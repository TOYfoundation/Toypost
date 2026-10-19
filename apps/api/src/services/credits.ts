import type { Db } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { HttpError } from '../http.ts';
import { newId } from '../security.ts';
import {
  allocateSpend,
  CREDIT_ACTION_LABEL,
  costOf,
  monthlyCreditGrant,
  PURCHASED_VALIDITY_MONTHS,
  toCredits,
  toUnits,
  type CreditAction,
  type CreditBalance,
  type CreditBucket,
  type PlanId,
} from '../shared.ts';

function periodOf(now: Date): { source: string; expiresAt: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const source = `plan:${y}-${String(m + 1).padStart(2, '0')}`;
  const expiresAt = new Date(Date.UTC(y, m + 1, 1)).toISOString();
  return { source, expiresAt };
}

interface AccountRow {
  id: string;
  plan: PlanId;
  seats: number;
}

/**
 * Legt das Monatskontingent des laufenden Monats an, falls es fehlt (idempotent).
 * Bei einem Upgrade im laufenden Monat wird die Differenz sofort gutgeschrieben.
 */
export function ensureMonthlyGrant(db: Db, account: AccountRow, now = new Date()): void {
  const { source, expiresAt } = periodOf(now);
  const grantUnits = toUnits(monthlyCreditGrant(account.plan, account.seats));
  const existing = db
    .prepare(`SELECT id, granted_units FROM credit_buckets WHERE account_id = ? AND kind = 'plan' AND source = ?`)
    .get(account.id, source) as { id: string; granted_units: number } | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO credit_buckets (id, account_id, kind, granted_units, remaining_units, expires_at, source, created_at)
       VALUES (?, ?, 'plan', ?, ?, ?, ?, ?)`,
    ).run(newId('cb'), account.id, grantUnits, grantUnits, expiresAt, source, nowIso());
    db.prepare(`INSERT INTO credit_ledger (id, account_id, delta_units, action, ref, user_id, created_at) VALUES (?, ?, ?, 'grant', ?, NULL, ?)`).run(
      newId('cl'),
      account.id,
      grantUnits,
      source,
      nowIso(),
    );
    return;
  }
  if (grantUnits > existing.granted_units) {
    const delta = grantUnits - existing.granted_units;
    db.prepare(`UPDATE credit_buckets SET granted_units = ?, remaining_units = remaining_units + ? WHERE id = ?`).run(
      grantUnits,
      delta,
      existing.id,
    );
    db.prepare(`INSERT INTO credit_ledger (id, account_id, delta_units, action, ref, user_id, created_at) VALUES (?, ?, ?, 'grant-upgrade', ?, NULL, ?)`).run(
      newId('cl'),
      account.id,
      delta,
      source,
      nowIso(),
    );
  }
}

function liveBuckets(db: Db, accountId: string, now: Date): CreditBucket[] {
  const rows = db
    .prepare(
      `SELECT id, kind, remaining_units, expires_at FROM credit_buckets
       WHERE account_id = ? AND remaining_units > 0 AND expires_at > ?`,
    )
    .all(accountId, now.toISOString()) as { id: string; kind: 'plan' | 'purchased'; remaining_units: number; expires_at: string }[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, remainingUnits: r.remaining_units, expiresAt: r.expires_at }));
}

export function getBalance(db: Db, account: AccountRow, now = new Date()): CreditBalance {
  ensureMonthlyGrant(db, account, now);
  const buckets = liveBuckets(db, account.id, now);
  const plan = buckets.filter((b) => b.kind === 'plan').reduce((s, b) => s + b.remainingUnits, 0);
  const purchased = buckets.filter((b) => b.kind === 'purchased').reduce((s, b) => s + b.remainingUnits, 0);
  const { expiresAt } = periodOf(now);
  return {
    total: toCredits(plan + purchased),
    plan: toCredits(plan),
    purchased: toCredits(purchased),
    monthlyGrant: monthlyCreditGrant(account.plan, account.seats),
    planResetsOn: expiresAt.slice(0, 10),
  };
}

/**
 * Bucht Credits für eine KI-Aktion ab. Reicht das Guthaben nicht, wird nichts gebucht
 * und ein 402-Fehler mit dem fehlenden Betrag ausgelöst.
 */
export function spendCredits(
  db: Db,
  account: AccountRow,
  action: CreditAction,
  opts: { quantity?: number; ref?: string; userId?: string; now?: Date } = {},
): number {
  const now = opts.now ?? new Date();
  const units = costOf(action, opts.quantity ?? 1);
  return tx(db, () => {
    ensureMonthlyGrant(db, account, now);
    const result = allocateSpend(liveBuckets(db, account.id, now), units, now);
    if (!result.ok) {
      throw new HttpError(
        402,
        'credits_exhausted',
        `Für „${CREDIT_ACTION_LABEL[action]}“ fehlen ${toCredits(result.shortfallUnits)} Credits. Kaufe ein Credit-Paket oder warte bis zum Monatswechsel.`,
        { needed: toCredits(units), shortfall: toCredits(result.shortfallUnits) },
      );
    }
    const upd = db.prepare(`UPDATE credit_buckets SET remaining_units = remaining_units - ? WHERE id = ?`);
    for (const d of result.deductions) upd.run(d.units, d.bucketId);
    db.prepare(`INSERT INTO credit_ledger (id, account_id, delta_units, action, ref, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      newId('cl'),
      account.id,
      -units,
      action,
      opts.ref ?? null,
      opts.userId ?? null,
      now.toISOString(),
    );
    return toCredits(units);
  });
}

