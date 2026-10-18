import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import { collectionDateTime } from '../lib/collection-workbench';
import '../collection-secondary.css';

interface Title { id: string; document: string; client_name: string; branch: string; due_date: string; amount_cents: number; collector_id: string | null; payment_source: string | null; payment_reported_date: string | null; revision: number }
interface Agent { id: string; display_name: string }
interface Receipt { id: string; amount_cents: number; payment_date: string; validated_at: string }
interface PaymentReport { id: string; title_id: string; action: 'PAID'; collector_id: string | null; contact_date: string | null; observation: string | null; return_note: string | null; payment_date: string | null; created_at: string }
export interface CollectionValidationProps { canRead: boolean; canReadFinance?: boolean; canWrite: boolean; canValidate: boolean; isCollector?: boolean; collectorId?: string | null; onChange?: () => void; refreshKey?: number }
const fields = 'id,document,client_name,branch,due_date,amount_cents,collector_id,payment_source,payment_reported_date,revision';
function message(error: unknown, fallback: string) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === '40001') return 'Este título mudou. Atualize a fila e confira novamente antes de validar.';
  if (code === '42501') return 'Seu perfil não permite esta consulta ou validação financeira.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (['PGRST202', 'PGRST205', '42P01', '42703'].includes(code)) return 'A fila de validação precisa da atualização do banco. Procure a administração.';
  if (code === '23514' || code === '22023') return 'Confira a situação do título, a data real e a justificativa. Nenhum recebimento foi confirmado.';
  return fallback;
}

