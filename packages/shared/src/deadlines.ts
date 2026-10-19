import type { Deadline, DeadlineKind } from './types.ts';
import { addDays, addMonths, formatDateDe, nextBusinessDay, toIso } from './dates.ts';

/**
 * Regelbasierte Fristen-Erkennung für deutsche Briefe.
 * Läuft vor jeder KI und kostet keine Credits; die KI ergänzt nur, was hier nicht gefunden wird.
 *
 * Rechenregeln:
 * - Tagesfristen beginnen am Tag nach dem Ereignis (§ 187 BGB), Monatsfristen nach § 188 BGB.
 * - "nach Bekanntgabe": Bescheide gelten am vierten Tag nach Aufgabe zur Post als bekannt gegeben
 *   (§ 122 Abs. 2 AO in der seit 2025 geltenden Fassung); fällt dieser Tag auf ein Wochenende oder einen Feiertag,
 *   verschiebt er sich auf den nächsten Werktag.
 * - Fällt das Fristende auf ein Wochenende oder einen bundesweiten Feiertag, endet die Frist am nächsten Werktag.
 * Das Ergebnis ist eine Hilfe, keine Rechtsberatung; die App zeigt die Rechnung immer mit an.
 */

export interface DetectOptions {
  /** Datum des Briefs (Briefkopf), YYYY-MM-DD */
  letterDate: string;
  /** Tag, an dem der Brief tatsächlich eingegangen ist, falls bekannt */
  receivedDate?: string;
}

const MONTH_NAMES: Record<string, number> = {
  januar: 1, jänner: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  ein: 1, eine: 1, einem: 1, einer: 1, eines: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6,
  sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, vierzehn: 14, einundzwanzig: 21, dreißig: 30,
};

const TRIGGER_EXPLICIT =
  /(bis\s+(?:zum\s+|spätestens\s+(?:zum\s+|am\s+)?|einschließlich\s+)?|spätestens\s+(?:am\s+|bis\s+(?:zum\s+)?)?|fällig\s+(?:am|bis(?:\s+zum)?)\s+|zahlungsziel:?\s*|zahlbar\s+bis\s+(?:zum\s+)?)/i;

const DATE_NUMERIC = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?!\d)/;
const DATE_WORDS = /(\d{1,2})\.\s?(januar|jänner|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+(\d{4})/i;

const RELATIVE =
  /(innerhalb|binnen)\s+(?:von\s+)?(\d{1,3}|[a-zäöüß]+)\s+(tag(?:en|e)?|woche(?:n)?|monat(?:en|s|e)?)(?:\s+(?:nach|ab|seit)\s+(?:dem\s+|der\s+)?(erhalt|zugang|bekanntgabe|zustellung|rechnungsdatum|datum|eingang)(?:\s+\w+)?)?/gi;

function classify(context: string): DeadlineKind {
  const c = context.toLowerCase();
  if (/(einspruch|widerspruch|rechtsbehelf|klage)/.test(c)) return 'einspruch';
  if (/(kündig)/.test(c)) return 'kuendigung';
  if (/(zahl|überweis|begleich|betrag|rechnung|lastschrift)/.test(c)) return 'zahlung';
  if (/(stellungnahme|rückmeldung|antwort|mitteil|einreich|nachreich|unterlagen|vorleg|zurücksend)/.test(c)) return 'antwort';
  return 'allgemein';
}

/** Der Satz, in dem die Fundstelle steht (Datumspunkte wie "15. Januar" zählen nicht als Satzende). */
function sentenceAround(text: string, index: number, length: number): { current: string; previous: string } {
  const boundary = /[.!?]\s+(?=[A-ZÄÖÜ])/g;
  let prevStart = 0;
  let start = 0;
  let end = text.length;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text))) {
    const pos = m.index + m[0].length;
    if (pos <= index) {
      prevStart = start;
      start = pos;
    }
    else if (m.index >= index + length) {
      end = m.index + 1;
      break;
    }
  }
  return { current: text.slice(start, end), previous: text.slice(prevStart, start) };
}

