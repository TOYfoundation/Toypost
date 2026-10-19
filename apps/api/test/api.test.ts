import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { webhookSignature } from '../src/security.ts';
import { MockProvider, type AnalyzeInput } from '../src/ai/provider.ts';
import { demoLetterText } from '../src/shared.ts';

const TODAY = '2026-10-19';
const tmp = mkdtempSync(join(tmpdir(), 'dokufy-test-'));
let base = '';
let server: Server;
let ctx: ReturnType<typeof createApp>['ctx'];
let failNextAi = false;
const aiCalls: AnalyzeInput[] = [];

class TestAi extends MockProvider {
  async analyze(input: AnalyzeInput) {
    aiCalls.push(input);
    if (failNextAi) {
      failNextAi = false;
      throw new Error('simulierter Ausfall');
    }
    return super.analyze(input);
  }
}

before(async () => {
  const config = loadConfig({
    DOKUFY_SECRET: 'test-secret-test-secret-test-secret-1234',
    DATABASE_PATH: ':memory:',
    FILES_PATH: join(tmp, 'files'),
    PUBLIC_URL: 'http://127.0.0.1:0',
  } as NodeJS.ProcessEnv);
  const app = createApp(config, { db: openDb(':memory:'), ai: new TestAi(), now: () => new Date(`${TODAY}T10:00:00Z`), log: () => {} });
  server = app.server;
  ctx = app.ctx;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (ctx.config as { publicUrl: string }).publicUrl = base;
  (ctx.payments as unknown as { publicUrl: string }).publicUrl = base;
});

after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

let token = '';
let accountId = '';

test('Registrierung startet im Free-Tarif mit 30 Credits', async () => {
  const r = await call('POST', '/v1/auth/register', { name: 'Alex Test', email: 'alex@example.de', password: 'sehr-geheim-123' });
  assert.equal(r.status, 200);
  token = r.data.token;
  accountId = r.data.account.id;
  assert.equal(r.data.account.plan, 'free');
  assert.equal(r.data.account.credits.total, 30);
  const dup = await call('POST', '/v1/auth/register', { name: 'Alex', email: 'ALEX@example.de', password: 'sehr-geheim-123' });
  assert.equal(dup.status, 409);
  const wrong = await call('POST', '/v1/auth/login', { email: 'alex@example.de', password: 'falsch-falsch' });
  assert.equal(wrong.status, 401);
  assert.equal((await call('GET', '/v1/me')).status, 401);
});

let stromCase = '';
let stromDoc = '';

test('Rechnung wird ausgewertet: Vorgang, Frist, Zahlung, 1 Credit', async () => {
  const r = await call('POST', '/v1/documents', { text: demoLetterText('strom', TODAY), letterDate: '2026-10-10', channel: 'upload' }, token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.createdCase, true);
  assert.equal(r.data.creditsSpent, 1);
  assert.equal(r.data.case.status, 'action');
  assert.equal(r.data.case.deadline.date, '2026-10-26');
  assert.equal(r.data.case.payment.amountCents, 18640);
  assert.equal(r.data.credits.total, 29);
  stromCase = r.data.caseId;
  stromDoc = r.data.documentId;

  const today = await call('GET', '/v1/today', undefined, token);
  assert.equal(today.data.action[0].id, stromCase);

  const giro = await call('GET', `/v1/cases/${stromCase}/girocode`, undefined, token);
  assert.match(giro.data.payload, /^BCD\n002\n1\nSCT\n\nWeserstrom GmbH\nDE89370400440532013000\nEUR186\.40/);
});

test('Folgebrief mit gleicher Kundennummer landet im selben Vorgang', async () => {
  const text = `Weserstrom GmbH\nKundennummer: 4711-0815\nZahlungserinnerung: Bitte überweisen Sie den Rechnungsbetrag: 186,40 € bis zum 02.11.2026.`;
  const r = await call('POST', '/v1/documents', { text, letterDate: '2026-10-19' }, token);
  assert.equal(r.data.caseId, stromCase);
  assert.equal(r.data.createdCase, false);
  const detail = await call('GET', `/v1/cases/${stromCase}`, undefined, token);
  assert.equal(detail.data.documents.length, 2);
  assert.ok(detail.data.timeline.length >= 2);
});

