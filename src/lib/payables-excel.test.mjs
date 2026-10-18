import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { addCivilDays, financialWeek, financialWeekLabel, monthBounds, previousMonth, comparisonRanges } from './financial-dates.ts';
import { buildPayablesWorkbook, payablesWorkbookFilename, MAX_PAYABLE_WORKBOOK_ROWS, PAYABLE_EXPORT_HEADERS, PAYABLE_FINANCIAL_HEADERS } from './payables-excel.ts';

const filters = { scope: 'grupo-consolidado', search: '', start: '', end: '', status: '', macro: '', branch: '' };
const options = { month: '2026-10', filters, fullMonth: true, generatedAt: '2026-10-18T01:15:32.000Z', importId: 'synthetic-import-1' };
const title = (id, overrides = {}) => ({ id, scope: 'grupo-consolidado', source_key: `key-${id}`, entry_number: `N-${id}`, description: `Fornecedor sintético ${id}`, due_date: '2026-10-16', amount_cents: 12345, source_status: 'Pendente', plan: 'PLANO TESTE', bank_account: 'Banco sintético', branch: 'FILIAL TESTE', issued_on: '2026-10-01', macro: 'FIXO', status: 'NEW', settled_at: null, ...overrides });
const previous = (id, overrides = {}) => title(id, { due_date: '2026-09-16', issued_on: '2026-09-01', ...overrides });
const payment = (id, overrides = {}) => ({ id, title_id: 'invoice-selected', entry_number: 'N-invoice-selected', description: 'Fornecedor sintético pago', branch: 'FILIAL TESTE', macro_snapshot: 'FIXO', amount_cents: 500, paid_on: '2026-10-12', bank_label: 'Banco sintético A', created_at: '2026-10-12T13:00:00.000Z', created_by: 'synthetic-finance-user', cancelled_at: null, ...overrides });
const summaryValue = (book, label) => {
  const sheet = book.getWorksheet('Resumo do mês');
  let result;
  sheet.eachRow(row => { if (row.getCell(1).value === label) result = row.getCell(2).value; });
  return result;
};
const findMacro = (book, sheetName, name) => {
  let result;
  book.getWorksheet(sheetName).eachRow(row => { if (row.getCell(1).value === name) result = row; });
  return result;
};

test('financial week is Saturday through Friday across month, year and leap boundaries', () => {
  assert.deepEqual(financialWeek('2026-10-17'), { start: '2026-10-17', end: '2026-10-23' });
  assert.deepEqual(financialWeek('2026-10-23'), { start: '2026-10-17', end: '2026-10-23' });
  assert.deepEqual(financialWeek('2027-01-01'), { start: '2026-12-26', end: '2027-01-01' });
  assert.deepEqual(financialWeek('2024-02-29'), { start: '2024-02-24', end: '2024-03-01' });
  assert.equal(financialWeekLabel('2027-01-01'), '26/12/2026 a 01/01/2027');
  assert.equal(addCivilDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addCivilDays('2024-02-28', 2), '2024-03-01');
  for (const invalid of ['2026-02-29', '2026-13-01', '2026-10-32', '01/10/2026', '0000-01-01']) assert.throws(() => financialWeek(invalid));
});

