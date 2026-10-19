import { addressFromPublicKey, checkAddress, fromHex, keccak256 } from '../shared.ts';
import { bytesToBigInt, recoverPublicKey } from './secp256k1.ts';

/**
 * "Anmelden mit Adresse" (Sign-In with Ethereum, EIP-4361), as planned for the TOYPAY wallet (concept 04, 7b).
 * The wallet signs a readable text with personal_sign (EIP-191); ToyPost recovers the address from the signature.
 */

export interface SiweMessage {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources: string[];
}

export function parseSiwe(text: string): SiweMessage {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = /^(.+) wants you to sign in with your Ethereum account:$/.exec(lines[0] ?? '');
  if (!head) throw new Error('Keine Anmelde-Nachricht nach EIP-4361.');
  const address = (lines[1] ?? '').trim();
  const a = checkAddress(address);
  if (!a.ok) throw new Error('Die Adresse in der Anmelde-Nachricht ist ungültig.');
  if (lines[2] !== '') throw new Error('Anmelde-Nachricht: Leerzeile nach der Adresse fehlt.');
  let i = 3;
  let statement: string | undefined;
  if (lines[i] !== undefined && !lines[i].startsWith('URI: ')) {
    statement = lines[i];
    i++;
    if (lines[i] !== '') throw new Error('Anmelde-Nachricht: Leerzeile nach dem Text fehlt.');
    i++;
  }
  const fields: Record<string, string> = {};
  const resources: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === 'Resources:') {
      for (i++; i < lines.length && lines[i].startsWith('- '); i++) resources.push(lines[i].slice(2));
      break;
    }
    const m = /^([A-Za-z ]+): (.*)$/.exec(line);
    if (!m) {
      if (line === '') continue;
      throw new Error(`Anmelde-Nachricht: unerwartete Zeile „${line.slice(0, 40)}“.`);
    }
    fields[m[1]] = m[2];
  }
  for (const k of ['URI', 'Version', 'Chain ID', 'Nonce', 'Issued At']) if (!fields[k]) throw new Error(`Anmelde-Nachricht: „${k}“ fehlt.`);
  if (fields.Version !== '1') throw new Error('Anmelde-Nachricht: nur Version 1 wird unterstützt.');
  if (!/^[a-zA-Z0-9]{8,}$/.test(fields.Nonce)) throw new Error('Anmelde-Nachricht: ungültige Nonce.');
  return {
    domain: head[1],
    address: a.address,
    statement,
    uri: fields.URI,
    version: fields.Version,
    chainId: Number(fields['Chain ID']),
    nonce: fields.Nonce,
    issuedAt: fields['Issued At'],
    expirationTime: fields['Expiration Time'],
    notBefore: fields['Not Before'],
    requestId: fields['Request ID'],
    resources,
  };
}

/** EIP-191 hash of a personal message: keccak256("\x19Ethereum Signed Message:\n" + length + message). */
export function personalMessageHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak256(all);
}

/** Address that signed a personal message, or undefined if the signature is invalid. */
export function recoverPersonalSigner(message: string, signatureHex: string): string | undefined {
  let sig: Uint8Array;
  try {
    sig = fromHex(signatureHex);
  } catch {
    return undefined;
  }
  if (sig.length !== 65) return undefined;
  const r = bytesToBigInt(sig.slice(0, 32));
  const s = bytesToBigInt(sig.slice(32, 64));
  const v = sig[64];
  const recId = v >= 27 ? v - 27 : v;
  const pub = recoverPublicKey(personalMessageHash(message), r, s, recId);
  return pub ? addressFromPublicKey(pub) : undefined;
}

export interface SiweCheck {
  domain: string;
  /** allowed chain ids; empty = any (ToyChain's chain id is not chosen yet, toycoin decision 40) */
  chainIds: number[];
  now: Date;
  /** returns true once if the nonce was issued by ToyPost and not used yet */
  consumeNonce: (nonce: string) => boolean;
}

export function verifySiwe(message: string, signature: string, check: SiweCheck): { address: string; parsed: SiweMessage } {
  const parsed = parseSiwe(message);
  if (parsed.domain !== check.domain) throw new Error(`Die Anmeldung ist für ${parsed.domain}, nicht für ${check.domain}.`);
  if (check.chainIds.length && !check.chainIds.includes(parsed.chainId)) throw new Error(`Netz ${parsed.chainId} wird hier nicht angenommen.`);
  const now = check.now.getTime();
  const issued = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(now - issued) > 10 * 60_000) throw new Error('Die Anmelde-Nachricht ist zu alt oder aus der Zukunft.');
  if (parsed.expirationTime && Date.parse(parsed.expirationTime) <= now) throw new Error('Die Anmelde-Nachricht ist abgelaufen.');
  if (parsed.notBefore && Date.parse(parsed.notBefore) > now) throw new Error('Die Anmelde-Nachricht gilt noch nicht.');
  const signer = recoverPersonalSigner(message, signature);
  if (!signer || signer !== parsed.address) throw new Error('Die Unterschrift passt nicht zur Adresse.');
  if (!check.consumeNonce(parsed.nonce)) throw new Error('Diese Anmelde-Nachricht wurde schon benutzt oder ist unbekannt.');
  return { address: signer, parsed };
}
