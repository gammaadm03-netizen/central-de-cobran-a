import { useEffect, useRef, useState, type FormEvent } from 'react';
import { commercialImportRequest, commercialError } from '../lib/commercial';
import { formatCents } from '../lib/payables';
import { officialToday } from './Treasury';
import '../commercial.css';

interface PreviewItem { line_number?: number; code: string; product: string; invoice: string; branch: string; sale_cents: number; margin_cents: number | null }
interface Preview { rows: PreviewItem[]; preview: { row_count: number; sale_cents: number; margin_cents: number | null; margin_missing_count?: number; month: string; previous_import_id: string | null }; file_sha256: string }
interface Problem { line: number; column: string; problem: string; correction: string }
interface Analysis { data: Preview; fileName: string; base64: string; month: string }
const cash = (value: number | null) => value === null ? 'Não informado' : formatCents(value);
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
function problemsOf(error: unknown): Problem[] {
  const values = error && typeof error === 'object' && 'errors' in error ? error.errors : null;
  return Array.isArray(values) ? values.slice(0, 100).filter((value): value is Problem => !!value && Number.isSafeInteger(value.line) && typeof value.column === 'string' && typeof value.problem === 'string' && typeof value.correction === 'string').map(value => ({ line: value.line, column: value.column.slice(0, 300), problem: value.problem.slice(0, 600), correction: value.correction.slice(0, 600) })) : [];
}
function validPreview(data: Preview, month: string, hash: string) {
  const p = data?.preview;
  const structurallyValid = !!data && data.file_sha256 === hash && Array.isArray(data.rows) && data.rows.length > 0 && data.rows.length <= 5000 && !!p && p.row_count === data.rows.length && p.month === month && Number.isSafeInteger(p.sale_cents) && (p.margin_cents === null || Number.isSafeInteger(p.margin_cents)) && (p.previous_import_id === null || typeof p.previous_import_id === 'string' && uuid.test(p.previous_import_id)) && data.rows.every(row => typeof row.code === 'string' && typeof row.product === 'string' && typeof row.invoice === 'string' && typeof row.branch === 'string' && Number.isSafeInteger(row.sale_cents) && (row.margin_cents === null || Number.isSafeInteger(row.margin_cents)));
  if (!structurallyValid) return false;
  const saleTotal = data.rows.reduce((sum, row) => sum + BigInt(row.sale_cents), 0n);
  const missing = data.rows.filter(row => row.margin_cents === null).length;
  const marginTotal = data.rows.reduce((sum, row) => sum + BigInt(row.margin_cents ?? 0), 0n);
  return saleTotal === BigInt(p.sale_cents) && (missing ? p.margin_cents === null : p.margin_cents !== null && marginTotal === BigInt(p.margin_cents)) && (p.margin_missing_count === undefined || p.margin_missing_count === missing);
}

