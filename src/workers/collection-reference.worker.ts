/// <reference lib="webworker" />
import { streamReferenceWorkbook, type CollectionReferenceMode } from '../lib/collection-reference-parser.mjs';

type Input = { type: 'START'; runId: string; mode: CollectionReferenceMode; buffer: ArrayBuffer } | { type: 'ACK'; runId: string; sequence: number } | { type: 'ABORT'; runId: string };
type Run = { runId: string; abort: AbortController; pending?: { sequence: number; resolve: () => void; reject: (error: Error) => void } };
let current: Run | null = null;

self.onmessage = (event: MessageEvent<Input>) => {
  const input = event.data;
  if (input.type === 'ACK') {
    if (current?.runId === input.runId && current.pending?.sequence === input.sequence) { const pending = current.pending; current.pending = undefined; pending.resolve(); }
    return;
  }
  if (input.type === 'ABORT') { if (current?.runId === input.runId) { current.abort.abort(); current.pending?.reject(new DOMException('Importação cancelada.', 'AbortError')); } return; }
  if (input.type !== 'START' || current || !/^[a-f0-9-]{36}$/i.test(input.runId) || !(input.buffer instanceof ArrayBuffer)) return;
  const state: Run = { runId: input.runId, abort: new AbortController() };
  current = state;
  void (async () => {
    try {
      const result = await streamReferenceWorkbook(new Uint8Array(input.buffer), input.mode, {
        signal: state.abort.signal,
        onProgress: progress => self.postMessage({ type: 'PROGRESS', runId: state.runId, progress }),
        onChunk: chunk => new Promise<void>((resolve, reject) => {
          // One transferred artifact remains outstanding until the parent has
          // durably staged it. No further worksheet rows are consumed meanwhile.
          state.pending = { sequence: chunk.sequence, resolve, reject };
          self.postMessage({ type: 'CHUNK', runId: state.runId, ...chunk, csv: chunk.csv.buffer }, [chunk.csv.buffer]);
        }),
      });
      self.postMessage({ type: 'DONE', runId: state.runId, ...result });
    } catch (failure) {
      self.postMessage({ type: 'ERROR', runId: state.runId, message: failure instanceof Error ? failure.message : 'Não foi possível ler o arquivo de apoio.', aborted: state.abort.signal.aborted });
    } finally { current = null; }
  })();
};
