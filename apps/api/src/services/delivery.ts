import { createHmac } from 'node:crypto';
import type { IntegrationStore } from '../integrations/store.ts';
import {
  buildDeadlineIcs,
  buildTaskIcs,
  calendarObjectPath,
  deadlineUid,
  draftFileName,
  draftFilePath,
  NextcloudClient,
  taskUid,
  type DavWrite,
  type NextcloudConfig,
} from '../integrations/nextcloud.ts';
import { todayIso, type CaseSummary, type Deadline, type MessageSummary, type SafetyNote, type ToyInvoiceSummary } from '../shared.ts';

/**
 * Verteilt Ergebnisse an Nextcloud.
 * Ist n8n verbunden, geht jedes Ereignis samt vorbereiteter Nextcloud-Schreibvorgänge (davWrites) an n8n;
 * n8n führt sie aus und kann weitere eigene Schritte anhängen. Ohne n8n schreibt ToyPost selbst in Nextcloud.
 * Fehler blockieren nie die Verarbeitung; sie werden protokolliert.
 */

export type ToyPostEvent =
  | { type: 'document.analyzed'; caseId: string; documentId: string; usedAi: boolean; case: CaseSummary }
  | { type: 'deadline.detected'; caseId: string; caseTitle: string; deadline: Deadline }
  | { type: 'draft.created'; caseId: string; caseTitle: string; draftId: string; subject: string; body: string }
  | { type: 'case.updated'; case: CaseSummary }
  // ---------- ToyPost ----------
  | { type: 'message.received'; message: MessageSummary; caseId?: string; contactId?: string }
  | { type: 'message.sent'; message: MessageSummary }
  | {
      type: 'toy.payment.received';
      invoice: ToyInvoiceSummary;
      transfer: { hash: string; from: string; amount: string; purpose?: string };
      caseId?: string;
      contactId?: string;
    }
  | { type: 'toy.ampel.changed'; from?: string; to: string; bigRedLamp: boolean; criteria: { id: string; color: string; note?: string }[]; url: string }
  | { type: 'project.milestone'; repo: string; milestone: { id: string; title: string; status: string; done: boolean }; url: string }
  | { type: 'project.release'; repo: string; tag: string; name: string; notes: string; url: string }
  | { type: 'feed.item'; channelId: string; feed: string; item: { key: string; title: string; link?: string; text: string; date?: string } }
  | { type: 'safety.warning'; findings: SafetyNote[]; caseId?: string; messageId?: string };

export type EventType = ToyPostEvent['type'];

/** Welche Nextcloud-Änderungen ein Ereignis auslöst. Rein, ohne Netzwerk – deshalb gut testbar. */
export function davWritesFor(event: ToyPostEvent, cfg: NextcloudConfig, link?: string, now: Date = new Date()): DavWrite[] {
  const ics = (uid: string, content: string): DavWrite => ({
    path: calendarObjectPath(cfg, uid),
    contentType: 'text/calendar; charset=utf-8',
    content,
  });
  switch (event.type) {
    case 'document.analyzed':
      return event.case.status === 'action' ? [ics(taskUid(event.caseId), buildTaskIcs(event.case, link))] : [];
    case 'deadline.detected':
      return [ics(deadlineUid(event.caseId, event.deadline), buildDeadlineIcs(deadlineUid(event.caseId, event.deadline), event.caseTitle, event.deadline, link))];
    case 'draft.created':
      return [
        {
          path: draftFilePath(cfg, draftFileName(todayIso(now), event.caseTitle)),
          contentType: 'text/markdown; charset=utf-8',
          content: `# ${event.subject}\n\n${event.body}\n`,
        },
      ];
    default:
      return [];
    case 'case.updated': {
      const c = event.case;
      const writes = [ics(taskUid(c.id), buildTaskIcs(c, link))];
      if (c.deadline && (c.status === 'done' || c.status === 'info')) {
        const uid = deadlineUid(c.id, c.deadline);
        writes.push(ics(uid, buildDeadlineIcs(uid, c.title, c.deadline, link, true)));
      }
      return writes;
    }
  }
}

function caseIdOf(event: ToyPostEvent): string | undefined {
  if (event.type === 'case.updated') return event.case.id;
  return 'caseId' in event ? event.caseId : undefined;
}

export class Delivery {
  private readonly integrations: IntegrationStore;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly signingSecret: (accountId: string) => string;
  private readonly linkFor: (accountId: string, caseId: string) => string | undefined;
  private readonly now: () => Date;
  readonly pending = new Set<Promise<void>>();
  private readonly listeners: ((accountId: string, event: ToyPostEvent) => Promise<void> | void)[] = [];

  /** Internal listeners (automations). Errors are logged and never stop delivery. */
  on(listener: (accountId: string, event: ToyPostEvent) => Promise<void> | void): void {
    this.listeners.push(listener);
  }

  constructor(
    integrations: IntegrationStore,
    signingSecret: (accountId: string) => string,
    log: (msg: string, extra?: unknown) => void,
    linkFor: (accountId: string, caseId: string) => string | undefined = () => undefined,
    now: () => Date = () => new Date(),
  ) {
    this.integrations = integrations;
    this.signingSecret = signingSecret;
    this.log = log;
    this.linkFor = linkFor;
    this.now = now;
  }

  /** Nicht blockierend; in Tests kann mit `settle()` gewartet werden. */
  emit(accountId: string, event: ToyPostEvent): void {
    const p = this.deliver(accountId, event)
      .catch((e: Error) => this.log(`Zustellung ${event.type} fehlgeschlagen: ${e.message}`))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    for (const l of this.listeners) {
      const q = Promise.resolve()
        .then(() => l(accountId, event))
        .catch((e: Error) => this.log(`Automation bei ${event.type} fehlgeschlagen: ${e.message}`))
        .finally(() => this.pending.delete(q));
      this.pending.add(q);
    }
  }

  /** Waits until all deliveries, including those started by listeners, are done. */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async deliver(accountId: string, event: ToyPostEvent): Promise<void> {
    const nc = this.integrations.get(accountId, 'nextcloud');
    const caseId = caseIdOf(event);
    const davWrites = nc ? davWritesFor(event, nc, caseId ? this.linkFor(accountId, caseId) : undefined, this.now()) : [];
    const n8n = this.integrations.get(accountId, 'n8n');
    if (n8n) {
      const body = JSON.stringify({ accountId, at: new Date().toISOString(), ...event, davWrites });
      const signature = createHmac('sha256', this.signingSecret(accountId)).update(body).digest('hex');
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(n8n.eventsUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-toypost-signature': signature, 'x-toypost-event': event.type },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) return;
          throw new Error(`n8n antwortete mit ${res.status}`);
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise((r) => setTimeout(r, attempt * 500));
        }
      }
      return;
    }
    if (!nc || !davWrites.length) return;
    const client = new NextcloudClient(nc);
    if (event.type === 'draft.created') await client.ensureDraftFolder();
    for (const w of davWrites) await client.write(w);
  }
}
