import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import { addCivilDays, financialWeek, monthBounds } from '../lib/financial-dates';
import { officialToday } from './Treasury';
import '../payables-overview.css';

export interface PayablesDetailSelection { start: string; end: string; macro?: string; outstandingOnly?: boolean; canonicalOnly?: boolean }
export type OverviewSelection = PayablesDetailSelection;
interface MacroSummary {
  macro: string; planned_cents: number | null; paid_cents: number | null; difference_cents: number | null;
  open_week_cents: number | null; future_cents: number | null; overdue_cents: number | null;
  week_title_count: number | null; future_title_count: number | null;
}
interface ManagementSummary {
  as_of_date: string; week_start: string; week_end: string; month_start: string; month_end: string; latest_import_id: string | null; latest_import_at: string | null;
  planned_week_cents: number | null; paid_week_cents: number | null; monthly_paid_cents: number | null; monthly_paid_count: number | null; difference_week_cents: number | null;
  open_week_cents: number | null; future_cents: number | null; overdue_cents: number | null;
  week_title_count: number | null; future_title_count: number | null; cheques_week_cents: number | null;
  cheques_week_count: number | null; pending_reconciliation_count: number | null;
  by_macro: MacroSummary[]; missing_sources: string[];
}
const amountKeys = ['planned_week_cents', 'paid_week_cents', 'open_week_cents', 'future_cents', 'overdue_cents', 'cheques_week_cents', 'monthly_paid_cents'] as const;
const countKeys = ['week_title_count', 'future_title_count', 'cheques_week_count', 'pending_reconciliation_count', 'monthly_paid_count'] as const;
const macroAmountKeys = ['planned_cents', 'paid_cents', 'open_week_cents', 'future_cents', 'overdue_cents'] as const;
const validAmount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
function validSummary(value: unknown, selected: string, month: string): value is ManagementSummary {
  if (!value || typeof value !== 'object') return false;
  const position = value as ManagementSummary;
  try {
    const period = monthBounds(month);
    if (position.month_start !== period.start || position.month_end !== period.end) return false;
    if (position.week_start !== selected || position.week_end !== addCivilDays(selected, 6) || addCivilDays(position.as_of_date, 0) !== position.as_of_date) return false;
  } catch { return false; }
  if (!Array.isArray(position.by_macro) || position.by_macro.length > 200 || !Array.isArray(position.missing_sources) || position.missing_sources.some(item => typeof item !== 'string')) return false;
  const missing = position.latest_import_id === null;
  if (!missing && (typeof position.latest_import_id !== 'string' || !position.latest_import_id || typeof position.latest_import_at !== 'string' || !Number.isFinite(new Date(position.latest_import_at).getTime()))) return false;
  for (const key of [...amountKeys, ...countKeys]) if (missing ? position[key] !== null : !validAmount(position[key])) return false;
  if (missing ? position.difference_week_cents !== null : !Number.isSafeInteger(position.difference_week_cents)) return false;
  const names = new Set<string>();
  for (const macro of position.by_macro) {
    if (!macro || typeof macro.macro !== 'string' || !macro.macro.trim() || names.has(macro.macro)) return false;
    names.add(macro.macro);
    for (const key of [...macroAmountKeys, 'week_title_count', 'future_title_count'] as const) if (missing ? macro[key] !== null : !validAmount(macro[key])) return false;
    if (missing ? macro.difference_cents !== null : !Number.isSafeInteger(macro.difference_cents)) return false;
  }
  return true;
}
function errorMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)) return 'O resumo de Contas a Pagar precisa ser ativado pela administração. Os títulos e os pagamentos existentes continuam preservados.';
  if (code === '42501') return 'Seu perfil não tem permissão para consultar este resumo.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (code === '22003') return 'O total excede o limite de precisão permitido. Solicite a conferência da base à administração.';
  return 'Não foi possível consultar o resumo. Atualize para tentar novamente.';
}
function Amount({ value }: { value: number | null }) { return value === null ? <span className="payables-overview-missing">Aguardando importação</span> : <>{formatCents(value)}</>; }
function monthLabel(value: string) { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', month: 'long', year: 'numeric' }).format(new Date(`${value}T12:00:00Z`)); }
function thisWeek() { return financialWeek(officialToday()).start; }

export default function PayablesOverview({ onDetails, onActuals, onUnavailable, refreshKey = 0 }: { onDetails: (filters: PayablesDetailSelection) => void; onActuals?: (range: { start: string; end: string; macro?: string }) => void; onUnavailable?: () => void; refreshKey?: number }) {
  const [weekInput, setWeekInput] = useState(thisWeek), [selectedWeek, setSelectedWeek] = useState(thisWeek);
  const [monthInput, setMonthInput] = useState(() => officialToday().slice(0, 7)), [selectedMonth, setSelectedMonth] = useState(() => officialToday().slice(0, 7));
  const [periodStart, setPeriodStart] = useState(thisWeek), [periodEnd, setPeriodEnd] = useState(() => addCivilDays(thisWeek(), 6)), [actualMacro, setActualMacro] = useState('');
  const [summary, setSummary] = useState<ManagementSummary | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const unavailableCallback = useRef(onUnavailable); unavailableCallback.current = onUnavailable;
  useEffect(() => {
    const client = supabase; if (!client) { setLoading(false); setError('Conexão indisponível.'); return; }
    const abort = new AbortController(); setLoading(true); setError(''); setSummary(null);
    void Promise.resolve(client.rpc('payables_management_summary', { p_week: selectedWeek, p_month: `${selectedMonth}-01` }).abortSignal(abort.signal).retry(false)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      if (!validSummary(result.data, selectedWeek, selectedMonth)) throw new Error('invalid_response');
      setSummary(result.data);
    }).catch(failure => { if (!abort.signal.aborted) { setError(errorMessage(failure));
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)) unavailableCallback.current?.();
    } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [selectedWeek, selectedMonth, refresh, refreshKey]);
  function applyWeek(event: FormEvent) {
    event.preventDefault(); if (loading) return;
    try {
      if (weekInput < '1900-01-01') throw new Error();
      const week = financialWeek(weekInput).start; setWeekInput(week); setSelectedWeek(week); setRefresh(value => value + 1);
    } catch { setError('Selecione uma data válida para consultar a semana financeira.'); }
  }
  function applyMonth(event: FormEvent) {
    event.preventDefault(); if (loading) return;
    try { monthBounds(monthInput); if (monthInput < '1900-01' || monthInput > '2199-12') throw new Error(); setSelectedMonth(monthInput); setRefresh(value => value + 1); }
    catch { setError('Selecione um mês válido para consultar os pagamentos realizados.'); }
  }
  function openActualPeriod(event: FormEvent) {
    event.preventDefault(); if (unavailable || !summary || !onActuals) return;
    try {
      if (periodStart < '1900-01-01' || periodEnd < periodStart || addCivilDays(periodStart, 0) !== periodStart || addCivilDays(periodEnd, 0) !== periodEnd || (Date.parse(`${periodEnd}T12:00:00Z`) - Date.parse(`${periodStart}T12:00:00Z`)) / 86400000 > 3660 || (actualMacro && !summary.by_macro.some(item => item.macro === actualMacro))) throw new Error();
      setError(''); onActuals({ start: periodStart, end: periodEnd, ...(actualMacro ? { macro: actualMacro } : {}) });
    } catch { setError('Informe um período válido, com data final a partir da inicial, até dez anos, e um macro da lista.'); }
  }
  const unavailable = loading || !summary || !summary.latest_import_id;
  const week = summary ? { start: summary.week_start, end: summary.week_end } : { start: selectedWeek, end: addCivilDays(selectedWeek, 6) };
  function details(macro?: string, outstandingOnly = false, future = false) {
    if (!summary || unavailable) return;
    onDetails({ canonicalOnly: true, start: future ? summary.as_of_date : summary.week_start, end: future ? '' : summary.week_end, ...(macro ? { macro } : {}), ...(outstandingOnly ? { outstandingOnly: true } : {}) });
  }
  return <div className="payables-overview">
    <section className="panel payables-overview-header" aria-labelledby="payables-overview-title">
      <div className="panel-header"><div><h2 id="payables-overview-title">Resumo de Contas a Pagar</h2><p className="muted">Planejamento, pagamentos realizados e compromissos do grupo consolidado.</p></div><div className="inline-actions"><button className="button secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Atualizar resumo</button></div></div>
      <form className="payables-overview-period" onSubmit={applyWeek}><label className="field" htmlFor="payables-summary-week">Semana financeira<input id="payables-summary-week" type="date" min="1900-01-01" max="2199-12-31" value={weekInput} onChange={event => setWeekInput(event.target.value)} disabled={loading} required /></label><button className="button secondary" type="submit" disabled={loading}>Consultar semana</button><button className="button secondary" type="button" disabled={loading} onClick={() => { const current = thisWeek(); setWeekInput(current); setSelectedWeek(current); setRefresh(value => value + 1); }}>Semana atual</button><span className="payables-overview-period-label">{dateLabel(week.start)} a {dateLabel(week.end)} · sábado a sexta-feira</span></form>
      <form className="payables-overview-month" onSubmit={applyMonth}><label className="field" htmlFor="payables-summary-month">Mês dos pagamentos<input id="payables-summary-month" type="month" min="1900-01" max="2199-12" value={monthInput} onChange={event => setMonthInput(event.target.value)} disabled={loading} required /></label><button className="button secondary" type="submit" disabled={loading}>Consultar mês</button><span className="help-text">O total mensal é apurado pela data real de pagamento e não muda ao trocar a semana.</span></form>
      {loading && <p className="help-text" role="status">Carregando o resumo financeiro…</p>}{error && <p className="notice error" role="alert">{error}</p>}
      {summary && !summary.latest_import_id && <p className="notice" role="status">Importe a primeira base de previsões em Importar Bases → Contas a Pagar para apurar estes indicadores. A ausência da base não é considerada saldo zero.</p>}
      {summary?.latest_import_at && <p className="help-text">Última importação: {dateLabel(summary.latest_import_at)} · Posição de vencimentos em {dateLabel(summary.as_of_date)}.</p>}
    </section>
    {summary && <>
      <section className="payables-overview-cards" aria-label="Indicadores de Contas a Pagar">
        <article className="panel payables-overview-card"><h3>Previsto na semana</h3><strong><Amount value={summary.planned_week_cents} /></strong><p>Valor atualizado dos títulos com vencimento na semana, incluindo os já pagos.</p><button className="payables-overview-link" disabled={unavailable} onClick={() => details()}>Ver títulos previstos →</button></article>
        <article className="panel payables-overview-card"><h3>Realizado na semana</h3><strong><Amount value={summary.paid_week_cents} /></strong><p>Pagamentos efetivos pela data real do pagamento nesta semana.</p>{onActuals && <button className="payables-overview-link" disabled={unavailable} onClick={() => onActuals({ start: summary.week_start, end: summary.week_end })}>Ver pagamentos realizados →</button>}</article>
        <article className="panel payables-overview-card"><h3>Realizado no mês</h3><small className="payables-overview-card-period">{monthLabel(summary.month_start)}</small><strong><Amount value={summary.monthly_paid_cents} /></strong><p>{summary.monthly_paid_count === null ? 'Aguardando base' : `${summary.monthly_paid_count.toLocaleString('pt-BR')} pagamento(s) confirmado(s)`} · período de {dateLabel(summary.month_start)} a {dateLabel(summary.month_end)}.</p>{onActuals && <button className="payables-overview-link" disabled={unavailable} onClick={() => onActuals({ start: summary.month_start, end: summary.month_end })}>Ver pagamentos do mês →</button>}</article>
        <article className="panel payables-overview-card payables-overview-open"><h3>Saldo a pagar na semana</h3><strong><Amount value={summary.open_week_cents} /></strong><p>Valor restante dos títulos com vencimento de {dateLabel(week.start)} a {dateLabel(week.end)}.</p><button className="payables-overview-link" disabled={unavailable} onClick={() => details(undefined, true)}>Ver saldo da semana →</button></article>
        <article className="panel payables-overview-card"><h3>Total a vencer</h3><strong><Amount value={summary.future_cents} /></strong><p>Todo o saldo restante com vencimento a partir de {dateLabel(summary.as_of_date)}, sem limite de semanas.</p><button className="payables-overview-link" disabled={unavailable} onClick={() => details(undefined, true, true)}>Ver todos a vencer →</button></article>
      </section>
      {onActuals && <section className="panel payables-overview-actuals" aria-labelledby="payables-overview-actuals-title"><div className="panel-header"><div><h2 id="payables-overview-actuals-title">Consultar pagamentos realizados</h2><p className="muted">Escolha as datas efetivas dos pagamentos e o Centro de Custo Macro para abrir os títulos correspondentes.</p></div></div><form className="payables-overview-actual-controls" onSubmit={openActualPeriod}><label className="field">Período inicial dos pagamentos<input type="date" min="1900-01-01" max="2199-12-31" value={periodStart} onChange={event => setPeriodStart(event.target.value)} disabled={unavailable} required /></label><label className="field">Período final dos pagamentos<input type="date" min="1900-01-01" max="2199-12-31" value={periodEnd} onChange={event => setPeriodEnd(event.target.value)} disabled={unavailable} required /></label><label className="field">Centro de Custo Macro dos pagamentos<select value={actualMacro} onChange={event => setActualMacro(event.target.value)} disabled={unavailable}><option value="">Todos os macros</option>{summary.by_macro.map(item => <option key={item.macro}>{item.macro}</option>)}</select></label><button type="submit" className="button" disabled={unavailable}>Consultar pagamentos</button></form></section>}
      <section className="panel payables-overview-attention" aria-labelledby="payables-overview-attention-title"><h2 id="payables-overview-attention-title">Acompanhamento financeiro</h2><div className="payables-overview-attention-grid"><div className={summary.overdue_cents && summary.overdue_cents > 0 ? 'payables-overview-overdue' : ''}><span>Vencidos a pagar</span><strong><Amount value={summary.overdue_cents} /></strong><small>Saldo anterior a {dateLabel(summary.as_of_date)}.</small><button className="payables-overview-link" disabled={unavailable || !summary.overdue_cents} onClick={() => onDetails({ canonicalOnly: true, start: '', end: addCivilDays(summary.as_of_date, -1), outstandingOnly: true })}>Ver títulos vencidos →</button></div><div><span>Cheques da semana</span><strong><Amount value={summary.cheques_week_cents} /></strong><small>{summary.cheques_week_count === null ? 'Aguardando base' : `${summary.cheques_week_count.toLocaleString('pt-BR')} título(s)`} · subtotal já incluído no saldo a pagar da semana.</small></div><div><span>Diferença entre previsto e realizado</span><strong><Amount value={summary.difference_week_cents} /></strong><small>Previsto da semana menos pagamentos efetivos no mesmo período.</small></div></div>{summary.pending_reconciliation_count !== null && summary.pending_reconciliation_count > 0 && <p className="notice">{summary.pending_reconciliation_count.toLocaleString('pt-BR')} título(s) ausente(s) do relatório ainda aguardam conciliação financeira. A ausência, sozinha, não comprova pagamento; o saldo continua considerado até a confirmação.</p>}</section>
      <section className="panel payables-overview-macros" aria-labelledby="payables-overview-macro-title"><div className="panel-header"><div><h2 id="payables-overview-macro-title">Resumo por Centro de Custo Macro</h2><p className="muted">Previsto, realizado e saldo da semana financeira. A vencer considera todos os vencimentos desde hoje.</p></div></div><div className="table-wrap"><table className="data-table"><caption className="sr-only">Resumo financeiro por macro de {dateLabel(week.start)} a {dateLabel(week.end)}</caption><thead><tr><th>Centro de Custo Macro</th><th>Previsto na semana</th><th>Realizado na semana</th><th>Diferença</th><th>Saldo da semana</th><th>A vencer desde hoje</th><th>Detalhamento</th></tr></thead><tbody>{summary.by_macro.map(macro => <tr key={macro.macro}><th scope="row">{macro.macro}</th><td><Amount value={macro.planned_cents} /></td><td><Amount value={macro.paid_cents} /></td><td><Amount value={macro.difference_cents} /></td><td><Amount value={macro.open_week_cents} /></td><td><Amount value={macro.future_cents} /></td><td><div className="inline-actions"><button className="button secondary" disabled={unavailable} aria-label={`Abrir títulos da semana do macro ${macro.macro}`} onClick={() => details(macro.macro)}>Semana</button><button className="button secondary" disabled={unavailable} aria-label={`Abrir títulos a vencer do macro ${macro.macro}`} onClick={() => details(macro.macro, true, true)}>A vencer</button></div></td></tr>)}</tbody><tfoot><tr><th scope="row">TOTAL DO GRUPO</th><td><Amount value={summary.planned_week_cents} /></td><td><Amount value={summary.paid_week_cents} /></td><td><Amount value={summary.difference_week_cents} /></td><td><Amount value={summary.open_week_cents} /></td><td><Amount value={summary.future_cents} /></td><td /></tr></tfoot></table></div><p className="help-text">O realizado usa a data real do pagamento e pode incluir títulos com vencimento em outras semanas. Cheques já fazem parte dos valores da semana. Versões anteriores comprovadamente substituídas permanecem no histórico e não duplicam estes totais.</p></section>
    </>}
  </div>;
}
