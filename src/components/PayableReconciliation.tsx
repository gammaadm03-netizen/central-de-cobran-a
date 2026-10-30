import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents, isPayableAdministrativeWriteoff, isPayableReportPaid, type PayableTitle } from '../lib/payables';
import { addCivilDays } from '../lib/financial-dates';
import { officialToday, parseBRLCents } from './Treasury';
import { hasPayableChequeNumber, payableChequePaymentBank } from '../lib/payable-cheque-bank';
import '../payable-reconciliation.css';

export interface FinancialPayableTitle extends PayableTitle {
  cheque_number?: string | null;
  last_import_id: string;
  paid_cents: number;
  outstanding_cents: number;
  payment_remaining_cents: number;
  overpaid_cents: number;
  financial_status: NonNullable<PayableTitle['financial_status']>;
  payment_revision: string | null;
}
interface PaymentAccount { id: string; company: string; bank: string; account_label: string; account_type: 'BANK' | 'CASH'; display_name: string }
interface PaymentRow {
  id: string; request_id: string; title_id: string; entry_number: string; description: string; branch: string;
  cheque_number?: string | null;
  macro_snapshot: string; effective_macro?: string; plan_snapshot: string; amount_cents: number; paid_on: string; bank_label: string;
  created_at: string; created_by: string; created_by_name: string; created_by_username: string;
  cancelled_at: string | null; cancelled_by_name: string | null; cancellation_observation: string | null;
  observation: string; status: 'ACTIVE' | 'CANCELLED';
}
interface Revision { import_id: string | null; financial_revision: string }
interface PaymentList { rows: PaymentRow[]; count: number; revision: Revision }
interface PaymentSummary { total_paid_cents: number; payment_count: number; by_macro: { macro: string; amount_cents: number; count: number }[]; pending_reconciliation_count: number; revision: Revision }
type PaymentRequest = { kind: 'payment'; args: { p_title_id: string; p_amount_cents: number; p_paid_on: string; p_bank_account_id: string; p_observation: string; p_expected_revision: string | null; p_request_id: string; p_expected_import_id: string } };
type ReversalRequest = { kind: 'reversal'; args: { p_payment_id: string; p_observation: string; p_expected_revision: string | null } };
type Mutation = PaymentRequest | ReversalRequest;
const PAGE_SIZE = 25;
const financialLabels: Record<FinancialPayableTitle['financial_status'], string> = { OPEN: 'Em aberto', PARTIAL: 'Pendência de registro anterior', PAID: 'Pago integralmente', OVERPAID: 'Pagamento acima do valor atualizado', PENDING_RECONCILIATION: 'Ausente da base · aguardando conciliação', ADMIN_WRITEOFF: 'BAIXADO SEM PAGAMENTO', REPORT_PAID: 'Pago' };
function validDate(value: string) { try { return value >= '1900-01-01' && value <= officialToday() && addCivilDays(value, 0) === value; } catch { return false; } }
function inputCents(value: number) { return `${BigInt(value) / 100n},${String(BigInt(value) % 100n).padStart(2, '0')}`; }
function chequeLabel(value: string | null | undefined) { return typeof value === 'string' && value.trim() ? value.trim() : 'Não informado'; }
function validUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value); }
function errorCode(value: unknown) { return value && typeof value === 'object' && 'code' in value ? String(value.code) : ''; }
function readError(value: unknown) {
  const code = errorCode(value);
  if (code === 'PGRST202' || code === '42P01') return 'A conciliação de pagamentos precisa da atualização do banco de dados. Os títulos importados continuam preservados.';
  if (code === '42501') return 'Seu perfil não tem permissão para consultar esta operação.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  return 'Não foi possível consultar os pagamentos. Atualize a conciliação para tentar novamente.';
}
function sameRevision(left?: Revision, right?: Revision) { return !!left && !!right && left.import_id === right.import_id && left.financial_revision === right.financial_revision; }

