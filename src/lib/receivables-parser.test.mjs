import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseCsv, validateWorkbookExpandedSize, validateReceivableRows, validateReceivablePaidRows, receivableCustomerKey, isReceivableIdentifierHeader, readReceivableIdentifierCell } from './receivables-parser.mjs';
import { parseCivilDate } from './payables-parser.mjs';
const header = ['NF','Órgão','Filial','Vencimento','Valor','Emissão','CNPJ'];
const row = ['00014','Cliente sintético','3','16/10/2026','1.234,56','01/10/2026','12.345.678/0001-90'];
test('relatório CR produz apenas campos canônicos e preserva centavos e identificadores', () => {
  const result = validateReceivableRows(parseCsv(header.join(';')+'\r\n'+row.join(';')));
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.rows,[{ document:'00014',client_name:'Cliente sintético',client_document:'12345678000190',branch:'3',issued_on:'2026-10-01',due_date:'2026-10-16',amount_cents:123456 }]);
  assert.equal(receivableCustomerKey(result.rows[0]),'cnpj:12345678000190');
});
test('campos opcionais ausentes não inventam CNPJ ou data e cliente normalizado estabiliza a chave', () => {
  const result = validateReceivableRows([header.slice(0,5),['14','  Cliente   sintético  ','3','2026-10-16',1.23]]);
  assert.deepEqual(result.errors,[]);
  assert.equal(result.rows[0].client_document,null); assert.equal(result.rows[0].issued_on,null);
  assert.equal(receivableCustomerKey(result.rows[0]),'name:CLIENTE SINTÉTICO');
  assert.equal(receivableCustomerKey({ client_document:null,client_name:'CLIENTE sintético' }),'name:CLIENTE SINTÉTICO');
});
test('espaços Unicode de planilhas são normalizados de modo estável antes da chave', () => {
  const result=validateReceivableRows([header.slice(0,5),['\uFEFF 00014\u00A0','\u00A0Prefeitura\u2003de\uFEFF teste ','\uFEFF 3\u00A0','16/10/2026','1,00']]);
  assert.deepEqual(result.errors,[]);assert.equal(result.rows[0].document,'00014');assert.equal(result.rows[0].branch,'3');assert.equal(receivableCustomerKey(result.rows[0]),'name:PREFEITURA DE TESTE');
});
test('CNPJ incompleto, CPF ou letras bloqueiam a base inteira sem completar zeros', () => {
  for (const value of ['1234567800019','123.456.789-00','12.345.678/0001-9x',1234567800019]) {
    const result = validateReceivableRows([header,[...row.slice(0,6),value]]);
    assert.deepEqual(result.rows,[]); assert.equal(result.errors[0].column,'CNPJ');
  }
});
test('cabeçalho ausente ou duplicado e valores fora das colunas impedem a importação', () => {
  const missing = validateReceivableRows([['NF','Cliente','Filial','Valor'],['14','A','3','1,00']]);
  assert.equal(missing.rows.length,0); assert.match(missing.errors[0].problem,/ausente/);
  const duplicate = validateReceivableRows([[...header,'Documento'],[...row,'outra']]);
  assert.match(duplicate.errors[0].problem,/duplicada/);
  assert.equal(validateReceivableRows([header,[...row,'valor perdido']]).rows.length,0);
});
test('data ou centavos inválidos bloqueiam inclusive linhas válidas anteriores', () => {
  for (const [column,value] of [[3,'31/02/2026'],[3,'1/2/26'],[4,'1,234'],[4,0.1+0.2]]) {
    const invalid = [...row]; invalid[column] = value;
    const result = validateReceivableRows([header,row,invalid]);
    assert.deepEqual(result.rows,[]); assert.equal(result.errors[0].line,3);
  }
});
test('duplicidade usa filial documento cliente e vencimento, nunca posição da linha', () => {
  const other = [...row]; other[0] = '15';
  assert.equal(validateReceivableRows([header,row,other]).rows.length,2);
  const duplicateName = [...row]; duplicateName[1] = '  cliente  SINTÉTICO '; duplicateName[6] = '';
  const noCnpj = [...row]; noCnpj[6] = '';
  assert.equal(validateReceivableRows([header,noCnpj,other,duplicateName]).rows.length,0);
  const differentClient = [...row]; differentClient[6] = '22345678000190';
  assert.equal(validateReceivableRows([header,row,differentClient]).rows.length,2);
});
test('fórmulas em campos conhecidos, extras e texto rico são recusadas sem avaliação', () => {
  for (const value of [{ formula:'SUM(A1:A2)',result:1 },'=1+1',{ richText:[{ text:'=1+1' }] },{ text:'=1+1',hyperlink:'https://example.invalid' }]) {
    assert.equal(validateReceivableRows([[...header,'Extra'],[...row,value]]).rows.length,0);
    const invalid = [...row]; invalid[1] = value;
    assert.equal(validateReceivableRows([header,invalid]).rows.length,0);
  }
});
test('arquivo vazio, limites de linhas colunas e soma insegura nunca geram baixa', () => {
  assert.equal(validateReceivableRows([]).rows.length,0);
  assert.equal(validateReceivableRows([header]).rows.length,0);
  assert.equal(validateReceivableRows([Array(101).fill('NF')]).rows.length,0);
  const many = Array.from({length:5001},(_,index) => [String(index),'Cliente','3','16/10/2026','1,00']);
  assert.equal(validateReceivableRows([header.slice(0,5),...many]).rows.length,0);
  const huge = [...row]; huge[4]='90.071.992.547.409,91'; const second=[...huge];second[0]='15';
  assert.equal(validateReceivableRows([header,huge,second]).rows.length,0);
});
test('XLSX real é validado com limite expandido e data civil sem conversão de fuso', async () => {
  const workbook = new ExcelJS.Workbook(),sheet=workbook.addWorksheet('CR');
  sheet.addRow(header); const source = [...row]; source[3]=new Date('2026-10-16T00:00:00Z');source[4]=1234.56;sheet.addRow(source);
  const bytes=Uint8Array.from(await workbook.xlsx.writeBuffer()).buffer;
  await validateWorkbookExpandedSize(bytes);
  const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(bytes);
  const result=validateReceivableRows([loaded.worksheets[0].getRow(1).values.slice(1),loaded.worksheets[0].getRow(2).values.slice(1)]);
  assert.deepEqual(result.errors,[]);assert.equal(result.rows[0].due_date,'2026-10-16');assert.equal(result.rows[0].amount_cents,123456);
});

