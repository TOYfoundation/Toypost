import {
  addDays,
  buildDemoCases,
  buildGiroCodePayload,
  CREDIT_ACTION_LABEL,
  CREDIT_COST_UNITS,
  CREDIT_PACKS,
  detectDeadlines,
  FEATURE_LABEL,
  PLAN_ORDER,
  PLANS,
  primaryDeadline,
  priceFor,
  SUPPORT_LABEL,
  toCredits,
  todayIso,
  type CaseDetail,
  type CaseStatus,
  type PlanId,
  checkSafety,
  detectToyRequest,
  toyLanguage,
  type MessageSummary,
} from '@toypost/shared';
import {
  DEMO_CHANNEL_KINDS,
  DEMO_PRESETS,
  demoAutomations,
  demoBroadcasts,
  demoChannels,
  demoContacts,
  demoFeedMessages,
  demoInvoice,
  demoOverview,
  demoToyCases,
} from './demo-toy.ts';
import type { AutomationInfo, BroadcastInfo, ChannelInfo } from './types.ts';
import type { Api, IntegrationKind, IntegrationState, LedgerEntry, Me, UploadInput } from './types.ts';
import { ApiError } from './types.ts';

/**
 * Demo-Modus: die ganze App ohne Server, mit Beispiel-Post.
 * Verhält sich wie die echte API (Credits, Fristen, Entwürfe), speichert aber nur im Arbeitsspeicher.
 */
export class DemoApi implements Api {
  readonly mode = 'demo' as const;
  private day = todayIso();
  private store: CaseDetail[] = [...demoToyCases(this.day), ...buildDemoCases(this.day)];
  private channelList: ChannelInfo[] = demoChannels(this.day);
  private broadcastList: BroadcastInfo[] = demoBroadcasts(this.day);
  private invoiceList = [demoInvoice('7K3QXP', '25', 'Validator-Hilfe'), demoInvoice('M2PAID', '5', 'Spende Testnet', 'paid')];
  private automationList: AutomationInfo[] = demoAutomations(this.day);
  private extraMessages: MessageSummary[] = demoFeedMessages(this.day);
  private plan: PlanId = 'pro';
  private planCredits = 272;
  private purchasedCredits = 100;
  private ledgerEntries: LedgerEntry[] = [
    { credits: 100, action: 'purchase', label: 'Credit-Paket gekauft', ref: null, at: `${addDays(this.day, -20)}T10:00:00Z` },
    { credits: 400, action: 'grant', label: 'Monatskontingent', ref: null, at: `${this.day.slice(0, 8)}01T00:00:00Z` },
  ];
  private integrationState: IntegrationState = {
    paperless: { connected: true, summary: 'paperless.beispiel.de' },
    nextcloud: { connected: true, summary: 'alex @ cloud.beispiel.de' },
    n8n: { connected: false },
    webhookUrl: 'https://api.toypost.app/v1/hooks/paperless/demo',
  };

  private delay<T>(value: T, ms = 220): Promise<T> {
    return new Promise((r) => setTimeout(() => r(structuredClone(value)), ms));
  }

  private find(id: string): CaseDetail {
    const c = this.store.find((x) => x.id === id);
    if (!c) throw new ApiError(404, 'not_found', 'Diesen Vorgang gibt es nicht.');
    return c;
  }

  private spend(action: keyof typeof CREDIT_COST_UNITS, quantity = 1): number {
    const credits = toCredits(CREDIT_COST_UNITS[action] * quantity);
    if (this.planCredits + this.purchasedCredits < credits) {
      throw new ApiError(402, 'credits_exhausted', `Für „${CREDIT_ACTION_LABEL[action]}“ fehlen Credits. Kaufe ein Credit-Paket.`);
    }
    const fromPlan = Math.min(this.planCredits, credits);
    this.planCredits -= fromPlan;
    this.purchasedCredits -= credits - fromPlan;
    this.ledgerEntries.unshift({ credits: -credits, action, label: CREDIT_ACTION_LABEL[action], ref: null, at: new Date().toISOString() });
    return credits;
  }

  private summary(c: CaseDetail) {
    const { documents, timeline, draft, ...s } = c;
    return { ...s, documentCount: documents.length };
  }

  async me(): Promise<Me> {
    return this.delay({
      id: 'acc_demo',
      name: 'Haushalt Beispiel',
      email: 'demo@toypost.app',
      plan: this.plan,
      seats: 1,
      storageUsedBytes: 1_870_000_000,
      credits: {
        total: this.planCredits + this.purchasedCredits,
        plan: this.planCredits,
        purchased: this.purchasedCredits,
        monthlyGrant: PLANS[this.plan].monthlyCredits,
        planResetsOn: addDays(`${this.day.slice(0, 8)}01`, 32).slice(0, 8) + '01',
      },
      role: 'owner',
      userName: 'Alex Beispiel',
    });
  }

