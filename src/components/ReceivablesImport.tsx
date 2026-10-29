import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { analyzeReceivableFile, analyzeReceivableReceivedFile, dateLabel, formatCents, RECEIVABLE_SCOPE, receivableError, receivableImportRequest, makeReceivableFailure, receivableFailureReference, receivableImportFailureMessage, type ImportProblem, type ReceivableImportRow, type ReceivableImportRequestBody } from '../lib/receivables';

import { officialToday } from './Treasury';
import { resolveReceivableCollectorHints, type CollectorHintSummary } from '../lib/receivable-collector-plan.mjs';
import type { ReceivableCollectorHint } from '../lib/receivables-parser.mjs';

type Mode = 'open' | 'received';
interface Batch { id: string; file_name: string; created_at: string; row_count: number; new_count: number; open_count: number; pending_count: number; validated_in_source_count: number; import_mode?: string }
interface Candidate { id: string; due_date: string; amount_cents: number; status: string; collector_id: string | null }
interface Collector { id: string; display_name: string; enabled: boolean }
interface Assignment { customer_key: string; client_name: string; client_document: string | null; collector_id: string | null; collector_name: string | null; row_count: number; requires_selection: boolean; locked: boolean }
interface PreviewRow extends ReceivableImportRow { line: number; title_id?: string | null; outcome: string; identity_outcome?: string; candidates?: Candidate[]; received_on?: string; received_amount_cents?: number }
interface RetirementItem { title_id: string; client_name: string; document: string; branch: string; due_date: string; amount_cents: number; collector_id: string | null; worked: boolean }
interface ReturnItem { line: number; title_id: string; document: string; client_name: string; branch: string; due_date: string; amount_cents: number; reason_kind: 'VALIDATED' | 'RETIRED'; expected_revision: number; retired_from_report: boolean; receipt_id: string | null; receipt_fingerprint: string; received_amount_cents: number | null; payment_date: string | null; source_row: Record<string, unknown>; source_fingerprint: string; approval_id: string | null; approved_by: string | null; approved_at: string | null; can_approve: boolean; collector_id?: string | null; requires_collector_assignment?: boolean }
interface ReturnApprovalRequest { p_title_id: string; p_expected_revision: number; p_expected_receipt_id: string | null; p_expected_receipt_fingerprint: string; p_source_row: Record<string, unknown>; p_reason: string; p_request_id: string }
interface PendingReturnApproval { body: ReturnApprovalRequest; fingerprint: string }
interface Preview {
  format_version?: string; full_report?: boolean; reference_date?: string; retired_count?: number; retired_worked_count?: number; retired_unworked_count?: number; reappeared_count?: number; retirement_items?: RetirementItem[];
  mode: Mode; previous_import_id: string | null; financial_revision: string; row_count: number;
  new_count: number; open_count?: number; changed_count?: number; pending_count?: number; validated_in_source_count?: number;
  received_count?: number; matched_count?: number; correction_count?: number; historical_count?: number;
  conflict_count: number; can_commit: boolean; errors?: ImportProblem[];
  collector_assignment_version?: string; customer_collector_assignments?: Assignment[]; missing_collector_count?: number;
  return_approval_version?: string; return_count?: number; return_unapproved_count?: number; return_items?: ReturnItem[];
}
interface Analysis { file: File; mode: Mode; base64: string; rows: PreviewRow[]; preview: Preview; nominalTotal: number; receivedTotal: number; titleMappings: Record<string, string>; collectorMappings: Record<string, string>; collectorHints?: ReceivableCollectorHint[]; collectorSummary?: CollectorHintSummary }
interface ServerPreview { rows: PreviewRow[]; preview: Preview; file_sha256: string }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(new Date(value).getTime());
const countFields = ['new_count', 'open_count', 'changed_count', 'pending_count', 'validated_in_source_count', 'received_count', 'matched_count', 'correction_count', 'historical_count', 'conflict_count'] as const;
const outcomes: Record<string, string> = { NEW: 'Nova parcela', UPDATE: 'Atualizar título', MATCHED: 'Já identificado', AMBIGUOUS: 'Escolher vínculo da parcela', CONFLICT: 'Conflito a conferir', NEW_RECEIPT: 'Confirmar recebimento', CORRECTION: 'Corrigir recebimento importado', HISTORICAL: 'Incluir quitado do histórico' };
function ambiguous(row: PreviewRow) { return row.outcome === 'AMBIGUOUS' || row.identity_outcome === 'AMBIGUOUS'; }
function unappliedTitleMappings(analysis: Analysis) { return analysis.rows.some(row => row.outcome !== 'CONFLICT' && ambiguous(row) && Object.hasOwn(analysis.titleMappings, String(row.line))); }
function returnActivationMissing(analysis: Analysis) { return analysis.mode === 'open' && (analysis.preview.validated_in_source_count ?? 0) > 0 && analysis.preview.return_approval_version !== '057'; }
function validatedOpenSummary(analysis: Analysis) {
  const count = analysis.preview.validated_in_source_count ?? 0;
  const rows = analysis.rows.filter(row => {
    if (typeof row.title_id !== 'string' || !uuid.test(row.title_id) || !row.candidates) return false;
    const selected = row.candidates.filter(candidate => candidate.id === row.title_id);
    return selected.length === 1 && selected[0].status === 'VALIDATED';
  });
  const total = rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n);
  const complete = count > 0 && count === rows.length && new Set(rows.map(row => row.title_id)).size === rows.length
    && total <= BigInt(analysis.nominalTotal);
  return { count, rows, excluded: complete ? Number(total) : null, unpaid: complete ? analysis.nominalTotal - Number(total) : null };
}
function ValidatedOpenReconciliation({ analysis }: { analysis: Analysis }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [analysis]);
  const summary = validatedOpenSummary(analysis), pages = Math.max(1, Math.ceil(summary.rows.length / 25)), current = Math.min(page, pages - 1);
  if (!summary.count) return null;
  return <section className="notice stack" aria-labelledby="validated-open-reconciliation-title">
    <h4 id="validated-open-reconciliation-title">Quitados presentes no relatório de abertos</h4>
    <p>{summary.count} título(s) já quitado(s) reaparecem no relatório. A importação não reabre esses títulos.</p>
    <p>Esses títulos ficam fora do saldo da carteira ativa. Confira a quitação na Central e a situação no sistema de origem antes de concluir a conciliação.</p>
    {summary.excluded !== null ? <><p><strong>Valor original do arquivo já quitado na Central: {formatCents(summary.excluded)}</strong></p><p><strong>Valor do arquivo ainda não quitado na Central: {formatCents(summary.unpaid!)}</strong></p><p className="help-text">A diferença usa o valor original dos títulos no arquivo. O valor efetivamente recebido pode ser diferente. Estes valores conferem as linhas deste arquivo; arquivos de inclusão e atualização preservam também os demais títulos da carteira.</p></>
      : <p>Os vínculos detalhados de todos os títulos quitados não vieram nesta análise. O valor total excluído não foi calculado. Confira os títulos na Central para esclarecer a diferença.</p>}
    {summary.rows.length > 0 && <><div className="table-wrap"><table><caption>Títulos já quitados identificados nesta análise</caption><thead><tr><th>Linha</th><th>Cliente / NF</th><th>Filial</th><th>Vencimento original</th><th>Valor original no arquivo</th></tr></thead><tbody>{summary.rows.slice(current * 25, (current + 1) * 25).map(row => <tr key={row.line}><td>{row.line + 1}</td><td>{row.client_name} · {row.document}</td><td>{row.branch}</td><td>{dateLabel(row.due_date)}</td><td>{formatCents(row.amount_cents)}</td></tr>)}</tbody></table></div>
      {pages > 1 && <div className="inline-actions"><button type="button" className="button secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>Quitados anteriores</button><span>Página {current + 1} de {pages}</span><button type="button" className="button secondary" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>Próximos quitados</button></div>}</>}
  </section>;
}
function returnApprovalMessage(failure: unknown) {
  const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
  if (['PGRST202', 'PGRST205', '42P01', '42703', '42883'].includes(code)) return 'Ative o SQL 057 de aprovação dos retornos no banco de dados e analise o arquivo novamente.';
  if (code === '42501') return 'Somente a Gerência autorizada pode aprovar o retorno. Confira o acesso antes de continuar.';
  if (code === '40001') return 'O título, o recebimento ou a aprovação mudou. Analise o arquivo novamente antes de aprovar.';
  if (['PGRST301', 'PGRST303'].includes(code)) return 'Sua sessão expirou. Entre novamente antes de aprovar.';
  return 'A aprovação foi recusada. Confira o título, a justificativa e a análise atual antes de continuar.';
}
function ReturnApprovals({ analysis, isManager, currentUserId, disabled, onPendingChange, onApproved }: { analysis: Analysis; isManager: boolean; currentUserId: string | null; disabled: boolean; onPendingChange: (pending: boolean) => void; onApproved: () => void }) {
  const [reasons, setReasons] = useState<Record<string, string>>({}), [pending, setPending] = useState<PendingReturnApproval | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const items = analysis.preview.return_items ?? [];
  async function execute(request: PendingReturnApproval) {
    if (!isManager || !currentUserId || busy) return;
    setBusy(true); setPending(request); setError(''); onPendingChange(true);
    try {
      if (!supabase) throw { code: 'PGRST301' };
      const result = await supabase.rpc('approve_receivable_report_return', request.body).retry(false);
      if (result.error) throw result.error;
      const proof = result.data, body = request.body;
      if (!proof || proof.format_version !== '057' || proof.request_id !== body.p_request_id || proof.title_id !== body.p_title_id || proof.title_revision !== body.p_expected_revision
        || proof.receipt_id !== body.p_expected_receipt_id || proof.receipt_fingerprint !== body.p_expected_receipt_fingerprint || proof.source_fingerprint !== request.fingerprint || proof.approved_by !== currentUserId || !uuid.test(proof.approval_id ?? '') || !instant(proof.approved_at)) throw new Error('invalid_return_approval_result');
      setPending(null); onPendingChange(false); onApproved();
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      if (['22023', '23514', '40001', '42501', 'P0057', 'P0002', '23505', '22003', 'PGRST202', 'PGRST205', '42P01', '42703', '42883', 'PGRST301', 'PGRST303'].includes(code)) { setPending(null); onPendingChange(false); setError(returnApprovalMessage(failure)); }
      else setError('Não foi possível confirmar o resultado da aprovação. Mantenha esta tela aberta e confira o mesmo protocolo antes de continuar. Nenhum retorno será aplicado antes da importação final.');
    } finally { setBusy(false); }
  }
  function approve(item: ReturnItem) {
    const reason = reasons[item.title_id]?.trim() ?? '';
    if (disabled || pending || busy || !isManager || !item.can_approve || !reason || reason.length > 5000) return;
    if (!window.confirm(`Aprovar o retorno da NF ${item.document}, filial ${item.branch}?\n\nValor original: ${formatCents(item.amount_cents)}.\nMotivo: ${reason}\n\nA aprovação registra sua autorização. O retorno e eventual estorno só serão aplicados ao concluir esta importação.`)) return;
    void execute({ body: { p_title_id: item.title_id, p_expected_revision: item.expected_revision, p_expected_receipt_id: item.receipt_id, p_expected_receipt_fingerprint: item.receipt_fingerprint, p_source_row: JSON.parse(JSON.stringify(item.source_row)), p_reason: reason, p_request_id: crypto.randomUUID() }, fingerprint: item.source_fingerprint });
  }
  return <section className="notice stack" aria-labelledby="return-approvals-title"><h3 id="return-approvals-title">Retornos para conferência da Gerência</h3>
    <p>{items.length} título(s) quitado(s) ou retirado(s) reaparecem no relatório de abertos. Cada retorno exige aprovação individual e justificativa da Gerência. A aprovação sozinha não altera recebimentos, saldos ou comissões.</p>
    <p>Depois das aprovações, a Gerência que aprovou deve concluir esta importação. O arquivo, os retornos e eventuais estornos serão aplicados juntos, com o histórico preservado.</p>
    {!isManager && <p>Conferência da Gerência necessária. Seu perfil não pode aprovar nem concluir uma importação que retorne esses títulos à carteira.</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {pending && <div className="notice" role="status"><p>A aprovação está pendente de confirmação. Os dados e o protocolo permanecem preservados.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void execute(pending)}>{busy ? 'Conferindo aprovação…' : 'Conferir aprovação pendente'}</button></div>}
    <div className="table-wrap"><table><caption>Títulos que dependem de aprovação para retornar</caption><thead><tr><th>Linha / título</th><th>Situação atual</th><th>Valores</th><th>Aprovação individual</th></tr></thead><tbody>{items.map(item => <tr key={item.title_id}><td>Linha {item.line + 1}<div>{item.client_name} · NF {item.document} · Filial {item.branch}</div><small>Vencimento {dateLabel(item.due_date)}</small>{item.requires_collector_assignment && <p className="help-text">Sem cobradora vinculada; será necessário atribuir a responsável após o retorno.</p>}</td><td>{item.reason_kind === 'VALIDATED' ? 'Recebimento validado na Central' : 'Retirado pelo relatório completo'}{item.retired_from_report && item.reason_kind === 'VALIDATED' && <small>Também retirado do relatório</small>}</td><td>Original: {formatCents(item.amount_cents)}{item.received_amount_cents !== null && <small>Recebido: {formatCents(item.received_amount_cents)} em {dateLabel(item.payment_date)}</small>}</td><td>{item.approval_id ? <p>Aprovação registrada em {dateLabel(item.approved_at)}. Retorno aguardando a conclusão desta importação.</p> : isManager && item.can_approve ? <><label className="field">Justificativa do retorno da NF {item.document}<textarea aria-label={`Justificativa do retorno da NF ${item.document}`} value={reasons[item.title_id] ?? ''} maxLength={5000} disabled={disabled || !!pending || busy} onChange={event => setReasons(previous => ({ ...previous, [item.title_id]: event.target.value }))} /></label><button type="button" className="button secondary" disabled={disabled || !!pending || busy || !reasons[item.title_id]?.trim()} onClick={() => approve(item)}>Aprovar retorno da NF {item.document}</button></> : <p>{isManager ? 'Resolva o vínculo ou conflito e analise novamente antes de aprovar este retorno.' : 'Aguardando aprovação da Gerência.'}</p>}</td></tr>)}</tbody></table></div>
  </section>;
}
const unappliedMappingsMessage = 'A função de importação não aplicou os vínculos selecionados. Atualize a função receivables-import e analise novamente.';
function safeProblems(value: unknown): ImportProblem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).filter((item): item is ImportProblem => item && Number.isSafeInteger(item.line) && typeof item.column === 'string' && typeof item.problem === 'string' && typeof item.correction === 'string').map(item => ({ line: item.line, column: item.column.slice(0, 300), problem: item.problem.slice(0, 700), correction: item.correction.slice(0, 700) }));
}
function validatePreview(value: ServerPreview, mode: Mode, hash: string, fullReport: boolean, referenceDate: string) {
  const preview = value?.preview;
  if (!value || value.file_sha256 !== hash || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 5000
    || !preview || preview.mode !== mode || preview.row_count !== value.rows.length || typeof preview.can_commit !== 'boolean'
    || typeof preview.financial_revision !== 'string' || !preview.financial_revision.length || preview.financial_revision.length > 256
    || !(preview.previous_import_id === null || typeof preview.previous_import_id === 'string' && uuid.test(preview.previous_import_id))
    || !Number.isSafeInteger(preview.new_count) || preview.new_count < 0 || !Number.isSafeInteger(preview.conflict_count) || preview.conflict_count < 0
    || countFields.some(key => preview[key] !== undefined && (!Number.isSafeInteger(preview[key]) || preview[key]! < 0))) throw new Error('Resposta de análise inválida.');
  let nominalTotal = 0, receivedTotal = 0;
  if (mode === 'open') {
    if (preview.format_version !== 'receivables-open-report-v1') throw { code: 'P0047', activation_required: true };
    if (preview.full_report !== fullReport || preview.reference_date !== referenceDate
      || ['retired_count', 'retired_worked_count', 'retired_unworked_count', 'reappeared_count'].some(key => !Number.isSafeInteger(preview[key as keyof Preview]) || Number(preview[key as keyof Preview]) < 0)
      || preview.retired_count !== preview.retired_worked_count! + preview.retired_unworked_count!
      || !Array.isArray(preview.retirement_items) || preview.retirement_items.length !== preview.retired_count
      || !fullReport && preview.retired_count !== 0) throw new Error('Conferência do relatório completo inválida.');
    const retiredIds = new Set<string>();
    for (const item of preview.retirement_items) {
      if (!item || !uuid.test(item.title_id) || retiredIds.has(item.title_id) || typeof item.client_name !== 'string' || typeof item.document !== 'string' || typeof item.branch !== 'string'
        || typeof item.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.due_date) || !Number.isSafeInteger(item.amount_cents) || item.amount_cents < 0
        || !(item.collector_id === null || uuid.test(item.collector_id)) || typeof item.worked !== 'boolean') throw new Error('Títulos ausentes inválidos.');
      retiredIds.add(item.title_id);
    }
    if (preview.retirement_items.filter(item => item.worked).length !== preview.retired_worked_count) throw new Error('Títulos trabalhados inválidos.');
    if (preview.return_approval_version !== undefined) {
      if (preview.return_approval_version !== '057' || !Number.isSafeInteger(preview.return_count) || preview.return_count! < 0 || preview.return_count! > value.rows.length
        || !Number.isSafeInteger(preview.return_unapproved_count) || preview.return_unapproved_count! < 0 || preview.return_unapproved_count! > preview.return_count!
        || !Array.isArray(preview.return_items) || preview.return_items.length !== preview.return_count || preview.can_commit && preview.return_unapproved_count! > 0) throw new Error('Conferência de retornos inválida.');
      const returnIds = new Set<string>();
      for (const item of preview.return_items) {
        const row = value.rows.find(candidate => candidate.line === item?.line);
        if (!item || !Number.isSafeInteger(item.line) || !row || row.title_id !== item.title_id || !uuid.test(item.title_id) || returnIds.has(item.title_id)
          || item.document !== row.document || item.client_name !== row.client_name || item.branch !== row.branch || item.due_date !== row.due_date || item.amount_cents !== row.amount_cents
          || !['VALIDATED', 'RETIRED'].includes(item.reason_kind) || !Number.isSafeInteger(item.expected_revision) || item.expected_revision < 1 || typeof item.retired_from_report !== 'boolean'
          || !(item.receipt_id === null || typeof item.receipt_id === 'string' && uuid.test(item.receipt_id)) || !(item.received_amount_cents === null || Number.isSafeInteger(item.received_amount_cents) && item.received_amount_cents >= 0)
          || !(item.payment_date === null || typeof item.payment_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.payment_date))
          || !item.source_row || typeof item.source_row !== 'object' || Array.isArray(item.source_row) || item.source_row.document !== row.document || item.source_row.client_name !== row.client_name || item.source_row.client_document !== row.client_document || item.source_row.branch !== row.branch || item.source_row.issued_on !== row.issued_on || item.source_row.due_date !== row.due_date || item.source_row.amount_cents !== row.amount_cents
          || !/^[a-f0-9]{64}$/.test(item.source_fingerprint) || !/^[a-f0-9]{64}$/.test(item.receipt_fingerprint) || typeof item.can_approve !== 'boolean'
          || item.collector_id !== undefined && !(item.collector_id === null || typeof item.collector_id === 'string' && uuid.test(item.collector_id)) || item.requires_collector_assignment !== undefined && typeof item.requires_collector_assignment !== 'boolean'
          || !(item.approval_id === null && item.approved_by === null && item.approved_at === null || typeof item.approval_id === 'string' && uuid.test(item.approval_id) && typeof item.approved_by === 'string' && uuid.test(item.approved_by) && instant(item.approved_at))) throw new Error('Título de retorno inválido.');
        returnIds.add(item.title_id);
      }
      if (preview.return_unapproved_count !== preview.return_items.filter(item => !item.approval_id).length) throw new Error('Aprovações de retorno inconsistentes.');
    }
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
function officialPreview(value: ServerPreview, mode: Mode, hash: string, fullReport: boolean, referenceDate: string) {
  try { return validatePreview(value, mode, hash, fullReport, referenceDate); }
  catch (failure) {
    if (failure && typeof failure === 'object' && 'code' in failure) throw failure;
    throw makeReceivableFailure({ phase: 'preview', status: 200, code: 'CR_INVALID_PREVIEW' });
  }
}

