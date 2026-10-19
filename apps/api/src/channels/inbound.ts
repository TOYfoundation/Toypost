import { createHmac } from 'node:crypto';
import { safeEqual } from '../security.ts';
import type { ChannelConfigs, ChannelKind } from './types.ts';

/**
 * Turns what each service delivers into one message format. Every channel has its own inbound address
 * /v1/inbox/<channelId>; services that sign requests are verified, all others need the channel's token.
 */

export interface InboundAttachment {
  name: string;
  mime: string;
  /** base64, or a URL ToyPost fetches itself (e.g. Telegram file) */
  base64?: string;
  fetch?: { url: string };
}

export interface InboundMessage {
  /** handle of the sender in this channel (e-mail address, phone number, chat id …) */
  from: string;
  fromName?: string;
  /** language code reported by the service (Telegram) or the sender, if known */
  language?: string;
  subject?: string;
  text: string;
  externalId?: string;
  /** groups messages of one conversation (e-mail thread, chat) */
  threadKey?: string;
  attachments: InboundAttachment[];
}

export type InboundResult = { kind: 'message'; message: InboundMessage } | { kind: 'ignore'; reason: string };

export interface InboundRequest {
  headers: Record<string, string | string[] | undefined>;
  query: URLSearchParams;
  body: any;
  /** full public URL of this request, for Twilio's signature */
  url: string;
}

/** Twilio signs the full URL plus all POST parameters sorted by name, HMAC-SHA1 with the auth token. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function authorizeInbound(kind: ChannelKind, cfg: any, token: string, req: InboundRequest): boolean {
  const header = (name: string) => String(req.headers[name] ?? '');
  const given = header('x-toypost-token') || req.query.get('token') || '';
  if (given && safeEqual(given, token)) return true;
  if (kind === 'telegram') return safeEqual(header('x-telegram-bot-api-secret-token'), token);
  if (kind === 'sms' && cfg.provider === 'twilio') {
    const sig = header('x-twilio-signature');
    return !!sig && safeEqual(sig, twilioSignature(cfg.authToken, req.url, req.body ?? {}));
  }
  return false;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

export function normalizeInbound<K extends ChannelKind>(kind: K, cfg: ChannelConfigs[K], body: any): InboundResult {
  if (kind === 'telegram') {
    const m = body?.message ?? body?.edited_message ?? body?.channel_post;
    if (!m) return { kind: 'ignore', reason: 'Kein Nachrichteninhalt (z. B. Statusmeldung).' };
    const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.chat?.title || m.from?.username || 'Telegram';
    // file ids only; the bot token stays in the encrypted channel settings and is added when downloading
    const attachments: InboundAttachment[] = [];
    if (Array.isArray(m.photo) && m.photo.length) {
      const largest = m.photo[m.photo.length - 1];
      attachments.push({ name: `telegram-${m.message_id}.jpg`, mime: 'image/jpeg', fetch: { url: `telegram:${largest.file_id}` } });
    }
    if (m.document?.file_id) {
      attachments.push({ name: str(m.document.file_name) || `telegram-${m.message_id}`, mime: str(m.document.mime_type) || 'application/octet-stream', fetch: { url: `telegram:${m.document.file_id}` } });
    }
    return {
      kind: 'message',
      message: {
        from: String(m.chat?.id ?? m.from?.id),
        fromName: name,
        language: m.from?.language_code,
        text: str(m.text ?? m.caption),
        externalId: `${m.chat?.id}:${m.message_id}`,
        threadKey: `telegram:${m.chat?.id}`,
        attachments,
      },
    };
  }
  if (kind === 'sms') {
    const c = cfg as ChannelConfigs['sms'];
    if (c.provider === 'twilio') {
      const attachments: InboundAttachment[] = [];
      for (let i = 0; i < Number(body?.NumMedia ?? 0); i++) {
        if (body[`MediaUrl${i}`]) attachments.push({ name: `mms-${i}`, mime: str(body[`MediaContentType${i}`]) || 'image/jpeg', fetch: { url: body[`MediaUrl${i}`] } });
      }
      return { kind: 'message', message: { from: str(body?.From), text: str(body?.Body), externalId: str(body?.MessageSid) || undefined, threadKey: `sms:${body?.From}`, attachments } };
    }
    if (c.provider === 'android') {
      if (body?.event && body.event !== 'sms:received') return { kind: 'ignore', reason: `Ereignis ${body.event}` };
      const p = body?.payload ?? body;
      return {
        kind: 'message',
        message: { from: str(p.phoneNumber ?? p.sender), text: str(p.message), externalId: str(p.messageId ?? body?.id) || undefined, threadKey: `sms:${p.phoneNumber}`, attachments: [] },
      };
    }
  }
  // Generic format: e-mail via n8n (IMAP node), Matrix bridge, Signal receive loop, own scripts
  const attachments: InboundAttachment[] = Array.isArray(body?.attachments)
    ? body.attachments
        .filter((a: any) => a && typeof a.name === 'string' && (typeof a.base64 === 'string' || typeof a.url === 'string'))
        .map((a: any) => ({ name: a.name, mime: str(a.mime) || 'application/octet-stream', base64: a.base64, fetch: a.url ? { url: a.url } : undefined }))
    : [];
  const from = str(body?.from).trim();
  const text = str(body?.text ?? body?.body ?? body?.message).trim();
  if (!from) return { kind: 'ignore', reason: 'Feld "from" fehlt.' };
  if (!text && !attachments.length) return { kind: 'ignore', reason: 'Weder Text noch Anhang.' };
  return {
    kind: 'message',
    message: {
      from,
      fromName: str(body?.fromName ?? body?.name) || undefined,
      language: str(body?.language) || undefined,
      subject: str(body?.subject) || undefined,
      text,
      externalId: str(body?.externalId ?? body?.messageId) || undefined,
      threadKey: str(body?.threadKey ?? body?.inReplyTo) || undefined,
      attachments,
    },
  };
}

/** Downloads an attachment that the service only referenced (Telegram file id, Twilio media URL). */
export async function fetchAttachment(a: InboundAttachment, kind: ChannelKind, cfg: any, f: typeof fetch = fetch): Promise<Buffer> {
  if (a.base64) return Buffer.from(a.base64, 'base64');
  if (!a.fetch) throw new Error('Anhang ohne Inhalt.');
  const u = a.fetch.url;
  if (u.startsWith('telegram:')) {
    if (kind !== 'telegram') throw new Error('Telegram-Anhang in einem anderen Kanal.');
    const token = (cfg as ChannelConfigs['telegram']).botToken;
    const fileId = u.slice('telegram:'.length);
    const info = (await (await f(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)).json()) as any;
    if (!info?.ok) throw new Error('Telegram hat die Datei nicht herausgegeben.');
    const res = await f(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
    if (!res.ok) throw new Error(`Telegram-Datei: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (!/^https:\/\//.test(u)) throw new Error('Anhänge werden nur über https geladen.');
  // Twilio media needs the account credentials
  const headers: Record<string, string> = {};
  if (kind === 'sms' && cfg.provider === 'twilio' && u.startsWith('https://api.twilio.com/')) {
    headers.authorization = `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`;
  }
  const res = await f(u, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Anhang konnte nicht geladen werden: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
