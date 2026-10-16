import { test, expect, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';

test('the complete Director report renders the official sources, prior-month taxes and exact assets without M49', async ({ page }) => {
  await setup(page, { report: 'complete', complete: true, imported: true, receivableImported: true, expanded: true });
  const summary = page.locator('.director-summary');
  await expect(summary.getByText('POSIÇÃO COMPLETA', { exact: true })).toBeVisible();
  await expect(summary.locator('.director-summary-column').nth(0)).toContainText('R$ 1.300,00');
  await expect(summary.locator('.director-summary-column').nth(2)).toContainText('0,024368 mi');
  await expect(summary.locator('.director-summary-column').nth(2)).toContainText('setembro de 2026');
  await summary.getByText('Memória do cálculo do Ativo Circulante', { exact: true }).click();
  await expect(summary.locator('.director-calculation').first()).toContainText('Faturamento geral × 14%');
  await expect(summary.locator('.director-calculation').first()).not.toContainText('M49');
  await expect(summary.locator('.director-cash-detail tbody tr')).toHaveCount(17);
  await expect(summary.locator('.director-cash-detail tbody tr').first()).toContainText('BRADESCO ECOPLAST');
  await page.screenshot({ path: '/tmp/central-diretoria-formula.png', fullPage: true });
});

test('missing stock blocks the assets calculation without becoming zero', async ({ page }) => {
  await setup(page, { report: 'partial', complete: true, imported: true, receivableImported: true, expanded: true });
  const summary = page.locator('.director-summary');
  await expect(summary.locator('.director-summary-column').nth(2)).toContainText('CÁLCULO AGUARDANDO INFORMAÇÕES');
  await expect(summary.locator('.director-summary-column').nth(1)).toContainText('ESTOQUE AGUARDANDO ATUALIZAÇÃO');
  await summary.getByText('Informações pendentes (1)', { exact: true }).click();
  await expect(summary.locator('.director-pending')).toContainText('Estoque aguardando atualização.');
});

test('zero and fractional-cent assets from the official backend remain exact on screen', async ({ page }) => {
  await setup(page, { report: 'zero', complete: true, expanded: true });
  await expect(page.locator('.director-summary-column').nth(2)).toContainText('0,00 mi');
  await page.unrouteAll({ behavior: 'wait' });
  await setup(page, { report: 'tiny', complete: true, expanded: true });
  await expect(page.locator('.director-summary-column').nth(2)).toContainText('−0,0000000014 mi');
});

test('the daily Excel reproduces the description rows and 17 accounts with numeric amounts', async ({ page }) => {
  await setup(page, { report: 'complete', complete: true, imported: true, receivableImported: true, expanded: true });
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar Excel', exact: true }).click();
  const download = await pending; const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await download.path())!);
  const daily = workbook.getWorksheet('Posição diária')!;
  expect(daily.getCell('B1').value).toBeInstanceOf(Date);
  expect(daily.getCell('B4').value).toBe(1300);
  expect(daily.getCell('B8').value).toBe(20000);
  expect(daily.getCell('B13').value).toBe(20000);
  expect(daily.getCell('B17').value).toBe(70);
  expect(daily.getCell('B18').value).toBe(0.024368);
  expect(daily.getCell('B18').numFmt).toContain('mi');
  expect(daily.getCell('A20').value).toBe('BRADESCO ECOPLAST');
  expect(daily.getCell('A36').value).toBe('CAIXA EASY CLEAN');
  expect(daily.getCell('B37').value).toBe(1700);
  const memory = workbook.getWorksheet('Memória do cálculo')!;
  expect(memory.getCell('B9').value).toBe(0.024368);
  expect(memory.getCell('B10').value).not.toContain('M49');
});

