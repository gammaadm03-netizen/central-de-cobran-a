import ExcelJS from 'npm:exceljs@4.4.0';
import { createBusinessGateway } from './handler.mjs';
import { isCostCodeHeader, readCostCodeCell } from '../../../src/lib/costs-parser.mjs';
Deno.serve(createBusinessGateway({
 env:(name:string)=>Deno.env.get(name),
 loadWorkbook:async(buffer:ArrayBuffer,options?:{mode?:string})=>{
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);
  const populated=workbook.worksheets.filter(sheet=>sheet.actualRowCount>0);
  if(populated.length!==1)throw new Error('Use uma única aba com dados.');
  const sheet=populated[0];if(sheet.rowCount>5021||sheet.columnCount>100)throw new Error('Limite da planilha excedido.');
  const matrix:unknown[][]=[];
  const codeColumn=options?.mode==='costs'?(sheet.getRow(1).values as unknown[]).findIndex(isCostCodeHeader):-1;
  for(let index=1;index<=sheet.rowCount;index++){
   const values=(sheet.getRow(index).values as unknown[]).slice(1);
   if(index>1&&codeColumn>0){const cell=sheet.getRow(index).getCell(codeColumn);values[codeColumn-1]=readCostCodeCell(cell.value,cell.numFmt);}
   matrix.push(values);
  }
  return{matrix,excel1904:Boolean(workbook.properties.date1904)};
 },
 log:(event:string)=>console.warn(`business-import:${event}`),
}));
