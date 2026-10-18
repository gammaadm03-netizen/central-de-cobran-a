import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { analyzePayableFile, dateLabel, formatCents, normalizePlan, PAYABLE_SCOPE, payableError, payableImportRequest, type ImportPreview, type ImportProblem, type PayableImportRow, type PayableServerPreview } from '../lib/payables';

interface PlanGroup { plan: string; count: number; cents: number; macro: string }
interface Batch { id: string; file_name: string; created_at: string; row_count: number; new_count: number; open_count: number; settled_count: number }
interface Analysis { file: File; hash: string; base64: string; rows: PayableImportRow[]; preview: ImportPreview; groups: PlanGroup[] }

export default function PayablesImport({ canImport }: { canImport: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState<'analyzing' | 'saving' | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [problems, setProblems] = useState<ImportProblem[]>([]);
  const [macros, setMacros] = useState<string[]>([]);
  const [history, setHistory] = useState<Batch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refresh, setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);

  useEffect(() => {
    if (!supabase || !canImport) { setHistoryLoading(false); return; }
    const client = supabase, abort = new AbortController(); let active = true;
    setHistoryLoading(true); setHistoryError('');
    void Promise.all([
      client.from('payable_imports').select('id,file_name,created_at,row_count,new_count,open_count,settled_count').eq('scope', PAYABLE_SCOPE).order('created_at', { ascending: false }).limit(20).abortSignal(abort.signal),
      client.from('payable_macros').select('name').order('name').abortSignal(abort.signal),
    ]).then(([batches, classifications]) => {
      if (!active) return;
      if (batches.error || classifications.error) throw batches.error ?? classifications.error;
      setHistory((batches.data ?? []) as Batch[]);
      setMacros((classifications.data ?? []).map(item => String(item.name)));
    }).catch(loadError => { if (active) setHistoryError(payableError(loadError, 'Não foi possível carregar as classificações e o histórico de importações.')); }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [canImport, refresh]);

  function resetAnalysis() { generation.current++; controller.current?.abort(); setAnalysis(null); setProblems([]); setError(''); setSuccess(''); setBusy(null); }

  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !file || !complete || !canImport || busy) return;
    const client = supabase; const current = ++generation.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy('analyzing'); setAnalysis(null); setProblems([]); setError(''); setSuccess('');
    try {
      const parsed = await analyzePayableFile(file, abort.signal);
      if (current !== generation.current) return;
      if (parsed.errors.length) { setProblems(parsed.errors); return; }
      const [mappingResult, canonical] = await Promise.all([
        client.from('payable_plan_mappings').select('plan,macro').abortSignal(abort.signal),
        payableImportRequest<PayableServerPreview>({ action:'preview',file_name:file.name,file_base64:parsed.base64 },abort.signal),
      ]);
      if (current !== generation.current) return;
      if (mappingResult.error) throw mappingResult.error;
      if (!canonical || !Array.isArray(canonical.rows) || canonical.rows.length < 1 || canonical.rows.length > 5000 || !/^[a-f0-9]{64}$/.test(canonical.file_sha256)) throw new Error('Não foi possível confirmar a análise do arquivo no servidor. Nenhum dado foi alterado.');
      const known = new Map((mappingResult.data ?? []).map(item => [normalizePlan(String(item.plan)), String(item.macro)]));
      const groups = new Map<string, PlanGroup>();
      for (const row of canonical.rows) {
        const key = normalizePlan(row.plan);
        const group = groups.get(key) ?? { plan: row.plan, count: 0, cents: 0, macro: known.get(key) ?? '' };
        group.count++; group.cents += row.amount_cents;
        if (!Number.isSafeInteger(group.cents)) throw new Error('Total do plano excede o limite seguro.');
        groups.set(key, group);
      }
      const preview = canonical.preview;
      if (!preview || !Number.isSafeInteger(preview.row_count) || preview.row_count !== canonical.rows.length || ['new_count','open_count','settled_count'].some(key => !Number.isSafeInteger(preview[key as keyof ImportPreview])) || (preview.changed_count !== undefined && (!Number.isSafeInteger(preview.changed_count) || preview.changed_count < 0 || preview.changed_count > preview.open_count))) throw new Error('Não foi possível confirmar o resumo da análise. Nenhum dado foi alterado.');
      setAnalysis({ file, hash: canonical.file_sha256, base64: parsed.base64, rows: canonical.rows, preview, groups: Array.from(groups.values()).sort((a,b) => a.plan.localeCompare(b.plan,'pt-BR')) });
    } catch (analyzeError) { if (current === generation.current && !abort.signal.aborted) {
      if (analyzeError && typeof analyzeError === 'object' && 'errors' in analyzeError && Array.isArray(analyzeError.errors) && analyzeError.errors.length) setProblems(analyzeError.errors as ImportProblem[]);
      else setError(payableError(analyzeError, analyzeError instanceof Error ? analyzeError.message : 'Não foi possível concluir a análise. Nenhum dado foi alterado.'));
    } }
    finally { if (current === generation.current) setBusy(null); }
  }

  async function commit() {
    if (!supabase || !analysis || !complete || !canImport || busy || analysis.groups.some(group => !macros.includes(group.macro))) return;
    const question = `Confirma a importação do RELATÓRIO COMPLETO do Grupo consolidado?\n\n${analysis.preview.new_count} novos; ${analysis.preview.open_count} permanecem em aberto${analysis.preview.changed_count === undefined ? '' : ` (${analysis.preview.changed_count} com dados atualizados)`}; ${analysis.preview.settled_count} ausentes serão QUITADOS POR IMPORTAÇÃO.\n\nBases filtradas não devem ser concluídas. Os títulos anteriores serão preservados no histórico.`;
    if (!window.confirm(question)) return;
    setBusy('saving'); setError(''); setSuccess('');
    const current = generation.current;
    try {
      const mappings = Object.fromEntries(analysis.groups.map(group => [group.plan, group.macro]));
      const summary = await payableImportRequest<ImportPreview>({
        action:'commit', file_name: analysis.file.name, file_base64: analysis.base64, mappings, complete: true,
        previous_import_id: analysis.preview.previous_import_id,
      });
      if (current !== generation.current) return;
      if (!summary || !Number.isSafeInteger(summary.row_count)) throw new Error('Resposta não confirmada.');
      setSuccess(`Importação concluída: ${summary.row_count} títulos, ${summary.new_count} novos, ${summary.open_count} em aberto${summary.changed_count === undefined ? '' : ` (${summary.changed_count} com valor, data, banco ou outros dados atualizados)`} e ${summary.settled_count} quitados por importação. Histórico preservado.`);
      setAnalysis(null); setComplete(false); setFile(null); setRefresh(value => value + 1);
      const input = document.getElementById('payable-file') as HTMLInputElement | null; if (input) input.value = '';
    } catch (writeError) {
      if (current === generation.current) {
        setError(payableError(writeError, 'Não foi possível confirmar a importação. Atualize o histórico antes de tentar novamente.'));
        if (writeError && typeof writeError === 'object' && 'code' in writeError && writeError.code === '40001') setAnalysis(null);
        setRefresh(value => value + 1);
      }
    } finally { if (current === generation.current) setBusy(null); }
  }

  if (!canImport) return <p className="notice">Seu perfil não permite importar bases de Contas a Pagar.</p>;
  const unclassified = analysis?.groups.filter(group => !macros.includes(group.macro)).length ?? 0;
  return <>
    <section className="panel" aria-labelledby="payable-import-title">
      <div className="panel-header"><div><h2 id="payable-import-title">Importar Contas a Pagar</h2><p className="muted">Origem: Grupo consolidado · análise da cópia e conclusão atômica no banco central.</p></div></div>
      <p className="notice error"><strong>IMPORTAR SOMENTE RELATÓRIO COMPLETO.</strong> Relatórios filtrados podem fazer títulos serem interpretados incorretamente como quitados.</p>
      <p className="help-text">Use o relatório completo de obrigações em aberto e cheques da mesma origem, abrangendo todas as filiais do Grupo consolidado. Não restrinja esse conjunto por mês, filial, banco ou macro, nem exclua cheques ou parte das obrigações em aberto. O arquivo original é preservado; ausências após a comparação geram baixa, sem apagar títulos.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      {success && <p className="notice success" role="status">{success}</p>}
      <form className="stack" onSubmit={event => void analyze(event)}>
        <label className="field" htmlFor="payable-file">Relatório completo de Contas a Pagar<input id="payable-file" type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={busy !== null} onChange={event => { resetAnalysis(); setComplete(false); setFile(event.target.files?.[0] ?? null); }} /></label>
        <p className="help-text">Até 2 MiB e 5.000 títulos. Formatos: .xlsx, .xlsm e .csv UTF-8. Para .xls antigo, salve uma cópia como .xlsx. Fórmulas são recusadas; macros nunca são executadas.</p>
        <label className="checkbox-field"><input type="checkbox" checked={complete} disabled={busy !== null} onChange={event => { setComplete(event.target.checked); setAnalysis(null); }} /> Confirmo que este é o relatório COMPLETO da mesma origem Grupo consolidado.</label>
        <div className="inline-actions"><button type="submit" className="button" disabled={!file || !complete || busy !== null || historyLoading || macros.length === 0}>{busy === 'analyzing' ? 'Analisando cópia…' : 'Analisar arquivo'}</button>{busy === 'analyzing' && <button type="button" className="button secondary" onClick={resetAnalysis}>Cancelar análise</button>}</div>
      </form>
      {problems.length > 0 && <div><p className="notice error" role="alert">Importação bloqueada. Nenhum dado foi alterado. Corrija todos os problemas abaixo e analise novamente.</p><div className="table-wrap"><table><caption>Problemas encontrados · até 100 erros por análise</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.map((problem,index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div></div>}
      {analysis && <div className="stack">
        <h3>Conferência antes da importação</h3><p>{analysis.preview.row_count} títulos · {analysis.preview.new_count} novos · {analysis.preview.open_count} em aberto{analysis.preview.changed_count === undefined ? '' : ` (${analysis.preview.changed_count} com dados atualizados)`} · <strong>{analysis.preview.settled_count} ausentes serão quitados por importação</strong>.</p>
        <p className="help-text">Classifique cada Plano de Contas. Planos conhecidos mantêm o mapeamento anterior; planos novos exigem sua escolha.</p>
        <div className="table-wrap"><table><caption>Classificação dos Planos de Contas</caption><thead><tr><th>Plano</th><th>Quantidade</th><th>Valor total</th><th>Centro de Custo Macro</th></tr></thead><tbody>{analysis.groups.map((group,index) => <tr key={normalizePlan(group.plan)}><td>{group.plan}</td><td>{group.count}</td><td>{formatCents(group.cents)}</td><td><label className="sr-only" htmlFor={`payable-macro-${index}`}>Macro para {group.plan}</label><select id={`payable-macro-${index}`} value={macros.includes(group.macro) ? group.macro : ''} disabled={busy !== null} onChange={event => { const macro = event.target.value; setAnalysis(previous => previous ? { ...previous, groups: previous.groups.map((item,itemIndex) => itemIndex === index ? { ...item, macro } : item) } : null); }}><option value="">NÃO CLASSIFICADO</option>{macros.map(macro => <option key={macro}>{macro}</option>)}</select></td></tr>)}</tbody></table></div>
        {unclassified > 0 && <p className="notice" role="status">{unclassified} plano(s) sem classificação. A conclusão está bloqueada.</p>}
        <button className="button" type="button" disabled={busy !== null || unclassified > 0 || !complete} onClick={() => void commit()}>{busy === 'saving' ? 'Concluindo importação…' : 'Concluir importação completa'}</button>
      </div>}
    </section>
    <section className="panel" aria-labelledby="payable-import-history"><div className="panel-header"><div><h2 id="payable-import-history">Histórico de importações de Contas a Pagar</h2><p className="muted">20 importações mais recentes da origem Grupo consolidado.</p></div><button className="button secondary" type="button" disabled={busy !== null || historyLoading} onClick={() => setRefresh(value => value + 1)}>Atualizar histórico</button></div>
      {historyError && <p className="notice error" role="alert">{historyError}</p>}
      <div className="table-wrap" aria-busy={historyLoading}><table><thead><tr><th>Data / hora</th><th>Arquivo</th><th>Títulos</th><th>Novos</th><th>Em aberto</th><th>Quitados</th></tr></thead><tbody>{historyLoading ? <tr><td className="empty-state" colSpan={6}>Carregando histórico…</td></tr> : history.length ? history.map(batch => <tr key={batch.id}><td>{dateLabel(batch.created_at)}</td><td>{batch.file_name}</td><td>{batch.row_count}</td><td>{batch.new_count}</td><td>{batch.open_count}</td><td>{batch.settled_count}</td></tr>) : <tr><td className="empty-state" colSpan={6}>{historyError ? 'Histórico indisponível.' : 'Nenhuma base de Contas a Pagar importada.'}</td></tr>}</tbody></table></div>
    </section>
  </>;
}