test('the assets result that exceeds Excel precision is refused explicitly', async ({ page }) => {
  await setup(page, { report: 'huge', complete: true, expanded: true });
  await page.getByRole('button', { name: 'Baixar Excel', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('excede os 15 algarismos do Excel');
});

test('a failed complete report keeps the core modules and blocks saving an uncertain position', async ({ page }) => {
  await setup(page, { report: 'fail', complete: true, imported: true, receivableImported: true });
  await expect(page.locator('.director-report-notice')).toContainText('Não foi possível consultar');
  await expect(page.locator('.financial-kpis')).toContainText('R$ 1.234,56');
  await expect(page.getByRole('button', { name: 'Salvar posição', exact: true })).toBeDisabled();
  await expect(page.getByText('private SQL secret trace')).toHaveCount(0);
});

test('new saved positions show the preserved assets result and inputs in history', async ({ page }) => {
  await setup(page, { report: 'complete', complete: true, imported: true, receivableImported: true, expanded: true });
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Posição completa salva');
  await page.getByRole('button', { name: 'Histórico das posições', exact: true }).click();
  await expect(page.locator('.director-history')).toContainText('0,024368 mi');
  await page.locator('.director-history').getByText('Ver indicadores', { exact: true }).click();
  await expect(page.locator('.director-snapshot-details')).toContainText('R$ 1.300,00');
  await expect(page.locator('.director-snapshot-details')).toContainText('BANCO CORA ECO PLAST');
});

test('a manager without specific Director write permission is kept in read-only summary mode', async ({ page }) => {
  const { calls } = await setup(page, { report: 'complete', complete: true, noDirectorWrite: true });
  await expect(page.getByRole('button', { name: 'Salvar posição', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Informar posição da Diretoria →', exact: true })).toHaveCount(0);
  expect(calls.some(call => call.name === 'save_director_position')).toBe(false);
});

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const fixedTime = new Date('2026-10-15T15:00:00Z');
const accountNames = [['F2G', 'Bradesco'], ['EASY CLEAN', 'Bradesco'], ['EASY CLEAN', 'Banco do Brasil'], ['FAST CLEAN', 'Bradesco'], ['FAST CLEAN', 'Banco do Brasil'], ['ECOPLAST', 'Bradesco'], ['ECOPLAST', 'Banco do Brasil'], ['GAMMA', 'Bradesco'], ['LIMPE FÁCIL', 'Bradesco'], ['LIMPE FÁCIL', 'Cora'], ['MY CLEAN', 'Cora']];
const stamp = '2026-10-15T12:00:00Z';
function cashFixture(complete = false, expanded = false) {
  const bankNames = ['BRADESCO F2G', 'BRADESCO EASY CLEAN', 'BANCO DO BRASIL EASY CLEAN', 'BRADESCO FAST CLEAN', 'BANCO DO BRASIL FAST CLEAN', 'BRADESCO ECOPLAST', 'BANCO DO BRASIL ECOPLAST', 'BRADESCO GAMMA IND', 'BRADESCO LIMPE FACIL', 'BANCO CORA LIMPE FACIL', 'BANCO CORA MY CLEAN'];
  const roster: { company: string; bank: string; account_label: string; account_type?: 'BANK' | 'CASH'; display_name?: string }[] = accountNames.map(([company, bank], index) => ({ company, bank, account_label: '', ...(expanded ? { account_type: 'BANK' as const, display_name: bankNames[index] } : {}) }));
  if (expanded) roster.push({ company: 'ECOPLAST', bank: 'Cora', account_label: '', account_type: 'BANK', display_name: 'BANCO CORA ECO PLAST' }, ...['ECOPLAST', 'LIMPE FÁCIL', 'GAMMA', 'FAST CLEAN', 'EASY CLEAN'].map(company => ({ company, bank: 'Caixa', account_label: 'Caixa da empresa', account_type: 'CASH' as const, display_name: `CAIXA ${company.replace('Á', 'A')}` })));
  return { accounts: roster.map((account, index) => ({ ...account, id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, amount_cents: complete || index === 0 ? 10000 : null, balance_date: complete || index === 0 ? '2026-10-15' : null, updated_at: complete || index === 0 ? stamp : null })), reported_accounts: complete ? roster.length : 1, expected_accounts: roster.length, total_cents: complete ? roster.length * 10000 : null, latest_position_date: '2026-10-15' };
}

function reportFixture(cash: ReturnType<typeof cashFixture>, mode = 'complete') {
  const inputs = { id: '90000000-0000-4000-8000-000000000099', reference_date: '2026-10-15', created_at: stamp, observation: 'Conferência sintética.' };
  const indicators = { turnover_month_cents: 100000, turnover_comlurb_cents: 30000, turnover_cents: 130000, orders_cents: 80000, blocked_orders_cents: 500, pending_orders_cents: 700, receivable_cents: 2000000, receivable_overdue_cents: 750000, receivable_overdue_bps: 3750, receivable_overdue_comlurb_cents: 2000, cash_cents: cash.total_cents, stock_cents: mode === 'partial' ? null : 300000, merchandise_cents: 5000, installments_cents: 3000, previous_month_taxes_cents: 7000, payable_period_cents: 123456, projected_cash_cents: 546544, current_assets_millions: mode === 'partial' ? null : mode === 'zero' ? '0' : mode === 'tiny' ? '-0.0000000014' : mode === 'huge' ? '123456789.123456789' : '0.024368', complete: mode !== 'partial', formula_version: '2026-10-sem-m49' };
  return { as_of_date: '2026-10-15', inputs, indicators, cash, stock: { value_cents: indicators.stock_cents, reference_date: '2026-10-15', source: 'MANUAL' }, missing_sources: mode === 'partial' ? ['Estoque aguardando atualização.'] : [], complete: mode !== 'partial', formula_version: '2026-10-sem-m49' };
}

interface FixtureOptions { role?: 'gerente_geral' | 'diretor' | 'contas_pagar' | 'contas_receber'; imported?: boolean; complete?: boolean; fail?: boolean; failOldWeek?: boolean; receivableImported?: boolean; receivableFailure?: string; expanded?: boolean; negatives?: boolean; panelOnly?: boolean; report?: 'complete' | 'partial' | 'fail' | 'zero' | 'tiny' | 'huge'; noDirectorWrite?: boolean }
async function setup(page: Page, options: FixtureOptions = {}) {
  await page.clock.setFixedTime(fixedTime);
  const role = options.role ?? 'gerente_geral';
  const id = '90000000-0000-4000-8000-000000000001';
  const permissions = options.panelOnly ? [{ resource: 'painel', action: 'read' }] : ['painel', 'caixa', role === 'contas_receber' ? 'contas_receber' : 'contas_pagar', 'importar_bases'].map(resource => ({ resource, action: 'read' }));
  if (['diretor', 'gerente_geral'].includes(role)) permissions.push({ resource: 'resumo_diretoria', action: 'read' });
  if (role === 'gerente_geral') { permissions.push({ resource: 'usuarios', action: 'admin' }, { resource: 'caixa', action: 'write' }); if (!options.noDirectorWrite) permissions.push({ resource: 'resumo_diretoria', action: 'write' }); }
  const access = { profile: { id, username: 'TesteFinanceiro', display_name: 'Pessoa Teste', role_key: role, enabled: true }, permissions, collector_id: null };
  const claims = { sub: id, session_id: '90000000-0000-4000-8000-000000000002', exp: Math.floor(fixedTime.getTime() / 1000) + 3600, iat: Math.floor(fixedTime.getTime() / 1000), role: 'authenticated' };
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-test-only'].join('.');
  const calls: { name: string; body: any }[] = [];
  let cash = cashFixture(options.complete, options.expanded);
  if (options.negatives) { cash.accounts[0].amount_cents = -25000; cash.accounts[1].amount_cents = -5000; cash.accounts[1].balance_date = '2026-10-14'; cash.accounts[1].updated_at = stamp; cash.accounts[2].amount_cents = 100000; cash.accounts[2].balance_date = '2026-10-15'; cash.accounts[2].updated_at = stamp; cash.total_cents = options.complete ? cash.accounts.reduce((total, account) => total + account.amount_cents!, 0) : null; cash.reported_accounts = cash.accounts.filter(account => account.amount_cents !== null).length; }
  let stock = { value_cents: null as number | null, reference_date: null as string | null, source: null as string | null };
  const history: any[] = [];
  await page.route(`${project}/**`, async route => {
    const request = route.request(); const url = new URL(request.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range', 'content-range': '0-0/1' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON();
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json });
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' } });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'fixture@test.invalid', email_confirmed_at: stamp, created_at: stamp, app_metadata: {}, user_metadata: {} });
    const name = url.pathname.split('/').at(-1)!;
    calls.push({ name, body });
    if (name === 'current_access') return reply(access);
    if (name === 'cash_position') {
      if (options.fail) return reply({ message: 'private SQL secret trace' }, 500);
      if (!options.negatives) return reply(cash);
      const accounts = cash.accounts.map(account => account.balance_date && account.balance_date > body.p_as_of ? { ...account, amount_cents: null, balance_date: null, updated_at: null } : account);
      const reported = accounts.filter(account => account.amount_cents !== null); const negative = reported.filter(account => account.amount_cents! < 0);
      return reply({ ...cash, accounts: options.panelOnly ? [] : accounts, reported_accounts: reported.length, total_cents: reported.length === accounts.length ? reported.reduce((sum, account) => sum + account.amount_cents!, 0) : null, negative_accounts_count: negative.length, coverage_required_cents: negative.reduce((sum, account) => sum - account.amount_cents!, 0) });
    }
    if (name === 'current_stock') return reply(stock);
    if (name === 'director_report') {
      if (!options.report) return reply({ code: 'PGRST202' }, 404);
      if (options.report === 'fail') return reply({ message: 'private SQL secret trace' }, 503);
      return reply(reportFixture(cash, options.report));
    }
    if (name === 'payables_summary') return options.failOldWeek && body.p_start === '2026-10-03' ? reply({ message: 'private SQL secret trace' }, 500) : reply({ open_cents: 900000, overdue_cents: 300000, period_cents: 123456, active_count: 20, latest_import_at: options.imported ? stamp : null });
    if (name === 'receivables_summary') return options.receivableFailure ? reply({ code: options.receivableFailure, message: 'private SQL secret trace' }, 404) : reply({ open_cents: 2000000, overdue_cents: 750000, period_cents: 500000, active_count: 30, pending_count: 2, unassigned_count: 3, received_period_cents: 12345, latest_import_at: options.receivableImported ? stamp : null, overdue_bps: 3750, overdue_comlurb_cents: null });
    if (name === 'set_bank_balance') {
      const account = cash.accounts.find(account => account.id === body.p_account_id)!;
      account.amount_cents = body.p_amount_cents; account.balance_date = body.p_balance_date; account.updated_at = stamp;
      return reply(account.id);
    }
    if (name === 'save_manual_stock') { stock = { value_cents: body.p_value_cents, reference_date: body.p_reference_date, source: 'MANUAL' }; return reply('90000000-0000-4000-8000-000000000010'); }
    if (name === 'save_director_position') { history.push({ id: '90000000-0000-4000-8000-000000000011', created_at: stamp, created_by: id, period_start: body.p_start, period_end: body.p_end, indicators: options.report && options.report !== 'fail' ? { ...reportFixture(cash, options.report).indicators, cash_accounts: cash.accounts } : { cash_cents: cash.total_cents, stock_cents: stock.value_cents, payable_period_cents: options.imported ? 123456 : null, complete: false } }); return reply(history[0].id); }
    if (name === 'director_positions') return route.fulfill({ status: 200, headers: { ...headers, 'content-range': history.length ? `0-${history.length - 1}/${history.length}` : '*/0' }, json: history });
    throw new Error(`Unexpected fixture request ${name}`);
  });
  await page.goto('/');
  await page.getByLabel('Usuário', { exact: true }).fill('TesteFinanceiro'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await expect(page.getByText('Carregando indicadores…')).toHaveCount(0);
  return { calls };
}

test('dashboard uses Saturday to Friday and never substitutes missing bases or partial bank balances with zero', async ({ page }) => {
  const { calls } = await setup(page);
  const kpis = page.locator('.financial-kpis');
  await expect(page.getByText('10/10/2026–16/10/2026 · sábado a sexta-feira', { exact: true })).toBeVisible();
  expect(calls.find(call => call.name === 'payables_summary')?.body).toEqual({ p_start: '2026-10-10', p_end: '2026-10-16' });
  await expect(kpis).toContainText('SALDOS AGUARDANDO ATUALIZAÇÃO'); await expect(kpis).toContainText('BASE AGUARDANDO IMPORTAÇÃO');
  await expect(kpis).not.toContainText('R$ 0,00');
  await expect(page.getByText('ESTOQUE AGUARDANDO ATUALIZAÇÃO').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Resumo da Diretoria', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/central-painel-gerencial.png', fullPage: true });
});

test('a complete cash position and imported payables still do not create a projection without receivables', async ({ page }) => {
  await setup(page, { complete: true, imported: true });
  const kpis = page.locator('.financial-kpi');
  await expect(kpis.nth(0)).toContainText('R$ 1.100,00'); await expect(kpis.nth(3)).toContainText('R$ 1.234,56');
  await expect(kpis.nth(1)).toContainText('BASE AGUARDANDO IMPORTAÇÃO');
  await page.getByRole('button', { name: 'Hoje', exact: true }).click();
  await expect(page.locator('.financial-period-caption')).toContainText('15/10/2026–15/10/2026');
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  await expect(page.locator('.financial-period-caption')).toContainText('01/10/2026–31/10/2026');
});

test('changing week clears the previous period if the new period request fails', async ({ page }) => {
  const { calls } = await setup(page, { imported: true, failOldWeek: true });
  await expect(page.locator('.financial-kpis')).toContainText('R$ 1.234,56');
  await page.getByLabel('Semana financeira').selectOption('2026-10-03');
  await expect(page.getByRole('alert')).toContainText('Não foi possível atualizar o painel');
  await expect(page.locator('.financial-kpis')).not.toContainText('R$ 1.234,56');
  await expect(page.getByText('private SQL secret trace')).toHaveCount(0);
  expect(calls.filter(call => call.name === 'payables_summary').at(-1)?.body).toEqual({ p_start: '2026-10-03', p_end: '2026-10-09' });
});

test('director can inspect dashboard and bank balances without financial write controls', async ({ page }) => {
  const { calls } = await setup(page, { role: 'diretor' });
  await expect(page.getByRole('button', { name: 'Salvar posição', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Histórico das posições', exact: true }).click();
  await expect(page.getByText('Nenhuma posição salva.')).toBeVisible();
  await page.getByRole('button', { name: 'Abrir Caixa →', exact: true }).click();
  await expect(page.getByText('Carregando posição financeira…')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Registrar saldo de conta', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Salvar estoque manual', exact: true })).toHaveCount(0);
  await expect(page.getByText('1 de 11 contas com saldo informado')).toBeVisible();
  expect(calls.some(call => call.name === 'set_bank_balance')).toBe(false);
});

test('CP viewer has dashboard metrics but no official director summary', async ({ page }) => {
  await setup(page, { role: 'contas_pagar', imported: true });
  await expect(page.locator('.financial-kpis')).toContainText('R$ 1.234,56');
  await expect(page.getByRole('heading', { name: 'Resumo da Diretoria', exact: true })).toHaveCount(0);
});

test('CR viewer is not offered navigation into an unauthorized CP module', async ({ page }) => {
  await setup(page, { role: 'contas_receber', imported: true });
  await expect(page.locator('.financial-kpis')).toContainText('R$ 1.234,56');
  await expect(page.getByRole('button', { name: 'Consultar Contas a Pagar →', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Abrir Caixa →', exact: true })).toBeVisible();
});

test('manager records exact negative cents only after confirmation and sends the observed row revision', async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByRole('button', { name: 'Abrir Caixa →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Registrar saldo de conta', exact: true })).toBeVisible();
  await page.getByLabel('Saldo (R$)', { exact: true }).fill('-1.234,56');
  await page.getByLabel('Observação do saldo', { exact: true }).fill('Conferido no extrato oficial.');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Registrar saldo', exact: true }).click();
  expect(calls.some(call => call.name === 'set_bank_balance')).toBe(false);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Registrar saldo', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saldo registrado com histórico e auditoria.' })).toBeVisible();
  expect(calls.find(call => call.name === 'set_bank_balance')?.body).toEqual({ p_account_id: '10000000-0000-4000-8000-000000000001', p_balance_date: '2026-10-15', p_amount_cents: -123456, p_observation: 'Conferido no extrato oficial.', p_expected_updated_at: stamp });
  await page.screenshot({ path: '/tmp/central-caixa-bancos.png', fullPage: true });
});

test('manual stock accepts explicit zero and rejects rounding extra decimal places', async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByRole('button', { name: 'Abrir Caixa →', exact: true }).click();
  await page.getByLabel('Valor do estoque (R$)', { exact: true }).fill('1,234');
  await page.getByLabel('Observação do estoque', { exact: true }).fill('Posição de contingência validada.');
  await page.getByRole('button', { name: 'Salvar estoque manual', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Use até duas casas decimais');
  expect(calls.some(call => call.name === 'save_manual_stock')).toBe(false);
  await page.getByLabel('Valor do estoque (R$)', { exact: true }).fill('0,00');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar estoque manual', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Estoque manual registrado' })).toBeVisible();
  expect(calls.find(call => call.name === 'save_manual_stock')?.body.p_value_cents).toBe(0);
  await expect(page.locator('.treasury-kpis').nth(0)).toContainText('R$ 0,00');
  await expect(page.locator('.treasury-kpis').nth(0)).toContainText('MANUAL · Referência 15/10/2026');
});

test('bank values preserve each cent up to the safe integer limit without display rounding', async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByRole('button', { name: 'Abrir Caixa →', exact: true }).click();
  await page.getByLabel('Saldo (R$)', { exact: true }).fill('90071992547409,91');
  await page.getByLabel('Observação do saldo', { exact: true }).fill('Teste sintético de precisão de centavos.');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Registrar saldo', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saldo registrado' })).toBeVisible();
  expect(calls.find(call => call.name === 'set_bank_balance')?.body.p_amount_cents).toBe(Number.MAX_SAFE_INTEGER);
  await expect(page.locator('.bank-company').filter({ has: page.getByRole('heading', { name: 'F2G', exact: true }) })).toContainText('R$ 90.071.992.547.409,91');
});

