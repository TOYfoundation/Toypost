import type { Context } from '../context.ts';
import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { HttpError } from '../http.ts';
import { newId } from '../security.ts';
import type { ChannelRow } from '../channels/store.ts';
import { BROADCAST_TARGET, CAN_SEND } from '../channels/types.ts';
import { GitHubClient } from '../toy/clients.ts';
import { blocksSending, checkSafety, formatToy, toyLanguage, type CaseStatus } from '../shared.ts';
import type { ToyPostEvent } from './delivery.ts';
import { getAccountRow } from './accounts.ts';
import { createBroadcast } from './broadcasts.ts';
import { getContactRow, updateContact } from './contacts.ts';
import { bestChannelFor, sendMessage } from './messages.ts';
import { addTimeline, updateCase } from './cases.ts';

/**
 * Automations: when <event> and <conditions>, do <actions>. Declarative JSON, no code, no scripting.
 * Anything that reaches many people only creates a draft for approval; direct sending is allowed for replies to
 * one person and for push notices to the user's own announcement channel.
 */

export const TRIGGERS = [
  'message.received',
  'message.sent',
  'document.analyzed',
  'deadline.detected',
  'case.updated',
  'toy.payment.received',
  'toy.ampel.changed',
  'project.milestone',
  'project.release',
  'feed.item',
  'safety.warning',
] as const;
export type Trigger = (typeof TRIGGERS)[number];

export interface Condition {
  /** dotted path into the event, e.g. "message.channelKind", "to", "milestone.id" */
  field: string;
  op: 'eq' | 'neq' | 'contains' | 'not_contains' | 'in' | 'matches' | 'exists';
  value?: string | string[];
}

export type Action =
  | { type: 'notify'; channelId: string; title: string; text: string }
  | { type: 'reply'; text: string; subject?: string; translate?: boolean }
  | { type: 'compose_reply'; purpose: 'payment_thanks' | 'security_reply'; facts: string[]; send: boolean }
  | { type: 'broadcast_draft'; audience: string; purpose: 'milestone' | 'release' | 'incident' | 'report'; facts: string[] }
  | { type: 'github_issue'; channelId: string; title: string; body: string; labels?: string[] }
  | { type: 'tag_contact'; tag: string }
  | { type: 'case_status'; status: CaseStatus };

export interface AutomationDto {
  id: string;
  name: string;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
  runs: number;
  lastRunAt?: string;
  log: { at: string; result: string }[];
}

interface Row {
  id: string;
  account_id: string;
  name: string;
  trigger: Trigger;
  conditions_json: string;
  actions_json: string;
  enabled: number;
  runs: number;
  last_run_at: string | null;
}

// ---------- evaluation (pure, tested on its own) ----------

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function matches(event: unknown, conditions: readonly Condition[]): boolean {
  return conditions.every((c) => {
    const raw = getPath(event, c.field);
    const v = raw === undefined || raw === null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    const want = c.value;
    switch (c.op) {
      case 'exists':
        return raw !== undefined && raw !== null && v !== '';
      case 'eq':
        return v === String(want ?? '');
      case 'neq':
        return v !== String(want ?? '');
      case 'contains':
        return v.toLowerCase().includes(String(want ?? '').toLowerCase());
      case 'not_contains':
        return !v.toLowerCase().includes(String(want ?? '').toLowerCase());
      case 'in':
        return Array.isArray(want) && want.map(String).includes(v);
      case 'matches':
        try {
          return new RegExp(String(want ?? ''), 'i').test(v);
        } catch {
          return false;
        }
    }
  });
}

/** {{path}} placeholders filled from the event; values are cut to 500 characters, nothing is executed. */
export function fill(template: string, event: unknown): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    if (path === 'amountToy') {
      const units = getPath(event, 'transfer.amount') ?? getPath(event, 'invoice.amount');
      try {
        return formatToy(BigInt(String(units)), 'de');
      } catch {
        return '';
      }
    }
    const v = getPath(event, path);
    if (v === undefined || v === null) return '';
    return (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 500);
  });
}

