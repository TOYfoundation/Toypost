import type { Deadline } from '../shared.ts';

/** Nextcloud über WebDAV (Dateien) und CalDAV (Fristen als Kalendereinträge). Anmeldung mit App-Passwort. */

export interface NextcloudConfig {
  url: string;
  user: string;
  appPassword: string;
  /** Kalender für Fristen, z. B. "personal" */
  calendar: string;
  /** Ordner für Entwürfe und Vorgänge, z. B. "Dokufy" */
  folder: string;
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

/** Ganztägiger Termin mit Erinnerungen 7, 3 und 1 Tag vorher. */
export function buildDeadlineIcs(uid: string, caseTitle: string, d: Deadline, link?: string): string {
  const day = d.date.replace(/-/g, '');
  const next = new Date(`${d.date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const dayAfter = next.toISOString().slice(0, 10).replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const alarms = [7, 3, 1]
    .map((n) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(caseTitle)}`, `TRIGGER:-P${n}D`, 'END:VALARM'].join('\r\n'))
    .join('\r\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dokufy//Fristen//DE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${dayAfter}`,
    `SUMMARY:${icsEscape(`${KIND_LABEL[d.kind]}: ${caseTitle}`)}`,
    `DESCRIPTION:${icsEscape(`${d.explanation}\nTextstelle: „${d.phrase}“${link ? `\n${link}` : ''}`)}`,
    'CATEGORIES:Dokufy',
    alarms,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
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
    const res = await fetch(`${this.base}/remote.php/dav${path}`, {
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
    await this.dav('PROPFIND', `/files/${encodeURIComponent(this.cfg.user)}/`, undefined, { Depth: '0' });
  }

  /** Legt eine Datei im Dokufy-Ordner ab, z. B. einen Antwortentwurf. */
  async putFile(relativePath: string, data: string | Uint8Array, mime = 'text/plain; charset=utf-8'): Promise<string> {
    const user = encodeURIComponent(this.cfg.user);
    const parts = [this.cfg.folder, ...relativePath.split('/').slice(0, -1)].filter(Boolean);
    let acc = '';
    for (const p of parts) {
      acc += `/${encodeURIComponent(p)}`;
      await this.dav('MKCOL', `/files/${user}${acc}`);
    }
    const target = `/files/${user}/${[this.cfg.folder, ...relativePath.split('/')].map(encodeURIComponent).join('/')}`;
    await this.dav('PUT', target, data, { 'content-type': mime });
    return target;
  }

  /** Schreibt eine Frist in den Kalender. Gleiche UID = Aktualisierung statt Duplikat. */
  async upsertDeadline(uid: string, caseTitle: string, d: Deadline, link?: string): Promise<void> {
    const path = `/calendars/${encodeURIComponent(this.cfg.user)}/${encodeURIComponent(this.cfg.calendar)}/${encodeURIComponent(uid)}.ics`;
    await this.dav('PUT', path, buildDeadlineIcs(uid, caseTitle, d, link), { 'content-type': 'text/calendar; charset=utf-8' });
  }
}
