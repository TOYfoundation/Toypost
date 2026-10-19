/** Reine Kalenderdaten als 'YYYY-MM-DD', ohne Zeitzonen-Fallen. */

export function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

export function toIso(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const { y, m, d } = parseIsoDate(iso);
  return toIso(y, m, d + days);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Monatsfrist nach § 188 Abs. 2, 3 BGB: endet am Tag mit derselben Zahl im Zielmonat,
 * fehlt dieser Tag, am letzten Tag des Monats.
 */
export function addMonths(iso: string, months: number): string {
  const { y, m, d } = parseIsoDate(iso);
  const total = m - 1 + months;
  const ty = y + Math.floor(total / 12);
  const tm = (((total % 12) + 12) % 12) + 1;
  return toIso(ty, tm, Math.min(d, daysInMonth(ty, tm)));
}

export function weekday(iso: string): number {
  const { y, m, d } = parseIsoDate(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Ostersonntag nach der Gaußschen Osterformel (Gregorianisch). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toIso(year, month, day);
}

/** Bundesweite gesetzliche Feiertage. Regionale Feiertage sind hier bewusst nicht enthalten. */
export function nationalHolidays(year: number): string[] {
  const easter = easterSunday(year);
  return [
    toIso(year, 1, 1),
    addDays(easter, -2), // Karfreitag
    addDays(easter, 1), // Ostermontag
    toIso(year, 5, 1),
    addDays(easter, 39), // Christi Himmelfahrt
    addDays(easter, 50), // Pfingstmontag
    toIso(year, 10, 3),
    toIso(year, 12, 25),
    toIso(year, 12, 26),
  ];
}

export function isBusinessDay(iso: string): boolean {
  const wd = weekday(iso);
  if (wd === 0 || wd === 6) return false;
  return !nationalHolidays(parseIsoDate(iso).y).includes(iso.slice(0, 10));
}

/** Fällt ein Fristende auf Samstag, Sonntag oder Feiertag, verschiebt es sich auf den nächsten Werktag (§ 193 BGB, § 108 Abs. 3 AO). */
export function nextBusinessDay(iso: string): string {
  let cur = iso.slice(0, 10);
  while (!isBusinessDay(cur)) cur = addDays(cur, 1);
  return cur;
}

/** Ganze Tage von `from` bis `to` (beide YYYY-MM-DD). Negativ, wenn `to` vor `from` liegt. */
export function daysBetween(from: string, to: string): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

const MONTHS_DE = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
const WEEKDAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** "Mi, 18. Nov." */
export function formatDateDe(iso: string, withWeekday = true): string {
  const { m, d } = parseIsoDate(iso);
  const base = `${d}. ${MONTHS_DE[m - 1]}`;
  return withWeekday ? `${WEEKDAYS_DE[weekday(iso)]}, ${base}` : base;
}

/** "heute", "morgen", "in 3 Tagen", "seit 2 Tagen überfällig" */
export function relativeDueDe(due: string, today: string): string {
  const n = daysBetween(today, due);
  if (n === 0) return 'heute';
  if (n === 1) return 'morgen';
  if (n > 1) return `in ${n} Tagen`;
  if (n === -1) return 'seit gestern überfällig';
  return `seit ${-n} Tagen überfällig`;
}

export function formatEuro(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = (abs % 100).toString().padStart(2, '0');
  return `${neg ? '−' : ''}${euros},${rest} €`;
}

export function todayIso(now: Date = new Date(), timeZone = 'Europe/Berlin'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