function PaymentTable({ rows, titleHistory = false, onReverse, onOpenTitle, disabled = false }: { rows: PaymentRow[]; titleHistory?: boolean; onReverse?: (payment: PaymentRow) => void; onOpenTitle?: (titleId: string) => void; disabled?: boolean }) {
  return <div className="table-wrap"><table className="data-table"><caption className="sr-only">{titleHistory ? 'Histórico de pagamentos do título, incluindo estornos' : 'Pagamentos realizados por data efetiva'}</caption><thead><tr><th>Data do pagamento</th>{!titleHistory && <><th>Lançamento / Favorecido</th><th>Centro de Custo Macro</th></>}<th>Banco / conta do pagamento</th><th>Nº cheque registrado</th><th>Valor pago</th><th>Registro / responsável</th><th>Observação / situação</th>{onReverse && <th>Ação</th>}</tr></thead><tbody>{rows.map(row => <tr key={row.id} className={row.cancelled_at ? 'payable-payment-reversed' : undefined}><td>{dateLabel(row.paid_on)}</td>{!titleHistory && <><td>{onOpenTitle ? <button type="button" className="button secondary" aria-label={`Abrir título ${row.entry_number}`} disabled={disabled} onClick={() => onOpenTitle(row.title_id)}>{row.entry_number}</button> : <strong>{row.entry_number}</strong>}<small>{row.description} · Filial {row.branch}</small></td><td>{row.effective_macro ?? row.macro_snapshot}</td></>}<td>{row.bank_label}</td><td>{chequeLabel(row.cheque_number)}</td><td className="payable-payment-money">{formatCents(row.amount_cents)}</td><td>{dateLabel(row.created_at)}<small>{row.created_by_name || row.created_by_username || 'Responsável registrado'}</small></td><td>{row.observation || '—'}{titleHistory && <small>Macro registrado: {row.macro_snapshot}{row.effective_macro && row.effective_macro !== row.macro_snapshot ? ` · Corrigido para: ${row.effective_macro}` : ''}</small>}{row.cancelled_at ? <small className="payable-payment-cancelled">Estornado em {dateLabel(row.cancelled_at)} · {row.cancelled_by_name || 'Responsável registrado'}<br />{row.cancellation_observation}</small> : <small>Pagamento confirmado</small>}</td>{onReverse && <td>{!row.cancelled_at && <button className="button secondary" disabled={disabled} onClick={() => onReverse(row)}>Estornar pagamento</button>}</td>}</tr>)}</tbody></table></div>;
}

