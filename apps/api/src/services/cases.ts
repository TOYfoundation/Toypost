import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { HttpError } from '../http.ts';
import { newId } from '../security.ts';
import {
  primaryDeadline,
  type Analysis,
  type CaseDetail,
  type CaseStatus,
  type CaseSummary,
  type Deadline,
  type DocumentSummary,
  type Payment,
  type SafetyNote,
  type ToyRequest,
} from '../shared.ts';
import { listMessages } from './messages.ts';
import { invoiceForCase } from './invoices.ts';

export interface CaseRow {
  id: string;
  account_id: string;
  title: string;
  correspondent: string;
  status: CaseStatus;
  summary: string;
  next_action: string | null;
  deadline_json: string | null;
  payment_json: string | null;
  reference: string | null;
  confidence: number;
  follow_up_on: string | null;
  assignee_user_id: string | null;
  contact_id: string | null;
  safety_json: string | null;
  toy_request_json: string | null;
  created_at: string;
  updated_at: string;
}

interface DocRow {
  id: string;
  case_id: string | null;
  title: string;
  correspondent: string;
  kind: DocumentSummary['kind'];
  channel: DocumentSummary['channel'];
  direction: 'in' | 'out';
  letter_date: string;
  received_at: string;
  pages: number;
  paperless_id: number | null;
}

export function docToSummary(r: DocRow): DocumentSummary {
  return {
    id: r.id,
    caseId: r.case_id,
    title: r.title,
    correspondent: r.correspondent,
    kind: r.kind,
    channel: r.channel,
    direction: r.direction,
    receivedAt: r.received_at,
    pages: r.pages,
    paperlessId: r.paperless_id ?? undefined,
  };
}

function toSummary(db: Db, r: CaseRow): CaseSummary {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM documents WHERE case_id = ?').get(r.id) as { n: number }).n;
  const assignee = r.assignee_user_id
    ? (db.prepare('SELECT name FROM users WHERE id = ?').get(r.assignee_user_id) as { name: string } | undefined)?.name
    : undefined;
  return {
    id: r.id,
    title: r.title,
    correspondent: r.correspondent,
    status: r.status,
    summary: r.summary,
    nextAction: r.next_action ?? undefined,
    deadline: r.deadline_json ? (JSON.parse(r.deadline_json) as Deadline) : undefined,
    payment: r.payment_json ? (JSON.parse(r.payment_json) as Payment) : undefined,
    reference: r.reference ?? undefined,
    updatedAt: r.updated_at,
    documentCount: count,
    assigneeName: assignee,
    confidence: r.confidence,
    followUpOn: r.follow_up_on ?? undefined,
    contact: r.contact_id
      ? (db.prepare('SELECT id, name FROM contacts WHERE id = ?').get(r.contact_id) as { id: string; name: string } | undefined)
      : undefined,
    safety: r.safety_json ? (JSON.parse(r.safety_json) as SafetyNote[]) : undefined,
    toyRequest: r.toy_request_json ? (JSON.parse(r.toy_request_json) as ToyRequest) : undefined,
    toyInvoice: invoiceForCase(db, r.id),
  };
}

export function getCaseRow(db: Db, accountId: string, id: string): CaseRow {
  const row = db.prepare('SELECT * FROM cases WHERE id = ? AND account_id = ?').get(id, accountId) as CaseRow | undefined;
  if (!row) throw new HttpError(404, 'not_found', 'Diesen Vorgang gibt es nicht oder er gehört zu einem anderen Konto.');
  return row;
}

export function getCaseSummary(db: Db, accountId: string, id: string): CaseSummary {
  return toSummary(db, getCaseRow(db, accountId, id));
}

export function getCaseDetail(db: Db, accountId: string, id: string): CaseDetail {
  const row = getCaseRow(db, accountId, id);
  const docs = db
    .prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY received_at DESC')
    .all(id) as unknown as DocRow[];
  const timeline = db.prepare('SELECT at, text FROM timeline WHERE case_id = ? ORDER BY at DESC, rowid DESC').all(id) as {
    at: string;
    text: string;
  }[];
  const draft = db
    .prepare(`SELECT id, subject, body, created_at FROM drafts WHERE case_id = ? AND status != 'sent' ORDER BY created_at DESC LIMIT 1`)
    .get(id) as { id: string; subject: string; body: string; created_at: string } | undefined;
  return {
    ...toSummary(db, row),
    documents: docs.map(docToSummary),
    messages: listMessages(db, row.account_id, { caseId: row.id, limit: 100 }),
    timeline,
    draft: draft ? { id: draft.id, subject: draft.subject, body: draft.body, createdAt: draft.created_at } : undefined,
  };
}

export function listCases(db: Db, accountId: string, opts: { status?: CaseStatus; q?: string } = {}): CaseSummary[] {
  const where = ['account_id = ?'];
  const args: (string | number)[] = [accountId];
  if (opts.status) {
    where.push('status = ?');
    args.push(opts.status);
  }
  if (opts.q) {
    where.push('(title LIKE ? OR correspondent LIKE ? OR reference LIKE ? OR summary LIKE ?)');
    const like = `%${opts.q}%`;
    args.push(like, like, like, like);
  }
  const rows = db.prepare(`SELECT * FROM cases WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 200`).all(...args) as unknown as CaseRow[];
  return rows.map((r) => toSummary(db, r));
}

