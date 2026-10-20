import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCostDecimal, validateCostRows, isCostCodeHeader, readCostCodeCell } from './costs-parser.mjs';

const header = ['Produto: código', 'Produto: nome', 'peso', 'custo atual'];
const source = ['00127', 'Produto sintético', '', 12.345678];

test('cost template maps the exact ERP headers and preserves code, weight absence and six unit decimals', () => {
  const result = validateCostRows([header, source]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [{ line_number: 2, code: '00127', product: 'Produto sintético', weight_kg: null, unit_cost: '12.345678' }]);
});
test('cost parser keeps every physical duplicate and conflicting candidate for the server resolution step', () => {
  const result = validateCostRows([header, source, source, [source[0], source[1], null, 0]]);
  assert.deepEqual(result.errors, []); assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map(row => row.line_number), [2, 3, 4]);
  assert.deepEqual(result.rows.map(row => row.unit_cost), ['12.345678', '12.345678', '0']);
});
test('unknown cost stays null while explicit zero cost and zero weight remain known zeros', () => {
  const result = validateCostRows([header, [41, 'Item sem custo', null, null], [42, 'Item de custo zero', 0, 0]]);
  assert.deepEqual(result.errors, []); assert.equal(result.rows[0].unit_cost, null);
  assert.equal(result.rows[1].unit_cost, '0'); assert.equal(result.rows[1].weight_kg, '0');
});
test('decimal strings use Brazilian notation and remain exact beyond JavaScript integer precision', () => {
  assert.equal(parseCostDecimal('R$ 1.234,567890', { currency: true }), '1234.56789');
  assert.equal(parseCostDecimal('999.999.999.999,999999'), '999999999999.999999');
  assert.equal(parseCostDecimal('000,010000'), '0.01');
  for (const invalid of ['1,2345678', '1.23456', '1e2', '-1,00', 'NaN', '1.000.000.000.000,00']) assert.throws(() => parseCostDecimal(invalid));
});
test('numeric binary tails clean only within two ULPs and genuine extra unit precision is rejected', () => {
  assert.equal(parseCostDecimal(0.30000000000000004), '0.3');
  assert.equal(parseCostDecimal(1.2345670000000002), '1.234567');
  assert.equal(parseCostDecimal(0.000001), '0.000001');
  assert.equal(parseCostDecimal(1000000000.123456), '1000000000.123456');
  for (const invalid of [1.2345678, 1000000000.1234567, 100000000.1234567, 0.0000001, Number.MIN_VALUE, -1, Infinity, NaN, 1e12]) assert.throws(() => parseCostDecimal(invalid));
});
test('XLSX numeric zero masks preserve identifiers and never infer missing leading zeros', () => {
  assert.equal(readCostCodeCell(127, '000000'), '000127');
  assert.equal(readCostCodeCell(127, 'General'), '127');
  assert.equal(readCostCodeCell('000127', 'General'), '000127');
  assert.equal(isCostCodeHeader('Produto: código'), true);
  assert.throws(() => readCostCodeCell(127, '#,##0'));
  assert.throws(() => readCostCodeCell(1.2, 'General'));
});
test('cost import rejects formulas even in unused columns, ambiguity and invalid identity cells', () => {
  for (const value of [{ formula: '1+2', result: 3 }, { sharedFormula: 'A1', result: 3 }, '=1+2', '@SUM(A1)']) {
    const result = validateCostRows([[...header, 'Observação'], [...source, value]]);
    assert.equal(result.errors[0].line, 2);
  }
  for (const matrix of [[['Produto: nome', 'custo atual'], ['Nome', 1]], [[...header, 'Código'], [...source, 99]], [header, ['', 'Produto', null, 1]], [header, [1.2, 'Produto', null, 1]], [header, ['1e3', 'Produto', null, 1]], [header, [...source, 'fora do cabeçalho']]]) assert(validateCostRows(matrix).errors.length > 0);
});
test('a missing weight column remains absent information, and malformed rows do not remove valid source lines silently', () => {
  const result = validateCostRows([['Produto: código', 'Produto: nome', 'custo atual'], ['AA-1', 'Item válido', '2,125'], ['AA-2', 'Outro item', 'inválido']]);
  assert.equal(result.rows[0].weight_kg, null); assert.equal(result.rows[0].line_number, 2);
  assert.equal(result.errors[0].line, 3); assert.equal(result.rows.length, 1);
});
test('cost input bounds include 5000 source rows and reject empty or structurally invalid files', () => {
  const result = validateCostRows([header, ...Array.from({ length: 5000 }, (_, index) => [index + 1, 'Item sintético', null, 1])]);
  assert.equal(result.errors.length, 0); assert.equal(result.rows.length, 5000);
  for (const matrix of [null, [], [header], [header, ['', '', '', '']], [[...Array(101).fill('')], source], [header, ...Array(5001).fill(source)]]) assert(validateCostRows(matrix).errors.length > 0);
});
