import { randomBytes } from 'node:crypto';
import type { Context } from '../context.ts';
import type { Db } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { HttpError } from '../http.ts';
import { newId } from '../security.ts';
import {
  buildPaymentLink,
  checkAddress,
  invoicePurpose,
  parseToy,
  todayIso,
  toyDecimal,
  unitsFromWire,
  type ToyInvoiceSummary,
} from '../shared.ts';
import { addTimeline, updateCase } from './cases.ts';

/**
 * TOY invoices: ToyPost asks for a payment with a toychain: link (QR code) and a unique purpose ("TP-7K3Q …").
 * When ToyScan reports a transfer to the address with that purpose, the invoice is paid and the case is closed.
 * ToyPost never holds keys and never sends TOY itself: paying always happens in the TOYPAY wallet.
 */

interface InvoiceRow {
  id: string;
  account_id: string;
  case_id: string | null;
  contact_id: string | null;
  code: string;
  address: string;
  amount_units: string;
  paid_units: string;
  purpose: string;
  note: string | null;
  valid_until: string | null;
  status: ToyInvoiceSummary['status'];
  payments_json: string;
  created_at: string;
  paid_at: string | null;
}

/** A transfer on ToyChain as ToyScan reports it (fields normalised by toTransfer). */
export interface ToyTransfer {
  hash: string;
  from: string;
  to: string;
  /** smallest units */
  amount: bigint;
  purpose?: string;
  block?: number;
  at?: string;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

function newCode(): string {
  const bytes = randomBytes(6);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function toSummary(r: InvoiceRow): ToyInvoiceSummary {
  return {
    id: r.id,
    code: r.code,
    address: r.address,
    amount: r.amount_units,
    paid: r.paid_units,
    purpose: r.purpose,
    status: r.status,
    validUntil: r.valid_until ?? undefined,
    link: buildPaymentLink({ address: r.address, amount: r.status === 'paid' ? BigInt(r.amount_units) : BigInt(r.amount_units) - BigInt(r.paid_units), purpose: r.purpose, note: r.note ?? undefined, validUntil: r.valid_until ?? undefined }),
  };
}

export function invoiceForCase(db: Db, caseId: string): ToyInvoiceSummary | undefined {
  const r = db.prepare('SELECT * FROM toy_invoices WHERE case_id = ? ORDER BY created_at DESC LIMIT 1').get(caseId) as InvoiceRow | undefined;
  return r ? toSummary(r) : undefined;
}

export function listInvoices(db: Db, accountId: string): ToyInvoiceSummary[] {
  return (db.prepare('SELECT * FROM toy_invoices WHERE account_id = ? ORDER BY created_at DESC').all(accountId) as unknown as InvoiceRow[]).map(toSummary);
}

export function createInvoice(
  db: Db,
  accountId: string,
  input: { address: string; amount: string; label?: string; note?: string; validUntil?: string; caseId?: string; contactId?: string },
): ToyInvoiceSummary {
  const a = checkAddress(input.address);
  if (!a.ok) throw new HttpError(400, 'invalid_input', a.reason === 'checksum' ? 'Die Prüfsumme der Empfangsadresse stimmt nicht.' : 'Das ist keine gültige Empfangsadresse.');
  let units: bigint;
  try {
    units = parseToy(input.amount);
  } catch (e) {
    throw new HttpError(400, 'invalid_input', (e as Error).message);
  }
  if (units === 0n) throw new HttpError(400, 'invalid_input', 'Der Betrag muss größer als 0 sein.');
  if (input.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil)) throw new HttpError(400, 'invalid_input', '"validUntil" muss ein Datum JJJJ-MM-TT sein.');
  if (input.note && input.note.length > 300) throw new HttpError(400, 'invalid_input', 'Die Nachricht an den Zahler darf höchstens 300 Zeichen haben.');
  let code = newCode();
  while (db.prepare('SELECT 1 FROM toy_invoices WHERE account_id = ? AND code = ?').get(accountId, code)) code = newCode();
  const id = newId('inv');
  const purpose = invoicePurpose(code, input.label);
  db.prepare(
    `INSERT INTO toy_invoices (id, account_id, case_id, contact_id, code, address, amount_units, purpose, note, valid_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, accountId, input.caseId ?? null, input.contactId ?? null, code, a.address, units.toString(), purpose, input.note ?? null, input.validUntil ?? null, nowIso());
  if (input.caseId) addTimeline(db, input.caseId, `TOY-Rechnung ${code} über ${toyDecimal(units)} TOY erstellt`);
  return toSummary(db.prepare('SELECT * FROM toy_invoices WHERE id = ?').get(id) as unknown as InvoiceRow);
}

/**
 * Pure matching rule (tested on its own): the transfer goes to the invoice address and its purpose starts with
 * the invoice code "TP-XXXXXX". The code alone is enough, so a payer who shortened the purpose still matches.
 */
export function matchInvoice<T extends { address: string; code: string; status: string }>(invoices: readonly T[], t: Pick<ToyTransfer, 'to' | 'purpose'>): T | undefined {
  const purpose = (t.purpose ?? '').trim().toUpperCase();
  return invoices.find(
    (i) =>
      ['open', 'partial', 'expired'].includes(i.status) &&
      i.address.toLowerCase() === t.to.toLowerCase() &&
      (purpose === `TP-${i.code}` || purpose.startsWith(`TP-${i.code} `)),
  );
}

/** Field names of ToyScan are not final yet (ToyScan is planned for M11); both German and English names are accepted. */
export function toTransfer(o: any): ToyTransfer | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const hash = o.hash ?? o.txHash ?? o.transaktion;
  const from = o.from ?? o.von;
  const to = o.to ?? o.an;
  const raw = o.value ?? o.amount ?? o.betrag;
  const amountWire = typeof raw === 'object' && raw ? raw.wert ?? raw.value ?? raw.einheiten : raw;
  if (typeof hash !== 'string' || typeof from !== 'string' || typeof to !== 'string' || typeof amountWire !== 'string') return undefined;
  const fa = checkAddress(from);
  const ta = checkAddress(to);
  if (!fa.ok || !ta.ok) return undefined;
  let amount: bigint;
  try {
    amount = unitsFromWire(amountWire);
  } catch {
    return undefined;
  }
  const purpose = o.purpose ?? o.zweck ?? o.verwendungszweck;
  const block = Number(o.block ?? o.blockNumber ?? o.hoehe);
  return {
    hash,
    from: fa.address,
    to: ta.address,
    amount,
    purpose: typeof purpose === 'string' ? purpose : undefined,
    block: Number.isFinite(block) ? block : undefined,
    at: typeof (o.time ?? o.zeit) === 'string' ? (o.time ?? o.zeit) : undefined,
  };
}

/** Books a transfer on the matching invoice. Idempotent: the same transaction hash counts once. */
export function applyTransfer(ctx: Context, accountId: string, t: ToyTransfer): { invoice?: ToyInvoiceSummary; booked: boolean } {
  const { db } = ctx;
  const rows = db.prepare(`SELECT * FROM toy_invoices WHERE account_id = ? AND lower(address) = lower(?)`).all(accountId, t.to) as unknown as InvoiceRow[];
  const row = matchInvoice(rows, t);
  if (!row) return { booked: false };
  const result = tx(db, () => {
    const fresh = db.prepare('SELECT * FROM toy_invoices WHERE id = ?').get(row.id) as unknown as InvoiceRow;
    const payments = JSON.parse(fresh.payments_json) as { hash: string }[];
    if (payments.some((p) => p.hash === t.hash)) return { booked: false, row: fresh };
    const paid = BigInt(fresh.paid_units) + t.amount;
    const status: InvoiceRow['status'] = paid >= BigInt(fresh.amount_units) ? 'paid' : 'partial';
    payments.push({ hash: t.hash, from: t.from, amount: t.amount.toString(), block: t.block, at: t.at ?? nowIso() } as any);
    db.prepare('UPDATE toy_invoices SET paid_units = ?, status = ?, payments_json = ?, paid_at = ? WHERE id = ?').run(
      paid.toString(),
      status,
      JSON.stringify(payments),
      status === 'paid' ? nowIso() : fresh.paid_at,
      fresh.id,
    );
    if (fresh.case_id) {
      addTimeline(db, fresh.case_id, `${toyDecimal(t.amount)} TOY eingegangen (Rechnung ${fresh.code}${status === 'paid' ? ', vollständig bezahlt' : ', Teilzahlung'})`);
    }
    return { booked: true, row: db.prepare('SELECT * FROM toy_invoices WHERE id = ?').get(row.id) as unknown as InvoiceRow };
  });
  const invoice = toSummary(result.row);
  if (result.booked) {
    if (invoice.status === 'paid' && result.row.case_id) {
      const summary = updateCase(db, accountId, result.row.case_id, { status: 'done' });
      ctx.delivery.emit(accountId, { type: 'case.updated', case: summary });
    }
    ctx.delivery.emit(accountId, {
      type: 'toy.payment.received',
      invoice,
      transfer: { hash: t.hash, from: t.from, amount: t.amount.toString(), purpose: t.purpose },
      caseId: result.row.case_id ?? undefined,
      contactId: result.row.contact_id ?? undefined,
    });
  }
  return { invoice, booked: result.booked };
}

/** Marks overdue invoices as expired (they can still be paid; the status only informs). */
export function expireInvoices(db: Db, now: Date): number {
  return Number(db.prepare(`UPDATE toy_invoices SET status = 'expired' WHERE status = 'open' AND valid_until IS NOT NULL AND valid_until < ?`).run(todayIso(now)).changes);
}
