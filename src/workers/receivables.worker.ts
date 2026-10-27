/// <reference lib="webworker" />
import { MAX_FILE_BYTES, MAX_ROWS, parseCsv, validateWorkbookExpandedSize, validateReceivableRows, validateReceivablePaidRows, isReceivableIdentifierHeader, readReceivableIdentifierCellResult, mergeReceivableImportProblems } from '../lib/receivables-parser.mjs';
import type { ImportProblem } from '../lib/payables';

self.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer; name: string; mode?: 'open' | 'received' }>) => {
  try {
    const { buffer, name, mode = 'open' } = event.data;
    if (mode !== 'open' && mode !== 'received') throw new Error('Modo de importação inválido. Selecione títulos em aberto ou recebimentos.');
    if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('O arquivo excede 2 MiB.');
    const extension = name.toLowerCase().split('.').pop();
    let matrix: unknown[][];
    let excel1904 = false;
    const cellErrors: ImportProblem[] = [];
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
      const identifierColumns: number[] = [];
      sheet.getRow(1).eachCell((cell, column) => { if (isReceivableIdentifierHeader(cell.value)) identifierColumns.push(column); });
      matrix = [];
      for (let index = 1; index <= sheet.rowCount; index++) {
        const source = sheet.getRow(index), values = (source.values as unknown[]).slice(1);
        if (index > 1) for (const column of identifierColumns) {
          const cell = source.getCell(column), result = readReceivableIdentifierCellResult(cell.value, cell.numFmt, index, column);
          values[column - 1] = result.value;
          if (result.error && cellErrors.length < 100) cellErrors.push(result.error);
        }
        matrix.push(values);
      }
      excel1904 = Boolean(workbook.properties.date1904);
    } else if (extension === 'xls') {
      throw new Error('O formato .xls antigo ainda não é aceito. No Excel, salve uma cópia como .xlsx e selecione essa cópia.');
    } else throw new Error('Selecione um arquivo .xlsx, .xlsm ou .csv.');
    const parsed = mode === 'received' ? validateReceivablePaidRows(matrix, { excel1904 }) : validateReceivableRows(matrix, { excel1904 });
    const errors = mergeReceivableImportProblems(parsed.errors, cellErrors);
    self.postMessage({ rows: errors.length ? [] : parsed.rows, errors, ...(!errors.length && 'collector_hints' in parsed ? { collector_hints: parsed.collector_hints } : {}) });
  } catch (error) {
    self.postMessage({ rows: [], errors: [{ line: 0, column: 'Arquivo', problem: error instanceof Error ? error.message : 'Não foi possível analisar o arquivo.', correction: 'Confira o formato, salve uma cópia com valores e tente novamente.' }] });
  }
};
