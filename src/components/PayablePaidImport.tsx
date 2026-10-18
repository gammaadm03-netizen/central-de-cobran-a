import { useEffect, useRef, useState, type FormEvent } from 'react';
import { analyzePayablePaymentsFile, dateLabel, formatCents, payableImportRequest, type ImportProblem } from '../lib/payables';
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
}
interface CanonicalPaid { rows: PaidRow[]; preview: PaidPreview; file_sha256: string }
interface PaidAnalysis extends CanonicalPaid { file: File; base64: string }
interface PaidResult { import_id: string; row_count: number; new_payment_count: number; matched_payment_count: number; reviewed_count: number; correction_count?: number; idempotent: boolean }
const outcomes: Record<string, string> = { NEW_PAYMENT: 'Novo pagamento', MATCHED: 'Pagamento já registrado', CORRECTION: 'Correção de importação anterior', CONFLICT: 'Divergência — conferir', UNKNOWN_TITLE: 'Título não encontrado', UNMAPPED_BANK: 'Vincular banco / conta' };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
function codeOf(value: unknown) { return value && typeof value === 'object' && 'code' in value ? String(value.code) : ''; }
function paidError(failure: unknown, fallback: string) {
  const code = codeOf(failure);
  if (code === '42501') return 'Seu perfil não tem permissão para importar pagamentos de Contas a Pagar.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (['PGRST202', '42P01', '42883', 'P0021'].includes(code)) return 'A importação de títulos pagos precisa da atualização do banco e do serviço de importação. Nenhum dado foi alterado.';
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
  if (!p || p.mode !== 'payments' || p.row_count !== value.rows.length || !(p.previous_import_id === null || uuid(p.previous_import_id)) || typeof p.can_commit !== 'boolean') return false;
  if (typeof p.financial_revision !== 'string' || !p.financial_revision.trim() || p.financial_revision.length > 256) return false;
  if (['row_count', 'new_payment_count', 'matched_payment_count', 'correction_count', 'conflict_count'].some(key => !Number.isSafeInteger(p[key as keyof PaidPreview]) || Number(p[key as keyof PaidPreview]) < 0 || Number(p[key as keyof PaidPreview]) > p.row_count)) return false;
  if (!Array.isArray(p.errors) || !Array.isArray(p.unmapped_banks) || !Array.isArray(p.bank_options) || !p.bank_options.every(bank => uuid(bank.id) && typeof bank.display_name === 'string')) return false;
  if (p.unclassified_plans !== undefined && (!Array.isArray(p.unclassified_plans) || !p.unclassified_plans.every(plan => typeof plan.plan === 'string' && Number.isSafeInteger(plan.count) && plan.count > 0 && Number.isSafeInteger(plan.total_cents) && plan.total_cents >= 0))) return false;
  if (p.macros !== undefined && (!Array.isArray(p.macros) || !p.macros.every(macro => typeof macro === 'string' && macro.trim()))) return false;
  if (!p.unmapped_banks.every(bank => typeof bank.key === 'string' && typeof bank.branch === 'string' && typeof bank.paid_bank === 'string' && Number.isSafeInteger(bank.count) && bank.count > 0)) return false;
  if (!value.rows.every(row => Number.isSafeInteger(row.line) && row.line > 0 && typeof row.entry_number === 'string' && typeof row.branch === 'string' && typeof row.paid_on === 'string' && typeof row.paid_bank === 'string' && Number.isSafeInteger(row.amount_paid_cents) && row.amount_paid_cents > 0 && typeof row.outcome === 'string')) return false;
  if (p.can_commit && (p.errors.length || p.conflict_count || p.unmapped_banks.length || p.unclassified_plans?.length || p.new_payment_count + p.matched_payment_count + p.correction_count !== p.row_count || value.rows.some(row => !['NEW_PAYMENT', 'MATCHED', 'CORRECTION'].includes(row.outcome)))) return false;
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
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { generation.current += 1; controller.current?.abort(); }, []);
  useEffect(() => { onBusyChange?.(!!busy || writeUncertain); return () => onBusyChange?.(false); }, [busy, writeUncertain, onBusyChange]);

  function reset() {
    generation.current += 1; controller.current?.abort(); setAnalysis(null); setMappings({}); setPlanMappings({}); setMappingDirty(false);
    setProblems([]); setError(''); setSuccess(''); setNeedsReview(false); setWriteUncertain(false); setBusy(null);
  }
  async function analyze(event?: FormEvent) {
    event?.preventDefault(); if (!canImport || !file || !declaredPaid || busy) return;
    const current = ++generation.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy('analyzing'); setProblems([]); setError(''); setSuccess('');
    const previous = analysis; const selectedMappings = { ...mappings }, selectedPlans = { ...planMappings };
    try {
      // Reanálises usam os mesmos bytes já conferidos, inclusive após resposta incerta.
      const parsed = previous && previous.file === file ? { base64: previous.base64, hash: previous.file_sha256, errors: [] as ImportProblem[] } : await analyzePayablePaymentsFile(file, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      if (parsed.errors.length) { setAnalysis(null); setProblems(parsed.errors); setNeedsReview(true); return; }
      const canonical = await payableImportRequest<CanonicalPaid>({ action: 'preview', mode: 'payments', file_name: file.name, file_base64: parsed.base64, bank_mappings: selectedMappings, mappings: selectedPlans }, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      if (!validCanonical(canonical, parsed.hash)) throw new Error('invalid-preview');
      setAnalysis({ ...canonical, file, base64: parsed.base64 }); setProblems(canonical.preview.errors.slice(0, 100)); setMappingDirty(false); setNeedsReview(false);
    } catch (failure) {
      if (current !== generation.current || abort.signal.aborted) return;
      const found = problemsOf(failure); if (found.length) setProblems(found);
      setNeedsReview(true);
      setError(paidError(failure, 'Não foi possível concluir a análise dos pagamentos. Nenhum dado foi alterado. Confira o arquivo e tente novamente.'));
    } finally { if (current === generation.current) setBusy(null); }
  }
  const preview = analysis?.preview;
  const canCommit = !!analysis && !!preview?.can_commit && !needsReview && !mappingDirty && !problems.length && preview.conflict_count === 0 && preview.unmapped_banks.length === 0 && !preview.unclassified_plans?.length && declaredPaid && canImport && !busy;
  async function commit() {
    if (!canCommit || !analysis) return;
    const frozen = analysis; const bankMappings = { ...mappings }, macroMappings = { ...planMappings };
    if (!window.confirm(`Importar os pagamentos efetivos deste arquivo?\n\nArquivo: ${frozen.file.name}\nTítulos: ${frozen.preview.row_count}\nNovos pagamentos: ${frozen.preview.new_payment_count}\nJá registrados: ${frozen.preview.matched_payment_count}\nCorreções de importações anteriores: ${frozen.preview.correction_count}\n\nOs títulos serão conferidos e marcados como CONCILIADO conforme os dados validados. Valores, datas e contas efetivos comporão o realizado por Macro. Nenhum título ausente será baixado por este arquivo.${frozen.preview.correction_count ? '\n\nAs correções estornam o registro anterior gerado por importação e gravam o novo pagamento, preservando o histórico.' : ''}`)) return;
    const current = generation.current; const abort = new AbortController(); controller.current = abort;
    setBusy('saving'); setError(''); setSuccess('');
    try {
      const result = await payableImportRequest<PaidResult>({ action: 'commit', mode: 'payments', file_name: frozen.file.name, file_base64: frozen.base64, complete: true, previous_import_id: frozen.preview.previous_import_id, previous_financial_revision: frozen.preview.financial_revision, bank_mappings: bankMappings, mappings: macroMappings, confirm_corrections: frozen.preview.correction_count > 0 }, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      if (!result || !uuid(result.import_id) || result.row_count !== frozen.preview.row_count || ['new_payment_count', 'matched_payment_count', 'reviewed_count'].some(key => !Number.isSafeInteger(result[key as keyof PaidResult]) || Number(result[key as keyof PaidResult]) < 0 || Number(result[key as keyof PaidResult]) > result.row_count) || typeof result.idempotent !== 'boolean') throw new Error('unconfirmed');
      setSuccess(result.idempotent ? `Este arquivo já estava registrado. ${result.row_count} título(s) conferido(s), sem duplicar pagamentos.` : `Pagamentos importados: ${result.row_count} título(s), ${result.new_payment_count} novo(s) pagamento(s), ${result.matched_payment_count} já registrado(s) e ${result.reviewed_count} conciliado(s).${frozen.preview.correction_count ? ` ${frozen.preview.correction_count} correção(ões) com histórico preservado.` : ''}`);
      setAnalysis(null); setFile(null); setDeclaredPaid(false); setMappings({}); setPlanMappings({}); setMappingDirty(false); setNeedsReview(false); setWriteUncertain(false); setProblems([]); if (fileInput.current) fileInput.current.value = '';
    } catch (failure) {
      if (current !== generation.current || abort.signal.aborted) return;
      setNeedsReview(true); setWriteUncertain(!['42501', 'PGRST301', 'PGRST303', 'PGRST202', '42P01', '42883', 'P0021', '40001', '22023', '23514', 'P0016'].includes(codeOf(failure))); const found = problemsOf(failure); if (found.length) setProblems(found);
      setError(paidError(failure, 'Não foi possível confirmar o resultado da importação. O arquivo e seu preenchimento foram mantidos. Reanalise este mesmo arquivo antes de tentar novamente; pagamentos já registrados serão reconhecidos sem duplicação.'));
    } finally { if (current === generation.current) setBusy(null); }
  }
  if (!canImport) return <p className="notice">Seu perfil não permite importar títulos pagos de Contas a Pagar.</p>;
  return <section className="panel payable-paid-import" aria-labelledby="payable-paid-import-title">
    <div className="panel-header"><div><h2 id="payable-paid-import-title">Importar títulos pagos</h2><p className="muted">Pagamentos efetivos do relatório do sistema · conciliação automática dos títulos conferidos.</p></div></div>
    <p className="notice">Use somente o relatório de títulos efetivamente <strong>PAGOS INTEGRALMENTE</strong>. Este arquivo pode conter apenas os pagamentos do período; sua ausência não baixa outros títulos.</p>
    <details className="import-format-help"><summary>Como preparar o relatório de pagamentos</summary><p className="help-text">Neste relatório, “Vencimento: data” corresponde à data real do pagamento, “Emissão: valor do lançamento” ao valor integral pago e “Plano cc - Conta: nome” à conta que realizou o pagamento. O valor integral pago atualiza o valor do título conforme o ERP, com histórico, e o vencimento original da previsão será preservado. Situação: PAGO. Títulos sem correspondência ou com pagamento manual divergente exigem conferência.</p></details>
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    <form className="stack" onSubmit={event => void analyze(event)}>
      <label className="field">Relatório de títulos pagos<input ref={fileInput} aria-label="Relatório de títulos pagos" type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={!!busy || writeUncertain} onChange={event => { reset(); setDeclaredPaid(false); setFile(event.target.files?.[0] ?? null); }} /></label>
      <p className="help-text">Até 2 MiB e 5.000 títulos. .xlsx, .xlsm ou .csv UTF-8. Para .xls, salve uma cópia como .xlsx. O arquivo original será preservado; macros não são executadas.</p>
      <label className="checkbox-field"><input type="checkbox" checked={declaredPaid} disabled={!!busy || writeUncertain} onChange={event => { setDeclaredPaid(event.target.checked); if (!event.target.checked) { setAnalysis(null); setNeedsReview(false); } setSuccess(''); }} />Confirmo que todos os títulos deste arquivo foram pagos integralmente, com data real e banco efetivo informados.</label>
      <div className="inline-actions"><button type="submit" className="button" disabled={!file || !declaredPaid || !!busy}>{busy === 'analyzing' ? 'Analisando pagamentos…' : analysis || needsReview ? 'Reanalisar mesmo arquivo' : 'Analisar pagamentos'}</button>{busy === 'analyzing' && <button type="button" className="button secondary" onClick={() => { generation.current += 1; controller.current?.abort(); setBusy(null); setNeedsReview(true); }}>Cancelar análise de pagamentos</button>}</div>
    </form>
    {problems.length > 0 && <div className="payable-paid-problems"><p className="notice error" role="alert">Importação bloqueada. Nenhum dado foi alterado. Corrija as divergências e reanalise o arquivo.</p><div className="table-wrap"><table><caption>Problemas dos pagamentos · até 100 linhas</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.map((problem, index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div></div>}
    {analysis && preview && <div className="payable-paid-analysis stack"><h3>Conferência dos pagamentos</h3><p className="help-text">Arquivo analisado: {analysis.file.name}. A conclusão utilizará exatamente o arquivo desta análise.</p><dl className="payable-paid-metrics"><div><dt>Títulos no arquivo</dt><dd>{preview.row_count}</dd></div><div><dt>Novos pagamentos</dt><dd>{preview.new_payment_count}</dd></div><div><dt>Já registrados</dt><dd>{preview.matched_payment_count}</dd></div><div><dt>Correções de importações</dt><dd>{preview.correction_count}</dd></div><div><dt>Divergências</dt><dd>{preview.conflict_count}</dd></div></dl>
      {!!preview.unclassified_plans?.length && <div className="payable-paid-bank-mapping"><h3>Classificar novos Planos de Contas</h3><p className="help-text">Escolha o Macro de cada plano novo. A classificação será preservada para as próximas importações; depois de escolher, reanalise este arquivo.</p><div className="table-wrap"><table><thead><tr><th>Plano de Contas</th><th>Títulos</th><th>Valor pago</th><th>Centro de Custo Macro</th></tr></thead><tbody>{preview.unclassified_plans.map((item, index) => <tr key={item.plan}><td>{item.plan}</td><td>{item.count}</td><td>{formatCents(item.total_cents)}</td><td><select aria-label={`Macro para plano pago ${index + 1}`} value={planMappings[item.plan] ?? ''} disabled={!!busy} onChange={event => { const value = event.target.value; setPlanMappings(previous => ({ ...previous, [item.plan]: value })); setMappingDirty(true); }}><option value="">NÃO CLASSIFICADO</option>{preview.macros?.map(macro => <option key={macro}>{macro}</option>)}</select></td></tr>)}</tbody></table></div></div>}
      {preview.unmapped_banks.length > 0 && <div className="payable-paid-bank-mapping"><h3>Vincular bancos do relatório às contas oficiais</h3><p className="help-text">Escolha a conta oficial para cada filial e nome de banco encontrado. A Central não presume a conta pelo texto. Depois, reanalise o mesmo arquivo.</p>{preview.unmapped_banks.map((item, index) => <label className="field" key={item.key}>Filial {item.branch} · {item.paid_bank || 'Banco não informado'} · {item.count} título(s)<select aria-label={`Conta oficial para banco ${index + 1}`} value={mappings[item.key] ?? ''} disabled={!!busy} onChange={event => { const value = event.target.value; setMappings(previous => ({ ...previous, [item.key]: value })); setMappingDirty(true); }}><option value="">Selecione a conta oficial</option>{preview.bank_options.map(bank => <option key={bank.id} value={bank.id}>{bank.display_name}</option>)}</select></label>)}</div>}
      {mappingDirty && <p className="notice" role="status">Vínculos alterados. Reanalise os pagamentos para confirmar a correspondência antes de importar.</p>}
      <div className="table-wrap"><table><caption>Prévia dos pagamentos · {Math.min(10, analysis.rows.length)} de {analysis.rows.length} títulos</caption><thead><tr><th>Linha / lançamento</th><th>Filial</th><th>Nº cheque do arquivo</th><th>Valor integral pago</th><th>Data real do pagamento</th><th>Banco efetivo informado</th><th>Plano / Macro</th><th>Emissão</th><th>Vencimento original da previsão</th><th>Conferência</th></tr></thead><tbody>{analysis.rows.slice(0, 10).map((row, index) => <tr key={index}><td>{row.line}<strong>{row.entry_number}</strong>{row.description && <small>{row.description}</small>}</td><td>{row.branch}</td><td>{row.cheque_number || 'Não informado'}</td><td>{formatCents(row.amount_paid_cents)}{row.amount_changed && Number.isSafeInteger(row.previous_amount_cents) && <small>Valor anterior: {formatCents(row.previous_amount_cents!)}</small>}</td><td>{dateLabel(row.paid_on)}</td><td>{row.paid_bank || 'Não informado'}{row.bank_account_id && <small>{preview.bank_options.find(bank => bank.id === row.bank_account_id)?.display_name ?? 'Conta oficial vinculada'}</small>}</td><td>{row.plan || 'Plano atual preservado'}<small>{row.target_macro || 'Classificação a conferir'}</small></td><td>{dateLabel(row.issued_on ?? null)}</td><td>{dateLabel(row.forecast_due_date)}</td><td>{outcomes[row.outcome] ?? 'Conferir título'}{row.problem && <small>{row.problem}</small>}</td></tr>)}</tbody></table></div>
      {(!preview.can_commit || preview.conflict_count > 0 || preview.unmapped_banks.length > 0 || !!preview.unclassified_plans?.length) && <p className="notice">A conclusão está bloqueada até resolver todos os títulos e bancos pendentes.</p>}
      <button className="button" type="button" disabled={!canCommit} onClick={() => void commit()}>{busy === 'saving' ? 'Importando pagamentos…' : 'Concluir importação dos pagamentos'}</button>
    </div>}
  </section>;
}
