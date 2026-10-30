import { useEffect, useRef, useState } from 'react';
import { analyzePayableFile, dateLabel, formatCents, type ImportProblem, type PayableImportRow, type PayableResolutionChoice } from '../lib/payables';
import { dailyProblems } from '../lib/payable-daily';
import { openStatusImportError, payableOpenStatusRequest, validOpenStatusCanonical, validOpenStatusResult, type OpenStatusCanonical, type OpenStatusRequest, type OpenStatusResult } from '../lib/payable-open-status';

type RoundingAdjustment = { line: number; original_amount: string; amount_cents: number };
interface Prepared { file: File; base64: string; hash: string; rows: PayableImportRow[]; emptyReportConfirmed: boolean; rounding_adjustments?: RoundingAdjustment[] }
interface Analysis extends OpenStatusCanonical { source: Prepared }
interface Frozen { body: OpenStatusRequest; rows: number; markedPaid: number; nominalPaid: number; reopened: number; writtenOff: number; newCount: number; openCount: number; changed: number; rounding: RoundingAdjustment[] }
interface Completed { result: OpenStatusResult; rounding: RoundingAdjustment[]; fileName: string }
const rowIdentity = (row: PayableImportRow) => JSON.stringify([row.entry_number, row.description, row.branch, row.plan, row.bank_account, row.source_status, row.amount_cents, row.due_date, row.issued_on, row.cheque_number ?? null]);
const definitiveFailures = ['P0061', 'P0058', 'P0059', 'P0060', 'PGRST202', '42883', '42P01', '40001', '42501', 'PGRST301', 'PGRST303', '22023', '23514', '23505', 'P0016', 'P0042', 'SOURCE_VALIDATION_FAILED'];

