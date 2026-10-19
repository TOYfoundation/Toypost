/**
 * GiroCode / EPC-QR-Code (European Payments Council, Version 002).
 * Die Banking-App liest den Code und füllt die Überweisung vollständig aus.
 */

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/** Prüfziffer nach ISO 13616 (Modulo 97). */
export function isValidIban(iban: string): boolean {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = /[A-Z]/.test(ch) ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const digit of v) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function formatIban(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})/g, '$1 ').trim();
}

export interface GiroCodeInput {
  recipient: string;
  iban: string;
  amountCents: number;
  /** unstrukturierter Verwendungszweck, max. 140 Zeichen */
  reference?: string;
  bic?: string;
}

export function buildGiroCodePayload(input: GiroCodeInput): string {
  const iban = normalizeIban(input.iban);
  if (!isValidIban(iban)) throw new Error('Die IBAN ist ungültig.');
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > 99_999_999_999) {
    throw new Error('Der Betrag muss zwischen 0,01 € und 999.999.999,99 € liegen.');
  }
  const name = input.recipient.trim().slice(0, 70);
  if (!name) throw new Error('Der Empfänger fehlt.');
  const amount = `EUR${Math.floor(input.amountCents / 100)}.${(input.amountCents % 100).toString().padStart(2, '0')}`;
  const lines = [
    'BCD',
    '002',
    '1', // UTF-8
    'SCT',
    (input.bic ?? '').trim(),
    name,
    iban,
    amount,
    '', // Purpose code
    '', // strukturierte Referenz (RF), hier nicht genutzt
    (input.reference ?? '').trim().slice(0, 140),
  ];
  // Leere Zeilen am Ende dürfen entfallen.
  while (lines.length > 8 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