function validate(trigger: unknown, conditions: unknown, actions: unknown): { trigger: Trigger; conditions: Condition[]; actions: Action[] } {
  if (!TRIGGERS.includes(trigger as Trigger)) throw new HttpError(400, 'invalid_input', `Unbekannter Auslöser. Erlaubt: ${TRIGGERS.join(', ')}.`);
  if (!Array.isArray(conditions) || conditions.length > 10) throw new HttpError(400, 'invalid_input', 'Höchstens 10 Bedingungen.');
  for (const c of conditions as Condition[]) {
    if (typeof c?.field !== 'string' || !/^[\w.]{1,80}$/.test(c.field)) throw new HttpError(400, 'invalid_input', 'Bedingung: "field" ist ungültig.');
    if (!['eq', 'neq', 'contains', 'not_contains', 'in', 'matches', 'exists'].includes(c.op)) throw new HttpError(400, 'invalid_input', 'Bedingung: unbekannter Vergleich.');
    if (c.op === 'matches') {
      if (typeof c.value !== 'string' || c.value.length > 200) throw new HttpError(400, 'invalid_input', 'Muster zu lang.');
      try {
        new RegExp(c.value);
      } catch {
        throw new HttpError(400, 'invalid_input', 'Das Muster ist kein gültiger regulärer Ausdruck.');
      }
    }
  }
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 5) throw new HttpError(400, 'invalid_input', 'Eine bis fünf Aktionen.');
  for (const a of actions as Action[]) {
    if (!['notify', 'reply', 'compose_reply', 'broadcast_draft', 'github_issue', 'tag_contact', 'case_status'].includes(a?.type)) {
      throw new HttpError(400, 'invalid_input', 'Unbekannte Aktion.');
    }
  }
  return { trigger: trigger as Trigger, conditions: conditions as Condition[], actions: actions as Action[] };
}

function toDto(db: Db, r: Row): AutomationDto {
  const log = db.prepare('SELECT created_at AS at, result FROM automation_log WHERE automation_id = ? ORDER BY created_at DESC LIMIT 10').all(r.id) as {
    at: string;
    result: string;
  }[];
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    conditions: JSON.parse(r.conditions_json),
    actions: JSON.parse(r.actions_json),
    enabled: !!r.enabled,
    runs: r.runs,
    lastRunAt: r.last_run_at ?? undefined,
    log,
  };
}

export function listAutomations(db: Db, accountId: string): AutomationDto[] {
  return (db.prepare('SELECT * FROM automations WHERE account_id = ? ORDER BY created_at').all(accountId) as unknown as Row[]).map((r) => toDto(db, r));
}

export function saveAutomation(db: Db, accountId: string, input: { id?: string; name: string; trigger: unknown; conditions: unknown; actions: unknown; enabled?: boolean }): AutomationDto {
  const v = validate(input.trigger, input.conditions ?? [], input.actions);
  const name = input.name.trim().slice(0, 80) || 'Automation';
  if (input.id) {
    const r = db.prepare('SELECT id FROM automations WHERE id = ? AND account_id = ?').get(input.id, accountId);
    if (!r) throw new HttpError(404, 'not_found', 'Diese Automation gibt es nicht.');
    db.prepare('UPDATE automations SET name = ?, trigger = ?, conditions_json = ?, actions_json = ?, enabled = ? WHERE id = ?').run(
      name,
      v.trigger,
      JSON.stringify(v.conditions),
      JSON.stringify(v.actions),
      input.enabled === false ? 0 : 1,
      input.id,
    );
    return toDto(db, db.prepare('SELECT * FROM automations WHERE id = ?').get(input.id) as unknown as Row);
  }
  const id = newId('auto');
  db.prepare('INSERT INTO automations (id, account_id, name, trigger, conditions_json, actions_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    accountId,
    name,
    v.trigger,
    JSON.stringify(v.conditions),
    JSON.stringify(v.actions),
    input.enabled === false ? 0 : 1,
    nowIso(),
  );
  return toDto(db, db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as unknown as Row);
}