test('comparison dates intersect filters with selected month and compare same ordinal days', () => {
  assert.deepEqual(comparisonRanges('2026-10', '2026-10-10', '2026-10-16'), { current: { start: '2026-10-10', end: '2026-10-16' }, previous: { start: '2026-09-10', end: '2026-09-16' } });
  assert.deepEqual(comparisonRanges('2026-03', '2026-03-30', '2026-03-31'), { current: { start: '2026-03-30', end: '2026-03-31' }, previous: { start: '2026-02-28', end: '2026-02-28' } });
  assert.deepEqual(comparisonRanges('2024-03', '2024-03-29', '2024-03-31').previous, { start: '2024-02-29', end: '2024-02-29' });
  assert.deepEqual(comparisonRanges('2026-02').previous, { start: '2026-01-01', end: '2026-01-31' });
  assert.deepEqual(comparisonRanges('2026-01', '2025-12-01', '2026-02-10').previous, { start: '2025-12-01', end: '2025-12-31' });
  assert.deepEqual(monthBounds('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.throws(() => comparisonRanges('2026-10', '2026-11-01'), /não incluem/);
  assert.throws(() => comparisonRanges('2026-10', '2026-10-16', '2026-10-10'), /anterior/);
  assert.throws(() => comparisonRanges('2026-10', '2026-02-30'), /existente/);
});

test('workbook has exact required sheet order and fourteen launch columns with real numeric dates and money', async () => {
  const book = await buildPayablesWorkbook([title('b'), title('a', { due_date: '2026-10-15', amount_cents: 0, issued_on: null })], [], options);
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['TODOS OS LANÇAMENTOS', 'Resumo por Macro', 'Comparativo por Macro', 'Resumo do mês']);
  const sheet = book.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), [...PAYABLE_EXPORT_HEADERS]);
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell('B2').value, 'N-a');
  assert.equal(sheet.getCell('G2').value, null);
  assert.equal(sheet.getCell('J2').value, 0);
  assert.equal(sheet.getCell('N2').value, null);
  assert.ok(sheet.getCell('H2').value instanceof Date);
  assert.equal(sheet.getCell('H2').value.toISOString(), '2026-10-15T12:00:00.000Z');
  assert.equal(sheet.getCell('I2').value, '10/10/2026 a 16/10/2026');
  assert.equal(sheet.getCell('J3').value, 123.45);
  assert.equal(sheet.getCell('J3').numFmt, '"R$" #,##0.00;[Red]-"R$" #,##0.00');
  assert.equal(sheet.getCell('H3').numFmt, 'dd/mm/yyyy');
  assert.equal(sheet.getCell('M3').value, 'IMPORTAÇÃO DIÁRIA');
  assert.equal(summaryValue(book, 'Quantidade de lançamentos'), 2);
  assert.equal(summaryValue(book, 'Última importação da posição'), options.importId);
});

test('round-trip XLSX keeps literal formula-like text, typed dates, decimals and São Paulo timestamps', async () => {
  const original = await buildPayablesWorkbook([title('formula', { description: '=SUM(A1:A9)', entry_number: '+00012', plan: '@PLANO', branch: '-FILIAL', status: 'SETTLED_IMPORT', settled_at: '2026-10-18T01:15:32.000Z', amount_cents: 1 })], [], options);
  const bytes = await original.xlsx.writeBuffer();
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes);
  const row = book.worksheets[0].getRow(2);
  assert.equal(row.getCell(3).value, '=SUM(A1:A9)');
  assert.equal(row.getCell(3).type, ExcelJS.ValueType.String);
  assert.equal(row.getCell(2).value, '+00012');
  assert.equal(row.getCell(4).value, '@PLANO');
  assert.equal(row.getCell(5).value, '-FILIAL');
  assert.equal(row.getCell(10).value, 0.01);
  assert.equal(row.getCell(10).type, ExcelJS.ValueType.Number);
  assert.ok(row.getCell(14).value instanceof Date);
  assert.equal(row.getCell(14).value.toISOString(), '2026-10-17T22:15:32.000Z');
  assert.equal(row.getCell(14).numFmt, 'dd/mm/yyyy hh:mm');
  assert.equal(summaryValue(book, 'Gerado em — America/Sao_Paulo').toISOString(), '2026-10-17T22:15:32.000Z');
});

test('macros and month totals use exact integer cents and distinguish current open versus settled history', async () => {
  const book = await buildPayablesWorkbook([title('one', { amount_cents: 1 }), title('two', { amount_cents: 2, status: 'OPEN' }), title('settled', { amount_cents: 7, status: 'SETTLED_IMPORT', settled_at: '2026-10-18T12:00:00Z', macro: 'VARIÁVEL' })], [], options);
  const fixed = findMacro(book, 'Resumo por Macro', 'FIXO'), total = findMacro(book, 'Resumo por Macro', 'TOTAL');
  assert.deepEqual(fixed.values.slice(2, 8), [2, 2, 0, 0.03, 0, 0.03]);
  assert.equal(fixed.getCell(8).value, 0.3);
  assert.deepEqual(total.values.slice(2, 8), [3, 2, 1, 0.03, 0.07, 0.1]);
  assert.equal(total.getCell(8).value, 1);
  assert.equal(summaryValue(book, 'Total dos lançamentos'), 0.1);
  assert.equal(summaryValue(book, 'Total em aberto'), 0.03);
  assert.equal(summaryValue(book, 'Total quitado por importação'), 0.07);
});

