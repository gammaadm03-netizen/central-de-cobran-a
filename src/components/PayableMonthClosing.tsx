import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents, type PayableTitle } from '../lib/payables';
import { addCivilDays, monthBounds } from '../lib/financial-dates';
import { officialToday, parseBRLCents } from './Treasury';
import '../payable-month-closing.css';

interface Revision { import_id: string | null; financial_revision: string }
interface ClosureMetadata { id: string; month: string; version: number; created_at: string; created_by: string; created_by_name?: string; observation: string }
interface MonthStatus {
  month: string; status: 'OPEN' | 'CLOSED'; total_titles: number; reconciled_count: number; pending_count: number;
  eligible_count: number; total_nominal_cents: number; total_paid_cents: number; outstanding_cents: number;
  can_close: boolean; excluded_historical_count?: number; revision: Revision; latest_closure: ClosureMetadata | null; issues: string[];
}
interface ReviewTitle extends PayableTitle {
  review_status: 'A_CONCILIAR' | 'CONCILIADO'; review_id: string | null; reviewed_at: string | null;
  reviewed_by: string | null; review_fingerprint: string; cheque_number?: string | null; closing_eligible?: boolean; closing_exclusion_reason?: string | null; paid_cents: number; payment_remaining_cents: number;
}
interface ClosureSnapshot extends ClosureMetadata {
  snapshot: {
    schema_version: string; titles: Record<string, unknown>[]; historical_titles?: Record<string, unknown>[]; payments: Record<string, unknown>[];
    realized: { by_macro: { macro: string; amount_cents: number; count: number }[]; total_paid_cents: number; payment_count: number; rows: Record<string, unknown>[] };
  };
}
const PAGE_SIZE = 10;
const MAX_EXPORT_TITLES = 20000;
const MAX_EXPORT_PAYMENTS = 50000;
const CURRENCY = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
function codeOf(error: unknown) { return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''; }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value); }
function knownFailure(error: unknown) { return ['PGRST202', 'PGRST205', '42P01', '42883', '42501', 'PGRST301', 'PGRST303', '40001', '22023', '23514', '22003'].includes(codeOf(error)); }
function readableError(error: unknown, operation = 'consultar o fechamento') {
  const code = codeOf(error);
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)) return 'O fechamento e a conferência de títulos precisam da atualização 017 do banco de dados. Os títulos e pagamentos existentes estão preservados.';
  if (code === '42501') return 'Seu perfil não tem permissão para esta operação.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (code === '40001') return 'Os dados mudaram desde a consulta. Atualize a conferência e revise os valores antes de continuar. Seu preenchimento foi mantido.';
  if (code === '22023' || code === '23514') return 'A operação foi recusada. Confira os títulos pendentes, os valores, as datas e o motivo informado.';
  if (code === '22003') return 'Os valores ultrapassam o limite de precisão permitido.';
  return `Não foi possível ${operation}. Atualize os dados antes de tentar novamente.`;
}
function isStatus(value: unknown): value is MonthStatus {
  if (!value || typeof value !== 'object') return false;
  const s = value as MonthStatus;
  return ['OPEN', 'CLOSED'].includes(s.status) && typeof s.month === 'string' && Array.isArray(s.issues) && s.issues.every(issue => typeof issue === 'string')
    && [s.total_titles, s.reconciled_count, s.pending_count, s.eligible_count, s.total_nominal_cents, s.total_paid_cents, s.outstanding_cents].every(n => Number.isSafeInteger(n) && n >= 0)
    && (s.excluded_historical_count === undefined || (Number.isSafeInteger(s.excluded_historical_count) && s.excluded_historical_count >= 0))
    && typeof s.can_close === 'boolean' && !!s.revision && typeof s.revision.financial_revision === 'string';
}
function civil(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value < '1900-01-01' || addCivilDays(value, 0) !== value) throw new Error('invalid_export');
  return new Date(`${value}T12:00:00Z`);
}
function localInstant(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('invalid_export');
  const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error('invalid_export');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const n = (key: string) => Number(parts.find(part => part.type === key)?.value);
  return new Date(Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')));
}
function excelMoney(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || BigInt(value as number) > 999999999999999n) throw new Error('invalid_export');
  return (value as number) / 100;
}
function text(value: unknown) { return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value); }
function chequeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > 150 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_export');
  return value;
}
function validSnapshot(value: unknown, metadata: ClosureMetadata): value is ClosureSnapshot {
  if (!value || typeof value !== 'object') return false;
  const result = value as ClosureSnapshot;
  return result.id === metadata.id && result.version === metadata.version && result.month === metadata.month
    && !!result.snapshot && Array.isArray(result.snapshot.titles) && Array.isArray(result.snapshot.payments)
    && !!result.snapshot.realized && Array.isArray(result.snapshot.realized.rows) && Array.isArray(result.snapshot.realized.by_macro)
    && result.snapshot.titles.length <= MAX_EXPORT_TITLES && result.snapshot.payments.length <= MAX_EXPORT_PAYMENTS
    && result.snapshot.realized.rows.length <= MAX_EXPORT_PAYMENTS
    && (result.snapshot.historical_titles === undefined || (Array.isArray(result.snapshot.historical_titles) && result.snapshot.historical_titles.length + result.snapshot.titles.length <= MAX_EXPORT_TITLES))
    && result.snapshot.schema_version === '1';
}
async function downloadClosureExcel(closure: ClosureSnapshot) {
  const { default: ExcelJS } = await import('exceljs');
  let nominal = 0n, paid = 0n, remaining = 0n;
  const identities = new Set<string>();
  for (const item of closure.snapshot.titles) {
    if (!isUuid(item.id) || identities.has(item.id)) throw new Error('invalid_export');
    identities.add(item.id);
    for (const key of ['amount_cents', 'paid_cents', 'payment_remaining_cents']) excelMoney(item[key]);
    nominal += BigInt(item.amount_cents as number); paid += BigInt(item.paid_cents as number); remaining += BigInt(item.payment_remaining_cents as number);
  }
  for (const total of [nominal, paid, remaining]) if (total > 999999999999999n) throw new Error('invalid_export');
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'Central Financeira · Grupo Ecoplast';
  workbook.subject = 'Posição imutável do fechamento mensal de Contas a Pagar'; workbook.created = new Date(closure.created_at);
  const info = workbook.addWorksheet('Fechamento'); info.columns = [{ width: 38 }, { width: 90 }];
  info.addRow(['CENTRAL FINANCEIRA · GRUPO ECOPLAST', 'FECHAMENTO MENSAL DE CONTAS A PAGAR']);
  info.addRow(['Identificação do fechamento', closure.id]);
  info.addRow(['Mês de vencimento dos títulos', civil(closure.month)]).getCell(2).numFmt = 'mm/yyyy';
  info.addRow(['Versão do fechamento', closure.version]);
  info.addRow(['Fechado em · America/Sao_Paulo', localInstant(closure.created_at)]).getCell(2).numFmt = 'dd/mm/yyyy hh:mm';
  info.addRow(['Responsável', closure.created_by_name || closure.created_by]);
  info.addRow(['Observação', closure.observation]);
  info.addRow(['Valor nominal dos títulos conciliados', Number(nominal) / 100]).getCell(2).numFmt = CURRENCY;
  info.addRow(['Pago confirmado nos títulos conciliados', Number(paid) / 100]).getCell(2).numFmt = CURRENCY;
  info.addRow(['Restante para conciliar nesses títulos', Number(remaining) / 100]).getCell(2).numFmt = CURRENCY;
  info.addRow(['Versões anteriores fora do fechamento', closure.snapshot.historical_titles?.length ?? 0]);
  info.addRow(['Origem', 'Cópia histórica salva no fechamento. Atualizações posteriores não recalculam este arquivo.']);
  info.addRow(['Critério de conferência', 'CONCILIADO exige quitação integral e conferência registrada, manual ou pelo relatório de pagamentos. A ausência no relatório importado não comprova pagamento.']);
  info.addRow(['Títulos', 'Selecionados pelo vencimento no mês fechado; pagamentos vinculados podem ter ocorrido em outros meses.']);
  info.addRow(['Realizados', 'Selecionados pela data real do pagamento no mês fechado, incluindo títulos com vencimento em outro mês.']);
  function titleSheet(name: string, items: Record<string, unknown>[]) {
  const titles = workbook.addWorksheet(name);
  titles.columns = ['Centro de Custo Macro', 'Nº lançamento', 'Histórico / Favorecido', 'Plano de Contas', 'Filial', 'Banco / conta da fonte', 'Emissão', 'Vencimento', 'Valor atualizado', 'Pago confirmado', 'Restante para conciliar', 'Conferência', 'Conferido em', 'Identificação do título', 'Número do cheque'].map((header, i) => ({ header, width: i === 2 ? 45 : 25 }));
  for (const item of items) {
    if (!item || typeof item !== 'object' || !isUuid(item.id)) throw new Error('invalid_export');
    const row = titles.addRow([text(item.macro), text(item.entry_number), text(item.description), text(item.plan), text(item.branch), text(item.bank_account), civil(item.issued_on), civil(item.due_date), excelMoney(item.amount_cents), excelMoney(item.paid_cents), excelMoney(item.payment_remaining_cents), text(item.review_status), localInstant(item.reviewed_at), text(item.id), chequeText(item.cheque_number)]);
    for (const n of [7, 8]) row.getCell(n).numFmt = 'dd/mm/yyyy';
    for (const n of [9, 10, 11]) row.getCell(n).numFmt = CURRENCY;
    row.getCell(13).numFmt = 'dd/mm/yyyy hh:mm'; row.getCell(15).numFmt = '@';
  }
  }
  titleSheet('Títulos do mês', closure.snapshot.titles);
  if (closure.snapshot.historical_titles?.length) titleSheet('Versões anteriores', closure.snapshot.historical_titles);
  function payments(name: string, items: Record<string, unknown>[]) {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = ['Data real do pagamento', 'Nº lançamento', 'Histórico / Favorecido', 'Filial', 'Centro de Custo Macro realizado', 'Banco / conta do pagamento', 'Valor pago', 'Registrado em', 'Responsável', 'Situação', 'Identificação do pagamento', 'Macro original do pagamento', 'Número do cheque'].map((header, i) => ({ header, width: i === 2 || i === 5 ? 42 : 25 }));
    for (const item of items) {
      if (!item || typeof item !== 'object' || !isUuid(item.id)) throw new Error('invalid_export');
      const row = sheet.addRow([civil(item.paid_on), text(item.entry_number), text(item.description), text(item.branch), text(item.effective_macro ?? item.macro_snapshot), text(item.bank_label), excelMoney(item.amount_cents), localInstant(item.created_at), text(item.created_by_name || item.created_by), item.cancelled_at ? 'ESTORNADO' : 'CONFIRMADO', text(item.id), text(item.macro_snapshot), chequeText(item.cheque_number)]);
      row.getCell(1).numFmt = 'dd/mm/yyyy'; row.getCell(7).numFmt = CURRENCY; row.getCell(8).numFmt = 'dd/mm/yyyy hh:mm'; row.getCell(13).numFmt = '@';
    }
  }
  payments('Pagamentos dos títulos', closure.snapshot.payments);
  payments('Realizados no mês', closure.snapshot.realized.rows);
  const macros = workbook.addWorksheet('Realizados por Macro');
  macros.columns = [{ header: 'Centro de Custo Macro', width: 37 }, { header: 'Pagamentos', width: 18 }, { header: 'Valor realizado no mês', width: 30 }];
  for (const item of closure.snapshot.realized.by_macro) {
    if (!item || typeof item.macro !== 'string' || !Number.isSafeInteger(item.count) || item.count < 0) throw new Error('invalid_export');
    macros.addRow([item.macro, item.count, excelMoney(item.amount_cents)]).getCell(3).numFmt = CURRENCY;
  }
  if (!Number.isSafeInteger(closure.snapshot.realized.payment_count)) throw new Error('invalid_export');
  macros.addRow(['TOTAL', closure.snapshot.realized.payment_count, excelMoney(closure.snapshot.realized.total_paid_cents)]).getCell(3).numFmt = CURRENCY;
  for (const sheet of workbook.worksheets) { sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.getRow(1).font = { bold: true }; if (sheet.rowCount > 1 && sheet.name !== 'Fechamento') sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } }; }
  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, filename: `Contas_a_Pagar_Fechamento_${closure.month.slice(0, 7)}_v${closure.version}.xlsx` };
}

