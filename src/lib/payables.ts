import { publishableKey, supabase, supabaseUrl } from './supabase';
import { financialWeekLabel } from './financial-dates';

export const PAYABLE_SCOPE = 'grupo-consolidado';
export interface PayableImportRow { entry_number: string; description: string; due_date: string; amount_cents: number; source_status: string; plan: string; bank_account: string; branch: string; issued_on: string | null; cheque_number?: string | null }
export interface PayablePaidRow { branch: string; entry_number: string; source_status: 'PAGO'; paid_on: string; amount_paid_cents: number; paid_bank: string; cheque_number?: string | null; description?: string; plan?: string; issued_on?: string | null }
export interface PayableTitle extends PayableImportRow {
  id: string; scope: string; source_key: string; macro: string; status: 'NEW' | 'OPEN' | 'SETTLED_IMPORT'; settled_at: string | null;
  last_import_id?: string; paid_cents?: number; outstanding_cents?: number; payment_remaining_cents?: number;
  overpaid_cents?: number; financial_status?: 'OPEN' | 'PARTIAL' | 'PAID' | 'OVERPAID' | 'PENDING_RECONCILIATION' | 'ADMIN_WRITEOFF';
  last_payment_date?: string | null; last_payment_bank?: string | null; payment_revision?: string | null;
  review_status?: 'A_CONCILIAR' | 'CONCILIADO' | 'BAIXADO_ADMINISTRATIVAMENTE'; review_id?: string | null; reviewed_by?: string | null; reviewed_at?: string | null; review_fingerprint?: string; closing_eligible?: boolean; closing_exclusion_reason?: string | null;
  administrative_writeoff_id?: string | null; administrative_writeoff_at?: string | null;
  administrative_writeoff_by?: string | null; administrative_writeoff_reason?: string | null;
  administrative_writeoff_import_id?: string | null;
}
export function isPayableAdministrativeWriteoff(row: PayableTitle) {
  return row.financial_status === 'ADMIN_WRITEOFF' || row.closing_exclusion_reason === 'ADMIN_WRITEOFF' || !!row.administrative_writeoff_id;
}
export interface ImportProblem { line: number; column: string; problem: string; correction: string }
export interface ImportPreview { previous_import_id: string | null; row_count: number; new_count: number; open_count: number; settled_count: number; changed_count?: number }
export interface PayableFilters { scope: string; search: string; start: string; end: string; status: string; macro: string; branch: string; financialStatus?: string; reviewStatus?: string; outstandingOnly?: boolean; canonicalOnly?: boolean }
export interface PayableServerPreview { rows: PayableImportRow[]; preview: ImportPreview; file_sha256: string }
export const payableStatus: Record<string, string> = { NEW: 'Novo', OPEN: 'Em aberto', SETTLED_IMPORT: 'Quitado por importação' };
export const payableFinancialStatus: Record<string, string> = { OPEN: 'Em aberto', PARTIAL: 'Pendência de pagamento anterior', PAID: 'Totalmente pago', OVERPAID: 'Pagamento acima do valor atualizado', PENDING_RECONCILIATION: 'Baixado por importação — a conciliar', ADMIN_WRITEOFF: 'Baixado sem pagamento' };
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export function formatCents(value: number) {
  if (!Number.isSafeInteger(value)) return 'Valor indisponível';
  const signed = BigInt(value), absolute = signed < 0n ? -signed : signed;
  const fraction = String(absolute % 100n).padStart(2,'0');
  return (signed < 0n ? '-' : '') + money.formatToParts(absolute / 100n).map(part => part.type === 'fraction' ? fraction : part.value).join('');
}
export function dateLabel(value: string | null) { if (!value) return '—'; return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
export function normalizePlan(value: string) { return value.trim().toUpperCase().replace(/\s+/g, ' '); }
export function payableError(error: unknown, fallback: string) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === '42501') return 'Seu perfil não tem permissão para esta operação.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (code === '40001') return 'A base mudou desde a análise. Analise o arquivo novamente antes de concluir.';
  if (code === '23505') return 'Este arquivo já foi importado para esta origem. Nenhum dado foi alterado.';
  if (code === 'P0021') return 'Ative a atualização das importações de previsão e pagamentos no banco de dados. Nenhum dado foi alterado.';
  if (code === 'P0042') return 'Confira a baixa sem pagamento e as possíveis alterações deste título antes de confirmar a importação.';
  if (code === 'P0043') return error && typeof error === 'object' && 'activation_required' in error && error.activation_required === true
    ? 'Ative a atualização de conciliação na importação no banco e na função payables-import. Preserve o arquivo e as escolhas para analisar novamente.'
    : 'Confira as decisões de pagamento e baixa de cada título e valide novamente as escolhas antes de confirmar a importação.';
  if (code === 'P0019') return 'Ative a atualização dos números de cheque no banco de dados antes de importar esta coluna. Nenhum dado foi alterado.';
  if (code === 'P0016') return 'Há lançamentos repetidos ou versões históricas ambíguas para a mesma filial e número. Confira parcelas e o histórico. Nenhum dado foi alterado.';
  if (code === '23514' || code === '22023') return 'A importação foi recusada. Confira as linhas, a origem completa e a classificação de todos os planos.';
  if (code === 'PGRST202' || code === '42P01') return 'Este módulo precisa da atualização do banco de dados. Solicite a aplicação da migration de Contas a Pagar à administração.';
  return fallback;
}

