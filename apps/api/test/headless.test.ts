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
import { MockProvider } from '../src/ai/provider.ts';
import { demoLetterText } from '../src/shared.ts';

/**
 * Betrieb ohne App (z. B. auf Proxmox): Steuerung über Paperless-Tags, Ergebnisse als Nextcloud-Schreibvorgänge.
 */

const TODAY = '2026-10-19';
const tmp = mkdtempSync(join(tmpdir(), 'dokufy-headless-'));
let base = '';
let server: Server;
let ctx: ReturnType<typeof createApp>['ctx'];

// Fängt Ereignisse ab, die an n8n gehen würden
const events: any[] = [];
let n8n: Server;
let n8nUrl = '';

// Simuliert Nextcloud-WebDAV für den Direktmodus
const davRequests: { method: string; url: string; auth: string; body: string }[] = [];
let dav: Server;
let davUrl = '';

before(async () => {
  const config = loadConfig({
    DOKUFY_SECRET: 'test-secret-test-secret-test-secret-1234',
    DATABASE_PATH: ':memory:',
    FILES_PATH: join(tmp, 'files'),
    SELF_HOSTED: 'true',
  } as NodeJS.ProcessEnv);
  const app = createApp(config, { db: openDb(':memory:'), ai: new MockProvider(), now: () => new Date(`${TODAY}T10:00:00Z`), log: () => {} });
  server = app.server;
  ctx = app.ctx;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  n8n = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      events.push(JSON.parse(body));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => n8n.listen(0, '127.0.0.1', r));
  n8nUrl = `http://127.0.0.1:${(n8n.address() as AddressInfo).port}/webhook/dokufy-test`;

  dav = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      davRequests.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      res.statusCode = req.method === 'MKCOL' ? 201 : 204;
      res.end();
    });
  });
  await new Promise<void>((r) => dav.listen(0, '127.0.0.1', r));
  davUrl = `http://127.0.0.1:${(dav.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  n8n.close();
  dav.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

let token = '';
let accountId = '';
let secret = '';
let caseId = '';

test('Eigene Installation: neues Konto bekommt alle Funktionen', async () => {
  const r = await call('POST', '/v1/auth/register', { name: 'Alex', email: 'alex@haus.lan', password: 'lang-genug-123' });
  token = r.data.token;
  accountId = r.data.account.id;
  assert.equal(r.data.account.plan, 'enterprise');
  assert.equal(r.data.account.credits.total, 25000);
  secret = (await call('GET', '/v1/integrations/webhook-secret', undefined, token)).data.secret;

  assert.equal((await call('PUT', '/v1/integrations/paperless', { url: 'http://paperless:8000', token: 'x', publicUrl: 'https://paperless.dokufy.lan', skipTest: true }, token)).status, 200);
  assert.equal((await call('PUT', '/v1/integrations/nextcloud', { url: davUrl, user: 'admin', appPassword: 'app-pw', calendar: 'dokufy', folder: 'Dokufy', skipTest: true }, token)).status, 200);
  assert.equal((await call('PUT', '/v1/integrations/n8n', { eventsUrl: n8nUrl }, token)).status, 200);
});

test('Paperless-Webhook mit festem Token und ID als Text', async () => {
  const wrong = await call('POST', `/v1/hooks/paperless/${accountId}`, { documentId: '7' }, undefined, { 'x-dokufy-token': 'falsch' });
  assert.equal(wrong.status, 401);

  const r = await call(
    'POST',
    `/v1/hooks/paperless/${accountId}`,
    { documentId: '7', content: demoLetterText('strom', TODAY), title: 'Jahresabrechnung Strom', created: '2026-10-10' },
    undefined,
    { 'x-dokufy-token': secret },
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  caseId = r.data.caseId;
  await ctx.delivery.settle();

  const analyzed = events.find((e) => e.type === 'document.analyzed');
  assert.equal(analyzed.case.status, 'action');
  assert.equal(analyzed.davWrites.length, 1);
  const task = analyzed.davWrites[0];
  assert.equal(task.path, `calendars/admin/dokufy/dokufy-${caseId}-aufgabe.ics`);
  assert.match(task.content, /BEGIN:VTODO/);
  assert.match(task.content, /DUE;VALUE=DATE:20261026/);
  assert.match(task.content, /STATUS:NEEDS-ACTION/);
  assert.match(task.content, /https:\/\/paperless\.dokufy\.lan\/documents\/7\/details/);

  const deadline = events.find((e) => e.type === 'deadline.detected');
  assert.equal(deadline.davWrites[0].path, `calendars/admin/dokufy/dokufy-${caseId}-zahlung.ics`);
  assert.match(deadline.davWrites[0].content, /BEGIN:VEVENT[\s\S]*DTSTART;VALUE=DATE:20261026[\s\S]*TRIGGER:-P7D/);
});

test('Tag "dokufy-antwort": Entwurf landet als Datei in Nextcloud', async () => {
  events.length = 0;
  const r = await call('POST', `/v1/hooks/paperless/${accountId}`, { documentId: '7', action: 'draft' }, undefined, { 'x-dokufy-token': secret });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.caseId, caseId);
  await ctx.delivery.settle();
  const e = events.find((x) => x.type === 'draft.created');
  assert.ok(e.body.length > 50);
  assert.equal(e.davWrites[0].path, `files/admin/Dokufy/Entw%C3%BCrfe/${encodeURIComponent('2026-10-19 Jahresabrechnung Strom.md')}`);
  assert.match(e.davWrites[0].content, /^# /);

  const unknown = await call('POST', `/v1/hooks/paperless/${accountId}`, { documentId: '999', action: 'draft' }, undefined, { 'x-dokufy-token': secret });
  assert.equal(unknown.status, 404);
});

test('Tag "dokufy-erledigt": Aufgabe abgehakt, Termin abgesagt', async () => {
  events.length = 0;
  const r = await call('POST', `/v1/hooks/paperless/${accountId}`, { documentId: '7', action: 'done' }, undefined, { 'x-dokufy-token': secret });
  assert.equal(r.data.status, 'done');
  await ctx.delivery.settle();
  const e = events.find((x) => x.type === 'case.updated');
  const [task, cancelled] = e.davWrites;
  assert.match(task.content, /STATUS:COMPLETED/);
  assert.match(cancelled.content, /STATUS:CANCELLED/);
  assert.doesNotMatch(cancelled.content, /VALARM/);
});

test('Ohne n8n schreibt Dokufy selbst per WebDAV in Nextcloud', async () => {
  await call('DELETE', '/v1/integrations/n8n', undefined, token);
  await call(
    'POST',
    `/v1/hooks/paperless/${accountId}`,
    { documentId: '8', content: demoLetterText('kasse', TODAY), created: '2026-10-16' },
    undefined,
    { 'x-dokufy-token': secret },
  );
  await ctx.delivery.settle();
  const puts = davRequests.filter((d) => d.method === 'PUT');
  assert.ok(puts.some((d) => /\/remote\.php\/dav\/calendars\/admin\/dokufy\/dokufy-case_.*-aufgabe\.ics$/.test(d.url)));
  assert.ok(puts.some((d) => /-antwort\.ics$/.test(d.url)));
  assert.equal(puts[0].auth, 'Basic ' + Buffer.from('admin:app-pw').toString('base64'));
});
