import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import '../receivables.css';

const scope = 'grupo-consolidado';
const statuses: Record<string, string> = { NEW: 'Novo', OPEN: 'Aberto', PENDING_VALIDATION: 'Pago — aguardando validação', NOT_LOCATED: 'Pagamento não localizado — cobrar novamente', VALIDATED: 'Quitado — validado' };
const actions: Record<string, string> = { CONTACT: 'Contato realizado', NO_RESPONSE: 'Sem resposta', PROMISE: 'Promessa de pagamento', RETRY: 'Cobrar novamente', PAID: 'Título pago', NOT_LOCATED_CONTACT: 'Não localizado no contato', OTHER: 'Outros', PAYMENT_DATE: 'Data real de pagamento informada', VALIDATE: 'Pagamento validado pelo financeiro', PAYMENT_NOT_LOCATED: 'Pagamento não localizado pelo financeiro' };
const contactActions = ['CONTACT', 'NO_RESPONSE', 'PROMISE', 'RETRY', 'PAID', 'NOT_LOCATED_CONTACT', 'OTHER'];
const nextActions = ['CONTACT', 'NO_RESPONSE', 'PROMISE', 'RETRY', 'OTHER'];
const columns = 'id,scope,document,client_name,client_document,customer_key,branch,issued_on,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,payment_date,reported_in_collection,collector_locked,in_latest_report,revision,updated_at,last_action,next_action,next_action_date';

export interface OperationalTitle {
  id: string; scope: string; document: string; client_name: string; client_document: string | null; customer_key: string; branch: string;
  issued_on: string | null; due_date: string; amount_cents: number; collector_id: string | null;
  status: string; validation_status: string; payment_source: string | null; payment_reported_date: string | null; payment_date: string | null;
  reported_in_collection: boolean; collector_locked: boolean; in_latest_report: boolean; revision: number; updated_at: string;
  last_action: string | null; next_action: string | null; next_action_date: string | null;
  collection_as_of_date?: string;
}
interface Agent { id: string; display_name: string; enabled: boolean }
interface Filters { search: string; status: string; start: string; end: string; branch: string; collector: string; nextAction: string }
interface CollectionEvent {
  id: string; action: string; contact_date: string | null; next_action: string | null; next_date: string | null;
  observation: string | null; return_note: string | null; payment_date: string | null; created_at: string;
}
interface Receipt { id: string; amount_cents: number; payment_date: string; delay_days: number; delay_band: string; payment_source: string; validated_at: string }
export interface ReceivableWorkspaceProps {
  mode: 'receivables' | 'collections'; canWrite: boolean; canManage: boolean; canValidate?: boolean;
  collectorId?: string | null; isCollector?: boolean; onImport?: () => void;
  collectionFilter?: { requestId: number; start?: string; end?: string; status?: string; collector?: string; nextAction?: string };
  onCollectionChange?: () => void; refreshKey?: number;
}
const initialFilters: Filters = { search: '', status: 'ACTIVE', start: '', end: '', branch: '', collector: '', nextAction: '' };

