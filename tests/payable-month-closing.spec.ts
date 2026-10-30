import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = new Date('2026-10-18T15:00:00Z');
const stamp = now.toISOString();
const month = '2026-09-01';
const uuid = (value: number) => `84000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const fingerprint = (value: number) => value.toString(16).padStart(64, '0');
type Failure = '40001' | 'XX000';
interface Options {
  director?: boolean;
  manager?: boolean;
  paidCents?: number;
  titleCents?: number;
  titleMacro?: 'FIXO' | 'VARIÁVEL';
  reviewed?: boolean;
  closed?: boolean;
  reviewFailure?: Failure;
  correctionFailure?: Failure;
  closingFailure?: Failure;
  historyFailureOffset?: number;
  historyCount?: number;
  snapshotFailure?: boolean;
  historical?: boolean;
  chequeNumber?: string | null;
}

async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(now);
  const userId = uuid(1);
  const role = options.director ? 'diretor' : options.manager ? 'gerente_geral' : 'contas_pagar';
  const permissions = ['painel', 'caixa', 'contas_pagar', 'importar_bases'].map(resource => ({ resource, action: 'read' }));
  if (!options.director) permissions.push({ resource: 'contas_pagar', action: 'write' }, { resource: 'contas_pagar', action: 'import' });
  const access = { profile: { id: userId, username: 'FinanceiroSintetico', display_name: 'Pessoa Sintética', role_key: role, enabled: true }, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, session_id: uuid(2), exp: Math.floor(now.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const title: any = {
    id: uuid(3), scope: 'grupo-consolidado', source_key: 'synthetic-month-title', entry_number: 'SINT-401',
    description: 'Fornecedor sintético para fechamento', cheque_number: options.chequeNumber ?? null, branch: '3 - FILIAL SINTÉTICA',
    due_date: '2026-09-14', issued_on: '2026-09-01', amount_cents: options.titleCents ?? 20000,
    source_status: 'ABERTO', plan: 'PLANO SINTÉTICO', bank_account: 'Banco indicado no relatório',
    macro: options.titleMacro ?? 'FIXO', status: 'SETTLED_IMPORT', settled_at: '2026-10-18T12:00:00Z',
    last_import_id: uuid(4), payment_revision: (options.paidCents ?? 20000) ? uuid(5) : null,
    review_status: options.reviewed ? 'CONCILIADO' : 'A_CONCILIAR', review_id: options.reviewed ? uuid(6) : null,
    reviewed_at: options.reviewed ? stamp : null, reviewed_by: options.reviewed ? userId : null,
    review_fingerprint: fingerprint(1),
  };
  let event = 1;
  const paid = options.paidCents ?? 20000;
  const payments: any[] = paid ? [{
    id: uuid(5), request_id: uuid(50), title_id: title.id, entry_number: title.entry_number,
    description: title.description, branch: title.branch, macro_snapshot: 'FIXO', effective_macro: 'FIXO',
    cheque_number: options.chequeNumber ? '000214' : null, plan_snapshot: title.plan, due_date: title.due_date, title_amount_cents: title.amount_cents,
    amount_cents: paid, paid_on: '2026-09-17', bank_account_id: uuid(100), bank_label: 'BRADESCO ECOPLAST',
    created_at: stamp, created_by: userId, created_by_name: 'Pessoa Sintética', created_by_username: 'FinanceiroSintetico',
    observation: 'Comprovante sintético', cancelled_at: null, cancelled_by_name: null, cancellation_observation: null, status: 'ACTIVE',
  }] : [];
  const revision = () => ({ import_id: title.last_import_id, financial_revision: String(event) });
  const financial = () => {
    const total = payments.filter(item => !item.cancelled_at).reduce((sum, item) => sum + item.amount_cents, 0);
    return { ...title, paid_cents: total, outstanding_cents: total > 0 ? Math.max(0, title.amount_cents - total) : title.status === 'SETTLED_IMPORT' ? 0 : title.amount_cents,
      payment_remaining_cents: Math.max(0, title.amount_cents - total), overpaid_cents: Math.max(0, total - title.amount_cents),
      financial_status: total > title.amount_cents ? 'OVERPAID' : total === title.amount_cents && total > 0 ? 'PAID' : total > 0 ? 'PARTIAL' : 'PENDING_RECONCILIATION',
      last_payment_date: payments.at(-1)?.paid_on ?? null, last_payment_bank: payments.at(-1)?.bank_label ?? null };
  };
  const historicalTitle = {
    ...financial(), id: uuid(10), source_key: 'synthetic-superseded-title', description: 'Versão sintética anterior do mesmo lançamento',
    due_date: '2026-09-10', amount_cents: 12000, last_import_id: uuid(11), paid_cents: 0, outstanding_cents: 0,
    payment_remaining_cents: 12000, overpaid_cents: 0, financial_status: 'PENDING_RECONCILIATION',
    payment_revision: null, review_status: 'A_CONCILIAR', review_id: null, reviewed_at: null, reviewed_by: null,
    review_fingerprint: fingerprint(10), closing_eligible: false, closing_exclusion_reason: 'Versão atual identificada no relatório mais recente.',
  };
  const frozenTitle = { ...financial(), cheque_number: options.chequeNumber ? '000113' : null, macro: 'VARIÁVEL', amount_cents: 10123, paid_cents: 10123, outstanding_cents: 0, payment_remaining_cents: 0, financial_status: 'PAID', review_status: 'CONCILIADO', review_id: uuid(6), reviewed_at: stamp, reviewed_by: userId, review_fingerprint: fingerprint(80) };
  const frozenPayment = { ...payments[0], id: uuid(710), title_id: title.id, entry_number: title.entry_number, description: title.description,
    branch: title.branch, macro_snapshot: 'FIXO', effective_macro: 'VARIÁVEL', amount_cents: 10123, paid_on: '2026-08-31',
    bank_label: 'BRADESCO ECOPLAST', cheque_number: options.chequeNumber ? '000214' : null, created_at: stamp, created_by: userId, cancelled_at: null };
  const realizedOtherTitlePayment = { ...frozenPayment, id: uuid(711), title_id: uuid(712), entry_number: 'OUTRO-MÊS',
    description: 'Pagamento sintético de título com vencimento em outro mês', cheque_number: options.chequeNumber ? '000315' : null, amount_cents: 2345, paid_on: '2026-09-05' };
  const snapshot = { month, schema_version: '1', titles: [frozenTitle], historical_titles: options.historical ? [historicalTitle] : [], payments: [frozenPayment],
    realized: { rows: [realizedOtherTitlePayment], by_macro: [{ macro: 'VARIÁVEL', amount_cents: 2345, count: 1 }], total_paid_cents: 2345, payment_count: 1 } };
  const closures: any[] = Array.from({ length: options.historyCount ?? (options.closed ? 1 : 0) }, (_, index) => ({
    id: uuid(300 + index), month, version: (options.historyCount ?? 1) - index, status: index === 0 && options.closed ? 'CLOSED' : 'REOPENED',
    created_at: `2026-10-${String(18 - Math.min(index, 17)).padStart(2, '0')}T12:00:00Z`, created_by: userId,
    source_revision: revision(), total_titles: 1, total_nominal_cents: 10123, total_paid_cents: 10123,
    created_by_name: 'Pessoa Sintética', created_by_username: 'FinanceiroSintetico', observation: `Conferência sintética ${index + 1}`,
    reopened_at: index === 0 && options.closed ? null : stamp, reopened_by: index === 0 && options.closed ? null : userId,
    reopening_observation: index === 0 && options.closed ? null : 'Reabertura sintética documentada', snapshot,
  }));
  let closed = !!options.closed;
  const status = (selectedMonth: string) => ({
    month: selectedMonth, status: closed ? 'CLOSED' : 'OPEN', total_titles: 1,
    reconciled_count: title.review_status === 'CONCILIADO' ? 1 : 0,
    pending_count: title.review_status === 'CONCILIADO' ? 0 : 1,
    eligible_count: financial().financial_status === 'PAID' && title.review_status !== 'CONCILIADO' ? 1 : 0,
    total_nominal_cents: title.amount_cents, total_paid_cents: financial().paid_cents,
    outstanding_cents: financial().outstanding_cents,
    can_close: !closed && title.review_status === 'CONCILIADO', revision: revision(), latest_closure: closures[0] ?? null,
    excluded_historical_count: options.historical ? 1 : 0,
    issues: title.review_status === 'CONCILIADO' ? [] : ['Existem títulos aguardando conciliação.'],
  });
  const calls: { name: string; body: any; query: string; method: string }[] = [];
  const accounts = [{ id: uuid(100), display_name: 'BRADESCO ECOPLAST', company: 'ECOPLAST', bank: 'BRADESCO', account_label: 'Conta sintética', account_type: 'BANK' }];
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, code = 200, count?: number) => route.fulfill({ status: code, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json });
    const reject = (code: Failure) => reply({ code, message: 'private SQL query secret' }, code === '40001' ? 409 : 503);
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON(); calls.push({ name, body, query: url.search, method: request.method() });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600 } });
    if (url.pathname === '/auth/v1/user') return reply({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@test.invalid', email_confirmed_at: stamp, created_at: stamp, app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'current_access') return reply(access);
    if (['director_report', 'payables_forecast', 'payables_management_summary'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'cash_position') return reply({ accounts: [], total_cents: null, expected_accounts: 17, reported_accounts: 0, latest_position_date: null });
    if (name === 'current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (name === 'payables_summary') return reply({ open_cents: financial().outstanding_cents, overdue_cents: 0, period_cents: 0, active_count: 1, latest_import_at: stamp });
    if (name === 'receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null, received_period_cents: 0, overdue_bps: null });
    if (name === 'payable_macros') return reply([{ name: 'FIXO' }, { name: 'VARIÁVEL' }], 200, 2);
    if (name === 'payable_imports') return reply([{ id: title.last_import_id, created_at: stamp }], 200, 1);
    if (name === 'payable_plan_mappings' || name === 'director_positions') return reply([], 200, 0);
    if (['payable_titles', 'payable_financial_titles', 'payable_review_titles'].includes(name)) {
      const selected = options.historical ? [financial(), historicalTitle] : [financial()];
      return reply(url.searchParams.has('id') ? selected.find(item => `eq.${item.id}` === url.searchParams.get('id')) : selected, 200, selected.length);
    }
    if (name === 'get_payable_payment_accounts') return reply(accounts);
    if (name === 'get_payables_revision') return reply(revision());
    if (name === 'payable_payment_summary') {
      const selected = payments.filter(item => !item.cancelled_at && item.paid_on >= body.p_start && item.paid_on <= body.p_end);
      return reply({ total_paid_cents: selected.reduce((sum, item) => sum + item.amount_cents, 0), payment_count: selected.length,
        by_macro: [{ macro: 'FIXO', amount_cents: selected.reduce((sum, item) => sum + item.amount_cents, 0), count: selected.length }],
        pending_reconciliation_count: financial().financial_status === 'PENDING_RECONCILIATION' ? 1 : 0, revision: revision() });
    }
    if (name === 'list_payable_payments') {
      const selected = body.p_title_id ? payments.filter(item => item.title_id === body.p_title_id) : payments.filter(item => item.paid_on >= body.p_start && item.paid_on <= body.p_end);
      return reply({ rows: selected.slice(body.p_offset, body.p_offset + body.p_limit), count: selected.length, revision: revision() });
    }
    if (name === 'review_payable_title') {
      if (options.reviewFailure) return reject(options.reviewFailure);
      if (body.p_expected_fingerprint !== title.review_fingerprint) return reject('40001');
      title.review_status = 'CONCILIADO'; title.review_id = uuid(800 + event); title.reviewed_at = stamp; title.reviewed_by = userId;
      title.review_fingerprint = fingerprint(++event); return reply(title.review_id);
    }
    if (name === 'correct_payable_title') {
      if (options.correctionFailure) return reject(options.correctionFailure);
      if (body.p_expected_fingerprint !== title.review_fingerprint) return reject('40001');
      Object.assign(title, { due_date: body.p_due_date, amount_cents: body.p_amount_cents, bank_account: body.p_bank_account,
        description: body.p_description, issued_on: body.p_issued_on, macro: body.p_macro,
        review_status: 'A_CONCILIAR', review_id: null, reviewed_at: null, reviewed_by: null });
      if (body.p_change_cheque === true) title.cheque_number = body.p_cheque_number;
      closed = false;
      if (body.p_reclassify_payments) payments.forEach(payment => { payment.effective_macro = body.p_macro; });
      title.review_fingerprint = fingerprint(++event); return reply(uuid(850 + event));
    }
    if (name === 'payables_month_status') return reply(status(body.p_month));
    if (name === 'list_payable_month_closures') {
      if (options.historyFailureOffset === body.p_offset) return reject('XX000');
      return reply({ rows: closures.slice(body.p_offset, body.p_offset + body.p_limit).map(({ snapshot: _snapshot, ...metadata }) => metadata), count: closures.length });
    }
    if (name === 'read_payable_month_closure') {
      if (options.snapshotFailure) return reject('XX000');
      const closure = closures.find(item => item.id === body.p_id); return reply(closure ?? null);
    }
    if (name === 'close_payables_month') {
      if (options.closingFailure) return reject(options.closingFailure);
      if (JSON.stringify(body.p_expected_revision) !== JSON.stringify(revision())) return reject('40001');
      const saved = { id: uuid(900 + event), month: body.p_month, version: (closures[0]?.version ?? 0) + 1, status: 'CLOSED',
        created_at: stamp, created_by: userId, created_by_name: 'Pessoa Sintética', created_by_username: 'FinanceiroSintetico',
        source_revision: revision(), total_titles: 1, total_nominal_cents: 10123, total_paid_cents: 10123,
        observation: body.p_observation, reopened_at: null, reopened_by: null, reopening_observation: null, snapshot };
      closures.unshift(saved); closed = true; event += 1; return reply(saved.id);
    }
    if (name === 'reopen_payables_month') {
      if (options.closingFailure) return reject(options.closingFailure);
      if (body.p_expected_closure_id !== closures[0]?.id) return reject('40001');
      closures[0].reopened_at = stamp; closures[0].reopened_by = userId; closures[0].reopening_observation = body.p_observation;
      closures[0].status = 'REOPENED'; closed = false; event += 1; return reply(closures[0].id);
    }
    throw new Error(`Unexpected offline month-closing request ${name}`);
  });
  await page.goto('/');
  await page.getByLabel('Usuário', { exact: true }).fill('FinanceiroSintetico');
  await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Contas a Pagar', exact: true }).click();
  await expect(page.getByText('Carregando títulos…', { exact: true })).toHaveCount(0);
  return { title, payments, calls, closures, snapshot, historicalTitle, financial, options };
}

const review = (page: Page) => page.locator('.payable-title-review');
const closing = (page: Page) => page.locator('.payable-month-closing');
const writeNames = ['review_payable_title', 'correct_payable_title', 'close_payables_month', 'reopen_payables_month'];

async function openReview(page: Page) {
  await page.locator('section[aria-labelledby="payables-title"]').getByRole('button', { name: /^(A CONCILIAR|CONCILIADO)$/ }).first().click();
  await expect(review(page).getByRole('heading', { name: 'Conferência do título SINT-401', exact: true })).toBeVisible();
  await expect(review(page).getByRole('button', { name: 'Atualizar conferência', exact: true })).toBeEnabled();
}

async function selectMonth(page: Page) {
  await closing(page).getByLabel('Mês do fechamento', { exact: true }).fill('2026-09');
  await closing(page).getByRole('button', { name: 'Consultar fechamento', exact: true }).click();
  await expect(closing(page).getByRole('button', { name: 'Atualizar fechamento', exact: true })).toBeEnabled();
}

async function correction(page: Page) {
  await review(page).getByText('Corrigir título', { exact: true }).click();
  await review(page).getByLabel('Vencimento do título', { exact: true }).fill('2026-09-21');
  await review(page).getByLabel('Valor atualizado do título (R$)', { exact: true }).fill('250,37');
  await review(page).getByLabel('Banco / conta informado no título', { exact: true }).fill('Banco corrigido da base');
  await review(page).getByRole('textbox', { name: 'Histórico / favorecido do título', exact: true }).fill('Favorecido sintético corrigido');
  await review(page).getByLabel('Emissão do título', { exact: true }).fill('2026-09-02');
  await review(page).getByRole('combobox', { name: 'Centro de Custo Macro corrigido', exact: true }).selectOption('VARIÁVEL');
  await review(page).getByRole('textbox', { name: 'Motivo da correção', exact: true }).fill('Correção conferida com o relatório do sistema.');
}

test('partial, absent and overpaid titles cannot be explicitly marked reconciled', async ({ page }) => {
  const cases = [{ paidCents: 7001 }, { paidCents: 0 }, { paidCents: 0, titleCents: 0 }, { paidCents: 20001 }];
  for (const options of cases) {
    const { calls } = await setup(page, options); await openReview(page);
    await expect(review(page).getByRole('button', { name: 'Confirmar conciliação do título', exact: true })).toBeDisabled();
    expect(calls.filter(call => writeNames.includes(call.name))).toEqual([]);
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const manager of [false, true]) {
  test(`${manager ? 'Manager' : 'CP operator'} explicitly reviews a fully paid title with a reason, confirmation and fingerprint`, async ({ page }) => {
    const { calls, title } = await setup(page, { manager }); await openReview(page);
    const originalFingerprint = title.review_fingerprint;
    await review(page).getByRole('textbox', { name: 'Observação da conferência', exact: true }).fill('Comprovantes, datas e bancos conferidos.');
    page.once('dialog', dialog => dialog.dismiss());
    await review(page).getByRole('button', { name: 'Confirmar conciliação do título', exact: true }).click();
    expect(calls.some(call => call.name === 'review_payable_title')).toBe(false);
    page.once('dialog', dialog => { expect(dialog.message()).toMatch(/concili|confer/i); return dialog.accept(); });
    await review(page).getByRole('button', { name: 'Confirmar conciliação do título', exact: true }).click();
    await expect(review(page).getByRole('status').filter({ hasText: 'Título marcado como CONCILIADO' })).toBeVisible();
    await expect(review(page)).toContainText('CONCILIADO');
    const saved = calls.filter(call => call.name === 'review_payable_title'); expect(saved).toHaveLength(1);
    expect(saved[0].body).toEqual({ p_title_id: title.id, p_observation: 'Comprovantes, datas e bancos conferidos.', p_expected_fingerprint: originalFingerprint });
    expect(calls.some(call => ['register_payable_payment', 'save_bank_position', 'save_bank_balance'].includes(call.name))).toBe(false);
  });
}

test('Director can read review and immutable closing history without mutation controls', async ({ page }) => {
  const { calls } = await setup(page, { director: true, reviewed: true, closed: true }); await openReview(page);
  await expect(review(page)).toContainText('CONCILIADO');
  await expect(review(page).getByRole('button', { name: 'Confirmar conciliação do título', exact: true })).toHaveCount(0);
  await expect(review(page).getByText('Corrigir título', { exact: true })).toHaveCount(0);
  await selectMonth(page);
  await expect(closing(page).getByRole('button', { name: 'Fechar mês', exact: true })).toHaveCount(0);
  await expect(closing(page).getByRole('button', { name: 'Reabrir mês', exact: true })).toHaveCount(0);
  await expect(closing(page).getByRole('button', { name: 'Baixar fechamento em Excel', exact: true })).toBeVisible();
  expect(calls.some(call => writeNames.includes(call.name))).toBe(false);
});

test('correction preserves payments and requires explicit macro reclassification with audited reason and fingerprint', async ({ page }) => {
  const { calls, payments, title } = await setup(page, { reviewed: true }); await openReview(page); await correction(page);
  const originalFingerprint = title.review_fingerprint;
  await expect(review(page).getByRole('button', { name: 'Salvar correção do título', exact: true })).toBeDisabled();
  expect(calls.some(call => call.name === 'correct_payable_title')).toBe(false);
  await review(page).getByLabel('Atualizar macro dos pagamentos já registrados', { exact: true }).check();
  page.once('dialog', dialog => dialog.dismiss()); await review(page).getByRole('button', { name: 'Salvar correção do título', exact: true }).click();
  expect(calls.some(call => call.name === 'correct_payable_title')).toBe(false);
  page.once('dialog', dialog => { expect(dialog.message()).toMatch(/pagamento|macro/i); return dialog.accept(); });
  await review(page).getByRole('button', { name: 'Salvar correção do título', exact: true }).click();
  await expect(review(page).getByRole('status').filter({ hasText: /correç|corrigid/i })).toBeVisible();
  const corrected = calls.filter(call => call.name === 'correct_payable_title'); expect(corrected).toHaveLength(1);
  expect(corrected[0].body).toEqual({ p_title_id: title.id, p_due_date: '2026-09-21', p_amount_cents: 25037,
    p_bank_account: 'Banco corrigido da base', p_description: 'Favorecido sintético corrigido', p_issued_on: '2026-09-02', p_macro: 'VARIÁVEL',
    p_observation: 'Correção conferida com o relatório do sistema.', p_expected_fingerprint: originalFingerprint, p_reclassify_payments: true });
  expect(payments).toHaveLength(1); expect(payments[0].amount_cents).toBe(20000); expect(payments[0].macro_snapshot).toBe('FIXO'); expect(payments[0].effective_macro).toBe('VARIÁVEL');
  await expect(review(page)).toContainText('A CONCILIAR'); await expect(review(page)).toContainText('R$ 250,37');
});

test('payments can be reclassified to the current title macro after a prior source import changed that macro', async ({ page }) => {
  const { calls, payments, title } = await setup(page, { titleMacro: 'VARIÁVEL' }); await openReview(page);
  await review(page).getByText('Corrigir título', { exact: true }).click();
  await expect(review(page).getByRole('combobox', { name: 'Centro de Custo Macro corrigido', exact: true })).toHaveValue('VARIÁVEL');
  await review(page).getByLabel('Atualizar macro dos pagamentos já registrados', { exact: true }).check();
  await review(page).getByRole('textbox', { name: 'Motivo da correção', exact: true }).fill('Aplicar aos pagamentos o macro já atualizado na importação.');
  page.once('dialog', dialog => dialog.accept()); await review(page).getByRole('button', { name: 'Salvar correção do título', exact: true }).click();
  await expect(review(page).getByRole('status').filter({ hasText: /correç|corrigid/i })).toBeVisible();
  const saved = calls.filter(call => call.name === 'correct_payable_title'); expect(saved).toHaveLength(1);
  expect(saved[0].body.p_title_id).toBe(title.id); expect(saved[0].body.p_macro).toBe('VARIÁVEL'); expect(saved[0].body.p_reclassify_payments).toBe(true);
  expect(payments[0].macro_snapshot).toBe('FIXO'); expect(payments[0].effective_macro).toBe('VARIÁVEL'); expect(payments[0].amount_cents).toBe(20000);
});

for (const failure of ['40001', 'XX000'] as const) {
  test(`${failure} correction failure keeps the draft, hides SQL details and blocks unverified repetition`, async ({ page }) => {
    const options: Options = { correctionFailure: failure }; const { calls, title } = await setup(page, options); await openReview(page); await correction(page);
    await review(page).getByLabel('Atualizar macro dos pagamentos já registrados', { exact: true }).check();
    page.once('dialog', dialog => dialog.accept()); await review(page).getByRole('button', { name: 'Salvar correção do título', exact: true }).click();
    await expect(review(page).getByRole('alert')).toBeVisible();
    await expect(review(page).getByLabel('Valor atualizado do título (R$)', { exact: true })).toHaveValue('250,37');
    await expect(review(page).getByRole('textbox', { name: 'Motivo da correção', exact: true })).toHaveValue('Correção conferida com o relatório do sistema.');
    await expect(review(page).getByRole('button', { name: 'Salvar correção do título', exact: true })).toBeDisabled();
    expect(title.amount_cents).toBe(20000); expect(calls.filter(call => call.name === 'correct_payable_title')).toHaveLength(1);
    await expect(page.getByText('private SQL query secret')).toHaveCount(0);
  });
}

test('a stale review never claims success and requires refreshing the source fingerprint', async ({ page }) => {
  const options: Options = { reviewFailure: '40001' }; const { title, calls } = await setup(page, options); await openReview(page);
  await review(page).getByRole('textbox', { name: 'Observação da conferência', exact: true }).fill('Conferência sintética completa.');
  page.once('dialog', dialog => dialog.accept()); await review(page).getByRole('button', { name: 'Confirmar conciliação do título', exact: true }).click();
  await expect(review(page).getByRole('alert')).toBeVisible(); await expect(review(page).getByRole('status')).toHaveCount(0);
  await expect(review(page).getByRole('button', { name: 'Confirmar conciliação do título', exact: true })).toBeDisabled();
  await expect(review(page).getByRole('textbox', { name: 'Observação da conferência', exact: true })).toHaveValue('Conferência sintética completa.');
  options.reviewFailure = undefined; title.review_fingerprint = fingerprint(91);
  await review(page).getByRole('button', { name: 'Atualizar conferência', exact: true }).click();
  await expect(review(page).getByRole('button', { name: 'Confirmar conciliação do título', exact: true })).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); await review(page).getByRole('button', { name: 'Confirmar conciliação do título', exact: true }).click();
  await expect(review(page)).toContainText('CONCILIADO'); expect(calls.filter(call => call.name === 'review_payable_title').at(-1)?.body.p_expected_fingerprint).toBe(fingerprint(91));
});

test('month closing stays blocked while any title awaits explicit reconciliation', async ({ page }) => {
  const { calls } = await setup(page); await selectMonth(page);
  await closing(page).getByRole('textbox', { name: 'Observação do fechamento', exact: true }).fill('Tentativa sintética com conferência pendente.');
  await expect(closing(page).getByRole('button', { name: 'Fechar mês', exact: true })).toBeDisabled();
  await expect(closing(page)).toContainText(/A conciliar|pendente|aguardando conciliação/i);
  expect(calls.some(call => call.name === 'close_payables_month')).toBe(false);
});

test('a fully reconciled month closes with a frozen revision and reopens with a separate reason and closure ID', async ({ page }) => {
  const { calls, closures } = await setup(page, { reviewed: true }); await selectMonth(page);
  await closing(page).getByRole('textbox', { name: 'Observação do fechamento', exact: true }).fill('Todos os títulos e comprovantes foram conferidos.');
  page.once('dialog', dialog => dialog.dismiss()); await closing(page).getByRole('button', { name: 'Fechar mês', exact: true }).click();
  expect(calls.some(call => call.name === 'close_payables_month')).toBe(false);
  const expectedRevision = calls.filter(call => call.name === 'payables_month_status').at(-1)!;
  page.once('dialog', dialog => { expect(dialog.message()).toMatch(/fechar|fechamento/i); return dialog.accept(); });
  await closing(page).getByRole('button', { name: 'Fechar mês', exact: true }).click();
  await expect(closing(page)).toContainText(/Fechado/i);
  const closed = calls.filter(call => call.name === 'close_payables_month'); expect(closed).toHaveLength(1);
  expect(closed[0].body.p_month).toBe(month); expect(expectedRevision.body.p_month).toBe(month);
  expect(closed[0].body.p_expected_revision).toEqual({ import_id: uuid(4), financial_revision: '1' });
  await closing(page).getByRole('textbox', { name: 'Observação do fechamento', exact: true }).fill('Reabertura para conferir um documento adicional.');
  page.once('dialog', dialog => { expect(dialog.message()).toMatch(/reabrir/i); return dialog.accept(); });
  await closing(page).getByRole('button', { name: 'Reabrir mês', exact: true }).click();
  await expect(closing(page)).toContainText(/Aberto/i);
  const reopened = calls.filter(call => call.name === 'reopen_payables_month'); expect(reopened).toHaveLength(1);
  expect(reopened[0].body).toEqual({ p_month: month, p_observation: 'Reabertura para conferir um documento adicional.', p_expected_closure_id: closures[0].id });
  expect(closures).toHaveLength(1); expect(closures[0].snapshot.titles[0].amount_cents).toBe(10123);
});

test('a concurrent financial change blocks closing without clearing the observation or showing false success', async ({ page }) => {
  const { calls } = await setup(page, { reviewed: true, closingFailure: '40001' }); await selectMonth(page);
  await closing(page).getByRole('textbox', { name: 'Observação do fechamento', exact: true }).fill('Conferência completa antes da alteração concorrente.');
  page.once('dialog', dialog => dialog.accept()); await closing(page).getByRole('button', { name: 'Fechar mês', exact: true }).click();
  await expect(closing(page).getByRole('alert')).toBeVisible();
  await expect(closing(page).getByRole('textbox', { name: 'Observação do fechamento', exact: true })).toHaveValue('Conferência completa antes da alteração concorrente.');
  await expect(closing(page).getByRole('button', { name: 'Fechar mês', exact: true })).toBeDisabled();
  expect(calls.filter(call => call.name === 'close_payables_month')).toHaveLength(1); await expect(page.getByText('private SQL query secret')).toHaveCount(0);
});

test('history is paginated and a failed next page does not display the previous page as current', async ({ page }) => {
  const options: Options = { director: true, reviewed: true, closed: true, historyCount: 12, historyFailureOffset: 10 };
  const { calls } = await setup(page, options); await selectMonth(page);
  await expect(closing(page).getByText('Conferência sintética 1', { exact: true })).toBeVisible();
  await closing(page).getByRole('button', { name: 'Mais fechamentos', exact: true }).click();
  await expect(closing(page).getByRole('alert')).toBeVisible();
  await expect(closing(page).getByText('Conferência sintética 1', { exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.name === 'list_payable_month_closures').at(-1)?.body.p_offset).toBe(10);
  options.historyFailureOffset = undefined;
  await closing(page).getByRole('button', { name: 'Atualizar fechamento', exact: true }).click();
  await expect(closing(page).getByText('Conferência sintética 11', { exact: true })).toBeVisible();
  await expect(closing(page).getByText('Conferência sintética 1', { exact: true })).toHaveCount(0);
});

test('immutable Excel uses closure data, typed dates and numbers, and actual-month payments from other due months', async ({ page }) => {
  const { calls, title } = await setup(page, { director: true, reviewed: true, closed: true }); await selectMonth(page);
  title.amount_cents = 99701; title.description = 'Current title changed after historical closure';
  const pending = page.waitForEvent('download');
  await closing(page).getByRole('button', { name: 'Baixar fechamento em Excel', exact: true }).click();
  const download = await pending, workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await download.path())!);
  expect(download.suggestedFilename()).toMatch(/2026-09.*\.xlsx$/);
  const cells: ExcelJS.Cell[] = []; workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => cells.push(cell))));
  const values = cells.map(cell => cell.value);
  expect(values).toContain('Fornecedor sintético para fechamento'); expect(values).not.toContain('Current title changed after historical closure');
  expect(values).toContain(101.23); expect(values).not.toContain(997.01); expect(values).toContain(23.45);
  expect(cells.some(cell => cell.value instanceof Date && cell.value.toISOString().slice(0, 10) === '2026-08-31')).toBe(true);
  expect(cells.some(cell => cell.value instanceof Date && cell.value.toISOString().slice(0, 10) === '2026-09-05')).toBe(true);
  expect(cells.some(cell => typeof cell.value === 'number' && cell.value === 101.23 && cell.numFmt.includes('0.00'))).toBe(true);
  expect(workbook.getWorksheet('Pagamentos dos títulos')?.getCell('E2').value).toBe('VARIÁVEL');
  expect(workbook.getWorksheet('Realizados no mês')?.getCell('E2').value).toBe('VARIÁVEL');
  expect(values.some(value => typeof value === 'string' && /fechamento|versão/i.test(value))).toBe(true);
  expect(values).toContain(uuid(300));
  expect(calls.filter(call => call.name === 'read_payable_month_closure')).toHaveLength(1);
  expect(calls.some(call => writeNames.includes(call.name))).toBe(false);
});

test('a failed snapshot read never exports current live titles under a historical filename', async ({ page }) => {
  await setup(page, { director: true, reviewed: true, closed: true, snapshotFailure: true }); await selectMonth(page);
  const downloads: string[] = []; page.on('download', item => downloads.push(item.suggestedFilename()));
  await closing(page).getByRole('button', { name: 'Baixar fechamento em Excel', exact: true }).click();
  await expect(closing(page).getByRole('alert')).toBeVisible(); expect(downloads).toEqual([]);
  await expect(page.getByText('private SQL query secret')).toHaveCount(0);
});

test('superseded source versions stay consultable without requiring payment and appear separately in the historical Excel', async ({ page }) => {
  const { calls } = await setup(page, { reviewed: true, closed: true, historical: true }); await selectMonth(page);
  await expect(closing(page)).toContainText('1 de 1 títulos concluídos');
  await expect(closing(page)).toContainText('1 registro(s) preservado(s) no histórico, fora da conferência e dos totais do fechamento');
  const old = page.locator('section[aria-labelledby="payables-title"]').getByRole('row').filter({ hasText: 'Versão sintética anterior do mesmo lançamento' });
  await expect(old.getByRole('button', { name: 'VERSÃO ANTERIOR', exact: true })).toBeDisabled();
  await old.getByRole('button', { name: 'Consultar pagamentos', exact: true }).click();
  const paymentEditor = page.locator('.payable-reconciliation-editor');
  await expect(paymentEditor).toContainText('Versão sintética anterior do mesmo lançamento');
  await expect(paymentEditor.getByRole('button', { name: 'Confirmar pagamento', exact: true })).toHaveCount(0);
  await expect(paymentEditor.getByRole('button', { name: 'Estornar pagamento', exact: true })).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await closing(page).getByRole('button', { name: 'Baixar fechamento em Excel', exact: true }).click();
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await (await pending).path())!);
  expect(workbook.getWorksheet('Títulos do mês')?.rowCount).toBe(2);
  const history = workbook.getWorksheet('Versões anteriores'); expect(history?.rowCount).toBe(2);
  expect(history?.getCell('C2').value).toBe('Versão sintética anterior do mesmo lançamento');
  expect(history?.getCell('I2').value).toBe(120);
  expect(calls.some(call => writeNames.includes(call.name) || call.name === 'register_payable_payment')).toBe(false);
});

test('Excel refuses an aggregate with more than fifteen digits even when each title amount is individually safe', async ({ page }) => {
  const { snapshot, closures } = await setup(page, { director: true, reviewed: true, closed: true }); await selectMonth(page);
  const first = snapshot.titles[0]; first.amount_cents = 500000000000000; first.paid_cents = 500000000000000;
  snapshot.titles.push({ ...first, id: uuid(990), source_key: 'synthetic-large-second', entry_number: 'SINT-402' });
  closures[0].total_titles = 2; closures[0].total_nominal_cents = 1000000000000000; closures[0].total_paid_cents = 1000000000000000;
  const downloads: string[] = []; page.on('download', item => downloads.push(item.suggestedFilename()));
  await closing(page).getByRole('button', { name: 'Baixar fechamento em Excel', exact: true }).click();
  await expect(closing(page).getByRole('alert')).toContainText(/precisão|Excel/i);
  expect(downloads).toEqual([]);
});


test('cheque is separate from entry number and an audited correction preserves leading zeroes and previous payment metadata', async ({ page }) => {
  const { title, payments, calls } = await setup(page, { reviewed: true, closed: true, chequeNumber: '000719' });
  await openReview(page);
  await expect(review(page).getByRole('heading', { name: 'Conferência do título SINT-401', exact: true })).toBeVisible();
  await expect(review(page).locator('.payable-title-cheque')).toContainText('Número do cheque: 000719');
  await review(page).getByText('Corrigir título', { exact: true }).click();
  const input = review(page).getByRole('textbox', { name: 'Número do cheque do título', exact: true });
  await expect(input).toHaveValue('000719'); await expect(input).toHaveAttribute('type', 'text');
  const originalFingerprint = title.review_fingerprint;
  await input.fill('000720');
  await review(page).getByRole('textbox', { name: 'Motivo da correção', exact: true }).fill('Número conferido com o cheque original.');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Número do cheque: 000720'); return dialog.accept(); });
  await review(page).getByRole('button', { name: 'Salvar correção do título', exact: true }).click();
  await expect(review(page).getByRole('status').filter({ hasText: /correç|corrigid/i })).toBeVisible();
  const changed = calls.filter(call => call.name === 'correct_payable_title'); expect(changed).toHaveLength(1);
  expect(changed[0].body).toMatchObject({ p_title_id: title.id, p_cheque_number: '000720', p_change_cheque: true,
    p_observation: 'Número conferido com o cheque original.', p_expected_fingerprint: originalFingerprint });
  expect(title.entry_number).toBe('SINT-401'); expect(title.cheque_number).toBe('000720');
  expect(payments[0].cheque_number).toBe('000214');
  await expect(review(page).locator('.payable-title-cheque')).toContainText('000720');
  await expect(review(page)).toContainText('A CONCILIAR'); await expect(closing(page)).toContainText('MÊS ABERTO');
});

test('clearing a cheque is an explicit nullable patch while untouched cheque fields preserve the original API payload', async ({ page }) => {
  const { title, calls } = await setup(page, { chequeNumber: '000719' }); await openReview(page);
  await review(page).getByText('Corrigir título', { exact: true }).click();
  await review(page).getByRole('textbox', { name: 'Número do cheque do título', exact: true }).fill('');
  await review(page).getByRole('textbox', { name: 'Motivo da correção', exact: true }).fill('Retirar número indevido após conferência.');
  page.once('dialog', dialog => dialog.accept());
  await review(page).getByRole('button', { name: 'Salvar correção do título', exact: true }).click();
  await expect(review(page).getByRole('status').filter({ hasText: /correç|corrigid/i })).toBeVisible();
  const changed = calls.filter(call => call.name === 'correct_payable_title'); expect(changed).toHaveLength(1);
  expect(changed[0].body.p_change_cheque).toBe(true); expect(changed[0].body.p_cheque_number).toBeNull();
  expect(title.cheque_number).toBeNull(); expect(title.entry_number).toBe('SINT-401');
});

test('closed Excel exports frozen cheque text from each snapshot and never substitutes the current title or entry number', async ({ page }) => {
  const { title, historicalTitle } = await setup(page, { director: true, reviewed: true, closed: true, historical: true, chequeNumber: '000719' });
  historicalTitle.cheque_number = '000015'; await selectMonth(page);
  title.cheque_number = '999910';
  const pending = page.waitForEvent('download');
  await closing(page).getByRole('button', { name: 'Baixar fechamento em Excel', exact: true }).click();
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await (await pending).path())!);
  for (const [name, cell, expected] of [['Títulos do mês', 'O2', '000113'], ['Versões anteriores', 'O2', '000015'],
    ['Pagamentos dos títulos', 'M2', '000214'], ['Realizados no mês', 'M2', '000315']] as const) {
    const sheet = workbook.getWorksheet(name)!;
    expect(sheet.getRow(1).getCell(sheet.columnCount).value).toBe('Número do cheque');
    expect(sheet.getCell(cell).value).toBe(expected); expect(typeof sheet.getCell(cell).value).toBe('string');
    expect(sheet.getCell(cell).numFmt).toBe('@');
  }
  expect(workbook.getWorksheet('Títulos do mês')?.getCell('B2').value).toBe('SINT-401');
});

test('older closed snapshots without cheque numbers keep blank cheque columns even after the current source is updated', async ({ page }) => {
  const { snapshot, title } = await setup(page, { director: true, reviewed: true, closed: true, chequeNumber: '000719' });
  for (const item of [...snapshot.titles, ...snapshot.payments, ...snapshot.realized.rows]) delete (item as Record<string, unknown>).cheque_number;
  await selectMonth(page); title.cheque_number = '999910';
  const pending = page.waitForEvent('download');
  await closing(page).getByRole('button', { name: 'Baixar fechamento em Excel', exact: true }).click();
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await (await pending).path())!);
  expect(workbook.getWorksheet('Títulos do mês')?.getCell('O2').value || '').toBe('');
  expect(workbook.getWorksheet('Pagamentos dos títulos')?.getCell('M2').value || '').toBe('');
  expect(workbook.getWorksheet('Realizados no mês')?.getCell('M2').value || '').toBe('');
  expect(workbook.getWorksheet('Títulos do mês')?.getCell('B2').value).toBe('SINT-401');
});
