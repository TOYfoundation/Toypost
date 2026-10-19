import type { IncomingMessage, ServerResponse } from 'node:http';

/** Fehler mit HTTP-Status und einer Meldung, die der Nutzer lesen kann. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  rawBody: string;
  body: any;
  ip: string;
}

export type Handler = (req: Request) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  get(p: string, h: Handler) {
    return this.on('GET', p, h);
  }
  post(p: string, h: Handler) {
    return this.on('POST', p, h);
  }
  put(p: string, h: Handler) {
    return this.on('PUT', p, h);
  }
  patch(p: string, h: Handler) {
    return this.on('PATCH', p, h);
  }
  delete(p: string, h: Handler) {
    return this.on('DELETE', p, h);
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    if (pathMatched) throw new HttpError(405, 'method_not_allowed', `${method} ist hier nicht erlaubt.`);
    return null;
  }
}

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'too_large', 'Die Datei ist größer als 20 MB.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/** Einfaches Ratenlimit pro Schlüssel (z. B. IP + Route), im Speicher. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  check(key: string): void {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      const wait = Math.ceil((entry.resetAt - now) / 1000);
      throw new HttpError(429, 'rate_limited', `Zu viele Versuche. Bitte in ${wait} Sekunden erneut versuchen.`);
    }
  }
}

// ---------- Eingabeprüfung ----------

export function requireString(body: any, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw new HttpError(400, 'invalid_input', `Das Feld "${key}" fehlt.`);
  }
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_input', `Das Feld "${key}" muss Text sein.`);
  const s = v.trim();
  if (opts.min && s.length < opts.min) throw new HttpError(400, 'invalid_input', `"${key}" braucht mindestens ${opts.min} Zeichen.`);
  if (opts.max && s.length > opts.max) throw new HttpError(400, 'invalid_input', `"${key}" darf höchstens ${opts.max} Zeichen haben.`);
  return s;
}

export function optionalInt(body: any, key: string, min: number, max: number, fallback: number): number {
  const v = body?.[key];
  if (v === undefined || v === null) return fallback;
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, 'invalid_input', `"${key}" muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return v;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new HttpError(400, 'invalid_input', `"${key}" muss einer dieser Werte sein: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function isoDateOrUndefined(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, 'invalid_input', `"${key}" muss ein Datum im Format JJJJ-MM-TT sein.`);
  }
  return value;
}
