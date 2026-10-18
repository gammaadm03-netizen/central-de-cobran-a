import ExcelJS from 'npm:exceljs@4.4.0';
import { createPayablesGateway } from './handler.mjs';
import { isChequeNumberHeader, readPayableChequeCell } from '../../../src/lib/payables-parser.mjs';

Deno.serve(createPayablesGateway({
  env: (name: string) => Deno.env.get(name),
  // The handler validates actual ZIP expansion before calling this adapter.
  loadWorkbook: async (buffer: ArrayBuffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const populated = workbook.worksheets.filter(sheet => sheet.actualRowCount > 0);
    if (populated.length !== 1) throw new Error('A cópia para importação deve conter uma única aba com dados.');
    const sheet = populated[0];
    if (sheet.rowCount > 5001 || sheet.columnCount > 100) throw new Error('Planilha excede 5.000 linhas ou 100 colunas.');
    const chequeColumns: number[] = [];
    sheet.getRow(1).eachCell((cell, column) => { if (isChequeNumberHeader(cell.value)) chequeColumns.push(column); });
    const matrix: unknown[][] = [];
    for (let index = 1; index <= sheet.rowCount; index++) {
      const source = sheet.getRow(index), values = (source.values as unknown[]).slice(1);
      if (index > 1) for (const column of chequeColumns) { const cell = source.getCell(column); values[column - 1] = readPayableChequeCell(cell.value, cell.numFmt); }
      matrix.push(values);
    }
    return { matrix, excel1904: Boolean(workbook.properties.date1904) };
  },
  log: (event: string) => console.warn(`payables-import:${event}`),
}));
