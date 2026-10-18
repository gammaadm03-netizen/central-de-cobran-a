import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = new Date('2026-10-18T15:00:00Z');
const uuid = (value: number) => `73000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const labels = ['BRADESCO ECOPLAST', 'BRADESCO LIMPE FACIL', 'BRADESCO GAMMA IND', 'BRADESCO F2G', 'BRADESCO FAST CLEAN', 'BRADESCO EASY CLEAN', 'BANCO DO BRASIL FAST CLEAN', 'BANCO DO BRASIL EASY CLEAN', 'BANCO DO BRASIL ECOPLAST', 'BANCO CORA LIMPE FACIL', 'BANCO CORA MY CLEAN', 'BANCO CORA ECO PLAST', 'CAIXA ECOPLAST', 'CAIXA LIMPE FACIL', 'CAIXA GAMMA', 'CAIXA FAST CLEAN', 'CAIXA EASY CLEAN'];
interface Options { director?: boolean; missing?: boolean; stale?: boolean; ambiguous?: boolean; uncertain?: boolean; commitBeforeError?: boolean; initialPayments?: number; initialPaymentAmount?: number; titleValue?: number; extraTitle?: boolean; changedFinancialRevision?: boolean; chequeNumber?: string | null; entryNumber?: string }
async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(now);
  const id = uuid(1); const role = options.director ? 'diretor' : 'contas_pagar';
  const permissions = ['painel', 'caixa', 'contas_pagar', 'importar_bases'].map(resource => ({ resource, action: 'read' }));
  if (!options.director) permissions.push({ resource: 'contas_pagar', action: 'write' }, { resource: 'contas_pagar', action: 'import' });
  const access = { profile: { id, username: 'FinanceiroTeste', display_name: 'Pessoa de Teste', role_key: role, enabled: true }, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, session_id: uuid(2), exp: Math.floor(now.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const title: any = { id: uuid(3), scope: 'grupo-consolidado', source_key: 'synthetic-title', entry_number: options.entryNumber ?? '8001', description: 'Fornecedor sintético de conciliação', branch: '3', due_date: '2026-10-14', amount_cents: options.titleValue ?? 20000, source_status: 'ABERTO', plan: 'ENERGIA', bank_account: 'Banco original da base', issued_on: '2026-10-01', macro: 'FIXO', status: 'SETTLED_IMPORT', settled_at: '2026-10-18T12:00:00Z', last_import_id: uuid(4), payment_revision: null, ...(Object.hasOwn(options, 'chequeNumber') ? { cheque_number: options.chequeNumber } : {}) };
  const sourceTitles = [title, ...(options.extraTitle ? [{ ...title, id: uuid(3000), source_key: 'synthetic-second-title', entry_number: '8002', description: 'Outro fornecedor sintético', amount_cents: 12345, due_date: '2026-10-20', macro: 'VARIÁVEL', status: 'OPEN', settled_at: null }] : [])];
  const accounts = labels.map((label, index) => ({ id: uuid(100 + index), display_name: label, company: label, bank: 'Conta sintética', account_label: label, account_type: index >= 12 ? 'CASH' : 'BANK' }));
  const payments: any[] = []; let event = 0, revisionReads = 0; const calls: { name: string; body: any; query: string; method: string }[] = [];
  function payment(amount = 100, paidOn = '2026-10-17', requestId = uuid(700 + event)) { event += 1; return { id: uuid(200 + event), request_id: requestId, title_id: title.id, event_revision: event, entry_number: title.entry_number, cheque_number: title.cheque_number ?? null, description: title.description, branch: title.branch, macro_snapshot: title.macro, plan_snapshot: title.plan, due_date: title.due_date, title_amount_cents: title.amount_cents, amount_cents: amount, paid_on: paidOn, bank_account_id: accounts[0].id, bank_label: accounts[0].display_name, observation: 'Comprovante sintético', created_at: '2026-10-18T15:00:00Z', created_by: id, created_by_name: 'Pessoa de Teste', created_by_username: 'FinanceiroTeste', cancelled_at: null, cancelled_by_name: null, cancellation_observation: null, status: 'ACTIVE' }; }
  // Somente registros históricos podem conter valores menores que o título.
  for (let index = 0; index < (options.initialPayments ?? 0); index += 1) { const historical: any = payment(options.initialPaymentAmount ?? 100); delete historical.cheque_number; payments.push(historical); }
  if (payments.length) title.payment_revision = payments.at(-1).id;
  const revision = () => ({ import_id: title.last_import_id, financial_revision: String(event) });
  const financial = (source: any = title) => { const active = payments.filter(item => item.title_id === source.id && !item.cancelled_at); const paid = active.reduce((sum, item) => sum + item.amount_cents, 0); const last = [...active].sort((a, b) => b.paid_on.localeCompare(a.paid_on) || b.event_revision - a.event_revision)[0]; return { ...source, paid_cents: paid, outstanding_cents: paid > 0 ? Math.max(0, source.amount_cents - paid) : source.status === 'SETTLED_IMPORT' ? 0 : source.amount_cents, payment_remaining_cents: Math.max(0, source.amount_cents - paid), overpaid_cents: Math.max(0, paid - source.amount_cents), last_payment_date: last?.paid_on ?? null, last_payment_bank: last?.bank_label ?? null, financial_status: paid > source.amount_cents ? 'OVERPAID' : paid === source.amount_cents && paid > 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : source.status === 'SETTLED_IMPORT' ? 'PENDING_RECONCILIATION' : 'OPEN' }; };
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count !== undefined ? { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' } : {}) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON(); calls.push({ name, body, query: url.search, method: request.method() });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600 } });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'fixture@test.invalid', email_confirmed_at: now.toISOString(), created_at: now.toISOString(), app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'current_access') return reply(access);
    if (name === 'payables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'payable_review_titles') return reply({ code: 'PGRST205' }, 404);
    if (['get_payable_month_status', 'payables_month_status', 'list_payable_month_closures'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (['director_report', 'payables_forecast'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'cash_position') return reply({ accounts: [], total_cents: null, expected_accounts: 17, reported_accounts: 0, latest_position_date: null });
    if (name === 'current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (name === 'payables_summary') return reply({ open_cents: financial().outstanding_cents, overdue_cents: 0, period_cents: financial().outstanding_cents, active_count: 1, latest_import_at: now.toISOString() });
    if (name === 'receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null, received_period_cents: 0, overdue_bps: null });
    if (name === 'payable_macros') return reply([{ name: 'FIXO' }, { name: 'VARIÁVEL' }], 200, 2);
    if (name === 'payable_imports') return reply([{ id: title.last_import_id, created_at: now.toISOString() }], 200, 1);
    if (name === 'payable_plan_mappings' || name === 'director_positions') return reply([], 200, 0);
    if (name === 'payable_titles' || name === 'payable_financial_titles') {
      if (name === 'payable_financial_titles' && options.missing) return reply({ code: '42P01', message: 'private SQL query secret' }, 404);
      const idFilter = url.searchParams.get('id');
      if (idFilter) return reply(financial(sourceTitles.find(item => item.id === idFilter.slice(3))));
      let rows = sourceTitles.map(source => name === 'payable_financial_titles' ? financial(source) : source);
      for (const key of ['status', 'macro', 'branch', 'financial_status']) { const value = url.searchParams.get(key); if (value?.startsWith('eq.')) rows = rows.filter(row => row[key] === value.slice(3)); }
      for (const bound of url.searchParams.getAll('due_date')) { if (bound.startsWith('gte.')) rows = rows.filter(row => row.due_date >= bound.slice(4)); if (bound.startsWith('lte.')) rows = rows.filter(row => row.due_date <= bound.slice(4)); }
      rows.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 25);
      return reply(rows.slice(offset, offset + limit), 200, rows.length);
    }
    if (name === 'get_payable_payment_accounts') return options.missing ? reply({ code: 'PGRST202' }, 404) : reply(accounts);
    if (name === 'get_payables_revision') { revisionReads += 1; return reply(options.changedFinancialRevision && revisionReads > 1 ? { ...revision(), financial_revision: String(event + 1) } : revision()); }
    if (name === 'payable_payment_summary') {
      if (options.missing) return reply({ code: 'PGRST202', message: 'private SQL query secret' }, 404);
      const selected = payments.filter(item => !item.cancelled_at && item.paid_on >= body.p_start && item.paid_on <= body.p_end);
      return reply({ total_paid_cents: selected.reduce((sum, item) => sum + item.amount_cents, 0), payment_count: selected.length, by_macro: ['FIXO', 'VARIÁVEL'].map(macro => ({ macro, amount_cents: selected.filter(item => (item.effective_macro ?? item.macro_snapshot) === macro).reduce((sum, item) => sum + item.amount_cents, 0), count: selected.filter(item => (item.effective_macro ?? item.macro_snapshot) === macro).length })), pending_reconciliation_count: financial().financial_status === 'PENDING_RECONCILIATION' ? 1 : 0, revision: revision() });
    }
    if (name === 'list_payable_payments') {
      if (options.missing) return reply({ code: 'PGRST202' }, 404);
      const selected = payments.filter(item => (body.p_title_id ? item.title_id === body.p_title_id : !item.cancelled_at && item.paid_on >= body.p_start && item.paid_on <= body.p_end) && (!body.p_macro || (item.effective_macro ?? item.macro_snapshot) === body.p_macro) && (!body.p_bank_account_id || item.bank_account_id === body.p_bank_account_id)).sort((a, b) => b.paid_on.localeCompare(a.paid_on) || b.event_revision - a.event_revision);
      return reply({ rows: selected.slice(body.p_offset, body.p_offset + body.p_limit), count: selected.length, revision: revision() });
    }
    if (name === 'register_payable_payment') {
      const existing = payments.find(item => item.request_id === body.p_request_id); if (existing) return reply(existing.id);
      if (options.ambiguous) return reply({ code: 'P0016', message: 'private SQL query secret' }, 409);
      if (options.stale) return reply({ code: '40001', message: 'private SQL query secret' }, 409);
      if (options.uncertain && !options.commitBeforeError) return reply({ code: 'XX000', message: 'private SQL query secret' }, 503);
      if (body.p_expected_revision !== title.payment_revision || body.p_expected_import_id !== title.last_import_id) return reply({ code: '40001' }, 409);
      if (body.p_amount_cents !== financial().payment_remaining_cents || body.p_amount_cents <= 0) return reply({ code: '22023', message: 'Only full remaining amount is permitted.' }, 400);
      const saved = payment(body.p_amount_cents, body.p_paid_on, body.p_request_id); saved.bank_account_id = body.p_bank_account_id; saved.bank_label = accounts.find(item => item.id === body.p_bank_account_id)!.display_name; saved.observation = body.p_observation; payments.push(saved); title.payment_revision = saved.id;
      if (options.uncertain) return reply({ code: 'XX000', message: 'private SQL query secret' }, 503);
      return reply(saved.id);
    }
    if (name === 'cancel_payable_payment') {
      const saved = payments.find(item => item.id === body.p_payment_id)!; event += 1; saved.cancelled_at = now.toISOString(); saved.cancelled_by_name = 'Pessoa de Teste'; saved.cancellation_observation = body.p_observation; saved.status = 'CANCELLED'; title.payment_revision = uuid(900 + event); return reply(title.payment_revision);
    }
    throw new Error(`Unexpected offline fixture request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('FinanceiroTeste'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click(); await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Contas a Pagar', exact: true }).click(); await expect(page.getByText('Carregando valores realizados…', { exact: true })).toHaveCount(0);
  return { title, payments, calls, accounts, financial };
}
async function openTitle(page: Page) { await page.getByRole('button', { name: /Conciliar título|Consultar pagamentos/, exact: true }).first().click(); await expect(page.getByText('Carregando título e histórico de pagamentos…', { exact: true })).toHaveCount(0); }
async function fillPayment(page: Page, date = '2026-10-17', bank = uuid(100)) {
  await page.getByLabel('Data real do pagamento', { exact: true }).fill(date); await page.getByLabel('Banco / conta do pagamento', { exact: true }).selectOption(bank); await page.getByLabel('Observação do pagamento', { exact: true }).fill('Conferido no comprovante do fornecedor.');
}
const editor = (page: Page) => page.locator('.payable-reconciliation-editor');
const actual = (page: Page) => page.locator('.payable-payment-total');

