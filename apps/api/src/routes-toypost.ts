import { randomBytes } from 'node:crypto';
import type { Context } from './context.ts';
import { nowIso } from './db.ts';
import { HttpError, oneOf, requireString, RateLimiter, type Request, type Router } from './http.ts';
import type { AccountRow, UserRow } from './services/accounts.ts';
import { getAccountRow, getUserRow, toAccountDto } from './services/accounts.ts';
import { sendVia } from './channels/adapters.ts';
import { authorizeInbound, normalizeInbound } from './channels/inbound.ts';
import type { ChannelRow } from './channels/store.ts';
import { CAN_SEND, CHANNEL_KINDS, CHANNEL_LABEL, HANDLE_KIND, normalizeHandle, POLLED, validateChannelConfig, type ChannelKind } from './channels/types.ts';
import { addHandle, contactDto, getContactRow, listContacts, mergeContacts, updateContact } from './services/contacts.ts';
import { listMessages, receiveMessage, sendMessage } from './services/messages.ts';
import { createBroadcast, discardBroadcast, getBroadcast, listBroadcasts, sendBroadcast, updateBroadcast } from './services/broadcasts.ts';
import { deleteAutomation, installPreset, listAutomations, PRESETS, saveAutomation, TRIGGERS } from './services/automations.ts';
import { applyTransfer, createInvoice, listInvoices, toTransfer } from './services/invoices.ts';
import { transparencyReport } from './services/reports.ts';
import { listCases } from './services/cases.ts';
import { pollChannel } from './toy/watchers.ts';
import { GitHubClient } from './toy/clients.ts';
import { verifySiwe } from './toy/siwe.ts';
import { knownAddresses, ownAddresses } from './services/contacts.ts';
import {
  checkSafety,
  detectToyRequest,
  glossaryHint,
  LEGACY_TOKENS,
  TOY_GLOSSARY,
  TOY_I18N_SOURCE,
  TOY_LANGUAGES,
  toyLanguage,
  type MessageChannelKind,
} from './shared.ts';

interface Authed {
  account: AccountRow;
  user: UserRow;
}

export interface RouteHelpers {
  auth: (req: Request) => Authed;
  requireAdmin: (a: Authed) => void;
  issueToken: (user: { id: string; account_id: string }) => string;
}

const MESSAGE_KINDS: MessageChannelKind[] = ['email', 'telegram', 'matrix', 'signal', 'sms', 'ntfy', 'talk', 'discord', 'slack', 'webhook', 'feed', 'github', 'toyscan'];

