import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

/** Kurze, URL-taugliche IDs mit Präfix, z. B. "case_3f9a…" */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

// ---------- Passwörter (scrypt) ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

// ---------- Signierte Zugangstokens ----------

export interface TokenPayload {
  sub: string; // user id
  acc: string; // account id
  exp: number; // Unix-Sekunden
}

export class Keys {
  readonly signKey: Buffer;
  readonly encKey: Buffer;

  constructor(secret: string) {
    this.signKey = scryptSync(secret, 'toypost-sign', 32);
    this.encKey = scryptSync(secret, 'toypost-enc', 32);
  }

  sign(payload: TokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.signKey).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  verify(token: string): TokenPayload | null {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', this.signKey).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  }

  /** AES-256-GCM für Zugangsdaten zu Paperless, Nextcloud und n8n. */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  }

  decrypt(enc: string): string {
    const [v, iv, tag, data] = enc.split('.');
    if (v !== 'v1') throw new Error('Unbekanntes Verschlüsselungsformat');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** HMAC-SHA256-Signatur für eingehende Webhooks (n8n → ToyPost). */
export function webhookSignature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
