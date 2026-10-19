import { createHmac } from 'node:crypto';
import type { IntegrationStore } from '../integrations/store.ts';
import { NextcloudClient } from '../integrations/nextcloud.ts';
import type { CaseSummary, Deadline } from '../shared.ts';

/**
 * Verteilt Ergebnisse an die angebundenen Systeme.
 * Ist n8n verbunden, gehen alle Ereignisse an n8n und n8n entscheidet, wohin (Kalender, Deck, Talk, E-Mail).
 * Ohne n8n schreibt Dokufy Fristen direkt in den Nextcloud-Kalender.
 * Fehler blockieren nie die App; sie werden protokolliert und können erneut ausgelöst werden.
 */

export type DokufyEvent =
  | { type: 'document.analyzed'; caseId: string; documentId: string; usedAi: boolean }
  | { type: 'deadline.detected'; caseId: string; caseTitle: string; deadline: Deadline }
  | { type: 'draft.created'; caseId: string; draftId: string; subject: string }
  | { type: 'case.updated'; case: CaseSummary };

export class Delivery {
  private readonly integrations: IntegrationStore;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly signingSecret: (accountId: string) => string;
  readonly pending = new Set<Promise<void>>();

  constructor(integrations: IntegrationStore, signingSecret: (accountId: string) => string, log: (msg: string, extra?: unknown) => void) {
    this.integrations = integrations;
    this.signingSecret = signingSecret;
    this.log = log;
  }

  /** Nicht blockierend; in Tests kann mit `settle()` gewartet werden. */
  emit(accountId: string, event: DokufyEvent): void {
    const p = this.deliver(accountId, event)
      .catch((e: Error) => this.log(`Zustellung ${event.type} fehlgeschlagen: ${e.message}`))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async settle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async deliver(accountId: string, event: DokufyEvent): Promise<void> {
    const n8n = this.integrations.get(accountId, 'n8n');
    if (n8n) {
      const body = JSON.stringify({ accountId, at: new Date().toISOString(), ...event });
      const signature = createHmac('sha256', this.signingSecret(accountId)).update(body).digest('hex');
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(n8n.eventsUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dokufy-signature': signature, 'x-dokufy-event': event.type },
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
    if (event.type === 'deadline.detected') {
      const nc = this.integrations.get(accountId, 'nextcloud');
      if (!nc) return;
      await new NextcloudClient(nc).upsertDeadline(`dokufy-${event.caseId}-${event.deadline.kind}`, event.caseTitle, event.deadline);
    }
  }
}
