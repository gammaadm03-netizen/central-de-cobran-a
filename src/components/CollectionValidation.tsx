import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import { collectionDateTime } from '../lib/collection-workbench';
import { parseMoneyCents } from '../lib/payables-parser.mjs';
import '../collection-secondary.css';

interface Title { id: string; scope: string; document: string; client_name: string; branch: string; due_date: string; amount_cents: number; collector_id: string | null; payment_source: string | null; payment_reported_date: string | null; revision: number; status: string; validation_status: string; retired_from_report: boolean; collection_worked?: boolean }
interface Agent { id: string; display_name: string }
interface Receipt { id: string; title_id: string; amount_cents: number; payment_date: string; validated_at: string }
interface PaymentReport { id: string; title_id: string; action: 'PAID'; collector_id: string | null; contact_date: string | null; observation: string | null; return_note: string | null; payment_date: string | null; created_at: string }
interface ValidationRequest { p_title_id: string; p_decision: 'CONFIRM' | 'NOT_LOCATED'; p_payment_date: string | null; p_received_cents: number | null; p_adjustment_reason: string | null; p_observation: string; p_expected_revision: number; p_request_id: string }
interface ValidationResult { format_version: '053' | '055'; request_id: string; title_id: string; decision: ValidationRequest['p_decision']; receipt_id: string | null; payment_date: string | null; nominal_cents: number; received_cents: number | null; adjustment_cents: number | null; adjustment_reason: string | null; title_revision: number }
export interface CollectionValidationProps { canRead: boolean; canReadFinance?: boolean; canWrite: boolean; canValidate: boolean; isCollector?: boolean; collectorId?: string | null; onChange?: () => void; refreshKey?: number }
const fields = 'id,scope,document,client_name,branch,due_date,amount_cents,collector_id,payment_source,payment_reported_date,revision,status,validation_status,retired_from_report';
const retiredMessage = 'O título está retirado do relatório completo. Para confirmar seu recebimento nesta tela, ative o SQL 055 e abra a fila de títulos retirados. A devolução à cobrança depende de o título reaparecer no relatório de abertos.';
const changedMessage = 'Este título mudou. Atualize a fila e confira novamente antes de validar.';
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
function validResult(value: unknown, request: ValidationRequest, nominal: number, retired: boolean): value is ValidationResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as ValidationResult;
  if (!(result.format_version === '055' || !retired && result.format_version === '053') || result.request_id !== request.p_request_id || result.title_id !== request.p_title_id || result.decision !== request.p_decision
    || result.nominal_cents !== nominal || !Number.isSafeInteger(result.title_revision) || result.title_revision <= request.p_expected_revision) return false;
  return request.p_decision === 'CONFIRM'
    ? typeof result.receipt_id === 'string' && uuid.test(result.receipt_id) && result.payment_date === request.p_payment_date
      && result.received_cents === request.p_received_cents && result.adjustment_cents === nominal - request.p_received_cents!
      && result.adjustment_reason === request.p_adjustment_reason
    : result.receipt_id === null && result.payment_date === null && result.received_cents === null && result.adjustment_cents === null && result.adjustment_reason === null;
}
function enteredCents(value: string) { try { return parseMoneyCents(value); } catch { return null; } }
function civilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2199-12-31') return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validTitle(value: unknown): value is Title {
  if (!value || typeof value !== 'object') return false;
  const row = value as Title;
  return typeof row.id === 'string' && !!row.id && row.scope === 'grupo-consolidado'
    && ['document', 'client_name', 'branch'].every(key => typeof row[key as keyof Title] === 'string')
    && civilDate(row.due_date) && Number.isSafeInteger(row.amount_cents) && row.amount_cents >= 0
    && (row.collector_id === null || typeof row.collector_id === 'string')
    && (row.payment_source === null || ['COBRANCA', 'IMPORTACAO_DIARIA'].includes(row.payment_source))
    && (row.payment_reported_date === null || civilDate(row.payment_reported_date))
    && Number.isSafeInteger(row.revision) && row.revision >= 1 && typeof row.retired_from_report === 'boolean'
    && ['NEW', 'OPEN', 'PENDING_VALIDATION', 'NOT_LOCATED', 'VALIDATED'].includes(row.status)
    && ['NONE', 'PENDING', 'VALIDATED'].includes(row.validation_status);
}
function pendingTitle(row: Title, verifiedRetired = false) {
  return row.retired_from_report
    ? verifiedRetired && ['NEW', 'OPEN', 'NOT_LOCATED', 'PENDING_VALIDATION'].includes(row.status) && ['NONE', 'PENDING'].includes(row.validation_status)
    : row.status === 'PENDING_VALIDATION' && row.validation_status === 'PENDING';
}
function stateMessage(current: Title | null, expected: Title, receipts: Receipt[]) {
  if (!current) return 'Título indisponível nesta consulta. Atualize a fila e confira seu acesso antes de continuar.';
  if (receipts.length || current.status === 'VALIDATED' || current.validation_status === 'VALIDATED') return 'Já existe recebimento validado para este título. Atualize a fila; uma segunda confirmação não será enviada.';
  if (current.retired_from_report !== expected.retired_from_report) return changedMessage;
  if (!pendingTitle(current, expected.collection_worked === true) || !current.retired_from_report && current.payment_source === null) return 'Este título não está mais pendente de validação financeira. Atualize a fila antes de continuar.';
  if (current.revision !== expected.revision || current.amount_cents !== expected.amount_cents || current.due_date !== expected.due_date
    || current.collector_id !== expected.collector_id || current.payment_source !== expected.payment_source) return changedMessage;
  return '';
}
function message(error: unknown, fallback: string) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === '40001') return changedMessage;
  if (code === 'PV001') return retiredMessage;
  if (code === 'PV002') return 'Este título não está mais pendente de validação financeira. Atualize a fila antes de continuar.';
  if (code === 'PV003') return 'Já existe recebimento validado para este título. Atualize a fila antes de continuar.';
  if (code === 'PV004') return 'Informe a data real do recebimento, até hoje.';
  if (code === 'PV005') return 'Informe o valor efetivamente recebido, positivo e até o valor original do título.';
  if (code === 'PV006') return 'Informe a justificativa do desconto ou da retenção antes de confirmar.';
  if (code === '42501') return 'Seu perfil não permite esta consulta ou validação financeira.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (['PGRST202', 'PGRST205', '42P01', '42703', '42883'].includes(code)) return 'Ative o SQL 053 de validação financeira e o complemento SQL 055 no banco de dados antes de continuar.';
  if (code === '23514' || code === '22023') return 'Confira a situação do título, a data real e a justificativa. Nenhum recebimento foi confirmado.';
  return fallback;
}

