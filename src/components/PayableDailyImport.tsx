import { useEffect, useRef, useState } from 'react';
import { analyzePayableFile, dateLabel, formatCents, type ImportProblem, type PayableImportRow, type PayableResolutionChoice } from '../lib/payables';
import { dailyProblems } from '../lib/payable-daily';
import { contentsImportError, payableReportContentsRequest, validContentsCanonical, validContentsResult, type ContentsCanonical, type ContentsPreview, type ContentsRequest, type ContentsResult, type ReportContents } from '../lib/payable-report-contents';

type RoundingAdjustment = { line: number; original_amount: string; amount_cents: number };
interface Prepared { file: File; base64: string; hash: string; rows: PayableImportRow[]; contents: ReportContents; emptyReportConfirmed: boolean; rounding_adjustments?: RoundingAdjustment[] }
interface Analysis extends ContentsCanonical { source: Prepared }
interface Frozen { body: ContentsRequest; rows: number; markedPaid: number; nominalPaid: number; reopened: number; writtenOff: number; newCount: number; openCount: number; changed: number; positionCount: number; previousPositionCount: number; removedCount: number; rounding: RoundingAdjustment[] }
interface Completed { result: ContentsResult; rounding: RoundingAdjustment[]; fileName: string }
const rowIdentity = (row: PayableImportRow) => JSON.stringify([row.entry_number, row.description, row.branch, row.plan, row.bank_account, row.source_status, row.amount_cents, row.due_date, row.issued_on, row.cheque_number ?? null]);
const definitiveFailures = ['P0065', 'P0061', 'P0058', 'P0059', 'P0060', 'PGRST202', '42883', '42P01', '40001', '42501', 'PGRST301', 'PGRST303', '22023', '23514', '23505', 'P0016', 'P0042', 'SOURCE_VALIDATION_FAILED'];
const sameReduction = (left: ContentsPreview, right: ContentsPreview) => left.previous_import_id === right.previous_import_id && left.financial_revision === right.financial_revision
  && left.previous_position_count === right.previous_position_count && left.removed_from_position_count === right.removed_from_position_count && left.marked_paid_cents === right.marked_paid_cents;

