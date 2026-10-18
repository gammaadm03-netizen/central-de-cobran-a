import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseCivilDate, parseMoneyCents, parseCsv, inspectWorkbookZip, validateWorkbookExpandedSize, validatePayableRows, validatePayablePaidRows, isChequeNumberHeader, readPayableChequeCell } from './payables-parser.mjs';

const header = ['Nº Lançamento','Histórico','Vencimento','Valor','Plano de Contas','Filial'];
const row = ['14','Fornecedor sintético','16/10/2026','1.234,56','ENERGIA','3'];
const erpHeader = ['Lançamento', 'Histórico', 'Plano cp - Conta: nome', 'Plano cc - Conta: nome', 'Emissão: valor do lançamento', 'Emissão: data', 'Vencimento: data', 'Filial', 'Situação'];
const erpRow = ['80', 'Fornecedor de teste', 'ENERGIA - FIXO', 'BANCO TESTE - CONTA 1', '125,90', '16/10/2026 15:03', '20/10/2026 00:00', '7', 'CHEQUE'];
test('CSV brasileiro preserva delimitadores, aspas e quebras de linha entre aspas', () => {
  const matrix = parseCsv('\uFEFF' + header.join(';') + '\r\n14;"Fornecedor; A ""B""\nUnidade";16/10/2026;"1.234,56";ENERGIA;3\r\n');
  assert.equal(matrix[1][1], 'Fornecedor; A "B"\nUnidade');
  const result = validatePayableRows(matrix);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].amount_cents,123456);
  assert.equal(result.rows[0].due_date,'2026-10-16');
  assert.equal(result.rows[0].description,'Fornecedor; A "B" Unidade');
});
test('CSV com vírgula respeita valores brasileiros entre aspas e recusa aspas truncadas', () => {
  assert.equal(parseCsv('a,b,c\n1,"2,30",3')[1][1],'2,30');
  assert.throws(() => parseCsv('a;b\n1;"sem fim'), /fechamento/);
  assert.throws(() => parseCsv('a;b\n1;"b"erro'), /fechamento/);
});
test('centavos exatos não aceitam arredondamento, texto inválido ou notação estrangeira ambígua', () => {
  assert.equal(parseMoneyCents('R$ 1.234.567,89'),123456789);
  assert.equal(parseMoneyCents(19.99),1999);
  assert.equal(parseMoneyCents(90071992547409.9),9007199254740990);
  assert.equal(parseMoneyCents('0,01'),1);
  for (const invalid of ['',NaN,-1,'-1,00','1,234','1.23','12.34,00','1e3','1 234,56',1.001,0.1+0.2]) assert.throws(() => parseMoneyCents(invalid));
});
test('datas civis são estáveis, validam calendário e recusam datas abreviadas e horas', () => {
  assert.equal(parseCivilDate('29/02/2024'),'2024-02-29');
  assert.equal(parseCivilDate('2026-10-16'),'2026-10-16');
  assert.equal(parseCivilDate(1),'1900-01-01');
  assert.equal(parseCivilDate(61),'1900-03-01');
  assert.equal(parseCivilDate(1,true),'1904-01-02');
  for (const invalid of ['31/02/2026','1/2/26','10/16/2026','2026-10-16T00:00:00Z',60,45000.5,new Date('2026-10-16T12:00:00Z')]) assert.throws(() => parseCivilDate(invalid));
});
test('ausência de coluna, duplicidade de cabeçalho ou linha inválida bloqueiam a base inteira', () => {
  const missing = validatePayableRows([header.slice(0,-1),row]); assert.equal(missing.rows.length,0); assert.match(missing.errors[0].problem,/ausente/);
  const duplicate = validatePayableRows([[...header,'Descrição'],[...row,'Outra']]); assert.match(duplicate.errors[0].problem,/duplicada/);
  const invalid = validatePayableRows([header,row,['15','Outro','31/02/2026','2,00','ENERGIA','3']]); assert.equal(invalid.rows.length,0); assert.equal(invalid.errors[0].line,3);
});
test('chave não depende da linha e títulos duplicados ou fórmulas nunca são importados silenciosamente', () => {
  assert.equal(validatePayableRows([header,row,row]).rows.length,0);
  const formula = validatePayableRows([header,[...row.slice(0,3),{ formula:'SUM(A1:A2)',result:10 },...row.slice(4)]]); assert.equal(formula.rows.length,0); assert.match(formula.errors[0].problem,/Fórmula/);
  const extra = validatePayableRows([[...header,'Extra'],[...row,{ formula:'1+1',result:2 }]]); assert.equal(extra.rows.length,0);
  const ragged = validatePayableRows([header,[...row,'Unexpected value']]); assert.equal(ragged.rows.length,0);
});
test('XLSX real passa preflight e tamanho expandido forjado é recusado antes do carregamento', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('CP'); sheet.addRow(header); sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer(); const actual = Uint8Array.from(buffer).buffer;
  const entries = inspectWorkbookZip(actual); assert.ok(entries.length > 0); await validateWorkbookExpandedSize(actual);
  const forged = actual.slice(0), view = new DataView(forged);
  let changed = false;
  for (let index = 0; index < forged.byteLength - 46; index++) if (view.getUint32(index,true) === 0x02014b50 && view.getUint32(index+24,true)>1) { view.setUint32(index+24,0,true); changed=true; break; }
  assert.equal(changed,true); await assert.rejects(validateWorkbookExpandedSize(forged),/expandido/);
});
test('base vazia e total maior que o inteiro seguro bloqueiam baixa por importação', () => {
  assert.equal(validatePayableRows([header]).rows.length,0);
  const result = validatePayableRows([header,['1','A','16/10/2026',90071992547409.9,'PLANO','3'],['2','B','16/10/2026',90071992547409.9,'PLANO','3']]);
  assert.equal(result.rows.length,0); assert.ok(result.errors.length > 0);
});
test('cabeçalhos explícitos do ERP preservam plano CP, conta bancária, emissão e vencimento', () => {
  const result = validatePayableRows([erpHeader, erpRow]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [{ entry_number:'80', description:'Fornecedor de teste', plan:'ENERGIA - FIXO', bank_account:'BANCO TESTE - CONTA 1', amount_cents:12590, issued_on:'2026-10-16', due_date:'2026-10-20', branch:'7', source_status:'CHEQUE' }]);
  const withoutStatus = validatePayableRows([erpHeader.slice(0, -1), erpRow.slice(0, -1)]);
  assert.deepEqual(withoutStatus.errors, []);
  assert.equal(withoutStatus.rows[0].source_status, '');
});
test('modelo ERP exige filial explícita e nunca a deduz da descrição do banco', () => {
  const result = validatePayableRows([erpHeader.filter((_, index) => index !== 7), erpRow.filter((_, index) => index !== 7)]);
  assert.deepEqual(result.rows, []);
  assert.ok(result.errors.some(error => error.column === 'Filial' && /ausente/.test(error.problem)));
});
test('horário nas colunas ERP é validado sem mudar o dia civil; calendários e horas inválidas bloqueiam tudo', () => {
  const valid = validatePayableRows([erpHeader, [...erpRow.slice(0, 5), '29/02/2024 23:59:59', '01/03/2024 00:01', ...erpRow.slice(7)]]);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.rows[0].issued_on, '2024-02-29');
  assert.equal(valid.rows[0].due_date, '2024-03-01');
  for (const date of ['31/02/2026 15:03', '29/02/2026 15:03', '16/10/2026 24:00', '16/10/2026 23:60', '16/10/2026 23:59:60', '16/10/2026 1:00', '16/10/2026 15:3', '2026-10-16T00:00:00Z', '16/10/2026 15:03 -03:00']) {
    const result = validatePayableRows([erpHeader, [...erpRow.slice(0, 5), date, ...erpRow.slice(6)]]);
    assert.deepEqual(result.rows, [], date);
    assert.ok(result.errors.some(error => error.column === 'Emissão'), date);
  }
});
test('datas ERP em Date e serial fracionário conservam campos UTC, rejeitam data Excel fictícia e respeitam 1904', () => {
  const result = validatePayableRows([erpHeader, [...erpRow.slice(0, 5), new Date('2026-10-16T00:01:01Z'), new Date('2026-10-20T23:59:59Z'), ...erpRow.slice(7)]]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].issued_on, '2026-10-16');
  assert.equal(result.rows[0].due_date, '2026-10-20');
  const serial = validatePayableRows([erpHeader, [...erpRow.slice(0, 5), 45000.999, 45001.001, ...erpRow.slice(7)]]);
  assert.deepEqual(serial.errors, []);
  assert.equal(serial.rows[0].issued_on, parseCivilDate(45000));
  assert.equal(serial.rows[0].due_date, parseCivilDate(45001));
  const serial1904 = validatePayableRows([erpHeader, [...erpRow.slice(0, 5), 1.5, 2.75, ...erpRow.slice(7)]], { excel1904: true });
  assert.deepEqual(serial1904.errors, []);
  assert.equal(serial1904.rows[0].issued_on, '1904-01-02');
  assert.equal(serial1904.rows[0].due_date, '1904-01-03');
  for (const date of [60.5, 0.5, -1, Infinity, NaN, new Date(NaN)]) {
    assert.equal(validatePayableRows([erpHeader, [...erpRow.slice(0, 5), date, ...erpRow.slice(6)]]).rows.length, 0);
  }
});
test('XLSX real do ERP conserva datas com hora em células Date e serial; o parser compartilhado continua somente data', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('CP');
  sheet.addRow(erpHeader);
  sheet.addRow([...erpRow.slice(0, 5), new Date('2026-10-16T00:01:00Z'), new Date('2026-10-20T23:59:00Z'), ...erpRow.slice(7)]);
  sheet.getCell('F2').numFmt = 'dd/mm/yyyy hh:mm'; sheet.getCell('G2').numFmt = 'dd/mm/yyyy hh:mm';
  sheet.addRow(['81', ...erpRow.slice(1, 5), 45000.75, 45001.25, ...erpRow.slice(7)]);
  const reopened = new ExcelJS.Workbook(); await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const matrix = []; reopened.worksheets[0].eachRow({ includeEmpty: true }, source => matrix.push(Array.from({ length: reopened.worksheets[0].columnCount }, (_, column) => source.getCell(column + 1).value)));
  assert.ok(matrix[1][5] instanceof Date);
  assert.equal(typeof matrix[2][5], 'number');
  const result = validatePayableRows(matrix, { excel1904: reopened.properties.date1904 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].issued_on, '2026-10-16');
  assert.equal(result.rows[0].due_date, '2026-10-20');
  assert.equal(result.rows[1].issued_on, parseCivilDate(45000));
  assert.equal(result.rows[1].due_date, parseCivilDate(45001));
  assert.throws(() => parseCivilDate(matrix[1][5]), /horário/);
  assert.throws(() => parseCivilDate(matrix[2][5]), /horário/);
  assert.throws(() => parseCivilDate('16/10/2026 15:03'), /dd\/mm\/aaaa/);
  assert.equal(validatePayableRows([header, [...row.slice(0, 2), new Date('2026-10-16T12:00:00Z'), ...row.slice(3)]]).rows.length, 0);
});
test('ERP recusa cabeçalhos duplicados, valores sem significado confirmado e fórmulas', () => {
  for (const duplicate of ['Valor', 'Plano de Contas', 'Banco', 'Emissão', 'Vencimento']) {
    const result = validatePayableRows([[...erpHeader, duplicate], [...erpRow, 'ignorado']]);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.some(error => /duplicada ou ambígua/.test(error.problem)), duplicate);
  }
  for (const unknownAmount of ['Emissão: valor c', 'Emissão: valor corrigido', 'Saldo devedor', 'Valor pago']) {
    const result = validatePayableRows([[...erpHeader.slice(0, 4), unknownAmount, ...erpHeader.slice(5)], erpRow]);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.some(error => error.column === 'Valor' && /ausente/.test(error.problem)), unknownAmount);
  }
  for (const column of [3, 4, 5, 6]) {
    const values = [...erpRow]; values[column] = { formula: '1+1', result: 2 };
    const result = validatePayableRows([erpHeader, values]);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.some(error => /Fórmula não permitida/.test(error.problem)));
  }
});
test('número do cheque é opcional e só vem da coluna explícita, preservando zeros e identificadores textuais', () => {
  const withoutCheque = validatePayableRows([erpHeader, [...erpRow.slice(0, 1), 'Cheque: 999999 no histórico', ...erpRow.slice(2)]]);
  assert.deepEqual(withoutCheque.errors, []);
  assert.equal(Object.hasOwn(withoutCheque.rows[0], 'cheque_number'), false);
  for (const [source, expected] of [[' 000123 ', '000123'], ['AB-001 / 002', 'AB-001 / 002'], [123, '123'], [0, '0'], ['', ''], [null, ''], [undefined, '']]) {
    const result = validatePayableRows([[...erpHeader, 'Cheque: número'], [...erpRow, source]]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0].cheque_number, expected);
  }
  const csv = parseCsv([...erpHeader, 'Cheque: número'].join(';') + '\n' + [...erpRow, '000123'].join(';'));
  assert.equal(validatePayableRows(csv).rows[0].cheque_number, '000123');
  assert.equal(isChequeNumberHeader('Cheque: número'), true);
  assert.equal(isChequeNumberHeader(' CHEQUE : NUMERO '), true);
  for (const header of ['Nº lançamento', 'Número', 'Cheque', 'Histórico', 'Documento: número']) assert.equal(isChequeNumberHeader(header), false);
  const duplicate = validatePayableRows([[...erpHeader, 'Cheque: número', 'CHEQUE NUMERO'], [...erpRow, '000123', '000456']]);
  assert.deepEqual(duplicate.rows, []);
  assert.ok(duplicate.errors.some(error => error.column === 'Cheque: número' && /duplicada/.test(error.problem)));
});
test('número de cheque recusa frações, notação científica, booleanos, conteúdo inseguro e identificadores acima do limite', () => {
  for (const cheque of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, false, '1e3', '1E+03', '1,25', '1.25', '-1', '123\n456', '\u0000', '0'.repeat(151), new Date('2026-10-16T00:00:00Z'), '=100+1', { formula:'1+1', result:2 }]) {
    const result = validatePayableRows([[...erpHeader, 'Cheque: número'], [...erpRow, cheque]]);
    assert.deepEqual(result.rows, [], String(cheque));
    assert.ok(result.errors.some(error => error.column === 'Cheque: número'), String(cheque));
  }
  assert.equal(validatePayableRows([[...erpHeader, 'Cheque: número'], [...erpRow, '0'.repeat(150)]]).rows[0].cheque_number.length, 150);
});
test('adaptador de cheque conserva formato simples de zeros e recusa formatos numéricos que poderiam perder informação', () => {
  assert.equal(readPayableChequeCell(123, '000000'), '000123');
  assert.equal(readPayableChequeCell(1234567, '000000'), '1234567');
  assert.equal(readPayableChequeCell(0, '000000'), '000000');
  assert.equal(readPayableChequeCell(123, 'General'), '123');
  assert.equal(readPayableChequeCell(123, '@'), '123');
  assert.equal(readPayableChequeCell('000123', '0.00'), '000123');
  assert.equal(readPayableChequeCell(null, '000000'), '');
  for (const format of ['0.00', '0E+00', '#,##0', '000000;[Red]-000000', 'dd/mm/yyyy', '[>=0]000000', '"CH"000000']) assert.throws(() => readPayableChequeCell(123, format), /Formato da célula do cheque não suportado/);
  assert.throws(() => readPayableChequeCell(123, '0'.repeat(151)), /150 caracteres/);
  assert.throws(() => readPayableChequeCell(new Date('2026-10-16T00:00:00Z'), 'dd/mm/yyyy'), /Formato da célula do cheque não suportado/);
});
test('XLSX real preserva cheque como texto ou número com zeros de apresentação, sem afetar as datas ERP', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('CP');
  sheet.addRow([...erpHeader, 'Cheque: número']);
  sheet.addRow([...erpRow, '000123']);
  sheet.addRow(['81', ...erpRow.slice(1), 123]); sheet.getCell('J3').numFmt = '000000';
  sheet.addRow(['82', ...erpRow.slice(1), 'AB-0007']);
  sheet.addRow(['83', ...erpRow.slice(1), null]);
  const reopened = new ExcelJS.Workbook(); await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const loaded = reopened.worksheets[0], chequeColumns = [];
  loaded.getRow(1).eachCell((cell, column) => { if (isChequeNumberHeader(cell.value)) chequeColumns.push(column); });
  const matrix = [];
  for (let index = 1; index <= loaded.rowCount; index++) {
    const source = loaded.getRow(index), values = source.values.slice(1);
    if (index > 1) for (const column of chequeColumns) { const cell = source.getCell(column); values[column - 1] = readPayableChequeCell(cell.value, cell.numFmt); }
    matrix.push(values);
  }
  const result = validatePayableRows(matrix);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map(row => row.cheque_number), ['000123', '000123', 'AB-0007', '']);
  assert.ok(result.rows.every(row => row.issued_on === '2026-10-16' && row.due_date === '2026-10-20'));
});
const paidHeader = ['Lançamento', 'Filial', 'Emissão: valor do lançamento', 'Plano cc - Conta: nome', 'Vencimento: data'];
const paidRow = [' 00a-8 ', ' 7 ', '125,90', 'BANCO TESTE - CONTA 1', '17/10/2026 23:59'];
test('relatório explicitamente pago dispensa plano e histórico e preserva data, banco e valor efetivos', () => {
  const result = validatePayablePaidRows([paidHeader, paidRow]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [{ branch:'7', entry_number:'00a-8', source_status:'PAGO', paid_on:'2026-10-17', amount_paid_cents:12590, paid_bank:'BANCO TESTE - CONTA 1' }]);
  assert.equal(Object.hasOwn(result.rows[0], 'cheque_number'), false);
  const full = validatePayablePaidRows([erpHeader, erpRow]);
  assert.deepEqual(full.errors, []);
  assert.equal(full.rows[0].source_status, 'PAGO');
  assert.equal(full.rows[0].paid_on, '2026-10-20');
  assert.equal(full.rows[0].amount_paid_cents, 12590);
  assert.equal(full.rows[0].paid_bank, 'BANCO TESTE - CONTA 1');
  assert.equal(Object.hasOwn(full.rows[0], 'due_date'), false);
  assert.equal(full.rows[0].plan, 'ENERGIA - FIXO');
  assert.equal(full.rows[0].description, 'Fornecedor de teste');
  assert.equal(full.rows[0].issued_on, '2026-10-16');
  assert.ok(validatePayableRows([paidHeader, paidRow]).errors.some(error => error.column === 'Plano de Contas'));
});
test('relatório pago exige valor, data e banco explícitos e não deduz pagamento pela emissão ou histórico', () => {
  for (let index = 0; index < paidHeader.length; index++) {
    const missing = validatePayablePaidRows([paidHeader.filter((_, column) => column !== index), paidRow.filter((_, column) => column !== index)]);
    assert.deepEqual(missing.rows, []);
    assert.ok(missing.errors.some(error => /ausente/.test(error.problem)), paidHeader[index]);
    const blank = [...paidRow]; blank[index] = '';
    assert.deepEqual(validatePayablePaidRows([paidHeader, blank]).rows, [], paidHeader[index]);
  }
  const onlyIssueDate = [...paidHeader]; onlyIssueDate[4] = 'Emissão: data';
  const result = validatePayablePaidRows([onlyIssueDate, paidRow]);
  assert.ok(result.errors.some(error => error.column === 'Vencimento' && /ausente/.test(error.problem)));
  for (const amount of [0, '0,00', -1, '1,234', 1.001]) assert.deepEqual(validatePayablePaidRows([paidHeader, [...paidRow.slice(0, 2), amount, ...paidRow.slice(3)]]).rows, []);
  for (const date of ['31/02/2026 00:00', '17/10/2026 24:00', '17/10/26', '2026-10-17T23:59:00-03:00']) assert.deepEqual(validatePayablePaidRows([paidHeader, [...paidRow.slice(0, 4), date]]).rows, []);
});
test('situação incompatível ou desconhecida bloqueia todos os pagamentos; cheque não prova pagamento fora do modo explícito', () => {
  for (const status of ['', 'pago', 'CHEQUE', 'QUITADO', 'LIQUIDADO', 'COMPENSADO']) {
    const result = validatePayablePaidRows([[...paidHeader, 'Situação'], [...paidRow, status]]);
    assert.deepEqual(result.errors, [], status);
    assert.equal(result.rows[0].source_status, 'PAGO');
  }
  for (const status of ['ABERTO', 'EM ABERTO', 'PENDENTE', 'CANCELADO', 'ESTORNADO', 'BAIXADO', 'DESCONHECIDO', 'PAGO!']) {
    const result = validatePayablePaidRows([[...paidHeader, 'Situação'], [...paidRow, 'PAGO'], ['80', ...paidRow.slice(1), status]]);
    assert.deepEqual(result.rows, [], status);
    assert.ok(result.errors.some(error => /situação incompatível/.test(error.problem)), status);
  }
  assert.equal(validatePayableRows([erpHeader, erpRow]).rows[0].source_status, 'CHEQUE');
});
test('pagamentos repetidos usam somente filial e lançamento, preservam pontuação da identidade e recusam fórmulas', () => {
  const duplicate = validatePayablePaidRows([paidHeader, paidRow, ['00A-8', '7', '130,00', 'OUTRO BANCO', '18/10/2026 00:00']]);
  assert.deepEqual(duplicate.rows, []);
  assert.ok(duplicate.errors.some(error => /Lançamento repetido/.test(error.problem)));
  const distinct = validatePayablePaidRows([paidHeader, paidRow, ['00a8', ...paidRow.slice(1)]]);
  assert.equal(distinct.rows.length, 2);
  for (let index = 0; index < paidHeader.length; index++) {
    const values = [...paidRow]; values[index] = { formula:'1+1', result:2 };
    assert.deepEqual(validatePayablePaidRows([paidHeader, values]).rows, []);
  }
  const extraFormula = validatePayablePaidRows([[...paidHeader, 'Histórico'], [...paidRow, { formula:'1+1', result:2 }]]);
  assert.deepEqual(extraFormula.rows, []);
  assert.ok(extraFormula.errors.some(error => /Fórmula/.test(error.problem)));
  assert.deepEqual(validatePayablePaidRows([paidHeader]).rows, []);
  const duplicateHeader = validatePayablePaidRows([[...paidHeader, 'Valor'], [...paidRow, '125,90']]);
  assert.ok(duplicateHeader.errors.some(error => /duplicada ou ambígua/.test(error.problem)));
});
test('pagamentos preservam cheque, data Excel com hora e centavos sem alterar os dados de previsão', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Pagamentos');
  sheet.addRow([...paidHeader, 'Cheque: número']);
  sheet.addRow([...paidRow.slice(0, 4), new Date('2026-10-17T23:59:00Z'), 123]);
  sheet.getCell('E2').numFmt = 'dd/mm/yyyy hh:mm'; sheet.getCell('F2').numFmt = '000000';
  const reopened = new ExcelJS.Workbook(); await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const source = reopened.worksheets[0].getRow(2), values = source.values.slice(1);
  values[5] = readPayableChequeCell(source.getCell(6).value, source.getCell(6).numFmt);
  const result = validatePayablePaidRows([[...paidHeader, 'Cheque: número'], values]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0], { branch:'7', entry_number:'00a-8', source_status:'PAGO', paid_on:'2026-10-17', amount_paid_cents:12590, paid_bank:'BANCO TESTE - CONTA 1', cheque_number:'000123' });
  const cleared = validatePayablePaidRows([[...paidHeader, 'Cheque: número'], [...paidRow, '']]);
  assert.equal(cleared.rows[0].cheque_number, '');
  const fractional = validatePayablePaidRows([paidHeader, [...paidRow.slice(0, 4), 45000.75]]);
  assert.equal(fractional.rows[0].paid_on, parseCivilDate(45000));
  const epoch1904 = validatePayablePaidRows([paidHeader, [...paidRow.slice(0, 4), 1.5]], { excel1904:true });
  assert.equal(epoch1904.rows[0].paid_on, '1904-01-02');
  assert.throws(() => parseCivilDate(source.getCell(5).value), /horário/);
});
test('relatório pago inclui metadados atuais somente quando informados, sem apagar descrição ou plano ausentes', () => {
  const absent = validatePayablePaidRows([paidHeader, paidRow]);
  assert.deepEqual(absent.errors, []);
  for (const key of ['description', 'plan', 'issued_on']) assert.equal(Object.hasOwn(absent.rows[0], key), false);
  const metadataHeader = [...paidHeader, 'Histórico', 'Plano cp - Conta: nome', 'Emissão: data'];
  const changed = validatePayablePaidRows([metadataHeader, [...paidRow, '  Histórico   atualizado  ', '  PLANO   CORRIGIDO ', '15/10/2026 23:59:59']]);
  assert.deepEqual(changed.errors, []);
  assert.deepEqual(changed.rows[0], { branch:'7', entry_number:'00a-8', source_status:'PAGO', paid_on:'2026-10-17', amount_paid_cents:12590, paid_bank:'BANCO TESTE - CONTA 1', description:'Histórico atualizado', plan:'PLANO CORRIGIDO', issued_on:'2026-10-15' });
  const empty = validatePayablePaidRows([metadataHeader, [...paidRow, '   ', null, '']]);
  assert.deepEqual(empty.errors, []);
  assert.equal(Object.hasOwn(empty.rows[0], 'description'), false);
  assert.equal(Object.hasOwn(empty.rows[0], 'plan'), false);
  assert.equal(empty.rows[0].issued_on, null);
  const excelDate = validatePayablePaidRows([metadataHeader, [...paidRow, 'Histórico', 'Plano', new Date('2026-10-15T23:59:59Z')]]);
  assert.equal(excelDate.rows[0].issued_on, '2026-10-15');
});
test('metadados opcionais de pagamento rejeitam datas inválidas, fórmulas e texto acima do limite de forma atômica', () => {
  const metadataHeader = [...paidHeader, 'Histórico', 'Plano cp - Conta: nome', 'Emissão: data'];
  for (const metadata of [
    ['Histórico', 'Plano', '31/02/2026 00:00'],
    ['Histórico', 'Plano', '15/10/2026 24:00'],
    ['x'.repeat(1501), 'Plano', '15/10/2026 00:00'],
    ['Histórico', 'x'.repeat(301), '15/10/2026 00:00'],
    [{ formula:'1+1', result:2 }, 'Plano', '15/10/2026 00:00'],
    ['Histórico', { formula:'1+1', result:2 }, '15/10/2026 00:00'],
    ['Histórico', 'Plano', { formula:'1+1', result:2 }],
  ]) {
    const result = validatePayablePaidRows([metadataHeader, [...paidRow, 'Histórico', 'Plano', '15/10/2026 00:00'], ['81', ...paidRow.slice(1), ...metadata]]);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.some(error => error.line === 3));
  }
  const genericDate = validatePayablePaidRows([[...paidHeader, 'Emissão'], [...paidRow, '15/10/2026 23:59']]);
  assert.deepEqual(genericDate.rows, []);
});
