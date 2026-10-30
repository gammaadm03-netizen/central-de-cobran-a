export interface RoundingAdjustment { line: number; original_amount: string; amount_cents: number }
export function validStatusResolutionChoices(value: unknown, rowCount?: number): boolean;
export function validRoundingAdjustments(value: unknown): value is RoundingAdjustment[];
export function validOpenStatusRequest(value: unknown): boolean;
export function validOpenStatusPreview(value: unknown, context?: { sourceRows: unknown[]; resolutionChoices?: Record<string, unknown>; roundingAdjustments?: RoundingAdjustment[]; emptyReportConfirmed?: boolean }): boolean;
export function validOpenStatusCommit(value: unknown, context?: { sourceRows: unknown[]; request: unknown; roundingAdjustments?: RoundingAdjustment[] }): boolean;
export const OPEN_STATUS_REPORT_VERSION: '061';
