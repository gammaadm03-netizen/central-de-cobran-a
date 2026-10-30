import { payableImportRequest, type ImportProblem, type PayableImportRow, type PayableResolutionChoice } from './payables';
import { validOpenStatusPreview, validOpenStatusCommit, type RoundingAdjustment } from '../../supabase/functions/payables-import/open-status-reconciliation.mjs';
import { dailyProblems } from './payable-daily';

export type { RoundingAdjustment };
export interface OpenStatusAction { kind: 'PAID' | 'REOPEN'; title_id: string; source_key: string; amount_cents: number }
export interface OpenStatusException {
  key: string; kind: 'CENT'; line: number | null; title_id: string | null; branch: string; entry_number: string;
  description: string; due_date: string; amount_cents: 1; allowed_actions: 'WRITE_OFF'[];
  selected_action: 'WRITE_OFF' | null; requires_resolution: boolean; problem: string | null; already_written_off?: boolean;
  cheque_number?: string | null;
}
export interface OpenStatusPreview {
  mode: 'open_status'; status_report_version: '061'; status_only: true; report_kind: 'ALL'; report_date: string;
  empty_report_confirmed: boolean; previous_import_id: string | null; financial_revision: string; rows: PayableImportRow[];
  row_count: number; new_count: number; open_count: number; changed_count: number; marked_paid_count: number;
  marked_paid_cents: number; reopened_count: number; baseline_only: boolean; baseline_origin: 'FIRST_REPORT' | 'PREVIOUS_REPORT';
  exceptions: OpenStatusException[]; status_actions: OpenStatusAction[]; unmapped_plans: { plan: string; count: number; total_cents: number }[];
  macro_options: string[]; errors: ImportProblem[]; can_commit: boolean; rounding_adjustments: RoundingAdjustment[];
}
export interface OpenStatusCanonical { rows: PayableImportRow[]; preview: OpenStatusPreview; file_sha256: string }
export interface OpenStatusRequest {
  action: 'preview' | 'commit'; mode: 'open_status'; status_report_version: '061'; report_kind: 'ALL';
  file_name: string; file_base64: string; mappings: Record<string, string>; resolution_choices: Record<string, PayableResolutionChoice>;
  complete?: true; empty_report_confirmed?: true; previous_import_id?: string | null;
  previous_financial_revision?: string; expected_report_date?: string; request_id?: string;
}
export interface OpenStatusResult {
  mode: 'open_status'; status_report_version: '061'; status_only: true; report_kind: 'ALL'; report_date: string;
  empty_report_confirmed: boolean; request_id: string; report_id: string; import_id: string; row_count: number;
  new_count: number; open_count: number; updated_count: number; marked_paid_count: number; marked_paid_cents: number; reopened_count: number;
  paid_count: 0; payment_cents: 0; payments_created: 0; written_off_count: number; baseline_only: boolean;
  idempotent: boolean; rounding_adjustments: RoundingAdjustment[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const openStatusProblems = dailyProblems;
export function validOpenStatusCanonical(value: unknown, hash: string, emptyReportConfirmed = false, roundingAdjustments?: RoundingAdjustment[]): value is OpenStatusCanonical {
  return object(value) && /^[a-f\d]{64}$/.test(hash) && value.file_sha256 === hash && Array.isArray(value.rows)
    && validOpenStatusPreview(value.preview, { sourceRows: value.rows, emptyReportConfirmed, roundingAdjustments });
}
export function validOpenStatusResult(value: unknown, request: OpenStatusRequest, rowCount: number, roundingAdjustments?: RoundingAdjustment[]): value is OpenStatusResult {
  return Number.isSafeInteger(rowCount) && rowCount >= 0 && rowCount <= 5000
    && validOpenStatusCommit(value, { sourceRows: Array.from({ length: rowCount }), request, roundingAdjustments });
}
export async function payableOpenStatusRequest<T>(body: OpenStatusRequest, signal?: AbortSignal): Promise<T> { return payableImportRequest<T>(body, signal); }
export function openStatusImportError(failure: unknown, fallback: string) {
  const code = object(failure) && typeof failure.code === 'string' ? failure.code : '';
  if (['PGRST202', '42883', '42P01'].includes(code) || code === 'P0061' && object(failure) && failure.activation_required === true)
    return 'Ative o SQL 061 do relatório diário de Contas a Pagar e publique a função payables-import atualizada.';
  if (['P0058', 'P0059', 'P0060', 'P0061'].includes(code)) return 'Utilize o relatório diário completo atualizado e confira somente as baixas individuais de R$ 0,01 indicadas.';
  if (code === '40001') return 'A base ou o dia da importação mudou. Clique em Importar relatório para atualizar a conferência.';
  if (code === '23505') return 'Este arquivo corresponde a uma posição anterior. Utilize o relatório completo atualizado.';
  if (code === '42501') return 'Seu perfil não tem permissão para importar Contas a Pagar.';
  if (['PGRST301', 'PGRST303'].includes(code)) return 'Sua sessão expirou. Entre novamente para continuar.';
  if (['22023', '23514', 'P0016', 'P0042'].includes(code)) return 'Confira os problemas indicados no relatório antes de importar novamente.';
  return fallback;
}
