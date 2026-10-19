import type { Context } from '../context.ts';
import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { HttpError } from '../http.ts';
import { newId } from '../security.ts';
import { BROADCAST_TARGET, CAN_SEND } from '../channels/types.ts';
import type { ChannelRow } from '../channels/store.ts';
import { blocksSending, checkSafety, glossaryHint, hasFeature, toyLanguage } from '../shared.ts';
import type { AccountRow } from './accounts.ts';
import type { UserRow } from './accounts.ts';
import { listContacts } from './contacts.ts';
import { bestChannelFor, sendMessage } from './messages.ts';

/**
 * Announcements to a group (testers, validators, community) or to a channel (Discord, ntfy topic …).
 * ToyPost writes and translates, a person approves: nothing goes out to many people without a human "send".
 * Audience: "gruppe:<tag>" (each contact in their language over their best channel), "kanal:<channelId>" or "alle".
 */

export interface BroadcastRow {
  id: string;
  account_id: string;
  audience_tag: string;
  subject: string;
  body: string;
  source: string;
  status: 'draft' | 'sent' | 'discarded';
  created_by: string | null;
  approved_by: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface BroadcastDto {
  id: string;
  audience: string;
  audienceLabel: string;
  subject: string;
  body: string;
  source: string;
  status: BroadcastRow['status'];
  createdAt: string;
  sentAt?: string;
  recipients: number;
  languages: string[];
  results?: { sent: number; failed: number; blocked: number; skipped: number };
}

function audienceOf(db: Db, accountId: string, audience: string): { label: string; contacts: { id: string; language: string }[]; channel?: ChannelRow } {
  if (audience === 'alle') {
    const contacts = listContacts(db, accountId);
    return { label: 'Alle Kontakte', contacts: contacts.map((c) => ({ id: c.id, language: c.language })) };
  }
  if (audience.startsWith('gruppe:')) {
    const tag = audience.slice('gruppe:'.length);
    const contacts = listContacts(db, accountId, { tag });
    return { label: `Gruppe „${tag}“`, contacts: contacts.map((c) => ({ id: c.id, language: c.language })) };
  }
  if (audience.startsWith('kanal:')) {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND account_id = ?').get(audience.slice('kanal:'.length), accountId) as ChannelRow | undefined;
    if (!ch) throw new HttpError(400, 'invalid_input', 'Diesen Kanal gibt es nicht.');
    if (!CAN_SEND.includes(ch.kind)) throw new HttpError(400, 'invalid_input', `Über ${ch.name} kann ToyPost nicht senden.`);
    return { label: `Kanal „${ch.name}“`, contacts: [], channel: ch };
  }
  throw new HttpError(400, 'invalid_input', 'Empfänger: "alle", "gruppe:<Name>" oder "kanal:<Kanal-ID>".');
}

function toDto(db: Db, r: BroadcastRow): BroadcastDto {
  const a = audienceOf(db, r.account_id, r.audience_tag);
  const stats = db
    .prepare(`SELECT status, COUNT(*) AS n FROM messages WHERE broadcast_id = ? GROUP BY status`)
    .all(r.id) as { status: string; n: number }[];
  const by = (s: string) => stats.find((x) => x.status === s)?.n ?? 0;
  return {
    id: r.id,
    audience: r.audience_tag,
    audienceLabel: a.label,
    subject: r.subject,
    body: r.body,
    source: r.source,
    status: r.status,
    createdAt: r.created_at,
    sentAt: r.sent_at ?? undefined,
    recipients: a.channel ? 1 : a.contacts.length,
    languages: [...new Set(a.contacts.map((c) => c.language))].sort(),
    results: r.status === 'sent' ? { sent: by('sent'), failed: by('failed'), blocked: by('blocked'), skipped: 0 } : undefined,
  };
}

export function getBroadcast(db: Db, accountId: string, id: string): BroadcastRow {
  const r = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND account_id = ?').get(id, accountId) as BroadcastRow | undefined;
  if (!r) throw new HttpError(404, 'not_found', 'Diese Mitteilung gibt es nicht.');
  return r;
}

export function listBroadcasts(db: Db, accountId: string): BroadcastDto[] {
  return (db.prepare('SELECT * FROM broadcasts WHERE account_id = ? ORDER BY created_at DESC LIMIT 100').all(accountId) as unknown as BroadcastRow[]).map((r) => toDto(db, r));
}

export function createBroadcast(db: Db, accountId: string, input: { audience: string; subject: string; body: string; source: string; userId?: string }): BroadcastDto {
  audienceOf(db, accountId, input.audience);
  const findings = checkSafety({ text: `${input.subject}\n${input.body}`, direction: 'out' });
  if (blocksSending(findings)) throw new HttpError(422, 'blocked_secret', findings[0].message);
  const id = newId('bc');
  db.prepare('INSERT INTO broadcasts (id, account_id, audience_tag, subject, body, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    accountId,
    input.audience,
    input.subject.slice(0, 200),
    input.body.slice(0, 10_000),
    input.source,
    input.userId ?? null,
    nowIso(),
  );
  return toDto(db, getBroadcast(db, accountId, id));
}

export function updateBroadcast(db: Db, accountId: string, id: string, patch: { subject?: string; body?: string; audience?: string }): BroadcastDto {
  const r = getBroadcast(db, accountId, id);
  if (r.status !== 'draft') throw new HttpError(409, 'not_draft', 'Gesendete Mitteilungen lassen sich nicht mehr ändern.');
  if (patch.audience) audienceOf(db, accountId, patch.audience);
  db.prepare('UPDATE broadcasts SET subject = ?, body = ?, audience_tag = ? WHERE id = ?').run(patch.subject ?? r.subject, patch.body ?? r.body, patch.audience ?? r.audience_tag, id);
  return toDto(db, getBroadcast(db, accountId, id));
}

export function discardBroadcast(db: Db, accountId: string, id: string): BroadcastDto {
  const r = getBroadcast(db, accountId, id);
  if (r.status !== 'draft') throw new HttpError(409, 'not_draft', 'Nur Entwürfe lassen sich verwerfen.');
  db.prepare(`UPDATE broadcasts SET status = 'discarded' WHERE id = ?`).run(id);
  return toDto(db, getBroadcast(db, accountId, id));
}

/**
 * Approves and sends. With the four-eyes rule (Team/Enterprise with several users) the author may not approve.
 * Each language is translated once (glossary of the Toy projects included); German texts go out unchanged.
 */
export async function sendBroadcast(ctx: Context, account: AccountRow, approver: UserRow, id: string): Promise<BroadcastDto> {
  const { db } = ctx;
  const r = getBroadcast(db, account.id, id);
  if (r.status !== 'draft') throw new HttpError(409, 'not_draft', 'Diese Mitteilung wurde schon gesendet oder verworfen.');
  if (hasFeature(account.plan, 'approval') && account.seats > 1 && r.created_by === approver.id) {
    throw new HttpError(409, 'approval_required', 'Eine zweite Person muss diese Mitteilung freigeben.');
  }
  // mark first, so a second click cannot send twice
  const claimed = db.prepare(`UPDATE broadcasts SET status = 'sent', approved_by = ?, sent_at = ? WHERE id = ? AND status = 'draft'`).run(approver.id, nowIso(), id);
  if (Number(claimed.changes) !== 1) throw new HttpError(409, 'not_draft', 'Diese Mitteilung wird gerade schon gesendet.');
  const audience = audienceOf(db, account.id, r.audience_tag);
  const channels = ctx.channels;

  if (audience.channel) {
    await sendMessage(ctx, account, { channel: audience.channel, cfg: channels.config(audience.channel), subject: r.subject, text: r.body, broadcastId: r.id });
    return toDto(db, getBroadcast(db, account.id, id));
  }

  const translations = new Map<string, { subject?: string; text: string }>();
  const glossary = glossaryHint(`${r.subject}\n${r.body}`);
  for (const c of audience.contacts) {
    const ch = bestChannelFor(db, account.id, c.id);
    if (!ch) continue;
    const lang = toyLanguage(c.language);
    let t = translations.get(lang.code);
    if (!t) {
      try {
        t = lang.code === 'de' ? { subject: r.subject, text: r.body } : await ctx.ai.translate({ subject: r.subject, text: r.body, targetLang: lang.code, targetLangName: lang.name, glossary });
      } catch (e) {
        ctx.log(`Übersetzung nach ${lang.code} fehlgeschlagen, sende Deutsch: ${(e as Error).message}`);
        t = { subject: r.subject, text: r.body };
      }
      translations.set(lang.code, t);
    }
    try {
      await sendMessage(ctx, account, { channel: ch, cfg: channels.config(ch), contactId: c.id, subject: t.subject ?? r.subject, text: t.text, broadcastId: r.id });
    } catch (e) {
      ctx.log(`Mitteilung an Kontakt ${c.id} nicht gesendet: ${(e as Error).message}`);
    }
  }
  return toDto(db, getBroadcast(db, account.id, id));
}

/** Announcement channels of an account (for automations that post to "all announcement channels"). */
export function announcementChannels(db: Db, accountId: string): ChannelRow[] {
  return (db.prepare('SELECT * FROM channels WHERE account_id = ? AND enabled = 1').all(accountId) as unknown as ChannelRow[]).filter((c) => BROADCAST_TARGET.includes(c.kind));
}
