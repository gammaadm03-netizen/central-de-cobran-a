import { supabase } from './supabase';
import { addCivilDays } from './financial-dates';

export const COLLECTION_STATUSES = [
  'NOVO TÍTULO - COBRAR', 'SEM SUCESSO', 'AGUARDANDO RETORNO', 'COBRANCA VIA EMAIL', 'COBRANCA POR WHATSAPP',
  'AGUARDANDO LIQUIDACAO', 'SEM PRAZO', 'SEM PREVISAO DE PG', 'PAGAMENTO PROGRAMADO',
  'MERCADORIA A RECOLHER', 'NOTA A CANCELAR', 'AGUARDANDO NOTA ASSINADA', 'NOTA COM PENDÊNCIA', 'PAUSAR COBRANÇA',
  'TÍTULO PAGO',
] as const;
export type CollectionStatus = typeof COLLECTION_STATUSES[number];
export const COLLECTION_BANDS = [['1_30', '1–30 dias'], ['31_60', '31–60 dias'], ['61_90', '61–90 dias'], ['91_180', '91–180 dias'], ['181_365', '181–365 dias'], ['ACIMA_365', 'Acima de 365 dias']] as const;
export const COLLECTION_SORTS = [['delay_desc', 'Maior atraso'], ['amount_desc', 'Maior valor'], ['amount_asc', 'Menor valor'], ['delay_asc', 'Menor atraso'], ['client_asc', 'Cliente A–Z'], ['next_date_asc', 'Próximo retorno']] as const;
export const FINANCIAL_STATUSES: Record<string, string> = { ACTIVE: 'Vencidos em aberto', NEW: 'Novos', OPEN: 'Em aberto', PENDING_VALIDATION: 'Pagamento aguardando validação', NOT_LOCATED: 'Pagamento não localizado', VALIDATED: 'Quitados — histórico', RETIRED_FROM_REPORT: 'Ausentes do relatório — histórico' };
export interface CollectionFilters { search: string; collector: string; band: string; sort: string; status: string; financialStatus: string; dueStart: string; dueEnd: string; nextAction: string; queue: 'active' | 'returns' | 'history' | 'all' }
export const INITIAL_COLLECTION_FILTERS: CollectionFilters = { search: '', collector: '', band: '', sort: 'delay_desc', status: '', financialStatus: 'ACTIVE', dueStart: '', dueEnd: '', nextAction: '', queue: 'active' };
export interface CollectionWorkflow { version: '029'; normal_pause: true; finish_requires_started: true; pending_read_only: true; returns_priority: true; started?: boolean; can_finish?: boolean; recovery_allowed?: boolean }
export interface CollectionPriority { collector_id: string | null; due_count: number; total_cents: number; next_title_id: string | null; next_due_date: string | null }
export type CollectionStartBlock = 'RETURN_PRIORITY' | 'ALREADY_RUNNING' | 'UNASSIGNED' | 'PENDING_VALIDATION' | 'SETTLED' | 'READ_ONLY' | 'REPORT_RETIRED';
export interface CollectionTimer { title_id: string; running: boolean; session_id: string | null; started_at: string | null; elapsed_seconds: number; total_seconds: number; actor_total_seconds: number; server_now: string; recovery_allowed?: boolean }
export interface CollectionRow {
  id: string; customer_key: string; document: string; client_name: string; client_document: string | null; branch: string; due_date: string; amount_cents: number;
  collector_id: string | null; collector_name: string | null; status: string; validation_status: string; payment_source: string | null; payment_reported_date: string | null;
  revision: number; operational_status: CollectionStatus; case_revision: number; observation: string | null; next_action_text: string | null; next_date: string | null;
  retired_from_report?: boolean; return_due?: boolean; return_due_date?: string | null; can_start?: boolean; start_block_reason?: CollectionStartBlock | null;
  delay_days: number; total_work_seconds: number; operational_label?: string; legacy_worked?: boolean; current_timer: { session_id: string | null; started_at: string | null; running: boolean; elapsed_seconds: number };
}
export interface CollectionWorkbench { as_of_date: string; server_now: string; count: number; total_cents: number; snapshot_revision: string; rows: CollectionRow[]; active_timer: CollectionTimer | null; workflow?: CollectionWorkflow; priority?: CollectionPriority }
export interface CollectionCase { status: CollectionStatus; observation: string | null; next_action: string | null; next_date: string | null; payment_date: string | null; revision: number; updated_at: string | null; updated_by: string | null; finalized_at: string | null }
export interface CollectionHistory { id: string; action: string; observation: string | null; created_at: string; contact_date?: string | null; next_action?: string | null; next_date?: string | null; payment_date?: string | null; return_note?: string | null }
export interface CollectionWorkSession { id: string; [key: string]: unknown }
export interface CollectionCaseHistory { id: string; status: CollectionStatus; observation: string | null; next_action: string | null; next_date: string | null; finalized: boolean; created_at: string }
export interface CollectionReportHistory { id: string; action: 'RETIRED_WORKED' | 'RETIRED_UNWORKED' | 'REAPPEARED'; worked: boolean; reference_date: string; created_at: string }
export interface CollectionDetail { title: CollectionRow; case: CollectionCase; timer: CollectionTimer; history: CollectionHistory[]; report_history?: CollectionReportHistory[]; case_history?: CollectionCaseHistory[]; work_sessions: CollectionWorkSession[]; workflow?: CollectionWorkflow; priority?: CollectionPriority }
export interface CollectionDraft { status: CollectionStatus; observation: string; nextAction: string; nextDate: string; paymentDate: string }
export interface CollectionSaveResult { title_id: string; revision: number; case_revision: number; event_id: string | null; finished: boolean; timer: CollectionTimer }
export interface CollectionAgent { id: string; display_name: string; enabled: boolean }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(new Date(value).getTime());
export function collectionDate(value: unknown): value is string { try { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && addCivilDays(value, 0) === value; } catch { return false; } }
export function collectionServerDay(timestamp: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
  const part = (name: string) => parts.find(value => value.type === name)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function collectionDateTime(timestamp: string): string { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(timestamp)); }
