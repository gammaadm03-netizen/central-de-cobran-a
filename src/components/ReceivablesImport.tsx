import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { analyzeReceivableFile, dateLabel, formatCents, RECEIVABLE_SCOPE, receivableError, receivableImportRequest, type ReceivableImportPreview, type ImportProblem, type ReceivableImportRow, type ReceivableServerPreview } from '../lib/receivables';

interface Batch { id: string; file_name: string; created_at: string; row_count: number; new_count: number; open_count: number; pending_count: number; validated_in_source_count: number }
interface Analysis { file: File; base64: string; rows: ReceivableImportRow[]; preview: ReceivableImportPreview; total: number }
const counts = ['row_count','new_count','open_count','pending_count','validated_in_source_count'] as const;
function validPreview(preview: ReceivableImportPreview) {
  return preview && counts.every(key => Number.isSafeInteger(preview[key]) && preview[key] >= 0) && preview.new_count + preview.open_count + preview.validated_in_source_count === preview.row_count && (preview.previous_import_id === null || typeof preview.previous_import_id === 'string');
}
export default function ReceivablesImport({ canImport }: { canImport: boolean }) {
  const [file,setFile] = useState<File | null>(null);
  const [complete,setComplete] = useState(false);
  const [busy,setBusy] = useState<'analyzing' | 'saving' | null>(null);
  const [analysis,setAnalysis] = useState<Analysis | null>(null);
  const [problems,setProblems] = useState<ImportProblem[]>([]);
  const [history,setHistory] = useState<Batch[]>([]);
  const [historyLoading,setHistoryLoading] = useState(true);
  const [historyError,setHistoryError] = useState('');
  const [error,setError] = useState('');
  const [success,setSuccess] = useState('');
  const [refresh,setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    if (!supabase || !canImport) { setHistoryLoading(false); return; }
    const client = supabase, abort = new AbortController(); let active = true;
    setHistoryLoading(true); setHistoryError('');
    void Promise.resolve(client.from('receivable_imports').select('id,file_name,created_at,row_count,new_count,open_count,pending_count,validated_in_source_count').eq('scope',RECEIVABLE_SCOPE).order('created_at',{ ascending:false }).limit(20).abortSignal(abort.signal)).then(result => {
      if (!active) return;
      if (result.error) { setHistoryError(receivableError(result.error,'Não foi possível carregar o histórico de importações.')); return; }
      setHistory((result.data ?? []) as Batch[]);
    }).catch(() => { if (active) setHistoryError('Não foi possível carregar o histórico de importações. Tente atualizar novamente.'); }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; abort.abort(); };
  },[canImport,refresh]);
  function resetAnalysis() { generation.current++; controller.current?.abort(); setAnalysis(null); setProblems([]); setError(''); setSuccess(''); setBusy(null); }
  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !file || !complete || !canImport || busy) return;
    const current = ++generation.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy('analyzing'); setAnalysis(null); setProblems([]); setError(''); setSuccess('');
    try {
      const parsed = await analyzeReceivableFile(file,abort.signal);
      if (current !== generation.current) return;
      if (parsed.errors.length) { setProblems(parsed.errors); return; }
      const canonical = await receivableImportRequest<ReceivableServerPreview>({ action:'preview',file_name:file.name,file_base64:parsed.base64 },abort.signal);
      if (current !== generation.current) return;
      if (!canonical || !Array.isArray(canonical.rows) || !canonical.rows.length || canonical.rows.length > 5000 || canonical.file_sha256 !== parsed.hash || !validPreview(canonical.preview) || canonical.preview.row_count !== canonical.rows.length) throw new Error('Resposta de análise inválida.');
      let total = 0;
      for (const row of canonical.rows) {
        if (!Number.isSafeInteger(row.amount_cents) || row.amount_cents < 0) throw new Error('Total inválido.');
        total += row.amount_cents;
        if (!Number.isSafeInteger(total)) throw new Error('Total excede o limite seguro.');
      }
      setAnalysis({ file,base64:parsed.base64,rows:canonical.rows,preview:canonical.preview,total });
    } catch (analyzeError) { if (current === generation.current && !abort.signal.aborted) {
      if (analyzeError && typeof analyzeError === 'object' && 'errors' in analyzeError && Array.isArray(analyzeError.errors) && analyzeError.errors.length) setProblems(analyzeError.errors as ImportProblem[]);
      else setError(receivableError(analyzeError,'Não foi possível concluir a análise. Nenhum dado foi alterado.'));
    } } finally { if (current === generation.current) setBusy(null); }
  }
  async function commit() {
    if (!analysis || !complete || !canImport || busy) return;
    if (!window.confirm(`Confirma a importação do RELATÓRIO COMPLETO de Contas a Receber do Grupo consolidado?\n\n${analysis.preview.new_count} novos; ${analysis.preview.open_count} em aberto; ${analysis.preview.pending_count} novas ausências ficarão QUITADO — AGUARDANDO VALIDAÇÃO.\n\nAusências não são recebimentos confirmados. As carteiras e o histórico serão preservados. Títulos já validados não serão reabertos.`)) return;
    setBusy('saving'); setError(''); setSuccess(''); const current = generation.current;
    try {
      const summary = await receivableImportRequest<ReceivableImportPreview & { import_id:string }>({ action:'commit',file_name:analysis.file.name,file_base64:analysis.base64,complete:true,previous_import_id:analysis.preview.previous_import_id });
      if (current !== generation.current) return;
      if (!summary || typeof summary.import_id !== 'string' || !counts.every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0)) throw new Error('Resposta de importação não confirmada.');
      setSuccess(`Importação concluída: ${summary.row_count} títulos, ${summary.new_count} novos, ${summary.open_count} em aberto e ${summary.pending_count} novas ausências aguardando validação. Nenhum recebimento foi confirmado por esta importação.`);
      setAnalysis(null); setComplete(false); setFile(null); setRefresh(value => value + 1);
      const input = document.getElementById('receivable-file') as HTMLInputElement | null; if (input) input.value = '';
    } catch (writeError) { if (current === generation.current) {
      setError(receivableError(writeError,'Não foi possível confirmar a importação. Atualize o histórico antes de tentar novamente.'));
      if (writeError && typeof writeError === 'object' && 'code' in writeError && writeError.code === '40001') setAnalysis(null);
      setRefresh(value => value + 1);
    } } finally { if (current === generation.current) setBusy(null); }
  }
  if (!canImport) return <p className="notice">Seu perfil não permite importar bases de Contas a Receber.</p>;
  return <>
    <section className="panel" aria-labelledby="receivable-import-title">
      <div className="panel-header"><div><h2 id="receivable-import-title">Importar Contas a Receber</h2><p className="muted">Origem: Grupo consolidado · análise da cópia e conclusão atômica no banco central.</p></div></div>
      <p className="notice error"><strong>IMPORTAR SOMENTE RELATÓRIO COMPLETO.</strong> Relatórios filtrados podem gerar ausências incorretas e encaminhar títulos indevidamente à validação.</p>
      <p className="help-text">Use a mesma origem completa, abrangendo todas as filiais. Não filtre por mês, cliente, filial, cobradora ou situação. Um título ausente fica QUITADO — AGUARDANDO VALIDAÇÃO; exige data real do pagamento e confirmação financeira antes de contar como recebido. A carteira da cobradora é preservada.</p>
      <p className="help-text">Colunas obrigatórias: Documento / NF, Cliente / Órgão, Filial, Vencimento e Valor. Opcionais: Emissão e CNPJ. Não complete CNPJ ausente automaticamente.</p>
      {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
      <form className="stack" onSubmit={event => void analyze(event)}>
        <label className="field" htmlFor="receivable-file">Relatório completo de Contas a Receber<input id="receivable-file" type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={busy !== null} onChange={event => { resetAnalysis(); setComplete(false); setFile(event.target.files?.[0] ?? null); }} /></label>
        <p className="help-text">Até 2 MiB, 5.000 títulos e uma única aba preenchida. Formatos: .xlsx, .xlsm e .csv UTF-8. Para .xls antigo, salve uma cópia como .xlsx. Fórmulas são recusadas; macros nunca são executadas.</p>
        <label className="checkbox-field"><input type="checkbox" checked={complete} disabled={busy !== null} onChange={event => { setComplete(event.target.checked); setAnalysis(null); }} /> Confirmo que este é o relatório COMPLETO de Contas a Receber da mesma origem Grupo consolidado.</label>
        <div className="inline-actions"><button type="submit" className="button" disabled={!file || !complete || busy !== null || historyLoading}>{busy === 'analyzing' ? 'Analisando cópia…' : 'Analisar arquivo'}</button>{busy === 'analyzing' && <button type="button" className="button secondary" onClick={resetAnalysis}>Cancelar análise</button>}</div>
      </form>
      {problems.length > 0 && <div><p className="notice error" role="alert">Importação bloqueada. Nenhum dado foi alterado. Corrija todos os problemas abaixo e analise novamente.</p><div className="table-wrap"><table><caption>Problemas encontrados · até 100 erros por análise</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.map((problem,index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div></div>}
      {analysis && <div className="stack"><h3>Conferência de Contas a Receber</h3><p>{analysis.preview.row_count} títulos · total {formatCents(analysis.total)} · {analysis.preview.new_count} novos · {analysis.preview.open_count} em aberto.</p><p className="notice"><strong>{analysis.preview.pending_count} novas ausências aguardando validação.</strong> Isso não confirma recebimentos e não gera comissão.</p>
        {analysis.preview.validated_in_source_count > 0 && <p className="notice">{analysis.preview.validated_in_source_count} título(s) já validado(s) reaparecem no relatório. Permanecerão validados; confira a origem do arquivo.</p>}
        <button className="button" type="button" disabled={busy !== null || !complete} onClick={() => void commit()}>{busy === 'saving' ? 'Concluindo importação…' : 'Concluir importação completa de CR'}</button>
      </div>}
    </section>
    <section className="panel" aria-labelledby="receivable-import-history"><div className="panel-header"><div><h2 id="receivable-import-history">Histórico de importações de Contas a Receber</h2><p className="muted">20 importações mais recentes da origem Grupo consolidado.</p></div><button className="button secondary" type="button" disabled={busy !== null || historyLoading} onClick={() => setRefresh(value => value + 1)}>Atualizar histórico de CR</button></div>
      {historyError && <p className="notice error" role="alert">{historyError}</p>}
      <div className="table-wrap" aria-busy={historyLoading}><table><thead><tr><th>Data / hora</th><th>Arquivo</th><th>Títulos</th><th>Novos</th><th>Em aberto</th><th>Novas ausências</th><th>Validados na origem</th></tr></thead><tbody>{historyLoading ? <tr><td className="empty-state" colSpan={7}>Carregando histórico…</td></tr> : history.length ? history.map(batch => <tr key={batch.id}><td>{dateLabel(batch.created_at)}</td><td>{batch.file_name}</td><td>{batch.row_count}</td><td>{batch.new_count}</td><td>{batch.open_count}</td><td>{batch.pending_count}</td><td>{batch.validated_in_source_count}</td></tr>) : <tr><td className="empty-state" colSpan={7}>{historyError ? 'Histórico indisponível.' : 'Nenhuma base de Contas a Receber importada.'}</td></tr>}</tbody></table></div>
    </section>
  </>;
}
