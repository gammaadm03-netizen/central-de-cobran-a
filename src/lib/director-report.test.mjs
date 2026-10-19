import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactMillions, displayMillions, excelMillions, reportAmount, directorAccounts } from './director-report.ts';

test('PostgreSQL decimal strings preserve zero, negative and fractional-cent results without rounding', () => {
  assert.equal(exactMillions('0.0000000000000000000000000000'), '0');
  assert.equal(exactMillions('-0.0000000014000000000000000000'), '-0.0000000014');
  assert.equal(displayMillions('-0.0000000014'), '0,00 mi');
  assert.equal(displayMillions('1234.1200000000'), '1.234,12 mi');
  assert.equal(displayMillions('12.3456'), '12,35 mi');
  assert.equal(displayMillions('9.995'), '10,00 mi');
  assert.equal(displayMillions('-1.235'), '−1,24 mi');
  assert.equal(displayMillions('0'), '0,00 mi');
  for (const invalid of [0, null, undefined, 'NaN', '<script>', '1e2', '1.00000000001']) assert.equal(exactMillions(invalid), null);
});
test('Excel refuses precision loss while accepting exact report-scale values and explicit zero', () => {
  assert.equal(excelMillions('0'), 0);
  assert.equal(excelMillions('-0.0000000014'), -0.0000000014);
  assert.equal(excelMillions('12.1234567890'), 12.123456789);
  assert.equal(excelMillions('123456789.1234567890'), null);
});
test('financial fields are safe integer cents; missing, decimal and coerced values remain unknown', () => {
  for (const invalid of [undefined, null, '123', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(reportAmount({ amount: invalid }, 'amount'), null);
  assert.equal(reportAmount({ amount: 0 }, 'amount'), 0);
  assert.equal(reportAmount({ amount: -123 }, 'amount'), -123);
});
test('Director bank display follows the supplied order without changing or dropping future accounts', () => {
  const accounts = ['CAIXA EASY CLEAN', 'BANCO CORA ECO PLAST', 'BRADESCO ECOPLAST', 'BRADESCO F2G', 'CONTA FUTURA'].map((display_name, id) => ({ display_name, id: String(id) }));
  const ordered = directorAccounts(accounts);
  assert.deepEqual(ordered.map(account => account.display_name), ['BRADESCO ECOPLAST', 'BRADESCO F2G', 'BANCO CORA ECO PLAST', 'CAIXA EASY CLEAN', 'CONTA FUTURA']);
  assert.equal(accounts[0].display_name, 'CAIXA EASY CLEAN');
  assert.equal(ordered.length, accounts.length);
});