function validRow(value: unknown, day: string): value is CollectionRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as CollectionRow;
  return typeof row.id === 'string' && !!row.id && typeof row.customer_key === 'string' && !!row.customer_key && typeof row.client_name === 'string' && typeof row.document === 'string' && typeof row.branch === 'string'
    && nullableText(row.collector_id) && nullableText(row.collector_name) && collectionDate(row.due_date) && row.due_date < day && integer(row.amount_cents) && integer(row.revision) && integer(row.case_revision)
    && COLLECTION_STATUSES.includes(row.operational_status) && row.status !== 'ACTIVE' && Object.hasOwn(FINANCIAL_STATUSES, row.status) && integer(row.delay_days)
    && row.delay_days === Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${row.due_date}T12:00:00Z`)) / 86400000)
    && nullableText(row.observation) && nullableText(row.next_action_text) && (row.next_date === null || collectionDate(row.next_date)) && integer(row.total_work_seconds);
}
export function validCollectionTimer(value: unknown): value is CollectionTimer {
  if (!value || typeof value !== 'object') return false;
  const timer = value as CollectionTimer;
  return typeof timer.title_id === 'string' && typeof timer.running === 'boolean' && nullableText(timer.session_id) && (timer.started_at === null || instant(timer.started_at))
    && integer(timer.elapsed_seconds) && integer(timer.total_seconds) && integer(timer.actor_total_seconds) && timer.total_seconds >= timer.actor_total_seconds && timer.actor_total_seconds >= timer.elapsed_seconds
    && instant(timer.server_now) && (!timer.running || !!timer.session_id && instant(timer.started_at));
}
export function collectionWorkflowReady(value: CollectionWorkflow | undefined): value is CollectionWorkflow {
  return value?.version === '029' && value.normal_pause === true && value.finish_requires_started === true && value.pending_read_only === true && value.returns_priority === true;
}
function validPriority(value: CollectionPriority | undefined, day: string) {
  return !!value && nullableText(value.collector_id) && integer(value.due_count) && integer(value.total_cents) && nullableText(value.next_title_id)
    && (value.next_due_date === null || collectionDate(value.next_due_date) && value.next_due_date <= day)
    && (value.due_count === 0 ? value.total_cents === 0 && value.next_title_id === null && value.next_due_date === null : !!value.next_title_id && !!value.next_due_date);
}
function validWorkflowRow(row: CollectionRow, day: string) {
  return typeof row.return_due === 'boolean' && (row.return_due_date === null || collectionDate(row.return_due_date))
    && (!row.return_due || !!row.return_due_date && row.return_due_date <= day) && typeof row.can_start === 'boolean'
    && (row.start_block_reason === null || ['RETURN_PRIORITY', 'ALREADY_RUNNING', 'UNASSIGNED', 'PENDING_VALIDATION', 'SETTLED', 'READ_ONLY', 'REPORT_RETIRED'].includes(row.start_block_reason ?? ''))
    && (!row.can_start || row.start_block_reason === null) && (!row.retired_from_report || !row.can_start && ['REPORT_RETIRED', 'READ_ONLY'].includes(row.start_block_reason ?? ''));
}
export function collectionStartReason(reason: CollectionStartBlock | null | undefined) {
  return reason === 'RETURN_PRIORITY' ? 'Atenda primeiro os retornos devidos desta carteira, com data até hoje.'
    : reason === 'ALREADY_RUNNING' ? 'Já existe um atendimento em andamento. Pause ou finalize esse atendimento antes de iniciar outro.'
    : reason === 'UNASSIGNED' ? 'Este título está sem responsável definida. Acesse Importar Bases → Contas a Receber para definir as responsáveis na importação.'
    : reason === 'PENDING_VALIDATION' ? 'Pagamento informado aguarda validação de Contas a Receber. Este título está em leitura.'
    : reason === 'SETTLED' ? 'Recebimento já validado. O título está disponível somente no histórico.'
    : reason === 'REPORT_RETIRED' ? 'Título ausente do relatório completo, disponível somente no histórico. O financeiro pode confirmar o recebimento na Validação financeira ou pelo relatório de quitados.'
    : reason === 'READ_ONLY' ? 'Seu perfil permite somente leitura; não pode iniciar ou alterar este atendimento.' : '';
}
export function assertCollectionWorkbench(value: unknown, isCollector: boolean, collectorId: string | null, filters: CollectionFilters): asserts value is CollectionWorkbench {
  const result = value as CollectionWorkbench;
  const ready = collectionWorkflowReady(result?.workflow);
  if (!result || !collectionDate(result.as_of_date) || !instant(result.server_now) || !integer(result.count) || !integer(result.total_cents) || typeof result.snapshot_revision !== 'string' || !result.snapshot_revision || !Array.isArray(result.rows) || result.rows.length > 500 || result.rows.length > result.count
    || result.active_timer !== null && (!validCollectionTimer(result.active_timer) || !result.active_timer.running)
    || ready && (!validPriority(result.priority, result.as_of_date) || result.rows.some(row => !validWorkflowRow(row, result.as_of_date)) || result.active_timer !== null && typeof result.active_timer.recovery_allowed !== 'boolean')
    || result.rows.some(row => !validRow(row, result.as_of_date) || isCollector && row.collector_id !== collectorId || (filters.queue === 'active' || filters.queue === 'returns') && (row.retired_from_report === true || row.status === 'VALIDATED' || ready && row.status === 'PENDING_VALIDATION') || ready && filters.queue === 'returns' && row.return_due !== true) || new Set(result.rows.map(row => row.id)).size !== result.rows.length
    || result.rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n) > BigInt(result.total_cents) || result.count === 0 && result.total_cents !== 0) throw new Error('invalid_workbench');
}
export function assertCollectionDetail(value: unknown, isCollector: boolean, collectorId: string | null): asserts value is CollectionDetail {
  const data = value as CollectionDetail;
  const state = data?.case;
  const day = data?.timer?.server_now && collectionServerDay(data.timer.server_now);
  const ready = collectionWorkflowReady(data?.workflow);
  if (!data || !validCollectionTimer(data.timer) || !collectionDate(day) || !validRow(data.title, day) || data.timer.title_id !== data.title.id || isCollector && data.title.collector_id !== collectorId
    || ready && (!validPriority(data.priority, day) || !validWorkflowRow(data.title, day) || typeof data.workflow?.started !== 'boolean' || typeof data.workflow.can_finish !== 'boolean' || typeof data.workflow.recovery_allowed !== 'boolean')
    || !state || !COLLECTION_STATUSES.includes(state.status) || !integer(state.revision) || !nullableText(state.observation) || !nullableText(state.next_action) || state.next_date !== null && !collectionDate(state.next_date)
    || state.payment_date !== null && !collectionDate(state.payment_date) || !Array.isArray(data.history) || data.history.length > 100 || !Array.isArray(data.work_sessions) || data.work_sessions.length > 50
    || data.history.some(item => !item || typeof item.id !== 'string' || typeof item.action !== 'string' || !instant(item.created_at) || !nullableText(item.observation))
    || data.report_history !== undefined && (!Array.isArray(data.report_history) || data.report_history.length > 100 || data.report_history.some(item => !item || typeof item.id !== 'string' || !['RETIRED_WORKED', 'RETIRED_UNWORKED', 'REAPPEARED'].includes(item.action) || typeof item.worked !== 'boolean' || !collectionDate(item.reference_date) || !instant(item.created_at)))
    || data.case_history !== undefined && (!Array.isArray(data.case_history) || data.case_history.length > 100 || data.case_history.some(item => !item || typeof item.id !== 'string' || !COLLECTION_STATUSES.includes(item.status) || !instant(item.created_at) || !nullableText(item.observation)))) throw new Error('invalid_detail');
}
export function collectionArguments(filters: CollectionFilters, offset: number, limit: number, isCollector: boolean, collectorId: string | null) {
  return { p_search: filters.search.trim(), p_collector_id: isCollector ? collectorId : filters.collector && filters.collector !== 'unassigned' ? filters.collector : null, p_unassigned: !isCollector && filters.collector === 'unassigned', p_band: filters.band || null, p_sort: filters.sort, p_status: filters.status || null,
    p_offset: offset, p_limit: limit, p_queue: filters.queue, p_due_start: filters.dueStart || null, p_due_end: filters.dueEnd || null, p_next_action: filters.nextAction || null, p_financial_status: filters.financialStatus || null };
}
export async function readCollectionWorkbench(filters: CollectionFilters, offset: number, limit: number, isCollector: boolean, collectorId: string | null, signal: AbortSignal) {
  if (!supabase) throw { code: 'PGRST301' };
  if (isCollector && !collectorId) throw { code: '42501' };
  const result = await supabase.rpc('collection_workbench', collectionArguments(filters, offset, limit, isCollector, collectorId)).abortSignal(signal).retry(false);
  if (result.error) throw result.error;
  assertCollectionWorkbench(result.data, isCollector, collectorId, filters); return result.data;
}
export async function readCollectionDetail(titleId: string, isCollector: boolean, collectorId: string | null, signal: AbortSignal) {
  if (!supabase) throw { code: 'PGRST301' };
  const result = await supabase.rpc('collection_case_detail', { p_title_id: titleId }).abortSignal(signal).retry(false);
  if (result.error) throw result.error;
  assertCollectionDetail(result.data, isCollector, collectorId); return result.data;
}
export function collectionDraft(data: CollectionDetail): CollectionDraft { return { status: data.case.status, observation: data.case.observation ?? '', nextAction: data.case.next_action ?? '', nextDate: data.case.next_date ?? '', paymentDate: data.case.payment_date ?? data.title.payment_reported_date ?? '' }; }
export const collectionDraftKey = (draft: CollectionDraft) => JSON.stringify(draft);
export function workTime(seconds: number) { const value = Math.max(0, Math.floor(seconds)); return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
export function collectionError(error: unknown, fallback = 'Não foi possível concluir a operação. Confira sua conexão e tente novamente.') {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['PGRST202', 'PGRST205', '42883', '42P01', '42703'].includes(code)) return 'A central operacional da Cobrança precisa da atualização do banco. Peça à administração para ativar a operação de cobrança.';
  if (code === 'P0029') return 'Atenda primeiro os retornos devidos desta carteira. Atualize os títulos e abra a fila de retornos.';
  if (code === '55000') return 'Inicie este atendimento antes de finalizar. Uma pausa preserva o atendimento já iniciado.';
  if (code === '40001') return 'Este título foi alterado por outra operação. Atualize o detalhe, confira o rascunho e tente novamente.';
  if (code === '42501') return 'Seu perfil não tem permissão para esta operação ou carteira. Atualize os dados de acesso.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (code === '23514' || code === '22023') return 'A operação foi recusada. Confira o responsável, as datas, os campos obrigatórios e se há outro atendimento em andamento.';
  if (code === '22003') return 'O valor excede o limite seguro de precisão. Solicite a conferência da base.';
  return fallback;
}
export function downloadCollectionCsv(rows: CollectionRow[], day: string) {
  const escape = (value: unknown) => { let text = String(value ?? ''); if (/^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const decimal = (value: number) => `${BigInt(value) / 100n},${String(BigInt(value) % 100n).padStart(2, '0')}`;
  const header = ['Cliente', 'Documento', 'Empresa', 'Vencimento', 'Dias de atraso', 'Valor', 'Cobradora', 'Status da cobrança', 'Situação financeira', 'Observação', 'Próxima ação', 'Data da próxima ação', 'Retirado da carteira ativa pelo relatório completo'];
  const lines = rows.map(row => [row.client_name, row.document, row.branch, row.due_date, row.delay_days, decimal(row.amount_cents), row.collector_name ?? 'Sem cobradora definida', row.operational_label || row.operational_status, row.retired_from_report && row.status !== 'VALIDATED' ? 'Retirado da carteira ativa' : FINANCIAL_STATUSES[row.status], row.observation, row.next_action_text, row.next_date, row.retired_from_report ? 'SIM' : 'NÃO'].map(escape).join(';'));
  const url = URL.createObjectURL(new Blob(['\uFEFF' + header.map(escape).join(';') + '\r\n' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `Cobranca_Filtrado_${day}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
