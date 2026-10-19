import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { HttpError } from '../http.ts';
import { newId, randomToken, type Keys } from '../security.ts';
import { CAN_SEND, CHANNEL_LABEL, HANDLE_KIND, POLLED, type ChannelConfigs, type ChannelKind } from './types.ts';

export interface ChannelRow {
  id: string;
  account_id: string;
  kind: ChannelKind;
  name: string;
  config_enc: string;
  inbound_token: string;
  enabled: number;
  last_poll_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface ChannelDto {
  id: string;
  kind: ChannelKind;
  kindLabel: string;
  name: string;
  enabled: boolean;
  canSend: boolean;
  polled: boolean;
  handleLabel?: string;
  /** where the service delivers incoming messages (with token), only for admins */
  inboundUrl?: string;
  summary: string;
  lastPollAt?: string;
  lastError?: string;
}

/** Channel settings encrypted like the other integrations; the app sees only a masked summary. */
export class ChannelStore {
  private readonly db: Db;
  private readonly keys: Keys;

  constructor(db: Db, keys: Keys) {
    this.db = db;
    this.keys = keys;
  }

  create<K extends ChannelKind>(accountId: string, kind: K, name: string, config: ChannelConfigs[K]): ChannelRow {
    const id = newId('ch');
    this.db
      .prepare('INSERT INTO channels (id, account_id, kind, name, config_enc, inbound_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, accountId, kind, name, this.keys.encrypt(JSON.stringify(config)), randomToken(24), nowIso());
    return this.row(accountId, id);
  }

  update<K extends ChannelKind>(accountId: string, id: string, patch: { name?: string; enabled?: boolean; config?: ChannelConfigs[K] }): ChannelRow {
    const row = this.row(accountId, id);
    this.db
      .prepare('UPDATE channels SET name = ?, enabled = ?, config_enc = ? WHERE id = ?')
      .run(
        patch.name ?? row.name,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        patch.config ? this.keys.encrypt(JSON.stringify(patch.config)) : row.config_enc,
        id,
      );
    return this.row(accountId, id);
  }

  remove(accountId: string, id: string): void {
    this.row(accountId, id);
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  }

  row(accountId: string, id: string): ChannelRow {
    const r = this.db.prepare('SELECT * FROM channels WHERE id = ? AND account_id = ?').get(id, accountId) as ChannelRow | undefined;
    if (!r) throw new HttpError(404, 'not_found', 'Diesen Kanal gibt es nicht.');
    return r;
  }

  /** For inbound requests: the channel id is in the URL, the account follows from it. */
  byId(id: string): ChannelRow {
    const r = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
    if (!r) throw new HttpError(404, 'not_found', 'Diesen Kanal gibt es nicht.');
    return r;
  }

  list(accountId: string): ChannelRow[] {
    return this.db.prepare('SELECT * FROM channels WHERE account_id = ? ORDER BY created_at').all(accountId) as unknown as ChannelRow[];
  }

  due(kinds: readonly ChannelKind[]): ChannelRow[] {
    const placeholders = kinds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM channels WHERE enabled = 1 AND kind IN (${placeholders})`).all(...kinds) as unknown as ChannelRow[];
  }

  config<K extends ChannelKind>(row: ChannelRow & { kind: K }): ChannelConfigs[K] {
    return JSON.parse(this.keys.decrypt(row.config_enc)) as ChannelConfigs[K];
  }

  markPolled(id: string, error: string | null): void {
    this.db.prepare('UPDATE channels SET last_poll_at = ?, last_error = ? WHERE id = ?').run(nowIso(), error, id);
  }

  dto(row: ChannelRow, publicUrl: string, admin: boolean): ChannelDto {
    const cfg = this.config(row) as any;
    const host = (u?: string) => {
      try {
        return u ? new URL(u).host : '';
      } catch {
        return '';
      }
    };
    const summary: Record<ChannelKind, () => string> = {
      email: () => `${cfg.from} über ${cfg.host}`,
      telegram: () => `Bot ${String(cfg.botToken).split(':')[0]}`,
      matrix: () => host(cfg.homeserver),
      signal: () => cfg.number,
      sms: () => (cfg.provider === 'twilio' ? `Twilio ${cfg.from}` : cfg.provider === 'android' ? `Android-Gateway ${host(cfg.url)}` : host(cfg.url)),
      ntfy: () => `${host(cfg.server)}/${cfg.topic}`,
      talk: () => host(cfg.url),
      discord: () => 'Discord-Webhook',
      slack: () => 'Slack-Webhook',
      webhook: () => host(cfg.url),
      feed: () => `${host(cfg.url)}, alle ${cfg.everyMinutes} Min.`,
      github: () => `${cfg.repo} (${cfg.branch}), alle ${cfg.everyMinutes} Min.`,
      toyscan: () => `${host(cfg.url)}${cfg.watchAddresses?.length ? `, ${cfg.watchAddresses.length} Adressen` : ''}`,
    };
    const receives = !POLLED.includes(row.kind) && !['discord', 'slack', 'ntfy', 'webhook'].includes(row.kind);
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: CHANNEL_LABEL[row.kind],
      name: row.name,
      enabled: !!row.enabled,
      canSend: CAN_SEND.includes(row.kind),
      polled: POLLED.includes(row.kind),
      handleLabel: HANDLE_KIND[row.kind],
      inboundUrl: admin && (receives || row.kind === 'toyscan') ? `${publicUrl}/v1/inbox/${row.id}?token=${row.inbound_token}` : undefined,
      summary: summary[row.kind](),
      lastPollAt: row.last_poll_at ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  }
}
