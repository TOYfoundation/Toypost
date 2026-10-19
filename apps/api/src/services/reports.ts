import type { Context } from '../context.ts';
import type { ChannelRow } from '../channels/store.ts';
import { GitHubClient, parseMilestones, ToyScanClient } from '../toy/clients.ts';
import { formatToy, unitsFromWire } from '../shared.ts';

/**
 * Draft of the monthly public transparency report of the Toy projects (toycoin spec 15, decision 102:
 * from testnet start a report appears monthly in docs/berichte/). ToyPost collects what it knows:
 * project progress (STATUS.md), ToyScan warning light and supply, and the project's own correspondence
 * (counts only, no names or contents). A person reviews it; with a GitHub token it becomes a pull request.
 */

export interface ReportInput {
  /** YYYY-MM */
  month: string;
}

function monthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Monat im Format JJJJ-MM angeben.');
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const to = new Date(Date.UTC(y, m, 1)).toISOString();
  return { from, to };
}

export async function transparencyReport(ctx: Context, accountId: string, input: ReportInput): Promise<{ markdown: string; path: string }> {
  const { db } = ctx;
  const { from, to } = monthRange(input.month);
  const channels = db.prepare('SELECT * FROM channels WHERE account_id = ? AND enabled = 1').all(accountId) as unknown as ChannelRow[];
  const lines: string[] = [`# Transparenz-Bericht ${input.month}`, '', `Entwurf, erstellt von ToyPost am ${ctx.now().toISOString().slice(0, 10)}. Vor dem Veröffentlichen prüfen.`, ''];

  // 1. Project progress
  const gh = channels.find((c) => c.kind === 'github');
  lines.push('## Fortschritt', '');
  if (gh) {
    const cfg = ctx.channels.config(gh as ChannelRow & { kind: 'github' });
    try {
      const ms = parseMilestones(await new GitHubClient(cfg.repo, cfg.token, ctx.config.githubApi).fileText('docs/STATUS.md', cfg.branch));
      lines.push('| Meilenstein | Inhalt | Stand |', '|---|---|---|', ...ms.map((m) => `| ${m.id} | ${m.title} | ${m.status} |`));
    } catch (e) {
      lines.push(`_STATUS.md nicht lesbar: ${(e as Error).message}_`);
    }
  } else {
    lines.push('_Kein GitHub-Kanal verbunden._');
  }
  lines.push('');

  // 2. Chain health from ToyScan
  const scan = channels.find((c) => c.kind === 'toyscan');
  lines.push('## Kette und Warnampel', '');
  if (scan) {
    const cfg = ctx.channels.config(scan as ChannelRow & { kind: 'toyscan' });
    const client = new ToyScanClient(cfg.url);
    try {
      const ampel = await client.ampel();
      lines.push(`- Warnampel: **${ampel.color}**${ampel.bigRedLamp ? ' (große rote Lampe)' : ''}`);
      for (const k of ampel.criteria) lines.push(`  - ${k.id}: ${k.color}${k.note ? ` – ${k.note}` : ''}`);
    } catch (e) {
      lines.push(`- Warnampel nicht abrufbar: ${(e as Error).message}`);
    }
    try {
      const s = await client.supply();
      const minted = s?.gemintet ?? s?.minted;
      if (typeof minted === 'string') lines.push(`- Gemintet: ${formatToy(unitsFromWire(minted), 'de')} (Obergrenze 100.000.000 TOY)`);
    } catch {
      // supply is optional in the report
    }
  } else {
    lines.push('_ToyScan ist nicht verbunden._');
  }
  lines.push('');

  // 3. Correspondence of the project, counts only
  const byChannel = db
    .prepare(`SELECT channel_kind AS kind, direction, COUNT(*) AS n FROM messages WHERE account_id = ? AND created_at >= ? AND created_at < ? GROUP BY channel_kind, direction ORDER BY channel_kind`)
    .all(accountId, from, to) as { kind: string; direction: string; n: number }[];
  const warnings = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND created_at >= ? AND created_at < ? AND safety_json != '[]'`).get(accountId, from, to) as { n: number };
  const broadcasts = db.prepare(`SELECT COUNT(*) AS n FROM broadcasts WHERE account_id = ? AND status = 'sent' AND sent_at >= ? AND sent_at < ?`).get(accountId, from, to) as { n: number };
  lines.push('## Kommunikation', '');
  if (byChannel.length) {
    lines.push('| Kanal | eingegangen | gesendet |', '|---|---|---|');
    for (const kind of [...new Set(byChannel.map((r) => r.kind))]) {
      const n = (d: string) => byChannel.find((r) => r.kind === kind && r.direction === d)?.n ?? 0;
      lines.push(`| ${kind} | ${n('in')} | ${n('out')} |`);
    }
  } else {
    lines.push('Keine Nachrichten in diesem Monat.');
  }
  lines.push('', `- Mitteilungen an Gruppen: ${broadcasts.n}`, `- Nachrichten mit Sicherheitswarnung (Betrug, Phrase, Adress-Falle): ${warnings.n}`, '');
  lines.push('_Namen, Adressen und Inhalte von Nachrichten stehen bewusst nicht im Bericht._', '');
  return { markdown: lines.join('\n'), path: `docs/berichte/${input.month}.md` };
}