test('daily reconciliation defaults to yesterday, distinguishes absence from paid, and lists 17 official accounts', async ({ page }) => {
  const { calls } = await setup(page);
  await expect(page.getByLabel('Pagamento inicial', { exact: true })).toHaveValue('2026-10-17'); await expect(page.getByLabel('Pagamento final', { exact: true })).toHaveValue('2026-10-17');
  await expect(actual(page)).toContainText('R$ 0,00'); await expect(actual(page)).toContainText('1');
  await openTitle(page); await expect(editor(page)).toContainText('Restante para conciliar'); await expect(editor(page)).toContainText('R$ 200,00'); await expect(editor(page)).toContainText('Banco original da base');
  await expect(editor(page)).toContainText('a ausência na importação, sozinha, não comprova');
  await expect(page.getByLabel('Banco / conta do pagamento', { exact: true }).locator('option')).toHaveCount(18);
  const history = calls.find(call => call.name === 'list_payable_payments' && call.body.p_title_id); expect(history?.body.p_start).toBeNull(); expect(history?.body.p_end).toBeNull();
});

test('a historical payment is preserved and its remaining balance can only be completed in full', async ({ page }) => {
  const { payments, calls } = await setup(page, { initialPayments: 1, initialPaymentAmount: 7015 }); await openTitle(page); await fillPayment(page, '2026-10-18', uuid(110));
  await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).toHaveValue('129,85'); await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).not.toBeEditable();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('pagamento INTEGRAL'); expect(dialog.message().replaceAll('\u00a0', ' ')).toContain('R$ 129,85'); return dialog.accept(); }); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click();
  await expect(editor(page)).toContainText('Pago integralmente'); await expect(editor(page).locator('tbody tr')).toHaveCount(2); await expect(actual(page)).toContainText('R$ 70,15');
  await page.getByLabel('Pagamento final', { exact: true }).fill('2026-10-18'); await page.getByRole('button', { name: 'Consultar realizado', exact: true }).click(); await expect(actual(page)).toContainText('R$ 200,00');
  await expect(page.locator('.payable-payment-macros>div').filter({ hasText: 'FIXO' })).toContainText('R$ 200,00');
  expect(payments.map(item => [item.amount_cents, item.paid_on, item.bank_label])).toEqual([[7015, '2026-10-17', 'BRADESCO ECOPLAST'], [12985, '2026-10-18', 'BANCO CORA MY CLEAN']]);
  const writes = calls.filter(call => call.name === 'register_payable_payment'); expect(writes).toHaveLength(1); expect(writes[0].body.p_expected_revision).toBe(payments[0].id); expect(writes[0].body.p_amount_cents).toBe(12985);
  expect(calls.some(call => ['save_bank_balance', 'save_bank_position'].includes(call.name))).toBe(false);
});

