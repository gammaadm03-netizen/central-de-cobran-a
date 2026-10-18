import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import { addCivilDays } from '../lib/financial-dates';
import type { CollectionSelection } from './CollectionOverview';
import CollectionCustomerContext, { type CollectionContactGuard } from './CollectionCustomerContext';
import { COLLECTION_BANDS, COLLECTION_SORTS, COLLECTION_STATUSES, FINANCIAL_STATUSES, INITIAL_COLLECTION_FILTERS, collectionDateTime, collectionServerDay, collectionWorkflowReady, collectionStartReason, collectionDate, collectionDraft, collectionDraftKey, collectionError, downloadCollectionCsv, readCollectionDetail, readCollectionWorkbench, validCollectionTimer, workTime, type CollectionAgent, type CollectionDetail, type CollectionDraft, type CollectionFilters, type CollectionRow, type CollectionSaveResult, type CollectionTimer, type CollectionWorkbench } from '../lib/collection-workbench';
import '../collection-workbench.css';

interface Props { canWrite: boolean; canManage: boolean; collectorId: string | null; isCollector: boolean; selection?: CollectionSelection & { requestId: number }; onChange?: () => void; onFinish?: (paid: boolean) => void; refreshKey?: number; onContactsChange?: () => void; contactsRefreshKey?: number }
interface FrozenRequest { rpc: 'save_collection_case' | 'collection_work_action'; body: Record<string, unknown>; kind: 'start' | 'pause' | 'save' | 'finish' | 'recovery'; titleId: string; paid: boolean; nextId: string | null; globalRecovery?: boolean }
const nextActions: Record<string, string> = { NONE: 'Sem próxima ação', CONTACT: 'Contato', NO_RESPONSE: 'Sem resposta', PROMISE: 'Promessa de pagamento', RETRY: 'Cobrar novamente', OTHER: 'Outra ação' };
const actionLabels: Record<string, string> = { CONTACT: 'Contato realizado', NO_RESPONSE: 'Sem resposta', PROMISE: 'Promessa de pagamento', RETRY: 'Cobrar novamente', PAID: 'Pagamento informado à validação', NOT_LOCATED_CONTACT: 'Não localizado no contato', OTHER: 'Atendimento registrado', VALIDATE: 'Recebimento validado', PAYMENT_NOT_LOCATED: 'Pagamento não localizado', PAYMENT_DATE: 'Data de pagamento informada' };
const emptyDraft: CollectionDraft = { status: 'NOVO TÍTULO - COBRAR', observation: '', nextAction: '', nextDate: '', paymentDate: '' };
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';

