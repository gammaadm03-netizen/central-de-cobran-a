import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
// UTC is already November, while the financial day in São Paulo is October 31.
const now = new Date('2026-11-01T01:30:00Z');
const day = '2026-10-31';
const stamp = '2026-10-31T18:00:00Z';
type SummaryMode = 'ready' | 'missing' | 'no-base' | 'zero' | 'permission' | 'offline';
interface Options { mode?: SummaryMode; panelOnly?: boolean; cashFailure?: boolean; patch?: Record<string, unknown>; clock?: Date }

async function setup(page: Page, options: Options = {}) {
  const browserNow = options.clock ?? now;
  await page.clock.setFixedTime(browserNow);
  const id = '81000000-0000-4000-8000-000000000001';
  const permissions = [{ resource: 'painel', action: 'read' }, ...(options.panelOnly ? [] : [{ resource: 'resumo_diretoria', action: 'read' }])];
  const access = { profile: { id, username: 'DiretorSintetico', display_name: 'Pessoa Sintética', role_key: options.panelOnly ? 'contas_pagar' : 'diretor', enabled: true }, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, session_id: '81000000-0000-4000-8000-000000000002', exp: Math.floor(browserNow.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const calls: { name: string; body: any }[] = [];
  let mode: SummaryMode = options.mode ?? 'ready';
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range', 'content-range': '*/0' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, headers, json });
    const name = url.pathname.split('/').at(-1)!, body = request.postDataJSON();
    calls.push({ name, body });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' } });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'synthetic@test.invalid', email_confirmed_at: stamp, created_at: stamp, app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (name === 'cash_position') return options.cashFailure ? reply({ code: 'XX000', message: 'private SQL and secret trace' }, 503) : reply({ accounts: [], reported_accounts: 0, expected_accounts: 17, total_cents: null, latest_position_date: null });
    if (name === 'current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (name === 'payables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (name === 'receivables_summary') return reply({ open_cents: 99900, overdue_cents: 22200, period_cents: 40000, received_period_cents: 99999, active_count: 7, pending_count: 0, unassigned_count: 0, overdue_bps: 2222, overdue_comlurb_cents: null, latest_import_at: mode === 'no-base' ? null : stamp });
    if (name === 'director_report' || name === 'receivables_daily_delinquency') return reply({ code: 'PGRST202' }, 404);
    if (name === 'receivables_management_summary') {
      if (mode === 'missing') return reply({ code: 'PGRST202', message: 'private missing function details' }, 404);
      if (mode === 'permission') return reply({ code: '42501', message: 'private SQL and secret trace' }, 403);
      if (mode === 'offline') return reply({ code: 'XX000', message: 'private SQL and secret trace' }, 503);
      const absent = mode === 'no-base', zero = mode === 'zero';
      return reply({ as_of_date: day, received_date: day, open_cents: absent ? null : zero ? 0 : 80000, overdue_cents: absent ? null : zero ? 0 : 30000, received_day_cents: absent ? null : zero ? 0 : 1234, received_month_cents: absent ? null : zero ? 0 : 5678, active_count: absent ? null : zero ? 0 : 5, latest_import_at: absent ? null : stamp, latest_import_id: absent ? null : '81000000-0000-4000-8000-000000000003', ...options.patch });
    }
    throw new Error(`Unexpected synthetic dashboard request ${name}`);
  });
  await page.goto('/');
  await page.getByLabel('Usuário', { exact: true }).fill('DiretorSintetico');
  await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Painel Gerencial', exact: true })).toBeVisible();
  await expect(page.getByText('Carregando indicadores…', { exact: true })).toHaveCount(0);
  return { calls, setMode(value: SummaryMode) { mode = value; } };
}
const section = (page: Page) => page.locator('section[aria-labelledby="receivables-management-title"]');
const card = (page: Page, label: string) => section(page).getByRole('heading', { name: label, exact: true }).locator('..');

test('Director sees exact open, overdue and today receipts in three read-only cards using the official São Paulo date', async ({ page }) => {
  const { calls } = await setup(page);
  await expect(card(page, 'Contas a receber em atraso')).toContainText('R$ 300,00');
  await expect(card(page, 'Total a receber')).toContainText('R$ 800,00');
  await expect(card(page, 'Recebido no dia')).toContainText('R$ 12,34');
  await expect(card(page, 'Recebido no dia')).toContainText('31/10/2026');
  expect(calls.filter(call => call.name === 'receivables_management_summary').map(call => call.body)).toEqual([{ p_day: null }]);
  expect(calls.some(call => /^(save_|set_|register_|validate_)/.test(call.name))).toBe(false);
  await expect(page.getByRole('button', { name: 'Salvar posição', exact: true })).toHaveCount(0);
});

test('changing week and month changes the cash-flow period while the daily receipt remains today and never uses monthly receipts', async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByLabel('Semana financeira', { exact: true }).selectOption('2026-10-24');
  await expect(page.getByText('Carregando indicadores…', { exact: true })).toHaveCount(0);
  await expect(card(page, 'Recebido no dia')).toContainText('R$ 12,34');
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  await page.getByLabel('Mês do painel', { exact: true }).fill('2026-09');
  await expect(page.getByText('Carregando indicadores…', { exact: true })).toHaveCount(0);
  await expect(card(page, 'Recebido no dia')).toContainText('31/10/2026');
  await expect(card(page, 'Recebido no dia')).toContainText('R$ 12,34');
  await expect(card(page, 'Recebido no dia')).not.toContainText('R$ 56,78');
  await expect(card(page, 'Recebido no dia')).not.toContainText('R$ 999,99');
  expect(calls.filter(call => call.name === 'receivables_management_summary').every(call => call.body.p_day === null)).toBe(true);
  await expect.poll(() => calls.some(call => call.name === 'receivables_summary' && call.body.p_start === '2026-09-01' && call.body.p_end === '2026-09-30')).toBe(true);
});