test('new payments have a read-only exact full amount and confirmation dismissal or future dates never write', async ({ page }) => {
  const { calls } = await setup(page); await openTitle(page); await fillPayment(page);
  await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).toHaveValue('200,00'); await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).not.toBeEditable(); await expect(editor(page)).toContainText('use “Corrigir título” antes de registrar'); await expect(editor(page)).not.toContainText('Pago parcialmente');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click();
  await fillPayment(page, '2026-10-19'); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click(); expect(calls.filter(call => call.name === 'register_payable_payment')).toHaveLength(0);
  await fillPayment(page); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click(); await expect(editor(page)).toContainText('Pago integralmente'); expect(calls.filter(call => call.name === 'register_payable_payment').at(-1)?.body.p_amount_cents).toBe(20000);
});

test('Director consults payment histories and realized totals with no payment or reversal controls', async ({ page }) => {
  const { calls } = await setup(page, { director: true, initialPayments: 2 }); await expect(actual(page)).toContainText('R$ 2,00'); await openTitle(page);
  await expect(editor(page).locator('tbody tr')).toHaveCount(2); await expect(page.getByRole('button', { name: 'Confirmar pagamento', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Estornar pagamento', exact: true })).toHaveCount(0); expect(calls.some(call => ['register_payable_payment', 'cancel_payable_payment'].includes(call.name))).toBe(false);
});

test('stale import rejects payment, preserves draft, and requires explicit refresh before retry', async ({ page }) => {
  const options: Options = { stale: true }; const { calls, title } = await setup(page, options); await openTitle(page); await fillPayment(page);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click(); await expect(editor(page).getByRole('alert')).toContainText('atualizado por outra conciliação ou importação'); await expect(page.getByRole('button', { name: 'Confirmar pagamento', exact: true })).toBeDisabled(); await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).toHaveValue('200,00');
  title.amount_cents = 25000; title.due_date = '2026-10-20'; title.bank_account = 'Banco atualizado na base'; title.last_import_id = uuid(88); options.stale = false;
  await page.getByRole('button', { name: 'Conferir título e histórico', exact: true }).click(); await expect(page.getByRole('button', { name: 'Confirmar pagamento', exact: true })).toBeEnabled(); await expect(editor(page)).toContainText('Banco atualizado na base'); await expect(editor(page)).toContainText('20/10/2026'); await expect(editor(page)).toContainText('R$ 250,00');
  await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).toHaveValue('250,00'); await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).not.toBeEditable(); await expect(page.getByLabel('Data real do pagamento', { exact: true })).toHaveValue('2026-10-17'); await expect(page.getByLabel('Observação do pagamento', { exact: true })).toHaveValue('Conferido no comprovante do fornecedor.');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click(); await expect(editor(page).getByRole('status')).toContainText('registrado'); expect(calls.filter(call => call.name === 'register_payable_payment').at(-1)?.body.p_expected_import_id).toBe(uuid(88)); await expect(page.getByText('private SQL query secret')).toHaveCount(0);
});

