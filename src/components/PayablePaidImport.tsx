import { useEffect, useRef, useState, type FormEvent } from 'react';
import { analyzePayablePaymentsFile, dateLabel, formatCents, payableError, payableImportRequest, type ImportProblem } from '../lib/payables';
import PayableImportReconciliation, { resolutionChoices, validReconciliationItems, type ReconciliationItem, type ResolutionDraft, type ResolutionChoice } from './PayableImportReconciliation';
import { officialToday } from './Treasury';
import '../payable-paid-import.css';

interface PaidBank { id: string; display_name: string; company: string; bank: string; account_type: 'BANK' | 'CASH' }
interface PaidRow {
  line: number; branch: string; entry_number: string; source_status: string; paid_on: string;
  amount_paid_cents: number; paid_bank: string; cheque_number?: string | null; bank_mapping_key: string;
  bank_account_id: string | null; title_id: string | null; title_amount_cents: number | null;
  forecast_due_date: string | null; outcome: string; problem: string;
  description?: string; plan?: string; issued_on?: string | null; target_macro?: string;
  amount_changed?: boolean; previous_amount_cents?: number | null;
}
interface PaidPreview {
  mode: 'payments'; previous_import_id: string | null; row_count: number; new_payment_count: number;
  financial_revision: string;
  matched_payment_count: number; correction_count: number; conflict_count: number; errors: ImportProblem[];
  unmapped_banks: { key: string; branch: string; paid_bank: string; count: number }[];
  bank_options: PaidBank[]; can_commit: boolean;
  unclassified_plans?: { plan: string; count: number; total_cents: number }[]; macros?: string[];
  reconciliation_version: '043'; reconciliation_items: ReconciliationItem[]; resolution_errors?: ImportProblem[];
  writeoff_count: number; new_writeoff_count?: number; matched_writeoff_count?: number;
}
interface CanonicalPaid { rows: PaidRow[]; preview: PaidPreview; file_sha256: string }
interface PaidAnalysis extends CanonicalPaid { file: File; base64: string; choices: Record<string, ResolutionChoice> }
interface PaidResult { import_id: string; request_id: string; row_count: number; new_payment_count: number; matched_payment_count: number; reviewed_count: number; correction_count?: number; writeoff_count: number; idempotent: boolean }
type PaidRequest = Parameters<typeof payableImportRequest>[0] & { reconciliation_version: '043'; resolution_choices: Record<string, ResolutionChoice>; request_id?: string };
interface FrozenPaid { body: PaidRequest; rowCount: number; correctionCount: number }
const outcomes: Record<string, string> = { NEW_PAYMENT: 'Novo pagamento', MATCHED: 'Pagamento já registrado', CORRECTION: 'Correção de importação anterior', CONFLICT: 'Divergência — conferir', UNKNOWN_TITLE: 'Título não encontrado', UNMAPPED_BANK: 'Vincular banco / conta', WRITE_OFF_PENDING: 'Confirmar baixa sem pagamento', WRITE_OFF: 'Somente baixado — sem pagamento' };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
function codeOf(value: unknown) { return value && typeof value === 'object' && 'code' in value ? String(value.code) : ''; }
function paidError(failure: unknown, fallback: string) {
  const code = codeOf(failure);
  if (code === '42501') return 'Seu perfil não tem permissão para importar pagamentos de Contas a Pagar.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (['PGRST202', '42P01', '42883', 'P0021'].includes(code) || code === 'P0043' && failure && typeof failure === 'object' && 'activation_required' in failure && failure.activation_required === true) return 'Ative a atualização 043 no banco e na função payables-import para conciliar as escolhas junto com o arquivo.';
  if (code === 'P0043') return payableError(failure, fallback);
  if (code === 'P0042') return 'Este título possui pagamento ou baixa anterior que precisa de conferência. Reanalise o arquivo e confira a situação antes de conciliar.';
  if (code === '40001') return 'A base ou os pagamentos mudaram desde a análise. Nenhum dado desta tentativa foi alterado. Reanalise o mesmo arquivo antes de concluir.';
  if (['22023', '23514', 'P0016'].includes(code)) return 'Importação recusada. Confira o valor integral pago, a data real, o banco e a correspondência de cada título. Nenhum dado foi alterado.';
  return fallback;
}
function problemsOf(value: unknown): ImportProblem[] {
  if (!value || typeof value !== 'object' || !('errors' in value) || !Array.isArray(value.errors)) return [];
  return value.errors.slice(0, 100).filter((item): item is ImportProblem => !!item && typeof item === 'object' && Number.isSafeInteger(item.line) && typeof item.column === 'string' && typeof item.problem === 'string' && typeof item.correction === 'string');
}
function validCanonical(value: CanonicalPaid, expectedHash: string) {
  if (!value || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 5000 || value.file_sha256 !== expectedHash || !/^[a-f0-9]{64}$/.test(value.file_sha256)) return false;
  const p = value.preview;
  if (!p || p.reconciliation_version !== '043' || p.mode !== 'payments' || p.row_count !== value.rows.length || !(p.previous_import_id === null || uuid(p.previous_import_id)) || typeof p.can_commit !== 'boolean' || !validReconciliationItems(p.reconciliation_items)) return false;
  if (!Number.isSafeInteger(p.writeoff_count) || p.writeoff_count < 0 || p.writeoff_count > p.row_count) return false;
  if (typeof p.financial_revision !== 'string' || !p.financial_revision.trim() || p.financial_revision.length > 256) return false;
  if (['row_count', 'new_payment_count', 'matched_payment_count', 'correction_count', 'conflict_count'].some(key => !Number.isSafeInteger(p[key as keyof PaidPreview]) || Number(p[key as keyof PaidPreview]) < 0 || Number(p[key as keyof PaidPreview]) > p.row_count)) return false;
  if (!Array.isArray(p.errors) || !Array.isArray(p.unmapped_banks) || !Array.isArray(p.bank_options) || !p.bank_options.every(bank => uuid(bank.id) && typeof bank.display_name === 'string')) return false;
  if (p.unclassified_plans !== undefined && (!Array.isArray(p.unclassified_plans) || !p.unclassified_plans.every(plan => typeof plan.plan === 'string' && Number.isSafeInteger(plan.count) && plan.count > 0 && Number.isSafeInteger(plan.total_cents) && plan.total_cents >= 0))) return false;
  if (p.macros !== undefined && (!Array.isArray(p.macros) || !p.macros.every(macro => typeof macro === 'string' && macro.trim()))) return false;
  if (!p.unmapped_banks.every(bank => typeof bank.key === 'string' && typeof bank.branch === 'string' && typeof bank.paid_bank === 'string' && Number.isSafeInteger(bank.count) && bank.count > 0)) return false;
  if (!value.rows.every(row => Number.isSafeInteger(row.line) && row.line > 0 && typeof row.entry_number === 'string' && typeof row.branch === 'string' && typeof row.paid_on === 'string' && typeof row.paid_bank === 'string' && Number.isSafeInteger(row.amount_paid_cents) && row.amount_paid_cents > 0 && typeof row.outcome === 'string')) return false;
  if (p.can_commit && (p.errors.length || p.conflict_count || p.unmapped_banks.length || p.unclassified_plans?.length || p.new_payment_count + p.matched_payment_count + p.correction_count + p.writeoff_count !== p.row_count || value.rows.some(row => !['NEW_PAYMENT', 'MATCHED', 'CORRECTION', 'WRITE_OFF'].includes(row.outcome)))) return false;
  return true;
}

