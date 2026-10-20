import { publishableKey, supabase, supabaseUrl } from './supabase';
import type { ImportProblem } from './payables';
import { makeReceivableFailure } from './receivables-errors.mjs';
export { formatCents, dateLabel } from './payables';
export type { ImportProblem } from './payables';
export { makeReceivableFailure, receivableFailureReference, receivableImportFailureMessage } from './receivables-errors.mjs';
export const RECEIVABLE_SCOPE = 'grupo-consolidado';
export interface ReceivableImportRow { document: string; client_name: string; client_document: string | null; branch: string; issued_on: string | null; due_date: string; amount_cents: number }
export interface ReceivablePaidRow extends ReceivableImportRow { received_on: string; received_amount_cents: number }
export interface ReceivableTitle extends ReceivableImportRow { id:string; scope:string; source_key:string; customer_key:string; collector_id:string|null; status:'NEW'|'OPEN'|'PENDING_VALIDATION'|'NOT_LOCATED'|'VALIDATED'; validation_status:'NONE'|'PENDING'|'VALIDATED'; payment_source:'IMPORTACAO_DIARIA'|'COBRANCA'|null; payment_reported_date:string|null; payment_date:string|null; reported_in_collection:boolean; collector_locked:boolean; in_latest_report:boolean; retired_from_report:boolean; first_import_id:string; last_import_id:string; created_at:string; updated_at:string; revision:number; last_action:string|null; next_action:string|null; next_action_date:string|null }
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
  if (code === 'P0047') return error && typeof error === 'object' && 'activation_required' in error && error.activation_required === true ? 'Ative a atualização 047 no banco e publique a função receivables-import para sincronizar o relatório completo.' : 'A sincronização precisa de nova conferência. Analise o relatório novamente antes de concluir.';
  if (code === 'P0030') return error && typeof error === 'object' && 'activation_required' in error && error.activation_required === true ? 'Atualize o banco e a função receivables-import para definir as cobradoras na importação.' : 'Confira a responsável de cada cliente sem carteira e os vínculos das parcelas. Analise o mesmo arquivo novamente antes de concluir.';
  if (code === 'P0023' || code === 'P0024') return error && typeof error === 'object' && 'activation_required' in error && error.activation_required === true ? 'Ative a atualização de importação de Contas a Receber no banco e no serviço antes de concluir. Nenhum dado foi alterado.' : 'A importação encontrou uma divergência. Confira os vínculos entre as parcelas e reanalise o arquivo antes de concluir. Nenhum dado desta tentativa foi alterado.';
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)) return 'Este módulo precisa da atualização do banco de dados. Solicite a atualização de Contas a Receber à administração.';
  return fallback;
}

export interface ReceivableImportRequestBody { action: 'preview' | 'commit'; file_name: string; file_base64: string; complete?: boolean; previous_import_id?: string | null; mode?: 'open' | 'received'; title_mappings?: Record<string, string>; collector_mappings?: Record<string, string>; previous_financial_revision?: string | null; confirm_corrections?: boolean; full_report?: boolean; reference_date?: string; request_id?: string }
export async function receivableImportRequest<T>(body: ReceivableImportRequestBody, signal?: AbortSignal): Promise<T> {
  const client = supabase;
  const phase = body.action;
  if (signal?.aborted) throw new DOMException('Análise cancelada.', 'AbortError');
  if (!client) throw makeReceivableFailure({ phase, code: 'PGRST301' });
  let session;
  try { ({ data: { session } } = await client.auth.getSession()); }
  catch { throw makeReceivableFailure({ phase, code: 'CR_AUTH_UNAVAILABLE' }); }
  if (!session?.access_token) throw makeReceivableFailure({ phase, code: 'PGRST301' });
  const abort = new AbortController(), cancel = () => abort.abort(); let timedOut = false;
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) abort.abort();
  const timer = window.setTimeout(() => { timedOut = true; abort.abort(); },60000);
  try {
    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/functions/v1/receivables-import`, {
        method: 'POST', headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type':'application/json' },
        body:JSON.stringify(body), signal:abort.signal, credentials:'omit', cache:'no-store',
      });
    } catch {
      if (signal?.aborted) throw new DOMException('Análise cancelada.', 'AbortError');
      throw makeReceivableFailure({ phase, code: timedOut ? 'CR_REQUEST_TIMEOUT' : 'CR_NETWORK_ERROR' });
    }
    let result: unknown;
    try { result = await response.json(); }
    catch {
      if (signal?.aborted) throw new DOMException('Análise cancelada.', 'AbortError');
      throw makeReceivableFailure({ phase, status: response.status, code: timedOut ? 'CR_REQUEST_TIMEOUT' : 'CR_INVALID_RESPONSE' });
    }
    if (!response.ok) throw makeReceivableFailure({ phase, status: response.status, payload: result });
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw makeReceivableFailure({ phase, status: response.status, code: 'CR_INVALID_RESPONSE' });
    return result as T;
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort',cancel); }
}


async function analyzeReceivableImportFile<Row>(file: File, mode: 'open' | 'received', signal?: AbortSignal): Promise<{ rows: Row[]; errors: ImportProblem[]; hash: string; base64: string }> {
  if (!file.size) throw makeReceivableFailure({ phase: 'preview', code: 'CR_FILE_EMPTY' });
  if (file.size > 2 * 1024 * 1024) throw makeReceivableFailure({ phase: 'preview', code: 'CR_FILE_TOO_LARGE' });
  if (!/\.(xlsx|xlsm|csv|xls)$/i.test(file.name)) throw makeReceivableFailure({ phase: 'preview', code: 'CR_FILE_FORMAT_INVALID' });
  let original: ArrayBuffer;
  try { original = await file.arrayBuffer(); }
  catch { throw makeReceivableFailure({ phase: 'preview', code: 'CR_FILE_READ_FAILED' }); }
  if (signal?.aborted) throw new DOMException('Análise cancelada.', 'AbortError');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', original))).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const result = await new Promise<{ rows: Row[]; errors: ImportProblem[] }>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Análise cancelada.', 'AbortError')); return; }
    const worker = new Worker(new URL('../workers/receivables.worker.ts', import.meta.url), { type: 'module' });
    let timeout: number;
    const cleanup = () => { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new DOMException('Análise cancelada.', 'AbortError')); };
    timeout = window.setTimeout(() => { cleanup(); reject(makeReceivableFailure({ phase: 'preview', code: 'CR_FILE_ANALYSIS_TIMEOUT' })); }, 20000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => { cleanup(); resolve(event.data); };
    worker.onerror = () => { cleanup(); reject(makeReceivableFailure({ phase: 'preview', code: 'CR_FILE_ANALYSIS_FAILED' })); };
    const copy = original.slice(0);
    worker.postMessage({ buffer: copy, name: file.name, mode }, [copy]);
  });
  const bytes = new Uint8Array(original);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { ...result, hash, base64: btoa(binary) };
}

export function analyzeReceivableFile(file: File, signal?: AbortSignal) {
  return analyzeReceivableImportFile<ReceivableImportRow>(file, 'open', signal);
}
export function analyzeReceivableReceivedFile(file: File, signal?: AbortSignal) {
  return analyzeReceivableImportFile<ReceivablePaidRow>(file, 'received', signal);
}
