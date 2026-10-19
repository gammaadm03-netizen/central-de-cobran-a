import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import { officialToday } from './Treasury';
import '../human-resources.css';

interface HrRow {
  source_row: number; branch: string; employee: string; sector: string; admitted_on: string | null; birthday_on: string | null;
  salary_base_cents: number | null; payroll_salary_cents: number | null; transport_cents: number | null; advance_cents: number | null; cost_allowance_cents?: number | null; total_cents: number | null; reported_total_cents?: number | null;
  count_label: string | null; basket_eligible: boolean; basket_cost_cents: number; is_partner: boolean;
}
interface HrGroup { label: string; count: number; salary_base_cents: number | null }
interface HrReport {
  snapshot: { id: string; reference_date: string; file_name: string; imported_at: string; sha256: string; row_count: number } | null;
  summary: { employees: number; partners: number; admissions: number; birthdays: number; basket_eligible: number; basket_excluded: number; basket_unit_cents: number;
    basket_monthly_cents: number; basket_annual_cents: number; salary_base_cents: number | null; salary_base_all_cents?: number | null; payroll_salary_employees_cents?: number | null; payroll_salary_cents?: number | null; transport_cents: number | null; advance_cents: number | null; cost_allowance_cents?: number | null; total_cents: number | null; reported_total_cents?: number | null; total_formula_version?: string; total_formula_caption?: string };
  by_branch: HrGroup[]; by_sector: HrGroup[]; birthdays: (HrRow & { day: number })[]; work_anniversaries: (HrRow & { day: number; years: number })[];
  quality: Record<string, number>; rows: HrRow[];
}
const months = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const countFields = ['employees', 'partners', 'admissions', 'birthdays', 'basket_eligible', 'basket_excluded', 'basket_unit_cents', 'basket_monthly_cents', 'basket_annual_cents'] as const;
const moneyFields = ['salary_base_cents', 'transport_cents', 'advance_cents', 'total_cents'] as const;
const qualityLabels: Record<string, string> = { missing_admission: 'Sem data de admissão', missing_birthday: 'Sem aniversário', missing_branch: 'Sem filial', missing_sector: 'Sem setor', missing_salary_base: 'Sem Salário Folha / salário base', missing_payroll_salary: 'Sem salário recebido', missing_transport: 'Sem vale-transporte', missing_advance: 'Sem adiantamento', missing_cost_allowance: 'Sem ajuda de custo', missing_total: 'Total não informado' };
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableMoney = (value: unknown) => value === null || Number.isSafeInteger(value);
// Earlier positions have no allowance field or payroll total. Preserve them as unknown.
const optionalMoney = (value: unknown) => value === undefined || nullableMoney(value);
function civilDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z'); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validRow(row: HrRow) {
  return !!row && safeCount(row.source_row) && row.source_row > 0 && ['branch', 'employee', 'sector'].every(key => typeof row[key as keyof HrRow] === 'string')
    && !!row.employee.trim() && (row.admitted_on === null || civilDate(row.admitted_on)) && (row.birthday_on === null || civilDate(row.birthday_on))
    && [...moneyFields, 'payroll_salary_cents'].every(key => nullableMoney(row[key as keyof HrRow])) && optionalMoney(row.cost_allowance_cents) && optionalMoney(row.reported_total_cents)
    && (row.count_label === null || typeof row.count_label === 'string') && typeof row.basket_eligible === 'boolean' && typeof row.is_partner === 'boolean'
    && safeCount(row.basket_cost_cents) && row.basket_cost_cents === (row.basket_eligible ? 11280 : 0);
}
function validReport(value: unknown): value is HrReport {
  const report = value as HrReport;
  if (!report || !report.summary || !Array.isArray(report.rows) || report.rows.length > 5000 || !report.rows.every(validRow)) return false;
  const summary = report.summary;
  if (!countFields.every(key => safeCount(summary[key])) || !moneyFields.every(key => nullableMoney(summary[key])) || summary.basket_unit_cents !== 11280
    || !optionalMoney(summary.payroll_salary_cents) || !optionalMoney(summary.cost_allowance_cents) || !optionalMoney(summary.reported_total_cents) || !optionalMoney(summary.salary_base_all_cents) || !optionalMoney(summary.payroll_salary_employees_cents)
    || summary.total_formula_version !== undefined && summary.total_formula_version !== 'rh-five-fields-v1'
    || summary.employees + summary.partners !== report.rows.length || summary.basket_eligible + summary.basket_excluded !== report.rows.length
    || summary.basket_monthly_cents !== summary.basket_eligible * summary.basket_unit_cents || summary.basket_annual_cents !== summary.basket_monthly_cents * 12) return false;
  if (report.snapshot !== null && (!report.snapshot || typeof report.snapshot.id !== 'string' || !civilDate(report.snapshot.reference_date)
    || typeof report.snapshot.file_name !== 'string' || !report.snapshot.file_name || !Number.isFinite(Date.parse(report.snapshot.imported_at))
    || !/^[a-f\d]{64}$/.test(report.snapshot.sha256) || report.snapshot.row_count !== report.rows.length)) return false;
  if (!report.snapshot && report.rows.length) return false;
  if (![report.by_branch, report.by_sector].every(groups => Array.isArray(groups) && groups.length <= 5000 && groups.every(row => row && typeof row.label === 'string' && safeCount(row.count) && nullableMoney(row.salary_base_cents)))) return false;
  return !!report.quality && Object.keys(qualityLabels).every(key => key === 'missing_cost_allowance' && report.quality[key] === undefined || safeCount(report.quality[key]))
    && Array.isArray(report.birthdays) && report.birthdays.length <= report.rows.length && report.birthdays.every(row => validRow(row) && safeCount(row.day) && row.day >= 1 && row.day <= 31)
    && Array.isArray(report.work_anniversaries) && report.work_anniversaries.length <= report.rows.length && report.work_anniversaries.every(row => validRow(row) && safeCount(row.day) && row.day >= 1 && row.day <= 31 && safeCount(row.years) && row.years >= 1);
}
const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');
const displayMoney = (value: number | null | undefined) => value == null ? 'Não informado' : formatCents(value);
const displayDate = (value: string | null) => value === null ? 'Não informado' : dateLabel(value);
const totalFormula = 'Total = Salário Base + VT total + Salário recebido + Adiantamento + Ajuda de Custo';
function sumReportedMoney(rows: HrRow[], field: 'payroll_salary_cents' | 'salary_base_cents') {
  let total = 0n;
  for (const row of rows) { const value = row[field]; if (value === null) return null; total += BigInt(value); }
  return total < BigInt(Number.MIN_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(total);
}
function hrError(failure: unknown) {
  const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)) return 'A aba RH / DP precisa ser ativada pela administração. Os dados atuais continuam preservados.';
  if (code === '42501') return 'Seu perfil não permite consultar a base de RH / DP.';
  if (['PGRST301', 'PGRST303'].includes(code)) return 'Sua sessão expirou. Entre novamente.';
  return 'Não foi possível consultar RH / DP. Atualize a consulta para tentar novamente.';
}
function GroupTable({ title, rows }: { title: string; rows: HrGroup[] }) {
  return <section className="panel hr-group"><h3>{title}</h3><div className="table-wrap"><table><thead><tr><th>{title === 'Quadro por filial' ? 'Filial' : 'Setor'}</th><th>Pessoas</th><th>Salário base</th></tr></thead><tbody>{rows.length ? rows.map(row => <tr key={row.label}><td>{row.label || 'Não informado'}</td><td>{row.count}</td><td>{displayMoney(row.salary_base_cents)}</td></tr>) : <tr><td colSpan={3} className="empty-state">Importe a base de RH / DP para visualizar.</td></tr>}</tbody></table></div></section>;
}