export default function ReceivablesImport({ canImport, isManager = false, currentUserId = null, onBusyChange }: { canImport: boolean; isManager?: boolean; currentUserId?: string | null; onBusyChange?: (busy: boolean) => void }) {
  const [mode, setMode] = useState<Mode>('open'), [file, setFile] = useState<File | null>(null), [complete, setComplete] = useState(false);
  const [operationBusy, setBusy] = useState<'analyzing' | 'saving' | null>(null), [uncertain, setUncertain] = useState(false), [approvalPending, setApprovalPending] = useState(false), [approvalRevision, setApprovalRevision] = useState(0);
  const busy = operationBusy ?? (approvalPending ? 'approving' : null);
  const [fullReport, setFullReport] = useState(true), [referenceDate, setReferenceDate] = useState(officialToday());
  const pendingCommit = useRef<ReceivableImportRequestBody | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [mappings, setMappings] = useState<Record<string, string>>({}), [mappingsDirty, setMappingsDirty] = useState(false);
  const [collectorMappings, setCollectorMappings] = useState<Record<string, string>>({}), [collectors, setCollectors] = useState<Collector[]>([]);
  const [useFileCollectors, setUseFileCollectors] = useState(true);
  const [collectorsLoading, setCollectorsLoading] = useState(false), [collectorsError, setCollectorsError] = useState('');
  const [bulkCollector, setBulkCollector] = useState(''), [customerSearch, setCustomerSearch] = useState(''), [customerPage, setCustomerPage] = useState(1);
  const [problems, setProblems] = useState<ImportProblem[]>([]), [history, setHistory] = useState<Batch[]>([]);
  const [previousProblems, setPreviousProblems] = useState(false), [errorReference, setErrorReference] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true), [historyError, setHistoryError] = useState('');
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [refresh, setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null), generation = useRef(0), inputRef = useRef<HTMLInputElement | null>(null);
  const problemsRef = useRef<HTMLDivElement | null>(null), focusProblems = useRef(false);
  const errorRef = useRef<HTMLDivElement | null>(null), focusError = useRef(false);
  useEffect(() => {
    const locked = approvalPending || operationBusy === 'saving' || uncertain;
    onBusyChange?.(locked); window.dispatchEvent(new CustomEvent('receivable-validation-pending', { detail: locked }));
    function warn(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    if (locked) window.addEventListener('beforeunload', warn);
    return () => { if (locked) window.removeEventListener('beforeunload', warn); };
  }, [approvalPending, operationBusy, uncertain, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); window.dispatchEvent(new CustomEvent('receivable-validation-pending', { detail: false })); }, [onBusyChange]);
  useEffect(() => { if (approvalRevision > 0) void analyze(); }, [approvalRevision]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    if (busy !== null || !problems.length || !focusProblems.current || !problemsRef.current) return;
    focusProblems.current = false;
    problemsRef.current.focus({ preventScroll: true });
    problemsRef.current.scrollIntoView({ block: 'start' });
  }, [busy, problems]);
  useEffect(() => {
    if (busy !== null || !error || !focusError.current || !errorRef.current) return;
    focusError.current = false; errorRef.current.focus({ preventScroll: true }); errorRef.current.scrollIntoView({ block: 'start' });
  }, [busy, error]);
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
  function resetAnalysis() { generation.current++; controller.current?.abort(); focusProblems.current = false; focusError.current = false; setAnalysis(null); pendingCommit.current = null; setProblems([]); setPreviousProblems(false); setError(''); setErrorReference(''); setSuccess(''); setBusy(null); }
  function changeMode(next: Mode) {
    if (busy || uncertain || next === mode) return;
    resetAnalysis(); setMode(next); setFile(null); setComplete(false); setMappings({}); setCollectorMappings({}); setUseFileCollectors(true); setBulkCollector(''); setCustomerSearch(''); setCustomerPage(1); setMappingsDirty(false); if (inputRef.current) inputRef.current.value = '';
  }
  async function analyze(event?: FormEvent) {
    event?.preventDefault();
    if (!supabase || !file || !complete || !canImport || busy || mode === 'open' && uncertain) return;
    const previousAnalysis = analysis?.file === file && analysis.mode === mode ? analysis : null;
    function preserveChoices() { setAnalysis(previousAnalysis); if (previousAnalysis) setMappingsDirty(true); }
    const current = ++generation.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    focusProblems.current = false; focusError.current = false; setBusy('analyzing'); setProblems([]); setPreviousProblems(false); setError(''); setErrorReference(''); setSuccess('');
    try {
      const parsed = mode === 'received' ? await analyzeReceivableReceivedFile(file, abort.signal) : await analyzeReceivableFile(file, abort.signal);
      if (current !== generation.current) return;
      if (parsed.errors.length) { preserveChoices(); focusProblems.current = true; setProblems(parsed.errors); return; }
      // The first preview identifies official customer wallets before a file can propose a responsible.
      const selectedCollectors = Object.fromEntries(Object.entries(collectorMappings).filter(([, id]) => id !== ''));
      const previewRequest = (choices: Record<string, string>) => receivableImportRequest<ServerPreview>({ action: 'preview', mode, file_name: file.name, file_base64: parsed.base64, title_mappings: mappings, ...(mode === 'open' ? { collector_mappings: choices, full_report: fullReport, reference_date: referenceDate } : {}) }, abort.signal);
      let canonical = await previewRequest(selectedCollectors);
      if (current !== generation.current) return;
      let totals = officialPreview(canonical, mode, parsed.hash, fullReport, referenceDate);
      let effectiveCollectors = selectedCollectors, collectorSummary: CollectorHintSummary | undefined;
      let collectorProblems: ImportProblem[] = [];
      if (mode === 'open' && parsed.collector_hints !== undefined) {
        const hints = useFileCollectors ? parsed.collector_hints : [];
        const hintedKeys = new Set(hints.map(item => item.customer_key));
        const needsCollectorLookup = canonical.preview.customer_collector_assignments!.some(item => item.requires_selection && !item.locked && hintedKeys.has(item.customer_key) && !Object.hasOwn(collectorMappings, item.customer_key));
        if (needsCollectorLookup && (collectorsLoading || collectorsError)) throw { errors: [{ line: hints[0].line, column: 'COBRADORA', problem: collectorsLoading ? 'Aguarde a consulta das cobradoras e analise o arquivo novamente.' : 'Não foi possível conferir as cobradoras da planilha.', correction: 'Atualize o histórico de CR para consultar as cobradoras e analise o arquivo novamente.' }] };
        const plan = resolveReceivableCollectorHints({ hints, assignments: canonical.preview.customer_collector_assignments!, collectors, mappings: collectorMappings });
        effectiveCollectors = plan.mappings; collectorSummary = plan.summary; collectorProblems = plan.problems;
        const changed = Object.keys(effectiveCollectors).length !== Object.keys(selectedCollectors).length || Object.entries(effectiveCollectors).some(([key, id]) => selectedCollectors[key] !== id);
        if (changed) {
          const firstRevision = canonical.preview.financial_revision, firstImport = canonical.preview.previous_import_id;
          canonical = await previewRequest(effectiveCollectors);
          if (current !== generation.current) return;
          totals = officialPreview(canonical, mode, parsed.hash, fullReport, referenceDate);
          if (canonical.preview.financial_revision !== firstRevision || canonical.preview.previous_import_id !== firstImport) throw { code: '40001' };
          if (Object.entries(effectiveCollectors).some(([key, id]) => canonical.preview.customer_collector_assignments!.find(item => item.customer_key === key)?.collector_id !== id)) throw makeReceivableFailure({ phase: 'preview', status: 200, code: 'CR_INVALID_PREVIEW' });
        }
      }
      const nextAnalysis: Analysis = { file, mode, base64: parsed.base64, rows: canonical.rows, preview: canonical.preview, titleMappings: { ...mappings }, collectorMappings: { ...effectiveCollectors }, ...(mode === 'open' && parsed.collector_hints !== undefined ? { collectorHints: parsed.collector_hints, collectorSummary } : {}), ...totals };
      setAnalysis(nextAnalysis);
      if (mode === 'received') setUncertain(false);
      // SQL errors use financial row numbers; file hints already carry physical Excel rows.
      const nextProblems = [...safeProblems(canonical.preview.errors).map(problem => ({ ...problem, line: problem.line > 0 ? problem.line + 1 : problem.line })), ...collectorProblems].slice(0, 100);
      focusProblems.current = nextProblems.length > 0; setProblems(nextProblems); setMappingsDirty(false);
    } catch (failure) { if (current === generation.current && !abort.signal.aborted) {
      preserveChoices(); setErrorReference(receivableFailureReference(failure, 'preview'));
      const details = safeProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : null);
      if (details.length) { focusProblems.current = true; setProblems(details); } else { focusError.current = true; setError(receivableError(failure, receivableImportFailureMessage(failure, 'preview'))); }
    } } finally { if (current === generation.current) setBusy(null); }
  }
  async function commit(retry = false) {
    if (!analysis || !complete || !canImport || busy || !retry && (uncertain || mappingsDirty || unappliedTitleMappings(analysis) || !analysis.preview.can_commit || problems.length || returnActivationMissing(analysis) || (analysis.preview.return_count ?? 0) > 0 && !isManager)) return;
    if (retry && !pendingCommit.current) return;
    const p = analysis.preview, corrections = p.correction_count ?? 0;
    const validatedOpen = analysis.mode === 'open' && analysis.preview.return_approval_version !== '057' ? validatedOpenSummary(analysis) : null;
    const message = analysis.mode === 'received'
      ? `Confirmar o relatório de TÍTULOS QUITADOS?\n\n${p.row_count} títulos; recebido efetivo ${formatCents(analysis.receivedTotal)}.\n${p.new_count} novos títulos; ${p.matched_count ?? 0} recebimentos já registrados; ${corrections} correções de recebimentos importados; ${p.historical_count ?? 0} quitados do histórico.\n\nOs recebimentos conferidos pelo arquivo sairão da carteira ativa e alimentarão a base de apuração de comissões. Correções preservam os registros anteriores. Esta importação não paga comissões.`
      : `Confirmar o relatório de ABERTOS E VENCIDOS?\n\n${p.row_count} títulos; ${p.new_count} novas parcelas; ${p.changed_count ?? 0} alterações em títulos existentes.\n\nPosição do relatório: ${dateLabel(p.reference_date ?? null)}.\n${p.full_report ? `${p.retired_count} títulos ausentes sairão da carteira ativa: ${p.retired_worked_count} pendentes em Comissões e ${p.retired_unworked_count} sem cobrança, preservados no histórico.` : 'Inclusão/atualização: títulos ausentes continuarão como estão.'}\n${p.reappeared_count} títulos retornarão à carteira. Nenhum recebimento será confirmado por ausência.${(p.return_count ?? 0) > 0 ? `\n\n${p.return_count} retorno(s) aprovado(s) pela Gerência serão aplicados com esta importação. Recebimentos anteriores desses títulos serão estornados com histórico preservado; os títulos voltarão à carteira. Aprovar não aplicou essas alterações antes desta confirmação.` : ''}${validatedOpen?.count ? `\n\n${validatedOpen.count} título(s) já quitado(s) permanecerão fora da carteira ativa.${validatedOpen.excluded !== null ? ` Valor original no arquivo: ${formatCents(validatedOpen.excluded)}. Valor do arquivo ainda não quitado na Central: ${formatCents(validatedOpen.unpaid!)}.` : ' O valor total excluído não foi calculado porque os vínculos detalhados estão incompletos.'}` : ''}`;
    if (!retry && !window.confirm(message)) return;
    setBusy('saving'); setError(''); setErrorReference(''); setSuccess(''); const current = generation.current;
    try {
      const body: ReceivableImportRequestBody = retry ? pendingCommit.current! : { action: 'commit', mode: analysis.mode, file_name: analysis.file.name, file_base64: analysis.base64, complete: true, title_mappings: { ...mappings }, previous_import_id: p.previous_import_id, previous_financial_revision: p.financial_revision, ...(analysis.mode === 'received' ? { confirm_corrections: corrections > 0 } : { collector_mappings: { ...analysis.collectorMappings }, full_report: p.full_report, reference_date: p.reference_date, request_id: crypto.randomUUID() }) };
      if (analysis.mode === 'open') pendingCommit.current = body;
      const summary = await receivableImportRequest<{ import_id: string; row_count: number; request_id?: string; full_report?: boolean; reference_date?: string; retired_count?: number; retired_worked_count?: number; retired_unworked_count?: number; reappeared_count?: number; return_approval_version?: string; returned_count?: number }>(body);
      if (current !== generation.current) return;
      if (!summary || typeof summary.import_id !== 'string' || !uuid.test(summary.import_id) || summary.row_count !== p.row_count || analysis.mode === 'open' && (summary.request_id !== body.request_id || summary.full_report !== p.full_report || summary.reference_date !== p.reference_date || summary.retired_count !== p.retired_count || summary.retired_worked_count !== p.retired_worked_count || summary.retired_unworked_count !== p.retired_unworked_count || summary.reappeared_count !== p.reappeared_count)) throw makeReceivableFailure({ phase: 'commit', status: 200, code: 'CR_INVALID_RESPONSE' });
      if (analysis.mode === 'open' && p.return_approval_version === '057' && (summary.return_approval_version !== '057' || summary.returned_count !== p.return_count)) throw makeReceivableFailure({ phase: 'commit', status: 200, code: 'CR_INVALID_RESPONSE' });
      setSuccess(analysis.mode === 'received' ? `Importação concluída: ${summary.row_count} títulos quitados conferidos. Recebimentos disponíveis no resumo e na base de apuração de comissões; títulos validados fora da carteira ativa.` : `Importação concluída: ${summary.row_count} títulos conferidos. ${summary.retired_count} ausentes retirados da carteira ativa; ${summary.retired_worked_count} pendentes em Comissões, aguardando o relatório de quitados. Nenhum recebimento foi presumido.${summary.returned_count ? ` ${summary.returned_count} retorno(s) aprovado(s) pela Gerência aplicados com histórico preservado.` : ''}`);
      pendingCommit.current = null; setUncertain(false); setAnalysis(null); setComplete(false); setFile(null); setMappings({}); setCollectorMappings({}); setUseFileCollectors(true); setBulkCollector(''); setCustomerSearch(''); setCustomerPage(1); setMappingsDirty(false); setProblems([]); setRefresh(value => value + 1); if (inputRef.current) inputRef.current.value = '';
    } catch (failure) { if (current === generation.current) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      const known = ['40001', '23505', '23514', '22023', '42501', 'P0023', 'P0024', 'P0030', 'P0047', 'PGRST301', 'PGRST303'].includes(code);
      setUncertain(!known);
      focusError.current = true; setErrorReference(receivableFailureReference(failure, 'commit'));
      setError(receivableError(failure, receivableImportFailureMessage(failure, 'commit')));
      if (known) { pendingCommit.current = null; setAnalysis(null); } else setMappingsDirty(true);
      setRefresh(value => value + 1);
    } } finally { if (current === generation.current) setBusy(null); }
  }
  function mapTitle(line: number, title: string) {
    if (busy || uncertain) return;
    setMappings(previous => { const next = { ...previous }; if (title) next[String(line)] = title; else delete next[String(line)]; return next; }); setMappingsDirty(true); setPreviousProblems(true); setError(''); setErrorReference('');
  }
  function mapCollector(key: string, id: string) {
    if (busy || uncertain || !analysis?.preview.customer_collector_assignments?.some(item => item.customer_key === key && item.requires_selection && !item.locked) || id && !collectors.some(item => item.id === id)) return;
    setCollectorMappings(previous => ({ ...previous, [key]: id })); setMappingsDirty(true); setPreviousProblems(true); setError(''); setErrorReference('');
  }
  if (!canImport) return <p className="notice">Seu perfil não permite importar bases de Contas a Receber.</p>;
  const mappingRows = analysis?.rows.filter(row => ambiguous(row) || Object.hasOwn(mappings, String(row.line))) ?? [];
  const unresolved = mappingRows.filter(row => ambiguous(row) && !mappings[String(row.line)]);
  const mappingsNotApplied = !!analysis && !mappingsDirty && unappliedTitleMappings(analysis);
  const assignments = analysis?.preview.customer_collector_assignments ?? [];
  const selectedCollector = (key: string) => Object.hasOwn(collectorMappings, key) ? collectorMappings[key] : useFileCollectors ? analysis?.collectorMappings[key] ?? '' : '';
  const hintedCustomers = new Set(analysis?.collectorHints?.map(item => item.customer_key) ?? []);
  const filteredCustomers = assignments.filter(item => `${item.client_name} ${item.client_document ?? ''}`.toLocaleLowerCase('pt-BR').includes(customerSearch.toLocaleLowerCase('pt-BR')));
  const pages = Math.max(1, Math.ceil(filteredCustomers.length / 20)), currentPage = Math.min(customerPage, pages);
  return <>
    <section className="panel" aria-labelledby="receivable-import-title">
      <div className="panel-header"><div><h2 id="receivable-import-title">Importar Contas a Receber</h2><p className="muted">Atualize a Central com o relatório do sistema de origem. A cópia original, as carteiras e o histórico são preservados.</p></div></div>
      <div className="inline-actions" role="group" aria-label="Tipo de relatório de Contas a Receber"><button type="button" className={`button ${mode === 'open' ? '' : 'secondary'}`} aria-pressed={mode === 'open'} disabled={busy !== null || uncertain} onClick={() => changeMode('open')}>Abertos e vencidos</button><button type="button" className={`button ${mode === 'received' ? '' : 'secondary'}`} aria-pressed={mode === 'received'} disabled={busy !== null || uncertain} onClick={() => changeMode('received')}>Títulos quitados</button></div>
      <p className="notice">{mode === 'open' ? 'No relatório completo, os títulos ausentes saem da carteira ativa e mantêm o histórico. Se houve cobrança, ficam pendentes em Comissões até o relatório de quitados confirmar o recebimento.' : 'Títulos quitados confirmam o recebimento pela data e pelo valor efetivos do relatório, retiram os títulos validados da carteira ativa e alimentam a base de apuração de comissões.'}</p>
      <p className="help-text">{mode === 'open' ? 'Inclua títulos a vencer e vencidos. Na Cobrança aparecem somente os vencidos. Na carga inicial, a coluna COBRADORA preenche as responsáveis dos clientes sem carteira. Nos próximos relatórios, escolha na Central a cobradora dos novos clientes. Carteiras existentes são preservadas nas atualizações diárias. Alterações de parcelas que gerem dúvida exigem conferir o vínculo antes de concluir.' : 'Este modo exige as colunas Quitação: data do recebimento e Quitação: valor recebido. O vencimento e o valor original continuam separados do recebimento; não substitua essas informações.'}</p>
      <p className="help-text">Campos do título: Documento / NF, Cliente / Órgão, Filial, Vencimento e Valor original. Emissão e CNPJ são opcionais; não complete CNPJ ausente automaticamente.</p>
      {error && <div ref={errorRef} tabIndex={-1} className="notice error" role="alert"><p>{error}</p>{errorReference && <p className="help-text">Código para suporte: <code style={{ overflowWrap: 'anywhere' }}>{errorReference}</code></p>}</div>}{success && <p className="notice success" role="status">{success}</p>}
      {uncertain && <div className="notice" role="status"><p>A confirmação está pendente. Mantenha esta tela aberta para conferir o mesmo envio sem duplicar informações.</p>{mode === 'open' ? <button type="button" className="button secondary" disabled={busy !== null} onClick={() => void commit(true)}>Conferir confirmação pendente</button> : <p>Clique em Analisar arquivo para conferir o mesmo envio.</p>}</div>}
      <form className="stack" onSubmit={event => void analyze(event)}>
        <label className="field" htmlFor="receivable-file">{mode === 'open' ? 'Relatório de abertos e vencidos de Contas a Receber' : 'Relatório de títulos quitados de Contas a Receber'}<input ref={inputRef} id="receivable-file" type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={busy !== null || uncertain} onChange={event => { resetAnalysis(); setComplete(false); setMappings({}); setCollectorMappings({}); setUseFileCollectors(true); setBulkCollector(''); setCustomerSearch(''); setCustomerPage(1); setMappingsDirty(false); setFile(event.target.files?.[0] ?? null); }} /></label>
        <p className="help-text">Até 2 MiB, 5.000 títulos e uma única aba preenchida. Formatos: .xlsx, .xlsm e .csv UTF-8. Para .xls antigo, salve uma cópia como .xlsx. Fórmulas são recusadas; macros nunca são executadas.</p>
        {mode === 'open' && <div className="inline-actions"><label className="field">Abrangência do relatório<select aria-label="Abrangência do relatório" value={fullReport ? 'full' : 'incremental'} disabled={busy !== null || uncertain} onChange={event => { resetAnalysis(); setComplete(false); setFullReport(event.target.value === 'full'); }}><option value="full">Relatório completo — conferir títulos ausentes</option><option value="incremental">Somente inclusão e atualização</option></select></label><label className="field">Data da posição do relatório<input type="date" value={referenceDate} max={officialToday()} required disabled={busy !== null || uncertain} onChange={event => { resetAnalysis(); setComplete(false); setReferenceDate(event.target.value); }} /></label></div>}
        <label className="checkbox-field"><input type="checkbox" checked={complete} disabled={busy !== null || uncertain} onChange={event => { setComplete(event.target.checked); setAnalysis(null); }} />{mode === 'open' ? ` ${fullReport ? 'Confirmo que este é o relatório completo de todos os títulos em aberto, a vencer e vencidos, da mesma origem e de todas as filiais.' : 'Confirmo que este arquivo contém somente inclusões e atualizações. Títulos ausentes serão preservados.'}` : ' Confirmo que todas as linhas deste arquivo são títulos quitados, com data e valor efetivamente recebidos.'}</label>
        <div className="inline-actions"><button type="submit" className="button" disabled={!file || !complete || busy !== null || historyLoading || mode === 'open' && (uncertain || !referenceDate || referenceDate > officialToday())}>{busy === 'analyzing' ? 'Analisando cópia…' : 'Analisar arquivo'}</button>{busy === 'analyzing' && !uncertain && <button type="button" className="button secondary" onClick={resetAnalysis}>Cancelar análise</button>}</div>
      </form>
      {problems.length > 0 && <div ref={problemsRef} tabIndex={-1} role="region" aria-label="Problemas encontrados na importação">
        <div className={`notice${previousProblems ? '' : ' error'}`} role={previousProblems ? 'status' : 'alert'}>
          {previousProblems ? <><p><strong>Escolhas alteradas.</strong> Valide as escolhas abaixo para atualizar a análise.</p><p>A tabela mostra os problemas da análise anterior. Nenhum dado foi alterado por esta análise.</p></> : <>
            <p><strong>Importação bloqueada.</strong> Nenhum dado foi alterado por esta análise. {problems.length} problema(s) encontrado(s) nesta análise.</p>
            {mappingsNotApplied && <p><strong>{unappliedMappingsMessage}</strong></p>}
            <p><strong>{problems[0].line > 0 ? `Linha ${problems[0].line} · ` : ''}{problems[0].column}:</strong> {problems[0].problem}</p>
            <p><strong>Como corrigir:</strong> {problems[0].correction}</p>
            <p>Confira os detalhes abaixo e analise o arquivo novamente.</p>
          </>}
        </div>
        {errorReference && !error && <p className="help-text">Código para suporte: <code style={{ overflowWrap: 'anywhere' }}>{errorReference}</code></p>}
        <div className="table-wrap"><table><caption>{previousProblems ? 'Análise anterior · problemas encontrados · até 100 erros por análise' : 'Problemas encontrados · até 100 erros por análise'}</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.map((problem, index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div>
      </div>}
      {mode === 'open' && analysis && <section className="stack" aria-labelledby="import-collectors-title"><h3 id="import-collectors-title">Cobradoras responsáveis pela carteira</h3>
        <p className="help-text">A responsável é vinculada ao cliente e acompanha seus títulos. Os vínculos existentes ficam preservados. Você também pode reimportar o mesmo arquivo para completar carteiras sem responsável, sem duplicar os títulos.</p>
        {!!analysis.collectorHints?.length && <label className="checkbox-field"><input type="checkbox" checked={useFileCollectors} disabled={busy !== null || uncertain} onChange={event => { setUseFileCollectors(event.target.checked); setCollectorMappings({}); setMappingsDirty(true); setPreviousProblems(true); setError(''); setErrorReference(''); }} />Usar cobradoras da planilha</label>}
        {analysis.collectorSummary && useFileCollectors && <p className="notice" role="status">Coluna COBRADORA: {analysis.collectorSummary.file_title_count} título(s) de {analysis.collectorSummary.file_customer_count} cliente(s). {analysis.collectorSummary.assigned_customer_count} carteira(s) sem responsável com escolha sugerida pela planilha; {analysis.collectorSummary.preserved_customer_count} carteira(s) existente(s) preservada(s); {analysis.collectorSummary.manual_customer_count} escolha(s) feita(s) na Central. Confira as responsáveis antes de concluir.</p>}
        {collectorsLoading && <p role="status">Consultando cobradoras…</p>}
        {collectorsError && <p className="notice error" role="alert">{collectorsError}</p>}
        {!collectorsLoading && !collectorsError && collectors.length === 0 && assignments.some(item => item.requires_selection) && <p className="notice" role="status">Nenhuma cobradora ativa está disponível. Peça à Gerência Geral que cadastre ou ative as cobradoras na Administração e atualize o histórico para consultar novamente.</p>}
        {assignments.some(item => item.requires_selection && !item.locked) && <div className="inline-actions"><label className="field">Cobradora para clientes sem responsável<select value={bulkCollector} disabled={busy !== null || uncertain || collectorsLoading || !!collectorsError} onChange={event => setBulkCollector(event.target.value)}><option value="">Selecione a cobradora</option>{collectors.map(item => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><button type="button" className="button secondary" disabled={busy !== null || uncertain || !bulkCollector || !collectors.some(item => item.id === bulkCollector)} onClick={() => {
          setCollectorMappings(previous => ({ ...previous, ...Object.fromEntries(assignments.filter(item => item.requires_selection && !item.locked && !(Object.hasOwn(previous, item.customer_key) ? previous[item.customer_key] : useFileCollectors ? analysis.collectorMappings[item.customer_key] : '')).map(item => [item.customer_key, bulkCollector])) })); setMappingsDirty(true); setPreviousProblems(true); setError(''); setErrorReference('');
        }}>Aplicar às carteiras sem responsável</button></div>}
        <label className="field">Buscar cliente na atribuição de cobradoras<input value={customerSearch} onChange={event => { setCustomerSearch(event.target.value); setCustomerPage(1); }} /></label>
        <div className="table-wrap"><table><caption>{assignments.length} cliente(s) na conferência de carteiras</caption><thead><tr><th>Cliente</th><th>Títulos</th><th>Cobradora responsável</th></tr></thead><tbody>{filteredCustomers.slice((currentPage - 1) * 20, currentPage * 20).map(item => <tr key={item.customer_key}><td>{item.client_name}{item.client_document && <small className="muted"> · {item.client_document}</small>}</td><td>{item.row_count}</td><td>{item.requires_selection && !item.locked ? <label className="field">Cobradora de {item.client_name}<select aria-label={`Cobradora de ${item.client_name}`} value={selectedCollector(item.customer_key)} disabled={busy !== null || uncertain || collectorsLoading || !!collectorsError} onChange={event => mapCollector(item.customer_key, event.target.value)}><option value="">Selecione a cobradora</option>{collectors.map(collector => <option key={collector.id} value={collector.id}>{collector.display_name}</option>)}</select>{useFileCollectors && hintedCustomers.has(item.customer_key) && selectedCollector(item.customer_key) && <small className="help-text">{Object.hasOwn(collectorMappings, item.customer_key) ? 'Definição na Central' : 'Responsável lida da coluna COBRADORA'}</small>}</label> : <span>{item.collector_name ?? 'Sem atribuição necessária para títulos quitados'}{item.collector_id && <small className="muted"> · Carteira preservada</small>}</span>}</td></tr>)}</tbody></table></div>
        {pages > 1 && <div className="inline-actions"><button type="button" className="button secondary" disabled={currentPage === 1} onClick={() => setCustomerPage(currentPage - 1)}>Clientes anteriores</button><span>Página {currentPage} de {pages}</span><button type="button" className="button secondary" disabled={currentPage === pages} onClick={() => setCustomerPage(currentPage + 1)}>Próximos clientes</button></div>}
        {(analysis.preview.missing_collector_count ?? 0) > 0 && !mappingsDirty && <p className="notice" role="status">Escolha a cobradora de {analysis.preview.missing_collector_count} cliente(s) sem responsável e analise o arquivo novamente.</p>}
        {mappingsDirty && <p className="notice" role="status">Responsáveis ou vínculos alterados. Clique em Analisar arquivo novamente para conferir as escolhas antes de concluir.</p>}
      </section>}
      {mappingRows.length > 0 && <div className="stack"><h3>Conferir parcelas do mesmo documento</h3><p className="help-text">Escolha um título existente somente quando a linha for uma atualização daquela parcela. Se for outra parcela, escolha Nova parcela. Nenhum vínculo é presumido pelo número da NF.</p>
        {unresolved.length > 0 && <button type="button" className="button secondary" disabled={busy !== null || uncertain} onClick={() => { setMappings(previous => ({ ...previous, ...Object.fromEntries(unresolved.map(row => [String(row.line), 'NEW'])) })); setMappingsDirty(true); setPreviousProblems(true); setError(''); setErrorReference(''); }}>Marcar {unresolved.length} linha(s) como novas parcelas</button>}
        <div className="table-wrap"><table><caption>Vínculo das parcelas antes da importação</caption><thead><tr><th>Linha</th><th>Cliente / NF</th><th>Vencimento / Valor original</th><th>Vínculo confirmado</th></tr></thead><tbody>{mappingRows.map(row => <tr key={row.line}><td>{row.line + 1}</td><td>{row.client_name} · {row.document} · Filial {row.branch}</td><td>{dateLabel(row.due_date)} · {formatCents(row.amount_cents)}</td><td><label className="field">Vínculo da linha {row.line + 1}<select aria-label={`Vínculo da linha ${row.line + 1}`} value={mappings[String(row.line)] ?? ''} disabled={busy !== null || uncertain} onChange={event => mapTitle(row.line, event.target.value)}><option value="">Selecione a parcela</option><option value="NEW">Nova parcela</option>{row.candidates?.map(candidate => <option key={candidate.id} value={candidate.id}>{dateLabel(candidate.due_date)} · {formatCents(candidate.amount_cents)} · {candidate.status === 'VALIDATED' ? 'Quitado' : 'Em aberto'}</option>)}</select></label></td></tr>)}</tbody></table></div>
        {mappingsDirty && <p className="notice">Vínculos alterados. Valide as escolhas de parcelas para conferir o resultado antes de concluir.</p>}
        <div className="inline-actions"><button type="button" className="button secondary" disabled={!file || !complete || busy !== null || historyLoading || uncertain} onClick={() => void analyze()}>{busy === 'analyzing' ? 'Validando escolhas…' : 'Validar escolhas de parcelas'}</button></div>
        {mappingsNotApplied && !problems.length && <p className="notice error" role="alert">{unappliedMappingsMessage}</p>}
      </div>}
      {analysis && <div className="stack"><h3>Conferência de Contas a Receber</h3>{mappingsDirty && <p className="notice">Prévia anterior preservada. Valide o mesmo arquivo e as escolhas novamente antes de confirmar a importação.</p>}<p>{analysis.preview.row_count} títulos · total original {formatCents(analysis.nominalTotal)} · {analysis.preview.new_count} novos títulos.</p>
        {mode === 'received' ? <><p><strong>Total recebido efetivo: {formatCents(analysis.receivedTotal)}</strong></p><p>{analysis.preview.received_count ?? 0} recebimentos novos · {analysis.preview.matched_count ?? 0} já registrados · {analysis.preview.correction_count ?? 0} correções · {analysis.preview.historical_count ?? 0} quitados do histórico.</p><p className="notice">A confirmação deste arquivo valida os recebimentos conferidos. A apuração de comissões usa o valor efetivamente recebido; importar não significa pagar comissão.</p></> : <div className="notice"><p>{analysis.preview.changed_count ?? 0} títulos com alterações · {analysis.preview.reappeared_count ?? 0} retornando à carteira.</p><p>{analysis.preview.full_report ? `${analysis.preview.retired_count} títulos ausentes sairão da carteira ativa: ${analysis.preview.retired_worked_count} ficarão pendentes em Comissões e ${analysis.preview.retired_unworked_count} permanecerão somente no histórico.` : 'Somente inclusão e atualização: títulos ausentes serão preservados.'}</p><p>Nenhum recebimento ou comissão será calculado por ausência.</p></div>}
        {mode === 'open' && !!analysis.preview.retirement_items?.length && <details><summary>Conferir {analysis.preview.retired_count} títulos ausentes do relatório completo</summary><div className="table-wrap"><table><caption>Títulos que sairão da carteira ativa</caption><thead><tr><th>Cliente / NF</th><th>Filial</th><th>Vencimento</th><th>Valor de referência</th><th>Destino</th></tr></thead><tbody>{analysis.preview.retirement_items.map(item => <tr key={item.title_id}><td>{item.client_name} · {item.document}</td><td>{item.branch}</td><td>{dateLabel(item.due_date)}</td><td>{formatCents(item.amount_cents)}</td><td>{item.worked ? 'Pendente em Comissões — aguardando quitados' : 'Histórico, sem recebimento confirmado'}</td></tr>)}</tbody></table></div></details>}
        {mode === 'open' && analysis.preview.return_approval_version === '057' && (analysis.preview.return_count ?? 0) > 0 && <ReturnApprovals analysis={analysis} isManager={isManager} currentUserId={currentUserId} disabled={operationBusy !== null || uncertain || mappingsDirty} onPendingChange={setApprovalPending} onApproved={() => { setApprovalPending(false); setMappingsDirty(true); setApprovalRevision(value => value + 1); }} />}
        {mode === 'open' && analysis.preview.return_approval_version !== '057' && <ValidatedOpenReconciliation analysis={analysis} />}
        {returnActivationMissing(analysis) && <p className="notice error" role="alert">Ative o SQL 057 de aprovação individual dos retornos e analise o arquivo novamente. Títulos quitados não podem retornar sem a conferência da Gerência.</p>}
        <div className="table-wrap"><table><caption>Conferência das primeiras {Math.min(10, analysis.rows.length)} linhas oficiais</caption><thead><tr><th>Cliente / NF</th><th>Filial</th><th>Vencimento original</th><th>Valor original</th>{mode === 'received' && <><th>Recebido em</th><th>Valor recebido</th></>}<th>Resultado</th></tr></thead><tbody>{analysis.rows.slice(0, 10).map(row => <tr key={row.line}><td>{row.client_name} · {row.document}</td><td>{row.branch}</td><td>{dateLabel(row.due_date)}</td><td>{formatCents(row.amount_cents)}</td>{mode === 'received' && <><td>{dateLabel(row.received_on ?? null)}</td><td>{formatCents(row.received_amount_cents ?? 0)}</td></>}<td>{outcomes[row.outcome]}</td></tr>)}</tbody></table></div>
        {!analysis.preview.can_commit && !problems.length && <p className="notice error" role="alert">Este arquivo ainda precisa de conferência. Resolva os vínculos ou conflitos e analise novamente.</p>}
        <button className="button" type="button" disabled={busy !== null || uncertain || !complete || mappingsDirty || unappliedTitleMappings(analysis) || !analysis.preview.can_commit || problems.length > 0 || returnActivationMissing(analysis) || (analysis.preview.return_count ?? 0) > 0 && !isManager} onClick={() => void commit()}>{busy === 'saving' ? 'Concluindo importação…' : mode === 'received' ? 'Confirmar importação de títulos quitados' : 'Concluir importação de abertos e vencidos'}</button>
      </div>}
    </section>
    <section className="panel" aria-labelledby="receivable-import-history"><div className="panel-header"><div><h2 id="receivable-import-history">Histórico de importações de Contas a Receber</h2><p className="muted">20 arquivos mais recentes. Os contadores descrevem cada lote e não substituem o saldo atual.</p></div><button className="button secondary" type="button" disabled={busy !== null || historyLoading} onClick={() => setRefresh(value => value + 1)}>Atualizar histórico de CR</button></div>
      {historyError && <p className="notice error" role="alert">{historyError}</p>}
      <div className="table-wrap" aria-busy={historyLoading}><table><thead><tr><th>Data / hora</th><th>Arquivo</th><th>Tipo</th><th>Títulos</th><th>Novos títulos</th><th>Já identificados</th></tr></thead><tbody>{historyLoading ? <tr><td className="empty-state" colSpan={6}>Carregando histórico…</td></tr> : history.length ? history.map(batch => <tr key={batch.id}><td>{dateLabel(batch.created_at)}</td><td>{batch.file_name}</td><td>{batch.import_mode === 'OPEN' ? 'Abertos e vencidos' : batch.import_mode === 'RECEIVED' ? 'Títulos quitados' : 'Histórico'}</td><td>{batch.row_count}</td><td>{batch.new_count}</td><td>{batch.open_count + batch.validated_in_source_count}</td></tr>) : <tr><td className="empty-state" colSpan={6}>{historyError ? 'Histórico indisponível.' : 'Nenhuma base de Contas a Receber importada.'}</td></tr>}</tbody></table></div>
    </section>
  </>;
}
