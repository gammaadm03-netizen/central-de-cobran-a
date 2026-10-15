import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { displayDate, displayDateTime, money, officialToday, type CashPosition, type StockPosition } from './Treasury';
import '../financial.css';

type PeriodMode = 'today' | 'week' | 'month';
interface PayableSummary { open_cents: number; overdue_cents: number; period_cents: number; active_count: number; latest_import_at: string | null }
interface Position { cash: CashPosition; stock: StockPosition; payables: PayableSummary }
interface DirectorPosition { id: string; created_at: string; created_by: string; period_start: string; period_end: string; indicators: Record<string, number | boolean | null> }
interface Indicator { label: string; cents: number | null; detail: string }
const BASE_PENDING = 'BASE AGUARDANDO IMPORTAÇÃO';
const CASH_PENDING = 'SALDOS AGUARDANDO ATUALIZAÇÃO';
const STOCK_PENDING = 'ESTOQUE AGUARDANDO ATUALIZAÇÃO';

export function addDays(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
export function financialWeek(date: string) { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); const start = addDays(date, -((day + 1) % 7)); return { start, end: addDays(start, 6) }; }
function shortDate(date: string) { return displayDate(date).slice(0, 5); }
function Pending({ caption = BASE_PENDING }: { caption?: string }) { return <span className="financial-missing">{caption}</span>; }
function MoneyValue({ cents, caption }: { cents: number | null; caption?: string }) { return cents === null ? <Pending caption={caption} /> : <>{money(cents)}</>; }

