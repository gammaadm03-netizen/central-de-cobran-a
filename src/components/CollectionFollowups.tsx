import { useEffect, useRef, useState } from 'react';
import { dateLabel, formatCents } from '../lib/payables';
import { INITIAL_COLLECTION_FILTERS, collectionDate, collectionError, collectionWorkflowReady, readCollectionWorkbench, workTime, type CollectionWorkbench } from '../lib/collection-workbench';
import type { CollectionSelection } from './CollectionOverview';
import '../collection-followups.css';

interface Props {
  isCollector: boolean; collectorId: string | null; canWrite: boolean; refreshKey?: number;
  onDetails: (selection: CollectionSelection) => void;
}
const activationMessage = 'A agenda de retornos aguarda a atualização da operação de cobrança. A consulta dos títulos permanece disponível.';

function validReturns(result: CollectionWorkbench, isCollector: boolean, collectorId: string | null) {
  const priority = result.priority;
  if (!collectionWorkflowReady(result.workflow) || !priority || result.rows.length > 5
    || priority.collector_id !== (isCollector ? collectorId : null)
    || priority.due_count !== result.count || priority.total_cents !== result.total_cents
    || result.rows.some(row => !row.return_due || !collectionDate(row.return_due_date) || row.return_due_date > result.as_of_date || !row.collector_id || !['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status))
    || result.count > 0 && (!result.rows.length || priority.next_title_id !== result.rows[0].id || priority.next_due_date !== result.rows[0].return_due_date)
    || result.count === 0 && (priority.next_title_id !== null || priority.next_due_date !== null)) throw new Error('invalid_returns');
}

export default function CollectionFollowups({ isCollector, collectorId, canWrite, refreshKey = 0, onDetails }: Props) {
  const [result, setResult] = useState<CollectionWorkbench | null>(null), [loading, setLoading] = useState(true), [message, setMessage] = useState('');
  const [focusRevision, setFocusRevision] = useState(0), [tick, setTick] = useState(0);
  const timerAnchor = useRef(0), lastFocus = useRef(0);
  useEffect(() => {
    lastFocus.current = performance.now();
    function refresh() {
      if (document.visibilityState === 'hidden' || performance.now() - lastFocus.current < 1500) return;
      lastFocus.current = performance.now(); setFocusRevision(value => value + 1);
    }
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setMessage(''); setResult(null);
    if (isCollector && !collectorId) { setLoading(false); return () => abort.abort(); }
    // Esta consulta não herda busca, situação, período ou carteira selecionados
    // na mesa de atendimento. O servidor determina a agenda e o escopo oficial.
    void readCollectionWorkbench({ ...INITIAL_COLLECTION_FILTERS, queue: 'returns', sort: 'next_date_asc' }, 0, 5, isCollector, collectorId, abort.signal).then(data => {
      if (abort.signal.aborted) return;
      if (!collectionWorkflowReady(data.workflow)) {
        setMessage(activationMessage); return;
      }
      validReturns(data, isCollector, collectorId); setResult(data);
    }).catch(error => {
      if (!abort.signal.aborted) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        setMessage(['22023', 'PGRST202', '42883'].includes(code) ? activationMessage : collectionError(error, 'Não foi possível consultar os retornos. Atualize a visão da cobrança para tentar novamente.'));
      }
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [isCollector, collectorId, refreshKey, focusRevision]);
  useEffect(() => {
    setTick(0); if (!result?.active_timer?.running) return;
    timerAnchor.current = performance.now();
    const interval = window.setInterval(() => setTick(Math.max(0, Math.floor((performance.now() - timerAnchor.current) / 1000))), 1000);
    return () => window.clearInterval(interval);
  }, [result?.active_timer]);
  const activeTimer = result?.active_timer, dueCount = result?.count ?? 0;
  return <section className={`collection-followups${dueCount ? ' collection-followups-due' : ''}`} aria-label="Agenda de retornos da cobrança" aria-busy={loading}>
    {activeTimer && <div className="collection-followups-timer"><p>Seu atendimento está em andamento <strong role="timer" aria-label="Tempo do atendimento em andamento" aria-live="off">{workTime(activeTimer.actor_total_seconds + tick)}</strong></p>{canWrite && <button type="button" className="button secondary" onClick={() => onDetails({ titleId: activeTimer.title_id, queue: 'active' })}>Retomar atendimento</button>}</div>}
    <div className="collection-followups-heading"><div><h2>Agenda de retornos</h2><p>{loading ? 'Consultando os retornos devidos…' : result ? dueCount ? <><strong>{dueCount.toLocaleString('pt-BR')} retorno(s) para atender</strong> até {dateLabel(result.as_of_date)} · {formatCents(result.total_cents)}</> : <>Nenhum retorno devido em {dateLabel(result.as_of_date)}.</> : 'Os retornos são consultados na base central.'}</p></div>{result && dueCount > 0 && <div className="collection-followups-actions"><button type="button" className="button" onClick={() => onDetails({ queue: 'returns' })}>Atender retornos</button></div>}</div>
    {message && <p className="collection-followups-message" aria-live="polite">{message}</p>}
    {result && dueCount > 0 && <ul className="collection-followups-list">{result.rows.map(row => <li key={row.id}><div className="collection-followups-title"><strong>{row.client_name}</strong><span>{row.document} · {row.collector_name || 'Cobradora definida'} · {formatCents(row.amount_cents)}</span>{row.next_action_text && <p>{row.next_action_text}</p>}</div><span className="collection-followups-date">Retorno {dateLabel(row.return_due_date!)}</span><button type="button" className="button secondary" aria-label={`Abrir retorno ${row.document}`} onClick={() => onDetails({ titleId: row.id, queue: 'returns' })}>Abrir retorno</button></li>)}</ul>}
    {result && <p className="collection-followups-footer">{dueCount > 5 ? `Exibindo os primeiros 5 de ${dueCount.toLocaleString('pt-BR')} retornos. ` : ''}Agenda oficial de São Paulo, por carteira atribuída. Retornos futuros aparecem a partir da data marcada; pagamentos em validação ficam na fila financeira.</p>}
  </section>;
}
