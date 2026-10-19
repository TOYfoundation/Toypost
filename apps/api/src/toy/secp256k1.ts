/**
 * secp256k1 public-key recovery for verifying wallet signatures ("Anmelden mit Adresse", EIP-4361 / EIP-191).
 *
 * Only public data is processed (message hash, signature, curve points); no private key ever exists on the
 * server, so constant-time arithmetic is not required. Straightforward affine arithmetic from SEC 1 v2,
 * section 4.1.6 (public key recovery). Verified in tests against signatures created by Node's OpenSSL.
 * To be replaced by an audited library (e.g. @noble/curves) once a package registry is available in the build.
 */

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const G: Point = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

export interface Point {
  x: bigint;
  y: bigint;
}

export function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

export function modInv(a: bigint, m: bigint): bigint {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('Kein Inverses.');
  return mod(oldS, m);
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

export function pointAdd(a: Point | null, b: Point | null): Point | null {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y, P) === 0n) return null;
    return pointDouble(a);
  }
  const l = mod((b.y - a.y) * modInv(b.x - a.x, P), P);
  const x = mod(l * l - a.x - b.x, P);
  return { x, y: mod(l * (a.x - x) - a.y, P) };
}

export function pointDouble(a: Point | null): Point | null {
  if (!a || a.y === 0n) return null;
  const l = mod(3n * a.x * a.x * modInv(2n * a.y, P), P);
  const x = mod(l * l - 2n * a.x, P);
  return { x, y: mod(l * (a.x - x) - a.y, P) };
}

export function pointMul(k: bigint, pt: Point | null): Point | null {
  let result: Point | null = null;
  let addend = pt;
  let e = mod(k, N);
  while (e > 0n) {
    if (e & 1n) result = pointAdd(result, addend);
    addend = pointDouble(addend);
    e >>= 1n;
  }
  return result;
}

export function isOnCurve(pt: Point): boolean {
  return mod(pt.y * pt.y - (pt.x * pt.x * pt.x + 7n), P) === 0n;
}

export function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function bigIntTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function encodeUncompressed(pt: Point): Uint8Array {
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(bigIntTo32(pt.x), 1);
  out.set(bigIntTo32(pt.y), 33);
  return out;
}

/**
 * Recovers the public key from a 32-byte message hash and (r, s, recovery id 0/1).
 * Returns undefined for any invalid input instead of throwing.
 */
export function recoverPublicKey(hash: Uint8Array, r: bigint, s: bigint, recId: number): Uint8Array | undefined {
  if (hash.length !== 32 || recId < 0 || recId > 1) return undefined;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return undefined;
  const x = r; // recovery ids 2 and 3 (x = r + n) practically never occur and are not accepted
  const ySquared = mod(x * x * x + 7n, P);
  let y = modPow(ySquared, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== ySquared) return undefined;
  if (Number(y & 1n) !== recId) y = P - y;
  const R: Point = { x, y };
  const e = mod(bytesToBigInt(hash), N);
  const rInv = modInv(r, N);
  const u1 = mod(-e * rInv, N);
  const u2 = mod(s * rInv, N);
  const Q = pointAdd(pointMul(u1, G), pointMul(u2, R));
  if (!Q || !isOnCurve(Q)) return undefined;
  return encodeUncompressed(Q);
}
