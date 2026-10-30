import type { PayableImportRow, PayablePaidRow, ImportProblem } from './payables';
export const MAX_FILE_BYTES: number;
export const MAX_ROWS: number;
export const COLUMN_LABELS: Record<string, string>;
export function parseCivilDate(value: unknown, excel1904?: boolean): string;
export function parseMoneyCents(value: unknown): number;
export interface PayableRoundingAdjustment { line: number; original_amount: string; amount_cents: number }
export function parseProvisionedMoneyCents(value: unknown): { amount_cents: number; original_amount: string; adjusted: boolean };
export function parseCsv(text: string, options?: { maxRows?: number }): unknown[][];
export function isChequeNumberHeader(value: unknown): boolean;
export function readPayableChequeCell(value: unknown, numFmt?: string): string;
export function inspectWorkbookZip(buffer: ArrayBuffer): { start: number; compressed: number; uncompressed: number; method: number }[];
export function validateWorkbookExpandedSize(buffer: ArrayBuffer): Promise<void>;
export function validatePayableRows(matrix: unknown[][], options?: { excel1904?: boolean; roundProvisionedAmounts?: boolean }): { rows: PayableImportRow[]; errors: ImportProblem[]; rounding_adjustments?: PayableRoundingAdjustment[] };
export function validatePayableDailyRows(matrix: unknown[][], options?: { excel1904?: boolean; allowEmptyCheques?: boolean; allowEmptyReport?: boolean; roundProvisionedAmounts?: boolean }): { rows: PayableImportRow[]; errors: ImportProblem[]; rounding_adjustments?: PayableRoundingAdjustment[] };
export function validatePayablePaidRows(matrix: unknown[][], options?: { excel1904?: boolean; today?: string; useExplicitPaymentDate?: boolean; allowInternalCashWriteoff?: boolean; columnRulesVersion?: '059' }): { rows: PayablePaidRow[]; errors: ImportProblem[] };
