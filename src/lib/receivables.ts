import { publishableKey, supabase, supabaseUrl } from './supabase';
import type { ImportProblem } from './payables';
export { formatCents, dateLabel } from './payables';
export type { ImportProblem } from './payables';
export const RECEIVABLE_SCOPE = 'grupo-consolidado';
export interface ReceivableImportRow { document: string; client_name: string; client_document: string | null; branch: string; issued_on: string | null; due_date: string; amount_cents: number }
export interface ReceivableTitle extends ReceivableImportRow { id:string; scope:string; source_key:string; customer_key:string; collector_id:string|null; status:'NEW'|'OPEN'|'PENDING_VALIDATION'|'NOT_LOCATED'|'VALIDATED'; validation_status:'NONE'|'PENDING'|'VALIDATED'; payment_source:'IMPORTACAO_DIARIA'|'COBRANCA'|null; payment_reported_date:string|null; payment_date:string|null; reported_in_collection:boolean; collector_locked:boolean; in_latest_report:boolean; first_import_id:string; last_import_id:string; created_at:string; updated_at:string; revision:number; last_action:string|null; next_action:string|null; next_action_date:string|null }
export interface ReceivableImportPreview { previous_import_id: string | null; row_count: number; new_count: number; open_count: number; pending_count: number; validated_in_source_count: number }
export interface ReceivableServerPreview { rows: ReceivableImportRow[]; preview: ReceivableImportPreview; file_sha256: string }
export const receivableStatus: Record<string,string> = { NEW: 'Novo', OPEN: 'Em aberto', PENDING_VALIDATION: 'Quitado — aguardando validação', VALIDATED: 'Quitado — validado', NOT_LOCATED: 'Pagamento não localizado — cobrar novamente' };
export function receivableError(error: unknown, fallback: string) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === '42501') return 'Seu perfil não tem permissão para esta operação.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (code === '40001') return 'A base mudou desde a análise. Analise o arquivo novamente antes de concluir.';
  if (code === '23505') return 'Este arquivo já foi importado para esta origem. Nenhum dado foi alterado.';
  if (code === '23514' || code === '22023') return 'A importação foi recusada. Confira as linhas e confirme o relatório completo da mesma origem.';
  if (code === 'PGRST202' || code === '42P01') return 'Este módulo precisa da atualização do banco de dados. Solicite a atualização de Contas a Receber à administração.';
  return fallback;
}

export async function receivableImportRequest<T>(body: { action: 'preview' | 'commit'; file_name: string; file_base64: string; complete?: boolean; previous_import_id?: string | null }, signal?: AbortSignal): Promise<T> {
  const client = supabase;
  if (!client) throw { code: 'PGRST301' };
  const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw { code: 'PGRST301' };
  const abort = new AbortController(), cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) abort.abort();
  const timer = window.setTimeout(cancel,30000);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/receivables-import`, {
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


export async function analyzeReceivableFile(file: File, signal?: AbortSignal): Promise<{ rows: ReceivableImportRow[]; errors: ImportProblem[]; hash: string; base64: string }> {
  if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('Selecione um arquivo não vazio de até 2 MiB.');
  if (!/\.(xlsx|xlsm|csv|xls)$/i.test(file.name)) throw new Error('Selecione .xlsx, .xlsm ou .csv. Para .xls, salve uma cópia como .xlsx.');
  const original = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Análise cancelada.', 'AbortError');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', original))).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const result = await new Promise<{ rows: ReceivableImportRow[]; errors: ImportProblem[] }>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/receivables.worker.ts', import.meta.url), { type: 'module' });
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
