import { useEffect, useRef, useState, type FormEvent } from 'react';
import { publishableKey, supabase, supabaseUrl } from '../lib/supabase';
import { dateLabel } from '../lib/payables';
import { analyzeCollectionReferenceFile, hashCollectionReferenceFile, type CollectionReferenceMode, type CollectionReferenceStats } from '../lib/collection-reference-import';
import { makeCollectionReferenceFailure, collectionReferenceFailureMessage, collectionReferenceFailureReference, type CollectionReferenceAction } from '../lib/collection-reference-errors.mjs';
import '../collection-reference-import.css';

type Mode = CollectionReferenceMode;
type JobStatus = 'UPLOADING' | 'VERIFIED' | 'STAGING' | 'PREPARED' | 'PUBLISHING' | 'PUBLISHED';
type Phase = 'hash' | 'begin' | 'upload' | 'verify' | 'read' | 'stage' | 'preview' | 'publish';
interface Job {
  job_id: string; mode: 'CONTACTS' | 'DESCRIPTIONS'; status: JobStatus; bucket: string; storage_path: string;
  source_name: string; source_size: number; source_sha256: string; original_verified: boolean;
  manifest_sha256: string | null; staged_rows: number; staged_chunks: number; reused?: boolean; created_at?: string;
}
interface Example { source_line: number; outcome: string; client_name: string | null; document?: string | null; branch?: string | null; problem: string | null }
interface Preview {
  job_id: string; mode: Job['mode']; status: JobStatus; financial_revision: string; context_revision: string;
  source: { name: string; size: number; sha256: string; verified: true }; manifest_sha256: string;
  row_count: number; deduplicated_count: number; eligible_count: number; matched_title_count: number; unmatched_count: number;
  paid_only_count: number; ambiguous_count: number; invalid_count: number; warning_count: number; manual_preserved_count: number;
  variant_count: number; quarantine_count: number; can_publish: boolean; requires_quarantine_confirmation: boolean;
  processed_rows: number; published_rows: number; remaining_rows: number; examples: Example[];
}
interface PublishResult { job_id: string; status: 'PUBLISHING' | 'PUBLISHED'; done: boolean; processed_rows: number; published_rows: number; skipped_manual_rows: number; quarantined_rows: number; remaining_rows: number }
interface StageResult { job_id: string; chunk_index: number; row_count: number; duplicate: boolean; staged_rows: number; staged_chunks: number }
interface PublishRequest { action: 'publish'; job_id: string; previous_financial_revision: string; confirm_quarantine: boolean; request_id: string }
interface History { count: number; rows: Job[] }
const maxBytes = 16 * 1024 * 1024;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const sha = /^[a-f\d]{64}$/;
const statuses: Record<JobStatus, string> = { UPLOADING: 'Aguardando arquivo', VERIFIED: 'Arquivo conferido', STAGING: 'Preparação em andamento', PREPARED: 'Pronto para conferência', PUBLISHING: 'Conclusão em andamento', PUBLISHED: 'Concluído' };
const phaseLabels: Record<Phase, string> = { hash: 'Conferindo o arquivo selecionado', begin: 'Preparando o envio', upload: 'Enviando a cópia original', verify: 'Conferindo a cópia recebida', read: 'Lendo o arquivo e organizando os registros', stage: 'Recebendo os registros preparados', preview: 'Conferindo vínculos e pendências', publish: 'Concluindo a importação' };
const outcomes: Record<string, string> = { MATCHED: 'Vínculo encontrado', UNMATCHED: 'Sem vínculo', PAID_ONLY: 'Título quitado — sem vínculo ativo', AMBIGUOUS: 'Vínculo a conferir', INVALID: 'Dados a conferir', MANUAL_PRESERVED: 'Alteração manual preservada', VARIANT: 'Descrições divergentes' };
const previewCounts = ['row_count', 'deduplicated_count', 'eligible_count', 'matched_title_count', 'unmatched_count', 'paid_only_count', 'ambiguous_count', 'invalid_count', 'warning_count', 'manual_preserved_count', 'variant_count', 'quarantine_count', 'processed_rows', 'published_rows', 'remaining_rows'] as const;
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const count = (value: number) => value.toLocaleString('pt-BR');
const modeLabel = (mode: Mode | Job['mode']) => mode === 'contacts' || mode === 'CONTACTS' ? 'Contatos dos clientes' : 'Descrições dos títulos';
const modeForJob = (job: Job): Mode => job.mode === 'CONTACTS' ? 'contacts' : 'descriptions';
const sizeLabel = (bytes: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: bytes < 1024 * 1024 ? 0 : 2 }).format(bytes / (bytes < 1024 * 1024 ? 1024 : 1024 * 1024)) + (bytes < 1024 * 1024 ? ' KB' : ' MB');
const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
const knownFailure = (error: unknown) => ['40001', '42501', '22023', '23514', '23505', 'P0028', 'PGRST301', 'PGRST303', 'ORIGINAL_MISSING'].includes(codeOf(error));
function referenceError(error: unknown, fallback: string) {
  const code = codeOf(error);
  if (code === '42501') return 'Seu acesso não permite importar contatos e descrições. Confira o acesso com a Gerência Geral.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente antes de continuar.';
  if (['P0028', 'PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return 'A importação de contatos e descrições precisa ser ativada pela administração.';
  if (code === '40001') return 'A base foi atualizada durante a conferência. Reanalise este arquivo preparado antes de concluir.';
  if (code === '23514' || code === '22023' || code === '23505') return 'A preparação foi recusada. Confira o arquivo, seus cabeçalhos e as pendências antes de tentar novamente.';
  if (code === 'SOURCE_MISMATCH') return 'A cópia recebida não corresponde ao arquivo selecionado. A preparação foi interrompida para conferência.';
  if (error instanceof Error && /^(?:Selecione |Salve uma cópia|Cabeçalho |A planilha |A linha \d|A referência |O cache |Este navegador |Arquivo de apoio |Estrutura XLSX |Integridade |XML |Relação da planilha |Caminho da planilha |Parte obrigatória |Tamanho expandido |Metadados XLSX |Elemento XML |Entidade XML |Caractere XML |Linhas físicas XLSX |Células XLSX |Índice sharedStrings |Tipo de célula XLSX |A leitura do arquivo )/.test(error.message)) return error.message.slice(0, 600);
  return collectionReferenceFailureMessage(error, fallback);
}
function assertJob(value: unknown, expectedHash?: string): asserts value is Job {
  const job = value as Job;
  if (!job || !uuid.test(job.job_id) || !['CONTACTS', 'DESCRIPTIONS'].includes(job.mode) || !Object.hasOwn(statuses, job.status)
    || job.bucket !== 'collection-reference-files' || typeof job.storage_path !== 'string'
    || !new RegExp('^[a-f0-9-]{36}/' + job.job_id + '/original$', 'i').test(job.storage_path)
    || typeof job.source_name !== 'string' || !job.source_name || !safeCount(job.source_size) || !job.source_size || job.source_size > maxBytes
    || !sha.test(job.source_sha256) || expectedHash !== undefined && expectedHash !== job.source_sha256
    || typeof job.original_verified !== 'boolean' || job.manifest_sha256 !== null && !sha.test(job.manifest_sha256)
    || !safeCount(job.staged_rows) || !safeCount(job.staged_chunks) || job.staged_rows > 300000 || job.staged_chunks > 1024) throw new Error('invalid_job');
}
function assertPreview(value: unknown, job: Job): asserts value is Preview {
  const preview = value as Preview;
  if (!preview || preview.job_id !== job.job_id || preview.mode !== job.mode || !Object.hasOwn(statuses, preview.status)
    || typeof preview.financial_revision !== 'string' || !preview.financial_revision || typeof preview.context_revision !== 'string' || !preview.context_revision
    || !preview.source || preview.source.sha256 !== job.source_sha256 || preview.source.size !== job.source_size || preview.source.name !== job.source_name || preview.source.verified !== true
    || !sha.test(preview.manifest_sha256) || previewCounts.some(key => !safeCount(preview[key]))
    || typeof preview.can_publish !== 'boolean' || typeof preview.requires_quarantine_confirmation !== 'boolean'
    || !Array.isArray(preview.examples) || preview.examples.length > 100
    || preview.examples.some(row => !row || !safeCount(row.source_line) || row.source_line < 2 || !Object.hasOwn(outcomes, row.outcome) || row.client_name !== null && typeof row.client_name !== 'string' || row.problem !== null && typeof row.problem !== 'string')) throw new Error('invalid_preview');
}
function assertPublish(value: unknown, jobId: string): asserts value is PublishResult {
  const result = value as PublishResult;
  if (!result || result.job_id !== jobId || !['PUBLISHING', 'PUBLISHED'].includes(result.status) || typeof result.done !== 'boolean'
    || ['processed_rows', 'published_rows', 'skipped_manual_rows', 'quarantined_rows', 'remaining_rows'].some(key => !safeCount(result[key as keyof PublishResult]))
    || result.done !== (result.status === 'PUBLISHED') || result.done && result.remaining_rows !== 0) throw new Error('unknown_publication');
}
async function referenceRequest<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const action = body.action as CollectionReferenceAction;
  if (signal?.aborted) throw new DOMException('Conferência cancelada.', 'AbortError');
  if (!supabase) throw makeCollectionReferenceFailure({ action, code: 'PGRST301' });
  let session;
  try { ({ data: { session } } = await supabase.auth.getSession()); }
  catch { throw makeCollectionReferenceFailure({ action, code: 'REF_AUTH_UNAVAILABLE' }); }
  if (!session?.access_token) throw makeCollectionReferenceFailure({ action, code: 'PGRST301' });
  const abort = new AbortController(); let timedOut = false;
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  const timer = window.setTimeout(() => { timedOut = true; abort.abort(); }, 60000);
  try {
    let response: Response;
    try { response = await fetch(supabaseUrl + '/functions/v1/collection-reference-import', { method: 'POST', headers: { apikey: publishableKey, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal, credentials: 'omit', cache: 'no-store' }); }
    catch {
      if (signal?.aborted) throw new DOMException('Conferência cancelada.', 'AbortError');
      throw makeCollectionReferenceFailure({ action, code: timedOut ? 'REF_REQUEST_TIMEOUT' : 'REF_NETWORK_ERROR' });
    }
    let result: unknown;
    try { result = await response.json(); }
    catch {
      if (signal?.aborted) throw new DOMException('Conferência cancelada.', 'AbortError');
      throw makeCollectionReferenceFailure({ action, status: response.status, ...(timedOut ? { code: 'REF_REQUEST_TIMEOUT' } : response.ok ? { code: 'REF_INVALID_RESPONSE' } : {}) });
    }
    if (!response.ok) throw makeCollectionReferenceFailure({ action, status: response.status, payload: result });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw makeCollectionReferenceFailure({ action, status: response.status, code: 'REF_INVALID_RESPONSE' });
    return result as T;
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
function base64(bytes: Uint8Array) { let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }

export default function CollectionReferenceImport({ canImport }: { canImport: boolean }) {
  const [mode, setMode] = useState<Mode>('contacts'), [file, setFile] = useState<File | null>(null), [job, setJob] = useState<Job | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null), [stats, setStats] = useState<CollectionReferenceStats | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null), [preparedRows, setPreparedRows] = useState(0), [preparedChunks, setPreparedChunks] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false), [canceling, setCanceling] = useState(false), [pending, setPending] = useState<PublishRequest | null>(null);
  const [error, setError] = useState(''), [errorReference, setErrorReference] = useState(''), [notice, setNotice] = useState(''), [success, setSuccess] = useState(''), [publishProgress, setPublishProgress] = useState(0);
  const [history, setHistory] = useState<History>({ count: 0, rows: [] }), [historyLoading, setHistoryLoading] = useState(true), [historyError, setHistoryError] = useState(''), [historyErrorReference, setHistoryErrorReference] = useState(''), [historyRevision, setHistoryRevision] = useState(0);
  const controller = useRef<AbortController | null>(null), generation = useRef(0), cancelRequested = useRef(false), chunkPending = useRef(false), input = useRef<HTMLInputElement | null>(null);
  const pendingRequest = useRef<PublishRequest | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    if (!canImport) { setHistoryLoading(false); return; }
    const abort = new AbortController(); setHistoryLoading(true); setHistoryError(''); setHistoryErrorReference('');
    void referenceRequest<History>({ action: 'history', offset: 0, limit: 20 }, abort.signal).then(result => {
      if (!safeCount(result?.count) || !Array.isArray(result.rows) || result.rows.length > 20 || result.rows.length > result.count) throw new Error('invalid_history');
      result.rows.forEach(row => assertJob(row));
      if (!abort.signal.aborted) setHistory(result);
    }).catch(failure => { if (!abort.signal.aborted) { setHistoryError(referenceError(failure, 'Não foi possível consultar o histórico de importações. A seleção do arquivo continua disponível.')); setHistoryErrorReference(collectionReferenceFailureReference(failure, 'history')); } }).finally(() => { if (!abort.signal.aborted) setHistoryLoading(false); });
    return () => abort.abort();
  }, [canImport, historyRevision]);
  const busy = phase !== null, preparing = busy && phase !== 'publish', locked = busy || pending !== null;
  function clearMessages() { setError(''); setErrorReference(''); setNotice(''); setSuccess(''); }
  function showFailure(failure: unknown, fallback: string, action: CollectionReferenceAction = 'preview') {
    const safeFailure = failure instanceof Error && /^(?:invalid_|unknown_|unverified_original$)/.test(failure.message)
      ? makeCollectionReferenceFailure({ action, code: failure.message === 'invalid_preview' ? 'REF_INVALID_PREVIEW' : 'REF_INVALID_RESPONSE', status: 200 }) : failure;
    setError(referenceError(safeFailure, fallback)); setErrorReference(collectionReferenceFailureReference(safeFailure, action));
  }
  function reset() {
    generation.current++; controller.current?.abort(); setPreview(null); setJob(null); setStats(null); setAcknowledged(false); setPreparedRows(0); setPreparedChunks(0); clearMessages();
  }
  function changeMode(next: Mode) { if (locked || next === mode) return; reset(); setMode(next); setFile(null); if (input.current) input.current.value = ''; }
  function checkCanceled() { if (cancelRequested.current || controller.current?.signal.aborted) throw new DOMException('Preparação interrompida.', 'AbortError'); }
  async function loadPreview(currentJob: Job, current: number) {
    checkCanceled(); setPhase('preview');
    const result = await referenceRequest<Preview>({ action: 'preview', job_id: currentJob.job_id }, controller.current?.signal);
    checkCanceled();
    assertPreview(result, currentJob);
    if (current !== generation.current) return;
    setPreview(result); setAcknowledged(false); setJob({ ...currentJob, status: result.status }); setPreparedRows(currentJob.staged_rows); setPreparedChunks(currentJob.staged_chunks);
  }
  async function uploadOriginal(currentJob: Job, source: File) {
    if (!supabase) throw { code: 'PGRST301' };
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !currentJob.storage_path.startsWith(session.user.id + '/')) throw { code: '42501' };
    setPhase('upload');
    const result = await supabase.storage.from(currentJob.bucket).upload(currentJob.storage_path, source, { upsert: false, contentType: source.type || 'application/octet-stream' });
    if (result.error) throw result.error;
  }
  async function analyze(event: FormEvent) {
    event.preventDefault(); if (!file || !canImport || locked) return;
    if (!file.size || file.size > maxBytes || !/\.(xlsx|xlsm)$/i.test(file.name)) { setError('Selecione um arquivo .xlsx ou .xlsm não vazio, de até 16 MB.'); setErrorReference(''); return; }
    const current = ++generation.current, source = file, selectedMode = mode, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    cancelRequested.current = false; chunkPending.current = false; setCanceling(false); clearMessages(); setPreview(null); setJob(null); setStats(null); setAcknowledged(false); setPreparedRows(0); setPreparedChunks(0); setPhase('hash');
    try {
      const hash = await hashCollectionReferenceFile(source, abort.signal); checkCanceled(); setPhase('begin');
      let currentJob = await referenceRequest<Job>({ action: 'begin', mode: selectedMode, file_name: source.name, file_size: source.size, file_sha256: hash }, abort.signal);
      assertJob(currentJob, hash);
      if (currentJob.mode !== (selectedMode === 'contacts' ? 'CONTACTS' : 'DESCRIPTIONS')) throw new Error('invalid_mode');
      if (current !== generation.current) return; setJob(currentJob); checkCanceled();
      if (currentJob.status === 'PUBLISHED') { setSuccess('Este arquivo já foi concluído. A importação anterior foi localizada e nenhum novo envio foi criado.'); setHistoryRevision(value => value + 1); return; }
      if (!currentJob.original_verified) {
        let missing = !currentJob.reused;
        if (currentJob.reused) {
          setPhase('verify');
          try { const verified = await referenceRequest<Job>({ action: 'verify_original', job_id: currentJob.job_id }); assertJob(verified, hash); currentJob = verified; }
          catch (failure) { if (codeOf(failure) !== 'ORIGINAL_MISSING') throw failure; missing = true; }
        }
        checkCanceled();
        if (missing) { await uploadOriginal(currentJob, source); checkCanceled(); setPhase('verify'); const verified = await referenceRequest<Job>({ action: 'verify_original', job_id: currentJob.job_id }); assertJob(verified, hash); currentJob = verified; }
        if (!currentJob.original_verified) throw new Error('unverified_original'); setJob(currentJob);
      }
      checkCanceled();
      if (['PREPARED', 'PUBLISHING'].includes(currentJob.status)) { await loadPreview(currentJob, current); return; }
      setPhase('read'); let expectedSequence = 0, rowCount = 0, runId: string | null = null;
      const parsed = await analyzeCollectionReferenceFile(source, selectedMode, {
        signal: abort.signal,
        onChunk: async chunk => {
          checkCanceled();
          if (chunk.sequence !== expectedSequence || !safeCount(chunk.rowCount) || !chunk.rowCount || chunk.rowCount > 500 || !(chunk.csv instanceof Uint8Array) || !chunk.csv.length || chunk.csv.length > 256 * 1024 || !sha.test(chunk.sha256) || runId !== null && runId !== chunk.runId) throw new Error('invalid_chunk');
          runId = chunk.runId; const body = { action: 'stage', job_id: currentJob.job_id, chunk_index: expectedSequence, chunk_sha256: chunk.sha256, chunk_base64: base64(chunk.csv) };
          chunkPending.current = true; setPhase('stage');
          try {
            let result: StageResult;
            try { result = await referenceRequest<StageResult>(body); }
            catch (failure) { if (knownFailure(failure) || cancelRequested.current) throw failure; result = await referenceRequest<StageResult>(body); }
            if (result?.job_id !== currentJob.job_id || result.chunk_index !== expectedSequence || result.row_count !== chunk.rowCount || typeof result.duplicate !== 'boolean' || !safeCount(result.staged_rows) || !safeCount(result.staged_chunks) || result.staged_chunks < expectedSequence + 1) throw new Error('invalid_stage_ack');
          } finally { chunkPending.current = false; }
          expectedSequence++; rowCount += chunk.rowCount;
          if (current !== generation.current) throw new DOMException('Preparação interrompida.', 'AbortError');
          setPreparedRows(rowCount); setPreparedChunks(expectedSequence); checkCanceled(); setPhase('read');
        },
      });
      checkCanceled();
      if (parsed.sourceSha256 !== hash || parsed.stats.chunk_count !== expectedSequence || !expectedSequence) throw { code: 'SOURCE_MISMATCH' };
      if (current !== generation.current) return; setStats(parsed.stats); setPhase('preview');
      const prepared = await referenceRequest<Job>({ action: 'finish_prepare', job_id: currentJob.job_id, expected_chunks: expectedSequence }, abort.signal); assertJob(prepared, hash); checkCanceled(); setJob(prepared);
      await loadPreview(prepared, current); setHistoryRevision(value => value + 1);
    } catch (failure) {
      if (current !== generation.current) return;
      setPreview(null);
      if (cancelRequested.current || abort.signal.aborted) setNotice('Preparação interrompida. A cópia original e os lotes já recebidos permanecem preservados. Selecione novamente o mesmo arquivo para continuar; nenhuma conclusão foi iniciada.');
      else showFailure(failure, 'Não foi possível concluir a preparação. Mantenha o mesmo arquivo para tentar novamente e recuperar os lotes já recebidos.', 'begin');
      setHistoryRevision(value => value + 1);
    } finally { if (current === generation.current) { setPhase(null); setCanceling(false); chunkPending.current = false; } }
  }
  function cancelPreparation() { if (!preparing || canceling) return; cancelRequested.current = true; setCanceling(true); if (!chunkPending.current && (phase === 'read' || phase === 'hash')) controller.current?.abort(); }
  async function reanalyze(selected: Job = job!) {
    if (!canImport || locked || !selected) return;
    const current = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort; cancelRequested.current = false; setCanceling(false); clearMessages(); setPhase('preview'); setPreview(null); setAcknowledged(false);
    try {
      const currentJob = await referenceRequest<Job>({ action: 'status', job_id: selected.job_id }, abort.signal); assertJob(currentJob);
      checkCanceled();
      if (current !== generation.current) return; setMode(modeForJob(currentJob)); setJob(currentJob); setFile(null); setStats(null); if (input.current) input.current.value = '';
      if (currentJob.status === 'PUBLISHED') { setSuccess('Esta importação já foi concluída. Os registros e as alterações manuais permanecem preservados.'); return; }
      if (!['PREPARED', 'PUBLISHING'].includes(currentJob.status)) { setNotice('Esta preparação ainda está incompleta. Selecione o mesmo arquivo original para continuar de onde parou.'); return; }
      await loadPreview(currentJob, current);
    } catch (failure) { if (current === generation.current) { if (cancelRequested.current) setNotice('Conferência interrompida. O arquivo preparado permanece disponível no histórico.'); else if (!abort.signal.aborted) showFailure(failure, 'Não foi possível conferir esta preparação. Tente atualizar novamente.'); } }
    finally { if (current === generation.current) { setPhase(null); setCanceling(false); } }
  }
  async function publish(frozen?: PublishRequest) {
    if (!canImport || busy || !job || !preview && !frozen) return;
    const needsAcknowledgement = !!preview && (preview.requires_quarantine_confirmation || preview.quarantine_count > 0 || preview.warning_count > 0);
    if (!frozen && (!preview!.can_publish || needsAcknowledgement && !acknowledged)) return;
    if (!frozen && !window.confirm('Concluir a importação de ' + modeLabel(mode).toLowerCase() + ' do arquivo “' + job.source_name + '”?\n\n' + count(preview!.eligible_count) + ' registros aproveitáveis; ' + count(preview!.quarantine_count) + ' pendências para conferência.\n\nAlterações manuais serão preservadas. O arquivo complementa a Cobrança e não cria títulos nem confirma recebimentos.')) return;
    const current = generation.current;
    let request: PublishRequest = frozen ?? { action: 'publish', job_id: job.job_id, previous_financial_revision: preview!.financial_revision, confirm_quarantine: !!(acknowledged || !needsAcknowledgement), request_id: crypto.randomUUID() };
    setPhase('publish'); clearMessages();
    try {
      let previousProcessed = -1, previousRemaining = Number.POSITIVE_INFINITY;
      for (;;) {
        pendingRequest.current = request; setPending(request);
        const result = await referenceRequest<PublishResult>({ ...request }); assertPublish(result, request.job_id);
        if (current !== generation.current) return; setPublishProgress(result.processed_rows);
        if (result.done) {
          pendingRequest.current = null; setPending(null); setPreview(null); setAcknowledged(false); setJob(previous => previous ? { ...previous, status: 'PUBLISHED' } : previous); setFile(null); if (input.current) input.current.value = '';
          setSuccess('Importação concluída: ' + count(result.published_rows) + ' registros incluídos, ' + count(result.skipped_manual_rows) + ' alterações manuais preservadas e ' + count(result.quarantined_rows) + ' pendências mantidas para conferência.'); setHistoryRevision(value => value + 1); break;
        }
        if (result.processed_rows <= previousProcessed || result.remaining_rows >= previousRemaining || result.remaining_rows === 0) throw new Error('unknown_publication_progress');
        previousProcessed = result.processed_rows; previousRemaining = result.remaining_rows;
        request = { ...request, request_id: crypto.randomUUID() };
      }
    } catch (failure) {
      if (current !== generation.current) return;
      if (knownFailure(failure)) { pendingRequest.current = null; setPending(null); setPreview(null); setAcknowledged(false); }
      showFailure(failure, 'A confirmação ainda não chegou. O arquivo e a conferência foram preservados. Confira o mesmo envio antes de iniciar outra importação.', 'publish');
      setHistoryRevision(value => value + 1);
    } finally { if (current === generation.current) setPhase(null); }
  }
  if (!canImport) return <p className="notice">Seu acesso não permite importar contatos e descrições.</p>;
  const needsAck = !!preview && (preview.requires_quarantine_confirmation || preview.quarantine_count > 0 || preview.warning_count > 0);
  return <div className="collection-reference-import">
    <section className="panel" aria-labelledby="collection-reference-title"><div className="panel-header"><div><h2 id="collection-reference-title">Contatos e descrições da Cobrança</h2><p className="muted">Inclua os arquivos de apoio e mantenha os dados disponíveis na carteira autorizada.</p></div></div>
      <div className="collection-reference-modes" role="group" aria-label="Arquivo de apoio da Cobrança"><button type="button" className="collection-reference-mode" disabled={locked} aria-pressed={mode === 'contacts'} onClick={() => changeMode('contacts')}><strong>Contatos dos clientes</strong><span>E-mails e telefones para o atendimento. Campos ausentes permanecem vazios; números não são marcados como WhatsApp automaticamente.</span></button><button type="button" className="collection-reference-mode" disabled={locked} aria-pressed={mode === 'descriptions'} onClick={() => changeMode('descriptions')}><strong>Descrições dos títulos</strong><span>Contexto do documento, contrato e descrição para consultar durante a cobrança.</span></button></div>
      {mode === 'descriptions' ? <div className="collection-reference-sequence"><strong>Primeiro: importe os abertos e vencidos de Contas a Receber.</strong><p>Depois, envie as descrições. O arquivo pode conter títulos vencidos e a vencer; a informação aparece somente na Cobrança quando o título estiver vencido. Títulos quitados não recebem um vínculo ativo. As descrições não são exibidas em Contas a Receber ou Comissões.</p></div> : <p className="collection-reference-sequence">Os contatos são agrupados pelo cliente identificado. Linhas sem identificação e endereços a conferir permanecem pendentes. Inclusões, correções e exclusões manuais são preservadas nas novas importações.</p>}
      <form onSubmit={event => void analyze(event)}><label className="field collection-reference-file" htmlFor="collection-reference-file">{mode === 'contacts' ? 'Arquivo de contatos dos clientes' : 'Arquivo de descrições dos títulos'}<input ref={input} id="collection-reference-file" type="file" accept=".xlsx,.xlsm" disabled={locked} onChange={event => { if (locked) return; reset(); setFile(event.target.files?.[0] ?? null); }} /></label><p className="help-text">Arquivos .xlsx ou .xlsm de até 16 MB. Aguarde a preparação de arquivos grandes; você pode interromper e continuar com o mesmo arquivo.</p>
        {(file || job) && <p className="collection-reference-file-meta"><strong>{file?.name ?? job?.source_name}</strong><span>{sizeLabel(file?.size ?? job!.source_size)}</span>{job && <span>{statuses[job.status]}</span>}</p>}
        <div className="collection-reference-controls"><button type="submit" className="button" disabled={!file || locked}>Preparar e conferir arquivo</button>{preparing && <button type="button" className="button secondary" disabled={canceling} onClick={cancelPreparation}>{canceling ? 'Interrompendo após a etapa atual…' : 'Interromper preparação'}</button>}{job && !preview && !locked && ['PREPARED', 'PUBLISHING'].includes(job.status) && <button type="button" className="button secondary" onClick={() => void reanalyze()}>Reanalisar arquivo preparado</button>}</div>
      </form>
      {phase && <div className="collection-reference-progress" aria-live="polite"><div className="collection-reference-progress-header"><strong>{phaseLabels[phase]}</strong><span>{canceling ? 'A etapa em andamento será preservada.' : modeLabel(mode)}</span></div><progress aria-label="Progresso da preparação" /><p>{phase === 'publish' ? publishProgress ? count(publishProgress) + ' registros conferidos para conclusão.' : 'Aguarde a confirmação da conclusão. Você poderá conferir o mesmo envio se a conexão for interrompida.' : count(preparedRows) + ' linhas recebidas · ' + count(preparedChunks) + ' lotes confirmados'}</p></div>}
      {error && <div className="notice error" role="alert"><p>{error}</p>{errorReference && <p className="help-text">Código para suporte: <code style={{ overflowWrap: 'anywhere' }}>{errorReference}</code></p>}</div>}{notice && <p className="notice" role="status">{notice}</p>}{success && <p className="notice success" role="status">{success}</p>}
      {pending && !busy && <div className="notice collection-reference-pending"><p>A confirmação deste arquivo está pendente. O mesmo envio será conferido sem criar uma segunda importação.</p><button type="button" className="button secondary" onClick={() => void publish(pending)}>Conferir confirmação pendente</button></div>}
      <p className="collection-reference-privacy"><span aria-hidden="true">●</span><span>O original e as pendências ficam protegidos na Central. Cada cobradora consulta apenas os contatos e as informações permitidos em sua carteira.</span></p>
    </section>
    {preview && <section className="panel collection-reference-preview" aria-labelledby="collection-reference-preview-title"><div className="panel-header"><div><h3 id="collection-reference-preview-title">Conferência antes de concluir</h3><p className="muted">{preview.source.name} · {sizeLabel(preview.source.size)} · {modeLabel(mode)}</p></div><button type="button" className="button secondary" disabled={locked} onClick={() => void reanalyze()}>Atualizar conferência</button></div>
      <div className="collection-reference-stats"><div className="collection-reference-stat"><span>Registros recebidos</span><strong>{count(preview.row_count)}</strong></div><div className="collection-reference-stat"><span>Registros aproveitáveis</span><strong>{count(preview.eligible_count)}</strong></div><div className="collection-reference-stat"><span>Repetições agrupadas</span><strong>{count(preview.deduplicated_count)}</strong></div><div className="collection-reference-stat is-pending"><span>Pendências para conferência</span><strong>{count(preview.quarantine_count)}</strong></div></div>
      {stats && <p className="collection-reference-preview-note">Leitura do arquivo: {count(stats.nonblank_rows)} linhas preenchidas · {count(stats.duplicate_rows)} repetições idênticas identificadas.</p>}
      <div className="collection-reference-coverage"><div><h4>{mode === 'contacts' ? 'Clientes e contatos' : 'Cobertura dos títulos'}</h4><p>{count(preview.matched_title_count)} vínculos encontrados · {count(preview.unmatched_count)} sem vínculo · {count(preview.paid_only_count)} referências apenas a títulos quitados.</p><p>{mode === 'contacts' ? 'E-mails e telefones válidos são mantidos separadamente. Contatos ausentes não são preenchidos com valores de exemplo.' : 'Os vínculos seguros consideram os títulos abertos já importados, vencidos e a vencer. O contexto fica guardado e aparece na Cobrança somente após o vencimento.'}</p></div><div><h4>Preservação e pendências</h4><p>{count(preview.manual_preserved_count)} alterações manuais preservadas · {count(preview.warning_count)} avisos de qualidade · {count(preview.ambiguous_count)} vínculos ambíguos · {count(preview.variant_count)} descrições divergentes.</p><p>Vínculos duvidosos permanecem pendentes. A Central não escolhe automaticamente a descrição mais recente e não cria títulos financeiros.</p></div></div>
      {!!preview.examples.length && <details><summary>Ver exemplos de linhas conferidas</summary><div className="table-wrap"><table className="data-table"><caption className="sr-only">Exemplos da conferência do arquivo de apoio</caption><thead><tr><th>Linha do arquivo</th><th>Resultado</th><th>Cliente / documento</th><th>Orientação</th></tr></thead><tbody>{preview.examples.map((row, index) => <tr key={row.source_line + ':' + index}><td>{row.source_line}</td><td>{outcomes[row.outcome]}</td><td>{row.client_name || 'Cliente não identificado'}{row.document ? ' · ' + row.document : ''}{row.branch ? ' · ' + row.branch : ''}</td><td>{row.problem || 'Conferido'}</td></tr>)}</tbody></table></div></details>}
      {needsAck && <label className="collection-reference-ack"><input type="checkbox" checked={acknowledged} disabled={locked} onChange={event => setAcknowledged(event.target.checked)} /><span>Revisei os avisos e as pendências. Estou ciente de que somente os registros seguros serão incluídos; os demais continuam preservados para conferência.</span></label>}
      {!preview.can_publish && <p className="notice">Este arquivo ainda precisa de conferência antes de concluir. Revise as pendências e atualize a análise.</p>}
      <button type="button" className="button" disabled={locked || !preview.can_publish || needsAck && !acknowledged} onClick={() => void publish()}>Concluir importação deste arquivo</button><p className="collection-reference-preview-note">A conclusão atualiza somente os dados de apoio seguros. Os valores, os pagamentos e o histórico financeiro são preservados.</p>
    </section>}
    <section className="panel collection-reference-history" aria-labelledby="collection-reference-history-title"><div className="panel-header"><div><h3 id="collection-reference-history-title">Histórico dos seus arquivos</h3><p className="muted">Preparações e conclusões ficam registradas para consulta e retomada.</p></div><button type="button" className="button secondary" disabled={historyLoading || locked} onClick={() => setHistoryRevision(value => value + 1)}>Atualizar histórico</button></div>
      {historyError && <div className="notice error" role="alert"><p>{historyError}</p>{historyErrorReference && <p className="help-text">Código para suporte: <code style={{ overflowWrap: 'anywhere' }}>{historyErrorReference}</code></p>}</div>}{historyLoading ? <p className="help-text">Consultando os arquivos…</p> : !history.rows.length ? <p className="help-text">Nenhum arquivo registrado neste acesso.</p> : <div className="table-wrap"><table className="data-table"><caption className="sr-only">Histórico privado de contatos e descrições</caption><thead><tr><th>Arquivo</th><th>Base</th><th>Registros preparados</th><th>Situação</th><th>Conferir</th></tr></thead><tbody>{history.rows.map(row => <tr key={row.job_id}><td><strong>{row.source_name}</strong><div>{sizeLabel(row.source_size)}{row.created_at ? ' · ' + dateLabel(row.created_at) : ''}</div></td><td>{modeLabel(row.mode)}</td><td>{count(row.staged_rows)}</td><td><span className={'collection-reference-status' + (row.status === 'PUBLISHED' ? '' : ' pending')}>{statuses[row.status]}</span></td><td><button type="button" className="button secondary" disabled={locked} onClick={() => void reanalyze(row)} aria-label={'Conferir arquivo ' + row.source_name}>Conferir</button></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
