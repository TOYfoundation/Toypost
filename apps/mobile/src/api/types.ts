import type {
  Account,
  CaseDetail,
  CaseStatus,
  CaseSummary,
  CreditPack,
  DocumentSummary,
  Plan,
  PlanId,
} from '@dokufy/shared';

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
  sendDraft(draftId: string): Promise<CaseSummary>;
  upload(input: UploadInput): Promise<UploadResult>;
  search(q: string): Promise<{ cases: CaseSummary[]; documents: DocumentSummary[] }>;
  ask(question: string): Promise<{ answer: string; sources: { id: string; caseId: string; title: string; date: string }[]; creditsSpent: number }>;
  catalog(): Promise<Catalog>;
  credits(): Promise<{ balance: Account['credits']; ledger: LedgerEntry[] }>;
  checkout(input: { type: 'plan'; plan: Exclude<PlanId, 'free' | 'enterprise'>; interval: 'month' | 'year'; seats?: number } | { type: 'credits'; pack: 'S' | 'M' | 'L' }): Promise<{ url: string; amountCents: number; description: string }>;
  integrations(): Promise<IntegrationState>;
  saveIntegration(kind: IntegrationKind, config: Record<string, string>): Promise<IntegrationState>;
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
