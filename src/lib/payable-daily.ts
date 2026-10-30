import { normalizePaidBankDescription } from './payable-bank-rules.mjs';
import { addCivilDays } from './financial-dates';
import { payableImportRequest, type ImportProblem, type PayableImportRow, type PayableResolutionChoice } from './payables';
import { payableUuid, validReconciliationItems, type ImportBank, type ReconciliationItem } from '../components/PayableImportReconciliation';

export type DailyReportKind = 'NORMAL' | 'CHEQUES';
export interface DailyAction extends ReconciliationItem {
  payment_remaining_cents: number; paid_on: string | null; bank_account_id: string | null; bank_label: string | null;
  cheque_number: string | null; rule: 'DUE_DATE' | 'IMPORT_DATE'; payment_revision: string | null; last_import_id: string | null;
  bank_mapping_key?: string | null; source_bank?: string | null;
}
export interface DailyPreview {
  daily_report_version: '059'; mode: 'daily'; report_kind: DailyReportKind; report_date: string;
  empty_cheques_confirmed: boolean;
  previous_import_id: string | null; financial_revision: string; rows: PayableImportRow[];
  row_count: number; ignored_cheque_count: number; new_count: number; open_count: number; changed_count: number;
  baseline_only: boolean; baseline_origin: 'EXISTING_BASE' | 'PREVIOUS_REPORT' | 'FIRST_REPORT';
  auto_payment_count: number; auto_payment_cents: number; missing_count: number;
  automatic_actions: DailyAction[]; exceptions: DailyAction[]; reconciliation_items: DailyAction[];
  bank_options: ImportBank[]; unclassified_plans: { plan: string; count: number; total_cents: number }[]; macros: string[];
  errors: ImportProblem[]; can_commit: boolean;
}
export interface DailyCanonical { rows: PayableImportRow[]; preview: DailyPreview; file_sha256: string }
export interface DailyRequest {
  action: 'preview' | 'commit'; mode: 'daily'; daily_report_version: '059'; report_kind: DailyReportKind;
  file_name: string; file_base64: string; mappings: Record<string, string>; bank_mappings: Record<string, string>;
  resolution_choices: Record<string, PayableResolutionChoice>; complete?: true;
  empty_cheques_confirmed?: true;
  previous_import_id?: string | null; previous_financial_revision?: string; expected_report_date?: string; request_id?: string;
}
export interface DailyResult {
  daily_report_version: '059'; mode: 'daily'; report_kind: DailyReportKind; report_date: string;
  empty_cheques_confirmed: boolean;
  request_id: string; report_id: string; import_id: string; row_count: number; new_count: number; open_count: number;
  changed_count: number; paid_count: number; automatic_paid_count: number; payment_cents: number; written_off_count: number; idempotent: boolean;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, maximum = 1500): value is string => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const nullableUuid = (value: unknown) => value === null || payableUuid(value);
