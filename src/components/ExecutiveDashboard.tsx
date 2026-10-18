import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ASSETS_FORMULA, directorAccounts, displayMillions, exactMillions, excelMillions, reportAmount, type DirectorReport } from '../lib/director-report';
import { displayDate, displayDateTime, money, officialToday, accountName, accountType, cashCoverage, type CashPosition, type StockPosition } from './Treasury';
import '../financial.css';

type PeriodMode = 'today' | 'week' | 'month';
interface PayableSummary { open_cents: number; overdue_cents: number; period_cents: number; active_count: number; latest_import_at: string | null }
interface ReceivableSummary { open_cents: number; overdue_cents: number; period_cents: number; active_count: number; pending_count: number; unassigned_count: number; received_period_cents: number; latest_import_at: string | null; overdue_bps: number | null; overdue_comlurb_cents: number | null }
interface ReceivablesManagementSummary { as_of_date: string; received_date: string; open_cents: number | null; overdue_cents: number | null; received_day_cents: number | null; received_month_cents: number | null; active_count: number | null; latest_import_at: string | null; latest_import_id: string | null }
interface ReceivablesManagementPosition { day: string | null; open_cents: number | null; overdue_cents: number | null; received_day_cents: number | null; imported_at: string | null; legacy: boolean }
interface Position { cash: CashPosition; stock: StockPosition; payables: PayableSummary; receivables: ReceivableSummary | null; report: DirectorReport | null }
interface DirectorPosition { id: string; created_at: string; created_by: string; period_start: string; period_end: string; indicators: Record<string, unknown> }
interface Indicator { label: string; cents: number | null; detail: string; percentageBps?: number | null; millions?: string | null }
const BASE_PENDING = 'BASE AGUARDANDO IMPORTAÇÃO';
const CASH_PENDING = 'SALDOS AGUARDANDO ATUALIZAÇÃO';
const STOCK_PENDING = 'ESTOQUE AGUARDANDO ATUALIZAÇÃO';
const RECEIVED_PENDING = 'RECEBIMENTOS AGUARDANDO ATIVAÇÃO';
const missingReceivablesManagement = (code: string) => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code);
function safeReceivableAmount(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function validReceivablesManagement(value: unknown): value is ReceivablesManagementSummary {
  if (!value || typeof value !== 'object') return false;
  const data = value as ReceivablesManagementSummary;
  if (typeof data.as_of_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.as_of_date) || data.received_date !== data.as_of_date) return false;
  try { if (addDays(data.as_of_date, 0) !== data.as_of_date) return false; } catch { return false; }
  const keys = ['open_cents', 'overdue_cents', 'received_day_cents', 'received_month_cents', 'active_count'] as const;
  if (data.latest_import_id === null) return data.latest_import_at === null && keys.every(key => data[key] === null);
  return typeof data.latest_import_id === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(data.latest_import_id)
    && typeof data.latest_import_at === 'string' && Number.isFinite(new Date(data.latest_import_at).getTime())
    && keys.every(key => safeReceivableAmount(data[key]) !== null);
}

export function addDays(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
export function financialWeek(date: string) { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); const start = addDays(date, -((day + 1) % 7)); return { start, end: addDays(start, 6) }; }
function shortDate(date: string) { return displayDate(date).slice(0, 5); }
function Pending({ caption = BASE_PENDING }: { caption?: string }) { return <span className="financial-missing">{caption}</span>; }
function MoneyValue({ cents, caption }: { cents: number | null; caption?: string }) { return cents === null ? <Pending caption={caption} /> : <>{money(cents)}</>; }
function percentage(bps: number) { return `${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bps / 100)}%`; }
function IndicatorValue({ indicator, caption }: { indicator: Indicator; caption: string }) { return indicator.millions !== undefined ? indicator.millions === null ? <Pending caption="CÁLCULO AGUARDANDO INFORMAÇÕES" /> : <>{displayMillions(indicator.millions)}</> : indicator.percentageBps !== undefined ? indicator.percentageBps === null ? <Pending /> : <>{percentage(indicator.percentageBps)}</> : <MoneyValue cents={indicator.cents} caption={caption} />; }