export function deleteAutomation(db: Db, accountId: string, id: string): void {
  const r = db.prepare('SELECT id FROM automations WHERE id = ? AND account_id = ?').get(id, accountId);
  if (!r) throw new HttpError(404, 'not_found', 'Diese Automation gibt es nicht.');
  db.prepare('DELETE FROM automation_log WHERE automation_id = ?').run(id);
  db.prepare('DELETE FROM automations WHERE id = ?').run(id);
}

// ---------- presets for the Toy projects ----------

export interface Preset {
  id: string;
  name: string;
  description: string;
  needs: ('github' | 'toyscan' | 'announce')[];
  build: (ids: { github?: string; announce?: string }) => { name: string; trigger: Trigger; conditions: Condition[]; actions: Action[] };
}

const SECURITY_WORDS = 'sicherheitslücke|schwachstelle|vulnerab|exploit|security (issue|bug|hole)|faille|vulnerabilidad';
const BUG_WORDS = '\\bfehler\\b|\\bbug\\b|absturz|stürzt ab|crash|funktioniert nicht|geht nicht|doesn.t work|broken';

export const PRESETS: Preset[] = [
  {
    id: 'meilenstein',
    name: 'Meilenstein fertig → Mitteilung an Tester',
    description: 'Wird in docs/STATUS.md ein Meilenstein fertig, schreibt ToyPost eine Mitteilung an die Gruppe „Tester“. Sie geht erst nach deiner Freigabe raus, in der Sprache jedes Testers.',
    needs: ['github'],
    build: () => ({
      name: 'Meilenstein fertig → Mitteilung an Tester',
      trigger: 'project.milestone',
      conditions: [],
      actions: [
        {
          type: 'broadcast_draft',
          audience: 'gruppe:Tester',
          purpose: 'milestone',
          facts: ['Meilenstein {{milestone.id}} ist fertig: {{milestone.title}}', 'Stand: {{milestone.status}}', 'Details: {{url}}'],
        },
      ],
    }),
  },
  {
    id: 'release',
    name: 'Neue Version → Mitteilung an die Community',
    description: 'Bei einem neuen Release auf GitHub entsteht eine Mitteilung an die Gruppe „Community“ zum Freigeben.',
    needs: ['github'],
    build: () => ({
      name: 'Neue Version → Mitteilung an die Community',
      trigger: 'project.release',
      conditions: [],
      actions: [
        { type: 'broadcast_draft', audience: 'gruppe:Community', purpose: 'release', facts: ['Version {{tag}} ist erschienen: {{name}}', '{{notes}}', 'Download und Details: {{url}}'] },
      ],
    }),
  },
  {
    id: 'ampel',
    name: 'Warnampel rot → Notfall-Mitteilung und Push an dich',
    description: 'Springt die ToyScan-Warnampel auf Rot, bekommst du sofort eine Push-Nachricht, und eine Notfall-Mitteilung an alle Kontakte liegt zum Freigeben bereit (Notfall-Plan, Entscheidung 88).',
    needs: ['toyscan', 'announce'],
    build: ({ announce }) => ({
      name: 'Warnampel rot → Notfall-Mitteilung und Push an dich',
      trigger: 'toy.ampel.changed',
      conditions: [{ field: 'to', op: 'eq', value: 'rot' }],
      actions: [
        { type: 'notify', channelId: announce!, title: 'ToyScan: Warnampel ROT', text: 'Die Warnampel steht auf Rot (große rote Lampe: {{bigRedLamp}}). Kriterien: {{criteria}}. Quelle: {{url}}' },
        {
          type: 'broadcast_draft',
          audience: 'alle',
          purpose: 'incident',
          facts: ['Die Warnampel von ToyScan steht auf Rot.', 'Betroffene Kriterien: {{criteria}}', 'Wir prüfen den Fall und melden uns.', 'Niemand vom Projekt fragt je nach deiner Wiederherstellungsphrase.'],
        },
      ],
    }),
  },
  {
    id: 'zahlung',
    name: 'TOY-Zahlung eingegangen → Dank an den Zahler',
    description: 'Ist eine TOY-Rechnung bezahlt, bedankt sich ToyPost beim Zahler über seinen Kanal, in seiner Sprache.',
    needs: [],
    build: () => ({
      name: 'TOY-Zahlung eingegangen → Dank an den Zahler',
      trigger: 'toy.payment.received',
      conditions: [{ field: 'invoice.status', op: 'eq', value: 'paid' }],
      actions: [{ type: 'compose_reply', purpose: 'payment_thanks', facts: ['Zahlung über {{amountToy}} für {{invoice.purpose}} ist angekommen.', 'Transaktion: {{transfer.hash}}'], send: true }],
    }),
  },
  {
    id: 'fehlermeldung',
    name: 'Fehlermeldung per Nachricht → GitHub-Issue',
    description: 'Meldet jemand per E-Mail, Telegram oder SMS einen Fehler, legt ToyPost ein Issue im Projekt an. Sicherheitslücken landen nie öffentlich.',
    needs: ['github'],
    build: ({ github }) => ({
      name: 'Fehlermeldung per Nachricht → GitHub-Issue',
      trigger: 'message.received',
      conditions: [
        { field: 'message.body', op: 'matches', value: BUG_WORDS },
        { field: 'message.body', op: 'matches', value: `^(?![\\s\\S]*(${SECURITY_WORDS}))` },
      ],
      actions: [
        {
          type: 'github_issue',
          channelId: github!,
          title: 'Rückmeldung über {{message.channelKind}}: {{message.preview}}',
          body: 'Eingegangen über ToyPost ({{message.channelKind}}, {{message.createdAt}}).\n\n> {{message.body}}\n\n_Absender ist in ToyPost hinterlegt und wird hier nicht genannt._',
          labels: ['rückmeldung'],
        },
        { type: 'reply', text: 'Danke für deine Meldung! Wir haben sie an das Entwicklerteam weitergegeben.', translate: true },
      ],
    }),
  },
  {
    id: 'sicherheit',
    name: 'Sicherheitsmeldung → vertrauliche Antwort',
    description: 'Wer eine Schwachstelle meldet, bekommt eine Antwort mit dem vertraulichen Meldeweg aus SECURITY.md. Nichts davon wird öffentlich.',
    needs: [],
    build: () => ({
      name: 'Sicherheitsmeldung → vertrauliche Antwort',
      trigger: 'message.received',
      conditions: [{ field: 'message.body', op: 'matches', value: SECURITY_WORDS }],
      actions: [
        {
          type: 'compose_reply',
          purpose: 'security_reply',
          facts: [
            'Danke für die Meldung einer möglichen Schwachstelle.',
            'Bitte melde Details nicht öffentlich, sondern über die private Sicherheitsmeldung auf GitHub („Report a vulnerability“ im Reiter Security) oder direkt an den Projektinhaber.',
            'Wir bestätigen den Eingang, beheben die Lücke und nennen dich auf Wunsch öffentlich.',
          ],
          send: true,
        },
      ],
    }),
  },
  {
    id: 'betrug',
    name: 'Betrugsverdacht → Push an dich',
    description: 'Erkennt ToyPost eine Betrugsnachricht (Phrase verlangt, falscher Airdrop, Adress-Falle), bekommst du sofort eine Push-Nachricht.',
    needs: ['announce'],
    build: ({ announce }) => ({
      name: 'Betrugsverdacht → Push an dich',
      trigger: 'safety.warning',
      conditions: [{ field: 'findings', op: 'contains', value: '"severity":"red"' }],
      actions: [{ type: 'notify', channelId: announce!, title: 'ToyPost: Betrugsverdacht', text: '{{findings}}' }],
    }),
  },
];

