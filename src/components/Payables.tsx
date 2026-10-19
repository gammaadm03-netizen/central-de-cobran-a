import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, downloadCsv, formatCents, isPayableAdministrativeWriteoff, PAYABLE_SCOPE, payableError, payableStatus, payableFinancialStatus, readPayables, readPayablesRevision, type PayableFilters, type PayableTitle } from '../lib/payables';
import PayablesForecast from './PayablesForecast';
import PayableReconciliation from './PayableReconciliation';
import PayablesOverview, { type PayablesDetailSelection } from './PayablesOverview';
import PayableMonthClosing, { PayableTitleReview } from './PayableMonthClosing';
import { officialToday } from './Treasury';
import { comparisonRanges, monthBounds, financialWeek } from '../lib/financial-dates';
import '../payables-reports.css';

const initialFilters: PayableFilters = { scope: PAYABLE_SCOPE, search: '', start: '', end: '', status: '', macro: '', branch: '', financialStatus: '', reviewStatus: '', outstandingOnly: false, canonicalOnly: false };
export default function Payables({ onImport, canWrite = false, canConfigure = false }: { onImport?: () => void; canWrite?: boolean; canConfigure?: boolean }) {
  const [filters, setFilters] = useState(initialFilters);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<PayableTitle[]>([]);
  const [macros, setMacros] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const [reportMonth, setReportMonth] = useState(() => officialToday().slice(0, 7));
  const [monthFilter, setMonthFilter] = useState(() => officialToday().slice(0, 7));
  const [monthMacro, setMonthMacro] = useState('');
  const [financialAvailable, setFinancialAvailable] = useState(false);
  const [selectedTitle, setSelectedTitle] = useState<PayableTitle | null>(null);
  const [selectedReview, setSelectedReview] = useState<PayableTitle | null>(null);
  const [reviewAvailable, setReviewAvailable] = useState(false);
  const [showTitles, setShowTitles] = useState(false);
  const [showActuals, setShowActuals] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [legacyFallback, setLegacyFallback] = useState(false);
  const [actualRange, setActualRange] = useState<{ start: string; end: string } | undefined>();
  const [actualMacro, setActualMacro] = useState('');
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const detailAbort = useRef<AbortController | null>(null);
  useEffect(() => () => detailAbort.current?.abort(), []);
  const exportAbort = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbort.current?.abort(),[]);
  useEffect(() => {
    if (search === filters.search) return;
    const timer = window.setTimeout(() => { setFilters(previous => previous.search === search ? previous : { ...previous, search }); setPage(0); }, 200);
    return () => window.clearTimeout(timer);
  }, [search, filters.search]);
  useEffect(() => {
    const client = supabase; if (!client) return;
    const abort = new AbortController();
    void client.from('payable_macros').select('name').order('name').abortSignal(abort.signal).then(result => { if (!abort.signal.aborted && !result.error) setMacros((result.data ?? []).map(item => String(item.name))); });
    return () => abort.abort();
  },[]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(''); setRows([]);
    if (filters.start && filters.end && filters.start > filters.end) { setError('A data inicial deve ser anterior à data final.'); setLoading(false); setCount(0); return; }
    void readPayables(filters,page*size,size,abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setCount(result.count);
      setFinancialAvailable(result.financialAvailable);
      setReviewAvailable(result.reviewAvailable);
      const last = Math.max(0,Math.ceil(result.count/size)-1);
      if (page > last) setPage(last); else setRows(result.rows);
    }).catch(loadError => { if (!abort.signal.aborted) { setCount(0); setError(payableError(loadError,'Não foi possível carregar Contas a Pagar. Tente atualizar a lista.')); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  },[filters,page,size,refresh]);
  function change(key: keyof PayableFilters,value:string) { setFilters(previous => ({ ...previous,[key]:value })); setPage(0); }
  async function exportRows() {
    if (exporting || !count || loading || search !== filters.search) return;
    const frozen = { ...filters }; const abort = new AbortController(); exportAbort.current = abort; setExporting(true); setError(''); setExportProgress('Preparando exportação…');
    try {
      const snapshot = await readPayablesRevision(abort.signal);
      const selected: PayableTitle[] = []; let expected: number | null = null;
      for (let offset = 0;;offset += 500) {
        const result = await readPayables(frozen,offset,500,abort.signal);
        if (abort.signal.aborted) return;
        if (expected !== null && result.count !== expected) throw new Error('A base mudou durante a exportação. Atualize os filtros e tente novamente.');
        expected = result.count; selected.push(...result.rows);
        if (selected.length > 100000) throw new Error('A exportação excede 100.000 títulos. Restrinja o período ou os filtros.');
        setExportProgress(`Exportando ${selected.length.toLocaleString('pt-BR')} de ${expected.toLocaleString('pt-BR')} títulos…`);
        if (selected.length >= expected) break;
        if (!result.rows.length) throw new Error('A base mudou durante a exportação. Tente novamente.');
      }
      if (JSON.stringify(await readPayablesRevision(abort.signal)) !== JSON.stringify(snapshot)) throw new Error('A base ou os pagamentos mudaram durante a exportação. Atualize os filtros e tente novamente.');
      if (abort.signal.aborted) return;
      downloadCsv(selected,`Contas_a_Pagar_Filtrado_${officialToday()}.csv`);
      setExportProgress(`${selected.length.toLocaleString('pt-BR')} títulos exportados com os filtros selecionados.`);
    } catch (exportError) { if (!abort.signal.aborted) { setError(payableError(exportError,exportError instanceof Error ? exportError.message : 'Não foi possível concluir a exportação.')); setExportProgress(''); } }
    finally { if (!abort.signal.aborted) setExporting(false); }
  }
  async function exportExcel(fullMonth: boolean) {
    if (exporting || loading || (!fullMonth && search !== filters.search)) return;
    const frozen = fullMonth ? { ...initialFilters } : { ...filters };
    const selectedMonth = reportMonth;
    const abort = new AbortController(); exportAbort.current = abort;
    setExporting(true); setError(''); setExportProgress('Preparando relatório Excel…');
    try {
      const client = supabase; if (!client) throw new Error('Conexão indisponível.');
      const { current, previous } = comparisonRanges(selectedMonth, frozen.start, frozen.end);
      const snapshot = await readPayablesRevision(abort.signal);
      if (!snapshot.import_id) throw new Error('Importe a primeira base de Contas a Pagar antes de gerar o Excel.');
      const { buildPayablesWorkbook, payablesWorkbookFilename, MAX_PAYABLE_WORKBOOK_ROWS } = await import('../lib/payables-excel');
      const load = async (range: { start: string; end: string }, label: string) => {
        const selected: PayableTitle[] = []; let expected: number | null = null;
        for (let offset = 0;; offset += 500) {
          if (abort.signal.aborted) throw new DOMException('Exportação cancelada.', 'AbortError');
          const result = await readPayables({ ...frozen, start: range.start, end: range.end }, offset, 500, abort.signal);
          if (expected !== null && result.count !== expected) throw new Error('A base mudou durante a exportação. Atualize e tente novamente.');
          expected = result.count;
          if (expected > MAX_PAYABLE_WORKBOOK_ROWS) throw new Error(`O Excel permite até ${MAX_PAYABLE_WORKBOOK_ROWS.toLocaleString('pt-BR')} lançamentos por período nesta versão. Restrinja os filtros ou use CSV; nenhum arquivo parcial foi gerado.`);
          selected.push(...result.rows);
          setExportProgress(`${label}: ${selected.length.toLocaleString('pt-BR')} de ${expected.toLocaleString('pt-BR')} lançamentos…`);
          if (selected.length >= expected) break;
          if (!result.rows.length) throw new Error('A base mudou durante a exportação. Atualize e tente novamente.');
        }
        return selected;
      };
      const selected = await load(current, 'Mês selecionado');
      const comparison = await load(previous, 'Período anterior');
      let payments: import('../lib/payables-excel').PaymentExportRow[] | undefined;
      if (snapshot.financial_revision !== null) {
        payments = []; let expected: number | null = null;
        for (let offset = 0;; offset += 500) {
          const result = await client.rpc('list_payable_payments', { p_start: current.start, p_end: current.end, p_offset: offset, p_limit: 500, p_title_id: null, p_macro: frozen.macro || null, p_bank_account_id: null }).abortSignal(abort.signal);
          if (result.error) throw result.error;
          if (abort.signal.aborted) return;
          const data = result.data as { rows: import('../lib/payables-excel').PaymentExportRow[]; count: number };
          if (!data || !Array.isArray(data.rows) || !Number.isSafeInteger(data.count) || data.count < 0 || (expected !== null && expected !== data.count)) throw new Error('Os pagamentos mudaram durante a exportação. Atualize e tente novamente.');
          expected = data.count;
          if (expected > MAX_PAYABLE_WORKBOOK_ROWS) throw new Error('O relatório possui mais de 20.000 pagamentos. Restrinja os filtros; nenhum arquivo parcial foi gerado.');
          payments.push(...data.rows);
          setExportProgress(`Pagamentos realizados: ${payments.length.toLocaleString('pt-BR')} de ${expected.toLocaleString('pt-BR')}…`);
          if (payments.length >= expected) break;
          if (!data.rows.length) throw new Error('Os pagamentos mudaram durante a exportação. Atualize e tente novamente.');
        }
        payments = payments.filter(payment => (!frozen.branch.trim() || payment.branch === frozen.branch.trim()) && (!frozen.search.trim() || payment.description.toLocaleLowerCase('pt-BR').includes(frozen.search.trim().toLocaleLowerCase('pt-BR'))) && (!frozen.status || payment.title_status === frozen.status) && (!frozen.financialStatus || payment.financial_status === frozen.financialStatus) && (!frozen.reviewStatus || (payment as import('../lib/payables-excel').PaymentExportRow & { review_status?: string }).review_status === frozen.reviewStatus));
      }
      if (JSON.stringify(await readPayablesRevision(abort.signal)) !== JSON.stringify(snapshot)) throw new Error('A base mudou durante a exportação. Atualize e tente novamente.');
      if (abort.signal.aborted) return;
      setExportProgress('Gerando as abas do Excel…');
      const workbook = await buildPayablesWorkbook(selected, comparison, { month: selectedMonth, filters: frozen, fullMonth, generatedAt: new Date().toISOString(), importId: snapshot.import_id, currentRange: current, previousRange: previous, payments });
      const buffer = await workbook.xlsx.writeBuffer();
      if (abort.signal.aborted) return;
      // Uma importação que termine durante a construção do arquivo também invalida a cópia.
      if (JSON.stringify(await readPayablesRevision(abort.signal)) !== JSON.stringify(snapshot)) throw new Error('A base ou os pagamentos mudaram durante a exportação. Atualize e tente novamente.');
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = payablesWorkbookFilename(selectedMonth, fullMonth); document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      setExportProgress(`${selected.length.toLocaleString('pt-BR')} lançamentos exportados em Excel. O comparativo usa o período equivalente do mês anterior.`);
    } catch (failure) {
      if (!abort.signal.aborted) { setError(payableError(failure, failure instanceof Error ? failure.message : 'Não foi possível gerar o Excel. Nenhum arquivo parcial foi gerado.')); setExportProgress(''); }
    } finally { if (!abort.signal.aborted) setExporting(false); }
  }
  function openDetails(selection: PayablesDetailSelection) {
    setFilters({ ...initialFilters, start: selection.start, end: selection.end, macro: selection.macro ?? '', canonicalOnly: selection.canonicalOnly ?? false, outstandingOnly: selection.outstandingOnly ?? false });
    setSearch(''); setPage(0); setShowTitles(true); setDetailError('');
    window.setTimeout(() => document.getElementById('payables-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }
  function openActuals(selection: { start: string; end: string; macro?: string }) {
    setActualRange({ start: selection.start, end: selection.end }); setActualMacro(selection.macro ?? ''); setShowActuals(true); setDetailError('');
    window.setTimeout(() => document.getElementById('payable-actual-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }
  async function openPaidTitle(id: string) {
    if (selectedTitle || selectedReview) { setDetailError('Feche o título atual antes de abrir outro detalhamento.'); return; }
    if (!supabase || detailLoading) return;
    detailAbort.current?.abort(); const abort = new AbortController(); detailAbort.current = abort; setDetailLoading(true); setDetailError('');
    try {
      let result = await supabase.from('payable_review_titles').select('*').eq('id', id).abortSignal(abort.signal).single();
      if (result.error && ['PGRST205', '42P01'].includes(result.error.code)) result = await supabase.from('payable_financial_titles').select('*').eq('id', id).abortSignal(abort.signal).single();
      if (result.error) throw result.error;
      if (!result.data) throw new Error('Título indisponível.');
      if (!abort.signal.aborted) { setSelectedTitle(result.data as PayableTitle); setShowActuals(true); window.setTimeout(() => document.getElementById('payable-reconciliation-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }
    } catch (failure) { if (!abort.signal.aborted) setDetailError(payableError(failure, 'Não foi possível abrir o título. Atualize a consulta e tente novamente.')); }
    finally { if (!abort.signal.aborted) setDetailLoading(false); }
  }
  const pages = Math.max(1,Math.ceil(count/size));
  return <div className="stack"><PayablesOverview refreshKey={refresh} onDetails={openDetails} onActuals={openActuals} onUnavailable={() => setLegacyFallback(true)} />
    <div className="toolbar"><button className="button secondary" type="button" onClick={() => openDetails({ start: '', end: '', canonicalOnly: false })}>Abrir todos os lançamentos</button><button className="button secondary" type="button" onClick={() => openActuals(financialWeek(officialToday()))}>Ver pagamentos da semana</button><button className="button secondary" type="button" onClick={() => setShowTools(value => !value)}>Fechamento e parâmetros</button>{(showTitles || showActuals || showTools) && !legacyFallback && <button className="button secondary" type="button" disabled={!!selectedTitle || !!selectedReview} onClick={() => { setShowTitles(false); setShowActuals(false); setShowTools(false); }}>Voltar ao resumo</button>}</div>
    {detailError && <p className="notice error" role="alert">{detailError}</p>}{detailLoading && <p role="status">Abrindo título…</p>}
    {selectedReview && <PayableTitleReview key={selectedReview.id} canWrite={canWrite} title={selectedReview} onChanged={() => setRefresh(value => value + 1)} onClose={() => setSelectedReview(null)} />}
    {(showActuals || legacyFallback || !!selectedTitle) && <PayableReconciliation canWrite={canWrite && selectedTitle?.closing_eligible !== false && (!selectedTitle || !isPayableAdministrativeWriteoff(selectedTitle))} selectedTitle={selectedTitle} onCloseTitle={() => setSelectedTitle(null)} onChanged={() => setRefresh(value => value + 1)} initialRange={actualRange} initialMacro={actualMacro} refreshKey={refresh} onOpenTitle={id => void openPaidTitle(id)} />}
    {(showTools || legacyFallback) && <><PayableMonthClosing canWrite={canWrite} refreshKey={refresh} onChanged={() => setRefresh(value => value + 1)} /><PayablesForecast key={`forecast-${refresh}`} canWrite={canWrite} canConfigure={canConfigure} /></>}
    {(showTitles || legacyFallback) && <section className="panel" aria-labelledby="payables-title">
    <div className="panel-header"><div><h2 id="payables-title">Lançamentos de Contas a Pagar</h2><p className="muted">Grupo consolidado · títulos quitados permanecem no histórico. Semana financeira: sábado a sexta-feira.</p></div><div className="inline-actions">{onImport && <button type="button" className="button" onClick={onImport}>Ir para Importar Bases</button>}<button type="button" className="button secondary" disabled={loading} onClick={() => setRefresh(value => value+1)}>Atualizar títulos</button></div></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    <form className="payables-report-controls" aria-label="Consulta por mês e macro" onSubmit={event => {
      event.preventDefault(); if (loading || exporting) return;
      try { const range = monthBounds(monthFilter); setSearch(''); setFilters({ ...initialFilters, start: range.start, end: range.end, macro: monthMacro }); setReportMonth(monthFilter); setPage(0); setError(''); }
      catch { setError('Selecione um mês válido para consultar os títulos.'); }
    }}><label className="field">Mês dos títulos<input type="month" value={monthFilter} min="1900-01" max="9998-12" onChange={event => setMonthFilter(event.target.value)} required /></label><label className="field">Centro de Custo Macro do mês<select value={monthMacro} onChange={event => setMonthMacro(event.target.value)}><option value="">Todos os macros</option>{macros.map(macro => <option key={macro}>{macro}</option>)}</select></label><button type="submit" className="button" disabled={loading || exporting || !monthFilter}>Exibir títulos</button><p className="help-text">Consulta pelo mês de vencimento e macro escolhido, incluindo o histórico. Pagamentos realizados são apurados pela data efetiva de cada pagamento, no quadro de conciliação.</p></form>
    <div className="form-grid">
      <label className="field" htmlFor="payables-search">Pesquisar histórico / favorecido<input id="payables-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Nome ou descrição" maxLength={200} /></label>
      <label className="field" htmlFor="payables-status">Status<select id="payables-status" value={filters.status} onChange={event => change('status',event.target.value)}><option value="">Todos, incluindo histórico</option>{Object.entries(payableStatus).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="field" htmlFor="payables-start">Vencimento inicial<input id="payables-start" type="date" value={filters.start} onChange={event => change('start',event.target.value)} /></label>
      <label className="field" htmlFor="payables-end">Vencimento final<input id="payables-end" type="date" value={filters.end} onChange={event => change('end',event.target.value)} /></label>
      <label className="field" htmlFor="payables-macro">Centro de Custo Macro<select id="payables-macro" value={filters.macro} onChange={event => change('macro',event.target.value)}><option value="">Todos os macros</option>{macros.map(macro => <option key={macro}>{macro}</option>)}</select></label>
      <label className="field" htmlFor="payables-branch">Filial<input id="payables-branch" value={filters.branch} onChange={event => change('branch',event.target.value)} placeholder="Código / nome exato da base" maxLength={200} /></label>
      <label className="field" htmlFor="payables-financial-status">Situação financeira<select id="payables-financial-status" disabled={!financialAvailable} value={filters.financialStatus ?? ''} onChange={event => change('financialStatus',event.target.value)}><option value="">Todas as situações financeiras</option>{Object.entries(payableFinancialStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="field" htmlFor="payables-review-status">Revisão do título<select id="payables-review-status" disabled={!reviewAvailable} value={filters.reviewStatus ?? ''} onChange={event => change('reviewStatus',event.target.value)}><option value="">Todos os títulos</option><option value="A_CONCILIAR">A CONCILIAR</option><option value="CONCILIADO">CONCILIADO</option><option value="BAIXADO_ADMINISTRATIVAMENTE">BAIXADO SEM PAGAMENTO</option></select></label>
    </div>
    <div className="toolbar"><button className="button secondary" type="button" onClick={() => { setSearch(''); setFilters(initialFilters); setPage(0); }}>Limpar filtros</button><button className="button secondary" type="button" disabled={loading || exporting || !count || search !== filters.search} onClick={() => void exportRows()}>{exporting ? 'Exportando…' : 'Baixar CSV dos filtros'}</button></div>
    <div className="payables-report-controls"><label className="field">Mês do relatório Excel<input type="month" value={reportMonth} min="1900-01" max="9998-12" onChange={event => setReportMonth(event.target.value)} disabled={exporting} required /></label><div className="inline-actions"><button className="button secondary" type="button" disabled={loading || exporting || !reportMonth || search !== filters.search} onClick={() => void exportExcel(false)}>Baixar Excel dos filtros</button><button className="button secondary" type="button" disabled={loading || exporting || !reportMonth} onClick={() => void exportExcel(true)}>Baixar mês completo — lançamento por lançamento</button></div><p className="help-text">Excel dos filtros: mês selecionado, limitado pelos filtros acima. Escolha um macro para seu relatório individual. Mês completo: inclui todos os lançamentos do mês, inclusive quitados, de todas as filiais e macros. A comparação usa o período equivalente do mês anterior.</p></div>
    {exportProgress && <p className="help-text" role="status">{exportProgress}</p>}
    <div className="table-wrap" aria-busy={loading}><table className="data-table"><caption className="sr-only">Títulos de Contas a Pagar com filtros e paginação</caption><thead><tr>{reviewAvailable && <th>Conferência / Correções</th>}{financialAvailable && <th>Pagamentos</th>}<th>Macro / Plano</th><th>Nº lançamento</th><th>Nº cheque</th><th>Histórico / Favorecido</th><th>Filial / Banco informado</th><th>Emissão</th><th>Vencimento</th><th>Valor atualizado</th><th>Status da importação</th><th>Baixa automática</th>{financialAvailable && <><th>Valor pago</th><th>Saldo a pagar</th><th>Situação financeira</th><th>Último pagamento</th></>}</tr></thead><tbody>{loading ? <tr><td className="empty-state" colSpan={(financialAvailable ? 15 : 10) + (reviewAvailable ? 1 : 0)}>Carregando títulos…</td></tr> : rows.length ? rows.map(row => <tr key={row.id}>{reviewAvailable && <td><button type="button" className={`button ${row.review_status === 'CONCILIADO' ? '' : 'secondary'}`} disabled={!!selectedReview || !!selectedTitle || row.closing_eligible === false || isPayableAdministrativeWriteoff(row)} onClick={() => { setSelectedReview(row); window.setTimeout(() => document.getElementById('payable-title-review-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }}>{isPayableAdministrativeWriteoff(row) ? 'BAIXADO SEM PAGAMENTO' : row.closing_eligible === false ? 'VERSÃO ANTERIOR' : row.review_status === 'CONCILIADO' ? 'CONCILIADO' : 'A CONCILIAR'}</button><small className="help-text">{isPayableAdministrativeWriteoff(row) ? 'Baixa administrativa; valor original fora dos totais, sem registrar pagamento.' : row.closing_eligible === false ? 'Histórico fora do fechamento; não exige novo pagamento.' : canWrite ? 'Conferir / corrigir título' : 'Consultar conferência'}</small></td>}{financialAvailable && <td><button type="button" className="button secondary" disabled={!!selectedTitle || !!selectedReview} onClick={() => { setSelectedTitle(row); window.setTimeout(() => document.getElementById('payable-reconciliation-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }}>{canWrite && row.closing_eligible !== false && !isPayableAdministrativeWriteoff(row) ? 'Conciliar título' : 'Consultar pagamentos'}</button></td>}<td><strong>{row.macro}</strong><div>{row.plan}</div></td><td>{reviewAvailable ? <button className="button secondary" type="button" aria-label={`Abrir título ${row.entry_number}`} disabled={!!selectedReview || !!selectedTitle} onClick={() => { setSelectedReview(row); window.setTimeout(() => document.getElementById('payable-title-review-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }}>{row.entry_number}</button> : row.entry_number}</td><td>{row.cheque_number || (row.source_status?.trim().toUpperCase() === 'CHEQUE' ? 'Não informado' : '—')}</td><td>{row.description}</td><td>{row.branch}<div>{row.bank_account || '—'}</div></td><td>{dateLabel(row.issued_on)}</td><td>{dateLabel(row.due_date)}</td><td style={{whiteSpace:'nowrap'}}>{formatCents(row.amount_cents)}{isPayableAdministrativeWriteoff(row) && <small className="help-text">Valor original preservado; fora dos totais.</small>}</td><td><span className="badge">{payableStatus[row.status]}</span><div>{row.source_status || '—'}</div></td><td>{dateLabel(row.settled_at)}</td>{financialAvailable && <><td>{formatCents(row.paid_cents!)}</td><td>{formatCents(row.outstanding_cents!)}{row.overpaid_cents ? <div className="notice error">Excedente: {formatCents(row.overpaid_cents)}</div> : null}</td><td>{isPayableAdministrativeWriteoff(row) ? 'BAIXADO SEM PAGAMENTO' : row.financial_status ? payableFinancialStatus[row.financial_status] : 'Indisponível'}{isPayableAdministrativeWriteoff(row) && <small className="help-text">{dateLabel(row.administrative_writeoff_at ?? null)}{row.administrative_writeoff_reason ? ` · ${row.administrative_writeoff_reason}` : ''}</small>}</td><td>{dateLabel(row.last_payment_date ?? null)}<div>{row.last_payment_bank || '—'}</div></td></>}</tr>) : <tr><td className="empty-state" colSpan={(financialAvailable ? 15 : 10) + (reviewAvailable ? 1 : 0)}>{error ? 'Lista indisponível.' : 'Nenhum título para os filtros selecionados. Importe uma base completa em Importar Bases.'}</td></tr>}</tbody></table></div>
    <div className="pagination"><label className="field" htmlFor="payables-size">Por página<select id="payables-size" value={size} onChange={event => { setSize(+event.target.value); setPage(0); }}><option value="25">25</option><option value="50">50</option></select></label><span>{count.toLocaleString('pt-BR')} títulos · página {page+1} de {pages}</span><button type="button" className="button secondary" disabled={loading || !page} onClick={() => setPage(value => value-1)}>Anterior</button><button type="button" className="button secondary" disabled={loading || page+1>=pages} onClick={() => setPage(value => value+1)}>Próxima</button></div>
  </section>}</div>;
}
