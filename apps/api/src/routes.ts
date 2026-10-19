import type { Context } from './context.ts';
import { nowIso, tx } from './db.ts';
import {
  HttpError,
  isoDateOrUndefined,
  oneOf,
  optionalInt,
  RateLimiter,
  requireString,
  Router,
  type Request,
} from './http.ts';
import { newId, safeEqual, verifyPassword, webhookSignature } from './security.ts';
import { createAccountWithOwner, getAccountRow, getUserRow, toAccountDto, type AccountRow, type UserRow } from './services/accounts.ts';
import { addPurchasedCredits, getBalance, ledger, spendCredits, refundCredits } from './services/credits.ts';
import { addTimeline, getCaseDetail, getCaseRow, getCaseSummary, listCases, todayView, updateCase, docToSummary } from './services/cases.ts';
import { correctDocument, ingestDocument } from './services/pipeline.ts';
import { INTEGRATION_KINDS, validateIntegration, type IntegrationKind } from './integrations/store.ts';
import { PaperlessClient } from './integrations/paperless.ts';
import { NextcloudClient } from './integrations/nextcloud.ts';
import type { DevPaymentProvider } from './billing/provider.ts';
import {
  buildGiroCodePayload,
  CREDIT_ACTION_LABEL,
  CREDIT_COST_UNITS,
  CREDIT_PACKS,
  FEATURE_LABEL,
  hasFeature,
  PLAN_ORDER,
  PLANS,
  priceFor,
  SUPPORT_LABEL,
  toCredits,
  todayIso,
  type CaseStatus,
  type DocumentKind,
  type FeatureKey,
  type PlanId,
} from './shared.ts';

const CASE_STATUSES: CaseStatus[] = ['action', 'waiting', 'info', 'done'];
const DOC_KINDS: DocumentKind[] = ['rechnung', 'mahnung', 'bescheid', 'vertrag', 'kuendigung', 'kontoauszug', 'information', 'sonstiges'];
const TOKEN_DAYS = 30;

interface Authed {
  account: AccountRow;
  user: UserRow;
}

