import type { CaseSummary, Deadline } from '../shared.ts';

/**
 * Nextcloud über WebDAV (Dateien) und CalDAV (Fristen als Termine, Vorgänge als Aufgaben). Anmeldung mit App-Passwort.
 *
 * Dokufy beschreibt jede Änderung als "DAV-Schreibvorgang" (Pfad + Inhalt). Diese Schreibvorgänge führt entweder
 * Dokufy selbst aus oder – wenn n8n verbunden ist – n8n. Alle Kalenderobjekte haben feste UIDs; erneutes Schreiben
 * aktualisiert also, statt Duplikate anzulegen.
 */

export interface NextcloudConfig {
  url: string;
  user: string;
  appPassword: string;
  /** Kalender für Fristen und Aufgaben, z. B. "dokufy" */
  calendar: string;
  /** Ordner für Entwürfe, z. B. "Dokufy" */
  folder: string;
}

/** Ein Schreibvorgang relativ zu <nextcloud>/remote.php/dav/ */
export interface DavWrite {
  path: string;
  contentType: string;
  content: string;
}

const KIND_LABEL: Record<Deadline['kind'], string> = {
  zahlung: 'Zahlung',
  einspruch: 'Einspruchsfrist',
  antwort: 'Antwort fällig',
  kuendigung: 'Kündigungsfrist',
  allgemein: 'Frist',
};

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function wrap(component: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dokufy//DE', ...component, 'END:VCALENDAR'].join('\r\n');
}

export function deadlineUid(caseId: string, d: Deadline): string {
  return `dokufy-${caseId}-${d.kind}`;
}

export function taskUid(caseId: string): string {
  return `dokufy-${caseId}-aufgabe`;
}

/** Ganztägiger Termin mit Erinnerungen 7, 3 und 1 Tag vorher. Abgesagt, sobald der Vorgang erledigt ist. */
export function buildDeadlineIcs(uid: string, caseTitle: string, d: Deadline, link?: string, cancelled = false): string {
  const day = d.date.replace(/-/g, '');
  const next = new Date(`${d.date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const dayAfter = next.toISOString().slice(0, 10).replace(/-/g, '');
  const alarms = cancelled
    ? []
    : [7, 3, 1].map((n) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(caseTitle)}`, `TRIGGER:-P${n}D`, 'END:VALARM'].join('\r\n'));
  return wrap([
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp()}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${dayAfter}`,
    `SUMMARY:${icsEscape(`${KIND_LABEL[d.kind]}: ${caseTitle}`)}`,
    `DESCRIPTION:${icsEscape(`${d.explanation}\nTextstelle: „${d.phrase}“${link ? `\n${link}` : ''}`)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'CATEGORIES:Dokufy',
    ...alarms,
    'END:VEVENT',
  ]);
}

/** Aufgabe je Vorgang (erscheint in Nextcloud Tasks und auf dem Telefon, z. B. über DAVx⁵ oder iOS-Erinnerungen). */
export function buildTaskIcs(c: CaseSummary, link?: string): string {
  const done = c.status === 'done' || c.status === 'info';
  const waiting = c.status === 'waiting';
  const due = waiting ? c.followUpOn : c.deadline?.date;
  const summary = waiting ? `Nachhaken: ${c.title}` : `${c.nextAction ?? 'Prüfen'}: ${c.title}`;
  const description = [c.summary, c.correspondent, c.reference, c.payment ? `Betrag: ${(c.payment.amountCents / 100).toFixed(2).replace('.', ',')} €, IBAN ${c.payment.iban}` : undefined, link]
    .filter(Boolean)
    .join('\n');
  const soon = due ? (Date.parse(`${due}T00:00:00Z`) - Date.now()) / 86_400_000 <= 3 : false;
  return wrap([
    'BEGIN:VTODO',
    `UID:${taskUid(c.id)}`,
    `DTSTAMP:${stamp()}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    ...(due ? [`DUE;VALUE=DATE:${due.replace(/-/g, '')}`] : []),
    `PRIORITY:${soon ? 1 : 5}`,
    ...(done ? ['STATUS:COMPLETED', 'PERCENT-COMPLETE:100', `COMPLETED:${stamp()}`] : ['STATUS:NEEDS-ACTION']),
    'CATEGORIES:Dokufy',
    'END:VTODO',
  ]);
}

function seg(s: string): string {
  return encodeURIComponent(s);
}

export function calendarObjectPath(cfg: NextcloudConfig, uid: string): string {
  return `calendars/${seg(cfg.user)}/${seg(cfg.calendar)}/${seg(uid)}.ics`;
}

export function draftFilePath(cfg: NextcloudConfig, fileName: string): string {
  return `files/${seg(cfg.user)}/${seg(cfg.folder)}/${seg('Entwürfe')}/${seg(fileName)}`;
}

export function draftFileName(date: string, caseTitle: string): string {
  const safe = caseTitle.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${date} ${safe}.md`;
}

export class NextcloudClient {
  private readonly cfg: NextcloudConfig;
  private readonly base: string;
  private readonly auth: string;

  constructor(cfg: NextcloudConfig) {
    this.cfg = cfg;
    this.base = cfg.url.replace(/\/$/, '');
    this.auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString('base64');
  }

  private async dav(method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
    const res = await fetch(`${this.base}/remote.php/dav/${path.replace(/^\//, '')}`, {
      method,
      body,
      headers: { Authorization: this.auth, ...headers },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 405 /* MKCOL auf vorhandenen Ordner */) {
      throw new Error(`Nextcloud antwortete mit ${res.status} auf ${method} ${path}`);
    }
    return res;
  }

  async test(): Promise<void> {
    await this.dav('PROPFIND', `files/${seg(this.cfg.user)}/`, undefined, { Depth: '0' });
  }

  /** Führt einen vorbereiteten Schreibvorgang aus. */
  async write(w: DavWrite): Promise<void> {
    await this.dav('PUT', w.path, w.content, { 'content-type': w.contentType });
  }

  /** Legt den Entwurfsordner an (idempotent). */
  async ensureDraftFolder(): Promise<void> {
    const user = seg(this.cfg.user);
    await this.dav('MKCOL', `files/${user}/${seg(this.cfg.folder)}`);
    await this.dav('MKCOL', `files/${user}/${seg(this.cfg.folder)}/${seg('Entwürfe')}`);
  }
}
