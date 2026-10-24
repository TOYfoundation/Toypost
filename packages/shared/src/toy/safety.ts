import { findAddresses, lookalikeOf } from './address.ts';
import { TOYVERSE } from './toyverse-data.ts';

/**
 * Safety checks for correspondence in the Toy ecosystem. They follow the wallet rules
 * (TOYPAY concept 7a/7b/7c): a recovery phrase or private key is never shared, look-alike addresses are traps,
 * and tokens named ToyCoin on other chains are NOT ToyChain TOY (spec v0.3, section 11; decision 63).
 *
 * Findings are warnings for the user, never automatic actions on money. Outgoing messages with an apparent
 * secret are blocked before sending; incoming messages are flagged.
 */

export type SafetySeverity = 'block' | 'red' | 'yellow';

export interface SafetyFinding {
  code:
    | 'secret_phrase'
    | 'private_key'
    | 'asks_for_secret'
    | 'legacy_token'
    | 'lookalike_address'
    | 'fake_airdrop'
    | 'urgency_wallet';
  severity: SafetySeverity;
  /** German explanation for the user, plain language */
  message: string;
  evidence?: string;
}

/**
 * Old ERC-20 tokens called ToyCoin/TOY. Checked with Etherscan on 19.10.2026: both deployed by
 * 0x18da0be974424d54519c63f62e4b26c0318c00c2 in July 2022, not connected to ToyChain (toycoin docs/02, decision 63).
 */
export const LEGACY_TOKENS: readonly { chainId: number; chain: string; address: string }[] = TOYVERSE.legacyTokens.map(
  ({ chainId, chain, address }) => ({ chainId, chain, address }),
);

// Words around secrets in the languages most likely to appear in correspondence (de, en, fr, es, pt, it, nl, tr, pl).
const SECRET_WORDS =
  /(seed|mnemonic|recovery|wiederherstellung|phrase|schlüsselwörter|merkwörter|secret|geheim|private ?key|privater? schlüssel|clé privée|phrase de récupération|frase (semilla|de recuperación)|chave privada|frase de recuperação|chiave privata|herstelzin|kurtarma|fraza odzyskiwania)/i;

const ASK_WORDS =
  /(send|share|enter|confirm|verify|validate|sync|provide|type|gib|teile|sende|schick|eingeben|bestätige|bestätigen|verifizier|envoyez|saisissez|confirmez|envía|introduce|verifica|envie|digite|confirme)/i;

const AIRDROP = /(airdrop|claim (your|now)|free toy|gratis[- ]?toy|kostenlose toy|giveaway|bonus.{0,20}toy|double your)/i;
const URGENCY = /(sofort|umgehend|innerhalb von \d+ (stunden|minuten)|letzte (warnung|chance)|gesperrt|suspend|urgent|immediately|within \d+ hours|last chance|locked|blocked)/i;
const WALLET = /(wallet|toypay|metamask|konto|account|toy\b|toycoin)/i;

/**
 * A run of 12, 15, 18, 21 or 24 short lowercase words, optionally numbered ("1. word 2. word" or one per line),
 * looks like a BIP-39 recovery phrase. Without the official word list this is a heuristic; it is combined with
 * context words to keep false alarms low, except for numbered lists, which are almost always phrases.
 */
function findPhraseLike(text: string): string | undefined {
  const tokens = text
    .replace(/\b\d{1,2}[.):]\s*/g, ' ')
    .split(/[\s,;]+/)
    .filter(Boolean);
  let run: string[] = [];
  const check = (): string | undefined => {
    if ([12, 15, 18, 21, 24].some((n) => run.length >= n)) return run.slice(0, 3).join(' ') + ' …';
    return undefined;
  };
  for (const t of tokens) {
    if (/^[a-z]{3,8}$/.test(t)) {
      run.push(t);
    } else {
      const hit = check();
      if (hit) return hit;
      run = [];
    }
  }
  return check();
}

function hasNumberedWordList(text: string): boolean {
  const items = text.match(/(?:^|\s)(\d{1,2})[.)]\s*[a-z]{3,8}\b/g) ?? [];
  return items.length >= 12;
}

