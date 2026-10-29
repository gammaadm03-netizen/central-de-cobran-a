import { useEffect, useRef, useState } from 'react';
import { analyzePayableFile, dateLabel, formatCents, type ImportProblem, type PayableImportRow, type PayableResolutionChoice } from '../lib/payables';
import { parseMoneyCents } from '../lib/payables-parser.mjs';
import { dailyCivilDate, dailyImportError, dailyProblems, payableDailyRequest, validDailyCanonical, validDailyResult, type DailyAction, type DailyCanonical, type DailyReportKind, type DailyRequest } from '../lib/payable-daily';
import type { ResolutionDraft } from './PayableImportReconciliation';

interface Prepared { file: File; base64: string; hash: string; rows: PayableImportRow[]; emptyChequesConfirmed: boolean }
interface Analysis extends DailyCanonical { source: Prepared; choices: Record<string, PayableResolutionChoice>; mappings: Record<string, string>; bankMappings: Record<string, string> }
interface Frozen { body: DailyRequest; rows: number; paid: number; writtenOff: number; cents: number; automatic: number }
const decimal = (cents: number) => `${BigInt(cents) / 100n},${String(BigInt(cents) % 100n).padStart(2, '0')}`;
const rowIdentity = (row: PayableImportRow) => JSON.stringify([row.entry_number, row.description, row.branch, row.plan, row.bank_account, row.source_status, row.amount_cents, row.due_date, row.issued_on, row.cheque_number ?? null]);
const isCent = (item: DailyAction) => item.kind === 'CENT' || item.source_amount_cents === 1 || item.amount_cents === 1;
const emptyDraft = (item: DailyAction, today: string): ResolutionDraft => ({ action: '', paidOn: item.paid_on && item.paid_on <= today ? item.paid_on : today, amount: decimal(item.payment_remaining_cents), bankId: item.bank_account_id ?? '' });
function choicesFor(items: DailyAction[], drafts: Record<string, ResolutionDraft>, today: string, banks: { id: string }[]) {
  const choices: Record<string, PayableResolutionChoice> = {};
  for (const item of items) {
    const draft = drafts[item.key];
    if (!draft || !item.allowed_actions.includes(draft.action)) continue;
    if (draft.action === 'WRITE_OFF' && isCent(item)) choices[item.key] = { action: 'WRITE_OFF', reason: 'Baixa administrativa de R$ 0,01 confirmada individualmente na conciliação diária; não representa pagamento.' };
    else if (draft.action === 'REOPEN') choices[item.key] = { action: 'REOPEN', reason: 'Retorno da previsão confirmado na conferência do relatório diário, preservando a baixa anterior no histórico.' };
    else if (draft.action === 'PAID' && dailyCivilDate(draft.paidOn) && draft.paidOn <= today && banks.some(bank => bank.id === draft.bankId)) {
      try {
        const amount = parseMoneyCents(draft.amount);
        if (amount === item.payment_remaining_cents && amount > 0 && Number(item.amount_cents) > 1) choices[item.key] = { action: 'PAID', reason: 'Pagamento integral conferido individualmente na exceção da conciliação diária.', paid_on: draft.paidOn, amount_paid_cents: amount, bank_account_id: draft.bankId };
      } catch { /* Incomplete drafts remain editable until reviewed. */ }
    }
  }
  return choices;
}
function DailyActions({ items, page, onPage }: { items: DailyAction[]; page: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(items.length / 25)), current = Math.min(page, pages - 1);
  return <section className="stack" aria-label="Baixas automáticas da importação"><h3>Pagamentos calculados pelo relatório</h3>
    <p>As datas e contas abaixo serão usadas no realizado quando a importação for concluída.</p>
    <div className="table-wrap"><table><caption>{items.length} título(s) com baixa automática</caption><thead><tr><th>Lançamento / filial</th><th>Favorecido</th><th>Cheque</th><th>Vencimento</th><th>Data da baixa</th><th>Valor a pagar</th><th>Conta oficial</th></tr></thead><tbody>{items.slice(current * 25, (current + 1) * 25).map(item => <tr key={item.key}><td>{item.entry_number} · {item.branch}</td><td>{item.description}</td><td>{item.cheque_number ?? '—'}</td><td>{dateLabel(item.due_date)}</td><td>{dateLabel(item.paid_on)}</td><td>{formatCents(item.payment_remaining_cents)}</td><td>{item.bank_label}</td></tr>)}</tbody></table></div>
    {pages > 1 && <div className="pagination"><button type="button" className="button secondary" disabled={current === 0} onClick={() => onPage(current - 1)}>Baixas anteriores</button><span>Página {current + 1} de {pages}</span><button type="button" className="button secondary" disabled={current + 1 === pages} onClick={() => onPage(current + 1)}>Próximas baixas</button></div>}
  </section>;
}