export function addToyPostRoutes(r: Router, ctx: Context, { auth, requireAdmin, issueToken }: RouteHelpers): void {
  const { db } = ctx;
  const inboxLimiter = new RateLimiter(120, 60_000);
  const walletLimiter = new RateLimiter(20, 60_000);
  const channelOf = (a: Authed, id: string) => ctx.channels.row(a.account.id, id);

  // ---------- Kanäle ----------

  r.get('/v1/channels', (req) => {
    const a = auth(req);
    const admin = a.user.role !== 'member';
    return {
      channels: ctx.channels.list(a.account.id).map((c) => ctx.channels.dto(c, ctx.config.publicUrl, admin)),
      kinds: CHANNEL_KINDS.map((k) => ({ kind: k, label: CHANNEL_LABEL[k], canSend: CAN_SEND.includes(k), polled: POLLED.includes(k), handleLabel: HANDLE_KIND[k] })),
    };
  });

  r.post('/v1/channels', (req) => {
    const a = auth(req);
    requireAdmin(a);
    const kind = oneOf(req.body?.kind, CHANNEL_KINDS, 'kind') as ChannelKind;
    const name = requireString(req.body, 'name', { optional: true, max: 60 }) || CHANNEL_LABEL[kind];
    const cfg = validateChannelConfig(kind, req.body?.config ?? {});
    return ctx.channels.dto(ctx.channels.create(a.account.id, kind, name, cfg as any), ctx.config.publicUrl, true);
  });

  r.patch('/v1/channels/:id', (req) => {
    const a = auth(req);
    requireAdmin(a);
    const row = channelOf(a, req.params.id);
    const b = req.body ?? {};
    const config = b.config ? validateChannelConfig(row.kind, { ...ctx.channels.config(row), ...b.config }) : undefined;
    return ctx.channels.dto(
      ctx.channels.update(a.account.id, row.id, { name: b.name ? requireString(b, 'name', { max: 60 }) : undefined, enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, config: config as any }),
      ctx.config.publicUrl,
      true,
    );
  });

  r.delete('/v1/channels/:id', (req) => {
    const a = auth(req);
    requireAdmin(a);
    ctx.channels.remove(a.account.id, req.params.id);
    return { ok: true };
  });

  /** Test: sendable channels send a short test message, polled sources are read once. */
  r.post('/v1/channels/:id/test', async (req) => {
    const a = auth(req);
    requireAdmin(a);
    const row = channelOf(a, req.params.id);
    const cfg = ctx.channels.config(row);
    if (POLLED.includes(row.kind)) {
      try {
        const res = await pollChannel(ctx, row, { githubApi: ctx.config.githubApi });
        ctx.channels.markPolled(row.id, null);
        return { ok: true, message: res.baseline ? 'Verbunden. Der aktuelle Stand ist gespeichert; ab jetzt meldet ToyPost Neues.' : `Verbunden, ${res.events} neue Ereignisse.` };
      } catch (e) {
        ctx.channels.markPolled(row.id, (e as Error).message);
        throw new HttpError(400, 'connection_failed', `Abruf fehlgeschlagen: ${(e as Error).message}`);
      }
    }
    if (!CAN_SEND.includes(row.kind)) throw new HttpError(400, 'cannot_send', 'Dieser Kanal kann nur empfangen.');
    const to = req.body?.to ? normalizeHandle(row.kind, String(req.body.to)) : undefined;
    try {
      await sendVia(row.kind, cfg as any, { to, subject: 'ToyPost-Test', text: 'Diese Testnachricht bestätigt, dass ToyPost über diesen Kanal senden kann.' });
      return { ok: true, message: 'Testnachricht gesendet.' };
    } catch (e) {
      throw new HttpError(400, 'connection_failed', `Senden fehlgeschlagen: ${(e as Error).message}`);
    }
  });

  /** Tells Telegram where to deliver messages, signed with the channel's token. */
  r.post('/v1/channels/:id/telegram-webhook', async (req) => {
    const a = auth(req);
    requireAdmin(a);
    const row = channelOf(a, req.params.id);
    if (row.kind !== 'telegram') throw new HttpError(400, 'invalid_input', 'Das ist kein Telegram-Kanal.');
    const cfg = ctx.channels.config(row as ChannelRow & { kind: 'telegram' });
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${ctx.config.publicUrl}/v1/inbox/${row.id}`, secret_token: row.inbound_token, allowed_updates: ['message', 'edited_message', 'channel_post'] }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!data.ok) throw new HttpError(400, 'connection_failed', `Telegram: ${data.description ?? res.status}`);
    return { ok: true, message: 'Telegram liefert neue Nachrichten jetzt an ToyPost.' };
  });

  // ---------- Eingang aller Kanäle ----------

  r.post('/v1/inbox/:channelId', async (req) => {
    inboxLimiter.check(`inbox:${req.params.channelId}`);
    const row = ctx.channels.byId(req.params.channelId);
    const cfg = ctx.channels.config(row);
    if (!authorizeInbound(row.kind, cfg, row.inbound_token, { headers: req.headers, query: req.query, body: req.body, url: req.url })) {
      throw new HttpError(401, 'invalid_signature', 'Anmeldung am Eingang fehlgeschlagen (Token oder Signatur).');
    }
    if (!row.enabled) return { ok: true, ignored: 'Kanal ist ausgeschaltet.' };
    const account = getAccountRow(db, row.account_id);
    // ToyScan address alarm (docs/05 section 8): one transfer or a list of transfers
    if (row.kind === 'toyscan') {
      const raw = req.body?.transaktionen ?? req.body?.transactions ?? [req.body?.transaktion ?? req.body?.transaction ?? req.body];
      let booked = 0;
      for (const t of (Array.isArray(raw) ? raw : []).map(toTransfer)) if (t && applyTransfer(ctx, account.id, t).booked) booked++;
      return { ok: true, booked };
    }
    if (POLLED.includes(row.kind) || !['email', 'telegram', 'matrix', 'signal', 'sms', 'talk', 'webhook'].includes(row.kind)) {
      throw new HttpError(400, 'invalid_input', 'Dieser Kanal nimmt keine Nachrichten an.');
    }
    const n = normalizeInbound(row.kind, cfg as any, req.body ?? {});
    if (n.kind === 'ignore') return { ok: true, ignored: n.reason };
    const result = await receiveMessage(ctx, account, row, cfg, n.message);
    return { ok: true, messageId: result.message.id, caseId: result.caseId, duplicate: result.duplicate ?? false };
  });

  // ---------- Nachrichten ----------

  r.get('/v1/messages', (req) => {
    const a = auth(req);
    const direction = req.query.get('direction');
    return listMessages(db, a.account.id, {
      direction: direction ? oneOf(direction, ['in', 'out'] as const, 'direction') : undefined,
      contactId: req.query.get('contactId') ?? undefined,
      caseId: req.query.get('caseId') ?? undefined,
      before: req.query.get('before') ?? undefined,
      limit: Number(req.query.get('limit') ?? 50),
    });
  });

  r.post('/v1/messages', async (req) => {
    const a = auth(req);
    const b = req.body ?? {};
    const row = channelOf(a, requireString(b, 'channelId'));
    return sendMessage(ctx, a.account, {
      channel: row,
      cfg: ctx.channels.config(row),
      contactId: b.contactId ? requireString(b, 'contactId') : undefined,
      to: b.to ? requireString(b, 'to', { max: 200 }) : undefined,
      subject: requireString(b, 'subject', { optional: true, max: 200 }) || undefined,
      text: requireString(b, 'text', { min: 1, max: 20_000 }),
      link: requireString(b, 'link', { optional: true, max: 2000 }) || undefined,
      caseId: b.caseId ? requireString(b, 'caseId') : undefined,
    });
  });

  // ---------- Kontakte ----------

  r.get('/v1/contacts', (req) => {
    const a = auth(req);
    return listContacts(db, a.account.id, { tag: req.query.get('tag') ?? undefined, q: req.query.get('q') ?? undefined });
  });

  r.post('/v1/contacts', (req) => {
    const a = auth(req);
    const b = req.body ?? {};
    const name = requireString(b, 'name', { min: 1, max: 120 });
    const handles = Array.isArray(b.handles) ? b.handles : [];
    const id = `ct_${randomBytes(10).toString('hex')}`;
    const now = nowIso();
    db.prepare('INSERT INTO contacts (id, account_id, name, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, a.account.id, name, toyLanguage(b.language).code, now, now);
    try {
      for (const h of handles) {
        const kind = oneOf(h?.kind, MESSAGE_KINDS, 'kind') as ChannelKind;
        addHandle(db, a.account.id, id, kind as MessageChannelKind, normalizeHandle(kind, String(h?.handle ?? '')));
      }
      return updateContact(db, a.account.id, id, { toyAddress: b.toyAddress, tags: Array.isArray(b.tags) ? b.tags : undefined });
    } catch (e) {
      db.prepare('DELETE FROM contact_handles WHERE contact_id = ?').run(id);
      db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
      throw e;
    }
  });

  r.get('/v1/contacts/:id', (req) => {
    const a = auth(req);
    const c = getContactRow(db, a.account.id, req.params.id);
    const caseIds = db.prepare('SELECT id FROM cases WHERE contact_id = ? ORDER BY updated_at DESC LIMIT 30').all(c.id) as { id: string }[];
    const cases = listCases(db, a.account.id).filter((x) => caseIds.some((r) => r.id === x.id));
    return { ...contactDto(db, c), messages: listMessages(db, a.account.id, { contactId: c.id, limit: 50 }), cases };
  });

  r.patch('/v1/contacts/:id', (req) => {
    const a = auth(req);
    const b = req.body ?? {};
    return updateContact(db, a.account.id, req.params.id, {
      name: b.name,
      language: b.language,
      toyAddress: b.toyAddress,
      tags: Array.isArray(b.tags) ? b.tags : undefined,
      preferredChannelId: b.preferredChannelId,
    });
  });

  r.post('/v1/contacts/:id/handles', (req) => {
    const a = auth(req);
    const kind = oneOf(req.body?.kind, MESSAGE_KINDS, 'kind') as ChannelKind;
    return addHandle(db, a.account.id, req.params.id, kind as MessageChannelKind, normalizeHandle(kind, requireString(req.body, 'handle', { max: 200 })));
  });

  r.post('/v1/contacts/:id/merge', (req) => {
    const a = auth(req);
    return mergeContacts(db, a.account.id, req.params.id, requireString(req.body, 'fromId'));
  });

  // ---------- Mitteilungen an Gruppen und Kanäle ----------

  r.get('/v1/broadcasts', (req) => listBroadcasts(db, auth(req).account.id));

  r.post('/v1/broadcasts', (req) => {
    const a = auth(req);
    return createBroadcast(db, a.account.id, {
      audience: requireString(req.body, 'audience', { max: 80 }),
      subject: requireString(req.body, 'subject', { min: 2, max: 200 }),
      body: requireString(req.body, 'body', { min: 2, max: 10_000 }),
      source: 'von Hand',
      userId: a.user.id,
    });
  });

  r.patch('/v1/broadcasts/:id', (req) => {
    const a = auth(req);
    const b = req.body ?? {};
    return updateBroadcast(db, a.account.id, req.params.id, {
      subject: b.subject !== undefined ? requireString(b, 'subject', { min: 2, max: 200 }) : undefined,
      body: b.body !== undefined ? requireString(b, 'body', { min: 2, max: 10_000 }) : undefined,
      audience: b.audience !== undefined ? requireString(b, 'audience', { max: 80 }) : undefined,
    });
  });

  /** Preview in one language before approving, so the user sees what a Swahili or Arabic reader gets. */
  r.get('/v1/broadcasts/:id/preview', async (req) => {
    const a = auth(req);
    const b = getBroadcast(db, a.account.id, req.params.id);
    const lang = toyLanguage(req.query.get('lang') ?? 'en');
    const t = lang.code === 'de' ? { subject: b.subject, text: b.body } : await ctx.ai.translate({ subject: b.subject, text: b.body, targetLang: lang.code, targetLangName: lang.name, glossary: glossaryHint(`${b.subject}\n${b.body}`) });
    return { language: lang, subject: t.subject ?? b.subject, body: t.text };
  });

  r.post('/v1/broadcasts/:id/send', async (req) => {
    const a = auth(req);
    requireAdmin(a);
    return sendBroadcast(ctx, a.account, a.user, req.params.id);
  });

  r.post('/v1/broadcasts/:id/discard', (req) => discardBroadcast(db, auth(req).account.id, req.params.id));

  // ---------- Automationen ----------

  r.get('/v1/automations', (req) => {
    const a = auth(req);
    return {
      automations: listAutomations(db, a.account.id),
      presets: PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description, needs: p.needs })),
      triggers: TRIGGERS,
    };
  });

  r.post('/v1/automations', (req) => {
    const a = auth(req);
    requireAdmin(a);
    const b = req.body ?? {};
    return saveAutomation(db, a.account.id, { name: requireString(b, 'name', { max: 80 }), trigger: b.trigger, conditions: b.conditions ?? [], actions: b.actions, enabled: b.enabled });
  });

  r.put('/v1/automations/:id', (req) => {
    const a = auth(req);
    requireAdmin(a);
    const b = req.body ?? {};
    return saveAutomation(db, a.account.id, { id: req.params.id, name: requireString(b, 'name', { max: 80 }), trigger: b.trigger, conditions: b.conditions ?? [], actions: b.actions, enabled: b.enabled });
  });

  r.delete('/v1/automations/:id', (req) => {
    const a = auth(req);
    requireAdmin(a);
    deleteAutomation(db, a.account.id, req.params.id);
    return { ok: true };
  });

  r.post('/v1/automations/presets/:presetId', (req) => {
    const a = auth(req);
    requireAdmin(a);
    return installPreset(db, a.account.id, req.params.presetId, { github: req.body?.github, announce: req.body?.announce });
  });

  // ---------- Toy-Projekte ----------

  r.get('/v1/toy/overview', (req) => {
    const a = auth(req);
    const states = db.prepare(`SELECT key, value, updated_at FROM watch_state WHERE account_id = ?`).all(a.account.id) as { key: string; value: string; updated_at: string }[];
    const ampel = states.find((s) => s.key.endsWith(':ampel'));
    const milestones = states.find((s) => s.key.endsWith(':milestones'));
    const invoices = listInvoices(db, a.account.id);
    return {
      ampel: ampel ? { color: ampel.value.replace('+lampe', ''), bigRedLamp: ampel.value.endsWith('+lampe'), checkedAt: ampel.updated_at } : null,
      milestones: milestones ? JSON.parse(milestones.value) : [],
      invoices: {
        open: invoices.filter((i) => i.status === 'open' || i.status === 'partial').length,
        paid: invoices.filter((i) => i.status === 'paid').length,
        list: invoices.slice(0, 20),
      },
      pendingBroadcasts: listBroadcasts(db, a.account.id).filter((b) => b.status === 'draft').length,
      legacyTokens: LEGACY_TOKENS,
      languages: TOY_LANGUAGES.length,
      i18nSource: TOY_I18N_SOURCE,
    };
  });

  r.get('/v1/toy/languages', () => ({ languages: TOY_LANGUAGES, glossary: TOY_GLOSSARY, source: TOY_I18N_SOURCE }));

  r.get('/v1/toy/invoices', (req) => listInvoices(db, auth(req).account.id));

  r.post('/v1/toy/invoices', async (req) => {
    const a = auth(req);
    const b = req.body ?? {};
    const invoice = createInvoice(db, a.account.id, {
      address: requireString(b, 'address'),
      amount: requireString(b, 'amount', { max: 40 }),
      label: requireString(b, 'label', { optional: true, max: 60 }) || undefined,
      note: requireString(b, 'note', { optional: true, max: 300 }) || undefined,
      validUntil: requireString(b, 'validUntil', { optional: true }) || undefined,
      caseId: b.caseId ? requireString(b, 'caseId') : undefined,
      contactId: b.contactId ? requireString(b, 'contactId') : undefined,
    });
    // optionally send the payment link to the contact right away
    let message;
    if (b.sendVia && b.contactId) {
      const ch = channelOf(a, requireString(b, 'sendVia'));
      message = await sendMessage(ctx, a.account, {
        channel: ch,
        cfg: ctx.channels.config(ch),
        contactId: b.contactId,
        subject: `Zahlungsaufforderung ${invoice.code}`,
        text: `Bitte zahle ${b.amount} TOY mit dem Verwendungszweck „${invoice.purpose}“. Der Link öffnet die TOYPAY Wallet:`,
        link: invoice.link,
        caseId: b.caseId,
      });
    }
    return { invoice, message };
  });

  /** Check any text: phishing, secrets, TOY payment request – e.g. a suspicious message someone forwards. */
  r.post('/v1/toy/check', (req) => {
    const a = auth(req);
    const text = requireString(req.body, 'text', { min: 1, max: 50_000 });
    const direction = req.body?.direction === 'out' ? 'out' : 'in';
    const request = detectToyRequest(text, ownAddresses(db, a.account.id));
    return {
      findings: checkSafety({ text, direction, knownAddresses: knownAddresses(db, a.account.id) }),
      toyRequest: request ? { address: request.address, amount: request.amount?.toString(), purpose: request.purpose, link: request.link } : null,
    };
  });

  r.post('/v1/toy/report', async (req) => {
    const a = auth(req);
    requireAdmin(a);
    const month = requireString(req.body, 'month', { max: 7 });
    let report;
    try {
      report = await transparencyReport(ctx, a.account.id, { month });
    } catch (e) {
      throw new HttpError(400, 'invalid_input', (e as Error).message);
    }
    if (req.body?.propose !== true) return report;
    const gh = ctx.channels.list(a.account.id).find((c) => c.kind === 'github' && c.enabled);
    if (!gh) throw new HttpError(400, 'not_configured', 'Für einen Pull Request braucht ToyPost einen GitHub-Kanal mit Schreibrecht.');
    const cfg = ctx.channels.config(gh as ChannelRow & { kind: 'github' });
    if (!cfg.token) throw new HttpError(400, 'not_configured', 'Der GitHub-Kanal hat kein Token. Für einen Pull Request braucht es Schreibrecht auf Inhalte und Pull Requests.');
    const pr = await new GitHubClient(cfg.repo, cfg.token, ctx.config.githubApi).proposeFile({
      base: cfg.branch,
      branch: `toypost/bericht-${month}`,
      path: report.path,
      content: report.markdown,
      message: `Add transparency report draft ${month}`,
      title: `Transparenz-Bericht ${month} (Entwurf)`,
      body: 'Von ToyPost erstellter Entwurf. Bitte prüfen und ergänzen, bevor er zusammengeführt wird.',
    });
    return { ...report, pullRequest: pr };
  });

  // ---------- Anmelden mit Adresse (EIP-4361) ----------

  const consumeNonce = (nonce: string) => {
    const row = db.prepare('SELECT created_at FROM siwe_nonces WHERE nonce = ?').get(nonce) as { created_at: string } | undefined;
    if (!row) return false;
    db.prepare('DELETE FROM siwe_nonces WHERE nonce = ?').run(nonce);
    return ctx.now().getTime() - Date.parse(row.created_at) < 10 * 60_000;
  };

  r.get('/v1/auth/wallet/nonce', (req) => {
    walletLimiter.check(`nonce:${req.ip}`);
    const nonce = randomBytes(12).toString('hex');
    db.prepare('INSERT INTO siwe_nonces (nonce, created_at) VALUES (?, ?)').run(nonce, ctx.now().toISOString());
    db.prepare('DELETE FROM siwe_nonces WHERE created_at < ?').run(new Date(ctx.now().getTime() - 60 * 60_000).toISOString());
    return { nonce, domain: ctx.config.siweDomain, uri: ctx.config.publicUrl, chainIds: ctx.config.chainIds, statement: 'Bei ToyPost anmelden' };
  });

  const verifyWallet = (req: Request) => {
    try {
      return verifySiwe(requireString(req.body, 'message', { max: 4000 }), requireString(req.body, 'signature', { max: 200 }), {
        domain: ctx.config.siweDomain,
        chainIds: ctx.config.chainIds,
        now: ctx.now(),
        consumeNonce,
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(401, 'invalid_signature', (e as Error).message);
    }
  };

  r.post('/v1/auth/wallet', (req) => {
    walletLimiter.check(`wallet:${req.ip}`);
    const { address } = verifyWallet(req);
    const link = db.prepare('SELECT user_id FROM wallet_links WHERE address = ?').get(address) as { user_id: string } | undefined;
    if (!link) throw new HttpError(404, 'wallet_not_linked', 'Diese Adresse ist mit keinem ToyPost-Konto verknüpft. Melde dich einmal mit E-Mail an und verknüpfe sie unter Konto.');
    const user = getUserRow(db, link.user_id);
    return { token: issueToken(user), account: toAccountDto(db, getAccountRow(db, user.account_id), user, ctx.now()), address };
  });

  r.post('/v1/me/wallet', (req) => {
    const a = auth(req);
    const { address } = verifyWallet(req);
    const existing = db.prepare('SELECT user_id FROM wallet_links WHERE address = ?').get(address) as { user_id: string } | undefined;
    if (existing && existing.user_id !== a.user.id) throw new HttpError(409, 'wallet_taken', 'Diese Adresse ist schon mit einem anderen Konto verknüpft.');
    if (!existing) db.prepare('INSERT INTO wallet_links (address, user_id, created_at) VALUES (?, ?, ?)').run(address, a.user.id, nowIso());
    return { addresses: (db.prepare('SELECT address FROM wallet_links WHERE user_id = ?').all(a.user.id) as { address: string }[]).map((r) => r.address) };
  });

  r.get('/v1/me/wallet', (req) => {
    const a = auth(req);
    return { addresses: (db.prepare('SELECT address FROM wallet_links WHERE user_id = ?').all(a.user.id) as { address: string }[]).map((r) => r.address) };
  });

  r.delete('/v1/me/wallet/:address', (req) => {
    const a = auth(req);
    db.prepare('DELETE FROM wallet_links WHERE user_id = ? AND lower(address) = lower(?)').run(a.user.id, req.params.address);
    return { ok: true };
  });

}