test('snapshot persists the selected period and is visible in paginated history', async ({ page }) => {
  const { calls } = await setup(page, { imported: true });
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Posição parcial salva');
  expect(calls.find(call => call.name === 'save_director_position')?.body).toEqual({ p_start: '2026-10-10', p_end: '2026-10-16' });
  await page.getByRole('button', { name: 'Histórico das posições', exact: true }).click();
  await expect(page.locator('.director-history')).toContainText('R$ 1.234,56');
  await expect(page.locator('.director-history')).toContainText('Parcial');
  await expect(page.locator('.director-history')).toContainText('SALDOS AGUARDANDO ATUALIZAÇÃO');
});

test('export contains native Excel dates and numeric currency while missing balances stay explicit', async ({ page }) => {
  await setup(page, { complete: true, imported: true });
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar Excel', exact: true }).click();
  const download = await downloadPromise; const path = await download.path();
  expect(download.suggestedFilename()).toBe('Resumo_Diretoria_2026-10-10_2026-10-16.xlsx');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path!);
  const summary = workbook.getWorksheet('Resumo da Diretoria')!;
  expect(summary.getCell('C2').value).toBeInstanceOf(Date);
  const rows: any[] = []; summary.eachRow(row => rows.push({ indicator: row.getCell(2).value, value: row.getCell(3).value }));
  expect(rows.find(row => row.indicator === 'Caixa total')?.value).toBe(1100);
  expect(rows.find(row => row.indicator === 'Contas a pagar na semana')?.value).toBe(1234.56);
  expect(rows.find(row => row.indicator === 'Estoque total')?.value).toBe('ESTOQUE AGUARDANDO ATUALIZAÇÃO');
  expect(rows.find(row => row.indicator === 'Contas a receber total')?.value).toBe('BASE AGUARDANDO IMPORTAÇÃO');
});