export default function PayableDailyImport({ canImport, onBusyChange }: { canImport: boolean; reportKind: 'ALL'; onBusyChange: (busy: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null), [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [reportContents, setReportContents] = useState<ReportContents | null>(null);
  const [busy, setBusy] = useState<'preparing' | 'saving' | null>(null), [pending, setPending] = useState<Frozen | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, boolean>>({});
  const [emptyReportConfirmed, setEmptyReportConfirmed] = useState(false);
  const [largeReductionConfirmed, setLargeReductionConfirmed] = useState(false);
  const [error, setError] = useState(''), [completed, setCompleted] = useState<Completed | null>(null), [problems, setProblems] = useState<ImportProblem[]>([]);
  const prepared = useRef<Prepared | null>(null), frozen = useRef<Frozen | null>(null), controller = useRef<AbortController | null>(null), busyRef = useRef(false), generation = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => { onBusyChange(!!busy || !!pending); return () => onBusyChange(false); }, [busy, pending, onBusyChange]);
  useEffect(() => {
    if (!pending && busy !== 'saving') return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [pending, busy]);
  function choicesFor(current: Analysis | null, checked: Record<string, boolean>) {
    const choices: Record<string, PayableResolutionChoice> = {};
    for (const item of current?.preview.exceptions ?? []) if (item.requires_resolution && item.allowed_actions.includes('WRITE_OFF') && checked[item.key]) choices[item.key] = { action: 'WRITE_OFF', reason: 'Baixa individual de R$ 0,01 confirmada na importação diária, sem pagamento e fora dos totais financeiros.' };
    return choices;
  }
  async function readPreview(selected: File, contents: ReportContents, checked: Record<string, boolean>, emptyConfirmed: boolean, confirmReduction: boolean, abort: AbortController, previous: Analysis | null) {
    const source = prepared.current?.file === selected && prepared.current.contents === contents && prepared.current.emptyReportConfirmed === emptyConfirmed ? prepared.current : { file: selected, contents, emptyReportConfirmed: emptyConfirmed, ...await analyzePayableFile(selected, abort.signal, emptyConfirmed, true) };
    if ('errors' in source && Array.isArray(source.errors) && source.errors.length) { setProblems(source.errors); setAnalysis(null); return null; }
    prepared.current = source;
    const body: ContentsRequest = { action: 'preview', mode: 'open_status', status_report_version: '065', report_kind: 'ALL', report_contents: contents, file_name: selected.name, file_base64: source.base64, mappings: {}, resolution_choices: choicesFor(previous, checked), confirm_large_reduction: confirmReduction, ...(emptyConfirmed ? { empty_report_confirmed: true } : {}) };
    const canonical = await payableReportContentsRequest<unknown>(body, abort.signal);
    if (!validContentsCanonical(canonical, source.hash, contents, emptyConfirmed, source.rounding_adjustments ?? [], confirmReduction)) throw new Error('invalid-preview');
    if (canonical.rows.length !== source.rows.length || canonical.rows.some((row, index) => rowIdentity(row) !== rowIdentity(source.rows[index]))
      || canonical.preview.exceptions.some(item => item.selected_action !== (body.resolution_choices?.[item.key]?.action ?? null))) throw new Error('invalid-source');
    return { ...canonical, source };
  }
  async function prepare(selected: File, contents: ReportContents, emptyConfirmed: boolean) {
    if (!canImport || busyRef.current || frozen.current) return;
    busyRef.current = true; setBusy('preparing'); setError(''); setProblems([]);
    const current = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    try {
      const next = await readPreview(selected, contents, {}, emptyConfirmed, false, abort, null);
      if (current !== generation.current || abort.signal.aborted) return;
      setAnalysis(next); if (next) setProblems(next.preview.errors);
    } catch (failure) {
      if (current !== generation.current || abort.signal.aborted) return;
      setAnalysis(null); setProblems(dailyProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : []));
      setError(contentsImportError(failure, 'Não foi possível preparar este relatório. O arquivo está selecionado; tente importar novamente. Nenhum dado foi alterado por esta preparação.'));
    } finally { if (current === generation.current) { busyRef.current = false; setBusy(null); } }
  }
  async function execute(request: Frozen, alreadyBusy = false) {
    if (busyRef.current && !alreadyBusy) return;
    frozen.current = request; busyRef.current = true; setPending(request); setBusy('saving'); setError('');
    try {
      const result = await payableReportContentsRequest<unknown>(request.body);
      if (!validContentsResult(result, request.body, request.rows, request.rounding) || result.marked_paid_count !== request.markedPaid || result.marked_paid_cents !== request.nominalPaid || result.reopened_count !== request.reopened || result.written_off_count !== request.writtenOff || result.new_count !== request.newCount || result.open_count !== request.openCount || result.updated_count !== request.changed || result.position_count !== request.positionCount || result.previous_position_count !== request.previousPositionCount || result.removed_from_position_count !== request.removedCount) throw new Error('unconfirmed');
      frozen.current = null; setPending(null); setCompleted({ result, rounding: request.rounding, fileName: request.body.file_name });
      setAnalysis(null); prepared.current = null; setFile(null); setReportContents(null); setConfirmations({}); setEmptyReportConfirmed(false); setLargeReductionConfirmed(false); setProblems([]); if (input.current) input.current.value = '';
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      if (definitiveFailures.includes(code)) { frozen.current = null; setPending(null); }
      setProblems(dailyProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : []));
      setError(contentsImportError(failure, 'A confirmação do resultado não chegou. O arquivo e o protocolo estão preservados. Confira o mesmo envio pelo botão abaixo.'));
    } finally { busyRef.current = false; setBusy(null); }
  }
  async function importReport() {
    if (!file || !reportContents || !canImport || busyRef.current || frozen.current) return;
    busyRef.current = true; setBusy('preparing'); setError(''); setCompleted(null); setProblems([]);
    const current = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    try {
      const next = await readPreview(file, reportContents, confirmations, emptyReportConfirmed, largeReductionConfirmed, abort, analysis);
      if (current !== generation.current || abort.signal.aborted || !next) return;
      setAnalysis(next); setProblems(next.preview.errors);
      if (largeReductionConfirmed && analysis && next.preview.requires_large_reduction_confirmation && !sameReduction(analysis.preview, next.preview)) {
        setLargeReductionConfirmed(false); setError('A posição da carteira mudou. Confira a redução atualizada e confirme novamente se o arquivo contém todos os títulos em aberto.'); return;
      }
      if (!next.preview.can_commit || next.preview.errors.length) { setError('Confira os problemas indicados e as confirmações abaixo antes de importar. Nenhum dado foi alterado por esta preparação.'); return; }
      const p = next.preview;
      const body: ContentsRequest = { action: 'commit', mode: 'open_status', status_report_version: '065', report_kind: 'ALL', report_contents: next.source.contents, file_name: next.source.file.name, file_base64: next.source.base64, mappings: {}, resolution_choices: choicesFor(next, confirmations), confirm_large_reduction: largeReductionConfirmed, complete: true, previous_import_id: p.previous_import_id, previous_financial_revision: p.financial_revision, expected_report_date: p.report_date, request_id: crypto.randomUUID(), ...(next.source.emptyReportConfirmed ? { empty_report_confirmed: true } : {}) };
      await execute({ body, rows: p.row_count, markedPaid: p.marked_paid_count, nominalPaid: p.marked_paid_cents, reopened: p.reopened_count, writtenOff: Object.keys(body.resolution_choices ?? {}).length, newCount: p.new_count, openCount: p.open_count, changed: p.changed_count, positionCount: p.position_count, previousPositionCount: p.previous_position_count, removedCount: p.removed_from_position_count, rounding: structuredClone(next.source.rounding_adjustments ?? []) }, true);
    } catch (failure) {
      if (current !== generation.current || abort.signal.aborted) return;
      setProblems(dailyProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : []));
      setError(contentsImportError(failure, 'Não foi possível importar este relatório. Confira os problemas indicados e tente novamente. Nenhum dado foi alterado por esta preparação.'));
    } finally { if (current === generation.current) { busyRef.current = false; setBusy(null); } }
  }
  function changeContents(contents: ReportContents) {
    if (busyRef.current || frozen.current || contents === reportContents) return;
    generation.current++; controller.current?.abort(); prepared.current = null;
    setReportContents(contents); setFile(null); setAnalysis(null); setConfirmations({}); setEmptyReportConfirmed(false); setLargeReductionConfirmed(false); setProblems([]); setError(''); setCompleted(null);
    if (input.current) input.current.value = '';
  }
  const disabled = !!busy || !!pending, cents = (analysis?.preview.exceptions ?? []).filter(item => item.requires_resolution);
  const centConfirmed = cents.every(item => item.allowed_actions.includes('WRITE_OFF') && confirmations[item.key]);
  const isCentConfirmationProblem = (problem: ImportProblem) => problem.column === 'Baixa sem pagamento' && cents.some(item => item.allowed_actions.includes('WRITE_OFF') && item.problem === problem.problem && (item.line ?? 0) === problem.line);
  const reductionRequired = reportContents === 'FULL_OPEN' && analysis?.preview.requires_large_reduction_confirmation === true;
  const isReductionConfirmationProblem = (problem: ImportProblem) => reductionRequired && (problem as ImportProblem & { code?: string }).code === 'LARGE_REDUCTION_CONFIRMATION'
    && problem.column === 'Abrangência do relatório' && problem.problem === analysis?.preview.large_reduction_problem;
  const hardProblems = problems.filter(problem => !isCentConfirmationProblem(problem) && !isReductionConfirmationProblem(problem));
  const visibleProblems = problems.filter(problem => (!isCentConfirmationProblem(problem) || cents.some(item => !confirmations[item.key] && item.problem === problem.problem && (item.line ?? 0) === problem.line))
    && (!isReductionConfirmationProblem(problem) || !largeReductionConfirmed));
  return <section className="panel stack" aria-labelledby="payable-daily-title">
    <div><h2 id="payable-daily-title">Importar relatório diário de Contas a Pagar</h2><p>Escolha o conteúdo do arquivo antes de importar. A Central aplica as alterações aos títulos sem criar pagamentos financeiros.</p></div>
    <fieldset className="stack" disabled={disabled || !canImport}><legend>Conteúdo do relatório</legend>
      <label className="checkbox-field"><input type="radio" name="payable-report-contents" value="FULL_OPEN" checked={reportContents === 'FULL_OPEN'} onChange={() => changeContents('FULL_OPEN')} required />Todos os títulos em aberto</label>
      <p className="help-text">Relação completa de todas as filiais, incluindo novos lançamentos e cheques. Atualiza valores e vencimentos; títulos ausentes recebem o status Pago.</p>
      <label className="checkbox-field"><input type="radio" name="payable-report-contents" value="PAID_STATUS" checked={reportContents === 'PAID_STATUS'} onChange={() => changeContents('PAID_STATUS')} required />Somente títulos baixados</label>
      <p className="help-text">Baixa somente os títulos relacionados no arquivo. Os demais títulos em aberto são preservados.</p>
    </fieldset>
    {reportContents && <p className="notice">{reportContents === 'FULL_OPEN' ? 'Confira se o arquivo contém todos os títulos ainda em aberto. Um arquivo apenas de novos títulos ou de baixados não representa a carteira completa.' : 'Os títulos listados receberão o status Pago. Use títulos já cadastrados na Central; títulos ausentes deste arquivo permanecem na carteira.'} A mudança de status preserva os pagamentos financeiros já registrados e seus históricos.</p>}
    <label className="field">Relatório diário de Contas a Pagar<input ref={input} aria-label="Relatório diário de Contas a Pagar" type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={disabled || !canImport || !reportContents} onChange={event => {
      if (busyRef.current || frozen.current || !reportContents) return;
      const selected = event.target.files?.[0] ?? null; generation.current++; controller.current?.abort(); prepared.current = null; setFile(selected); setAnalysis(null); setConfirmations({}); setEmptyReportConfirmed(false); setLargeReductionConfirmed(false); setProblems([]); setError(''); setCompleted(null);
      if (selected) void prepare(selected, reportContents, false);
    }} /></label><p className="help-text">Até 2 MiB e 5.000 títulos. .xlsx, .xlsm ou .csv UTF-8. O original será preservado. Valores com mais de duas casas serão arredondados por título para centavos e detalhados após a importação.</p>
    {reportContents === 'FULL_OPEN' && <label className="checkbox-field"><input type="checkbox" aria-label="Confirmo que o relatório completo não contém títulos em aberto" checked={emptyReportConfirmed} disabled={disabled || !file || !canImport} onChange={event => {
      if (busyRef.current || frozen.current || !file) return;
      const confirmed = event.target.checked; setEmptyReportConfirmed(confirmed); setLargeReductionConfirmed(false); setAnalysis(null); prepared.current = null; setProblems([]); setConfirmations({}); setError(''); void prepare(file, 'FULL_OPEN', confirmed);
    }} />Confirmo que o relatório completo não contém títulos em aberto. Use somente para um arquivo com os cabeçalhos, quando não restar nenhum título aberto.</label>}
    {busy && <p role="status">{busy === 'saving' ? 'Importando relatório e atualizando os títulos…' : 'Preparando relatório…'}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {pending && !busy && <div className="notice" role="status"><p>A confirmação está pendente. Mantenha esta tela para conferir o mesmo arquivo e protocolo.</p><button type="button" className="button secondary" disabled={!!busy} onClick={() => void execute(pending)}>Conferir importação diária pendente</button></div>}
    {!!visibleProblems.length && <div className="table-wrap"><table><caption>Problemas do relatório diário</caption><thead><tr><th>Linha</th><th>Campo</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{visibleProblems.slice(0, 100).map((problem, index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div>}
    {reductionRequired && analysis && <section className="stack notice" aria-label="Conferência de redução do relatório completo"><h3>Confira os títulos ausentes</h3><p>A posição anterior contém <strong>{analysis.preview.previous_position_count} título(s)</strong>. Este arquivo contém <strong>{analysis.preview.row_count}</strong> e deixa <strong>{analysis.preview.removed_from_position_count} título(s)</strong> da posição anterior de fora. Confira se é a relação completa dos que continuam em aberto.</p><p>Nesta importação, <strong>{analysis.preview.marked_paid_count} título(s)</strong> ausente(s) receberão o status Pago.</p><label className="checkbox-field"><input type="checkbox" aria-label="Confirmo que este arquivo contém todos os títulos em aberto, mesmo com a redução indicada" checked={largeReductionConfirmed} disabled={disabled || !canImport} onChange={event => { if (busyRef.current || frozen.current) return; setLargeReductionConfirmed(event.target.checked); setError(''); }} />Confirmo que este arquivo contém todos os títulos em aberto, mesmo com a redução indicada.</label></section>}
    {!!cents.length && <section className="stack" aria-label="Baixas individuais de R$ 0,01"><h3>Baixas de R$ 0,01</h3><p>Confirme cada título abaixo. Essas baixas encerram o título sem pagamento e ficam fora das somas financeiras.</p>{cents.map(item => <article className="payable-import-review-item" key={item.key}><h4>Lançamento {item.entry_number} · Filial {item.branch}</h4><p>{item.description}</p><p className="help-text">Vencimento {dateLabel(item.due_date)}{item.cheque_number ? ` · Cheque ${item.cheque_number}` : ''}</p><label className="checkbox-field"><input type="checkbox" aria-label={`Confirmar baixa diária de R$ 0,01 do lançamento ${item.entry_number} filial ${item.branch}`} disabled={disabled || !item.allowed_actions.includes('WRITE_OFF')} checked={!!confirmations[item.key]} onChange={event => { setConfirmations(previous => ({ ...previous, [item.key]: event.target.checked })); setError(''); }} />Confirmo a baixa deste título de R$ 0,01, sem pagamento e sem incluir o valor nos totais.</label></article>)}</section>}
    {!pending && <button type="button" className="button" disabled={!file || !reportContents || !canImport || disabled || !centConfirmed || reductionRequired && !largeReductionConfirmed || hardProblems.length > 0} onClick={() => void importReport()}>Importar relatório</button>}
    {completed && <section className="stack" aria-label="Resultado da importação diária"><p className="notice success" role="status">{completed.result.idempotent ? 'Este envio já estava concluído, sem duplicar títulos ou baixas.' : 'Importação diária concluída.'} {completed.result.row_count} título(s) no relatório, {completed.result.new_count} novo(s), {completed.result.open_count} existente(s), {completed.result.updated_count} atualizado(s), {completed.result.marked_paid_count} com status Pago, {completed.result.reopened_count} retorno(s) à previsão e {completed.result.written_off_count} baixa(s) de R$ 0,01 sem pagamento.</p><p>Arquivo: {completed.fileName} · Conteúdo: {completed.result.report_contents === 'FULL_OPEN' ? 'Todos os títulos em aberto' : 'Somente títulos baixados'} · Importado em {dateLabel(completed.result.report_date)}. {completed.result.report_contents === 'PAID_STATUS' && 'Os demais títulos da carteira foram preservados. '}Nenhum pagamento financeiro foi criado por esta importação.</p>{completed.rounding.length > 0 && <details><summary>{completed.rounding.length} ajuste(s) de arredondamento para centavos</summary><div className="table-wrap"><table><caption>Valores arredondados por título</caption><thead><tr><th>Linha</th><th>Valor da origem (R$)</th><th>Valor importado</th></tr></thead><tbody>{completed.rounding.map(item => <tr key={item.line}><td>{item.line}</td><td>{item.original_amount}</td><td>{formatCents(item.amount_cents)}</td></tr>)}</tbody></table></div></details>}</section>}
  </section>;
}