export function buildRouter(ctx: Context): Router {
  const r = new Router();
  const authLimiter = new RateLimiter(10, 60_000);
  const { db } = ctx;

  const auth = (req: Request): Authed => {
    const header = String(req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = token ? ctx.keys.verify(token) : null;
    if (!payload) throw new HttpError(401, 'unauthorized', 'Bitte melde dich an.');
    const user = getUserRow(db, payload.sub);
    if (user.account_id !== payload.acc) throw new HttpError(401, 'unauthorized', 'Bitte melde dich erneut an.');
    return { user, account: getAccountRow(db, user.account_id) };
  };

  const requireFeature = (a: Authed, feature: FeatureKey) => {
    if (!hasFeature(a.account.plan, feature)) {
      const needed = PLAN_ORDER.find((p) => hasFeature(p, feature))!;
      throw new HttpError(403, 'plan_required', `„${FEATURE_LABEL[feature]}“ gibt es ab dem Tarif ${PLANS[needed].name}.`, { plan: needed });
    }
  };

  const requireAdmin = (a: Authed) => {
    if (a.user.role === 'member') throw new HttpError(403, 'forbidden', 'Das dürfen nur Inhaber und Admins des Kontos.');
  };

  const issueToken = (user: { id: string; account_id: string }) =>
    ctx.keys.sign({ sub: user.id, acc: user.account_id, exp: Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86_400 });

  // ---------- System ----------

  r.get('/v1/health', () => ({ ok: true, ai: ctx.ai.name, payments: ctx.payments.id, time: nowIso() }));

  // ---------- Konto ----------

  r.post('/v1/auth/register', (req) => {
    authLimiter.check(`register:${req.ip}`);
    const name = requireString(req.body, 'name', { min: 2, max: 80 });
    const email = requireString(req.body, 'email', { max: 200 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid_input', 'Die E-Mail-Adresse sieht nicht gültig aus.');
    const password = requireString(req.body, 'password', { min: 10, max: 200 });
    const accountName = requireString(req.body, 'accountName', { optional: true, max: 80 });
    const { userId } = createAccountWithOwner(db, { name, email, password, accountName, plan: ctx.config.selfHosted ? 'enterprise' : 'free' });
    const user = getUserRow(db, userId);
    return { token: issueToken(user), account: toAccountDto(db, getAccountRow(db, user.account_id), user, ctx.now()) };
  });

  r.post('/v1/auth/login', (req) => {
    authLimiter.check(`login:${req.ip}`);
    const email = requireString(req.body, 'email').toLowerCase();
    const password = requireString(req.body, 'password');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'invalid_login', 'E-Mail oder Passwort stimmen nicht.');
    }
    return { token: issueToken(user), account: toAccountDto(db, getAccountRow(db, user.account_id), user, ctx.now()) };
  });

  r.get('/v1/me', (req) => {
    const a = auth(req);
    return toAccountDto(db, a.account, a.user, ctx.now());
  });

  r.get('/v1/team', (req) => {
    const a = auth(req);
    return db.prepare('SELECT id, name, email, role FROM users WHERE account_id = ? ORDER BY created_at').all(a.account.id);
  });

  // ---------- Heute und Vorgänge ----------

  r.get('/v1/today', (req) => {
    const a = auth(req);
    return todayView(db, a.account.id, todayIso(ctx.now()));
  });

  r.get('/v1/cases', (req) => {
    const a = auth(req);
    const status = req.query.get('status');
    return listCases(db, a.account.id, {
      status: status ? oneOf(status, CASE_STATUSES, 'status') : undefined,
      q: req.query.get('q') ?? undefined,
    });
  });

  r.get('/v1/cases/:id', (req) => {
    const a = auth(req);
    return getCaseDetail(db, a.account.id, req.params.id);
  });

  r.patch('/v1/cases/:id', (req) => {
    const a = auth(req);
    const b = req.body ?? {};
    if (b.assigneeUserId !== undefined) requireFeature(a, 'roles');
    const summary = updateCase(db, a.account.id, req.params.id, {
      status: b.status !== undefined ? oneOf(b.status, CASE_STATUSES, 'status') : undefined,
      followUpOn: b.followUpOn === null ? null : isoDateOrUndefined(b.followUpOn, 'followUpOn'),
      assigneeUserId: b.assigneeUserId,
      title: b.title !== undefined ? requireString(b, 'title', { min: 2, max: 120 }) : undefined,
    });
    ctx.delivery.emit(a.account.id, { type: 'case.updated', case: summary });
    return summary;
  });

  r.get('/v1/cases/:id/girocode', (req) => {
    const a = auth(req);
    requireFeature(a, 'paymentAssistant');
    const c = getCaseSummary(db, a.account.id, req.params.id);
    if (!c.payment) throw new HttpError(404, 'no_payment', 'In diesem Vorgang wurden keine Zahlungsdaten gefunden.');
    return { payload: buildGiroCodePayload(c.payment), payment: c.payment };
  });

  r.post('/v1/cases/:id/paid', (req) => {
    const a = auth(req);
    const row = getCaseRow(db, a.account.id, req.params.id);
    addTimeline(db, row.id, 'Als bezahlt markiert');
    const summary = updateCase(db, a.account.id, row.id, { status: 'done' });
    ctx.delivery.emit(a.account.id, { type: 'case.updated', case: summary });
    return summary;
  });

  // ---------- Antwortentwürfe ----------

  /** Antwortentwurf erstellen – aus der App oder per Tag in Paperless. */
  const createDraft = async (account: AccountRow, author: UserRow, caseId: string, intent?: string, tone: 'sachlich' | 'freundlich' | 'bestimmt' = 'sachlich') => {
    const detail = getCaseDetail(db, account.id, caseId);
    const spent = spendCredits(db, account, 'draft', { ref: detail.id, userId: author.id, now: ctx.now() });
    const docs = db
      .prepare(`SELECT title, letter_date AS date, content_text AS text FROM documents WHERE case_id = ? ORDER BY received_at DESC LIMIT 3`)
      .all(detail.id) as { title: string; date: string; text: string }[];
    let draft: { subject: string; body: string };
    try {
      draft = await ctx.ai.draft({
        senderName: author.name,
        correspondent: detail.correspondent,
        caseTitle: detail.title,
        reference: detail.reference,
        documents: docs,
        intent,
        tone,
      });
    } catch (e) {
      refundCredits(db, account.id, spent, `draft-error:${detail.id}`);
      throw new HttpError(502, 'ai_failed', 'Der Entwurf konnte gerade nicht erstellt werden. Die Credits wurden erstattet. Bitte versuche es gleich noch einmal.');
    }
    const id = newId('draft');
    db.prepare('INSERT INTO drafts (id, case_id, subject, body, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      detail.id,
      draft.subject,
      draft.body,
      'draft',
      author.id,
      nowIso(),
    );
    addTimeline(db, detail.id, 'Antwortentwurf erstellt');
    ctx.delivery.emit(account.id, { type: 'draft.created', caseId: detail.id, caseTitle: detail.title, draftId: id, subject: draft.subject, body: draft.body });
    return { id, ...draft, creditsSpent: spent };
  };

  r.post('/v1/cases/:id/draft', async (req) => {
    const a = auth(req);
    const tone = req.body?.tone ? oneOf(req.body.tone, ['sachlich', 'freundlich', 'bestimmt'] as const, 'tone') : 'sachlich';
    const intent = requireString(req.body, 'intent', { optional: true, max: 300 }) || undefined;
    return createDraft(a.account, a.user, req.params.id, intent, tone);
  });

  r.post('/v1/drafts/:id/send', (req) => {
    const a = auth(req);
    const d = db
      .prepare(`SELECT d.*, c.account_id FROM drafts d JOIN cases c ON c.id = d.case_id WHERE d.id = ?`)
      .get(req.params.id) as { id: string; case_id: string; created_by: string; status: string; account_id: string } | undefined;
    if (!d || d.account_id !== a.account.id) throw new HttpError(404, 'not_found', 'Diesen Entwurf gibt es nicht.');
    // 4-Augen-Prinzip: in Team und Enterprise darf nicht dieselbe Person schreiben und freigeben.
    if (hasFeature(a.account.plan, 'approval') && a.account.seats > 1 && d.created_by === a.user.id) {
      throw new HttpError(409, 'approval_required', 'Eine zweite Person muss diesen Entwurf freigeben.');
    }
    db.prepare(`UPDATE drafts SET status = 'sent', approved_by = ? WHERE id = ?`).run(a.user.id, d.id);
    const followUp = new Date(ctx.now().getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    addTimeline(db, d.case_id, 'Antwort versendet, Wiedervorlage in 14 Tagen');
    const summary = updateCase(db, a.account.id, d.case_id, { status: 'waiting', followUpOn: followUp });
    ctx.delivery.emit(a.account.id, { type: 'case.updated', case: summary });
    return summary;
  });

  // ---------- Dokumente ----------

  r.post('/v1/documents', async (req) => {
    const a = auth(req);
    const b = req.body ?? {};
    const channel = oneOf(b.channel ?? 'upload', ['scan', 'mail', 'upload', 'nextcloud'] as const, 'channel');
    if (channel === 'mail') requireFeature(a, 'mailInbox');
    const file = b.file
      ? {
          name: requireString(b.file, 'name', { max: 200 }),
          mime: requireString(b.file, 'mime', { max: 100 }),
          base64: requireString(b.file, 'base64'),
        }
      : undefined;

    // Foto oder PDF ohne Text: Paperless übernimmt die Texterkennung und meldet sich per Webhook zurück.
    if (file && !b.text) {
      const cfg = ctx.integrations.get(a.account.id, 'paperless');
      if (!cfg) {
        throw new HttpError(
          422,
          'ocr_unavailable',
          'Für Fotos und PDFs ohne Text braucht Dokufy die Texterkennung von Paperless. Verbinde Paperless unter Konto → Verbindungen.',
        );
      }
      const taskId = await new PaperlessClient(cfg).upload(
        { name: file.name, data: Buffer.from(file.base64, 'base64'), mime: file.mime },
        { title: typeof b.title === 'string' ? b.title : undefined },
      );
      return { queued: true, taskId, message: 'Wird gelesen. Der Vorgang erscheint in etwa einer Minute.' };
    }
    const text = requireString(b, 'text', { min: 20, max: 200_000 });
    const sizeBytes = file ? Math.floor((file.base64.length * 3) / 4) : Buffer.byteLength(text);
    const result = await ingestDocument(ctx, a.account, a.user.id, {
      text,
      title: requireString(b, 'title', { optional: true, max: 120 }) || undefined,
      letterDate: isoDateOrUndefined(b.letterDate, 'letterDate'),
      receivedDate: isoDateOrUndefined(b.receivedDate, 'receivedDate'),
      channel,
      pages: optionalInt(b, 'pages', 1, 500, 1),
      sizeBytes,
      file,
      premiumOcr: b.premiumOcr === true,
      bulkImport: b.bulkImport === true,
    });
    return { ...result, case: getCaseSummary(db, a.account.id, result.caseId), credits: getBalance(db, a.account, ctx.now()) };
  });

  r.post('/v1/documents/:id/correct', (req) => {
    const a = auth(req);
    const b = req.body ?? {};
    return correctDocument(ctx, a.account.id, req.params.id, {
      correspondent: b.correspondent !== undefined ? requireString(b, 'correspondent', { min: 2, max: 80 }) : undefined,
      kind: b.kind !== undefined ? oneOf(b.kind, DOC_KINDS, 'kind') : undefined,
      caseId: b.caseId !== undefined ? requireString(b, 'caseId') : undefined,
    });
  });

  // ---------- Suche und Fragen ----------

  r.get('/v1/search', (req) => {
    const a = auth(req);
    const q = (req.query.get('q') ?? '').trim();
    if (q.length < 2) return { cases: [], documents: [] };
    const like = `%${q}%`;
    const docs = db
      .prepare(
        `SELECT * FROM documents WHERE account_id = ? AND (title LIKE ? OR correspondent LIKE ? OR content_text LIKE ?) ORDER BY received_at DESC LIMIT 30`,
      )
      .all(a.account.id, like, like, like) as any[];
    return { cases: listCases(db, a.account.id, { q }), documents: docs.map(docToSummary) };
  });

  r.post('/v1/ask', async (req) => {
    const a = auth(req);
    const question = requireString(req.body, 'question', { min: 5, max: 500 });
    const words = question
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const rows = db
      .prepare('SELECT id, case_id AS caseId, title, letter_date AS date, content_text AS text FROM documents WHERE account_id = ? ORDER BY received_at DESC LIMIT 500')
      .all(a.account.id) as { id: string; caseId: string; title: string; date: string; text: string }[];
    const scored = rows
      .map((d) => {
        const hay = `${d.title} ${d.text}`.toLowerCase();
        return { d, score: words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 6)
      .map((x) => x.d);
    const spent = spendCredits(db, a.account, 'ask', { userId: a.user.id, now: ctx.now() });
    try {
      const result = await ctx.ai.answer(question, scored);
      return { ...result, sources: scored.filter((s) => result.sourceIds.includes(s.id)).map((s) => ({ id: s.id, caseId: s.caseId, title: s.title, date: s.date })), creditsSpent: spent };
    } catch {
      refundCredits(db, a.account.id, spent, 'ask-error');
      throw new HttpError(502, 'ai_failed', 'Die Frage konnte gerade nicht beantwortet werden. Die Credits wurden erstattet.');
    }
  });

  // ---------- Tarife, Credits, Abrechnung ----------

  r.get('/v1/billing/catalog', () => ({
    plans: PLAN_ORDER.map((id) => ({
      ...PLANS[id],
      featureLabels: PLANS[id].features.map((f) => FEATURE_LABEL[f]),
      supportLabel: SUPPORT_LABEL[PLANS[id].support],
    })),
    creditPacks: CREDIT_PACKS,
    creditCosts: Object.entries(CREDIT_COST_UNITS).map(([action, units]) => ({
      action,
      label: CREDIT_ACTION_LABEL[action as keyof typeof CREDIT_ACTION_LABEL],
      credits: toCredits(units),
    })),
  }));

  r.get('/v1/billing/credits', (req) => {
    const a = auth(req);
    return { balance: getBalance(db, a.account, ctx.now()), ledger: ledger(db, a.account.id) };
  });

  r.post('/v1/billing/checkout', async (req) => {
    const a = auth(req);
    requireAdmin(a);
    const b = req.body ?? {};
    const type = oneOf(b.type, ['plan', 'credits'] as const, 'type');
    let item: Record<string, unknown>;
    let amountCents: number;
    let description: string;
    let interval: 'month' | 'year' | undefined;
    if (type === 'plan') {
      const plan = oneOf(b.plan, ['pro', 'team'] as const, 'plan');
      interval = oneOf(b.interval ?? 'month', ['month', 'year'] as const, 'interval');
      const p = PLANS[plan];
      const seats = optionalInt(b, 'seats', p.minSeats, p.maxSeats ?? 10_000, p.minSeats);
      amountCents = priceFor(plan, interval, seats);
      item = { plan, interval, seats };
      description = `Dokufy ${p.name}${p.perSeat ? `, ${seats} Nutzer` : ''}, ${interval === 'month' ? 'monatlich' : 'jährlich'}`;
    } else {
      const pack = CREDIT_PACKS.find((p) => p.id === b.pack);
      if (!pack) throw new HttpError(400, 'invalid_input', 'Unbekanntes Credit-Paket. Erlaubt: S, M, L.');
      amountCents = pack.priceCents;
      item = { pack: pack.id, credits: pack.credits };
      description = `${pack.credits} Dokufy-Credits`;
    }
    const orderId = newId('ord');
    db.prepare('INSERT INTO orders (id, account_id, type, item_json, amount_cents, provider, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      orderId,
      a.account.id,
      type,
      JSON.stringify(item),
      amountCents,
      ctx.payments.id,
      'pending',
      nowIso(),
    );
    const checkout = await ctx.payments.createCheckout(
      { id: orderId, description, amountCents, type, interval },
      { accountId: a.account.id, email: a.user.email, name: a.user.name },
    );
    db.prepare('UPDATE orders SET provider_ref = ? WHERE id = ?').run(checkout.providerRef, orderId);
    return { orderId, url: checkout.url, amountCents, description };
  });

  /** Schaltet eine bezahlte Bestellung frei. Idempotent: doppelte Webhooks bewirken nichts. */
  const fulfill = (orderId: string): { fulfilled: boolean } => {
    return tx(db, () => {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
        | { id: string; account_id: string; type: 'plan' | 'credits'; item_json: string; status: string }
        | undefined;
      if (!o) throw new HttpError(404, 'not_found', 'Bestellung unbekannt.');
      if (o.status === 'paid') return { fulfilled: false };
      db.prepare(`UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?`).run(nowIso(), o.id);
      const item = JSON.parse(o.item_json);
      if (o.type === 'credits') {
        addPurchasedCredits(db, o.account_id, item.credits, o.id, ctx.now());
      } else {
        const renews = new Date(ctx.now());
        if (item.interval === 'year') renews.setUTCFullYear(renews.getUTCFullYear() + 1);
        else renews.setUTCMonth(renews.getUTCMonth() + 1);
        db.prepare('UPDATE accounts SET plan = ?, seats = ?, billing_interval = ?, plan_renews_at = ? WHERE id = ?').run(
          item.plan,
          item.seats,
          item.interval,
          renews.toISOString(),
          o.account_id,
        );
        // Monatskontingent sofort auf den neuen Tarif anheben
        getBalance(db, getAccountRow(db, o.account_id), ctx.now());
      }
      return { fulfilled: true };
    });
  };

  r.post('/v1/billing/webhook/:provider', (req) => {
    if (req.params.provider !== ctx.payments.id) throw new HttpError(404, 'not_found', 'Unbekannter Zahlungsanbieter.');
    const event = ctx.payments.parseWebhook(req.rawBody, req.headers);
    if (!event) throw new HttpError(400, 'invalid_signature', 'Signatur ungültig.');
    if (event.status === 'failed') {
      db.prepare(`UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'`).run(event.orderId);
      return { ok: true };
    }
    return { ok: true, ...fulfill(event.orderId) };
  });

  // Nur Entwicklung: "Bezahlseite" des Dev-Anbieters
  r.get('/v1/billing/dev/pay/:orderId', (req) => {
    if (ctx.payments.id !== 'dev' || ctx.config.production) throw new HttpError(404, 'not_found', 'Nicht verfügbar.');
    const dev = ctx.payments as DevPaymentProvider;
    if (!safeEqual(req.query.get('sig') ?? '', dev.sign(req.params.orderId))) throw new HttpError(400, 'invalid_signature', 'Signatur ungültig.');
    return { ok: true, ...fulfill(req.params.orderId), message: 'Testzahlung verbucht. Du kannst zur App zurückkehren.' };
  });

  r.post('/v1/plan/downgrade', (req) => {
    const a = auth(req);
    requireAdmin(a);
    // Downgrade löscht keine Dokumente; wird der Speicher knapp, pausieren nur neue Uploads.
    db.prepare(`UPDATE accounts SET plan = 'free', seats = 1, billing_interval = NULL, plan_renews_at = NULL WHERE id = ?`).run(a.account.id);
    return toAccountDto(db, getAccountRow(db, a.account.id), a.user, ctx.now());
  });

  // ---------- Integrationen ----------

  r.get('/v1/integrations', (req) => {
    const a = auth(req);
    return { ...ctx.integrations.describe(a.account.id), webhookUrl: `${ctx.config.publicUrl}/v1/hooks/paperless/${a.account.id}` };
  });

  r.put('/v1/integrations/:kind', async (req) => {
    const a = auth(req);
    requireAdmin(a);
    const kind = oneOf(req.params.kind, INTEGRATION_KINDS, 'kind') as IntegrationKind;
    if (kind === 'paperless' || kind === 'nextcloud') requireFeature(a, 'ownInstances');
    if (kind === 'n8n') requireFeature(a, 'customWorkflows');
    const cfg = validateIntegration(kind, req.body);
    if (req.body?.skipTest !== true) {
      try {
        if (kind === 'paperless') await new PaperlessClient(cfg as any).test();
        if (kind === 'nextcloud') await new NextcloudClient(cfg as any).test();
      } catch (e) {
        throw new HttpError(400, 'connection_failed', `Verbindung fehlgeschlagen: ${(e as Error).message}. Prüfe Adresse und Zugangsdaten.`);
      }
    }
    ctx.integrations.set(a.account.id, kind, cfg as any);
    return ctx.integrations.describe(a.account.id);
  });

  r.delete('/v1/integrations/:kind', (req) => {
    const a = auth(req);
    requireAdmin(a);
    ctx.integrations.remove(a.account.id, oneOf(req.params.kind, INTEGRATION_KINDS, 'kind') as IntegrationKind);
    return ctx.integrations.describe(a.account.id);
  });

  r.get('/v1/integrations/webhook-secret', (req) => {
    const a = auth(req);
    requireAdmin(a);
    return { secret: a.account.webhook_secret };
  });

  /**
   * Eingang aus Paperless – direkt per Paperless-Workflow-Webhook oder über n8n.
   * Anmeldung: Header x-dokufy-token = Webhook-Geheimnis des Kontos (Paperless kann feste Header senden)
   * oder x-dokufy-signature = HMAC-SHA256 des Rohinhalts (für Absender, die signieren können).
   *
   * Aktionen (Feld "action"):
   *  - "added" (Standard): neues Dokument auswerten und einordnen
   *  - "draft": Antwortentwurf für den Vorgang des Dokuments schreiben (Tag "dokufy-antwort" in Paperless)
   *  - "done": Vorgang des Dokuments als erledigt markieren (Tag "dokufy-erledigt" in Paperless)
   */
  r.post('/v1/hooks/paperless/:accountId', async (req) => {
    const account = getAccountRow(db, req.params.accountId);
    const token = String(req.headers['x-dokufy-token'] ?? '');
    const sig = String(req.headers['x-dokufy-signature'] ?? '');
    const authorized =
      (token && safeEqual(token, account.webhook_secret)) || (sig && safeEqual(sig, webhookSignature(account.webhook_secret, req.rawBody)));
    if (!authorized) throw new HttpError(401, 'invalid_signature', 'Anmeldung am Webhook fehlgeschlagen (x-dokufy-token oder x-dokufy-signature).');

    // Paperless setzt Platzhalter als Text ein: "123" statt 123
    const paperlessId = Number(req.body?.documentId);
    if (!Number.isInteger(paperlessId) || paperlessId <= 0) throw new HttpError(400, 'invalid_input', '"documentId" (Paperless-ID) fehlt.');
    const action = oneOf(req.body?.action ?? 'added', ['added', 'draft', 'done'] as const, 'action');
    const existing = db.prepare('SELECT id, case_id FROM documents WHERE account_id = ? AND paperless_id = ?').get(account.id, paperlessId) as
      | { id: string; case_id: string }
      | undefined;

    if (action !== 'added') {
      if (!existing) throw new HttpError(404, 'not_found', `Dokument ${paperlessId} ist in Dokufy noch nicht eingeordnet.`);
      if (action === 'done') {
        const summary = updateCase(db, account.id, existing.case_id, { status: 'done' });
        ctx.delivery.emit(account.id, { type: 'case.updated', case: summary });
        return { ok: true, caseId: summary.id, status: summary.status };
      }
      const owner = db.prepare(`SELECT * FROM users WHERE account_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1`).get(account.id) as unknown as UserRow;
      const intent = typeof req.body?.intent === 'string' && req.body.intent.trim() ? req.body.intent.trim().slice(0, 300) : undefined;
      const draft = await createDraft(account, owner, existing.case_id, intent);
      return { ok: true, caseId: existing.case_id, draftId: draft.id, subject: draft.subject };
    }

    if (existing) return { duplicate: true, documentId: existing.id, caseId: existing.case_id };

    let text: string = typeof req.body?.content === 'string' ? req.body.content : '';
    let title: string | undefined = typeof req.body?.title === 'string' && req.body.title ? req.body.title : undefined;
    let created: string | undefined = typeof req.body?.created === 'string' && req.body.created ? req.body.created : undefined;
    if (!text) {
      const cfg = ctx.integrations.get(account.id, 'paperless');
      if (!cfg) throw new HttpError(400, 'not_configured', 'Paperless ist nicht verbunden und es wurde kein Text mitgeschickt.');
      const doc = await new PaperlessClient(cfg).getDocument(paperlessId);
      text = doc.content;
      // Paperless-Titel sind oft Dateinamen ("scan_0042"); Dokufys eigene Auswertung liefert den besseren Titel.
      created = created ?? doc.created;
    }
    if (text.trim().length < 20) return { skipped: true, reason: 'Kein lesbarer Text (leeres Dokument oder OCR fehlgeschlagen).' };
    const result = await ingestDocument(ctx, account, null, {
      text,
      title,
      letterDate: created?.slice(0, 10),
      channel: req.body?.channel === 'mail' ? 'mail' : 'scan',
      pages: Number.isInteger(req.body?.pages) ? req.body.pages : 1,
      sizeBytes: Number.isInteger(req.body?.sizeBytes) ? req.body.sizeBytes : Buffer.byteLength(text),
      paperlessId,
    });
    const cfg = ctx.integrations.get(account.id, 'paperless');
    if (cfg?.caseFieldId) {
      new PaperlessClient(cfg).setCaseField(paperlessId, cfg.caseFieldId, result.caseId).catch((e) => ctx.log(`Paperless-Feld nicht gesetzt: ${e.message}`));
    }
    return result;
  });

  return r;
}

export type { PlanId };