test('Excel export refuses values beyond its numeric precision instead of silently rounding cents', async ({ page }) => {
  await setup(page);
  let downloads = 0; page.on('download', () => { downloads += 1; });
  // A magnitude negativa e o zero final positivo não podem contornar a proteção.
  for (const amount of ['-90071992547409,91', '90071992547409,90']) {
    await page.getByRole('button', { name: 'Abrir Caixa →', exact: true }).click();
    await page.getByLabel('Saldo (R$)', { exact: true }).fill(amount);
    await page.getByLabel('Observação do saldo', { exact: true }).fill('Teste sintético de limite de precisão do Excel.');
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Registrar saldo', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saldo registrado' })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Painel Gerencial', exact: true }).click();
    await page.getByRole('button', { name: 'Baixar Excel', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('até 15 algarismos significativos');
    await expect(page.getByRole('alert')).toContainText('interrompida para evitar arredondamento');
    expect(downloads).toBe(0);
    await expect(page.getByRole('button', { name: 'Baixar Excel', exact: true })).toBeEnabled();
  }
});

test('treasury backend failures show friendly feedback and no stale bank values', async ({ page }) => {
  await setup(page, { fail: true });
  await page.getByRole('navigation').getByRole('button', { name: 'Caixa / Bancos', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível carregar a posição de caixa');
  await expect(page.getByText('private SQL secret trace')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Registrar saldo', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test('receivables summary fills actual projection and validated daily receipts without exposing rows to CP', async ({ page }) => {
  const { calls } = await setup(page, { role: 'contas_pagar', complete: true, imported: true, receivableImported: true });
  await expect(page.locator('.financial-kpi').nth(1)).toContainText('R$ 4.865,44');
  await expect(page.locator('.financial-kpi').nth(2)).toContainText('R$ 5.000,00');
  await expect(page.locator('.attention-card')).toContainText('R$ 7.500,00');
  await expect(page.locator('.financial-module-grid')).toContainText('R$ 123,45');
  await expect(page.getByText('Projeção por vencimento. Inclui títulos sem recebimento validado; não representa dinheiro disponível em conta.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Consultar Contas a Receber →', exact: true })).toHaveCount(0);
  expect(calls.some(call => call.name === 'receivable_titles')).toBe(false);
});

test('unavailable receivables activation preserves the working cash and payable indicators', async ({ page }) => {
  await setup(page, { complete: true, imported: true, receivableFailure: 'PGRST202' });
  await expect(page.getByRole('status')).toContainText('Contas a Receber aguardando ativação');
  await expect(page.locator('.financial-kpi').nth(0)).toContainText('R$ 1.100,00');
  await expect(page.locator('.financial-kpi').nth(3)).toContainText('R$ 1.234,56');
  await expect(page.locator('.financial-kpi').nth(1)).toContainText('BASE AGUARDANDO IMPORTAÇÃO');
  await expect(page.getByText('private SQL secret trace')).toHaveCount(0);
});

test('director export writes actual overdue percentage as numeric percentage instead of money', async ({ page }) => {
  await setup(page, { role: 'diretor', complete: true, imported: true, receivableImported: true });
  await expect(page.locator('.director-summary-column')).toContainText(['COMERCIAL', '37,50%', 'OBRIGAÇÕES']);
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar Excel', exact: true }).click();
  const download = await downloadPromise; const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await download.path())!);
  let found = false; workbook.getWorksheet('Resumo da Diretoria')!.eachRow(row => {
    if (row.getCell(2).value === 'Percentual em atraso') { found = true; expect(row.getCell(3).value).toBe(0.375); expect(row.getCell(3).numFmt).toBe('0.00%'); }
  }); expect(found).toBe(true);
});