export default function CommercialImport({ canImport }: { canImport: boolean }) {
  const [file, setFile] = useState<File | null>(null), [month, setMonth] = useState(() => officialToday().slice(0, 7));
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState(''), [problems, setProblems] = useState<Problem[]>([]);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  function reset() { generation.current++; controller.current?.abort(); setAnalysis(null); setReviewed(false); setError(''); setProblems([]); setSuccess(''); }
  async function analyze(event: FormEvent) {
    event.preventDefault(); if (!canImport || !file || busy) return;
    const current = ++generation.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy('preview'); setError(''); setSuccess(''); setProblems([]); setAnalysis(null); setReviewed(false);
    try {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1900-01' || month > '2199-12') throw new Error('Selecione um mês válido para o fechamento.');
      if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('Selecione uma planilha não vazia de até 2 MiB.');
      if (!/\.(xlsx|xlsm|csv)$/i.test(file.name)) throw new Error('Selecione .xlsx, .xlsm ou .csv. Para arquivos .xls, salve uma cópia como .xlsx.');
      const original = await file.arrayBuffer(); if (abort.signal.aborted) return;
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', original))).map(value => value.toString(16).padStart(2, '0')).join('');
      let binary = ''; const bytes = new Uint8Array(original); for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const base64 = btoa(binary), selectedMonth = `${month}-01`;
      const data = await commercialImportRequest<Preview>({ action: 'preview', mode: 'commercial', month: selectedMonth, file_name: file.name, file_base64: base64 }, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      if (!validPreview(data, selectedMonth, hash)) throw new Error('Não foi possível conferir a análise da planilha. Tente novamente.');
      setAnalysis({ data, fileName: file.name, base64, month: selectedMonth }); setUncertain(false);
    } catch (failure) { if (current === generation.current && !abort.signal.aborted) { const errors = problemsOf(failure); setProblems(errors); setError(errors.length ? 'Corrija as linhas indicadas e analise a planilha novamente.' : commercialError(failure, failure instanceof Error ? failure.message : 'Não foi possível analisar o fechamento. Nenhum dado foi alterado.')); } }
    finally { if (current === generation.current) setBusy(null); }
  }
  async function commit() {
    if (!canImport || !analysis || !reviewed || busy || uncertain) return;
    const current = generation.current, p = analysis.data.preview; setBusy('commit'); setError(''); setSuccess('');
    try {
      const result = await commercialImportRequest<{ import_id: string; row_count: number; month: string; idempotent?: boolean }>({ action: 'commit', mode: 'commercial', month: analysis.month, file_name: analysis.fileName, file_base64: analysis.base64, previous_import_id: p.previous_import_id, complete: true });
      if (current !== generation.current) return;
      if (!result || !uuid.test(result.import_id) || result.row_count !== p.row_count || result.month !== analysis.month) throw new Error('unconfirmed_import');
      setSuccess(`${result.idempotent ? 'Arquivo já conferido' : 'Fechamento importado'}: ${result.row_count.toLocaleString('pt-BR')} itens em ${analysis.month.slice(0, 7).split('-').reverse().join('/')}. Faturamento e Margens consultam a mesma base do mês.`);
      setAnalysis(null); setFile(null); setReviewed(false); setUncertain(false); if (input.current) input.current.value = '';
    } catch (failure) { if (current === generation.current) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      const known = ['40001', '23505', '23514', '22023', '42501', 'PGRST202', 'PGRST205', 'PGRST301', 'PGRST303', 'P0032'].includes(code);
      if (known) { setAnalysis(null); setReviewed(false); }
      else { setUncertain(true); setReviewed(false); }
      setError(commercialError(failure, known ? 'O fechamento não foi importado. Confira o arquivo e analise novamente.' : 'A confirmação do envio não chegou. Mantenha este arquivo e clique em Conferir novamente para verificar o fechamento antes de reenviar.'));
    } } finally { if (current === generation.current) setBusy(null); }
  }
  if (!canImport) return <p className="notice">Seu perfil não permite importar fechamentos de Faturamento e Margens.</p>;
  const p = analysis?.data.preview;
  return <section className="panel commercial-import" aria-labelledby="commercial-import-title"><div className="panel-header"><div><h2 id="commercial-import-title">Faturamento e Margens</h2><p className="muted">Uma planilha de fechamento alimenta as duas abas, com os itens, as notas fiscais e os custos disponíveis.</p></div><span className="badge">Fechamento mensal</span></div>
    <p className="notice">Selecione o mês e envie o relatório completo desse fechamento. Uma nova importação atualiza a posição desse mês e preserva os arquivos anteriores no histórico. Outros meses permanecem disponíveis para consulta.</p>
    <details className="commercial-header-help"><summary>Como preparar o relatório</summary><p>Inclua os cabeçalhos Produto, Venda total, Emissão, Cliente e Filial na primeira linha. Código, Nota fiscal, Funcionário comissionado e Centro de custo permitem os filtros e o detalhamento.</p><p>Para Margens, inclua Margem líquida final R$ ou todos os componentes: CMV total, Imposto total, Frete total e Comissão total. Sem essas informações, a margem aparece como não informada. Todos os itens devem ter emissão dentro do mês selecionado. Salve uma cópia somente com valores, sem fórmulas.</p></details>
    <form className="form-grid" onSubmit={analyze}><label className="field">Mês da base de faturamento<input type="month" min="1900-01" max="2199-12" required disabled={!!busy || uncertain} value={month} onChange={event => { reset(); setMonth(event.target.value); }} /></label><label className="field">Planilha de faturamento e margens<input ref={input} type="file" accept=".xlsx,.xlsm,.csv" disabled={!!busy || uncertain} required onChange={event => { reset(); setFile(event.target.files?.[0] ?? null); }} /><small>Arquivo completo do mês, até 2 MiB e 5.000 itens.</small></label><div className="full inline-actions"><button className="button secondary" disabled={!!busy || !file}>{busy === 'preview' ? 'Analisando fechamento…' : uncertain ? 'Conferir novamente' : 'Analisar fechamento'}</button></div></form>
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {!!problems.length && <div className="table-wrap commercial-problems"><table><caption>Linhas do fechamento que precisam de correção</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.map((item, index) => <tr key={index}><td>{item.line || 'Arquivo'}</td><td>{item.column}</td><td>{item.problem}</td><td>{item.correction}</td></tr>)}</tbody></table></div>}
    {analysis && p && <><h3>Conferência do fechamento · {analysis.month.slice(0, 7).split('-').reverse().join('/')}</h3><p className="commercial-source">Arquivo: {analysis.fileName}</p><div className="commercial-cards"><article><h3>Itens no relatório</h3><strong>{p.row_count.toLocaleString('pt-BR')}</strong></article><article><h3>Faturamento informado</h3><strong>{formatCents(p.sale_cents)}</strong></article><article><h3>Margem final</h3><strong>{cash(p.margin_cents)}</strong><small>{p.margin_cents === null ? 'Faltam informações de margem ou custos em um ou mais itens.' : 'Informada no fechamento ou calculada dos custos disponíveis.'}</small></article></div>
    <div className="table-wrap"><table><caption>Amostra dos primeiros itens do fechamento</caption><thead><tr><th>Código</th><th>Produto</th><th>Filial</th><th>NF</th><th>Venda</th><th>Margem final</th></tr></thead><tbody>{analysis.data.rows.slice(0, 10).map((row, index) => <tr key={index}><td>{row.code || '—'}</td><td>{row.product}</td><td>{row.branch || 'Não informada'}</td><td>{row.invoice || 'Não informada'}</td><td>{formatCents(row.sale_cents)}</td><td>{cash(row.margin_cents)}</td></tr>)}</tbody></table></div><p className="help-text">Prévia dos primeiros {Math.min(10, p.row_count)} de {p.row_count.toLocaleString('pt-BR')} itens. A confirmação importa todos os itens analisados.</p>
    <label className="commercial-import-check"><input type="checkbox" checked={reviewed} disabled={!!busy || uncertain} onChange={event => setReviewed(event.target.checked)} />Conferi o mês e os totais. Este é o relatório completo do fechamento e deve atualizar a posição desse mês.</label><button className="button" disabled={!reviewed || !!busy || uncertain} onClick={() => void commit()}>{busy === 'commit' ? 'Importando fechamento…' : 'Confirmar importação do fechamento'}</button></>}
  </section>;
}
