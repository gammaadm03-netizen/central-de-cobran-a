import { useEffect, useRef, useState, type FormEvent } from 'react';
import { commercialError, commercialImportRequest } from '../lib/commercial';
import { formatCents } from '../lib/payables';
import { officialToday } from './Treasury';
import type { HrImportRow } from '../lib/hr-parser.mjs';
import type { HrProjectedRow, HrQuality, HrSummary } from '../lib/hr';
import '../human-resources.css';

interface HrPreview { row_count: number; previous_import_id: string | null; summary: HrSummary; quality: HrQuality }
interface HrAnalysis { rows: HrProjectedRow[]; preview: HrPreview; file_sha256: string; format_version: 3 }
interface HrProblem { line: number; column: string; problem: string; correction: string }
interface Prepared { source: File; reference: string; base64: string; hash: string; analysis: HrAnalysis }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const hashPattern = /^[a-f\d]{64}$/;
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const money = (value: unknown) => value === null || Number.isSafeInteger(value);
const optionalMoney = (value: unknown) => value === undefined || money(value);
const displayMoney = (value: number | null | undefined) => value == null ? 'Não informado' : formatCents(value);
const displayDate = (value: string | null) => value === null ? 'Não informado' : value.split('-').reverse().join('/');
const qualityKeys = ['missing_admission', 'missing_birthday', 'missing_branch', 'missing_sector', 'missing_salary_base', 'missing_payroll_salary', 'missing_transport', 'missing_advance', 'missing_cost_allowance', 'missing_total'] as const;
function assertAnalysis(value: unknown, hash: string): asserts value is HrAnalysis {
  const result = value as HrAnalysis, preview = result?.preview, summary = preview?.summary;
  if (result?.format_version !== 3) throw new Error('hr_gateway_update_required');
  if (!result || result.file_sha256 !== hash || !hashPattern.test(result.file_sha256) || !preview || !safeCount(preview.row_count) || !preview.row_count || preview.row_count > 5000
    || preview.previous_import_id !== null && !uuid.test(preview.previous_import_id) || !Array.isArray(result.rows) || result.rows.length !== preview.row_count
    || result.rows.some(row => !row || !safeCount(row.source_row) || typeof row.employee !== 'string' || !row.employee.trim() || typeof row.branch !== 'string' || typeof row.sector !== 'string'
      || !['salary_base_cents', 'payroll_salary_cents', 'transport_cents', 'advance_cents', 'total_cents'].every(key => money(row[key as keyof HrImportRow])) || !optionalMoney(row.cost_allowance_cents) || !optionalMoney(row.reported_total_cents))
    || !summary || !['employees', 'partners', 'admissions', 'birthdays', 'basket_eligible', 'basket_excluded', 'basket_unit_cents', 'basket_monthly_cents', 'basket_annual_cents'].every(key => safeCount(summary[key as keyof HrSummary]))
    || !['salary_base_cents', 'transport_cents', 'advance_cents', 'total_cents'].every(key => money(summary[key as keyof HrSummary]))
    || !optionalMoney(summary.payroll_salary_cents) || !optionalMoney(summary.cost_allowance_cents) || !optionalMoney(summary.reported_total_cents) || !optionalMoney(summary.salary_base_all_cents)
    || !['prolabore_base_cents', 'prolabore_received_cents', 'employee_total_cents', 'partner_total_cents', 'payroll_salary_employees_cents'].every(key => optionalMoney(summary[key as keyof HrSummary]))
    || summary.compensation_groups_version !== undefined && summary.compensation_groups_version !== 'rh-compensation-groups-v1'
    || summary.total_formula_version !== undefined && summary.total_formula_version !== 'rh-five-fields-v1'
    || summary.employees + summary.partners !== preview.row_count || summary.basket_eligible + summary.basket_excluded !== preview.row_count || summary.basket_unit_cents !== 11280
    || summary.basket_monthly_cents !== summary.basket_eligible * 11280 || summary.basket_annual_cents !== summary.basket_monthly_cents * 12
    || !preview.quality || !qualityKeys.every(key => key === 'missing_cost_allowance' && preview.quality[key] === undefined || safeCount(preview.quality[key]))) throw new Error('invalid_preview');
}
const isPartner = (row: HrProjectedRow) => row.compensation_kind === 'prolabore' || row.sector.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toUpperCase() === 'SOCIO';
function sumMoney(rows: HrProjectedRow[], field: 'salary_base_cents' | 'payroll_salary_cents' | 'total_cents') {
  let total = 0n;
  for (const row of rows) { const value = row[field]; if (value == null) return null; total += BigInt(value); }
  return total < BigInt(Number.MIN_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(total);
}
function importProblems(failure: unknown): HrProblem[] {
  const problems = failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : null;
  if (!Array.isArray(problems)) return [];
  return problems.filter((problem): problem is HrProblem => !!problem && safeCount(problem.line) && typeof problem.column === 'string' && typeof problem.problem === 'string' && typeof problem.correction === 'string').slice(0, 100);
}
function fileBase64(bytes: Uint8Array) { let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }
async function fileHash(bytes: Uint8Array<ArrayBuffer>) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); }

