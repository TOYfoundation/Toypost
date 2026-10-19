import { keccak256, toHex } from './keccak.ts';

/**
 * ToyChain uses Ethereum addresses (spec v0.3, section 10): 20 bytes, shown as 0x + 40 hex characters.
 * Mixed-case addresses carry the EIP-55 checksum; a wrong checksum is a typo or a manipulated address.
 */

export type AddressCheck =
  | { ok: true; address: string; checksummed: boolean }
  | { ok: false; reason: 'format' | 'checksum' };

/** EIP-55 checksum form of an address. */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error('Keine gültige Adresse.');
  const hash = toHex(keccak256(lower));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/**
 * Checks an address. All-lowercase or all-uppercase addresses have no checksum and are accepted;
 * mixed case must match EIP-55 exactly.
 */
export function checkAddress(input: string): AddressCheck {
  const s = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, reason: 'format' };
  const body = s.slice(2);
  const checksummed = body !== body.toLowerCase() && body !== body.toUpperCase();
  const canonical = toChecksumAddress(s);
  if (checksummed && canonical !== s) return { ok: false, reason: 'checksum' };
  return { ok: true, address: canonical, checksummed };
}

export function isAddress(input: string): boolean {
  return checkAddress(input).ok;
}

/** All valid addresses in a text, in EIP-55 form, without duplicates. */
export function findAddresses(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) {
    const c = checkAddress(m[0]);
    if (c.ok) found.add(c.address);
  }
  return [...found];
}

/**
 * Address trap warning (TOYPAY wallet concept, section 7a): an address that shares the first and last
 * four hex characters with a known address, but is a different address, is a typical poisoning attack.
 */
export function lookalikeOf(address: string, known: readonly string[]): string | undefined {
  const a = address.toLowerCase();
  return known.find((k) => {
    const b = k.toLowerCase();
    return a !== b && a.slice(2, 6) === b.slice(2, 6) && a.slice(-4) === b.slice(-4);
  });
}

/** Short display form: 0x1234…abcd */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Address of an uncompressed secp256k1 public key (65 bytes, 0x04 || X || Y): last 20 bytes of Keccak-256(X || Y). */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('Erwartet einen unkomprimierten öffentlichen Schlüssel (65 Byte).');
  return toChecksumAddress('0x' + toHex(keccak256(publicKey.slice(1))).slice(24));
}
