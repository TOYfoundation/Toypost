/**
 * Credits: Abrechnungseinheit für KI-Arbeit.
 * Intern wird in Zehntel-Credits gerechnet (CREDIT_SCALE), damit 0,5 Credits ohne Gleitkomma-Fehler gehen.
 */

export const CREDIT_SCALE = 10;

export type CreditAction = 'analyze' | 'premiumOcrPage' | 'ask' | 'draft' | 'importDoc';

/** Kosten je Aktion in Zehntel-Credits. */
export const CREDIT_COST_UNITS: Record<CreditAction, number> = {
  analyze: 10,
  premiumOcrPage: 10,
  ask: 30,
  draft: 50,
  importDoc: 5,
};

export const CREDIT_ACTION_LABEL: Record<CreditAction, string> = {
  analyze: 'Dokument auswerten',
  premiumOcrPage: 'Premium-OCR je Seite',
  ask: 'Frage an das Archiv',
  draft: 'Antwortentwurf',
  importDoc: 'Altbestand importieren, je Dokument',
};

export function costOf(action: CreditAction, quantity = 1): number {
  return CREDIT_COST_UNITS[action] * quantity;
}

export function toCredits(units: number): number {
  return units / CREDIT_SCALE;
}

export function toUnits(credits: number): number {
  return Math.round(credits * CREDIT_SCALE);
}

export interface CreditPack {
  id: 'S' | 'M' | 'L';
  credits: number;
  priceCents: number;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: 'S', credits: 500, priceCents: 500 },
  { id: 'M', credits: 1500, priceCents: 1200 },
  { id: 'L', credits: 4000, priceCents: 2500 },
];

/** Gekaufte Credits verfallen nach 24 Monaten. */
export const PURCHASED_VALIDITY_MONTHS = 24;

export function pricePerCreditCents(pack: CreditPack): number {
  return pack.priceCents / pack.credits;
}

export interface CreditBucket {
  id: string;
  kind: 'plan' | 'purchased';
  /** verbleibend, in Zehntel-Credits */
  remainingUnits: number;
  /** ISO-Zeitstempel */
  expiresAt: string;
}

export interface SpendResult {
  ok: boolean;
  /** Abbuchungen je Topf, in Zehntel-Credits */
  deductions: { bucketId: string; units: number }[];
  /** fehlender Betrag, wenn ok=false */
  shortfallUnits: number;
}

/**
 * Verteilt eine Abbuchung auf die Töpfe:
 * zuerst das Monatskontingent (verfällt sonst), dann gekaufte Credits mit dem frühesten Ablaufdatum.
 * Abgelaufene Töpfe werden ignoriert. Reicht das Guthaben nicht, wird nichts abgebucht.
 */
export function allocateSpend(buckets: CreditBucket[], units: number, now: Date = new Date()): SpendResult {
  const live = buckets
    .filter((b) => b.remainingUnits > 0 && new Date(b.expiresAt).getTime() > now.getTime())
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'plan' ? -1 : 1;
      return new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
    });
  const available = live.reduce((sum, b) => sum + b.remainingUnits, 0);
  if (available < units) {
    return { ok: false, deductions: [], shortfallUnits: units - available };
  }
  const deductions: SpendResult['deductions'] = [];
  let rest = units;
  for (const b of live) {
    if (rest === 0) break;
    const take = Math.min(b.remainingUnits, rest);
    deductions.push({ bucketId: b.id, units: take });
    rest -= take;
  }
  return { ok: true, deductions, shortfallUnits: 0 };
}

/** true, sobald 80 % des Monatskontingents verbraucht sind. */
export function shouldWarn(planRemainingUnits: number, monthlyGrantUnits: number): boolean {
  if (monthlyGrantUnits <= 0) return false;
  return planRemainingUnits <= monthlyGrantUnits * 0.2;
}
