import { test, expect, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const fixedTime = new Date('2026-10-15T15:00:00Z');
const accountNames = [['F2G', 'Bradesco'], ['EASY CLEAN', 'Bradesco'], ['EASY CLEAN', 'Banco do Brasil'], ['FAST CLEAN', 'Bradesco'], ['FAST CLEAN', 'Banco do Brasil'], ['ECOPLAST', 'Bradesco'], ['ECOPLAST', 'Banco do Brasil'], ['GAMMA', 'Bradesco'], ['LIMPE FÁCIL', 'Bradesco'], ['LIMPE FÁCIL', 'Cora'], ['MY CLEAN', 'Cora']];
const stamp = '2026-10-15T12:00:00Z';
function cashFixture(complete = false) {
  return { accounts: accountNames.map(([company, bank], index) => ({ id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, company, bank, account_label: '', amount_cents: complete || index === 0 ? 10000 : null, balance_date: complete || index === 0 ? '2026-10-15' : null, updated_at: complete || index === 0 ? stamp : null })), reported_accounts: complete ? 11 : 1, expected_accounts: 11, total_cents: complete ? 110000 : null, latest_position_date: '2026-10-15' };
}
interface FixtureOptions { role?: 'gerente_geral' | 'diretor' | 'contas_pagar' | 'contas_receber'; imported?: boolean; complete?: boolean; fail?: boolean; failOldWeek?: boolean; receivableImported?: boolean; receivableFailure?: string }
async function setup(page: Page, options: FixtureOptions = {}) {
  await page.clock.setFixedTime(fixedTime);
  const role = options.role ?? 'gerente_geral';
  const id = '90000000-0000-4000-8000-000000000001';
  const permissions = ['painel', 'caixa', role === 'contas_receber' ? 'contas_receber' : 'contas_pagar', 'importar_bases'].map(resource => ({ resource, action: 'read' }));
  if (['diretor', 'gerente_geral'].includes(role)) permissions.push({ resource: 'resumo_diretoria', action: 'read' });
  if (role === 'gerente_geral') permissions.push({ resource: 'usuarios', action: 'admin' }, { resource: 'caixa', action: 'write' });
  const access = { profile: { id, username: 'TesteFinanceiro', display_name: 'Pessoa Teste', role_key: role, enabled: true }, permissions, collector_id: null };
  const claims = { sub: id, session_id: '90000000-0000-4000-8000-000000000002', exp: Math.floor(fixedTime.getTime() / 1000) + 3600, iat: Math.floor(fixedTime.getTime() / 1000), role: 'authenticated' };
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-test-only'].join('.');
  const calls: { name: string; body: any }[] = [];
  let cash = cashFixture(options.complete);
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
    if (name === 'cash_position') return options.fail ? reply({ message: 'private SQL secret trace' }, 500) : reply(cash);
    if (name === 'current_stock') return reply(stock);
    if (name === 'payables_summary') return options.failOldWeek && body.p_start === '2026-10-03' ? reply({ message: 'private SQL secret trace' }, 500) : reply({ open_cents: 900000, overdue_cents: 300000, period_cents: 123456, active_count: 20, latest_import_at: options.imported ? stamp : null });
    if (name === 'receivables_summary') return options.receivableFailure ? reply({ code: options.receivableFailure, message: 'private SQL secret trace' }, 404) : reply({ open_cents: 2000000, overdue_cents: 750000, period_cents: 500000, active_count: 30, pending_count: 2, unassigned_count: 3, received_period_cents: 12345, latest_import_at: options.receivableImported ? stamp : null, overdue_bps: 3750, overdue_comlurb_cents: null });
    if (name === 'set_bank_balance') {
      const account = cash.accounts.find(account => account.id === body.p_account_id)!;
      account.amount_cents = body.p_amount_cents; account.balance_date = body.p_balance_date; account.updated_at = stamp;
      return reply(account.id);
    }
    if (name === 'save_manual_stock') { stock = { value_cents: body.p_value_cents, reference_date: body.p_reference_date, source: 'MANUAL' }; return reply('90000000-0000-4000-8000-000000000010'); }
    if (name === 'save_director_position') { history.push({ id: '90000000-0000-4000-8000-000000000011', created_at: stamp, created_by: id, period_start: body.p_start, period_end: body.p_end, indicators: { cash_cents: cash.total_cents, stock_cents: stock.value_cents, payable_period_cents: options.imported ? 123456 : null, complete: false } }); return reply(history[0].id); }
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
  await expect(page.getByRole('heading', { name: 'Registrar saldo bancário', exact: true })).toHaveCount(0);
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
  await expect(page.getByRole('heading', { name: 'Registrar saldo bancário', exact: true })).toBeVisible();
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
