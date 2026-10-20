export interface CostImportRow { line_number: number; code: string; product: string; weight_kg: string | null; unit_cost: string | null }
export interface CostImportProblem { line: number; column: string; problem: string; correction: string }
export function parseCostDecimal(value: unknown, options?: { optional?: boolean; currency?: boolean }): string | null;
export function isCostCodeHeader(value: unknown): boolean;
export function readCostCodeCell(value: unknown, numFmt?: string): unknown;
export function validateCostRows(matrix: unknown[][]): { rows: CostImportRow[]; errors: CostImportProblem[] };
