import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaidBankMappings } from './payable-bank-plan.mjs';
const id = '10000000-0000-4000-8000-000000000001', other = '10000000-0000-4000-8000-000000000002';
const row = (changes = {}) => ({ amount_paid_cents: 10000, paid_bank: 'BANCO SINTÉTICO 0001001-1', bank_mapping_key: 'chave-sintetica', bank_account_id: id, ...changes });
test('bank plan freezes every officially resolved nonadministrative account and retains explicit choices', () => {
  const result = resolvePaidBankMappings([row(), row()], {});
  assert.deepEqual(result, { mappings: { 'chave-sintetica': id }, changed: true });
  assert.deepEqual(resolvePaidBankMappings([row()], result.mappings), { ...result, changed: false });
  assert.deepEqual(resolvePaidBankMappings([row({ bank_account_id: null })], {}), { mappings: {}, changed: false });
  assert.deepEqual(resolvePaidBankMappings([row({ amount_paid_cents: 1 }), row({ paid_bank: 'CAIXA INTERNO' })], {}), { mappings: {}, changed: false });
});
test('a conflicting official result or mismatched manual account cannot replace a reviewed bank silently', () => {
  assert.throws(() => resolvePaidBankMappings([row(), row({ bank_account_id: other })]), /conflicting-bank-plan/);
  assert.throws(() => resolvePaidBankMappings([row()], { 'chave-sintetica': other }), /conflicting-bank-plan/);
  assert.throws(() => resolvePaidBankMappings([row({ bank_account_id: 'invalid' })]), /invalid-bank-plan/);
});

test('a fixed cheque bank never teaches a raw source-bank alias to ordinary payments', () => {
  const cheque = row({ payment_bank_rule: 'CHEQUE_F2G', bank_account_id: other });
  assert.deepEqual(resolvePaidBankMappings([cheque]), { mappings: {}, changed: false });
  assert.deepEqual(resolvePaidBankMappings([row(), cheque]), { mappings: { 'chave-sintetica': id }, changed: true });
  assert.deepEqual(resolvePaidBankMappings([cheque], { 'chave-sintetica': id }), { mappings: { 'chave-sintetica': id }, changed: false });
});