  async today() {
    const all = this.store.map((c) => this.summary(c));
    const due = (a: any, b: any) => (a.deadline?.date ?? '9999').localeCompare(b.deadline?.date ?? '9999');
    return this.delay({
      today: this.day,
      action: all.filter((c) => c.status === 'action').sort(due),
      followUpDue: all.filter((c) => c.status === 'waiting' && c.followUpOn && c.followUpOn <= this.day),
      waiting: all.filter((c) => c.status === 'waiting' && !(c.followUpOn && c.followUpOn <= this.day)),
      newInfo: all.filter((c) => c.status === 'info'),
    });
  }

  async cases(status?: CaseStatus, q?: string) {
    const needle = q?.toLowerCase();
    return this.delay(
      this.store
        .filter((c) => !status || c.status === status)
        .filter((c) => !needle || `${c.title} ${c.correspondent} ${c.reference ?? ''}`.toLowerCase().includes(needle))
        .map((c) => this.summary(c)),
    );
  }

  async caseDetail(id: string) {
    return this.delay(this.find(id));
  }

  async updateCase(id: string, patch: { status?: CaseStatus; followUpOn?: string | null }) {
    const c = this.find(id);
    if (patch.status && patch.status !== c.status) {
      c.status = patch.status;
      c.timeline.unshift({ at: new Date().toISOString(), text: patch.status === 'done' ? 'Vorgang als erledigt markiert' : 'Status geändert' });
    }
    if (patch.followUpOn !== undefined) c.followUpOn = patch.followUpOn ?? undefined;
    c.updatedAt = new Date().toISOString();
    return this.delay(this.summary(c));
  }

  async markPaid(id: string) {
    const c = this.find(id);
    c.timeline.unshift({ at: new Date().toISOString(), text: 'Als bezahlt markiert' });
    return this.updateCase(id, { status: 'done' });
  }

  async giroCode(id: string) {
    const c = this.find(id);
    if (!c.payment) throw new ApiError(404, 'no_payment', 'In diesem Vorgang wurden keine Zahlungsdaten gefunden.');
    return this.delay({ payload: buildGiroCodePayload(c.payment) });
  }

  async createDraft(id: string, input: { intent?: string; tone: 'sachlich' | 'freundlich' | 'bestimmt' }) {
    const c = this.find(id);
    const creditsSpent = this.spend('draft');
    const intent = input.intent?.trim() || 'Rückmeldung zu Ihrem Schreiben';
    const greeting = input.tone === 'freundlich' ? 'Guten Tag,' : 'Sehr geehrte Damen und Herren,';
    const draft = {
      id: `draft_${Date.now()}`,
      subject: `${intent} – ${c.reference ?? c.title}`,
      body: `${greeting}\n\n${c.reference ? `${c.reference}\n\n` : ''}bezugnehmend auf Ihr Schreiben „${c.title}“ möchte ich Folgendes mitteilen: ${intent}.\n\nBitte bestätigen Sie mir den Eingang dieses Schreibens.\n\nMit freundlichen Grüßen\nAlex Beispiel`,
      createdAt: new Date().toISOString(),
    };
    c.draft = draft;
    c.timeline.unshift({ at: draft.createdAt, text: 'Antwortentwurf erstellt' });
    return this.delay({ ...draft, creditsSpent }, 900);
  }

  async sendDraft(draftId: string, channelId?: string) {
    const c = this.store.find((x) => x.draft?.id === draftId);
    if (!c) throw new ApiError(404, 'not_found', 'Diesen Entwurf gibt es nicht.');
    if (channelId !== undefined) {
      if (!c.contact) throw new ApiError(400, 'no_contact', 'Dieser Vorgang hat noch keinen Kontakt. Ordne einen Kontakt zu oder sende den Entwurf selbst.');
      c.messages.unshift({ id: `msg_${Date.now()}`, channelKind: 'sms', channelName: 'Projekt-Handy', direction: 'out', contact: c.contact, caseId: c.id, subject: c.draft!.subject, preview: c.draft!.body.slice(0, 140), body: c.draft!.body, status: 'sent', safety: [], createdAt: new Date().toISOString() });
    }
    c.draft = undefined;
    c.timeline.unshift({ at: new Date().toISOString(), text: 'Antwort versendet, Wiedervorlage in 14 Tagen' });
    return this.updateCase(c.id, { status: 'waiting', followUpOn: addDays(this.day, 14) });
  }

