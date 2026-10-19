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
import { todayIso, type CaseSummary, type Deadline } from '../shared.ts';

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
  | { type: 'case.updated'; case: CaseSummary };

/** Welche Nextcloud-Änderungen ein Ereignis auslöst. Rein, ohne Netzwerk – deshalb gut testbar. */
export function davWritesFor(event: ToyPostEvent, cfg: NextcloudConfig, link?: string): DavWrite[] {
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
          path: draftFilePath(cfg, draftFileName(todayIso(), event.caseTitle)),
          contentType: 'text/markdown; charset=utf-8',
          content: `# ${event.subject}\n\n${event.body}\n`,
        },
      ];
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

function caseIdOf(event: ToyPostEvent): string {
  return event.type === 'case.updated' ? event.case.id : event.caseId;
}

export class Delivery {
  private readonly integrations: IntegrationStore;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly signingSecret: (accountId: string) => string;
  private readonly linkFor: (accountId: string, caseId: string) => string | undefined;
  readonly pending = new Set<Promise<void>>();

  constructor(
    integrations: IntegrationStore,
    signingSecret: (accountId: string) => string,
    log: (msg: string, extra?: unknown) => void,
    linkFor: (accountId: string, caseId: string) => string | undefined = () => undefined,
  ) {
    this.integrations = integrations;
    this.signingSecret = signingSecret;
    this.log = log;
    this.linkFor = linkFor;
  }

  /** Nicht blockierend; in Tests kann mit `settle()` gewartet werden. */
  emit(accountId: string, event: ToyPostEvent): void {
    const p = this.deliver(accountId, event)
      .catch((e: Error) => this.log(`Zustellung ${event.type} fehlgeschlagen: ${e.message}`))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async settle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async deliver(accountId: string, event: ToyPostEvent): Promise<void> {
    const nc = this.integrations.get(accountId, 'nextcloud');
    const davWrites = nc ? davWritesFor(event, nc, this.linkFor(accountId, caseIdOf(event))) : [];
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
