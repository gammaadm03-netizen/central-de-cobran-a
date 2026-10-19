import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHrRows } from './hr-parser.mjs';
const header=['FILIAL','CONTAGEM','ADMISSÃO','ANIVERSÁRIO','SALÁRIO','SETOR','FUNCIONÁRIO','VT TOTAL','SALÁRIO','ADIANTAMENTO','TOTAL'];
const row=['Filial sintética','1','10/10/2020','29/02/2000','2.000,00','Operação','Pessoa sintética','120,50','1.800,00','200,00','2.120,50'];
test('RH preserves both repeated salary columns and exact cents',()=>{
 const result=validateHrRows([header,row]);assert.deepEqual(result.errors,[]);
 assert.equal(result.rows[0].salary_base_cents,200000);assert.equal(result.rows[0].payroll_salary_cents,180000);assert.equal(result.rows[0].transport_cents,12050);assert.equal(result.rows[0].birthday_on,'2000-02-29');assert.equal(result.rows[0].source_row,2);
});
test('RH detects header after a report title without replacing salary fields',()=>{
 const result=validateHrRows([['Relatório sintético'],[],header,row]);assert.equal(result.errors.length,0);assert.equal(result.rows[0].source_row,4);
});
test('RH keeps unknown salaries and dates while present benefit columns treat blank cells as zero',()=>{
 const source=[...row];source[0]='';source[2]='';source[3]='';source[4]='';source[5]='';source[7]='';source[8]='';source[9]='';source[10]='';
 const result=validateHrRows([header,source]);assert.equal(result.errors.length,0);for(const key of ['admitted_on','birthday_on','salary_base_cents','payroll_salary_cents','cost_allowance_cents','total_cents'])assert.equal(result.rows[0][key],null);
 for(const key of ['transport_cents','advance_cents'])assert.equal(result.rows[0][key],0);
});

const reportHeader=['FILIAL','ADMISSAO','ANIVERSARIO','Salário Base','VT TOTAL','Salário','Adiantamento','Ajuda de Custo','SETOR','Funcionário'];
const reportRow=['Unidade sintética','01/03/2020','20/05/1990','2.500,00','R$ -','1.850,75','','R$ 480,25','Financeiro','Pessoa sintética'];
test('RH actual report maps named Salário Base and Salário independently and imports Ajuda de Custo',()=>{
 const result=validateHrRows([reportHeader,reportRow]);assert.deepEqual(result.errors,[]);
 const parsed=result.rows[0];assert.equal(parsed.salary_base_cents,250000);assert.equal(parsed.payroll_salary_cents,185075);
 assert.equal(parsed.cost_allowance_cents,48025);assert.equal(parsed.transport_cents,0);assert.equal(parsed.advance_cents,0);
 assert.equal(parsed.total_cents,null);assert.equal(parsed.admitted_on,'2020-03-01');assert.equal(parsed.birthday_on,'1990-05-20');
 assert.equal(Object.keys(parsed).length,13);
});
test('RH salary names take priority regardless of their positions and preserve the legacy repeated salary layout',()=>{
 const base=['FILIAL','FUNCIONÁRIO','SETOR'];
 for(const [cols,values]of [[['Salário','Salário Base'],['1.100,10','2.200,20']],[['Salário da folha','Salário'],['2.200,20','1.100,10']],[['Salário Folha','Salário recebido'],['2.200,20','1.100,10']],[['Salário recebido','Salário Folha'],['1.100,10','2.200,20']],[['Salário Base','Salário Líquido'],['2.200,20','1.100,10']],[['Salário','Salário'],['2.200,20','1.100,10']]]){
  const result=validateHrRows([[...base,...cols],['Unidade','Pessoa sintética','Área',...values]]);assert.deepEqual(result.errors,[]);
  assert.equal(result.rows[0].salary_base_cents,220020);assert.equal(result.rows[0].payroll_salary_cents,110010);
 }
 for(const cols of [['Salário Base','Salário Base'],['Salário Base','Salário Folha'],['Salário recebido','Salário Líquido'],['Salário Base','Salário','Salário'],['Salário Base','Salário Folha','Salário']])assert(validateHrRows([[...base,...cols],['Unidade','Pessoa sintética','Área',...cols.map(()=>1)]]).errors.length>0);
});
test('RH present optional benefits accept blank or accounting zero without inventing absent columns or salary values',()=>{
 for(const value of ['',null,undefined,0,'0,00','-','R$ -','R$  —']){
  const source=[...reportRow];source[3]='';source[4]=value;source[5]='';source[6]=value;source[7]=value;
  const result=validateHrRows([reportHeader,source]);assert.deepEqual(result.errors,[]);
  for(const key of ['transport_cents','advance_cents','cost_allowance_cents'])assert.equal(result.rows[0][key],0);
  assert.equal(result.rows[0].salary_base_cents,null);assert.equal(result.rows[0].payroll_salary_cents,null);assert.equal(result.rows[0].total_cents,null);
 }
 const sparse=validateHrRows([['FILIAL','SETOR','FUNCIONÁRIO'],['Unidade','Área','Pessoa sintética']]);assert.deepEqual(sparse.errors,[]);
 for(const key of ['transport_cents','advance_cents','cost_allowance_cents'])assert.equal(sparse.rows[0][key],null);
 const partner=[...reportRow];partner[1]='';partner[8]='SOCIO';assert.equal(validateHrRows([reportHeader,partner]).rows[0].admitted_on,null);
});
test('RH rejects impossible dates, abbreviated years, unsupported formulas and third salary before import',()=>{
 for(const change of [[2,'31/02/2020'],[3,'01/01/99'],[4,{formula:'SUM(A1)',result:1}],[6,'=HYPERLINK("x")'],[6,'']]){
  const source=[...row];source[change[0]]=change[1];const result=validateHrRows([header,source]);assert.equal(result.rows.length,0);assert(result.errors.length>0);
 }
 assert(validateHrRows([[...header,'SALÁRIO'],[...row,'1,00']]).errors.length>0);
 assert(validateHrRows([header,row,['', '', '', '', '', '', '', '', '', '', '2.120,50']]).errors.some(error=>error.column==='Funcionário'));
});
test('RH handles Excel 1900 and 1904 civil dates and exact signed payroll adjustments',()=>{
 const source=[...row];source[2]=new Date('2020-10-10T00:00:00.000Z');source[3]=61;source[9]='-20,00';
 let result=validateHrRows([header,source]);assert.equal(result.errors.length,0);assert.equal(result.rows[0].birthday_on,'1900-03-01');assert.equal(result.rows[0].advance_cents,-2000);
 result=validateHrRows([header,source],{excel1904:true});assert.equal(result.rows[0].birthday_on,'1904-03-02');source[3]=60;assert(validateHrRows([header,source]).errors.length>0);
});
test('RH rejects missing source headers, empty snapshot, unsafe money and out-of-header cells',()=>{
 assert(validateHrRows([['FUNCIONÁRIO'],['Pessoa sintética']]).errors.length>0);
 assert(validateHrRows([header]).errors.length>0);
 for(const value of ['1,234',900719925474099.1,-100]){const source=[...row];source[4]=value;assert(validateHrRows([header,source]).errors.length>0);}
 assert(validateHrRows([header,[...row,'extra']]).errors.length>0);
});
