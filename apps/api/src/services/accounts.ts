import type { Db } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { HttpError } from '../http.ts';
import { hashPassword, newId, randomToken } from '../security.ts';
import { getBalance } from './credits.ts';
import type { Account, PlanId } from '../shared.ts';

export interface AccountRow {
  id: string;
  name: string;
  plan: PlanId;
  seats: number;
  billing_interval: 'month' | 'year' | null;
  plan_renews_at: string | null;
  storage_used_bytes: number;
  webhook_secret: string;
  created_at: string;
}

export interface UserRow {
  id: string;
  account_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: 'owner' | 'admin' | 'member';
}

export function createAccountWithOwner(db: Db, input: { name: string; email: string; password: string; accountName?: string }) {
  const email = input.email.toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'email_taken', 'Für diese E-Mail-Adresse gibt es schon ein Konto. Melde dich an.');
  }
  return tx(db, () => {
    const accountId = newId('acc');
    const userId = newId('usr');
    db.prepare('INSERT INTO accounts (id, name, plan, seats, webhook_secret, created_at) VALUES (?, ?, ?, 1, ?, ?)').run(
      accountId,
      input.accountName || input.name,
      'free',
      randomToken(32),
      nowIso(),
    );
    db.prepare('INSERT INTO users (id, account_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      userId,
      accountId,
      email,
      input.name,
      hashPassword(input.password),
      'owner',
      nowIso(),
    );
    return { accountId, userId };
  });
}

export function getAccountRow(db: Db, id: string): AccountRow {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  if (!row) throw new HttpError(404, 'not_found', 'Konto nicht gefunden.');
  return row;
}

export function getUserRow(db: Db, id: string): UserRow {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!row) throw new HttpError(401, 'unauthorized', 'Bitte melde dich erneut an.');
  return row;
}

export function toAccountDto(db: Db, acc: AccountRow, user: UserRow, now = new Date()): Account & { role: UserRow['role']; userName: string } {
  return {
    id: acc.id,
    name: acc.name,
    email: user.email,
    plan: acc.plan,
    seats: acc.seats,
    storageUsedBytes: acc.storage_used_bytes,
    credits: getBalance(db, acc, now),
    role: user.role,
    userName: user.name,
  };
}
