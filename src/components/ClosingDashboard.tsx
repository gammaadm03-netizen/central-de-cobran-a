import { useEffect, useState } from 'react';
import { commercialError, readCommercial, type CommercialFilters, type CommercialReport, type CommercialRow } from '../lib/commercial';
import { dateLabel, formatCents } from '../lib/payables';
import '../closing-dashboard.css';

const maximumItems = 20000;
const monthPattern = /^(19\d{2}|20\d{2}|21\d{2})-(0[1-9]|1[0-2])-01$/;
const cash = (value: number | null) => value === null ? 'Não informado' : formatCents(value);
const percent = (value: number | null) => value === null ? 'Não informado' : `${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const nullableInteger = (value: unknown) => value === null || Number.isSafeInteger(value);
const nullablePercent = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value);
type MoneyField = 'sale_cents' | 'cost_cents' | 'tax_cents' | 'freight_cents' | 'commission_cents' | 'margin_cents';
type Group = { name: string; items: number; sale: number; margin: number | null };
type Dashboard = { report: CommercialReport; rows: CommercialRow[]; totals: Record<MoneyField, number | null>; branches: Group[]; centres: Group[]; missingMargins: number };

function monthLabel(value: string) {
  return monthPattern.test(value) ? new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.slice(0, 7)}-01T12:00:00Z`)) : 'Último fechamento';
}
function validReport(data: CommercialReport) {
  if (!data || !monthPattern.test(data.month) || typeof data.revision !== 'string' || !Number.isSafeInteger(data.count) || data.count < 0 || !Array.isArray(data.rows) || data.rows.length > Math.min(500, data.count) || !data.summary || !data.options) return false;
  if (data.source !== null && (!data.source || typeof data.source.import_id !== 'string' || typeof data.source.file_name !== 'string' || data.source.month !== data.month || !Number.isFinite(Date.parse(data.source.updated_at)))) return false;
  const s = data.summary;
  if (![s.sale_cents, s.filtered_sale_cents, s.row_count, s.filtered_count].every(Number.isSafeInteger) || s.row_count !== data.count || s.filtered_count !== data.count || s.sale_cents !== s.filtered_sale_cents || s.margin_cents !== s.filtered_margin_cents || !nullableInteger(s.margin_cents) || !nullablePercent(s.margin_percent)) return false;
  if (!['months', 'branches', 'centres', 'employees'].every(key => Array.isArray(data.options[key as keyof typeof data.options]) && data.options[key as keyof typeof data.options].every(item => typeof item === 'string'))) return false;
  if (!data.options.months.every(item => monthPattern.test(item)) || !data.source && data.count !== 0) return false;
  return data.rows.every(row => row && typeof row.id === 'string' && !!row.id && typeof row.branch === 'string' && typeof row.cost_center === 'string' && Number.isSafeInteger(row.sale_cents)
    && [row.cost_cents, row.tax_cents, row.freight_cents, row.commission_cents, row.margin_cents].every(nullableInteger));
}
function sameVersion(first: CommercialReport, next: CommercialReport) {
  return validReport(next) && next.month === first.month && next.revision === first.revision && next.count === first.count && next.source?.import_id === first.source?.import_id
    && next.summary.sale_cents === first.summary.sale_cents && next.summary.margin_cents === first.summary.margin_cents && next.summary.margin_percent === first.summary.margin_percent;
}
function sum(rows: CommercialRow[], field: MoneyField) {
  if (rows.some(row => row[field] === null)) return null;
  const result = rows.reduce((total, row) => total + BigInt(row[field]!), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('unsafe_dashboard');
  return Number(result);
}
function groups(rows: CommercialRow[], field: 'branch' | 'cost_center'): Group[] {
  const grouped = new Map<string, CommercialRow[]>();
  for (const row of rows) {
    const name = row[field].trim() || 'Não informado';
    const members = grouped.get(name) ?? [];
    members.push(row); grouped.set(name, members);
  }
  return [...grouped].map(([name, members]) => ({ name, items: members.length, sale: sum(members, 'sale_cents')!, margin: sum(members, 'margin_cents') }))
    .sort((left, right) => Math.abs(right.sale) - Math.abs(left.sale) || left.name.localeCompare(right.name, 'pt-BR'));
}
function consolidate(report: CommercialReport, rows: CommercialRow[]): Dashboard {
  if (rows.length !== report.count || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('changed_dashboard');
  const totals = Object.fromEntries((['sale_cents', 'cost_cents', 'tax_cents', 'freight_cents', 'commission_cents', 'margin_cents'] as const).map(field => [field, sum(rows, field)])) as Dashboard['totals'];
  if (report.source && (totals.sale_cents !== report.summary.sale_cents || totals.margin_cents !== report.summary.margin_cents)) throw new Error('changed_dashboard');
  return { report, rows, totals, branches: groups(rows, 'branch'), centres: groups(rows, 'cost_center'), missingMargins: rows.filter(row => row.margin_cents === null).length };
}
function Breakdown({ title, rows }: { title: string; rows: Group[] }) {
  const maximum = Math.max(1, ...rows.flatMap(row => [Math.abs(row.sale), Math.abs(row.margin ?? 0)]));
  return <section className="panel closing-breakdown" aria-label={title}>
    <h3>{title}</h3><p className="help-text">Todos os itens do mês. Valores negativos aparecem em vermelho.</p>
    <div className="closing-chart-legend" aria-hidden="true"><span>Venda</span><span>Margem</span></div>
    <div className="table-wrap"><table><caption>{title}</caption><thead><tr><th>Grupo</th><th>Itens</th><th>Venda</th><th>Margem</th><th>Margem %</th></tr></thead><tbody>{rows.map(row => <tr key={row.name}>
      <th scope="row">{row.name}</th><td>{row.items.toLocaleString('pt-BR')}</td>
      <td><span className={row.sale < 0 ? 'closing-negative' : ''}>{cash(row.sale)}</span><span className={`closing-data-bar ${row.sale < 0 ? 'closing-data-bar-negative' : ''}`} aria-hidden="true" style={{ width: `${Math.abs(row.sale) / maximum * 100}%` }} /></td>
      <td><span className={row.margin !== null && row.margin < 0 ? 'closing-negative' : ''}>{cash(row.margin)}</span>{row.margin !== null && <span className={`closing-data-bar closing-data-bar-margin ${row.margin < 0 ? 'closing-data-bar-negative' : ''}`} aria-hidden="true" style={{ width: `${Math.abs(row.margin) / maximum * 100}%` }} />}</td>
      <td>{percent(row.margin === null || row.sale === 0 ? null : row.margin / row.sale * 100)}</td>
    </tr>)}</tbody></table></div>
  </section>;
}

export default function ClosingDashboard({ refreshKey = 0, onMargins, onCosts, onImport }: {
  refreshKey?: number; onMargins?: () => void; onCosts?: () => void; onImport?: () => void;
}) {
  const [month, setMonth] = useState(''), [months, setMonths] = useState<string[]>([]), [refresh, setRefresh] = useState(0);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null), [loading, setLoading] = useState(true), [progress, setProgress] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setDashboard(null); setError(''); setProgress('Consultando o fechamento…');
    void (async () => {
      const filters: CommercialFilters = { month, search: '', branch: '', centre: '', employee: '', marginBand: '' };
      const first = await readCommercial(filters, 0, 500, abort.signal);
      if (abort.signal.aborted) return;
      if (!validReport(first) || month !== '' && first.month !== month) throw new Error('invalid_dashboard');
      if (first.count > maximumItems) throw new Error('limit_dashboard');
      const rows = [...first.rows]; const frozen = { ...filters, month: first.month };
      while (rows.length < first.count) {
        setProgress(`Consultando ${rows.length.toLocaleString('pt-BR')} de ${first.count.toLocaleString('pt-BR')} itens do fechamento…`);
        const next = await readCommercial(frozen, rows.length, 500, abort.signal);
        if (abort.signal.aborted) return;
        if (!sameVersion(first, next) || !next.rows.length || rows.length + next.rows.length > first.count) throw new Error('changed_dashboard');
        rows.push(...next.rows);
      }
      if (first.count > first.rows.length) {
        const current = await readCommercial(frozen, 0, 1, abort.signal);
        if (abort.signal.aborted) return;
        if (!sameVersion(first, current)) throw new Error('changed_dashboard');
      }
      const result = consolidate(first, rows);
      if (!abort.signal.aborted) { setDashboard(result); setMonths(first.options.months); }
    })().catch(failure => {
      if (abort.signal.aborted) return;
      const detail = failure instanceof Error ? failure.message : '';
      setError(commercialError(failure, detail === 'changed_dashboard' ? 'O fechamento mudou durante a consulta. Atualize os dashboards para conferir a versão atual.' : detail === 'limit_dashboard' ? 'Este fechamento ultrapassa 20.000 itens. Consulte os itens em Margens; os dashboards não exibem totais parciais.' : 'Não foi possível conferir os dashboards do fechamento. Atualize para tentar novamente.'));
    }).finally(() => { if (!abort.signal.aborted) { setLoading(false); setProgress(''); } });
    return () => abort.abort();
  }, [month, refresh, refreshKey]);
  const report = dashboard?.report, totals = dashboard?.totals;
  return <div className="stack closing-dashboard">
    <section className="panel" aria-labelledby="closing-dashboard-title"><div className="panel-header"><div><h2 id="closing-dashboard-title">Dashboards do fechamento</h2><p className="muted">Resultado consolidado do mês e distribuição por filial e centro de custo.</p></div><div className="inline-actions"><button type="button" className="button secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Atualizar dashboards</button>{onImport && <button type="button" className="button" onClick={onImport}>Importar fechamento</button>}</div></div>
      <div className="closing-dashboard-controls"><label className="field">Mês dos dashboards do fechamento<select value={month || report?.month || ''} onChange={event => setMonth(event.target.value)}><option value="">Último fechamento</option>{months.map(value => <option key={value} value={value}>{monthLabel(value)}</option>)}{month && !months.includes(month) && <option value={month}>{monthLabel(month)}</option>}</select></label><div className="inline-actions">{onMargins && <button type="button" className="button secondary" onClick={onMargins}>Abrir Margens</button>}{onCosts && <button type="button" className="button secondary" onClick={onCosts}>Consultar Custos</button>}</div></div>
      {report?.source && <p className="help-text closing-source">{report.source.file_name} · {monthLabel(report.month)} · Atualizado em {dateLabel(report.source.updated_at)}</p>}
      {loading && <p role="status" className="help-text closing-source">{progress}</p>}{error && <p role="alert" className="notice error">{error}</p>}
    </section>
    {dashboard && report && totals && (report.source ? <>
      <section className="closing-kpis" aria-label="Indicadores do fechamento">
        {[
          ['Venda total', cash(totals.sale_cents), 'Todos os itens do mês'], ['CMV total', cash(totals.cost_cents), 'Custo dos itens do fechamento'],
          ['Margem do fechamento', cash(report.summary.margin_cents), 'Margem final preservada da base'], ['Margem do fechamento %', percent(report.summary.margin_percent), 'Margem total ÷ venda total'],
          ['Itens do fechamento', report.count.toLocaleString('pt-BR'), 'Linhas do fechamento importado'], ['Itens sem margem', dashboard.missingMargins.toLocaleString('pt-BR'), 'Precisam de conferência na base'],
          ['Impostos', cash(totals.tax_cents), 'Valores informados no fechamento'], ['Fretes', cash(totals.freight_cents), 'Valores informados no fechamento'],
          ['Comissões do fechamento', cash(totals.commission_cents), 'Componente informado no fechamento'],
        ].map(([label, value, note]) => <article key={label} className="closing-kpi"><h3>{label}</h3><strong>{value}</strong><small>{note}</small></article>)}
      </section>
      {dashboard.missingMargins > 0 && <p className="notice">Há {dashboard.missingMargins.toLocaleString('pt-BR')} item(ns) sem margem informada. A margem consolidada permanece não informada enquanto a base estiver incompleta.</p>}
      <p className="help-text">Os gráficos consideram a mesma versão e todos os itens do mês. Um componente ausente mantém seu total como Não informado. A margem final segue o fechamento, inclusive quando foi informada no arquivo.</p>
      {report.count > 0 ? <div className="closing-breakdowns"><Breakdown title="Venda e margem por filial" rows={dashboard.branches} /><Breakdown title="Venda e margem por centro de custo" rows={dashboard.centres} /></div> : <p className="notice">O fechamento deste mês está cadastrado sem itens.</p>}
    </> : <section className="panel"><h3>Nenhum fechamento importado para este mês</h3><p className="muted">Os dashboards ficam disponíveis após a importação do fechamento do mês em Importar Bases → Fechamento / Faturamento. Os dados de Margens e Custos ficam nas opções do menu lateral.</p></section>)}
  </div>;
}