export default function PayablePaidImport({ canImport, onBusyChange }: { canImport: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [declaredPaid, setDeclaredPaid] = useState(false);
  const [analysis, setAnalysis] = useState<PaidAnalysis | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [planMappings, setPlanMappings] = useState<Record<string, string>>({});
  const [mappingDirty, setMappingDirty] = useState(false);
  const [problems, setProblems] = useState<ImportProblem[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState<'analyzing' | 'saving' | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [writeUncertain, setWriteUncertain] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ResolutionDraft>>({}), [pendingRequest, setPendingRequest] = useState<FrozenPaid | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<FrozenPaid | null>(null);
  useEffect(() => () => { generation.current += 1; controller.current?.abort(); }, []);
  useEffect(() => { onBusyChange?.(!!busy || writeUncertain); return () => onBusyChange?.(false); }, [busy, writeUncertain, onBusyChange]);
  useEffect(() => {
    if (!pendingRequest && busy !== 'saving') return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [pendingRequest, busy]);

  function reset() {
    if (pendingRef.current) return;
    generation.current += 1; controller.current?.abort(); setAnalysis(null); setMappings({}); setPlanMappings({}); setDrafts({}); setMappingDirty(false);
    setProblems([]); setError(''); setSuccess(''); setNeedsReview(false); setWriteUncertain(false); setBusy(null);
  }
  async function analyze(event?: FormEvent) {
    event?.preventDefault(); if (!canImport || !file || !declaredPaid || busy || pendingRef.current) return;
    const current = ++generation.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy('analyzing'); setProblems([]); setError(''); setSuccess('');
    const previous = analysis; const selectedMappings = { ...mappings }, selectedPlans = { ...planMappings };
    const selectedChoices = previous ? resolutionChoices(previous.preview.reconciliation_items, drafts, previous.preview.bank_options, officialToday()).choices : {};
    try {
      // Reanálises usam os mesmos bytes já conferidos, inclusive após resposta incerta.
      const parsed = previous && previous.file === file ? { base64: previous.base64, hash: previous.file_sha256, errors: [] as ImportProblem[] } : await analyzePayablePaymentsFile(file, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      if (parsed.errors.length) { setAnalysis(null); setProblems(parsed.errors); setNeedsReview(true); return; }
      const canonical = await payableImportRequest<CanonicalPaid>({ action: 'preview', mode: 'payments', reconciliation_version: '043', resolution_choices: selectedChoices, file_name: file.name, file_base64: parsed.base64, bank_mappings: selectedMappings, mappings: selectedPlans } as PaidRequest, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      if (canonical?.preview?.reconciliation_version !== '043') throw { code: 'P0043', activation_required: true };
      if (!validCanonical(canonical, parsed.hash) || canonical.preview.reconciliation_items.some(item => selectedChoices[item.key] && item.selected_action !== selectedChoices[item.key].action)) throw new Error('invalid-preview');
      setAnalysis({ ...canonical, file, base64: parsed.base64, choices: selectedChoices }); setProblems(canonical.preview.errors.slice(0, 100)); setMappingDirty(false); setNeedsReview(false);
    } catch (failure) {
      if (current !== generation.current || abort.signal.aborted) return;
      const found = problemsOf(failure); if (found.length) setProblems(found);
      setNeedsReview(true);
      setError(paidError(failure, 'Não foi possível concluir a análise dos pagamentos. Nenhum dado foi alterado. Confira o arquivo e tente novamente.'));
    } finally { if (current === generation.current) setBusy(null); }
  }
  const preview = analysis?.preview;
  const resolution = analysis ? resolutionChoices(analysis.preview.reconciliation_items, drafts, analysis.preview.bank_options, officialToday()) : { choices: {}, unresolved: 0 };
  const canCommit = !!analysis && !!preview?.can_commit && !needsReview && !mappingDirty && !problems.length && !resolution.unresolved && !pendingRequest && preview.conflict_count === 0 && preview.unmapped_banks.length === 0 && !preview.unclassified_plans?.length && declaredPaid && canImport && !busy;
  async function executeFrozen(request: FrozenPaid) {
    if (busy) return;
    pendingRef.current = request;
    const current = generation.current; setBusy('saving'); setError(''); setSuccess('');
    try {
      const result = await payableImportRequest<PaidResult>(request.body);
      if (current !== generation.current) return;
      if (!result || !uuid(result.import_id) || result.request_id !== request.body.request_id || result.row_count !== request.rowCount || ['new_payment_count', 'matched_payment_count', 'reviewed_count', 'writeoff_count'].some(key => !Number.isSafeInteger(result[key as keyof PaidResult]) || Number(result[key as keyof PaidResult]) < 0 || Number(result[key as keyof PaidResult]) > result.row_count) || typeof result.idempotent !== 'boolean') throw new Error('unconfirmed');
      pendingRef.current = null; setPendingRequest(null);
      setSuccess(result.idempotent ? `Este envio já estava registrado. ${result.row_count} título(s) conferido(s), sem duplicar pagamentos ou baixas.` : `Importação concluída: ${result.new_payment_count} novo(s) pagamento(s), ${result.matched_payment_count} já registrado(s), ${result.reviewed_count} conciliado(s) e ${result.writeoff_count} baixa(s) sem pagamento.${request.correctionCount ? ` ${request.correctionCount} correção(ões) com histórico preservado.` : ''}`);
      setAnalysis(null); setFile(null); setDeclaredPaid(false); setMappings({}); setPlanMappings({}); setDrafts({}); setMappingDirty(false); setNeedsReview(false); setWriteUncertain(false); setProblems([]); if (fileInput.current) fileInput.current.value = '';
    } catch (failure) {
      if (current !== generation.current) return;
      const known = ['42501', 'PGRST301', 'PGRST303', 'PGRST202', '42P01', '42883', 'P0021', 'P0042', 'P0043', '40001', '22023', '23514', 'P0016'].includes(codeOf(failure));
      setNeedsReview(true); setWriteUncertain(!known);
      if (known) { pendingRef.current = null; setPendingRequest(null); } else setPendingRequest(request);
      const found = problemsOf(failure); if (found.length) setProblems(found);
      setError(paidError(failure, 'Não foi possível confirmar o resultado. O arquivo, as escolhas e o protocolo foram preservados. Repita a confirmação pendente para conferir o mesmo envio sem duplicar pagamentos ou baixas.'));
    } finally { if (current === generation.current) setBusy(null); }
  }
  function commit() {
    if (!canCommit || !analysis || pendingRef.current) return;
    const frozen = analysis;
    if (!window.confirm(`Importar e conciliar este arquivo em uma única confirmação?\n\nArquivo: ${frozen.file.name}\nTítulos: ${frozen.preview.row_count}\nNovos pagamentos: ${frozen.preview.new_payment_count}\nJá registrados: ${frozen.preview.matched_payment_count}\nBaixas sem pagamento confirmadas: ${frozen.preview.writeoff_count}\nCorreções anteriores: ${frozen.preview.correction_count}\n\nOs pagamentos usarão data, valor e conta efetivos do relatório e serão conciliados. Cada baixa de R$ 0,01 confirmada ficará no histórico, fora dos totais financeiros, sem criar pagamento ou realizado. Nenhum título ausente será baixado por este arquivo.${frozen.preview.correction_count ? '\n\nCorreções preservam o histórico do registro anterior.' : ''}`)) return;
    const request: FrozenPaid = { rowCount: frozen.preview.row_count, correctionCount: frozen.preview.correction_count, body: { action: 'commit', mode: 'payments', reconciliation_version: '043', resolution_choices: frozen.choices, request_id: crypto.randomUUID(), file_name: frozen.file.name, file_base64: frozen.base64, complete: true, previous_import_id: frozen.preview.previous_import_id, previous_financial_revision: frozen.preview.financial_revision, bank_mappings: { ...mappings }, mappings: { ...planMappings }, confirm_corrections: frozen.preview.correction_count > 0 } };
    void executeFrozen(request);
  }
  if (!canImport) return <p className="notice">Seu perfil não permite importar títulos pagos de Contas a Pagar.</p>;
  return <section className="panel payable-paid-import" aria-labelledby="payable-paid-import-title">
    <div className="panel-header"><div><h2 id="payable-paid-import-title">Importar títulos pagos</h2><p className="muted">Pagamentos efetivos do relatório do sistema · conciliação automática dos títulos conferidos.</p></div></div>
    <p className="notice">Use o relatório dos pagamentos integrais do período. Cada marcador de <strong>R$ 0,01</strong> exige sua confirmação individual como Somente baixado: fica no histórico, fora dos valores financeiros e sem criar pagamento. Títulos ausentes permanecem na base.</p>
    <details className="import-format-help"><summary>Como preparar o relatório de pagamentos</summary><p className="help-text">Neste relatório, “Vencimento: data” corresponde à data real do pagamento, “Emissão: valor do lançamento” ao valor integral pago e “Plano cc - Conta: nome” à conta que realizou o pagamento. O valor integral pago atualiza o valor do título conforme o ERP, com histórico, e o vencimento original da previsão será preservado. Situação: PAGO. Títulos sem correspondência ou com pagamento manual divergente exigem conferência.</p></details>
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}{pendingRequest && <div className="notice" role="status"><p>A confirmação está pendente. O arquivo e as escolhas estão congelados para conferir este mesmo envio.</p><button type="button" className="button secondary" disabled={!!busy} onClick={() => void executeFrozen(pendingRequest)}>Repetir confirmação pendente</button></div>}
    <form className="stack" onSubmit={event => void analyze(event)}>
      <label className="field">Relatório de títulos pagos<input ref={fileInput} aria-label="Relatório de títulos pagos" type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={!!busy || writeUncertain} onChange={event => { if (pendingRef.current) return; reset(); setDeclaredPaid(false); setFile(event.target.files?.[0] ?? null); }} /></label>
      <p className="help-text">Até 2 MiB e 5.000 títulos. .xlsx, .xlsm ou .csv UTF-8. Para .xls, salve uma cópia como .xlsx. O arquivo original será preservado; macros não são executadas.</p>
      <label className="checkbox-field"><input type="checkbox" checked={declaredPaid} disabled={!!busy || writeUncertain} onChange={event => { setDeclaredPaid(event.target.checked); if (!event.target.checked) { setAnalysis(null); setNeedsReview(false); } setSuccess(''); }} />Confirmo que este é o relatório de pagamentos do período; os dados efetivos e cada baixa sem pagamento serão conferidos antes de importar.</label>
      <div className="inline-actions"><button type="submit" className="button" disabled={!file || !declaredPaid || !!busy || !!pendingRequest}>{busy === 'analyzing' ? 'Analisando pagamentos…' : analysis || needsReview ? 'Reanalisar mesmo arquivo' : 'Analisar pagamentos'}</button>{busy === 'analyzing' && !pendingRequest && <button type="button" className="button secondary" onClick={() => { generation.current += 1; controller.current?.abort(); setBusy(null); setNeedsReview(true); }}>Cancelar análise de pagamentos</button>}</div>
    </form>
    {problems.length > 0 && <div className="payable-paid-problems"><p className="notice error" role="alert">Importação bloqueada. Nenhum dado foi alterado. Corrija as divergências e reanalise o arquivo.</p><div className="table-wrap"><table><caption>Problemas dos pagamentos · até 100 linhas</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.map((problem, index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div></div>}
    {analysis && preview && <div className="payable-paid-analysis stack"><h3>Conferência dos pagamentos</h3><p className="help-text">Arquivo analisado: {analysis.file.name}. A conclusão utilizará exatamente o arquivo desta análise.</p><dl className="payable-paid-metrics"><div><dt>Títulos no arquivo</dt><dd>{preview.row_count}</dd></div><div><dt>Novos pagamentos</dt><dd>{preview.new_payment_count}</dd></div><div><dt>Já registrados</dt><dd>{preview.matched_payment_count}</dd></div><div><dt>Correções de importações</dt><dd>{preview.correction_count}</dd></div><div><dt>Baixas sem pagamento</dt><dd>{preview.writeoff_count}</dd></div><div><dt>Divergências</dt><dd>{preview.conflict_count}</dd></div></dl>
      {!!preview.unclassified_plans?.length && <div className="payable-paid-bank-mapping"><h3>Classificar novos Planos de Contas</h3><p className="help-text">Escolha o Macro de cada plano novo. A classificação será preservada para as próximas importações; depois de escolher, reanalise este arquivo.</p><div className="table-wrap"><table><thead><tr><th>Plano de Contas</th><th>Títulos</th><th>Valor pago</th><th>Centro de Custo Macro</th></tr></thead><tbody>{preview.unclassified_plans.map((item, index) => <tr key={item.plan}><td>{item.plan}</td><td>{item.count}</td><td>{formatCents(item.total_cents)}</td><td><select aria-label={`Macro para plano pago ${index + 1}`} value={planMappings[item.plan] ?? ''} disabled={!!busy || !!pendingRequest} onChange={event => { const value = event.target.value; setPlanMappings(previous => ({ ...previous, [item.plan]: value })); setMappingDirty(true); }}><option value="">NÃO CLASSIFICADO</option>{preview.macros?.map(macro => <option key={macro}>{macro}</option>)}</select></td></tr>)}</tbody></table></div></div>}
      {preview.unmapped_banks.length > 0 && <div className="payable-paid-bank-mapping"><h3>Vincular bancos do relatório às contas oficiais</h3><p className="help-text">Escolha a conta oficial para cada filial e nome de banco encontrado. A Central não presume a conta pelo texto. Depois, reanalise o mesmo arquivo.</p>{preview.unmapped_banks.map((item, index) => <label className="field" key={item.key}>Filial {item.branch} · {item.paid_bank || 'Banco não informado'} · {item.count} título(s)<select aria-label={`Conta oficial para banco ${index + 1}`} value={mappings[item.key] ?? ''} disabled={!!busy || !!pendingRequest} onChange={event => { const value = event.target.value; setMappings(previous => ({ ...previous, [item.key]: value })); setMappingDirty(true); }}><option value="">Selecione a conta oficial</option>{preview.bank_options.map(bank => <option key={bank.id} value={bank.id}>{bank.display_name}</option>)}</select></label>)}</div>}
      <PayableImportReconciliation items={preview.reconciliation_items} banks={preview.bank_options} drafts={drafts} disabled={!!busy || !!pendingRequest} today={officialToday()} onChange={(key, value) => { setDrafts(previous => ({ ...previous, [key]: value })); setMappingDirty(true); setError(''); }} />
      {mappingDirty && <p className="notice" role="status">Vínculos alterados. Reanalise os pagamentos para confirmar a correspondência antes de importar.</p>}
      <div className="table-wrap"><table><caption>Prévia dos pagamentos · {Math.min(10, analysis.rows.length)} de {analysis.rows.length} títulos</caption><thead><tr><th>Linha / lançamento</th><th>Filial</th><th>Nº cheque do arquivo</th><th>Valor informado no arquivo</th><th>Data real do pagamento</th><th>Banco efetivo informado</th><th>Plano / Macro</th><th>Emissão</th><th>Vencimento original da previsão</th><th>Conferência</th></tr></thead><tbody>{analysis.rows.slice(0, 10).map((row, index) => <tr key={index}><td>{row.line}<strong>{row.entry_number}</strong>{row.description && <small>{row.description}</small>}</td><td>{row.branch}</td><td>{row.cheque_number || 'Não informado'}</td><td>{formatCents(row.amount_paid_cents)}{['WRITE_OFF', 'WRITE_OFF_PENDING'].includes(row.outcome) && <small>Marcador de baixa; não é valor pago.</small>}{row.amount_changed && Number.isSafeInteger(row.previous_amount_cents) && <small>Valor anterior: {formatCents(row.previous_amount_cents!)}</small>}</td><td>{['WRITE_OFF', 'WRITE_OFF_PENDING'].includes(row.outcome) ? 'Sem pagamento' : dateLabel(row.paid_on)}</td><td>{['WRITE_OFF', 'WRITE_OFF_PENDING'].includes(row.outcome) ? 'Não se aplica à baixa' : row.paid_bank || 'Não informado'}{row.bank_account_id && <small>{preview.bank_options.find(bank => bank.id === row.bank_account_id)?.display_name ?? 'Conta oficial vinculada'}</small>}</td><td>{row.plan || 'Plano atual preservado'}<small>{row.target_macro || 'Classificação a conferir'}</small></td><td>{dateLabel(row.issued_on ?? null)}</td><td>{dateLabel(row.forecast_due_date)}</td><td>{outcomes[row.outcome] ?? 'Conferir título'}{row.problem && <small>{row.problem}</small>}</td></tr>)}</tbody></table></div>
      {(!preview.can_commit || preview.conflict_count > 0 || preview.unmapped_banks.length > 0 || !!preview.unclassified_plans?.length) && <p className="notice">A conclusão está bloqueada até resolver todos os títulos e bancos pendentes.</p>}
      <button className="button" type="button" disabled={!canCommit} onClick={commit}>{busy === 'saving' ? 'Importando pagamentos…' : 'Concluir importação dos pagamentos'}</button>
    </div>}
  </section>;
}
