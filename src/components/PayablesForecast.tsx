import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import { officialToday, parseBRLCents } from './Treasury';
import '../payables-forecast.css';

interface ForecastRule { id: string; rule_key: string; label: string; macro: string; amount_cents: number; day_of_month: number; effective_from: string; created_at: string }
interface ForecastPlan { plan: string; macro: string; rule_key: string | null; mapping_id: string | null; configured: boolean; effective_from: string | null }
interface ForecastProvision { rule_key: string; label: string; macro: string; month: string; due_date: string; expected_cents: number; actual_cents: number | null; remaining_cents: number | null; completion_id: string | null; done: boolean; issues: string[]; rule_id: string }
interface ForecastWeek { start: string; end: string; real_cents: number | null; estimated_cents: number | null; known_estimated_cents: number; total_cents: number | null; cheques_cents: number | null; cheque_count: number; title_count: number; macros: { macro: string; real_cents: number | null; estimated_cents: number | null; total_cents: number | null }[]; provisions: ForecastProvision[] }
interface ForecastReport { as_of_date: string; start_date: string; end_date: string; latest_import_id: string | null; latest_import_at: string | null; weeks: ForecastWeek[]; rules: ForecastRule[]; plans: ForecastPlan[]; missing_sources: string[] }
type Editor = { kind: 'rule'; key: string } | { kind: 'plan'; plan: string } | { kind: 'completion'; provision: ForecastProvision } | null;

