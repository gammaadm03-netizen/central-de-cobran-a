import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel } from '../lib/payables';
import '../collection-secondary.css';

interface WorkRow { title_id: string; document: string; client_name: string; branch: string; collector_id: string | null; collector_name: string | null; actor_id: string; actor_name: string; session_id: string; started_at: string; ended_at: string | null; end_reason: string | null; seconds: number; running: boolean }
interface WorkSummary {
  start: string; end: string; as_of_date: string; server_now: string; total_seconds: number; session_count: number; running_count: number; title_count: number; truncated: boolean;
  by_collector: { collector_id: string | null; display_name: string; total_seconds: number; session_count: number; running_count: number; title_count: number }[];
  by_day: { date: string; total_seconds: number; session_count: number; title_count: number }[]; rows: WorkRow[];
}
export interface CollectionWorkTimeProps { isCollector: boolean; collectorId: string | null; refreshKey?: number }
const civil = /^\d{4}-\d{2}-\d{2}$/;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function duration(value: number) { return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
function timestamp(value: string | null) { return value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—'; }
function validSummary(value: WorkSummary, isCollector: boolean, collectorId: string | null) {
  if (!value || !civil.test(value.start) || !civil.test(value.end) || value.start > value.end || !civil.test(value.as_of_date) || !Number.isFinite(Date.parse(value.server_now))
    || ![value.total_seconds, value.session_count, value.running_count, value.title_count].every(integer) || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.by_collector) || !Array.isArray(value.by_day) || !Array.isArray(value.rows) || value.rows.length > 1000) return false;
  if (value.by_collector.some(row => ![row.total_seconds, row.session_count, row.running_count, row.title_count].every(integer) || typeof row.display_name !== 'string' || isCollector && row.collector_id !== collectorId)) return false;
  if (value.by_day.some(row => !civil.test(row.date) || row.date < value.start || row.date > value.end || ![row.total_seconds, row.session_count, row.title_count].every(integer))) return false;
  return value.rows.every(row => integer(row.seconds) && typeof row.running === 'boolean' && typeof row.document === 'string' && typeof row.client_name === 'string'
    && Number.isFinite(Date.parse(row.started_at)) && (row.ended_at === null || Number.isFinite(Date.parse(row.ended_at))) && (!isCollector || row.collector_id === collectorId));
}
function workError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['PGRST202', 'PGRST205', '42P01'].includes(code)) return 'Ative a atualização de Tempo de trabalho no banco para consultar os registros persistentes.';
  if (code === '42501') return 'Seu perfil não permite consultar este período ou esta carteira.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (code === '22023') return 'Confira o período: informe as duas datas e use no máximo 366 dias.';
  return 'Não foi possível consultar o tempo registrado. Atualize a consulta; nenhum total foi presumido.';
}