test('comparison includes macros appearing in only one month and never invents a percentage with zero denominator', async () => {
  const book = await buildPayablesWorkbook([title('current', { amount_cents: 300, macro: 'FIXO' }), title('new', { amount_cents: 200, macro: 'FRETE' })], [previous('prior', { amount_cents: 100, macro: 'FIXO' }), previous('old', { amount_cents: 400, macro: 'IMPOSTO' })], options);
  assert.deepEqual(findMacro(book, 'Comparativo por Macro', 'FIXO').values.slice(2), [1, 1, 1, 3, 2, 2]);
  assert.deepEqual(findMacro(book, 'Comparativo por Macro', 'FRETE').values.slice(2), [0, 0, 1, 2, 2, '—']);
  assert.deepEqual(findMacro(book, 'Comparativo por Macro', 'IMPOSTO').values.slice(2), [1, 4, 0, 0, -4, -1]);
  assert.deepEqual(findMacro(book, 'Comparativo por Macro', 'TOTAL').values.slice(2), [2, 5, 2, 5, 0, 0]);
});

test('empty periods are valid zero totals, and zero-value macro participation remains undefined', async () => {
  const empty = await buildPayablesWorkbook([], [], { ...options, importId: null });
  assert.equal(empty.worksheets[0].rowCount, 1);
  assert.equal(summaryValue(empty, 'Quantidade de lançamentos'), 0);
  assert.equal(summaryValue(empty, 'Total dos lançamentos'), 0);
  assert.equal(summaryValue(empty, 'Última importação da posição'), 'Nenhuma importação');
  assert.equal(findMacro(empty, 'Comparativo por Macro', 'TOTAL').getCell(7).value, '—');
  const zero = await buildPayablesWorkbook([title('zero', { amount_cents: 0 })], [], options);
  assert.equal(findMacro(zero, 'Resumo por Macro', 'FIXO').getCell(8).value, '—');
  assert.equal(findMacro(zero, 'Resumo por Macro', 'TOTAL').getCell(8).value, '—');
});

test('filtered month export records actual ranges and keeps active filters as literal metadata', async () => {
  const selected = { ...filters, search: '=BUSCA()', start: '2026-10-10', end: '2026-10-16', status: 'OPEN', macro: 'FIXO', branch: 'FILIAL TESTE' };
  const ranges = comparisonRanges('2026-10', selected.start, selected.end);
  const book = await buildPayablesWorkbook([title('selected', { status: 'OPEN' })], [previous('prior')], { ...options, filters: selected, fullMonth: false, currentRange: ranges.current, previousRange: ranges.previous });
  assert.equal(summaryValue(book, 'Filtro: pesquisa'), '=BUSCA()');
  assert.equal(summaryValue(book, 'Filtro: status'), 'Em aberto');
  assert.equal(summaryValue(book, 'Filtro: macro'), 'FIXO');
  assert.equal(summaryValue(book, 'Comparação: início do mês anterior').toISOString(), '2026-09-10T12:00:00.000Z');
  assert.equal(summaryValue(book, 'Comparação: fim do mês anterior').toISOString(), '2026-09-16T12:00:00.000Z');
  assert.match(book.getWorksheet('Comparativo por Macro').getCell('C1').value, /10\/09\/2026 a 16\/09\/2026/);
  await assert.rejects(buildPayablesWorkbook([], [], { ...options, filters: selected, fullMonth: true }), /mês completo/);
  await assert.rejects(buildPayablesWorkbook([], [], { ...options, currentRange: { start: '2026-10-01', end: '2026-10-15' } }), /não correspondem/);
  await assert.rejects(buildPayablesWorkbook([title('outside', { due_date: '2026-10-09' })], [], { ...options, filters: selected, fullMonth: false }), /incompletos/);
});

