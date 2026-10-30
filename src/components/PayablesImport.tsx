import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import PayableDailyImport from './PayableDailyImport';
import PayableColumnGuide from './PayableColumnGuide';
import PayableImportReconciliation, { resolutionChoices, validReconciliationItems, payableUuid, type ReconciliationItem, type ImportBank, type ResolutionDraft, type ResolutionChoice } from './PayableImportReconciliation';
import { officialToday } from './Treasury';
import { analyzePayableFile, dateLabel, formatCents, normalizePlan, PAYABLE_SCOPE, payableError, payableImportRequest, type ImportPreview, type ImportProblem, type PayableImportRow } from '../lib/payables';

interface PlanGroup { plan: string; count: number; cents: number; macro: string }
interface Batch { id: string; file_name: string; created_at: string; row_count: number; new_count: number; open_count: number; settled_count: number }
interface ForecastPreview extends ImportPreview { reconciliation_version: '043'; financial_revision: string; full_report: boolean; reconciliation_items: ReconciliationItem[]; resolution_errors: ImportProblem[]; can_commit: boolean; bank_options: ImportBank[]; bank_accounts?: ImportBank[] }
interface Analysis { file: File; hash: string; base64: string; rows: PayableImportRow[]; preview: ForecastPreview; groups: PlanGroup[]; choices: Record<string, ResolutionChoice> }
type ForecastRequest = Parameters<typeof payableImportRequest>[0] & { reconciliation_version: '043'; full_report: boolean; resolution_choices: Record<string, ResolutionChoice>; request_id?: string };
interface FrozenForecast { body: ForecastRequest; rowCount: number }

export default function PayablesImport({ canImport, onBusyChange }: { canImport: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [importBusy, setImportBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(importBusy);
    window.dispatchEvent(new CustomEvent('receivable-validation-pending', { detail: importBusy }));
  }, [importBusy, onBusyChange]);
  useEffect(() => () => {
    onBusyChange?.(false);
    window.dispatchEvent(new CustomEvent('receivable-validation-pending', { detail: false }));
  }, [onBusyChange]);
  if (!canImport) return <p className="notice">Seu perfil não permite importar bases de Contas a Pagar.</p>;
  return <>
    <section className="panel" aria-label="Rotina diária de Contas a Pagar">
      <h2>Contas a Pagar: um relatório por dia</h2>
      <p>Envie a relação completa dos títulos que continuam em aberto, incluindo os novos lançamentos e os cheques. O primeiro arquivo cria a base inicial. Nos próximos dias, os títulos que deixarem de aparecer serão baixados como pagos.</p>
      <p className="help-text">A Central atualiza os valores e vencimentos do mesmo lançamento, inclui os novos e calcula as baixas em uma única conferência. Marcadores de R$ 0,01 exigem confirmação individual e ficam fora do realizado.</p>
      <PayableColumnGuide />
    </section>
    <PayableDailyImport canImport={canImport} reportKind="ALL" onBusyChange={setImportBusy} />
  </>;
}

