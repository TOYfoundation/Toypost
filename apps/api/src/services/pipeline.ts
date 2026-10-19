import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../context.ts';
import { nowIso, tx } from '../db.ts';
import { HttpError } from '../http.ts';
import { newId } from '../security.ts';
import { heuristicAnalysis, matchCaseByRules, type CaseCandidate } from '../ai/provider.ts';
import { refundCredits, spendCredits } from './credits.ts';
import { addTimeline, applyAnalysis, createCase, getCaseRow, getCaseSummary, type CaseRow } from './cases.ts';
import type { AccountRow } from './accounts.ts';
import {
  checkSafety,
  detectToyRequest,
  redactSecrets,
  storageLimitBytes,
  todayIso,
  toyDecimal,
  type Analysis,
  type Channel,
  type DocumentKind,
  type SafetyNote,
  type ToyRequest,
} from '../shared.ts';
import { knownAddresses, ownAddresses } from './contacts.ts';

export interface IngestInput {
  text: string;
  title?: string;
  letterDate?: string;
  receivedDate?: string;
  channel: Channel;
  pages: number;
  sizeBytes: number;
  /** Originaldatei (optional), base64 */
  file?: { name: string; mime: string; base64: string };
  paperlessId?: number;
  /** Premium-OCR wurde für diese Seiten genutzt (kostet je Seite 1 Credit) */
  premiumOcr?: boolean;
  /** Altbestand-Import: günstiger, wird nachts verarbeitet */
  bulkImport?: boolean;
  /** Vorgang steht schon fest (z. B. dieselbe Unterhaltung im Messenger) */
  caseId?: string;
  /** Kontakt, von dem die Nachricht kam */
  contactId?: string;
}

export interface IngestResult {
  documentId: string;
  caseId: string;
  createdCase: boolean;
  usedAi: boolean;
  matchedRule: boolean;
  creditsSpent: number;
  analysis: Analysis;
  safety: SafetyNote[];
  toyRequest?: ToyRequest;
}

/** Merges new warnings into a case without duplicates. */
export function mergeSafety(existingJson: string | null, add: SafetyNote[]): string | null {
  const list = existingJson ? (JSON.parse(existingJson) as SafetyNote[]) : [];
  for (const f of add) if (!list.some((x) => x.code === f.code && x.message === f.message)) list.push(f);
  return list.length ? JSON.stringify(list) : null;
}

interface RuleRow {
  id: string;
  match_text: string;
  correspondent: string;
  kind: DocumentKind;
  case_id: string | null;
}

/** Eine gelernte Regel greift, wenn ihr Merkmal (Zeichen oder Absender) wörtlich im Text steht. */
function findRule(ctx: Context, accountId: string, text: string): RuleRow | undefined {
  const lower = text.toLowerCase().replace(/\s+/g, ' ');
  const rules = ctx.db.prepare('SELECT id, match_text, correspondent, kind, case_id FROM rules WHERE account_id = ? ORDER BY length(match_text) DESC').all(accountId) as unknown as RuleRow[];
  return rules.find((r) => lower.includes(r.match_text.toLowerCase()));
}