export function installPreset(db: Db, accountId: string, presetId: string, ids: { github?: string; announce?: string }): AutomationDto {
  const p = PRESETS.find((x) => x.id === presetId);
  if (!p) throw new HttpError(404, 'not_found', 'Diese Vorlage gibt es nicht.');
  const channel = (id: string | undefined, ok: (c: ChannelRow) => boolean, what: string) => {
    if (!id) throw new HttpError(400, 'invalid_input', `Für diese Vorlage fehlt ${what}.`);
    const c = db.prepare('SELECT * FROM channels WHERE id = ? AND account_id = ?').get(id, accountId) as ChannelRow | undefined;
    if (!c || !ok(c)) throw new HttpError(400, 'invalid_input', `Der gewählte Kanal passt nicht als ${what}.`);
  };
  if (p.needs.includes('github') && !ids.github) {
    // with exactly one GitHub channel there is nothing to choose
    const gh = db.prepare(`SELECT id FROM channels WHERE account_id = ? AND kind = 'github'`).all(accountId) as { id: string }[];
    if (gh.length === 1) ids = { ...ids, github: gh[0].id };
  }
  if (p.needs.includes('github')) channel(ids.github, (c) => c.kind === 'github', 'ein GitHub-Kanal');
  if (p.needs.includes('announce')) channel(ids.announce, (c) => BROADCAST_TARGET.includes(c.kind) || ['telegram', 'matrix', 'talk'].includes(c.kind), 'ein Kanal für Push-Nachrichten');
  if (p.needs.includes('toyscan') && !(db.prepare(`SELECT 1 FROM channels WHERE account_id = ? AND kind = 'toyscan'`).get(accountId))) {
    throw new HttpError(400, 'invalid_input', 'Verbinde zuerst ToyScan als Kanal.');
  }
  const built = p.build(ids);
  return saveAutomation(db, accountId, built);
}

