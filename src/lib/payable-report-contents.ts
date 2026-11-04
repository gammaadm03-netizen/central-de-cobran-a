import { payableImportRequest, type ImportProblem, type PayableImportRow, type PayableResolutionChoice } from './payables';
import { validContentsPreview, validContentsCommit, type RoundingAdjustment } from '../../supabase/functions/payables-import/report-contents-reconciliation.mjs';
import type { OpenStatusAction, OpenStatusException } from './payable-open-status';

export type { RoundingAdjustment };
export type ReportContents = 'FULL_OPEN' | 'PAID_STATUS';
export interface ContentsProblem extends ImportProblem { code?: string }
export interface ContentsPreview {
  mode: 'open_status'; status_report_version: '065'; status_only: true; report_kind: 'ALL'; report_contents: ReportContents;
  report_date: string; empty_report_confirmed: boolean; previous_import_id: string | null; financial_revision: string;
  rows: PayableImportRow[]; source_row_count: number; row_count: number; new_count: number; open_count: number; changed_count: number;
  position_count: number; previous_position_count: number; removed_from_position_count: number;
  requires_large_reduction_confirmation: boolean; large_reduction_confirmed: boolean; large_reduction_problem: string | null;
  marked_paid_count: number; marked_paid_cents: number; reopened_count: number; baseline_only: boolean;
  baseline_origin: 'FIRST_REPORT' | 'PREVIOUS_REPORT'; status_actions: OpenStatusAction[]; exceptions: OpenStatusException[];
  paid_already_closed_keys: string[]; paid_already_closed_count: number; paid_unknown_keys: string[];
  unmapped_plans: { plan: string; count: number; total_cents: number }[]; macro_options: string[];
  errors: ContentsProblem[]; can_commit: boolean; rounding_adjustments: RoundingAdjustment[];
}
export interface ContentsCanonical { rows: PayableImportRow[]; preview: ContentsPreview; file_sha256: string }
export interface ContentsRequest {
  action: 'preview' | 'commit'; mode: 'open_status'; status_report_version: '065'; report_kind: 'ALL'; report_contents: ReportContents;
  file_name: string; file_base64: string; mappings: Record<string, string>; resolution_choices: Record<string, PayableResolutionChoice>;
  complete?: true; empty_report_confirmed?: true; previous_import_id?: string | null;
  previous_financial_revision?: string; expected_report_date?: string; request_id?: string; confirm_large_reduction?: boolean;
}
export interface ContentsResult {
  mode: 'open_status'; status_report_version: '065'; status_only: true; report_kind: 'ALL'; report_contents: ReportContents;
  report_date: string; empty_report_confirmed: boolean; request_id: string; report_id: string; import_id: string;
  source_row_count: number; row_count: number; new_count: number; open_count: number; updated_count: number;
  marked_paid_count: number; marked_paid_cents: number; reopened_count: number; written_off_count: number;
  position_count: number; previous_position_count: number; removed_from_position_count: number;
  requires_large_reduction_confirmation: boolean; large_reduction_confirmed: boolean; large_reduction_problem: null;
  paid_already_closed_keys: string[]; paid_already_closed_count: number; paid_unknown_keys: string[];
  paid_count: 0; payment_cents: 0; payments_created: 0; baseline_only: boolean; idempotent: boolean;
  rounding_adjustments: RoundingAdjustment[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validContentsCanonical(value: unknown, hash: string, reportContents: ReportContents, emptyReportConfirmed = false, roundingAdjustments?: RoundingAdjustment[], confirmLargeReduction = false): value is ContentsCanonical {
  return object(value) && /^[a-f\d]{64}$/.test(hash) && value.file_sha256 === hash && Array.isArray(value.rows)
    && validContentsPreview(value.preview, { sourceRows: value.rows, reportContents, emptyReportConfirmed, roundingAdjustments, confirmLargeReduction });
}
export function validContentsResult(value: unknown, request: ContentsRequest, rowCount: number, roundingAdjustments?: RoundingAdjustment[]): value is ContentsResult {
  return Number.isSafeInteger(rowCount) && rowCount >= 0 && rowCount <= 5000
    && validContentsCommit(value, { sourceRows: Array.from({ length: rowCount }), request, roundingAdjustments });
}
export async function payableReportContentsRequest<T>(body: ContentsRequest, signal?: AbortSignal): Promise<T> { return payableImportRequest<T>(body, signal); }
export function contentsImportError(failure: unknown, fallback: string) {
  const code = object(failure) && typeof failure.code === 'string' ? failure.code : '';
  if (['PGRST202', '42883', '42P01'].includes(code) || code === 'P0065' && object(failure) && failure.activation_required === true)
    return 'Ative o SQL 065 dos tipos de relatório de Contas a Pagar e publique a função payables-import atualizada.';
  if (['P0058', 'P0059', 'P0060', 'P0061', 'P0065'].includes(code)) return 'Atualize a Central e selecione se o arquivo contém abertos completos ou títulos baixados. Confira as confirmações indicadas.';
  if (code === '40001') return 'A base ou o dia da importação mudou. Clique em Importar relatório para atualizar a conferência.';
  if (code === '23505') return 'Este arquivo corresponde a uma posição anterior. Exporte um novo relatório completo e atualizado da origem.';
  if (code === '42501') return 'Seu perfil não tem permissão para importar Contas a Pagar.';
  if (['PGRST301', 'PGRST303'].includes(code)) return 'Sua sessão expirou. Entre novamente para continuar.';
  if (['22023', '23514', 'P0016', 'P0042'].includes(code)) return 'Confira os problemas indicados no relatório antes de importar novamente.';
  return fallback;
}
