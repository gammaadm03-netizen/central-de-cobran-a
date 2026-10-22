import { useEffect, useRef, useState, type FormEvent } from 'react';
import { officialToday } from './Treasury';
import { dateLabel, type ImportProblem } from '../lib/payables';
import { costDecimal, costUuid, displayUnitCost, displayWeight, productCostError, productCostRequest, type CostAnalysis, type CostImportBody, type CostSource, type ProductCostRow } from '../lib/product-costs';
import CostClosingApplication from './CostClosingApplication';
import ProductCostsCatalog from './ProductCostsCatalog';
import '../commercial.css';
import '../product-costs.css';

const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function validRow(row: ProductCostRow) { return row && typeof row.code === 'string' && !!row.code && typeof row.product === 'string' && count(row.line_number) && (row.unit_cost === null || costDecimal(row.unit_cost)) && (row.weight_kg === null || costDecimal(row.weight_kg)); }
function validAnalysis(data: CostAnalysis, hash: string, date: string) {
  const p = data?.preview;
  return data?.format_version === 'costs-v1' && data.file_sha256 === hash && !!p && p.reference_date === date && (p.previous_import_id === null || costUuid(p.previous_import_id))
    && [p.row_count, p.item_count, p.new_count, p.changed_count, p.unchanged_count, p.zero_cost_count, p.missing_cost_count, p.missing_weight_count].every(count)
    && p.row_count > 0 && p.row_count <= 5000 && p.item_count > 0 && p.item_count <= p.row_count && Array.isArray(data.rows) && data.rows.length === p.item_count
    && data.rows.every(validRow) && new Set(data.rows.map(row => row.code)).size === data.rows.length && typeof p.can_commit === 'boolean'
    && Array.isArray(p.conflicts) && p.conflicts.every(item => typeof item.code === 'string' && typeof item.product === 'string' && Array.isArray(item.options) && item.options.length > 1 && item.options.every(option => count(option.line_number) && option.line_number > 1 && (option.unit_cost === null || costDecimal(option.unit_cost)) && (option.weight_kg === null || costDecimal(option.weight_kg))));
}
function failureCode(error: unknown) { return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''; }

