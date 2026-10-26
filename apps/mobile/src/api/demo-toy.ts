import { buildPaymentLink, parseToy, type CaseDetail, type ContactSummary, type MessageSummary, type ToyInvoiceSummary } from '@toypost/shared';
import type { AutomationInfo, BroadcastInfo, ChannelInfo, ChannelKindInfo, PresetInfo, ToyOverview } from './types.ts';

/**
 * Demo data for ToyPost's channels and the Toy projects: an SMS with a TOY payment request, a Telegram photo,
 * a phishing e-mail, a project blog entry, a milestone announcement waiting for approval.
 * The milestone list mirrors toycoin docs/STATUS.md (as of 18.10.2026).
 */

const ANNA_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const OWN_ADDRESS = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

export const DEMO_CHANNEL_KINDS: ChannelKindInfo[] = [
  { kind: 'email', label: 'E-Mail', canSend: true, polled: false, handleLabel: 'E-Mail-Adresse' },
  { kind: 'telegram', label: 'Telegram', canSend: true, polled: false, handleLabel: 'Chat-ID' },
  { kind: 'matrix', label: 'Matrix / Element', canSend: true, polled: false, handleLabel: 'Raum-ID (!abc:server)' },
  { kind: 'signal', label: 'Signal', canSend: true, polled: false, handleLabel: 'Telefonnummer (+49…)' },
  { kind: 'sms', label: 'SMS', canSend: true, polled: false, handleLabel: 'Telefonnummer (+49…)' },
  { kind: 'ntfy', label: 'Mitteilungen (ntfy / UnifiedPush)', canSend: true, polled: false },
  { kind: 'talk', label: 'Nextcloud Talk', canSend: true, polled: false, handleLabel: 'Unterhaltungs-Token' },
  { kind: 'discord', label: 'Discord', canSend: true, polled: false },
  { kind: 'slack', label: 'Slack', canSend: true, polled: false },
  { kind: 'webhook', label: 'Webhook', canSend: true, polled: false },
  { kind: 'feed', label: 'Datenfeed (RSS, Atom, JSON)', canSend: false, polled: true },
  { kind: 'github', label: 'GitHub-Projekt', canSend: false, polled: true },
  { kind: 'toyscan', label: 'ToyScan und ToyChain', canSend: false, polled: true },
];

export function demoChannels(day: string): ChannelInfo[] {
  const at = `${day}T08:55:00.000Z`;
  return [
    { id: 'ch_mail', kind: 'email', kindLabel: 'E-Mail', name: 'Projekt-Mail', enabled: true, canSend: true, polled: false, handleLabel: 'E-Mail-Adresse', summary: 'team@toycoin.example über mail.example', inboundUrl: 'https://toypost.example/v1/inbox/ch_mail?token=…' },
    { id: 'ch_tg', kind: 'telegram', kindLabel: 'Telegram', name: 'ToyCoin-Bot', enabled: true, canSend: true, polled: false, handleLabel: 'Chat-ID', summary: 'Bot 7412…', inboundUrl: 'https://toypost.example/v1/inbox/ch_tg?token=…' },
    { id: 'ch_sms', kind: 'sms', kindLabel: 'SMS', name: 'Projekt-Handy', enabled: true, canSend: true, polled: false, handleLabel: 'Telefonnummer (+49…)', summary: 'Android-Gateway 192.168.1.40:8080', inboundUrl: 'https://toypost.example/v1/inbox/ch_sms?token=…' },
    { id: 'ch_push', kind: 'ntfy', kindLabel: 'Mitteilungen (ntfy / UnifiedPush)', name: 'Push an mich', enabled: true, canSend: true, polled: false, summary: 'ntfy.sh/toypost-team' },
    { id: 'ch_gh', kind: 'github', kindLabel: 'GitHub-Projekt', name: 'toycoin', enabled: true, canSend: false, polled: true, summary: 'TOYfoundation/toycoin (main), alle 15 Min.', lastPollAt: at },
    { id: 'ch_scan', kind: 'toyscan', kindLabel: 'ToyScan und ToyChain', name: 'ToyScan Testnet', enabled: true, canSend: false, polled: true, summary: 'scan.toycoin.example, 1 Adresse', lastPollAt: at },
    { id: 'ch_feed', kind: 'feed', kindLabel: 'Datenfeed (RSS, Atom, JSON)', name: 'Projekt-Blog', enabled: true, canSend: false, polled: true, summary: 'blog.toycoin.example, alle 30 Min.', lastPollAt: at },
  ];
}