function PaymentEditor({ title, accounts, accountsLoading, canWrite, onClose, onChanged }: { title: PayableTitle; accounts: PaymentAccount[]; accountsLoading: boolean; canWrite: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<FinancialPayableTitle | null>(null);
  const [history, setHistory] = useState<PaymentRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadedPage, setLoadedPage] = useState(-1);
  const [refresh, setRefresh] = useState(0);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(() => addCivilDays(officialToday(), -1));
  const [bank, setBank] = useState('');
  const [observation, setObservation] = useState('');
  const [reversal, setReversal] = useState<PaymentRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [recovery, setRecovery] = useState<Mutation | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const container = useRef<HTMLElement>(null);
  const numberedCheque = hasPayableChequeNumber((detail ?? title).cheque_number);
  const chequeBank = payableChequePaymentBank(accounts);
  const paymentBank = numberedCheque ? chequeBank?.id ?? '' : bank;
  useEffect(() => { container.current?.focus(); }, []);
  useEffect(() => {
    const client = supabase; if (!client) { setError('Conexão indisponível.'); setLoading(false); return; }
    const abort = new AbortController(); setLoading(true); setLoadedPage(-1); setHistory([]);
    void Promise.all([
      // A coluna cheque_number só existe a partir da atualização 019.
      // Selecionar a view mantém a consulta compatível com bancos 015–018.
      client.from('payable_financial_titles').select('*').eq('id', title.id).abortSignal(abort.signal).single().retry(false),
      client.rpc('list_payable_payments', { p_start: null, p_end: null, p_offset: page * PAGE_SIZE, p_limit: PAGE_SIZE, p_title_id: title.id, p_macro: null, p_bank_account_id: null }).abortSignal(abort.signal).retry(false),
    ]).then(([source, events]) => {
      if (abort.signal.aborted) return;
      if (source.error) throw source.error;
      if (events.error) throw events.error;
      const latest = source.data as FinancialPayableTitle;
      const records = events.data as PaymentList;
      if (!latest || !Number.isSafeInteger(latest.payment_remaining_cents) || !Array.isArray(records?.rows) || !Number.isSafeInteger(records.count)) throw new Error('read');
      setDetail(latest); setCount(records.count);
      const last = Math.max(0, Math.ceil(records.count / PAGE_SIZE) - 1);
      if (page > last) { setPage(last); return; }
      setHistory(records.rows); setLoadedPage(page);
      setAmount(latest.payment_remaining_cents ? inputCents(latest.payment_remaining_cents) : '');
      setBlocked(false); setReviewed(true); setError('');
    }).catch(failure => { if (!abort.signal.aborted) { setError(readError(failure)); setBlocked(true); setReviewed(false); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [title.id, page, refresh]);

  async function execute(request: Mutation) {
    if (!canWrite || busy || isPayableAdministrativeWriteoff(detail ?? title) || request.kind === 'payment' && isPayableReportPaid(detail ?? title)) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      if (!supabase) throw new Error('connection');
      const result = request.kind === 'payment' ? await supabase.rpc('register_payable_payment', request.args).retry(false) : await supabase.rpc('cancel_payable_payment', request.args).retry(false);
      if (result.error) throw result.error;
      if (!validUuid(result.data)) throw new Error('unconfirmed');
      setRecovery(null); setReviewed(false); setBlocked(false); setObservation(''); setReversal(null); setReason('');
      setPage(0); setRefresh(value => value + 1); onChanged();
      setSuccess(request.kind === 'payment' ? `Pagamento de ${formatCents(request.args.p_amount_cents)} em ${dateLabel(request.args.p_paid_on)} registrado. O realizado considera a data efetiva do pagamento.` : 'Pagamento estornado com histórico e auditoria. O valor foi retirado do realizado.');
    } catch (failure) {
      const code = errorCode(failure);
      if (code === 'P0016') { setRecovery(null); setBlocked(true); setReviewed(false); setError('A identificação deste título é ambígua. Confira as versões do lançamento e os pagamentos existentes antes de continuar. Nenhum pagamento desta tentativa foi registrado; seu preenchimento foi mantido.'); }
      else if (code === '40001') { setRecovery(null); setBlocked(true); setReviewed(false); setError('O título foi atualizado por outra conciliação ou importação. Nenhum pagamento desta tentativa foi registrado. Seu preenchimento foi mantido; confira o título e o histórico antes de continuar.'); }
      else if (['22023', '22003', '42501', 'PGRST301', 'PGRST303', 'PGRST202', '42P01'].includes(code)) {
        setRecovery(null);
        setError(code === '22023' ? 'O registro foi recusado. É permitido somente o valor integral a pagar. Confira o título, a data real, o banco e os registros anteriores.' : code === '22003' ? 'O valor excede o limite de precisão permitido.' : readError(failure));
      } else {
        setRecovery(request); setReviewed(false); setBlocked(true);
        setError('Não foi possível confirmar o resultado. Seu preenchimento e a identificação da solicitação foram preservados. Confira o título e o histórico; depois, se necessário, reenvie a mesma solicitação com segurança.');
      }
    } finally { setBusy(false); }
  }
  async function register(event: FormEvent) {
    event.preventDefault(); if (!canWrite || busy || loading || blocked || recovery || !detail || isPayableAdministrativeWriteoff(detail) || isPayableReportPaid(detail)) return;
    const cents = parseBRLCents(amount); setError(''); setSuccess('');
    if (numberedCheque && !chequeBank) { setError('Ative uma única conta bancária oficial BRADESCO F2G para registrar o pagamento deste cheque.'); return; }
    if (cents === null || cents <= 0 || cents !== detail.payment_remaining_cents || !validDate(paidOn) || !accounts.some(account => account.id === paymentBank) || !observation.trim()) { setError('Confirme o valor integral a pagar, a data real até hoje, o banco/conta e a observação. Para alterar o valor, corrija o título antes de registrar o pagamento.'); return; }
    if (!window.confirm(`Confirmar pagamento INTEGRAL?\n\nLançamento: ${detail.entry_number}\nData efetiva: ${dateLabel(paidOn)}\nBanco/conta: ${accounts.find(account => account.id === paymentBank)!.display_name}\nNº cheque da base: ${chequeLabel(detail.cheque_number)}\nValor integral a pagar: ${formatCents(cents)}\nSaldo após o pagamento: ${formatCents(0)}\n\nO realizado será atribuído ao macro ${detail.macro} na data efetiva do pagamento.`)) return;
    await execute({ kind: 'payment', args: { p_title_id: detail.id, p_amount_cents: cents, p_paid_on: paidOn, p_bank_account_id: paymentBank, p_observation: observation.trim(), p_expected_revision: detail.payment_revision, p_request_id: crypto.randomUUID(), p_expected_import_id: detail.last_import_id } });
  }
  async function reverse(event: FormEvent) {
    event.preventDefault(); if (!detail || !reversal || !canWrite || busy || loading || blocked || recovery || !reason.trim() || isPayableAdministrativeWriteoff(detail)) return;
    if (!window.confirm(`Estornar pagamento de ${formatCents(reversal.amount_cents)}?\n\nData do pagamento: ${dateLabel(reversal.paid_on)}\nBanco/conta: ${reversal.bank_label}\nMotivo: ${reason.trim()}\n\nO histórico será preservado e o valor sairá do realizado.`)) return;
    await execute({ kind: 'reversal', args: { p_payment_id: reversal.id, p_observation: reason.trim(), p_expected_revision: detail.payment_revision } });
  }
  const writtenOff = isPayableAdministrativeWriteoff(detail ?? title);
  const writable = canWrite && !writtenOff;
  const reportPaid = isPayableReportPaid(detail ?? title);
  const locked = busy || loading || accountsLoading || blocked || !!recovery || writtenOff;
  return <section className="panel payable-reconciliation-editor" aria-labelledby="payable-reconciliation-title" ref={container} tabIndex={-1}>
    <div className="panel-header"><div><h2 id="payable-reconciliation-title">Conciliação do título {title.entry_number}</h2><p className="muted">{title.description} · Filial {title.branch}</p></div><div className="inline-actions"><button className="button secondary" disabled={busy || loading} onClick={() => { setSuccess(''); setRefresh(value => value + 1); }}>Conferir título e histórico</button><button className="button secondary" disabled={busy || !!recovery} onClick={onClose}>Fechar conciliação</button></div></div>
    {loading && <p role="status">Carregando título e histórico de pagamentos…</p>}{error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {detail && <><dl className="payable-reconciliation-title-metrics"><div><dt>Valor atualizado do título</dt><dd>{formatCents(detail.amount_cents)}</dd></div><div><dt>Já pago e confirmado</dt><dd>{formatCents(detail.paid_cents)}</dd></div><div><dt>Restante para conciliar</dt><dd>{formatCents(detail.payment_remaining_cents)}</dd></div><div><dt>Situação financeira</dt><dd>{financialLabels[detail.financial_status]}</dd></div></dl><p className="help-text payable-source-cheque"><strong>Nº cheque informado na base: </strong><span>{chequeLabel(detail.cheque_number)}</span></p><p className="help-text">Vencimento da base: {dateLabel(detail.due_date)} · Banco previsto (Plano cc): {detail.bank_account || 'não informado'} · Plano cp: {detail.plan} · Macro atual: {detail.macro}. O histórico preserva o macro e o banco usados no registro; correções de classificação ficam registradas.</p>{!writtenOff && !reportPaid && detail.status === 'SETTLED_IMPORT' && detail.paid_cents === 0 && <p className="notice">Este título desapareceu do relatório completo. Informe os pagamentos reais para registrar valores realizados; a ausência na importação, sozinha, não comprova valor, data nem banco do pagamento.</p>}{detail.overpaid_cents > 0 && <p className="notice error">Os pagamentos excedem o valor atualizado do título em {formatCents(detail.overpaid_cents)}. Confira a alteração da base e os registros; nenhum pagamento histórico foi modificado.</p>}</>}
    {reportPaid && <p className="notice"><strong>Pago pelo relatório diário.</strong> O título saiu da relação de abertos. Esta atualização altera o status e não cria valor realizado, data real ou banco de pagamento. Os pagamentos efetivos já registrados permanecem no histórico. Se o título voltar ao relatório, a previsão será reaberta automaticamente.</p>}
    {writtenOff && <p className="notice"><strong>BAIXADO SEM PAGAMENTO.</strong> O valor original foi preservado e retirado dos totais. A baixa administrativa não registra pagamento.{detail?.administrative_writeoff_at && <> Registrada em {dateLabel(detail.administrative_writeoff_at)}.</>}{detail?.administrative_writeoff_reason && <> Motivo: {detail.administrative_writeoff_reason}.</>}{detail?.administrative_writeoff_by && <> Responsável: {detail.administrative_writeoff_by}.</>}</p>}
    {recovery && !writtenOff && <div className="notice payable-payment-recovery"><p>A solicitação permanece protegida contra duplicação. O reenvio usa os mesmos dados e a mesma identificação.</p><button className="button secondary" disabled={busy || loading || !reviewed} onClick={() => { if (window.confirm('Reenviar exatamente a mesma solicitação? Se o registro já tiver sido concluído, ele será confirmado sem criar outro.')) void execute(recovery); }}>{busy ? 'Conferindo solicitação…' : 'Reenviar a mesma solicitação com segurança'}</button></div>}
    {writable && !reportPaid && detail && detail.payment_remaining_cents > 0 && <form className="payable-payment-form" onSubmit={event => void register(event)}><fieldset disabled={locked}><legend>Registrar pagamento integral</legend><div className="form-grid"><label className="field">Valor integral a pagar (R$)<input aria-label="Valor integral a pagar (R$)" inputMode="decimal" autoComplete="off" maxLength={24} value={amount} readOnly required /></label><label className="field">Data real do pagamento<input type="date" min="1900-01-01" max={officialToday()} value={paidOn} onChange={event => setPaidOn(event.target.value)} required /></label><label className="field full">Banco / conta do pagamento<select aria-label="Banco / conta do pagamento" value={paymentBank} disabled={numberedCheque} onChange={event => setBank(event.target.value)} required><option value="">Selecione a conta que realizou o pagamento</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.display_name}</option>)}</select></label>{numberedCheque && <p className={`help-text${!accountsLoading && !chequeBank ? ' notice error' : ''}`} role={!accountsLoading && !chequeBank ? 'alert' : undefined}>{chequeBank ? 'Título com número de cheque: banco de pagamento BRADESCO F2G. O banco previsto no relatório permanece preservado.' : 'Ative uma única conta bancária oficial BRADESCO F2G para registrar o pagamento deste cheque.'}</p>}<label className="field full">Observação do pagamento<textarea aria-label="Observação do pagamento" value={observation} onChange={event => setObservation(event.target.value)} maxLength={1000} required /></label></div><p className="help-text">O pagamento deve quitar o valor integral a pagar. Se o valor estiver incorreto, use “Corrigir título” antes de registrar. Eventuais registros anteriores permanecem no histórico; a pendência remanescente deve ser quitada integralmente. O registro não altera os saldos informados em Caixa / Bancos.</p><button className="button" type="submit" disabled={locked || numberedCheque && !chequeBank}>{busy ? 'Registrando pagamento…' : 'Confirmar pagamento'}</button></fieldset></form>}
    {reversal && writable && <form className="payable-payment-reversal" onSubmit={event => void reverse(event)}><fieldset disabled={locked}><legend>Estornar pagamento de {formatCents(reversal.amount_cents)}</legend><label className="field">Motivo do estorno<textarea aria-label="Motivo do estorno" value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} required /></label><div className="inline-actions"><button className="button secondary" type="button" onClick={() => { setReversal(null); setReason(''); }}>Voltar sem estornar</button><button className="button" disabled={!reason.trim()} type="submit">Confirmar estorno</button></div></fieldset></form>}
    <h3>Histórico financeiro deste título</h3><p className="help-text">Inclui todos os pagamentos e estornos, em qualquer data. Alterações futuras na base não apagam esses registros.</p>
    {loadedPage === page && !loading && (history.length ? <PaymentTable rows={history} titleHistory onReverse={writable ? payment => { setReversal(payment); setReason(''); setError(''); } : undefined} disabled={locked || !!reversal} /> : <p className="empty-state">Nenhum pagamento registrado para este título.</p>)}
    <div className="pagination"><span>{count} registro(s) · Página {page + 1}</span><button className="button secondary" disabled={busy || loading || page === 0} onClick={() => setPage(value => value - 1)}>Pagamentos anteriores</button><button className="button secondary" disabled={busy || loading || (page + 1) * PAGE_SIZE >= count} onClick={() => setPage(value => value + 1)}>Mais pagamentos do título</button></div>
  </section>;
}