test('uncertain response blocks a new payment and safely retries the same request without duplicates', async ({ page }) => {
  const options: Options = { uncertain: true, commitBeforeError: true }; const { payments, calls } = await setup(page, options); await openTitle(page); await fillPayment(page); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toContainText('Não foi possível confirmar o resultado'); await expect(page.getByRole('button', { name: 'Confirmar pagamento', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Fechar conciliação', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Reenviar a mesma solicitação com segurança', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Ver pagamentos da semana', exact: true }).click(); await expect(page.getByLabel('Pagamento final', { exact: true })).toHaveValue('2026-10-23'); await expect(page.getByRole('button', { name: 'Reenviar a mesma solicitação com segurança', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Conferir título e histórico', exact: true }).click(); await expect(page.getByRole('button', { name: 'Reenviar a mesma solicitação com segurança', exact: true })).toBeEnabled(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Reenviar a mesma solicitação com segurança', exact: true }).click(); await expect(editor(page).getByRole('status')).toContainText('registrado');
  const writes = calls.filter(call => call.name === 'register_payable_payment'); expect(writes).toHaveLength(2); expect(writes[0].body).toEqual(writes[1].body); expect(payments).toHaveLength(1); await expect(actual(page)).toContainText('R$ 200,00');
});

test('updated source amount, due date and bank preserve the paid ledger and the macro used in the payment', async ({ page }) => {
  const { title, payments } = await setup(page, { initialPayments: 1 }); await openTitle(page);
  title.amount_cents = 30000; title.due_date = '2026-11-03'; title.bank_account = 'Banco atualizado do relatório'; title.macro = 'VARIÁVEL'; title.last_import_id = uuid(89);
  await page.getByRole('button', { name: 'Conferir título e histórico', exact: true }).click();
  await expect(editor(page)).toContainText('R$ 300,00'); await expect(editor(page)).toContainText('03/11/2026'); await expect(editor(page)).toContainText('Banco atualizado do relatório'); await expect(editor(page)).toContainText('R$ 299,00');
  await expect(editor(page).locator('tbody tr')).toContainText('BRADESCO ECOPLAST'); await expect(actual(page)).toContainText('R$ 1,00'); await expect(page.locator('.payable-payment-macros>div').filter({ hasText: 'FIXO' })).toContainText('R$ 1,00'); expect(payments[0].macro_snapshot).toBe('FIXO'); expect(payments[0].amount_cents).toBe(100);
});

test('an audited macro correction appears in realized values while payment history preserves the original classification', async ({ page }) => {
  const { payments } = await setup(page, { initialPayments: 1 }); payments[0].effective_macro = 'VARIÁVEL';
  await page.getByRole('button', { name: 'Atualizar conciliação', exact: true }).click();
  await expect(page.locator('.payable-payment-macros>div').filter({ hasText: 'VARIÁVEL' })).toContainText('R$ 1,00');
  await expect(page.locator('.payable-payment-macros>div').filter({ hasText: 'FIXO' })).toContainText('R$ 0,00');
  await openTitle(page); await expect(editor(page)).toContainText('Macro registrado: FIXO · Corrigido para: VARIÁVEL');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar realizado em CSV', exact: true }).click(); const contents = await readFile((await (await download).path())!, 'utf8'); expect(contents).toContain('"VARIÁVEL"'); expect(payments[0].macro_snapshot).toBe('FIXO');
});

test('cancellation requires a reason and confirmation and preserves the immutable payment in history', async ({ page }) => {
  const { payments, calls } = await setup(page, { initialPayments: 1 }); await openTitle(page); await page.getByRole('button', { name: 'Estornar pagamento', exact: true }).click(); await expect(page.getByRole('button', { name: 'Confirmar estorno', exact: true })).toBeDisabled();
  await page.getByLabel('Motivo do estorno', { exact: true }).fill('Comprovante associado ao título incorreto.'); page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Confirmar estorno', exact: true }).click(); expect(calls.some(call => call.name === 'cancel_payable_payment')).toBe(false);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar estorno', exact: true }).click(); await expect(editor(page).getByRole('status')).toContainText('Pagamento estornado'); await expect(editor(page)).toContainText('Estornado em'); await expect(editor(page)).toContainText('Comprovante associado ao título incorreto.'); await expect(actual(page)).toContainText('R$ 0,00'); expect(payments).toHaveLength(1); expect(payments[0].status).toBe('CANCELLED'); expect(calls.some(call => call.method === 'DELETE' || call.method === 'PATCH')).toBe(false);
});