export default function CollectionValidation({ canRead, canReadFinance = false, canWrite, canValidate, isCollector = false, collectorId = null, onChange, refreshKey = 0 }: CollectionValidationProps) {
  const [collector, setCollector] = useState(''), [agents, setAgents] = useState<Agent[]>([]);
  const [rows, setRows] = useState<Title[]>([]), [count, setCount] = useState(0), [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Title | null>(null);
  const allowed = canRead && (canReadFinance || isCollector && !!collectorId);
  useEffect(() => {
    if (!allowed || !supabase) return;
    const abort = new AbortController();
    void Promise.resolve(supabase.from('collection_agents').select('id,display_name').order('display_name').abortSignal(abort.signal)).then(result => { if (!abort.signal.aborted && !result.error) setAgents((result.data ?? []) as Agent[]); });
    return () => abort.abort();
  }, [allowed]);
  useEffect(() => {
    if (!allowed) { setRows([]); setCount(0); return; }
    const client = supabase, abort = new AbortController(); setLoading(true); setError(''); setRows([]); setSelected(null);
    if (!client) { setLoading(false); setError('Sua sessão expirou. Entre novamente.'); return; }
    let query = client.from(canReadFinance ? 'receivable_titles' : 'collection_overdue_titles').select(fields, { count: 'exact' }).eq('scope', 'grupo-consolidado').eq('status', 'PENDING_VALIDATION').eq('validation_status', 'PENDING').order('due_date').order('id').range(page * 25, page * 25 + 24);
    if (!canReadFinance) query = query.eq('collector_id', collectorId!);
    else if (collector === 'unassigned') query = query.is('collector_id', null);
    else if (collector) query = query.eq('collector_id', collector);
    void Promise.resolve(query.abortSignal(abort.signal)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      const total = result.count ?? 0, last = Math.max(0, Math.ceil(total / 25) - 1); setCount(total);
      if (page > last) setPage(last); else setRows((result.data ?? []) as unknown as Title[]);
    }).catch(failure => { if (!abort.signal.aborted) { setCount(0); setError(message(failure, 'Não foi possível carregar a fila de validação. Atualize e tente novamente.')); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [allowed, canReadFinance, collectorId, collector, page, refresh, refreshKey]);
  if (!canRead) return <p className="notice">Seu perfil não permite consultar a fila de validação.</p>;
  if (!allowed) return <p className="notice">A consulta depende do vínculo com sua carteira ou da permissão de Contas a Receber. Procure a Gerência Geral.</p>;
  function completed(text: string) { setNotice(text); setSelected(null); setRefresh(value => value + 1); onChange?.(); }
  return <section className="panel collection-secondary collection-validation" aria-labelledby="collection-validation-title">
    <div className="panel-header"><div><h2 id="collection-validation-title">Validação financeira</h2><p className="muted">Confira a entrada real antes de confirmar. Pagamento informado pela cobrança permanece pendente até a validação financeira.</p></div><button type="button" className="button secondary" disabled={loading} onClick={() => { setNotice(''); setRefresh(value => value + 1); }}>Atualizar fila</button></div>
    {(!canReadFinance || !canValidate) && <p className="notice">Consulta em leitura. Somente um acesso autorizado do financeiro pode confirmar ou devolver pagamentos.</p>}
    {error && <p className="notice error" role="alert">{error}</p>}{notice && <p className="notice success" role="status">{notice}</p>}
    {canReadFinance && <label className="field collection-secondary-filter">Responsável pela carteira<select value={collector} onChange={event => { setCollector(event.target.value); setPage(0); }}><option value="">Todas as responsáveis</option><option value="unassigned">Sem responsável definida</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}</select></label>}
    <div className="table-wrap" aria-busy={loading}><table className="data-table"><caption>Pagamentos aguardando validação financeira</caption><thead><tr><th>Cliente / NF</th><th>Responsável</th><th>Vencimento</th><th>Valor original</th><th>Pagamento informado</th><th>Origem</th><th>Conferência</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="empty-state">Carregando fila…</td></tr> : rows.length ? rows.map(row => <tr key={row.id}><td><strong>{row.client_name}</strong><div>{row.document} · Filial {row.branch}</div></td><td>{agents.find(agent => agent.id === row.collector_id)?.display_name ?? (row.collector_id ? 'Responsável atribuída' : 'Sem responsável definida')}</td><td>{dateLabel(row.due_date)}</td><td>{formatCents(row.amount_cents)}</td><td>{dateLabel(row.payment_reported_date)}</td><td>{row.payment_source === 'COBRANCA' ? 'Cobrança' : row.payment_source === 'IMPORTACAO_DIARIA' ? 'Importação diária' : 'Origem pendente'}</td><td><button type="button" className="button secondary" onClick={() => { setSelected(row); setNotice(''); }}>Conferir {row.document}</button></td></tr>) : <tr><td colSpan={7} className="empty-state">{error ? 'Fila indisponível.' : 'Nenhum pagamento pendente para este filtro.'}</td></tr>}</tbody></table></div>
    <div className="pagination"><span>{count.toLocaleString('pt-BR')} pendentes · página {page + 1} de {Math.max(1, Math.ceil(count / 25))}</span><button type="button" className="button secondary" disabled={loading || !page} onClick={() => setPage(value => value - 1)}>Página anterior da fila</button><button type="button" className="button secondary" disabled={loading || (page + 1) * 25 >= count} onClick={() => setPage(value => value + 1)}>Próxima página da fila</button></div>
    {selected && <ValidationDetail key={`${selected.id}:${selected.revision}`} row={selected} agents={agents} canWrite={canReadFinance && canWrite} canValidate={canReadFinance && canValidate} onClose={() => setSelected(null)} onCompleted={completed} />}
  </section>;
}

function ValidationDetail({ row, agents, canWrite, canValidate, onClose, onCompleted }: { row: Title; agents: Agent[]; canWrite: boolean; canValidate: boolean; onClose: () => void; onCompleted: (text: string) => void }) {
  const [date, setDate] = useState(row.payment_reported_date ?? ''), [decision, setDecision] = useState('CONFIRM'), [observation, setObservation] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [readReady, setReadReady] = useState(false), [receipts, setReceipts] = useState<Receipt[]>([]), [error, setError] = useState('');
  const [report, setReport] = useState<PaymentReport | null>(null);
  useEffect(() => {
    const client = supabase, abort = new AbortController();
    if (!client) { setLoading(false); setError('Sua sessão expirou. Entre novamente.'); return; }
    const readReceipts = async () => {
      const columns = 'id,amount_cents,payment_date,validated_at';
      let result = await client.from('effective_receivable_receipts').select(columns).eq('title_id', row.id).limit(1).abortSignal(abort.signal);
      if (result.error && ['PGRST205', '42P01'].includes(result.error.code)) result = await client.from('receivable_receipts').select(columns).eq('title_id', row.id).limit(1).abortSignal(abort.signal);
      if (result.error) throw result.error;
      return (result.data ?? []) as unknown as Receipt[];
    };
    const readReport = async (): Promise<PaymentReport | null> => {
      if (row.payment_source !== 'COBRANCA') return null;
      const result = await client.from('receivable_collection_events').select('id,title_id,action,collector_id,contact_date,observation,return_note,payment_date,created_at').eq('title_id', row.id).eq('action', 'PAID').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).abortSignal(abort.signal);
      if (result.error) throw result.error;
      if (!Array.isArray(result.data) || result.data.length > 1) throw new Error('invalid_payment_report');
      const found = result.data[0] as PaymentReport | undefined;
      const nullableText = (value: unknown) => value === null || typeof value === 'string';
      if (found && (found.title_id !== row.id || found.action !== 'PAID' || typeof found.id !== 'string' || !found.id
        || !nullableText(found.collector_id) || !nullableText(found.contact_date) || !nullableText(found.payment_date)
        || !nullableText(found.observation) || !nullableText(found.return_note) || typeof found.created_at !== 'string' || !Number.isFinite(Date.parse(found.created_at)))) throw new Error('invalid_payment_report');
      return found ?? null;
    };
    void Promise.allSettled([readReceipts(), readReport()]).then(results => {
      if (abort.signal.aborted) return;
      const [receiptResult, reportResult] = results;
      if (receiptResult.status === 'fulfilled') setReceipts(receiptResult.value);
      if (reportResult.status === 'fulfilled') setReport(reportResult.value);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') { setReadReady(false); setError(message(failed.reason, 'Não foi possível conferir os recebimentos ou o relato original da cobrança. Atualize a fila.')); return; }
      setReadReady(true);
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [row.id, row.payment_source]);
  function validDate() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '1900-01-01' || date > '2199-12-31') return false;
    const parsed = new Date(`${date}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }
  async function saveDate() {
    if (!canWrite || busy || loading || !readReady || error || receipts.length || row.payment_source !== 'IMPORTACAO_DIARIA') return;
    if (!validDate()) { setError('Informe a data real do pagamento, até hoje. O vencimento não comprova o recebimento.'); return; }
    if (!window.confirm(`Registrar a data real ${dateLabel(date)} para o título ${row.document}? Isso mantém o recebimento pendente de validação.`)) return;
    setBusy(true); setError('');
    try { const result = await supabase!.rpc('set_receivable_payment_date', { p_title_id: row.id, p_payment_date: date, p_expected_revision: row.revision }); if (result.error) throw result.error; onCompleted('Data real registrada. O recebimento continua aguardando validação financeira.'); }
    catch (failure) { setError(message(failure, 'Não foi possível confirmar a gravação da data. Atualize a fila antes de repetir.')); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canValidate || busy || loading || !readReady || receipts.length) return;
    setError(''); const confirm = decision === 'CONFIRM';
    if (confirm && !validDate()) { setError('Informe a data real do pagamento, até hoje. O vencimento não comprova o recebimento.'); return; }
    if (!confirm && (!row.collector_id || !observation.trim())) { setError('Informe a justificativa. A devolução exige a mesma responsável já atribuída.'); return; }
    if (!window.confirm(confirm ? `Confirmar financeiramente ${formatCents(row.amount_cents)} do título ${row.document}, recebido em ${dateLabel(date)}? Confira a entrada bancária; o título sairá da carteira ativa.` : `Devolver o título ${row.document} à mesma responsável para cobrar novamente? Nenhum recebimento ou comissão será confirmado.`)) return;
    setBusy(true);
    try {
      const result = await supabase!.rpc('validate_receivable_payment', { p_title_id: row.id, p_decision: decision, p_payment_date: confirm ? date : null, p_observation: observation.trim(), p_expected_revision: row.revision });
      if (result.error) throw result.error;
      onCompleted(confirm ? 'Recebimento validado. O título saiu da carteira ativa e seu histórico foi preservado.' : 'Pagamento não localizado. Título devolvido à mesma responsável, sem recebimento confirmado.');
    } catch (failure) { setError(message(failure, 'Não foi possível confirmar a validação. Atualize a fila e confira o título antes de repetir.')); }
    finally { setBusy(false); }
  }
  return <section className="collection-validation-detail" aria-label={`Conferência financeira de ${row.document}`}><div className="panel-header"><h3>Conferência de {row.document}</h3><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Fechar conferência</button></div>
    <p>{row.client_name} · Valor original {formatCents(row.amount_cents)} · Vencimento {dateLabel(row.due_date)}</p>
    {row.payment_source === 'COBRANCA' && <section className="notice" aria-label="Relato original da cobrança"><strong>Relato original da cobrança</strong>{loading ? <p>Consultando o relato registrado…</p> : report ? <>
      <p><strong>Pagamento informado pela cobradora:</strong> {dateLabel(report.payment_date)}<br /><strong>Registrado em:</strong> {collectionDateTime(report.created_at)}<br /><strong>Responsável pelo relato:</strong> {agents.find(agent => agent.id === report.collector_id)?.display_name || 'Responsável registrada na cobrança'}</p>
      <p><strong>Observação da cobradora:</strong></p><p style={{ whiteSpace: 'pre-wrap' }}>{report.observation || 'Não informada.'}</p>{report.return_note && <p style={{ whiteSpace: 'pre-wrap' }}>{report.return_note}</p>}
    </> : <p>{readReady ? 'Não há relato de pagamento da cobrança disponível para este título.' : 'O relato original ainda não pôde ser conferido. Atualize a fila.'}</p>}<p className="help-text">O relato é preservado no histórico. Confirme a entrada bancária e informe abaixo a data real do recebimento.</p></section>}
    {loading && <p className="help-text" role="status">Conferindo recebimentos registrados…</p>}{error && <p className="notice error" role="alert">{error}</p>}
    {receipts.map(receipt => <p className="notice" key={receipt.id}>Já existe recebimento validado: {formatCents(receipt.amount_cents)} em {dateLabel(receipt.payment_date)}. Atualize a fila antes de qualquer nova conferência.</p>)}
    {!canWrite && !canValidate ? <p className="notice">Pagamento informado em {dateLabel(row.payment_reported_date)}. Este acesso permite somente consulta.</p> : <form onSubmit={event => void submit(event)}><fieldset disabled={busy || loading || !readReady || receipts.length > 0}>{!row.collector_id && <p className="notice">Este título está sem responsável definida. Para devolver à cobrança, atribua uma cobradora nos detalhes do título em Contas a Receber.</p>}<div className="form-grid">
      <label className="field">Data real do recebimento<input type="date" min="1900-01-01" max="2199-12-31" value={date} onChange={event => { setDate(event.target.value); setError(''); }} /></label>
      {canValidate && <label className="field">Decisão da validação<select value={decision} onChange={event => { setDecision(event.target.value); setError(''); }}><option value="CONFIRM">Confirmar recebimento</option><option value="NOT_LOCATED" disabled={!row.collector_id}>Não localizado — cobrar novamente</option></select></label>}
      {canValidate && <label className="field">Justificativa / observação da validação<textarea value={observation} maxLength={5000} onChange={event => setObservation(event.target.value)} required={decision === 'NOT_LOCATED'} /></label>}
    </div><p className="help-text">A data informada é a data real da entrada bancária. O vencimento e o valor original não são alterados por esta conferência.</p>
    <div className="inline-actions">{canWrite && row.payment_source === 'IMPORTACAO_DIARIA' && <button type="button" className="button secondary" onClick={() => void saveDate()}>Salvar data real sem validar</button>}{canValidate && <button type="submit" className="button">{busy ? 'Processando validação…' : decision === 'CONFIRM' ? 'Confirmar recebimento financeiro' : 'Devolver à mesma responsável'}</button>}</div></fieldset></form>}
  </section>;
}
