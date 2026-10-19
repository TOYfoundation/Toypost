import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';

/**
 * Minimal SMTP client (RFC 5321) for sending plain-text mail: implicit TLS (465), STARTTLS (587) or plain
 * (only for a relay on the same machine). AUTH PLAIN. Body as UTF-8 base64, non-ASCII headers as RFC 2047.
 * No dependency, so it runs in the zero-dependency API.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  user?: string;
  password?: string;
  from: string;
  fromName?: string;
  /** only for tests with a self-signed server */
  rejectUnauthorized?: boolean;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
}

class Lines {
  private buffer = '';
  private waiting: ((line: string) => void)[] = [];
  private queue: string[] = [];
  private failed: Error | null = null;
  private failWaiters: ((e: Error) => void)[] = [];

  attach(socket: Socket | TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf('\r\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 2);
        const w = this.waiting.shift();
        if (w) w(line);
        else this.queue.push(line);
      }
    });
    const fail = (e: Error) => {
      this.failed = e;
      for (const f of this.failWaiters.splice(0)) f(e);
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('Verbindung zum Mailserver wurde geschlossen.')));
  }

  next(): Promise<string> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiting.push(resolve);
      this.failWaiters.push(reject);
    });
  }

  /** Reads one reply (possibly multi-line "250-…" … "250 …") and returns code and text. */
  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.next();
      lines.push(line.slice(4));
      if (line[3] !== '-') return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
    }
  }
}

/** RFC 2047 encoded-word for headers with non-ASCII characters. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function cleanAddress(a: string): string {
  const s = a.trim();
  if (!/^[^@\s<>,;]+@[^@\s<>,;]+$/.test(s)) throw new Error(`Ungültige E-Mail-Adresse: ${s}`);
  return s;
}

export function buildMime(cfg: SmtpConfig, msg: MailMessage, now = new Date()): { data: string; messageId: string } {
  const domain = cfg.from.split('@')[1];
  const messageId = `<${randomUUID()}@${domain}>`;
  const from = cfg.fromName ? `${encodeHeader(cfg.fromName)} <${cleanAddress(cfg.from)}>` : cleanAddress(cfg.from);
  const headers = [
    `From: ${from}`,
    `To: ${cleanAddress(msg.to)}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    ...(msg.inReplyTo ? [`In-Reply-To: ${msg.inReplyTo.replace(/[\r\n]/g, '')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: ToyPost',
  ];
  const body = Buffer.from(msg.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return { data: `${headers.join('\r\n')}\r\n\r\n${body}`, messageId };
}

export async function sendMail(cfg: SmtpConfig, msg: MailMessage, timeoutMs = 20_000): Promise<{ messageId: string }> {
  const lines = new Lines();
  let socket: Socket | TLSSocket = await new Promise((resolve, reject) => {
    const opts = { host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized ?? true };
    const s = cfg.security === 'tls' ? tlsConnect(opts, () => resolve(s)) : netConnect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once('error', reject);
  });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Der Mailserver antwortet nicht.')));
  lines.attach(socket);
  const write = (line: string) => socket.write(`${line}\r\n`);
  const expect = async (codes: number[], step: string) => {
    const r = await lines.reply();
    if (!codes.includes(r.code)) throw new Error(`Mailserver lehnt ab (${step}): ${r.code} ${r.text}`);
    return r;
  };
  try {
    await expect([220], 'Begrüßung');
    const helo = 'toypost.local';
    write(`EHLO ${helo}`);
    let ehlo = await expect([250], 'EHLO');
    if (cfg.security === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('Der Mailserver bietet kein STARTTLS an.');
      write('STARTTLS');
      await expect([220], 'STARTTLS');
      socket.removeAllListeners('data');
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({ socket, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized ?? true }, () => resolve(t));
        t.once('error', reject);
      });
      lines.attach(socket);
      write(`EHLO ${helo}`);
      ehlo = await expect([250], 'EHLO nach STARTTLS');
    }
    if (cfg.user) {
      if (cfg.security === 'none' && !['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) {
        throw new Error('Passwörter werden nur verschlüsselt gesendet. Stelle "security" auf tls oder starttls.');
      }
      write(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.password ?? ''}`, 'utf8').toString('base64')}`);
      await expect([235], 'Anmeldung');
    }
    const { data, messageId } = buildMime(cfg, msg);
    write(`MAIL FROM:<${cleanAddress(cfg.from)}>`);
    await expect([250], 'Absender');
    write(`RCPT TO:<${cleanAddress(msg.to)}>`);
    await expect([250, 251], 'Empfänger');
    write('DATA');
    await expect([354], 'DATA');
    // dot-stuffing: lines starting with "." get a second dot
    socket.write(`${data.replace(/\r\n\./g, '\r\n..')}\r\n.\r\n`);
    await expect([250], 'Nachricht');
    write('QUIT');
    return { messageId };
  } finally {
    socket.end();
  }
}