export interface PayableResolutionChoice {
  action: 'WRITE_OFF' | 'PAID' | 'REOPEN'; reason: string;
  paid_on?: string; amount_paid_cents?: number; bank_account_id?: string;
}
export interface PayableImportRequest {
  action: 'preview' | 'commit'; file_name: string; file_base64: string;
  mappings?: Record<string,string>; complete?: boolean; previous_import_id?: string | null;
  mode?: 'forecast' | 'payments'; bank_mappings?: Record<string,string>; confirm_corrections?: boolean;
  previous_financial_revision?: string | null; reconciliation_version?: '043'; full_report?: boolean;
  resolution_choices?: Record<string, PayableResolutionChoice>; request_id?: string;
  payment_date_version?: '2026-10-27.1';
}
export async function payableImportRequest<T>(body: PayableImportRequest, signal?: AbortSignal): Promise<T> {
  const client = supabase;
  if (!client) throw { code: 'PGRST301' };
  const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw { code: 'PGRST301' };
  const abort = new AbortController(), cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) abort.abort();
  const timer = window.setTimeout(cancel,60000);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/payables-import`, {
      method: 'POST', headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type':'application/json' },
      body:JSON.stringify(body), signal:abort.signal, credentials:'omit', cache:'no-store',
    });
    const result = await response.json();
    if (!response.ok) {
      const errors: ImportProblem[] = response.status === 422 && Array.isArray(result?.errors) ? result.errors.slice(0,100).filter((item:unknown) => item !== null && typeof item === 'object' && 'line' in item && Number.isSafeInteger(item.line) && 'column' in item && typeof item.column === 'string' && 'problem' in item && typeof item.problem === 'string' && 'correction' in item && typeof item.correction === 'string').map((item:ImportProblem) => ({ line:item.line, column:item.column.slice(0,300), problem:item.problem.slice(0,500), correction:item.correction.slice(0,500) })) : [];
      throw { activation_required: result?.activation_required === true, code: typeof result?.code === 'string' ? result.code : response.status === 401 ? 'PGRST301' : response.status === 403 ? '42501' : '', errors };
    }
    return result as T;
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort',cancel); }
}

export async function readPayables(filters: PayableFilters, offset: number, size: number, signal?: AbortSignal) {
  if (!supabase) throw new Error('Conexão indisponível.');
  const client = supabase;
  function queryFor(table: 'payable_review_titles' | 'payable_financial_titles' | 'payable_titles') {
  const financial = table !== 'payable_titles';
  let query = client.from(table).select('*', { count: 'exact' }).eq('scope', filters.scope).order('due_date').order('id').range(offset, offset + size - 1);
  if (filters.search.trim()) query = query.ilike('description', `%${filters.search.trim().replace(/[\\%_]/g, '\\$&')}%`);
  if (filters.start) query = query.gte('due_date', filters.start);
  if (filters.end) query = query.lte('due_date', filters.end);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.macro) query = query.eq('macro', filters.macro);
  if (filters.branch.trim()) query = query.eq('branch', filters.branch.trim());
  if (financial && filters.financialStatus) query = query.eq('financial_status', filters.financialStatus);
  if (table === 'payable_review_titles' && filters.reviewStatus) query = query.eq('review_status', filters.reviewStatus);
  if (table === 'payable_review_titles' && filters.canonicalOnly) query = query.eq('closing_eligible', true);
  if (financial && filters.outstandingOnly) query = query.gt('payment_remaining_cents', 0);
  if (signal) query = query.abortSignal(signal);
  return query;
  }
  let result = await queryFor('payable_review_titles');
  let reviewAvailable = true;
  if (result.error && ['PGRST205', '42P01'].includes(result.error.code)) {
    reviewAvailable = false;
    if (filters.canonicalOnly || filters.outstandingOnly) throw new Error('Ative o resumo gerencial de Contas a Pagar para consultar este detalhamento.');
    if (filters.reviewStatus) throw new Error('Ative o fechamento mensal no banco para filtrar pela revisão dos títulos.');
    result = await queryFor('payable_financial_titles');
  }
  let financialAvailable = true;
  if (result.error && ['PGRST205', '42P01'].includes(result.error.code)) {
    financialAvailable = false;
    if (filters.financialStatus) throw new Error('Ative a conciliação de pagamentos no banco para filtrar pela situação financeira.');
    result = await queryFor('payable_titles');
  }
  if (result.error) throw result.error;
  return { rows: (result.data ?? []) as unknown as PayableTitle[], count: result.count ?? 0, financialAvailable, reviewAvailable };
}

export interface PayablesRevision { import_id: string | null; financial_revision: string | null }
export async function readPayablesRevision(signal?: AbortSignal): Promise<PayablesRevision> {
  if (!supabase) throw new Error('Conexão indisponível.');
  let request = supabase.rpc('get_payables_revision'); if (signal) request = request.abortSignal(signal);
  const result = await request;
  if (result.error && ['PGRST202', '42883'].includes(result.error.code)) {
    let query = supabase.from('payable_imports').select('id').eq('scope', PAYABLE_SCOPE).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
    if (signal) query = query.abortSignal(signal);
    const fallback = await query; if (fallback.error) throw fallback.error;
    return { import_id: fallback.data?.[0]?.id ?? null, financial_revision: null };
  }
  if (result.error) throw result.error;
  if (!result.data || !(result.data.import_id === null || typeof result.data.import_id === 'string') || typeof result.data.financial_revision !== 'string') throw new Error('Não foi possível confirmar a versão dos dados financeiros.');
  return result.data as PayablesRevision;
}

async function analyzePayableImportFile<Row>(file: File, signal: AbortSignal | undefined, mode: 'forecast' | 'payments', today?: string): Promise<{ rows: Row[]; errors: ImportProblem[]; hash: string; base64: string }> {
  if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('Selecione um arquivo não vazio de até 2 MiB.');
  if (!/\.(xlsx|xlsm|csv|xls)$/i.test(file.name)) throw new Error('Selecione .xlsx, .xlsm ou .csv. Para .xls, salve uma cópia como .xlsx.');
  const original = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Análise cancelada.', 'AbortError');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', original))).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const result = await new Promise<{ rows: Row[]; errors: ImportProblem[] }>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/payables.worker.ts', import.meta.url), { type: 'module' });
    let timeout: number;
    const cleanup = () => { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new DOMException('Análise cancelada.', 'AbortError')); };
    timeout = window.setTimeout(() => { cleanup(); reject(new Error('A análise excedeu 20 segundos. Salve uma cópia com valores e tente novamente.')); }, 20000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => { cleanup(); resolve(event.data); };
    worker.onerror = () => { cleanup(); reject(new Error('Não foi possível processar a cópia do arquivo. Nenhum dado foi alterado.')); };
    const copy = original.slice(0);
    worker.postMessage({ buffer: copy, name: file.name, mode, ...(mode === 'payments' && today !== undefined ? { today } : {}) }, [copy]);
  });
  const bytes = new Uint8Array(original);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { ...result, hash, base64: btoa(binary) };
}

export function analyzePayableFile(file: File, signal?: AbortSignal) { return analyzePayableImportFile<PayableImportRow>(file, signal, 'forecast'); }
export function analyzePayablePaymentsFile(file: File, signal?: AbortSignal, today?: string) { return analyzePayableImportFile<PayablePaidRow>(file, signal, 'payments', today); }

export function downloadCsv(rows: PayableTitle[], name: string) {
  const headers = ['Centro de Custo Macro','Nº Lançamento','Histórico/Favorecido','Plano de Contas','Filial','Banco/Conta','Emissão','Vencimento','Semana Financeira','Valor','Status','Situação','Origem','Data baixa automática'];
  const financial = rows.length > 0 && rows.every(row => row.financial_status !== undefined);
  if (financial) headers.push('Valor pago histórico', 'Saldo em aberto', 'Situação financeira', 'Último pagamento', 'Banco do último pagamento', 'Crédito por pagamento excedente');
  const reviewed = financial && rows.every(row => row.review_status !== undefined);
  if (reviewed) headers.push('Revisão do título', 'Data da conferência', 'Responsável pela conferência');
  const hasCheques = rows.some(row => Object.hasOwn(row, 'cheque_number'));
  if (hasCheques) headers.push('Nº cheque');
  const administrative = rows.some(row => Object.hasOwn(row, 'administrative_writeoff_id'));
  if (administrative) headers.push('Valor considerado nos totais', 'Baixa sem pagamento', 'Motivo da baixa sem pagamento', 'Data da baixa sem pagamento', 'Responsável pela baixa sem pagamento', 'Importação da baixa sem pagamento');
  const safe = (value: unknown) => { let text = String(value ?? ''); if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"','""')}"`; };
  const decimal = (value:number) => { const cents=BigInt(value); return `${cents/100n},${String(cents%100n).padStart(2,'0')}`; };
  const lines = rows.map(row => {
    const writtenOff = isPayableAdministrativeWriteoff(row);
    return [row.macro,row.entry_number,row.description,row.plan,row.branch,row.bank_account,dateLabel(row.issued_on),dateLabel(row.due_date),financialWeekLabel(row.due_date),decimal(row.amount_cents),payableStatus[row.status],row.source_status,'IMPORTAÇÃO DIÁRIA',dateLabel(row.settled_at),
      ...(financial ? [Number.isSafeInteger(row.paid_cents) ? decimal(row.paid_cents!) : 'Indisponível', Number.isSafeInteger(row.outstanding_cents) ? decimal(row.outstanding_cents!) : 'Indisponível', payableFinancialStatus[row.financial_status!] ?? 'Indisponível', dateLabel(row.last_payment_date ?? null), row.last_payment_bank ?? '', Number.isSafeInteger(row.overpaid_cents) ? decimal(row.overpaid_cents!) : 'Indisponível'] : []),
      ...(reviewed ? [writtenOff ? 'BAIXADO SEM PAGAMENTO' : row.closing_eligible === false ? 'VERSÃO ANTERIOR — HISTÓRICO FORA DO FECHAMENTO' : row.review_status === 'CONCILIADO' ? 'CONCILIADO' : 'A CONCILIAR', dateLabel(row.reviewed_at ?? null), row.reviewed_by ?? ''] : []),
      ...(hasCheques ? [row.cheque_number ?? ''] : []),
      ...(administrative ? [decimal(writtenOff || row.closing_eligible === false ? 0 : row.amount_cents), writtenOff ? 'BAIXADO SEM PAGAMENTO' : '', row.administrative_writeoff_reason ?? '', dateLabel(row.administrative_writeoff_at ?? null), row.administrative_writeoff_by ?? '', row.administrative_writeoff_import_id ?? ''] : []),
    ].map(safe).join(';');
  });
  const url = URL.createObjectURL(new Blob(['\uFEFF' + headers.map(safe).join(';') + '\r\n' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