export default function CostsImport({ canImport, canApply }: { canImport: boolean; canApply: boolean }) {
  const [file, setFile] = useState<File | null>(null), [referenceDate, setReferenceDate] = useState(officialToday);
  const [prepared, setPrepared] = useState<{ analysis: CostAnalysis; body: CostImportBody } | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, number>>({}), [dirty, setDirty] = useState(false), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null), [pending, setPending] = useState<CostImportBody | null>(null);
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [problems, setProblems] = useState<ImportProblem[]>([]);
  const [applicationBusy, setApplicationBusy] = useState(false);
  const [costSource, setCostSource] = useState<CostSource | null>(null), [selectedImport, setSelectedImport] = useState<string | null>(null), [catalogRefresh, setCatalogRefresh] = useState(0);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => { if (!pending && busy !== 'commit') return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [pending, busy]);
  function reset() { generation.current++; controller.current?.abort(); setPrepared(null); setResolutions({}); setDirty(false); setReviewed(false); setError(''); setSuccess(''); setProblems([]); }
  async function analyze(event?: FormEvent) {
    event?.preventDefault(); if (!canImport || !file || busy || pending || applicationBusy) return;
    const current = ++generation.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy('preview'); setError(''); setSuccess(''); setProblems([]); setReviewed(false); setDirty(true);
    try {
      if (!file.size || file.size > 2 * 1024 * 1024 || !/\.(xlsx|xlsm|csv)$/i.test(file.name)) throw new Error('Selecione uma planilha .xlsx, .xlsm ou .csv de até 2 MiB.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate) || referenceDate < '1900-01-01' || referenceDate > officialToday()) throw new Error('Informe a data de referência dos custos até hoje.');
      const original = await file.arrayBuffer(); if (abort.signal.aborted) return;
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', original))].map(value => value.toString(16).padStart(2, '0')).join('');
      let binary = ''; const bytes = new Uint8Array(original); for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const body: CostImportBody = { action: 'preview', mode: 'costs', reference_date: referenceDate, file_name: file.name, file_base64: btoa(binary), resolutions: { ...resolutions } };
      const data = await productCostRequest<CostAnalysis>(body, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      if (data?.format_version !== 'costs-v1') throw { code: 'P0044' };
      if (!validAnalysis(data, hash, referenceDate)) throw new Error('Não foi possível conferir a análise dos custos. O arquivo e as escolhas foram preservados.');
      setPrepared({ analysis: data, body }); setDirty(false);
    } catch (failure) { if (current === generation.current && !abort.signal.aborted) {
      const issues = failure && typeof failure === 'object' && 'errors' in failure && Array.isArray(failure.errors) ? failure.errors.filter((item: ImportProblem) => count(item?.line) && typeof item.column === 'string' && typeof item.problem === 'string').slice(0,100) : [];
      setProblems(issues); setError(productCostError(failure, issues.length ? 'Confira as linhas indicadas e analise novamente.' : failure instanceof Error ? failure.message : 'Não foi possível analisar os custos. O arquivo e as escolhas foram preservados.'));
    } } finally { if (current === generation.current) setBusy(null); }
  }
  async function execute(body: CostImportBody) {
    if (busy) return; const current = generation.current; setBusy('commit'); setError('');
    try {
      const result = await productCostRequest<{ format_version: string; import_id: string; reference_date: string; row_count: number; item_count: number; idempotent?: boolean }>(body);
      if (current !== generation.current) return;
      if (!costUuid(result?.import_id) || result.reference_date !== body.reference_date || result.row_count !== prepared?.analysis.preview.row_count || result.item_count !== prepared?.analysis.preview.item_count) throw new Error('unconfirmed_cost_import');
      setSuccess(`${result.idempotent ? 'Esta base já estava registrada' : 'Base de custos importada'}: ${result.item_count.toLocaleString('pt-BR')} produtos, referência ${dateLabel(result.reference_date)}. O histórico foi preservado. Selecione o mês abaixo para aplicar os custos ao fechamento.`);
      setPending(null); setPrepared(null); setFile(null); setResolutions({}); setReviewed(false); setDirty(false); setSelectedImport(result.import_id); setCatalogRefresh(value => value + 1); if (input.current) input.current.value = '';
    } catch (failure) { if (current === generation.current) {
      if (['40001','22023','22007','22003','23514','42501','P0044','PGRST202','PGRST301','PGRST303'].includes(failureCode(failure))) { setPending(null); setDirty(true); setReviewed(false); }
      else setPending(body);
      setError(productCostError(failure, 'A confirmação não chegou. O mesmo arquivo, referência e escolhas estão preservados. Repita a confirmação pendente para conferir esse envio.'));
    } } finally { if (current === generation.current) setBusy(null); }
  }
  const frozen = !!busy || !!pending || applicationBusy, p = prepared?.analysis.preview;
  if (!canImport) return <p className="notice">Seu perfil não permite importar custos.</p>;
  return <div className="stack product-costs"><section className="panel" aria-labelledby="cost-import-title"><div className="panel-header"><div><h2 id="cost-import-title">Importar custos por item</h2><p className="muted">Custo atual de cada produto para o CMV e a análise do fechamento.</p></div><span className="badge">Base de Custos</span></div>
    <p className="notice">A planilha identifica os produtos pelo código. Custos unitários mantêm até seis casas decimais; o CMV é calculado pela quantidade de cada item do fechamento.</p>
    <p className="help-text">Cabeçalhos: Produto: código, Produto: nome, peso e custo atual. Peso é uma informação do cadastro, sem unidade declarada; não substitui a quantidade vendida. Até 2 MiB, 5.000 linhas e uma aba preenchida.</p>
    <form className="form-grid" onSubmit={event => void analyze(event)}><label className="field">Data de referência dos custos<input type="date" min="1900-01-01" max={officialToday()} value={referenceDate} disabled={frozen} required onChange={event => { reset(); setReferenceDate(event.target.value); }} /></label><label className="field">Planilha de custos por item<input ref={input} type="file" accept=".xlsx,.xlsm,.csv" disabled={frozen} required onChange={event => { reset(); setFile(event.target.files?.[0] ?? null); }} /></label><div className="full inline-actions"><button className="button secondary" disabled={!file || frozen}>{busy === 'preview' ? 'Analisando custos…' : 'Analisar custos'}</button></div></form>
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {pending && <div className="notice"><p>A confirmação está pendente. Mantenha esta tela e confira o mesmo envio antes de iniciar outra importação.</p><button className="button secondary" disabled={!!busy} onClick={() => void execute(pending)}>Repetir confirmação pendente dos custos</button></div>}
    {!!problems.length && <div className="table-wrap"><table><caption>Problemas na planilha de custos</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th></tr></thead><tbody>{problems.map((problem,index) => <tr key={index}><td>{problem.line || 'Arquivo'}</td><td>{problem.column}</td><td>{problem.problem}</td></tr>)}</tbody></table></div>}
    {prepared && p && <div className="stack"><h3>Conferência dos custos</h3><div className="commercial-cards"><article><h3>Produtos distintos</h3><strong>{p.item_count.toLocaleString('pt-BR')}</strong><small>{p.row_count.toLocaleString('pt-BR')} linhas no arquivo</small></article><article><h3>Ocorrências repetidas</h3><strong>{(p.row_count-p.item_count).toLocaleString('pt-BR')}</strong><small>Um custo escolhido por código</small></article><article><h3>Custos zerados</h3><strong>{p.zero_cost_count.toLocaleString('pt-BR')}</strong><small>Exigem conferência para o fechamento</small></article><article><h3>Custos não informados</h3><strong>{p.missing_cost_count.toLocaleString('pt-BR')}</strong><small>Continuam sem valor conhecido</small></article></div>
      {p.conflicts.length > 0 && <div className="stack"><h3>Códigos com custos divergentes</h3><p className="notice">Escolha a linha que contém o custo correto de cada produto e valide as escolhas. Nenhum custo divergente é escolhido automaticamente.</p>{p.conflicts.map(item => <label className="field" key={item.code}>Custo para o código {item.code}<span>{item.product}</span><select aria-label={`Custo para o código ${item.code}`} value={resolutions[item.code] ?? ''} disabled={frozen} onChange={event => { const line = event.target.value; setResolutions(previous => { const next = { ...previous }; if (line) next[item.code] = Number(line); else delete next[item.code]; return next; }); setDirty(true); setReviewed(false); }}><option value="">Selecione o custo correto</option>{item.options.map(option => <option key={option.line_number} value={option.line_number}>Linha {option.line_number} · {displayUnitCost(option.unit_cost)} · Peso {displayWeight(option.weight_kg)}</option>)}</select></label>)}</div>}
      {dirty && <p className="notice" role="status">Escolhas alteradas. Valide novamente antes de confirmar a importação.</p>}
      <div className="table-wrap"><table><caption>Amostra dos custos por produto</caption><thead><tr><th>Código</th><th>Produto</th><th>Peso informado</th><th>Custo unitário</th><th>Linha de origem</th></tr></thead><tbody>{prepared.analysis.rows.slice(0,10).map(row => <tr key={row.code}><td>{row.code}</td><td>{row.product}</td><td>{displayWeight(row.weight_kg)}</td><td>{displayUnitCost(row.unit_cost)}</td><td>{row.line_number}</td></tr>)}</tbody></table></div>
      <button type="button" className="button secondary" disabled={frozen} onClick={() => void analyze()}>Validar escolhas dos custos</button>
      <label className="commercial-import-check"><input type="checkbox" disabled={frozen || dirty || !p.can_commit} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />Conferi os custos, os valores zerados e as escolhas dos códigos repetidos.</label>
      <button className="button" disabled={frozen || dirty || !reviewed || !p.can_commit} onClick={() => void execute({ ...prepared.body, action: 'commit', previous_import_id: p.previous_import_id, complete: true, resolutions: { ...prepared.body.resolutions } })}>{busy === 'commit' ? 'Importando custos…' : 'Confirmar importação dos custos'}</button>
    </div>}
  </section>
  <ProductCostsCatalog key={catalogRefresh} initialImportId={selectedImport} disabled={frozen} onSourceChange={setCostSource} />
  {canApply && costSource && <CostClosingApplication costSource={costSource} disabled={!!busy || !!pending} onBusyChange={setApplicationBusy} />}
  </div>;
}