  async upload(input: UploadInput) {
    const credits = this.spend('analyze') + (input.premiumOcr ? this.spend('premiumOcrPage', input.pages) : 0);
    const letterDate = input.letterDate ?? this.day;
    const text =
      input.text ??
      `Landeshauptkasse\nKassenzeichen: 0815-2026-4471\nDatum: ${letterDate}\nKraftfahrzeugsteuer 2026/2027\nZu zahlender Betrag: 94,00 €\nBitte zahlen Sie innerhalb von 14 Tagen auf IBAN DE89 3704 0044 0532 0130 00.`;
    const deadlines = detectDeadlines(text, { letterDate });
    const id = `demo_upload_${Date.now()}`;
    const title = input.title || (input.text ? text.split('\n')[0].slice(0, 60) : 'Kraftfahrzeugsteuer 2026/2027');
    const detail: CaseDetail = {
      id,
      title,
      correspondent: input.text ? 'Unbekannter Absender' : 'Landeshauptkasse',
      status: deadlines.length ? 'action' : 'info',
      summary: deadlines.length ? 'Neue Post mit Frist erkannt.' : 'Neue Post, nichts zu tun.',
      nextAction: deadlines.length ? 'Schreiben prüfen' : undefined,
      deadline: primaryDeadline(deadlines, this.day),
      payment: input.text ? undefined : { amountCents: 9400, iban: 'DE89370400440532013000', recipient: 'Landeshauptkasse', reference: 'Kassenzeichen 0815-2026-4471' },
      reference: input.text ? undefined : 'Kassenzeichen 0815-2026-4471',
      updatedAt: new Date().toISOString(),
      documentCount: 1,
      confidence: 0.88,
      documents: [
        {
          id: `${id}_doc`,
          caseId: id,
          title,
          correspondent: 'Landeshauptkasse',
          kind: 'bescheid',
          channel: input.channel,
          receivedAt: new Date().toISOString(),
          pages: input.pages,
          direction: 'in',
        },
      ],
      timeline: [{ at: new Date().toISOString(), text: `Eingegangen: ${title}` }],
    };
    this.store.unshift(detail);
    return this.delay({ caseId: id, createdCase: true, matchedRule: false, creditsSpent: credits, case: this.summary(detail) }, 1200);
  }

  async search(q: string) {
    const cases = await this.cases(undefined, q);
    const documents = this.store
      .flatMap((c) => c.documents)
      .filter((d) => `${d.title} ${d.correspondent}`.toLowerCase().includes(q.toLowerCase()));
    return this.delay({ cases, documents });
  }

  async ask(question: string) {
    const creditsSpent = this.spend('ask');
    const q = question.toLowerCase();
    const hit = this.store.find((c) => q.split(/\s+/).some((w) => w.length > 3 && `${c.title} ${c.correspondent} ${c.summary}`.toLowerCase().includes(w)));
    if (!hit) return this.delay({ answer: 'Dazu habe ich in deinen Dokumenten nichts gefunden.', sources: [], creditsSpent }, 900);
    const due = hit.deadline ? ` Die nächste Frist ist am ${hit.deadline.date.split('-').reverse().join('.')}.` : '';
    return this.delay(
      { answer: `${hit.summary}${due}`, sources: [{ id: hit.documents[0].id, caseId: hit.id, title: hit.title, date: hit.updatedAt.slice(0, 10) }], creditsSpent },
      900,
    );
  }

  async catalog() {
    return this.delay({
      plans: PLAN_ORDER.map((id) => ({
        ...PLANS[id],
        featureLabels: PLANS[id].features.map((f) => FEATURE_LABEL[f]),
        supportLabel: SUPPORT_LABEL[PLANS[id].support],
      })),
      creditPacks: CREDIT_PACKS,
      creditCosts: Object.entries(CREDIT_COST_UNITS).map(([action, units]) => ({
        action,
        label: CREDIT_ACTION_LABEL[action as keyof typeof CREDIT_ACTION_LABEL],
        credits: toCredits(units),
      })),
    });
  }

  async credits() {
    const me = await this.me();
    return this.delay({ balance: me.credits, ledger: this.ledgerEntries });
  }

  async checkout(input: Parameters<Api['checkout']>[0]) {
    if (input.type === 'credits') {
      const pack = CREDIT_PACKS.find((p) => p.id === input.pack)!;
      this.purchasedCredits += pack.credits;
      this.ledgerEntries.unshift({ credits: pack.credits, action: 'purchase', label: 'Credit-Paket gekauft', ref: null, at: new Date().toISOString() });
      return this.delay({ url: '', amountCents: pack.priceCents, description: `${pack.credits} ToyPost-Credits` }, 600);
    }
    const before = PLANS[this.plan].monthlyCredits;
    this.plan = input.plan;
    const after = PLANS[this.plan].monthlyCredits * (PLANS[this.plan].perSeat ? Math.max(input.seats ?? 1, PLANS[this.plan].minSeats) : 1);
    if (after > before) this.planCredits += after - before;
    return this.delay({ url: '', amountCents: priceFor(input.plan, input.interval, input.seats), description: `ToyPost ${PLANS[input.plan].name}` }, 600);
  }

