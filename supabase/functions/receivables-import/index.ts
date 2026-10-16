import ExcelJS from 'npm:exceljs@4.4.0';
import { createReceivablesGateway } from './handler.mjs';

Deno.serve(createReceivablesGateway({
  env: (name: string) => Deno.env.get(name),
  // The handler validates actual ZIP expansion before calling this adapter.
  loadWorkbook: async (buffer: ArrayBuffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const populated = workbook.worksheets.filter(sheet => sheet.actualRowCount > 0);
    if (populated.length !== 1) throw new Error('A cópia para importação deve conter uma única aba com dados.');
    const sheet = populated[0];
    if (sheet.rowCount > 5001 || sheet.columnCount > 100) throw new Error('Planilha excede 5.000 linhas ou 100 colunas.');
    const matrix: unknown[][] = [];
    for (let index = 1; index <= sheet.rowCount; index++) matrix.push((sheet.getRow(index).values as unknown[]).slice(1));
    return { matrix, excel1904: Boolean(workbook.properties.date1904) };
  },
  log: (event: string) => console.warn(`receivables-import:${event}`),
}));