test('Excel accepts conservative fifteen-digit cents and refuses extreme individual and aggregate precision loss', async () => {
  const book = await buildPayablesWorkbook([title('safe', { amount_cents: 999999999999999 })], [], options);
  const reloaded = new ExcelJS.Workbook(); await reloaded.xlsx.load(await book.xlsx.writeBuffer());
  assert.equal(reloaded.worksheets[0].getCell('J2').value, 9999999999999.99);
  assert.equal(summaryValue(reloaded, 'Total dos lançamentos'), 9999999999999.99);
  for (const rows of [[title('unsafe', { amount_cents: 1000000000000000 })], [title('maxsafe', { amount_cents: Number.MAX_SAFE_INTEGER })], [title('a', { amount_cents: 500000000000000 }), title('b', { amount_cents: 500000000000000 })]]) {
    await assert.rejects(buildPayablesWorkbook(rows, [], options), /15 algarismos/);
  }
  await assert.rejects(buildPayablesWorkbook([], [previous('prior', { amount_cents: Number.MAX_SAFE_INTEGER })], options), /15 algarismos/);
  await assert.rejects(buildPayablesWorkbook([], [previous('a', { amount_cents: 500000000000000 }), previous('b', { amount_cents: 500000000000000 })], options), /15 algarismos/);
});

test('invalid amounts, dates, statuses, duplicate ids, scope and mixed months fail before workbook generation', async () => {
  for (const invalid of [title('a', { amount_cents: -1 }), title('a', { amount_cents: 1.5 }), title('a', { amount_cents: NaN }), title('a', { amount_cents: '100' }), title('a', { amount_cents: Number.MAX_SAFE_INTEGER + 1 }), title('a', { due_date: '2026-09-30' }), title('a', { due_date: '2026-10-32' }), title('a', { issued_on: '2026-02-30' }), title('a', { status: 'CANCELLED' }), title('a', { status: 'SETTLED_IMPORT' }), title('a', { scope: 'other' }), title('a', { description: undefined })]) {
    await assert.rejects(buildPayablesWorkbook([invalid], [], options));
  }
  await assert.rejects(buildPayablesWorkbook([title('same'), title('same')], [], options), /incompletos/);
  await assert.rejects(buildPayablesWorkbook([], [title('wrong-prior')], options), /incompletos/);
  await assert.rejects(buildPayablesWorkbook([], [], { ...options, month: '2026-13' }), /mês válido/);
  await assert.rejects(buildPayablesWorkbook([], [], { ...options, generatedAt: '2026-10-18T10:00:00' }), /data e hora/);
});

test('large exports stop explicitly without returning a partial workbook', async () => {
  const tooMany = Array.from({ length: MAX_PAYABLE_WORKBOOK_ROWS + 1 }, (_, index) => title(`many-${index}`));
  await assert.rejects(buildPayablesWorkbook(tooMany, [], options), /nenhum arquivo parcial/);
  await assert.rejects(buildPayablesWorkbook([], tooMany, options), /nenhum arquivo parcial/);
});

test('filenames identify complete month versus filtered export and reject unsafe month text', () => {
  assert.equal(payablesWorkbookFilename('2026-10', true), 'Contas_a_Pagar_Lancamento_por_Lancamento_2026-10.xlsx');
  assert.equal(payablesWorkbookFilename('2026-10', false), 'Contas_a_Pagar_Filtrado_2026-10.xlsx');
  assert.throws(() => payablesWorkbookFilename('../2026-10', true), /mês válido/);
});