export default function PayableDailyImport({ canImport, reportKind, onBusyChange }: { canImport: boolean; reportKind: DailyReportKind; onBusyChange: (busy: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null), [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<'analyzing' | 'saving' | null>(null), [pending, setPending] = useState<Frozen | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ResolutionDraft>>({}), [mappings, setMappings] = useState<Record<string, string>>({});
  const [bankMappings, setBankMappings] = useState<Record<string, string>>({});
  const [emptyChequesConfirmed, setEmptyChequesConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState(''), [problems, setProblems] = useState<ImportProblem[]>([]);
  const [actionsPage, setActionsPage] = useState(0), [exceptionPage, setExceptionPage] = useState(0);
  const prepared = useRef<Prepared | null>(null), frozen = useRef<Frozen | null>(null), controller = useRef<AbortController | null>(null), busyRef = useRef(false), generation = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => { onBusyChange(!!busy || !!pending); return () => onBusyChange(false); }, [busy, pending, onBusyChange]);
  useEffect(() => {
    if (!pending && busy !== 'saving') return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [pending, busy]);
  async function analyze(selected: File, selectedDrafts = drafts, selectedMappings = mappings, selectedBanks = bankMappings, emptyConfirmed = emptyChequesConfirmed) {
    if (!canImport || busyRef.current || frozen.current) return;
    busyRef.current = true; setBusy('analyzing'); setError(''); setSuccess(''); setProblems([]); setDirty(true);
    const current = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    try {
      const source = prepared.current?.file === selected && prepared.current.emptyChequesConfirmed === emptyConfirmed ? prepared.current : { file: selected, emptyChequesConfirmed: emptyConfirmed, ...await analyzePayableFile(selected, abort.signal, emptyConfirmed) };
      if (current !== generation.current || abort.signal.aborted) return;
      if ('errors' in source && Array.isArray(source.errors) && source.errors.length) { setProblems(source.errors); setAnalysis(null); return; }
      prepared.current = source;
      const previous = analysis?.source.file === selected ? analysis.preview : null;
      const choices = previous ? choicesFor(previous.exceptions, selectedDrafts, previous.report_date, previous.bank_options) : {};
      const body: DailyRequest = { action: 'preview', mode: 'daily', daily_report_version: '058', report_kind: reportKind, file_name: selected.name, file_base64: source.base64, mappings: { ...selectedMappings }, bank_mappings: { ...selectedBanks }, resolution_choices: choices, ...(emptyConfirmed ? { empty_cheques_confirmed: true } : {}) };
      const canonical = await payableDailyRequest<unknown>(body, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      if (!validDailyCanonical(canonical, source.hash, reportKind, emptyConfirmed)) throw new Error('invalid-preview');
      const isCheque = (row: PayableImportRow) => row.source_status.trim().toUpperCase() === 'CHEQUE' || !!row.cheque_number?.trim();
      const expected = reportKind === 'NORMAL' ? source.rows.filter(row => !isCheque(row)) : source.rows;
      if (reportKind === 'CHEQUES' && source.rows.some(row => !isCheque(row)) || canonical.rows.length !== expected.length || canonical.rows.some((row, index) => rowIdentity(row) !== rowIdentity(expected[index]))
        || canonical.preview.ignored_cheque_count !== source.rows.length - expected.length
        || canonical.preview.exceptions.some(item => item.selected_action !== (choices[item.key]?.action ?? null))) throw new Error('invalid-partition');
      setAnalysis({ ...canonical, source, choices, mappings: { ...selectedMappings }, bankMappings: { ...selectedBanks } }); setProblems(canonical.preview.errors); setDirty(false); setActionsPage(0); setExceptionPage(0);
    } catch (failure) {
      if (current !== generation.current || abort.signal.aborted) return;
      setProblems(dailyProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : []));
      setError(dailyImportError(failure, 'Não foi possível conferir o relatório diário. Nenhuma baixa foi aplicada por esta análise. Confira o arquivo e tente novamente.'));
    } finally { if (current === generation.current) { busyRef.current = false; setBusy(null); } }
  }
  async function execute(request: Frozen) {
    if (busyRef.current) return;
    frozen.current = request; busyRef.current = true; setPending(request); setBusy('saving'); setError(''); setSuccess('');
    try {
      const result = await payableDailyRequest<unknown>(request.body);
      if (!validDailyResult(result, request.body, request.rows) || result.paid_count !== request.paid || result.written_off_count !== request.writtenOff || result.payment_cents !== request.cents || result.automatic_paid_count !== request.automatic) throw new Error('unconfirmed');
      frozen.current = null; setPending(null); setSuccess(`${result.idempotent ? 'Este envio já estava concluído, sem duplicar baixas.' : 'Importação diária concluída.'} ${result.row_count} título(s) atualizado(s), ${result.paid_count} pagamento(s), total ${formatCents(result.payment_cents)}, e ${result.written_off_count} baixa(s) de R$ 0,01 sem pagamento.`);
      setAnalysis(null); prepared.current = null; setFile(null); setDrafts({}); setMappings({}); setBankMappings({}); setEmptyChequesConfirmed(false); setDirty(false); setProblems([]); if (input.current) input.current.value = '';
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      if (['P0058', 'PGRST202', '42883', '42P01', '40001', '42501', 'PGRST301', 'PGRST303', '22023', '23514', '23505', 'P0016', 'P0042', 'SOURCE_VALIDATION_FAILED'].includes(code)) { frozen.current = null; setPending(null); setDirty(true); }
      setProblems(dailyProblems(failure && typeof failure === 'object' && 'errors' in failure ? failure.errors : []));
      setError(dailyImportError(failure, 'A confirmação do resultado não chegou. O arquivo, as escolhas e o protocolo estão preservados. Confira o mesmo envio pelo botão abaixo, sem iniciar uma nova importação.'));
    } finally { busyRef.current = false; setBusy(null); }
  }
  function commit() {
    if (!analysis || !canImport || busyRef.current || frozen.current || dirty || !analysis.preview.can_commit || problems.length) return;
    const p = analysis.preview, selected = Object.values(analysis.choices), paid = selected.filter(choice => choice.action === 'PAID');
    const total = p.automatic_actions.reduce((sum, item) => sum + BigInt(item.payment_remaining_cents), 0n) + paid.reduce((sum, choice) => sum + BigInt(choice.amount_paid_cents!), 0n);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) { setError('A soma dos pagamentos excede o limite seguro. Confira os valores antes de importar.'); return; }
    const writtenOff = selected.filter(choice => choice.action === 'WRITE_OFF').length;
    const settlementNotice = p.baseline_only ? 'Esta primeira importação estabelece a referência de cheques, sem baixar cheques ausentes.' : reportKind === 'CHEQUES' ? 'Os cheques ausentes serão considerados pagos no dia desta importação, respeitando os dados efetivos confirmados nas exceções.' : 'Os títulos ausentes serão considerados pagos nas respectivas datas de vencimento, respeitando as datas efetivas confirmadas nas exceções; os cheques terão conferência separada.';
    if (!window.confirm(`Importar o relatório completo de ${reportKind === 'CHEQUES' ? 'cheques' : 'títulos'} e concluir a conciliação?\n\nArquivo: ${analysis.source.file.name}\nData da importação: ${dateLabel(p.report_date)}\nTítulos no relatório: ${p.row_count}\nPagamentos: ${p.auto_payment_count + paid.length}\nValor dos pagamentos: ${formatCents(Number(total))}\nBaixas individuais de R$ 0,01 sem pagamento: ${writtenOff}\n\nConfirmo que o arquivo contém todos os ${reportKind === 'CHEQUES' ? 'cheques em aberto de todas as filiais' : 'títulos comuns em aberto de todas as filiais'}. ${settlementNotice} Os pagamentos entram no realizado. O histórico será preservado.`)) return;
    const body: DailyRequest = { action: 'commit', mode: 'daily', daily_report_version: '058', report_kind: reportKind, file_name: analysis.source.file.name, file_base64: analysis.source.base64, mappings: { ...analysis.mappings }, bank_mappings: { ...analysis.bankMappings }, resolution_choices: structuredClone(analysis.choices), complete: true, previous_import_id: p.previous_import_id, previous_financial_revision: p.financial_revision, expected_report_date: p.report_date, request_id: crypto.randomUUID(), ...(analysis.source.emptyChequesConfirmed ? { empty_cheques_confirmed: true } : {}) };
    void execute({ body, rows: p.row_count, paid: p.auto_payment_count + paid.length, writtenOff, cents: Number(total), automatic: p.auto_payment_count });
  }
  const p = analysis?.preview, disabled = !!busy || !!pending;
  const bankGroups = new Map<string, { key: string; branch: string; source: string; count: number }>();
  for (const item of p?.exceptions ?? []) {
    if (item.kind !== 'MISSING' || isCent(item) || item.bank_account_id !== null || !item.bank_mapping_key?.trim() || !item.source_bank?.trim()) continue;
    const group = bankGroups.get(item.bank_mapping_key) ?? { key: item.bank_mapping_key, branch: item.branch, source: item.source_bank, count: 0 };
    group.count++; bankGroups.set(item.bank_mapping_key, group);
  }
  const pages = Math.max(1, Math.ceil((p?.exceptions.length ?? 0) / 20)), currentPage = Math.min(exceptionPage, pages - 1);
  const updateDraft = (item: DailyAction, value: Partial<ResolutionDraft>) => { if (!p || disabled) return; setDrafts(previous => ({ ...previous, [item.key]: { ...(previous[item.key] ?? emptyDraft(item, p.report_date)), ...value } })); setDirty(true); setError(''); };
  return <section className="panel stack" aria-labelledby="payable-daily-title">
    <div><h2 id="payable-daily-title">{reportKind === 'CHEQUES' ? 'Importar relatório diário de cheques' : 'Importar relatório diário de títulos'}</h2><p>Selecione o relatório completo. A conferência começa automaticamente; a conclusão aplica as atualizações e baixas em uma única confirmação.</p></div>
    <p className="notice">{reportKind === 'CHEQUES' ? 'Use o relatório completo dos cheques ainda em aberto. A primeira importação cria a referência de comparação; nas próximas, os cheques ausentes terão pagamento na data da importação.' : 'Use o relatório completo de títulos em aberto. Os títulos comuns ausentes terão pagamento na data de vencimento. Os cheques serão preservados para a importação própria.'}</p>
    <label className="field">{reportKind === 'CHEQUES' ? 'Relatório completo de cheques em aberto' : 'Relatório completo diário de Contas a Pagar'}<input ref={input} aria-label={reportKind === 'CHEQUES' ? 'Relatório completo de cheques em aberto' : 'Relatório completo diário de Contas a Pagar'} type="file" accept=".xlsx,.xlsm,.csv,.xls" disabled={disabled || !canImport} onChange={event => {
      if (busyRef.current || frozen.current) return;
      const selected = event.target.files?.[0] ?? null; generation.current++; controller.current?.abort(); prepared.current = null; setFile(selected); setAnalysis(null); setDrafts({}); setMappings({}); setBankMappings({}); setEmptyChequesConfirmed(false); setDirty(false); setProblems([]); setError(''); setSuccess('');
      if (selected) void analyze(selected, {}, {}, {}, false);
    }} /></label><p className="help-text">Até 2 MiB e 5.000 títulos. .xlsx, .xlsm ou .csv UTF-8. O arquivo original será preservado. Para incluir apenas alguns títulos, use Previsões / novos títulos.</p>
    {reportKind === 'CHEQUES' && <label className="checkbox-field"><input type="checkbox" aria-label="Confirmo que o relatório completo não contém cheques pendentes" checked={emptyChequesConfirmed} disabled={disabled || !file || !canImport} onChange={event => {
      if (busyRef.current || frozen.current || !file) return;
      const confirmed = event.target.checked; setEmptyChequesConfirmed(confirmed); setAnalysis(null); prepared.current = null; setProblems([]); setDirty(true); setError('');
      void analyze(file, drafts, mappings, bankMappings, confirmed);
    }} />Confirmo que o relatório completo não contém cheques pendentes. O arquivo deve conter somente os cabeçalhos, sem linhas de cheques.</label>}
    {busy === 'analyzing' && <p role="status">Conferindo o relatório e calculando as baixas…</p>}
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {pending && <div className="notice" role="status"><p>A confirmação está pendente. Mantenha esta tela para conferir o mesmo arquivo e protocolo.</p><button type="button" className="button secondary" disabled={!!busy} onClick={() => void execute(pending)}>Conferir importação diária pendente</button></div>}
    {!!problems.length && <div className="table-wrap"><table><caption>Pendências do relatório diário</caption><thead><tr><th>Linha</th><th>Campo</th><th>Problema</th><th>Como corrigir</th></tr></thead><tbody>{problems.slice(0, 100).map((problem, index) => <tr key={index}><td>{problem.line || '—'}</td><td>{problem.column}</td><td>{problem.problem}</td><td>{problem.correction}</td></tr>)}</tbody></table></div>}
    {p && analysis && <>
      <h3>Conferência da importação diária</h3><p>Arquivo: {analysis.source.file.name} · Data da importação: <strong>{dateLabel(p.report_date)}</strong>.</p>
      {p.baseline_only && <p className="notice">Primeiro relatório de cheques: esta importação estabelece a base de comparação. Nenhum cheque ausente será baixado agora.</p>}
      {reportKind === 'NORMAL' && p.baseline_origin === 'EXISTING_BASE' && <p className="notice">A primeira conferência diária compara este relatório com os títulos comuns já cadastrados na Central.</p>}
      {p.ignored_cheque_count > 0 && <p className="notice">{p.ignored_cheque_count} cheque(s) do arquivo foram separados desta conferência. Atualize-os em Relatório diário de cheques.</p>}
      <dl className="payable-paid-metrics"><div><dt>Títulos no relatório</dt><dd>{p.row_count}</dd></div><div><dt>Novos títulos</dt><dd>{p.new_count}</dd></div><div><dt>Títulos existentes</dt><dd>{p.open_count}</dd></div><div><dt>Pagamentos automáticos</dt><dd>{p.auto_payment_count}</dd></div><div><dt>Valor automático</dt><dd>{formatCents(p.auto_payment_cents)}</dd></div><div><dt>Exceções para conferir</dt><dd>{p.exceptions.length}</dd></div></dl>
      <p><strong>Valor do relatório sem os marcadores de R$ 0,01: {formatCents(Number(analysis.rows.reduce((sum, row) => sum + (row.amount_cents === 1 ? 0n : BigInt(row.amount_cents)), 0n)))}</strong></p>
      {p.automatic_actions.length > 0 && <DailyActions items={p.automatic_actions} page={actionsPage} onPage={setActionsPage} />}
      {!!p.unclassified_plans.length && <section className="stack"><h3>Classificar planos novos</h3><p>As classificações existentes são reaproveitadas. Selecione somente os planos que ainda não possuem classificação.</p>{p.unclassified_plans.map(plan => <label key={plan.plan} className="field">Macro para {plan.plan}<select aria-label={`Macro diário para ${plan.plan}`} disabled={disabled} value={mappings[plan.plan] ?? ''} onChange={event => { setMappings(previous => ({ ...previous, [plan.plan]: event.target.value })); setDirty(true); }}><option value="">Selecione a classificação</option>{p.macros.map(macro => <option key={macro}>{macro}</option>)}</select></label>)}</section>}
      {bankGroups.size > 0 && <section className="stack" aria-label="Vínculos bancários para as próximas importações"><h3>Vincular descrições bancárias</h3><p>Uma escolha resolve os títulos com a mesma descrição e filial. Ao concluir, a Central usará este vínculo nas próximas importações desta descrição e filial. Para um pagamento excepcional por outra conta, confira somente aquele título abaixo.</p>{[...bankGroups.values()].map(group => <label className="field" key={group.key}>Filial {group.branch} · {group.source} · {group.count} título(s)<select aria-label={`Vincular conta para ${group.source} · Filial ${group.branch}`} disabled={disabled} value={bankMappings[group.key] ?? ''} onChange={event => { const value = event.target.value; setBankMappings(previous => { const next = { ...previous }; if (value) next[group.key] = value; else delete next[group.key]; return next; }); setDirty(true); }}><option value="">Selecione a conta oficial para este vínculo</option>{p.bank_options.map(bank => <option key={bank.id} value={bank.id}>{bank.display_name}</option>)}</select></label>)}</section>}
      {!!p.exceptions.length && <section className="stack" aria-label="Exceções da conciliação diária"><h3>Conferir exceções</h3><p>R$ 0,01 exige confirmação individual sem pagamento. Outros casos abaixo precisam de dados ou correção antes da conclusão.</p>{p.exceptions.slice(currentPage * 20, (currentPage + 1) * 20).map(item => {
        const draft = drafts[item.key] ?? emptyDraft(item, p.report_date), cent = isCent(item);
        return <article className="payable-import-review-item" key={item.key}><h4>Lançamento {item.entry_number} · Filial {item.branch}</h4><p>{item.description}</p><p className="help-text">Vencimento {dateLabel(item.due_date)} · Valor {item.amount_cents === null ? 'Não informado' : formatCents(item.amount_cents)}{item.cheque_number ? ` · Cheque ${item.cheque_number}` : ''}</p>
          {item.problem && <p className="notice">{item.problem}</p>}
          {!item.allowed_actions.length ? <p className="notice error">Este título exige correção no histórico antes de concluir a importação.</p> : cent ? <label className="checkbox-field"><input type="checkbox" aria-label={`Confirmar baixa diária de R$ 0,01 do lançamento ${item.entry_number} filial ${item.branch}`} disabled={disabled} checked={draft.action === 'WRITE_OFF'} onChange={event => updateDraft(item, { action: event.target.checked ? 'WRITE_OFF' : '' })} />Confirmo a baixa deste título de R$ 0,01, sem pagamento e sem incluir o valor nos totais.</label> : <label className="field">Conciliação deste título<select aria-label={`Exceção diária do lançamento ${item.entry_number} filial ${item.branch}`} disabled={disabled} value={draft.action} onChange={event => updateDraft(item, { action: event.target.value as ResolutionDraft['action'] })}><option value="">Selecione a ação</option>{item.allowed_actions.includes('PAID') && <option value="PAID">Confirmar pagamento integral</option>}{item.allowed_actions.includes('REOPEN') && <option value="REOPEN">Confirmar retorno à previsão</option>}</select></label>}
          {draft.action === 'PAID' && <div className="payable-import-payment-fields"><label className="field">Data efetiva do pagamento<input aria-label={`Data diária do lançamento ${item.entry_number} filial ${item.branch}`} type="date" min="1900-01-01" max={p.report_date} disabled={disabled} value={draft.paidOn} onChange={event => updateDraft(item, { paidOn: event.target.value })} /></label><label className="field">Valor integral (R$)<input aria-label={`Valor diário do lançamento ${item.entry_number} filial ${item.branch}`} readOnly value={draft.amount} /></label><label className="field">Conta oficial<select aria-label={`Conta diária do lançamento ${item.entry_number} filial ${item.branch}`} disabled={disabled} value={draft.bankId} onChange={event => updateDraft(item, { bankId: event.target.value })}><option value="">Selecione a conta oficial</option>{p.bank_options.map(bank => <option key={bank.id} value={bank.id}>{bank.display_name}</option>)}</select></label></div>}
        </article>;
      })}{pages > 1 && <div className="pagination"><button type="button" className="button secondary" disabled={disabled || currentPage === 0} onClick={() => setExceptionPage(currentPage - 1)}>Exceções anteriores</button><span>Página {currentPage + 1} de {pages}</span><button type="button" className="button secondary" disabled={disabled || currentPage + 1 === pages} onClick={() => setExceptionPage(currentPage + 1)}>Próximas exceções</button></div>}</section>}
      {dirty && <p className="notice" role="status">Os ajustes precisam de uma nova conferência antes de concluir.</p>}
      <div className="inline-actions">{(dirty || !p.can_commit) && <button type="button" className="button secondary" disabled={disabled || !file} onClick={() => file && void analyze(file)}>Conferir ajustes do relatório diário</button>}<button type="button" className="button" disabled={!canImport || disabled || dirty || !p.can_commit || problems.length > 0} onClick={commit}>{busy === 'saving' ? 'Concluindo conciliação diária…' : 'Importar e conciliar relatório diário'}</button></div>
    </>}
    {!analysis && file && !disabled && <button type="button" className="button secondary" onClick={() => void analyze(file)}>Conferir novamente o relatório diário</button>}
  </section>;
}
