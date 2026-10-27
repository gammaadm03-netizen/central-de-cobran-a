/// <reference lib="webworker" />
import { MAX_FILE_BYTES, MAX_ROWS, parseCsv, validateWorkbookExpandedSize, validatePayableRows, validatePayablePaidRows, isChequeNumberHeader, readPayableChequeCell } from '../lib/payables-parser.mjs';

self.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer; name: string; mode?: 'forecast' | 'payments'; today?: string }>) => {
  try {
    const { buffer, name, mode = 'forecast', today } = event.data;
    if (mode !== 'forecast' && mode !== 'payments') throw new Error('Modo de importação inválido. Selecione previsão ou pagamentos realizados.');
    if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('O arquivo excede 2 MiB.');
    const extension = name.toLowerCase().split('.').pop();
    let matrix: unknown[][];
    let excel1904 = false;
    if (extension === 'csv') {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw new Error('O CSV não está em UTF-8. Salve uma cópia como CSV UTF-8 e tente novamente.'); }
      matrix = parseCsv(text);
    } else if (extension === 'xlsx' || extension === 'xlsm') {
      await validateWorkbookExpandedSize(buffer);
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const populated = workbook.worksheets.filter(sheet => sheet.actualRowCount > 0);
      if (populated.length !== 1) throw new Error('A cópia para importação deve conter uma única aba com dados.');
      const sheet = populated[0];
      if (sheet.rowCount > MAX_ROWS + 1 || sheet.columnCount > 100) throw new Error('Planilha excede 5.000 linhas ou 100 colunas.');
      const chequeColumns: number[] = [];
      sheet.getRow(1).eachCell((cell, column) => { if (isChequeNumberHeader(cell.value)) chequeColumns.push(column); });
      matrix = [];
      for (let index = 1; index <= sheet.rowCount; index++) {
        const source = sheet.getRow(index), values = (source.values as unknown[]).slice(1);
        if (index > 1) for (const column of chequeColumns) { const cell = source.getCell(column); values[column - 1] = readPayableChequeCell(cell.value, cell.numFmt); }
        matrix.push(values);
      }
      excel1904 = Boolean(workbook.properties.date1904);
    } else if (extension === 'xls') {
      throw new Error('O formato .xls antigo ainda não é aceito. No Excel, salve uma cópia como .xlsx e selecione essa cópia.');
    } else throw new Error('Selecione um arquivo .xlsx, .xlsm ou .csv.');
    self.postMessage(mode === 'payments' ? validatePayablePaidRows(matrix, { excel1904, ...(today !== undefined ? { today } : {}) }) : validatePayableRows(matrix, { excel1904 }));
  } catch (error) {
    self.postMessage({ rows: [], errors: [{ line: 0, column: 'Arquivo', problem: error instanceof Error ? error.message : 'Não foi possível analisar o arquivo.', correction: 'Confira o formato, salve uma cópia com valores e tente novamente.' }] });
  }
};