test('paginated actuals and title history never render thousands of rows and CSV respects actual dates', async ({ page }) => {
  const { calls } = await setup(page, { initialPayments: 27 }); await expect(page.locator('.payable-reconciliation>.panel').last().locator('tbody tr')).toHaveCount(25); await page.getByRole('button', { name: 'Mais realizados', exact: true }).click(); await expect(page.locator('.payable-reconciliation>.panel').last().locator('tbody tr')).toHaveCount(2);
  await openTitle(page); await expect(editor(page).locator('tbody tr')).toHaveCount(25); await page.getByRole('button', { name: 'Mais pagamentos do título', exact: true }).click(); await expect(editor(page).locator('tbody tr')).toHaveCount(2); expect(calls.filter(call => call.name === 'list_payable_payments' && call.body.p_title_id).at(-1)?.body.p_offset).toBe(25);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar realizado em CSV', exact: true }).click(); const file = await download; expect(file.suggestedFilename()).toBe('Contas_a_Pagar_Realizado_2026-10-17_2026-10-17.csv'); const contents = await readFile((await file.path())!, 'utf8'); expect(contents).toContain('Data real do pagamento'); expect(contents.split('\r\n')).toHaveLength(28); expect(contents).toContain('17/10/2026');
});

test('missing payment migration gives a friendly warning while imported titles remain visible', async ({ page }) => {
  await setup(page, { missing: true }); await expect(page.getByRole('alert').filter({ hasText: 'conciliação de pagamentos precisa da atualização' })).toBeVisible(); await expect(page.getByRole('cell', { name: 'Fornecedor sintético de conciliação', exact: true })).toBeVisible(); await expect(page.getByText('private SQL query secret')).toHaveCount(0);
});