export default function HumanResourcesImport({ canImport, onImported }: { canImport: boolean; onImported?: () => void }) {
  const [file, setFile] = useState<File | null>(null), [reference, setReference] = useState(officialToday), [acknowledged, setAcknowledged] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null), [busy, setBusy] = useState<'preview' | 'commit' | null>(null), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [problems, setProblems] = useState<HrProblem[]>([]);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  function clearPreparation() { generation.current++; controller.current?.abort(); setPrepared(null); setError(''); setSuccess(''); setProblems([]); setAcknowledged(false); }
  async function analyze(event: FormEvent) {
    event.preventDefault(); if (!canImport || !file || busy) return;
    if (!file.size || file.size > 2 * 1024 * 1024 || !/\.(?:xlsx|xlsm|csv)$/i.test(file.name)) { setError('Selecione uma base .xlsx, .xlsm ou .csv UTF-8 não vazia, de até 2 MiB. Para .xls antigo, salve uma cópia como .xlsx.'); return; }
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(reference) && Number.isFinite(Date.parse(reference + 'T12:00:00Z')) && new Date(reference + 'T12:00:00Z').toISOString().slice(0, 10) === reference;
    if (!validDate) { setError('Informe a data da posição desta base de RH / DP.'); return; }
    const current = ++generation.current, source = file, selectedReference = reference, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    setBusy('preview'); setError(''); setSuccess(''); setProblems([]); setPrepared(null); setAcknowledged(false);
    try {
      const bytes = new Uint8Array(await source.arrayBuffer()), hash = await fileHash(bytes);
      if (abort.signal.aborted || current !== generation.current) return;
      const base64 = fileBase64(bytes);
      const analysis = await commercialImportRequest<HrAnalysis>({ action: 'preview', mode: 'hr', reference_date: selectedReference, file_name: source.name, file_base64: base64 }, abort.signal);
      assertAnalysis(analysis, hash);
      if (!abort.signal.aborted && current === generation.current) setPrepared({ source, reference: selectedReference, base64, hash, analysis });
    } catch (failure) { if (!abort.signal.aborted && current === generation.current) {
      const details = importProblems(failure); if (details.length) setProblems(details); else setError(failure instanceof Error && failure.message === 'hr_gateway_update_required' ? 'Atualize a função business-import para reconhecer Salário Folha e Salário recebido. Depois, analise novamente. Nenhum dado foi alterado.' : commercialError(failure, 'Não foi possível analisar a base de RH / DP. Nenhum dado foi alterado.'));
    } } finally { if (current === generation.current) setBusy(null); }
  }
  async function commit() {
    if (!prepared || !acknowledged || !canImport || busy) return;
    const current = generation.current, ready = prepared; setBusy('commit'); setError(''); setSuccess(''); setProblems([]);
    try {
      const result = await commercialImportRequest<{ import_id: string; row_count: number; idempotent?: boolean }>({ action: 'commit', mode: 'hr', reference_date: ready.reference, file_name: ready.source.name, file_base64: ready.base64, previous_import_id: ready.analysis.preview.previous_import_id, complete: true });
      if (current !== generation.current) return;
      if (!result || !uuid.test(result.import_id) || result.row_count !== ready.analysis.preview.row_count) throw new Error('unknown_commit');
      setSuccess(result.idempotent ? 'Esta base já foi importada. A posição foi localizada sem criar outra cópia.' : `Base de RH / DP registrada: ${result.row_count} registro(s). A posição com a data mais recente alimenta a aba; as demais permanecem no histórico.`);
      setPrepared(null); setFile(null); setAcknowledged(false); setUncertain(false); if (input.current) input.current.value = ''; onImported?.();
    } catch (failure) { if (current === generation.current) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      const known = ['40001', '22023', '23514', '23505', '42501', 'PGRST301', 'PGRST303', 'PGRST202', 'PGRST205', '42P01', '42883'].includes(code);
      const details = importProblems(failure); if (details.length) setProblems(details);
      setError(commercialError(failure, known ? 'A importação não foi concluída. Confira a base antes de analisar novamente.' : 'A confirmação do envio não chegou. Mantenha o mesmo arquivo e clique em Analisar base de RH / DP para conferir o envio antes de tentar outra base.'));
      setUncertain(!known); setPrepared(null); setAcknowledged(false);
    } } finally { if (current === generation.current) setBusy(null); }
  }
  if (!canImport) return <p className="notice">Seu perfil não permite importar bases de RH / DP.</p>;
  const summary = prepared?.analysis.preview.summary, quality = prepared?.analysis.preview.quality;
  const calculatedTotal = summary?.total_formula_version === 'rh-five-fields-v1';
  const employees = prepared?.analysis.rows.filter(row => !isPartner(row)) ?? [], partners = prepared?.analysis.rows.filter(isPartner) ?? [];
  const grouped = summary?.compensation_groups_version === 'rh-compensation-groups-v1';
  const employeeBase = grouped ? summary?.salary_base_cents : sumMoney(employees, 'salary_base_cents');
  const employeeReceived = grouped ? summary?.payroll_salary_employees_cents : sumMoney(employees, 'payroll_salary_cents');
  const prolaboreBase = grouped ? summary?.prolabore_base_cents : sumMoney(partners, 'salary_base_cents');
  const prolaboreReceived = grouped ? summary?.prolabore_received_cents : sumMoney(partners, 'payroll_salary_cents');
  const employeeTotal = grouped ? summary?.employee_total_cents : calculatedTotal ? sumMoney(employees, 'total_cents') : null;
  const partnerTotal = grouped ? summary?.partner_total_cents : calculatedTotal ? sumMoney(partners, 'total_cents') : null;
  const missing = quality ? qualityKeys.reduce((sum, key) => sum + (quality[key] ?? 0), 0) : 0;
  return <section className="panel human-resources-import" aria-labelledby="hr-import-title">
    <div className="panel-header"><div><h2 id="hr-import-title">Importar base de RH / DP</h2><p className="muted">Envie a base completa de pessoas e valores para atualizar o quadro, os benefícios e o calendário.</p></div></div>
    <p className="help-text">Cabeçalhos: FILIAL, ADMISSAO, ANIVERSARIO, Salário Folha (ou Salário Base), VT TOTAL, Salário recebido, Adiantamento, Ajuda de Custo, SETOR e Funcionário. Salário Folha / Base é o valor sem descontos; Salário recebido é o valor com descontos. Os dois são importados separadamente. No setor SÓCIO, esses valores são classificados como pró-labore e ficam separados dos salários dos colaboradores. O formato antigo com dois cabeçalhos SALÁRIO também é aceito.</p>
    <p className="help-text">VT TOTAL, Adiantamento e Ajuda de Custo em branco ou com traço valem zero. Colunas ausentes permanecem como “Não informado”. O Total é calculado como remuneração sem descontos + VT total + remuneração recebida + Adiantamento + Ajuda de Custo, com subtotais separados para colaboradores e sócios. A coluna TOTAL do arquivo é opcional e fica preservada para conferência, sem ser somada novamente.</p>
    <p className="notice">Cada importação é uma posição completa de RH / DP. A posição com a data mais recente alimenta a aba; os arquivos e as posições anteriores permanecem preservados.</p>
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {uncertain && <p className="notice" role="status">Conferência do envio pendente. O arquivo e a data ficam preservados até a confirmação do mesmo envio.</p>}
    <form className="stack" onSubmit={event => void analyze(event)}><div className="form-grid"><label className="field">Arquivo da base de RH / DP<input ref={input} type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={busy !== null || uncertain} onChange={event => { clearPreparation(); setFile(event.target.files?.[0] ?? null); }} /></label><label className="field">Data da posição de RH<input type="date" min="1900-01-01" max={officialToday()} required value={reference} disabled={busy !== null || uncertain} onChange={event => { clearPreparation(); setReference(event.target.value); }} /></label></div>
      <p className="help-text">Até 2 MiB, 5.000 pessoas e uma única aba preenchida. Formatos .xlsx, .xlsm e .csv UTF-8. Fórmulas são recusadas; macros nunca são executadas.</p>
      <div className="inline-actions"><button type="submit" className="button" disabled={!file || !reference || busy !== null}>{busy === 'preview' ? 'Analisando base de RH / DP…' : 'Analisar base de RH / DP'}</button>{busy === 'preview' && !uncertain && <button type="button" className="button secondary" onClick={() => { clearPreparation(); setBusy(null); }}>Cancelar análise de RH</button>}</div>
    </form>
    {problems.length > 0 && <div className="table-wrap"><table><caption>Campos a corrigir no arquivo de RH / DP</caption><thead><tr><th>Linha</th><th>Coluna</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.map((problem, index) => <tr key={index}><td>{problem.line || 'Arquivo'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div>}
    {prepared && summary && <section className="stack" aria-labelledby="hr-preview-title"><h3 id="hr-preview-title">Conferência da posição de RH / DP</h3><p>{prepared.source.name} · {prepared.analysis.preview.row_count} registro(s) · posição de {prepared.reference.split('-').reverse().join('/')}</p>
      <div className="hr-import-preview"><article>Colaboradores / sócios<strong>{summary.employees} / {summary.partners}</strong></article><article>Salário Folha — colaboradores<strong>{displayMoney(employeeBase)}</strong></article><article>Salário recebido — colaboradores<strong>{displayMoney(employeeReceived)}</strong></article><article>Pró-labore sem descontos<strong>{displayMoney(prolaboreBase)}</strong></article><article>Pró-labore recebido<strong>{displayMoney(prolaboreReceived)}</strong></article><article>Vale-transporte<strong>{displayMoney(summary.transport_cents)}</strong></article><article>Adiantamentos<strong>{displayMoney(summary.advance_cents)}</strong></article><article>Ajuda de Custo<strong>{displayMoney(summary.cost_allowance_cents)}</strong></article><article>Cesta básica mensal<strong>{formatCents(summary.basket_monthly_cents)}</strong></article><article>{calculatedTotal ? 'Total de remunerações e benefícios' : 'TOTAL da posição anterior'}<strong>{displayMoney(summary.total_cents)}</strong></article></div>
      {calculatedTotal && <p className="help-text">Total = remuneração sem descontos + VT total + remuneração recebida + Adiantamento + Ajuda de Custo. Colaboradores: {displayMoney(employeeTotal)} · Sócios: {displayMoney(partnerTotal)}. A coluna TOTAL original é preservada para conferência.</p>}
      {missing > 0 && <p className="notice">A base contém {missing} campo(s) sem informação. Confira a amostra abaixo. Colunas ausentes permanecem como “Não informado”; os benefícios em branco nas colunas presentes são importados como zero.</p>}
      <div className="table-wrap"><table><caption>Amostra da base de RH / DP — até dez pessoas</caption><thead><tr><th>Linha</th><th>Funcionário</th><th>Filial</th><th>Setor</th><th>Tipo de remuneração</th><th>Admissão</th><th>Aniversário</th><th>Remuneração sem descontos</th><th>Remuneração recebida com descontos</th><th>VT TOTAL</th><th>Adiantamento</th><th>Ajuda de Custo</th><th>{calculatedTotal ? 'Total calculado' : 'TOTAL da posição anterior'}</th><th>TOTAL na origem</th></tr></thead><tbody>{prepared.analysis.rows.slice(0, 10).map(row => <tr key={row.source_row}><td>{row.source_row}</td><td>{row.employee}</td><td>{row.branch || 'Não informado'}</td><td>{row.sector || 'Não informado'}</td><td>{isPartner(row) ? 'Pró-labore' : 'Salário'}</td><td>{displayDate(row.admitted_on)}</td><td>{displayDate(row.birthday_on)}</td><td>{displayMoney(row.salary_base_cents)}</td><td>{displayMoney(row.payroll_salary_cents)}</td><td>{displayMoney(row.transport_cents)}</td><td>{displayMoney(row.advance_cents)}</td><td>{displayMoney(row.cost_allowance_cents)}</td><td>{displayMoney(row.total_cents)}</td><td>{displayMoney(row.reported_total_cents)}</td></tr>)}</tbody></table></div>
      <label className="checkbox-field"><input type="checkbox" checked={acknowledged} disabled={busy !== null} onChange={event => setAcknowledged(event.target.checked)} /> Confirmo que esta é a base completa de RH / DP da data informada e conferi os campos apresentados.</label>
      <button className="button" disabled={!acknowledged || busy !== null} onClick={() => void commit()}>{busy === 'commit' ? 'Atualizando RH / DP…' : 'Confirmar importação de RH / DP'}</button>
    </section>}
  </section>;
}
