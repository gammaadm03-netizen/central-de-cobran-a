import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { displayDate, displayDateTime, money, officialToday, parseBRLCents, type StockPosition } from './Treasury';
import '../stock-import.css';

interface StockHistory {
  id: string; value_cents: number; reference_date: string; observation: string; created_at: string; created_by: string;
  profiles: { username: string; display_name: string } | null;
}
function validReference(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > officialToday()) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export default function StockImport({ canWrite, onDashboard }: { canWrite: boolean; onDashboard?: () => void }) {
  const [reference, setReference] = useState(officialToday);
  const [amount, setAmount] = useState('');
  const [observation, setObservation] = useState('');
  const [stock, setStock] = useState<StockPosition | null>(null);
  const [history, setHistory] = useState<StockHistory[]>([]);
  const [loadedPage, setLoadedPage] = useState(-1);
  const [historyCount, setHistoryCount] = useState(0);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [readError, setReadError] = useState('');

  useEffect(() => {
    if (!canWrite) { setLoading(false); return; }
    let active = true;
    setLoading(true); setReadError('');
    async function load() {
      try {
        if (!supabase) throw new Error('connection');
        const [current, rows] = await Promise.all([
          supabase.rpc('current_stock'),
          supabase.from('stock_positions').select('id,value_cents,reference_date,observation,created_at,created_by,profiles!stock_positions_created_by_fkey(username,display_name)', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(page * 20, page * 20 + 19).retry(false),
        ]);
        if (current.error || rows.error || !current.data || !Array.isArray(rows.data)) throw new Error('read');
        if (active) {
          setStock(current.data as StockPosition); setHistory(rows.data as unknown as StockHistory[]); setHistoryCount(rows.count ?? 0); setLoadedPage(page);
          setSaveUncertain(false); setError('');
        }
      } catch { if (active) setReadError('Não foi possível consultar o estoque e seu histórico. Os campos preenchidos foram preservados. Atualize e tente novamente.'); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [canWrite, page, revision]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || saving || loading || saveUncertain) return;
    setError(''); setSuccess('');
    const cents = parseBRLCents(amount);
    if (cents === null || cents < 0 || !validReference(reference) || !observation.trim() || observation.trim().length > 1000) {
      setError('Informe valor maior ou igual a zero, com até duas casas decimais, data de referência válida e observação de até 1.000 caracteres.'); return;
    }
    if (!window.confirm(`Salvar posição manual de estoque?\n\nReferência: ${displayDate(reference)}\nValor: ${money(cents)}\n\nA posição será preservada no histórico com responsável e auditoria.`)) return;
    setSaving(true);
    try {
      if (!supabase) throw new Error('connection');
      const result = await supabase.rpc('save_manual_stock', { p_value_cents: cents, p_reference_date: reference, p_observation: observation.trim() });
      if (result.error || typeof result.data !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(result.data)) throw new Error('write');
      setAmount(''); setObservation('');
      setSuccess(`Estoque manual de ${displayDate(reference)} registrado com histórico e auditoria.`);
      setPage(0); setRevision(value => value + 1);
    } catch {
      setSaveUncertain(true);
      setError('Não foi possível confirmar o salvamento. Seus campos foram mantidos. Atualize a posição e confira o histórico antes de tentar novamente.');
    } finally { setSaving(false); }
  }

  if (!canWrite) return <section className="panel"><h2>Estoque</h2><p className="notice">Seu perfil não permite registrar posições de estoque. Consulte o Painel Gerencial para visualizar a posição autorizada.</p></section>;
  const displayedHistory = loadedPage === page && !readError ? history : [];
  return <div className="stock-import stack">
    <section className="panel stock-import-current"><div className="panel-heading"><div><h2>Estoque manual</h2><p className="muted">Informe o valor total do estoque para atualizar a posição central da Central Financeira.</p></div><span className="badge">MANUAL</span></div>
      <div className="stock-import-position"><div><span className="stock-import-label">VALOR ESTIMADO DO ESTOQUE</span><strong>{loading && !stock ? 'Carregando…' : stock?.value_cents != null ? money(stock.value_cents) : 'ESTOQUE AGUARDANDO ATUALIZAÇÃO'}</strong><small>{stock?.value_cents != null ? `MANUAL · Referência ${displayDate(stock.reference_date)}` : 'Ausência de informação não é considerada valor zero.'}</small></div><button type="button" className="button secondary" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>{loading ? 'Consultando estoque…' : 'Atualizar posição e histórico'}</button></div>
      <p className="help-text">O Painel Gerencial utiliza a posição com a data de referência mais recente. Em caso de mesma data, utiliza o registro mais recente. Uma posição antiga permanece no histórico.</p>
      {readError && <p className="alert error" role="alert">{readError}</p>}
    </section>
    <section className="panel stock-import-form"><h2>Registrar posição de estoque</h2><p className="muted">Após salvar, o valor fica disponível no Painel Gerencial e em Caixa/Bancos ao abrir ou atualizar essas telas.</p>
      {error && <p className="alert error" role="alert">{error}</p>}{success && <p className="alert success" role="status">{success}</p>}
      <form className="stack" onSubmit={event => void save(event)}><fieldset disabled={saving}><div className="form-grid">
        <label className="field">Data de referência do estoque<input type="date" value={reference} onChange={event => setReference(event.target.value)} max={officialToday()} min="1900-01-01" required /></label>
        <label className="field">Valor total do estoque (R$)<input inputMode="decimal" autoComplete="off" placeholder="1.234,56" value={amount} onChange={event => setAmount(event.target.value)} maxLength={24} required /></label>
        <label className="field full">Observação da posição de estoque<textarea value={observation} onChange={event => setObservation(event.target.value)} maxLength={1000} required /></label>
      </div><div className="inline-actions"><button className="button" type="submit" disabled={saving || loading || saveUncertain}>{saving ? 'Salvando estoque…' : 'Salvar posição de estoque'}</button>{onDashboard && <button className="button secondary" type="button" disabled={saving} onClick={onDashboard}>Ir para o Painel Gerencial</button>}</div></fieldset></form>
    </section>
    <section className="panel stock-import-history"><div className="panel-heading"><div><h2>Histórico do estoque</h2><p className="muted">Registros preservados por data de inclusão, com responsável e observação.</p></div></div>
      {loading && <p className="help-text" role="status">Carregando histórico de estoque…</p>}
      {!loading && !readError && displayedHistory.length === 0 && <p className="empty-state">Nenhuma posição de estoque registrada.</p>}
      {!loading && displayedHistory.length > 0 && <div className="table-scroll"><table><thead><tr><th>Data de referência</th><th>Valor do estoque</th><th>Registrado em</th><th>Responsável</th><th>Observação</th></tr></thead><tbody>{displayedHistory.map(row => <tr key={row.id}><td>{displayDate(row.reference_date)}</td><td className="financial-numeric">{money(row.value_cents)}</td><td>{displayDateTime(row.created_at)}</td><td>{row.profiles?.display_name || row.profiles?.username || 'Responsável registrado'}{row.profiles?.display_name && row.profiles.username && <small className="stock-import-author">{row.profiles.username}</small>}</td><td className="stock-import-observation">{row.observation}</td></tr>)}</tbody></table></div>}
      <div className="pagination"><span>{historyCount} posição(ões) · Página {page + 1}</span><button className="button secondary" type="button" disabled={loading || saving || page === 0} onClick={() => setPage(value => value - 1)}>Anterior</button><button className="button secondary" type="button" disabled={loading || saving || (page + 1) * 20 >= historyCount} onClick={() => setPage(value => value + 1)}>Próxima</button></div>
    </section>
  </div>;
}