export default function CollectionDesk({ canWrite, canManage, collectorId, isCollector, selection, onChange, onFinish, refreshKey = 0, onContactsChange, contactsRefreshKey = 0 }: Props) {
  const [filters, setFilters] = useState<CollectionFilters>({ ...INITIAL_COLLECTION_FILTERS }), [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const [list, setList] = useState<CollectionWorkbench | null>(null), [loading, setLoading] = useState(true), [listError, setListError] = useState(''), [refresh, setRefresh] = useState(0);
  const [agents, setAgents] = useState<CollectionAgent[]>([]), [agentError, setAgentError] = useState('');
  const [detail, setDetail] = useState<CollectionDetail | null>(null), [draft, setDraft] = useState<CollectionDraft>(emptyDraft), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [pending, setPending] = useState<FrozenRequest | null>(null), [notice, setNotice] = useState('');
  const [rebaseRequired, setRebaseRequired] = useState(false);
  const [contactGuard, setContactGuard] = useState<CollectionContactGuard>({ dirty: false, pending: false }), [contactDiscard, setContactDiscard] = useState(0);
  const [contactTarget, setContactTarget] = useState<{ titleId: string; customerKey: string } | null>(null);
  const [tick, setTick] = useState(0), [assignment, setAssignment] = useState(''), [assignmentReason, setAssignmentReason] = useState('');
  const [exporting, setExporting] = useState(false), [exportStatus, setExportStatus] = useState('');
  const [recovery, setRecovery] = useState<{ id: string; revision: number; timer: CollectionTimer } | null>(null);
  const [activeTimer, setActiveTimer] = useState<CollectionTimer | null>(null);
  const mounted = useRef(true), detailAbort = useRef<AbortController | null>(null), exportAbort = useRef<AbortController | null>(null), timerAnchor = useRef(0), casePanel = useRef<HTMLElement | null>(null);
  const pendingRef = useRef<FrozenRequest | null>(null), detailRef = useRef<CollectionDetail | null>(null), draftRef = useRef(draft);
  const rebaseRef = useRef(false);
  detailRef.current = detail; draftRef.current = draft;
  const unbound = isCollector && !collectorId;
  const dirty = detail !== null && collectionDraftKey(draft) !== collectionDraftKey(collectionDraft(detail));
  const ready = collectionWorkflowReady(list?.workflow), detailReady = collectionWorkflowReady(detail?.workflow);
  const writableTitle = detail !== null && !!detail.title.collector_id && !['UNASSIGNED', 'READ_ONLY'].includes(detail.title.start_block_reason ?? '') && !['VALIDATED', 'PENDING_VALIDATION'].includes(detail.title.status);
  const editable = canWrite && ready && detailReady && writableTitle;
  const running = detail?.timer.running ? detail.timer : activeTimer?.running ? activeTimer : recovery?.timer.running ? recovery.timer : null;
  const activationNotice = 'Ative a atualização 029 da Cobrança no banco para usar Iniciar, Pausar, Salvar andamento e Finalizar. Os títulos continuam disponíveis para leitura.';
  const actionWaiting = busy || !!pending || detailLoading;
  const otherRunning = !!running && running.title_id !== detail?.title.id;
  const canStart = editable && !actionWaiting && !blocked && detail?.title.can_start === true && !detail.timer.running && !otherRunning;
  const canPause = canWrite && ready && detailReady && !!detail?.timer.running && !actionWaiting;
  const canFinish = editable && !actionWaiting && !blocked && detail?.workflow?.can_finish === true;
  const paidDateInvalid = draft.status === 'TÍTULO PAGO' && (!collectionDate(draft.paymentDate) || draft.paymentDate < '1900-01-01' || !!detail && draft.paymentDate > collectionServerDay(detail.timer.server_now));
  const canRecover = canWrite && ready && !!activeTimer?.running && activeTimer.recovery_allowed === true;
  const startReason = !ready || detail && !detailReady ? activationNotice : !canWrite ? 'Seu perfil permite somente leitura; peça acesso à administração para trabalhar neste título.'
    : actionWaiting ? 'Aguarde a consulta ou confirmação em andamento antes de iniciar.' : blocked ? 'Confira a versão atual do título e resolva a confirmação pendente antes de continuar.'
    : detail?.timer.running ? 'Este atendimento já está em andamento. Pausar está disponível.' : collectionStartReason(detail?.title.start_block_reason);
  const saveReason = !ready || detail && !detailReady ? activationNotice : !canWrite || detail?.title.start_block_reason === 'READ_ONLY' ? 'Este acesso é somente leitura.' : !detail?.title.collector_id || detail.title.start_block_reason === 'UNASSIGNED' ? collectionStartReason('UNASSIGNED') : !writableTitle ? 'Este título está em leitura enquanto aguarda validação ou já foi quitado.'
    : actionWaiting ? 'Aguarde a confirmação em andamento.' : blocked ? 'Resolva a conferência de revisão ou a confirmação pendente antes de salvar.' : !dirty ? 'Salvar andamento fica disponível após alterar os campos do atendimento.' : paidDateInvalid ? 'Para salvar o rascunho com status TÍTULO PAGO, informe uma data real válida até hoje. Salvar o rascunho não confirma o recebimento.' : '';

  function freeze(request: FrozenRequest | null) { pendingRef.current = request; setPending(request); }
  function requireRebase(value: boolean) { rebaseRef.current = value; setRebaseRequired(value); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; detailAbort.current?.abort(); exportAbort.current?.abort(); }; }, []);
  useEffect(() => {
    if (!running && !dirty && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [running, dirty, pending]);
  useEffect(() => {
    if (!detail?.timer.running) { setTick(0); return; }
    timerAnchor.current = performance.now(); setTick(0);
    const timer = window.setInterval(() => setTick(Math.max(0, Math.floor((performance.now() - timerAnchor.current) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [detail?.timer]);
  useEffect(() => {
    if (search === filters.search) return;
    const timer = window.setTimeout(() => { setFilters(previous => ({ ...previous, search })); setPage(0); }, 250);
    return () => window.clearTimeout(timer);
  }, [search, filters.search]);
  useEffect(() => {
    if (!selection) return;
    const current = detailRef.current;
    if ((current && collectionDraftKey(draftRef.current) !== collectionDraftKey(collectionDraft(current)) || pendingRef.current) && !window.confirm('Há um atendimento com alterações não salvas ou confirmação pendente. Manter o rascunho e aplicar o novo filtro?')) return;
    setSearch(''); setPage(0); setFilters({ ...INITIAL_COLLECTION_FILTERS, dueStart: selection.start ?? '', dueEnd: selection.end ?? '', collector: selection.collector ?? '', nextAction: selection.nextAction ?? '', financialStatus: selection.status ?? 'ACTIVE', queue: selection.queue ?? (selection.status === 'VALIDATED' ? 'history' : selection.status === 'PENDING_VALIDATION' ? 'all' : 'active') });
    if (selection.titleId) openTitle(selection.titleId);
  }, [selection?.requestId]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setList(null); setListError('');
    if (unbound) { setLoading(false); return () => abort.abort(); }
    if (filters.dueStart && filters.dueEnd && filters.dueStart > filters.dueEnd) { setListError('A data inicial deve ser anterior à data final.'); setLoading(false); return () => abort.abort(); }
    void readCollectionWorkbench(filters, page * 25, 25, isCollector, collectorId, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setActiveTimer(result.active_timer);
      const last = Math.max(0, Math.ceil(result.count / 25) - 1); if (page > last) setPage(last); else setList(result);
    }).catch(error => { if (!abort.signal.aborted) setListError(collectionError(error, 'Não foi possível carregar a carteira. Atualize os títulos para tentar novamente.')); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [filters, page, refresh, refreshKey, isCollector, collectorId, unbound]);
  useEffect(() => {
    const client = supabase, abort = new AbortController(); setAgents([]); setAgentError('');
    if (client && !unbound) void Promise.resolve(client.from('collection_agents').select('id,display_name,enabled').order('display_name').abortSignal(abort.signal)).then(result => {
      if (abort.signal.aborted) return; if (result.error) throw result.error;
      if (!Array.isArray(result.data) || result.data.some(row => typeof row.id !== 'string' || typeof row.display_name !== 'string' || typeof row.enabled !== 'boolean') || isCollector && result.data.some(row => row.id !== collectorId)) throw new Error('invalid_agents');
      setAgents(result.data);
    }).catch(error => { if (!abort.signal.aborted) setAgentError(collectionError(error, 'Não foi possível consultar as cobradoras. A carteira mantém os responsáveis já cadastrados.')); });
    return () => abort.abort();
  }, [isCollector, collectorId, unbound, refreshKey]);
  useEffect(() => { if (detailRef.current && !unbound) void loadDetail(detailRef.current.title.id, true); }, [refreshKey]);
  function change(key: keyof CollectionFilters, value: string) { setFilters(previous => ({ ...previous, [key]: value, ...(key === 'financialStatus' ? { queue: value === 'VALIDATED' ? 'history' : value === '' || value === 'PENDING_VALIDATION' ? 'all' : 'active' } : {}) })); setPage(0); }
  async function loadDetail(id: string, preserve = false) {
    detailAbort.current?.abort(); const abort = new AbortController(); detailAbort.current = abort;
    setSelectedId(id); setDetailLoading(true); setDetailError('');
    try {
      const result = await readCollectionDetail(id, isCollector, collectorId, abort.signal); if (abort.signal.aborted || !mounted.current) return;
      const previous = detailRef.current;
      const wasDirty = preserve && (previous?.title.id === result.title.id ? collectionDraftKey(draftRef.current) !== collectionDraftKey(collectionDraft(previous)) : collectionDraftKey(draftRef.current) !== collectionDraftKey(emptyDraft));
      const changedWithDraft = wasDirty && (!previous || previous.title.revision !== result.title.revision || previous.case.revision !== result.case.revision);
      setDetail(result); setContactTarget({ titleId: result.title.id, customerKey: result.title.customer_key }); setRecovery(null); setAssignment(result.title.collector_id ?? '');
      if (!preserve) { setDraft(collectionDraft(result)); setAssignmentReason(''); requireRebase(false); }
      else if (changedWithDraft) requireRebase(true);
      else if (!wasDirty && !rebaseRef.current) setDraft(collectionDraft(result));
      setBlocked(!!pendingRef.current || rebaseRef.current);
    } catch (error) {
      if (abort.signal.aborted || !mounted.current) return;
      const previous = detailRef.current;
      if (previous?.title.id === id && previous.timer.running) setRecovery({ id, revision: previous.title.revision, timer: previous.timer });
      setDetail(null); setBlocked(true); setDetailError(collectionError(error, 'Não foi possível consultar o atendimento. Atualize o detalhe antes de continuar.'));
    } finally { if (!abort.signal.aborted && mounted.current) setDetailLoading(false); }
  }
  function openTitle(id: string) {
    if (busy || id === detail?.title.id) return;
    if (running && running.title_id !== id) { setDetailError('Pause ou finalize o atendimento em andamento antes de abrir outro título.'); return; }
    if (contactGuard.pending) { setDetailError('Resolva a confirmação dos contatos antes de trocar de título.'); return; }
    if (contactGuard.dirty && !window.confirm('Há alterações não salvas nos contatos do órgão. Descartar essas alterações e abrir outro título?')) return;
    if (pendingRef.current) { setDetailError('Resolva a confirmação pendente antes de trocar de título.'); return; }
    if (dirty && !window.confirm('Há alterações não salvas neste atendimento. Descartar o rascunho e abrir outro título?')) return;
    setDetail(null); setContactTarget(null); setDraft(emptyDraft); setRecovery(null); setNotice(''); setBlocked(false); requireRebase(false); void loadDetail(id);
    if (window.matchMedia('(max-width: 1050px)').matches) window.setTimeout(() => casePanel.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0);
  }
  async function execute(request: FrozenRequest) {
    const client = supabase; if (!client || busy) return;
    freeze(request); setBusy(true); setDetailError(''); setNotice('');
    try {
      const result = await client.rpc(request.rpc, request.body).retry(false); if (result.error) throw result.error;
      const timer = request.rpc === 'collection_work_action' ? result.data : (result.data as CollectionSaveResult)?.timer;
      if (!validCollectionTimer(timer) || timer.title_id !== request.titleId) throw new Error('unknown_result');
      if (request.rpc === 'save_collection_case' && (result.data?.title_id !== request.titleId || !Number.isSafeInteger(result.data?.revision) || !Number.isSafeInteger(result.data?.case_revision) || result.data?.finished !== (request.kind === 'finish'))) throw new Error('unknown_result');
      if (!mounted.current) return;
      freeze(null); setBlocked(false); setRefresh(value => value + 1); setRecovery(null);
      setActiveTimer(timer.running ? timer : null);
      if (!request.globalRecovery) await loadDetail(request.titleId, request.kind === 'start' || request.kind === 'pause');
      setNotice(request.kind === 'finish' ? request.paid ? 'Pagamento informado. O título segue para validação em Contas a Receber; a comissão depende da confirmação financeira.' : 'Atendimento finalizado e registrado no histórico.' : request.kind === 'save' ? 'Andamento salvo na base central.' : request.kind === 'start' ? 'Atendimento iniciado.' : request.kind === 'pause' ? 'Atendimento pausado. O andamento pode ser salvo e o trabalho retomado depois.' : 'Intervalo indisponível finalizado; o histórico de tempo foi preservado.');
      onChange?.(); if (request.kind === 'finish') onFinish?.(request.paid);
    } catch (error) {
      if (!mounted.current) return;
      const known = ['40001', '42501', '23514', '22023', '55000', 'P0029', 'PGRST301', 'PGRST303'].includes(errorCode(error));
      if (known) freeze(null); setBlocked(known ? !['23514', '22023', '55000', 'P0029'].includes(errorCode(error)) : true);
      if (errorCode(error) === 'P0029') setRefresh(value => value + 1);
      setDetailError(collectionError(error, 'Não foi possível confirmar a operação. O envio foi preservado; repita a confirmação pendente com o mesmo protocolo ou atualize o detalhe.'));
      if (errorCode(error) === '42501') {
        const previous = detailRef.current; if (previous?.timer.running) setRecovery({ id: previous.title.id, revision: previous.title.revision, timer: previous.timer }); setDetail(null);
      }
    } finally { if (mounted.current) setBusy(false); }
  }
  function timerAction(action: 'START' | 'PAUSE') {
    if (!detail || !canWrite || busy || pending) return;
    if (action === 'START' && !canStart) { setDetailError(startReason || 'Atualize o título para conferir se o atendimento pode ser iniciado.'); return; }
    if (action === 'PAUSE' && !canPause) { setDetailError(!ready || !detailReady ? activationNotice : 'Pausar fica disponível somente enquanto este atendimento está em andamento.'); return; }
    void execute({ rpc: 'collection_work_action', body: { p_title_id: detail.title.id, p_action: action, p_expected_revision: detail.title.revision, p_request_id: crypto.randomUUID() }, kind: action === 'START' ? 'start' : 'pause', titleId: detail.title.id, paid: false, nextId: null });
  }
  function recoverInterval() {
    if (!canRecover || !activeTimer || actionWaiting || pending) return;
    if (!window.confirm('Finalizar apenas o intervalo do título que ficou indisponível? O tempo registrado será preservado; nenhum pagamento será confirmado.')) return;
    void execute({ rpc: 'collection_work_action', body: { p_title_id: activeTimer.title_id, p_action: 'FINISH', p_expected_revision: null, p_request_id: crypto.randomUUID() }, kind: 'recovery', titleId: activeTimer.title_id, paid: false, nextId: null, globalRecovery: true });
  }
  function save(finish: boolean, event?: FormEvent, markPaid = false) {
    event?.preventDefault(); if (!detail || !editable || busy || blocked || pending) return;
    const candidate = markPaid ? { ...draft, status: 'TÍTULO PAGO' as const } : draft;
    if (markPaid) setDraft(candidate);
    if (finish && !canFinish) { setDetailError('Inicie este atendimento antes de finalizar. Se já iniciou, uma pausa preserva a possibilidade de salvar e finalizar; atualize o detalhe para conferir.'); return; }
    if (finish && contactGuard.pending) { setDetailError('Resolva a confirmação dos contatos antes de finalizar o atendimento.'); return; }
    const day = collectionServerDay(detail.timer.server_now), paid = candidate.status === 'TÍTULO PAGO';
    if (candidate.observation.length > 5000 || candidate.nextAction.length > 1000 || !paid && candidate.nextDate && !collectionDate(candidate.nextDate) || paid && (!collectionDate(candidate.paymentDate) || candidate.paymentDate > day || candidate.paymentDate < '1900-01-01') || finish && (!detail.title.collector_id || !candidate.observation.trim() || !paid && (!candidate.nextAction.trim() || !collectionDate(candidate.nextDate) || candidate.nextDate < day))) {
      setDetailError(paid ? 'Para marcar como pago e finalizar, preencha a observação e a data real do pagamento, até hoje. Depois clique novamente em Marcar como título pago ou em Finalizar atendimento.' : 'Para finalizar, informe a observação, a próxima ação e uma data de retorno de hoje em diante. A responsável deve estar definida na importação.'); return;
    }
    if (finish && paid && !window.confirm(`Informar o pagamento do título ${detail.title.document} em ${dateLabel(candidate.paymentDate)}?\n\nEle seguirá para validação de Contas a Receber. O tempo será encerrado e a data será registrada na observação pelo servidor.`)) return;
    if (finish && contactGuard.dirty) {
      if (!window.confirm('Há alterações não salvas nos contatos do órgão. Descartar essas alterações e finalizar o atendimento?')) return;
      setContactDiscard(value => value + 1);
    }
    void execute({ rpc: 'save_collection_case', body: { p_title_id: detail.title.id, p_status: candidate.status, p_observation: candidate.observation.trim(), p_next_action: paid ? null : candidate.nextAction.trim() || null, p_next_date: paid ? null : candidate.nextDate || null, p_expected_revision: detail.title.revision, p_expected_case_revision: detail.case.revision, p_payment_date: paid ? candidate.paymentDate : null, p_finish: finish, p_request_id: crypto.randomUUID() }, kind: finish ? 'finish' : 'save', titleId: detail.title.id, paid, nextId: null });
  }
  async function assign(event: FormEvent) {
    event.preventDefault(); if (!ready || !detailReady || !detail || !canManage || isCollector || busy || blocked || !assignmentReason.trim() || !agents.some(agent => agent.id === assignment && agent.enabled)) return;
    if (!window.confirm(`Atribuir os títulos ativos deste cliente à cobradora selecionada?\n\nA alteração usa a atribuição oficial do cliente e preserva o histórico. Motivo: ${assignmentReason.trim()}`)) return;
    setBusy(true); setDetailError('');
    try {
      if (!supabase) throw { code: 'PGRST301' };
      const result = await supabase.rpc('assign_receivable_collector', { p_customer_key: detail.title.customer_key, p_collector_id: assignment, p_observation: assignmentReason.trim() }).retry(false);
      if (result.error) throw result.error;
      if (!Number.isSafeInteger(result.data) || result.data < 0) throw new Error('unknown_assignment');
      if (!mounted.current) return; await loadDetail(detail.title.id, true); setAssignmentReason(''); setRefresh(value => value + 1); setNotice('Responsável atualizado pela atribuição oficial do cliente.'); onChange?.();
    } catch (error) { if (mounted.current) { setBlocked(true); setDetailError(collectionError(error, 'Não foi possível confirmar a atribuição. Atualize o detalhe e confira o responsável antes de tentar novamente.')); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function exportCsv() {
    if (!list?.count || exporting || loading) return;
    const abort = new AbortController(); exportAbort.current = abort; const frozen = { ...filters }; setExporting(true); setExportStatus('Preparando a exportação…'); setListError('');
    try {
      const before = await readCollectionWorkbench(frozen, 0, 1, isCollector, collectorId, abort.signal);
      if (before.count > 100000) throw new Error('limit');
      const token = (value: CollectionWorkbench) => `${value.as_of_date}:${value.snapshot_revision}:${value.count}:${value.total_cents}`;
      const rows: CollectionRow[] = [];
      for (let offset = 0; rows.length < before.count; offset += 500) {
        const result = await readCollectionWorkbench(frozen, offset, 500, isCollector, collectorId, abort.signal);
        if (token(result) !== token(before) || !result.rows.length) throw new Error('changed'); rows.push(...result.rows);
        setExportStatus(`Preparando ${rows.length.toLocaleString('pt-BR')} de ${before.count.toLocaleString('pt-BR')} títulos…`);
      }
      const after = await readCollectionWorkbench(frozen, 0, 1, isCollector, collectorId, abort.signal);
      if (token(before) !== token(after) || rows.length !== before.count || new Set(rows.map(row => row.id)).size !== rows.length || rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n) !== BigInt(before.total_cents)) throw new Error('changed');
      if (!abort.signal.aborted) { downloadCollectionCsv(rows, before.as_of_date); setExportStatus(`${rows.length.toLocaleString('pt-BR')} títulos exportados com os filtros selecionados.`); }
    } catch (error) { if (!abort.signal.aborted) { setExportStatus(''); setListError(collectionError(error, error instanceof Error && error.message === 'changed' ? 'A base mudou durante a exportação. Atualize os títulos e tente novamente.' : error instanceof Error && error.message === 'limit' ? 'A exportação excede 100.000 títulos. Restrinja os filtros.' : 'Não foi possível exportar a carteira. Nenhum arquivo parcial foi gerado.')); } }
    finally { if (!abort.signal.aborted) setExporting(false); }
  }
  const mainTimer = detail ? (canWrite ? detail.timer.actor_total_seconds : detail.timer.total_seconds) + (detail.timer.running ? tick : 0) : 0;
  return <section className="collection-desk" aria-labelledby="collection-desk-title">
    <div className="panel collection-desk-header"><div className="panel-header"><div><h2 id="collection-desk-title">Central operacional da cobrança</h2><p className="muted">{isCollector ? 'Sua carteira vencida e seus atendimentos na base central.' : 'Carteiras vencidas, responsáveis e próximos contatos.'}</p></div><button type="button" className="button secondary" disabled={loading || busy || unbound} onClick={() => setRefresh(value => value + 1)}>Atualizar títulos</button></div>
      {unbound ? <p className="notice" role="status">Seu login ainda não está vinculado a uma cobradora. Peça à Gerência Geral para configurar o vínculo. Nenhuma carteira está disponível até essa configuração.</p> : <>
        <form className="collection-desk-filters" onSubmit={event => { event.preventDefault(); setFilters(previous => ({ ...previous, search })); setPage(0); }}>
          <label className="field collection-search">Buscar na carteira<input value={search} onChange={event => setSearch(event.target.value)} maxLength={200} placeholder="Cliente, documento, status ou observação" /></label>
          {!isCollector && <label className="field">Cobradora<select value={filters.collector} onChange={event => change('collector', event.target.value)}><option value="">Todas as carteiras</option><option value="unassigned">Sem cobradora definida</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.display_name}{agent.enabled ? '' : ' (inativa)'}</option>)}</select></label>}
          <label className="field">Faixa de atraso<select value={filters.band} onChange={event => change('band', event.target.value)}><option value="">Todas as faixas</option>{COLLECTION_BANDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field">Ordenar carteira<select value={filters.sort} onChange={event => change('sort', event.target.value)}>{COLLECTION_SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field">Status da cobrança<select value={filters.status} onChange={event => change('status', event.target.value)}><option value="">Todos os status</option>{COLLECTION_STATUSES.map(value => <option key={value}>{value}</option>)}</select></label>
          <button type="submit" className="button secondary">Aplicar busca</button><button type="button" className="button secondary" onClick={() => { setSearch(''); setFilters({ ...INITIAL_COLLECTION_FILTERS }); setPage(0); }}>Limpar filtros</button>
        </form>
        <details className="collection-extra-filters" open={!!(filters.dueStart || filters.dueEnd || filters.nextAction || filters.financialStatus !== 'ACTIVE')}><summary>Vencimentos e situação financeira</summary><div className="form-grid"><label className="field">Vencimento inicial<input type="date" max={list ? addCivilDays(list.as_of_date, -1) : undefined} value={filters.dueStart} onChange={event => change('dueStart', event.target.value)} /></label><label className="field">Vencimento final<input type="date" max={list ? addCivilDays(list.as_of_date, -1) : undefined} value={filters.dueEnd} onChange={event => change('dueEnd', event.target.value)} /></label><label className="field">Situação financeira<select value={filters.financialStatus} onChange={event => change('financialStatus', event.target.value)}><option value="">Todos, incluindo histórico</option>{Object.entries(FINANCIAL_STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field">Próxima ação da carteira<select value={filters.nextAction} onChange={event => change('nextAction', event.target.value)}><option value="">Todas as próximas ações</option>{Object.entries(nextActions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div></details>
        <div className="collection-filter-meta"><p>{loading ? 'Consultando a carteira…' : list ? <><strong>{list.count.toLocaleString('pt-BR')} título(s)</strong> · <strong>{formatCents(list.total_cents)}</strong> no filtro · posição {dateLabel(list.as_of_date)}</> : 'Carteira indisponível.'}</p><button type="button" className="button secondary" disabled={loading || exporting || !list?.count} onClick={() => void exportCsv()}>{exporting ? 'Exportando…' : 'Baixar CSV dos filtros'}</button></div>
      </>}
      {canWrite && list && !ready && <p className="notice" role="status">{activationNotice}</p>}
      {ready && list?.priority && list.priority.due_count > 0 && <p className="notice">{list.priority.due_count} retorno(s) devido(s) nesta carteira. Retornos com data até hoje têm prioridade; agendamentos futuros não bloqueiam novos atendimentos.<button type="button" className="button secondary" onClick={() => { setSearch(''); setFilters({ ...INITIAL_COLLECTION_FILTERS, collector: filters.collector, queue: 'returns', sort: 'next_date_asc' }); setPage(0); }}>Abrir retornos devidos</button></p>}
      {listError && <p className="notice error" role="alert">{listError}</p>}{agentError && <p className="notice error" role="alert">{agentError}</p>}{notice && <p className="notice success" role="status">{notice}</p>}{exportStatus && <p className="help-text" role="status">{exportStatus}</p>}
    </div>
    {activeTimer && (activeTimer.title_id !== detail?.title.id || canRecover) && canWrite && <div className="notice collection-active-timer"><p><strong>Existe um atendimento em andamento.</strong> {canRecover ? 'O título ficou indisponível para cobrança; somente o encerramento deste intervalo está autorizado.' : 'Abra esse atendimento para pausar, salvar ou finalizar antes de iniciar outro.'}</p>{canRecover ? <button type="button" className="button secondary" disabled={actionWaiting || !!pending} onClick={recoverInterval}>Finalizar intervalo indisponível</button> : <button type="button" className="button secondary" disabled={actionWaiting || !!pending} onClick={() => openTitle(activeTimer.title_id)}>Abrir atendimento em andamento</button>}</div>}
    {!unbound && <div className="collection-desk-layout"><div className="panel collection-desk-list"><div className="table-wrap"><table className="data-table"><caption className="sr-only">Títulos vencidos da carteira de cobrança</caption><thead><tr><th>Cliente</th><th>Doc.</th><th>Empresa</th><th>Vencimento</th><th>Dias</th><th>Valor</th><th>Cobradora</th><th>Status</th><th>Abrir</th></tr></thead><tbody>{loading ? <tr><td colSpan={9} className="empty-state">Carregando títulos…</td></tr> : list?.rows.length ? list.rows.map(row => <tr key={row.id} className={row.id === detail?.title.id ? 'collection-row-selected' : ''}><td><strong>{row.client_name}</strong></td><td>{row.document}</td><td>{row.branch}</td><td>{dateLabel(row.due_date)}</td><td>{row.delay_days}</td><td className="collection-money">{formatCents(row.amount_cents)}</td><td>{row.collector_name || 'Sem cobradora definida'}</td><td><span className="collection-case-status">{row.operational_label || row.operational_status}</span>{row.status === 'PENDING_VALIDATION' && <small>Aguardando validação financeira</small>}{row.status === 'NOT_LOCATED' && <small>Pagamento não localizado — cobrar novamente</small>}{row.status === 'VALIDATED' && <small>Quitado — validado</small>}</td><td><button type="button" className="button secondary" aria-label={`Abrir título ${row.document}`} disabled={busy || detailLoading || !!running && running.title_id !== row.id} onClick={() => openTitle(row.id)}>Abrir →</button></td></tr>) : <tr><td colSpan={9} className="empty-state">{listError ? 'Lista indisponível.' : 'Nenhum título vencido para os filtros selecionados.'}</td></tr>}</tbody></table></div><div className="pagination"><span>{list?.count ?? 0} título(s) · Página {page + 1} de {Math.max(1, Math.ceil((list?.count ?? 0) / 25))}</span><button type="button" className="button secondary" disabled={loading || page === 0} onClick={() => setPage(value => value - 1)}>Anterior</button><button type="button" className="button secondary" disabled={loading || (page + 1) * 25 >= (list?.count ?? 0)} onClick={() => setPage(value => value + 1)}>Próxima</button></div></div>
      <aside ref={casePanel} className="panel collection-case-panel" role="region" aria-labelledby="collection-case-heading"><div className="panel-header"><h2 id="collection-case-heading">Atendimento do título</h2>{selectedId && <button type="button" className="button secondary" disabled={busy || detailLoading || contactGuard.pending} onClick={() => void loadDetail(selectedId, true)}>Atualizar detalhe</button>}</div>
        {detailLoading && <p className="help-text">Carregando atendimento…</p>}{detailError && <p className="notice error" role="alert">{detailError}</p>}
        {pending && <div className="notice"><p>A confirmação deste envio está pendente. O rascunho e o mesmo protocolo foram preservados; nenhum novo envio será criado.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void execute(pending)}>Repetir confirmação pendente</button></div>}
        {!detail && !detailLoading && <p className="help-text">Selecione um título para trabalhar.</p>}
        {recovery && !detail && !canRecover && canWrite && <p className="notice">O intervalo foi preservado. Atualize os títulos para conferir a disponibilidade do atendimento antes de encerrar.</p>}
        {detail && <><h3 className="collection-client-title">{detail.title.client_name}</h3><p className="collection-case-caption">Doc. {detail.title.document} · {detail.title.branch} · venc. {dateLabel(detail.title.due_date)} · <strong>{detail.title.delay_days} dias</strong> · {formatCents(detail.title.amount_cents)}</p></>}
        {contactTarget && <CollectionCustomerContext key={contactTarget.titleId} titleId={contactTarget.titleId} customerKey={contactTarget.customerKey} enabled={!!detail && detail.title.id === contactTarget.titleId && detail.title.status !== 'VALIDATED' && detail.title.due_date < collectionServerDay(detail.timer.server_now)} canEdit={canWrite || canManage} refreshKey={contactsRefreshKey} discardKey={contactDiscard} onGuardChange={setContactGuard} onChange={onContactsChange} />}
        {detail && <>
          <div className={`collection-work-timer${detail.timer.running ? ' running' : ''}`}><span>{canWrite ? 'Seu tempo neste título' : 'Tempo de trabalho do título'}</span><strong role="timer" aria-label="Tempo do atendimento" aria-live="off">{workTime(mainTimer)}</strong><small>{detail.timer.running ? 'Atendimento em andamento' : detail.workflow?.started ? 'Atendimento pausado; o andamento e o tempo foram preservados' : 'Sem intervalo ativo; clique em Iniciar para trabalhar'}</small></div>
          <p className="help-text">Tempo total do título: {workTime(detail.timer.total_seconds + (detail.timer.running ? tick : 0))} · {detail.title.collector_name || 'Sem cobradora definida'}</p>
          {canWrite && (!ready || !detailReady) && <p className="notice">{activationNotice}</p>}
          {!canWrite && <p className="notice">Consulta em modo de leitura. Somente perfis autorizados registram o atendimento.</p>}
          {detail.title.operational_label === 'Sem status operacional' && <p className="notice">Este título possui atendimento histórico sem status operacional definido. A seleção abaixo será registrada somente ao salvar um novo andamento.</p>}
          {detail.title.status === 'PENDING_VALIDATION' && <p className="notice">Pagamento aguardando validação financeira em Contas a Receber. O título saiu da fila de atendimentos ativos; a comissão depende da confirmação do recebimento.</p>}
          {detail.title.status === 'VALIDATED' && <p className="notice">Recebimento validado. Este registro está disponível somente para consulta do histórico.</p>}
          {rebaseRequired && <div className="notice collection-draft-conflict"><p><strong>O título ou o andamento mudou no banco.</strong> Seu rascunho foi preservado e a gravação continua bloqueada. Confira a versão atual antes de escolher como continuar.</p><p>Status no banco: {detail.case.status}<br />Observação no banco: {detail.case.observation || 'Não informada'}<br />Próxima ação no banco: {detail.case.next_action || 'Não informada'}{detail.case.next_date ? ` · ${dateLabel(detail.case.next_date)}` : ''}</p><div className="collection-case-buttons"><button type="button" className="button secondary" disabled={busy || !!pending} onClick={() => { setDraft(collectionDraft(detail)); requireRebase(false); setBlocked(false); setDetailError(''); }}>Carregar versão do banco</button>{canWrite && <button type="button" className="button secondary" disabled={busy || !!pending} onClick={() => { requireRebase(false); setBlocked(false); setDetailError(''); setNotice('Rascunho mantido após a conferência da versão atual. Revise os campos antes de salvar.'); }}>Manter rascunho após conferência</button>}</div></div>}
          <form className="collection-case-editor" onSubmit={event => save(false, event)}><fieldset disabled={!editable || busy || blocked || detailLoading}><label className="field">Cobradora responsável<input value={detail.title.collector_name || 'Sem cobradora definida'} readOnly /></label><label className="field">Status do atendimento<select value={draft.status} onChange={event => setDraft(previous => ({ ...previous, status: event.target.value as CollectionDraft['status'] }))}>{COLLECTION_STATUSES.map(status => <option key={status}>{status}</option>)}</select></label>
            {draft.status === 'TÍTULO PAGO' && <label className="field collection-paid-date-field">Data do pagamento informado<input type="date" min="1900-01-01" max={collectionServerDay(detail.timer.server_now)} value={draft.paymentDate} onChange={event => setDraft(previous => ({ ...previous, paymentDate: event.target.value }))} /><small>Informar o pagamento não confirma o recebimento financeiro.</small></label>}
            <label className="field collection-observation-field">Observações<textarea value={draft.observation} onChange={event => setDraft(previous => ({ ...previous, observation: event.target.value }))} maxLength={5000} placeholder="Registre o contato, o retorno e os detalhes do atendimento" /></label><label className="field">Próxima ação<input readOnly={draft.status === 'TÍTULO PAGO'} value={draft.status === 'TÍTULO PAGO' ? 'Aguardar validação financeira' : draft.nextAction} onChange={event => setDraft(previous => ({ ...previous, nextAction: event.target.value }))} maxLength={1000} placeholder="Ex.: ligar novamente / enviar e-mail" /></label><label className="field">Data da próxima ação<input type="date" min="1900-01-01" disabled={draft.status === 'TÍTULO PAGO'} value={draft.status === 'TÍTULO PAGO' ? '' : draft.nextDate} onChange={event => setDraft(previous => ({ ...previous, nextDate: event.target.value }))} /></label>
            {editable && <div className="collection-case-buttons"><button type="submit" className="button secondary" disabled={!dirty || paidDateInvalid}>Salvar andamento</button><button type="button" className="button" disabled={!canFinish} onClick={() => save(true)}>Finalizar atendimento</button><button type="button" className="button secondary" disabled={!canFinish} onClick={() => save(true, undefined, true)}>Marcar como título pago</button></div>}</fieldset></form>
          {canWrite && <div className="collection-timer-buttons"><button type="button" className="button secondary" disabled={!canStart} onClick={() => timerAction('START')}>Iniciar</button><button type="button" className="button secondary" disabled={!canPause} onClick={() => timerAction('PAUSE')}>Pausar</button></div>}
          {canWrite && <div className="help-text" aria-live="polite"><p>{startReason || 'Iniciar está disponível; o cronômetro usa os registros oficiais do servidor.'}</p>{!detail.timer.running && <p>Pausar fica disponível somente enquanto o atendimento está em andamento.</p>}{saveReason && <p>{saveReason}</p>}{ready && detailReady && !detail.workflow?.can_finish && writableTitle && <p>Finalizar e marcar como pago exigem que este atendimento tenha sido iniciado. Pausar preserva essa possibilidade.</p>}{draft.status === 'TÍTULO PAGO' && <p>Salvar andamento preserva somente o rascunho. Informe a data e a observação; Marcar como título pago ou Finalizar atendimento envia o pagamento para validação financeira e encerra o intervalo.</p>}</div>}
          {dirty && <p className="help-text">Há alterações ainda não salvas neste atendimento.</p>}
          {canManage && !isCollector && detail.title.status !== 'VALIDATED' && <details className="collection-assignment"><summary>Gerenciar responsável</summary><p className="help-text">A atribuição oficial afeta os títulos ativos do mesmo cliente e preserva o histórico.</p><form onSubmit={event => void assign(event)}><fieldset disabled={!ready || !detailReady || busy || blocked || detailLoading}><label className="field">Nova cobradora<select value={assignment} onChange={event => setAssignment(event.target.value)}><option value="">Selecione a responsável</option>{agents.filter(agent => agent.enabled).map(agent => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}</select></label><label className="field">Motivo da atribuição<textarea value={assignmentReason} onChange={event => setAssignmentReason(event.target.value)} maxLength={5000} required /></label><button type="submit" className="button secondary" disabled={!assignment || !assignmentReason.trim() || assignment === detail.title.collector_id}>Atribuir cobradora</button></fieldset></form></details>}
          <div className="collection-case-history"><h3>Histórico do título</h3>{detail.history.length ? <ol>{detail.history.map(event => <li key={event.id}><strong>{actionLabels[event.action] || event.action}</strong><time>{collectionDateTime(event.created_at)}</time>{event.observation && <p>{event.observation}</p>}{event.return_note && <p>{event.return_note}</p>}{event.payment_date && <small>Pagamento informado: {dateLabel(event.payment_date)}</small>}</li>)}</ol> : <p className="help-text">Nenhuma ação de cobrança registrada.</p>}</div>
          {!!detail.case_history?.length && <details className="collection-case-history"><summary>Andamentos salvos</summary><ol>{detail.case_history.map(event => <li key={event.id}><strong>{event.status}</strong><time>{collectionDateTime(event.created_at)} · {event.finalized ? 'Finalizado' : 'Rascunho salvo'}</time>{event.observation && <p>{event.observation}</p>}{event.next_action && <p>Próxima ação: {event.next_action}{event.next_date ? ` · ${dateLabel(event.next_date)}` : ''}</p>}</li>)}</ol></details>}
        </>}
      </aside>
    </div>}
  </section>;
}