export function demoContacts(): ContactSummary[] {
  return [
    { id: 'ct_anna', name: 'Anna Tester', language: 'en', toyAddress: ANNA_ADDRESS, tags: ['Tester'], handles: [{ kind: 'sms', handle: '+491701234567' }, { kind: 'email', handle: 'anna@example.org' }], openCases: 1 },
    { id: 'ct_baraka', name: 'Baraka', language: 'sw', tags: ['Tester', 'Community'], handles: [{ kind: 'sms', handle: '+255712345678' }], openCases: 0 },
    { id: 'ct_kofi', name: 'Kofi', language: 'ak', tags: ['Community'], handles: [{ kind: 'telegram', handle: '77' }], openCases: 1 },
    { id: 'ct_fake', name: 'TOYPAY Support', language: 'de', tags: [], handles: [{ kind: 'email', handle: 'support@toypay-sicherheit.example' }], openCases: 1 },
  ];
}

export function demoToyCases(day: string): CaseDetail[] {
  const amount = parseToy('12.5').toString();
  const link = buildPaymentLink({ address: ANNA_ADDRESS, amount: parseToy('12.5'), purpose: 'Testnet QA Oktober' });
  const msg = (m: Partial<MessageSummary> & Pick<MessageSummary, 'id' | 'channelKind' | 'body' | 'createdAt'>): MessageSummary => ({
    direction: 'in',
    preview: m.body.replace(/\s+/g, ' ').slice(0, 140),
    status: 'received',
    safety: [],
    ...m,
  });
  const anna: CaseDetail = {
    id: 'demo_anna',
    title: 'Rechnung Testnet-Prüfung',
    correspondent: 'Anna Tester',
    status: 'action',
    summary: 'Anna hat die Testnet-Wallet geprüft und bittet um 12,5 TOY mit dem Verwendungszweck „Testnet QA Oktober“.',
    nextAction: '12,5 TOY in der TOYPAY Wallet prüfen und zahlen',
    updatedAt: `${day}T07:42:00.000Z`,
    documentCount: 1,
    confidence: 0.92,
    contact: { id: 'ct_anna', name: 'Anna Tester' },
    toyRequest: { address: ANNA_ADDRESS, amount, purpose: 'Testnet QA Oktober', link },
    documents: [],
    messages: [
      msg({
        id: 'msg_anna1',
        channelKind: 'sms',
        channelName: 'Projekt-Handy',
        contact: { id: 'ct_anna', name: 'Anna Tester' },
        caseId: 'demo_anna',
        body: `Hi! I finished testing the wallet on the testnet. Please pay 12.5 TOY: ${link}`,
        language: 'en',
        createdAt: `${day}T07:42:00.000Z`,
      }),
    ],
    timeline: [{ at: `${day}T07:42:00.000Z`, text: 'Eingegangen: SMS von Anna Tester' }],
  };
  const scam: CaseDetail = {
    id: 'demo_phishing',
    title: 'Konto gesperrt',
    correspondent: 'TOYPAY Support',
    status: 'action',
    summary: 'Eine angebliche Support-Mail verlangt die Wiederherstellungsphrase, sonst werde das Konto gesperrt.',
    nextAction: 'Warnung lesen: möglicher Betrug',
    updatedAt: `${day}T06:10:00.000Z`,
    documentCount: 1,
    confidence: 0.95,
    contact: { id: 'ct_fake', name: 'TOYPAY Support' },
    safety: [
      { code: 'asks_for_secret', severity: 'red', message: 'Die Nachricht verlangt eine Phrase oder einen Schlüssel. Niemand Seriöses fragt danach, auch nicht das ToyChain-Team. Das ist Betrug.' },
    ],
    documents: [],
    messages: [
      msg({
        id: 'msg_scam',
        channelKind: 'email',
        channelName: 'Projekt-Mail',
        contact: { id: 'ct_fake', name: 'TOYPAY Support' },
        caseId: 'demo_phishing',
        subject: 'Konto gesperrt',
        body: 'Ihr TOYPAY-Konto wird in 24 Stunden gesperrt. Bitte bestätigen Sie sofort Ihre Wiederherstellungsphrase über unser Formular.',
        safety: [{ code: 'asks_for_secret', severity: 'red', message: 'Die Nachricht verlangt eine Phrase oder einen Schlüssel. Das ist Betrug.' }],
        createdAt: `${day}T06:10:00.000Z`,
      }),
    ],
    timeline: [{ at: `${day}T06:10:00.000Z`, text: 'Eingegangen: E-Mail „Konto gesperrt“ – Betrugswarnung' }],
  };
  const kofi: CaseDetail = {
    id: 'demo_kofi',
    title: 'Foto: Brief vom Finanzamt',
    correspondent: 'Kofi',
    status: 'info',
    summary: 'Kofi hat über Telegram ein Foto eines Briefs geschickt; Paperless liest es gerade.',
    updatedAt: `${day}T05:30:00.000Z`,
    documentCount: 0,
    confidence: 0.8,
    contact: { id: 'ct_kofi', name: 'Kofi' },
    documents: [],
    messages: [
      msg({
        id: 'msg_kofi',
        channelKind: 'telegram',
        channelName: 'ToyCoin-Bot',
        contact: { id: 'ct_kofi', name: 'Kofi' },
        caseId: 'demo_kofi',
        body: 'Foto vom Brief 📄',
        language: 'ak',
        createdAt: `${day}T05:30:00.000Z`,
      }),
    ],
    timeline: [{ at: `${day}T05:30:00.000Z`, text: 'Foto über Telegram an Paperless zur Texterkennung' }],
  };
  return [anna, scam, kofi];
}