function SnapshotDetails({ values }: { values: Record<string, unknown> }) {
  const fields = [
    ['Faturamento mês', 'turnover_month_cents'], ['Faturamento COMLURB', 'turnover_comlurb_cents'], ['Faturamento geral', 'turnover_cents'],
    ['Valor de pedidos do sistema', 'orders_cents'], ['Pedidos bloqueados', 'blocked_orders_cents'], ['Total de pendências', 'pending_orders_cents'],
    ['Contas a receber total', 'receivable_cents'], ['Contas a receber atrasado', 'receivable_overdue_cents'], ['Atrasado COMLURB', 'receivable_overdue_comlurb_cents'],
    ['Caixa total', 'cash_cents'], ['Estoque total', 'stock_cents'], ['Pagamento de mercadoria', 'merchandise_cents'], ['Parcelamentos', 'installments_cents'], ['Impostos do mês passado', 'previous_month_taxes_cents'],
  ];
  return <details className="director-snapshot-details"><summary>Ver indicadores</summary><p className="financial-caption">Valores preservados quando a posição foi salva.</p>
    <dl>{fields.map(([label, key]) => <div key={key}><dt>{label}</dt><dd><MoneyValue cents={reportAmount(values, key)} caption="NÃO INFORMADO NESTA POSIÇÃO" /></dd></div>)}
      <div><dt>Percentual em atraso</dt><dd>{reportAmount(values, 'receivable_overdue_bps') === null ? 'Não informado nesta posição' : percentage(reportAmount(values, 'receivable_overdue_bps')!)}</dd></div>
    </dl>
    <p className="financial-caption">Fórmula: {typeof values.formula_version === 'string' ? values.formula_version : 'Versão anterior · sem recálculo'}</p>
    {Array.isArray(values.cash_accounts) && <dl>{values.cash_accounts.map((value, index) => {
      const account = value as Record<string, unknown>;
      return <div key={index}><dt>{typeof account.display_name === 'string' ? account.display_name : `${String(account.company)} · ${String(account.bank)}`}</dt><dd><MoneyValue cents={reportAmount(account, 'amount_cents')} caption={CASH_PENDING} /></dd></div>;
    })}</dl>}
  </details>;
}

