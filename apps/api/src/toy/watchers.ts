import type { Context } from '../context.ts';
import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { newId } from '../security.ts';
import type { ChannelRow } from '../channels/store.ts';
import { parseFeed } from '../channels/feeds.ts';
import { POLLED, type ChannelConfigs } from '../channels/types.ts';
import { applyTransfer, expireInvoices, toTransfer } from '../services/invoices.ts';
import { GitHubClient, newlyDone, parseMilestones, ToyScanClient, type Milestone } from './clients.ts';

/**
 * Polled sources: data feeds, the progress of the Toy projects on GitHub and ToyScan (warning light, payments).
 * The first poll of a source only records the current state, so connecting a feed never floods the inbox.
 */

export function getState(db: Db, accountId: string, key: string): string | undefined {
  return (db.prepare('SELECT value FROM watch_state WHERE account_id = ? AND key = ?').get(accountId, key) as { value: string } | undefined)?.value;
}

export function setState(db: Db, accountId: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO watch_state (account_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(accountId, key, value, nowIso());
}

export interface PollResult {
  events: number;
  baseline: boolean;
}

export interface WatcherDeps {
  fetch?: typeof fetch;
  githubApi?: string;
}

export async function pollChannel(ctx: Context, row: ChannelRow, deps: WatcherDeps = {}): Promise<PollResult> {
  const f = deps.fetch ?? fetch;
  const { db } = ctx;
  const acc = row.account_id;
  let events = 0;

  if (row.kind === 'feed') {
    const cfg = ctx.channels.config(row as ChannelRow & { kind: 'feed' });
    const res = await f(cfg.url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, text/xml' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Feed antwortete mit ${res.status}`);
    const feed = parseFeed(await res.text());
    const baseline = !(db.prepare('SELECT 1 FROM seen_items WHERE channel_id = ? LIMIT 1').get(row.id));
    for (const item of feed.items.slice(0, 50)) {
      if (!item.key) continue;
      const fresh = db.prepare('INSERT OR IGNORE INTO seen_items (channel_id, item_key, created_at) VALUES (?, ?, ?)').run(row.id, item.key, nowIso());
      if (Number(fresh.changes) === 0 || baseline) continue;
      if (events >= 20) continue;
      events++;
      db.prepare(
        `INSERT INTO messages (id, account_id, channel_id, channel_kind, direction, subject, body, safety_json, status, external_id, created_at)
         VALUES (?, ?, ?, 'feed', 'in', ?, ?, '[]', 'received', ?, ?)`,
      ).run(newId('msg'), acc, row.id, item.title.slice(0, 300), [item.text.slice(0, 4000), item.link].filter(Boolean).join('\n\n'), item.key.slice(0, 300), nowIso());
      ctx.delivery.emit(acc, { type: 'feed.item', channelId: row.id, feed: feed.title, item: { ...item, text: item.text.slice(0, 2000) } });
    }
    return { events, baseline };
  }

  if (row.kind === 'github') {
    const cfg = ctx.channels.config(row as ChannelRow & { kind: 'github' });
    const gh = new GitHubClient(cfg.repo, cfg.token, deps.githubApi ?? ctx.config.githubApi, f);
    const shaKey = `gh:${row.id}:status_sha`;
    const msKey = `gh:${row.id}:milestones`;
    const relKey = `gh:${row.id}:releases`;
    const baseline = getState(db, acc, shaKey) === undefined;
    const sha = await gh.latestCommit('docs/STATUS.md', cfg.branch);
    if (sha && sha !== getState(db, acc, shaKey)) {
      const now = parseMilestones(await gh.fileText('docs/STATUS.md', cfg.branch));
      const before = JSON.parse(getState(db, acc, msKey) ?? '[]') as Milestone[];
      if (!baseline) {
        for (const m of newlyDone(before, now)) {
          events++;
          ctx.delivery.emit(acc, { type: 'project.milestone', repo: cfg.repo, milestone: m, url: `https://github.com/${cfg.repo}/blob/${cfg.branch}/docs/STATUS.md` });
        }
      }
      setState(db, acc, msKey, JSON.stringify(now));
      setState(db, acc, shaKey, sha);
    }
    const known = new Set(JSON.parse(getState(db, acc, relKey) ?? '[]') as number[]);
    const releases = (await gh.releases()).filter((r) => !r.draft);
    for (const r of releases) {
      if (known.has(r.id)) continue;
      known.add(r.id);
      if (baseline) continue;
      events++;
      ctx.delivery.emit(acc, { type: 'project.release', repo: cfg.repo, tag: r.tag_name, name: r.name ?? r.tag_name, notes: (r.body ?? '').slice(0, 4000), url: r.html_url });
    }
    setState(db, acc, relKey, JSON.stringify([...known]));
    return { events, baseline };
  }

  if (row.kind === 'toyscan') {
    const cfg = ctx.channels.config(row as ChannelRow & { kind: 'toyscan' });
    const scan = new ToyScanClient(cfg.url, f);
    const key = `toyscan:${row.id}:ampel`;
    const previous = getState(db, acc, key);
    const ampel = await scan.ampel();
    const stateNow = `${ampel.color}${ampel.bigRedLamp ? '+lampe' : ''}`;
    // first look: only report if something is already wrong
    if (stateNow !== previous && (previous !== undefined || ampel.color === 'rot')) {
      events++;
      ctx.delivery.emit(acc, {
        type: 'toy.ampel.changed',
        from: previous?.replace('+lampe', ''),
        to: ampel.color,
        bigRedLamp: ampel.bigRedLamp,
        criteria: ampel.criteria.map((c) => ({ id: c.id, color: c.color, note: c.note })),
        url: cfg.url,
      });
    }
    setState(db, acc, key, stateNow);
    // payments: watched addresses plus all addresses with open invoices
    const invoiceAddresses = (db.prepare(`SELECT DISTINCT address FROM toy_invoices WHERE account_id = ? AND status IN ('open', 'partial', 'expired')`).all(acc) as { address: string }[]).map((r) => r.address);
    for (const address of new Set([...cfg.watchAddresses, ...invoiceAddresses])) {
      const { transfers } = await scan.address(address);
      for (const raw of transfers) {
        const t = toTransfer(raw);
        if (t && t.to.toLowerCase() === address.toLowerCase() && applyTransfer(ctx, acc, t).booked) events++;
      }
    }
    return { events, baseline: previous === undefined };
  }

  return { events: 0, baseline: false };
}

/** Background loop: polls every source when it is due and expires overdue invoices once a day. */
export function startScheduler(ctx: Context, everyMs = 60_000): () => void {
  let running = false;
  let lastExpiry = '';
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = ctx.now();
      for (const row of ctx.channels.due(POLLED)) {
        const cfg = ctx.channels.config(row) as ChannelConfigs['feed'];
        const last = row.last_poll_at ? Date.parse(row.last_poll_at) : 0;
        if (now.getTime() - last < cfg.everyMinutes * 60_000) continue;
        try {
          await pollChannel(ctx, row);
          ctx.channels.markPolled(row.id, null);
        } catch (e) {
          ctx.channels.markPolled(row.id, (e as Error).message.slice(0, 300));
          ctx.log(`Abruf ${row.kind} ${row.name} fehlgeschlagen: ${(e as Error).message}`);
        }
      }
      const day = now.toISOString().slice(0, 10);
      if (day !== lastExpiry) {
        lastExpiry = day;
        expireInvoices(ctx.db, now);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
