import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { analyzeReceivableFile, analyzeReceivableReceivedFile, dateLabel, formatCents, RECEIVABLE_SCOPE, receivableError, receivableImportRequest, type ImportProblem, type ReceivableImportRow } from '../lib/receivables';

type Mode = 'open' | 'received';
interface Batch { id: string; file_name: string; created_at: string; row_count: number; new_count: number; open_count: number; pending_count: number; validated_in_source_count: number; import_mode?: string }
interface Candidate { id: string; due_date: string; amount_cents: number; status: string; collector_id: string | null }
interface Collector { id: string; display_name: string; enabled: boolean }
interface Assignment { customer_key: string; client_name: string; client_document: string | null; collector_id: string | null; collector_name: string | null; row_count: number; requires_selection: boolean; locked: boolean }
interface PreviewRow extends ReceivableImportRow { line: number; title_id?: string | null; outcome: string; identity_outcome?: string; candidates?: Candidate[]; received_on?: string; received_amount_cents?: number }
interface Preview {
  mode: Mode; previous_import_id: string | null; financial_revision: string; row_count: number;
  new_count: number; open_count?: number; changed_count?: number; pending_count?: number; validated_in_source_count?: number;
  received_count?: number; matched_count?: number; correction_count?: number; historical_count?: number;
  conflict_count: number; can_commit: boolean; errors?: ImportProblem[];
  collector_assignment_version?: string; customer_collector_assignments?: Assignment[]; missing_collector_count?: number;
}
interface Analysis { file: File; mode: Mode; base64: string; rows: PreviewRow[]; preview: Preview; nominalTotal: number; receivedTotal: number }
interface ServerPreview { rows: PreviewRow[]; preview: Preview; file_sha256: string }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const countFields = ['new_count', 'open_count', 'changed_count', 'pending_count', 'validated_in_source_count', 'received_count', 'matched_count', 'correction_count', 'historical_count', 'conflict_count'] as const;
const outcomes: Record<string, string> = { NEW: 'Nova parcela', UPDATE: 'Atualizar título', MATCHED: 'Já identificado', AMBIGUOUS: 'Escolher vínculo da parcela', CONFLICT: 'Conflito a conferir', NEW_RECEIPT: 'Confirmar recebimento', CORRECTION: 'Corrigir recebimento importado', HISTORICAL: 'Incluir quitado do histórico' };
function ambiguous(row: PreviewRow) { return row.outcome === 'AMBIGUOUS' || row.identity_outcome === 'AMBIGUOUS'; }
function safeProblems(value: unknown): ImportProblem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).filter((item): item is ImportProblem => item && Number.isSafeInteger(item.line) && typeof item.column === 'string' && typeof item.problem === 'string' && typeof item.correction === 'string').map(item => ({ line: item.line, column: item.column.slice(0, 300), problem: item.problem.slice(0, 700), correction: item.correction.slice(0, 700) }));
}
function validatePreview(value: ServerPreview, mode: Mode, hash: string) {
  const preview = value?.preview;
  if (!value || value.file_sha256 !== hash || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 5000
    || !preview || preview.mode !== mode || preview.row_count !== value.rows.length || typeof preview.can_commit !== 'boolean'
    || typeof preview.financial_revision !== 'string' || !preview.financial_revision.length || preview.financial_revision.length > 256
    || !(preview.previous_import_id === null || typeof preview.previous_import_id === 'string' && uuid.test(preview.previous_import_id))
    || !Number.isSafeInteger(preview.new_count) || preview.new_count < 0 || !Number.isSafeInteger(preview.conflict_count) || preview.conflict_count < 0
    || countFields.some(key => preview[key] !== undefined && (!Number.isSafeInteger(preview[key]) || preview[key]! < 0))) throw new Error('Resposta de análise inválida.');
  let nominalTotal = 0, receivedTotal = 0;
  if (mode === 'open') {
    const groups = preview.customer_collector_assignments;
    if (preview.collector_assignment_version !== '030') throw { code: 'P0030', activation_required: true };
    if (!Array.isArray(groups) || groups.length > 5000 || !Number.isSafeInteger(preview.missing_collector_count) || preview.missing_collector_count! < 0) throw new Error('Carteiras oficiais inválidas.');
    const keys = new Set<string>();
    for (const item of groups) {
      if (!item || typeof item.customer_key !== 'string' || !/^(name:|cnpj:)/.test(item.customer_key) || item.customer_key.length > 1505 || /[\u0000-\u001f\u007f]/.test(item.customer_key) || keys.has(item.customer_key)
        || typeof item.client_name !== 'string' || !(item.client_document === null || typeof item.client_document === 'string')
        || !(item.collector_id === null || typeof item.collector_id === 'string' && uuid.test(item.collector_id)) || !(item.collector_name === null || typeof item.collector_name === 'string')
        || !Number.isSafeInteger(item.row_count) || item.row_count < 1 || item.row_count > value.rows.length || typeof item.requires_selection !== 'boolean' || typeof item.locked !== 'boolean') throw new Error('Carteiras oficiais inválidas. Analise novamente antes de importar.');
      keys.add(item.customer_key);
    }
    if (preview.missing_collector_count !== groups.filter(item => item.requires_selection && !item.collector_id).length || preview.can_commit && preview.missing_collector_count! > 0) throw new Error('Conferência de responsáveis inválida.');
  }
  const lines = new Set<number>();
  for (const row of value.rows) {
    if (!Number.isSafeInteger(row.line) || row.line < 1 || row.line > value.rows.length || lines.has(row.line)
      || !Number.isSafeInteger(row.amount_cents) || row.amount_cents < 0 || typeof row.document !== 'string' || typeof row.client_name !== 'string'
      || typeof row.branch !== 'string' || typeof row.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.due_date)
      || typeof row.outcome !== 'string' || !Object.hasOwn(outcomes, row.outcome)) throw new Error('Linhas oficiais inválidas.');
    lines.add(row.line); nominalTotal += row.amount_cents;
    if (mode === 'received') {
      if (!Number.isSafeInteger(row.received_amount_cents) || row.received_amount_cents! <= 0 || typeof row.received_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.received_on)) throw new Error('Recebimento oficial inválido.');
      receivedTotal += row.received_amount_cents!;
    }
    if (!Number.isSafeInteger(nominalTotal) || !Number.isSafeInteger(receivedTotal)) throw new Error('Total excede o limite seguro.');
    if (row.candidates !== undefined && (!Array.isArray(row.candidates) || row.candidates.some(item => !uuid.test(item.id) || typeof item.due_date !== 'string' || !Number.isSafeInteger(item.amount_cents) || item.amount_cents < 0))) throw new Error('Vínculos oficiais inválidos.');
  }
  return { nominalTotal, receivedTotal };
}

