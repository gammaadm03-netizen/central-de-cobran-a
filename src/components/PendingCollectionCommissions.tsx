import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import { isPendingCollectionCommissionsReport, pendingCollectionCommissionsError, type PendingCollectionCommission, type PendingCollectionCommissionsReport } from '../lib/pending-collection-commissions';

const timestamp = (value: string) => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
export default function PendingCollectionCommissions({ refreshKey }: { refreshKey: number }) {
  const [search, setSearch] = useState(''), [collector, setCollector] = useState('');
  const [filters, setFilters] = useState({ search: '', collector: '' }), [page, setPage] = useState(0), [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<PendingCollectionCommissionsReport | null>(null), [collectors, setCollectors] = useState<PendingCollectionCommissionsReport['options']['collectors']>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [selected, setSelected] = useState<PendingCollectionCommission | null>(null);
  useEffect(() => {
    const client = supabase, abort = new AbortController();
    setLoading(true); setError(''); setReport(null); setSelected(null);
    if (!client) { setLoading(false); setError('Conexão indisponível.'); return; }
    void Promise.resolve(client.rpc('pending_collection_commissions', { p_search: filters.search, p_collector_id: filters.collector || null, p_offset: page * 25, p_limit: 25 }).abortSignal(abort.signal).retry(false)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      if (!isPendingCollectionCommissionsReport(result.data)) throw new Error('invalid_response');
      const last = Math.max(0, Math.ceil(result.data.count / 25) - 1);
      setCollectors(result.data.options.collectors);
      if (page > last) setPage(last); else setReport(result.data);
    }).catch(failure => { if (!abort.signal.aborted) setError(pendingCollectionCommissionsError(failure)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [filters, page, refresh, refreshKey]);
  function query(event: FormEvent) {
    event.preventDefault(); if (loading) return;
    setPage(0); setFilters({ search: search.trim(), collector }); setRefresh(value => value + 1);
  }
  return <section className="panel stack" aria-labelledby="pending-collection-commissions-title">
    <div className="panel-header"><div><h2 id="pending-collection-commissions-title">Aguardando confirmação de recebimento</h2><p className="muted">Títulos trabalhados que saíram do relatório completo de abertos. O relatório de quitados deve confirmar o recebimento para que a comissão seja calculada.</p></div><button type="button" className="button secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Atualizar pendências</button></div>
    <p className="help-text">Esta fila mostra a posição atual, sem filtro de mês de recebimento. Os valores nominais são apenas referência e ficam fora do recebido validado, da comissão apurada e das apurações salvas.</p>
    <form className="form-grid" onSubmit={query}><label className="field">Buscar título pendente<input value={search} maxLength={200} onChange={event => setSearch(event.target.value)} placeholder="Cliente, documento ou filial" /></label><label className="field">Cobradora das pendências<select aria-label="Cobradora das pendências" value={collector} onChange={event => setCollector(event.target.value)}><option value="">Todas as responsáveis</option>{collectors.map(item => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><button type="submit" className="button" disabled={loading}>Consultar pendências</button><button type="button" className="button secondary" disabled={loading} onClick={() => { setSearch(''); setCollector(''); setFilters({ search: '', collector: '' }); setPage(0); }}>Limpar filtros das pendências</button></form>
    {loading && <p role="status">Consultando títulos aguardando recebimento…</p>}{error && <p className="notice error" role="alert">{error}</p>}
    {report && !report.count && <p className="empty-state">Nenhum título aguardando confirmação de recebimento neste filtro.</p>}
    {report && report.count > 0 && <><div className="table-wrap"><table><caption>Títulos trabalhados aguardando relatório de quitados</caption><thead><tr><th>Cliente / documento</th><th>Filial</th><th>Cobradora</th><th>Vencimento original</th><th>Valor nominal de referência</th><th>Situação</th><th>Detalhes</th></tr></thead><tbody>{report.rows.map(row => <tr key={row.event_id}><td>{row.client_name}<small>Documento {row.document}</small></td><td>{row.branch}</td><td>{row.collector_name ?? 'Sem responsável atual'}</td><td>{dateLabel(row.due_date)}</td><td>{formatCents(row.nominal_reference_cents)}</td><td>Aguardando relatório de quitados</td><td><button type="button" className="button secondary" onClick={() => setSelected(row)}>Abrir pendência {row.document}</button></td></tr>)}</tbody></table></div>
      <div className="pagination"><p>{report.count} pendência(s) · página {page + 1} de {Math.max(1, Math.ceil(report.count / 25))}</p><div className="inline-actions"><button type="button" className="button secondary" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}>Pendências anteriores</button><button type="button" className="button secondary" disabled={(page + 1) * 25 >= report.count || loading} onClick={() => setPage(value => value + 1)}>Próximas pendências</button></div></div></>}
    {selected && <section aria-labelledby="pending-commission-detail-title"><div className="panel-header"><h3 id="pending-commission-detail-title">Pendência {selected.document}</h3><button type="button" className="button secondary" onClick={() => setSelected(null)}>Fechar pendência</button></div><p>{selected.client_name} · Filial {selected.branch} · {selected.collector_name ?? 'Sem responsável atual'}</p><dl className="commission-receipt-details"><div><dt>Valor nominal de referência</dt><dd>{formatCents(selected.nominal_reference_cents)}</dd></div><div><dt>Recebimento</dt><dd>A confirmar pelo relatório de quitados</dd></div><div><dt>Comissão</dt><dd>Aguardando confirmação do recebimento</dd></div><div><dt>Vencimento original</dt><dd>{dateLabel(selected.due_date)}</dd></div><div><dt>Data de referência do relatório completo</dt><dd>{dateLabel(selected.reference_date)}</dd></div><div><dt>Retirado da carteira ativa em</dt><dd>{timestamp(selected.retired_at)}</dd></div></dl><p className="help-text">O histórico da cobrança permanece preservado. Se o título reaparecer em abertos, ele volta à carteira; se for confirmado em quitados, passa para a apuração com a data e o valor efetivamente recebidos.</p></section>}
  </section>;
}