export default function HumanResources({ canExport = false, onImport }: { canExport?: boolean; onImport?: () => void }) {
  const [month, setMonth] = useState(() => officialToday().slice(0, 7)), [search, setSearch] = useState(''), [branch, setBranch] = useState(''), [sector, setSector] = useState('');
  const [report, setReport] = useState<HrReport | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false), [page, setPage] = useState(0), queryId = useRef(0);
  const validMonth = /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(month);
  useEffect(() => {
    if (!supabase || !validMonth) { setLoading(false); setReport(null); setError(!supabase ? 'Conexão indisponível.' : 'Selecione um mês válido.'); return; }
    const client = supabase, abort = new AbortController(), current = ++queryId.current;
    setLoading(true); setError(''); setReport(null); setPage(0);
    void Promise.resolve(client.rpc('hr_report', { p_month: month + '-01' }).abortSignal(abort.signal).retry(false)).then(result => {
      if (abort.signal.aborted || current !== queryId.current) return;
      if (result.error) throw result.error;
      if (!validReport(result.data)) throw new Error('invalid_report');
      setReport(result.data);
    }).catch(failure => { if (!abort.signal.aborted && current === queryId.current) setError(hrError(failure)); }).finally(() => { if (!abort.signal.aborted && current === queryId.current) setLoading(false); });
    return () => abort.abort();
  }, [month, validMonth, refresh]);
  const filtered = useMemo(() => (report?.rows ?? []).filter(row => (!search || normalize([row.employee, row.branch, row.sector].join(' ')).includes(normalize(search))) && (!branch || row.branch === branch) && (!sector || row.sector === sector)), [report, search, branch, sector]);
  const branches = [...new Set((report?.rows ?? []).map(row => row.branch).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const sectors = [...new Set((report?.rows ?? []).map(row => row.sector).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1)), visible = filtered.slice(currentPage * 25, (currentPage + 1) * 25);
  const present = !!report?.snapshot, summary = report?.summary;
  const calculatedTotal = summary?.total_formula_version === 'rh-five-fields-v1';
  const salaryBaseAll = summary?.salary_base_all_cents !== undefined ? summary.salary_base_all_cents : report ? sumReportedMoney(report.rows, 'salary_base_cents') : null;
  const monthLabel = validMonth ? `${months[Number(month.slice(5)) - 1]} de ${month.slice(0, 4)}` : 'Mês selecionado';
  const cards = summary ? [
    ['Colaboradores', String(summary.employees), 'Exclui registros com setor SÓCIO'], ['Sócios', String(summary.partners), 'Acompanhados separadamente do quadro'],
    ['Admissões no mês', String(summary.admissions), monthLabel], ['Aniversariantes no mês', String(summary.birthdays), monthLabel],
    ['Beneficiários de cesta básica', String(summary.basket_eligible), 'Exceções nominais da política original'], ['Custo mensal — cesta básica', displayMoney(summary.basket_monthly_cents), 'R$ 112,80 por beneficiário'],
    ['Não recebem cesta', String(summary.basket_excluded), 'Exceções fixas da política atual'], ['Custo anual projetado — cesta', displayMoney(summary.basket_annual_cents), 'Custo mensal × 12'],
    ['Salário Folha — colaboradores', displayMoney(summary.salary_base_cents), 'Salário Folha do relatório; sem descontos e sem sócios'], ['Salário base — sem descontos', displayMoney(salaryBaseAll), 'Salário Base, incluindo sócios'], ['Salário recebido', displayMoney(summary.payroll_salary_cents), 'Salário recebido com descontos, incluindo sócios'], ['Vale-transporte', displayMoney(summary.transport_cents), 'Total informado em VT TOTAL'],
    ['Adiantamentos', displayMoney(summary.advance_cents), 'Total informado em ADIANTAMENTO'], ['Ajuda de custo', displayMoney(summary.cost_allowance_cents), 'Coluna Ajuda de Custo, incluindo sócios'], [calculatedTotal ? 'Total de salários e benefícios' : 'TOTAL da posição anterior', displayMoney(summary.total_cents), calculatedTotal ? 'Salário Base + VT + Salário recebido + Adiantamento + Ajuda de Custo' : 'TOTAL preservado da posição anterior; atualize a consulta após ativar o cálculo'],
  ] : [];
  async function exportReport() {
    if (!report?.snapshot || !canExport || exporting || loading) return;
    const snapshot = report.snapshot, selected = [...filtered];
    setExporting(true); setError('');
    try {
      const financial = selected.flatMap(row => [...moneyFields, 'payroll_salary_cents', 'cost_allowance_cents', 'basket_cost_cents', 'reported_total_cents'].map(key => row[key as keyof HrRow]));
      if (financial.some(value => typeof value === 'number' && Math.abs(value) > 999999999999999)) throw new Error('excel_precision');
      const { default: ExcelJS } = await import('exceljs');
      const book = new ExcelJS.Workbook(); book.creator = 'Central Financeira · Grupo Ecoplast'; book.created = new Date();
      const detail = book.addWorksheet('Pessoas filtradas');
      detail.columns = ['Filial', 'Admissão', 'Aniversário', 'Funcionário', 'Setor', 'Sócio', 'Cesta básica', 'Custo cesta', 'Salário Folha / Salário Base sem descontos', 'Vale-transporte recebido', 'Salário recebido com descontos', 'Adiantamento', 'Ajuda de Custo', calculatedTotal ? 'Total calculado' : 'TOTAL da posição anterior', 'TOTAL informado na origem', 'Linha de origem'].map((header, index) => ({ header, width: index === 3 ? 44 : index === 4 ? 26 : 21 }));
      const amount = (value: number | null | undefined) => value == null ? 'Não informado' : value / 100;
      for (const row of selected) {
        const output = detail.addRow([row.branch, row.admitted_on ? new Date(row.admitted_on + 'T12:00:00Z') : null, row.birthday_on ? new Date(row.birthday_on + 'T12:00:00Z') : null, row.employee, row.sector, row.is_partner ? 'Sim' : 'Não', row.basket_eligible ? 'Sim' : 'Não', amount(row.basket_cost_cents), amount(row.salary_base_cents), amount(row.transport_cents), amount(row.payroll_salary_cents), amount(row.advance_cents), amount(row.cost_allowance_cents), amount(row.total_cents), amount(row.reported_total_cents), row.source_row]);
        [2, 3].forEach(column => { output.getCell(column).numFmt = 'dd/mm/yyyy'; });
        [8, 9, 10, 11, 12, 13, 14, 15].forEach(column => { output.getCell(column).numFmt = '"R$" #,##0.00;[Red]-"R$" #,##0.00'; });
      }
      detail.autoFilter = { from: 'A1', to: 'P1' }; detail.views = [{ state: 'frozen', ySplit: 1 }];
      const source = book.addWorksheet('Origem e critérios'); source.columns = [{ width: 35 }, { width: 110 }];
      source.addRows([['RH / DP — consulta', monthLabel], ['Arquivo de origem', snapshot.file_name], ['Data da posição', snapshot.reference_date], ['Importação', snapshot.imported_at], ['Identificador da importação', snapshot.id], ['SHA-256 do original', snapshot.sha256], ['Linhas na base', snapshot.row_count], ['Pessoas exportadas', selected.length], ['Busca', search || 'Todas'], ['Filial', branch || 'Todas'], ['Setor', sector || 'Todos'], ['Cesta básica', 'R$ 112,80 por pessoa; exceções: Gabriel Pedrosa Marques Ferreira e Gustavo Marques Ferreira.'], ['Salário base', 'Coluna Salário Folha ou Salário Base: salário sem descontos; no formato antigo, primeiro SALÁRIO.'], ['Salário Folha — colaboradores', 'Salário Folha sem descontos. O indicador exclui os sócios.'], ['Salário recebido', 'Coluna Salário recebido ou Salário; no formato antigo, segundo SALÁRIO. Valor com descontos, incluindo sócios.'], ['Valores de benefícios', 'VT TOTAL, Adiantamento e Ajuda de Custo em branco equivalem a zero quando a coluna está presente. Colunas ausentes e posições antigas preservam Não informado.'], ['Total de salários e benefícios', calculatedTotal ? totalFormula + '. Inclui ambos os salários e os sócios; nenhuma parcela é somada duas vezes.' : 'TOTAL original de uma consulta anterior à ativação do cálculo.'], ['Versão do cálculo', summary?.total_formula_version || 'Não informada na posição anterior'], ['TOTAL informado na origem', 'Preservado para conferência. Não é somado novamente ao total calculado.'], ['Escopo', 'O arquivo contém somente as pessoas dos filtros exibidos. Os indicadores na tela abrangem a base completa.']]);
      const bytes = await book.xlsx.writeBuffer(), url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const link = document.createElement('a'); link.href = url; link.download = `RH_DP_${month}.xlsx`; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(failure instanceof Error && failure.message === 'excel_precision' ? 'Um valor excede a precisão segura do Excel. Nenhum arquivo parcial foi gerado.' : 'Não foi possível gerar o relatório de RH / DP. Tente novamente.'); }
    finally { setExporting(false); }
  }
  return <div className="stack human-resources">
    <section className="panel" aria-labelledby="hr-overview-title"><div className="panel-header"><div><h2 id="hr-overview-title">RH / DP</h2><p className="muted">Quadro, benefícios e calendário calculados com as informações da base importada.</p></div><div className="inline-actions"><button className="button secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Atualizar RH / DP</button>{onImport && <button className="button secondary" onClick={onImport}>Importar base de RH / DP</button>}</div></div>
      <label className="field hr-month">Mês do calendário de RH<input type="month" min="1900-01" max="2199-12" value={month} onChange={event => setMonth(event.target.value)} /></label>
      {report?.snapshot && <p className="help-text">Posição de {dateLabel(report.snapshot.reference_date)} · {report.snapshot.file_name} · {report.snapshot.row_count} registro(s). A troca do mês consulta aniversários e admissões da mesma base.</p>}
      {loading && <p role="status">Consultando base de RH / DP…</p>}{error && <p className="notice error" role="alert">{error}</p>}{report && !present && <p className="notice">Aguardando a primeira importação de RH / DP. Os valores serão exibidos após a inclusão da base.</p>}
    </section>
    {report && <>{present && !calculatedTotal && <p className="notice">O cálculo atualizado do Total ainda precisa ser ativado nesta consulta. Os valores de TOTAL registrados na posição anterior continuam identificados separadamente.</p>}<div className="hr-cards">{cards.map(([title, value, note]) => <article className="panel hr-card" key={title}><h3>{title}</h3><strong>{present ? value : '—'}</strong><small>{note}</small></article>)}</div>
      <div className="hr-two-columns"><GroupTable title="Quadro por filial" rows={report.by_branch} /><GroupTable title="Quadro por setor" rows={report.by_sector} /></div>
      <section className="panel" aria-labelledby="hr-calendar-title"><h3 id="hr-calendar-title">Calendário de aniversários e tempo de empresa</h3><p className="help-text">{monthLabel}. O tempo de empresa considera os anos completados no mês selecionado.</p><div className="hr-month-buttons" role="group" aria-label="Meses do calendário">{months.map((label, index) => <button className={`button ${Number(month.slice(5)) === index + 1 ? '' : 'secondary'}`} type="button" key={label} aria-pressed={Number(month.slice(5)) === index + 1} onClick={() => setMonth(`${month.slice(0, 4)}-${String(index + 1).padStart(2, '0')}`)}>{label.slice(0, 3)}</button>)}</div>
        <div className="hr-two-columns hr-calendar-columns"><div><h4>Aniversariantes do mês ({report.birthdays.length})</h4><div className="table-wrap"><table><thead><tr><th>Dia</th><th>Funcionário</th><th>Setor</th><th>Filial</th></tr></thead><tbody>{report.birthdays.length ? report.birthdays.map(row => <tr key={row.source_row}><td>{String(row.day).padStart(2, '0')}/{month.slice(5)}</td><td>{row.employee}</td><td>{row.sector || 'Não informado'}</td><td>{row.branch || 'Não informado'}</td></tr>) : <tr><td colSpan={4} className="empty-state">Nenhum aniversariante neste mês.</td></tr>}</tbody></table></div></div>
          <div><h4>Aniversário de empresa ({report.work_anniversaries.length})</h4><div className="table-wrap"><table><thead><tr><th>Dia</th><th>Funcionário</th><th>Setor</th><th>Tempo de empresa</th></tr></thead><tbody>{report.work_anniversaries.length ? report.work_anniversaries.map(row => <tr key={row.source_row}><td>{String(row.day).padStart(2, '0')}/{month.slice(5)}</td><td>{row.employee}</td><td>{row.sector || 'Não informado'}</td><td>{row.years} {row.years === 1 ? 'ano' : 'anos'}</td></tr>) : <tr><td colSpan={4} className="empty-state">Nenhum aniversário de empresa neste mês.</td></tr>}</tbody></table></div></div></div>
      </section>
      {present && <section className="panel" aria-labelledby="hr-quality-title"><h3 id="hr-quality-title">Conferência dos dados da base</h3><div className="hr-quality">{Object.entries(qualityLabels).map(([key, label]) => <p key={key}><span>{label}</span><strong>{report.quality[key] === undefined ? 'Não informado' : report.quality[key]}</strong></p>)}</div><p className="help-text">Nas novas importações, VT TOTAL, Adiantamento e Ajuda de Custo em branco valem zero quando a coluna está presente. Colunas ausentes e informações não registradas em posições antigas aparecem como “Não informado”. Salário Folha e Salário Base representam o salário sem descontos. Salário recebido é o valor recebido com descontos. {calculatedTotal ? totalFormula + ' — inclui os dois salários e os sócios.' : 'O total desta consulta conserva o valor registrado na posição anterior.'} A coluna TOTAL da origem, quando existente, fica preservada apenas para conferência.</p></section>}
      <section className="panel" aria-labelledby="hr-people-title"><div className="panel-header"><div><h3 id="hr-people-title">Pessoas da base</h3><p className="help-text">{filtered.length} de {report.rows.length} registro(s). Os filtros abaixo atuam na lista de pessoas e na exportação.</p></div>{canExport && <button className="button secondary" disabled={!present || loading || exporting} onClick={() => void exportReport()}>{exporting ? 'Gerando Excel…' : 'Baixar relatório de RH / DP'}</button>}</div>
        <div className="form-grid hr-filters"><label className="field">Buscar pessoa<input type="search" value={search} placeholder="Funcionário, filial ou setor" onChange={event => { setSearch(event.target.value); setPage(0); }} /></label><label className="field">Filial de RH<select value={branch} onChange={event => { setBranch(event.target.value); setPage(0); }}><option value="">Todas as filiais</option>{branches.map(item => <option value={item} key={item}>{item}</option>)}</select></label><label className="field">Setor de RH<select value={sector} onChange={event => { setSector(event.target.value); setPage(0); }}><option value="">Todos os setores</option>{sectors.map(item => <option value={item} key={item}>{item}</option>)}</select></label><button className="button secondary" onClick={() => { setSearch(''); setBranch(''); setSector(''); setPage(0); }}>Limpar filtros de RH</button></div>
        <div className="table-wrap"><table><caption>Funcionários, sócios e valores informados na base de RH / DP</caption><thead><tr><th>Filial</th><th>Admissão</th><th>Aniversário</th><th>Funcionário</th><th>Setor</th><th>Cesta básica</th><th>Custo cesta</th><th>Salário Folha / base sem descontos</th><th>VT recebido</th><th>Salário recebido com descontos</th><th>Adiantamento</th><th>Ajuda de Custo</th><th>{calculatedTotal ? 'Total calculado' : 'TOTAL da posição anterior'}</th><th>TOTAL na origem</th></tr></thead><tbody>{visible.length ? visible.map(row => <tr key={row.source_row}><td>{row.branch || 'Não informado'}</td><td>{displayDate(row.admitted_on)}</td><td>{displayDate(row.birthday_on)}</td><td>{row.employee}{row.is_partner && <small>Sócio</small>}</td><td>{row.sector || 'Não informado'}</td><td>{row.basket_eligible ? 'Sim' : 'Não'}</td><td>{displayMoney(row.basket_cost_cents)}</td><td>{displayMoney(row.salary_base_cents)}</td><td>{displayMoney(row.transport_cents)}</td><td>{displayMoney(row.payroll_salary_cents)}</td><td>{displayMoney(row.advance_cents)}</td><td>{displayMoney(row.cost_allowance_cents)}</td><td>{displayMoney(row.total_cents)}</td><td>{displayMoney(row.reported_total_cents)}</td></tr>) : <tr><td colSpan={14} className="empty-state">Nenhum registro encontrado.</td></tr>}</tbody></table></div>
        <div className="pagination"><p>Página {currentPage + 1} de {Math.max(1, Math.ceil(filtered.length / 25))}</p><div className="inline-actions"><button className="button secondary" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Anterior</button><button className="button secondary" disabled={(currentPage + 1) * 25 >= filtered.length} onClick={() => setPage(currentPage + 1)}>Próxima</button></div></div>
      </section>
    </>}
  </div>;
}
