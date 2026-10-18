import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const fixedTime = new Date('2026-10-18T15:00:00Z');
const today = '2026-10-18';
const uuid = (n: number) => `85000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const macros = ['FIXO', 'IMPOSTO', 'SALÁRIOS', 'ADIANTAMENTO', 'VALE TRANSPORTE', 'VARIÁVEL', 'BÔNUS / COMISSÕES', 'FRETE', 'OUTROS IMPOSTOS', 'CONSÓRCIOS', 'REEMBOLSO - GABRIEL', 'FREELANCER - COMERCIAL', 'PREJUÍZOS', 'COMPRA DE MERCADORIA'];
interface Options { director?: boolean; noBase?: boolean; missing?: boolean; failure?: boolean; unsafe?: boolean }
function shifted(value: string, days: number) { return new Date(Date.parse(`${value}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10); }
function weekFor(value: string) { const day = new Date(`${value}T12:00:00Z`).getUTCDay(); const start = shifted(value, -((day + 1) % 7)); return { start, end: shifted(start, 6) }; }
async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(fixedTime);
  const userId = uuid(1), role = options.director ? 'diretor' : 'contas_pagar';
  const permissions = ['painel', 'caixa', 'contas_pagar', 'importar_bases'].map(resource => ({ resource, action: 'read' }));
  if (!options.director) permissions.push({ resource: 'contas_pagar', action: 'write' }, { resource: 'contas_pagar', action: 'import' });
  const access = { profile: { id: userId, username: 'FinanceiroResumoSintetico', display_name: 'Pessoa Sintética', role_key: role, enabled: true }, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, session_id: uuid(2), exp: Math.floor(fixedTime.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const title = (n: number, due: string, amount: number, paid: number, description: string, sourceStatus = 'ABERTO') => ({
    id: uuid(10 + n), scope: 'grupo-consolidado', source_key: `synthetic-overview-${n}`, entry_number: `RES-${n}`,
    description, branch: '3 - FILIAL SINTÉTICA', due_date: due, issued_on: '2026-09-01', amount_cents: amount,
    paid_cents: paid, outstanding_cents: n === 4 ? 0 : amount - paid, payment_remaining_cents: amount - paid, overpaid_cents: 0,
    source_status: sourceStatus, plan: 'PLANO SINTÉTICO', bank_account: 'Banco da base sintética', macro: 'FIXO',
    status: n === 4 || n === 5 || n === 7 || n === 8 ? 'SETTLED_IMPORT' : 'OPEN', settled_at: n === 4 || n === 5 || n === 7 || n === 8 ? fixedTime.toISOString() : null,
    financial_status: paid === amount ? 'PAID' : n === 4 ? 'PENDING_RECONCILIATION' : 'OPEN',
    last_import_id: uuid(3), payment_revision: paid ? uuid(40 + n) : null,
    review_status: paid === amount ? 'CONCILIADO' : 'A_CONCILIAR', review_id: paid ? uuid(50 + n) : null,
    reviewed_at: paid ? fixedTime.toISOString() : null, reviewed_by: paid ? userId : null,
    review_fingerprint: String(n).padStart(64, '0'), closing_eligible: true, closing_exclusion_reason: null,
    cheque_number: n === 1 ? '000070' : null,
  });
  const titles = options.noBase ? [] : [
    title(1, '2026-10-20', 1000, 0, 'Cheque sintético previsto na semana', 'CHEQUE'),
    title(2, '2026-10-21', 3000, 0, 'Obrigação sintética em aberto na semana'),
    title(3, '2026-10-22', 6000, 6000, 'Obrigação sintética já paga da semana'),
    title(4, '2026-10-01', 2500, 0, 'Obrigação sintética ausente aguardando conciliação'),
    title(5, '2026-09-30', 1000, 1000, 'Título sintético de outra semana pago nesta semana'),
    title(6, '2027-02-05', 5000, 0, 'Obrigação sintética além de oito semanas'),
    { ...title(7, '2026-09-15', 2000, 2000, 'Pagamento sintético do mês fora da semana atual'), macro: 'VARIÁVEL' },
    title(8, '2026-09-20', 500, 500, 'Pagamento sintético fixo no mesmo período'),
  ];
  const payments = options.noBase ? [] : [
    { id: uuid(43), title_id: uuid(13), entry_number: 'RES-3', description: 'Obrigação sintética já paga da semana', branch: '3 - FILIAL SINTÉTICA', macro_snapshot: 'FIXO', effective_macro: 'FIXO', amount_cents: 6000, paid_on: '2026-10-18', bank_label: 'Conta sintética', created_at: fixedTime.toISOString(), created_by: userId, cancelled_at: null, observation: 'Comprovante sintético' },
    { id: uuid(45), title_id: uuid(15), entry_number: 'RES-5', description: 'Título sintético de outra semana pago nesta semana', branch: '3 - FILIAL SINTÉTICA', macro_snapshot: 'FIXO', effective_macro: 'FIXO', amount_cents: 1000, paid_on: '2026-10-17', bank_label: 'Conta sintética', created_at: fixedTime.toISOString(), created_by: userId, cancelled_at: null, observation: 'Comprovante sintético' },
    { id: uuid(47), title_id: uuid(17), entry_number: 'RES-7', description: 'Pagamento sintético do mês fora da semana atual', branch: '3 - FILIAL SINTÉTICA', macro_snapshot: 'VARIÁVEL', effective_macro: 'VARIÁVEL', amount_cents: 2000, paid_on: '2026-10-05', bank_label: 'Conta sintética', created_at: fixedTime.toISOString(), created_by: userId, cancelled_at: null, observation: 'Comprovante sintético' },
    { id: uuid(48), title_id: uuid(18), entry_number: 'RES-8', description: 'Pagamento sintético fixo no mesmo período', branch: '3 - FILIAL SINTÉTICA', macro_snapshot: 'FIXO', effective_macro: 'FIXO', amount_cents: 500, paid_on: '2026-10-04', bank_label: 'Conta sintética', created_at: fixedTime.toISOString(), created_by: userId, cancelled_at: null, observation: 'Comprovante sintético' },
  ];
  const sum = (items: any[], key: string) => items.reduce((total, item) => total + item[key], 0);
  const revision = { import_id: options.noBase ? null : uuid(3), financial_revision: '2:1' };
  function summary(input: string | null, monthInput: string | null = '2026-10-01') {
    const week = weekFor(input || today), due = titles.filter(t => t.due_date >= week.start && t.due_date <= week.end), actual = payments.filter(p => p.paid_on >= week.start && p.paid_on <= week.end);
    const future = titles.filter(t => t.due_date >= today && t.payment_remaining_cents > 0), overdue = titles.filter(t => t.due_date < today && t.payment_remaining_cents > 0), cheques = due.filter(t => t.source_status === 'CHEQUE' && t.payment_remaining_cents > 0);
    const selectedMonth = (monthInput || '2026-10-01').slice(0, 7);
    const monthStart = `${selectedMonth}-01`; const [year, monthNumber] = selectedMonth.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(year, monthNumber, 0, 12)).toISOString().slice(0, 10);
    const monthly = payments.filter(p => p.paid_on >= monthStart && p.paid_on <= monthEnd);
    const value = (amount: number) => options.noBase ? null : amount;
    return { as_of_date: today, month_start: monthStart, month_end: monthEnd, monthly_paid_cents: value(sum(monthly, 'amount_cents')), monthly_paid_count: value(monthly.length), week_start: week.start, week_end: week.end, latest_import_id: revision.import_id, latest_import_at: options.noBase ? null : fixedTime.toISOString(),
      planned_week_cents: value(options.unsafe ? Number.MAX_SAFE_INTEGER + 1 : sum(due, 'amount_cents')), paid_week_cents: value(sum(actual, 'amount_cents')), difference_week_cents: value(sum(due, 'amount_cents') - sum(actual, 'amount_cents')),
      open_week_cents: value(sum(due, 'payment_remaining_cents')), future_cents: value(sum(future, 'payment_remaining_cents')), overdue_cents: value(sum(overdue, 'payment_remaining_cents')),
      week_title_count: value(due.length), future_title_count: value(future.length), cheques_week_cents: value(sum(cheques, 'payment_remaining_cents')), cheques_week_count: value(cheques.length), pending_reconciliation_count: value(titles.filter(t => t.financial_status === 'PENDING_RECONCILIATION').length),
      by_macro: macros.map(macro => { const group = due.filter(t => t.macro === macro), paid = actual.filter(t => t.effective_macro === macro), coming = future.filter(t => t.macro === macro), late = overdue.filter(t => t.macro === macro); return { macro,
        planned_cents: value(sum(group, 'amount_cents')), paid_cents: value(sum(paid, 'amount_cents')), difference_cents: value(sum(group, 'amount_cents') - sum(paid, 'amount_cents')), open_week_cents: value(sum(group, 'payment_remaining_cents')),
        future_cents: value(sum(coming, 'payment_remaining_cents')), overdue_cents: value(sum(late, 'payment_remaining_cents')), week_title_count: value(group.length), future_title_count: value(coming.length) }; }), missing_sources: options.noBase ? ['contas_pagar'] : [], };
  }
  const calls: { name: string; body: any; query: string; method: string }[] = [];
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON(); calls.push({ name, body, query: url.search, method: request.method() });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600 } });
    if (url.pathname === '/auth/v1/user') return reply({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@test.invalid', created_at: fixedTime.toISOString(), app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'current_access') return reply(access);
    if (name === 'payables_management_summary') {
      if (options.missing) return reply({ code: 'PGRST202', message: 'private SQL query secret' }, 404);
      if (options.failure) return reply({ code: 'XX000', message: 'private SQL query secret' }, 503);
      return reply(summary(body.p_week, body.p_month));
    }
    if (['director_report', 'payables_forecast', 'payables_month_status', 'list_payable_month_closures'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'cash_position') return reply({ accounts: [], total_cents: null, expected_accounts: 17, reported_accounts: 0, latest_position_date: null });
    if (name === 'current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (name === 'payables_summary') return reply({ open_cents: 9000, overdue_cents: 0, period_cents: 4000, active_count: 3, latest_import_at: options.noBase ? null : fixedTime.toISOString() });
    if (name === 'receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null, received_period_cents: 0, overdue_bps: null });
    if (name === 'director_positions' || name === 'payable_plan_mappings') return reply([], 200, 0);
    if (name === 'payable_macros') return reply(macros.map(name => ({ name })), 200, macros.length);
    if (name === 'payable_imports') return reply(options.noBase ? [] : [{ id: uuid(3), created_at: fixedTime.toISOString() }], 200, options.noBase ? 0 : 1);
    if (name === 'get_payables_revision') return reply(revision);
    if (['payable_titles', 'payable_financial_titles', 'payable_review_titles'].includes(name)) {
      let selected = titles.slice();
      for (const [key, expression] of url.searchParams) {
        if (expression.startsWith('eq.') && key in (titles[0] || {})) selected = selected.filter(item => String((item as any)[key]) === expression.slice(3));
        if (expression.startsWith('gte.') && key === 'due_date') selected = selected.filter(item => item.due_date >= expression.slice(4));
        if (expression.startsWith('lte.') && key === 'due_date') selected = selected.filter(item => item.due_date <= expression.slice(4));
        if (expression.startsWith('gt.') && ['payment_remaining_cents', 'outstanding_cents'].includes(key)) selected = selected.filter(item => (item as any)[key] > Number(expression.slice(3)));
      }
      return reply(url.searchParams.has('id') ? selected[0] ?? null : selected, 200, selected.length);
    }
    if (name === 'get_payable_payment_accounts') return reply([{ id: uuid(100), display_name: 'Conta sintética', company: 'Empresa sintética', bank: 'Banco sintético', account_label: 'Conta', account_type: 'BANK' }]);
    if (name === 'payable_payment_summary') {
      const selected = payments.filter(p => p.paid_on >= body.p_start && p.paid_on <= body.p_end);
      return reply({ total_paid_cents: sum(selected, 'amount_cents'), payment_count: selected.length, by_macro: macros.map(macro => ({ macro, amount_cents: sum(selected.filter(p => p.effective_macro === macro), 'amount_cents'), count: selected.filter(p => p.effective_macro === macro).length })), pending_reconciliation_count: 1, revision });
    }
    if (name === 'list_payable_payments') {
      const selected = payments.filter(p => (body.p_title_id ? p.title_id === body.p_title_id : p.paid_on >= body.p_start && p.paid_on <= body.p_end) && (!body.p_macro || p.effective_macro === body.p_macro));
      return reply({ rows: selected, count: selected.length, revision });
    }
    throw new Error(`Unexpected overview request ${request.method()} ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('FinanceiroResumoSintetico'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click(); await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Contas a Pagar', exact: true }).click();
  return { calls, options, summary };
}
const overview = (page: Page) => page.locator('.payables-overview');
const card = (page: Page, name: string) => overview(page).locator('.payables-overview-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
const noWrites = (calls: { name: string }[]) => expect(calls.some(call => /^(commit_|register_|correct_|review_|close_|reopen_|cancel_)/.test(call.name))).toBe(false);

test('CP opens an executive summary first with fourteen macros, actual dates and cheques included only once', async ({ page }) => {
  const { calls } = await setup(page);
  await expect(overview(page).getByRole('heading', { name: 'Resumo de Contas a Pagar', exact: true })).toBeVisible();
  await expect(card(page, 'Previsto na semana')).toContainText(/R\$\s*100,00/);
  await expect(card(page, 'Realizado na semana')).toContainText(/R\$\s*70,00/);
  await expect(card(page, 'Saldo a pagar na semana')).toContainText(/R\$\s*40,00/);
  await expect(card(page, 'Total a vencer')).toContainText(/R\$\s*90,00/);
  await expect(overview(page)).toContainText('17/10/2026 a 23/10/2026 · sábado a sexta-feira');
  await expect(overview(page)).toContainText('subtotal já incluído no saldo a pagar da semana');
  await expect(overview(page).locator('tbody tr')).toHaveCount(14);
  await expect(page.getByRole('heading', { name: 'Lançamentos de Contas a Pagar', exact: true })).toHaveCount(0);
  expect(calls.find(call => call.name === 'payables_management_summary')?.body).toEqual({ p_week: '2026-10-17', p_month: '2026-10-01' });
  noWrites(calls);
});

test('week selection normalizes Saturday through Friday and future outstanding remains global', async ({ page }) => {
  const { calls } = await setup(page);
  await expect(card(page, 'Total a vencer')).toContainText(/R\$\s*90,00/);
  await overview(page).getByLabel('Semana financeira', { exact: true }).fill('2026-10-25');
  await overview(page).getByRole('button', { name: 'Consultar semana', exact: true }).click();
  await expect(overview(page)).toContainText('24/10/2026 a 30/10/2026 · sábado a sexta-feira');
  await expect(card(page, 'Previsto na semana')).toContainText(/R\$\s*0,00/);
  await expect(card(page, 'Total a vencer')).toContainText(/R\$\s*90,00/);
  expect(calls.filter(call => call.name === 'payables_management_summary').at(-1)?.body.p_week).toBe('2026-10-24');
  await overview(page).getByRole('button', { name: 'Semana atual', exact: true }).click();
  await expect(card(page, 'Previsto na semana')).toContainText(/R\$\s*100,00/); noWrites(calls);
});

test('all future detail includes obligations beyond eight weeks and filters remaining canonical balances', async ({ page }) => {
  const { calls } = await setup(page);
  await card(page, 'Total a vencer').getByRole('button', { name: 'Ver todos a vencer →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lançamentos de Contas a Pagar', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Obrigação sintética além de oito semanas', exact: true })).toBeVisible();
  const query = new URLSearchParams(calls.filter(call => ['payable_review_titles', 'payable_financial_titles'].includes(call.name)).at(-1)?.query);
  expect(query.getAll('due_date')).toContain('gte.2026-10-18'); expect(query.getAll('due_date').some(value => value.startsWith('lte.'))).toBe(false);
  expect(query.get('payment_remaining_cents')).toBe('gt.0'); expect(query.get('closing_eligible')).toBe('eq.true');
  noWrites(calls);
});

test('Director can drill down by macro without receiving write controls', async ({ page }) => {
  const { calls } = await setup(page, { director: true });
  await overview(page).getByRole('button', { name: 'Abrir títulos da semana do macro FIXO', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Cheque sintético previsto na semana', exact: true })).toBeVisible();
  const query = new URLSearchParams(calls.filter(call => call.name === 'payable_review_titles').at(-1)?.query);
  expect(query.get('macro')).toBe('eq.FIXO'); expect(query.getAll('due_date')).toEqual(expect.arrayContaining(['gte.2026-10-17', 'lte.2026-10-23']));
  expect(query.get('closing_eligible')).toBe('eq.true');
  await expect(page.getByRole('button', { name: 'Ir para Importar Bases', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirmar pagamento', exact: true })).toHaveCount(0);
  noWrites(calls);
});

test('actual payment drilldown carries the selected financial week rather than a due-date filter or yesterday', async ({ page }) => {
  const { calls } = await setup(page);
  await card(page, 'Realizado na semana').getByRole('button', { name: 'Ver pagamentos realizados →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pagamentos realizados', exact: true })).toBeVisible();
  await expect.poll(() => calls.filter(call => call.name === 'payable_payment_summary').some(call => call.body.p_start === '2026-10-17' && call.body.p_end === '2026-10-23')).toBe(true);
  await expect(page.getByRole('cell', { name: /Título sintético de outra semana pago nesta semana/ })).toBeVisible(); noWrites(calls);
});

test('missing imported base keeps unknown balances explicit and does not create zero-valued financial cards', async ({ page }) => {
  const { calls } = await setup(page, { noBase: true });
  await expect(overview(page).getByText('Aguardando importação', { exact: true }).first()).toBeVisible();
  await expect(overview(page)).toContainText('A ausência da base não é considerada saldo zero');
  await expect(overview(page).getByText(/R\$\s*0,00/)).toHaveCount(0);
  await expect(card(page, 'Total a vencer').getByRole('button')).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Lançamentos de Contas a Pagar', exact: true })).toHaveCount(0); noWrites(calls);
});

test('a temporary error clears stale totals without silently switching to the operational fallback or exposing SQL', async ({ page }) => {
  const options: Options = {}; const { calls } = await setup(page, options);
  await expect(card(page, 'Total a vencer')).toContainText(/R\$\s*90,00/);
  options.failure = true; await overview(page).getByRole('button', { name: 'Atualizar resumo', exact: true }).click();
  await expect(overview(page).getByRole('alert')).toContainText('Não foi possível consultar o resumo');
  await expect(overview(page).getByText(/R\$\s*90,00/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Lançamentos de Contas a Pagar', exact: true })).toHaveCount(0);
  await expect(page.getByText('private SQL query secret')).toHaveCount(0); noWrites(calls);
});

test('missing summary RPC preserves the working operational module', async ({ page }) => {
  const { calls } = await setup(page, { missing: true });
  await expect(page.getByRole('heading', { name: 'Lançamentos de Contas a Pagar', exact: true })).toBeVisible();
  await expect(page.getByText('private SQL query secret')).toHaveCount(0); noWrites(calls);
});

test('unsafe financial values fail closed instead of being rounded or replaced with zero', async ({ page }) => {
  const { calls } = await setup(page, { unsafe: true });
  await expect(overview(page).getByRole('alert')).toBeVisible();
  await expect(overview(page).getByText(/R\$/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Lançamentos de Contas a Pagar', exact: true })).toHaveCount(0); noWrites(calls);
});


test('the monthly paid card includes actual payments outside the selected week and its month selector stays independent', async ({ page }) => {
  const { calls } = await setup(page);
  await expect(card(page, 'Realizado no mês')).toContainText(/R\$\s*95,00/);
  await expect(card(page, 'Realizado no mês')).toContainText('outubro de 2026');
  await expect(card(page, 'Realizado na semana')).toContainText(/R\$\s*70,00/);
  await overview(page).getByLabel('Mês dos pagamentos', { exact: true }).fill('2026-09');
  await overview(page).getByRole('button', { name: 'Consultar mês', exact: true }).click();
  await expect(card(page, 'Realizado no mês')).toContainText('setembro de 2026');
  await expect(card(page, 'Realizado no mês')).toContainText(/R\$\s*0,00/);
  await expect(card(page, 'Realizado na semana')).toContainText(/R\$\s*70,00/);
  expect(calls.filter(call => call.name === 'payables_management_summary').at(-1)?.body).toEqual({ p_week: '2026-10-17', p_month: '2026-09-01' });
  noWrites(calls);
});

test('monthly payment detail uses the payment month even when the invoice fell due in September', async ({ page }) => {
  const { calls } = await setup(page);
  await card(page, 'Realizado no mês').getByRole('button', { name: 'Ver pagamentos do mês →', exact: true }).click();
  await expect.poll(() => calls.filter(call => call.name === 'list_payable_payments').some(call => call.body.p_start === '2026-10-01' && call.body.p_end === '2026-10-31')).toBe(true);
  await expect(page.getByRole('cell', { name: /Pagamento sintético do mês fora da semana atual/ })).toBeVisible();
  noWrites(calls);
});

test('custom period and macro open actual payment titles without using their due dates or mixing other macros', async ({ page }) => {
  const { calls } = await setup(page);
  await overview(page).getByLabel('Período inicial dos pagamentos', { exact: true }).fill('2026-10-01');
  await overview(page).getByLabel('Período final dos pagamentos', { exact: true }).fill('2026-10-10');
  await overview(page).getByRole('combobox', { name: 'Centro de Custo Macro dos pagamentos', exact: true }).selectOption('VARIÁVEL');
  await overview(page).getByRole('button', { name: 'Consultar pagamentos', exact: true }).click();
  await expect.poll(() => calls.filter(call => call.name === 'list_payable_payments').some(call => call.body.p_start === '2026-10-01' && call.body.p_end === '2026-10-10' && call.body.p_macro === 'VARIÁVEL')).toBe(true);
  await expect(page.getByRole('cell', { name: /Pagamento sintético do mês fora da semana atual/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Pagamento sintético fixo no mesmo período/ })).toHaveCount(0);
  noWrites(calls);
});
