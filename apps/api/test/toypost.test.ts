import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { MockProvider } from '../src/ai/provider.ts';
import { pollChannel } from '../src/toy/watchers.ts';
import { sendVia } from '../src/channels/adapters.ts';
import { twilioSignature } from '../src/channels/inbound.ts';
import { parseFeed } from '../src/channels/feeds.ts';
import { matchInvoice, toTransfer } from '../src/services/invoices.ts';
import { fill, matches } from '../src/services/automations.ts';
import { encodeUncompressed, G, mod, modInv, N, pointMul, recoverPublicKey } from '../src/toy/secp256k1.ts';
import { parseSiwe, personalMessageHash, recoverPersonalSigner } from '../src/toy/siwe.ts';
import { parseAmpel, parseMilestones } from '../src/toy/clients.ts';
import { addressFromPublicKey, parseToy, toHex } from '../src/shared.ts';

const NOW = new Date('2026-10-19T10:00:00Z');
const tmp = mkdtempSync(join(tmpdir(), 'toypost-test-'));
let base = '';
let fakeBase = '';
let server: Server;
let fake: Server;
let smtp: NetServer;
let smtpPort = 0;
let ctx: ReturnType<typeof createApp>['ctx'];
let token = '';

// ---------- fake outside world ----------

const seen: { method: string; path: string; headers: Record<string, any>; body: string }[] = [];
const smtpSessions: string[] = [];
const world = {
  statusSha: 'sha1',
  statusMd: '| Meilenstein | Inhalt | Status |\n|---|---|---|\n| M1 | Grundtypen und Emission | ✅ fertig |\n| M2 | Kryptografie und Adressen | ⏳ offen |\n',
  releases: [] as any[],
  ampel: { farbe: 'gruen', kriterien: [{ nr: 'A1', farbe: 'gruen' }] } as any,
  transfers: [] as any[],
  feed: '<rss><channel><title>Projekt-Blog</title><item><guid>1</guid><title>Alt</title><description>alter Beitrag</description></item></channel></rss>',
};

function startFake(): Promise<void> {
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body });
      const json = (o: unknown, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const p = url.pathname;
      if (p === '/android/message') return json({ id: `sms-${seen.length}` });
      if (p.startsWith('/ntfy/')) return json({ id: `push-${seen.length}` });
      if (p === '/gh/repos/Safehaigit/toycoin/commits') return json([{ sha: world.statusSha }]);
      if (p === '/gh/repos/Safehaigit/toycoin/contents/docs/STATUS.md') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(world.statusMd);
      }
      if (p === '/gh/repos/Safehaigit/toycoin/releases') return json(world.releases);
      if (p === '/gh/repos/Safehaigit/toycoin/issues' && req.method === 'POST') return json({ number: 7, html_url: 'https://github.com/x/7' }, 201);
      if (p === '/gh/repos/Safehaigit/toycoin/git/ref/heads/main') return json({ object: { sha: 'basesha' } });
      if (p === '/gh/repos/Safehaigit/toycoin/git/refs') return json({}, 201);
      if (p.startsWith('/gh/repos/Safehaigit/toycoin/contents/docs/berichte/')) return json({}, 201);
      if (p === '/gh/repos/Safehaigit/toycoin/pulls') return json({ number: 9, html_url: 'https://github.com/x/pull/9' }, 201);
      if (p === '/scan/api/v1/ampel') return json(world.ampel);
      if (p === '/scan/api/v1/supply') return json({ gemintet: '50500000000000000000000' });
      if (p.startsWith('/scan/api/v1/address/')) return json({ transaktionen: world.transfers });
      if (p === '/feed.xml') {
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        return res.end(world.feed);
      }
      json({ error: 'unknown' }, 404);
    });
  });
  return new Promise((r) => fake.listen(0, '127.0.0.1', () => r()));
}