/** Erst die Fundstelle selbst ("Zahlungsziel"), dann ihr Satz, dann der Satz davor. */
function kindFor(text: string, index: number, phrase: string): DeadlineKind {
  const own = classify(phrase);
  if (own !== 'allgemein') return own;
  const { current, previous } = sentenceAround(text, index, phrase.length);
  const inSentence = classify(current);
  return inSentence !== 'allgemein' ? inSentence : classify(previous);
}

function normalizeYear(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

function parseCount(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS[token.toLowerCase()] ?? null;
}

export function detectDeadlines(text: string, opts: DetectOptions): Deadline[] {
  const found: Deadline[] = [];
  const flat = text.replace(/\s+/g, ' ');

  // 1. Ausdrückliche Daten hinter einem Signalwort ("bis zum 18.11.2026", "Zahlungsziel: 30.10.2026")
  const triggerRe = new RegExp(TRIGGER_EXPLICIT.source, 'gi');
  let t: RegExpExecArray | null;
  while ((t = triggerRe.exec(flat))) {
    const after = flat.slice(t.index + t[0].length, t.index + t[0].length + 30);
    let iso: string | null = null;
    let raw = '';
    const num = after.match(new RegExp('^' + DATE_NUMERIC.source));
    const words = after.match(new RegExp('^' + DATE_WORDS.source, 'i'));
    if (num) {
      iso = toIso(normalizeYear(num[3]), Number(num[2]), Number(num[1]));
      raw = num[0];
    } else if (words) {
      iso = toIso(Number(words[3]), MONTH_NAMES[words[2].toLowerCase()], Number(words[1]));
      raw = words[0];
    }
    if (!iso) continue;
    const phrase = (t[0] + raw).trim();
    found.push({
      date: iso,
      kind: kindFor(flat, t.index, phrase),
      phrase,
      explanation: `Datum steht so im Brief.`,
    });
  }

  // 2. Relative Fristen ("innerhalb von 14 Tagen", "binnen eines Monats nach Bekanntgabe")
  RELATIVE.lastIndex = 0;
  let r: RegExpExecArray | null;
  while ((r = RELATIVE.exec(flat))) {
    const count = parseCount(r[2]);
    if (!count) continue;
    const unit = r[3].toLowerCase();
    const event = r[4]?.toLowerCase();

    let base = opts.letterDate;
    let baseText = `ab Briefdatum ${formatDateDe(opts.letterDate)}`;
    if (event === 'bekanntgabe') {
      base = nextBusinessDay(addDays(opts.letterDate, 4));
      baseText = `Bekanntgabe gilt am ${formatDateDe(base)} (4 Tage nach Briefdatum, § 122 AO)`;
    } else if (event && ['erhalt', 'zugang', 'zustellung', 'eingang'].includes(event)) {
      base = opts.receivedDate ?? opts.letterDate;
      baseText = opts.receivedDate
        ? `ab Eingang am ${formatDateDe(base)}`
        : `ab Briefdatum ${formatDateDe(base)}, Eingangsdatum unbekannt`;
    }

    let end: string;
    let span: string;
    if (unit.startsWith('tag')) {
      end = addDays(base, count);
      span = `${count} ${count === 1 ? 'Tag' : 'Tage'}`;
    } else if (unit.startsWith('woche')) {
      end = addDays(base, count * 7);
      span = `${count} ${count === 1 ? 'Woche' : 'Wochen'}`;
    } else {
      end = addMonths(base, count);
      span = `${count} ${count === 1 ? 'Monat' : 'Monate'}`;
    }
    const shifted = nextBusinessDay(end);
    const shiftText = shifted !== end ? `, auf den nächsten Werktag verschoben` : '';
    found.push({
      date: shifted,
      kind: kindFor(flat, r.index, r[0]),
      phrase: r[0].trim(),
      explanation: `${span} ${baseText}: ${formatDateDe(shifted)}${shiftText}`,
    });
  }

  const unique = new Map<string, Deadline>();
  for (const d of found) {
    const key = `${d.date}|${d.kind}`;
    if (!unique.has(key)) unique.set(key, d);
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Die für den Nutzer wichtigste Frist: die früheste, die noch nicht abgelaufen ist, sonst die zuletzt abgelaufene. */
export function primaryDeadline(deadlines: Deadline[], today: string): Deadline | undefined {
  const open = deadlines.filter((d) => d.date >= today);
  if (open.length) return open[0];
  return deadlines.at(-1);
}