export default function CollectionWorkTime({ isCollector, collectorId, refreshKey = 0 }: CollectionWorkTimeProps) {
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [collector, setCollector] = useState('');
  const [range, setRange] = useState<{ start: string | null; end: string | null; collector: string }>({ start: null, end: null, collector: '' });
  const [agents, setAgents] = useState<{ id: string; display_name: string }[]>([]), [summary, setSummary] = useState<WorkSummary | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [page, setPage] = useState(0);
  useEffect(() => {
    if (isCollector || !supabase) return;
    const abort = new AbortController();
    void Promise.resolve(supabase.from('collection_agents').select('id,display_name').order('display_name').abortSignal(abort.signal)).then(result => { if (!abort.signal.aborted && !result.error) setAgents((result.data ?? []) as { id: string; display_name: string }[]); });
    return () => abort.abort();
  }, [isCollector]);
  useEffect(() => {
    const client = supabase, abort = new AbortController(); setError(''); setSummary(null); setPage(0);
    if (isCollector && !collectorId) { setLoading(false); return; }
    if (!client) { setLoading(false); setError('Sua sessão expirou. Entre novamente.'); return; }
    setLoading(true);
    void Promise.resolve(client.rpc('collection_work_summary', { p_start: range.start, p_end: range.end, p_collector_id: isCollector ? collectorId : range.collector || null }).abortSignal(abort.signal)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      const data = result.data as WorkSummary;
      if (!validSummary(data, isCollector || !!range.collector, isCollector ? collectorId : range.collector || null) || range.start && (data.start !== range.start || data.end !== range.end)) throw new Error('invalid_summary');
      setSummary(data);
      if (range.start === null) { setStart(data.start); setEnd(data.end); }
    }).catch(failure => { if (!abort.signal.aborted) setError(workError(failure)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [range, isCollector, collectorId, refresh, refreshKey]);
  function apply(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!civil.test(start) || !civil.test(end) || start > end || (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000 > 365) { setError('Informe um período válido de até 366 dias, com a data inicial anterior à final.'); return; }
    setRange({ start, end, collector });
  }
  if (isCollector && !collectorId) return <p className="notice">Vincule seu login à sua carteira para consultar o tempo de trabalho.</p>;
  const rows = summary?.rows.slice(page * 25, page * 25 + 25) ?? [], pages = Math.max(1, Math.ceil((summary?.rows.length ?? 0) / 25));
  return <section className="panel collection-secondary collection-work-time" aria-labelledby="collection-work-time-title">
    <div className="panel-header"><div><h2 id="collection-work-time-title">Tempo de trabalho</h2><p className="muted">Intervalos registrados na Central dentro do período selecionado. Pausas ficam fora da soma.</p></div><button type="button" className="button secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Atualizar tempo registrado</button></div>
    {isCollector && <p className="help-text">Esta consulta reúne os intervalos operados pelo seu acesso, incluindo o histórico preservado.</p>}
    <form className="collection-work-filters" onSubmit={apply}><div className="form-grid"><label className="field">Início do período de trabalho<input type="date" min="1900-01-01" max="2199-12-31" value={start} onChange={event => setStart(event.target.value)} /></label><label className="field">Fim do período de trabalho<input type="date" min="1900-01-01" max="2199-12-31" value={end} onChange={event => setEnd(event.target.value)} /></label>{!isCollector && <label className="field">Responsável no tempo de trabalho<select value={collector} onChange={event => setCollector(event.target.value)}><option value="">Todas as responsáveis</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}</select></label>}</div><button type="submit" className="button" disabled={loading}>Consultar tempo no período</button></form>
    {error && <p className="notice error" role="alert">{error}</p>}{loading && <p className="help-text" role="status">Consultando intervalos registrados…</p>}
    <div className="collection-work-cards"><article><h3>Tempo registrado no período</h3><strong>{summary ? duration(summary.total_seconds) : 'Não disponível'}</strong></article><article><h3>Sessões de trabalho</h3><strong>{summary ? summary.session_count.toLocaleString('pt-BR') : 'Não disponível'}</strong></article><article><h3>Títulos trabalhados</h3><strong>{summary ? summary.title_count.toLocaleString('pt-BR') : 'Não disponível'}</strong></article></div>
    {summary && <><p className="help-text">Período: {dateLabel(summary.start)} a {dateLabel(summary.end)} · Consulta oficial: {timestamp(summary.server_now)} · {summary.running_count} sessão(ões) em andamento no período. A duração em andamento é atualizada ao consultar novamente.</p>
      <div className="table-wrap"><table className="data-table"><caption>Tempo por responsável no período</caption><thead><tr><th>Responsável</th><th>Tempo</th><th>Sessões</th><th>Títulos</th></tr></thead><tbody>{summary.by_collector.length ? summary.by_collector.map((row, index) => <tr key={row.collector_id ?? index}><td>{row.display_name}</td><td>{duration(row.total_seconds)}</td><td>{row.session_count}</td><td>{row.title_count}</td></tr>) : <tr><td colSpan={4} className="empty-state">Nenhum intervalo registrado no período.</td></tr>}</tbody></table></div>
      <div className="table-wrap"><table className="data-table"><caption>Intervalos de trabalho registrados</caption><thead><tr><th>Cliente / NF</th><th>Responsável / Operador</th><th>Início</th><th>Fim</th><th>Tempo no período</th><th>Situação</th></tr></thead><tbody>{rows.length ? rows.map(row => <tr key={row.session_id}><td>{row.client_name}<div>{row.document} · Filial {row.branch}</div></td><td>{row.collector_name ?? 'Sem responsável atribuída'}<div>Operador: {row.actor_name}</div></td><td>{timestamp(row.started_at)}</td><td>{timestamp(row.ended_at)}</td><td>{duration(row.seconds)}</td><td>{row.running ? 'Em andamento' : row.end_reason === 'PAUSE' ? 'Pausada' : row.end_reason === 'FINISH' ? 'Concluída' : 'Encerrada'}</td></tr>) : <tr><td colSpan={6} className="empty-state">Nenhum intervalo registrado no período.</td></tr>}</tbody></table></div>
      {summary.truncated && <p className="notice">Os totais incluem todo o período. A tabela detalhada mostra até 1.000 intervalos; reduza o período para consultar outros registros.</p>}
      <div className="pagination"><span>{summary.rows.length.toLocaleString('pt-BR')} intervalos na tabela · página {page + 1} de {pages}</span><button type="button" className="button secondary" disabled={!page} onClick={() => setPage(value => value - 1)}>Intervalos anteriores</button><button type="button" className="button secondary" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>Próximos intervalos</button></div>
    </>}
  </section>;
}