export async function ingestDocument(ctx: Context, account: AccountRow, userId: string | null, inputRaw: IngestInput): Promise<IngestResult> {
  let input = inputRaw;
  const { db } = ctx;
  const now = ctx.now();
  const today = todayIso(now);
  // Safety first, on the original text; afterwards secrets are removed before anything is stored or sent to an AI.
  const findings = checkSafety({ text: input.text, direction: 'in', knownAddresses: knownAddresses(db, account.id) });
  const safety: SafetyNote[] = findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message }));
  const detected = detectToyRequest(input.text, ownAddresses(db, account.id));
  const toyRequest: ToyRequest | undefined = detected
    ? { address: detected.address, amount: detected.amount?.toString(), purpose: detected.purpose, link: detected.link }
    : undefined;
  input = { ...input, text: redactSecrets(input.text) };
  const letterDate = input.letterDate ?? today;

  // 1. Speicher prüfen: volle Konten bleiben lesbar, nur neue Uploads pausieren.
  const limit = storageLimitBytes(account.plan, account.seats);
  if (account.storage_used_bytes + input.sizeBytes > limit) {
    throw new HttpError(413, 'storage_full', 'Dein Speicher ist voll. Lösche alte Dokumente oder wechsle in einen größeren Tarif.');
  }

  // 2. Kostenlose Regel-Auswertung
  let analysis = heuristicAnalysis(input.text, letterDate, input.receivedDate);
  if (input.title) analysis.title = input.title;

  // 3. Gelernte Regeln: Treffer ersetzen die KI
  const rule = findRule(ctx, account.id, input.text);
  const openCases = db
    .prepare(`SELECT id, title, correspondent, reference FROM cases WHERE account_id = ? AND status != 'done' ORDER BY updated_at DESC LIMIT 40`)
    .all(account.id) as { id: string; title: string; correspondent: string; reference: string | null }[];
  const candidates: CaseCandidate[] = openCases.map((c) => ({ ...c, reference: c.reference ?? undefined }));

  let caseId: string | undefined;
  let usedAi = false;
  let creditsSpent = 0;

  if (input.caseId) {
    // known conversation: no AI needed to find the case, but analysis still runs below for deadlines and amounts
    getCaseRow(db, account.id, input.caseId);
  }
  if (rule) {
    analysis = { ...analysis, correspondent: rule.correspondent, kind: rule.kind, confidence: 0.9 };
    caseId = rule.case_id && candidates.some((c) => c.id === rule.case_id) ? rule.case_id : matchCaseByRules(analysis, candidates);
    db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(rule.id);
  } else {
    // 4. KI-Auswertung gegen Credits
    const action = input.bulkImport ? 'importDoc' : 'analyze';
    creditsSpent += spendCredits(db, account, action, { userId: userId ?? undefined, now });
    if (input.premiumOcr) creditsSpent += spendCredits(db, account, 'premiumOcrPage', { quantity: input.pages, userId: userId ?? undefined, now });
    try {
      const result = await ctx.ai.analyze({ text: input.text, letterDate, receivedDate: input.receivedDate, candidates, baseline: analysis });
      caseId = result.caseId ?? matchCaseByRules(result, candidates);
      analysis = result;
      usedAi = ctx.ai.name !== 'mock';
    } catch (e) {
      // Fehlgeschlagene KI kostet nichts; die Regel-Auswertung wird übernommen.
      refundCredits(db, account.id, creditsSpent, `ai-error:${now.toISOString()}`);
      ctx.log(`KI-Auswertung fehlgeschlagen, Regel-Ergebnis übernommen: ${(e as Error).message}`);
      creditsSpent = 0;
      caseId = matchCaseByRules(analysis, candidates);
    }
  }

  if (input.caseId) caseId = input.caseId;
  if (toyRequest && !analysis.nextAction) {
    analysis = {
      ...analysis,
      actionRequired: true,
      nextAction: toyRequest.amount ? `${toyDecimal(BigInt(toyRequest.amount))} TOY in der TOYPAY Wallet prüfen und zahlen` : 'TOY-Zahlung in der TOYPAY Wallet prüfen',
    };
  }
  if (safety.some((f) => f.severity !== 'yellow')) {
    analysis = { ...analysis, actionRequired: true, nextAction: 'Warnung lesen: möglicher Betrug' };
  }

  // 5. Datei ablegen (nur wenn kein Paperless die Datei hält)
  let filePath: string | null = null;
  const documentId = newId('doc');
  if (input.file && !input.paperlessId) {
    const dir = join(ctx.config.filesPath, account.id);
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, `${documentId}-${input.file.name.replace(/[^\w.\-]/g, '_')}`);
    writeFileSync(filePath, Buffer.from(input.file.base64, 'base64'));
  }

  // 6. Speichern
  const { caseRow, created } = tx(db, () => {
    let row: CaseRow;
    let created = false;
    if (caseId) {
      row = getCaseRow(db, account.id, caseId);
      applyAnalysis(db, row, analysis, today);
    } else {
      row = createCase(db, account.id, analysis, today);
      created = true;
    }
    db.prepare(
      `INSERT INTO documents (id, account_id, case_id, title, correspondent, kind, channel, direction, letter_date, received_at, pages, size_bytes, paperless_id, file_path, content_text, analysis_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      documentId,
      account.id,
      row.id,
      analysis.title,
      analysis.correspondent,
      analysis.kind,
      input.channel,
      letterDate,
      input.receivedDate ?? now.toISOString(),
      input.pages,
      input.sizeBytes,
      input.paperlessId ?? null,
      filePath,
      input.text,
      JSON.stringify(analysis),
      nowIso(),
    );
    db.prepare('UPDATE accounts SET storage_used_bytes = storage_used_bytes + ? WHERE id = ?').run(input.sizeBytes, account.id);
    const current = db.prepare('SELECT safety_json, contact_id FROM cases WHERE id = ?').get(row.id) as { safety_json: string | null; contact_id: string | null };
    db.prepare('UPDATE cases SET safety_json = ?, contact_id = COALESCE(contact_id, ?), toy_request_json = COALESCE(?, toy_request_json) WHERE id = ?').run(
      mergeSafety(current.safety_json, safety),
      input.contactId ?? null,
      toyRequest ? JSON.stringify(toyRequest) : null,
      row.id,
    );
    addTimeline(db, row.id, `Eingegangen: ${analysis.title}${analysis.actionRequired && analysis.nextAction ? ` – ${analysis.nextAction}` : ''}`);
    return { caseRow: row, created };
  });

  // 7. Verteilen
  const summary = getCaseSummary(db, account.id, caseRow.id);
  ctx.delivery.emit(account.id, { type: 'document.analyzed', caseId: caseRow.id, documentId, usedAi, case: summary });
  if (summary.deadline && summary.status === 'action') {
    ctx.delivery.emit(account.id, { type: 'deadline.detected', caseId: caseRow.id, caseTitle: summary.title, deadline: summary.deadline });
  }

  if (safety.length) ctx.delivery.emit(account.id, { type: 'safety.warning', findings: safety, caseId: caseRow.id });

  return { documentId, caseId: caseRow.id, createdCase: created, usedAi, matchedRule: !!rule, creditsSpent, analysis, safety, toyRequest };
}

/**
 * Korrektur durch den Nutzer: Dokument umhängen oder Absender/Typ ändern.
 * Daraus entsteht eine Regel, damit der nächste gleiche Brief ohne KI und ohne Credits zugeordnet wird.
 */
export function correctDocument(
  ctx: Context,
  accountId: string,
  documentId: string,
  patch: { correspondent?: string; kind?: DocumentKind; caseId?: string },
): { ruleCreated: boolean } {
  const { db } = ctx;
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND account_id = ?').get(documentId, accountId) as
    | { id: string; case_id: string | null; correspondent: string; kind: DocumentKind; analysis_json: string | null }
    | undefined;
  if (!doc) throw new HttpError(404, 'not_found', 'Dieses Dokument gibt es nicht.');
  if (patch.caseId) getCaseRow(db, accountId, patch.caseId);

  const correspondent = patch.correspondent ?? doc.correspondent;
  const kind = patch.kind ?? doc.kind;
  const caseId = patch.caseId ?? doc.case_id;
  const analysis = doc.analysis_json ? (JSON.parse(doc.analysis_json) as Analysis) : undefined;
  // Merkmal der Regel: die Nummer ohne Bezeichnung ("4711-0815" statt "Kundennummer 4711-0815"), sonst der Absender
  const matchText = analysis?.reference ? analysis.reference.replace(/^\S+\s+/, '') : correspondent;

  return tx(db, () => {
    db.prepare('UPDATE documents SET correspondent = ?, kind = ?, case_id = ? WHERE id = ?').run(correspondent, kind, caseId, documentId);
    if (caseId && caseId !== doc.case_id) addTimeline(db, caseId, 'Dokument von Hand zugeordnet');
    if (matchText.length < 4) return { ruleCreated: false };
    const existing = db.prepare('SELECT id FROM rules WHERE account_id = ? AND lower(match_text) = lower(?)').get(accountId, matchText) as
      | { id: string }
      | undefined;
    if (existing) {
      db.prepare('UPDATE rules SET correspondent = ?, kind = ?, case_id = ? WHERE id = ?').run(correspondent, kind, caseId, existing.id);
    } else {
      db.prepare('INSERT INTO rules (id, account_id, match_text, correspondent, kind, case_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        newId('rule'),
        accountId,
        matchText,
        correspondent,
        kind,
        caseId,
        nowIso(),
      );
    }
    return { ruleCreated: true };
  });
}
