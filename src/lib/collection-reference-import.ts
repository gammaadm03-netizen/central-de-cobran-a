import { REFERENCE_LIMITS, referenceSha256, type CollectionReferenceChunk, type CollectionReferenceMode, type CollectionReferenceProgress, type CollectionReferenceStats } from './collection-reference-parser.mjs';
export type { CollectionReferenceChunk, CollectionReferenceMode, CollectionReferenceProgress, CollectionReferenceStats } from './collection-reference-parser.mjs';

const canceled = () => new DOMException('Importação cancelada.', 'AbortError');
function validateFile(file: File) {
  if (!(file instanceof File) || !file.size || file.size > REFERENCE_LIMITS.fileBytes) throw new Error('Selecione um arquivo de apoio com até 16 MiB.');
  if (!/\.(?:xlsx|xlsm)$/i.test(file.name)) throw new Error('Salve uma cópia do arquivo de apoio em .xlsx ou .xlsm.');
}
export async function hashCollectionReferenceFile(file: File, signal?: AbortSignal): Promise<string> {
  validateFile(file); if (signal?.aborted) throw canceled();
  const bytes = new Uint8Array(await file.arrayBuffer()); if (signal?.aborted) throw canceled();
  const hash = await referenceSha256(bytes); if (signal?.aborted) throw canceled(); return hash;
}

export async function analyzeCollectionReferenceFile(file: File, mode: CollectionReferenceMode, options: { signal?: AbortSignal; onChunk: (chunk: CollectionReferenceChunk) => Promise<void>; onProgress?: (progress: CollectionReferenceProgress) => void }): Promise<{ runId: string; sourceSha256: string; stats: CollectionReferenceStats }> {
  validateFile(file);
  if (!['contacts', 'descriptions'].includes(mode)) throw new Error('Tipo de referência inválido.');
  if (options.signal?.aborted) throw canceled();
  const runId = crypto.randomUUID(), buffer = await file.arrayBuffer();
  if (options.signal?.aborted) throw canceled();
  const worker = new Worker(new URL('../workers/collection-reference.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    let settled = false, sequence = 0, chunkPending = false;
    const finish = (error?: unknown, result?: { runId: string; sourceSha256: string; stats: CollectionReferenceStats }) => {
      if (settled) return; settled = true; options.signal?.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else if (result) resolve(result);
    };
    const abort = () => { worker.postMessage({ type: 'ABORT', runId }); finish(canceled()); };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(new Error('A leitura do arquivo foi interrompida. Confira o formato e tente novamente.'));
    worker.onmessageerror = () => finish(new Error('Não foi possível receber a análise do arquivo de apoio.'));
    worker.onmessage = (event: MessageEvent) => {
      if (settled || event.data?.runId !== runId) return;
      const message = event.data;
      if (message.type === 'ERROR') { finish(message.aborted ? canceled() : new Error(typeof message.message === 'string' ? message.message : 'Arquivo de apoio inválido.')); return; }
      if (message.type === 'PROGRESS') { try { options.onProgress?.(message.progress); } catch (failure) { finish(failure); } return; }
      if (message.type === 'DONE') {
        if (chunkPending || !/^[a-f0-9]{64}$/.test(message.sourceSha256) || message.stats?.chunk_count !== sequence) { finish(new Error('A análise do arquivo não foi concluída de forma consistente.')); return; }
        finish(undefined, { runId, sourceSha256: message.sourceSha256, stats: message.stats }); return;
      }
      if (message.type !== 'CHUNK') return;
      if (chunkPending || message.sequence !== sequence || !(message.csv instanceof ArrayBuffer) || !message.csv.byteLength || message.csv.byteLength > REFERENCE_LIMITS.chunkBytes || !Number.isInteger(message.rowCount) || message.rowCount < 1 || message.rowCount > REFERENCE_LIMITS.chunkRows || !/^[a-f0-9]{64}$/.test(message.sha256)) { finish(new Error('A sequência dos trechos do arquivo é inválida.')); return; }
      chunkPending = true;
      const chunk: CollectionReferenceChunk = { runId, sequence, csv: new Uint8Array(message.csv), sha256: message.sha256, rowCount: message.rowCount, firstSourceLine: message.firstSourceLine, lastSourceLine: message.lastSourceLine };
      void Promise.resolve().then(() => options.onChunk(chunk)).then(() => {
        if (settled) return; if (options.signal?.aborted) { abort(); return; }
        sequence++; chunkPending = false; worker.postMessage({ type: 'ACK', runId, sequence: chunk.sequence });
      }, failure => finish(failure));
    };
    if (options.signal?.aborted) { abort(); return; }
    worker.postMessage({ type: 'START', runId, mode, buffer }, [buffer]);
  });
}
