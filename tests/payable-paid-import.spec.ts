import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { isChequeNumberHeader, parseCsv, readPayableChequeCell, validatePayablePaidRows } from '../src/lib/payables-parser.mjs';
import { isInternalCashBank, officialPaidBankName } from '../src/lib/payable-bank-rules.mjs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = new Date('2026-10-18T15:00:00Z');
const paymentDateVersion = '2026-10-27.1';
const bankRulesVersion = '050';
const uuid = (value: number) => `76000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const bankLabels = ['BRADESCO ECOPLAST', 'BRADESCO LIMPE FACIL', 'BRADESCO GAMMA IND', 'BRADESCO F2G', 'BRADESCO FAST CLEAN', 'BRADESCO EASY CLEAN', 'BANCO DO BRASIL FAST CLEAN', 'BANCO DO BRASIL EASY CLEAN', 'BANCO DO BRASIL ECOPLAST', 'BANCO CORA LIMPE FACIL', 'BANCO CORA MY CLEAN', 'BANCO CORA ECO PLAST', 'CAIXA ECOPLAST', 'CAIXA LIMPE FACIL', 'CAIXA GAMMA', 'CAIXA FAST CLEAN', 'CAIXA EASY CLEAN'];
const headers = ['Filial', 'Lançamento', 'Situação', 'Vencimento: data', 'Emissão: valor do lançamento', 'Plano cc - Conta: nome', 'Cheque: número', 'Histórico', 'Plano cp - Conta: nome', 'Emissão: data'];
const csv = `${headers.join(';')}\r\n3;14;PAGO;17/10/2026 23:59:59;200,00;BANCO ERP PAGO;;Fornecedor pago sintético;ENERGIA;01/10/2026 10:15:00`;
interface Options { director?: boolean; knownBank?: boolean; newPlan?: boolean; conflict?: boolean; correction?: boolean; stale?: boolean; uncertain?: boolean; commitBeforeError?: boolean; badHash?: boolean; financialRevision?: unknown; unknownCent?: boolean; staleChoice?: boolean; oldProtocol?: boolean; holdPreview?: () => Promise<void>; serverToday?: string; missingPaymentDateVersion?: boolean; dateReviewRequired?: boolean; missingBankRulesVersion?: boolean; bankRulesUnavailable?: boolean; conflictingBankIds?: boolean; changeFreezeRevision?: boolean; existingTitleCheque?: boolean; missingColumnRules?: boolean; missingChequeBank?: boolean; badChequeBank?: boolean }

async function parseOriginal(body: any, today = '2026-10-18') {
  const bytes = Buffer.from(body.file_base64, 'base64'); let matrix: unknown[][];
  if (body.file_name.endsWith('.csv')) matrix = parseCsv(bytes.toString('utf8'));
  else {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
    const sheet = workbook.worksheets[0]; const chequeColumns: number[] = [];
    sheet.getRow(1).eachCell((cell, column) => { if (isChequeNumberHeader(cell.value)) chequeColumns.push(column); });
    matrix = []; for (let index=1;index<=sheet.rowCount;index++) { const row=sheet.getRow(index),values=(row.values as unknown[]).slice(1); if (index > 1) for (const column of chequeColumns) values[column - 1] = readPayableChequeCell(row.getCell(column).value, row.getCell(column).numFmt); matrix.push(values); }
  }
  const parsed = validatePayablePaidRows(matrix, { excel1904: false, today, allowInternalCashWriteoff: body.bank_rules_version === bankRulesVersion, columnRulesVersion: body.column_rules_version });
  return { ...parsed, hash: createHash('sha256').update(bytes).digest('hex') };
}
async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(now);
  const id = uuid(1), role = options.director ? 'diretor' : 'contas_pagar';
  const permissions = ['painel', 'caixa', 'contas_pagar', 'importar_bases'].map(resource => ({ resource, action: 'read' }));
  if (!options.director) permissions.push({ resource: 'contas_pagar', action: 'import' }, { resource: 'contas_pagar', action: 'write' });
  const access = { profile: { id, username: 'ImportadorTeste', display_name: 'Pessoa de Teste', role_key: role, enabled: true }, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, session_id: uuid(2), exp: Math.floor(now.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const accounts = bankLabels.map((label, index) => ({ id: uuid(100 + index), display_name: label, company: 'Empresa de Teste', bank: label, account_type: index < 12 ? 'BANK' : 'CASH' })).filter(account => !options.missingChequeBank || account.display_name !== 'BRADESCO F2G');
  const calls: { name: string; body: any }[] = []; const previews: any[] = [], commits: any[] = [];
  let committed = false, ledgerCount = 0, writeoffLedgerCount = 0; const paidRequests = new Map<string, { body: any; result: any }>(); let storedBanks: Record<string, string> = {}, storedPlans: Record<string, string> = {};
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const cors = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,authorization,content-type,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range', 'content-range': '*/0' };
    const reply = (json: any, status = 200) => route.fulfill({ status, headers: cors, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = request.postDataJSON(); calls.push({ name, body });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600 } });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'fixture@test.invalid', email_confirmed_at: now.toISOString(), created_at: now.toISOString(), app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'current_access') return reply(access);
    if (['director_report', 'payables_management_summary', 'payables_forecast', 'payable_payment_summary', 'list_payable_payments', 'get_payables_revision', 'payables_month_status', 'list_payable_month_closures'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'cash_position') return reply({ accounts: [], total_cents: null, reported_accounts: 0, expected_accounts: 17, latest_position_date: null });
    if (name === 'current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (name === 'payables_summary' || name === 'receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (name === 'payable_macros') return reply([{ name: 'FIXO' }, { name: 'VARIÁVEL' }]);
    if (['payable_imports', 'payable_plan_mappings', 'director_positions', 'payable_titles'].includes(name)) return reply([]);
    if (['payable_review_titles', 'payable_financial_titles'].includes(name)) return reply({ code: 'PGRST205' }, 404);
    if (name === 'get_payable_payment_accounts') return reply(accounts);
    if (name === 'payables-import') {
      expect(body.mode).toBe('payments'); expect(body.payment_date_version).toBe(paymentDateVersion); expect(body.bank_rules_version).toBe(bankRulesVersion); expect(body.column_rules_version).toBe('059');
      if (options.bankRulesUnavailable) return reply({code:'P0050',activation_required:true,error:'private SQL query secret'},409);
      const parsed = await parseOriginal(body,options.serverToday); if (parsed.errors.length) return reply({ code: parsed.errors.some(error=>error.problem==='A data do pagamento é futura.')?'SOURCE_VALIDATION_FAILED':'INVALID_FILE', errors: parsed.errors }, 422);
      expect(body.reconciliation_version).toBe('043'); expect(body.resolution_choices).toBeDefined();
      const rows: any[] = [], banks: any[] = [], plans: any[] = [], errors: any[] = [], items: any[] = [], resolutionErrors: any[] = [];
      let newCount = 0, matched = 0, corrections = 0, conflicts = 0, writeoffs = 0;
      for (const [index, row] of parsed.rows.entries()) {
        const key = JSON.stringify(['source-bank', row.branch, row.paid_bank]), cent = row.amount_paid_cents === 1, numberedCheque = !!row.cheque_number?.trim() || !!options.existingTitleCheque, internalCash = isInternalCashBank(row.paid_bank) && !numberedCheque, administrative = cent || internalCash;
        const chequeAccount = accounts.find(account => account.display_name === 'BRADESCO F2G');
        const approvedName=officialPaidBankName(row.paid_bank,approvedBankAliases.map(([source,official_name])=>({source,official_name}))),officialAccount=accounts.find(account=>account.account_type==='BANK'&&account.display_name===approvedName);
        const resolutionKey = `row:${index + 1}`, selected = body.resolution_choices?.[resolutionKey];
        const bankId = administrative ? null : numberedCheque ? options.badChequeBank ? accounts[0].id : chequeAccount?.id ?? null : options.conflictingBankIds&&index>0?accounts[1].id:officialAccount?.id ?? body.bank_mappings?.[key] ?? storedBanks[key] ?? (options.knownBank ? accounts[0].id : null);
        const classified = administrative || !options.newPlan || !!body.mappings?.[row.plan] || !!storedPlans[row.plan];
        if (!administrative && !bankId) banks.push({ key, branch: row.branch, paid_bank: row.paid_bank, count: 1, ...(numberedCheque ? { official_bank_name: 'BRADESCO F2G' } : {}) });
        if (!classified) { plans.push({ plan: row.plan, count: 1, total_cents: row.amount_paid_cents }); errors.push({ line: index + 2, column: 'Plano de Contas', problem: 'Plano novo sem Centro de Custo Macro.', correction: 'Escolha o Macro do plano e reanalise este arquivo.' }); }
        let outcome = !bankId ? 'UNMAPPED_BANK' : !classified || options.conflict ? 'CONFLICT' : committed ? 'MATCHED' : options.correction ? 'CORRECTION' : 'NEW_PAYMENT';
        let problem = options.conflict ? 'Pagamento manual divergente.' : '';
        if (!administrative && options.conflict) errors.push({ line: index + 2, column: 'Pagamento', problem: 'Este título possui pagamento manual divergente.', correction: 'Confira os pagamentos manuais antes de importar.' });
        if (administrative) {
          const unknown = !!options.unknownCent;
          problem = unknown ? 'Título de R$ 0,01 não encontrado. Importe primeiro a previsão para preservar o vencimento e o valor original.' : selected?.action === 'WRITE_OFF' ? '' : cent?'Confirme individualmente a baixa sem pagamento deste título de R$ 0,01.':'Confirme individualmente a baixa sem pagamento deste lançamento de Caixa Interno.';
          outcome = unknown ? 'UNKNOWN_TITLE' : problem ? 'WRITE_OFF_PENDING' : 'WRITE_OFF'; if (!unknown) writeoffs++;
          items.push({ key: resolutionKey, kind: cent?'CENT':'INTERNAL_CASH', line: index + 1, title_id: unknown ? null : uuid(10 + index), branch: row.branch, entry_number: row.entry_number,
            description: row.description ?? '', due_date: unknown ? null : '2026-10-25', amount_cents: unknown ? null : 20000, source_amount_cents: row.amount_paid_cents,
            allowed_actions: unknown ? [] : ['WRITE_OFF'], selected_action: options.staleChoice ? null : selected?.action ?? null,
            requires_resolution: !unknown, problem: problem || null, already_written_off: committed && !unknown });
          if (problem) { const error = { line: index + 2, column: 'Baixa sem pagamento', problem, correction: unknown ? 'Importe primeiro a previsão original.' : 'Confirme esta baixa individual e reanalise o arquivo.' }; errors.push(error); resolutionErrors.push(error); }
        }
        if (outcome === 'NEW_PAYMENT') newCount++; if (outcome === 'MATCHED') matched++; if (outcome === 'CORRECTION') corrections++; if (outcome === 'CONFLICT') conflicts++;
        rows.push({ ...row, payment_bank_rule: numberedCheque ? 'CHEQUE_F2G' : 'SOURCE_BANK', line: index + 1, bank_mapping_key: key, bank_account_id: bankId, title_id: administrative && options.unknownCent ? null : uuid(10 + index), title_amount_cents: 20000,
          forecast_due_date: administrative && options.unknownCent ? null : '2026-10-25', outcome, payment_ids: committed && !administrative ? [uuid(40)] : [], problem,
          target_macro: body.mappings?.[row.plan] ?? storedPlans[row.plan] ?? 'FIXO' });
      }
      const preview = { ...(options.missingColumnRules ? {} : { column_rules_version: '059' }), cheque_payment_bank_id: accounts.find(account => account.display_name === 'BRADESCO F2G')?.id ?? null, mode: 'payments', reconciliation_version: options.oldProtocol ? '021' : '043', full_report: false, reconciliation_items: items, resolution_errors: resolutionErrors,
        writeoff_count: writeoffs, new_writeoff_count: committed ? 0 : writeoffs, matched_writeoff_count: committed ? writeoffs : 0,
        financial_revision: 'financialRevision' in options ? options.financialRevision : options.changeFreezeRevision&&previews.length>0?'changed-during-bank-freeze':committed ? '1:1' : '0:0', previous_import_id: committed ? uuid(30) : uuid(20),
        row_count: rows.length, new_payment_count: newCount, matched_payment_count: matched, correction_count: corrections, conflict_count: conflicts + resolutionErrors.length,
        errors, unmapped_banks: banks, bank_accounts: accounts, bank_options: accounts, unclassified_plans: plans, macros: ['FIXO', 'VARIÁVEL'], can_commit: !errors.length && !banks.length && !conflicts };
      if (body.action === 'preview') { previews.push(body); await options.holdPreview?.(); return reply({ rows, preview, file_sha256: options.badHash ? 'a'.repeat(64) : parsed.hash, ...(options.missingPaymentDateVersion?{}:{payment_date_version:paymentDateVersion}),...(options.missingBankRulesVersion?{}:{bank_rules_version:bankRulesVersion}) }); }
      commits.push(body); expect(body.request_id).toMatch(/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
      const saved = paidRequests.get(body.request_id);
      if (saved) { expect(body).toEqual(saved.body); return reply({ ...saved.result, idempotent: true }); }
      if (options.stale) return reply({ code: '40001', message: 'private SQL query secret' }, 409);
      if (options.dateReviewRequired) return reply({ code: 'PAYMENT_DATE_REVIEW_REQUIRED', message: 'private SQL query secret' }, 409);
      if (!preview.can_commit || !body.complete || (corrections && !body.confirm_corrections)) return reply({ code: '22023', message: 'private SQL query secret' }, 400);
      const existed = committed;
      const result = { import_id: uuid(30), request_id: body.request_id, reconciliation_version: '043', payment_date_version: paymentDateVersion, bank_rules_version: bankRulesVersion, reconciled_at: now.toISOString(), row_count: rows.length,
        new_payment_count: existed ? 0 : newCount, matched_payment_count: existed ? rows.length - writeoffs : matched, correction_count: existed ? 0 : corrections,
        reviewed_count: rows.length - writeoffs, writeoff_count: writeoffs, idempotent: existed };
      if (!options.uncertain || options.commitBeforeError || existed) {
        committed = true; ledgerCount = rows.length - writeoffs; writeoffLedgerCount = writeoffs;
        storedBanks = { ...storedBanks, ...body.bank_mappings }; storedPlans = { ...storedPlans, ...body.mappings }; paidRequests.set(body.request_id, { body, result });
      }
      if (options.uncertain && !existed) return reply({ code: 'XX000', message: 'private SQL query secret' }, 503);
      return reply(result);
    }
    throw new Error(`Unexpected offline fixture request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('ImportadorTeste'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click(); await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  if (options.director) await expect(page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true })).toHaveCount(0);
  else { await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click(); await page.getByRole('button', { name: 'Pagamentos realizados', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Importar títulos pagos', exact: true })).toBeVisible(); }
  return { calls, previews, commits, accounts, ledgerCount: () => ledgerCount, writeoffLedgerCount: () => writeoffLedgerCount };
}
async function selectCsv(page: Page, contents = csv, filename = 'pagos.csv') { await page.getByLabel('Relatório de títulos pagos', { exact: true }).setInputFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from(contents) }); await page.getByRole('checkbox', { name: /Confirmo que este é o relatório de pagamentos do período/ }).check(); }
async function analyze(page: Page) { await page.getByRole('button', { name: /Analisar pagamentos|Reanalisar mesmo arquivo/, exact: true }).click(); await expect(page.getByText('Analisando pagamentos…', { exact: true })).toHaveCount(0); }
const panel = (page: Page) => page.locator('.payable-paid-import');