export function ForecastImport({ canImport, onBusyChange }: { canImport: boolean; onBusyChange: (busy: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null), [reportKind, setReportKind] = useState<'' | 'FULL' | 'INCREMENTAL'>('');
  const [complete, setComplete] = useState(false), [busy, setBusy] = useState<'analyzing' | 'saving' | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [needsReview, setNeedsReview] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ResolutionDraft>>({}), [planChoices, setPlanChoices] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<FrozenForecast | null>(null), [problems, setProblems] = useState<ImportProblem[]>([]);
  const [macros, setMacros] = useState<string[]>([]), [history, setHistory] = useState<Batch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true), [historyError, setHistoryError] = useState('');
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [refresh, setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null), generation = useRef(0), input = useRef<HTMLInputElement | null>(null);
  const source = useRef<{ file: File; hash: string; base64: string } | null>(null);
  const frozenRef = useRef<FrozenForecast | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => { onBusyChange(!!busy || !!pending); return () => onBusyChange(false); }, [busy, pending, onBusyChange]);
  useEffect(() => {
    if (!pending && busy !== 'saving') return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [pending, busy]);
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
      setHistory((batches.data ?? []) as Batch[]); setMacros((classifications.data ?? []).map(item => String(item.name)));
    }).catch(failure => { if (active) setHistoryError(payableError(failure, 'Não foi possível consultar as classificações e o histórico.')); }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [canImport, refresh]);
  function importError(failure: unknown, fallback: string) {
    const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
    if (['PGRST202', '42883', '42P01'].includes(code) || code === 'P0043' && failure && typeof failure === 'object' && 'activation_required' in failure && failure.activation_required === true) return 'Ative a atualização 043 no banco e na função payables-import para conciliar as escolhas junto com o arquivo.';
    if (code === 'P0042') return 'Este título possui pagamento ou baixa anterior que precisa de conferência. Reanalise o arquivo e confira a situação antes de conciliar.';
    return payableError(failure, fallback);
  }
  function clearPreparation() {
    generation.current++; controller.current?.abort(); setAnalysis(null); setDrafts({}); setPlanChoices({}); setProblems([]); setNeedsReview(false); setError(''); setSuccess(''); setBusy(null); source.current = null;
  }
  function markChoices() { setNeedsReview(true); setError(''); setSuccess(''); }
  async function analyze(event?: FormEvent) {
    event?.preventDefault();
    if (!supabase || !file || !complete || !reportKind || !canImport || busy || pending || frozenRef.current) return;
    const current = ++generation.current, client = supabase;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const prior = analysis?.file === file && analysis.preview.full_report === (reportKind === 'FULL') ? analysis : null;
    const chosen = prior ? resolutionChoices(prior.preview.reconciliation_items, drafts, prior.preview.bank_options, officialToday()).choices : {};
    setBusy('analyzing'); setProblems([]); setError(''); setSuccess(''); setNeedsReview(true);
    try {
      const parsed = source.current?.file === file ? { ...source.current, errors: [] as ImportProblem[] } : await analyzePayableFile(file, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      if (parsed.errors.length) { setProblems(parsed.errors); return; }
      source.current = { file, hash: parsed.hash, base64: parsed.base64 };
      const [mappingResult, canonical] = await Promise.all([
        client.from('payable_plan_mappings').select('plan,macro').abortSignal(abort.signal),
        payableImportRequest<{ rows: PayableImportRow[]; preview: ForecastPreview; file_sha256: string }>({ action: 'preview', mode: 'forecast', reconciliation_version: '043', full_report: reportKind === 'FULL', resolution_choices: chosen, file_name: file.name, file_base64: parsed.base64 } as ForecastRequest, abort.signal),
      ]);
      if (current !== generation.current || abort.signal.aborted) return;
      if (mappingResult.error) throw mappingResult.error;
      if (canonical?.preview?.reconciliation_version !== '043') throw { code: 'P0043', activation_required: true };
      const preview = canonical.preview;
      const banks = preview.bank_options ?? preview.bank_accounts;
      if (!Array.isArray(canonical.rows) || canonical.rows.length < 1 || canonical.rows.length > 5000 || canonical.file_sha256 !== parsed.hash
        || preview.full_report !== (reportKind === 'FULL') || preview.row_count !== canonical.rows.length
        || !(preview.previous_import_id === null || payableUuid(preview.previous_import_id)) || typeof preview.financial_revision !== 'string' || !preview.financial_revision.trim() || preview.financial_revision.length > 256
        || typeof preview.can_commit !== 'boolean' || !validReconciliationItems(preview.reconciliation_items) || preview.reconciliation_items.some(item => item.kind === 'INTERNAL_CASH') || !Array.isArray(preview.resolution_errors)
        || !Array.isArray(banks) || banks.some(bank => !payableUuid(bank.id) || typeof bank.display_name !== 'string')
        || ['new_count', 'open_count', 'settled_count'].some(key => !Number.isSafeInteger(preview[key as keyof ImportPreview]) || Number(preview[key as keyof ImportPreview]) < 0)
        || preview.reconciliation_items.some(item => chosen[item.key] && item.selected_action !== chosen[item.key].action)) throw new Error('invalid-preview');
      const known = new Map((mappingResult.data ?? []).map(item => [normalizePlan(String(item.plan)), String(item.macro)])), groups = new Map<string, PlanGroup>();
      for (const row of canonical.rows) {
        if (!Number.isSafeInteger(row.amount_cents) || row.amount_cents < 0 || typeof row.plan !== 'string') throw new Error('invalid-row');
        const key = normalizePlan(row.plan), group = groups.get(key) ?? { plan: row.plan, count: 0, cents: 0, macro: planChoices[key] ?? known.get(key) ?? '' };
        group.count++; group.cents += row.amount_cents; if (!Number.isSafeInteger(group.cents)) throw new Error('invalid-total'); groups.set(key, group);
      }
      const issues = preview.resolution_errors.slice(0,100).filter(item => Number.isSafeInteger(item.line) && typeof item.column === 'string' && typeof item.problem === 'string' && typeof item.correction === 'string');
      if (preview.can_commit && (issues.length || preview.reconciliation_items.some(item => item.requires_resolution && !chosen[item.key]))) throw new Error('invalid-resolution');
      setAnalysis({ file, hash: parsed.hash, base64: parsed.base64, rows: canonical.rows, preview: { ...preview, bank_options: banks }, choices: chosen, groups: [...groups.values()].sort((a,b) => a.plan.localeCompare(b.plan,'pt-BR')) });
      setProblems(issues); setNeedsReview(false);
    } catch (failure) {
      if (current !== generation.current || abort.signal.aborted) return;
      setNeedsReview(true);
      if (failure && typeof failure === 'object' && 'errors' in failure && Array.isArray(failure.errors)) setProblems(failure.errors.slice(0,100) as ImportProblem[]);
      setError(importError(failure, 'Não foi possível validar esta análise. O arquivo e as escolhas foram preservados. Confira os problemas e tente novamente.'));
    } finally { if (current === generation.current) setBusy(null); }
  }
  const unclassified = analysis?.groups.filter(group => !macros.includes(group.macro)).length ?? 0;
  const resolution = analysis ? resolutionChoices(analysis.preview.reconciliation_items, drafts, analysis.preview.bank_options, officialToday()) : { choices: {}, unresolved: 0 };
  const canCommit = !!analysis && complete && !!reportKind && !busy && !pending && !needsReview && !unclassified && !problems.length && !resolution.unresolved && analysis.preview.can_commit;
  async function execute(request: FrozenForecast) {
    if (busy) return;
    frozenRef.current = request; const current = generation.current;
    setBusy('saving'); setError(''); setSuccess('');
    try {
      const result = await payableImportRequest<ImportPreview & { import_id: string; request_id?: string; idempotent?: boolean }>(request.body);
      if (current !== generation.current) return;
      if (!result || !payableUuid(result.import_id) || result.row_count !== request.rowCount || result.request_id !== request.body.request_id) throw new Error('unconfirmed');
      frozenRef.current = null; setPending(null);
      setSuccess(`Importação concluída: ${result.row_count} título(s) conferido(s). As conciliações escolhidas foram aplicadas junto com o arquivo; pagamentos efetivos compõem o realizado e baixas administrativas ficam fora dos valores financeiros. Histórico preservado.`);
      setAnalysis(null); setFile(null); setComplete(false); setReportKind(''); setDrafts({}); setPlanChoices({}); setProblems([]); setNeedsReview(false); source.current = null; setRefresh(value => value + 1); if (input.current) input.current.value = '';
    } catch (failure) {
      if (current !== generation.current) return;
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      const known = ['23505','23514','22023','42501','40001','P0016','P0019','P0021','P0042','P0043','PGRST202','PGRST301','PGRST303','42P01','42883'].includes(code);
      if (known) { frozenRef.current = null; setPending(null); setNeedsReview(true); }
      else setPending(request);
      setError(importError(failure, 'A confirmação do resultado não chegou. O mesmo arquivo, tipo de relatório, escolhas e protocolo foram preservados. Repita a confirmação pendente para conferir esse envio sem criar outro protocolo.'));
      setRefresh(value => value + 1);
    } finally { if (current === generation.current) setBusy(null); }
  }
  function commit() {
    if (!canCommit || !analysis || frozenRef.current) return;
    const paid = Object.values(analysis.choices).filter(choice => choice.action === 'PAID').length, writtenOff = Object.values(analysis.choices).filter(choice => choice.action === 'WRITE_OFF').length;
    if (!window.confirm(`Concluir esta importação e suas conciliações em uma única confirmação?\n\nArquivo: ${analysis.file.name}\nTipo: ${analysis.preview.full_report ? 'Relatório completo' : 'Somente novos títulos e atualizações'}\nTítulos no arquivo: ${analysis.preview.row_count}\nPagamentos efetivos informados: ${paid}\nBaixas sem pagamento confirmadas individualmente: ${writtenOff}\n\nOs pagamentos usarão as datas, valores e contas efetivos informados. Somente baixado não cria pagamento nem realizado. Todas as escolhas e o histórico serão preservados.`)) return;
    const request: FrozenForecast = { rowCount: analysis.preview.row_count, body: { action: 'commit', mode: 'forecast', reconciliation_version: '043', full_report: analysis.preview.full_report, resolution_choices: analysis.choices, file_name: analysis.file.name, file_base64: analysis.base64, mappings: Object.fromEntries(analysis.groups.map(group => [group.plan, group.macro])), complete: true, previous_import_id: analysis.preview.previous_import_id, previous_financial_revision: analysis.preview.financial_revision, request_id: crypto.randomUUID() } };
    void execute(request);
  }
  return <>
    <section className="panel" aria-labelledby="payable-import-title">
      <div className="panel-header"><div><h2 id="payable-import-title">Importar Contas a Pagar</h2><p className="muted">Previsão e conciliação do relatório, em uma única importação.</p></div></div>
      <p className="notice">Identifique o tipo de relatório. Na conferência você decide sobre cada baixa, sem precisar abrir os títulos depois de importar.</p>
      <fieldset className="payable-import-report-kind" disabled={!!busy || !!pending}><legend>Conteúdo do relatório de previsões</legend>
        <label><input type="radio" name="payable-report-kind" aria-label="Relatório completo de títulos em aberto" checked={reportKind === 'FULL'} onChange={() => { if (pending) return; clearPreparation(); setReportKind('FULL'); setComplete(false); }} /><span>Relatório completo de títulos em aberto<small>Mostra também os títulos da base que não constam mais no arquivo, para você escolher Pago ou Somente baixado.</small></span></label>
        <label><input type="radio" name="payable-report-kind" aria-label="Somente novos títulos e atualizações" checked={reportKind === 'INCREMENTAL'} onChange={() => { if (pending) return; clearPreparation(); setReportKind('INCREMENTAL'); setComplete(false); }} /><span>Somente novos títulos e atualizações<small>Preserva os títulos ausentes deste arquivo, sem presumir pagamento ou baixa.</small></span></label>
      </fieldset>
      {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
      {pending && <div className="notice" role="status"><p>A confirmação está pendente. O arquivo, o tipo de relatório e as escolhas estão congelados até conferir este mesmo envio.</p><button type="button" className="button secondary" disabled={!!busy} onClick={() => void execute(pending)}>Repetir confirmação pendente</button></div>}
      <form className="stack" onSubmit={event => void analyze(event)}>
        <label className="field" htmlFor="payable-file">Relatório de previsões de Contas a Pagar<input ref={input} id="payable-file" type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={!!busy || !!pending} onChange={event => { if (pending) return; clearPreparation(); setComplete(false); setFile(event.target.files?.[0] ?? null); }} /></label>
        <p className="help-text">Até 2 MiB e 5.000 títulos. .xlsx, .xlsm ou .csv UTF-8. O original será preservado; macros não são executadas.</p>
        <label className="checkbox-field"><input type="checkbox" checked={complete} disabled={!!busy || !!pending} onChange={event => { setComplete(event.target.checked); setNeedsReview(true); }} />Confirmo o conteúdo do relatório e o tipo de importação selecionado.</label>
        <div className="inline-actions"><button type="submit" className="button" disabled={!file || !reportKind || !complete || !!busy || !!pending || historyLoading || !macros.length}>{busy === 'analyzing' ? 'Analisando cópia…' : analysis ? 'Reanalisar arquivo' : 'Analisar arquivo'}</button>{busy === 'analyzing' && <button type="button" className="button secondary" onClick={() => { generation.current++; controller.current?.abort(); setBusy(null); setNeedsReview(true); }}>Cancelar análise</button>}</div>
      </form>
      {analysis && <div className="stack"><h3>Conferência antes da importação</h3><p>{analysis.preview.row_count} títulos no arquivo · {analysis.preview.new_count} novos · {analysis.preview.open_count} títulos existentes.</p>
        <p className="help-text">Os valores da prévia são nominais. Os títulos confirmados como Somente baixado serão preservados no histórico e excluídos dos valores financeiros.</p>
        {needsReview && <p className="notice" role="status">Escolhas ou dados alterados. Valide novamente antes de concluir. A conferência exibida é a anterior.</p>}
        <div className="table-wrap"><table><caption>Prévia dos títulos · {Math.min(analysis.rows.length,10)} de {analysis.rows.length} lançamentos</caption><thead><tr><th>Nº lançamento</th><th>Nº cheque</th><th>Histórico / favorecido</th><th>Plano de Contas</th><th>Banco previsto (Plano cc)</th><th>Valor nominal</th><th>Emissão</th><th>Vencimento</th><th>Filial</th><th>Situação da origem</th></tr></thead><tbody>{analysis.rows.slice(0,10).map((row,index) => <tr key={index}><td>{row.entry_number}</td><td>{row.cheque_number || '—'}</td><td>{row.description}</td><td>{row.plan}</td><td>{row.bank_account || '—'}</td><td>{formatCents(row.amount_cents)}</td><td>{dateLabel(row.issued_on)}</td><td>{dateLabel(row.due_date)}</td><td>{row.branch}</td><td>{row.source_status || 'Não informada'}</td></tr>)}</tbody></table></div>
        <div className="table-wrap"><table><caption>Classificação dos Planos de Contas</caption><thead><tr><th>Plano</th><th>Quantidade</th><th>Valor nominal</th><th>Centro de Custo Macro</th></tr></thead><tbody>{analysis.groups.map(group => <tr key={normalizePlan(group.plan)}><td>{group.plan}</td><td>{group.count}</td><td>{formatCents(group.cents)}</td><td><select aria-label={`Macro para ${group.plan}`} value={macros.includes(group.macro) ? group.macro : ''} disabled={!!busy || !!pending} onChange={event => { const macro = event.target.value, key = normalizePlan(group.plan); setPlanChoices(previous => ({ ...previous, [key]: macro })); setAnalysis(previous => previous ? { ...previous, groups: previous.groups.map(item => normalizePlan(item.plan) === key ? { ...item, macro } : item) } : null); markChoices(); }}><option value="">NÃO CLASSIFICADO</option>{macros.map(macro => <option key={macro}>{macro}</option>)}</select></td></tr>)}</tbody></table></div>
        <PayableImportReconciliation items={analysis.preview.reconciliation_items} banks={analysis.preview.bank_options} drafts={drafts} disabled={!!busy || !!pending} today={officialToday()} onChange={(key,value) => { setDrafts(previous => ({ ...previous, [key]: value })); markChoices(); }} />
        {unclassified > 0 && <p className="notice" role="status">{unclassified} plano(s) sem Centro de Custo Macro.</p>}
        <div className="inline-actions"><button type="button" className="button secondary" disabled={!!busy || !!pending || !complete} onClick={() => void analyze()}>Validar escolhas da importação</button><button type="button" className="button" disabled={!canCommit} onClick={commit}>{busy === 'saving' ? 'Concluindo importação…' : 'Importar e conciliar títulos'}</button></div>
      </div>}
      {!!problems.length && <div><p className="notice error" role="alert">{needsReview ? 'Confira os problemas da análise e valide as escolhas novamente.' : 'A importação ainda precisa de conferência.'} Nenhum pagamento foi registrado por esta análise.</p><div className="table-wrap"><table><caption>Problemas encontrados · até 100 erros por análise</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.map((problem,index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div></div>}
    </section>
    <section className="panel" aria-labelledby="payable-import-history"><div className="panel-header"><h2 id="payable-import-history">Histórico de importações de Contas a Pagar</h2><button type="button" className="button secondary" disabled={!!busy || historyLoading} onClick={() => setRefresh(value => value + 1)}>Atualizar histórico</button></div>{historyError && <p className="notice error" role="alert">{historyError}</p>}<div className="table-wrap"><table><thead><tr><th>Data / hora</th><th>Arquivo</th><th>Títulos</th><th>Novos</th><th>Em aberto</th><th>Quitados</th></tr></thead><tbody>{historyLoading ? <tr><td colSpan={6}>Carregando histórico…</td></tr> : history.map(batch => <tr key={batch.id}><td>{dateLabel(batch.created_at)}</td><td>{batch.file_name}</td><td>{batch.row_count}</td><td>{batch.new_count}</td><td>{batch.open_count}</td><td>{batch.settled_count}</td></tr>)}</tbody></table></div></section>
  </>;
}
