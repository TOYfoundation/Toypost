import { addDays, formatDateDe } from './dates.ts';
import { detectDeadlines, primaryDeadline } from './deadlines.ts';
import type { CaseDetail, CaseStatus, Channel, DocumentKind, Payment } from './types.ts';

/**
 * Beispiel-Post für Demo-Modus und Seed-Daten. Alle Absender, Nummern und Personen sind erfunden;
 * die IBAN ist die offizielle Test-IBAN. Daten werden relativ zu "heute" erzeugt, damit Fristen immer aktuell wirken.
 */

export interface DemoLetter {
  key: string;
  daysAgo: number;
  channel: Channel;
  kind: DocumentKind;
  title: string;
  correspondent: string;
  text: (letterDate: string) => string;
  status: CaseStatus;
  summary: string;
  nextAction?: string;
  payment?: Payment;
  reference?: string;
  followUpInDays?: number;
}

const TEST_IBAN = 'DE89370400440532013000';

export const DEMO_LETTERS: DemoLetter[] = [
  {
    key: 'steuer',
    daysAgo: 5,
    channel: 'scan',
    kind: 'bescheid',
    title: 'Einkommensteuerbescheid 2025',
    correspondent: 'Finanzamt Bremen-Nord',
    reference: 'Steuernummer 60/123/45678',
    status: 'action',
    summary: 'Nachzahlung von 412,00 €; Einspruch ist möglich, wenn Werbungskosten fehlen.',
    nextAction: 'Bescheid prüfen, ggf. Einspruch',
    payment: { amountCents: 41200, iban: TEST_IBAN, recipient: 'Finanzamt Bremen-Nord', reference: 'St-Nr 60/123/45678 ESt 2025' },
    text: (d) => `Finanzamt Bremen-Nord
Steuernummer: 60/123/45678
Bescheid für 2025 über Einkommensteuer
Datum: ${d}

Die Einkommensteuer wird festgesetzt. Nachzahlung: 412,00 €.
Bitte zahlen Sie den Betrag bis zum ${formatPlain(addDays(d, 30))} auf das Konto IBAN DE89 3704 0044 0532 0130 00.
Rechtsbehelfsbelehrung: Gegen diesen Bescheid ist der Einspruch gegeben. Er ist innerhalb eines Monats nach Bekanntgabe einzulegen.`,
  },
  {
    key: 'strom',
    daysAgo: 9,
    channel: 'mail',
    kind: 'rechnung',
    title: 'Jahresabrechnung Strom 2026',
    correspondent: 'Weserstrom GmbH',
    reference: 'Kundennummer 4711-0815',
    status: 'action',
    summary: 'Nachzahlung 186,40 €, neuer Abschlag ab Dezember 58 € im Monat.',
    nextAction: 'Rechnung bezahlen',
    payment: { amountCents: 18640, iban: TEST_IBAN, recipient: 'Weserstrom GmbH', reference: 'Kd-Nr 4711-0815' },
    text: (d) => `Weserstrom GmbH
Kundennummer: 4711-0815
Rechnungsdatum: ${d}
Jahresabrechnung Strom
Rechnungsbetrag: 186,40 €
Der Betrag ist zahlbar innerhalb von 14 Tagen auf IBAN DE89 3704 0044 0532 0130 00.
Ihr neuer monatlicher Abschlag ab Dezember beträgt 58,00 €.`,
  },
  {
    key: 'kasse',
    daysAgo: 3,
    channel: 'scan',
    kind: 'sonstiges',
    title: 'Nachweis Arbeitsunfähigkeit angefordert',
    correspondent: 'Hanseatische Krankenkasse',
    reference: 'Versicherungsnummer H 123456789',
    status: 'action',
    summary: 'Die Kasse braucht die AU-Bescheinigung vom September, sonst ruht das Krankengeld.',
    nextAction: 'AU-Bescheinigung hochladen',
    text: (d) => `Hanseatische Krankenkasse
Versicherungsnummer: H 123456789
Datum: ${d}
Für die Zahlung des Krankengeldes fehlt uns die Arbeitsunfähigkeitsbescheinigung vom September.
Bitte senden Sie uns die Unterlagen binnen zwei Wochen zurück.`,
  },
  {
    key: 'handy',
    daysAgo: 12,
    channel: 'mail',
    kind: 'vertrag',
    title: 'Mobilfunkvertrag verlängert sich',
    correspondent: 'Nordnetz Mobil GmbH',
    reference: 'Vertragsnummer NM-2024-55871',
    status: 'action',
    summary: 'Ohne Kündigung verlängert sich der Vertrag um 12 Monate zu 29,99 € im Monat.',
    nextAction: 'Kündigen oder verlängern',
    text: (d) => `Nordnetz Mobil GmbH
Vertragsnummer: NM-2024-55871
Datum: ${d}
Ihr Vertrag endet am 31.01.2027 und verlängert sich sonst um 12 Monate zu 29,99 € monatlich.
Die Kündigung ist spätestens am 31. Dezember 2026 möglich.`,
  },
  {
    key: 'nebenkosten',
    daysAgo: 2,
    channel: 'upload',
    kind: 'information',
    title: 'Nebenkostenabrechnung 2025',
    correspondent: 'Hausverwaltung Weserblick',
    reference: 'Objekt 17 / Whg 4',
    status: 'info',
    summary: 'Guthaben 64,20 €, wird mit der Novembermiete verrechnet. Nichts zu tun.',
    text: (d) => `Hausverwaltung Weserblick
Objekt 17 / Whg 4
Datum: ${d}
Nebenkostenabrechnung 2025: Guthaben 64,20 €. Wir verrechnen das Guthaben mit der Miete für November.`,
  },
  {
    key: 'kfz',
    daysAgo: 16,
    channel: 'mail',
    kind: 'sonstiges',
    title: 'Schadensmeldung Parkrempler',
    correspondent: 'Elbe Versicherung AG',
    reference: 'Schadennummer KH-26-009141',
    status: 'waiting',
    summary: 'Unterlagen und Fotos am 4. Oktober gesendet, Rückmeldung steht aus.',
    nextAction: 'Nachhaken, falls keine Antwort',
    followUpInDays: -1,
    text: (d) => `Elbe Versicherung AG
Schadennummer: KH-26-009141
Datum: ${d}
Vielen Dank für Ihre Schadensmeldung. Bitte senden Sie uns Fotos des Schadens und den Kostenvoranschlag.`,
  },
  {
    key: 'rundfunk',
    daysAgo: 27,
    channel: 'scan',
    kind: 'rechnung',
    title: 'Rundfunkbeitrag Quartal 4',
    correspondent: 'Beitragsservice',
    reference: 'Beitragsnummer 512 345 678',
    status: 'done',
    summary: 'Per Lastschrift bezahlt.',
    text: (d) => `Beitragsservice
Beitragsnummer: 512 345 678
Datum: ${d}
Der Rundfunkbeitrag für das 4. Quartal wird per Lastschrift eingezogen.`,
  },
];

