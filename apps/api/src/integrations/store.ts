import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { HttpError } from '../http.ts';
import type { Keys } from '../security.ts';
import type { PaperlessConfig } from './paperless.ts';
import type { NextcloudConfig } from './nextcloud.ts';

export interface N8nConfig {
  /** Webhook-URL eines n8n-Workflows, an den ToyPost Ereignisse sendet */
  eventsUrl: string;
}

export interface IntegrationConfigs {
  /** publicUrl: Adresse, unter der Menschen Paperless öffnen (für Links in Aufgaben und Terminen) */
  paperless: PaperlessConfig & { caseFieldId?: number; publicUrl?: string };
  nextcloud: NextcloudConfig;
  n8n: N8nConfig;
}

export type IntegrationKind = keyof IntegrationConfigs;
export const INTEGRATION_KINDS: IntegrationKind[] = ['paperless', 'nextcloud', 'n8n'];

/** Zugangsdaten werden verschlüsselt gespeichert und nie vollständig an die App zurückgegeben. */
export class IntegrationStore {
  private readonly db: Db;
  private readonly keys: Keys;

  constructor(db: Db, keys: Keys) {
    this.db = db;
    this.keys = keys;
  }

  get<K extends IntegrationKind>(accountId: string, kind: K): IntegrationConfigs[K] | null {
    const row = this.db.prepare('SELECT config_enc FROM integrations WHERE account_id = ? AND kind = ?').get(accountId, kind) as
      | { config_enc: string }
      | undefined;
    return row ? (JSON.parse(this.keys.decrypt(row.config_enc)) as IntegrationConfigs[K]) : null;
  }

  set<K extends IntegrationKind>(accountId: string, kind: K, config: IntegrationConfigs[K]): void {
    this.db
      .prepare(
        `INSERT INTO integrations (account_id, kind, config_enc, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, kind) DO UPDATE SET config_enc = excluded.config_enc, updated_at = excluded.updated_at`,
      )
      .run(accountId, kind, this.keys.encrypt(JSON.stringify(config)), nowIso());
  }

  remove(accountId: string, kind: IntegrationKind): void {
    this.db.prepare('DELETE FROM integrations WHERE account_id = ? AND kind = ?').run(accountId, kind);
  }

  /** Für die App: Adresse und Benutzer sichtbar, Geheimnisse maskiert. */
  describe(accountId: string): Record<IntegrationKind, { connected: boolean; summary?: string }> {
    const p = this.get(accountId, 'paperless');
    const n = this.get(accountId, 'nextcloud');
    const w = this.get(accountId, 'n8n');
    return {
      paperless: { connected: !!p, summary: p ? new URL(p.url).host : undefined },
      nextcloud: { connected: !!n, summary: n ? `${n.user} @ ${new URL(n.url).host}` : undefined },
      n8n: { connected: !!w, summary: w ? new URL(w.eventsUrl).host : undefined },
    };
  }
}

export function validateIntegration(kind: IntegrationKind, body: any): IntegrationConfigs[IntegrationKind] {
  const url = (key: string) => {
    const v = body?.[key];
    try {
      const u = new URL(String(v));
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      return u.toString().replace(/\/$/, '');
    } catch {
      throw new HttpError(400, 'invalid_input', `"${key}" muss eine vollständige Adresse sein, z. B. https://paperless.example.de`);
    }
  };
  const str = (key: string, fallback?: string) => {
    const v = body?.[key] ?? fallback;
    if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'invalid_input', `Das Feld "${key}" fehlt.`);
    return v.trim();
  };
  switch (kind) {
    case 'paperless':
      return {
        url: url('url'),
        token: str('token'),
        caseFieldId: Number.isInteger(body?.caseFieldId) ? body.caseFieldId : undefined,
        publicUrl: body?.publicUrl ? url('publicUrl') : undefined,
      };
    case 'nextcloud':
      return {
        url: url('url'),
        user: str('user'),
        appPassword: str('appPassword'),
        calendar: str('calendar', 'personal'),
        folder: str('folder', 'ToyPost'),
      };
    case 'n8n':
      return { eventsUrl: url('eventsUrl') };
  }
}
