import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Datenbankschicht auf Basis von node:sqlite (in Node.js enthalten, keine Abhängigkeit).
 * Alle Zugriffe laufen über diese Datei und die Repositories, damit später ein Postgres-Adapter
 * für große Installationen ergänzt werden kann, ohne die Routen anzufassen.
 */

const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    seats INTEGER NOT NULL DEFAULT 1,
    billing_interval TEXT,
    plan_renews_at TEXT,
    storage_used_bytes INTEGER NOT NULL DEFAULT 0,
    webhook_secret TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL
  );
  CREATE TABLE cases (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    title TEXT NOT NULL,
    correspondent TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    next_action TEXT,
    deadline_json TEXT,
    payment_json TEXT,
    reference TEXT,
    confidence REAL NOT NULL DEFAULT 1,
    follow_up_on TEXT,
    assignee_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX cases_account_status ON cases(account_id, status);
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    case_id TEXT REFERENCES cases(id),
    title TEXT NOT NULL,
    correspondent TEXT NOT NULL,
    kind TEXT NOT NULL,
    channel TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'in',
    letter_date TEXT NOT NULL,
    received_at TEXT NOT NULL,
    pages INTEGER NOT NULL DEFAULT 1,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    paperless_id INTEGER,
    file_path TEXT,
    content_text TEXT NOT NULL DEFAULT '',
    analysis_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX documents_account_case ON documents(account_id, case_id);
  CREATE UNIQUE INDEX documents_paperless ON documents(account_id, paperless_id) WHERE paperless_id IS NOT NULL;
  CREATE TABLE timeline (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id),
    at TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id),
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT NOT NULL,
    approved_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE credit_buckets (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL,
    granted_units INTEGER NOT NULL,
    remaining_units INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX credit_buckets_account ON credit_buckets(account_id, kind, expires_at);
  CREATE UNIQUE INDEX credit_buckets_plan_period ON credit_buckets(account_id, source) WHERE kind = 'plan';
  CREATE TABLE credit_ledger (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    delta_units INTEGER NOT NULL,
    action TEXT NOT NULL,
    ref TEXT,
    user_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX credit_ledger_account ON credit_ledger(account_id, created_at);
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    type TEXT NOT NULL,
    item_json TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE TABLE integrations (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL,
    config_enc TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, kind)
  );
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    match_text TEXT NOT NULL,
    correspondent TEXT NOT NULL,
    kind TEXT NOT NULL,
    case_id TEXT,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  `,
  // ---------- ToyPost: Kanäle, Kontakte, Nachrichten, Automationen, Toy-Anbindung ----------
  `
  ALTER TABLE cases ADD COLUMN contact_id TEXT;
  ALTER TABLE cases ADD COLUMN safety_json TEXT;
  ALTER TABLE cases ADD COLUMN toy_request_json TEXT;
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'de',
    toy_address TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    preferred_channel_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX contacts_account ON contacts(account_id);
  CREATE TABLE contact_handles (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    contact_id TEXT NOT NULL REFERENCES contacts(id),
    kind TEXT NOT NULL,
    handle TEXT NOT NULL,
    PRIMARY KEY (account_id, kind, handle)
  );
  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    config_enc TEXT NOT NULL,
    inbound_token TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_poll_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX channels_account ON channels(account_id);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    channel_id TEXT,
    channel_kind TEXT NOT NULL,
    direction TEXT NOT NULL,
    contact_id TEXT,
    case_id TEXT,
    document_id TEXT,
    external_id TEXT,
    thread_key TEXT,
    subject TEXT,
    body TEXT NOT NULL,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    safety_json TEXT NOT NULL DEFAULT '[]',
    language TEXT,
    status TEXT NOT NULL,
    error TEXT,
    broadcast_id TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX messages_account_created ON messages(account_id, created_at);
  CREATE INDEX messages_case ON messages(case_id);
  CREATE UNIQUE INDEX messages_external ON messages(account_id, channel_id, external_id) WHERE external_id IS NOT NULL;
  CREATE TABLE broadcasts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    audience_tag TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT,
    approved_by TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    conditions_json TEXT NOT NULL DEFAULT '[]',
    actions_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    runs INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE automation_log (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id),
    event_type TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE toy_invoices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    case_id TEXT,
    contact_id TEXT,
    code TEXT NOT NULL,
    address TEXT NOT NULL,
    amount_units TEXT NOT NULL,
    paid_units TEXT NOT NULL DEFAULT '0',
    purpose TEXT NOT NULL,
    note TEXT,
    valid_until TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    payments_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE UNIQUE INDEX toy_invoices_purpose ON toy_invoices(account_id, purpose);
  CREATE TABLE wallet_links (
    address TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE siwe_nonces (
    nonce TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE watch_state (
    account_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, key)
  );
  CREATE TABLE seen_items (
    channel_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, item_key)
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

/** Führt fn in einer Transaktion aus. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
