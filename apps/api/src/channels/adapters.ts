import { createHmac, randomUUID } from 'node:crypto';
import type { ChannelConfigs, ChannelKind } from './types.ts';
import { sendMail } from './smtp.ts';

/**
 * Sending through each channel. All adapters use plain HTTP APIs (or SMTP) and no SDK.
 * `to` is the handle of the person or room; for broadcast channels (ntfy, Discord, Slack, webhook) it is ignored.
 */

export interface Outgoing {
  to?: string;
  subject?: string;
  text: string;
  /** optional link, e.g. a toychain: payment link */
  link?: string;
}

export interface SendResult {
  externalId?: string;
}

type Fetch = typeof fetch;

async function ok(res: Response, what: string): Promise<any> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${what} antwortete mit ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const type = res.headers.get('content-type') ?? '';
  return type.includes('json') ? res.json() : res.text();
}

function fullText(m: Outgoing, withSubject: boolean): string {
  const parts = [withSubject && m.subject ? m.subject : '', m.text, m.link ?? ''].filter(Boolean);
  return parts.join('\n\n');
}

function need(to: string | undefined, kind: string): string {
  if (!to) throw new Error(`Für ${kind} fehlt der Empfänger.`);
  return to;
}

export async function sendVia<K extends ChannelKind>(kind: K, cfg: ChannelConfigs[K], m: Outgoing, f: Fetch = fetch): Promise<SendResult> {
  const timeout = { signal: AbortSignal.timeout(15_000) };
  switch (kind) {
    case 'email': {
      const c = cfg as ChannelConfigs['email'];
      const r = await sendMail(c, { to: need(m.to, 'E-Mail'), subject: m.subject ?? '(ohne Betreff)', text: fullText({ ...m, subject: undefined }, false) });
      return { externalId: r.messageId };
    }
    case 'telegram': {
      const c = cfg as ChannelConfigs['telegram'];
      const data = await ok(
        await f(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: m.to ?? need(c.defaultChatId, 'Telegram'), text: fullText(m, true), disable_web_page_preview: true }),
          ...timeout,
        }),
        'Telegram',
      );
      return { externalId: data?.result?.message_id ? String(data.result.message_id) : undefined };
    }
    case 'matrix': {
      const c = cfg as ChannelConfigs['matrix'];
      const room = m.to ?? need(c.defaultRoom, 'Matrix');
      const txn = randomUUID();
      const data = await ok(
        await f(`${c.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${c.accessToken}` },
          body: JSON.stringify({ msgtype: 'm.text', body: fullText(m, true) }),
          ...timeout,
        }),
        'Matrix',
      );
      return { externalId: data?.event_id };
    }
    case 'signal': {
      // signal-cli-rest-api (bbernhard), self-hosted next to ToyPost
      const c = cfg as ChannelConfigs['signal'];
      const data = await ok(
        await f(`${c.url}/v2/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: fullText(m, true), number: c.number, recipients: [need(m.to, 'Signal')] }),
          ...timeout,
        }),
        'Signal',
      );
      return { externalId: data?.timestamp ? String(data.timestamp) : undefined };
    }
    case 'sms': {
      const c = cfg as ChannelConfigs['sms'];
      const to = need(m.to, 'SMS');
      const text = fullText(m, true).slice(0, 1530); // 10 concatenated SMS at most
      if (c.provider === 'twilio') {
        const data = await ok(
          await f(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`,
            },
            body: new URLSearchParams({ To: to, From: c.from, Body: text }).toString(),
            ...timeout,
          }),
          'Twilio',
        );
        return { externalId: data?.sid };
      }
      if (c.provider === 'android') {
        // "SMS Gateway for Android" (capcom6), runs on an old phone with a SIM card
        const data = await ok(
          await f(`${c.url}/message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${c.user}:${c.password}`).toString('base64')}` },
            body: JSON.stringify({ message: text, phoneNumbers: [to] }),
            ...timeout,
          }),
          'SMS-Gateway',
        );
        return { externalId: data?.id };
      }
      await ok(
        await f(c.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(c.bearer ? { authorization: `Bearer ${c.bearer}` } : {}) },
          body: JSON.stringify({ to, text }),
          ...timeout,
        }),
        'SMS-Dienst',
      );
      return {};
    }
    case 'ntfy': {
      // ntfy also serves as UnifiedPush distributor, the open push path planned for the TOYPAY wallet
      const c = cfg as ChannelConfigs['ntfy'];
      const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
      // ntfy reads non-ASCII header values as RFC 2047 encoded words
      if (m.subject) headers['x-title'] = /^[\x20-\x7e]*$/.test(m.subject) ? m.subject : `=?UTF-8?B?${Buffer.from(m.subject).toString('base64')}?=`;
      if (m.link) headers['x-click'] = m.link;
      if (c.token) headers.authorization = `Bearer ${c.token}`;
      const data = await ok(await f(`${c.server}/${m.to ?? c.topic}`, { method: 'POST', headers, body: m.text, ...timeout }), 'ntfy');
      return { externalId: typeof data === 'object' ? data?.id : undefined };
    }
    case 'talk': {
      const c = cfg as ChannelConfigs['talk'];
      const token = m.to ?? need(c.defaultToken, 'Nextcloud Talk');
      const data = await ok(
        await f(`${c.url}/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'ocs-apirequest': 'true',
            authorization: `Basic ${Buffer.from(`${c.user}:${c.appPassword}`).toString('base64')}`,
          },
          body: JSON.stringify({ message: fullText(m, true) }),
          ...timeout,
        }),
        'Nextcloud Talk',
      );
      return { externalId: data?.ocs?.data?.id ? String(data.ocs.data.id) : undefined };
    }
    case 'discord': {
      const c = cfg as ChannelConfigs['discord'];
      await ok(
        await f(c.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: fullText(m, true).slice(0, 2000) }), ...timeout }),
        'Discord',
      );
      return {};
    }
    case 'slack': {
      const c = cfg as ChannelConfigs['slack'];
      await ok(await f(c.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: fullText(m, true) }), ...timeout }), 'Slack');
      return {};
    }
    case 'webhook': {
      const c = cfg as ChannelConfigs['webhook'];
      const body = JSON.stringify({ to: m.to, subject: m.subject, text: m.text, link: m.link, at: new Date().toISOString() });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (c.secret) headers['x-toypost-signature'] = createHmac('sha256', c.secret).update(body).digest('hex');
      await ok(await f(c.url, { method: 'POST', headers, body, ...timeout }), 'Webhook');
      return {};
    }
    default:
      throw new Error(`Über ${kind} kann ToyPost nicht senden.`);
  }
}
