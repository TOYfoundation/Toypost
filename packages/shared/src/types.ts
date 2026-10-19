/** Gemeinsame Typen für App und API. Datumswerte sind ISO-Strings (YYYY-MM-DD oder volle Zeitstempel). */

export type PlanId = 'free' | 'pro' | 'team' | 'enterprise';

/** Was ein Vorgang vom Nutzer braucht. */
export type CaseStatus =
  | 'action' // Handlung nötig (zahlen, antworten, entscheiden)
  | 'waiting' // eigene Antwort ist raus, wir warten auf die Gegenseite
  | 'info' // nur zur Kenntnis, nichts zu tun
  | 'done'; // erledigt

export type DocumentKind =
  | 'rechnung'
  | 'mahnung'
  | 'bescheid'
  | 'vertrag'
  | 'kuendigung'
  | 'kontoauszug'
  | 'information'
  | 'sonstiges';

export type Channel = 'scan' | 'mail' | 'upload' | 'nextcloud';

export type DeadlineKind = 'zahlung' | 'einspruch' | 'antwort' | 'kuendigung' | 'allgemein';

export interface Deadline {
  /** Fälliges Datum, YYYY-MM-DD */
  date: string;
  kind: DeadlineKind;
  /** Textstelle, aus der die Frist stammt */
  phrase: string;
  /** Erklärung, wie gerechnet wurde, für den Nutzer sichtbar */
  explanation: string;
}

export interface Payment {
  amountCents: number;
  iban: string;
  recipient: string;
  reference?: string;
  bic?: string;
}

export interface DocumentSummary {
  id: string;
  caseId: string | null;
  title: string;
  correspondent: string;
  kind: DocumentKind;
  channel: Channel;
  receivedAt: string;
  pages: number;
  paperlessId?: number;
  /** Richtung: eingegangen oder von uns versendet */
  direction: 'in' | 'out';
}

export interface CaseSummary {
  id: string;
  title: string;
  correspondent: string;
  status: CaseStatus;
  /** Kurzfassung der KI in einem Satz */
  summary: string;
  /** Nächste Handlung als Verb-Phrase, z. B. "Einspruch prüfen" */
  nextAction?: string;
  deadline?: Deadline;
  payment?: Payment;
  reference?: string;
  updatedAt: string;
  documentCount: number;
  assigneeName?: string;
  /** 0..1, wie sicher sich die KI bei Zuordnung und Extraktion ist */
  confidence: number;
  /** Datum, an dem Dokufy nachhaken soll, wenn keine Antwort kam */
  followUpOn?: string;
}

export interface CaseDetail extends CaseSummary {
  documents: DocumentSummary[];
  timeline: { at: string; text: string }[];
  draft?: { id: string; subject: string; body: string; createdAt: string };
}

/** Strukturierte Ausgabe der KI-Auswertung eines Dokuments. */
export interface Analysis {
  kind: DocumentKind;
  correspondent: string;
  title: string;
  summary: string;
  actionRequired: boolean;
  nextAction?: string;
  deadlines: Deadline[];
  payment?: Payment;
  reference?: string;
  /** Vorschlag für den Vorgang, dem das Dokument zugeordnet wird */
  caseHint?: string;
  confidence: number;
}

export interface CreditBalance {
  /** Gesamt in Credits (Dezimal möglich, z. B. 12.5) */
  total: number;
  plan: number;
  purchased: number;
  monthlyGrant: number;
  /** Ende des aktuellen Abrechnungsmonats */
  planResetsOn: string;
}

export interface Account {
  id: string;
  name: string;
  email: string;
  plan: PlanId;
  seats: number;
  storageUsedBytes: number;
  credits: CreditBalance;
}