export default function ReceivablesImport({ canImport }: { canImport: boolean }) {
  const [mode, setMode] = useState<Mode>('open'), [file, setFile] = useState<File | null>(null), [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState<'analyzing' | 'saving' | null>(null), [uncertain, setUncertain] = useState(false);
  const [reviewCollectors, setReviewCollectors] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [mappings, setMappings] = useState<Record<string, string>>({}), [mappingsDirty, setMappingsDirty] = useState(false);
  const [collectorMappings, setCollectorMappings] = useState<Record<string, string>>({}), [collectors, setCollectors] = useState<Collector[]>([]);
  const [collectorsLoading, setCollectorsLoading] = useState(false), [collectorsError, setCollectorsError] = useState('');
  const [bulkCollector, setBulkCollector] = useState(''), [customerSearch, setCustomerSearch] = useState(''), [customerPage, setCustomerPage] = useState(1);
  const [problems, setProblems] = useState<ImportProblem[]>([]), [history, setHistory] = useState<Batch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true), [historyError, setHistoryError] = useState('');
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [refresh, setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null), generation = useRef(0), inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    if (!supabase || !canImport || mode !== 'open') return;
    const abort = new AbortController(); let active = true;
    setCollectorsLoading(true); setCollectorsError('');
    void Promise.resolve(supabase.from('collection_agents').select('id,display_name,enabled').eq('enabled', true).order('display_name').abortSignal(abort.signal)).then(result => {
      if (!active) return;
      if (result.error || !Array.isArray(result.data) || result.data.some(item => !uuid.test(item.id) || typeof item.display_name !== 'string' || item.enabled !== true)) { setCollectors([]); setCollectorsError('Não foi possível consultar as cobradoras. Atualize o histórico para tentar novamente.'); return; }
      setCollectors(result.data as Collector[]);
    }).catch(() => { if (active) { setCollectors([]); setCollectorsError('Não foi possível consultar as cobradoras. Atualize o histórico para tentar novamente.'); } }).finally(() => { if (active) setCollectorsLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [canImport, mode, refresh]);
  useEffect(() => {
    if (!supabase || !canImport) { setHistoryLoading(false); return; }
    const client = supabase, abort = new AbortController(); let active = true;
    setHistoryLoading(true); setHistoryError('');
    const read = async () => {
      const fields = 'id,file_name,created_at,row_count,new_count,open_count,pending_count,validated_in_source_count';
      const result = await client.from('receivable_imports').select(`${fields},import_mode`).eq('scope', RECEIVABLE_SCOPE).order('created_at', { ascending: false }).limit(20).abortSignal(abort.signal);
      if (!result.error || !['42703', 'PGRST204'].includes(result.error.code)) return result;
      return client.from('receivable_imports').select(fields).eq('scope', RECEIVABLE_SCOPE).order('created_at', { ascending: false }).limit(20).abortSignal(abort.signal);
    };
    void read().then(result => {
      if (!active) return;
      if (result.error) { setHistoryError(receivableError(result.error, 'Não foi possível carregar o histórico de importações.')); return; }
      setHistory((result.data ?? []) as unknown as Batch[]);
    }).catch(() => { if (active) setHistoryError('Não foi possível carregar o histórico de importações. Tente atualizar novamente.'); }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [canImport, refresh]);
  function resetAnalysis() { generation.current++; controller.current?.abort(); setAnalysis(null); setProblems([]); setError(''); setSuccess(''); setBusy(null); }
  function changeMode(next: Mode) {
    if (busy || uncertain || next === mode) return;
    resetAnalysis(); setMode(next); setFile(null); setComplete(false); setMappings({}); setCollectorMappings({}); setBulkCollector(''); setCustomerSearch(''); setCustomerPage(1); setMappingsDirty(false); if (inputRef.current) inputRef.current.value = '';
  }
  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !file || !complete || !canImport || busy) return;
    const current = ++generation.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy('analyzing'); setProblems([]); setError(''); setSuccess('');
    try {
      const parsed = mode === 'received' ? await analyzeReceivableReceivedFile(file, abort.signal) : await analyzeReceivableFile(file, abort.signal);
      if (current !== generation.current) return;
      if (parsed.errors.length) { setAnalysis(null); setProblems(parsed.errors); return; }
      let canonical: ServerPreview, recoveredCollectors = false;
      try {
        canonical = await receivableImportRequest<ServerPreview>({ action: 'preview', mode, file_name: file.name, file_base64: parsed.base64, title_mappings: mappings, ...(mode === 'open' ? { collector_mappings: collectorMappings } : {}) }, abort.signal);
      } catch (failure) {
        const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
        if (!uncertain || mode !== 'open' || !['23514', 'P0030'].includes(code)) throw failure;
        // A receipt or an official assignment can supersede choices after a lost
        // commit response. Re-read the same original without choices; this call
        // cannot change finance. File/mode/parcel mappings remain frozen.
        canonical = await receivableImportRequest<ServerPreview>({ action: 'preview', mode, file_name: file.name, file_base64: parsed.base64, title_mappings: mappings, collector_mappings: {} }, abort.signal);
        validatePreview(canonical, mode, parsed.hash);
        if (current !== generation.current) return;
        setCollectorMappings({}); setBulkCollector(''); setReviewCollectors(true); recoveredCollectors = true; setRefresh(value => value + 1);
        setError('A carteira mudou durante a confirmação pendente. Consulte os vínculos atuais abaixo e, se necessário, escolha as responsáveis ausentes. O mesmo arquivo foi preservado; nenhum recebimento foi alterado por esta consulta.');
      }
      if (current !== generation.current) return;
      const totals = validatePreview(canonical, mode, parsed.hash);
      setAnalysis({ file, mode, base64: parsed.base64, rows: canonical.rows, preview: canonical.preview, ...totals });
      // SQL preview identifies each financial item from 1; the header occupies
      // Excel row 1. Parser and HTTP 422 errors already use physical rows.
      setProblems(safeProblems(canonical.preview.errors).map(problem => ({ ...problem, line: problem.line > 0 ? problem.line + 1 : problem.line }))); setMappingsDirty(recoveredCollectors);
    } catch (failure) { if (current === generation.current && !abort.signal.aborted) {
      setAnalysis(null);
      const details = safeProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : null);
      if (details.length) setProblems(details); else setError(receivableError(failure, 'Não foi possível concluir a análise. Nenhum dado foi alterado.'));
    } } finally { if (current === generation.current) setBusy(null); }
  }
  async function commit() {
    if (!analysis || !complete || !canImport || busy || mappingsDirty || !analysis.preview.can_commit || problems.length) return;
    const p = analysis.preview, corrections = p.correction_count ?? 0;
    const message = analysis.mode === 'received'
      ? `Confirmar o relatório de TÍTULOS QUITADOS?\n\n${p.row_count} títulos; recebido efetivo ${formatCents(analysis.receivedTotal)}.\n${p.new_count} novos títulos; ${p.matched_count ?? 0} recebimentos já registrados; ${corrections} correções de recebimentos importados; ${p.historical_count ?? 0} quitados do histórico.\n\nOs recebimentos conferidos pelo arquivo sairão da carteira ativa e alimentarão a base de apuração de comissões. Correções preservam os registros anteriores. Esta importação não paga comissões.`
      : `Confirmar o relatório de ABERTOS E VENCIDOS?\n\n${p.row_count} títulos; ${p.new_count} novas parcelas; ${p.changed_count ?? 0} alterações em títulos existentes.\n\nAs carteiras e o histórico serão preservados. Títulos ausentes neste arquivo continuarão como estão. Nenhum recebimento será confirmado por esta importação.`;
    if (!window.confirm(message)) return;
    setBusy('saving'); setError(''); setSuccess(''); const current = generation.current;
    try {
      const summary = await receivableImportRequest<{ import_id: string; row_count: number }>({ action: 'commit', mode: analysis.mode, file_name: analysis.file.name, file_base64: analysis.base64, complete: true, title_mappings: mappings, previous_import_id: p.previous_import_id, previous_financial_revision: p.financial_revision, ...(analysis.mode === 'received' ? { confirm_corrections: corrections > 0 } : { collector_mappings: collectorMappings }) });
      if (current !== generation.current) return;
      if (!summary || typeof summary.import_id !== 'string' || !uuid.test(summary.import_id) || summary.row_count !== p.row_count) throw new Error('Resposta de importação não confirmada.');
      setSuccess(analysis.mode === 'received' ? `Importação concluída: ${summary.row_count} títulos quitados conferidos. Recebimentos disponíveis no resumo e na base de apuração de comissões; títulos validados fora da carteira ativa.` : `Importação concluída: ${summary.row_count} títulos conferidos. Ausências preservadas. Nenhum recebimento foi confirmado por esta importação.`);
      setUncertain(false); setReviewCollectors(false); setAnalysis(null); setComplete(false); setFile(null); setMappings({}); setCollectorMappings({}); setBulkCollector(''); setCustomerSearch(''); setCustomerPage(1); setMappingsDirty(false); setProblems([]); setRefresh(value => value + 1); if (inputRef.current) inputRef.current.value = '';
    } catch (failure) { if (current === generation.current) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      const known = ['40001', '23505', '23514', '22023', '42501', 'P0023', 'P0024', 'P0030', 'PGRST301', 'PGRST303'].includes(code);
      setUncertain(!known); setReviewCollectors(false);
      setError(receivableError(failure, 'A confirmação do envio não chegou. Mantenha este arquivo e confira novamente antes de repetir a importação.'));
      if (known) setAnalysis(null); else setMappingsDirty(true);
      setRefresh(value => value + 1);
    } } finally { if (current === generation.current) setBusy(null); }
  }
  function mapTitle(line: number, title: string) {
    if (busy || uncertain) return;
    setMappings(previous => { const next = { ...previous }; if (title) next[String(line)] = title; else delete next[String(line)]; return next; }); setMappingsDirty(true); setError('');
  }
  function mapCollector(key: string, id: string) {
    if (busy || uncertain && !reviewCollectors || !analysis?.preview.customer_collector_assignments?.some(item => item.customer_key === key && item.requires_selection && !item.locked) || id && !collectors.some(item => item.id === id)) return;
    setCollectorMappings(previous => { const next = { ...previous }; if (id) next[key] = id; else delete next[key]; return next; }); setMappingsDirty(true); setError('');
  }
  if (!canImport) return <p className="notice">Seu perfil não permite importar bases de Contas a Receber.</p>;
  const mappingRows = analysis?.rows.filter(row => ambiguous(row) || Object.hasOwn(mappings, String(row.line))) ?? [];
  const unresolved = mappingRows.filter(row => ambiguous(row) && !mappings[String(row.line)]);
  const assignments = analysis?.preview.customer_collector_assignments ?? [];
  const filteredCustomers = assignments.filter(item => `${item.client_name} ${item.client_document ?? ''}`.toLocaleLowerCase('pt-BR').includes(customerSearch.toLocaleLowerCase('pt-BR')));
  const pages = Math.max(1, Math.ceil(filteredCustomers.length / 20)), currentPage = Math.min(customerPage, pages);
  return <>
    <section className="panel" aria-labelledby="receivable-import-title">
      <div className="panel-header"><div><h2 id="receivable-import-title">Importar Contas a Receber</h2><p className="muted">Atualize a Central com o relatório do sistema de origem. A cópia original, as carteiras e o histórico são preservados.</p></div></div>
      <div className="inline-actions" role="group" aria-label="Tipo de relatório de Contas a Receber"><button type="button" className={`button ${mode === 'open' ? '' : 'secondary'}`} aria-pressed={mode === 'open'} disabled={busy !== null || uncertain} onClick={() => changeMode('open')}>Abertos e vencidos</button><button type="button" className={`button ${mode === 'received' ? '' : 'secondary'}`} aria-pressed={mode === 'received'} disabled={busy !== null || uncertain} onClick={() => changeMode('received')}>Títulos quitados</button></div>
      <p className="notice">{mode === 'open' ? 'Abertos e vencidos atualizam a previsão e os dados dos títulos. Uma ausência nunca confirma recebimento nem retira um título da carteira.' : 'Títulos quitados confirmam o recebimento pela data e pelo valor efetivos do relatório, retiram os títulos validados da carteira ativa e alimentam a base de apuração de comissões.'}</p>
      <p className="help-text">{mode === 'open' ? 'Inclua títulos a vencer e vencidos. Na Cobrança aparecem somente os vencidos. Escolha a cobradora dos clientes sem responsável durante esta importação. Carteiras existentes são preservadas nas atualizações diárias. Alterações de parcelas que gerem dúvida exigem conferir o vínculo antes de concluir.' : 'Este modo exige as colunas Quitação: data do recebimento e Quitação: valor recebido. O vencimento e o valor original continuam separados do recebimento; não substitua essas informações.'}</p>
      <p className="help-text">Campos do título: Documento / NF, Cliente / Órgão, Filial, Vencimento e Valor original. Emissão e CNPJ são opcionais; não complete CNPJ ausente automaticamente.</p>
      {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
      {uncertain && <p className="notice" role="status">A confirmação está pendente. O arquivo e o tipo de relatório ficam preservados. Clique em Analisar arquivo para conferir o mesmo envio e concluir sem duplicar recebimentos.</p>}
      <form className="stack" onSubmit={event => void analyze(event)}>
        <label className="field" htmlFor="receivable-file">{mode === 'open' ? 'Relatório de abertos e vencidos de Contas a Receber' : 'Relatório de títulos quitados de Contas a Receber'}<input ref={inputRef} id="receivable-file" type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={busy !== null || uncertain} onChange={event => { resetAnalysis(); setComplete(false); setMappings({}); setCollectorMappings({}); setBulkCollector(''); setCustomerSearch(''); setCustomerPage(1); setMappingsDirty(false); setFile(event.target.files?.[0] ?? null); }} /></label>
        <p className="help-text">Até 2 MiB, 5.000 títulos e uma única aba preenchida. Formatos: .xlsx, .xlsm e .csv UTF-8. Para .xls antigo, salve uma cópia como .xlsx. Fórmulas são recusadas; macros nunca são executadas.</p>
        <label className="checkbox-field"><input type="checkbox" checked={complete} disabled={busy !== null || uncertain} onChange={event => { setComplete(event.target.checked); setAnalysis(null); }} />{mode === 'open' ? ' Confirmo que este arquivo contém títulos em aberto, a vencer e vencidos, do sistema de origem.' : ' Confirmo que todas as linhas deste arquivo são títulos quitados, com data e valor efetivamente recebidos.'}</label>
        <div className="inline-actions"><button type="submit" className="button" disabled={!file || !complete || busy !== null || historyLoading}>{busy === 'analyzing' ? 'Analisando cópia…' : 'Analisar arquivo'}</button>{busy === 'analyzing' && !uncertain && <button type="button" className="button secondary" onClick={resetAnalysis}>Cancelar análise</button>}</div>
      </form>
      {mode === 'open' && analysis && <section className="stack" aria-labelledby="import-collectors-title"><h3 id="import-collectors-title">Cobradoras responsáveis pela carteira</h3>
        <p className="help-text">A responsável é vinculada ao cliente e acompanha seus títulos. Os vínculos existentes ficam preservados. Você também pode reimportar o mesmo arquivo para completar carteiras sem responsável, sem duplicar os títulos.</p>
        {collectorsLoading && <p role="status">Consultando cobradoras…</p>}
        {collectorsError && <p className="notice error" role="alert">{collectorsError}</p>}
        {!collectorsLoading && !collectorsError && collectors.length === 0 && assignments.some(item => item.requires_selection) && <p className="notice" role="status">Nenhuma cobradora ativa está disponível. Peça à Gerência Geral que cadastre ou ative as cobradoras na Administração e atualize o histórico para consultar novamente.</p>}
        {assignments.some(item => item.requires_selection && !item.locked) && <div className="inline-actions"><label className="field">Cobradora para clientes sem responsável<select value={bulkCollector} disabled={busy !== null || uncertain && !reviewCollectors || collectorsLoading || !!collectorsError} onChange={event => setBulkCollector(event.target.value)}><option value="">Selecione a cobradora</option>{collectors.map(item => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><button type="button" className="button secondary" disabled={busy !== null || uncertain && !reviewCollectors || !bulkCollector || !collectors.some(item => item.id === bulkCollector)} onClick={() => {
          setCollectorMappings(previous => ({ ...previous, ...Object.fromEntries(assignments.filter(item => item.requires_selection && !item.locked && !previous[item.customer_key]).map(item => [item.customer_key, bulkCollector])) })); setMappingsDirty(true); setError('');
        }}>Aplicar às carteiras sem responsável</button></div>}
        <label className="field">Buscar cliente na atribuição de cobradoras<input value={customerSearch} onChange={event => { setCustomerSearch(event.target.value); setCustomerPage(1); }} /></label>
        <div className="table-wrap"><table><caption>{assignments.length} cliente(s) na conferência de carteiras</caption><thead><tr><th>Cliente</th><th>Títulos</th><th>Cobradora responsável</th></tr></thead><tbody>{filteredCustomers.slice((currentPage - 1) * 20, currentPage * 20).map(item => <tr key={item.customer_key}><td>{item.client_name}{item.client_document && <small className="muted"> · {item.client_document}</small>}</td><td>{item.row_count}</td><td>{item.requires_selection && !item.locked ? <label className="field">Cobradora de {item.client_name}<select value={collectorMappings[item.customer_key] ?? ''} disabled={busy !== null || uncertain && !reviewCollectors || collectorsLoading || !!collectorsError} onChange={event => mapCollector(item.customer_key, event.target.value)}><option value="">Selecione a cobradora</option>{collectors.map(collector => <option key={collector.id} value={collector.id}>{collector.display_name}</option>)}</select></label> : <span>{item.collector_name ?? 'Sem atribuição necessária para títulos quitados'}{item.collector_id && <small className="muted"> · Carteira preservada</small>}</span>}</td></tr>)}</tbody></table></div>
        {pages > 1 && <div className="inline-actions"><button type="button" className="button secondary" disabled={currentPage === 1} onClick={() => setCustomerPage(currentPage - 1)}>Clientes anteriores</button><span>Página {currentPage} de {pages}</span><button type="button" className="button secondary" disabled={currentPage === pages} onClick={() => setCustomerPage(currentPage + 1)}>Próximos clientes</button></div>}
        {(analysis.preview.missing_collector_count ?? 0) > 0 && !mappingsDirty && <p className="notice" role="status">Escolha a cobradora de {analysis.preview.missing_collector_count} cliente(s) sem responsável e analise o arquivo novamente.</p>}
        {mappingsDirty && <p className="notice" role="status">Responsáveis ou vínculos alterados. Clique em Analisar arquivo novamente para conferir as escolhas antes de concluir.</p>}
      </section>}
      {mappingRows.length > 0 && <div className="stack"><h3>Conferir parcelas do mesmo documento</h3><p className="help-text">Escolha um título existente somente quando a linha for uma atualização daquela parcela. Se for outra parcela, escolha Nova parcela. Nenhum vínculo é presumido pelo número da NF.</p>
        {unresolved.length > 0 && <button type="button" className="button secondary" disabled={busy !== null || uncertain} onClick={() => { setMappings(previous => ({ ...previous, ...Object.fromEntries(unresolved.map(row => [String(row.line), 'NEW'])) })); setMappingsDirty(true); }}>Marcar {unresolved.length} linha(s) como novas parcelas</button>}
        <div className="table-wrap"><table><caption>Vínculo das parcelas antes da importação</caption><thead><tr><th>Linha</th><th>Cliente / NF</th><th>Vencimento / Valor original</th><th>Vínculo confirmado</th></tr></thead><tbody>{mappingRows.map(row => <tr key={row.line}><td>{row.line + 1}</td><td>{row.client_name} · {row.document} · Filial {row.branch}</td><td>{dateLabel(row.due_date)} · {formatCents(row.amount_cents)}</td><td><label className="field">Vínculo da linha {row.line + 1}<select aria-label={`Vínculo da linha ${row.line + 1}`} value={mappings[String(row.line)] ?? ''} disabled={busy !== null || uncertain} onChange={event => mapTitle(row.line, event.target.value)}><option value="">Selecione a parcela</option><option value="NEW">Nova parcela</option>{row.candidates?.map(candidate => <option key={candidate.id} value={candidate.id}>{dateLabel(candidate.due_date)} · {formatCents(candidate.amount_cents)} · {candidate.status === 'VALIDATED' ? 'Quitado' : 'Em aberto'}</option>)}</select></label></td></tr>)}</tbody></table></div>
        {mappingsDirty && <p className="notice">Vínculos alterados. Clique em Analisar arquivo novamente para conferir o resultado antes de concluir.</p>}
      </div>}
      {problems.length > 0 && <div><p className="notice error" role="alert">Importação bloqueada. Nenhum dado foi alterado. Corrija os problemas ou confira os vínculos e analise novamente.</p><div className="table-wrap"><table><caption>Problemas encontrados · até 100 erros por análise</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.map((problem, index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div></div>}
      {analysis && <div className="stack"><h3>Conferência de Contas a Receber</h3><p>{analysis.preview.row_count} títulos · total original {formatCents(analysis.nominalTotal)} · {analysis.preview.new_count} novos títulos.</p>
        {mode === 'received' ? <><p><strong>Total recebido efetivo: {formatCents(analysis.receivedTotal)}</strong></p><p>{analysis.preview.received_count ?? 0} recebimentos novos · {analysis.preview.matched_count ?? 0} já registrados · {analysis.preview.correction_count ?? 0} correções · {analysis.preview.historical_count ?? 0} quitados do histórico.</p><p className="notice">A confirmação deste arquivo valida os recebimentos conferidos. A apuração de comissões usa o valor efetivamente recebido; importar não significa pagar comissão.</p></> : <p className="notice">{analysis.preview.changed_count ?? 0} títulos com alterações. Ausências permanecem como estão; nenhum recebimento será confirmado.</p>}
        {(analysis.preview.validated_in_source_count ?? 0) > 0 && <p className="notice">{analysis.preview.validated_in_source_count} título(s) já quitado(s) reaparecem no relatório. A importação não reabre esses títulos.</p>}
        <div className="table-wrap"><table><caption>Conferência das primeiras {Math.min(10, analysis.rows.length)} linhas oficiais</caption><thead><tr><th>Cliente / NF</th><th>Filial</th><th>Vencimento original</th><th>Valor original</th>{mode === 'received' && <><th>Recebido em</th><th>Valor recebido</th></>}<th>Resultado</th></tr></thead><tbody>{analysis.rows.slice(0, 10).map(row => <tr key={row.line}><td>{row.client_name} · {row.document}</td><td>{row.branch}</td><td>{dateLabel(row.due_date)}</td><td>{formatCents(row.amount_cents)}</td>{mode === 'received' && <><td>{dateLabel(row.received_on ?? null)}</td><td>{formatCents(row.received_amount_cents ?? 0)}</td></>}<td>{outcomes[row.outcome]}</td></tr>)}</tbody></table></div>
        {!analysis.preview.can_commit && !problems.length && <p className="notice error" role="alert">Este arquivo ainda precisa de conferência. Resolva os vínculos ou conflitos e analise novamente.</p>}
        <button className="button" type="button" disabled={busy !== null || !complete || mappingsDirty || !analysis.preview.can_commit || problems.length > 0} onClick={() => void commit()}>{busy === 'saving' ? 'Concluindo importação…' : mode === 'received' ? 'Confirmar importação de títulos quitados' : 'Concluir importação de abertos e vencidos'}</button>
      </div>}
    </section>
    <section className="panel" aria-labelledby="receivable-import-history"><div className="panel-header"><div><h2 id="receivable-import-history">Histórico de importações de Contas a Receber</h2><p className="muted">20 arquivos mais recentes. Os contadores descrevem cada lote e não substituem o saldo atual.</p></div><button className="button secondary" type="button" disabled={busy !== null || historyLoading} onClick={() => setRefresh(value => value + 1)}>Atualizar histórico de CR</button></div>
      {historyError && <p className="notice error" role="alert">{historyError}</p>}
      <div className="table-wrap" aria-busy={historyLoading}><table><thead><tr><th>Data / hora</th><th>Arquivo</th><th>Tipo</th><th>Títulos</th><th>Novos títulos</th><th>Já identificados</th></tr></thead><tbody>{historyLoading ? <tr><td className="empty-state" colSpan={6}>Carregando histórico…</td></tr> : history.length ? history.map(batch => <tr key={batch.id}><td>{dateLabel(batch.created_at)}</td><td>{batch.file_name}</td><td>{batch.import_mode === 'OPEN' ? 'Abertos e vencidos' : batch.import_mode === 'RECEIVED' ? 'Títulos quitados' : 'Histórico'}</td><td>{batch.row_count}</td><td>{batch.new_count}</td><td>{batch.open_count + batch.validated_in_source_count}</td></tr>) : <tr><td className="empty-state" colSpan={6}>{historyError ? 'Histórico indisponível.' : 'Nenhuma base de Contas a Receber importada.'}</td></tr>}</tbody></table></div>
    </section>
  </>;
}
