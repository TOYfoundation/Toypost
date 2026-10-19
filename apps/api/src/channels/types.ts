import { HttpError } from '../http.ts';

/**
 * Every way ToyPost talks to people or receives data. Messaging channels send and receive; feeds, GitHub and
 * ToyScan only deliver events. All credentials are stored encrypted (ChannelStore) and never returned to the app.
 */
export const CHANNEL_KINDS = [
  'email',
  'telegram',
  'matrix',
  'signal',
  'sms',
  'ntfy',
  'talk',
  'discord',
  'slack',
  'webhook',
  'feed',
  'github',
  'toyscan',
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** What a handle of this channel looks like (the address of one person or room). */
export const HANDLE_KIND: Partial<Record<ChannelKind, string>> = {
  email: 'E-Mail-Adresse',
  telegram: 'Chat-ID',
  matrix: 'Raum-ID (!abc:server)',
  signal: 'Telefonnummer (+49…)',
  sms: 'Telefonnummer (+49…)',
  talk: 'Unterhaltungs-Token',
};

export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  email: 'E-Mail',
  telegram: 'Telegram',
  matrix: 'Matrix / Element',
  signal: 'Signal',
  sms: 'SMS',
  ntfy: 'Mitteilungen (ntfy / UnifiedPush)',
  talk: 'Nextcloud Talk',
  discord: 'Discord',
  slack: 'Slack',
  webhook: 'Webhook',
  feed: 'Datenfeed (RSS, Atom, JSON)',
  github: 'GitHub-Projekt',
  toyscan: 'ToyScan und ToyChain',
};

export interface ChannelConfigs {
  email: { host: string; port: number; security: 'tls' | 'starttls' | 'none'; user?: string; password?: string; from: string; fromName?: string };
  telegram: { botToken: string; defaultChatId?: string };
  matrix: { homeserver: string; accessToken: string; defaultRoom?: string };
  signal: { url: string; number: string };
  sms:
    | { provider: 'twilio'; accountSid: string; authToken: string; from: string }
    | { provider: 'android'; url: string; user: string; password: string }
    | { provider: 'http'; url: string; bearer?: string };
  ntfy: { server: string; topic: string; token?: string };
  talk: { url: string; user: string; appPassword: string; defaultToken?: string };
  discord: { webhookUrl: string };
  slack: { webhookUrl: string };
  webhook: { url: string; secret?: string };
  feed: { url: string; everyMinutes: number };
  github: { repo: string; token?: string; branch: string; everyMinutes: number };
  /** ToyScan instance (public API) and optionally a ToyChain node (JSON-RPC) */
  toyscan: { url: string; rpcUrl?: string; everyMinutes: number; watchAddresses: string[] };
}

export type ChannelConfig = ChannelConfigs[ChannelKind];

/** Which kinds can send, receive or are polled. */
export const CAN_SEND: readonly ChannelKind[] = ['email', 'telegram', 'matrix', 'signal', 'sms', 'ntfy', 'talk', 'discord', 'slack', 'webhook'];
export const POLLED: readonly ChannelKind[] = ['feed', 'github', 'toyscan'];
/** Channels that post to one fixed place (no per-person handle): good for announcements. */
export const BROADCAST_TARGET: readonly ChannelKind[] = ['ntfy', 'discord', 'slack', 'webhook'];

function url(body: any, key: string, optional = false): string | undefined {
  const v = body?.[key];
  if ((v === undefined || v === '') && optional) return undefined;
  try {
    const u = new URL(String(v));
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    return u.toString().replace(/\/$/, '');
  } catch {
    throw new HttpError(400, 'invalid_input', `"${key}" muss eine vollständige Adresse sein, z. B. https://beispiel.de`);
  }
}

function str(body: any, key: string, opts: { optional?: boolean; pattern?: RegExp; hint?: string } = {}): string | undefined {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return undefined;
    throw new HttpError(400, 'invalid_input', `Das Feld "${key}" fehlt.`);
  }
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_input', `"${key}" muss Text sein.`);
  const s = v.trim();
  if (opts.pattern && !opts.pattern.test(s)) throw new HttpError(400, 'invalid_input', opts.hint ?? `"${key}" hat ein ungültiges Format.`);
  return s;
}

function minutes(body: any, fallback: number, min: number): number {
  const v = body?.everyMinutes ?? fallback;
  if (!Number.isInteger(v) || v < min || v > 1440) throw new HttpError(400, 'invalid_input', `"everyMinutes" muss zwischen ${min} und 1440 liegen.`);
  return v;
}

const PHONE = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