// ---------- running ----------

function channelRow(db: Db, accountId: string, id: string): ChannelRow {
  const c = db.prepare('SELECT * FROM channels WHERE id = ? AND account_id = ?').get(id, accountId) as ChannelRow | undefined;
  if (!c) throw new Error('Kanal der Automation gibt es nicht mehr.');
  return c;
}

/** Contact an event belongs to (sender of a message, payer of an invoice). */
function contactOf(db: Db, event: any): string | undefined {
  if (event.contactId) return event.contactId;
  if (event.message?.contact?.id) return event.message.contact.id;
  if (event.caseId) {
    return (db.prepare('SELECT contact_id FROM cases WHERE id = ?').get(event.caseId) as { contact_id: string | null } | undefined)?.contact_id ?? undefined;
  }
  return undefined;
}

async function runAction(ctx: Context, accountId: string, action: Action, event: any): Promise<string> {
  const { db } = ctx;
  const account = getAccountRow(db, accountId);
  const owner = db.prepare(`SELECT name FROM users WHERE account_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1`).get(accountId) as { name: string } | undefined;
  switch (action.type) {
    case 'notify': {
      const ch = channelRow(db, accountId, action.channelId);
      const m = await sendMessage(ctx, account, { channel: ch, cfg: ctx.channels.config(ch), subject: fill(action.title, event), text: fill(action.text, event) });
      return `Push über ${ch.name}: ${m.status}`;
    }
    case 'reply':
    case 'compose_reply': {
      const contactId = contactOf(db, event);
      if (!contactId) return 'kein Kontakt, keine Antwort';
      const contact = getContactRow(db, accountId, contactId);
      // reply in the channel the message came from, else the contact's best channel
      const sameChannel = event.message?.channelKind && event.message?.direction === 'in' ? (db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(event.message.id) as { channel_id: string } | undefined)?.channel_id : undefined;
      const ch = sameChannel ? channelRow(db, accountId, sameChannel) : bestChannelFor(db, accountId, contactId);
      if (!ch || !CAN_SEND.includes(ch.kind)) return 'kein Kanal zum Antworten';
      let subject: string | undefined;
      let text: string;
      if (action.type === 'reply') {
        text = fill(action.text, event);
        subject = action.subject ? fill(action.subject, event) : undefined;
      } else {
        const composed = await ctx.ai.compose({ purpose: action.purpose, facts: action.facts.map((f) => fill(f, event)), senderName: owner?.name ?? account.name, tone: 'freundlich' });
        subject = composed.subject;
        text = composed.body;
        if (!action.send) {
          createBroadcast(db, accountId, { audience: `kanal:${ch.id}`, subject, body: text, source: `Automation (${event.type})` });
          return 'Antwort als Entwurf angelegt';
        }
      }
      const translate = action.type === 'compose_reply' || action.translate;
      if (translate && contact.language !== 'de') {
        const lang = toyLanguage(contact.language);
        try {
          const t = await ctx.ai.translate({ subject, text, targetLang: lang.code, targetLangName: lang.name, glossary: '' });
          subject = t.subject ?? subject;
          text = t.text;
        } catch (e) {
          ctx.log(`Übersetzung für Antwort fehlgeschlagen: ${(e as Error).message}`);
        }
      }
      const m = await sendMessage(ctx, account, { channel: ch, cfg: ctx.channels.config(ch), contactId, subject, text, caseId: event.caseId });
      return `Antwort an ${contact.name} über ${ch.name}: ${m.status}`;
    }
    case 'broadcast_draft': {
      const owner2 = owner?.name ?? account.name;
      const composed = await ctx.ai.compose({ purpose: action.purpose, facts: action.facts.map((f) => fill(f, event)).filter((f) => f.trim()), senderName: owner2, tone: action.purpose === 'incident' ? 'sachlich' : 'freundlich' });
      const b = createBroadcast(db, accountId, { audience: action.audience, subject: composed.subject, body: composed.body, source: `Automation (${event.type})` });
      return `Mitteilung ${b.id} wartet auf Freigabe (${b.recipients} Empfänger)`;
    }
    case 'github_issue': {
      const ch = channelRow(db, accountId, action.channelId);
      if (ch.kind !== 'github') throw new Error('Der Kanal ist kein GitHub-Kanal.');
      const cfg = ctx.channels.config(ch as ChannelRow & { kind: 'github' });
      const title = fill(action.title, event).slice(0, 200);
      const body = fill(action.body, event);
      // never put a secret or a security report into a public issue
      const findings = checkSafety({ text: `${title}\n${body}`, direction: 'out' });
      if (blocksSending(findings) || new RegExp(SECURITY_WORDS, 'i').test(body)) return 'Issue nicht angelegt: Inhalt gehört nicht öffentlich auf GitHub';
      const issue = await new GitHubClient(cfg.repo, cfg.token, ctx.config.githubApi).createIssue(title, body, action.labels ?? []);
      if (event.caseId) addTimeline(db, event.caseId, `GitHub-Issue #${issue.number} angelegt`);
      return `Issue #${issue.number} angelegt`;
    }
    case 'tag_contact': {
      const contactId = contactOf(db, event);
      if (!contactId) return 'kein Kontakt';
      const c = getContactRow(db, accountId, contactId);
      const tags = JSON.parse(c.tags_json) as string[];
      if (!tags.includes(action.tag)) updateContact(db, accountId, contactId, { tags: [...tags, action.tag] });
      return `Kontakt in Gruppe ${action.tag}`;
    }
    case 'case_status': {
      if (!event.caseId) return 'kein Vorgang';
      updateCase(db, accountId, event.caseId, { status: action.status });
      return `Vorgang auf ${action.status}`;
    }
  }
}

/** Called for every event. Automations never trigger on the messages they send themselves (no loops). */
export async function runAutomations(ctx: Context, accountId: string, event: ToyPostEvent): Promise<void> {
  if (event.type === 'message.sent') return;
  const rows = ctx.db.prepare('SELECT * FROM automations WHERE account_id = ? AND trigger = ? AND enabled = 1').all(accountId, event.type) as unknown as Row[];
  for (const r of rows) {
    if (!matches(event, JSON.parse(r.conditions_json))) continue;
    const results: string[] = [];
    for (const action of JSON.parse(r.actions_json) as Action[]) {
      try {
        results.push(await runAction(ctx, accountId, action, event));
      } catch (e) {
        results.push(`Fehler: ${(e as Error).message}`);
      }
    }
    ctx.db.prepare('UPDATE automations SET runs = runs + 1, last_run_at = ? WHERE id = ?').run(nowIso(), r.id);
    ctx.db.prepare('INSERT INTO automation_log (id, automation_id, event_type, result, created_at) VALUES (?, ?, ?, ?, ?)').run(newId('alog'), r.id, event.type, results.join(' · ').slice(0, 1000), nowIso());
  }
}