export default function PayableDailyImport({ canImport, onBusyChange }: { canImport: boolean; reportKind: 'ALL'; onBusyChange: (busy: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null), [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<'preparing' | 'saving' | null>(null), [pending, setPending] = useState<Frozen | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, boolean>>({});
  const [emptyReportConfirmed, setEmptyReportConfirmed] = useState(false);
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
  async function readPreview(selected: File, checked: Record<string, boolean>, emptyConfirmed: boolean, abort: AbortController, previous: Analysis | null) {
    const source = prepared.current?.file === selected && prepared.current.emptyReportConfirmed === emptyConfirmed ? prepared.current : { file: selected, emptyReportConfirmed: emptyConfirmed, ...await analyzePayableFile(selected, abort.signal, emptyConfirmed, true) };
    if ('errors' in source && Array.isArray(source.errors) && source.errors.length) { setProblems(source.errors); setAnalysis(null); return null; }
    prepared.current = source;
    const body: OpenStatusRequest = { action: 'preview', mode: 'open_status', status_report_version: '061', report_kind: 'ALL', file_name: selected.name, file_base64: source.base64, mappings: {}, resolution_choices: choicesFor(previous, checked), ...(emptyConfirmed ? { empty_report_confirmed: true } : {}) };
    const canonical = await payableOpenStatusRequest<unknown>(body, abort.signal);
    if (!validOpenStatusCanonical(canonical, source.hash, emptyConfirmed, source.rounding_adjustments ?? [])) throw new Error('invalid-preview');
    if (canonical.rows.length !== source.rows.length || canonical.rows.some((row, index) => rowIdentity(row) !== rowIdentity(source.rows[index]))
      || canonical.preview.exceptions.some(item => item.selected_action !== (body.resolution_choices?.[item.key]?.action ?? null))) throw new Error('invalid-source');
    return { ...canonical, source };
  }
  async function prepare(selected: File, emptyConfirmed: boolean) {
    if (!canImport || busyRef.current || frozen.current) return;
    busyRef.current = true; setBusy('preparing'); setError(''); setProblems([]);
    const current = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    try {
      const next = await readPreview(selected, {}, emptyConfirmed, abort, null);
      if (current !== generation.current || abort.signal.aborted) return;
      setAnalysis(next); if (next) setProblems(next.preview.errors);
    } catch (failure) {
      if (current !== generation.current || abort.signal.aborted) return;
      setAnalysis(null); setProblems(dailyProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : []));
      setError(openStatusImportError(failure, 'Não foi possível preparar este relatório. O arquivo está selecionado; tente importar novamente. Nenhum dado foi alterado por esta preparação.'));
    } finally { if (current === generation.current) { busyRef.current = false; setBusy(null); } }
  }
  async function execute(request: Frozen, alreadyBusy = false) {
    if (busyRef.current && !alreadyBusy) return;
    frozen.current = request; busyRef.current = true; setPending(request); setBusy('saving'); setError('');
    try {
      const result = await payableOpenStatusRequest<unknown>(request.body);
      if (!validOpenStatusResult(result, request.body, request.rows, request.rounding) || result.marked_paid_count !== request.markedPaid || result.marked_paid_cents !== request.nominalPaid || result.reopened_count !== request.reopened || result.written_off_count !== request.writtenOff || result.new_count !== request.newCount || result.open_count !== request.openCount || result.updated_count !== request.changed) throw new Error('unconfirmed');
      frozen.current = null; setPending(null); setCompleted({ result, rounding: request.rounding, fileName: request.body.file_name });
      setAnalysis(null); prepared.current = null; setFile(null); setConfirmations({}); setEmptyReportConfirmed(false); setProblems([]); if (input.current) input.current.value = '';
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      if (definitiveFailures.includes(code)) { frozen.current = null; setPending(null); }
      setProblems(dailyProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : []));
      setError(openStatusImportError(failure, 'A confirmação do resultado não chegou. O arquivo e o protocolo estão preservados. Confira o mesmo envio pelo botão abaixo.'));
    } finally { busyRef.current = false; setBusy(null); }
  }
  async function importReport() {
    if (!file || !canImport || busyRef.current || frozen.current) return;
    busyRef.current = true; setBusy('preparing'); setError(''); setCompleted(null); setProblems([]);
    const current = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    try {
      const next = await readPreview(file, confirmations, emptyReportConfirmed, abort, analysis);
      if (current !== generation.current || abort.signal.aborted || !next) return;
      setAnalysis(next); setProblems(next.preview.errors);
      if (!next.preview.can_commit || next.preview.errors.length) { setError('Confirme individualmente as baixas de R$ 0,01 indicadas abaixo. As alterações de valor e vencimento serão aplicadas automaticamente.'); return; }
      const p = next.preview;
      const body: OpenStatusRequest = { action: 'commit', mode: 'open_status', status_report_version: '061', report_kind: 'ALL', file_name: next.source.file.name, file_base64: next.source.base64, mappings: {}, resolution_choices: choicesFor(next, confirmations), complete: true, previous_import_id: p.previous_import_id, previous_financial_revision: p.financial_revision, expected_report_date: p.report_date, request_id: crypto.randomUUID(), ...(next.source.emptyReportConfirmed ? { empty_report_confirmed: true } : {}) };
      await execute({ body, rows: p.row_count, markedPaid: p.marked_paid_count, nominalPaid: p.marked_paid_cents, reopened: p.reopened_count, writtenOff: Object.keys(body.resolution_choices ?? {}).length, newCount: p.new_count, openCount: p.open_count, changed: p.changed_count, rounding: structuredClone(next.source.rounding_adjustments ?? []) }, true);
    } catch (failure) {
      if (current !== generation.current || abort.signal.aborted) return;
      setProblems(dailyProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : []));
      setError(openStatusImportError(failure, 'Não foi possível importar este relatório. Confira os problemas indicados e tente novamente. Nenhum dado foi alterado por esta preparação.'));
    } finally { if (current === generation.current) { busyRef.current = false; setBusy(null); } }
  }
  const disabled = !!busy || !!pending, cents = (analysis?.preview.exceptions ?? []).filter(item => item.requires_resolution);
  const centConfirmed = cents.every(item => item.allowed_actions.includes('WRITE_OFF') && confirmations[item.key]);
  const isCentConfirmationProblem = (problem: ImportProblem) => problem.column === 'Baixa sem pagamento' && cents.some(item => item.allowed_actions.includes('WRITE_OFF') && item.problem === problem.problem && (item.line ?? 0) === problem.line);
  const hardProblems = problems.filter(problem => !isCentConfirmationProblem(problem));
  const visibleProblems = problems.filter(problem => !isCentConfirmationProblem(problem) || cents.some(item => !confirmations[item.key] && item.problem === problem.problem && (item.line ?? 0) === problem.line));
  return <section className="panel stack" aria-labelledby="payable-daily-title">
    <div><h2 id="payable-daily-title">Importar relatório diário de Contas a Pagar</h2><p>Selecione a relação completa de abertos e clique em Importar relatório. Novos lançamentos, valores e vencimentos serão atualizados automaticamente.</p></div>
    <p className="notice">Use o relatório completo de todas as filiais, incluindo cheques. Títulos que saírem do relatório seguinte receberão o status Pago. Essa mudança de status não cria valor realizado, data real ou banco de pagamento. Os pagamentos já registrados permanecem no histórico.</p>
    <label className="field">Relatório completo diário de Contas a Pagar<input ref={input} aria-label="Relatório completo diário de Contas a Pagar" type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={disabled || !canImport} onChange={event => {
      if (busyRef.current || frozen.current) return;
      const selected = event.target.files?.[0] ?? null; generation.current++; controller.current?.abort(); prepared.current = null; setFile(selected); setAnalysis(null); setConfirmations({}); setEmptyReportConfirmed(false); setProblems([]); setError(''); setCompleted(null);
      if (selected) void prepare(selected, false);
    }} /></label><p className="help-text">Até 2 MiB e 5.000 títulos. .xlsx, .xlsm ou .csv UTF-8. Um arquivo parcial pode baixar títulos indevidamente. O original será preservado. Valores com mais de duas casas serão arredondados por título para centavos e detalhados após a importação.</p>
    <label className="checkbox-field"><input type="checkbox" aria-label="Confirmo que o relatório completo não contém títulos em aberto" checked={emptyReportConfirmed} disabled={disabled || !file || !canImport} onChange={event => {
      if (busyRef.current || frozen.current || !file) return;
      const confirmed = event.target.checked; setEmptyReportConfirmed(confirmed); setAnalysis(null); prepared.current = null; setProblems([]); setConfirmations({}); setError(''); void prepare(file, confirmed);
    }} />Confirmo que o relatório completo não contém títulos em aberto. Use somente para um arquivo com os cabeçalhos, quando não restar nenhum título aberto.</label>
    {busy && <p role="status">{busy === 'saving' ? 'Importando relatório e atualizando os títulos…' : 'Preparando relatório…'}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {pending && !busy && <div className="notice" role="status"><p>A confirmação está pendente. Mantenha esta tela para conferir o mesmo arquivo e protocolo.</p><button type="button" className="button secondary" disabled={!!busy} onClick={() => void execute(pending)}>Conferir importação diária pendente</button></div>}
    {!!visibleProblems.length && <div className="table-wrap"><table><caption>Problemas do relatório diário</caption><thead><tr><th>Linha</th><th>Campo</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{visibleProblems.slice(0, 100).map((problem, index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div>}
    {!!cents.length && <section className="stack" aria-label="Baixas individuais de R$ 0,01"><h3>Baixas de R$ 0,01</h3><p>Confirme cada título abaixo. Essas baixas encerram o título sem pagamento e ficam fora das somas financeiras.</p>{cents.map(item => <article className="payable-import-review-item" key={item.key}><h4>Lançamento {item.entry_number} · Filial {item.branch}</h4><p>{item.description}</p><p className="help-text">Vencimento {dateLabel(item.due_date)}{item.cheque_number ? ` · Cheque ${item.cheque_number}` : ''}</p><label className="checkbox-field"><input type="checkbox" aria-label={`Confirmar baixa diária de R$ 0,01 do lançamento ${item.entry_number} filial ${item.branch}`} disabled={disabled || !item.allowed_actions.includes('WRITE_OFF')} checked={!!confirmations[item.key]} onChange={event => { setConfirmations(previous => ({ ...previous, [item.key]: event.target.checked })); setError(''); }} />Confirmo a baixa deste título de R$ 0,01, sem pagamento e sem incluir o valor nos totais.</label></article>)}</section>}
    {!pending && <button type="button" className="button" disabled={!file || !canImport || disabled || !centConfirmed || hardProblems.length > 0} onClick={() => void importReport()}>Importar relatório</button>}
    {completed && <section className="stack" aria-label="Resultado da importação diária"><p className="notice success" role="status">{completed.result.idempotent ? 'Este envio já estava concluído, sem duplicar títulos ou baixas.' : 'Importação diária concluída.'} {completed.result.row_count} título(s) no relatório, {completed.result.new_count} novo(s), {completed.result.open_count} existente(s), {completed.result.updated_count} atualizado(s), {completed.result.marked_paid_count} com status Pago, {completed.result.reopened_count} retorno(s) à previsão e {completed.result.written_off_count} baixa(s) de R$ 0,01 sem pagamento.</p><p>Arquivo: {completed.fileName} · Importado em {dateLabel(completed.result.report_date)}. Nenhum pagamento financeiro foi criado por esta importação.</p>{completed.rounding.length > 0 && <details><summary>{completed.rounding.length} ajuste(s) de arredondamento para centavos</summary><div className="table-wrap"><table><caption>Valores arredondados por título</caption><thead><tr><th>Linha</th><th>Valor da origem (R$)</th><th>Valor importado</th></tr></thead><tbody>{completed.rounding.map(item => <tr key={item.line}><td>{item.line}</td><td>{item.original_amount}</td><td>{formatCents(item.amount_cents)}</td></tr>)}</tbody></table></div></details>}</section>}
  </section>;
}