test('possible versions or installments warn without removing historical and open rows from XLSX totals', async () => {
  const rows = [title('older', { entry_number: 'SAME-TEST', amount_cents: 100, status: 'SETTLED_IMPORT', settled_at: '2026-10-17T12:00:00Z' }), title('newer', { entry_number: 'SAME-TEST', amount_cents: 200, status: 'OPEN' }), title('another-branch', { entry_number: 'SAME-TEST', branch: 'OUTRA FILIAL TESTE', amount_cents: 50 })];
  const original = await buildPayablesWorkbook(rows, [], options);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await original.xlsx.writeBuffer());
  const sheet = book.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), [...PAYABLE_EXPORT_HEADERS]);
  assert.equal(sheet.rowCount, 4);
  const records = [];
  sheet.eachRow((row, index) => { if (index > 1) records.push([row.getCell(5).value, row.getCell(10).value, row.getCell(11).value]); });
  assert.deepEqual(records, [['OUTRA FILIAL TESTE', 0.5, 'Novo'], ['FILIAL TESTE', 2, 'Em aberto'], ['FILIAL TESTE', 1, 'Quitado por importação']]);
  assert.equal(summaryValue(book, 'Quantidade de lançamentos'), 3);
  assert.equal(summaryValue(book, 'Total dos lançamentos'), 3.5);
  assert.equal(summaryValue(book, 'Total em aberto'), 2.5);
  assert.equal(summaryValue(book, 'Total quitado por importação'), 1);
  const warning = summaryValue(book, 'Atenção: possíveis versões ou parcelas');
  assert.match(warning, /^1 grupo\(s\)/);
  assert.match(warning, /Possíveis versões ou parcelas do mesmo lançamento/);
  assert.match(warning, /sem deduplicação automática/);
  assert.match(warning, /totais representam registros preservados, não comprovam pagamento/);
  assert.match(summaryValue(book, 'Significado da data de baixa automática'), /não é a data real de pagamento/);
  for (const worksheet of book.worksheets) assert.match(worksheet.headerFooter.oddFooter, /não é a data real de pagamento/);
  const distinct = await buildPayablesWorkbook([title('one'), title('two', { branch: 'OUTRA FILIAL TESTE', entry_number: 'N-one' })], [], options);
  assert.equal(summaryValue(distinct, 'Atenção: possíveis versões ou parcelas'), undefined);
});

test('financial XLSX keeps partial payments by actual date and bank, including invoices due elsewhere and immutable payment macros', async () => {
  const rows = [title('invoice-selected', { amount_cents: 2000, macro: 'VARIÁVEL', status: 'OPEN', paid_cents: 1500, outstanding_cents: 500, overpaid_cents: 0, financial_status: 'PARTIAL', last_payment_date: '2026-10-14', last_payment_bank: 'Banco sintético B' })];
  const payments = [payment('pay-a'), payment('pay-b', { amount_cents: 1000, paid_on: '2026-10-14', bank_label: 'Banco sintético B' }), payment('paid-other-due-month', { title_id: 'invoice-due-in-november', entry_number: 'OUTRO-MÊS', amount_cents: 300, paid_on: '2026-10-16', macro_snapshot: 'FRETE' })];
  const original = await buildPayablesWorkbook(rows, [], { ...options, payments });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await original.xlsx.writeBuffer());
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['TODOS OS LANÇAMENTOS', 'Resumo por Macro', 'Comparativo por Macro', 'Resumo do mês', 'Pagamentos realizados', 'Realizado por Macro']);
  const launches = book.worksheets[0], row = launches.getRow(2);
  assert.deepEqual(launches.getRow(1).values.slice(1), [...PAYABLE_EXPORT_HEADERS, ...PAYABLE_FINANCIAL_HEADERS]);
  assert.equal(row.getCell(10).value, 20);
  assert.equal(row.getCell(11).value, 'Em aberto');
  assert.equal(row.getCell(15).value, 15);
  assert.equal(row.getCell(16).value, 5);
  assert.equal(row.getCell(17).value, 'Pendência de registro anterior');
  assert.equal(row.getCell(18).value.toISOString(), '2026-10-14T12:00:00.000Z');
  assert.equal(row.getCell(19).value, 'Banco sintético B');
  assert.equal(row.getCell(20).value, 0);
  assert.equal(summaryValue(book, 'Total dos lançamentos'), 20);
  assert.equal(summaryValue(book, 'Total em aberto'), 5);
  assert.equal(findMacro(book, 'Resumo por Macro', 'VARIÁVEL').getCell(5).value, 5);
  assert.equal(summaryValue(book, 'Valor pago histórico dos títulos selecionados'), 15);
  assert.equal(summaryValue(book, 'Realizado: total pago no período'), 18);
  assert.match(summaryValue(book, 'Critério do realizado'), /independente do vencimento/);
  assert.match(summaryValue(book, 'Critério do realizado'), /também restringem os pagamentos pela situação atual/);
  assert.equal(findMacro(book, 'Realizado por Macro', 'FIXO').getCell(3).value, 15);
  assert.equal(findMacro(book, 'Realizado por Macro', 'VARIÁVEL'), undefined);
  assert.equal(findMacro(book, 'Realizado por Macro', 'FRETE').getCell(3).value, 3);
  const actual = book.getWorksheet('Pagamentos realizados');
  assert.equal(actual.rowCount, 4);
  assert.equal(actual.getCell('G2').value.toISOString(), '2026-10-12T12:00:00.000Z');
  assert.equal(actual.getCell('H2').value, 'Banco sintético A');
  assert.equal(actual.getCell('H3').value, 'Banco sintético B');
  assert.equal(actual.getCell('B4').value, 'invoice-due-in-november');
  assert.equal(actual.getCell('K2').value, 'synthetic-finance-user');
  assert.equal(actual.getCell('I2').type, ExcelJS.ValueType.Number);
  assert.equal(actual.getCell('I2').numFmt, '"R$" #,##0.00;[Red]-"R$" #,##0.00');
});

