import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaidBankDescription, isInternalCashBank, officialPaidBankName } from './payable-bank-rules.mjs';

// Entirely synthetic account descriptions. Real mappings stay in private
// installation data and are not part of browser code or public test fixtures.
const aliases = [
  { source: 'BANCO SINTÉTICO A - 000001-X', official_name: 'CONTA OFICIAL A' },
  { source: 'BANCO SINTÉTICO B 000002-X', official_name: 'CONTA OFICIAL B' },
  { source: 'BANCO SINTÉTICO C PARTICIPAÇÕES 000003-X', official_name: 'CONTA OFICIAL C' },
  { source: 'BANCO SINTÉTICO D 000004-X', official_name: 'CONTA OFICIAL D' },
  { source: 'BANCO SINTÉTICO E 000005-X', official_name: 'CONTA OFICIAL E' },
  { source: 'BANCO SINTÉTICO F FÁCIL 000006-X', official_name: 'CONTA OFICIAL F' },
  { source: 'DÉBITO EM CONTA - BANCO SINTÉTICO B', official_name: 'CONTA OFICIAL B' },
];

test('only explicitly supplied source descriptions identify their configured official account names', () => {
  for (const { source, official_name } of aliases) {
    assert.equal(officialPaidBankName(source), null);
    assert.equal(officialPaidBankName(source, aliases), official_name);
    assert.equal(officialPaidBankName('  ' + source.toLowerCase().replaceAll(' ', '\t ') + '  ', aliases), official_name);
    assert.equal(officialPaidBankName(source.normalize('NFD').replace(/\p{M}/gu, ''), aliases), official_name);
    assert.equal(officialPaidBankName(source + ' - OUTRA CONTA', aliases), null);
    const changedAccount = source.replace(/(\d)(\D*)$/, (_, digit, suffix) => String((Number(digit) + 1) % 10) + suffix);
    assert.equal(officialPaidBankName(changedAccount, aliases), /\d/.test(source) ? null : official_name);
  }
});

test('normalization preserves account digits and punctuation and never infers by company or branch', () => {
  assert.equal(normalizePaidBankDescription('  banco\tsintético F fácil 000006-X '), 'BANCO SINTETICO F FACIL 000006-X');
  for (const source of ['BANCO SINTÉTICO B', 'CONTA OFICIAL B', 'BANCO SINTÉTICO B 2-X', 'BANCO SINTÉTICO B 000002 X', 'BANCO SINTÉTICO B 000002-9', 'BANCO SINTÉTICO A 000001-X', 'BANCO SINTÉTICO B 000002-X FILIAL 4', '', null, undefined]) assert.equal(officialPaidBankName(source, aliases), null);
  assert.equal(officialPaidBankName('BANCO SINTÉTICO B 000002-X', [...aliases, { source: 'banco sintético b 000002-X', official_name: 'OUTRA CONTA OFICIAL' }]), null);
  assert.equal(officialPaidBankName('', [{ source: '', official_name: 'CONTA SEM ORIGEM' }]), null);
});

test('internal cash is an exact normalized administrative marker, never an implicit official-bank alias', () => {
  for (const source of ['CAIXA INTERNO', '  caixa\t interno  ']) {
    assert.equal(isInternalCashBank(source), true);
    assert.equal(officialPaidBankName(source), null);
  }
  for (const source of ['CAIXA', 'CAIXA-INTERNO', 'CAIXAINTERNO', 'CAIXA INTERNO 1', 'BANCO CAIXA INTERNO', 'CAIXA EXTERNO', '', null, undefined]) assert.equal(isInternalCashBank(source), false);
});