export function demoFeedMessages(day: string): MessageSummary[] {
  return [
    {
      id: 'msg_feed',
      channelKind: 'feed',
      channelName: 'Projekt-Blog',
      direction: 'in',
      subject: 'Lokales Testnet: erste Knoten laufen',
      preview: 'Die ersten drei Knoten laufen im lokalen Testnet. Wer mittesten will, meldet sich per Telegram.',
      body: 'Die ersten drei Knoten laufen im lokalen Testnet. Wer mittesten will, meldet sich per Telegram.\n\nhttps://blog.toycoin.example/testnet',
      status: 'received',
      safety: [],
      createdAt: `${day}T04:00:00.000Z`,
    },
    {
      id: 'msg_out1',
      channelKind: 'sms',
      channelName: 'Projekt-Handy',
      direction: 'out',
      contact: { id: 'ct_baraka', name: 'Baraka' },
      preview: '[sw] Maendeleo: Hatua ya M1 imekamilika …',
      body: '[sw] Maendeleo: Hatua ya M1 imekamilika – aina za msingi na utoaji wa TOY.',
      status: 'sent',
      safety: [],
      language: 'sw',
      createdAt: `${day}T03:20:00.000Z`,
    },
  ];
}

export function demoOverview(invoices: ToyInvoiceSummary[], pending: number): ToyOverview {
  return {
    ampel: { color: 'gruen', bigRedLamp: false, checkedAt: new Date().toISOString() },
    milestones: [
      { id: 'Start', title: 'Rust-Workspace, leere Crates, CI, STATUS.md', status: '✅ fertig', done: true },
      { id: 'M1', title: 'Grundtypen und Emission, Genesis ohne Guthaben', status: '✅ fertig (18.10.2026)', done: true },
      { id: 'M2', title: 'Kryptografie und Adressen', status: '⏳ offen, nächster Schritt', done: false },
      { id: 'M3', title: 'Zustand, Transaktionen, Kontingent, Gebühren', status: '⏳ offen', done: false },
      { id: 'M7', title: 'JSON-RPC und toy_-Methoden', status: '⏳ offen', done: false },
      { id: 'M11', title: 'ToyScan und andere Ketten', status: '⏳ offen', done: false },
    ],
    invoices: { open: invoices.filter((i) => i.status === 'open' || i.status === 'partial').length, paid: invoices.filter((i) => i.status === 'paid').length, list: invoices },
    pendingBroadcasts: pending,
    languages: 45,
  };
}

