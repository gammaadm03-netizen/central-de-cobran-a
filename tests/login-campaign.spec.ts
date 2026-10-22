import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const moduleLabels = ['Painel Gerencial', 'Caixa / Bancos', 'Contas a Pagar', 'Contas a Receber', 'Cobrança', 'Comissões', 'Faturamento', 'Fechamento', 'RH / DP', 'Importar Bases'];
const resources = ['painel', 'caixa', 'contas_pagar', 'contas_receber', 'cobranca', 'comissoes', 'faturamento', 'margens', 'rh_dp', 'importar_bases'];

async function setup(page: Page, now = '2026-10-19T15:00:00Z') {
  await page.clock.setFixedTime(new Date(now));
  const profile = { id: '76000000-0000-4000-8000-000000000001', username: 'UsuarioTemaSintetico', display_name: 'Pessoa sintética', role_key: 'gerente_geral', enabled: true };
  const permissions = resources.flatMap(resource => ['read', 'export'].map(action => ({ resource, action })));
  permissions.push({ resource: 'usuarios', action: 'admin' }, { resource: 'configuracoes', action: 'admin' }, { resource: 'auditoria', action: 'read' }, { resource: 'mensagens_cp', action: 'read' });
  const access = { profile, permissions, collector_id: null };
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: profile.id, session_id: '76000000-0000-4000-8000-000000000002', role: 'authenticated', exp: Math.floor(Date.parse(now) / 1000) + 3600 })).toString('base64url'),
    Buffer.from('synthetic monthly fixture').toString('base64url'),
  ].join('.');
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status, headers });
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: profile.id, aud: 'authenticated', role: 'authenticated', email: 'theme@synthetic.invalid', email_confirmed_at: now, created_at: now, app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/current_access') return reply(access);
    if (url.pathname === '/rest/v1/profiles') return reply([{ ...profile, updated_at: now }]);
    if (url.pathname === '/rest/v1/rpc/cash_position') return reply({ accounts: [], total_cents: null, reported_accounts: 0, expected_accounts: 17, latest_position_date: null });
    if (url.pathname === '/rest/v1/rpc/current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (url.pathname === '/rest/v1/rpc/payables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (url.pathname === '/rest/v1/rpc/receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, pending_count: 0, unassigned_count: 0, received_period_cents: 0, latest_import_at: null, overdue_bps: null, overdue_comlurb_cents: null });
    if (url.pathname.startsWith('/rest/v1/rpc/')) return reply({ code: 'PGRST202' }, 404);
    if (url.pathname.startsWith('/rest/v1/')) return route.fulfill({ json: [], headers: { ...headers, 'content-range': '*/0' } });
    throw new Error(`Unexpected request in monthly campaign test: ${request.method()} ${url.pathname}`);
  });
}

async function signIn(page: Page) {
  await page.getByLabel('Usuário', { exact: true }).fill('UsuarioTemaSintetico');
  await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Módulos da Central' })).toBeVisible();
}

test('October welcome retains the slogan and shows larger branding and creator credit', async ({ page }) => {
  await setup(page); await page.goto('/');
  const intro = page.locator('.login-intro');
  await expect(intro).toContainText('Outubro Rosa');
  await expect(intro).toHaveAttribute('data-month', '10');
  await expect(intro).toHaveAttribute('data-motif', 'ribbon');
  await expect(intro.locator('.campaign-ribbon')).toHaveCount(1);
  expect(await intro.evaluate(node => getComputedStyle(node).getPropertyValue('--login-accent').trim())).toBe('#ef9ebc');
  await expect(intro.getByRole('heading', { level: 1 })).toHaveText('As informações certas.Em um só lugar.');
  await expect(intro.getByText('Idealizado e projetado por Graziele Pinheiro.', { exact: true })).toBeVisible();
  await expect(intro).not.toContainText('Acesso à Central Financeira do Grupo Ecoplast, com permissões individuais e histórico de operações.');
  const image = intro.locator('.brand-mark img');
  expect((await image.boundingBox())!.width).toBeGreaterThanOrEqual(90);
  expect(await intro.locator('.brand-copy strong').evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(22);
  await expect(page.getByLabel('Usuário', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Senha', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Esqueci minha senha', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/central-login-outubro.png', fullPage: true });
});

test('monthly campaign follows the Brasília month at November and January boundaries', async ({ page }) => {
  await setup(page, '2026-11-01T01:00:00Z'); await page.goto('/');
  await expect(page.locator('.login-intro')).toContainText('Outubro Rosa');
  await page.clock.setFixedTime(new Date('2026-11-01T03:00:00Z')); await page.reload();
  await expect(page.locator('.login-intro')).toContainText('Novembro Azul');
  await page.clock.setFixedTime(new Date('2027-01-01T01:00:00Z')); await page.reload();
  await expect(page.locator('.login-intro')).toContainText('Natal');
  await page.clock.setFixedTime(new Date('2027-01-01T03:00:00Z')); await page.reload();
  await expect(page.locator('.login-intro')).toContainText('Janeiro Branco');
});

test('compact campaign stays visible in every authorized module and administration', async ({ page }) => {
  await setup(page); await page.goto('/'); await signIn(page);
  const campaign = page.getByRole('complementary', { name: 'Campanha do mês', exact: true });
  for (const label of moduleLabels) {
    await page.getByRole('navigation', { name: 'Módulos da Central' }).getByRole('button', { name: label, exact: true }).click();
    await expect(campaign).toBeVisible();
    await expect(campaign).toContainText('Outubro Rosa');
    await expect(campaign).toHaveAttribute('data-month', '10');
    expect((await campaign.boundingBox())!.height).toBeLessThanOrEqual(80);
    if (label === 'Painel Gerencial') await page.screenshot({ path: '/tmp/central-campanha-painel.png', fullPage: true });
  }
  await page.getByRole('button', { name: 'Administração', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Usuários e permissões', exact: true })).toBeVisible();
  await expect(campaign).toBeVisible();
});

test('mobile welcome shows branding and creator credit without horizontal overflow', async ({ page }) => {
  await setup(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  const intro = page.locator('.login-intro');
  await expect(intro.getByText('Central Financeira', { exact: true })).toBeVisible();
  await expect(intro.getByText('Idealizado e projetado por Graziele Pinheiro.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Usuário', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/central-login-outubro-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 760 });
  await expect(intro.getByText('Idealizado e projetado por Graziele Pinheiro.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/central-login-outubro-320.png', fullPage: true });
  await signIn(page);
  const campaign = page.getByRole('complementary', { name: 'Campanha do mês', exact: true });
  await expect(campaign).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