export default function ExecutiveDashboard({ canManage, canReadDirectorSummary = false, canViewPayables = true, canViewCash = true, canViewReceivables = true, onDirectorInputs, onNavigate }: { canManage: boolean; canReadDirectorSummary?: boolean; canViewPayables?: boolean; canViewCash?: boolean; canViewReceivables?: boolean; onDirectorInputs?: () => void; onNavigate: (id: string) => void }) {
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
  const [receivableNotice, setReceivableNotice] = useState('');
  const [receivableManagement, setReceivableManagement] = useState<ReceivablesManagementPosition | null>(null);
  const [receivableManagementNotice, setReceivableManagementNotice] = useState('');
  const [receivableManagementError, setReceivableManagementError] = useState('');
  const [reportNotice, setReportNotice] = useState('');
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
    setLoading(true); setPosition(null); setUpdatedAt(null); setError(''); setReceivableNotice(''); setReportNotice(''); setSuccess('');
    setReceivableManagement(null); setReceivableManagementNotice(''); setReceivableManagementError('');
    const client = supabase;
    async function load() {
      try {
        if (!client) throw new Error('connection');
        const [cash, stock, payables, receivables, report, receivablesManagement] = await Promise.all([client.rpc('cash_position', { p_as_of: today }), client.rpc('current_stock'), client.rpc('payables_summary', { p_start: range.start, p_end: range.end }), Promise.resolve(client.rpc('receivables_summary', { p_start: range.start, p_end: range.end })).catch(() => ({ data: null, error: { code: 'connection' } })), canReadDirectorSummary ? Promise.resolve(client.rpc('director_report', { p_start: range.start, p_end: range.end })).catch(() => ({ data: null, error: { code: 'connection' } })) : Promise.resolve({ data: null, error: null }), Promise.resolve(client.rpc('receivables_management_summary', { p_day: null }).retry(false)).catch(() => ({ data: null, error: { code: 'connection' } }))]);
        if (active) {
          if (!receivablesManagement.error && validReceivablesManagement(receivablesManagement.data)) {
            const summary = receivablesManagement.data;
            setReceivableManagement({ day: summary.as_of_date, open_cents: summary.open_cents, overdue_cents: summary.overdue_cents, received_day_cents: summary.received_day_cents, imported_at: summary.latest_import_at, legacy: false });
          } else if (missingReceivablesManagement(receivablesManagement.error?.code ?? '')) {
            const legacy = !receivables.error && typeof receivables.data?.latest_import_at === 'string' && Number.isFinite(new Date(receivables.data.latest_import_at).getTime()) ? receivables.data as ReceivableSummary : null;
            setReceivableManagement({ day: null, open_cents: safeReceivableAmount(legacy?.open_cents), overdue_cents: safeReceivableAmount(legacy?.overdue_cents), received_day_cents: null, imported_at: legacy?.latest_import_at ?? null, legacy: true });
            setReceivableManagementNotice('O recebimento do dia aguarda ativação no banco. Os totais disponíveis usam a base oficial de Contas a Receber.');
          } else {
            setReceivableManagementError(receivablesManagement.error?.code === '42501' ? 'Seu perfil não tem permissão para consultar estes indicadores de Contas a Receber.' : 'Não foi possível atualizar os indicadores de Contas a Receber. Os valores não foram exibidos; atualize para tentar novamente.');
          }
        }
        if (cash.error || stock.error || payables.error || !cash.data || !stock.data || !payables.data) throw new Error('read');
        if (active) { setPosition({ cash: cash.data as CashPosition, stock: stock.data as StockPosition, payables: payables.data as PayableSummary, receivables: !receivables.error && receivables.data ? receivables.data as ReceivableSummary : null, report: !report.error && report.data ? report.data as DirectorReport : null });
          if (canReadDirectorSummary && (report.error || !report.data)) setReportNotice(['PGRST202', '42883'].includes(report.error?.code ?? '') ? 'O novo Resumo da Diretoria aguarda ativação no banco. Os saldos e bases já cadastrados continuam disponíveis.' : 'Não foi possível consultar o relatório completo da Diretoria. Atualize agora para tentar novamente.');
          if (receivables.error || !receivables.data) setReceivableNotice(['PGRST202', '42883'].includes(receivables.error?.code ?? '') ? 'Contas a Receber aguardando ativação. Caixa e Contas a Pagar continuam disponíveis.' : 'Não foi possível atualizar Contas a Receber. Atualize os indicadores para tentar novamente; Caixa e Contas a Pagar continuam disponíveis.'); setPositionPeriod(`${range.start}:${range.end}`); setUpdatedAt(new Date().toISOString()); }
      } catch { if (active) setError('Não foi possível atualizar o painel. Confira sua conexão e tente novamente.'); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [today, range.start, range.end, revision, canReadDirectorSummary]);

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
  const coverage = cashCoverage(position?.cash ?? null);
  const negativeFreshness = coverage.accounts.length !== coverage.count ? 'Confira e atualize as posições de hoje' : coverage.accounts.some(account => account.balance_date !== today) ? 'Registro anterior: confira e atualize hoje' : 'Saldos informados hoje';
  const payableImported = Boolean(position?.payables.latest_import_at);
  const payablePeriod = payableImported ? position!.payables.period_cents : null;
  const payableOpen = payableImported ? position!.payables.open_cents : null;
  const payableOverdue = payableImported ? position!.payables.overdue_cents : null;
  const receivableImported = Boolean(position?.receivables?.latest_import_at);
  const receivablePeriod = receivableImported ? position!.receivables!.period_cents : null;
  const receivableOpen = receivableImported ? position!.receivables!.open_cents : null;
  const receivableOverdue = receivableImported ? position!.receivables!.overdue_cents : null;
  const receivedPeriod = receivableImported ? position!.receivables!.received_period_cents : null;
  const overdueBps = receivableImported ? position!.receivables!.overdue_bps : null;
  const receivableManagementPosition = receivableManagement;
  const receivableManagementDay = receivableManagementPosition?.day ?? null;
  const receivableManagementPending = receivableManagementError ? 'INDICADOR INDISPONÍVEL' : loading ? 'ATUALIZANDO INDICADORES' : BASE_PENDING;
  const projectionBig = cashCents !== null && receivablePeriod !== null && payablePeriod !== null ? BigInt(cashCents) + BigInt(receivablePeriod) - BigInt(payablePeriod) : null;
  const projection = projectionBig !== null && projectionBig <= BigInt(Number.MAX_SAFE_INTEGER) && projectionBig >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(projectionBig) : null;
  const report = position?.report ?? null;
  const reportValues = report?.indicators;
  const reportDate = report?.as_of_date ?? today;
  const summaryCash = report?.cash ?? position?.cash ?? null;
  const summaryStock = report?.stock ?? position?.stock ?? null;
  const summaryAccounts = directorAccounts(summaryCash?.accounts ?? []);
  const manualSource = report?.inputs ? `MANUAL · ${displayDate(report.inputs.reference_date)} · conferido pela Gerência` : 'Importar Bases → Resumo da Diretoria · posição de hoje pendente';
  const currentAssets = exactMillions(reportValues?.current_assets_millions);
  const priorMonth = new Date(`${reportDate.slice(0, 7)}-01T12:00:00Z`); priorMonth.setUTCMonth(priorMonth.getUTCMonth() - 1);
  const taxesMonth = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(priorMonth);
  const commercial: Indicator[] = [
    { label: 'Faturamento mês', cents: reportAmount(reportValues, 'turnover_month_cents'), detail: `Exceto COMLURB · ${manualSource}` },
    { label: 'Faturamento COMLURB', cents: reportAmount(reportValues, 'turnover_comlurb_cents'), detail: manualSource },
    { label: 'Faturamento geral', cents: reportAmount(reportValues, 'turnover_cents'), detail: 'Faturamento mês + COMLURB · sem duplicidade' },
    { label: 'Valor de pedidos do sistema', cents: reportAmount(reportValues, 'orders_cents'), detail: manualSource },
    { label: 'Pedidos bloqueados', cents: reportAmount(reportValues, 'blocked_orders_cents'), detail: manualSource },
    { label: 'Total de pendências', cents: reportAmount(reportValues, 'pending_orders_cents'), detail: manualSource },
  ];
  const financial: Indicator[] = [
    { label: 'Contas a receber total', cents: report ? reportAmount(reportValues, 'receivable_cents') : receivableOpen, detail: 'Contas a Receber · carteira ativa' },
    { label: 'Contas a receber atrasado', cents: report ? reportAmount(reportValues, 'receivable_overdue_cents') : receivableOverdue, detail: 'Contas a Receber · títulos vencidos' },
    { label: 'Atrasado COMLURB', cents: reportAmount(reportValues, 'receivable_overdue_comlurb_cents'), detail: manualSource },
    { label: 'Percentual em atraso', cents: null, percentageBps: report ? reportAmount(reportValues, 'receivable_overdue_bps') : overdueBps, detail: 'Valor vencido ÷ carteira ativa de Contas a Receber' },
    { label: 'Caixa total', cents: summaryCash?.total_cents ?? null, detail: summaryCash ? `${summaryCash.reported_accounts}/${summaryCash.expected_accounts} contas · posição ${displayDate(reportDate)}` : 'Caixa / Bancos · posição atual' },
    { label: 'Estoque total', cents: summaryStock?.value_cents ?? null, detail: summaryStock?.value_cents != null ? `${summaryStock.source ?? 'MANUAL'} · ${displayDate(summaryStock.reference_date)}` : STOCK_PENDING },
  ];
  const obligations: Indicator[] = [
    { label: 'Pagamento de mercadoria', cents: reportAmount(reportValues, 'merchandise_cents'), detail: 'Contas a Pagar · títulos em aberto da macro COMPRA DE MERCADORIA' },
    { label: 'Parcelamentos', cents: reportAmount(reportValues, 'installments_cents'), detail: manualSource },
    { label: 'Impostos do mês passado', cents: reportAmount(reportValues, 'previous_month_taxes_cents'), detail: `${taxesMonth} · ${manualSource}` },
    { label: `Contas a pagar ${scopeLabel}`, cents: report ? reportAmount(reportValues, 'payable_period_cents') : payablePeriod, detail: `Contas a Pagar · ${rangeLabel}` },
    { label: 'Caixa projetado', cents: report ? reportAmount(reportValues, 'projected_cash_cents') : projection, detail: 'Caixa + receber − pagar · valores previstos por vencimento' },
    { label: 'Ativo circulante (milhões)', cents: null, millions: currentAssets, detail: currentAssets !== null ? 'Fórmula oficial · resultado em milhões de reais · sem arredondar as etapas' : 'Informe todos os componentes da fórmula oficial' },
  ];

  async function savePosition() {
    if (!canManage || !canReadDirectorSummary || saving || !position) return;
    if (reportNotice && !reportNotice.includes('aguarda ativação')) return;
    if (!window.confirm(`Salvar posição ${report?.complete ? 'completa' : 'parcial'} da Diretoria?\n\nReferência: ${displayDate(reportDate)}\nFluxo financeiro: ${rangeLabel}\nValores e fontes serão preservados no histórico. Nenhum valor ausente será substituído por zero.`)) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      if (!supabase) throw new Error('connection');
      const result = await supabase.rpc('save_director_position', { p_start: range.start, p_end: range.end });
      if (result.error) throw result.error;
      setSuccess(`Posição ${report?.complete ? 'completa' : 'parcial'} salva no histórico com data, hora e responsável.`); setHistoryRevision(value => value + 1);
    } catch { setError('Não foi possível salvar a posição. Atualize o painel antes de tentar novamente.'); }
    finally { setSaving(false); }
  }

  async function exportExcel() {
    if (!position || exporting || !canReadDirectorSummary) return;
    setExporting(true); setError('');
    try {
      const amounts = [...commercial, ...financial, ...obligations].map(indicator => indicator.cents).concat(summaryAccounts.map(account => account.amount_cents));
      // Limite conservador: contar todos os algarismos dos centavos,
      // inclusive zeros finais, pois a divisão por 100 também pode perder precisão.
      if (amounts.some(cents => cents !== null && BigInt(Math.abs(cents)).toString().length > 15)) {
        setError('O Excel não preserva todos os centavos de um dos valores desta posição, pois aceita até 15 algarismos significativos. A exportação foi interrompida para evitar arredondamento.');
        return;
      }
      if (currentAssets !== null && excelMillions(currentAssets) === null) {
        setError('O resultado exato do Ativo Circulante excede os 15 algarismos do Excel. A exportação foi interrompida para evitar arredondamento. Consulte a memória do cálculo no painel.'); return;
      }
      const { Workbook } = await import('exceljs');
      const book = new Workbook(); book.creator = 'Central Financeira · Grupo Ecoplast'; book.created = new Date();
      const sheet = book.addWorksheet('Resumo da Diretoria');
      sheet.columns = [{ header: 'Seção', key: 'section', width: 20 }, { header: 'Indicador', key: 'indicator', width: 34 }, { header: 'Valor', key: 'value', width: 30 }, { header: 'Origem / Situação', key: 'source', width: 66 }];
      const completeness = report?.complete ? 'POSIÇÃO COMPLETA' : 'POSIÇÃO PARCIAL';
      sheet.addRow({ section: completeness, indicator: 'Período inicial', value: new Date(`${range.start}T12:00:00Z`) }).getCell(3).numFmt = 'dd/mm/yyyy';
      sheet.addRow({ section: completeness, indicator: 'Período final', value: new Date(`${range.end}T12:00:00Z`) }).getCell(3).numFmt = 'dd/mm/yyyy';
      sheet.addRow({ section: completeness, indicator: 'Data da posição de caixa', value: new Date(`${reportDate}T12:00:00Z`), source: 'Último saldo de cada conta até essa data.' }).getCell(3).numFmt = 'dd/mm/yyyy';
      const currencyFormat = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
      const excelValue = (indicator: Indicator) => indicator.millions !== undefined ? indicator.millions === null ? 'CÁLCULO AGUARDANDO INFORMAÇÕES' : excelMillions(indicator.millions)! : indicator.percentageBps !== undefined ? indicator.percentageBps === null ? BASE_PENDING : indicator.percentageBps / 10000 : indicator.cents === null ? indicator.label === 'Caixa total' ? CASH_PENDING : indicator.label === 'Estoque total' ? STOCK_PENDING : BASE_PENDING : indicator.cents / 100;
      const excelFormat = (indicator: Indicator) => indicator.millions !== undefined ? '0.00########" mi"' : indicator.percentageBps !== undefined ? '0.00%' : currencyFormat;
      for (const [section, indicators] of [['COMERCIAL', commercial], ['FINANCEIRO', financial], ['OBRIGAÇÕES', obligations]] as [string, Indicator[]][]) for (const indicator of indicators) {
        const row = sheet.addRow({ section, indicator: indicator.label, value: excelValue(indicator), source: indicator.detail });
        row.getCell(3).numFmt = excelFormat(indicator);
      }
      const daily = book.addWorksheet('Posição diária');
      daily.columns = [{ width: 42 }, { width: 31 }, { width: 85 }];
      daily.addRow(['DESCRIÇÕES', new Date(`${reportDate}T12:00:00Z`), 'Origem / Situação']); daily.getCell('B1').numFmt = 'dd/mm/yyyy';
      const dailyIndicators = [...commercial, ...financial.slice(0, 4), financial[4], { ...financial[0], label: 'Total contas a receber' }, financial[5], ...obligations.slice(0, 3), obligations[5]];
      for (const indicator of dailyIndicators) {
        const row = daily.addRow([indicator.label, excelValue(indicator), indicator.detail]); row.getCell(2).numFmt = excelFormat(indicator);
      }
      daily.addRow(['FÓRMULA DO ATIVO CIRCULANTE', ASSETS_FORMULA, 'Resultado em milhões de reais; sem M49.']);
      for (const account of summaryAccounts) {
        const row = daily.addRow([accountName(account), account.amount_cents === null ? CASH_PENDING : account.amount_cents / 100, `Saldo de ${displayDate(account.balance_date)}`]); row.getCell(2).numFmt = currencyFormat;
      }
      daily.addRow(['Total caixa / bancos', summaryCash?.total_cents == null ? CASH_PENDING : summaryCash.total_cents / 100, 'Consolidado das contas; entra uma única vez na fórmula.']).getCell(2).numFmt = currencyFormat;
      const calculation = book.addWorksheet('Memória do cálculo');
      calculation.columns = [{ header: 'Componente', width: 36 }, { header: 'Valor (R$)', width: 28 }, { header: 'Operação', width: 30 }];
      for (const [indicator, operation] of [[financial[4], '+'], [financial[0], '+'], [financial[5], '+'], [obligations[2], '−'], [commercial[2], '− 14%'], [obligations[0], '−'], [obligations[1], '−']] as [Indicator, string][]) {
        calculation.addRow([indicator.label, excelValue(indicator), operation]).getCell(2).numFmt = currencyFormat;
      }
      calculation.addRow(['Ativo circulante (milhões)', excelValue(obligations[5]), 'Soma dos componentes ÷ 1.000.000']).getCell(2).numFmt = excelFormat(obligations[5]);
      calculation.addRow(['Fórmula', ASSETS_FORMULA, report?.formula_version ?? 'Aguardando ativação']);
      for (const missing of report?.missing_sources ?? []) calculation.addRow(['Pendente', missing]);
      const accounts = book.addWorksheet('Caixa por empresa e banco');
      accounts.columns = [{ header: 'Empresa', key: 'company', width: 22 }, { header: 'Banco', key: 'bank', width: 22 }, { header: 'Conta / Caixa', key: 'account', width: 34 }, { header: 'Tipo', key: 'type', width: 22 }, { header: 'Data do saldo', key: 'date', width: 18 }, { header: 'Saldo (R$)', key: 'balance', width: 25 }];
      for (const account of summaryAccounts) {
        const row = accounts.addRow({ company: account.company, bank: account.bank, account: accountName(account), type: accountType(account), date: account.balance_date ? new Date(`${account.balance_date}T12:00:00Z`) : 'NÃO INFORMADA', balance: account.amount_cents === null ? CASH_PENDING : account.amount_cents / 100 });
        row.getCell(5).numFmt = 'dd/mm/yyyy'; if (account.amount_cents !== null) row.getCell(6).numFmt = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
      }
      for (const worksheet of [sheet, accounts, daily, calculation]) { worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF135B45' } }; worksheet.views = [{ state: 'frozen', ySplit: 1 }]; worksheet.autoFilter = { from: 'A1', to: `${worksheet === sheet ? 'D' : worksheet === accounts ? 'F' : 'C'}1` }; }
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
    {receivableNotice && <p className="notice" role="status">{receivableNotice}</p>}
    {projectionBig !== null && projection === null && <p className="alert error" role="alert">A projeção ultrapassou o limite de precisão. O valor não foi arredondado nem exibido.</p>}
    <div className="financial-kpis">
      <article className="financial-kpi"><span className="financial-kpi-label">CAIXA HOJE</span><strong><MoneyValue cents={cashCents} caption={CASH_PENDING} /></strong><small>{cashCents !== null ? `Saldo consolidado · ${position?.cash.reported_accounts} contas` : 'Contas bancárias e caixas das empresas'}</small></article>
      <article className="financial-kpi"><span className="financial-kpi-label">CAIXA PROJETADO</span><strong><MoneyValue cents={projection} /></strong><small>Depende dos saldos, recebíveis e compromissos do período.</small></article>
      <article className="financial-kpi"><span className="financial-kpi-label">A RECEBER {scopeLabel.toUpperCase()}</span><strong><MoneyValue cents={receivablePeriod} /></strong><small>{rangeLabel}</small></article>
      <article className="financial-kpi payable-kpi"><span className="financial-kpi-label">A PAGAR {scopeLabel.toUpperCase()}</span><strong><MoneyValue cents={payablePeriod} /></strong><small>{rangeLabel}</small></article>
    </div>
    <div className="financial-overview-grid"><section className="financial-card movement-card"><div className="financial-card-heading"><div><h2>Movimento {mode === 'week' ? 'da semana' : mode === 'month' ? 'do mês' : 'do dia'}</h2><p className="financial-caption">{rangeLabel} · caixa atual + receber − pagar</p></div>{canViewCash && <button className="button secondary" onClick={() => onNavigate('caixa')}>Abrir Caixa →</button>}</div><dl className="financial-ledger"><div><dt>Saldo de entrada</dt><dd><MoneyValue cents={cashCents} caption={CASH_PENDING} /></dd></div><div><dt>+ Receber {scopeLabel}</dt><dd><MoneyValue cents={receivablePeriod} /></dd></div><div><dt>− Pagar {scopeLabel}</dt><dd><MoneyValue cents={payablePeriod} /></dd></div><div className="financial-ledger-total"><dt>Caixa projetado</dt><dd><MoneyValue cents={projection} /></dd></div></dl><p className="financial-caption">{projection !== null ? 'Projeção por vencimento. Inclui títulos sem recebimento validado; não representa dinheiro disponível em conta.' : 'Projeção aguardando saldos e bases completas do período.'}</p></section><section className="financial-card attention-card"><div className="financial-card-heading"><div><h2>Atenção da Gestão</h2><p className="financial-caption">Pontos que merecem acompanhamento.</p></div></div><dl className="financial-attention">{coverage.count > 0 && <div className="cash-coverage-attention"><dt><i className="attention-dot red" /><span>Contas negativas — cobrir hoje<small>{coverage.count} conta(s){` · ${negativeFreshness}`}{position?.cash.total_cents === null ? " · Posição incompleta" : ""}</small>{canViewCash && <button className="financial-text-button" onClick={() => onNavigate('caixa')}>Ver contas negativas →</button>}</span></dt><dd>{coverage.cents !== null ? money(coverage.cents) : "Valor acima do limite seguro"}</dd></div>}<div><dt><i className="attention-dot red" />Contas a receber vencidas</dt><dd><MoneyValue cents={receivableOverdue} /></dd></div><div><dt><i className="attention-dot amber" />Contas a pagar vencidas / pendentes</dt><dd><MoneyValue cents={payableOverdue} /></dd></div><div><dt><i className="attention-dot amber" />Títulos sem cobradora definida</dt><dd>{receivableImported ? position!.receivables!.unassigned_count : <Pending />}</dd></div><div><dt><i className="attention-dot green" />Margem líquida do fechamento</dt><dd><Pending /></dd></div></dl></section></div>
    <section className="financial-card receivables-management-summary" aria-labelledby="receivables-management-title">
      <div className="financial-card-heading"><div><h2 id="receivables-management-title">Contas a Receber · posição de hoje</h2><p className="financial-caption">{receivableManagementDay ? `Referência ${displayDate(receivableManagementDay)} · data oficial de Brasília.` : 'Data oficial aguardando consulta ao banco.'} O recebimento do dia acompanha esta data, independentemente do período escolhido no painel.</p></div><button type="button" className="button secondary" disabled={loading} onClick={() => setRevision(value => value + 1)}>Atualizar Contas a Receber</button></div>
      {receivableManagementError && <p className="alert error" role="alert">{receivableManagementError}</p>}
      {receivableManagementNotice && <p className="notice">{receivableManagementNotice}</p>}
      <div className="financial-module-grid">
        <article><h3>Contas a receber em atraso</h3><strong><MoneyValue cents={receivableManagementPosition?.overdue_cents ?? null} caption={receivableManagementPending} /></strong><p>{receivableManagementDay ? `Saldo em aberto dos títulos vencidos antes de ${displayDate(receivableManagementDay)}` : 'Saldo em aberto dos títulos vencidos na posição oficial'}, após os recebimentos validados.</p></article>
        <article><h3>Total a receber</h3><strong><MoneyValue cents={receivableManagementPosition?.open_cents ?? null} caption={receivableManagementPending} /></strong><p>Saldo da carteira ativa, incluindo os títulos de hoje e a vencer. Recebimentos validados já foram descontados.</p></article>
        <article><h3>Recebido no dia</h3><strong><MoneyValue cents={receivableManagementPosition?.received_day_cents ?? null} caption={receivableManagementPosition?.legacy ? RECEIVED_PENDING : receivableManagementPending} /></strong><p>{receivableManagementDay ? displayDate(receivableManagementDay) : 'Data oficial não disponível'} · valores efetivamente recebidos e validados financeiramente pela data real do recebimento.</p></article>
      </div>
      {receivableManagementPosition?.imported_at && <p className="financial-caption">Última importação de Contas a Receber: {displayDateTime(receivableManagementPosition.imported_at)}.</p>}
    </section>
    {canReadDirectorSummary && <section className="financial-card director-summary">
      <div className="financial-card-heading">
        <div><h2>Resumo da Diretoria</h2><p className="financial-caption">Referência {displayDate(reportDate)} · Faturamento do mês atual · Fluxo financeiro de {rangeLabel}.{position && updatedAt ? ` Atualizado ${displayDateTime(updatedAt)}.` : ''}</p></div>
        <div className="inline-actions financial-summary-actions">
          <span className={`badge ${report?.complete ? 'concluida' : 'pendente'}`}>{report?.complete ? 'POSIÇÃO COMPLETA' : 'POSIÇÃO PARCIAL'}</span>
          <button className="button secondary" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>Atualizar agora</button>
          {canManage && <button className="button secondary" disabled={loading || saving || !position || Boolean(reportNotice && !reportNotice.includes('aguarda ativação'))} onClick={() => void savePosition()}>{saving ? 'Salvando…' : 'Salvar posição'}</button>}
          <button className="button secondary" disabled={loading || !position || exporting} onClick={() => void exportExcel()}>{exporting ? 'Gerando Excel…' : 'Baixar Excel'}</button>
          <button className="button secondary" disabled={loading || !position} onClick={() => window.print()}>Imprimir / PDF</button>
          <button className="button secondary" onClick={() => setHistoryOpen(value => !value)}>{historyOpen ? 'Fechar histórico' : 'Histórico das posições'}</button>
        </div>
      </div>
      {reportNotice && <p className="notice director-report-notice">{reportNotice}</p>}
      {canManage && onDirectorInputs && <p className="financial-caption">Faturamento, pedidos e parâmetros conferidos pela Gerência: <button className="financial-text-button" onClick={onDirectorInputs}>Informar posição da Diretoria →</button></p>}
      <div className="director-summary-grid">
        {([['COMERCIAL', 'Faturamento + Pedidos', commercial], ['FINANCEIRO', 'Receber + Caixa + Estoque', financial], ['OBRIGAÇÕES', 'Contas a Pagar + Parâmetros', obligations]] as [string, string, Indicator[]][]).map(([title, source, indicators]) => <div className="director-summary-column" key={title}>
          <div className="director-summary-heading"><h3>{title}</h3><small>{source}</small></div>
          <dl>{indicators.map(indicator => <div key={indicator.label}><dt>{indicator.label}<small>{indicator.detail}</small></dt><dd><IndicatorValue indicator={indicator} caption={indicator.label === 'Caixa total' ? CASH_PENDING : indicator.label === 'Estoque total' ? STOCK_PENDING : BASE_PENDING} /></dd></div>)}</dl>
        </div>)}
      </div>
      <details className="director-calculation"><summary>Memória do cálculo do Ativo Circulante</summary><p>{ASSETS_FORMULA}</p>
        <dl>{[financial[4], financial[0], financial[5], obligations[2], commercial[2], obligations[0], obligations[1]].map(indicator => <div key={indicator.label}><dt>{indicator.label}{indicator.label === 'Faturamento geral' ? ' (dedução de 14%)' : ''}</dt><dd><MoneyValue cents={indicator.cents} caption={indicator.label === 'Estoque total' ? STOCK_PENDING : BASE_PENDING} /></dd></div>)}</dl>
        <p><strong>Resultado: <IndicatorValue indicator={obligations[5]} caption="CÁLCULO AGUARDANDO INFORMAÇÕES" /></strong></p>
        <p className="financial-caption">O caixa consolidado e o total a receber entram uma única vez. O estoque mantém a data de referência informada. As etapas do cálculo não são arredondadas.</p>
      </details>
      {report && report.missing_sources.length > 0 && <details className="director-calculation director-pending"><summary>Informações pendentes ({report.missing_sources.length})</summary><ul>{report.missing_sources.map((source, index) => <li key={`${index}:${source}`}>{source}</li>)}</ul></details>}
      <div className="director-cash-detail"><h3>Caixa detalhado por empresa / conta</h3>
        {summaryCash ? <div className="table-scroll"><table><thead><tr><th>Empresa</th><th>Conta / Caixa</th><th>Data do saldo</th><th className="financial-numeric">Saldo</th></tr></thead>
          <tbody>{summaryAccounts.map(account => <tr key={account.id}><td>{account.company}</td><td><strong>{accountName(account)}</strong><small className="financial-caption bank-account-label">{accountType(account)}</small></td><td>{displayDate(account.balance_date)}</td><td className="financial-numeric"><MoneyValue cents={account.amount_cents} caption={CASH_PENDING} /></td></tr>)}</tbody>
          <tfoot><tr><th colSpan={3}>Total caixa / bancos</th><td className="financial-numeric"><strong><MoneyValue cents={summaryCash.total_cents} caption={CASH_PENDING} /></strong></td></tr></tfoot>
        </table></div> : <p className="financial-caption">{loading ? 'Carregando saldos…' : CASH_PENDING}</p>}
      </div>
      {historyOpen && <div className="director-history"><h3>Histórico das posições</h3>
        {historyLoading && <p className="financial-loading" role="status">Carregando histórico…</p>}{historyError && <p className="alert error" role="alert">{historyError}</p>}
        {!historyLoading && !historyError && history.length === 0 && <p className="empty-state">Nenhuma posição salva.</p>}
        {history.length > 0 && <div className="table-scroll"><table><thead><tr><th>Salva em</th><th>Período</th><th>Caixa</th><th>A pagar no período</th><th>Estoque</th><th>Ativo circulante</th><th>Situação</th></tr></thead>
          <tbody>{history.map(snapshot => <tr key={snapshot.id}><td>{displayDateTime(snapshot.created_at)}</td><td>{displayDate(snapshot.period_start)}–{displayDate(snapshot.period_end)}</td>
            {['cash_cents', 'payable_period_cents', 'stock_cents'].map(key => <td key={key}><MoneyValue cents={reportAmount(snapshot.indicators, key)} caption={key === 'cash_cents' ? CASH_PENDING : key === 'stock_cents' ? STOCK_PENDING : BASE_PENDING} /></td>)}
            <td>{exactMillions(snapshot.indicators.current_assets_millions) === null ? 'Não calculado nesta posição' : displayMillions(exactMillions(snapshot.indicators.current_assets_millions)!)}</td>
            <td>{snapshot.indicators.complete ? 'Completa' : 'Parcial'}<SnapshotDetails values={snapshot.indicators} /></td>
          </tr>)}</tbody>
        </table></div>}
        <div className="pagination"><span>{historyCount} posição(ões) · Página {historyPage + 1}</span><button className="button secondary" disabled={historyLoading || historyPage === 0} onClick={() => setHistoryPage(value => value - 1)}>Anterior</button><button className="button secondary" disabled={historyLoading || (historyPage + 1) * 20 >= historyCount} onClick={() => setHistoryPage(value => value + 1)}>Próxima</button></div>
      </div>}
    </section>}
    <section className="financial-card"><div className="financial-card-heading"><div><h2>Indicadores mensais e módulos</h2><p className="financial-caption">Saldos e totais refletem somente registros persistidos na base central.</p></div><button className="button secondary" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>Atualizar indicadores</button></div><div className="financial-module-grid"><article><h3>Total a pagar em aberto</h3><strong><MoneyValue cents={payableOpen} /></strong><p>{payableImported ? `${position!.payables.active_count} títulos ativos · importação ${displayDateTime(position!.payables.latest_import_at!)}` : 'Contas a Pagar · importe o relatório completo na área Importar Bases.'}</p>{canViewPayables && <button className="financial-text-button" onClick={() => onNavigate('contas_pagar')}>Consultar Contas a Pagar →</button>}</article><article><h3>Total recebido consolidado</h3><strong><MoneyValue cents={receivedPeriod} /></strong><p>Recebimentos validados com origem IMPORTAÇÃO DIÁRIA e data real de pagamento em {rangeLabel}. Valores somente informados pela cobradora não entram no total.</p>{canViewReceivables && <button className="financial-text-button" onClick={() => onNavigate('contas_receber')}>Consultar Contas a Receber →</button>}</article><article><h3>Faturamento e ativo circulante</h3><strong>{canReadDirectorSummary ? <MoneyValue cents={reportAmount(reportValues, 'turnover_cents')} /> : <Pending />}</strong><p>{canReadDirectorSummary && currentAssets !== null ? `Ativo circulante: ${displayMillions(currentAssets)}. Consulte a memória do cálculo no Resumo da Diretoria.` : 'O cálculo depende do estoque e de todos os parâmetros oficiais.'}</p></article></div></section>
  </div>;
}
