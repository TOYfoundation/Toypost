import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import {
  addressFromPublicKey,
  blocksSending,
  buildPaymentLink,
  checkAddress,
  checkSafety,
  findAddresses,
  findPaymentLinks,
  findToyAmount,
  fitPurpose,
  formatToy,
  glossaryHint,
  invoicePurpose,
  isRtl,
  keccak256,
  keccakSponge256,
  lookalikeOf,
  parsePaymentLink,
  parseToy,
  purposeBytes,
  redactSecrets,
  toChecksumAddress,
  toHex,
  TOY_LANGUAGES,
  TOY_MAX_SUPPLY,
  toyDecimal,
  toyLanguage,
  unitsFromWire,
} from '../src/index.ts';

// ---------- Keccak-256 ----------

test('Keccak-256: official vectors', () => {
  assert.equal(toHex(keccak256('')), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(toHex(keccak256('abc')), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});

test('Keccak sponge equals Node sha3-256 when given SHA3 padding (differential test of the permutation)', () => {
  for (const len of [0, 1, 31, 32, 135, 136, 137, 271, 272, 273, 1000]) {
    for (let i = 0; i < 3; i++) {
      const data = randomBytes(len);
      assert.equal(toHex(keccakSponge256(data, 0x06)), createHash('sha3-256').update(data).digest('hex'), `length ${len}`);
    }
  }
});

// ---------- Addresses ----------

test('EIP-55: the examples from the EIP', () => {
  for (const a of [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]) {
    assert.equal(toChecksumAddress(a.toLowerCase()), a);
    assert.deepEqual(checkAddress(a), { ok: true, address: a, checksummed: true });
  }
});

test('Address check: lowercase accepted, wrong checksum and bad format rejected', () => {
  assert.equal(checkAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed').ok, true);
  assert.deepEqual(checkAddress('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), { ok: false, reason: 'checksum' });
  assert.deepEqual(checkAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe'), { ok: false, reason: 'format' });
});

test('Address from public key: private keys 1 and 2 give the well-known Ethereum addresses', () => {
  const pub = (n: number) => {
    const ecdh = createECDH('secp256k1');
    const key = Buffer.alloc(32);
    key[31] = n;
    ecdh.setPrivateKey(key);
    return new Uint8Array(ecdh.getPublicKey());
  };
  assert.equal(addressFromPublicKey(pub(1)), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.equal(addressFromPublicKey(pub(2)), '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF');
});

test('Look-alike addresses are detected, the same address is not', () => {
  const known = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const trap = '0x5aAe' + '0'.repeat(32) + 'BeAed'.slice(1);
  assert.equal(lookalikeOf(trap, [known]), known);
  assert.equal(lookalikeOf(known, [known]), undefined);
  assert.deepEqual(findAddresses(`Bitte an ${known.toLowerCase()} zahlen, nicht an 0x123.`), [known]);
});

// ---------- Amounts ----------

test('TOY amounts: integers only, 18 decimals, cap 10^26', () => {
  assert.equal(parseToy('1'), 10n ** 18n);
  assert.equal(parseToy('0.000000000000000001'), 1n);
  assert.equal(parseToy('100000000'), TOY_MAX_SUPPLY);
  assert.throws(() => parseToy('100000000.000000000000000001'), /100.000.000/);
  assert.throws(() => parseToy('0.0000000000000000001'), /18 Nachkommastellen/);
  assert.throws(() => parseToy('1e3'));
  assert.equal(toyDecimal(1_500_000_000_000_000_000n), '1.5');
  assert.equal(unitsFromWire('50500000000000000000000'), 50_500n * 10n ** 18n);
  assert.throws(() => unitsFromWire('-1'));
  assert.throws(() => unitsFromWire('100000000000000000000000001'));
});

test('TOY amounts in text: German and English notation', () => {
  assert.equal(findToyAmount('Bitte überweise 12,50 TOY bis Freitag.'), parseToy('12.5'));
  assert.equal(findToyAmount('Betrag: 1.250 TOY'), parseToy('1250'));
  assert.equal(findToyAmount('Total TOY 0.1 for the deposit'), parseToy('0.1'));
  assert.equal(findToyAmount('1.234,56 ToyCoin'), parseToy('1234.56'));
  assert.equal(findToyAmount('Keine Zahl hier, nur TOY.'), undefined);
});

test('TOY amounts formatted per language without rounding', () => {
  assert.equal(formatToy(parseToy('1234.5'), 'de'), '1.234,5 TOY');
  assert.equal(formatToy(parseToy('1234.5'), 'en'), '1,234.5 TOY');
  assert.equal(formatToy(1n, 'de'), '0,000000000000000001 TOY');
  assert.equal(formatToy(parseToy('0.1'), 'fr').replace(/\s/g, ' '), '0,1 TOY');
});

// ---------- Payment links ----------

test('Payment link round trip with amount, purpose, note and due date', () => {
  const link = buildPaymentLink({
    address: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
    amount: parseToy('12.5'),
    purpose: 'TP-7K3Q Rechnung 42',
    note: 'Danke für die Hilfe beim Testnet!',
    validUntil: '2026-11-02',
  });
  assert.equal(
    link,
    'toychain:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed?betrag=12.5&zweck=TP-7K3Q%20Rechnung%2042&nachricht=Danke%20f%C3%BCr%20die%20Hilfe%20beim%20Testnet!&bis=2026-11-02',
  );
  const back = parsePaymentLink(link);
  assert.equal(back.amount, parseToy('12.5'));
  assert.equal(back.purpose, 'TP-7K3Q Rechnung 42');
  assert.equal(back.validUntil, '2026-11-02');
});

test('Payment link rules: purpose at most 32 bytes, unknown req- parameters rejected, others kept', () => {
  const addr = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  assert.throws(() => buildPaymentLink({ address: addr, purpose: 'x'.repeat(33) }), /32 Byte/);
  assert.equal(purposeBytes(fitPurpose('Größenänderung für Übergrößen-Bestellung')), 32);
  assert.throws(() => parsePaymentLink(`toychain:${addr}?req-escrow=1`), /req-escrow/);
  assert.deepEqual(parsePaymentLink(`toychain:${addr}?betrag=1&label=Anna`).extra, { label: 'Anna' });
  assert.throws(() => parsePaymentLink('toychain:0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), /Prüfsumme/);
  assert.equal(invoicePurpose('7k3q', 'Rechnung Nummer 2026-0042 für Testbetrieb'), 'TP-7K3Q Rechnung Nummer 2026-004');
});

test('Payment links are found in running text', () => {
  const text = 'Hallo, hier der Link: toychain:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed?betrag=3&zweck=Abo%20Okt. Gruß';
  const [req] = findPaymentLinks(text);
  assert.equal(req.amount, parseToy('3'));
  assert.equal(req.purpose, 'Abo Okt.');
});

// ---------- Safety ----------

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

test('Outgoing recovery phrase is blocked, incoming one is flagged', () => {
  const out = checkSafety({ text: `Hier meine Wiederherstellungsphrase: ${PHRASE}`, direction: 'out' });
  assert.equal(blocksSending(out), true);
  const numbered = PHRASE.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n');
  assert.equal(blocksSending(checkSafety({ text: numbered, direction: 'out' })), true);
  const incoming = checkSafety({ text: `my seed is ${PHRASE}`, direction: 'in' });
  assert.equal(incoming[0].code, 'secret_phrase');
  assert.equal(incoming[0].severity, 'red');
});

test('Normal English text and transaction hashes are not mistaken for secrets', () => {
  const text =
    'thanks for the quick call today and sorry about the noise here at the office we will send the documents next week. ' +
    'Transaction hash: 0x98389cf8ba8762f72f5639189d9ba180f7132505b009e0d1d6e02cfd4a8371f3';
  assert.deepEqual(checkSafety({ text, direction: 'out' }), []);
});

test('Private key with context is blocked', () => {
  const text = `My private key is 0x${'ab'.repeat(32)}`;
  assert.equal(checkSafety({ text, direction: 'out' })[0].code, 'private_key');
});

test('Phishing: asks for the phrase, fake airdrop, legacy token, look-alike address', () => {
  assert.ok(checkSafety({ text: 'Bitte bestätige deine Wiederherstellungsphrase, sonst wird dein TOYPAY-Konto gesperrt.', direction: 'in' }).some((f) => f.code === 'asks_for_secret'));
  assert.ok(checkSafety({ text: 'Claim your free TOY airdrop now!', direction: 'in' }).some((f) => f.code === 'fake_airdrop'));
  assert.ok(
    checkSafety({ text: 'Kaufe ToyCoin hier: 0xa5b04ce6edd139c0e58ccdbc0b75e8c67cda678a', direction: 'in' }).some((f) => f.code === 'legacy_token'),
  );
  const known = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const trap = toChecksumAddress('0x5aae' + '1'.repeat(32) + 'beaed'.slice(1));
  assert.ok(checkSafety({ text: `Neue Zahladresse: ${trap}`, direction: 'in', knownAddresses: [known] }).some((f) => f.code === 'lookalike_address'));
});

test('Secrets are removed before logging or sending text to an AI', () => {
  const red = redactSecrets(`Phrase: ${PHRASE}. Private key: 0x${'cd'.repeat(32)}`);
  assert.ok(!red.includes('abandon'));
  assert.ok(!red.includes('cdcd'));
  assert.ok(red.includes('[Phrase entfernt]'));
});

// ---------- Languages ----------

test('45 shared languages with right-to-left for Arabic, Urdu and Persian', () => {
  assert.equal(TOY_LANGUAGES.length, 45);
  assert.deepEqual(TOY_LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code).sort(), ['ar', 'fa', 'ur']);
  assert.equal(toyLanguage('pt-BR').code, 'pt');
  assert.equal(toyLanguage('xx').code, 'en');
  assert.equal(isRtl('fa'), true);
  assert.match(glossaryHint('Das Aktivierungs-Pfand kommt beim Auflösen zurück.'), /Aktivierungs-Pfand = activation deposit/);
  assert.equal(glossaryHint('Nichts davon'), '');
});
