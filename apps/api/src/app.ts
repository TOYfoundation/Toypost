import { createServer, type Server } from 'node:http';
import type { Config } from './config.ts';
import type { Context } from './context.ts';
import { openDb, type Db } from './db.ts';
import { HttpError, readBody, sendJson } from './http.ts';
import { Keys } from './security.ts';
import { createAiProvider, type AiProvider } from './ai/provider.ts';
import { createPaymentProvider, type PaymentProvider } from './billing/provider.ts';
import { IntegrationStore } from './integrations/store.ts';
import { Delivery } from './services/delivery.ts';
import { buildRouter } from './routes.ts';
import { ChannelStore } from './channels/store.ts';
import { runAutomations } from './services/automations.ts';
import { createReporter, type Reporter } from './monitoring.ts';

export interface AppOptions {
  db?: Db;
  ai?: AiProvider;
  payments?: PaymentProvider;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  reporter?: Reporter;
  fetch?: typeof fetch;
}

export function createApp(config: Config, opts: AppOptions = {}): { server: Server; ctx: Context } {
  const db = opts.db ?? openDb(config.databasePath);
  const keys = new Keys(config.secret);
  const baseLog = opts.log ?? ((msg: string, extra?: unknown) => console.log(`[toypost] ${msg}`, extra ?? ''));
  const reporter =
    opts.reporter ?? createReporter(config.sentryDsn, { release: 'toypost@0.2.0', environment: config.production ? 'production' : 'development', f: opts.fetch, log: (m) => baseLog(m) });
  // failed deliveries, polls and automations also go to Sentry as warnings
  const log = (msg: string, extra?: unknown) => {
    baseLog(msg, extra);
    if (/fehlgeschlagen|nicht gesendet|nicht erreichbar/i.test(msg) && !/^Sentry/.test(msg)) reporter.message(msg, 'warning');
  };
  const now = opts.now ?? (() => new Date());
  const integrations = new IntegrationStore(db, keys);
  const delivery = new Delivery(
    integrations,
    (accountId) => (db.prepare('SELECT webhook_secret FROM accounts WHERE id = ?').get(accountId) as { webhook_secret: string }).webhook_secret,
    log,
    // Link zum neuesten Paperless-Dokument des Vorgangs, für Aufgaben und Termine in Nextcloud
    (accountId, caseId) => {
      const publicUrl = integrations.get(accountId, 'paperless')?.publicUrl;
      if (!publicUrl) return undefined;
      const doc = db
        .prepare('SELECT paperless_id FROM documents WHERE account_id = ? AND case_id = ? AND paperless_id IS NOT NULL ORDER BY received_at DESC LIMIT 1')
        .get(accountId, caseId) as { paperless_id: number } | undefined;
      return doc ? `${publicUrl.replace(/\/$/, '')}/documents/${doc.paperless_id}/details` : undefined;
    },
    now,
  );
  const ctx: Context = {
    config,
    db,
    keys,
    ai: opts.ai ?? createAiProvider(config),
    payments: opts.payments ?? createPaymentProvider(config),
    integrations,
    delivery,
    channels: new ChannelStore(db, keys),
    reporter,
    now,
    log,
  };
  delivery.on((accountId, event) => runAutomations(ctx, accountId, event));
  const router = buildRouter(ctx);

  const corsOrigin = (origin: string | undefined) => {
    if (config.appOrigins.includes('*')) return '*';
    return origin && config.appOrigins.includes(origin) ? origin : config.appOrigins[0];
  };

  const server = createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': corsOrigin(req.headers.origin),
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      vary: 'origin',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (!match) throw new HttpError(404, 'not_found', 'Diese Adresse gibt es nicht.');
      const rawBody = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : '';
      let body: unknown = undefined;
      if (rawBody) {
        // SMS services such as Twilio post form data instead of JSON
        if (String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(rawBody));
        } else {
          try {
            body = JSON.parse(rawBody);
          } catch {
            throw new HttpError(400, 'invalid_json', 'Der Inhalt ist kein gültiges JSON.');
          }
        }
      }
      const result = await match.handler({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        params: match.params,
        headers: req.headers,
        rawBody,
        body,
        url: `${config.publicUrl.replace(/\/$/, '')}${req.url ?? '/'}`,
        ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim(),
      });
      sendJson(res, 200, result, cors);
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: { code: e.code, message: e.message, details: e.details } }, cors);
      } else {
        log('Unerwarteter Fehler', e);
        reporter.exception(e, { route: `${req.method} ${new URL(req.url ?? '/', 'http://local').pathname.replace(/\/(case|doc|ch|msg|ct|inv|bc|auto|draft)_[\w]+/g, '/:id')}` });
        sendJson(res, 500, { error: { code: 'internal', message: 'Da ist etwas schiefgelaufen. Bitte versuche es erneut.' } }, cors);
      }
    }
  });

  return { server, ctx };
}
