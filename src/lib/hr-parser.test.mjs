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
test('RH unknown fields stay null and blank branch and sector can be corrected in the source',()=>{
 const source=[...row];source[0]='';source[2]='';source[3]='';source[4]='';source[5]='';source[7]='';source[8]='';source[9]='';source[10]='';
 const result=validateHrRows([header,source]);assert.equal(result.errors.length,0);for(const key of ['admitted_on','birthday_on','salary_base_cents','payroll_salary_cents','transport_cents','advance_cents','total_cents'])assert.equal(result.rows[0][key],null);
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
