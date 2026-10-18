import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseCivilDate, parseMoneyCents, parseCsv, inspectWorkbookZip, validateWorkbookExpandedSize, validatePayableRows } from './payables-parser.mjs';

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