function today() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function delayDays(row: OperationalTitle) {
  return Math.max(0, Math.round((Date.parse(`${row.payment_date ?? row.collection_as_of_date ?? today()}T12:00:00Z`) - Date.parse(`${row.due_date}T12:00:00Z`)) / 86400000));
}
function delayLabel(days: number) { return days === 0 ? 'Em dia' : days <= 30 ? '1 a 30 dias' : days <= 60 ? '31 a 60 dias' : days <= 90 ? '61 a 90 dias' : days <= 180 ? '91 a 180 dias' : days <= 365 ? '181 a 365 dias' : 'Acima de 365 dias'; }
function operationError(error: unknown, fallback: string) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === '40001') return 'Este título foi alterado por outra operação. Atualize os títulos, confira os dados e tente novamente.';
  if (code === '42501') return 'Seu perfil não tem permissão para esta operação ou carteira.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (code === '23514' || code === '22023') return 'A operação foi recusada. Confira a situação do título, as datas e os campos obrigatórios. Nenhum dado foi alterado.';
  if (code === 'COLLECTION_NOT_READY') return 'A Cobrança precisa da atualização do banco para exibir somente títulos vencidos. Peça à administração para ativar a atualização de Cobrança.';
  if (code === 'PGRST202' || code === '42703' || code === '42P01') return 'Contas a Receber e Cobrança precisam da atualização do banco de dados. Procure a administração.';
  return fallback;
}
function collectionReadError(error: unknown, mode: ReceivableWorkspaceProps['mode']) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return mode === 'collections' && ['PGRST202', 'PGRST205', '42P01', '42703'].includes(code) ? { code: 'COLLECTION_NOT_READY' } : error;
}
function collectionTitleIsOverdue(row: OperationalTitle) {
  return typeof row.collection_as_of_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.collection_as_of_date) && row.due_date < row.collection_as_of_date;
}
function previousDay(value: string) {
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
async function readTitles(filters: Filters, offset: number, size: number, isCollector: boolean, collectorId: string | null, signal: AbortSignal, mode: ReceivableWorkspaceProps['mode']) {
  if (!supabase) throw { code: 'PGRST301' };
  if (isCollector && !collectorId) return { rows: [], count: 0 };
  let query = supabase.from(mode === 'collections' ? 'collection_overdue_titles' : 'receivable_titles').select(mode === 'collections' ? `${columns},collection_as_of_date` : columns, { count: 'exact' }).eq('scope', scope).order('due_date').order('id').range(offset, offset + size - 1);
  if (isCollector) query = query.eq('collector_id', collectorId!);
  if (filters.search.trim()) query = query.ilike('client_name', `%${filters.search.trim().replace(/[\\%_]/g, '\\$&')}%`);
  if (filters.status === 'ACTIVE') query = query.neq('status', 'VALIDATED');
  else if (filters.status) query = query.eq('status', filters.status);
  if (filters.start) query = query.gte('due_date', filters.start);
  if (filters.end) query = query.lte('due_date', filters.end);
  if (filters.branch.trim()) query = query.eq('branch', filters.branch.trim());
  if (!isCollector && filters.collector === 'unassigned') query = query.is('collector_id', null);
  else if (!isCollector && filters.collector) query = query.eq('collector_id', filters.collector);
  if (mode === 'collections' && filters.nextAction === 'NONE') query = query.is('next_action', null);
  else if (mode === 'collections' && filters.nextAction) query = query.eq('next_action', filters.nextAction);
  const result = await query.abortSignal(signal);
  if (result.error) throw collectionReadError(result.error, mode);
  return { rows: (result.data ?? []) as unknown as OperationalTitle[], count: result.count ?? 0 };
}
function csv(rows: OperationalTitle[], agents: Agent[], name: string) {
  const safe = (value: unknown) => { let text = String(value ?? ''); if (/^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const decimal = (cents: number) => { const value = BigInt(cents); return `${value / 100n},${String(value % 100n).padStart(2, '0')}`; };
  const header = ['Cliente / Órgão', 'CNPJ', 'Documento / NF', 'Filial', 'Emissão', 'Vencimento', 'Valor', 'Cobradora', 'Status', 'Última ação', 'Próxima ação', 'Data próxima ação', 'Pagamento informado', 'Pagamento real validado', 'Origem do pagamento', 'Presente no último relatório'];
  const lines = rows.map(row => [row.client_name, row.client_document, row.document, row.branch, dateLabel(row.issued_on), dateLabel(row.due_date), decimal(row.amount_cents), agents.find(agent => agent.id === row.collector_id)?.display_name ?? (row.collector_id ? 'Cobradora atribuída' : 'Sem cobradora'), statuses[row.status], actions[row.last_action ?? ''] ?? '', actions[row.next_action ?? ''] ?? '', dateLabel(row.next_action_date), dateLabel(row.payment_reported_date), dateLabel(row.payment_date), row.payment_source === 'IMPORTACAO_DIARIA' ? 'IMPORTAÇÃO DIÁRIA' : row.payment_source === 'COBRANCA' ? 'COBRANÇA' : '', row.in_latest_report ? 'SIM' : 'NÃO'].map(safe).join(';'));
  const url = URL.createObjectURL(new Blob(['\uFEFF' + header.map(safe).join(';') + '\r\n' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Receivables({ canWrite, canValidate, onImport }: { canWrite: boolean; canValidate: boolean; onImport?: () => void }) {
  return <ReceivableWorkspace mode="receivables" canWrite={canWrite} canManage={canWrite} canValidate={canValidate} onImport={onImport} />;
}

export function ReceivableWorkspace({ mode, canWrite, canManage, canValidate = false, collectorId = null, isCollector = false, onImport, collectionFilter, onCollectionChange, refreshKey = 0 }: ReceivableWorkspaceProps) {
  const prefix = mode === 'collections' ? 'collection' : 'receivable';
  const [filters, setFilters] = useState(initialFilters), [search, setSearch] = useState('');
  const [rows, setRows] = useState<OperationalTitle[]>([]), [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true), [agentsError, setAgentsError] = useState('');
  const [page, setPage] = useState(0), [size, setSize] = useState(25), [count, setCount] = useState(0), [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<OperationalTitle | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false), [exportProgress, setExportProgress] = useState('');
  const exportAbort = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbort.current?.abort(), []);
  useEffect(() => {
    if (mode !== 'collections' || !collectionFilter) return;
    setSearch(''); setFilters({ ...initialFilters, start: collectionFilter.start ?? '', end: collectionFilter.end ?? '', status: collectionFilter.status ?? 'ACTIVE', collector: collectionFilter.collector ?? '', nextAction: collectionFilter.nextAction ?? '' }); setPage(0);
  }, [mode, collectionFilter?.requestId]);
  useEffect(() => { if (search === filters.search) return; const timer = window.setTimeout(() => { setFilters(previous => ({ ...previous, search })); setPage(0); }, 250); return () => window.clearTimeout(timer); }, [search, filters.search]);
  useEffect(() => {
    const abort = new AbortController(); setAgentsLoading(true); setAgentsError('');
    if (supabase && !(isCollector && !collectorId)) void Promise.resolve(supabase.from('collection_agents').select('id,display_name,enabled').order('display_name').abortSignal(abort.signal)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) { setAgents([]); setAgentsError(operationError(result.error, 'Não foi possível carregar as cobradoras. Atualize os títulos antes de atribuir a carteira.')); }
      else setAgents((result.data ?? []) as Agent[]);
    }).catch(() => { if (!abort.signal.aborted) { setAgents([]); setAgentsError('Não foi possível carregar as cobradoras. Atualize os títulos e tente novamente.'); } }).finally(() => { if (!abort.signal.aborted) setAgentsLoading(false); });
    else setAgentsLoading(false);
    return () => abort.abort();
  }, [isCollector, collectorId, refresh]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(''); setRows([]); setSelected(null);
    if (filters.start && filters.end && filters.start > filters.end) { setError('A data inicial deve ser anterior à data final.'); setLoading(false); setCount(0); return () => abort.abort(); }
    void readTitles(filters, page * size, size, isCollector, collectorId, abort.signal, mode).then(result => {
      if (abort.signal.aborted) return;
      setCount(result.count); const last = Math.max(0, Math.ceil(result.count / size) - 1);
      if (page > last) setPage(last); else setRows(result.rows);
    }).catch(failure => { if (!abort.signal.aborted) { setCount(0); setError(operationError(failure, 'Não foi possível carregar os títulos. Tente atualizar a lista.')); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [filters, page, size, isCollector, collectorId, refresh, mode, refreshKey]);
  function change(key: keyof Filters, value: string) { setFilters(previous => ({ ...previous, [key]: value })); setPage(0); }
  function completed(message: string) { setNotice(message); setSelected(null); setRefresh(value => value + 1); if (mode === 'collections') onCollectionChange?.(); workspaceRef.current?.scrollIntoView({ block: 'start' }); }
  async function exportRows() {
    if (loading || exporting || !count) return;
    const abort = new AbortController(), frozen = { ...filters }; exportAbort.current = abort; setExporting(true); setExportProgress('Preparando exportação…'); setError('');
    try {
      const client = supabase; if (!client) throw { code: 'PGRST301' };
      const snapshot = async () => {
        let query = client.from(mode === 'collections' ? 'collection_overdue_titles' : 'receivable_titles').select(mode === 'collections' ? 'id,revision,updated_at,collection_as_of_date' : 'id,revision,updated_at').eq('scope', scope).order('updated_at', { ascending: false }).order('id').limit(1);
        if (isCollector) query = query.eq('collector_id', collectorId!);
        const result = await query.abortSignal(abort.signal); if (result.error) throw collectionReadError(result.error, mode);
        return JSON.stringify(result.data ?? []);
      };
      const before = await snapshot(), selectedRows: OperationalTitle[] = []; let expected: number | null = null;
      for (let offset = 0; ; offset += 500) {
        const result = await readTitles(frozen, offset, 500, isCollector, collectorId, abort.signal, mode); if (abort.signal.aborted) return;
        if (expected !== null && expected !== result.count) throw new Error('changed'); expected = result.count;
        selectedRows.push(...result.rows); if (selectedRows.length > 100000) throw new Error('limit');
        setExportProgress(`Exportando ${selectedRows.length.toLocaleString('pt-BR')} de ${expected.toLocaleString('pt-BR')} títulos…`);
        if (selectedRows.length >= expected) break; if (!result.rows.length) throw new Error('changed');
      }
      if (before !== await snapshot() || new Set(selectedRows.map(row => row.id)).size !== selectedRows.length) throw new Error('changed');
      if (abort.signal.aborted) return;
      csv(selectedRows, agents, `${mode === 'collections' ? 'Cobranca' : 'Contas_a_Receber'}_Filtrado_${today()}.csv`);
      setExportProgress(`${selectedRows.length.toLocaleString('pt-BR')} títulos exportados com os filtros selecionados.`);
    } catch (failure) { if (!abort.signal.aborted) { setError(operationError(failure, failure instanceof Error && failure.message === 'changed' ? 'A base mudou durante a exportação. Atualize os títulos e tente novamente.' : failure instanceof Error && failure.message === 'limit' ? 'A exportação excede 100.000 títulos. Restrinja os filtros.' : 'Não foi possível concluir a exportação. Tente novamente.')); setExportProgress(''); } }
    finally { if (!abort.signal.aborted) setExporting(false); }
  }
  const pages = Math.max(1, Math.ceil(count / size)), unbound = isCollector && !collectorId;
  const collectionDateLimit = mode === 'collections' ? previousDay(rows[0]?.collection_as_of_date ?? today()) : undefined;
  return <section ref={workspaceRef} className="panel receivables-workspace" aria-labelledby={`${prefix}-title`}>
    <div className="panel-header"><div><h2 id={`${prefix}-title`}>{mode === 'collections' ? isCollector ? 'Minha carteira de cobrança' : 'Carteiras de cobrança' : 'Títulos de Contas a Receber'}</h2><p className="muted">{mode === 'collections' ? 'Somente títulos com vencimento anterior a hoje, pela data oficial de São Paulo. Contatos e pagamentos informados preservam a carteira até a validação financeira.' : 'Importação completa identifica ausências; somente a validação financeira confirma o recebimento.'}</p></div><div className="inline-actions">{onImport && <button type="button" className="button" onClick={onImport}>Ir para Importar Bases</button>}<button type="button" className="button secondary" disabled={loading || unbound} onClick={() => { setNotice(''); setRefresh(value => value + 1); }}>Atualizar títulos</button></div></div>
    {unbound ? <p className="notice" role="status">Seu login ainda não está vinculado a uma cobradora. Peça à Gerência Geral para configurar o vínculo em Administração. Nenhuma carteira está disponível até essa configuração.</p> : <>
      {error && <p className="notice error" role="alert">{error}</p>}{agentsError && <p className="notice error" role="alert">{agentsError}</p>}{notice && <p className="notice success" role="status">{notice}</p>}
      {canValidate && mode === 'receivables' && <div className="receivable-queue"><div><strong>Validação financeira</strong><p>Confira a data real e a entrada bancária antes de confirmar. Pagamento apenas informado não compõe o valor recebido.</p></div><button className="button secondary" type="button" onClick={() => change('status', 'PENDING_VALIDATION')}>Abrir fila de validação</button></div>}
      <div className="form-grid receivable-filters">
        <label className="field" htmlFor={`${prefix}-search`}>Pesquisar cliente / órgão<input id={`${prefix}-search`} value={search} onChange={event => setSearch(event.target.value)} placeholder="Nome do cliente ou órgão" maxLength={200} /></label>
        <label className="field" htmlFor={`${prefix}-status`}>Situação do título<select id={`${prefix}-status`} value={filters.status} onChange={event => change('status', event.target.value)}><option value="ACTIVE">{mode === 'collections' ? 'Vencidos em aberto' : 'Carteira ativa'}</option><option value="">{mode === 'collections' ? 'Vencidos, incluindo histórico' : 'Todos, incluindo histórico'}</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field" htmlFor={`${prefix}-start`}>Vencimento inicial<input id={`${prefix}-start`} type="date" max={collectionDateLimit} value={filters.start} onChange={event => change('start', event.target.value)} /></label>
        <label className="field" htmlFor={`${prefix}-end`}>Vencimento final<input id={`${prefix}-end`} type="date" max={collectionDateLimit} value={filters.end} onChange={event => change('end', event.target.value)} /></label>
        <label className="field" htmlFor={`${prefix}-branch`}>Filial<input id={`${prefix}-branch`} value={filters.branch} onChange={event => change('branch', event.target.value)} placeholder="Código / nome exato da base" maxLength={150} /></label>
        {!isCollector && <label className="field" htmlFor={`${prefix}-collector`}>Cobradora<select id={`${prefix}-collector`} value={filters.collector} onChange={event => change('collector', event.target.value)}><option value="">Todas as carteiras</option><option value="unassigned">Sem cobradora definida</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.display_name}{!agent.enabled ? ' (inativa)' : ''}</option>)}</select></label>}
        {mode === 'collections' && <label className="field" htmlFor={`${prefix}-next-action`}>Próxima ação<select id={`${prefix}-next-action`} value={filters.nextAction} onChange={event => change('nextAction', event.target.value)}><option value="">Todas as próximas ações</option><option value="NONE">Sem próxima ação definida</option>{nextActions.map(key => <option value={key} key={key}>{actions[key]}</option>)}</select></label>}
      </div>
      <div className="toolbar"><button type="button" className="button secondary" onClick={() => { setSearch(''); setFilters(initialFilters); setPage(0); }}>Limpar filtros</button><button type="button" className="button secondary" disabled={loading || exporting || !count} onClick={() => void exportRows()}>{exporting ? 'Exportando…' : 'Baixar CSV dos filtros'}</button></div>
      {exportProgress && <p className="help-text" role="status">{exportProgress}</p>}
      <div className="table-wrap" aria-busy={loading}><table className="data-table"><caption className="sr-only">{mode === 'collections' ? 'Carteira de cobrança' : 'Contas a Receber'} com filtros e paginação</caption><thead><tr><th>Cliente / Documento</th><th>Filial / Emissão</th><th>Vencimento / Atraso</th><th>Valor</th>{!isCollector && <th>Cobradora</th>}<th>Situação / Última ação</th><th>Próxima ação</th><th>Pagamento</th><th>Detalhes</th></tr></thead><tbody>{loading ? <tr><td colSpan={isCollector ? 8 : 9} className="empty-state">Carregando títulos…</td></tr> : rows.length ? rows.map(row => <tr key={row.id} className={selected?.id === row.id ? 'receivable-selected' : ''}><td><strong>{row.client_name}</strong><div>Documento / NF: {row.document}</div>{row.client_document && <small>CNPJ: {row.client_document}</small>}</td><td>{row.branch}<div>{dateLabel(row.issued_on)}</div></td><td>{dateLabel(row.due_date)}<div className={delayDays(row) ? 'receivable-overdue' : 'muted'}>{delayDays(row)} dias · {delayLabel(delayDays(row))}</div></td><td className="receivable-money">{formatCents(row.amount_cents)}</td>{!isCollector && <td>{agents.find(agent => agent.id === row.collector_id)?.display_name ?? (row.collector_id ? 'Cobradora atribuída' : 'Sem cobradora definida')}</td>}<td><span className={`badge receivable-status status-${row.status.toLowerCase()}`}>{statuses[row.status]}</span><div>{actions[row.last_action ?? ''] ?? 'Sem ação registrada'}</div>{!row.in_latest_report && row.status !== 'VALIDATED' && <small className="receivable-warning">Ausente no último relatório completo</small>}</td><td>{actions[row.next_action ?? ''] ?? '—'}<div>{dateLabel(row.next_action_date)}</div></td><td><div>Informado: {dateLabel(row.payment_reported_date)}</div><div>Validado: {dateLabel(row.payment_date)}</div></td><td><button type="button" className="button secondary" onClick={() => { setSelected(row); setNotice(''); }} aria-label={`Detalhar título ${row.document} de ${row.client_name}`}>Detalhar</button></td></tr>) : <tr><td colSpan={isCollector ? 8 : 9} className="empty-state">{error ? 'Lista indisponível.' : 'Nenhum título para os filtros selecionados.'}</td></tr>}</tbody></table></div>
      <div className="pagination"><label className="field" htmlFor={`${prefix}-size`}>Por página<select id={`${prefix}-size`} value={size} onChange={event => { setSize(Number(event.target.value)); setPage(0); }}><option value="25">25</option><option value="50">50</option></select></label><span>{count.toLocaleString('pt-BR')} títulos · página {page + 1} de {pages}</span><button type="button" className="button secondary" disabled={loading || !page} onClick={() => setPage(value => value - 1)}>Anterior</button><button type="button" className="button secondary" disabled={loading || page + 1 >= pages} onClick={() => setPage(value => value + 1)}>Próxima</button></div>
      {selected && <TitleDetails key={`${selected.id}:${selected.revision}`} row={selected} agents={agents} canAssign={canWrite && canManage && !agentsLoading && !agentsError} canContact={canWrite && mode === 'collections' && collectionTitleIsOverdue(selected)} canValidate={canValidate && mode === 'receivables'} onClose={() => setSelected(null)} onCompleted={completed} />}
    </>}
  </section>;
}

function TitleDetails({ row, agents, canAssign, canContact, canValidate, onClose, onCompleted }: { row: OperationalTitle; agents: Agent[]; canAssign: boolean; canContact: boolean; canValidate: boolean; onClose: () => void; onCompleted: (message: string) => void }) {
  const [events, setEvents] = useState<CollectionEvent[]>([]), [receipts, setReceipts] = useState<Receipt[]>([]), [loading, setLoading] = useState(true), [historyError, setHistoryError] = useState('');
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { headingRef.current?.scrollIntoView({ block: 'start' }); headingRef.current?.focus({ preventScroll: true }); }, [row.id]);
  useEffect(() => {
    const client = supabase, abort = new AbortController(); if (!client) { setLoading(false); setHistoryError('Sua sessão expirou. Entre novamente.'); return; }
    void Promise.all([
      client.from('receivable_collection_events').select('id,action,contact_date,next_action,next_date,observation,return_note,payment_date,created_at').eq('title_id', row.id).order('created_at', { ascending: false }).order('id').limit(50).abortSignal(abort.signal),
      (async () => {
        const receiptColumns = 'id,amount_cents,payment_date,delay_days,delay_band,payment_source,validated_at';
        const current = await client.from('effective_receivable_receipts').select(receiptColumns).eq('title_id', row.id).limit(1).abortSignal(abort.signal);
        if (!current.error || !['PGRST205', '42P01'].includes(current.error.code)) return current;
        return client.from('receivable_receipts').select(receiptColumns).eq('title_id', row.id).limit(1).abortSignal(abort.signal);
      })(),
    ]).then(results => {
      if (abort.signal.aborted) return;
      const failed = results.find(result => result.error); if (failed) { setHistoryError(operationError(failed.error, 'Não foi possível carregar o histórico. Atualize os títulos e tente novamente.')); return; }
      setEvents((results[0].data ?? []) as unknown as CollectionEvent[]); setReceipts((results[1].data ?? []) as unknown as Receipt[]);
    }).catch(() => { if (!abort.signal.aborted) setHistoryError('Não foi possível carregar o histórico. Atualize os títulos e tente novamente.'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [row.id]);
  return <section className="receivable-detail" aria-labelledby="receivable-detail-title"><div className="panel-header"><div><h3 ref={headingRef} tabIndex={-1} id="receivable-detail-title">Título {row.document} · {row.client_name}</h3><p className="muted">{formatCents(row.amount_cents)} · Vencimento {dateLabel(row.due_date)} · {statuses[row.status]}</p></div><button type="button" className="button secondary" onClick={onClose}>Fechar detalhes</button></div>
    {row.status === 'PENDING_VALIDATION' && <p className="notice">{row.payment_source === 'IMPORTACAO_DIARIA' ? 'Quitado na origem — aguardando validação. O título desapareceu do relatório completo. Informe a data real do pagamento após conferir a entrada bancária.' : 'Pagamento informado pela cobrança — aguardando validação financeira.'} A responsável permanece vinculada até a validação.</p>}
    {canAssign && !row.collector_id && !row.collector_locked && row.status !== 'VALIDATED' && <AssignmentForm row={row} agents={agents.filter(agent => agent.enabled)} onCompleted={onCompleted} />}
    {canContact && row.status !== 'VALIDATED' && <ContactForm row={row} onCompleted={onCompleted} />}
    {canValidate && row.status === 'PENDING_VALIDATION' && <ValidationForm row={row} onCompleted={onCompleted} />}
    <h3>Histórico do título</h3><p className="help-text">Até 50 ações mais recentes. Registros anteriores são preservados no banco.</p>
    {historyError && <p className="notice error" role="alert">{historyError}</p>}
    {loading ? <p className="help-text" role="status">Carregando histórico…</p> : <>
      {receipts.map(receipt => <p className="notice success" key={receipt.id}>Recebimento validado: {formatCents(receipt.amount_cents)} · Pagamento real em {dateLabel(receipt.payment_date)} · {receipt.delay_days} dias de atraso no recebimento ({delayLabel(receipt.delay_days)}) · Validado em {dateLabel(receipt.validated_at)} · Origem: {receipt.payment_source === 'IMPORTACAO_DIARIA' ? 'Importação diária' : 'Cobrança'}.</p>)}
      <ol className="receivable-history">{events.map(event => <li key={event.id}><strong>{actions[event.action] ?? 'Ação registrada'}</strong><small>Registrado em {dateLabel(event.created_at)}{event.contact_date ? ` · Contato em ${dateLabel(event.contact_date)}` : ''}</small>{event.observation && <p>{event.observation}</p>}{event.return_note && <p><strong>Retorno:</strong> {event.return_note}</p>}{event.next_action && <p>Próxima ação: {actions[event.next_action]} · {dateLabel(event.next_date)}</p>}{event.payment_date && <p>Data de pagamento: {dateLabel(event.payment_date)}</p>}</li>)}</ol>
      {!events.length && !historyError && <p className="help-text">Nenhum contato ou validação registrado para este título.</p>}
    </>}
  </section>;
}

function AssignmentForm({ row, agents, onCompleted }: { row: OperationalTitle; agents: Agent[]; onCompleted: (message: string) => void }) {
  const [agent, setAgent] = useState(''), [observation, setObservation] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !agent || !observation.trim()) return;
    const name = agents.find(item => item.id === agent)?.display_name;
    if (!window.confirm(`Atribuir a ${name} todos os títulos ativos ainda sem cobradora deste cliente? A carteira existente será preservada e a atribuição ficará na auditoria.`)) return;
    setBusy(true); setError('');
    try { const result = await supabase!.rpc('assign_receivable_collector', { p_customer_key: row.customer_key, p_collector_id: agent, p_observation: observation.trim() }); if (result.error) throw result.error; onCompleted(`${Number(result.data).toLocaleString('pt-BR')} título(s) atribuído(s) a ${name}.`); }
    catch (failure) { setError(operationError(failure, 'Não foi possível atribuir a carteira. Atualize os títulos e tente novamente.')); }
    finally { setBusy(false); }
  }
  return <form className="receivable-operation" onSubmit={submit}><fieldset disabled={busy}><legend>Atribuir cobradora ao cliente</legend><p className="help-text">A seleção vale para todos os títulos ativos ainda sem responsável deste cliente. Novos títulos herdam a carteira enquanto existir dívida ativa.</p><div className="form-grid"><label className="field">Cobradora responsável<select required value={agent} onChange={event => setAgent(event.target.value)}><option value="">Selecione a pessoa responsável</option>{agents.map(item => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><label className="field">Justificativa da atribuição<input required maxLength={5000} value={observation} onChange={event => setObservation(event.target.value)} /></label></div>{!agents.length && <p className="notice">Cadastre uma cobradora ativa em Administração antes de atribuir a carteira.</p>}{error && <p className="notice error" role="alert">{error}</p>}<button type="submit" className="button" disabled={!agents.length || !agent || !observation.trim()}>{busy ? 'Atribuindo…' : 'Confirmar atribuição'}</button></fieldset></form>;
}

function ContactForm({ row, onCompleted }: { row: OperationalTitle; onCompleted: (message: string) => void }) {
  const [action, setAction] = useState('CONTACT'), [contactDate, setContactDate] = useState(today()), [nextAction, setNextAction] = useState(''), [nextDate, setNextDate] = useState('');
  const [observation, setObservation] = useState(''), [returnNote, setReturnNote] = useState(''), [paymentDate, setPaymentDate] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (row.status === 'VALIDATED' || !collectionTitleIsOverdue(row)) { setError('Somente títulos vencidos e ainda não validados podem receber ações de cobrança. Atualize os títulos.'); return; }
    setError(''); if (action === 'PAID' && !paymentDate) { setError('Informe a data do pagamento. O título ficará aguardando validação financeira.'); return; }
    if (action === 'PAID' && !window.confirm(`Informar pagamento do título ${row.document} em ${dateLabel(paymentDate)}? O título continuará na carteira, aguardando validação financeira. Este registro não confirma o recebimento.`)) return;
    setBusy(true);
    try {
      const result = await supabase!.rpc('record_collection_action', { p_title_id: row.id, p_action: action, p_contact_date: contactDate, p_next_action: nextAction || null, p_next_date: nextDate || null, p_observation: observation.trim(), p_return_note: returnNote.trim(), p_payment_date: action === 'PAID' ? paymentDate : null, p_expected_revision: row.revision });
      if (result.error) throw result.error;
      onCompleted(action === 'PAID' ? 'Pagamento informado. O título permanece na carteira, aguardando validação financeira.' : 'Ação de cobrança registrada no histórico.');
    } catch (failure) { setError(operationError(failure, 'Não foi possível registrar a ação de cobrança. Atualize os títulos e tente novamente.')); }
    finally { setBusy(false); }
  }
  return <form className="receivable-operation" onSubmit={submit}><fieldset disabled={busy}><legend>Registrar ação de cobrança</legend><div className="form-grid"><label className="field">Ação de cobrança<select value={action} onChange={event => { setAction(event.target.value); setPaymentDate(''); }} required>{contactActions.filter(key => key !== 'PAID' || row.status !== 'PENDING_VALIDATION').map(key => <option value={key} key={key}>{actions[key]}</option>)}</select></label><label className="field">Data do contato<input type="date" required min="1900-01-01" max={today()} value={contactDate} onChange={event => setContactDate(event.target.value)} /></label><label className="field">Próxima ação<select value={nextAction} required={!!nextDate} onChange={event => { setNextAction(event.target.value); if (!event.target.value) setNextDate(''); }}><option value="">Sem próxima ação definida</option>{nextActions.map(key => <option value={key} key={key}>{actions[key]}</option>)}</select></label><label className="field">Data da próxima ação<input type="date" min="1900-01-01" disabled={!nextAction} value={nextDate} onChange={event => setNextDate(event.target.value)} /></label><label className="field">Observação<textarea maxLength={5000} required={action === 'OTHER'} value={observation} onChange={event => setObservation(event.target.value)} /></label><label className="field">Retorno do cliente<textarea maxLength={5000} value={returnNote} onChange={event => setReturnNote(event.target.value)} /></label>{action === 'PAID' && <label className="field">Data do pagamento informado<input type="date" required min="1900-01-01" max={today()} value={paymentDate} onChange={event => setPaymentDate(event.target.value)} /></label>}</div>{action === 'PAID' && <p className="notice">Pago — aguardando validação financeira. Somente Contas a Receber pode confirmar a entrada do valor.</p>}{error && <p className="notice error" role="alert">{error}</p>}<button type="submit" className="button">{busy ? 'Registrando…' : action === 'PAID' ? 'Informar pagamento para validação' : 'Registrar ação'}</button></fieldset></form>;
}

function ValidationForm({ row, onCompleted }: { row: OperationalTitle; onCompleted: (message: string) => void }) {
  const [decision, setDecision] = useState('CONFIRM'), [paymentDate, setPaymentDate] = useState(row.payment_reported_date ?? ''), [observation, setObservation] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const confirm = decision === 'CONFIRM'; setError('');
    if (confirm && !paymentDate) { setError('Informe a data real do pagamento após conferir a entrada bancária.'); return; }
    if (!confirm && !observation.trim()) { setError('Informe o motivo para devolver o título à mesma cobradora.'); return; }
    if (!window.confirm(confirm ? `Confirmar financeiramente ${formatCents(row.amount_cents)} do título ${row.document}, pago em ${dateLabel(paymentDate)}? O título sairá da carteira ativa e o recebimento ficará no histórico.` : `Marcar pagamento NÃO LOCALIZADO e devolver o título ${row.document} à mesma cobradora? O título voltará para cobrança e não gerará recebimento nem comissão.`)) return;
    setBusy(true);
    try {
      const result = await supabase!.rpc('validate_receivable_payment', { p_title_id: row.id, p_decision: decision, p_payment_date: confirm ? paymentDate : null, p_observation: observation.trim(), p_expected_revision: row.revision });
      if (result.error) throw result.error;
      onCompleted(confirm ? 'Recebimento validado. O título saiu da carteira ativa e permanece no histórico.' : 'Pagamento não localizado. Título devolvido à mesma cobradora para cobrar novamente, sem recebimento ou comissão.');
    } catch (failure) { setError(operationError(failure, 'Não foi possível concluir a validação financeira. Atualize os títulos e confira a situação antes de tentar novamente.')); }
    finally { setBusy(false); }
  }
  return <form className="receivable-operation receivable-validation" onSubmit={submit}><fieldset disabled={busy}><legend>Validar pagamento no financeiro</legend>{!row.collector_id && <p className="help-text">Para devolver um pagamento não localizado à cobrança, atribua primeiro a cobradora responsável por este cliente.</p>}<div className="form-grid"><label className="field">Decisão financeira<select value={decision} onChange={event => setDecision(event.target.value)}><option value="CONFIRM">Confirmar recebimento</option><option value="NOT_LOCATED" disabled={!row.collector_id}>Não localizado — cobrar novamente</option></select></label>{decision === 'CONFIRM' && <label className="field">Data real do pagamento<input type="date" required min="1900-01-01" max={today()} value={paymentDate} onChange={event => setPaymentDate(event.target.value)} /></label>}<label className="field full">Observação da validação<textarea maxLength={5000} required={decision === 'NOT_LOCATED'} value={observation} onChange={event => setObservation(event.target.value)} /></label></div>{error && <p className="notice error" role="alert">{error}</p>}<button type="submit" className={`button ${decision === 'NOT_LOCATED' ? 'secondary' : ''}`}>{busy ? 'Validando…' : decision === 'CONFIRM' ? 'Confirmar recebimento financeiro' : 'Devolver à mesma cobradora'}</button></fieldset></form>;
}