test('active empty ledger means zero realized, while missing financial fields remain unknown and overpayment stays flagged', async () => {
  const rows = [title('pending', { status: 'SETTLED_IMPORT', settled_at: '2026-10-17T12:00:00Z', amount_cents: 100, paid_cents: 0, outstanding_cents: 0, overpaid_cents: 0, financial_status: 'PENDING_RECONCILIATION', last_payment_date: null, last_payment_bank: null }), title('overpaid', { amount_cents: 50, paid_cents: 75, outstanding_cents: 0, overpaid_cents: 25, financial_status: 'OVERPAID', last_payment_date: '2026-09-20', last_payment_bank: 'Banco sintético A' })];
  const original = await buildPayablesWorkbook(rows, [], { ...options, payments: [] });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await original.xlsx.writeBuffer());
  assert.equal(summaryValue(book, 'Realizado: total pago no período'), 0);
  assert.equal(summaryValue(book, 'Valor pago histórico dos títulos selecionados'), 0.75);
  assert.equal(summaryValue(book, 'Crédito por pagamentos excedentes'), 0.25);
  assert.equal(summaryValue(book, 'Total em aberto'), 0);
  assert.equal(book.getWorksheet('Pagamentos realizados').rowCount, 1);
  assert.deepEqual(findMacro(book, 'Realizado por Macro', 'TOTAL').values.slice(2), [0, 0, '—']);
  const launches = book.worksheets[0];
  assert.equal(launches.getCell('J2').value, 0.5);
  assert.equal(launches.getCell('Q2').value, 'Pagamento excedente — revisar');
  assert.equal(launches.getCell('T2').value, 0.25);
  assert.equal(launches.getCell('J3').value, 1);
  assert.equal(launches.getCell('O3').value, 0);
  assert.equal(launches.getCell('P3').value, 0);
  assert.equal(launches.getCell('Q3').value, 'Aguardando conciliação');
  assert.equal(launches.getCell('R3').value, null);
  assert.equal(launches.getCell('S3').value, null);
  const unknown = await buildPayablesWorkbook([title('legacy')], [], { ...options, payments: [] });
  assert.equal(unknown.worksheets[0].getCell('O2').value, 'INFORMAÇÃO INDISPONÍVEL');
  assert.equal(unknown.worksheets[0].getCell('P2').value, 'INFORMAÇÃO INDISPONÍVEL');
  assert.equal(summaryValue(unknown, 'Valor pago histórico dos títulos selecionados'), 'INFORMAÇÃO INDISPONÍVEL');
  assert.equal(summaryValue(unknown, 'Crédito por pagamentos excedentes'), 'INFORMAÇÃO INDISPONÍVEL');
  assert.match(summaryValue(unknown, 'Saldos sem conciliação disponível'), /sem presumir pagamentos/);
  const legacy = await buildPayablesWorkbook([title('legacy')], [], options);
  assert.equal(legacy.worksheets.length, 4);
  assert.equal(legacy.worksheets[0].columnCount, 14);
});

