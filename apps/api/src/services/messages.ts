import type { Context } from '../context.ts';
import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { HttpError } from '../http.ts';
import { newId } from '../security.ts';
import { PaperlessClient } from '../integrations/paperless.ts';
import { sendVia, type Outgoing } from '../channels/adapters.ts';
import { fetchAttachment, type InboundMessage } from '../channels/inbound.ts';
import type { ChannelRow } from '../channels/store.ts';
import { CAN_SEND, CHANNEL_LABEL, normalizeHandle, type ChannelKind } from '../channels/types.ts';
import {
  blocksSending,
  checkSafety,
  redactSecrets,
  type Channel,
  type MessageChannelKind,
  type MessageSummary,
  type SafetyNote,
} from '../shared.ts';
import type { AccountRow } from './accounts.ts';
import { addTimeline } from './cases.ts';
import { getContactRow, knownAddresses, resolveContact, type ContactRow } from './contacts.ts';
import { ingestDocument } from './pipeline.ts';

interface MessageRow {
  id: string;
  account_id: string;
  channel_id: string | null;
  channel_kind: MessageChannelKind;
  direction: 'in' | 'out';
  contact_id: string | null;
  case_id: string | null;
  subject: string | null;
  body: string;
  safety_json: string;
  language: string | null;
  status: MessageSummary['status'];
  error: string | null;
  created_at: string;
}

/** Messages shorter than this are chat lines; longer ones (or with a TOY request) are analysed like a letter. */
const ANALYSE_FROM_CHARS = 40;
const SAME_CONVERSATION_DAYS = 30;

function toDto(db: Db, r: MessageRow): MessageSummary {
  const contact = r.contact_id ? (db.prepare('SELECT id, name FROM contacts WHERE id = ?').get(r.contact_id) as { id: string; name: string } | undefined) : undefined;
  const channel = r.channel_id ? (db.prepare('SELECT name FROM channels WHERE id = ?').get(r.channel_id) as { name: string } | undefined) : undefined;
  return {
    id: r.id,
    channelKind: r.channel_kind,
    channelName: channel?.name,
    direction: r.direction,
    contact,
    caseId: r.case_id ?? undefined,
    subject: r.subject ?? undefined,
    preview: r.body.replace(/\s+/g, ' ').slice(0, 140),
    body: r.body,
    status: r.status,
    safety: JSON.parse(r.safety_json) as SafetyNote[],
    language: r.language ?? undefined,
    createdAt: r.created_at,
    error: r.error ?? undefined,
  };
}

export function listMessages(
  db: Db,
  accountId: string,
  opts: { caseId?: string; contactId?: string; direction?: 'in' | 'out'; limit?: number; before?: string } = {},
): MessageSummary[] {
  const where = ['account_id = ?'];
  const args: (string | number)[] = [accountId];
  if (opts.caseId) (where.push('case_id = ?'), args.push(opts.caseId));
  if (opts.contactId) (where.push('contact_id = ?'), args.push(opts.contactId));
  if (opts.direction) (where.push('direction = ?'), args.push(opts.direction));
  if (opts.before) (where.push('created_at < ?'), args.push(opts.before));
  args.push(Math.min(opts.limit ?? 50, 200));
  const rows = db.prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args) as unknown as MessageRow[];
  return rows.map((r) => toDto(db, r));
}

