import { checkAddress, findAddresses } from './address.ts';
import { findToyAmount, parseToy, toyDecimal, ToyAmountError } from './amount.ts';
import { LEGACY_TOKENS } from './safety.ts';

/**
 * TOY payment links and QR codes, as planned for the TOYPAY wallet (concept 04, section 7a):
 *   toychain:<address>?betrag=<TOY>&zweck=<purpose>
 * modelled on BIP-21 / EIP-681. ToyPost uses these parameters (proposal in toycoin docs/spaeter):
 *   betrag     amount in TOY as plain decimal with a dot, at most 18 decimals (never smallest units)
 *   zweck      purpose that goes on chain, at most 32 bytes UTF-8 (spec 7.2)
 *   nachricht  note for the payer, shown in the wallet only, never on chain
 *   bis        payment request valid until (YYYY-MM-DD)
 * Unknown parameters are kept; unknown parameters starting with "req-" make the link invalid (BIP-21 rule),
 * so an older wallet never silently ignores a requirement.
 */

export const PURPOSE_MAX_BYTES = 32;

export interface PaymentRequest {
  address: string;
  /** smallest units */
  amount?: bigint;
  purpose?: string;
  note?: string;
  /** YYYY-MM-DD */
  validUntil?: string;
  extra?: Record<string, string>;
}

export class PaymentLinkError extends Error {}

export function purposeBytes(purpose: string): number {
  return new TextEncoder().encode(purpose).length;
}

/** Cuts a purpose to at most 32 bytes without splitting a character. */
export function fitPurpose(purpose: string): string {
  let out = '';
  for (const ch of purpose) {
    if (purposeBytes(out + ch) > PURPOSE_MAX_BYTES) break;
    out += ch;
  }
  return out;
}

const KNOWN = new Set(['betrag', 'zweck', 'nachricht', 'bis']);

export function buildPaymentLink(req: PaymentRequest): string {
  const a = checkAddress(req.address);
  if (!a.ok) throw new PaymentLinkError(a.reason === 'checksum' ? 'Die Prüfsumme der Adresse stimmt nicht.' : 'Das ist keine gültige Adresse.');
  if (req.purpose !== undefined && purposeBytes(req.purpose) > PURPOSE_MAX_BYTES) {
    throw new PaymentLinkError(`Der Verwendungszweck ist länger als ${PURPOSE_MAX_BYTES} Byte.`);
  }
  if (req.validUntil !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(req.validUntil)) throw new PaymentLinkError('"bis" muss ein Datum JJJJ-MM-TT sein.');
  const params: [string, string][] = [];
  if (req.amount !== undefined) params.push(['betrag', toyDecimal(req.amount)]);
  if (req.purpose) params.push(['zweck', req.purpose]);
  if (req.note) params.push(['nachricht', req.note]);
  if (req.validUntil) params.push(['bis', req.validUntil]);
  for (const [k, v] of Object.entries(req.extra ?? {})) if (!KNOWN.has(k)) params.push([k, v]);
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `toychain:${a.address}${query ? `?${query}` : ''}`;
}

export function parsePaymentLink(link: string): PaymentRequest {
  const m = /^toychain:(0x[0-9a-fA-F]{40})(?:\?(.*))?$/.exec(link.trim());
  if (!m) throw new PaymentLinkError('Das ist kein toychain:-Zahlungslink.');
  const a = checkAddress(m[1]);
  if (!a.ok) throw new PaymentLinkError(a.reason === 'checksum' ? 'Die Prüfsumme der Adresse im Link stimmt nicht.' : 'Die Adresse im Link ist ungültig.');
  const req: PaymentRequest = { address: a.address };
  const extra: Record<string, string> = {};
  for (const pair of (m[2] ?? '').split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
    let value: string;
    try {
      value = decodeURIComponent(eq < 0 ? '' : pair.slice(eq + 1).replace(/\+/g, '%20'));
    } catch {
      throw new PaymentLinkError(`Der Wert von "${key}" ist falsch kodiert.`);
    }
    switch (key) {
      case 'betrag':
        try {
          req.amount = parseToy(value);
        } catch (e) {
          throw new PaymentLinkError(e instanceof ToyAmountError ? e.message : 'Ungültiger Betrag.');
        }
        break;
      case 'zweck':
        if (purposeBytes(value) > PURPOSE_MAX_BYTES) throw new PaymentLinkError(`Der Verwendungszweck ist länger als ${PURPOSE_MAX_BYTES} Byte.`);
        req.purpose = value;
        break;
      case 'nachricht':
        req.note = value;
        break;
      case 'bis':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PaymentLinkError('"bis" muss ein Datum JJJJ-MM-TT sein.');
        req.validUntil = value;
        break;
      default:
        if (key.startsWith('req-')) throw new PaymentLinkError(`Der Link verlangt "${key}", das ToyPost nicht kennt.`);
        extra[key] = value;
    }
  }
  if (Object.keys(extra).length) req.extra = extra;
  return req;
}

/** All valid toychain: links in a text (letters, e-mails, messages). Invalid ones are skipped. */
export function findPaymentLinks(text: string): PaymentRequest[] {
  const out: PaymentRequest[] = [];
  for (const m of text.matchAll(/toychain:0x[0-9a-fA-F]{40}(?:\?[^\s<>"')\]]*)?/g)) {
    try {
      out.push(parsePaymentLink(m[0]));
    } catch {
      // ignore broken links; the safety check reports them separately
    }
  }
  return out;
}

/**
 * Purpose for an invoice: "TP-" plus a short code, unique per invoice and well under 32 bytes,
 * so that ToyPost can match the incoming payment to the case without guessing.
 */
export function invoicePurpose(invoiceCode: string, label?: string): string {
  const code = `TP-${invoiceCode.toUpperCase()}`;
  if (!label) return code;
  return fitPurpose(`${code} ${label}`);
}

export interface DetectedToyRequest {
  address: string;
  amount?: bigint;
  purpose?: string;
  link: string;
}

/**
 * A request to pay TOY found in a letter, e-mail or chat: a toychain: link, or exactly one address together
 * with a TOY amount. Legacy token contracts and the user's own addresses are never treated as payees.
 */
export function detectToyRequest(text: string, ownAddresses: readonly string[] = []): DetectedToyRequest | undefined {
  const excluded = new Set([...LEGACY_TOKENS.map((t) => t.address.toLowerCase()), ...ownAddresses.map((a) => a.toLowerCase())]);
  const link = findPaymentLinks(text).find((l) => !excluded.has(l.address.toLowerCase()));
  if (link) return { address: link.address, amount: link.amount, purpose: link.purpose, link: buildPaymentLink(link) };
  const candidates = findAddresses(text).filter((a) => !excluded.has(a.toLowerCase()));
  const amount = findToyAmount(text);
  if (candidates.length === 1 && amount !== undefined) {
    return { address: candidates[0], amount, link: buildPaymentLink({ address: candidates[0], amount }) };
  }
  return undefined;
}
