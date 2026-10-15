import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, downloadCsv, formatCents, PAYABLE_SCOPE, payableError, payableStatus, readPayables, type PayableFilters, type PayableTitle } from '../lib/payables';

const initialFilters: PayableFilters = { scope: PAYABLE_SCOPE, search: '', start: '', end: '', status: '', macro: '', branch: '' };
export default function Payables({ onImport }: { onImport?: () => void }) {
  const [filters, setFilters] = useState(initialFilters);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<PayableTitle[]>([]);
  const [macros, setMacros] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const exportAbort = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbort.current?.abort(),[]);
  useEffect(() => { const timer = window.setTimeout(() => { setFilters(previous => ({ ...previous, search })); setPage(0); },200); return () => window.clearTimeout(timer); },[search]);
  useEffect(() => {
    const client = supabase; if (!client) return;
    const abort = new AbortController();
    void client.from('payable_macros').select('name').order('name').abortSignal(abort.signal).then(result => { if (!abort.signal.aborted && !result.error) setMacros((result.data ?? []).map(item => String(item.name))); });
    return () => abort.abort();
  },[]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(''); setRows([]);
    if (filters.start && filters.end && filters.start > filters.end) { setError('A data inicial deve ser anterior à data final.'); setLoading(false); setCount(0); return; }
    void readPayables(filters,page*size,size,abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setCount(result.count);
      const last = Math.max(0,Math.ceil(result.count/size)-1);
      if (page > last) setPage(last); else setRows(result.rows);
    }).catch(loadError => { if (!abort.signal.aborted) { setCount(0); setError(payableError(loadError,'Não foi possível carregar Contas a Pagar. Tente atualizar a lista.')); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  },[filters,page,size,refresh]);
  function change(key: keyof PayableFilters,value:string) { setFilters(previous => ({ ...previous,[key]:value })); setPage(0); }
  async function exportRows() {
    if (exporting || !count || loading) return;
    const frozen = { ...filters }; const abort = new AbortController(); exportAbort.current = abort; setExporting(true); setError(''); setExportProgress('Preparando exportação…');
    try {
      const client = supabase; if (!client) throw { code:'PGRST301' };
      const latestImport = async () => { const result = await client.from('payable_imports').select('id').eq('scope',frozen.scope).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1).abortSignal(abort.signal); if (result.error) throw result.error; return result.data?.[0]?.id ?? null; };
      const snapshot = await latestImport();
      const selected: PayableTitle[] = []; let expected: number | null = null;
      for (let offset = 0;;offset += 500) {
        const result = await readPayables(frozen,offset,500,abort.signal);
        if (abort.signal.aborted) return;
        if (expected !== null && result.count !== expected) throw new Error('A base mudou durante a exportação. Atualize os filtros e tente novamente.');
        expected = result.count; selected.push(...result.rows);
        if (selected.length > 100000) throw new Error('A exportação excede 100.000 títulos. Restrinja o período ou os filtros.');
        setExportProgress(`Exportando ${selected.length.toLocaleString('pt-BR')} de ${expected.toLocaleString('pt-BR')} títulos…`);
        if (selected.length >= expected) break;
        if (!result.rows.length) throw new Error('A base mudou durante a exportação. Tente novamente.');
      }
      if (await latestImport() !== snapshot) throw new Error('A base mudou durante a exportação. Atualize os filtros e tente novamente.');
      if (abort.signal.aborted) return;
      downloadCsv(selected,`Contas_a_Pagar_Filtrado_${new Date().toISOString().slice(0,10)}.csv`);
      setExportProgress(`${selected.length.toLocaleString('pt-BR')} títulos exportados com os filtros selecionados.`);
    } catch (exportError) { if (!abort.signal.aborted) { setError(payableError(exportError,exportError instanceof Error ? exportError.message : 'Não foi possível concluir a exportação.')); setExportProgress(''); } }
    finally { if (!abort.signal.aborted) setExporting(false); }
  }
  const pages = Math.max(1,Math.ceil(count/size));
  return <section className="panel" aria-labelledby="payables-title">
    <div className="panel-header"><div><h2 id="payables-title">Lançamentos de Contas a Pagar</h2><p className="muted">Grupo consolidado · títulos quitados permanecem no histórico. Semana financeira: sábado a sexta-feira.</p></div><div className="inline-actions">{onImport && <button type="button" className="button" onClick={onImport}>Ir para Importar Bases</button>}<button type="button" className="button secondary" disabled={loading} onClick={() => setRefresh(value => value+1)}>Atualizar títulos</button></div></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="form-grid">
      <label className="field" htmlFor="payables-search">Pesquisar histórico / favorecido<input id="payables-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Nome ou descrição" maxLength={200} /></label>
      <label className="field" htmlFor="payables-status">Status<select id="payables-status" value={filters.status} onChange={event => change('status',event.target.value)}><option value="">Todos, incluindo histórico</option>{Object.entries(payableStatus).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="field" htmlFor="payables-start">Vencimento inicial<input id="payables-start" type="date" value={filters.start} onChange={event => change('start',event.target.value)} /></label>
      <label className="field" htmlFor="payables-end">Vencimento final<input id="payables-end" type="date" value={filters.end} onChange={event => change('end',event.target.value)} /></label>
      <label className="field" htmlFor="payables-macro">Centro de Custo Macro<select id="payables-macro" value={filters.macro} onChange={event => change('macro',event.target.value)}><option value="">Todos os macros</option>{macros.map(macro => <option key={macro}>{macro}</option>)}</select></label>
      <label className="field" htmlFor="payables-branch">Filial<input id="payables-branch" value={filters.branch} onChange={event => change('branch',event.target.value)} placeholder="Código / nome exato da base" maxLength={200} /></label>
    </div>
    <div className="toolbar"><button className="button secondary" type="button" onClick={() => { setSearch(''); setFilters(initialFilters); setPage(0); }}>Limpar filtros</button><button className="button secondary" type="button" disabled={loading || exporting || !count} onClick={() => void exportRows()}>{exporting ? 'Exportando…' : 'Baixar CSV dos filtros'}</button></div>
    {exportProgress && <p className="help-text" role="status">{exportProgress}</p>}
    <div className="table-wrap" aria-busy={loading}><table className="data-table"><caption className="sr-only">Títulos de Contas a Pagar com filtros e paginação</caption><thead><tr><th>Macro / Plano</th><th>Nº lançamento</th><th>Histórico / Favorecido</th><th>Filial / Banco</th><th>Emissão</th><th>Vencimento</th><th>Valor</th><th>Status / Situação</th><th>Baixa automática</th></tr></thead><tbody>{loading ? <tr><td className="empty-state" colSpan={9}>Carregando títulos…</td></tr> : rows.length ? rows.map(row => <tr key={row.id}><td><strong>{row.macro}</strong><div>{row.plan}</div></td><td>{row.entry_number}</td><td>{row.description}</td><td>{row.branch}<div>{row.bank_account || '—'}</div></td><td>{dateLabel(row.issued_on)}</td><td>{dateLabel(row.due_date)}</td><td style={{whiteSpace:'nowrap'}}>{formatCents(row.amount_cents)}</td><td><span className="badge">{payableStatus[row.status]}</span><div>{row.source_status || '—'}</div></td><td>{dateLabel(row.settled_at)}</td></tr>) : <tr><td className="empty-state" colSpan={9}>{error ? 'Lista indisponível.' : 'Nenhum título para os filtros selecionados. Importe uma base completa em Importar Bases.'}</td></tr>}</tbody></table></div>
    <div className="pagination"><label className="field" htmlFor="payables-size">Por página<select id="payables-size" value={size} onChange={event => { setSize(+event.target.value); setPage(0); }}><option value="25">25</option><option value="50">50</option></select></label><span>{count.toLocaleString('pt-BR')} títulos · página {page+1} de {pages}</span><button type="button" className="button secondary" disabled={loading || !page} onClick={() => setPage(value => value-1)}>Anterior</button><button type="button" className="button secondary" disabled={loading || page+1>=pages} onClick={() => setPage(value => value+1)}>Próxima</button></div>
  </section>;
}