function validActualRange(range?: { start: string; end: string }) {
  if (!range) return false;
  try { return range.start >= '1900-01-01' && addCivilDays(range.start, 0) === range.start && addCivilDays(range.end, 0) === range.end && range.end >= range.start && Date.parse(`${range.end}T12:00:00Z`) - Date.parse(`${range.start}T12:00:00Z`) <= 3660 * 86400000; } catch { return false; }
}
export default function PayableReconciliation({ canWrite, selectedTitle, onCloseTitle, onChanged, initialRange, initialMacro, refreshKey, onOpenTitle }: { canWrite: boolean; selectedTitle: PayableTitle | null; onCloseTitle: () => void; onChanged: () => void; initialRange?: { start: string; end: string }; initialMacro?: string; refreshKey?: number | string; onOpenTitle?: (titleId: string) => void }) {
  const yesterday = () => addCivilDays(officialToday(), -1);
  const [start, setStart] = useState(() => validActualRange(initialRange) ? initialRange!.start : yesterday());
  const [end, setEnd] = useState(() => validActualRange(initialRange) ? initialRange!.end : yesterday());
  const [range, setRange] = useState(() => validActualRange(initialRange) ? { ...initialRange! } : { start: yesterday(), end: yesterday() });
  const [macro, setMacro] = useState(initialMacro ?? '');
  const [page, setPage] = useState(0);
  const [summary, setSummary] = useState<PaymentSummary | null>(null);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [count, setCount] = useState(0);
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(canWrite);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [accountError, setAccountError] = useState('');
  const [exporting, setExporting] = useState(false);
  const exportAbort = useRef<AbortController | null>(null);
  const appliedRefreshKey = useRef(refreshKey);
  useEffect(() => () => exportAbort.current?.abort(), []);
  useEffect(() => {
    if (validActualRange(initialRange)) {
      setStart(initialRange!.start); setEnd(initialRange!.end); setPage(0);
      setRange(previous => previous.start === initialRange!.start && previous.end === initialRange!.end ? previous : { ...initialRange! });
    }
    setMacro(initialMacro ?? ''); setPage(0);
    // A new parent selection changes report filters without remounting PaymentEditor.
  }, [initialRange, initialMacro]);
  useEffect(() => {
    // Refreshing data preserves any filters chosen locally by the operator.
    if (appliedRefreshKey.current !== refreshKey) { appliedRefreshKey.current = refreshKey; setRefresh(value => value + 1); }
  }, [refreshKey]);
  useEffect(() => {
    if (!canWrite) return;
    const client = supabase; if (!client) { setAccountsLoading(false); setAccountError('Conexão indisponível.'); return; }
    const abort = new AbortController(); setAccountsLoading(true); setAccountError('');
    void Promise.resolve(client.rpc('get_payable_payment_accounts').abortSignal(abort.signal).retry(false)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error || !Array.isArray(result.data)) { setAccountError(readError(result.error)); return; }
      setAccounts(result.data as PaymentAccount[]);
    }).catch(() => { if (!abort.signal.aborted) setAccountError('Não foi possível consultar as contas oficiais.'); }).finally(() => { if (!abort.signal.aborted) setAccountsLoading(false); });
    return () => abort.abort();
  }, [canWrite, refresh]);
  useEffect(() => {
    const client = supabase; if (!client) { setLoading(false); setError('Conexão indisponível.'); return; }
    const abort = new AbortController(); setLoading(true); setError(''); setRows([]); setSummary(null);
    void Promise.all([
      client.rpc('payable_payment_summary', { p_start: range.start, p_end: range.end }).abortSignal(abort.signal).retry(false),
      client.rpc('list_payable_payments', { p_start: range.start, p_end: range.end, p_offset: page * PAGE_SIZE, p_limit: PAGE_SIZE, p_title_id: null, p_macro: macro || null, p_bank_account_id: null }).abortSignal(abort.signal).retry(false),
    ]).then(([totals, payments]) => {
      if (abort.signal.aborted) return;
      if (totals.error) throw totals.error;
      if (payments.error) throw payments.error;
      const total = totals.data as PaymentSummary, list = payments.data as PaymentList;
      if (!Array.isArray(total?.by_macro) || !Number.isSafeInteger(total.total_paid_cents) || !Array.isArray(list?.rows) || !Number.isSafeInteger(list.count)) throw new Error('read');
      if (!sameRevision(total.revision, list.revision)) throw new Error('changed');
      setSummary(total); setCount(list.count);
      const last = Math.max(0, Math.ceil(list.count / PAGE_SIZE) - 1);
      if (page > last) setPage(last); else setRows(list.rows);
    }).catch(failure => { if (!abort.signal.aborted) { setCount(0); setError(failure instanceof Error && failure.message === 'changed' ? 'A base mudou durante a consulta. Atualize a conciliação para conferir a posição atual.' : readError(failure)); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [range, page, refresh, macro]);
  function changed() { setRefresh(value => value + 1); onChanged(); }
  function consult(event: FormEvent) { event.preventDefault(); if (!validActualRange({ start, end })) { setError('Selecione um período válido, com início anterior ao fim e intervalo de até dez anos.'); return; } setPage(0); setRange({ start, end }); }
  async function exportPayments() {
    if (loading || exporting || !count || !summary) return;
    const client = supabase; if (!client) return;
    const abort = new AbortController(); exportAbort.current = abort; setExporting(true); setError('');
    try {
      const all: PaymentRow[] = []; const revision = summary.revision;
      for (let offset = 0; offset < count; offset += 500) {
        const result = await client.rpc('list_payable_payments', { p_start: range.start, p_end: range.end, p_offset: offset, p_limit: 500, p_title_id: null, p_macro: macro || null, p_bank_account_id: null }).abortSignal(abort.signal).retry(false);
        if (result.error) throw result.error;
        const data = result.data as PaymentList;
        if (!sameRevision(revision, data.revision) || data.count !== count || !Array.isArray(data.rows) || !data.rows.length) throw new Error('changed');
        all.push(...data.rows); if (all.length > 100000) throw new Error('limit');
      }
      const check = await client.rpc('get_payables_revision').abortSignal(abort.signal).retry(false);
      if (check.error) throw check.error;
      if (!sameRevision(revision, check.data as Revision) || all.length !== count) throw new Error('changed');
      if (abort.signal.aborted) return;
      const safe = (value: unknown) => { let text = String(value ?? ''); if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
      const decimal = (value: number) => `${BigInt(value) / 100n},${String(BigInt(value) % 100n).padStart(2, '0')}`;
      const headers = ['Centro de Custo Macro', 'Nº Lançamento', 'Histórico/Favorecido', 'Filial', 'Data real do pagamento', 'Banco/Conta do pagamento', 'Valor pago', 'Registrado em', 'Registrado por', 'Observação', 'Nº cheque registrado no pagamento'];
      const lines = all.map(row => [row.effective_macro ?? row.macro_snapshot, row.entry_number, row.description, row.branch, dateLabel(row.paid_on), row.bank_label, decimal(row.amount_cents), dateLabel(row.created_at), row.created_by_name || row.created_by_username, row.observation, chequeLabel(row.cheque_number)].map(safe).join(';'));
      const url = URL.createObjectURL(new Blob(['\uFEFF' + headers.map(safe).join(';') + '\r\n' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `Contas_a_Pagar_Realizado_${range.start}_${range.end}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error && failure.message === 'limit' ? 'A exportação excede 100.000 pagamentos. Reduza o período; nenhum arquivo parcial foi gerado.' : 'Não foi possível gerar o relatório: a base pode ter mudado. Atualize e tente novamente. Nenhum arquivo parcial foi gerado.'); }
    finally { if (!abort.signal.aborted) setExporting(false); }
  }
  const macroSummary = summary?.by_macro.find(item => item.macro === macro);
  const shownTotal = macro ? macroSummary?.amount_cents : summary?.total_paid_cents;
  const shownCount = macro ? macroSummary?.count : summary?.payment_count;
  return <div className="payable-reconciliation">
    {selectedTitle && <PaymentEditor key={selectedTitle.id} title={selectedTitle} accounts={accounts} accountsLoading={accountsLoading} canWrite={canWrite} onClose={onCloseTitle} onChanged={changed} />}
    <section className="panel" aria-labelledby="payable-actual-title"><div className="panel-header"><div><h2 id="payable-actual-title">Pagamentos realizados</h2><p className="muted">Concilie os pagamentos efetivos de cada título. O realizado usa a data real do pagamento, mesmo quando registrado no dia seguinte.</p></div><button className="button secondary" disabled={loading || exporting} onClick={() => setRefresh(value => value + 1)}>Atualizar conciliação</button></div>
      <form className="payable-payment-period" onSubmit={consult}><label className="field">Pagamento inicial<input type="date" min="1900-01-01" value={start} onChange={event => setStart(event.target.value)} required /></label><label className="field">Pagamento final<input type="date" min="1900-01-01" value={end} onChange={event => setEnd(event.target.value)} required /></label><label className="field">Centro de Custo Macro dos pagamentos<select aria-label="Centro de Custo Macro dos pagamentos" value={macro} disabled={loading || exporting} onChange={event => { setMacro(event.target.value); setPage(0); }}><option value="">Todos os macros</option>{summary?.by_macro.map(item => <option key={item.macro}>{item.macro}</option>)}</select></label><button className="button secondary" disabled={loading || exporting} type="submit">Consultar realizado</button><button className="button secondary" disabled={loading || exporting || !count} type="button" onClick={() => void exportPayments()}>{exporting ? 'Exportando realizado…' : 'Baixar realizado em CSV'}</button></form>
      {error && <p className="notice error" role="alert">{error}</p>}{selectedTitle && accountError && <p className="notice error" role="alert">Não foi possível carregar as contas para registrar pagamentos. {accountError}</p>}
      {loading && <p role="status">Carregando valores realizados…</p>}
      {summary && <><dl className="payable-payment-total"><div><dt>Total efetivamente pago{macro ? ` · ${macro}` : ''} · {dateLabel(range.start)} a {dateLabel(range.end)}</dt><dd>{shownTotal === undefined ? 'Macro indisponível' : formatCents(shownTotal)}</dd><small>{shownCount === undefined ? 'Atualize a consulta para conferir a classificação.' : `${shownCount} pagamento(s) confirmado(s)`}</small></div><div><dt>Títulos ausentes ainda sem conciliação financeira · total geral</dt><dd>{summary.pending_reconciliation_count}</dd><small>Ausência no relatório não entra no realizado.</small></div></dl><div className="payable-payment-macros">{summary.by_macro.filter(item => !macro || item.macro === macro).map(macro => <div key={macro.macro}><span>{macro.macro}</span><strong>{formatCents(macro.amount_cents)}</strong><small>{macro.count} pagamento(s)</small></div>)}</div></>}
      <p className="help-text">O valor, o vencimento e o banco da base diária podem ser atualizados. Pagamentos registrados mantêm sua data efetiva, conta e valor. Correções de macro preservam a classificação original no histórico. Selecione “Conciliar título” na lista de lançamentos para registrar ou consultar pagamentos.</p>
      {!loading && !error && (rows.length ? <PaymentTable rows={rows} onOpenTitle={onOpenTitle} disabled={!!selectedTitle} /> : <p className="empty-state">Nenhum pagamento realizado no período selecionado.</p>)}
      <div className="pagination"><span>{count} pagamento(s) · Página {page + 1}</span><button className="button secondary" disabled={loading || exporting || page === 0} onClick={() => setPage(value => value - 1)}>Realizados anteriores</button><button className="button secondary" disabled={loading || exporting || (page + 1) * PAGE_SIZE >= count} onClick={() => setPage(value => value + 1)}>Mais realizados</button></div>
    </section>
  </div>;
}