function currency(value: number | null | undefined) { return value == null ? 'Aguardando informações' : formatCents(value); }
function inputMoney(value: number) { const cents = BigInt(value); return `${cents / 100n},${String(cents % 100n).padStart(2, '0')}`; }
function validDate(value: string) { const parsed = new Date(`${value}T12:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }
function nextMonth(value: string) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 1); return date.toISOString().slice(0, 10); }
function forecastError(error: unknown, reading = false) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['PGRST202', '42P01', '42883'].includes(code)) return 'A previsão precisa da atualização 014 do banco de dados. Os lançamentos e as mensagens de Contas a Pagar continuam disponíveis abaixo.';
  if (code === '42501') return 'Seu perfil não tem permissão para esta operação.';
  if (['PGRST301', 'PGRST303'].includes(code)) return 'Sua sessão expirou. Entre novamente.';
  if (code === '40001') return 'A configuração foi alterada por outro usuário. Atualize a previsão e confira os valores antes de tentar novamente.';
  if (['22023', '23514'].includes(code)) return 'A operação foi recusada. Confira os valores, a vigência e a observação. Se o vencimento deste mês já passou, inicie a nova regra no primeiro dia do próximo mês.';
  return reading ? 'Não foi possível consultar a previsão. Atualize para tentar novamente.' : 'Não foi possível confirmar o salvamento. Os campos foram preservados. Atualize a previsão e confira os dados antes de tentar novamente.';
}
function issueLabel(issue: string) {
  const labels: Record<string, string> = { NO_IMPORT: 'Relatório completo ainda não importado.', MISSING_IMPORT: 'Relatório completo ainda não importado.', UNMAPPED_PLAN: 'Existem planos sem vínculo confirmado com a previsão.', UNCONFIGURED_PLAN: 'Existem planos sem vínculo confirmado com a previsão.', RULE_NOT_EFFECTIVE: 'Regra ainda sem vigência para este vencimento.', MISSING_RULE: 'Regra ainda sem vigência para este vencimento.' };
  const businessMessages = ['Importe o relatório completo de Contas a Pagar.', 'Vincule os planos deste macro à previsão correta ou a nenhuma previsão.', 'O macro do título mudou; revise o vínculo da previsão.', 'Há versões ou parcelas do mesmo lançamento no mês. Confira e conclua o ciclo quando não houver previsão restante.'];
  if (businessMessages.includes(issue)) return issue;
  return labels[issue] ?? 'Conferência da configuração pendente. Consulte os vínculos dos planos e a vigência das regras.';
}

export default function PayablesForecast({ canWrite, canConfigure, onRefreshTitles }: { canWrite: boolean; canConfigure: boolean; onRefreshTitles?: () => void }) {
  const [report, setReport] = useState<ForecastReport | null>(null);
  const [start, setStart] = useState(''); const [requestedStart, setRequestedStart] = useState<string | null>(null);
  const [revision, setRevision] = useState(0); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState(''); const [error, setError] = useState(''); const [success, setSuccess] = useState(''); const [uncertain, setUncertain] = useState(false);
  const [editor, setEditor] = useState<Editor>(null); const [amount, setAmount] = useState(''); const [day, setDay] = useState('');
  const [effective, setEffective] = useState(officialToday); const [binding, setBinding] = useState(''); const [observation, setObservation] = useState('');
  const [planSearch, setPlanSearch] = useState(''); const [planPage, setPlanPage] = useState(0);
  const [configurationOpen, setConfigurationOpen] = useState(false); const [expandedWeeks, setExpandedWeeks] = useState<string[]>([]);
  useEffect(() => {
    let active = true; setLoading(true); setReadError(''); setReport(null);
    void (async () => {
      try {
        if (!supabase) throw new Error('connection');
        const result = await supabase.rpc('payables_forecast', { p_start: requestedStart });
        if (result.error) throw result.error;
        const data = result.data as ForecastReport;
        if (!data || !Array.isArray(data.weeks) || !Array.isArray(data.rules) || !Array.isArray(data.plans)) throw new Error('response');
        if (active) { setReport(data); setUncertain(false); }
      } catch (loadError) { if (active) setReadError(forecastError(loadError, true)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [requestedStart, revision]);

  function openEditor(next: Exclude<Editor, null>) {
    if (!report || !canWrite || saving || loading || uncertain) return;
    setError(''); setSuccess(''); setObservation(''); setEffective(report.as_of_date); setEditor(next);
    if (next.kind === 'rule') { const rule = report.rules.find(item => item.rule_key === next.key); setAmount(rule ? inputMoney(rule.amount_cents) : ''); setDay(rule ? String(rule.day_of_month) : ''); const safeStart = nextMonth(report.as_of_date); setEffective(rule && rule.effective_from > safeStart ? rule.effective_from : safeStart); }
    if (next.kind === 'plan') { const plan = report.plans.find(item => item.plan === next.plan); setBinding(plan?.configured ? plan.rule_key ?? 'NONE' : ''); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!editor || !report || !canWrite || loading || saving || uncertain) return;
    setError(''); setSuccess('');
    const note = observation.trim();
    if (!note || note.length > 1000) { setError('Informe uma observação de até 1.000 caracteres.'); return; }
    let rpc: string; let params: Record<string, unknown>; let confirmation: string;
    if (editor.kind === 'rule') {
      if (!canConfigure) return;
      const rule = report.rules.find(item => item.rule_key === editor.key); const cents = parseBRLCents(amount); const dayNumber = Number(day);
      if (!rule || cents === null || cents < 0 || !/^\d{1,2}$/.test(day) || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 28 || !validDate(effective) || effective < report.as_of_date) { setError('Informe valor maior ou igual a zero, com até duas casas decimais, dia de 1 a 28 e vigência a partir de hoje.'); return; }
      rpc = 'save_payable_forecast_rule'; params = { p_rule_key: rule.rule_key, p_amount_cents: cents, p_day_of_month: dayNumber, p_effective_from: effective, p_observation: note, p_expected_id: rule.id };
      confirmation = `Alterar a regra ${rule.label}?\n\nValor: ${currency(cents)}\nDia: ${dayNumber}\nVigência: ${dateLabel(effective)}\n\nAs regras anteriores serão preservadas no histórico.`;
    } else if (editor.kind === 'plan') {
      const plan = report.plans.find(item => item.plan === editor.plan);
      if (!plan || !binding || (binding !== 'NONE' && !report.rules.some(rule => rule.rule_key === binding)) || !validDate(effective) || effective < report.as_of_date) { setError('Escolha um vínculo para o plano e uma vigência a partir de hoje.'); return; }
      rpc = 'map_payable_forecast_plan'; params = { p_plan: plan.plan, p_rule_key: binding === 'NONE' ? null : binding, p_effective_from: effective, p_observation: note, p_expected_id: plan.mapping_id };
      confirmation = `Confirmar o vínculo do plano ${plan.plan}?\n\n${binding === 'NONE' ? 'Não abate nenhuma das quatro previsões fixas.' : report.rules.find(rule => rule.rule_key === binding)?.label}\nVigência: ${dateLabel(effective)}\n\nO vínculo será registrado com responsável e auditoria.`;
    } else {
      const provision = report.weeks.flatMap(week => week.provisions).find(item => item.rule_key === editor.provision.rule_key && item.month === editor.provision.month);
      if (!provision) { setError('A previsão mudou. Atualize e confira os valores.'); return; }
      rpc = 'set_payable_forecast_completion'; params = { p_rule_key: provision.rule_key, p_month: provision.month, p_done: !provision.done, p_observation: note, p_expected_id: provision.completion_id };
      confirmation = provision.done ? `Reabrir a estimativa de ${provision.label} de ${dateLabel(provision.due_date)}?\n\nA estimativa residual voltará ao cálculo quando as informações estiverem completas.` : `Marcar ${provision.label} de ${dateLabel(provision.due_date)} como atendida?\n\nA estimativa residual será zerada. Os títulos reais continuam no total e nenhuma baixa financeira será realizada.`;
    }
    if (!window.confirm(confirmation)) return;
    setSaving(true);
    try {
      if (!supabase) throw new Error('connection');
      const result = await supabase.rpc(rpc, params);
      if (result.error) throw result.error;
      if (typeof result.data !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(result.data)) throw new Error('response');
      setEditor(null); setObservation(''); setSuccess('Alteração registrada com histórico e auditoria.'); setRevision(value => value + 1); onRefreshTitles?.();
    } catch (saveError) { setUncertain(true); setError(forecastError(saveError)); }
    finally { setSaving(false); }
  }
  const pendingPlans = report?.plans.filter(plan => !plan.configured).length ?? 0;
  const filteredPlans = report?.plans.filter(plan => plan.plan.toLocaleLowerCase('pt-BR').includes(planSearch.trim().toLocaleLowerCase('pt-BR'))) ?? [];
  const plans = filteredPlans.slice(planPage * 20, planPage * 20 + 20);
  const current = report?.weeks[0];
  return <section className="panel payable-forecast" aria-labelledby="payable-forecast-title" aria-busy={loading}>
    <div className="panel-header"><div><h2 id="payable-forecast-title">Previsão de Contas a Pagar</h2><p className="muted">Grupo consolidado · próximas 8 semanas financeiras, de sábado a sexta-feira. Esta previsão usa o grupo completo, independentemente dos filtros da lista de lançamentos.</p></div><button className="button secondary" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>{loading ? 'Consultando previsão…' : 'Atualizar previsão'}</button></div>
    {readError && <p className="notice error" role="alert">{readError}</p>}{error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    <form className="payable-forecast-period" onSubmit={event => { event.preventDefault(); if (saving || loading) return; if (!validDate(start) || new Date(`${start}T12:00:00Z`).getUTCDay() !== 6) { setError('Selecione um sábado para iniciar as 8 semanas financeiras.'); return; } setError(''); setRequestedStart(start); }}><label className="field">Sábado inicial da previsão<input type="date" value={start} onChange={event => setStart(event.target.value)} disabled={loading || saving} /></label><button className="button secondary" disabled={loading || saving || !start}>Consultar período</button><button type="button" className="button secondary" disabled={loading || saving} onClick={() => { setStart(''); setRequestedStart(null); setRevision(value => value + 1); setError(''); }}>Semana atual</button></form>
    {loading && <p className="help-text" role="status">Carregando as 8 semanas financeiras…</p>}
    {report && <>
      {!report.latest_import_id && <p className="notice" role="status">RELATÓRIO COMPLETO AGUARDANDO IMPORTAÇÃO. A ausência de títulos importados não é considerada valor zero.</p>}
      {report.latest_import_at && <p className="help-text">Último relatório completo: {dateLabel(report.latest_import_at)}. Títulos quitados permanecem no histórico.</p>}
      {report.missing_sources.length > 0 && report.latest_import_id && <p className="notice">Previsão parcial: existem vínculos ou regras aguardando conferência. Os totais pendentes não são tratados como zero.</p>}
      <div className="payable-forecast-metrics">{[['Títulos reais da primeira semana', current?.real_cents], ['Estimativa residual da primeira semana', current?.estimated_cents], ['Total da primeira semana', current?.total_cents]].map(([label, value]) => <div key={String(label)}><span>{String(label)}</span><strong className={value == null ? 'payable-forecast-missing' : ''}>{currency(typeof value === 'number' ? value : null)}</strong><small>{current ? `${dateLabel(current.start)} a ${dateLabel(current.end)}` : 'Período aguardando consulta'}</small></div>)}</div>
      <div className="table-wrap"><table className="data-table payable-forecast-overview"><caption>Previsão de {dateLabel(report.start_date)} a {dateLabel(report.end_date)} · títulos reais + saldo das estimativas</caption><thead><tr><th>Semana financeira</th><th>Títulos reais</th><th>Estimativas residuais</th><th>Total previsto</th><th>Conferência</th></tr></thead><tbody>{report.weeks.map((week, index) => <tr key={week.start}><td><strong>Semana {index + 1}</strong><small>{dateLabel(week.start)} a {dateLabel(week.end)}</small></td><td>{currency(week.real_cents)}<small>{week.title_count} título(s)</small></td><td>{currency(week.estimated_cents)}{week.estimated_cents === null && <small>Parte já apurada: {currency(week.known_estimated_cents)}</small>}</td><td className="payable-forecast-total">{currency(week.total_cents)}</td><td><a href={`#payable-week-${week.start}`} onClick={() => setExpandedWeeks(previous => previous.includes(week.start) ? previous : [...previous, week.start])}>Ver composição</a></td></tr>)}</tbody></table></div>
      <p className="help-text">Cada estimativa utiliza somente o saldo ainda não coberto pelos títulos reais vinculados ao grupo: máximo entre previsão − realizado e zero. Os cheques já estão incluídos nos títulos reais e aparecem separados para acompanhamento.</p>
      <div className="payable-forecast-weeks">{report.weeks.map((week, index) => <details className="payable-forecast-week" key={week.start} id={`payable-week-${week.start}`} open={expandedWeeks.includes(week.start)} onToggle={event => { const open = event.currentTarget.open; setExpandedWeeks(previous => open === previous.includes(week.start) ? previous : open ? [...previous, week.start] : previous.filter(value => value !== week.start)); }}><summary><span><strong>Semana {index + 1}</strong> · {dateLabel(week.start)} a {dateLabel(week.end)}</span><strong>{currency(week.total_cents)}</strong></summary><div className="payable-forecast-week-body"><div className="payable-cheques"><span><strong>CHEQUES DA SEMANA</strong><small>{week.cheque_count} cheque(s) identificado(s) na situação da base importada · valor já incluído nos títulos reais</small></span><strong>{currency(week.cheques_cents)}</strong></div><div className="table-wrap"><table><caption>Composição por Centro de Custo Macro</caption><thead><tr><th>Macro</th><th>Real</th><th>Estimativa residual</th><th>Total</th></tr></thead><tbody>{week.macros.map(macro => <tr key={macro.macro}><td>{macro.macro}</td><td>{currency(macro.real_cents)}</td><td>{currency(macro.estimated_cents)}</td><td>{currency(macro.total_cents)}</td></tr>)}</tbody></table></div>{week.provisions.length > 0 && <div className="payable-forecast-provisions"><h3>Conferência das previsões fixas</h3>{week.provisions.map(provision => <article className="payable-forecast-provision" key={`${provision.rule_key}-${provision.month}`}><div><strong>{provision.label}</strong><small>Vencimento {dateLabel(provision.due_date)} · {provision.macro}</small><p>Previsão {currency(provision.expected_cents)} · Real vinculado {currency(provision.actual_cents)} · Residual <strong>{currency(provision.remaining_cents)}</strong></p>{provision.done && <span className="badge concluida">Estimativa atendida</span>}{provision.issues.map((issue, issueIndex) => <p className="payable-forecast-missing" key={`${issue}-${issueIndex}`}>{issueLabel(issue)}</p>)}</div>{canWrite && <button className="button secondary" disabled={loading || saving || uncertain || provision.month < `${report.as_of_date.slice(0, 7)}-01`} onClick={() => openEditor({ kind: 'completion', provision })}>{provision.done ? 'Reabrir estimativa' : 'Marcar como atendida'}</button>}</article>)}</div>}</div></details>)}</div>
      <details className="payable-forecast-configuration" open={configurationOpen} onToggle={event => setConfigurationOpen(event.currentTarget.open)}><summary>Regras e vínculos das previsões fixas{pendingPlans > 0 && <span className="badge pendente">{pendingPlans} plano(s) sem vínculo</span>}</summary><p className="help-text">Os valores e os vencimentos vêm das regras centrais com vigência. Planos novos precisam de vínculo confirmado: salários, salários dos sócios, adiantamento, adiantamento dos sócios ou nenhum destes grupos. Não há classificação automática pelo nome.</p><div className="table-wrap"><table><caption>Regras mais recentes cadastradas</caption><thead><tr><th>Previsão</th><th>Macro</th><th>Valor</th><th>Dia mensal</th><th>Vigência</th>{canWrite && canConfigure && <th>Alterar</th>}</tr></thead><tbody>{report.rules.map(rule => <tr key={rule.rule_key}><td>{rule.label}</td><td>{rule.macro}</td><td>{currency(rule.amount_cents)}</td><td>{rule.day_of_month}</td><td>{dateLabel(rule.effective_from)}</td>{canWrite && canConfigure && <td><button className="button secondary" disabled={saving || uncertain} onClick={() => openEditor({ kind: 'rule', key: rule.rule_key })}>Editar {rule.label}</button></td>}</tr>)}</tbody></table></div><label className="field">Pesquisar plano para previsão<input value={planSearch} onChange={event => { setPlanSearch(event.target.value); setPlanPage(0); }} maxLength={200} placeholder="Plano de contas" /></label><div className="table-wrap"><table><caption>Vínculos dos planos importados</caption><thead><tr><th>Plano de contas</th><th>Macro</th><th>Previsão abatida</th><th>Vigência</th>{canWrite && <th>Vínculo</th>}</tr></thead><tbody>{plans.length > 0 ? plans.map(plan => <tr key={plan.plan}><td>{plan.plan}</td><td>{plan.macro}</td><td>{!plan.configured ? <span className="payable-forecast-missing">Vínculo pendente</span> : plan.rule_key === null ? 'Nenhuma previsão fixa' : report.rules.find(rule => rule.rule_key === plan.rule_key)?.label ?? 'Regra registrada'}</td><td>{plan.effective_from ? dateLabel(plan.effective_from) : '—'}</td>{canWrite && <td><button className="button secondary" disabled={saving || uncertain} onClick={() => openEditor({ kind: 'plan', plan: plan.plan })}>Vincular {plan.plan}</button></td>}</tr>) : <tr><td colSpan={canWrite ? 5 : 4}>Nenhum plano encontrado.</td></tr>}</tbody></table></div><div className="pagination"><span>{filteredPlans.length} plano(s) · página {planPage + 1}</span><button className="button secondary" disabled={!planPage || saving} onClick={() => setPlanPage(value => value - 1)}>Planos anteriores</button><button className="button secondary" disabled={(planPage + 1) * 20 >= filteredPlans.length || saving} onClick={() => setPlanPage(value => value + 1)}>Próximos planos</button></div></details>
    </>}
    {editor && canWrite && <section className="payable-forecast-editor" aria-labelledby="payable-forecast-editor-title"><h3 id="payable-forecast-editor-title">{editor.kind === 'rule' ? 'Alterar regra de previsão' : editor.kind === 'plan' ? 'Vincular plano à previsão' : editor.provision.done ? 'Reabrir estimativa atendida' : 'Registrar estimativa atendida'}</h3><form className="stack" onSubmit={event => void save(event)}><fieldset disabled={saving}><p className="help-text">{editor.kind === 'rule' ? report?.rules.find(rule => rule.rule_key === editor.key)?.label : editor.kind === 'plan' ? editor.plan : `${editor.provision.label} · ${dateLabel(editor.provision.due_date)}`}</p><div className="form-grid">{editor.kind === 'rule' && <><label className="field">Valor da previsão (R$)<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} maxLength={24} required /></label><label className="field">Dia do vencimento mensal<input type="number" min="1" max="28" step="1" value={day} onChange={event => setDay(event.target.value)} required /></label></>}{editor.kind === 'plan' && <label className="field full">Previsão vinculada ao plano<select value={binding} onChange={event => setBinding(event.target.value)} required><option value="">Escolha o vínculo</option>{report?.rules.map(rule => <option key={rule.rule_key} value={rule.rule_key}>{rule.label}</option>)}<option value="NONE">Nenhuma previsão fixa</option></select></label>}{editor.kind !== 'completion' && <label className="field">Início da vigência<input type="date" value={effective} onChange={event => setEffective(event.target.value)} min={report?.as_of_date} required /></label>}<label className="field full">Observação da alteração<textarea value={observation} onChange={event => setObservation(event.target.value)} maxLength={1000} required /></label></div><div className="inline-actions"><button className="button" disabled={loading || saving || uncertain} type="submit">{saving ? 'Salvando alteração…' : editor.kind === 'rule' ? 'Salvar regra de previsão' : editor.kind === 'plan' ? 'Salvar vínculo do plano' : editor.provision.done ? 'Confirmar reabertura' : 'Confirmar estimativa atendida'}</button><button className="button secondary" type="button" disabled={saving} onClick={() => setEditor(null)}>Fechar edição</button></div></fieldset></form></section>}
  </section>;
}