export default function CollectionValidation({ canRead, canReadFinance = false, canWrite, canValidate, isCollector = false, collectorId = null, onChange, refreshKey = 0 }: CollectionValidationProps) {
  const [collector, setCollector] = useState(''), [agents, setAgents] = useState<Agent[]>([]);
  const [rows, setRows] = useState<Title[]>([]), [count, setCount] = useState(0), [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Title | null>(null);
  const [openSequence, setOpenSequence] = useState(0);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const [pendingValidation, setPendingValidation] = useState(false);
  function lockValidation(pending: boolean) { setPendingValidation(pending); window.dispatchEvent(new CustomEvent('receivable-validation-pending', { detail: pending })); }
  useEffect(() => () => { window.dispatchEvent(new CustomEvent('receivable-validation-pending', { detail: false })); }, []);
  const allowed = canRead && (canReadFinance || isCollector && !!collectorId);
  useEffect(() => {
    if (!allowed || !supabase) return;
    const abort = new AbortController();
    void Promise.resolve(supabase.from('collection_agents').select('id,display_name').order('display_name').abortSignal(abort.signal)).then(result => { if (!abort.signal.aborted && !result.error) setAgents((result.data ?? []) as Agent[]); });
    return () => abort.abort();
  }, [allowed]);
  useEffect(() => {
    if (pendingValidation) return;
    if (!allowed) { setRows([]); setCount(0); return; }
    const client = supabase, abort = new AbortController(); setLoading(true); setError(''); setRows([]); setSelected(null);
    if (!client) { setLoading(false); setError('Sua sessão expirou. Entre novamente.'); return; }
    let query = client.from(canReadFinance ? 'receivable_titles' : 'collection_overdue_titles').select(fields, { count: 'exact' }).eq('scope', 'grupo-consolidado').eq('status', 'PENDING_VALIDATION').eq('validation_status', 'PENDING').eq('retired_from_report', false).order('due_date').order('id').range(page * 25, page * 25 + 24);
    if (!canReadFinance) query = query.eq('collector_id', collectorId!);
    else if (collector === 'unassigned') query = query.is('collector_id', null);
    else if (collector) query = query.eq('collector_id', collector);
    void Promise.resolve(query.abortSignal(abort.signal)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      if (!Array.isArray(result.data) || !result.data.every(validTitle) || result.data.some(row => !pendingTitle(row))) throw new Error('invalid_validation_queue');
      const total = result.count ?? 0, last = Math.max(0, Math.ceil(total / 25) - 1); setCount(total);
      if (page > last) setPage(last); else setRows((result.data ?? []) as unknown as Title[]);
    }).catch(failure => { if (!abort.signal.aborted) { setCount(0); setError(message(failure, 'Não foi possível carregar a fila de validação. Atualize e tente novamente.')); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [allowed, canReadFinance, collectorId, collector, page, refresh, refreshKey]);
  if (!canRead) return <p className="notice">Seu perfil não permite consultar a fila de validação.</p>;
  if (!allowed) return <p className="notice">A consulta depende do vínculo com sua carteira ou da permissão de Contas a Receber. Procure a Gerência Geral.</p>;
  function completed(text: string) { setNotice(text); setSelected(null); setRefresh(value => value + 1); onChange?.(); }
  function openDetail(row: Title, trigger: HTMLButtonElement) {
    selectedTrigger.current = trigger;
    setSelected(row); setNotice(''); setOpenSequence(value => value + 1);
  }
  function closeDetail() {
    setSelected(null);
    const trigger = selectedTrigger.current;
    if (trigger?.isConnected) { trigger.focus({ preventScroll: true }); trigger.scrollIntoView({ block: 'nearest' }); }
  }
  return <section className="panel collection-secondary collection-validation" aria-labelledby="collection-validation-title">
    <div className="panel-header"><div><h2 id="collection-validation-title">Validação financeira</h2><p className="muted">Confira a entrada real antes de confirmar. Pagamento informado pela cobrança permanece pendente até a validação financeira.</p></div><button type="button" className="button secondary" disabled={loading || pendingValidation} onClick={() => { setNotice(''); setRefresh(value => value + 1); }}>Atualizar fila</button></div>
    {(!canReadFinance || !canValidate) && <p className="notice">Consulta em leitura. Somente um acesso autorizado do financeiro pode confirmar ou devolver pagamentos.</p>}
    {error && <p className="notice error" role="alert">{error}</p>}{notice && <p className="notice success" role="status">{notice}</p>}
    {canReadFinance && <label className="field collection-secondary-filter">Responsável pela carteira<select aria-label="Responsável pela carteira" value={collector} disabled={pendingValidation} onChange={event => { setCollector(event.target.value); setPage(0); }}><option value="">Todas as responsáveis</option><option value="unassigned">Sem responsável definida</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}</select></label>}
    <div className="table-wrap" aria-busy={loading}><table className="data-table"><caption>Pagamentos aguardando validação financeira</caption><thead><tr><th>Cliente / NF</th><th>Responsável</th><th>Vencimento</th><th>Valor original</th><th>Pagamento informado</th><th>Origem</th><th>Conferência</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="empty-state">Carregando fila…</td></tr> : rows.length ? rows.map(row => <tr key={row.id}><td><strong>{row.client_name}</strong><div>{row.document} · Filial {row.branch}</div></td><td>{agents.find(agent => agent.id === row.collector_id)?.display_name ?? (row.collector_id ? 'Responsável atribuída' : 'Sem responsável definida')}</td><td>{dateLabel(row.due_date)}</td><td>{formatCents(row.amount_cents)}</td><td>{dateLabel(row.payment_reported_date)}</td><td>{row.payment_source === 'COBRANCA' ? 'Cobrança' : row.payment_source === 'IMPORTACAO_DIARIA' ? 'Importação diária' : 'Origem pendente'}</td><td><button type="button" className="button secondary" disabled={pendingValidation} aria-expanded={selected?.id === row.id} aria-controls="collection-validation-detail" onClick={event => openDetail(row, event.currentTarget)}>Conferir {row.document}</button></td></tr>) : <tr><td colSpan={7} className="empty-state">{error ? 'Fila indisponível.' : 'Nenhum pagamento pendente para este filtro.'}</td></tr>}</tbody></table></div>
    <div className="pagination"><span>{count.toLocaleString('pt-BR')} pendentes · página {page + 1} de {Math.max(1, Math.ceil(count / 25))}</span><button type="button" className="button secondary" disabled={loading || pendingValidation || !page} onClick={() => setPage(value => value - 1)}>Página anterior da fila</button><button type="button" className="button secondary" disabled={loading || pendingValidation || (page + 1) * 25 >= count} onClick={() => setPage(value => value + 1)}>Próxima página da fila</button></div>
    {canReadFinance && <RetiredValidationQueue refreshKey={refresh + refreshKey} pending={pendingValidation} selectedId={selected?.id} onSelect={openDetail} />}
    {selected && <ValidationDetail key={`${selected.id}:${selected.revision}`} row={selected} openSequence={openSequence} agents={agents} canReadFinance={canReadFinance} collectorId={collectorId} canWrite={canReadFinance && canWrite} canValidate={canReadFinance && canValidate} onClose={closeDetail} onPendingChange={lockValidation} onCompleted={completed} />}
  </section>;
}

function RetiredValidationQueue({ refreshKey, pending, selectedId, onSelect }: { refreshKey: number; pending: boolean; selectedId?: string; onSelect: (row: Title, trigger: HTMLButtonElement) => void }) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState(''), [page, setPage] = useState(0), [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<Title[]>([]), [count, setCount] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController(), client = supabase;
    setLoading(true); setError(''); setRows([]); setCount(0);
    if (!client) { setLoading(false); setError('Sua sessão expirou. Entre novamente.'); return; }
    void Promise.resolve(client.rpc('receivable_retired_validation_queue', { p_search: filter, p_collector_id: null, p_offset: page * 25, p_limit: 25 }).abortSignal(abort.signal).retry(false)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      const value = result.data;
      if (!value || value.format_version !== '055' || !Number.isSafeInteger(value.count) || value.count < 0 || !Array.isArray(value.rows)
        || value.rows.length > 25 || value.rows.length > value.count || !value.rows.every((row: unknown) => validTitle(row) && row.retired_from_report && row.collection_worked === true && pendingTitle(row, true))
        || new Set(value.rows.map((row: Title) => row.id)).size !== value.rows.length) throw new Error('invalid_retired_validation_queue');
      const last = Math.max(0, Math.ceil(value.count / 25) - 1);
      setCount(value.count); if (page > last) setPage(last); else setRows(value.rows);
    }).catch(failure => { if (!abort.signal.aborted) setError(message(failure, 'Não foi possível consultar os títulos retirados. Atualize esta fila e tente novamente.')); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [filter, page, refresh, refreshKey]);
  return <section className="stack" aria-labelledby="retired-validation-title"><div className="panel-header"><div><h3 id="retired-validation-title">Títulos retirados aguardando confirmação financeira</h3><p className="help-text">Títulos com movimento de cobrança que saíram do relatório completo. Confira a entrada bancária, a data e o valor recebidos para confirmar. A ausência no relatório não confirma pagamento.</p></div><button type="button" className="button secondary" disabled={pending || loading} onClick={() => setRefresh(value => value + 1)}>Atualizar títulos retirados</button></div>
    <form className="form-grid" onSubmit={event => { event.preventDefault(); if (!pending && !loading) { setFilter(search.trim()); setPage(0); setRefresh(value => value + 1); } }}><label className="field">Buscar título retirado<input value={search} disabled={pending} maxLength={500} onChange={event => setSearch(event.target.value)} placeholder="Cliente, documento ou filial" /></label><button className="button secondary" disabled={pending || loading}>Consultar títulos retirados</button></form>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="table-wrap" aria-busy={loading}><table className="data-table"><caption>Títulos retirados com movimento de cobrança</caption><thead><tr><th>Cliente / NF</th><th>Filial</th><th>Vencimento</th><th>Valor original</th><th>Conferência</th></tr></thead><tbody>{loading ? <tr><td colSpan={5}>Consultando títulos retirados…</td></tr> : rows.length ? rows.map(row => <tr key={row.id}><td>{row.client_name}<div>{row.document}</div></td><td>{row.branch}</td><td>{dateLabel(row.due_date)}</td><td>{formatCents(row.amount_cents)}</td><td><button type="button" className="button secondary" disabled={pending} aria-expanded={selectedId === row.id} aria-controls="collection-validation-detail" onClick={event => onSelect(row, event.currentTarget)}>Conferir retirado {row.document}</button></td></tr>) : <tr><td colSpan={5}>{error ? 'Fila de retirados indisponível.' : 'Nenhum título retirado aguardando confirmação neste filtro.'}</td></tr>}</tbody></table></div>
    <div className="pagination"><span>{count.toLocaleString('pt-BR')} retirado(s) · página {page + 1} de {Math.max(1, Math.ceil(count / 25))}</span><button type="button" className="button secondary" disabled={pending || loading || !page} onClick={() => setPage(value => value - 1)}>Retirados anteriores</button><button type="button" className="button secondary" disabled={pending || loading || (page + 1) * 25 >= count} onClick={() => setPage(value => value + 1)}>Próximos retirados</button></div>
  </section>;
}

function ValidationDetail({ row, openSequence, agents, canReadFinance, collectorId, canWrite, canValidate, onClose, onPendingChange, onCompleted }: { row: Title; openSequence: number; agents: Agent[]; canReadFinance: boolean; collectorId: string | null; canWrite: boolean; canValidate: boolean; onClose: () => void; onPendingChange: (pending: boolean) => void; onCompleted: (text: string) => void }) {
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }, [openSequence]);
  const [date, setDate] = useState(row.payment_reported_date ?? ''), [decision, setDecision] = useState('CONFIRM'), [observation, setObservation] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [readReady, setReadReady] = useState(false), [receipts, setReceipts] = useState<Receipt[]>([]), [error, setError] = useState('');
  const [report, setReport] = useState<PaymentReport | null>(null);
  const [blockedReason, setBlockedReason] = useState('');
  const [amount, setAmount] = useState(''), [adjustmentReason, setAdjustmentReason] = useState(''), [pending, setPending] = useState<ValidationRequest | null>(null);
  const [adjustmentConfirmed, setAdjustmentConfirmed] = useState(false);
  const receivedCents = enteredCents(amount), adjustmentCents = receivedCents === null || receivedCents > row.amount_cents ? null : row.amount_cents - receivedCents;
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);
  async function readTitle(signal?: AbortSignal): Promise<Title | null> {
    if (!supabase) throw { code: 'PGRST301' };
    let query = supabase.from(canReadFinance ? 'receivable_titles' : 'collection_overdue_titles').select(fields).eq('scope', 'grupo-consolidado').eq('id', row.id).limit(1);
    if (!canReadFinance) query = query.eq('collector_id', collectorId!);
    const result = await (signal ? query.abortSignal(signal) : query).retry(false);
    if (result.error) throw result.error;
    if (!Array.isArray(result.data) || result.data.length > 1 || result.data.some(item => !validTitle(item) || item.id !== row.id || !canReadFinance && item.collector_id !== collectorId)) throw new Error('invalid_validation_title');
    return result.data[0] as Title | undefined ?? null;
  }
  async function readReceipts(signal?: AbortSignal): Promise<Receipt[]> {
    if (!supabase) throw { code: 'PGRST301' };
    const receiptColumns = 'id,title_id,amount_cents,payment_date,validated_at';
    let query = supabase.from('effective_receivable_receipts').select(receiptColumns).eq('title_id', row.id).limit(1);
    let result = await (signal ? query.abortSignal(signal) : query).retry(false);
    if (result.error && ['PGRST205', '42P01'].includes(result.error.code)) {
      query = supabase.from('active_receivable_receipts').select(receiptColumns).eq('title_id', row.id).limit(1);
      result = await (signal ? query.abortSignal(signal) : query).retry(false);
    }
    if (result.error && ['PGRST205', '42P01'].includes(result.error.code)) {
      query = supabase.from('receivable_receipts').select(receiptColumns).eq('title_id', row.id).limit(1);
      result = await (signal ? query.abortSignal(signal) : query).retry(false);
    }
    if (result.error) throw result.error;
    if (!Array.isArray(result.data) || result.data.length > 1 || result.data.some(value => !value || value.title_id !== row.id || typeof value.id !== 'string'
      || !Number.isSafeInteger(value.amount_cents) || value.amount_cents < 0 || !civilDate(value.payment_date) || typeof value.validated_at !== 'string' || !Number.isFinite(Date.parse(value.validated_at)))) throw new Error('invalid_validation_receipt');
    return result.data as Receipt[];
  }
  useEffect(() => {
    const client = supabase, abort = new AbortController();
    if (!client) { setLoading(false); setError('Sua sessão expirou. Entre novamente.'); return; }
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
    void Promise.allSettled([readReceipts(abort.signal), readReport(), readTitle(abort.signal)]).then(results => {
      if (abort.signal.aborted) return;
      const [receiptResult, reportResult, titleResult] = results;
      if (receiptResult.status === 'fulfilled') setReceipts(receiptResult.value);
      if (reportResult.status === 'fulfilled') setReport(reportResult.value);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') { setReadReady(false); setError(message(failed.reason, 'Não foi possível conferir os recebimentos ou o relato original da cobrança. Atualize a fila.')); return; }
      if (receiptResult.status === 'fulfilled' && titleResult.status === 'fulfilled') setBlockedReason(stateMessage(titleResult.value, row, receiptResult.value));
      setReadReady(true);
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [row.id, row.revision, row.payment_source, canReadFinance, collectorId]);
  function validDate() {
    return civilDate(date);
  }
  async function checkFresh() {
    const [current, registered] = await Promise.all([readTitle(), readReceipts()]);
    setReceipts(registered);
    const reason = stateMessage(current, row, registered);
    if (reason) { setBlockedReason(reason); return false; }
    return true;
  }
  async function failedValidation(failure: unknown, fallback: string) {
    const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
    if (['23514', '22023', '40001', 'P0002', '23505', 'PV001', 'PV002', 'PV003'].includes(code)) {
      try {
        if (!await checkFresh()) return;
      } catch (readFailure) {
        setReadReady(false); setError(message(readFailure, 'Não foi possível consultar a situação atual deste título. Atualize a fila antes de continuar.')); return;
      }
      if (code === '40001') { setBlockedReason(changedMessage); return; }
      if (['PV001', 'PV002', 'PV003'].includes(code)) { setBlockedReason(message(failure, fallback)); return; }
      if (!validDate() && decision === 'CONFIRM') { setError('Informe a data real do pagamento, até hoje. O vencimento não comprova o recebimento.'); return; }
      setBlockedReason('A situação financeira precisa ser conferida novamente. Atualize a fila; confira os títulos quitados antes de repetir a validação.'); return;
    }
    if (['PV004', 'PV005', 'PV006'].includes(code)) { setError(message(failure, fallback)); return; }
    setReadReady(false); setError(message(failure, fallback));
  }
  async function saveDate() {
    if (!canWrite || busy || pending || loading || !readReady || blockedReason || error || receipts.length || row.payment_source !== 'IMPORTACAO_DIARIA') return;
    if (!validDate()) { setError('Informe a data real do pagamento, até hoje. O vencimento não comprova o recebimento.'); return; }
    if (!window.confirm(`Registrar a data real ${dateLabel(date)} para o título ${row.document}? Isso mantém o recebimento pendente de validação.`)) return;
    setBusy(true); setError(''); onPendingChange(true);
    try { if (!await checkFresh()) return; const result = await supabase!.rpc('set_receivable_payment_date', { p_title_id: row.id, p_payment_date: date, p_expected_revision: row.revision }).retry(false); if (result.error) throw result.error; onCompleted('Data real registrada. O recebimento continua aguardando validação financeira.'); }
    catch (failure) { await failedValidation(failure, 'Não foi possível confirmar a gravação da data. Atualize a fila antes de repetir.'); }
    finally { setBusy(false); onPendingChange(false); }
  }
  async function executeValidation(request: ValidationRequest) {
    if (!canValidate) return;
    setBusy(true); setError(''); setPending(request); onPendingChange(true);
    try {
      if (!supabase) throw { code: 'PGRST301' };
      const result = await supabase.rpc('validate_receivable_payment_v2', { ...request }).retry(false);
      if (result.error) throw result.error;
      if (!validResult(result.data, request, row.amount_cents, row.retired_from_report)) throw new Error('invalid_validation_result');
      let currentSettlement: boolean | null = null;
      if (request.p_decision === 'CONFIRM') {
        try {
          const signal = AbortSignal.timeout(15_000);
          const [currentTitle, activeReceipts] = await Promise.all([readTitle(signal), readReceipts(signal)]);
          currentSettlement = currentTitle?.status === 'VALIDATED' && currentTitle.validation_status === 'VALIDATED'
            && activeReceipts.some(receipt => receipt.id === result.data.receipt_id && receipt.amount_cents === request.p_received_cents && receipt.payment_date === request.p_payment_date);
        } catch { currentSettlement = null; }
      }
      setPending(null); onPendingChange(false);
      onCompleted(request.p_decision === 'CONFIRM'
        ? currentSettlement === true
          ? `Recebimento validado: ${formatCents(request.p_received_cents!)} em ${dateLabel(request.p_payment_date)}. O título saiu da carteira ativa e das pendências de recebimento. Havendo movimento de cobrança, integra a base de comissões no período da data real do recebimento, conforme as regras vigentes.`
          : currentSettlement === false
            ? 'Protocolo de validação anterior confirmado no histórico. A situação atual do título mudou após essa validação; consulte a carteira e o histórico antes de outra operação. Nenhum novo recebimento foi enviado.'
            : 'Protocolo de validação confirmado no histórico. Não foi possível conferir a situação atual do título. Atualize a carteira e o histórico antes de outra operação; não repita a confirmação como um novo recebimento.'
        : 'Pagamento não localizado: devolução registrada para a mesma responsável, sem recebimento confirmado por este protocolo. A fila foi atualizada; confira a situação atual do título.');
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      if (['PV001', 'PV002', 'PV003', 'PV004', 'PV005', 'PV006', '40001', '22023', '23514', '23505', 'P0002', '42501', 'PGRST202', 'PGRST205', '42P01', '42703', '42883', 'PGRST301', 'PGRST303'].includes(code)) {
        setPending(null);
        await failedValidation(failure, 'Não foi possível concluir a validação. Atualize a fila antes de continuar.');
        onPendingChange(false);
      } else setError('Não foi possível confirmar o resultado da validação. Mantenha esta conferência aberta e use Conferir confirmação pendente para verificar o mesmo envio sem duplicar recebimentos.');
    } finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canValidate || busy || pending || loading || !readReady || blockedReason || receipts.length) return;
    setError(''); const confirm = decision === 'CONFIRM';
    if (confirm && !validDate()) { setError('Informe a data real do pagamento, até hoje. O vencimento não comprova o recebimento.'); return; }
    if (confirm && (receivedCents === null || receivedCents > row.amount_cents || receivedCents < 0 || receivedCents === 0 && row.amount_cents !== 0)) { setError('Informe o valor efetivamente recebido, com até duas casas decimais, positivo e até o valor original do título.'); return; }
    if (confirm && adjustmentCents !== null && adjustmentCents > 0 && !adjustmentReason.trim()) { setError('Informe a justificativa do desconto ou da retenção antes de confirmar.'); return; }
    if (confirm && adjustmentCents !== null && adjustmentCents > 0 && !adjustmentConfirmed) { setError('Confirme que a diferença é desconto ou retenção e que o título está integralmente quitado. Um saldo ainda pendente não deve ser confirmado como desconto.'); return; }
    if (!confirm && row.retired_from_report) { setError('O título retirado permanece fora da carteira até reaparecer no relatório de abertos. Nenhum recebimento foi confirmado.'); return; }
    if (!confirm && (!row.collector_id || !observation.trim())) { setError('Informe a justificativa. A devolução exige a mesma responsável já atribuída.'); return; }
    if (!window.confirm(confirm ? `Confirmar financeiramente o título ${row.document}?\n\nValor original: ${formatCents(row.amount_cents)}\nValor efetivamente recebido: ${formatCents(receivedCents!)}\nDesconto ou retenção: ${formatCents(adjustmentCents!)}\nData real: ${dateLabel(date)}${adjustmentCents! > 0 ? `\nJustificativa: ${adjustmentReason.trim()}` : ''}\n\nConfira a entrada bancária. O realizado usará somente o valor recebido; o título sairá da carteira ativa.` : `Devolver o título ${row.document} à mesma responsável para cobrar novamente? Nenhum recebimento ou comissão será confirmado.`)) return;
    setBusy(true); onPendingChange(true);
    try {
      if (!await checkFresh()) { onPendingChange(false); setBusy(false); return; }
    } catch (failure) { onPendingChange(false); setBusy(false); setReadReady(false); setError(message(failure, 'Não foi possível consultar a situação atual do título. Atualize a fila antes de confirmar.')); return; }
    await executeValidation({ p_title_id: row.id, p_decision: confirm ? 'CONFIRM' : 'NOT_LOCATED', p_payment_date: confirm ? date : null,
      p_received_cents: confirm ? receivedCents : null, p_adjustment_reason: confirm && adjustmentCents! > 0 ? adjustmentReason.trim() : null,
      p_observation: observation.trim(), p_expected_revision: row.revision, p_request_id: crypto.randomUUID() });
  }
  return <section id="collection-validation-detail" className="collection-validation-detail" aria-label={`Conferência financeira de ${row.document}`}><div className="panel-header"><h3 ref={heading} tabIndex={-1}>Conferência de {row.document}</h3><button type="button" className="button secondary" disabled={busy || !!pending} onClick={onClose}>Fechar conferência</button></div>
    <p>{row.client_name} · Valor original {formatCents(row.amount_cents)} · Vencimento {dateLabel(row.due_date)}</p>
    {row.retired_from_report && <p className="notice">Título retirado do relatório completo, com movimento de cobrança registrado. A confirmação financeira com data e valor reais encerra a pendência e inclui o recebimento na base de comissões do período correspondente, conforme as regras vigentes.</p>}
    {row.payment_source === 'COBRANCA' && <section className="notice" aria-label="Relato original da cobrança"><strong>Relato original da cobrança</strong>{loading ? <p>Consultando o relato registrado…</p> : report ? <>
      <p><strong>Pagamento informado pela cobradora:</strong> {dateLabel(report.payment_date)}<br /><strong>Registrado em:</strong> {collectionDateTime(report.created_at)}<br /><strong>Responsável pelo relato:</strong> {agents.find(agent => agent.id === report.collector_id)?.display_name || 'Responsável registrada na cobrança'}</p>
      <p><strong>Observação da cobradora:</strong></p><p style={{ whiteSpace: 'pre-wrap' }}>{report.observation || 'Não informada.'}</p>{report.return_note && <p style={{ whiteSpace: 'pre-wrap' }}>{report.return_note}</p>}
    </> : <p>{readReady ? 'Não há relato de pagamento da cobrança disponível para este título.' : 'O relato original ainda não pôde ser conferido. Atualize a fila.'}</p>}<p className="help-text">O relato é preservado no histórico. Confirme a entrada bancária e informe abaixo a data real do recebimento.</p></section>}
    {loading && <p className="help-text" role="status">Conferindo recebimentos registrados…</p>}{(error || blockedReason) && <p className="notice error" role="alert">{error || blockedReason}</p>}
    {receipts.map(receipt => <p className="notice" key={receipt.id}>Já existe recebimento validado: {formatCents(receipt.amount_cents)} em {dateLabel(receipt.payment_date)}. Atualize a fila antes de qualquer nova conferência.</p>)}
    {pending && <p className="notice" role="status">A confirmação está pendente. O mesmo valor, a data, a justificativa e o protocolo serão conferidos novamente. <button type="button" className="button secondary" disabled={busy} onClick={() => void executeValidation(pending)}>Conferir confirmação pendente</button></p>}
    {!canWrite && !canValidate ? <p className="notice">Pagamento informado em {dateLabel(row.payment_reported_date)}. Este acesso permite somente consulta.</p> : <form noValidate onSubmit={event => void submit(event)}><fieldset disabled={busy || !!pending || loading || !readReady || !!blockedReason || receipts.length > 0}>{!row.collector_id && <p className="notice">Este título está sem responsável definida. Para devolver à cobrança, atribua uma cobradora nos detalhes do título em Contas a Receber.</p>}<div className="form-grid">
      <label className="field">Data real do recebimento<input type="date" min="1900-01-01" max="2199-12-31" value={date} onChange={event => { setDate(event.target.value); setError(''); }} /></label>
      {canValidate && <label className="field">Decisão da validação<select value={decision} onChange={event => { setDecision(event.target.value); setError(''); }}><option value="CONFIRM">Confirmar recebimento</option><option value="NOT_LOCATED" disabled={!row.collector_id || row.retired_from_report}>Não localizado — cobrar novamente</option></select></label>}
      {canValidate && decision === 'CONFIRM' && <><label className="field">Valor efetivamente recebido (R$)<input inputMode="decimal" placeholder="Informe o valor recebido" value={amount} required maxLength={40} onChange={event => { setAmount(event.target.value); setAdjustmentConfirmed(false); setError(''); }} /></label><div className="field"><span>Desconto ou retenção</span><strong>{adjustmentCents !== null && receivedCents !== null && receivedCents >= 0 ? formatCents(adjustmentCents) : 'Aguardando valor recebido'}</strong></div>{adjustmentCents !== null && adjustmentCents > 0 && <><label className="field full">Desconto ou retenção — justificativa<textarea value={adjustmentReason} maxLength={5000} required onChange={event => { setAdjustmentReason(event.target.value); setAdjustmentConfirmed(false); setError(''); }} /></label><label className="checkbox-field full"><input type="checkbox" checked={adjustmentConfirmed} onChange={event => { setAdjustmentConfirmed(event.target.checked); setError(''); }} />Confirmo que a diferença é desconto ou retenção e que o título está integralmente quitado.</label></>}</>}
      {canValidate && <label className="field">Justificativa / observação da validação<textarea value={observation} maxLength={5000} onChange={event => setObservation(event.target.value)} required={decision === 'NOT_LOCATED'} /></label>}
    </div><p className="help-text">O realizado e a base de comissão usarão somente o valor efetivamente recebido. O valor original será preservado, com o desconto ou retenção e sua justificativa no histórico. Valores escritos na observação da cobrança não são preenchidos automaticamente. Para recebimento parcial com saldo pendente, mantenha a pendência para conferência. Para pagamentos em datas diferentes, confira o relatório de títulos quitados.</p><p className="help-text">A data informada é a data real da entrada bancária. O vencimento e o valor original não são alterados por esta conferência.</p>
    <div className="inline-actions">{canWrite && !row.retired_from_report && row.payment_source === 'IMPORTACAO_DIARIA' && <button type="button" className="button secondary" onClick={() => void saveDate()}>Salvar data real sem validar</button>}{canValidate && <button type="submit" className="button">{busy ? 'Processando validação…' : decision === 'CONFIRM' ? 'Confirmar recebimento financeiro' : 'Devolver à mesma responsável'}</button>}</div></fieldset></form>}
  </section>;
}