export function validateChannelConfig(kind: ChannelKind, body: any): ChannelConfig {
  switch (kind) {
    case 'email': {
      const security = body?.security ?? 'starttls';
      if (!['tls', 'starttls', 'none'].includes(security)) throw new HttpError(400, 'invalid_input', '"security" muss tls, starttls oder none sein.');
      const port = body?.port ?? (security === 'tls' ? 465 : 587);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'invalid_input', '"port" ist ungültig.');
      return {
        host: str(body, 'host')!,
        port,
        security,
        user: str(body, 'user', { optional: true }),
        password: str(body, 'password', { optional: true }),
        from: str(body, 'from', { pattern: EMAIL, hint: '"from" muss eine E-Mail-Adresse sein.' })!,
        fromName: str(body, 'fromName', { optional: true }),
      };
    }
    case 'telegram':
      return {
        botToken: str(body, 'botToken', { pattern: /^\d+:[\w-]{30,}$/, hint: 'Das Bot-Token sieht so aus: 123456:ABC… (von @BotFather).' })!,
        defaultChatId: str(body, 'defaultChatId', { optional: true, pattern: /^-?\d+$|^@\w+$/ }),
      };
    case 'matrix':
      return {
        homeserver: url(body, 'homeserver')!,
        accessToken: str(body, 'accessToken')!,
        defaultRoom: str(body, 'defaultRoom', { optional: true, pattern: /^[!#][^:]+:.+$/, hint: 'Raum-ID im Format !abc:server oder #raum:server.' }),
      };
    case 'signal':
      return { url: url(body, 'url')!, number: str(body, 'number', { pattern: PHONE, hint: 'Nummer im Format +491701234567.' })! };
    case 'sms': {
      const provider = body?.provider;
      if (provider === 'twilio') {
        return {
          provider,
          accountSid: str(body, 'accountSid', { pattern: /^AC[0-9a-f]{32}$/, hint: 'Die Account SID beginnt mit AC.' })!,
          authToken: str(body, 'authToken')!,
          from: str(body, 'from', { pattern: PHONE, hint: 'Absender im Format +49….' })!,
        };
      }
      if (provider === 'android') return { provider, url: url(body, 'url')!, user: str(body, 'user')!, password: str(body, 'password')! };
      if (provider === 'http') return { provider, url: url(body, 'url')!, bearer: str(body, 'bearer', { optional: true }) };
      throw new HttpError(400, 'invalid_input', '"provider" muss twilio, android oder http sein.');
    }
    case 'ntfy':
      return {
        server: url(body, 'server')!,
        topic: str(body, 'topic', { pattern: /^[\w-]{1,64}$/, hint: 'Das Thema darf nur Buchstaben, Ziffern, - und _ enthalten.' })!,
        token: str(body, 'token', { optional: true }),
      };
    case 'talk':
      return { url: url(body, 'url')!, user: str(body, 'user')!, appPassword: str(body, 'appPassword')!, defaultToken: str(body, 'defaultToken', { optional: true }) };
    case 'discord':
      return { webhookUrl: url(body, 'webhookUrl')! };
    case 'slack':
      return { webhookUrl: url(body, 'webhookUrl')! };
    case 'webhook':
      return { url: url(body, 'url')!, secret: str(body, 'secret', { optional: true }) };
    case 'feed':
      return { url: url(body, 'url')!, everyMinutes: minutes(body, 30, 5) };
    case 'github':
      return {
        repo: str(body, 'repo', { pattern: /^[\w.-]+\/[\w.-]+$/, hint: 'Repository im Format besitzer/name, z. B. Safehaigit/toycoin.' })!,
        token: str(body, 'token', { optional: true }),
        branch: str(body, 'branch', { optional: true }) ?? 'main',
        everyMinutes: minutes(body, 15, 5),
      };
    case 'toyscan': {
      const addresses = Array.isArray(body?.watchAddresses) ? body.watchAddresses : [];
      for (const a of addresses) {
        if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new HttpError(400, 'invalid_input', `"${a}" ist keine Adresse.`);
      }
      return { url: url(body, 'url')!, rpcUrl: url(body, 'rpcUrl', true), everyMinutes: minutes(body, 5, 1), watchAddresses: addresses };
    }
  }
}

/** Validates a handle for a channel kind, e.g. a phone number for SMS. Returns the normalised handle. */
export function normalizeHandle(kind: ChannelKind, handle: string): string {
  const h = handle.trim();
  const bad = (what: string) => new HttpError(400, 'invalid_input', `„${h}“ ist keine gültige ${what}.`);
  switch (kind) {
    case 'email':
      if (!EMAIL.test(h)) throw bad('E-Mail-Adresse');
      return h.toLowerCase();
    case 'sms':
    case 'signal': {
      const n = h.replace(/[\s/()-]/g, '').replace(/^00/, '+');
      if (!PHONE.test(n)) throw bad('Telefonnummer im Format +49…');
      return n;
    }
    case 'telegram':
      if (!/^-?\d+$/.test(h)) throw bad('Telegram-Chat-ID');
      return h;
    case 'matrix':
      if (!/^[!#@][^:\s]+:\S+$/.test(h)) throw bad('Matrix-ID');
      return h;
    default:
      if (!h || h.length > 200) throw bad('Kennung');
      return h;
  }
}
