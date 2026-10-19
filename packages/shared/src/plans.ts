import type { PlanId } from './types.ts';

export type FeatureKey =
  | 'cases' // Vorgänge, Fristen, Heute-Ansicht
  | 'mailInbox' // E-Mail-Postfächer anbinden
  | 'drafts' // Antwortentwürfe ohne Extra-Freigabe
  | 'paymentAssistant' // GiroCode, bezahlt markieren
  | 'ownInstances' // eigene Paperless-/Nextcloud-Instanzen verbinden
  | 'familyMember'
  | 'roles' // Rollen, Zuweisung
  | 'approval' // 4-Augen-Freigabe von Antworten
  | 'sharedInboxes'
  | 'customWorkflows' // eigene n8n-Workflows
  | 'sso'
  | 'auditExport'
  | 'ownModels' // eigene/lokale KI-Modelle
  | 'onPremise';

export type SupportLevel = 'community' | 'email-2d' | 'email-1d' | 'sla';

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Preis in Cent. Bei Team/Enterprise je Nutzer. */
  priceMonthlyCents: number;
  priceYearlyCents: number;
  perSeat: boolean;
  /** Brutto (Privatkunden) oder netto (Geschäftskunden) */
  priceIncludesVat: boolean;
  minSeats: number;
  maxSeats: number | null;
  /** Speicher in GB; bei perSeat je Nutzer, gemeinsam genutzt */
  storageGb: number;
  /** Inklusiv-Credits pro Monat; bei perSeat je Nutzer, gemeinsamer Topf */
  monthlyCredits: number;
  mailInboxes: number | null;
  features: FeatureKey[];
  support: SupportLevel;
  /** Enterprise: Preis ist ein Ab-Preis, Angebot individuell */
  custom: boolean;
}

/** In allen Tarifen enthalten. Antwortentwürfe kosten überall Credits, auch in Free. */
const BASE: FeatureKey[] = ['cases', 'drafts', 'paymentAssistant'];

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'Zum Ausprobieren und für wenig Post',
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    perSeat: false,
    priceIncludesVat: true,
    minSeats: 1,
    maxSeats: 1,
    storageGb: 1,
    monthlyCredits: 30,
    mailInboxes: 0,
    features: [...BASE],
    support: 'community',
    custom: false,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'Für Privathaushalte und Selbstständige',
    priceMonthlyCents: 699,
    priceYearlyCents: 6900,
    perSeat: false,
    priceIncludesVat: true,
    minSeats: 1,
    maxSeats: 2,
    storageGb: 25,
    monthlyCredits: 400,
    mailInboxes: 3,
    features: [...BASE, 'mailInbox', 'ownInstances', 'familyMember'],
    support: 'email-2d',
    custom: false,
  },
  team: {
    id: 'team',
    name: 'Team',
    tagline: 'Für Büros, Praxen und kleine Unternehmen',
    priceMonthlyCents: 899,
    priceYearlyCents: 8900,
    perSeat: true,
    priceIncludesVat: false,
    minSeats: 3,
    maxSeats: null,
    storageGb: 50,
    monthlyCredits: 600,
    mailInboxes: null,
    features: [
      ...BASE,
      'mailInbox',
      'ownInstances',
      'roles',
      'approval',
      'sharedInboxes',
      'customWorkflows',
    ],
    support: 'email-1d',
    custom: false,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Für Organisationen mit eigenen Vorgaben',
    priceMonthlyCents: 1900,
    priceYearlyCents: 1900 * 12,
    perSeat: true,
    priceIncludesVat: false,
    minSeats: 25,
    maxSeats: null,
    storageGb: 1000,
    monthlyCredits: 1000,
    mailInboxes: null,
    features: [
      ...BASE,
      'mailInbox',
      'ownInstances',
      'roles',
      'approval',
      'sharedInboxes',
      'customWorkflows',
      'sso',
      'auditExport',
      'ownModels',
      'onPremise',
    ],
    support: 'sla',
    custom: true,
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'pro', 'team', 'enterprise'];

export function hasFeature(plan: PlanId, feature: FeatureKey): boolean {
  return PLANS[plan].features.includes(feature);
}

/** Speicherlimit in Bytes für ein Konto mit n Nutzern. */
export function storageLimitBytes(plan: PlanId, seats = 1): number {
  const p = PLANS[plan];
  const gb = p.perSeat ? p.storageGb * Math.max(seats, p.minSeats) : p.storageGb;
  return gb * 1024 ** 3;
}

/** Monatliches Credit-Kontingent für ein Konto mit n Nutzern. */
export function monthlyCreditGrant(plan: PlanId, seats = 1): number {
  const p = PLANS[plan];
  return p.perSeat ? p.monthlyCredits * Math.max(seats, p.minSeats) : p.monthlyCredits;
}

/** Preis pro Abrechnungszeitraum in Cent. */
export function priceFor(plan: PlanId, interval: 'month' | 'year', seats = 1): number {
  const p = PLANS[plan];
  const unit = interval === 'month' ? p.priceMonthlyCents : p.priceYearlyCents;
  return p.perSeat ? unit * Math.max(seats, p.minSeats) : unit;
}

/** Ersparnis des Jahrespreises gegenüber 12 Monatszahlungen, in Prozent (gerundet). */
export function yearlySavingPercent(plan: PlanId): number {
  const p = PLANS[plan];
  if (p.priceMonthlyCents === 0) return 0;
  return Math.round((1 - p.priceYearlyCents / (p.priceMonthlyCents * 12)) * 100);
}

export const SUPPORT_LABEL: Record<SupportLevel, string> = {
  community: 'Hilfe-Center und Community',
  'email-2d': 'E-Mail, Antwort in 2 Werktagen',
  'email-1d': 'E-Mail, Antwort in 1 Werktag',
  sla: 'SLA 99,9 % und fester Ansprechpartner',
};

export const FEATURE_LABEL: Record<FeatureKey, string> = {
  cases: 'Vorgänge, Fristen und Heute-Ansicht',
  mailInbox: 'E-Mail-Postfächer anbinden',
  drafts: 'Antwortentwürfe',
  paymentAssistant: 'Zahlungs-Assistent mit GiroCode',
  ownInstances: 'Eigene Paperless- und Nextcloud-Server verbinden',
  familyMember: 'Ein Familienmitglied inklusive',
  roles: 'Rollen und Zuweisung',
  approval: '4-Augen-Freigabe für Antworten',
  sharedInboxes: 'Gemeinsame Postfächer',
  customWorkflows: 'Eigene n8n-Workflows',
  sso: 'Single Sign-on (SAML, OIDC)',
  auditExport: 'Audit-Export',
  ownModels: 'Eigene KI-Modelle',
  onPremise: 'Betrieb im eigenen Rechenzentrum',
};
