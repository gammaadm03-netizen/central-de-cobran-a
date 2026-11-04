export const CONTENTS_REPORT_VERSION: '065';
export const REPORT_CONTENTS: ('FULL_OPEN' | 'PAID_STATUS')[];
export interface RoundingAdjustment { line: number; original_amount: string; amount_cents: number }
export function hasPaymentReportHeader(value: unknown): boolean;
export function validStatusResolutionChoices(value: unknown, rowCount?: number): boolean;
export function validRoundingAdjustments(value: unknown): value is RoundingAdjustment[];
export function validContentsRequest(value: unknown): boolean;
export function validContentsPreview(value: unknown, options?: { sourceRows?: unknown[]; resolutionChoices?: Record<string, unknown>; roundingAdjustments?: RoundingAdjustment[]; reportContents?: 'FULL_OPEN' | 'PAID_STATUS'; emptyReportConfirmed?: boolean; confirmLargeReduction?: boolean }): boolean;
export function validContentsCommit(value: unknown, options?: { sourceRows?: unknown[]; request?: unknown; roundingAdjustments?: RoundingAdjustment[] }): boolean;
