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

export interface AppOptions {
  db?: Db;
  ai?: AiProvider;
  payments?: PaymentProvider;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

export function createApp(config: Config, opts: AppOptions = {}): { server: Server; ctx: Context } {
  const db = opts.db ?? openDb(config.databasePath);
  const keys = new Keys(config.secret);
  const log = opts.log ?? ((msg: string, extra?: unknown) => console.log(`[dokufy] ${msg}`, extra ?? ''));
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
  );
  const ctx: Context = {
    config,
    db,
    keys,
    ai: opts.ai ?? createAiProvider(config),
    payments: opts.payments ?? createPaymentProvider(config),
    integrations,
    delivery,
    now: opts.now ?? (() => new Date()),
    log,
  };
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
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new HttpError(400, 'invalid_json', 'Der Inhalt ist kein gültiges JSON.');
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
        ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim(),
      });
      sendJson(res, 200, result, cors);
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: { code: e.code, message: e.message, details: e.details } }, cors);
      } else {
        log('Unerwarteter Fehler', e);
        sendJson(res, 500, { error: { code: 'internal', message: 'Da ist etwas schiefgelaufen. Bitte versuche es erneut.' } }, cors);
      }
    }
  });

  return { server, ctx };
}
