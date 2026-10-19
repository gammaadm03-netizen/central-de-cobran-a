import { test, expect, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = new Date('2026-10-16T15:00:00Z');
const stamp = now.toISOString();
type Role = 'gerente_geral' | 'contas_pagar' | 'contas_receber' | 'diretor';
interface StockRow { id: string; value_cents: number; reference_date: string; observation: string; created_at: string; created_by: string; profiles: { username: string; display_name: string } }
interface Options { role?: Role; noWrite?: boolean; rows?: StockRow[]; failSave?: boolean; failRead?: boolean }
function position(index: number, reference = '2026-10-15', cents = 10000 + index): StockRow { return { id: `90000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`, value_cents: cents, reference_date: reference, observation: `Posição sintética ${index}.`, created_at: `2026-10-15T12:00:${String(index).padStart(2, '0')}Z`, created_by: '90000000-0000-4000-8000-000000000001', profiles: { username: 'GestoraTeste', display_name: 'Gestora de Teste' } }; }

async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(now);
  const id = '90000000-0000-4000-8000-000000000001'; const role = options.role ?? 'gerente_geral';
  const permissions = ['painel', 'caixa', 'importar_bases'].map(resource => ({ resource, action: 'read' }));
  if (role === 'gerente_geral' && !options.noWrite) permissions.push({ resource: 'caixa', action: 'write' }, { resource: 'usuarios', action: 'admin' });
  if (role === 'contas_pagar') permissions.push({ resource: 'contas_pagar', action: 'import' });
  if (role === 'contas_receber') permissions.push({ resource: 'contas_receber', action: 'import' });
  if (role === 'diretor' || role === 'gerente_geral') permissions.push({ resource: 'resumo_diretoria', action: 'read' });
  const access = { profile: { id, username: 'GestoraTeste', display_name: 'Gestora de Teste', role_key: role, enabled: true }, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, session_id: '90000000-0000-4000-8000-000000000002', exp: Math.floor(now.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const rows = [...(options.rows ?? [])]; const calls: { name: string; body: any; query: string }[] = [];
  await page.route(`${project}/**`, async route => {
    const request = route.request(); const url = new URL(request.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range', 'content-range': '*/0' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json }); const body = request.postDataJSON(); const name = url.pathname.split('/').at(-1)!;
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' } });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'fixture@test.invalid', email_confirmed_at: stamp, created_at: stamp, app_metadata: {}, user_metadata: {} });
    calls.push({ name, body, query: url.search });
    if (url.pathname === '/rest/v1/rpc/receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'current_access') return reply(access);
    if (name === 'director_report') return reply({ code: 'PGRST202' }, 404);
    if (name === 'cash_position') return reply({ accounts: [], total_cents: null, reported_accounts: 0, expected_accounts: 17, latest_position_date: null });
    if (name === 'payables_summary' || name === 'receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (name === 'current_stock') {
      if (options.failRead) return reply({ code: 'XX000', message: 'private SQL query and secret' }, 503);
      const current = [...rows].sort((left, right) => right.reference_date.localeCompare(left.reference_date) || right.created_at.localeCompare(left.created_at))[0];
      return reply({ value_cents: current?.value_cents ?? null, reference_date: current?.reference_date ?? null, source: current ? 'MANUAL' : null });
    }
    if (name === 'stock_positions') {
      if (options.failRead) return reply({ code: 'XX000', message: 'private SQL query and secret' }, 503);
      const offset = Number(url.searchParams.get('offset') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 20);
      const all = [...rows].sort((left, right) => right.created_at.localeCompare(left.created_at)); const selected = all.slice(offset, offset + limit);
      return route.fulfill({ status: 200, headers: { ...headers, 'content-range': selected.length ? `${offset}-${offset + selected.length - 1}/${rows.length}` : `*/${rows.length}` }, json: selected });
    }
    if (name === 'save_manual_stock') {
      if (options.failSave) return reply({ code: 'XX000', message: 'private SQL query and secret' }, 503);
      const saved = { ...position(rows.length + 1, body.p_reference_date, body.p_value_cents), created_at: `2026-10-16T15:01:${String(rows.length).padStart(2, '0')}Z`, observation: body.p_observation }; rows.push(saved); return reply(saved.id);
    }
    if (['payable_macros', 'payable_imports', 'payable_plan_mappings', 'receivable_imports', 'collection_agents'].includes(name)) return reply([]);
    throw new Error(`Unexpected offline fixture request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('GestoraTeste'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await expect(page.getByText('Carregando indicadores…')).toHaveCount(0);
  if (role !== 'diretor') await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click();
  if (role === 'gerente_geral' && !options.noWrite) { await page.getByRole('tab', { name: 'Estoque', exact: true }).click(); await expect(page.getByText('Carregando histórico de estoque…')).toHaveCount(0); }
  return { rows, calls };
}
async function fill(page: Page, amount = '1.234,56', reference = '2026-10-16') {
  await page.getByLabel('Data de referência do estoque', { exact: true }).fill(reference);
  await page.getByLabel('Valor total do estoque (R$)', { exact: true }).fill(amount);
  await page.getByRole('textbox', { name: 'Observação da posição de estoque', exact: true }).fill('Conferido na base oficial de estoque.');
}

test('Importar Bases contains a manager-only manual stock card and does not turn missing stock into zero', async ({ page }) => {
  const { calls } = await setup(page);
  await expect(page.getByRole('tab', { name: 'Estoque', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.stock-import-current')).toContainText('ESTOQUE AGUARDANDO ATUALIZAÇÃO');
  await expect(page.locator('.stock-import-current')).not.toContainText('R$ 0,00');
  await expect(page.getByLabel('Data de referência do estoque', { exact: true })).toHaveValue('2026-10-16');
  await expect(page.getByLabel('Valor total do estoque (R$)', { exact: true })).toHaveValue('');
  await expect(page.getByText('Nenhuma posição de estoque registrada.', { exact: true })).toBeVisible();
  expect(calls.find(call => call.name === 'stock_positions')?.query).toContain('stock_positions_created_by_fkey');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('manual stock saves exact cents after confirmation and returns to the updated executive panel', async ({ page }) => {
  const { calls } = await setup(page); await fill(page);
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Salvar posição de estoque', exact: true }).click();
  expect(calls.some(call => call.name === 'save_manual_stock')).toBe(false);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição de estoque', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Estoque manual de 16/10/2026 registrado' })).toBeVisible();
  await expect(page.locator('.stock-import-current')).toContainText('R$ 1.234,56');
  await expect(page.locator('.stock-import-history')).toContainText('Gestora de Teste');
  await expect(page.locator('.stock-import-history')).toContainText('GestoraTeste');
  expect(calls.find(call => call.name === 'save_manual_stock')?.body).toEqual({ p_value_cents: 123456, p_reference_date: '2026-10-16', p_observation: 'Conferido na base oficial de estoque.' });
  await page.getByRole('button', { name: 'Ir para o Painel Gerencial', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Painel Gerencial', exact: true })).toBeVisible();
  await expect(page.locator('.director-summary-column').filter({ has: page.getByRole('heading', { name: 'FINANCEIRO', exact: true }) })).toContainText('R$ 1.234,56');
});

test('manual stock accepts explicit zero and the safe integer boundary without rounding', async ({ page }) => {
  const { calls } = await setup(page); await fill(page, '0,00');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição de estoque', exact: true }).click();
  await expect(page.locator('.stock-import-current')).toContainText('R$ 0,00');
  expect(calls.filter(call => call.name === 'save_manual_stock').at(-1)?.body.p_value_cents).toBe(0);
  await fill(page, '90071992547409,91'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição de estoque', exact: true }).click();
  await expect(page.locator('.stock-import-current')).toContainText('R$ 90.071.992.547.409,91');
  expect(calls.filter(call => call.name === 'save_manual_stock').at(-1)?.body.p_value_cents).toBe(Number.MAX_SAFE_INTEGER);
});

test('negative, excessive precision, unsafe cents, future dates and missing observation cannot create stock positions', async ({ page }) => {
  const { calls } = await setup(page);
  for (const amount of ['-0,01', '1,234', '90071992547409,92']) {
    await fill(page, amount); await page.getByRole('button', { name: 'Salvar posição de estoque', exact: true }).click();
    await expect(page.locator('.stock-import-form').getByRole('alert')).toContainText('até duas casas decimais');
  }
  await fill(page, '100,00', '2026-10-17'); await page.getByRole('button', { name: 'Salvar posição de estoque', exact: true }).click();
  await fill(page); await page.getByRole('textbox', { name: 'Observação da posição de estoque', exact: true }).fill(''); await page.getByRole('button', { name: 'Salvar posição de estoque', exact: true }).click();
  expect(calls.some(call => call.name === 'save_manual_stock')).toBe(false);
});

test('stock history paginates twenty records and preserves author and escaped observations', async ({ page }) => {
  const rows = Array.from({ length: 25 }, (_, index) => position(index + 1)); rows[24].observation = '<script>window.fixtureExecuted=true</script>';
  const { calls } = await setup(page, { rows });
  await expect(page.locator('.stock-import-history tbody tr')).toHaveCount(20);
  await expect(page.locator('.stock-import-history')).toContainText('25 posição(ões) · Página 1');
  await expect(page.getByText('<script>window.fixtureExecuted=true</script>', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixtureExecuted)).toBeUndefined();
  await page.locator('.stock-import-history').getByRole('button', { name: 'Próxima', exact: true }).click();
  await expect(page.locator('.stock-import-history tbody tr')).toHaveCount(5);
  await expect(page.locator('.stock-import-history')).toContainText('25 posição(ões) · Página 2');
  await expect(page.locator('.stock-import-history').getByRole('button', { name: 'Próxima', exact: true })).toBeDisabled();
  expect(calls.filter(call => call.name === 'stock_positions').at(-1)?.query).toContain('offset=20');
});

test('an older reference is appended to history without replacing the current dashboard position', async ({ page }) => {
  await setup(page, { rows: [position(1, '2026-10-16', 76543210)] }); await fill(page, '200,15', '2026-10-14');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição de estoque', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Estoque manual de 14/10/2026 registrado' })).toBeVisible();
  await expect(page.locator('.stock-import-current')).toContainText('R$ 765.432,10');
  await expect(page.locator('.stock-import-current')).toContainText('referência mais recente');
  await expect(page.locator('.stock-import-history tbody tr').first()).toContainText('14/10/2026');
  await expect(page.locator('.stock-import-history tbody tr').first()).toContainText('R$ 200,15');
});

test('a failed save keeps the draft, gives no false success and requires reviewing history before another attempt', async ({ page }) => {
  const { calls } = await setup(page, { failSave: true }); await fill(page);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição de estoque', exact: true }).click();
  await expect(page.locator('.stock-import-form').getByRole('alert')).toContainText('Não foi possível confirmar o salvamento');
  await expect(page.getByRole('button', { name: 'Salvar posição de estoque', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Observação da posição de estoque', exact: true })).toHaveValue('Conferido na base oficial de estoque.');
  await expect(page.getByLabel('Valor total do estoque (R$)', { exact: true })).toHaveValue('1.234,56');
  await expect(page.locator('.stock-import-form').getByRole('status')).toHaveCount(0);
  await expect(page.getByText('private SQL query and secret')).toHaveCount(0);
  await page.getByRole('button', { name: 'Atualizar posição e histórico', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Salvar posição de estoque', exact: true })).toBeEnabled();
  expect(calls.filter(call => call.name === 'save_manual_stock')).toHaveLength(1);
});

test('failed refresh preserves the known stock and all draft fields while showing a friendly error', async ({ page }) => {
  const options: Options = { rows: [position(1)] }; await setup(page, options); await fill(page);
  options.failRead = true; await page.getByRole('button', { name: 'Atualizar posição e histórico', exact: true }).click();
  await expect(page.locator('.stock-import-current').getByRole('alert')).toContainText('Não foi possível consultar o estoque');
  await expect(page.locator('.stock-import-current')).toContainText('R$ 100,01');
  await expect(page.getByLabel('Valor total do estoque (R$)', { exact: true })).toHaveValue('1.234,56');
  await expect(page.getByRole('textbox', { name: 'Observação da posição de estoque', exact: true })).toHaveValue('Conferido na base oficial de estoque.');
});

test('a failed history page never shows the previous page records under the new page number', async ({ page }) => {
  const options: Options = { rows: Array.from({ length: 25 }, (_, index) => position(index + 1)) }; await setup(page, options);
  await expect(page.locator('.stock-import-history tbody tr')).toHaveCount(20);
  options.failRead = true; await page.locator('.stock-import-history').getByRole('button', { name: 'Próxima', exact: true }).click();
  await expect(page.locator('.stock-import-current').getByRole('alert')).toContainText('Não foi possível consultar o estoque');
  await expect(page.locator('.stock-import-history')).toContainText('Página 2');
  await expect(page.locator('.stock-import-history tbody tr')).toHaveCount(0);
  await expect(page.getByText('Nenhuma posição de estoque registrada.', { exact: true })).toHaveCount(0);
  options.failRead = false; await page.getByRole('button', { name: 'Atualizar posição e histórico', exact: true }).click();
  await expect(page.locator('.stock-import-history tbody tr')).toHaveCount(5);
});

for (const role of ['contas_pagar', 'contas_receber', 'diretor'] as const) test(`${role} has no stock import entry and makes no stock-history or stock-write requests`, async ({ page }) => {
  const { calls } = await setup(page, { role });
  if (role === 'diretor') await expect(page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Estoque', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Salvar posição de estoque', exact: true })).toHaveCount(0);
  expect(calls.some(call => call.name === 'stock_positions' || call.name === 'save_manual_stock')).toBe(false);
});

test('manager without the official cash write permission has no stock import entry', async ({ page }) => {
  const { calls } = await setup(page, { noWrite: true });
  await expect(page.getByRole('tab', { name: 'Estoque', exact: true })).toHaveCount(0);
  expect(calls.some(call => call.name === 'stock_positions' || call.name === 'save_manual_stock')).toBe(false);
});