function findPrivateKey(text: string): string | undefined {
  for (const m of text.matchAll(/(?<![0-9a-fA-Fx])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) {
    const start = Math.max(0, (m.index ?? 0) - 60);
    const context = text.slice(start, (m.index ?? 0) + m[0].length + 20);
    // 64 hex characters are also transaction hashes; only context words make it a key
    if (/(private|privat|secret|geheim|key|schlüssel|clé|clave|chave)/i.test(context) && !/(tx|transaction|transaktion|hash|block)/i.test(context)) {
      return `${m[0].slice(0, 6)}…`;
    }
  }
  return undefined;
}

export interface SafetyInput {
  text: string;
  direction: 'in' | 'out';
  /** addresses the user knows (address book, own addresses) for the look-alike check */
  knownAddresses?: readonly string[];
}

export function checkSafety({ text, direction, knownAddresses = [] }: SafetyInput): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  const phrase = findPhraseLike(text);
  const phraseContext = SECRET_WORDS.test(text) || hasNumberedWordList(text);
  if (phrase && phraseContext) {
    findings.push({
      code: 'secret_phrase',
      severity: direction === 'out' ? 'block' : 'red',
      message:
        direction === 'out'
          ? 'Diese Nachricht enthält offenbar eine Wiederherstellungsphrase. ToyPost sendet sie nicht. Wer die Phrase kennt, kann alles TOY dieses Kontos nehmen.'
          : 'Diese Nachricht enthält offenbar eine Wiederherstellungsphrase. Lösche sie und richte ein neues Konto ein, wenn es deine ist.',
      evidence: phrase,
    });
  }
  const key = findPrivateKey(text);
  if (key) {
    findings.push({
      code: 'private_key',
      severity: direction === 'out' ? 'block' : 'red',
      message:
        direction === 'out'
          ? 'Diese Nachricht enthält offenbar einen privaten Schlüssel. ToyPost sendet sie nicht.'
          : 'Diese Nachricht enthält offenbar einen privaten Schlüssel. Ein Schlüssel, der einmal verschickt wurde, gilt als verloren.',
      evidence: key,
    });
  }
  if (direction === 'in' && SECRET_WORDS.test(text) && ASK_WORDS.test(text) && !phrase) {
    findings.push({
      code: 'asks_for_secret',
      severity: 'red',
      message: 'Die Nachricht verlangt eine Phrase oder einen Schlüssel. Niemand Seriöses fragt danach, auch nicht das ToyChain-Team. Das ist Betrug.',
    });
  }
  const addresses = findAddresses(text);
  for (const t of LEGACY_TOKENS) {
    if (addresses.some((a) => a.toLowerCase() === t.address.toLowerCase())) {
      findings.push({
        code: 'legacy_token',
        severity: 'yellow',
        message: `Die Nachricht nennt den alten ToyCoin-Token auf ${t.chain}. Er ist nicht ToyChain-TOY und nicht eintauschbar.`,
        evidence: t.address,
      });
    }
  }
  for (const a of addresses) {
    const similar = lookalikeOf(a, knownAddresses);
    if (similar) {
      findings.push({
        code: 'lookalike_address',
        severity: 'red',
        message: `Die Adresse ${a} sieht aus wie eine bekannte Adresse (${similar}), ist aber eine andere. Typische Adress-Falle: nicht dorthin zahlen.`,
        evidence: a,
      });
    }
  }
  if (direction === 'in' && AIRDROP.test(text)) {
    findings.push({
      code: 'fake_airdrop',
      severity: 'red',
      message: 'Versprochene Geschenke oder Airdrops sind ein typischer Betrug. ToyChain hat keine Airdrops: Alle TOY entstehen über die Emission.',
    });
  }
  if (direction === 'in' && URGENCY.test(text) && WALLET.test(text) && findings.length === 0) {
    findings.push({
      code: 'urgency_wallet',
      severity: 'yellow',
      message: 'Die Nachricht macht Druck rund um ein Konto oder eine Wallet. Prüfe den Absender, bevor du etwas tust.',
    });
  }
  return findings;
}

export function blocksSending(findings: readonly SafetyFinding[]): boolean {
  return findings.some((f) => f.severity === 'block');
}

/** Replaces apparent secrets with a placeholder before text is logged, stored in plain form or sent to an AI. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(?<![0-9a-fA-Fx])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, (m, _p, offset: number, all: string) => {
      const context = all.slice(Math.max(0, offset - 60), offset);
      return /(private|privat|secret|geheim|key|schlüssel)/i.test(context) ? '[Schlüssel entfernt]' : m;
    })
    .replace(/((?:\b\d{1,2}[.)]\s*)?\b[a-z]{3,8}\b[\s,]+){11,}(?:\d{1,2}[.)]\s*)?\b[a-z]{3,8}\b/g, (m, _g, offset: number, all: string) => {
      const context = all.slice(Math.max(0, offset - 80), offset + m.length);
      return SECRET_WORDS.test(context) || /\b\d{1,2}[.)]/.test(m) ? '[Phrase entfernt]' : m;
    });
}