/** Gibt Credits zurück, wenn eine bezahlte Aktion technisch fehlschlug. */
export function refundCredits(db: Db, accountId: string, credits: number, ref: string): void {
  const units = toUnits(credits);
  const now = new Date();
  db.prepare(
    `INSERT INTO credit_buckets (id, account_id, kind, granted_units, remaining_units, expires_at, source, created_at)
     VALUES (?, ?, 'purchased', ?, ?, ?, ?, ?)`,
  ).run(newId('cb'), accountId, units, units, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1)).toISOString(), `refund:${ref}`, nowIso());
  db.prepare(`INSERT INTO credit_ledger (id, account_id, delta_units, action, ref, user_id, created_at) VALUES (?, ?, ?, 'refund', ?, NULL, ?)`).run(
    newId('cl'),
    accountId,
    units,
    ref,
    nowIso(),
  );
}

export function addPurchasedCredits(db: Db, accountId: string, credits: number, orderId: string, now = new Date()): void {
  const units = toUnits(credits);
  const expires = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + PURCHASED_VALIDITY_MONTHS, now.getUTCDate()));
  db.prepare(
    `INSERT INTO credit_buckets (id, account_id, kind, granted_units, remaining_units, expires_at, source, created_at)
     VALUES (?, ?, 'purchased', ?, ?, ?, ?, ?)`,
  ).run(newId('cb'), accountId, units, units, expires.toISOString(), `order:${orderId}`, nowIso());
  db.prepare(`INSERT INTO credit_ledger (id, account_id, delta_units, action, ref, user_id, created_at) VALUES (?, ?, ?, 'purchase', ?, NULL, ?)`).run(
    newId('cl'),
    accountId,
    units,
    orderId,
    nowIso(),
  );
}

export function ledger(db: Db, accountId: string, limit = 50) {
  const rows = db
    .prepare(`SELECT delta_units, action, ref, created_at FROM credit_ledger WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(accountId, limit) as { delta_units: number; action: string; ref: string | null; created_at: string }[];
  return rows.map((r) => ({
    credits: toCredits(r.delta_units),
    action: r.action,
    label: (CREDIT_ACTION_LABEL as Record<string, string>)[r.action] ?? LEDGER_LABEL[r.action] ?? r.action,
    ref: r.ref,
    at: r.created_at,
  }));
}

const LEDGER_LABEL: Record<string, string> = {
  grant: 'Monatskontingent',
  'grant-upgrade': 'Aufstockung durch Tarifwechsel',
  purchase: 'Credit-Paket gekauft',
  refund: 'Erstattung nach Fehler',
};