test('Korrektur erzeugt eine Regel; der nächste gleiche Brief kostet keine Credits', async () => {
  const fix = await call('POST', `/v1/documents/${stromDoc}/correct`, { correspondent: 'Weserstrom', kind: 'rechnung' }, token);
  assert.equal(fix.data.ruleCreated, true);
  const callsBefore = aiCalls.length;
  const r = await call('POST', '/v1/documents', { text: demoLetterText('strom', TODAY), letterDate: '2026-10-19' }, token);
  assert.equal(r.data.matchedRule, true);
  assert.equal(r.data.creditsSpent, 0);
  assert.equal(r.data.caseId, stromCase);
  assert.equal(aiCalls.length, callsBefore, 'KI darf bei Regel-Treffer nicht laufen');
});

test('KI-Ausfall: Credits werden erstattet, Regel-Ergebnis übernommen', async () => {
  const before = (await call('GET', '/v1/me', undefined, token)).data.credits.total;
  failNextAi = true;
  const r = await call('POST', '/v1/documents', { text: demoLetterText('kasse', TODAY), letterDate: '2026-10-16' }, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.creditsSpent, 0);
  assert.equal(r.data.case.deadline.kind, 'antwort');
  const after = (await call('GET', '/v1/me', undefined, token)).data.credits.total;
  assert.equal(after, before);
});

test('Funktionen nach Tarif: E-Mail-Eingang erst ab Pro', async () => {
  const r = await call('POST', '/v1/documents', { text: demoLetterText('handy', TODAY), channel: 'mail' }, token);
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'plan_required');
  assert.equal(r.data.error.details.plan, 'pro');
});

test('Antwortentwurf kostet 5 Credits; Versand setzt Wiedervorlage', async () => {
  const before = (await call('GET', '/v1/me', undefined, token)).data.credits.total;
  const d = await call('POST', `/v1/cases/${stromCase}/draft`, { intent: 'Ratenzahlung in 3 Raten anfragen', tone: 'freundlich' }, token);
  assert.equal(d.status, 200);
  assert.equal(d.data.creditsSpent, 5);
  assert.match(d.data.body, /Ratenzahlung/);
  const after = (await call('GET', '/v1/me', undefined, token)).data.credits.total;
  assert.equal(before - after, 5);
  const sent = await call('POST', `/v1/drafts/${d.data.id}/send`, {}, token);
  assert.equal(sent.data.status, 'waiting');
  assert.equal(sent.data.followUpOn, '2026-11-02');
});

test('Leeres Guthaben: 402 mit fehlendem Betrag, nichts wird abgebucht', async () => {
  // Restguthaben verbrauchen
  let r;
  do {
    r = await call('POST', `/v1/cases/${stromCase}/draft`, {}, token);
  } while (r.status === 200);
  assert.equal(r.status, 402);
  assert.equal(r.data.error.code, 'credits_exhausted');
  assert.ok(r.data.error.details.shortfall > 0);
});

test('Credit-Paket kaufen (Dev-Zahlung) ist idempotent', async () => {
  const before = (await call('GET', '/v1/billing/credits', undefined, token)).data.balance.total;
  const co = await call('POST', '/v1/billing/checkout', { type: 'credits', pack: 'S' }, token);
  assert.equal(co.status, 200);
  assert.equal(co.data.amountCents, 500);
  const pay1 = await fetch(co.data.url).then((x) => x.json() as Promise<any>);
  assert.equal(pay1.fulfilled, true);
  const pay2 = await fetch(co.data.url).then((x) => x.json() as Promise<any>);
  assert.equal(pay2.fulfilled, false);
  const after = await call('GET', '/v1/billing/credits', undefined, token);
  assert.equal(after.data.balance.total - before, 500);
  assert.equal(after.data.ledger[0].label, 'Credit-Paket gekauft');
});

