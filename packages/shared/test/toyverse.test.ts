import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_TOKENS, TOY_DECIMALS, TOY_MAX_SUPPLY, TOY_UNIT, TOYVERSE, TOY_GLOSSARY, TOY_LANGUAGES } from '../src/toy/index.ts';

// Shared ToyVerse values (toycoin shared/toyverse.json, decision 135). If toycoin changes them,
// the daily sync updates toyverse-data.ts and these tests show what ToyPost must follow.

test('shared values: schema and constitution values', () => {
  assert.equal(TOYVERSE.schema, 'toyverse/1');
  assert.equal(TOY_DECIMALS, 18);
  assert.equal(TOY_UNIT, 10n ** BigInt(TOY_DECIMALS));
  assert.equal(TOY_MAX_SUPPLY, 10n ** 26n);
  assert.equal(TOYVERSE.toy.genesisBalanceUnits, '0');
  assert.equal(TOYVERSE.rules.onlyNativeCoin, true);
  assert.equal(TOYVERSE.rules.burnsToy, false);
  assert.equal(TOYVERSE.rules.appsNeverAskForSeedPhrase, true);
});

test('shared values: chain IDs of decision 116', () => {
  assert.deepEqual(TOYVERSE.chainIds, { mainnet: 7630713, testnet: 7630714, devnet: 7630715 });
});

test('shared values: old ToyCoin tokens are warnings only', () => {
  assert.equal(LEGACY_TOKENS.length, TOYVERSE.legacyTokens.length);
  for (const t of TOYVERSE.legacyTokens) {
    assert.equal(t.isToyChainToy, false);
    assert.match(t.address, /^0x[0-9a-fA-F]{40}$/);
  }
  assert.deepEqual(
    LEGACY_TOKENS.map((t) => t.chainId),
    [1, 137],
  );
});

test('shared values: amounts are strings, transaction kinds are type bytes', () => {
  for (const v of Object.values(TOYVERSE.stakeTiersUnits)) assert.match(v, /^\d+$/);
  assert.match(TOYVERSE.accounts.activationDepositUnits, /^\d+$/);
  for (const v of Object.values(TOYVERSE.txKinds)) assert.match(v, /^0x7[0-9a-f]$/);
});

test('shared values: languages and glossary are in line', () => {
  assert.equal(TOYVERSE.i18n.languages, TOY_LANGUAGES.length);
  for (const key of ['toyverse', 'toysafe', 'warning_list']) assert.ok(TOY_GLOSSARY.some((g) => g.key === key), key);
});