function formatPlain(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Komplette Demo-Vorgänge für den Offline-Demo-Modus der App. */
export function buildDemoCases(today: string): CaseDetail[] {
  return DEMO_LETTERS.map((l, i) => {
    const letterDate = addDays(today, -l.daysAgo);
    const text = l.text(letterDate);
    const deadlines = detectDeadlines(text, { letterDate });
    const deadline = l.status === 'action' ? primaryDeadline(deadlines, today) : undefined;
    const id = `demo_${l.key}`;
    const timeline = [
      { at: `${letterDate}T09:12:00.000Z`, text: `Eingegangen: ${l.title}` },
      ...(l.status === 'waiting' ? [{ at: `${addDays(letterDate, 2)}T17:40:00.000Z`, text: 'Antwort mit Fotos und Kostenvoranschlag gesendet' }] : []),
      ...(l.status === 'done' ? [{ at: `${addDays(letterDate, 1)}T08:00:00.000Z`, text: 'Vorgang als erledigt markiert' }] : []),
    ];
    return {
      id,
      title: l.title,
      correspondent: l.correspondent,
      status: l.status,
      summary: l.summary,
      nextAction: l.nextAction,
      deadline,
      payment: l.status === 'action' ? l.payment : undefined,
      reference: l.reference,
      updatedAt: `${letterDate}T09:12:00.000Z`,
      documentCount: l.status === 'waiting' ? 2 : 1,
      confidence: i === 2 ? 0.74 : 0.93,
      followUpOn: l.followUpInDays !== undefined ? addDays(today, l.followUpInDays) : undefined,
      documents: [
        {
          id: `${id}_doc1`,
          caseId: id,
          title: l.title,
          correspondent: l.correspondent,
          kind: l.kind,
          channel: l.channel,
          receivedAt: `${letterDate}T09:12:00.000Z`,
          pages: l.kind === 'bescheid' ? 4 : 1,
          direction: 'in' as const,
        },
        ...(l.status === 'waiting'
          ? [
              {
                id: `${id}_doc2`,
                caseId: id,
                title: 'Antwort mit Fotos und Kostenvoranschlag',
                correspondent: l.correspondent,
                kind: 'sonstiges' as const,
                channel: 'mail' as const,
                receivedAt: `${addDays(letterDate, 2)}T17:40:00.000Z`,
                pages: 3,
                direction: 'out' as const,
              },
            ]
          : []),
      ],
      timeline: timeline.reverse(),
    };
  });
}

export function demoLetterText(key: string, today: string): string {
  const l = DEMO_LETTERS.find((x) => x.key === key);
  return l ? l.text(addDays(today, -l.daysAgo)) : '';
}

export const DEMO_CREDITS = { total: 372, plan: 272, purchased: 100, monthlyGrant: 400 } as const;

/** Lesbares Datum für Erklärungen in der Oberfläche. */
export const demoDateLabel = formatDateDe;