test('director sees the total of all seventeen bank and company cash accounts and exports their official names', async ({ page }) => {
  const { calls } = await setup(page, { role: 'diretor', complete: true, expanded: true, imported: true, receivableImported: true });
  await expect(page.locator('.financial-kpi').nth(0)).toContainText('R$ 1.700,00');
  await expect(page.locator('.financial-kpi').nth(0)).toContainText('17 contas');
  await expect(page.locator('.financial-kpi').nth(1)).toContainText('R$ 5.465,44');
  const details = page.locator('.director-cash-detail'); await expect(details.locator('tbody tr')).toHaveCount(17);
  await expect(details.getByText('BANCO CORA ECO PLAST', { exact: true })).toBeVisible();
  await expect(details.getByText('BRADESCO GAMMA IND', { exact: true })).toBeVisible();
  for (const company of ['ECOPLAST', 'LIMPE FACIL', 'GAMMA', 'FAST CLEAN', 'EASY CLEAN']) await expect(details.getByText(`CAIXA ${company}`, { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar Excel', exact: true }).click();
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await (await downloadPromise).path())!);
  const sheet = workbook.getWorksheet('Caixa por empresa e banco')!; expect(sheet.rowCount).toBe(18);
  const rows: any[] = []; sheet.eachRow((row, index) => { if (index > 1) rows.push({ name: row.getCell(3).value, kind: row.getCell(4).value, date: row.getCell(5).value, amount: row.getCell(6).value, moneyFormat: row.getCell(6).numFmt }); });
  expect(rows.filter(row => row.kind === 'Caixa da empresa')).toHaveLength(5); expect(rows.filter(row => row.kind === 'Conta bancária')).toHaveLength(12);
  expect(rows.find(row => row.name === 'BANCO CORA ECO PLAST')?.amount).toBe(100);
  for (const row of rows) { expect(row.date).toBeInstanceOf(Date); expect(row.amount).toBe(100); expect(row.moneyFormat).toContain('0.00'); }
  await page.getByRole('button', { name: 'Abrir Caixa →', exact: true }).click();
  await expect(page.getByText('17 de 17 contas com saldo informado')).toBeVisible();
  await expect(page.locator('.bank-company tbody tr')).toHaveCount(17);
  await expect(page.locator('.bank-company').filter({ has: page.getByRole('heading', { name: 'ECOPLAST', exact: true }) })).toContainText('Subtotal: R$ 400,00');
  await expect(page.getByRole('heading', { name: 'Registrar saldo de conta', exact: true })).toHaveCount(0);
  expect(calls.some(call => call.name === 'set_bank_balance' || call.name === 'save_bank_position')).toBe(false);
});

test('manager can select and correct a company cash balance using its existing account id and revision', async ({ page }) => {
  const { calls } = await setup(page, { complete: true, expanded: true });
  await page.getByRole('button', { name: 'Abrir Caixa →', exact: true }).click();
  await page.getByLabel('Conta / Caixa', { exact: true }).selectOption({ label: 'CAIXA ECOPLAST' });
  await page.getByLabel('Saldo (R$)', { exact: true }).fill('250,01');
  await page.getByLabel('Observação do saldo', { exact: true }).fill('Conferência física do caixa da empresa.');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Registrar saldo', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saldo registrado' })).toBeVisible();
  expect(calls.find(call => call.name === 'set_bank_balance')?.body).toEqual({ p_account_id: '10000000-0000-4000-8000-000000000013', p_balance_date: '2026-10-15', p_amount_cents: 25001, p_observation: 'Conferência física do caixa da empresa.', p_expected_updated_at: stamp });
});


