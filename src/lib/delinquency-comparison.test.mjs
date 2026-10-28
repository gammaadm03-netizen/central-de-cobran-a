import test from 'node:test';
import assert from 'node:assert/strict';
import { DELINQUENCY_BANDS, delinquencyChange, validDelinquencyComparison } from './delinquency-comparison.mjs';

function report() {
  const position = (date, partial) => ({ date, partial, available: true, total_cents: 2100, title_count: 21,
    bands: DELINQUENCY_BANDS.map(({ key }, index) => ({ key, amount_cents: (index + 1) * 100, title_count: index + 1 })) });
  return { as_of_date: '2026-10-28', timezone: 'America/Sao_Paulo', first_available_date: '2026-10-27',
    previous: position('2026-10-27', false), current: position('2026-10-28', true) };
}
test('financial comparison preserves signed reduction amounts and the supplied aging examples', () => {
  const examples = [
    [75054227, 64431645, -10622582, '-14,15%', 'Muito positivo'],
    [19954686, 13499276, -6455410, '-32,35%', 'Excelente'],
    [10315022, 7901329, -2413693, '-23,40%', 'Muito positivo'],
    [22716216, 14480311, -8235905, '-36,26%', 'Excelente'],
    [10098862, 19628729, 9529867, '+94,37%', 'Atenção'],
    [4505084, 4516217, 11133, '+0,25%', 'Estável'],
    [142644097, 124457507, -18186590, '-12,75%', 'Muito positivo'],
  ];
  for (const [previous, current, difference, percentage, label] of examples) {
    const result = delinquencyChange(previous, current);
    assert.equal(result.difference_cents, difference); assert.equal(result.percentage, percentage); assert.equal(result.label, label);
    assert.ok(!result.label.includes('migração'));
  }
});
test('a zero baseline and unavailable history do not create infinite percentages or financial zeroes', () => {
  assert.deepEqual(delinquencyChange(0, 0), { difference_cents: 0, percentage: '0,00%', label: 'Sem variação', tone: 'neutral' });
  assert.deepEqual(delinquencyChange(0, 100), { difference_cents: 100, percentage: null, label: 'Novo saldo vencido', tone: 'negative' });
  for (const invalid of [null, undefined, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100']) {
    for (const [previous, current] of [[invalid, 100], [100, invalid]]) assert.deepEqual(delinquencyChange(previous, current), { difference_cents: null, percentage: null, label: 'Sem histórico', tone: 'unavailable' });
  }
});
test('percentages round exact rational values half-up, without floating point multiplication', () => {
  assert.equal(delinquencyChange(20000, 20001).percentage, '+0,01%');
  assert.equal(delinquencyChange(20000, 19999).percentage, '-0,01%');
  assert.equal(delinquencyChange(30000, 30001).percentage, '+0,00%');
  assert.equal(delinquencyChange(1, Number.MAX_SAFE_INTEGER).percentage, '+900.719.925.474.099.000,00%');
  assert.equal(delinquencyChange(Number.MAX_SAFE_INTEGER, 0).percentage, '-100,00%');
});
test('reading thresholds classify exact ratios rather than their rounded display', () => {
  for (const [current, label, tone] of [[7000, 'Excelente', 'positive'], [7001, 'Muito positivo', 'positive'],
    [9000, 'Muito positivo', 'positive'], [9001, 'Positivo', 'positive'], [9899, 'Positivo', 'positive'],
    [9900, 'Estável', 'neutral'], [10100, 'Estável', 'neutral'], [10101, 'Atenção', 'negative']]) {
    const result = delinquencyChange(10000, current); assert.equal(result.label, label); assert.equal(result.tone, tone);
  }
  assert.equal(delinquencyChange(1000000, 989999).label, 'Positivo');
});
test('a complete report validates six unique bands and exact independent amount/count sums', () => {
  assert.equal(validDelinquencyComparison(report()), true);
  const shuffled = report(); shuffled.current.bands.reverse(); assert.equal(validDelinquencyComparison(shuffled), true);
  const mutations = [
    value => { value.current.total_cents++; }, value => { value.current.title_count++; },
    value => { value.current.bands[0].key = value.current.bands[1].key; },
    value => { value.current.bands.pop(); }, value => { value.current.bands[0].amount_cents = -1; },
    value => { value.current.bands[0].title_count = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.current.total_cents = undefined; }, value => { value.current.bands[0].amount_cents = null; },
  ];
  for (const mutate of mutations) { const value = report(); mutate(value); assert.equal(validDelinquencyComparison(value), false); }
  const overflow = report(); overflow.current.bands.forEach(band => { band.amount_cents = Number.MAX_SAFE_INTEGER; });
  overflow.current.total_cents = Number.MAX_SAFE_INTEGER; assert.equal(validDelinquencyComparison(overflow), false);
});
test('reports enforce real civil dates, chronology, Brasília and partial-today semantics', () => {
  for (const mutate of [
    value => { value.as_of_date = '2026-02-30'; }, value => { value.previous.date = '2026-02-29'; },
    value => { value.current.date = '2026-10-29'; }, value => { value.previous.date = value.current.date; },
    value => { value.timezone = 'UTC'; }, value => { value.first_available_date = '2026-10-29'; },
    value => { value.first_available_date = null; }, value => { value.previous.partial = true; },
    value => { value.current.partial = false; }, value => { value.current.available = 'true'; },
  ]) { const value = report(); mutate(value); assert.equal(validDelinquencyComparison(value), false); }
  const leap = report(); leap.previous.date = '2024-02-29'; leap.first_available_date = '2024-02-29'; assert.equal(validDelinquencyComparison(leap), true);
});
test('an unrecorded date stays explicitly unavailable with null amounts across every band', () => {
  const value = report(); value.previous.date = '2026-10-26'; value.previous.available = false;
  value.previous.total_cents = null; value.previous.title_count = null;
  value.previous.bands.forEach(band => { band.amount_cents = null; band.title_count = null; });
  assert.equal(validDelinquencyComparison(value), true);
  value.previous.bands[0].amount_cents = 0; assert.equal(validDelinquencyComparison(value), false);
  value.previous.bands[0].amount_cents = null; value.first_available_date = null;
  assert.equal(validDelinquencyComparison(value), false);
  value.current.available = false; value.current.total_cents = null; value.current.title_count = null;
  value.current.bands.forEach(band => { band.amount_cents = null; band.title_count = null; });
  assert.equal(validDelinquencyComparison(value), true);
});