/** Heute-Ansicht: Handlungsbedarf nach Frist sortiert, dann Wartendes, dann neue Infos der letzten 7 Tage. */
export function todayView(db: Db, accountId: string, today: string) {
  const all = listCases(db, accountId);
  const byDue = (a: CaseSummary, b: CaseSummary) =>
    (a.deadline?.date ?? '9999-12-31').localeCompare(b.deadline?.date ?? '9999-12-31') || b.updatedAt.localeCompare(a.updatedAt);
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString();
  return {
    today,
    action: all.filter((c) => c.status === 'action').sort(byDue),
    followUpDue: all.filter((c) => c.status === 'waiting' && c.followUpOn && c.followUpOn <= today),
    waiting: all.filter((c) => c.status === 'waiting' && !(c.followUpOn && c.followUpOn <= today)),
    newInfo: all.filter((c) => c.status === 'info' && c.updatedAt >= weekAgo),
  };
}

export function addTimeline(db: Db, caseId: string, text: string, at = nowIso()): void {
  db.prepare('INSERT INTO timeline (id, case_id, at, text) VALUES (?, ?, ?, ?)').run(newId('tl'), caseId, at, text);
}

export function createCase(db: Db, accountId: string, a: Analysis, today: string): CaseRow {
  const id = newId('case');
  const now = nowIso();
  const deadline = primaryDeadline(a.deadlines, today);
  db.prepare(
    `INSERT INTO cases (id, account_id, title, correspondent, status, summary, next_action, deadline_json, payment_json, reference, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    accountId,
    a.title,
    a.correspondent,
    a.actionRequired ? 'action' : 'info',
    a.summary,
    a.nextAction ?? null,
    deadline ? JSON.stringify(deadline) : null,
    a.payment ? JSON.stringify(a.payment) : null,
    a.reference ?? null,
    a.confidence,
    now,
    now,
  );
  return getCaseRow(db, accountId, id);
}

/** Neue Post in einem bestehenden Vorgang: Status, Frist und Zahlung werden aktualisiert. */
export function applyAnalysis(db: Db, row: CaseRow, a: Analysis, today: string): void {
  const deadline = primaryDeadline(a.deadlines, today);
  // Neue Handlung nötig → offen. Sonst bleibt ein offener Vorgang offen; eine Antwort auf "wartet" oder neue Post zu "erledigt" wird Info.
  const status: CaseStatus = a.actionRequired || row.status === 'action' ? 'action' : 'info';
  const keepOld = status === 'action' && !a.actionRequired;
  db.prepare(
    `UPDATE cases SET status = ?, summary = ?, next_action = ?, deadline_json = ?, payment_json = COALESCE(?, payment_json),
       reference = COALESCE(reference, ?), confidence = ?, follow_up_on = NULL, updated_at = ? WHERE id = ?`,
  ).run(
    status,
    keepOld ? row.summary : a.summary,
    a.actionRequired ? a.nextAction ?? row.next_action : keepOld ? row.next_action : null,
    deadline ? JSON.stringify(deadline) : status === 'action' ? row.deadline_json : null,
    a.payment ? JSON.stringify(a.payment) : null,
    a.reference ?? null,
    a.confidence,
    nowIso(),
    row.id,
  );
}

export interface CasePatch {
  status?: CaseStatus;
  followUpOn?: string | null;
  assigneeUserId?: string | null;
  title?: string;
}

export function updateCase(db: Db, accountId: string, id: string, patch: CasePatch): CaseSummary {
  const row = getCaseRow(db, accountId, id);
  if (patch.assigneeUserId) {
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND account_id = ?').get(patch.assigneeUserId, accountId);
    if (!u) throw new HttpError(400, 'invalid_input', 'Diese Person gehört nicht zum Konto.');
  }
  const next = {
    status: patch.status ?? row.status,
    follow_up_on: patch.followUpOn === undefined ? row.follow_up_on : patch.followUpOn,
    assignee_user_id: patch.assigneeUserId === undefined ? row.assignee_user_id : patch.assigneeUserId,
    title: patch.title ?? row.title,
  };
  db.prepare('UPDATE cases SET status = ?, follow_up_on = ?, assignee_user_id = ?, title = ?, updated_at = ? WHERE id = ?').run(
    next.status,
    next.follow_up_on,
    next.assignee_user_id,
    next.title,
    nowIso(),
    id,
  );
  if (patch.status && patch.status !== row.status) {
    const label: Record<CaseStatus, string> = {
      action: 'wieder geöffnet',
      waiting: 'wartet auf Antwort',
      info: 'als Info abgelegt',
      done: 'als erledigt markiert',
    };
    addTimeline(db, id, `Vorgang ${label[patch.status]}`);
  }
  return getCaseSummary(db, accountId, id);
}