const erpHeader = ['Entidade 1 - Entidade: nome', 'Documento: número', 'Emissão: valor do lançamento', 'Emissão: data', 'Vencimento: data', 'Filial'];
const erpRow = ['Cliente exclusivamente sintético', '000123', '125,90', '01/10/2026 15:03', '20/10/2026 00:00', 'FILIAL TESTE'];
const receivedHeader = [...erpHeader, 'Quitação: data do recebimento', 'Quitação: valor recebido'];
const receivedRow = [...erpRow, '17/10/2026 23:59', '120,00'];

test('relatório ERP de seis colunas reconhece cliente, documento e valores sem inventar lançamento ou CNPJ', () => {
  const result = validateReceivableRows([erpHeader, erpRow]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [{ document:'000123', client_name:'Cliente exclusivamente sintético', client_document:null, branch:'FILIAL TESTE', issued_on:'2026-10-01', due_date:'2026-10-20', amount_cents:12590 }]);
  const extra = validateReceivableRows([[...erpHeader, 'Lançamento', 'Parcela'], [...erpRow, 'ERP-10', '1/2']]);
  assert.deepEqual(extra.rows, result.rows);
  assert.equal(isReceivableIdentifierHeader('Documento: número'), true);
  assert.equal(isReceivableIdentifierHeader('Lançamento'), false);
});

