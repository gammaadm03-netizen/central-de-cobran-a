import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import { monthBounds } from '../lib/financial-dates';
import { officialToday } from './Treasury';
import '../receivable-commissions.css';

interface CommissionRow {
  receipt_id: string; title_id: string; document: string; client_name: string; branch: string;
  due_date: string; payment_date: string; amount_cents: number; nominal_amount_cents: number;
  collector_id: string | null; collector_name: string | null; delay_days: number; delay_band: string;
  payment_source: string; base_cents: number; eligibility: 'BASE_DISPONIVEL' | 'RECEBIDO_EM_DIA' | 'PENDENTE_RESPONSAVEL';
}
interface CommissionBase {
  rows: CommissionRow[]; count: number; total_received_cents: number; eligible_base_cents: number;
  unassigned_count: number; rule_status: 'AGUARDANDO_REGRAS'; collectors: { id: string; display_name: string }[];
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const money = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const eligibility = { BASE_DISPONIVEL: 'Base disponível para apuração', RECEBIDO_EM_DIA: 'Recebido em dia / antecipado', PENDENTE_RESPONSAVEL: 'Responsável pendente' };
function validBase(value: unknown): value is CommissionBase {
  if (!value || typeof value !== 'object') return false;
  const base = value as CommissionBase;
  return base.rule_status === 'AGUARDANDO_REGRAS' && money(base.count) && money(base.unassigned_count) && base.unassigned_count <= base.count
    && money(base.total_received_cents) && money(base.eligible_base_cents) && base.eligible_base_cents <= base.total_received_cents
    && Array.isArray(base.collectors) && base.collectors.length <= 1000 && base.collectors.every(item => uuid(item.id) && typeof item.display_name === 'string' && item.display_name.trim())
    && Array.isArray(base.rows) && base.rows.length <= 25 && base.rows.every(row => uuid(row.receipt_id) && uuid(row.title_id)
      && typeof row.document === 'string' && typeof row.client_name === 'string' && typeof row.branch === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date) && /^\d{4}-\d{2}-\d{2}$/.test(row.payment_date)
      && money(row.amount_cents) && money(row.nominal_amount_cents) && money(row.base_cents) && row.amount_cents === row.base_cents
      && money(row.delay_days) && Object.hasOwn(eligibility, row.eligibility)
      && (row.collector_id === null || uuid(row.collector_id)) && (row.collector_name === null || typeof row.collector_name === 'string'));
}
function failureMessage(failure: unknown) {
  const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)) return 'A base de comissões precisa da atualização de Contas a Receber no banco. Solicite a ativação à administração.';
  if (code === '42501') return 'Seu perfil não permite consultar esta base de comissões.';
  if (['PGRST301', 'PGRST303'].includes(code)) return 'Sua sessão expirou. Entre novamente.';
  return 'Não foi possível consultar a base de comissões. Atualize para tentar novamente.';
}