test('Upgrade auf Team: Kontingent wird sofort angehoben, n8n erhält signierte Ereignisse', async () => {
  const co = await call('POST', '/v1/billing/checkout', { type: 'plan', plan: 'team', interval: 'year', seats: 3 }, token);
  assert.equal(co.data.amountCents, 8900 * 3);
  await fetch(co.data.url);
  const me = await call('GET', '/v1/me', undefined, token);
  assert.equal(me.data.plan, 'team');
  assert.equal(me.data.credits.monthlyGrant, 1800);
  assert.ok(me.data.credits.plan >= 1770);

  const received: { sig: string; body: string }[] = [];
  const hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ sig: String(req.headers['x-dokufy-signature']), body });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/webhook/dokufy`;
  const put = await call('PUT', '/v1/integrations/n8n', { eventsUrl: hookUrl }, token);
  assert.equal(put.data.n8n.connected, true);

  await call('POST', '/v1/documents', { text: demoLetterText('steuer', TODAY), letterDate: '2026-10-14' }, token);
  await ctx.delivery.settle();
  hook.close();
  const types = received.map((x) => JSON.parse(x.body).type);
  assert.deepEqual(types.sort(), ['deadline.detected', 'document.analyzed']);
  const secret = (await call('GET', '/v1/integrations/webhook-secret', undefined, token)).data.secret;
  for (const x of received) assert.equal(x.sig, webhookSignature(secret, x.body));
});

test('Paperless-Webhook: Signatur, Verarbeitung, Duplikat', async () => {
  const secret = (await call('GET', '/v1/integrations/webhook-secret', undefined, token)).data.secret;
  const body = JSON.stringify({ documentId: 42, content: demoLetterText('handy', TODAY), title: 'Vertrag', created: '2026-10-07' });
  const bad = await call('POST', `/v1/hooks/paperless/${accountId}`, body, undefined, { 'x-dokufy-signature': 'falsch' });
  assert.equal(bad.status, 401);
  const ok = await call('POST', `/v1/hooks/paperless/${accountId}`, body, undefined, { 'x-dokufy-signature': webhookSignature(secret, body) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.caseId);
  const again = await call('POST', `/v1/hooks/paperless/${accountId}`, body, undefined, { 'x-dokufy-signature': webhookSignature(secret, body) });
  assert.equal(again.data.duplicate, true);
});

test('Suche, Frage ans Archiv, Speicherlimit', async () => {
  const s = await call('GET', '/v1/search?q=Weserstrom', undefined, token);
  assert.ok(s.data.cases.length >= 1);
  assert.ok(s.data.documents.length >= 1);
  const ask = await call('POST', '/v1/ask', { question: 'Wann endet mein Vertrag bei Nordnetz?' }, token);
  assert.equal(ask.status, 200);
  assert.equal(ask.data.creditsSpent, 3);
  assert.equal(ask.data.sources.length, 1);

  ctx.db.prepare('UPDATE accounts SET storage_used_bytes = ? WHERE id = ?').run(3 * 50 * 1024 ** 3, accountId);
  const full = await call('POST', '/v1/documents', { text: demoLetterText('kasse', TODAY) }, token);
  assert.equal(full.status, 413);
  assert.equal(full.data.error.code, 'storage_full');
  const stillReadable = await call('GET', '/v1/cases', undefined, token);
  assert.equal(stillReadable.status, 200);
});

test('Katalog zeigt vier Tarife und drei Pakete', async () => {
  const c = await call('GET', '/v1/billing/catalog');
  assert.deepEqual(
    c.data.plans.map((p: any) => p.id),
    ['free', 'pro', 'team', 'enterprise'],
  );
  assert.equal(c.data.creditPacks.length, 3);
  assert.equal(c.data.creditCosts.find((x: any) => x.action === 'importDoc').credits, 0.5);
});