test('recebimentos ERP preservam nominal e recebido diferentes e admitem recebimento anterior ao vencimento', () => {
  const less = validateReceivablePaidRows([receivedHeader, receivedRow]);
  assert.deepEqual(less.errors, []);
  assert.deepEqual(less.rows, [{ document:'000123', client_name:'Cliente exclusivamente sintético', client_document:null, branch:'FILIAL TESTE', issued_on:'2026-10-01', due_date:'2026-10-20', amount_cents:12590, received_on:'2026-10-17', received_amount_cents:12000 }]);
  const more = validateReceivablePaidRows([receivedHeader, [...erpRow, '17/10/2026 12:34:56', '130,00']]);
  assert.equal(more.rows[0].amount_cents, 12590); assert.equal(more.rows[0].received_amount_cents, 13000);
  assert.equal(more.rows[0].received_on, '2026-10-17'); assert.equal(more.rows[0].due_date, '2026-10-20');
});

test('recebimento exige as duas colunas efetivas, valor positivo e data válida sem recorrer ao nominal ou vencimento', () => {
  for (const index of [6, 7]) {
    const missing = validateReceivablePaidRows([receivedHeader.filter((_, column) => column !== index), receivedRow.filter((_, column) => column !== index)]);
    assert.deepEqual(missing.rows, []); assert.ok(missing.errors.some(error => /ausente/.test(error.problem)));
    const blank = [...receivedRow]; blank[index] = '';
    assert.deepEqual(validateReceivablePaidRows([receivedHeader, blank]).rows, []);
  }
  for (const amount of ['0,00', 0, -1, '1,234', 1.001, Infinity]) {
    const result = validateReceivablePaidRows([receivedHeader, [...receivedRow.slice(0, 7), amount]]);
    assert.deepEqual(result.rows, []); assert.ok(result.errors.some(error => error.column === 'Quitação: valor recebido'));
  }
  const invalid = validateReceivablePaidRows([receivedHeader, [...erpRow, '31/02/2026 15:03', '120,00']]);
  assert.deepEqual(invalid.rows, []); assert.equal(invalid.errors[0].column, 'Quitação: data do recebimento');
});

test('horários ERP validam calendário e relógio sem flexibilizar datas genéricas de CR ou o parser compartilhado', () => {
  for (const invalid of ['01/10/2026 24:00', '01/10/2026 23:60', '01/10/2026 23:59:60', '31/02/2026 00:00', '01/10/2026 1:00', '01/10/2026 00:00 -03:00', '2026-10-01T00:00:00Z']) {
    const source = [...erpRow]; source[3] = invalid;
    assert.deepEqual(validateReceivableRows([erpHeader, source]).rows, [], invalid);
  }
  const generic = [...row]; generic[3] = '16/10/2026 15:03';
  assert.deepEqual(validateReceivableRows([header, generic]).rows, []);
  assert.throws(() => parseCivilDate('16/10/2026 15:03'));
  const leap = [...erpRow]; leap[3] = '29/02/2024 23:59:59';
  assert.equal(validateReceivableRows([erpHeader, leap]).rows[0].issued_on, '2024-02-29');
});

test('datas ERP em Date e serial fracionário preservam o dia civil e respeitam calendário Excel 1904', () => {
  const native = validateReceivablePaidRows([receivedHeader, [...erpRow.slice(0, 3), new Date('2026-10-01T23:59:59Z'), new Date('2026-10-20T00:01:00Z'), erpRow[5], new Date('2026-10-17T23:59:59Z'), 120]]);
  assert.deepEqual(native.errors, []); assert.equal(native.rows[0].issued_on, '2026-10-01'); assert.equal(native.rows[0].due_date, '2026-10-20'); assert.equal(native.rows[0].received_on, '2026-10-17');
  const serial = validateReceivablePaidRows([receivedHeader, [...erpRow.slice(0, 3), 45000.99, 45020.01, erpRow[5], 45017.75, 120]]);
  assert.deepEqual(serial.errors, []); assert.equal(serial.rows[0].issued_on, parseCivilDate(45000)); assert.equal(serial.rows[0].received_on, parseCivilDate(45017));
  const epoch = validateReceivableRows([erpHeader, [...erpRow.slice(0, 3), 1.5, 2.75, erpRow[5]]], { excel1904:true });
  assert.equal(epoch.rows[0].issued_on, '1904-01-02'); assert.equal(epoch.rows[0].due_date, '1904-01-03');
  for (const value of [60.5, 0.5, Infinity, new Date(NaN)]) assert.deepEqual(validateReceivableRows([erpHeader, [...erpRow.slice(0, 3), value, ...erpRow.slice(4)]]).rows, []);
});