export default function ExecutiveDashboard({ canManage, canReadDirectorSummary = false, canViewPayables = true, canViewCash = true, onNavigate }: { canManage: boolean; canReadDirectorSummary?: boolean; canViewPayables?: boolean; canViewCash?: boolean; onNavigate: (id: string) => void }) {
  const today = officialToday();
  const [mode, setMode] = useState<PeriodMode>('week');
  const [weekStart, setWeekStart] = useState(() => financialWeek(today).start);
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [loadedPosition, setPosition] = useState<Position | null>(null);
  const [positionPeriod, setPositionPeriod] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<DirectorPosition[]>([]);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyCount, setHistoryCount] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyRevision, setHistoryRevision] = useState(0);
  const range = useMemo(() => {
    if (mode === 'today') return { start: today, end: today };
    if (mode === 'week') return { start: weekStart, end: addDays(weekStart, 6) };
    const [year, monthNumber] = month.split('-').map(Number);
    return { start: `${month}-01`, end: new Date(Date.UTC(year, monthNumber, 0, 12)).toISOString().slice(0, 10) };
  }, [mode, weekStart, month, today]);
  const weeks = useMemo(() => Array.from({ length: 21 }, (_, index) => addDays(financialWeek(today).start, (index - 12) * 7)), [today]);
  const rangeLabel = `${displayDate(range.start)}–${displayDate(range.end)}`;
  const scopeLabel = mode === 'today' ? 'hoje' : mode === 'week' ? 'na semana' : 'no mês';

  useEffect(() => {
    let active = true;
    setLoading(true); setPosition(null); setUpdatedAt(null); setError(''); setSuccess('');
    const client = supabase;
    async function load() {
      try {
        if (!client) throw new Error('connection');
        const [cash, stock, payables] = await Promise.all([client.rpc('cash_position', { p_as_of: today }), client.rpc('current_stock'), client.rpc('payables_summary', { p_start: range.start, p_end: range.end })]);
        if (cash.error || stock.error || payables.error || !cash.data || !stock.data || !payables.data) throw new Error('read');
        if (active) { setPosition({ cash: cash.data as CashPosition, stock: stock.data as StockPosition, payables: payables.data as PayableSummary }); setPositionPeriod(`${range.start}:${range.end}`); setUpdatedAt(new Date().toISOString()); }
      } catch { if (active) setError('Não foi possível atualizar o painel. Confira sua conexão e tente novamente.'); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [today, range.start, range.end, revision]);

  useEffect(() => {
    if (!historyOpen || !canReadDirectorSummary) return;
    let active = true;
    setHistoryLoading(true); setHistoryError(''); setHistory([]);
    async function load() {
      try {
        if (!supabase) throw new Error('connection');
        const result = await supabase.from('director_positions').select('id,created_at,created_by,period_start,period_end,indicators', { count: 'exact' }).order('created_at', { ascending: false }).range(historyPage * 20, historyPage * 20 + 19);
        if (result.error) throw result.error;
        if (active) { setHistory((result.data ?? []) as DirectorPosition[]); setHistoryCount(result.count ?? 0); }
      } catch { if (active) setHistoryError('Não foi possível consultar o histórico de posições. Tente novamente.'); }
      finally { if (active) setHistoryLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [historyOpen, canReadDirectorSummary, historyPage, historyRevision]);

  const position = positionPeriod === `${range.start}:${range.end}` ? loadedPosition : null;
  const cashCents = position?.cash.total_cents ?? null;
  const payableImported = Boolean(position?.payables.latest_import_at);
  const payablePeriod = payableImported ? position!.payables.period_cents : null;
  const payableOpen = payableImported ? position!.payables.open_cents : null;
  const payableOverdue = payableImported ? position!.payables.overdue_cents : null;
  const stockCents = position?.stock.value_cents ?? null;
  const commercial: Indicator[] = [
    { label: 'Faturamento mês', cents: null, detail: 'Fechamento · exceto COMLURB' },
    { label: 'Faturamento COMLURB', cents: null, detail: 'Fechamento · cliente COMLURB' },
    { label: 'Faturamento geral', cents: null, detail: 'Fechamento · consolidado' },
    { label: 'Valor de pedidos do sistema', cents: null, detail: 'Pedidos de venda · integração pendente' },
    { label: 'Pedidos bloqueados', cents: null, detail: 'Pedidos · aguardando base oficial' },
    { label: 'Total de pendências', cents: null, detail: 'Comercial · aguardando base oficial' },
  ];
  const financial: Indicator[] = [
    { label: 'Contas a receber total', cents: null, detail: 'Contas a Receber · carteira ativa' },
    { label: 'Contas a receber atrasado', cents: null, detail: 'Contas a Receber · títulos vencidos' },
    { label: 'Atrasado COMLURB', cents: null, detail: 'Contas a Receber · COMLURB' },
    { label: 'Percentual em atraso', cents: null, detail: 'Depende da base de Contas a Receber' },
    { label: 'Caixa total', cents: cashCents, detail: position ? `${position.cash.reported_accounts}/${position.cash.expected_accounts} contas · posição ${displayDate(today)}` : 'Caixa / Bancos · posição atual' },
    { label: 'Estoque total', cents: stockCents, detail: stockCents !== null ? `${position?.stock.source ?? 'MANUAL'} · ${displayDate(position?.stock.reference_date)}` : STOCK_PENDING },
  ];
  const obligations: Indicator[] = [
    { label: 'Pagamento de mercadoria', cents: null, detail: 'Contas a Pagar · classificação e período em validação' },
    { label: 'Parcelamentos', cents: null, detail: 'Contas a Pagar · aguardando parâmetro oficial' },
    { label: 'Imposto fixo', cents: null, detail: 'Parâmetro financeiro · aguardando definição' },
    { label: `Contas a pagar ${scopeLabel}`, cents: payablePeriod, detail: `Contas a Pagar · ${rangeLabel}` },
    { label: 'Caixa projetado', cents: null, detail: 'Caixa + receber − pagar · depende da base completa' },
    { label: 'Ativo circulante (milhões)', cents: null, detail: 'Aguardando todos os parâmetros da fórmula oficial' },
  ];

  async function savePosition() {
    if (!canManage || !canReadDirectorSummary || saving || !position) return;
    if (!window.confirm(`Salvar posição parcial da Diretoria?\n\nPeríodo: ${rangeLabel}\nOs dados ainda não migrados ficarão identificados como indisponíveis. Nenhum valor ausente será substituído por zero.`)) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      if (!supabase) throw new Error('connection');
      const result = await supabase.rpc('save_director_position', { p_start: range.start, p_end: range.end });
      if (result.error) throw result.error;
      setSuccess('Posição parcial salva no histórico com data, hora e responsável.'); setHistoryRevision(value => value + 1);
    } catch { setError('Não foi possível salvar a posição. Atualize o painel antes de tentar novamente.'); }
    finally { setSaving(false); }
  }

  async function exportExcel() {
    if (!position || exporting || !canReadDirectorSummary) return;
    setExporting(true); setError('');
    try {
      const amounts = [...commercial, ...financial, ...obligations].map(indicator => indicator.cents).concat(position.cash.accounts.map(account => account.amount_cents));
      // Limite conservador: contar todos os algarismos dos centavos,
      // inclusive zeros finais, pois a divisão por 100 também pode perder precisão.
      if (amounts.some(cents => cents !== null && BigInt(Math.abs(cents)).toString().length > 15)) {
        setError('O Excel não preserva todos os centavos de um dos valores desta posição, pois aceita até 15 algarismos significativos. A exportação foi interrompida para evitar arredondamento.');
        return;
      }
      const { Workbook } = await import('exceljs');
      const book = new Workbook(); book.creator = 'Central Financeira · Grupo Ecoplast'; book.created = new Date();
      const sheet = book.addWorksheet('Resumo da Diretoria');
      sheet.columns = [{ header: 'Seção', key: 'section', width: 20 }, { header: 'Indicador', key: 'indicator', width: 34 }, { header: 'Valor', key: 'value', width: 30 }, { header: 'Origem / Situação', key: 'source', width: 66 }];
      sheet.addRow({ section: 'POSIÇÃO PARCIAL', indicator: 'Período inicial', value: new Date(`${range.start}T12:00:00Z`) }).getCell(3).numFmt = 'dd/mm/yyyy';
      sheet.addRow({ section: 'POSIÇÃO PARCIAL', indicator: 'Período final', value: new Date(`${range.end}T12:00:00Z`) }).getCell(3).numFmt = 'dd/mm/yyyy';
      sheet.addRow({ section: 'POSIÇÃO PARCIAL', indicator: 'Data da posição de caixa', value: new Date(`${today}T12:00:00Z`), source: 'Último saldo de cada conta até essa data.' }).getCell(3).numFmt = 'dd/mm/yyyy';
      for (const [section, indicators] of [['COMERCIAL', commercial], ['FINANCEIRO', financial], ['OBRIGAÇÕES', obligations]] as [string, Indicator[]][]) for (const indicator of indicators) {
        const unavailable = indicator.label === 'Caixa total' ? CASH_PENDING : indicator.label === 'Estoque total' ? STOCK_PENDING : BASE_PENDING;
        const row = sheet.addRow({ section, indicator: indicator.label, value: indicator.cents === null ? unavailable : indicator.cents / 100, source: indicator.detail });
        if (indicator.cents !== null) row.getCell(3).numFmt = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
      }
      const accounts = book.addWorksheet('Caixa por empresa e banco');
      accounts.columns = [{ header: 'Empresa', key: 'company', width: 22 }, { header: 'Banco', key: 'bank', width: 22 }, { header: 'Conta', key: 'account', width: 22 }, { header: 'Data do saldo', key: 'date', width: 18 }, { header: 'Saldo (R$)', key: 'balance', width: 25 }];
      for (const account of position.cash.accounts) {
        const row = accounts.addRow({ company: account.company, bank: account.bank, account: account.account_label, date: account.balance_date ? new Date(`${account.balance_date}T12:00:00Z`) : 'NÃO INFORMADA', balance: account.amount_cents === null ? CASH_PENDING : account.amount_cents / 100 });
        row.getCell(4).numFmt = 'dd/mm/yyyy'; if (account.amount_cents !== null) row.getCell(5).numFmt = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
      }
      for (const worksheet of [sheet, accounts]) { worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF135B45' } }; worksheet.views = [{ state: 'frozen', ySplit: 1 }]; worksheet.autoFilter = { from: 'A1', to: `${worksheet === sheet ? 'D' : 'E'}1` }; }
      const buffer = await book.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const link = document.createElement('a'); link.href = url; link.download = `Resumo_Diretoria_${range.start}_${range.end}.xlsx`; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { setError('Não foi possível gerar o Excel. Tente novamente.'); }
    finally { setExporting(false); }
  }

  return <div className="financial-page executive-dashboard">
    <div className="financial-toolbar"><p className="financial-subtitle">Resumo executivo da Central Financeira · posição consolidada</p><div className="inline-actions"><span className="financial-group-label">Grupo consolidado</span><label className="field financial-week-field"><span className="screen-reader-only">Semana financeira</span><select aria-label="Semana financeira" value={weekStart} onChange={event => { setWeekStart(event.target.value); setMode('week'); }}>{weeks.map(start => <option value={start} key={start}>{start === financialWeek(today).start ? 'Atual · ' : ''}{shortDate(start)}–{shortDate(addDays(start, 6))}{start.slice(0, 4) !== today.slice(0, 4) ? `/${start.slice(0, 4)}` : ''}</option>)}</select></label></div></div>
    <div className="financial-period-bar"><div className="financial-period-tabs" role="group" aria-label="Período do painel">{([['today', 'Hoje'], ['week', 'Semana'], ['month', 'Mês']] as const).map(([value, label]) => <button key={value} aria-pressed={mode === value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{label}</button>)}</div><div className="financial-period-caption">{mode === 'month' && <label className="field"><span className="screen-reader-only">Mês do painel</span><input aria-label="Mês do painel" type="month" value={month} onChange={event => { if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value); }} /></label>}<span>{rangeLabel} · {mode === 'week' ? 'sábado a sexta-feira' : 'visão de caixa e compromissos'}</span></div></div>
    {error && <p className="alert error" role="alert">{error}</p>}{success && <p className="alert success" role="status">{success}</p>}
    {loading && <p className="financial-loading" role="status">Carregando indicadores…</p>}
    <div className="financial-kpis">
      <article className="financial-kpi"><span className="financial-kpi-label">CAIXA HOJE</span><strong><MoneyValue cents={cashCents} caption={CASH_PENDING} /></strong><small>{cashCents !== null ? `Saldo consolidado · ${position?.cash.reported_accounts} contas` : '11 contas bancárias oficiais'}</small></article>
      <article className="financial-kpi"><span className="financial-kpi-label">CAIXA PROJETADO</span><strong><Pending /></strong><small>Depende dos saldos, recebíveis e compromissos do período.</small></article>
      <article className="financial-kpi"><span className="financial-kpi-label">A RECEBER {scopeLabel.toUpperCase()}</span><strong><Pending /></strong><small>{rangeLabel}</small></article>
      <article className="financial-kpi payable-kpi"><span className="financial-kpi-label">A PAGAR {scopeLabel.toUpperCase()}</span><strong><MoneyValue cents={payablePeriod} /></strong><small>{rangeLabel}</small></article>
    </div>
    <div className="financial-overview-grid"><section className="financial-card movement-card"><div className="financial-card-heading"><div><h2>Movimento {mode === 'week' ? 'da semana' : mode === 'month' ? 'do mês' : 'do dia'}</h2><p className="financial-caption">{rangeLabel} · caixa atual + receber − pagar</p></div>{canViewCash && <button className="button secondary" onClick={() => onNavigate('caixa')}>Abrir Caixa →</button>}</div><dl className="financial-ledger"><div><dt>Saldo de entrada</dt><dd><MoneyValue cents={cashCents} caption={CASH_PENDING} /></dd></div><div><dt>+ Receber {scopeLabel}</dt><dd><Pending /></dd></div><div><dt>− Pagar {scopeLabel}</dt><dd><MoneyValue cents={payablePeriod} /></dd></div><div className="financial-ledger-total"><dt>Caixa projetado</dt><dd><Pending /></dd></div></dl><p className="financial-caption">Projeção aguardando base completa de Contas a Receber.</p></section><section className="financial-card attention-card"><div className="financial-card-heading"><div><h2>Atenção da Gestão</h2><p className="financial-caption">Pontos que merecem acompanhamento.</p></div></div><dl className="financial-attention"><div><dt><i className="attention-dot red" />Contas a receber vencidas</dt><dd><Pending /></dd></div><div><dt><i className="attention-dot amber" />Contas a pagar vencidas / pendentes</dt><dd><MoneyValue cents={payableOverdue} /></dd></div><div><dt><i className="attention-dot amber" />Títulos sem cobradora definida</dt><dd><Pending /></dd></div><div><dt><i className="attention-dot green" />Margem líquida do fechamento</dt><dd><Pending /></dd></div></dl></section></div>
    {canReadDirectorSummary && <section className="financial-card director-summary"><div className="financial-card-heading"><div><h2>Resumo da Diretoria</h2><p className="financial-caption">{position && updatedAt ? `Atualizado ${displayDateTime(updatedAt)} · ` : ''}Posição parcial · dados ainda não migrados ficam identificados como indisponíveis.</p></div><div className="inline-actions financial-summary-actions"><span className="badge pendente">POSIÇÃO PARCIAL</span><button className="button secondary" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>Atualizar agora</button>{canManage && <button className="button secondary" disabled={loading || saving || !position} onClick={() => void savePosition()}>{saving ? 'Salvando…' : 'Salvar posição'}</button>}<button className="button secondary" disabled={loading || !position || exporting} onClick={() => void exportExcel()}>{exporting ? 'Gerando Excel…' : 'Baixar Excel'}</button><button className="button secondary" disabled={loading || !position} onClick={() => window.print()}>Imprimir / PDF</button><button className="button secondary" onClick={() => setHistoryOpen(value => !value)}>{historyOpen ? 'Fechar histórico' : 'Histórico das posições'}</button></div></div><div className="director-summary-grid">{([['COMERCIAL', 'Fechamento + Pedidos', commercial], ['FINANCEIRO', 'Receber + Caixa', financial], ['OBRIGAÇÕES', 'Contas a Pagar', obligations]] as [string, string, Indicator[]][]).map(([title, source, indicators]) => <div className="director-summary-column" key={title}><div className="director-summary-heading"><h3>{title}</h3><small>{source}</small></div><dl>{indicators.map(indicator => <div key={indicator.label}><dt>{indicator.label}<small>{indicator.detail}</small></dt><dd><MoneyValue cents={indicator.cents} caption={indicator.label === 'Caixa total' ? CASH_PENDING : indicator.label === 'Estoque total' ? STOCK_PENDING : BASE_PENDING} /></dd></div>)}</dl></div>)}</div><div className="director-cash-detail"><h3>Caixa detalhado por empresa / banco</h3>{position ? <div className="table-scroll"><table><thead><tr><th>Empresa</th><th>Banco</th><th>Data do saldo</th><th className="financial-numeric">Saldo</th></tr></thead><tbody>{position.cash.accounts.map(account => <tr key={account.id}><td>{account.company}</td><td>{account.bank}{account.account_label ? ` · ${account.account_label}` : ''}</td><td>{displayDate(account.balance_date)}</td><td className="financial-numeric"><MoneyValue cents={account.amount_cents} caption={CASH_PENDING} /></td></tr>)}</tbody></table></div> : <p className="financial-caption">{loading ? 'Carregando saldos…' : CASH_PENDING}</p>}</div>{historyOpen && <div className="director-history"><h3>Histórico das posições</h3>{historyLoading && <p className="financial-loading" role="status">Carregando histórico…</p>}{historyError && <p className="alert error" role="alert">{historyError}</p>}{!historyLoading && !historyError && history.length === 0 && <p className="empty-state">Nenhuma posição salva.</p>}{history.length > 0 && <div className="table-scroll"><table><thead><tr><th>Salva em</th><th>Período</th><th>Caixa</th><th>A pagar no período</th><th>Estoque</th><th>Situação</th></tr></thead><tbody>{history.map(snapshot => <tr key={snapshot.id}><td>{displayDateTime(snapshot.created_at)}</td><td>{displayDate(snapshot.period_start)}–{displayDate(snapshot.period_end)}</td>{['cash_cents', 'payable_period_cents', 'stock_cents'].map(key => <td key={key}><MoneyValue cents={typeof snapshot.indicators[key] === 'number' ? snapshot.indicators[key] as number : null} caption={key === 'cash_cents' ? CASH_PENDING : key === 'stock_cents' ? STOCK_PENDING : BASE_PENDING} /></td>)}<td>{snapshot.indicators.complete ? 'Completa' : 'Parcial'}</td></tr>)}</tbody></table></div>}<div className="pagination"><span>{historyCount} posição(ões) · Página {historyPage + 1}</span><button className="button secondary" disabled={historyLoading || historyPage === 0} onClick={() => setHistoryPage(value => value - 1)}>Anterior</button><button className="button secondary" disabled={historyLoading || (historyPage + 1) * 20 >= historyCount} onClick={() => setHistoryPage(value => value + 1)}>Próxima</button></div></div>}</section>}
    <section className="financial-card"><div className="financial-card-heading"><div><h2>Indicadores mensais e módulos</h2><p className="financial-caption">Saldos e totais refletem somente registros persistidos na base central.</p></div><button className="button secondary" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>Atualizar indicadores</button></div><div className="financial-module-grid"><article><h3>Total a pagar em aberto</h3><strong><MoneyValue cents={payableOpen} /></strong><p>{payableImported ? `${position!.payables.active_count} títulos ativos · importação ${displayDateTime(position!.payables.latest_import_at!)}` : 'Contas a Pagar · importe o relatório completo na área Importar Bases.'}</p>{canViewPayables && <button className="financial-text-button" onClick={() => onNavigate('contas_pagar')}>Consultar Contas a Pagar →</button>}</article><article><h3>Total recebido consolidado</h3><strong><Pending /></strong><p>Somente recebimentos validados financeiramente poderão integrar este indicador.</p></article><article><h3>Faturamento e ativo circulante</h3><strong><Pending /></strong><p>Faturamento, estoque e parâmetros financeiros precisam estar disponíveis para o cálculo oficial.</p></article></div></section>
  </div>;
}