test('negative account coverage remains urgent despite positive consolidated cash and identifies previous-day records', async ({ page }) => {
  await setup(page, { role: 'diretor', complete: true, expanded: true, negatives: true });
  await expect(page.locator('.financial-kpi').nth(0)).toContainText('R$ 2.100,00');
  const attention = page.locator('.cash-coverage-attention');
  await expect(attention).toContainText('Contas negativas — cobrir hoje');
  await expect(attention).toContainText('2 conta(s)'); await expect(attention).toContainText('R$ 300,00');
  await expect(attention).toContainText('Registro anterior: confira e atualize hoje');
  await attention.getByRole('button', { name: 'Ver contas negativas →', exact: true }).click();
  const alert = page.locator('.cash-coverage-alert');
  await expect(alert.getByRole('heading', { name: 'Contas negativas — cobrir hoje', exact: true })).toBeVisible();
  await expect(alert).toContainText('R$ 300,00'); await expect(alert).toContainText('Saldos positivos de outras contas não reduzem este alerta.');
  await expect(alert).toContainText('BRADESCO F2G'); await expect(alert).toContainText('BRADESCO EASY CLEAN');
  await expect(alert).toContainText('Registro anterior: confira e atualize hoje · 14/10/2026');
  await page.getByLabel('Data da posição', { exact: true }).fill('2026-10-14');
  await expect(alert.getByRole('heading', { name: 'Cobertura na data consultada', exact: true })).toBeVisible();
  await expect(alert).toContainText('R$ 50,00'); await expect(alert).toContainText('1 conta(s)');
  await expect(alert).not.toContainText('cobrir hoje');
});