export default function ReceivableCommissions() {
  const initial = useRef(monthBounds(officialToday().slice(0, 7))).current;
  const [start, setStart] = useState(initial.start), [end, setEnd] = useState(initial.end), [collector, setCollector] = useState('');
  const [filters, setFilters] = useState({ start: initial.start, end: initial.end, collector: '' });
  const [page, setPage] = useState(0), [refresh, setRefresh] = useState(0);
  const [base, setBase] = useState<CommissionBase | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [collectors, setCollectors] = useState<CommissionBase['collectors']>([]), [selected, setSelected] = useState<CommissionRow | null>(null);
  useEffect(() => {
    const client = supabase; if (!client) { setLoading(false); setError('Conexão indisponível.'); return; }
    const abort = new AbortController(); setLoading(true); setError(''); setBase(null); setSelected(null);
    void Promise.resolve(client.rpc('receivable_commission_base', { p_start: filters.start, p_end: filters.end, p_collector_id: filters.collector || null, p_offset: page * 25, p_limit: 25 }).abortSignal(abort.signal).retry(false)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      if (!validBase(result.data)) throw new Error('invalid_response');
      const last = Math.max(0, Math.ceil(result.data.count / 25) - 1);
      setCollectors(result.data.collectors);
      if (page > last) setPage(last); else setBase(result.data);
    }).catch(failure => { if (!abort.signal.aborted) setError(failureMessage(failure)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [filters, page, refresh]);
  function query(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    if (!start || !end || start > end || (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000 > 3660) { setError('Informe um período válido de recebimentos, de até dez anos.'); return; }
    setFilters({ start, end, collector }); setPage(0); setRefresh(value => value + 1);
  }
  return <div className="stack receivable-commissions">
    <section className="panel" aria-labelledby="commission-base-title"><div className="panel-header"><div><h2 id="commission-base-title">Base de comissões de cobrança</h2><p className="muted">Recebimentos confirmados, pela data efetiva, com a responsável e o atraso no recebimento.</p></div><button className="button secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Atualizar base de comissões</button></div>
      <p className="notice">A base é o <strong>valor efetivamente recebido</strong>. Recebimentos em atraso com responsável ficam disponíveis para apuração. Os percentuais e suas vigências aguardam definição; estes valores não representam comissão calculada ou paga.</p>
      <form className="form-grid" onSubmit={query}><label className="field">Recebimento inicial<input type="date" min="1900-01-01" max="2199-12-31" required value={start} onChange={event => setStart(event.target.value)} /></label><label className="field">Recebimento final<input type="date" min="1900-01-01" max="2199-12-31" required value={end} onChange={event => setEnd(event.target.value)} /></label><label className="field">Cobradora da comissão<select value={collector} onChange={event => setCollector(event.target.value)}><option value="">Todas as responsáveis</option>{collectors.map(item => <option value={item.id} key={item.id}>{item.display_name}</option>)}</select></label><button className="button" disabled={loading}>Consultar base de comissões</button></form>
      {error && <p className="notice error" role="alert">{error}</p>}{loading && <p role="status">Carregando recebimentos para comissões…</p>}
      {base && <><div className="commission-base-cards"><article><h3>Recebido no período</h3><strong>{formatCents(base.total_received_cents)}</strong><small>{base.count} recebimento(s) confirmado(s)</small></article><article><h3>Base em atraso atribuída</h3><strong>{formatCents(base.eligible_base_cents)}</strong><small>Disponível para aplicar as regras de comissão</small></article><article><h3>Responsável pendente</h3><strong>{base.unassigned_count}</strong><small>Recebimento preservado para conferência da atribuição</small></article></div>
      <div className="table-wrap"><table><caption>Recebimentos confirmados para comissões</caption><thead><tr><th>Título / cliente</th><th>Filial</th><th>Vencimento</th><th>Recebimento real</th><th>Valor original</th><th>Base recebida</th><th>Cobradora</th><th>Atraso</th><th>Situação da apuração</th><th>Detalhes</th></tr></thead><tbody>{base.rows.length ? base.rows.map(row => <tr key={row.receipt_id}><td><strong>{row.document}</strong><small>{row.client_name}</small></td><td>{row.branch}</td><td>{dateLabel(row.due_date)}</td><td>{dateLabel(row.payment_date)}</td><td>{formatCents(row.nominal_amount_cents)}</td><td>{formatCents(row.base_cents)}</td><td>{row.collector_name || 'Não atribuída'}</td><td>{row.delay_days} dia(s)</td><td>{eligibility[row.eligibility]}</td><td><button className="button secondary" onClick={() => setSelected(row)}>Abrir recebimento {row.document}</button></td></tr>) : <tr><td colSpan={10} className="empty-state">Nenhum recebimento confirmado para o período e a responsável selecionados.</td></tr>}</tbody></table></div>
      <div className="pagination"><p>{base.count} recebimento(s) · página {page + 1} de {Math.max(1, Math.ceil(base.count / 25))}</p><div className="inline-actions"><button className="button secondary" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}>Anterior</button><button className="button secondary" disabled={(page + 1) * 25 >= base.count || loading} onClick={() => setPage(value => value + 1)}>Próxima</button></div></div></>}
    </section>
    {selected && <section className="panel" aria-labelledby="commission-receipt-title"><div className="panel-header"><h2 id="commission-receipt-title">Recebimento {selected.document}</h2><button className="button secondary" onClick={() => setSelected(null)}>Fechar recebimento</button></div><p>{selected.client_name} · Filial {selected.branch} · {selected.collector_name || 'Responsável pendente'}</p><dl className="commission-receipt-details"><div><dt>Valor nominal</dt><dd>{formatCents(selected.nominal_amount_cents)}</dd></div><div><dt>Valor efetivamente recebido</dt><dd>{formatCents(selected.amount_cents)}</dd></div><div><dt>Vencimento original</dt><dd>{dateLabel(selected.due_date)}</dd></div><div><dt>Data efetiva do recebimento</dt><dd>{dateLabel(selected.payment_date)}</dd></div><div><dt>Atraso no recebimento</dt><dd>{selected.delay_days} dia(s)</dd></div><div><dt>Situação da apuração</dt><dd>{eligibility[selected.eligibility]}</dd></div></dl><p className="help-text">O recebimento permanece vinculado ao título e à responsável. A importação não gera pagamento de comissão.</p></section>}
  </div>;
}