export function demoInvoice(code: string, amount: string, label: string, status: ToyInvoiceSummary['status'] = 'open'): ToyInvoiceSummary {
  const purpose = `TP-${code} ${label}`.slice(0, 32);
  const units = parseToy(amount);
  return {
    id: `inv_${code}`,
    code,
    address: OWN_ADDRESS,
    amount: units.toString(),
    paid: status === 'paid' ? units.toString() : '0',
    purpose,
    status,
    link: buildPaymentLink({ address: OWN_ADDRESS, amount: units, purpose }),
  };
}

export function demoBroadcasts(day: string): BroadcastInfo[] {
  return [
    {
      id: 'bc_m1',
      audience: 'gruppe:Tester',
      audienceLabel: 'Gruppe „Tester“',
      subject: 'Fortschritt: Meilenstein M1 ist fertig',
      body: 'Hallo zusammen,\n\nMeilenstein M1 von ToyChain ist fertig: Grundtypen und Emission. Die Genesis enthält kein einziges TOY, alle 45 Pflicht-Tests laufen.\n\nAls Nächstes kommt M2: Kryptografie und Adressen. Wer beim Testen helfen will, antwortet einfach auf diese Nachricht.\n\nRamon',
      source: 'Automation (project.milestone)',
      status: 'draft',
      createdAt: `${day}T08:56:00.000Z`,
      recipients: 2,
      languages: ['en', 'sw'],
    },
  ];
}

export const DEMO_PRESETS: PresetInfo[] = [
  { id: 'meilenstein', name: 'Meilenstein fertig → Mitteilung an Tester', description: 'Wird in docs/STATUS.md ein Meilenstein fertig, schreibt ToyPost eine Mitteilung an die Gruppe „Tester“, die erst nach deiner Freigabe rausgeht.', needs: ['github'] },
  { id: 'release', name: 'Neue Version → Mitteilung an die Community', description: 'Bei einem neuen Release auf GitHub entsteht eine Mitteilung zum Freigeben.', needs: ['github'] },
  { id: 'ampel', name: 'Warnampel rot → Notfall-Mitteilung und Push an dich', description: 'Springt die ToyScan-Warnampel auf Rot, kommt sofort eine Push-Nachricht, und eine Notfall-Mitteilung liegt bereit.', needs: ['toyscan', 'announce'] },
  { id: 'zahlung', name: 'TOY-Zahlung eingegangen → Dank an den Zahler', description: 'Ist eine TOY-Rechnung bezahlt, bedankt sich ToyPost beim Zahler in seiner Sprache.', needs: [] },
  { id: 'fehlermeldung', name: 'Fehlermeldung per Nachricht → GitHub-Issue', description: 'Fehlermeldungen aus E-Mail, Telegram oder SMS werden zu Issues, ohne Namen oder Telefonnummer.', needs: ['github'] },
  { id: 'sicherheit', name: 'Sicherheitsmeldung → vertrauliche Antwort', description: 'Wer eine Schwachstelle meldet, bekommt den vertraulichen Meldeweg aus SECURITY.md.', needs: [] },
  { id: 'betrug', name: 'Betrugsverdacht → Push an dich', description: 'Erkennt ToyPost eine Betrugsnachricht, bekommst du sofort eine Push-Nachricht.', needs: ['announce'] },
];

export function demoAutomations(day: string): AutomationInfo[] {
  return [
    { id: 'auto_m', name: 'Meilenstein fertig → Mitteilung an Tester', trigger: 'project.milestone', enabled: true, runs: 1, lastRunAt: `${day}T08:56:00.000Z`, log: [{ at: `${day}T08:56:00.000Z`, result: 'Mitteilung bc_m1 wartet auf Freigabe (2 Empfänger)' }] },
    { id: 'auto_b', name: 'Betrugsverdacht → Push an dich', trigger: 'safety.warning', enabled: true, runs: 1, lastRunAt: `${day}T06:10:00.000Z`, log: [{ at: `${day}T06:10:00.000Z`, result: 'Push über Push an mich: sent' }] },
    { id: 'auto_z', name: 'TOY-Zahlung eingegangen → Dank an den Zahler', trigger: 'toy.payment.received', enabled: true, runs: 0, log: [] },
  ];
}
