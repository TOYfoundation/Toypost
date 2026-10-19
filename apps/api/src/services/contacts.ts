import type { Db } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { HttpError } from '../http.ts';
import { newId } from '../security.ts';
import { checkAddress, toyLanguage, type ContactSummary, type MessageChannelKind } from '../shared.ts';

/**
 * One person, many channels: Anna writes an e-mail, sends a photo via Telegram and an SMS – ToyPost keeps one
 * contact with three handles, her language and, if known, her TOY address. Cases and messages hang on the contact.
 */

export interface ContactRow {
  id: string;
  account_id: string;
  name: string;
  language: string;
  toy_address: string | null;
  tags_json: string;
  preferred_channel_id: string | null;
  created_at: string;
  updated_at: string;
}

export function getContactRow(db: Db, accountId: string, id: string): ContactRow {
  const r = db.prepare('SELECT * FROM contacts WHERE id = ? AND account_id = ?').get(id, accountId) as ContactRow | undefined;
  if (!r) throw new HttpError(404, 'not_found', 'Diesen Kontakt gibt es nicht.');
  return r;
}

/** Finds the contact behind a handle or creates one. A language reported by the service fills an unknown language. */
export function resolveContact(
  db: Db,
  accountId: string,
  kind: MessageChannelKind,
  handle: string,
  hint: { name?: string; language?: string } = {},
): { contact: ContactRow; created: boolean } {
  const existing = db
    .prepare('SELECT c.* FROM contact_handles h JOIN contacts c ON c.id = h.contact_id WHERE h.account_id = ? AND h.kind = ? AND h.handle = ?')
    .get(accountId, kind, handle) as ContactRow | undefined;
  if (existing) return { contact: existing, created: false };
  const id = newId('ct');
  const now = nowIso();
  const language = hint.language ? toyLanguage(hint.language).code : 'de';
  tx(db, () => {
    db.prepare('INSERT INTO contacts (id, account_id, name, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      accountId,
      (hint.name ?? handle).slice(0, 120),
      language,
      now,
      now,
    );
    db.prepare('INSERT INTO contact_handles (account_id, contact_id, kind, handle) VALUES (?, ?, ?, ?)').run(accountId, id, kind, handle);
  });
  return { contact: getContactRow(db, accountId, id), created: true };
}