test('known negatives still request coverage while the consolidated position is incomplete', async ({ page }) => {
  await setup(page, { role: 'diretor', expanded: true, negatives: true });
  await expect(page.locator('.financial-kpi').nth(0)).toContainText('SALDOS AGUARDANDO ATUALIZAÇÃO');
  await expect(page.locator('.cash-coverage-attention')).toContainText('R$ 300,00');
  await expect(page.locator('.cash-coverage-attention')).toContainText('Posição incompleta');
  await page.getByRole('button', { name: 'Abrir Caixa →', exact: true }).click();
  await expect(page.locator('.cash-coverage-alert')).toContainText('o alerta considera os saldos negativos já informados');

});


test('aggregate-only dashboard access never claims that hidden negative account balances were updated today', async ({ page }) => {
  await setup(page, { role: 'contas_pagar', expanded: true, complete: true, negatives: true, panelOnly: true });
  const attention = page.locator('.cash-coverage-attention');
  await expect(attention).toContainText('2 conta(s)'); await expect(attention).toContainText('R$ 300,00');
  await expect(attention).toContainText('Confira e atualize as posições de hoje');
  await expect(attention).not.toContainText('Saldos informados hoje');
  await expect(page.getByRole('button', { name: 'Ver contas negativas →', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Abrir Caixa →', exact: true })).toHaveCount(0);
  await expect(page.getByText('BRADESCO F2G', { exact: true })).toHaveCount(0);
  await expect(page.getByText('BRADESCO EASY CLEAN', { exact: true })).toHaveCount(0);
});
