import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths,
  allocateSpend,
  buildGiroCodePayload,
  detectDeadlines,
  easterSunday,
  formatEuro,
  isValidIban,
  monthlyCreditGrant,
  nextBusinessDay,
  priceFor,
  relativeDueDe,
  shouldWarn,
  storageLimitBytes,
  yearlySavingPercent,
  hasFeature,
} from '../src/index.ts';

test('Ostern und Feiertage', () => {
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
  // Karfreitag 2026 ist der 3.4., also nächster Werktag Dienstag nach Ostermontag
  assert.equal(nextBusinessDay('2026-04-03'), '2026-04-07');
  assert.equal(nextBusinessDay('2026-10-03'), '2026-10-05'); // Tag der Einheit, Samstag
});

test('Monatsfristen nach § 188 BGB', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-10-19', 1), '2026-11-19');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
});

test('Einspruchsfrist eines Bescheids ab Bekanntgabe', () => {
  const text = 'Gegen diesen Bescheid ist der Einspruch gegeben. Er ist innerhalb eines Monats nach Bekanntgabe einzulegen.';
  const [d] = detectDeadlines(text, { letterDate: '2026-10-14' });
  // 14.10. + 4 Tage = So 18.10. -> Mo 19.10.; + 1 Monat = Do 19.11.
  assert.equal(d.date, '2026-11-19');
  assert.equal(d.kind, 'einspruch');
  assert.match(d.explanation, /§ 122 AO/);
});

test('Zahlungsfrist in Tagen und ausdrückliches Datum', () => {
  const text = 'Der Rechnungsbetrag ist zahlbar innerhalb von 14 Tagen. Alternativ: bitte überweisen Sie bis zum 31.10.2026.';
  const ds = detectDeadlines(text, { letterDate: '2026-10-16' });
  assert.deepEqual(
    ds.map((d) => [d.date, d.kind]),
    [
      ['2026-10-30', 'zahlung'],
      ['2026-10-31', 'zahlung'],
    ],
  );
});

test('Fristende auf Feiertag wird verschoben, Zahlwörter werden erkannt', () => {
  const [d] = detectDeadlines('Bitte senden Sie uns die Unterlagen binnen zwei Wochen zurück.', { letterDate: '2026-12-18' });
  assert.equal(d.date, '2027-01-04');
  assert.equal(d.kind, 'antwort');
  assert.match(d.explanation, /nächsten Werktag/);
});

test('Zahlungsziel mit zweistelliger Jahreszahl und Monatsname', () => {
  const ds = detectDeadlines('Zahlungsziel: 30.10.26. Die Kündigung ist spätestens am 15. Januar 2027 möglich.', {
    letterDate: '2026-10-01',
  });
  assert.deepEqual(
    ds.map((d) => [d.date, d.kind]),
    [
      ['2026-10-30', 'zahlung'],
      ['2027-01-15', 'kuendigung'],
    ],
  );
});

test('Credits: erst Monatskontingent, dann ältestes gekauftes Paket, abgelaufene ignorieren', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const buckets = [
    { id: 'p2', kind: 'purchased' as const, remainingUnits: 100, expiresAt: '2028-01-01T00:00:00Z' },
    { id: 'old', kind: 'purchased' as const, remainingUnits: 500, expiresAt: '2026-01-01T00:00:00Z' },
    { id: 'p1', kind: 'purchased' as const, remainingUnits: 30, expiresAt: '2027-06-01T00:00:00Z' },
    { id: 'plan', kind: 'plan' as const, remainingUnits: 40, expiresAt: '2026-11-01T00:00:00Z' },
  ];
  const r = allocateSpend(buckets, 100, now);
  assert.equal(r.ok, true);
  assert.deepEqual(r.deductions, [
    { bucketId: 'plan', units: 40 },
    { bucketId: 'p1', units: 30 },
    { bucketId: 'p2', units: 30 },
  ]);
  const short = allocateSpend(buckets, 1000, now);
  assert.equal(short.ok, false);
  assert.equal(short.shortfallUnits, 830);
  assert.deepEqual(short.deductions, []);
});

test('Warnung bei 80 % Verbrauch', () => {
  assert.equal(shouldWarn(81, 400), false);
  assert.equal(shouldWarn(80, 400), true);
});

test('Tarife: Preise, Speicher, Kontingente', () => {
  assert.equal(priceFor('team', 'month', 2), 899 * 3); // Mindestens 3 Nutzer
  assert.equal(priceFor('pro', 'year'), 6900);
  assert.equal(yearlySavingPercent('pro'), 18);
  assert.equal(monthlyCreditGrant('team', 5), 3000);
  assert.equal(storageLimitBytes('free'), 1024 ** 3);
  assert.equal(hasFeature('free', 'drafts'), true);
  assert.equal(hasFeature('pro', 'customWorkflows'), false);
  assert.equal(hasFeature('enterprise', 'sso'), true);
});

test('IBAN-Prüfung und GiroCode', () => {
  assert.equal(isValidIban('DE89 3704 0044 0532 0130 00'), true);
  assert.equal(isValidIban('DE89 3704 0044 0532 0130 01'), false);
  const payload = buildGiroCodePayload({
    recipient: 'Stadtwerke Bremen',
    iban: 'DE89 3704 0044 0532 0130 00',
    amountCents: 12_345,
    reference: 'Kd-Nr 4711',
  });
  assert.equal(payload, 'BCD\n002\n1\nSCT\n\nStadtwerke Bremen\nDE89370400440532013000\nEUR123.45\n\n\nKd-Nr 4711');
  assert.throws(() => buildGiroCodePayload({ recipient: 'X', iban: 'DE00', amountCents: 1 }));
});

test('Formatierung', () => {
  assert.equal(formatEuro(123_456), '1.234,56 €');
  assert.equal(relativeDueDe('2026-10-22', '2026-10-19'), 'in 3 Tagen');
  assert.equal(relativeDueDe('2026-10-17', '2026-10-19'), 'seit 2 Tagen überfällig');
});