test('payment observations render escaped text and the reconciliation fits a phone viewport', async ({ page }) => {
  const { payments } = await setup(page, { initialPayments: 1 }); payments[0].observation = '<script>window.receiptExecuted=true</script>'; await page.getByRole('button', { name: 'Atualizar conciliação', exact: true }).click(); await expect(page.locator('td').filter({ hasText: '<script>window.receiptExecuted=true</script>' })).toBeVisible(); expect(await page.evaluate(() => (window as any).receiptExecuted)).toBeUndefined();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('financial Excel includes actual October payments for a title updated to November and keeps native financial cells', async ({ page }) => {
  const { title, payments, calls } = await setup(page, { extraTitle: true, initialPayments: 1, initialPaymentAmount: 7015 });
  payments[0].bank_account_id = uuid(110); payments[0].bank_label = 'BANCO CORA MY CLEAN';
  title.due_date = '2026-11-03'; title.last_import_id = uuid(89);
  await page.getByLabel('Mês do relatório Excel', { exact: true }).fill('2026-10');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar mês completo — lançamento por lançamento', exact: true }).click(); const download = await downloading;
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await download.path())!);
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['TODOS OS LANÇAMENTOS', 'Resumo por Macro', 'Comparativo por Macro', 'Resumo do mês', 'Pagamentos realizados', 'Realizado por Macro']);
  const detail = workbook.worksheets[0]; expect(detail.columnCount).toBe(20); expect(detail.rowCount).toBe(2); expect(detail.getCell('B2').value).toBe('8002'); expect(detail.getCell('H2').value).toBeInstanceOf(Date); expect(detail.getCell('J2').value).toBe(123.45); expect(detail.getCell('O2').value).toBe(0); expect(detail.getCell('P2').value).toBe(123.45); expect(detail.getCell('Q2').value).toBe('Em aberto');
  const actualSheet = workbook.getWorksheet('Pagamentos realizados')!; expect(actualSheet.rowCount).toBe(2); expect(actualSheet.getCell('B2').value).toBe(title.id); expect(actualSheet.getCell('C2').value).toBe('8001'); expect(actualSheet.getCell('F2').value).toBe('FIXO'); expect(actualSheet.getCell('G2').value).toBeInstanceOf(Date); expect((actualSheet.getCell('G2').value as Date).toISOString().slice(0, 10)).toBe('2026-10-17'); expect(actualSheet.getCell('H2').value).toBe('BANCO CORA MY CLEAN'); expect(actualSheet.getCell('I2').value).toBe(70.15); expect(actualSheet.getCell('I2').numFmt).toContain('R$'); expect(actualSheet.getCell('J2').value).toBeInstanceOf(Date); expect(actualSheet.getCell('K2').value).toBe(uuid(1)); expect(actualSheet.getCell('L2').value).toBe('FIXO');
  const byMacro = workbook.getWorksheet('Realizado por Macro')!; expect(byMacro.getCell('A2').value).toBe('FIXO'); expect(byMacro.getCell('C2').value).toBe(70.15); expect(typeof byMacro.getCell('D2').value).toBe('number'); expect(byMacro.getCell('D2').numFmt).toContain('%');
  expect(payments[0].paid_on).toBe('2026-10-17'); expect(calls.some(call => call.name === 'list_payable_payments' && call.body.p_start === '2026-10-01' && call.body.p_end === '2026-10-31' && call.body.p_limit === 500 && call.body.p_title_id === null)).toBe(true);
});

test('financial revision changing during Excel export aborts the file even when the import ID stays the same', async ({ page }) => {
  const { calls, title } = await setup(page, { initialPayments: 1, changedFinancialRevision: true }); const downloads: string[] = []; page.on('download', item => downloads.push(item.suggestedFilename()));
  await page.getByLabel('Mês do relatório Excel', { exact: true }).fill('2026-10'); await page.getByRole('button', { name: 'Baixar mês completo — lançamento por lançamento', exact: true }).click();
  await expect(page.locator('section[aria-labelledby="payables-title"]').getByRole('alert')).toContainText('A base mudou durante a exportação'); expect(downloads).toEqual([]); expect(calls.filter(call => call.name === 'get_payables_revision')).toHaveLength(2); expect(title.last_import_id).toBe(uuid(4)); expect(calls.some(call => call.name === 'list_payable_payments' && call.body.p_limit === 500)).toBe(true);
});

