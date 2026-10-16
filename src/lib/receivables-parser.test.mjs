import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseCsv, validateWorkbookExpandedSize, validateReceivableRows, receivableCustomerKey } from './receivables-parser.mjs';
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
test('duplicidade usa filial documento cliente vencimento valor, nunca posição da linha', () => {
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
