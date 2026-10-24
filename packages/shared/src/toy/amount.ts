/**
 * TOY amounts, exactly as ToyChain defines them (spec v0.3, sections 1 and 14):
 * 18 decimals, at most 100,000,000 TOY = 10^26 smallest units. Amounts are integers in smallest units (bigint),
 * never floating point. On the wire (ToyScan API, toy_ methods) they travel as decimal strings of smallest units.
 */

import { TOYVERSE } from './toyverse-data.ts';

// Values come from the shared ToyVerse file (toycoin shared/toyverse.json, decision 135), never typed here.
export const TOY_DECIMALS = TOYVERSE.toy.decimals;
export const TOY_UNIT = BigInt(TOYVERSE.toy.unitsPerToy);
/** Constitution value: hard cap of all TOY ever (10^26 smallest units). */
export const TOY_MAX_SUPPLY = BigInt(TOYVERSE.toy.maxSupplyUnits);
export const TOY_TICKER = TOYVERSE.toy.ticker;

export class ToyAmountError extends Error {}

function check(units: bigint): bigint {
  if (units < 0n) throw new ToyAmountError('Ein TOY-Betrag kann nicht negativ sein.');
  if (units > TOY_MAX_SUPPLY) throw new ToyAmountError('Mehr als 100.000.000 TOY gibt es nicht.');
  return units;
}

/** Smallest units from the wire format (decimal string), e.g. "1500000000000000000" → 1.5 TOY. */
export function unitsFromWire(s: string): bigint {
  if (!/^\d{1,27}$/.test(s)) throw new ToyAmountError(`"${s}" ist kein Betrag in kleinsten Einheiten.`);
  return check(BigInt(s));
}

export function unitsToWire(units: bigint): string {
  return check(units).toString();
}

/**
 * Parses a plain decimal TOY amount with a dot ("12.5", "0.000000000000000001"), as used in payment links.
 * More than 18 decimals is an error, never rounded.
 */
export function parseToy(decimal: string): bigint {
  const s = decimal.trim();
  const m = /^(\d{1,9})(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) throw new ToyAmountError(`"${decimal}" ist kein gültiger TOY-Betrag (höchstens 18 Nachkommastellen, Punkt als Trenner).`);
  const frac = (m[2] ?? '').padEnd(TOY_DECIMALS, '0');
  return check(BigInt(m[1]) * TOY_UNIT + BigInt(frac));
}

/** Plain decimal with a dot and only the decimals that are needed ("12.5"), the inverse of parseToy. */
export function toyDecimal(units: bigint): string {
  check(units);
  const whole = units / TOY_UNIT;
  const frac = (units % TOY_UNIT).toString().padStart(TOY_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Amount found in running text, e.g. "12,50 TOY", "1.250 TOY", "TOY 0.1". German style (comma decimal,
 * dot thousands) unless the number is clearly English style. Returns undefined if no valid TOY amount is found.
 */
export function findToyAmount(text: string): bigint | undefined {
  const re = /(?:\bTOY\s*([0-9][0-9.,']*)|([0-9][0-9.,']*)\s*(?:TOY|ToyCoin)\b)/g;
  for (const m of text.matchAll(re)) {
    const raw = (m[1] ?? m[2]).replace(/[.,]$/, '').replace(/'/g, '');
    const units = parseLooseNumber(raw);
    if (units !== undefined) return units;
  }
  return undefined;
}

function parseLooseNumber(raw: string): bigint | undefined {
  let normalized: string;
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  if (hasComma && hasDot) {
    // the separator that comes last is the decimal separator
    normalized = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  } else if (hasComma) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(raw) && raw.split(',').length > 2 ? raw.replace(/,/g, '') : raw.replace(',', '.');
  } else if (hasDot) {
    // "1.000" or "1.000.000" are German thousands; "0.5" or "12.75" are decimals
    normalized = /^\d{1,3}(\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '') : raw;
  } else {
    normalized = raw;
  }
  try {
    return parseToy(normalized);
  } catch {
    return undefined;
  }
}

/**
 * Shows a TOY amount in the reader's language: separators from the locale, all needed decimals, never rounded,
 * always with the ticker (TOYPAY wallet concept, section 7d). Example: de → "1.234,5 TOY", en → "1,234.5 TOY".
 */
export function formatToy(units: bigint, locale = 'de'): string {
  const plain = toyDecimal(units);
  const [whole, frac] = plain.split('.');
  let group = '.';
  let decimal = ',';
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
    group = parts.find((p) => p.type === 'group')?.value ?? ',';
    decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  } catch {
    // unknown locale: keep the German defaults
  }
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${grouped}${frac ? decimal + frac : ''} ${TOY_TICKER}`;
}