test('financial export rejects cancelled or duplicate receipts, wrong dates and unsafe money instead of inflating realized totals', async () => {
  for (const payments of [[payment('cancelled', { cancelled_at: '2026-10-13T12:00:00Z' })], [payment('zero', { amount_cents: 0 })], [payment('negative', { amount_cents: -1 })], [payment('other-month', { paid_on: '2026-09-30' })], [payment('invalid-date', { paid_on: '2026-10-32' })], [payment('bad-author', { created_by: '' })], [payment('same'), payment('same')]]) await assert.rejects(buildPayablesWorkbook([], [], { ...options, payments }), /pagamentos|data|Data/);
  await assert.rejects(buildPayablesWorkbook([], [], { ...options, payments: [payment('unsafe', { amount_cents: Number.MAX_SAFE_INTEGER })] }), /15 algarismos/);
  await assert.rejects(buildPayablesWorkbook([], [], { ...options, payments: [payment('one', { amount_cents: 500000000000000 }), payment('two', { amount_cents: 500000000000000 })] }), /15 algarismos/);
  await assert.rejects(buildPayablesWorkbook([title('unsafe-historical', { paid_cents: Number.MAX_SAFE_INTEGER })], [], { ...options, payments: [] }), /15 algarismos/);
  await assert.rejects(buildPayablesWorkbook([title('one', { paid_cents: 500000000000000 }), title('two', { paid_cents: 500000000000000 })], [], { ...options, payments: [] }), /15 algarismos/);
  await assert.rejects(buildPayablesWorkbook([title('bad-balance', { outstanding_cents: -1 })], [], { ...options, payments: [] }), /valor financeiro/);
});

test('audited payment macro correction changes realized grouping while retaining its original snapshot', async () => {
  const original = await buildPayablesWorkbook([], [], { ...options, payments: [payment('corrected', { macro_snapshot: 'FIXO', effective_macro: 'VARIÁVEL', amount_cents: 123 })] });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await original.xlsx.writeBuffer());
  assert.equal(findMacro(book, 'Realizado por Macro', 'FIXO'), undefined);
  assert.equal(findMacro(book, 'Realizado por Macro', 'VARIÁVEL').getCell(3).value, 1.23);
  const detail = book.getWorksheet('Pagamentos realizados');
  assert.equal(detail.getCell('F2').value, 'FIXO');
  assert.equal(detail.getCell('L2').value, 'VARIÁVEL');
  assert.match(summaryValue(book, 'Macro do realizado'), /correção auditada/);
});

test('financial and review filters remain visible in report metadata and cannot label a filtered workbook as full month', async () => {
  const financial = await buildPayablesWorkbook([], [], { ...options, fullMonth: false, filters: { ...filters, financialStatus: 'PARTIAL', reviewStatus: 'A_CONCILIAR' }, payments: [] });
  assert.equal(summaryValue(financial, 'Filtro: situação financeira'), 'Pendência de registro anterior');
  assert.equal(summaryValue(financial, 'Filtro: conferência'), 'A conciliar');
  await assert.rejects(buildPayablesWorkbook([], [], { ...options, filters: { ...filters, financialStatus: 'PAID' } }), /mês completo/);
  await assert.rejects(buildPayablesWorkbook([], [], { ...options, filters: { ...filters, reviewStatus: 'CONCILIADO' } }), /mês completo/);
});