test('without an imported base, all three metrics remain pending instead of becoming zero', async ({ page }) => {
  await setup(page, { mode: 'no-base' });
  for (const label of ['Contas a receber em atraso', 'Total a receber', 'Recebido no dia']) {
    await expect(card(page, label)).toContainText('BASE AGUARDANDO IMPORTAÇÃO');
    await expect(card(page, label)).not.toContainText('R$ 0,00');
  }
});

test('an imported empty balance and no receipts are valid exact zeroes', async ({ page }) => {
  await setup(page, { mode: 'zero' });
  for (const label of ['Contas a receber em atraso', 'Total a receber', 'Recebido no dia']) await expect(card(page, label)).toContainText('R$ 0,00');
  await expect(section(page)).not.toContainText('BASE AGUARDANDO IMPORTAÇÃO');
});

test('a missing new RPC falls back only to official open and overdue totals and leaves the daily receipt pending', async ({ page }) => {
  await setup(page, { mode: 'missing' });
  await expect(card(page, 'Contas a receber em atraso')).toContainText('R$ 222,00');
  await expect(card(page, 'Total a receber')).toContainText('R$ 999,00');
  await expect(card(page, 'Recebido no dia')).toContainText('RECEBIMENTOS AGUARDANDO ATIVAÇÃO');
  await expect(card(page, 'Recebido no dia')).not.toContainText('R$ 999,99');
  await expect(section(page).locator('.notice')).toContainText('aguarda ativação');
  await expect(page.getByText('private missing function details')).toHaveCount(0);
});

for (const mode of ['permission', 'offline'] as const) test(`${mode} failure clears previous amounts, shows safe feedback and never uses the legacy period as a daily receipt`, async ({ page }) => {
  const control = await setup(page);
  await expect(card(page, 'Recebido no dia')).toContainText('R$ 12,34');
  control.setMode(mode);
  await section(page).getByRole('button', { name: 'Atualizar Contas a Receber', exact: true }).click();
  await expect(section(page).getByRole('alert')).toContainText(mode === 'permission' ? 'não tem permissão' : 'Não foi possível atualizar');
  for (const label of ['Contas a receber em atraso', 'Total a receber', 'Recebido no dia']) await expect(card(page, label)).toContainText('INDICADOR INDISPONÍVEL');
  await expect(card(page, 'Recebido no dia')).not.toContainText('R$ 12,34');
  await expect(card(page, 'Total a receber')).not.toContainText('R$ 999,00');
  await expect(page.getByText('private SQL and secret trace')).toHaveCount(0);
});

for (const patch of [{ received_day_cents: Number.MAX_SAFE_INTEGER + 1 }, { received_day_cents: 0.5 }, { open_cents: -1 }, { received_date: '2026-10-30' }, { as_of_date: '2026-02-30', received_date: '2026-02-30' }]) test(`unsafe or mismatched summary is refused: ${JSON.stringify(patch)}`, async ({ page }) => {
  await setup(page, { patch });
  await expect(section(page).getByRole('alert')).toContainText('Não foi possível atualizar');
  await expect(card(page, 'Recebido no dia')).toContainText('INDICADOR INDISPONÍVEL');
  await expect(card(page, 'Recebido no dia')).not.toContainText('R$ 12,34');
});

test('painel.read alone can consult the three financial cards without gaining Director or Receivables write access', async ({ page }) => {
  const { calls } = await setup(page, { panelOnly: true });
  await expect(card(page, 'Total a receber')).toContainText('R$ 800,00');
  await expect(card(page, 'Recebido no dia')).toContainText('R$ 12,34');
  await expect(page.getByRole('heading', { name: 'Resumo da Diretoria', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Contas a Receber', exact: true })).toHaveCount(0);
  expect(calls.some(call => /^(save_|set_|register_|validate_)/.test(call.name))).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a separate cash failure does not discard the successfully fetched receivables indicators', async ({ page }) => {
  await setup(page, { cashFailure: true });
  await expect(page.getByRole('alert').filter({ hasText: 'Não foi possível atualizar o painel' })).toBeVisible();
  await expect(card(page, 'Total a receber')).toContainText('R$ 800,00');
  await expect(card(page, 'Recebido no dia')).toContainText('R$ 12,34');
});

test('an incorrect computer date never selects yesterday receipts or rejects the authoritative server day', async ({ page }) => {
  const { calls } = await setup(page, { clock: new Date('2026-10-17T15:00:00Z'), patch: { as_of_date: '2026-10-18', received_date: '2026-10-18', received_day_cents: 1800, open_cents: 180000, latest_import_at: '2026-10-18T13:00:00Z' } });
  await expect(section(page)).toContainText('Referência 18/10/2026');
  await expect(section(page)).not.toContainText('17/10/2026');
  await expect(card(page, 'Recebido no dia')).toContainText('18/10/2026');
  await expect(card(page, 'Recebido no dia')).toContainText('R$ 18,00');
  await expect(card(page, 'Total a receber')).toContainText('R$ 1.800,00');
  expect(calls.find(call => call.name === 'receivables_management_summary')?.body).toEqual({ p_day: null });
  expect(calls.find(call => call.name === 'cash_position')?.body).toEqual({ p_as_of: '2026-10-17' });
});
