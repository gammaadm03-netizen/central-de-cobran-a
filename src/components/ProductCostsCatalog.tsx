import { useEffect, useId, useState } from 'react';
import { dateLabel } from '../lib/payables';
import { costDecimal, costUuid, displayUnitCost, displayWeight, productCostError, readCostHistory, readProductCosts, type CostReport, type CostSource, type ProductCostRow } from '../lib/product-costs';
import '../product-costs.css';

const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function validRow(row: ProductCostRow) { return row && typeof row.code === 'string' && !!row.code && typeof row.product === 'string' && count(row.line_number) && (row.unit_cost === null || costDecimal(row.unit_cost)) && (row.weight_kg === null || costDecimal(row.weight_kg)); }
function validReport(data: CostReport) { return data && count(data.count) && typeof data.revision === 'string' && Array.isArray(data.rows) && data.rows.length <= 25 && data.rows.every(validRow) && (data.source === null || costUuid(data.source.import_id) && typeof data.source.file_name === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.source.reference_date)); }

interface ProductCostsCatalogProps {
  disabled?: boolean;
  initialImportId?: string | null;
  onSourceChange?: (source: CostSource | null) => void;
}

export default function ProductCostsCatalog({ disabled = false, initialImportId = null, onSourceChange }: ProductCostsCatalogProps) {
  const titleId = useId(), searchId = useId();
  const [history, setHistory] = useState<Awaited<ReturnType<typeof readCostHistory>>['rows']>([]), [historyCount, setHistoryCount] = useState(0);
  const [report, setReport] = useState<CostReport | null>(null), [selectedImport, setSelectedImport] = useState<string | null>(initialImportId);
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(0), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true), [readError, setReadError] = useState('');
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setReadError(''); setReport(null); onSourceChange?.(null);
    void Promise.all([readProductCosts(selectedImport, query, page * 25, abort.signal), readCostHistory(abort.signal)]).then(([data, imports]) => {
      if (abort.signal.aborted) return;
      if (!validReport(data) || !Array.isArray(imports.rows) || !count(imports.count) || imports.rows.some(item => !costUuid(item.id) || typeof item.file_name !== 'string')) throw new Error('invalid_cost_report');
      setReport(data); setHistory(imports.rows); setHistoryCount(imports.count); onSourceChange?.(data.source);
    }).catch(failure => { if (!abort.signal.aborted) setReadError(productCostError(failure, 'Não foi possível consultar a base de custos. Atualize para tentar novamente.')); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [selectedImport, query, page, refresh, onSourceChange]);
  const frozen = disabled;
  return (
  <section className="panel product-costs-catalog" aria-labelledby={titleId}><div className="panel-header"><div><h2 id={titleId}>Custos cadastrados e histórico</h2><p className="muted">Consulte cada versão pelo arquivo e pela data de referência.</p></div><button className="button secondary" disabled={loading || frozen} onClick={() => setRefresh(value => value+1)}>Atualizar custos cadastrados</button></div>
    {readError && <p className="notice error" role="alert">{readError}</p>}
    <div className="form-grid"><label className="field">Versão da base de custos<select aria-label="Versão da base de custos" value={selectedImport ?? ''} disabled={loading || frozen} onChange={event => { setSelectedImport(event.target.value || null); setPage(0); }}><option value="">Base mais recente por referência</option>{history.map(item => <option key={item.id} value={item.id}>{dateLabel(item.reference_date)} · {item.file_name} · {dateLabel(item.created_at)}</option>)}</select></label><form className="field" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(0); }}><label htmlFor={searchId}>Buscar código ou produto</label><div className="inline-actions"><input id={searchId} value={search} maxLength={500} disabled={frozen} onChange={event => setSearch(event.target.value)} /><button className="button secondary" disabled={loading || frozen}>Consultar custos</button></div></form></div>
    {historyCount > history.length && <p className="help-text">Mostrando as {history.length} versões mais recentes de {historyCount} importações.</p>}
    {loading ? <p role="status">Consultando custos…</p> : report && <><p className="help-text">{report.source ? `${report.source.file_name} · Referência ${dateLabel(report.source.reference_date)} · ${report.count.toLocaleString('pt-BR')} produto(s) no filtro.` : 'Nenhuma base de custos importada.'}</p><div className="table-wrap"><table><caption>Custos por item cadastrados</caption><thead><tr><th>Código</th><th>Produto</th><th>Peso informado</th><th>Custo unitário</th></tr></thead><tbody>{report.rows.length ? report.rows.map(row => <tr key={row.code}><td>{row.code}</td><td>{row.product}</td><td>{displayWeight(row.weight_kg)}</td><td>{displayUnitCost(row.unit_cost)}</td></tr>) : <tr><td colSpan={4}>Nenhum produto encontrado nesta base.</td></tr>}</tbody></table></div><div className="pagination"><span>Página {page+1} de {Math.max(1,Math.ceil(report.count/25))}</span><button className="button secondary" disabled={!page || frozen} onClick={() => setPage(value => value-1)}>Custos anteriores</button><button className="button secondary" disabled={(page+1)*25>=report.count || frozen} onClick={() => setPage(value => value+1)}>Próximos custos</button></div></>}
  </section>
  );
}
