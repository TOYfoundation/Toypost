import { randomUUID } from 'node:crypto';
import { redactSecrets } from './shared.ts';

/**
 * Error reports to Sentry without an SDK: one HTTP request per event in Sentry's envelope format.
 * Only error type, message and stack leave the server, after recovery phrases and keys have been removed;
 * no letters, messages or contact data. At most 30 reports per minute.
 * Set SENTRY_DSN (project "toypost-api"); without it nothing is sent.
 */

export interface Reporter {
  exception(e: unknown, tags?: Record<string, string>): void;
  message(text: string, level?: 'warning' | 'error', tags?: Record<string, string>): void;
  readonly pending: Set<Promise<void>>;
}

export function parseDsn(dsn: string): { endpoint: string; publicKey: string } {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\//, '').split('/').pop();
  if (!u.username || !projectId) throw new Error('SENTRY_DSN ist ungültig.');
  const prefix = u.pathname.replace(/\/[^/]*$/, '');
  return { endpoint: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/`, publicKey: u.username };
}

function frames(stack: string | undefined) {
  if (!stack) return undefined;
  const list = stack
    .split('\n')
    .slice(1)
    .map((l) => /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ function: m[1] ?? '<anonymous>', filename: m[2].replace(/^file:\/\//, ''), lineno: Number(m[3]), colno: Number(m[4]), in_app: !m[2].includes('node:') }))
    .reverse();
  return list.length ? { frames: list } : undefined;
}

export function createReporter(dsn: string | undefined, opts: { release: string; environment: string; f?: typeof fetch; log?: (m: string) => void }): Reporter {
  const pending = new Set<Promise<void>>();
  if (!dsn) return { exception: () => {}, message: () => {}, pending };
  const { endpoint, publicKey } = parseDsn(dsn);
  const f = opts.f ?? fetch;
  let windowStart = Date.now();
  let count = 0;

  const send = (event: Record<string, unknown>) => {
    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > 30) return;
    const eventId = randomUUID().replace(/-/g, '');
    const body = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify({ event_id: eventId, timestamp: Date.now() / 1000, platform: 'node', release: opts.release, environment: opts.environment, server_name: 'toypost-api', ...event }),
    ].join('\n');
    const p = f(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=toypost/0.1` },
      body,
      signal: AbortSignal.timeout(5000),
    })
      .then(() => undefined)
      .catch((e: Error) => opts.log?.(`Sentry nicht erreichbar: ${e.message}`))
      .finally(() => pending.delete(p));
    pending.add(p);
  };

  return {
    pending,
    exception(e, tags) {
      const err = e instanceof Error ? e : new Error(String(e));
      send({
        level: 'error',
        tags,
        exception: { values: [{ type: err.name, value: redactSecrets(err.message).slice(0, 1000), stacktrace: frames(err.stack) }] },
      });
    },
    message(text, level = 'warning', tags) {
      send({ level, tags, message: { formatted: redactSecrets(text).slice(0, 1000) } });
    },
  };
}
