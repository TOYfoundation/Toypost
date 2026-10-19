import type {
  MessageChannelKind,
  SafetyNote,
  ToyInvoiceSummary,
  ToyRequest,
  MessageSummary,
  ContactSummary,
  Account,
  CaseDetail,
  CaseStatus,
  CaseSummary,
  CreditPack,
  DocumentSummary,
  Plan,
  PlanId,
} from '@toypost/shared';

export interface TodayView {
  today: string;
  action: CaseSummary[];
  followUpDue: CaseSummary[];
  waiting: CaseSummary[];
  newInfo: CaseSummary[];
}

export interface Me extends Account {
  role: 'owner' | 'admin' | 'member';
  userName: string;
}

export interface Catalog {
  plans: (Plan & { featureLabels: string[]; supportLabel: string })[];
  creditPacks: CreditPack[];
  creditCosts: { action: string; label: string; credits: number }[];
}

export interface LedgerEntry {
  credits: number;
  action: string;
  label: string;
  ref: string | null;
  at: string;
}

export interface UploadInput {
  text?: string;
  title?: string;
  letterDate?: string;
  channel: 'scan' | 'upload' | 'mail';
  pages: number;
  premiumOcr: boolean;
  file?: { name: string; mime: string; base64: string };
}

export type UploadResult = UploadDone | { queued: true; message: string };

export interface UploadDone {
  queued?: false;
  caseId: string;
  createdCase: boolean;
  matchedRule: boolean;
  creditsSpent: number;
  case: CaseSummary;
}

export interface IntegrationState {
  paperless: { connected: boolean; summary?: string };
  nextcloud: { connected: boolean; summary?: string };
  n8n: { connected: boolean; summary?: string };
  webhookUrl: string;
}

export type IntegrationKind = 'paperless' | 'nextcloud' | 'n8n';

// ---------- ToyPost: Kanäle, Posteingang, Toy-Projekte ----------

export type { ContactSummary, MessageChannelKind, MessageSummary, SafetyNote, ToyInvoiceSummary, ToyRequest } from '@toypost/shared';

export interface ChannelInfo {
  id: string;
  kind: MessageChannelKind;
  kindLabel: string;
  name: string;
  enabled: boolean;
  canSend: boolean;
  polled: boolean;
  handleLabel?: string;
  inboundUrl?: string;
  summary: string;
  lastPollAt?: string;
  lastError?: string;
}

export interface ChannelKindInfo {
  kind: MessageChannelKind;
  label: string;
  canSend: boolean;
  polled: boolean;
  handleLabel?: string;
}

export interface ToyOverview {
  ampel: { color: 'gruen' | 'gelb' | 'rot' | 'unbekannt'; bigRedLamp: boolean; checkedAt: string } | null;
  milestones: { id: string; title: string; status: string; done: boolean }[];
  invoices: { open: number; paid: number; list: ToyInvoiceSummary[] };
  pendingBroadcasts: number;
  languages: number;
}

export interface BroadcastInfo {
  id: string;
  audience: string;
  audienceLabel: string;
  subject: string;
  body: string;
  source: string;
  status: 'draft' | 'sent' | 'discarded';
  createdAt: string;
  sentAt?: string;
  recipients: number;
  languages: string[];
  results?: { sent: number; failed: number; blocked: number; skipped: number };
}

export interface AutomationInfo {
  id: string;
  name: string;
  trigger: string;
  enabled: boolean;
  runs: number;
  lastRunAt?: string;
  log: { at: string; result: string }[];
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  needs: ('github' | 'toyscan' | 'announce')[];
}

export interface CheckResult {
  findings: SafetyNote[];
  toyRequest: ToyRequest | null;
}

/** Gemeinsame Schnittstelle für echten Server und Demo-Modus. */
export interface Api {
  readonly mode: 'live' | 'demo';
  me(): Promise<Me>;
  today(): Promise<TodayView>;
  cases(status?: CaseStatus, q?: string): Promise<CaseSummary[]>;
  caseDetail(id: string): Promise<CaseDetail>;
  updateCase(id: string, patch: { status?: CaseStatus; followUpOn?: string | null }): Promise<CaseSummary>;
  markPaid(id: string): Promise<CaseSummary>;
  giroCode(id: string): Promise<{ payload: string }>;
  createDraft(id: string, input: { intent?: string; tone: 'sachlich' | 'freundlich' | 'bestimmt' }): Promise<{ id: string; subject: string; body: string; creditsSpent: number }>;
  /** channelId: über diesen Kanal an den Kontakt senden; '' = besten Kanal wählen; undefined = nur als versendet markieren */
  sendDraft(draftId: string, channelId?: string): Promise<CaseSummary>;
  upload(input: UploadInput): Promise<UploadResult>;
  search(q: string): Promise<{ cases: CaseSummary[]; documents: DocumentSummary[] }>;
  ask(question: string): Promise<{ answer: string; sources: { id: string; caseId: string; title: string; date: string }[]; creditsSpent: number }>;
  catalog(): Promise<Catalog>;
  credits(): Promise<{ balance: Account['credits']; ledger: LedgerEntry[] }>;
  checkout(input: { type: 'plan'; plan: Exclude<PlanId, 'free' | 'enterprise'>; interval: 'month' | 'year'; seats?: number } | { type: 'credits'; pack: 'S' | 'M' | 'L' }): Promise<{ url: string; amountCents: number; description: string }>;
  integrations(): Promise<IntegrationState>;
  saveIntegration(kind: IntegrationKind, config: Record<string, string>): Promise<IntegrationState>;
  // ToyPost
  messages(filter?: { direction?: 'in' | 'out' }): Promise<MessageSummary[]>;
  contacts(q?: string): Promise<ContactSummary[]>;
  channels(): Promise<{ channels: ChannelInfo[]; kinds: ChannelKindInfo[] }>;
  createChannel(input: { kind: MessageChannelKind; name: string; config: Record<string, unknown> }): Promise<ChannelInfo>;
  testChannel(id: string, to?: string): Promise<{ ok: boolean; message: string }>;
  toyOverview(): Promise<ToyOverview>;
  broadcasts(): Promise<BroadcastInfo[]>;
  previewBroadcast(id: string, lang: string): Promise<{ language: { code: string; name: string; dir: 'ltr' | 'rtl' }; subject: string; body: string }>;
  sendBroadcast(id: string): Promise<BroadcastInfo>;
  discardBroadcast(id: string): Promise<BroadcastInfo>;
  createInvoice(input: { address: string; amount: string; label?: string; note?: string; caseId?: string }): Promise<{ invoice: ToyInvoiceSummary }>;
  checkText(text: string): Promise<CheckResult>;
  automations(): Promise<{ automations: AutomationInfo[]; presets: PresetInfo[] }>;
  installPreset(id: string, ids: { github?: string; announce?: string }): Promise<AutomationInfo>;
}

/** Fehler der API mit der Meldung, die der Nutzer sieht. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: any;
  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