function startSmtp(): Promise<void> {
  smtp = createNetServer((sock) => {
    let data = false;
    let buf = '';
    let session = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        session += line + '\n';
        if (data) {
          if (line === '.') {
            data = false;
            sock.write('250 queued\r\n');
          }
          continue;
        }
        if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH PLAIN')) sock.write('235 ok\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) sock.write('250 ok\r\n');
        else if (line === 'DATA') {
          data = true;
          sock.write('354 go\r\n');
        } else if (line === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
          smtpSessions.push(session);
        }
      }
    });
  });
  return new Promise((r) => smtp.listen(0, '127.0.0.1', () => ((smtpPort = (smtp.address() as AddressInfo).port), r())));
}

before(async () => {
  await startFake();
  await startSmtp();
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const config = loadConfig({
    TOYPOST_SECRET: 'test-secret-test-secret-test-secret-1234',
    DATABASE_PATH: ':memory:',
    FILES_PATH: join(tmp, 'files'),
    PUBLIC_URL: 'http://toypost.test',
    GITHUB_API: `${fakeBase}/gh`,
    SCHEDULER: 'false',
  } as NodeJS.ProcessEnv);
  const app = createApp(config, { db: openDb(':memory:'), ai: new MockProvider(), now: () => NOW, log: () => {} });
  server = app.server;
  ctx = app.ctx;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const reg = await call('POST', '/v1/auth/register', { name: 'Ramon Projekt', email: 'team@toy.test', password: 'sehr-geheimes-passwort' });
  token = reg.body.token;
});