export function dailyCivilDate(value: unknown): value is string {
  try { return typeof value === 'string' && value >= '1900-01-01' && value <= '2199-12-31' && addCivilDays(value, 0) === value; }
  catch { return false; }
}
export function dailyProblems(value: unknown): ImportProblem[] {
  return Array.isArray(value) ? value.slice(0, 100).filter((item): item is ImportProblem => object(item) && Number.isSafeInteger(item.line) && Number(item.line) >= 0 && text(item.column) && text(item.problem, 3000) && text(item.correction, 3000)) : [];
}
function validAction(item: unknown, preview: DailyPreview, automatic: boolean): item is DailyAction {
  if (!object(item) || !count(item.payment_remaining_cents) || !nullableUuid(item.bank_account_id) || !nullableUuid(item.last_import_id)
    || !nullableUuid(item.payment_revision) || !(item.bank_label === null || text(item.bank_label, 300))
    || !(item.cheque_number === null || text(item.cheque_number, 150)) || !['DUE_DATE', 'IMPORT_DATE'].includes(String(item.rule))
    || !(item.bank_mapping_key === undefined || item.bank_mapping_key === null || text(item.bank_mapping_key, 1000))
    || !(item.source_bank === undefined || item.source_bank === null || text(item.source_bank, 300))
    || item.rule !== (preview.report_kind === 'CHEQUES' ? 'IMPORT_DATE' : 'DUE_DATE')
    || !(item.paid_on === null || dailyCivilDate(item.paid_on))) return false;
  if (item.kind === 'MISSING' && preview.report_kind === 'NORMAL' && typeof item.cheque_number === 'string' && item.cheque_number.trim()) return false;
  if (item.amount_cents !== 1 && typeof item.cheque_number === 'string' && item.cheque_number.trim()
    && item.selected_action === 'PAID' && item.problem === null) {
    const official = preview.bank_options.filter(bank => bank.account_type === 'BANK' && normalizePaidBankDescription(bank.display_name) === 'BRADESCO F2G');
    if (official.length !== 1 || official[0].id !== item.bank_account_id) return false;
  }
  if (!automatic) return true;
  return item.kind === 'MISSING' && item.title_id !== null && item.line === null && item.requires_resolution === false
    && item.selected_action === 'PAID' && item.problem === null && item.payment_remaining_cents > 0
    && item.amount_cents !== null && Number(item.amount_cents) > 1 && item.payment_remaining_cents <= Number(item.amount_cents)
    && dailyCivilDate(item.paid_on) && item.paid_on <= preview.report_date && payableUuid(item.bank_account_id)
    && preview.bank_options.some(bank => bank.id === item.bank_account_id)
    && item.paid_on === (preview.report_kind === 'CHEQUES' ? preview.report_date : item.due_date);
}
export function validDailyCanonical(value: unknown, hash: string, kind: DailyReportKind, emptyChequesConfirmed = false): value is DailyCanonical {
  if (!object(value) || value.file_sha256 !== hash || !Array.isArray(value.rows) || !object(value.preview)) return false;
  const p = value.preview as unknown as DailyPreview;
  if (p.daily_report_version !== '059' || p.mode !== 'daily' || p.report_kind !== kind || !dailyCivilDate(p.report_date)
    || p.empty_cheques_confirmed !== emptyChequesConfirmed || emptyChequesConfirmed && kind !== 'CHEQUES'
    || !nullableUuid(p.previous_import_id) || !text(p.financial_revision, 256) || !p.financial_revision.trim()
    || !['row_count', 'ignored_cheque_count', 'new_count', 'open_count', 'changed_count', 'auto_payment_count', 'auto_payment_cents', 'missing_count'].every(key => count(p[key as keyof DailyPreview]))
    || p.row_count > 5000 || p.row_count !== value.rows.length || p.row_count === 0 && !(kind === 'CHEQUES' && emptyChequesConfirmed)
    || emptyChequesConfirmed && p.row_count !== 0 || p.new_count + p.open_count !== p.row_count || p.changed_count > p.open_count
    || p.ignored_cheque_count !== 0
    || !Array.isArray(p.rows) || JSON.stringify(p.rows) !== JSON.stringify(value.rows)
    || typeof p.baseline_only !== 'boolean' || !['EXISTING_BASE', 'PREVIOUS_REPORT', 'FIRST_REPORT'].includes(p.baseline_origin)
    || p.baseline_only && (kind !== 'CHEQUES' || p.baseline_origin !== 'FIRST_REPORT' || p.missing_count !== 0)
    || !Array.isArray(p.bank_options) || p.bank_options.some(bank => !payableUuid(bank.id) || !text(bank.display_name, 300) || !bank.display_name.trim())
    || new Set(p.bank_options.map(bank => bank.id)).size !== p.bank_options.length
    || !validReconciliationItems(p.automatic_actions) || !validReconciliationItems(p.exceptions) || !validReconciliationItems(p.reconciliation_items)
    || JSON.stringify(p.exceptions) !== JSON.stringify(p.reconciliation_items)
    || p.automatic_actions.some(item => !validAction(item, p, true)) || p.exceptions.some(item => !validAction(item, p, false))
    || new Set([...p.automatic_actions, ...p.exceptions].map(item => item.key)).size !== p.automatic_actions.length + p.exceptions.length
    || p.auto_payment_count !== p.automatic_actions.length
    || BigInt(p.auto_payment_cents) !== p.automatic_actions.reduce((sum, item) => sum + BigInt(item.payment_remaining_cents), 0n)
    || p.missing_count !== [...p.automatic_actions, ...p.exceptions].filter(item => item.kind === 'MISSING').length
    || !Array.isArray(p.unclassified_plans) || p.unclassified_plans.some(plan => !text(plan.plan, 300) || !plan.plan.trim() || !count(plan.count) || plan.count < 1 || !count(plan.total_cents))
    || new Set(p.unclassified_plans.map(plan => plan.plan)).size !== p.unclassified_plans.length
    || !Array.isArray(p.macros) || p.macros.some(macro => !text(macro, 100) || !macro.trim()) || new Set(p.macros).size !== p.macros.length
    || !Array.isArray(p.errors) || dailyProblems(p.errors).length !== Math.min(100, p.errors.length) || typeof p.can_commit !== 'boolean'
    || p.can_commit && (p.errors.length > 0 || p.unclassified_plans.length > 0 || p.exceptions.some(item => item.requires_resolution && !item.selected_action || item.problem !== null))) return false;
  return value.rows.every(row => object(row) && text(row.entry_number, 150) && !!row.entry_number.trim() && text(row.description) && text(row.branch, 150) && !!row.branch.trim()
    && text(row.plan, 300) && text(row.bank_account, 300) && text(row.source_status, 150) && count(row.amount_cents) && dailyCivilDate(row.due_date)
    && (row.issued_on === null || dailyCivilDate(row.issued_on)) && (row.cheque_number === undefined || row.cheque_number === null || text(row.cheque_number, 150)))
    && value.rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n) <= BigInt(Number.MAX_SAFE_INTEGER);
}
export function validDailyResult(value: unknown, request: DailyRequest, rowCount: number): value is DailyResult {
  if (!object(value) || value.daily_report_version !== '059' || value.mode !== 'daily' || value.report_kind !== request.report_kind
    || value.empty_cheques_confirmed !== (request.empty_cheques_confirmed === true)
    || rowCount === 0 && !(request.report_kind === 'CHEQUES' && request.empty_cheques_confirmed === true)
    || request.empty_cheques_confirmed === true && (request.report_kind !== 'CHEQUES' || rowCount !== 0)
    || value.report_date !== request.expected_report_date || value.request_id !== request.request_id || !payableUuid(value.report_id) || !payableUuid(value.import_id)
    || value.row_count !== rowCount || typeof value.idempotent !== 'boolean'
    || !['new_count', 'open_count', 'changed_count', 'paid_count', 'automatic_paid_count', 'payment_cents', 'written_off_count'].every(key => count(value[key]))) return false;
  return Number(value.new_count) + Number(value.open_count) === rowCount && Number(value.changed_count) <= Number(value.open_count)
    && Number(value.automatic_paid_count) <= Number(value.paid_count);
}
export async function payableDailyRequest<T>(body: DailyRequest, signal?: AbortSignal): Promise<T> { return payableImportRequest<T>(body, signal); }
export function dailyImportError(failure: unknown, fallback: string) {
  const code = object(failure) && typeof failure.code === 'string' ? failure.code : '';
  if (['PGRST202', '42883', '42P01'].includes(code) || code === 'P0059' && object(failure) && failure.activation_required === true) return 'Ative o SQL 059 de atualização das colunas de Contas a Pagar e publique a função payables-import atualizada para usar este relatório.';
  if (['P0058', 'P0059'].includes(code)) return 'Confira as exceções indicadas e utilize o relatório completo atualizado antes de concluir a conciliação diária.';
  if (code === '40001') return 'A base ou o dia da importação mudou. Confira novamente este arquivo antes de concluir.';
  if (code === '23505') return 'Este relatório já foi importado. Exporte o relatório completo atualizado para registrar a nova posição, sem repetir baixas.';
  if (code === '42501') return 'Seu perfil não tem permissão para importar e conciliar Contas a Pagar.';
  if (['PGRST301', 'PGRST303'].includes(code)) return 'Sua sessão expirou. Entre novamente para continuar.';
  if (['22023', '23514', 'P0016', 'P0042'].includes(code)) return 'Confira as pendências indicadas e reanalise o relatório antes de concluir.';
  return fallback;
}