test('XLSX preserves leading-zero cheques and separate payment snapshots without deduplicating titles paid by the same cheque', async () => {
  const rows = [title('one-cheque', { amount_cents: 100, cheque_number: '000123' }), title('two-cheque', { amount_cents: 200, cheque_number: '000123' })];
  const payments = [payment('first-cheque-payment', { title_id: rows[0].id, amount_cents: 100, cheque_number: '000099' }), payment('second-cheque-payment', { title_id: rows[1].id, amount_cents: 200, cheque_number: '000099' })];
  const original = await buildPayablesWorkbook(rows, [], { ...options, payments });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await original.xlsx.writeBuffer());
  const launches = book.worksheets[0], actual = book.getWorksheet('Pagamentos realizados');
  assert.deepEqual(launches.getRow(1).values.slice(1, 15), [...PAYABLE_EXPORT_HEADERS]);
  assert.equal(launches.getCell('U1').value, 'Nº cheque');
  assert.equal(launches.columnCount, 21);
  assert.equal(launches.rowCount, 3);
  for (const address of ['U2', 'U3']) {
    assert.equal(launches.getCell(address).value, '000123');
    assert.equal(launches.getCell(address).type, ExcelJS.ValueType.String);
    assert.equal(launches.getCell(address).numFmt, '@');
  }
  assert.equal(actual.getCell('L1').value, 'Macro efetivo — classificação auditada');
  assert.equal(actual.getCell('M1').value, 'Nº cheque no pagamento');
  assert.equal(actual.getCell('M2').value, '000099');
  assert.equal(actual.getCell('M3').value, '000099');
  assert.equal(actual.getCell('M2').type, ExcelJS.ValueType.String);
  assert.equal(actual.getCell('M2').numFmt, '@');
  assert.equal(summaryValue(book, 'Quantidade de lançamentos'), 2);
  assert.equal(summaryValue(book, 'Total dos lançamentos'), 3);
  assert.equal(summaryValue(book, 'Realizado: quantidade de pagamentos'), 2);
  assert.equal(summaryValue(book, 'Realizado: total pago no período'), 3);
  assert.match(summaryValue(book, 'Número do cheque'), /não identifica sozinho o título/);
});

test('unknown cheque numbers stay blank and old payment snapshots never inherit a newer title cheque', async () => {
  const original = await buildPayablesWorkbook([title('known-title', { cheque_number: '000456' }), title('unknown-title', { cheque_number: null })], [], { ...options, payments: [payment('old-unreported-cheque')] });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await original.xlsx.writeBuffer());
  assert.equal(book.worksheets[0].getCell('U2').value, '000456');
  assert.equal(book.worksheets[0].getCell('U3').value, null);
  assert.equal(book.getWorksheet('Pagamentos realizados').getCell('M2').value, null);
  const noFinance = await buildPayablesWorkbook([title('unreported', { cheque_number: null, entry_number: '000123', bank_account: 'CHEQUE 000999' })], [], options);
  assert.equal(noFinance.worksheets[0].columnCount, 15);
  assert.equal(noFinance.worksheets[0].getCell('O1').value, 'Nº cheque');
  assert.equal(noFinance.worksheets[0].getCell('O2').value, null);
  const oldFormat = await buildPayablesWorkbook([title('old-format')], [], options);
  assert.equal(oldFormat.worksheets[0].columnCount, 14);
});

test('formula-like cheque text stays literal, while numeric cheque payloads fail instead of silently dropping leading zeroes', async () => {
  const original = await buildPayablesWorkbook([title('formula-cheque', { cheque_number: '=SUM(A1:A9)' })], [], { ...options, payments: [payment('formula-payment', { cheque_number: '+000123' })] });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await original.xlsx.writeBuffer());
  assert.equal(book.worksheets[0].getCell('U2').value, '=SUM(A1:A9)');
  assert.equal(book.worksheets[0].getCell('U2').type, ExcelJS.ValueType.String);
  assert.equal(book.getWorksheet('Pagamentos realizados').getCell('M2').value, '+000123');
  assert.equal(book.getWorksheet('Pagamentos realizados').getCell('M2').type, ExcelJS.ValueType.String);
  await assert.rejects(buildPayablesWorkbook([title('numeric-cheque', { cheque_number: 123 })], [], options), /cheque deve ser texto/);
  await assert.rejects(buildPayablesWorkbook([], [], { ...options, payments: [payment('numeric-payment-cheque', { cheque_number: 123 })] }), /cheque deve ser texto/);
});
