import { publishableKey, supabase, supabaseUrl } from './supabase';

export const PAYABLE_SCOPE = 'grupo-consolidado';
export interface PayableImportRow { entry_number: string; description: string; due_date: string; amount_cents: number; source_status: string; plan: string; bank_account: string; branch: string; issued_on: string | null }
export interface PayableTitle extends PayableImportRow { id: string; scope: string; source_key: string; macro: string; status: 'NEW' | 'OPEN' | 'SETTLED_IMPORT'; settled_at: string | null }
export interface ImportProblem { line: number; column: string; problem: string; correction: string }
export interface ImportPreview { previous_import_id: string | null; row_count: number; new_count: number; open_count: number; settled_count: number }
export interface PayableFilters { scope: string; search: string; start: string; end: string; status: string; macro: string; branch: string }
export interface PayableServerPreview { rows: PayableImportRow[]; preview: ImportPreview; file_sha256: string }
export const payableStatus: Record<string, string> = { NEW: 'Novo', OPEN: 'Em aberto', SETTLED_IMPORT: 'Quitado por importação' };
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
  if (code === '23514' || code === '22023') return 'A importação foi recusada. Confira as linhas, a origem completa e a classificação de todos os planos.';
  if (code === 'PGRST202' || code === '42P01') return 'Este módulo precisa da atualização do banco de dados. Solicite a aplicação da migration de Contas a Pagar à administração.';
  return fallback;
}

export async function payableImportRequest<T>(body: { action: 'preview' | 'commit'; file_name: string; file_base64: string; mappings?: Record<string,string>; complete?: boolean; previous_import_id?: string | null }, signal?: AbortSignal): Promise<T> {
  const client = supabase;
  if (!client) throw { code: 'PGRST301' };
  const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw { code: 'PGRST301' };
  const abort = new AbortController(), cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) abort.abort();
  const timer = window.setTimeout(cancel,30000);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/payables-import`, {
      method: 'POST', headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type':'application/json' },
      body:JSON.stringify(body), signal:abort.signal, credentials:'omit', cache:'no-store',
    });
    const result = await response.json();
    if (!response.ok) {
      const errors: ImportProblem[] = response.status === 422 && Array.isArray(result?.errors) ? result.errors.slice(0,100).filter((item:unknown) => item !== null && typeof item === 'object' && 'line' in item && Number.isSafeInteger(item.line) && 'column' in item && typeof item.column === 'string' && 'problem' in item && typeof item.problem === 'string' && 'correction' in item && typeof item.correction === 'string').map((item:ImportProblem) => ({ line:item.line, column:item.column.slice(0,300), problem:item.problem.slice(0,500), correction:item.correction.slice(0,500) })) : [];
      throw { code: typeof result?.code === 'string' ? result.code : response.status === 401 ? 'PGRST301' : response.status === 403 ? '42501' : '', errors };
    }
    return result as T;
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort',cancel); }
}

export async function readPayables(filters: PayableFilters, offset: number, size: number, signal?: AbortSignal) {
  if (!supabase) throw new Error('Conexão indisponível.');
  let query = supabase.from('payable_titles').select('id,scope,source_key,entry_number,description,due_date,amount_cents,source_status,plan,bank_account,branch,issued_on,macro,status,settled_at', { count: 'exact' }).eq('scope', filters.scope).order('due_date').order('id').range(offset, offset + size - 1);
  if (filters.search.trim()) query = query.ilike('description', `%${filters.search.trim().replace(/[\\%_]/g, '\\$&')}%`);
  if (filters.start) query = query.gte('due_date', filters.start);
  if (filters.end) query = query.lte('due_date', filters.end);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.macro) query = query.eq('macro', filters.macro);
  if (filters.branch.trim()) query = query.eq('branch', filters.branch.trim());
  if (signal) query = query.abortSignal(signal);
  const result = await query;
  if (result.error) throw result.error;
  return { rows: (result.data ?? []) as PayableTitle[], count: result.count ?? 0 };
}

export async function analyzePayableFile(file: File, signal?: AbortSignal): Promise<{ rows: PayableImportRow[]; errors: ImportProblem[]; hash: string; base64: string }> {
  if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('Selecione um arquivo não vazio de até 2 MiB.');
  if (!/\.(xlsx|xlsm|csv|xls)$/i.test(file.name)) throw new Error('Selecione .xlsx, .xlsm ou .csv. Para .xls, salve uma cópia como .xlsx.');
  const original = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Análise cancelada.', 'AbortError');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', original))).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const result = await new Promise<{ rows: PayableImportRow[]; errors: ImportProblem[] }>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/payables.worker.ts', import.meta.url), { type: 'module' });
    let timeout: number;
    const cleanup = () => { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new DOMException('Análise cancelada.', 'AbortError')); };
    timeout = window.setTimeout(() => { cleanup(); reject(new Error('A análise excedeu 20 segundos. Salve uma cópia com valores e tente novamente.')); }, 20000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => { cleanup(); resolve(event.data); };
    worker.onerror = () => { cleanup(); reject(new Error('Não foi possível processar a cópia do arquivo. Nenhum dado foi alterado.')); };
    const copy = original.slice(0);
    worker.postMessage({ buffer: copy, name: file.name }, [copy]);
  });
  const bytes = new Uint8Array(original);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { ...result, hash, base64: btoa(binary) };
}

export function downloadCsv(rows: PayableTitle[], name: string) {
  const headers = ['Centro de Custo Macro','Nº Lançamento','Histórico/Favorecido','Plano de Contas','Filial','Banco/Conta','Emissão','Vencimento','Valor','Status','Situação','Origem','Data baixa automática'];
  const safe = (value: unknown) => { let text = String(value ?? ''); if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"','""')}"`; };
  const decimal = (value:number) => { const cents=BigInt(value); return `${cents/100n},${String(cents%100n).padStart(2,'0')}`; };
  const lines = rows.map(row => [row.macro,row.entry_number,row.description,row.plan,row.branch,row.bank_account,dateLabel(row.issued_on),dateLabel(row.due_date),decimal(row.amount_cents),payableStatus[row.status],row.source_status,'IMPORTAÇÃO DIÁRIA',dateLabel(row.settled_at)].map(safe).join(';'));
  const url = URL.createObjectURL(new Blob(['\uFEFF' + headers.map(safe).join(';') + '\r\n' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
