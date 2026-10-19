import { detectDeadlines, isValidIban, normalizeIban, primaryDeadline, type Analysis, type DocumentKind, type Payment } from '../shared.ts';

/**
 * Regelbasierte Vorauswertung. Kostet nichts und läuft vor jeder KI.
 * Sie liefert der KI Vorschläge und dient als Ersatz, wenn keine KI konfiguriert ist (AI_PROVIDER=mock).
 */

const KIND_PATTERNS: [DocumentKind, RegExp][] = [
  ['mahnung', /\b(mahnung|zahlungserinnerung|letzte erinnerung)\b/i],
  ['bescheid', /\b(bescheid|festsetzung|steuernummer|finanzamt|bewilligung)\b/i],
  ['kuendigung', /\b(kündigung|kündigungsbestätigung|vertragsende)\b/i],
  ['rechnung', /\b(rechnung|rechnungsnummer|rechnungsbetrag|zahlbar|abschlag)\b/i],
  ['vertrag', /\b(vertrag|vertragsnummer|laufzeit|vertragsbedingungen)\b/i],
  ['kontoauszug', /\b(kontoauszug|saldo)\b/i],
  ['information', /\b(information|mitteilung|hinweis|newsletter)\b/i],
];

export function guessKind(text: string): DocumentKind {
  for (const [kind, re] of KIND_PATTERNS) if (re.test(text)) return kind;
  return 'sonstiges';
}

export function guessCorrespondent(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const from = text.match(/(?:absender|von):\s*(.+)/i);
  if (from) return from[1].trim().slice(0, 80);
  const org = lines.find((l) => /(gmbh|ag\b|e\.\s?v\.|amt\b|kasse|stadtwerke|versicherung|bank|verwaltung|kg\b)/i.test(l));
  return (org ?? lines[0] ?? 'Unbekannter Absender').slice(0, 80);
}

const REFERENCE_RE =
  /(aktenzeichen|az\.?|steuernummer|kundennummer|kunden-nr\.?|kd\.-?nr\.?|rechnungsnummer|rechnungs-nr\.?|vertragsnummer|vertrags-nr\.?|versicherungsnummer|mitgliedsnummer|zeichen)\s*:?\s*([A-Z0-9][A-Z0-9/\-. ]{2,30}[A-Z0-9])/i;

export function extractReference(text: string): string | undefined {
  const m = text.match(REFERENCE_RE);
  if (!m) return undefined;
  return `${m[1].replace(/\.$/, '')} ${m[2].trim()}`.replace(/\s+/g, ' ');
}

const AMOUNT_RE =
  /(gesamtbetrag|rechnungsbetrag|zu zahlen(?:der betrag)?|zahlbetrag|offener betrag|betrag|summe|nachzahlung)\s*:?\s*(?:eur|€)?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*(?:eur|€)?/i;

export function extractAmountCents(text: string): number | undefined {
  const m = text.match(AMOUNT_RE);
  if (!m) return undefined;
  const value = m[2].replace(/\./g, '').replace(',', '.');
  return Math.round(Number(value) * 100);
}

export function extractIban(text: string): string | undefined {
  const re = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?)\b/g;
  for (const m of text.matchAll(re)) {
    const iban = normalizeIban(m[1]);
    if (isValidIban(iban)) return iban;
  }
  return undefined;
}

export function extractPayment(text: string, correspondent: string): Payment | undefined {
  const iban = extractIban(text);
  const amountCents = extractAmountCents(text);
  if (!iban || !amountCents) return undefined;
  const ref = text.match(/verwendungszweck\s*:?\s*(.+)/i)?.[1]?.trim() ?? extractReference(text);
  return { iban, amountCents, recipient: correspondent, reference: ref?.slice(0, 140) };
}

const NEXT_ACTION: Partial<Record<DocumentKind, string>> = {
  rechnung: 'Rechnung bezahlen',
  mahnung: 'Mahnung sofort begleichen',
  bescheid: 'Bescheid prüfen, ggf. Einspruch einlegen',
  kuendigung: 'Kündigung prüfen',
};

export function heuristicAnalysis(text: string, letterDate: string, receivedDate?: string): Analysis {
  const kind = guessKind(text);
  const correspondent = guessCorrespondent(text);
  const deadlines = detectDeadlines(text, { letterDate, receivedDate });
  const payment = extractPayment(text, correspondent);
  const reference = extractReference(text);
  const actionRequired = deadlines.length > 0 || !!payment || kind === 'mahnung' || kind === 'bescheid';
  const firstDeadline = primaryDeadline(deadlines, letterDate);
  let nextAction = NEXT_ACTION[kind];
  if (!nextAction && firstDeadline?.kind === 'antwort') nextAction = 'Antworten oder Unterlagen senden';
  const kindLabel: Record<DocumentKind, string> = {
    rechnung: 'Rechnung',
    mahnung: 'Mahnung',
    bescheid: 'Bescheid',
    vertrag: 'Vertrag',
    kuendigung: 'Kündigung',
    kontoauszug: 'Kontoauszug',
    information: 'Information',
    sonstiges: 'Schreiben',
  };
  return {
    kind,
    correspondent,
    title: `${kindLabel[kind]} ${correspondent}`.slice(0, 120),
    summary: actionRequired
      ? `${kindLabel[kind]} von ${correspondent}${firstDeadline ? `, Frist ${firstDeadline.date}` : ''}.`
      : `${kindLabel[kind]} von ${correspondent}, nichts zu tun.`,
    actionRequired,
    nextAction: actionRequired ? nextAction ?? 'Schreiben prüfen' : undefined,
    deadlines,
    payment,
    reference,
    caseHint: reference ?? correspondent,
    confidence: 0.55,
  };
}
