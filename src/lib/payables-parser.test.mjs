import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseCivilDate, parseMoneyCents, parseCsv, inspectWorkbookZip, validateWorkbookExpandedSize, validatePayableRows } from './payables-parser.mjs';

const header = ['Nº Lançamento','Histórico','Vencimento','Valor','Plano de Contas','Filial'];
const row = ['14','Fornecedor sintético','16/10/2026','1.234,56','ENERGIA','3'];
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