export default function PayableMonthClosing({ canWrite, onChanged, refreshKey = 0 }: { canWrite: boolean; onChanged: () => void; refreshKey?: number }) {
  const [month, setMonth] = useState(() => officialToday().slice(0, 7));
  const [selectedMonth, setSelectedMonth] = useState(() => officialToday().slice(0, 7));
  const [status, setStatus] = useState<MonthStatus | null>(null);
  const [history, setHistory] = useState<ClosureMetadata[]>([]);
  const [count, setCount] = useState(0), [page, setPage] = useState(0), [loadedPage, setLoadedPage] = useState(-1);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [exporting, setExporting] = useState('');
  const [observation, setObservation] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const [blocked, setBlocked] = useState(false), [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const client = supabase; if (!client) { setLoading(false); setError('Conexão indisponível.'); return; }
    const abort = new AbortController(); setLoading(true); setLoadedPage(-1); setStatus(null); setHistory([]); setError('');
    const date = `${selectedMonth}-01`;
    void Promise.all([
      client.rpc('payables_month_status', { p_month: date }).abortSignal(abort.signal).retry(false),
      client.rpc('list_payable_month_closures', { p_month: date, p_offset: page * PAGE_SIZE, p_limit: PAGE_SIZE }).abortSignal(abort.signal).retry(false),
    ]).then(([position, list]) => {
      if (abort.signal.aborted) return;
      if (position.error) throw position.error; if (list.error) throw list.error;
      if (!isStatus(position.data) || position.data.month !== date || !Array.isArray(list.data?.rows) || !Number.isSafeInteger(list.data.count) || list.data.count < 0) throw new Error('invalid');
      setStatus(position.data); setCount(list.data.count);
      const last = Math.max(0, Math.ceil(list.data.count / PAGE_SIZE) - 1);
      if (page > last) { setPage(last); return; }
      setHistory(list.data.rows as ClosureMetadata[]); setLoadedPage(page); setBlocked(false);
    }).catch(failure => { if (!abort.signal.aborted) { setCount(0); setBlocked(true); setError(readableError(failure)); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [selectedMonth, page, refresh, refreshKey]);
  async function changeClosing(event: FormEvent) {
    event.preventDefault(); if (!canWrite || busy || loading || blocked || !status || !observation.trim()) return;
    const closing = status.status === 'OPEN'; if (closing && !status.can_close) return;
    if (!closing && !status.latest_closure) return;
    if (!window.confirm(`${closing ? 'Fechar' : 'Reabrir'} Contas a Pagar de ${selectedMonth.split('-').reverse().join('/')}?\n\n${closing ? `${status.reconciled_count} de ${status.total_titles} títulos conciliados. Será salva uma posição histórica.` : 'A posição histórica será preservada. Após as correções, será necessário fechar o mês novamente.'}\n\nMotivo: ${observation.trim()}`)) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      if (!supabase) throw new Error('connection');
      const response = closing
        ? await supabase.rpc('close_payables_month', { p_month: status.month, p_observation: observation.trim(), p_expected_revision: status.revision }).retry(false)
        : await supabase.rpc('reopen_payables_month', { p_month: status.month, p_observation: observation.trim(), p_expected_closure_id: status.latest_closure!.id }).retry(false);
      if (!alive.current) return;
      if (response.error) throw response.error; if (!isUuid(response.data)) throw new Error('unconfirmed');
      setObservation(''); setSuccess(closing ? 'Mês fechado. A posição e o histórico foram preservados.' : 'Mês reaberto com motivo e histórico. Faça as correções e conclua um novo fechamento.'); setRefresh(value => value + 1); setPage(0); onChanged();
    } catch (failure) {
      if (!alive.current) return;
      setBlocked(true);
      setError(knownFailure(failure) ? readableError(failure, 'confirmar o fechamento') : 'Não foi possível confirmar o resultado. Seu motivo foi mantido. Atualize o fechamento e confira o histórico antes de tentar novamente.');
    } finally { if (alive.current) setBusy(false); }
  }
  async function exportClosing(metadata: ClosureMetadata) {
    if (exporting || busy || loading || !isUuid(metadata.id)) return;
    setExporting(metadata.id); setError('');
    try {
      if (!supabase) throw new Error('connection');
      const response = await supabase.rpc('read_payable_month_closure', { p_id: metadata.id }).retry(false);
      if (!alive.current) return;
      if (response.error) throw response.error;
      if (!validSnapshot(response.data, metadata)) throw new Error('invalid_export');
      const file = await downloadClosureExcel(response.data);
      if (!alive.current) return;
      const url = URL.createObjectURL(new Blob([file.buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      setSuccess(`Excel da versão ${metadata.version} gerado a partir da posição histórica salva.`);
    } catch (failure) { if (alive.current) setError(codeOf(failure) ? readableError(failure, 'baixar a posição histórica') : 'Não foi possível gerar o Excel do fechamento. Nenhum arquivo parcial foi criado. Confira a atualização do banco e os limites de precisão do Excel.'); }
    finally { if (alive.current) setExporting(''); }
  }
  return <section className="panel payable-month-closing" aria-labelledby="payable-month-title">
    <div className="panel-header"><div><h2 id="payable-month-title">Fechamento mensal de Contas a Pagar</h2><p className="muted">Conferência dos títulos por vencimento e posição histórica dos pagamentos.</p></div><button className="button secondary" disabled={busy || loading || !!exporting} onClick={() => { setSuccess(''); setRefresh(value => value + 1); }}>Atualizar fechamento</button></div>
    <form className="payable-closing-month" onSubmit={event => { event.preventDefault(); if (busy || !!exporting) return; try { monthBounds(month); if (month > officialToday().slice(0, 7) || month < '1900-01') throw new Error(); setSelectedMonth(month); setPage(0); setSuccess(''); setRefresh(value => value + 1); } catch { setError('Selecione um mês válido até o mês atual.'); } }}><label className="field">Mês do fechamento<input type="month" min="1900-01" max={officialToday().slice(0, 7)} value={month} onChange={event => setMonth(event.target.value)} disabled={busy || !!exporting} required /></label><button type="submit" className="button secondary" disabled={busy || loading || !!exporting}>Consultar fechamento</button></form>
    {loading && <p role="status">Consultando conferência e histórico do mês…</p>}{error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {status && !loading && <><div className="payable-closing-state"><strong className={status.status === 'CLOSED' ? 'payable-review-complete' : ''}>{status.status === 'CLOSED' ? 'MÊS FECHADO' : 'MÊS ABERTO'}</strong><span>{status.reconciled_count} de {status.total_titles} títulos CONCILIADOS · {status.pending_count} A CONCILIAR</span>{(status.excluded_historical_count ?? 0) > 0 && <small>{status.excluded_historical_count} versão(ões) anterior(es) preservada(s) no histórico, fora da conferência e dos totais do fechamento.</small>}{status.eligible_count > 0 && <small>{status.eligible_count} título(s) integralmente pago(s) aguardando conferência registrada.</small>}</div>
      <dl className="payable-closing-metrics"><div><dt>Valor atualizado dos títulos do mês</dt><dd>{formatCents(status.total_nominal_cents)}</dd></div><div><dt>Pago confirmado nesses títulos</dt><dd>{formatCents(status.total_paid_cents)}</dd></div><div><dt>Restante para conciliar</dt><dd>{formatCents(status.outstanding_cents)}</dd></div></dl>
      <p className="help-text">CONCILIADO exige quitação integral e conferência registrada, manual ou pelo relatório de pagamentos. Registros anteriores com pagamento incompleto ou excedente continuam A CONCILIAR. A ausência na base, sozinha, não comprova pagamento. O realizado mensal usa a data real do pagamento.</p>
      {status.issues.length > 0 && <ul className="payable-closing-issues">{status.issues.map((issue, i) => <li key={`${i}-${issue}`}>{issue}</li>)}</ul>}
      {canWrite && <form className="payable-closing-action" onSubmit={event => void changeClosing(event)}><label className="field">Observação do fechamento<textarea value={observation} onChange={event => setObservation(event.target.value)} maxLength={1000} disabled={busy || !!exporting} placeholder={status.status === 'CLOSED' ? 'Motivo para reabrir o mês' : 'Conferência e observação do fechamento'} required /></label><button type="submit" className="button" disabled={busy || blocked || !!exporting || !observation.trim() || (status.status === 'OPEN' && !status.can_close)}>{busy ? 'Processando fechamento…' : status.status === 'CLOSED' ? 'Reabrir mês' : 'Fechar mês'}</button>{status.status === 'OPEN' && !status.can_close && <p className="help-text">Resolva os títulos A CONCILIAR antes de fechar o mês.</p>}</form>}
    </>}
    <h3>Histórico dos fechamentos</h3>
    {!loading && loadedPage === page && (history.length ? <div className="table-wrap"><table className="data-table"><caption className="sr-only">Posições históricas do fechamento mensal</caption><thead><tr><th>Versão / Mês</th><th>Fechado em</th><th>Responsável / Observação</th><th>Relatório</th></tr></thead><tbody>{history.map(item => <tr key={item.id}><td><strong>Versão {item.version}</strong><small>{dateLabel(item.month)}</small></td><td>{dateLabel(item.created_at)}</td><td>{item.created_by_name || 'Responsável registrado'}<small>{item.observation}</small></td><td><button className="button secondary" disabled={busy || !!exporting} onClick={() => void exportClosing(item)}>{exporting === item.id ? 'Gerando Excel…' : 'Baixar fechamento em Excel'}</button></td></tr>)}</tbody></table></div> : <p className="empty-state">Nenhum fechamento salvo para este mês.</p>)}
    <div className="pagination"><span>{count} posição(ões) · Página {page + 1}</span><button className="button secondary" disabled={busy || loading || !!exporting || page === 0} onClick={() => setPage(value => value - 1)}>Fechamentos anteriores</button><button className="button secondary" disabled={busy || loading || !!exporting || (page + 1) * PAGE_SIZE >= count} onClick={() => setPage(value => value + 1)}>Mais fechamentos</button></div>
  </section>;
}

function ReviewEditor({ canWrite, title, onChanged, onClose }: { canWrite: boolean; title: PayableTitle; onChanged: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<ReviewTitle | null>(null), [macros, setMacros] = useState<string[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [refresh, setRefresh] = useState(0);
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [observation, setObservation] = useState(''), [reason, setReason] = useState('');
  const [due, setDue] = useState(''), [issued, setIssued] = useState(''), [amount, setAmount] = useState(''), [bank, setBank] = useState(''), [cheque, setCheque] = useState(''), [description, setDescription] = useState(''), [macro, setMacro] = useState('');
  const [reclassify, setReclassify] = useState(false);
  const initialized = useRef(false), alive = useRef(true), container = useRef<HTMLElement>(null);
  useEffect(() => { alive.current = true; container.current?.focus(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const client = supabase; if (!client) { setLoading(false); setError('Conexão indisponível.'); return; }
    const abort = new AbortController(); setLoading(true); setError(''); setDetail(null);
    void Promise.all([
      client.from('payable_review_titles').select('*').eq('id', title.id).abortSignal(abort.signal).single().retry(false),
      client.from('payable_macros').select('name').order('name').abortSignal(abort.signal).retry(false),
    ]).then(([source, options]) => {
      if (abort.signal.aborted) return;
      if (source.error) throw source.error; if (options.error) throw options.error;
      const current = source.data as ReviewTitle;
      if (!current || !['A_CONCILIAR', 'CONCILIADO'].includes(current.review_status) || typeof current.review_fingerprint !== 'string' || !Number.isSafeInteger(current.paid_cents) || !Number.isSafeInteger(current.amount_cents) || !Number.isSafeInteger(current.payment_remaining_cents) || (current.cheque_number != null && typeof current.cheque_number !== 'string') || !Array.isArray(options.data)) throw new Error('invalid');
      setDetail(current); setMacros(options.data.map(item => String(item.name))); setBlocked(false);
      if (!initialized.current) {
        setDue(current.due_date); setIssued(current.issued_on || ''); setAmount(`${BigInt(current.amount_cents) / 100n},${String(BigInt(current.amount_cents) % 100n).padStart(2, '0')}`);
        setBank(current.bank_account || ''); setCheque(current.cheque_number || ''); setDescription(current.description); setMacro(current.macro); initialized.current = true;
      }
    }).catch(failure => { if (!abort.signal.aborted) { setBlocked(true); setError(readableError(failure, 'consultar a conferência do título')); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [title.id, refresh]);
  async function mutate(kind: 'review' | 'correction', event: FormEvent) {
    event.preventDefault(); if (!canWrite || busy || loading || blocked || !detail || detail.closing_eligible === false) return;
    const eligible = detail.financial_status === 'PAID' && detail.amount_cents > 0 && detail.paid_cents === detail.amount_cents;
    if (kind === 'review' && (!eligible || !observation.trim() || detail.review_status === 'CONCILIADO')) return;
    const cents = parseBRLCents(amount);
    const allocationRequired = macro !== detail.macro && detail.paid_cents > 0;
    const changeCheque = Object.hasOwn(detail, 'cheque_number') && cheque.trim() !== (detail.cheque_number || '');
    if (kind === 'correction') {
      try { if (cents === null || cents <= 0 || due < '1900-01-01' || due > '2199-12-31' || addCivilDays(due, 0) !== due || (issued && (issued < '1900-01-01' || issued > '2199-12-31' || addCivilDays(issued, 0) !== issued)) || !description.trim() || cheque.length > 150 || /[\u0000-\u001f\u007f]/.test(cheque) || !macros.includes(macro) || !reason.trim() || (allocationRequired && !reclassify)) throw new Error(); }
      catch { setError('Confira valor positivo com até duas casas decimais, datas válidas, cheque, histórico, macro e motivo. A mudança de macro dos pagamentos exige confirmação explícita.'); return; }
    }
    const confirmation = kind === 'review'
      ? `Marcar o título ${detail.entry_number} como CONCILIADO?\n\nValor atualizado e pago: ${formatCents(detail.amount_cents)}\nObservação: ${observation.trim()}`
      : `Salvar correção do título ${detail.entry_number}?\n\nValor atualizado: ${formatCents(cents!)}\nVencimento: ${dateLabel(due)}\nBanco da fonte: ${bank.trim() || 'não informado'}\nNúmero do cheque: ${cheque.trim() || 'não informado'}\nMacro: ${macro}\nMotivo: ${reason.trim()}\n\nA conferência será invalidada e os fechamentos afetados serão reabertos. ${detail.paid_cents > 0 && reclassify ? 'Os pagamentos serão reclassificados para o novo macro com histórico; valores, datas e bancos dos pagamentos serão preservados.' : 'Os pagamentos anteriores serão preservados.'}`;
    if (!window.confirm(confirmation)) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      if (!supabase) throw new Error('connection');
      const response = kind === 'review'
        ? await supabase.rpc('review_payable_title', { p_title_id: detail.id, p_observation: observation.trim(), p_expected_fingerprint: detail.review_fingerprint }).retry(false)
        : await supabase.rpc('correct_payable_title', { p_title_id: detail.id, p_due_date: due, p_amount_cents: cents!, p_bank_account: bank.trim() || null, p_description: description.trim(), p_issued_on: issued || null, p_macro: macro, p_observation: reason.trim(), p_expected_fingerprint: detail.review_fingerprint, p_reclassify_payments: detail.paid_cents > 0 && reclassify, ...(changeCheque ? { p_cheque_number: cheque.trim() || null, p_change_cheque: true } : {}) }).retry(false);
      if (!alive.current) return;
      if (response.error) throw response.error; if (!isUuid(response.data)) throw new Error('unconfirmed');
      initialized.current = false; setObservation(''); setReason(''); setReclassify(false); setRefresh(value => value + 1); onChanged();
      setSuccess(kind === 'review' ? 'Título marcado como CONCILIADO, com autor e histórico.' : 'Correção registrada com histórico. Confira novamente o título após os ajustes.');
    } catch (failure) {
      if (!alive.current) return;
      setBlocked(true); setError(knownFailure(failure) ? readableError(failure, 'confirmar a conferência') : 'Não foi possível confirmar o resultado. Seu preenchimento foi mantido. Atualize a conferência e confira o histórico antes de tentar novamente.');
    } finally { if (alive.current) setBusy(false); }
  }
  const eligible = !!detail && detail.closing_eligible !== false && detail.financial_status === 'PAID' && detail.amount_cents > 0 && detail.paid_cents === detail.amount_cents;
  const allocationRequired = !!detail && macro !== detail.macro && detail.paid_cents > 0;
  return <section className="panel payable-title-review" aria-labelledby="payable-title-review-title" ref={container} tabIndex={-1}>
    <div className="panel-header"><div><h2 id="payable-title-review-title">Conferência do título {title.entry_number}</h2><p className="muted">{title.description} · Filial {title.branch} · Identificação do lançamento preservada</p></div><div className="inline-actions"><button className="button secondary" disabled={busy || loading} onClick={() => { setSuccess(''); setRefresh(value => value + 1); }}>Atualizar conferência</button><button className="button secondary" disabled={busy} onClick={onClose}>Fechar conferência</button></div></div>
    {loading && <p role="status">Consultando título e conferência…</p>}{error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {detail && !loading && <><div className="payable-closing-state"><strong className={detail.review_status === 'CONCILIADO' ? 'payable-review-complete' : ''}>{detail.closing_eligible === false ? 'VERSÃO ANTERIOR' : detail.review_status === 'CONCILIADO' ? 'CONCILIADO' : 'A CONCILIAR'}</strong>{detail.reviewed_at && <span>Última conferência: {dateLabel(detail.reviewed_at)}</span>}</div>
      <dl className="payable-closing-metrics"><div><dt>Valor atualizado do título</dt><dd>{formatCents(detail.amount_cents)}</dd></div><div><dt>Pago confirmado</dt><dd>{formatCents(detail.paid_cents)}</dd></div><div><dt>Restante para conciliar</dt><dd>{formatCents(detail.payment_remaining_cents)}</dd></div></dl>
      <p className="help-text">Vencimento atual: {dateLabel(detail.due_date)} · Macro atual: {detail.macro} · Banco / conta da fonte: {detail.bank_account || 'não informado'}.</p>
      <p className="help-text payable-title-cheque">Número do cheque: <strong>{detail.cheque_number || 'Não informado na base'}</strong></p>
      {detail.closing_eligible === false && <p className="notice">VERSÃO ANTERIOR · Histórico fora do fechamento. {detail.closing_exclusion_reason || 'A versão atual deste lançamento já está identificada. Os dados anteriores permanecem preservados.'}</p>}
      {!eligible && detail.closing_eligible !== false && <p className="notice">Este título continua A CONCILIAR. A conferência exige o pagamento integral exato do valor atualizado. Registros anteriores incompletos, diferenças de valor e a ausência no relatório não concluem a conciliação.</p>}
      {canWrite && detail.closing_eligible !== false && detail.review_status !== 'CONCILIADO' && <form className="payable-title-review-action" onSubmit={event => void mutate('review', event)}><label className="field">Observação da conferência<textarea value={observation} onChange={event => setObservation(event.target.value)} maxLength={1000} disabled={busy || blocked || !eligible} required /></label><button className="button" type="submit" disabled={busy || blocked || !eligible || !observation.trim()}>{busy ? 'Processando conferência…' : 'Confirmar conciliação do título'}</button></form>}
      {canWrite && detail.closing_eligible !== false && <details className="payable-title-correction"><summary>Corrigir título</summary><p className="help-text">A próxima importação diária atualizará novamente valor, datas, banco, número do cheque e histórico da fonte. A correção individual de macro será preservada enquanto o Plano de Contas permanecer o mesmo; uma mudança de plano exige nova conferência. Para corrigir data, valor ou banco de um pagamento já registrado, estorne o registro em Conciliação de pagamentos e informe o pagamento correto.</p><form onSubmit={event => void mutate('correction', event)}><fieldset disabled={busy || blocked}><legend>Correção auditada dos dados do título</legend><div className="form-grid"><label className="field">Vencimento do título<input type="date" min="1900-01-01" max="2199-12-31" value={due} onChange={event => setDue(event.target.value)} required /></label><label className="field">Valor atualizado do título (R$)<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} maxLength={24} required /></label><label className="field">Banco / conta informado no título<input value={bank} onChange={event => setBank(event.target.value)} maxLength={300} /></label><label className="field">Número do cheque do título<input aria-label="Número do cheque do título" type="text" autoComplete="off" maxLength={150} value={cheque} onChange={event => setCheque(event.target.value)} disabled={!Object.hasOwn(detail, 'cheque_number')} /><small>Campo separado do número do lançamento; os zeros à esquerda são preservados.</small>{!Object.hasOwn(detail, 'cheque_number') && <small>A atualização do número do cheque ainda precisa ser ativada pela administração.</small>}</label><label className="field">Emissão do título<input type="date" min="1900-01-01" max="2199-12-31" value={issued} onChange={event => setIssued(event.target.value)} /></label><label className="field full">Histórico / favorecido do título<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={1500} required /></label><label className="field">Centro de Custo Macro corrigido<select value={macro} onChange={event => { setMacro(event.target.value); setReclassify(false); }} required>{macros.map(item => <option key={item}>{item}</option>)}</select></label><label className="field full">Motivo da correção<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} required /></label></div>{detail.paid_cents > 0 && <label className="check-row"><input type="checkbox" checked={reclassify} onChange={event => setReclassify(event.target.checked)} />Atualizar macro dos pagamentos já registrados</label>}<p className="help-text">A correção mantém o histórico anterior, invalida a conferência e reabre fechamentos afetados. A mudança de macro dos pagamentos será registrada em histórico próprio.</p><button className="button" type="submit" disabled={busy || blocked || !reason.trim() || (allocationRequired && !reclassify)}>Salvar correção do título</button></fieldset></form></details>}
    </>}
  </section>;
}
export function PayableTitleReview(props: { canWrite: boolean; title: PayableTitle; onChanged: () => void; onClose: () => void }) { return <ReviewEditor key={props.title.id} {...props} />; }