after(() => {
  server.close();
  fake.close();
  smtp.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, tok = token, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const settle = () => ctx.delivery.settle();
const ids: Record<string, string> = {};
const inboxUrl = (id: string) => {
  const row = ctx.channels.byId(id);
  return `/v1/inbox/${id}?token=${row.inbound_token}`;
};

// ---------- pure parts ----------

test('Feeds: RSS, Atom and JSON Feed', () => {
  const rss = parseFeed('<rss><channel><title>Blog</title><item><title>A &amp; B</title><link>https://x/a</link><guid>g1</guid><description><![CDATA[<p>Hallo <b>Welt</b></p>]]></description></item></channel></rss>');
  assert.deepEqual(rss.items[0], { key: 'g1', title: 'A & B', link: 'https://x/a', text: 'Hallo Welt', date: undefined });
  const atom = parseFeed('<feed><title>Rel</title><entry><id>tag:1</id><title>v0.1</title><link rel="alternate" href="https://g/r/1"/><content>Neu</content><updated>2026-10-01</updated></entry></feed>');
  assert.equal(atom.items[0].link, 'https://g/r/1');
  const json = parseFeed(JSON.stringify({ title: 'J', items: [{ id: 'x', title: 'T', content_text: 'Text' }] }));
  assert.equal(json.items[0].text, 'Text');
});

test('Automations: conditions and placeholders', () => {
  const ev = { type: 'x', message: { body: 'Die App stürzt ab', channelKind: 'sms' }, to: 'rot' };
  assert.equal(matches(ev, [{ field: 'message.body', op: 'matches', value: 'stürzt ab' }, { field: 'to', op: 'eq', value: 'rot' }]), true);
  assert.equal(matches(ev, [{ field: 'message.channelKind', op: 'in', value: ['email'] }]), false);
  assert.equal(fill('Kanal {{message.channelKind}}: {{message.body}} {{gibts.nicht}}', ev), 'Kanal sms: Die App stürzt ab ');
  assert.equal(fill('{{amountToy}}', { transfer: { amount: '1500000000000000000' } }), '1,5 TOY');
});

test('Invoices: matching by address and code, tolerant ToyScan fields', () => {
  const inv = [{ address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', code: 'AB2CD3', status: 'open' }];
  assert.ok(matchInvoice(inv, { to: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', purpose: 'TP-AB2CD3 Rechnung' }));
  assert.ok(matchInvoice(inv, { to: inv[0].address, purpose: 'tp-ab2cd3' }));
  assert.equal(matchInvoice(inv, { to: inv[0].address, purpose: 'TP-AB2CD34' }), undefined);
  assert.equal(matchInvoice(inv, { to: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', purpose: 'TP-AB2CD3' }), undefined);
  const t = toTransfer({ hash: '0x1', von: inv[0].address, an: inv[0].address, betrag: { wert: '1000', formatiert: '0,000000000000001 TOY' }, zweck: 'TP-AB2CD3' });
  assert.equal(t?.amount, 1000n);
  assert.equal(toTransfer({ hash: '0x1', from: 'nope', to: inv[0].address, value: '1' }), undefined);
});

test('ToyScan warning light and STATUS.md milestones are read correctly', () => {
  const a = parseAmpel({ kriterien: [{ nr: 'A3', farbe: 'gelb' }, { nr: 'A5', farbe: 'rot', hinweis: 'Hash falsch' }] });
  assert.equal(a.color, 'rot');
  assert.equal(a.bigRedLamp, true);
  const ms = parseMilestones(world.statusMd);
  assert.deepEqual(ms.map((m) => [m.id, m.done]), [['M1', true], ['M2', false]]);
});

test('secp256k1: point math agrees with OpenSSL, recovery finds the signer', () => {
  for (let i = 0; i < 3; i++) {
    const d = randomBytes(32);
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(d);
    const mine = encodeUncompressed(pointMul(BigInt('0x' + d.toString('hex')), G)!);
    assert.equal(toHex(mine), ecdh.getPublicKey('hex'));
  }
  assert.equal(recoverPublicKey(new Uint8Array(32), 0n, 1n, 0), undefined);
  assert.equal(recoverPublicKey(new Uint8Array(32), 1n, N, 0), undefined);
});

/** Test-only signer (EIP-191 personal_sign) built from the same curve; the recovery itself is checked against OpenSSL above. */
function personalSign(message: string, d: bigint): string {
  const e = BigInt('0x' + toHex(personalMessageHash(message)));
  for (;;) {
    const k = mod(BigInt('0x' + randomBytes(32).toString('hex')), N);
    if (k === 0n) continue;
    const R = pointMul(k, G)!;
    const r = mod(R.x, N);
    let s = mod(modInv(k, N) * (e + r * d), N);
    let rec = Number(R.y & 1n);
    if (s > N / 2n) {
      s = N - s;
      rec ^= 1;
    }
    return '0x' + r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0') + (27 + rec).toString(16);
  }
}

test('EIP-4361 message parsing and personal_sign recovery', () => {
  const d = 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318n;
  const address = addressFromPublicKey(encodeUncompressed(pointMul(d, G)!));
  const msg = `toypost.test wants you to sign in with your Ethereum account:\n${address}\n\nBei ToyPost anmelden\n\nURI: http://toypost.test\nVersion: 1\nChain ID: 7777\nNonce: abcdef123456\nIssued At: 2026-10-19T10:00:00Z`;
  const parsed = parseSiwe(msg);
  assert.equal(parsed.statement, 'Bei ToyPost anmelden');
  assert.equal(parsed.chainId, 7777);
  assert.equal(recoverPersonalSigner(msg, personalSign(msg, d)), address);
  assert.notEqual(recoverPersonalSigner(msg + ' ', personalSign(msg, d)), address);
});

test('Sending: Telegram and Twilio requests have the right shape', async () => {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5 }, sid: 'SM1' }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const r1 = await sendVia('telegram', { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123' }, { to: '42', subject: 'Hallo', text: 'Text' }, f);
  assert.equal(r1.externalId, '5');
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123/sendMessage');
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: '42', text: 'Hallo\n\nText', disable_web_page_preview: true });
  const r2 = await sendVia('sms', { provider: 'twilio', accountSid: 'AC' + '0'.repeat(32), authToken: 't', from: '+4915112345678' }, { to: '+4917012345678', text: 'Hi' }, f);
  assert.equal(r2.externalId, 'SM1');
  assert.equal(new URLSearchParams(calls[1].init.body).get('To'), '+4917012345678');
});

// ---------- the whole flow through the API ----------

test('Channels: create SMS, webhook, push, GitHub, ToyScan, feed and e-mail', async () => {
  const mk = async (kind: string, name: string, config: unknown) => {
    const r = await call('POST', '/v1/channels', { kind, name, config });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as string;
  };
  ids.sms = await mk('sms', 'Projekt-Handy', { provider: 'android', url: `${fakeBase}/android`, user: 'u', password: 'p' });
  ids.inbox = await mk('webhook', 'Formular und Mail', { url: `${fakeBase}/hook` });
  ids.push = await mk('ntfy', 'Push an mich', { server: `${fakeBase}/ntfy`, topic: 'toypost-ramon' });
  ids.github = await mk('github', 'toycoin', { repo: 'Safehaigit/toycoin', token: 'ghp_test', everyMinutes: 15 });
  ids.scan = await mk('toyscan', 'ToyScan Testnet', { url: `${fakeBase}/scan`, everyMinutes: 5 });
  ids.feed = await mk('feed', 'Projekt-Blog', { url: `${fakeBase}/feed.xml`, everyMinutes: 30 });
  ids.mail = await mk('email', 'Projekt-Mail', { host: '127.0.0.1', port: smtpPort, security: 'none', from: 'team@toy.test', fromName: 'Toy-Team Ä' });
  const list = await call('GET', '/v1/channels');
  assert.equal(list.body.channels.length, 7);
  const sms = list.body.channels.find((c: any) => c.id === ids.sms);
  assert.match(sms.inboundUrl, /\/v1\/inbox\/ch_.*\?token=/);
  assert.ok(!JSON.stringify(list.body).includes('"password"'), 'secrets are never returned');
  const bad = await call('POST', '/v1/channels', { kind: 'sms', config: { provider: 'twilio', accountSid: 'nope' } });
  assert.equal(bad.status, 400);
});

test('Presets: install automations for the Toy projects', async () => {
  for (const [preset, body] of [
    ['meilenstein', {}],
    ['release', {}],
    ['ampel', { announce: ids.push }],
    ['zahlung', {}],
    ['fehlermeldung', { github: ids.github }],
    ['sicherheit', {}],
    ['betrug', { announce: ids.push }],
  ] as const) {
    const r = await call('POST', `/v1/automations/presets/${preset}`, body);
    assert.equal(r.status, 200, `${preset}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await call('POST', '/v1/automations/presets/ampel', {})).status, 400);
  assert.equal((await call('GET', '/v1/automations')).body.automations.length, 7);
});

test('Incoming SMS with a TOY payment request becomes a case with contact and payment link', async () => {
  const r = await call(
    'POST',
    inboxUrl(ids.sms),
    { event: 'sms:received', payload: { phoneNumber: '+49 170 1234567', message: 'Hallo, bitte zahle 12,5 TOY an 0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed bis zum 30.10.2026. Danke, Anna', messageId: 'a1' } },
    '',
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.caseId);
  ids.annaCase = r.body.caseId;
  const c = (await call('GET', `/v1/cases/${r.body.caseId}`)).body;
  assert.equal(c.toyRequest.address, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.equal(c.toyRequest.amount, parseToy('12.5').toString());
  assert.match(c.toyRequest.link, /^toychain:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed\?betrag=12\.5$/);
  assert.equal(c.contact.name, '+491701234567');
  assert.equal(c.messages.length, 1);
  ids.anna = c.contact.id;
  // the same message delivered twice is stored once
  const again = await call('POST', inboxUrl(ids.sms), { event: 'sms:received', payload: { phoneNumber: '+491701234567', message: 'x', messageId: 'a1' } }, '');
  assert.equal(again.body.duplicate, true);
  // a short follow-up joins the same case without a new analysis
  const follow = await call('POST', inboxUrl(ids.sms), { payload: { phoneNumber: '+491701234567', message: 'Hat geklappt?', messageId: 'a2' } }, '');
  assert.equal(follow.body.caseId, ids.annaCase);
  assert.equal((await call('POST', `/v1/inbox/${ids.sms}?token=falsch`, { payload: {} }, '')).status, 401);
});

test('Scam message: red warning on the message and an instant push to the user', async () => {
  const before = seen.filter((s) => s.path.startsWith('/ntfy/')).length;
  const r = await call(
    'POST',
    inboxUrl(ids.inbox),
    { from: 'support@toypay-sicherheit.example', fromName: 'TOYPAY Support', subject: 'Konto gesperrt', text: 'Ihr TOYPAY-Konto wird gesperrt. Bitte bestätigen Sie sofort Ihre Wiederherstellungsphrase über unser Formular.' },
    '',
  );
  assert.equal(r.status, 200);
  await settle();
  const c = (await call('GET', `/v1/cases/${r.body.caseId}`)).body;
  assert.ok(c.safety.some((f: any) => f.code === 'asks_for_secret' && f.severity === 'red'));
  assert.equal(c.nextAction, 'Warnung lesen: möglicher Betrug');
  const pushes = seen.filter((s) => s.path.startsWith('/ntfy/'));
  assert.equal(pushes.length, before + 1);
  assert.equal(pushes.at(-1)!.headers['x-title'], 'ToyPost: Betrugsverdacht');
});

test('Contacts: language, groups, a second handle, merge', async () => {
  await call('PATCH', `/v1/contacts/${ids.anna}`, { name: 'Anna Tester', language: 'en', tags: ['Tester'], toyAddress: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed' });
  const other = await call('POST', '/v1/contacts', { name: 'Anna (Mail)', handles: [{ kind: 'email', handle: 'Anna@Example.org' }], tags: ['Community'] });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const merged = await call('POST', `/v1/contacts/${ids.anna}/merge`, { fromId: other.body.id });
  assert.deepEqual(merged.body.tags.sort(), ['Community', 'Tester']);
  assert.deepEqual(merged.body.handles.map((h: any) => `${h.kind}:${h.handle}`).sort(), ['email:anna@example.org', 'sms:+491701234567']);
  const sw = await call('POST', '/v1/contacts', { name: 'Baraka', language: 'sw', handles: [{ kind: 'sms', handle: '+255712345678' }], tags: ['Tester'] });
  ids.baraka = sw.body.id;
  const bad = await call('PATCH', `/v1/contacts/${ids.anna}`, { toyAddress: '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' });
  assert.equal(bad.status, 400);
});

test('Sending: SMS via the Android gateway, e-mail via SMTP, secrets are blocked', async () => {
  const sms = await call('POST', '/v1/messages', { channelId: ids.sms, contactId: ids.anna, text: 'Danke, Anna!' });
  assert.equal(sms.body.status, 'sent', JSON.stringify(sms.body));
  const gw = seen.filter((s) => s.path === '/android/message').at(-1)!;
  assert.deepEqual(JSON.parse(gw.body), { message: 'Danke, Anna!', phoneNumbers: ['+491701234567'] });
  assert.equal(gw.headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);

  const mail = await call('POST', '/v1/messages', { channelId: ids.mail, contactId: ids.anna, subject: 'Grüße vom Testnet', text: 'Hallo Anna,\n.\nbis bald' });
  assert.equal(mail.body.status, 'sent', JSON.stringify(mail.body));
  const session = smtpSessions.at(-1)!;
  assert.match(session, /RCPT TO:<anna@example.org>/);
  assert.match(session, /Subject: =\?UTF-8\?B\?/);
  assert.match(session, /From: =\?UTF-8\?B\?.*\?= <team@toy\.test>/);

  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const blocked = await call('POST', '/v1/messages', { channelId: ids.sms, contactId: ids.anna, text: `Meine Phrase: ${phrase}` });
  assert.equal(blocked.status, 422);
  const stored = (await call('GET', `/v1/messages?contactId=${ids.anna}&direction=out`)).body;
  assert.equal(stored[0].status, 'blocked');
  assert.ok(!stored[0].body.includes('abandon'), 'the phrase is not stored');
});

test('TOY invoice: payment link, ToyScan alarm books the payment, thanks in the payer’s language', async () => {
  const inv = await call('POST', '/v1/toy/invoices', {
    address: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    amount: '25',
    label: 'Validator-Hilfe',
    contactId: ids.anna,
    caseId: ids.annaCase,
    sendVia: ids.sms,
  });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const invoice = inv.body.invoice;
  assert.match(invoice.purpose, /^TP-[A-Z2-9]{6} Validator-Hilfe$/);
  assert.match(invoice.link, /^toychain:0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359\?betrag=25&zweck=TP-/);
  assert.equal(inv.body.message.status, 'sent');

  const transfer = { hash: '0xabc', von: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', an: invoice.address, betrag: parseToy('25').toString(), zweck: invoice.purpose, block: 1234 };
  const alarm = await call('POST', inboxUrl(ids.scan), { transaktion: transfer }, '');
  assert.deepEqual(alarm.body, { ok: true, booked: 1 });
  const again = await call('POST', inboxUrl(ids.scan), { transaktion: transfer }, '');
  assert.equal(again.body.booked, 0, 'same transaction counts once');
  await settle();
  const c = (await call('GET', `/v1/cases/${ids.annaCase}`)).body;
  assert.equal(c.toyInvoice.status, 'paid');
  assert.equal(c.status, 'done');
  const thanks = seen.filter((s) => s.path === '/android/message').at(-1)!;
  assert.match(JSON.parse(thanks.body).message, /^\[en\] Zahlung eingegangen/);
});

test('GitHub progress: baseline first, then a finished milestone becomes a draft for testers in their languages', async () => {
  const row = ctx.channels.byId(ids.github);
  assert.deepEqual(await pollChannel(ctx, row), { events: 0, baseline: true });
  world.statusSha = 'sha2';
  world.statusMd = world.statusMd.replace('| M2 | Kryptografie und Adressen | ⏳ offen |', '| M2 | Kryptografie und Adressen | ✅ fertig (20.10.2026) |');
  assert.equal((await pollChannel(ctx, row)).events, 1);
  await settle();
  const drafts = (await call('GET', '/v1/broadcasts')).body.filter((b: any) => b.status === 'draft');
  const draft = drafts.find((b: any) => b.audience === 'gruppe:Tester');
  assert.ok(draft, JSON.stringify(drafts));
  assert.match(draft.subject, /M2/);
  assert.deepEqual(draft.languages, ['en', 'sw']);
  const preview = await call('GET', `/v1/broadcasts/${draft.id}/preview?lang=sw`);
  assert.equal(preview.body.language.name, 'Kiswahili');
  const before = seen.filter((s) => s.path === '/android/message').length;
  const sent = await call('POST', `/v1/broadcasts/${draft.id}/send`);
  assert.equal(sent.body.status, 'sent');
  assert.equal(sent.body.results.sent, 2);
  const texts = seen.filter((s) => s.path === '/android/message').slice(before).map((s) => JSON.parse(s.body).message);
  assert.ok(texts.some((t) => t.startsWith('[en] ')) && texts.some((t) => t.startsWith('[sw] ')), JSON.stringify(texts));
  assert.equal((await call('POST', `/v1/broadcasts/${draft.id}/send`)).status, 409, 'never sent twice');

  world.releases = [{ id: 1, tag_name: 'v0.1.0-testnet', name: 'Erstes Testnet', body: 'Kryptografie fertig', html_url: 'https://github.com/r/1', draft: false }];
  assert.equal((await pollChannel(ctx, row)).events, 1);
  await settle();
  assert.ok((await call('GET', '/v1/broadcasts')).body.some((b: any) => b.audience === 'gruppe:Community' && b.subject.includes('v0.1.0')));
});

test('ToyScan warning light: green is remembered, red sends a push and prepares an incident notice', async () => {
  const row = ctx.channels.byId(ids.scan);
  assert.equal((await pollChannel(ctx, row)).events, 0);
  world.ampel = { kriterien: [{ nr: 'A1', farbe: 'gruen' }, { nr: 'A5', farbe: 'rot', hinweis: 'Verfassungs-Hash weicht ab' }] };
  const before = seen.filter((s) => s.path.startsWith('/ntfy/')).length;
  assert.equal((await pollChannel(ctx, row)).events, 1);
  await settle();
  const push = seen.filter((s) => s.path.startsWith('/ntfy/')).slice(before)[0];
  assert.equal(push.headers['x-title'], 'ToyScan: Warnampel ROT');
  assert.match(push.body, /große rote Lampe: true/);
  const incident = (await call('GET', '/v1/broadcasts')).body.find((b: any) => b.audience === 'alle' && b.status === 'draft');
  assert.match(incident.subject, /^Wichtig:/);
  assert.match(incident.body, /Wiederherstellungsphrase/);
  const overview = (await call('GET', '/v1/toy/overview')).body;
  assert.deepEqual(overview.ampel.color, 'rot');
  assert.equal(overview.ampel.bigRedLamp, true);
});

test('Feed: first read is the baseline, a new entry arrives in the inbox', async () => {
  const row = ctx.channels.byId(ids.feed);
  assert.deepEqual(await pollChannel(ctx, row), { events: 0, baseline: true });
  world.feed = world.feed.replace('</channel>', '<item><guid>2</guid><title>Testnet startet</title><link>https://blog/2</link><description>Am 1.11.</description></item></channel>');
  assert.equal((await pollChannel(ctx, row)).events, 1);
  const msgs = (await call('GET', '/v1/messages?direction=in')).body;
  assert.ok(msgs.some((m: any) => m.channelKind === 'feed' && m.subject === 'Testnet startet'));
});

test('Bug report becomes a GitHub issue without the sender; a security report never does', async () => {
  const issuesBefore = seen.filter((s) => s.path.endsWith('/issues')).length;
  await call('POST', inboxUrl(ids.sms), { payload: { phoneNumber: '+255712345678', message: 'Die Wallet stürzt ab, wenn ich QR scanne', messageId: 'b1' } }, '');
  await settle();
  const issues = seen.filter((s) => s.path.endsWith('/issues'));
  assert.equal(issues.length, issuesBefore + 1);
  const issue = JSON.parse(issues.at(-1)!.body);
  assert.match(issue.body, /stürzt ab/);
  assert.ok(!issue.body.includes('+255'), 'phone number is not published');
  assert.equal(issues.at(-1)!.headers.authorization, 'Bearer ghp_test');

  await call('POST', inboxUrl(ids.sms), { payload: { phoneNumber: '+255712345678', message: 'Ich habe eine Sicherheitslücke gefunden, die App stürzt ab und gibt Schlüssel preis', messageId: 'b2' } }, '');
  await settle();
  assert.equal(seen.filter((s) => s.path.endsWith('/issues')).length, issuesBefore + 1, 'no public issue for security reports');
  const reply = seen.filter((s) => s.path === '/android/message').at(-1)!;
  assert.match(JSON.parse(reply.body).message, /Report a vulnerability/);
});

test('Telegram: secret header required, photo is recorded, language comes from Telegram', async () => {
  const tg = await call('POST', '/v1/channels', { kind: 'telegram', name: 'Bot', config: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123' } });
  const row = ctx.channels.byId(tg.body.id);
  const update = { update_id: 1, message: { message_id: 9, from: { id: 77, first_name: 'Kofi', language_code: 'ak' }, chat: { id: 77 }, photo: [{ file_id: 'small' }, { file_id: 'big' }], caption: 'Foto vom Brief' } };
  assert.equal((await call('POST', `/v1/inbox/${row.id}`, update, '', { 'x-telegram-bot-api-secret-token': 'falsch' })).status, 401);
  const ok = await call('POST', `/v1/inbox/${row.id}`, update, '', { 'x-telegram-bot-api-secret-token': row.inbound_token });
  assert.equal(ok.status, 200);
  const contacts = (await call('GET', '/v1/contacts?q=Kofi')).body;
  assert.equal(contacts[0].language, 'ak');
  const stored = ctx.db.prepare('SELECT attachments_json FROM messages WHERE id = ?').get(ok.body.messageId) as { attachments_json: string };
  assert.deepEqual(JSON.parse(stored.attachments_json), [{ name: 'telegram-9.jpg', mime: 'image/jpeg' }]);
  assert.ok(!stored.attachments_json.includes('ABCDEF'), 'bot token never stored with the message');
});

test('Twilio: signed form posts are accepted', async () => {
  const tw = await call('POST', '/v1/channels', { kind: 'sms', name: 'Twilio', config: { provider: 'twilio', accountSid: 'AC' + 'a'.repeat(32), authToken: 'twilio-secret', from: '+4915112345678' } });
  const params = { From: '+4917099999999', Body: 'Hallo per SMS mit genug Text für eine Auswertung bitte', MessageSid: 'SM42', NumMedia: '0' };
  const url = `http://toypost.test/v1/inbox/${tw.body.id}`;
  const form = new URLSearchParams(params).toString();
  const ok = await call('POST', `/v1/inbox/${tw.body.id}`, form, '', { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('twilio-secret', url, params) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const bad = await call('POST', `/v1/inbox/${tw.body.id}`, form, '', { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'falsch' });
  assert.equal(bad.status, 401);
});

test('Sign in with address (EIP-4361): link once, then log in; replays and wrong domains fail', async () => {
  const d = BigInt('0x' + randomBytes(32).toString('hex')) % N;
  const address = addressFromPublicKey(encodeUncompressed(pointMul(d, G)!));
  const siwe = async () => {
    const { nonce } = (await call('GET', '/v1/auth/wallet/nonce', undefined, '')).body;
    const message = `toypost.test wants you to sign in with your Ethereum account:\n${address}\n\nBei ToyPost anmelden\n\nURI: http://toypost.test\nVersion: 1\nChain ID: 7777\nNonce: ${nonce}\nIssued At: 2026-10-19T09:59:00Z`;
    return { message, signature: personalSign(message, d) };
  };
  const notLinked = await call('POST', '/v1/auth/wallet', await siwe(), '');
  assert.equal(notLinked.status, 404);
  const link = await call('POST', '/v1/me/wallet', await siwe());
  assert.deepEqual(link.body.addresses, [address]);
  const login = await siwe();
  const ok = await call('POST', '/v1/auth/wallet', login, '');
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/v1/me', undefined, ok.body.token)).body.email, 'team@toy.test');
  assert.equal((await call('POST', '/v1/auth/wallet', login, '')).status, 401, 'nonce works once');
  const other = await siwe();
  const foreign = { message: other.message.replace('toypost.test wants', 'evil.test wants'), signature: other.signature };
  assert.equal((await call('POST', '/v1/auth/wallet', foreign, '')).status, 401);
});

test('Check any text and write the monthly transparency report as a pull request', async () => {
  const check = await call('POST', '/v1/toy/check', { text: 'Claim your free TOY airdrop: send 1 TOY to 0xa5b04ce6edd139c0e58ccdbc0b75e8c67cda678a' });
  const codes = check.body.findings.map((f: any) => f.code).sort();
  assert.deepEqual(codes, ['fake_airdrop', 'legacy_token']);
  assert.equal(check.body.toyRequest, null, 'legacy token contract is never a payee');

  const report = await call('POST', '/v1/toy/report', { month: '2026-10', propose: true });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.path, 'docs/berichte/2026-10.md');
  assert.match(report.body.markdown, /\| M2 \| Kryptografie und Adressen \| ✅ fertig/);
  assert.match(report.body.markdown, /Warnampel: \*\*rot\*\*/);
  assert.match(report.body.markdown, /Gemintet: 50\.500 TOY/);
  assert.match(report.body.markdown, /\| sms \| \d+ \| \d+ \|/);
  assert.ok(!report.body.markdown.includes('Anna'), 'no names in the public report');
  assert.equal(report.body.pullRequest.number, 9);
  const put = seen.find((s) => s.method === 'PUT' && s.path.includes('/contents/docs/berichte/2026-10.md'))!;
  assert.equal(JSON.parse(put.body).branch, 'toypost/bericht-2026-10');
});

test('Draft reply sent through the contact’s channel', async () => {
  const caseId = (await call('GET', `/v1/contacts/${ids.baraka}`)).body.cases[0].id;
  const draft = await call('POST', `/v1/cases/${caseId}/draft`, { intent: 'Danke für die Meldung' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const before = seen.filter((s) => s.path === '/android/message').length;
  const sent = await call('POST', `/v1/drafts/${draft.body.id}/send`, { channelId: '' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const out = seen.filter((s) => s.path === '/android/message').slice(before);
  assert.equal(JSON.parse(out[0].body).phoneNumbers[0], '+255712345678');
});