  async integrations() {
    return this.delay(this.integrationState);
  }

  async saveIntegration(kind: IntegrationKind, config: Record<string, string>) {
    const host = (() => {
      try {
        return new URL(config.url ?? config.eventsUrl).host;
      } catch {
        throw new ApiError(400, 'invalid_input', 'Bitte gib eine vollständige Adresse ein, z. B. https://paperless.example.de');
      }
    })();
    this.integrationState = { ...this.integrationState, [kind]: { connected: true, summary: config.user ? `${config.user} @ ${host}` : host } };
    return this.delay(this.integrationState, 700);
  }

  // ---------- ToyPost ----------

  async messages(filter: { direction?: 'in' | 'out' } = {}) {
    const all = [...this.store.flatMap((c) => c.messages), ...this.extraMessages].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return this.delay(filter.direction ? all.filter((m) => m.direction === filter.direction) : all);
  }

  async contacts(q?: string) {
    return this.delay(demoContacts().filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())));
  }

  async channels() {
    return this.delay({ channels: this.channelList, kinds: DEMO_CHANNEL_KINDS });
  }

  async createChannel(input: { kind: ChannelInfo['kind']; name: string; config: Record<string, unknown> }) {
    const kind = DEMO_CHANNEL_KINDS.find((k) => k.kind === input.kind)!;
    const ch: ChannelInfo = { id: `ch_${Date.now()}`, kind: input.kind, kindLabel: kind.label, name: input.name || kind.label, enabled: true, canSend: kind.canSend, polled: kind.polled, handleLabel: kind.handleLabel, summary: 'Demo: nichts wird wirklich verbunden' };
    this.channelList = [...this.channelList, ch];
    return this.delay(ch, 600);
  }

  async testChannel(id: string) {
    const ch = this.channelList.find((c) => c.id === id);
    return this.delay({ ok: true, message: ch?.polled ? 'Verbunden. Der aktuelle Stand ist gespeichert.' : 'Testnachricht gesendet (Demo).' }, 700);
  }

  async toyOverview() {
    return this.delay(demoOverview(this.invoiceList, this.broadcastList.filter((b) => b.status === 'draft').length));
  }

  async broadcasts() {
    return this.delay(this.broadcastList);
  }

  async previewBroadcast(id: string, lang: string) {
    const b = this.broadcastList.find((x) => x.id === id)!;
    const language = toyLanguage(lang);
    return this.delay({ language: { code: language.code, name: language.name, dir: language.dir }, subject: language.code === 'de' ? b.subject : `[${language.code}] ${b.subject}`, body: language.code === 'de' ? b.body : `[${language.code}] ${b.body}` }, 500);
  }

  async sendBroadcast(id: string) {
    const b = this.broadcastList.find((x) => x.id === id)!;
    b.status = 'sent';
    b.sentAt = new Date().toISOString();
    b.results = { sent: b.recipients, failed: 0, blocked: 0, skipped: 0 };
    return this.delay(b, 800);
  }

  async discardBroadcast(id: string) {
    const b = this.broadcastList.find((x) => x.id === id)!;
    b.status = 'discarded';
    return this.delay(b);
  }

  async createInvoice(input: { address: string; amount: string; label?: string }) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) throw new ApiError(400, 'invalid_input', 'Das ist keine gültige Empfangsadresse.');
    if (!/^\d+(\.\d{1,18})?$/.test(input.amount) || Number(input.amount) <= 0) throw new ApiError(400, 'invalid_input', 'Betrag mit Punkt als Trenner, z. B. 12.5');
    const code = Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[01IO]/g, 'X');
    const invoice = demoInvoice(code, input.amount, input.label ?? 'Rechnung');
    this.invoiceList = [invoice, ...this.invoiceList];
    return this.delay({ invoice }, 500);
  }

  async checkText(text: string) {
    const findings = checkSafety({ text, direction: 'in' }).map((f) => ({ code: f.code, severity: f.severity, message: f.message }));
    const r = detectToyRequest(text);
    return this.delay({ findings, toyRequest: r ? { address: r.address, amount: r.amount?.toString(), purpose: r.purpose, link: r.link } : null }, 300);
  }

  async automations() {
    return this.delay({ automations: this.automationList, presets: DEMO_PRESETS });
  }

  async installPreset(id: string) {
    const p = DEMO_PRESETS.find((x) => x.id === id)!;
    const a: AutomationInfo = { id: `auto_${id}`, name: p.name, trigger: 'demo', enabled: true, runs: 0, log: [] };
    this.automationList = [...this.automationList, a];
    return this.delay(a, 500);
  }
}