export function contactDto(db: Db, r: ContactRow): ContactSummary {
  const handles = db.prepare('SELECT kind, handle FROM contact_handles WHERE contact_id = ? ORDER BY kind').all(r.id) as {
    kind: MessageChannelKind;
    handle: string;
  }[];
  const open = (db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE contact_id = ? AND status != 'done'`).get(r.id) as { n: number }).n;
  const last = db.prepare('SELECT MAX(created_at) AS at FROM messages WHERE contact_id = ?').get(r.id) as { at: string | null };
  return {
    id: r.id,
    name: r.name,
    language: r.language,
    toyAddress: r.toy_address ?? undefined,
    tags: JSON.parse(r.tags_json) as string[],
    handles,
    openCases: open,
    lastMessageAt: last.at ?? undefined,
  };
}

export function listContacts(db: Db, accountId: string, opts: { tag?: string; q?: string } = {}): ContactSummary[] {
  const rows = db.prepare('SELECT * FROM contacts WHERE account_id = ? ORDER BY name COLLATE NOCASE').all(accountId) as unknown as ContactRow[];
  return rows
    .filter((r) => !opts.tag || (JSON.parse(r.tags_json) as string[]).includes(opts.tag))
    .filter((r) => !opts.q || r.name.toLowerCase().includes(opts.q.toLowerCase()))
    .map((r) => contactDto(db, r));
}

export interface ContactPatch {
  name?: string;
  language?: string;
  toyAddress?: string | null;
  tags?: string[];
  preferredChannelId?: string | null;
}

export function updateContact(db: Db, accountId: string, id: string, patch: ContactPatch): ContactSummary {
  const r = getContactRow(db, accountId, id);
  let address = r.toy_address;
  if (patch.toyAddress !== undefined) {
    if (patch.toyAddress === null || patch.toyAddress === '') address = null;
    else {
      const c = checkAddress(patch.toyAddress);
      if (!c.ok) throw new HttpError(400, 'invalid_input', c.reason === 'checksum' ? 'Die Prüfsumme der TOY-Adresse stimmt nicht. Tippfehler?' : 'Das ist keine gültige TOY-Adresse.');
      address = c.address;
    }
  }
  if (patch.tags && !patch.tags.every((t) => typeof t === 'string' && /^[\p{L}\p{N} _-]{1,30}$/u.test(t))) {
    throw new HttpError(400, 'invalid_input', 'Gruppen dürfen nur Buchstaben, Ziffern, Leerzeichen, - und _ enthalten (höchstens 30 Zeichen).');
  }
  if (patch.preferredChannelId) {
    const ch = db.prepare('SELECT id FROM channels WHERE id = ? AND account_id = ?').get(patch.preferredChannelId, accountId);
    if (!ch) throw new HttpError(400, 'invalid_input', 'Diesen Kanal gibt es nicht.');
  }
  db.prepare('UPDATE contacts SET name = ?, language = ?, toy_address = ?, tags_json = ?, preferred_channel_id = ?, updated_at = ? WHERE id = ?').run(
    patch.name?.trim().slice(0, 120) || r.name,
    patch.language ? toyLanguage(patch.language).code : r.language,
    address,
    patch.tags ? JSON.stringify([...new Set(patch.tags.map((t) => t.trim()))]) : r.tags_json,
    patch.preferredChannelId === undefined ? r.preferred_channel_id : patch.preferredChannelId,
    nowIso(),
    id,
  );
  return contactDto(db, getContactRow(db, accountId, id));
}

export function addHandle(db: Db, accountId: string, contactId: string, kind: MessageChannelKind, handle: string): ContactSummary {
  const r = getContactRow(db, accountId, contactId);
  const owner = db.prepare('SELECT contact_id FROM contact_handles WHERE account_id = ? AND kind = ? AND handle = ?').get(accountId, kind, handle) as
    | { contact_id: string }
    | undefined;
  if (owner && owner.contact_id !== contactId) {
    throw new HttpError(409, 'handle_taken', 'Diese Kennung gehört schon zu einem anderen Kontakt. Führe die beiden Kontakte zusammen.', { contactId: owner.contact_id });
  }
  if (!owner) db.prepare('INSERT INTO contact_handles (account_id, contact_id, kind, handle) VALUES (?, ?, ?, ?)').run(accountId, contactId, kind, handle);
  return contactDto(db, r);
}

/** Merges `fromId` into `intoId`: handles, cases, messages and invoices move over, nothing is lost. */
export function mergeContacts(db: Db, accountId: string, intoId: string, fromId: string): ContactSummary {
  if (intoId === fromId) throw new HttpError(400, 'invalid_input', 'Ein Kontakt kann nicht mit sich selbst zusammengeführt werden.');
  const into = getContactRow(db, accountId, intoId);
  const from = getContactRow(db, accountId, fromId);
  tx(db, () => {
    for (const t of ['contact_handles', 'cases', 'messages', 'toy_invoices']) {
      db.prepare(`UPDATE ${t} SET contact_id = ? WHERE contact_id = ?`).run(intoId, fromId);
    }
    const tags = [...new Set([...(JSON.parse(into.tags_json) as string[]), ...(JSON.parse(from.tags_json) as string[])])];
    db.prepare('UPDATE contacts SET tags_json = ?, toy_address = COALESCE(toy_address, ?), updated_at = ? WHERE id = ?').run(JSON.stringify(tags), from.toy_address, nowIso(), intoId);
    db.prepare('DELETE FROM contacts WHERE id = ?').run(fromId);
  });
  return contactDto(db, getContactRow(db, accountId, intoId));
}

/** Addresses the user knows (contacts, own invoices): basis for the look-alike warning. */
export function knownAddresses(db: Db, accountId: string): string[] {
  const rows = db
    .prepare(
      `SELECT toy_address AS a FROM contacts WHERE account_id = ? AND toy_address IS NOT NULL
       UNION SELECT address AS a FROM toy_invoices WHERE account_id = ?`,
    )
    .all(accountId, accountId) as { a: string }[];
  return rows.map((r) => r.a);
}

/** The user's own receiving addresses (invoices): never shown as "you should pay this". */
export function ownAddresses(db: Db, accountId: string): string[] {
  return (db.prepare('SELECT DISTINCT address FROM toy_invoices WHERE account_id = ?').all(accountId) as { address: string }[]).map((r) => r.address);
}
