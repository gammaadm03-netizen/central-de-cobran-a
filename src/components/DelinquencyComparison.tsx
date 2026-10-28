import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { DELINQUENCY_BANDS, delinquencyChange, validDelinquencyComparison, type DelinquencyComparison as Comparison } from '../lib/delinquency-comparison.mjs';
import { displayDate, money } from './Treasury';
import '../delinquency-comparison.css';

function precedingDay(day: string) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function validDate(day: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T12:00:00Z`))
    && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day;
}

function Balance({ cents }: { cents: number | null }) {
  return cents === null ? <span className="delinquency-missing">Sem histórico</span> : <>{money(cents)}</>;
}

function ChangeCells({ previous, current }: { previous: number | null; current: number | null }) {
  const change = delinquencyChange(previous, current);
  return <>
    <td className={`financial-numeric delinquency-${change.tone}`}>{change.difference_cents === null ? '—' : `${change.difference_cents > 0 ? '+' : ''}${money(change.difference_cents)}`}</td>
    <td className={`financial-numeric delinquency-${change.tone}`}>{change.percentage ?? (change.difference_cents === null ? '—' : 'Sem base anterior')}</td>
    <td><span className={`delinquency-reading delinquency-${change.tone}`}><span className="delinquency-dot" aria-hidden="true" />{change.label}</span></td>
  </>;
}

export default function DelinquencyComparison({ today, refreshKey }: { today: string; refreshKey: number }) {
  const [previous, setPrevious] = useState(() => precedingDay(today));
  const [current, setCurrent] = useState(today);
  const [serverToday, setServerToday] = useState(today);
  const [query, setQuery] = useState<{ previous: string | null; current: string | null; sequence: number }>({ previous: null, current: null, sequence: 0 });
  const [report, setReport] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = ++generation.current;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true); setReport(null); setError('');
    async function load() {
      try {
        if (!supabase) throw { code: 'connection' };
        const result = await supabase.rpc('receivables_daily_delinquency', { p_previous: query.previous, p_current: query.current }).abortSignal(controller.signal).retry(false);
        if (request !== generation.current) return;
        if (result.error) throw result.error;
        if (!validDelinquencyComparison(result.data)
          || query.previous !== null && result.data.previous.date !== query.previous
          || query.current !== null && result.data.current.date !== query.current) throw { code: 'invalid_report' };
        setReport(result.data); setPrevious(result.data.previous.date); setCurrent(result.data.current.date); setServerToday(result.data.as_of_date);
      } catch (cause) {
        if (request !== generation.current || controller.signal.aborted) return;
        const code = (cause as { code?: string })?.code;
        setError(['PGRST202', '42883', '42P01'].includes(code ?? '')
          ? 'Ative o SQL 051 no banco de dados para consultar a variação diária da inadimplência.'
          : code === '42501' ? 'Seu perfil não tem permissão para consultar a variação da inadimplência.'
            : 'Não foi possível consultar a variação da inadimplência. Tente comparar as datas novamente.');
      } finally { if (request === generation.current) setLoading(false); }
    }
    void load();
    return () => { controller.abort(); if (request === generation.current) generation.current += 1; };
  }, [query, refreshKey, today]);

  function changeDate(which: 'previous' | 'current', value: string) {
    generation.current += 1; pending.current?.abort();
    setReport(null); setError(''); setLoading(false);
    if (which === 'previous') setPrevious(value); else setCurrent(value);
  }

  function compare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validDate(previous) || !validDate(current) || previous < '1900-01-01' || previous >= current || current > serverToday) {
      setReport(null); setError('Escolha duas datas até hoje, com a data anterior antes da data atual.'); return;
    }
    setQuery(value => ({ previous, current, sequence: value.sequence + 1 }));
  }

  return <section className="delinquency-comparison" aria-labelledby="delinquency-comparison-title">
    <div className="financial-card-heading"><div><h3 id="delinquency-comparison-title">Variação diária da inadimplência</h3><p className="financial-caption">Compare o saldo vencido em dois dias, por faixa de atraso. Uma redução do saldo representa melhora.</p></div></div>
    <form className="delinquency-date-form" onSubmit={compare}>
      <label className="field">Data anterior<input type="date" value={previous} min="1900-01-01" max={serverToday} required onChange={event => changeDate('previous', event.target.value)} /></label>
      <label className="field">Data atual<input type="date" value={current} min="1900-01-01" max={serverToday} required onChange={event => changeDate('current', event.target.value)} /></label>
      <button className="button secondary" type="submit" disabled={loading}>{loading ? 'Consultando…' : 'Comparar datas'}</button>
    </form>
    {loading && <p className="financial-loading" role="status">Consultando posições diárias…</p>}
    {error && <p className="alert error" role="alert">{error}</p>}
    {!loading && !error && !report && <p className="financial-caption">Clique em Comparar datas para consultar o período escolhido.</p>}
    {report && <>
      <div className="table-scroll"><table><caption className="sr-only">Comparação da inadimplência por faixa de atraso</caption><thead><tr><th scope="col">Faixa</th><th scope="col" className="financial-numeric">{displayDate(report.previous.date)}</th><th scope="col" className="financial-numeric">{displayDate(report.current.date)}{report.current.partial && <small className="delinquency-partial">Hoje · parcial</small>}</th><th scope="col" className="financial-numeric">Variação R$</th><th scope="col" className="financial-numeric">Variação %</th><th scope="col">Leitura</th></tr></thead>
        <tbody>{DELINQUENCY_BANDS.map(band => {
          const before = report.previous.bands.find(item => item.key === band.key)!;
          const after = report.current.bands.find(item => item.key === band.key)!;
          return <tr key={band.key}><th scope="row">{band.label}</th><td className="financial-numeric"><Balance cents={before.amount_cents} /></td><td className="financial-numeric"><Balance cents={after.amount_cents} /></td><ChangeCells previous={before.amount_cents} current={after.amount_cents} /></tr>;
        })}</tbody>
        <tfoot><tr><th scope="row">Total vencido</th><td className="financial-numeric"><Balance cents={report.previous.total_cents} /></td><td className="financial-numeric"><Balance cents={report.current.total_cents} /></td><ChangeCells previous={report.previous.total_cents} current={report.current.total_cents} /></tr></tfoot>
      </table></div>
      {(!report.previous.available || !report.current.available) && <p className="notice">Ainda não há histórico completo da carteira para uma das datas selecionadas.{report.first_available_date ? ` A base foi registrada a partir de ${displayDate(report.first_available_date)}.` : ' Importe a primeira base de Contas a Receber.'}</p>}
      <p className="financial-caption">Posições registradas na Central ao final de cada dia, no horário de Brasília. Hoje mostra a posição até agora. Importações e confirmações posteriores entram na data em que foram registradas.</p>
      <details className="delinquency-criteria"><summary>Como interpretar a variação</summary><p>Variação = saldo atual − saldo anterior. Percentual = variação ÷ saldo anterior. Redução de pelo menos 30%: Excelente; de pelo menos 10%: Muito positivo; acima de 1%: Positivo. Variações entre −1% e +1%: Estável. Aumento acima de 1%: Atenção. Saldo anterior zero não gera percentual de aumento.</p><p>As faixas mudam com os dias de atraso. A variação pode refletir novos vencimentos, recebimentos, alterações e retiradas do relatório.</p></details>
    </>}
  </section>;
}
