import type { ReceivableImportRow, ReceivablePaidRow } from './receivables';
import type { ImportProblem } from './payables';
export const MAX_FILE_BYTES: number;
export const MAX_ROWS: number;
export const COLUMN_LABELS: Record<string,string>;
export { parseCsv, validateWorkbookExpandedSize } from './payables-parser.mjs';
export function receivableCustomerKey(row: Pick<ReceivableImportRow, 'client_name' | 'client_document'>): string;
export interface ReceivableCollectorHint { line: number; customer_key: string; collector_name: string }
export function normalizeReceivableCollectorName(value: string): string;
export function validateReceivableRows(matrix: unknown[][], options?: { excel1904?: boolean }): { rows: ReceivableImportRow[]; errors: ImportProblem[]; collector_hints?: ReceivableCollectorHint[] };
export function validateReceivablePaidRows(matrix: unknown[][], options?: { excel1904?: boolean }): { rows: ReceivablePaidRow[]; errors: ImportProblem[] };
export function isReceivableIdentifierHeader(value: unknown): boolean;
export function readReceivableIdentifierCell(value: unknown, numFmt?: string): string;
export function readReceivableIdentifierCellResult(value: unknown, numFmt: string | undefined, line: number, column: number): { value: unknown; error: ImportProblem | null };
export function mergeReceivableImportProblems(parserErrors: ImportProblem[], cellErrors?: ImportProblem[]): ImportProblem[];