test('parcelas de mesma NF com vencimentos diferentes são preservadas; valores mutáveis não criam identidade duplicada', () => {
  const anotherDue = [...erpRow]; anotherDue[4] = '20/11/2026 00:00';
  assert.equal(validateReceivableRows([erpHeader, erpRow, anotherDue]).rows.length, 2);
  const changedValue = [...erpRow]; changedValue[2] = '130,00';
  const duplicate = validateReceivableRows([erpHeader, erpRow, changedValue]);
  assert.deepEqual(duplicate.rows, []); assert.ok(duplicate.errors.some(error => /duplicada/.test(error.problem)));
  const duplicateReceipt = validateReceivablePaidRows([receivedHeader, receivedRow, [...erpRow, '18/10/2026 00:00', '130,00']]);
  assert.deepEqual(duplicateReceipt.rows, []);
});

test('identificador de NF conserva zeros textuais e formatos numéricos simples, rejeitando perda de precisão ou formato ambíguo', () => {
  assert.equal(readReceivableIdentifierCell('000123'), '000123'); assert.equal(readReceivableIdentifierCell(123, '000000'), '000123'); assert.equal(readReceivableIdentifierCell(123, 'General'), '123');
  for (const value of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, Infinity, '1e3', true]) assert.throws(() => readReceivableIdentifierCell(value));
  for (const format of ['0.00', '#,##0', '0E+00', 'dd/mm/yyyy', '000000;[Red]-000000']) assert.throws(() => readReceivableIdentifierCell(123, format), /Formato do identificador não suportado/);
  assert.throws(() => readReceivableIdentifierCell(new Date('2026-10-17T00:00:00Z'), 'dd/mm/yyyy'), /Formato do identificador não suportado/);
});

test('XLSX real de recebimentos preserva NF formatada, datas com horas e valores nominal/recebido independentes', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Recebimentos');
  sheet.addRow(receivedHeader); sheet.addRow([erpRow[0], 123, 125.90, new Date('2026-10-01T23:59:00Z'), new Date('2026-10-20T00:01:00Z'), erpRow[5], new Date('2026-10-17T23:59:00Z'), 120]);
  sheet.getCell('B2').numFmt = '000000'; for (const address of ['D2', 'E2', 'G2']) sheet.getCell(address).numFmt = 'dd/mm/yyyy hh:mm';
  const bytes = Uint8Array.from(await workbook.xlsx.writeBuffer()).buffer; await validateWorkbookExpandedSize(bytes);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(bytes);
  const data = loaded.worksheets[0], values = data.getRow(2).values.slice(1);
  values[1] = readReceivableIdentifierCell(data.getCell('B2').value, data.getCell('B2').numFmt);
  const result = validateReceivablePaidRows([data.getRow(1).values.slice(1), values]);
  assert.deepEqual(result.errors, []); assert.equal(result.rows[0].document, '000123'); assert.equal(result.rows[0].amount_cents, 12590); assert.equal(result.rows[0].received_amount_cents, 12000); assert.equal(result.rows[0].received_on, '2026-10-17');
});

test('recebimentos mantêm emissão opcional, validam cabeçalhos únicos e recusam fórmulas em qualquer coluna', () => {
  const noIssue = validateReceivablePaidRows([receivedHeader.filter((_, index) => index !== 3), receivedRow.filter((_, index) => index !== 3)]);
  assert.deepEqual(noIssue.errors, []); assert.equal(noIssue.rows[0].issued_on, null);
  const duplicate = validateReceivablePaidRows([[...receivedHeader, 'Valor'], [...receivedRow, '125,90']]);
  assert.deepEqual(duplicate.rows, []); assert.match(duplicate.errors[0].problem, /duplicada/);
  for (let index = 0; index < receivedHeader.length; index++) {
    const values = [...receivedRow]; values[index] = { formula:'1+1', result:2 };
    assert.deepEqual(validateReceivablePaidRows([receivedHeader, values]).rows, []);
  }
  assert.deepEqual(validateReceivablePaidRows([[...receivedHeader, 'Extra'], [...receivedRow, '=1+1']]).rows, []);
});