test('ambiguous title identity is a deterministic rejection that preserves the draft and requires review', async ({ page }) => {
  const { payments, calls } = await setup(page, { ambiguous: true }); await openTitle(page); await fillPayment(page, '2026-10-17', uuid(110));
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toContainText('A identificação deste título é ambígua'); await expect(editor(page).getByRole('alert')).toContainText('Nenhum pagamento desta tentativa foi registrado');
  await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).toHaveValue('200,00'); await expect(page.getByLabel('Data real do pagamento', { exact: true })).toHaveValue('2026-10-17'); await expect(page.getByLabel('Banco / conta do pagamento', { exact: true })).toHaveValue(uuid(110));
  await expect(page.getByRole('button', { name: 'Confirmar pagamento', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Reenviar a mesma solicitação com segurança', exact: true })).toHaveCount(0); expect(payments).toHaveLength(0); expect(calls.filter(call => call.name === 'register_payable_payment')).toHaveLength(1); await expect(page.getByText('private SQL query secret')).toHaveCount(0);
  await page.getByRole('button', { name: 'Conferir título e histórico', exact: true }).click(); await expect(page.getByRole('button', { name: 'Confirmar pagamento', exact: true })).toBeEnabled();
});

test('the server rejects a tampered partial request and the UI preserves the full-amount draft without reporting success', async ({ page }) => {
  const { payments, calls } = await setup(page); await openTitle(page); await fillPayment(page);
  await page.route(`${project}/rest/v1/rpc/register_payable_payment`, async route => {
    const body = route.request().postDataJSON(); body.p_amount_cents -= 1;
    await route.fallback({ postData: JSON.stringify(body) });
  });
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toContainText('É permitido somente o valor integral a pagar');
  await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).toHaveValue('200,00'); await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).not.toBeEditable(); await expect(page.getByLabel('Observação do pagamento', { exact: true })).toHaveValue('Conferido no comprovante do fornecedor.');
  expect(payments).toHaveLength(0); expect(calls.filter(call => call.name === 'register_payable_payment')[0].body.p_amount_cents).toBe(19999); await expect(editor(page).getByRole('status')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Reenviar a mesma solicitação com segurança', exact: true })).toHaveCount(0);
});

test('cheque number stays separate from entry, bank and dates and its payment snapshot survives later imports', async ({ page }) => {
  const { title, payments, calls } = await setup(page, { chequeNumber: '000123', entryNumber: '14' }); await openTitle(page); await fillPayment(page, '2026-10-17', uuid(110));
  await expect(editor(page).getByRole('heading', { name: 'Conciliação do título 14', exact: true })).toBeVisible(); await expect(editor(page).locator('.payable-source-cheque')).toContainText('000123'); await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).toHaveValue('200,00'); await expect(page.getByLabel('Valor integral a pagar (R$)', { exact: true })).not.toBeEditable();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('pagamento INTEGRAL'); expect(dialog.message()).toContain('Lançamento: 14'); expect(dialog.message()).toContain('Nº cheque da base: 000123'); expect(dialog.message()).toContain('Banco/conta: BANCO CORA MY CLEAN'); expect(dialog.message()).toContain('Data efetiva: 17/10/2026'); return dialog.accept(); }); await page.getByRole('button', { name: 'Confirmar pagamento', exact: true }).click();
  await expect(editor(page)).toContainText('Pago integralmente'); await expect(editor(page).getByRole('columnheader', { name: 'Nº cheque registrado', exact: true })).toBeVisible(); await expect(editor(page).getByRole('cell', { name: '000123', exact: true })).toBeVisible(); await expect(editor(page).getByRole('cell', { name: 'BANCO CORA MY CLEAN', exact: true })).toBeVisible(); expect(payments[0].cheque_number).toBe('000123'); expect(payments[0].entry_number).toBe('14'); expect(payments[0].paid_on).toBe('2026-10-17');
  title.cheque_number = '000999'; title.last_import_id = uuid(91); await page.getByRole('button', { name: 'Conferir título e histórico', exact: true }).click(); await expect(editor(page).locator('.payable-source-cheque')).toContainText('000999'); await expect(editor(page).getByRole('cell', { name: '000123', exact: true })).toBeVisible(); await expect(editor(page).getByRole('cell', { name: '000999', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Atualizar conciliação', exact: true }).click(); await expect(page.getByText('Carregando valores realizados…', { exact: true })).toHaveCount(0);
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar realizado em CSV', exact: true }).click(); const contents = await readFile((await (await downloading).path())!, 'utf8'); expect(contents).toContain('Nº cheque registrado no pagamento'); expect(contents).toContain('"000123"'); expect(contents).not.toContain('"000999"'); expect(contents).toContain('"14"'); expect(contents).toContain('"BANCO CORA MY CLEAN"');
  expect(new URLSearchParams(calls.find(call => call.name === 'payable_financial_titles' && new URLSearchParams(call.query).has('id'))!.query).get('select')).toBe('*');
});

test('unknown historical cheque numbers remain explicitly unknown instead of borrowing the current source number', async ({ page }) => {
  const { payments, calls } = await setup(page, { chequeNumber: '000123', initialPayments: 1 }); await openTitle(page);
  await expect(editor(page).locator('.payable-source-cheque')).toContainText('000123'); await expect(editor(page).getByRole('cell', { name: 'Não informado', exact: true })).toBeVisible(); await expect(editor(page).getByRole('cell', { name: '000123', exact: true })).toHaveCount(0);
  payments[0].cheque_number = null; await page.getByRole('button', { name: 'Conferir título e histórico', exact: true }).click(); await expect(editor(page).getByRole('cell', { name: 'Não informado', exact: true })).toBeVisible(); expect(new URLSearchParams(calls.filter(call => call.name === 'payable_financial_titles' && new URLSearchParams(call.query).has('id')).at(-1)!.query).get('select')).toBe('*');
});

test('cheque identifiers render escaped text and actual CSV protects spreadsheet formulas', async ({ page }) => {
  const text = '<script>window.chequeExecuted=true</script>'; const { payments } = await setup(page, { chequeNumber: text, initialPayments: 2 }); payments[0].cheque_number = '=2+2'; payments[1].cheque_number = text;
  await openTitle(page); await expect(editor(page).locator('.payable-source-cheque')).toContainText(text); await expect(editor(page).getByRole('cell', { name: text, exact: true })).toBeVisible(); await expect(editor(page).getByRole('cell', { name: '=2+2', exact: true })).toBeVisible(); expect(await page.evaluate(() => (window as any).chequeExecuted)).toBeUndefined();
  await page.getByRole('button', { name: 'Atualizar conciliação', exact: true }).click(); await expect(page.getByText('Carregando valores realizados…', { exact: true })).toHaveCount(0);
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar realizado em CSV', exact: true }).click(); const contents = await readFile((await (await downloading).path())!, 'utf8'); expect(contents).toContain('"\'=2+2"'); expect(contents).toContain(text); expect(await page.evaluate(() => (window as any).chequeExecuted)).toBeUndefined();
});

test('period and macro paid consultation filters receipts by actual date, shows the selected total and opens its individual title', async ({ page }) => {
  const { title, payments, calls } = await setup(page, { director: true, initialPayments: 2 });
  title.due_date = '2026-09-15'; payments[0].amount_cents = 2000; payments[0].paid_on = '2026-10-05'; payments[0].macro_snapshot = 'VARIÁVEL'; payments[1].amount_cents = 500; payments[1].paid_on = '2026-10-07'; payments[1].macro_snapshot = 'FIXO';
  await page.getByRole('button', { name: 'Ver pagamentos da semana', exact: true }).click(); await expect(page.getByLabel('Pagamento inicial', { exact: true })).toHaveValue('2026-10-17'); await expect(page.getByLabel('Pagamento final', { exact: true })).toHaveValue('2026-10-23');
  await page.getByLabel('Pagamento inicial', { exact: true }).fill('2026-10-01'); await page.getByLabel('Pagamento final', { exact: true }).fill('2026-10-10'); await page.getByRole('button', { name: 'Consultar realizado', exact: true }).click(); await expect(actual(page)).toContainText('R$ 25,00');
  await page.getByLabel('Centro de Custo Macro dos pagamentos', { exact: true }).selectOption('VARIÁVEL'); await expect(actual(page)).toContainText('R$ 20,00'); await expect(actual(page)).not.toContainText('R$ 25,00');
  const table = page.locator('section[aria-labelledby="payable-actual-title"] tbody'); await expect(table.locator('tr')).toHaveCount(1); await expect(table).toContainText('05/10/2026'); await expect(table).toContainText('VARIÁVEL'); await expect(table).not.toContainText('FIXO');
  expect(calls.some(call => call.name === 'list_payable_payments' && call.body.p_start === '2026-10-01' && call.body.p_end === '2026-10-10' && call.body.p_macro === 'VARIÁVEL')).toBe(true);
  await page.getByRole('button', { name: 'Abrir título 8001', exact: true }).click(); await expect(editor(page)).toContainText('15/09/2026'); await expect(editor(page).locator('tbody tr')).toHaveCount(2); await expect(page.getByRole('button', { name: 'Confirmar pagamento', exact: true })).toHaveCount(0);
});