function insertMessage(db: Db, m: Omit<MessageRow, 'id' | 'created_at'> & { external_id?: string | null; thread_key?: string | null; attachments_json?: string; broadcast_id?: string | null; sent_at?: string | null }): MessageRow {
  const id = newId('msg');
  db.prepare(
    `INSERT INTO messages (id, account_id, channel_id, channel_kind, direction, contact_id, case_id, external_id, thread_key, subject, body, attachments_json, safety_json, language, status, error, broadcast_id, created_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    m.account_id,
    m.channel_id,
    m.channel_kind,
    m.direction,
    m.contact_id,
    m.case_id,
    m.external_id ?? null,
    m.thread_key ?? null,
    m.subject,
    m.body,
    m.attachments_json ?? '[]',
    m.safety_json,
    m.language,
    m.status,
    m.error,
    m.broadcast_id ?? null,
    nowIso(),
    m.sent_at ?? null,
  );
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow;
}

/** Case of an ongoing conversation: same thread, or the newest open case of this contact from the last 30 days. */
function conversationCase(db: Db, accountId: string, contactId: string, threadKey: string | undefined, now: Date, exactThread = false): string | undefined {
  if (threadKey) {
    const t = db
      .prepare(`SELECT m.case_id FROM messages m JOIN cases c ON c.id = m.case_id WHERE m.account_id = ? AND m.thread_key = ? AND c.status != 'done' ORDER BY m.created_at DESC LIMIT 1`)
      .get(accountId, threadKey) as { case_id: string } | undefined;
    if (t) return t.case_id;
    // Own scripts (webhook) name their threads exactly: a new key starts a new case
    if (exactThread) return undefined;
  }
  const since = new Date(now.getTime() - SAME_CONVERSATION_DAYS * 86_400_000).toISOString();
  const c = db
    .prepare(`SELECT id FROM cases WHERE account_id = ? AND contact_id = ? AND status != 'done' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1`)
    .get(accountId, contactId, since) as { id: string } | undefined;
  return c?.id;
}

export interface ReceiveResult {
  duplicate?: boolean;
  message: MessageSummary;
  caseId?: string;
  createdCase: boolean;
  contactCreated: boolean;
}

/**
 * Incoming message from any channel. Order: dedupe → contact → safety → case (conversation or analysis) →
 * attachments to Paperless for text recognition → store → event (automations, n8n).
 */
export async function receiveMessage(ctx: Context, account: AccountRow, channel: ChannelRow, cfg: any, inbound: InboundMessage): Promise<ReceiveResult> {
  const { db } = ctx;
  const kind = channel.kind as MessageChannelKind;
  if (inbound.externalId) {
    const dup = db.prepare('SELECT * FROM messages WHERE account_id = ? AND channel_id = ? AND external_id = ?').get(account.id, channel.id, inbound.externalId) as
      | MessageRow
      | undefined;
    if (dup) return { duplicate: true, message: toDto(db, dup), caseId: dup.case_id ?? undefined, createdCase: false, contactCreated: false };
  }
  let handle = inbound.from;
  try {
    handle = normalizeHandle(channel.kind, inbound.from);
  } catch {
    // keep what the service sent; some bridges use their own ids
  }
  const { contact, created: contactCreated } = resolveContact(db, account.id, kind, handle, { name: inbound.fromName, language: inbound.language });
  const fullText = [inbound.subject, inbound.text].filter(Boolean).join('\n\n');
  const findings = checkSafety({ text: fullText, direction: 'in', knownAddresses: knownAddresses(db, account.id) });
  const safety: SafetyNote[] = findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message }));

  let caseId = conversationCase(db, account.id, contact.id, inbound.threadKey, ctx.now(), kind === 'webhook');
  let createdCase = false;
  const substantial = fullText.length >= ANALYSE_FROM_CHARS || /toychain:0x|\bTOY\b/.test(fullText);
  if (substantial) {
    const result = await ingestDocument(ctx, account, null, {
      text: fullText,
      title: inbound.subject,
      channel: kind as Channel,
      pages: 1,
      sizeBytes: Buffer.byteLength(fullText),
      caseId,
      contactId: contact.id,
    });
    caseId = result.caseId;
    createdCase = result.createdCase;
  } else if (caseId) {
    addTimeline(db, caseId, `Nachricht über ${CHANNEL_LABEL[channel.kind]} von ${contact.name}`);
  }

  // Photos and files: Paperless reads them (OCR) and reports back through its webhook, like a scan.
  const attachments: { name: string; mime: string; paperlessTask?: string; error?: string }[] = [];
  const paperless = ctx.integrations.get(account.id, 'paperless');
  for (const a of inbound.attachments.slice(0, 10)) {
    const meta: (typeof attachments)[number] = { name: a.name, mime: a.mime };
    if (paperless && /^(image\/|application\/pdf)/.test(a.mime)) {
      try {
        const data = await fetchAttachment(a, channel.kind, cfg);
        meta.paperlessTask = await new PaperlessClient(paperless).upload({ name: a.name, data, mime: a.mime }, { title: `${CHANNEL_LABEL[channel.kind]} von ${contact.name}` });
      } catch (e) {
        meta.error = (e as Error).message;
      }
    }
    attachments.push(meta);
  }

  const row = insertMessage(db, {
    account_id: account.id,
    channel_id: channel.id,
    channel_kind: kind,
    direction: 'in',
    contact_id: contact.id,
    case_id: caseId ?? null,
    external_id: inbound.externalId ?? null,
    thread_key: inbound.threadKey ?? null,
    subject: inbound.subject ? redactSecrets(inbound.subject) : null,
    body: redactSecrets(inbound.text),
    attachments_json: JSON.stringify(attachments),
    safety_json: JSON.stringify(safety),
    language: contact.language,
    status: 'received',
    error: null,
  });
  if (caseId) db.prepare('UPDATE cases SET contact_id = COALESCE(contact_id, ?) WHERE id = ?').run(contact.id, caseId);
  const message = toDto(db, row);
  ctx.delivery.emit(account.id, { type: 'message.received', message, caseId, contactId: contact.id });
  if (safety.length && !substantial) ctx.delivery.emit(account.id, { type: 'safety.warning', findings: safety, caseId, messageId: row.id });
  return { message, caseId, createdCase, contactCreated };
}

export interface SendInput {
  channel: ChannelRow;
  cfg: any;
  contactId?: string;
  /** handle in this channel; if missing, taken from the contact */
  to?: string;
  subject?: string;
  text: string;
  link?: string;
  caseId?: string;
  broadcastId?: string;
}

/** Picks the contact's handle for a channel kind. */
export function handleFor(db: Db, contactId: string, kind: ChannelKind): string | undefined {
  const r = db.prepare('SELECT handle FROM contact_handles WHERE contact_id = ? AND kind = ? LIMIT 1').get(contactId, kind) as { handle: string } | undefined;
  return r?.handle;
}

/**
 * Sends a message. Apparent recovery phrases or private keys are never sent (status "blocked", HTTP 422).
 * Failures are stored with the error so the user can see and retry them.
 */
export async function sendMessage(ctx: Context, account: AccountRow, input: SendInput): Promise<MessageSummary> {
  const { db } = ctx;
  const kind = input.channel.kind;
  if (!CAN_SEND.includes(kind)) throw new HttpError(400, 'cannot_send', `Über ${CHANNEL_LABEL[kind]} kann ToyPost nicht senden.`);
  if (!input.channel.enabled) throw new HttpError(409, 'channel_disabled', `Der Kanal „${input.channel.name}“ ist ausgeschaltet.`);
  let contact: ContactRow | undefined;
  if (input.contactId) contact = getContactRow(db, account.id, input.contactId);
  let to = input.to ? normalizeHandle(kind, input.to) : contact ? handleFor(db, contact.id, kind) : undefined;
  const needsHandle = !['ntfy', 'discord', 'slack', 'webhook'].includes(kind) && !(input.cfg.defaultChatId || input.cfg.defaultRoom || input.cfg.defaultToken);
  if (!to && needsHandle) {
    throw new HttpError(400, 'no_handle', `Für ${contact?.name ?? 'diesen Empfänger'} ist keine Kennung für ${CHANNEL_LABEL[kind]} hinterlegt.`);
  }
  const findings = checkSafety({ text: [input.subject, input.text].filter(Boolean).join('\n'), direction: 'out', knownAddresses: knownAddresses(db, account.id) });
  const safety: SafetyNote[] = findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message }));
  const base = {
    account_id: account.id,
    channel_id: input.channel.id,
    channel_kind: kind as MessageChannelKind,
    direction: 'out' as const,
    contact_id: contact?.id ?? null,
    case_id: input.caseId ?? null,
    subject: input.subject ?? null,
    safety_json: JSON.stringify(safety),
    language: contact?.language ?? null,
    broadcast_id: input.broadcastId ?? null,
  };
  if (blocksSending(findings)) {
    insertMessage(db, { ...base, body: redactSecrets(input.text), status: 'blocked', error: findings.find((f) => f.severity === 'block')!.message });
    throw new HttpError(422, 'blocked_secret', findings.find((f) => f.severity === 'block')!.message);
  }
  const out: Outgoing = { to, subject: input.subject, text: input.text, link: input.link };
  try {
    const res = await sendVia(kind, input.cfg, out);
    const row = insertMessage(db, { ...base, body: input.text, status: 'sent', error: null, external_id: res.externalId ?? null, sent_at: nowIso() });
    if (input.caseId) addTimeline(db, input.caseId, `Nachricht über ${CHANNEL_LABEL[kind]}${contact ? ` an ${contact.name}` : ''} gesendet`);
    const message = toDto(db, row);
    ctx.delivery.emit(account.id, { type: 'message.sent', message });
    return message;
  } catch (e) {
    const row = insertMessage(db, { ...base, body: input.text, status: 'failed', error: (e as Error).message.slice(0, 500) });
    return toDto(db, row);
  }
}

/** Best channel for a contact: the preferred one, else the first enabled channel with a known handle. */
export function bestChannelFor(db: Db, accountId: string, contactId: string): ChannelRow | undefined {
  const c = getContactRow(db, accountId, contactId);
  const channels = db.prepare('SELECT * FROM channels WHERE account_id = ? AND enabled = 1 ORDER BY created_at').all(accountId) as unknown as ChannelRow[];
  const usable = channels.filter((ch) => CAN_SEND.includes(ch.kind) && handleFor(db, contactId, ch.kind));
  return usable.find((ch) => ch.id === c.preferred_channel_id) ?? usable[0];
}
