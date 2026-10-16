import type { ReceivableImportRow } from './receivables';
import type { ImportProblem } from './payables';
export const MAX_FILE_BYTES: number;
export const MAX_ROWS: number;
export const COLUMN_LABELS: Record<string,string>;
export { parseCsv, validateWorkbookExpandedSize } from './payables-parser.mjs';
export function receivableCustomerKey(row: Pick<ReceivableImportRow, 'client_name' | 'client_document'>): string;
export function validateReceivableRows(matrix: unknown[][], options?: { excel1904?: boolean }): { rows: ReceivableImportRow[]; errors: ImportProblem[] };