test('paid XLSX keeps actual date, bank, leading-zero cheque and original bytes, then automatically conciliates all titles', async ({ page }) => {
  const { previews, commits } = await setup(page, { knownBank: true });
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Pagos'); sheet.addRow(headers); sheet.addRow(['3', '14', 'PAGO', new Date('2026-10-17T23:59:59Z'), 200, 'BANCO ERP PAGO', 123, 'Fornecedor pago sintético', 'ENERGIA', new Date('2026-10-01T10:15:00Z')]); sheet.getCell('G2').numFmt = '000000';
  const original = Buffer.from(await workbook.xlsx.writeBuffer()); await page.getByLabel('Relatório de títulos pagos', { exact: true }).setInputFiles({ name: 'pagos.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: original }); await page.getByRole('checkbox', { name: /Confirmo que este é o relatório de pagamentos do período/ }).check(); await analyze(page);
  await expect(panel(page)).toContainText('000123'); await expect(panel(page)).toContainText('17/10/2026'); await expect(panel(page)).toContainText('25/10/2026'); await expect(panel(page)).toContainText('BANCO ERP PAGO'); await expect(panel(page)).toContainText('Fornecedor pago sintético'); await expect(panel(page)).toContainText('ENERGIA');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('serão conciliados'); expect(dialog.message()).toContain('Nenhum título ausente será baixado'); return dialog.accept(); }); await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click(); await expect(panel(page).getByRole('status')).toContainText('1 conciliado(s)');
  expect(commits).toHaveLength(1); expect(Buffer.from(commits[0].file_base64, 'base64')).toEqual(original); expect(commits[0].file_base64).toBe(previews[0].file_base64); expect(commits[0]).toMatchObject({ mode: 'payments', column_rules_version: '059', complete: true, previous_import_id: uuid(20), previous_financial_revision: '0:0', confirm_corrections: false }); expect(commits[0]).not.toHaveProperty('rows'); expect(commits[0]).not.toHaveProperty('p_rows');
  expect(commits[0].bank_mappings).toEqual({});
});
test('existing forecast cheque uses F2G even when paid file omits its number, without saving a raw bank alias', async ({ page }) => {
  const { commits, previews } = await setup(page, { existingTitleCheque: true });
  await selectExplicitPaidDate(page, new Date('2026-10-17T00:00:00Z'));
  await expect(page.getByRole('table', { name: /Prévia dos pagamentos/ })).toContainText('Regra do cheque: BRADESCO F2G');
  await expect(page.getByLabel(/^Conta oficial para banco/)).toHaveCount(0);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('Importação concluída');
  expect(previews).toHaveLength(1); expect(commits[0].bank_mappings).toEqual({});
});
for (const option of ['missingColumnRules', 'badChequeBank'] as const) test(`${option} cannot authorize a cheque payment`, async ({ page }) => {
  const { commits } = await setup(page, { [option]: true }); await selectCsv(page, csv.replace(';BANCO ERP PAGO;;', ';BANCO ERP PAGO;000123;')); await analyze(page);
  await expect(panel(page).getByRole('alert')).toContainText('Não foi possível concluir a análise');
  await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toHaveCount(0); expect(commits).toEqual([]);
});
test('missing official F2G account remains blocked with a visible instruction instead of another bank selector', async ({ page }) => {
  const { commits } = await setup(page, { missingChequeBank: true }); await selectCsv(page, csv.replace(';BANCO ERP PAGO;;', ';BANCO ERP PAGO;000123;')); await analyze(page);
  await expect(panel(page)).toContainText('A conta oficial precisa estar ativa e sem duplicidade');
  await expect(page.getByLabel(/^Conta oficial para banco/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled(); expect(commits).toEqual([]);
});

test('unknown bank and new plan require explicit official mappings and a new server analysis before commit', async ({ page }) => {
  const { previews, commits, accounts } = await setup(page, { newPlan: true }); await selectCsv(page); await analyze(page);
  await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled(); await expect(page.getByLabel('Conta oficial para banco 1', { exact: true }).locator('option')).toHaveCount(18); await expect(page.getByLabel('Macro para plano pago 1', { exact: true })).toHaveValue('');
  await page.getByLabel('Conta oficial para banco 1', { exact: true }).selectOption(accounts[10].id); await page.getByLabel('Macro para plano pago 1', { exact: true }).selectOption('VARIÁVEL'); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled(); await analyze(page);
  await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeEnabled(); expect(previews.at(-1).bank_mappings).toEqual({ [JSON.stringify(['source-bank', '3', 'BANCO ERP PAGO'])]: accounts[10].id }); expect(previews.at(-1).mappings).toEqual({ ENERGIA: 'VARIÁVEL' });
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click(); await expect(panel(page).getByRole('status')).toContainText('Importação concluída'); expect(commits[0].bank_mappings).toEqual(previews.at(-1).bank_mappings); expect(commits[0].mappings).toEqual(previews.at(-1).mappings);
});

test('conflicting manual payments block automatic import with line and correction guidance', async ({ page }) => {
  const { commits } = await setup(page, { knownBank: true, conflict: true }); await selectCsv(page); await analyze(page); await expect(panel(page)).toContainText('Este título possui pagamento manual divergente.'); await expect(panel(page)).toContainText('Confira os pagamentos manuais antes de importar.'); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled(); expect(commits).toHaveLength(0);
});

test('an import-owned correction uses one explicit final confirmation and keeps the audited correction flag', async ({ page }) => {
  const { commits } = await setup(page, { knownBank: true, correction: true }); await selectCsv(page); await analyze(page); await expect(panel(page)).toContainText('Correção de importação anterior'); await expect(page.getByRole('checkbox')).toHaveCount(1);
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click(); expect(commits).toHaveLength(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Correções anteriores: 1'); expect(dialog.message()).toContain('preservam o histórico do registro anterior'); return dialog.accept(); }); await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click(); await expect(panel(page).getByRole('status')).toContainText('1 correção(ões)'); expect(commits[0].confirm_corrections).toBe(true);
});

test('wrong paid status or a missing actual-bank column is rejected before sending any canonical preview', async ({ page }) => {
  const { previews, commits } = await setup(page, { knownBank: true }); await selectCsv(page, csv.replace(';PAGO;', ';ABERTO;')); await analyze(page); await expect(panel(page).getByRole('alert')).toContainText('Importação bloqueada'); expect(previews).toHaveLength(0);
  await selectCsv(page, csv.replace('Plano cc - Conta: nome', 'COLUNA AUSENTE')); await analyze(page); await expect(panel(page)).toContainText('Coluna obrigatória ausente'); expect(previews).toHaveLength(0); expect(commits).toHaveLength(0);
});

test('replacing the selected file invalidates the old preview and requires a fresh paid declaration', async ({ page }) => {
  const { commits } = await setup(page, { knownBank: true }); await selectCsv(page); await analyze(page); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeEnabled();
  await page.getByLabel('Relatório de títulos pagos', { exact: true }).setInputFiles({ name: 'outro.csv', mimeType: 'text/csv', buffer: Buffer.from(csv.replace(';14;', ';15;')) }); await expect(page.getByRole('heading', { name: 'Conferência dos pagamentos', exact: true })).toHaveCount(0); await expect(page.getByRole('checkbox', { name: /Confirmo que este é o relatório de pagamentos do período/ })).not.toBeChecked(); await expect(page.getByRole('button', { name: 'Analisar pagamentos', exact: true })).toBeDisabled(); expect(commits).toHaveLength(0);
});

test('a stale import preserves the file and requires reanalysis instead of repeating a write', async ({ page }) => {
  const options: Options = { knownBank: true, stale: true }; const { commits, previews } = await setup(page, options); await selectCsv(page); await analyze(page); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click(); await expect(panel(page).getByRole('alert')).toContainText('mudaram desde a análise'); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled();
  options.stale = false; await analyze(page); expect(previews.at(-1).file_base64).toBe(previews[0].file_base64); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click(); await expect(panel(page).getByRole('status')).toContainText('Importação concluída'); expect(commits).toHaveLength(2); await expect(page.getByText('private SQL query secret')).toHaveCount(0);
});

test('an uncertain committed result freezes the file and safely recognizes it on retry without duplicating payments', async ({ page }) => {
  const options: Options = { knownBank: true, uncertain: true, commitBeforeError: true }; const { commits, ledgerCount } = await setup(page, options); await selectCsv(page); await analyze(page); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toContainText('Não foi possível confirmar o resultado'); await expect(page.getByLabel('Relatório de títulos pagos', { exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reanalisar mesmo arquivo', exact: true })).toBeDisabled(); await page.getByRole('button', { name: 'Repetir confirmação pendente', exact: true }).click(); await expect(panel(page).getByRole('status')).toContainText('sem duplicar pagamentos'); expect(commits[0]).toEqual(commits[1]); expect(commits[0].payment_date_version).toBe(paymentDateVersion);expect(commits[0].bank_rules_version).toBe(bankRulesVersion); expect(commits[0].file_base64).toBe(commits[1].file_base64); expect(ledgerCount()).toBe(1); await expect(page.getByLabel('Relatório de títulos pagos', { exact: true })).toBeEnabled();
});

test('a mismatched server file hash cannot authorize an import', async ({ page }) => {
  const { commits } = await setup(page, { knownBank: true, badHash: true }); await selectCsv(page); await analyze(page); await expect(panel(page).getByRole('alert')).toContainText('Não foi possível concluir a análise'); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toHaveCount(0); expect(commits).toHaveLength(0);
});

test('a missing or invalid financial revision cannot authorize an import, even when the server marks it valid', async ({ page }) => {
  const options: Options = { knownBank: true, financialRevision: undefined };
  const { commits } = await setup(page, options);
  for (const [label, revision] of [['missing', undefined], ['null', null], ['numeric', 0], ['empty', ''], ['blank', ' \t '], ['over limit', 'x'.repeat(257)]] as const) {
    await test.step(label, async () => {
      options.financialRevision = revision;
      await selectCsv(page); await analyze(page);
      await expect(panel(page).getByRole('alert')).toContainText('Não foi possível concluir a análise');
      await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toHaveCount(0);
      expect(commits).toHaveLength(0);
    });
  }
});

test('Director cannot choose or import paid files', async ({ page }) => {
  const { previews, commits } = await setup(page, { director: true }); await expect(page.getByLabel('Relatório de títulos pagos', { exact: true })).toHaveCount(0); expect(previews).toHaveLength(0); expect(commits).toHaveLength(0);
});

test('asynchronous analysis disables file replacement and renders escaped ERP metadata on a phone viewport', async ({ page }) => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const options: Options = { knownBank: true, holdPreview: () => held }; await setup(page, options); const text = '<script>window.paidImportExecuted=true</script>'; await selectCsv(page, csv.replace('Fornecedor pago sintético', text));
  await page.getByRole('button', { name: 'Analisar pagamentos', exact: true }).click(); await expect(page.getByRole('button', { name: 'Analisando pagamentos…', exact: true })).toBeVisible(); await expect(page.getByLabel('Relatório de títulos pagos', { exact: true })).toBeDisabled(); release(); await expect(panel(page)).toContainText(text); expect(await page.evaluate(() => (window as any).paidImportExecuted)).toBeUndefined();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

const centCsv = csv.replace(';200,00;', ';0,01;');
const centCheckbox = (page: Page, entry = '14') => page.getByRole('checkbox', { name: `Confirmar baixa de R$ 0,01 do lançamento ${entry} filial 3`, exact: true });

test('a paid cent requires its own confirmation and another analysis before the single atomic import creates only a writeoff', async ({ page }) => {
  const { previews, commits, ledgerCount, writeoffLedgerCount } = await setup(page);
  await selectCsv(page, centCsv); await analyze(page);
  await expect(centCheckbox(page)).not.toBeChecked(); await expect(page.getByLabel('Conta oficial para banco 1', { exact: true })).toHaveCount(0);
  await expect(panel(page)).toContainText('Valor nominal R$ 200,00'); await expect(panel(page)).toContainText('Valor no arquivo R$ 0,01');
  await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled();
  await centCheckbox(page).check(); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled();
  await analyze(page); await expect(centCheckbox(page)).toBeChecked(); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeEnabled();
  expect(previews.at(-1).resolution_choices).toMatchObject({ 'row:1': { action: 'WRITE_OFF' } });
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Novos pagamentos: 0'); expect(dialog.message()).toContain('Baixas sem pagamento confirmadas: 1'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('0 conciliado(s) e 1 baixa(s) sem pagamento');
  expect(commits).toHaveLength(1); expect(commits[0].resolution_choices).toEqual(previews.at(-1).resolution_choices); expect(ledgerCount()).toBe(0); expect(writeoffLedgerCount()).toBe(1);
});

test('two cent titles each require a separate confirmation and no partial file can be imported', async ({ page }) => {
  const report = centCsv + '\r\n' + centCsv.split('\r\n')[1].replace(';14;', ';15;');
  const { previews, commits, ledgerCount, writeoffLedgerCount } = await setup(page); await selectCsv(page, report); await analyze(page);
  await centCheckbox(page).check(); await analyze(page);
  expect(previews.at(-1).resolution_choices).toHaveProperty('row:1'); expect(previews.at(-1).resolution_choices).not.toHaveProperty('row:2');
  await expect(centCheckbox(page, '15')).not.toBeChecked(); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled();
  expect(commits).toHaveLength(0); expect(ledgerCount()).toBe(0); expect(writeoffLedgerCount()).toBe(0);
  await centCheckbox(page, '15').check(); await analyze(page); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeEnabled();
  expect(Object.keys(previews.at(-1).resolution_choices)).toEqual(['row:1', 'row:2']);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('2 baixa(s) sem pagamento'); expect(commits).toHaveLength(1); expect(ledgerCount()).toBe(0); expect(writeoffLedgerCount()).toBe(2);
});

test('a cent without an existing forecast stays blocked with no invented due date, title or payment', async ({ page }) => {
  const { commits } = await setup(page, { unknownCent: true }); await selectCsv(page, centCsv); await analyze(page);
  await expect(panel(page)).toContainText('Importe primeiro a previsão'); await expect(panel(page)).toContainText('Valor nominal Não informado');
  await expect(centCheckbox(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled();
  expect(commits).toHaveLength(0);
});

test('a mixed file records the real payment and administrative writeoff in the same confirmation', async ({ page }) => {
  const report = csv + '\r\n' + centCsv.split('\r\n')[1].replace(';14;', ';15;');
  const { commits, ledgerCount, writeoffLedgerCount } = await setup(page, { knownBank: true }); await selectCsv(page, report); await analyze(page);
  await centCheckbox(page, '15').check(); await analyze(page); page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('1 conciliado(s) e 1 baixa(s) sem pagamento');
  expect(commits).toHaveLength(1); expect(Object.keys(commits[0].resolution_choices)).toEqual(['row:2']); expect(ledgerCount()).toBe(1); expect(writeoffLedgerCount()).toBe(1);
});

test('an uncertain mixed import freezes all choices and retries the exact protocol without duplicating payments or writeoffs', async ({ page }) => {
  const report = csv + '\r\n' + centCsv.split('\r\n')[1].replace(';14;', ';15;');
  const { commits, previews, ledgerCount, writeoffLedgerCount } = await setup(page, { knownBank: true, uncertain: true, commitBeforeError: true });
  await selectCsv(page, report); await analyze(page); await centCheckbox(page, '15').check(); await analyze(page); page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toContainText('O arquivo, as escolhas e o protocolo foram preservados');
  await expect(centCheckbox(page, '15')).toBeDisabled(); await expect(page.getByLabel('Relatório de títulos pagos', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reanalisar mesmo arquivo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Repetir confirmação pendente', exact: true }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'sem duplicar pagamentos ou baixas' })).toBeVisible(); expect(commits).toHaveLength(2); expect(commits[1]).toEqual(commits[0]);
  expect(previews.length).toBeGreaterThanOrEqual(2);expect(commits[0].resolution_choices).toEqual(previews.at(-1).resolution_choices); expect(ledgerCount()).toBe(1); expect(writeoffLedgerCount()).toBe(1);
});

test('a service response that loses an explicit cent choice cannot authorize confirmation', async ({ page }) => {
  const { commits, previews } = await setup(page, { staleChoice: true }); await selectCsv(page, centCsv); await analyze(page);
  await centCheckbox(page).check(); await analyze(page); expect(previews.at(-1).resolution_choices).toHaveProperty('row:1');
  await expect(panel(page).getByRole('alert').first()).toContainText('Não foi possível concluir a análise');
  await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toBeDisabled(); expect(commits).toHaveLength(0);
});

test('an older paid-import service cannot silently bypass reconciliation choices', async ({ page }) => {
  const { commits } = await setup(page, { knownBank: true, oldProtocol: true }); await selectCsv(page); await analyze(page);
  await expect(panel(page).getByRole('alert')).toContainText('Ative a atualização 043'); await expect(page.getByRole('button', { name: 'Concluir importação dos pagamentos', exact: true })).toHaveCount(0);
  expect(commits).toHaveLength(0);
});


// Modelo sintético com Quitação na coluna H, independente do vencimento da origem.
const explicitPaidDateHeaders=['Lançamento','Histórico','Plano cp - Conta: nome','Plano cc - Conta: nome','Emissão: valor do lançamento','Emissão: data','Vencimento: data','Quitação: data do pagamento','Filial','Situação'];
async function selectExplicitPaidDate(page:Page,paidDate:ExcelJS.CellValue,physicalLine=2) {
  const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Pagamentos sintéticos');sheet.addRow(explicitPaidDateHeaders);
  sheet.getRow(physicalLine).values=['14','Fornecedor pago sintético','ENERGIA','BANCO ERP PAGO',200,new Date('2026-10-01T10:15:00Z'),new Date('2043-06-30T12:00:00Z'),paidDate,'3','PAGO'];
  const original=Buffer.from(await workbook.xlsx.writeBuffer());
  await page.getByLabel('Relatório de títulos pagos',{exact:true}).setInputFiles({name:'pagos-com-quitacao.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:original});
  await page.getByRole('checkbox',{name:/Confirmo que este é o relatório de pagamentos do período/}).check();await analyze(page);return original;
}

test('explicit Quitação date overrides a distant Vencimento while preserving the forecast and original bytes',async({page})=>{
  const {previews,commits}=await setup(page,{knownBank:true});const original=await selectExplicitPaidDate(page,new Date('2026-10-17T23:59:59Z'));
  const preview=page.getByRole('table',{name:/Prévia dos pagamentos/});await expect(preview.locator('tbody tr')).toHaveCount(1);
  await expect(preview.getByRole('cell',{name:'17/10/2026',exact:true})).toBeVisible();await expect(preview.getByRole('cell',{name:'25/10/2026',exact:true})).toBeVisible();await expect(preview).not.toContainText('30/06/2043');
  expect(previews).toHaveLength(2);expect(previews[0].payment_date_version).toBe(paymentDateVersion);expect(previews[0].bank_rules_version).toBe(bankRulesVersion);expect(Buffer.from(previews[0].file_base64,'base64')).toEqual(original);expect(previews.at(-1).file_base64).toBe(previews[0].file_base64);expect(previews[0]).not.toHaveProperty('rows');
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true}).click();await expect(panel(page).getByRole('status')).toContainText('Importação concluída');
  expect(commits).toHaveLength(1);expect(commits[0].payment_date_version).toBe(paymentDateVersion);expect(commits[0].bank_rules_version).toBe(bankRulesVersion);expect(Buffer.from(commits[0].file_base64,'base64')).toEqual(original);expect(commits[0].file_base64).toBe(previews[0].file_base64);
  const preserved=new ExcelJS.Workbook();await preserved.xlsx.load(Buffer.from(commits[0].file_base64,'base64'));expect(preserved.worksheets[0].getCell('G2').value).toEqual(new Date('2043-06-30T12:00:00Z'));expect(preserved.worksheets[0].getCell('H2').value).toEqual(new Date('2026-10-17T23:59:59Z'));
});

test('an empty or malformed explicit Quitação date never falls back to Vencimento',async({page})=>{
  const {previews,commits,calls}=await setup(page,{knownBank:true});
  for(const paidDate of [null,'data inválida']as const)await test.step(paidDate===null?'blank explicit date':'invalid explicit date',async()=>{
    await selectExplicitPaidDate(page,paidDate);
    const problems=page.getByRole('table',{name:'Problemas dos pagamentos · até 100 linhas',exact:true});await expect(problems.locator('tbody tr')).toHaveCount(1);
    await expect(problems.getByRole('cell',{name:'Quitação: data do pagamento',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Conferência dos pagamentos',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toHaveCount(0);
    expect(previews).toHaveLength(0);expect(commits).toHaveLength(0);expect(calls.filter(call=>call.name==='payables-import')).toHaveLength(0);
  });
});

test('a future explicit Quitação date identifies its physical row and column before any canonical request',async({page})=>{
  const {previews,commits,calls}=await setup(page,{knownBank:true});await selectExplicitPaidDate(page,new Date('2026-10-19T00:00:00Z'),4);
  const problems=page.getByRole('table',{name:'Problemas dos pagamentos · até 100 linhas',exact:true}),row=problems.locator('tbody tr').filter({hasText:'A data do pagamento é futura.'});
  await expect(row).toHaveCount(1);await expect(row.getByRole('cell',{name:'4',exact:true})).toBeVisible();await expect(row.getByRole('cell',{name:'Quitação: data do pagamento',exact:true})).toBeVisible();await expect(row).toContainText('pagamentos agendados não confirmam pagamento realizado');
  await expect(page.getByRole('heading',{name:'Conferência dos pagamentos',exact:true})).toHaveCount(0);expect(previews).toHaveLength(0);expect(commits).toHaveLength(0);expect(calls.filter(call=>call.name==='payables-import')).toHaveLength(0);
  expect(await page.getByLabel('Relatório de títulos pagos',{exact:true}).evaluate(input=>(input as HTMLInputElement).files?.[0]?.name)).toBe('pagos-com-quitacao.xlsx');
  await expect(page.getByRole('checkbox',{name:/Confirmo que este é o relatório de pagamentos do período/})).toBeChecked();await expect(page.getByRole('button',{name:'Reanalisar mesmo arquivo',exact:true})).toBeEnabled();
});

test('authoritative server date validation keeps detailed source errors and the selected original for another analysis',async({page})=>{
  const {calls,previews,commits}=await setup(page,{knownBank:true,serverToday:'2026-10-16'});const original=await selectExplicitPaidDate(page,new Date('2026-10-17T00:00:00Z'),4);
  const problems=page.getByRole('table',{name:'Problemas dos pagamentos · até 100 linhas',exact:true}),row=problems.locator('tbody tr').filter({hasText:'A data do pagamento é futura.'});
  await expect(row).toHaveCount(1);await expect(row.getByRole('cell',{name:'4',exact:true})).toBeVisible();await expect(row.getByRole('cell',{name:'Quitação: data do pagamento',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Conferência dos pagamentos',exact:true})).toHaveCount(0);expect(previews).toHaveLength(0);expect(commits).toHaveLength(0);
  const requests=calls.filter(call=>call.name==='payables-import');expect(requests).toHaveLength(1);expect(requests[0].body.action).toBe('preview');expect(Buffer.from(requests[0].body.file_base64,'base64')).toEqual(original);expect(requests[0].body).not.toHaveProperty('today');
  await expect(page.getByLabel('Relatório de títulos pagos',{exact:true})).toBeEnabled();expect(await page.getByLabel('Relatório de títulos pagos',{exact:true}).evaluate(input=>(input as HTMLInputElement).files?.[0]?.name)).toBe('pagos-com-quitacao.xlsx');
  await expect(page.getByRole('button',{name:'Reanalisar mesmo arquivo',exact:true})).toBeEnabled();await expect(panel(page)).not.toContainText('private SQL query secret');
});


test('an older service that does not acknowledge the explicit payment-date contract cannot authorize confirmation',async({page})=>{
  const {previews,commits}=await setup(page,{knownBank:true,missingPaymentDateVersion:true});await selectExplicitPaidDate(page,new Date('2026-10-17T00:00:00Z'));
  await expect(panel(page).getByRole('alert')).toBeVisible();await expect(page.getByRole('heading',{name:'Conferência dos pagamentos',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toHaveCount(0);expect(previews).toHaveLength(1);expect(previews[0].payment_date_version).toBe(paymentDateVersion);expect(previews[0].bank_rules_version).toBe(bankRulesVersion);expect(commits).toHaveLength(0);
});

test('an older recorded import that still needs payment-date review never becomes a false success or an uncertain retry',async({page})=>{
  const {commits,ledgerCount}=await setup(page,{knownBank:true,dateReviewRequired:true});await selectExplicitPaidDate(page,new Date('2026-10-17T00:00:00Z'));
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true}).click();
  await expect(panel(page).getByRole('alert')).toContainText('histórico');await expect(panel(page)).not.toContainText('Importação concluída');await expect(panel(page)).not.toContainText('private SQL query secret');
  await expect(page.getByRole('button',{name:'Repetir confirmação pendente',exact:true})).toHaveCount(0);await expect(page.getByLabel('Relatório de títulos pagos',{exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Reanalisar mesmo arquivo',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toBeDisabled();expect(commits).toHaveLength(1);expect(commits[0].payment_date_version).toBe(paymentDateVersion);expect(commits[0].bank_rules_version).toBe(bankRulesVersion);expect(ledgerCount()).toBe(0);
});


const approvedBankAliases=[
  ['BANCO MODELO EASYCLEAN - 0001001-1','BRADESCO EASY CLEAN'],
  ['BANCO MODELO ECOPLAST 0001002-2','BRADESCO ECOPLAST'],
  ['BANCO MODELO F2G PARTICIPAÇÕES 0001003-3','BRADESCO F2G'],
  ['BANCO MODELO FAST CLEAN 0001004-4','BRADESCO FAST CLEAN'],
  ['BANCO MODELO GAMMA 0001005-5','BRADESCO GAMMA IND'],
  ['BANCO MODELO LIMPE FÁCIL 0001006-6','BRADESCO LIMPE FACIL'],
  ['DÉBITO SINTÉTICO EM CONTA - ECOPLAST','BRADESCO ECOPLAST'],
]as const;
const internalCashCheckbox=(page:Page,entry='14')=>page.getByRole('checkbox',{name:`Confirmar baixa sem pagamento do lançamento ${entry} filial 3`,exact:true});
const internalCashCsv=csv.replace(';200,00;',';100,00;').replace(';BANCO ERP PAGO;',';CAIXA INTERNO;').replace('17/10/2026 23:59:59','');

test('all seven approved source-bank descriptions resolve the official bank without inferring it from the branch',async({page})=>{
  const {previews,commits,accounts,ledgerCount,writeoffLedgerCount}=await setup(page);
  const report=headers.join(';')+'\r\n'+approvedBankAliases.map(([source],index)=>[`97`,String(100+index),'PAGO','17/10/2026 23:59:59','200,00',source,'',`Fornecedor bancário sintético ${index+1}`,'ENERGIA','01/10/2026 10:15:00'].join(';')).join('\r\n');
  await selectCsv(page,report);await analyze(page);
  const table=page.getByRole('table',{name:/Prévia dos pagamentos/});await expect(table.locator('tbody tr')).toHaveCount(7);
  for(const [index,[source,official]]of approvedBankAliases.entries()){
    const row=table.locator('tbody tr').nth(index),bankCell=row.locator('td').nth(5);
    await expect(row.locator('td').nth(1)).toHaveText('97');await expect(bankCell).toContainText(source);await expect(bankCell.getByText(official,{exact:true})).toBeVisible();
    expect(accounts.find(account=>account.display_name===official)?.account_type).toBe('BANK');
  }
  await expect(page.getByLabel(/^Conta oficial para banco/)).toHaveCount(0);await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toBeEnabled();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true}).click();await expect(panel(page).getByRole('status')).toContainText('7 conciliado(s)');
  expect(commits).toHaveLength(1);const expectedBanks=Object.fromEntries(approvedBankAliases.map(([source,official])=>[JSON.stringify(['source-bank','97',source]),accounts.find(account=>account.display_name===official)!.id]));expect(previews.length).toBeGreaterThanOrEqual(2);expect(previews[0].bank_mappings).toEqual({});expect(previews.at(-1).bank_mappings).toEqual(expectedBanks);expect(commits[0].bank_mappings).toEqual(expectedBanks);expect(commits[0].bank_rules_version).toBe(bankRulesVersion);expect(previews[0].bank_rules_version).toBe(bankRulesVersion);expect(Buffer.from(commits[0].file_base64,'base64').toString('utf8')).toBe(report);expect(ledgerCount()).toBe(7);expect(writeoffLedgerCount()).toBe(0);
});

test('Caixa Interno at a real nominal amount and blank date requires its own administrative writeoff confirmation',async({page})=>{
  const {previews,commits,ledgerCount,writeoffLedgerCount}=await setup(page);await selectCsv(page,internalCashCsv);await analyze(page);
  await expect(internalCashCheckbox(page)).not.toBeChecked();await expect(page.getByLabel(/^Conta oficial para banco/)).toHaveCount(0);
  await expect(panel(page)).toContainText('Valor nominal R$ 200,00');await expect(panel(page)).toContainText('Valor no arquivo R$ 100,00');
  const table=page.getByRole('table',{name:/Prévia dos pagamentos/});await expect(table).toContainText('Sem pagamento');await expect(table).toContainText('R$ 100,00');
  await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toBeDisabled();expect(commits).toHaveLength(0);
  await internalCashCheckbox(page).check();await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toBeDisabled();await analyze(page);
  await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toBeEnabled();expect(previews.at(-1).resolution_choices['row:1']).toMatchObject({action:'WRITE_OFF'});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true}).click();await expect(panel(page).getByRole('status')).toContainText('0 conciliado(s) e 1 baixa(s) sem pagamento');
  expect(commits).toHaveLength(1);expect(commits[0].bank_mappings).toEqual({});expect(Buffer.from(commits[0].file_base64,'base64').toString('utf8')).toBe(internalCashCsv);expect(commits[0]).not.toHaveProperty('rows');expect(ledgerCount()).toBe(0);expect(writeoffLedgerCount()).toBe(1);
});

test('two Caixa Interno rows require separate confirmations even when the source date is future or absent',async({page})=>{
  const first=internalCashCsv.split('\r\n')[1],second=first.replace(';14;',';15;').replace(';PAGO;;',';PAGO;19/10/2043;').replace(';100,00;',';250,50;');
  const {previews,commits,ledgerCount,writeoffLedgerCount}=await setup(page);await selectCsv(page,headers.join(';')+'\r\n'+first+'\r\n'+second);await analyze(page);
  await expect(internalCashCheckbox(page)).not.toBeChecked();await expect(internalCashCheckbox(page,'15')).not.toBeChecked();await internalCashCheckbox(page).check();await analyze(page);
  expect(previews.at(-1).resolution_choices).toHaveProperty('row:1');expect(previews.at(-1).resolution_choices).not.toHaveProperty('row:2');await expect(internalCashCheckbox(page,'15')).not.toBeChecked();await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toBeDisabled();expect(commits).toHaveLength(0);
  await internalCashCheckbox(page,'15').check();await analyze(page);await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toBeEnabled();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true}).click();await expect(panel(page).getByRole('status')).toContainText('2 baixa(s) sem pagamento');expect(ledgerCount()).toBe(0);expect(writeoffLedgerCount()).toBe(2);expect(Object.keys(commits[0].resolution_choices)).toEqual(['row:1','row:2']);
});

test('a mixed bank and Caixa Interno import freezes050 rules and repeats exact bytes without duplicating financial payments or writeoffs',async({page})=>{
  const real=csv.split('\r\n')[1].replace(';BANCO ERP PAGO;',`;${approvedBankAliases[0][0]};`),cash=internalCashCsv.split('\r\n')[1].replace(';14;',';15;'),report=headers.join(';')+'\r\n'+real+'\r\n'+cash;
  const {previews,commits,ledgerCount,writeoffLedgerCount}=await setup(page,{uncertain:true,commitBeforeError:true});await selectCsv(page,report);await analyze(page);await internalCashCheckbox(page,'15').check();await analyze(page);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true}).click();await expect(panel(page).getByRole('alert')).toContainText('O arquivo, as escolhas e o protocolo foram preservados');
  await expect(internalCashCheckbox(page,'15')).toBeDisabled();await expect(page.getByLabel('Relatório de títulos pagos',{exact:true})).toBeDisabled();expect(ledgerCount()).toBe(1);expect(writeoffLedgerCount()).toBe(1);
  await page.getByRole('button',{name:'Repetir confirmação pendente',exact:true}).click();await expect(panel(page).getByRole('status').filter({hasText:'sem duplicar pagamentos ou baixas'})).toBeVisible();
  expect(commits).toHaveLength(2);expect(commits[1]).toEqual(commits[0]);expect(commits[0]).toMatchObject({payment_date_version:paymentDateVersion,bank_rules_version:bankRulesVersion});expect(commits[0].resolution_choices).toEqual(previews.at(-1).resolution_choices);expect(Object.keys(commits[0].resolution_choices)).toEqual(['row:2']);expect(Buffer.from(commits[0].file_base64,'base64').toString('utf8')).toBe(report);expect(ledgerCount()).toBe(1);expect(writeoffLedgerCount()).toBe(1);
});

for(const unavailable of [false,true])test(`missing050 bank service ${unavailable?'activation':'echo'} blocks the paid import without falling back`,async({page})=>{
  const {calls,commits}=await setup(page,unavailable?{bankRulesUnavailable:true}:{missingBankRulesVersion:true});await selectCsv(page,internalCashCsv);await analyze(page);
  await expect(panel(page).getByRole('alert')).toBeVisible();await expect(page.getByRole('heading',{name:'Conferência dos pagamentos',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toHaveCount(0);
  const requests=calls.filter(call=>call.name==='payables-import');expect(requests).toHaveLength(1);expect(requests[0].body.bank_rules_version).toBe(bankRulesVersion);expect(commits).toHaveLength(0);await expect(panel(page)).not.toContainText('private SQL query secret');
});

test('Caixa Interno with a one-cent marker keeps the existing individual CENT confirmation even without a payment date',async({page})=>{
  const report=internalCashCsv.replace(';100,00;',';0,01;'),{previews,commits,ledgerCount,writeoffLedgerCount}=await setup(page);await selectCsv(page,report);await analyze(page);
  await expect(centCheckbox(page)).not.toBeChecked();await expect(internalCashCheckbox(page)).toHaveCount(0);await expect(page.getByLabel(/^Conta oficial para banco/)).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toBeDisabled();await centCheckbox(page).check();await analyze(page);
  await expect(centCheckbox(page)).toBeChecked();await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toBeEnabled();expect(previews.at(-1).resolution_choices['row:1']).toMatchObject({action:'WRITE_OFF'});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true}).click();await expect(panel(page).getByRole('status')).toContainText('0 conciliado(s) e 1 baixa(s) sem pagamento');
  expect(commits).toHaveLength(1);expect(ledgerCount()).toBe(0);expect(writeoffLedgerCount()).toBe(1);
});


test('resolved rows with the same source-bank key and different official IDs cannot produce an automatic mapping',async({page})=>{
  const {previews,commits}=await setup(page,{knownBank:true,conflictingBankIds:true});await selectCsv(page,csv+'\r\n'+csv.split('\r\n')[1].replace(';14;',';15;'));await analyze(page);
  await expect(panel(page).getByRole('alert')).toBeVisible();await expect(page.getByRole('heading',{name:'Conferência dos pagamentos',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toHaveCount(0);expect(previews).toHaveLength(1);expect(commits).toHaveLength(0);
});

test('a financial revision change during the automatic official-bank confirmation blocks that entire analysis',async({page})=>{
  const {previews,commits}=await setup(page,{knownBank:true,changeFreezeRevision:true});await selectCsv(page);await analyze(page);
  await expect(panel(page).getByRole('alert')).toBeVisible();await expect(page.getByRole('heading',{name:'Conferência dos pagamentos',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Concluir importação dos pagamentos',exact:true})).toHaveCount(0);
  expect(previews).toHaveLength(2);expect(previews[0].bank_mappings).toEqual({});expect(previews.at(-1).bank_mappings).toMatchObject({[JSON.stringify(['source-bank','3','BANCO ERP PAGO'])]:uuid(100)});expect(previews.at(-1).file_base64).toBe(previews[0].file_base64);expect(commits).toHaveLength(0);
});
