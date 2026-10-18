import { test, expect, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = new Date('2026-10-16T15:00:00Z');
const fields = ['turnover_month_cents', 'turnover_comlurb_cents', 'orders_cents', 'blocked_orders_cents', 'pending_orders_cents', 'overdue_comlurb_cents', 'installments_cents', 'previous_month_taxes_cents'] as const;
type Field = typeof fields[number];
type Role = 'gerente_geral' | 'contas_pagar' | 'contas_receber' | 'diretor';
interface Position { id: string; reference_date: string; values: Record<Field, number | null>; observation: string; created_at: string; created_by: string }
interface Options { role?: Role; noWrite?: boolean; rows?: Position[]; failRead?: boolean; failDate?: string; failSave?: string; saveDespiteFailure?: boolean; holdDate?: string }
function position(index: number, reference = '2026-10-16', values: Partial<Record<Field, number | null>> = {}): Position {
  return { id: `92000000-0000-4000-8000-${String(index).padStart(12, '0')}`, reference_date: reference, values: { ...Object.fromEntries(fields.map(field => [field, null])), ...values } as Record<Field, number | null>, observation: `Registro sintético ${index}.`, created_at: `2026-10-16T12:00:${String(index).padStart(2, '0')}Z`, created_by: '92000000-0000-4000-8000-000000000001' };
}

async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(now);
  const id = '92000000-0000-4000-8000-000000000001'; const role = options.role ?? 'gerente_geral';
  const permissions = ['painel', 'caixa', 'importar_bases', 'resumo_diretoria'].map(resource => ({ resource, action: 'read' }));
  if (role === 'gerente_geral') {
    permissions.push({ resource: 'caixa', action: 'write' }, { resource: 'usuarios', action: 'admin' });
    if (!options.noWrite) permissions.push({ resource: 'resumo_diretoria', action: 'write' });
  }
  if (role === 'contas_pagar') permissions.push({ resource: 'contas_pagar', action: 'import' });
  if (role === 'contas_receber') permissions.push({ resource: 'contas_receber', action: 'import' });
  const access = { profile: { id, username: 'GestoraTeste', display_name: 'Gestora de Teste', role_key: role, enabled: true }, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, session_id: '92000000-0000-4000-8000-000000000002', exp: Math.floor(now.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const rows = [...(options.rows ?? [])]; const calls: { name: string; body: any }[] = []; const held: (() => void)[] = [];
  await page.route(`${project}/**`, async route => {
    const request = route.request(); const url = new URL(request.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range', 'content-range': '*/0' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json }); const body = request.postDataJSON(); const name = url.pathname.split('/').at(-1)!;
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' } });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'fixture@test.invalid', email_confirmed_at: now.toISOString(), created_at: now.toISOString(), app_metadata: {}, user_metadata: {} });
    calls.push({ name, body });
    if (url.pathname === '/rest/v1/rpc/receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'current_access') return reply(access);
    if (name === 'director_report') return reply({ code: 'PGRST202', message: 'RPC unavailable in this isolated input fixture' }, 404);
    if (name === 'cash_position') return reply({ accounts: [], total_cents: null, reported_accounts: 0, expected_accounts: 17, latest_position_date: null });
    if (name === 'payables_summary' || name === 'receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (name === 'current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (name === 'stock_positions' || ['payable_macros', 'payable_imports', 'payable_plan_mappings', 'receivable_imports', 'collection_agents'].includes(name)) return reply([]);
    if (name === 'read_director_inputs') {
      if (body.p_reference_date === options.holdDate) await new Promise<void>(resolve => held.push(resolve));
      if (options.failRead || body.p_reference_date === options.failDate) return reply({ code: 'XX000', message: 'private query and secret' }, 503);
      return reply([...rows].reverse().find(row => row.reference_date === body.p_reference_date) ?? null);
    }
    if (name === 'save_director_inputs') {
      if (!options.failSave || options.saveDespiteFailure) {
        const saved = position(rows.length + 1, body.p_reference_date, body.p_values); saved.observation = body.p_observation; rows.push(saved);
      }
      if (options.failSave) return reply({ code: options.failSave, message: 'private query and secret' }, options.failSave === '40001' ? 409 : 503);
      return reply(rows.at(-1)!.id);
    }
    throw new Error(`Unexpected offline fixture request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('GestoraTeste'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await expect(page.getByText('Carregando indicadores…')).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click();
  if (role === 'gerente_geral' && !options.noWrite) {
    await page.getByRole('tab', { name: 'Resumo da Diretoria', exact: true }).click();
    await expect(page.getByText('Carregando indicadores da data selecionada…')).toHaveCount(0);
  }
  return { rows, calls, held };
}
async function fill(page: Page, amount = '1.234,56') {
  await page.getByLabel('Faturamento mês (exceto COMLURB) (R$)', { exact: true }).fill(amount);
  await page.getByRole('textbox', { name: 'Observação dos indicadores', exact: true }).fill('Posição conferida na documentação oficial.');
}
const submit = (page: Page) => page.getByRole('button', { name: 'Salvar indicadores da Diretoria', exact: true });

test('director inputs are dated, empty by default, distinct from central balances and usable on mobile', async ({ page }) => {
  const { calls } = await setup(page);
  await expect(page.getByRole('tab', { name: 'Resumo da Diretoria', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Data de referência do resumo', { exact: true })).toHaveValue('2026-10-16');
  await expect(page.locator('.director-inputs-position')).toContainText('Nenhum indicador complementar informado em 16/10/2026');
  await expect(page.locator('.director-inputs-total')).toContainText('Aguardando os dois valores de faturamento');
  await expect(page.locator('.director-inputs')).toContainText('Caixa, contas a receber, estoque e compra de mercadoria utilizam as bases centrais.');
  await expect(page.locator('.director-inputs input[inputmode="decimal"]')).toHaveCount(8);
  expect(calls.filter(call => call.name === 'read_director_inputs').at(-1)?.body).toEqual({ p_reference_date: '2026-10-16' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('save requires confirmation, preserves blank indicators as null and submits exact cents with optimistic id', async ({ page }) => {
  const { calls } = await setup(page); await fill(page);
  page.once('dialog', dialog => dialog.dismiss()); await submit(page).click();
  expect(calls.some(call => call.name === 'save_director_inputs')).toBe(false);
  page.once('dialog', dialog => dialog.accept()); await submit(page).click();
  await expect(page.locator('.director-inputs-form').getByRole('status')).toContainText('Indicadores de 16/10/2026 salvos');
  await expect(page.getByLabel('Faturamento mês (exceto COMLURB) (R$)', { exact: true })).toHaveValue('1234,56');
  expect(calls.find(call => call.name === 'save_director_inputs')?.body).toEqual({ p_reference_date: '2026-10-16', p_expected_id: null, p_observation: 'Posição conferida na documentação oficial.', p_values: { turnover_month_cents: 123456, turnover_comlurb_cents: null, orders_cents: null, blocked_orders_cents: null, pending_orders_cents: null, overdue_comlurb_cents: null, installments_cents: null, previous_month_taxes_cents: null } });
});

test('explicit zero is saved and general turnover adds exactly the two separate turnover values', async ({ page }) => {
  const { calls, rows } = await setup(page); await fill(page, '0,00');
  await page.getByLabel('Faturamento COMLURB (R$)', { exact: true }).fill('0,00');
  await expect(page.locator('.director-inputs-total')).toContainText('R$ 0,00');
  page.once('dialog', dialog => dialog.accept()); await submit(page).click();
  await expect(page.locator('.director-inputs-form').getByRole('status')).toContainText('salvos');
  await fill(page, '0,01'); await page.getByLabel('Faturamento COMLURB (R$)', { exact: true }).fill('0,02');
  await expect(page.locator('.director-inputs-total')).toContainText('R$ 0,03');
  page.once('dialog', dialog => dialog.accept()); await submit(page).click();
  await expect(page.locator('.director-inputs-form').getByRole('status')).toContainText('salvos');
  const writes = calls.filter(call => call.name === 'save_director_inputs');
  expect(writes[0].body.p_values.turnover_month_cents).toBe(0);
  expect(writes[0].body.p_values.turnover_comlurb_cents).toBe(0);
  expect(writes[1].body.p_expected_id).toBe(rows[0].id);
  expect(writes[1].body.p_values.turnover_month_cents).toBe(1);
  expect(writes[1].body.p_values.turnover_comlurb_cents).toBe(2);
});

test('safe integer cents remain exact and a combined unsafe turnover is blocked', async ({ page }) => {
  const { calls } = await setup(page); await fill(page, '90071992547409,91');
  page.once('dialog', dialog => dialog.accept()); await submit(page).click();
  await expect(page.locator('.director-inputs-form').getByRole('status')).toContainText('salvos');
  expect(calls.filter(call => call.name === 'save_director_inputs').at(-1)?.body.p_values.turnover_month_cents).toBe(Number.MAX_SAFE_INTEGER);
  await page.getByLabel('Faturamento COMLURB (R$)', { exact: true }).fill('0,01');
  await submit(page).click();
  await expect(page.locator('.director-inputs-form').getByRole('alert')).toContainText('faturamento geral ultrapassa');
  expect(calls.filter(call => call.name === 'save_director_inputs')).toHaveLength(1);
});

test('negative values, excessive precision, unsafe cents and an entirely blank position are blocked', async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByRole('textbox', { name: 'Observação dos indicadores', exact: true }).fill('Posição sintética.');
  await submit(page).click();
  await expect(page.locator('.director-inputs-form').getByRole('alert')).toContainText('Informe ao menos um indicador');
  for (const amount of ['-0,01', '1,234', '90071992547409,92']) {
    await fill(page, amount); await submit(page).click();
    await expect(page.locator('.director-inputs-form').getByRole('alert')).toContainText('até duas casas decimais');
  }
  expect(calls.some(call => call.name === 'save_director_inputs')).toBe(false);
});

test('selecting another date clears unsaved fields and reads exactly that date without carrying values forward', async ({ page }) => {
  const rows = [position(1, '2026-10-15', { orders_cents: 55555 })]; const fixture = await setup(page, { rows });
  await fill(page);
  await page.getByLabel('Data de referência do resumo', { exact: true }).fill('2026-10-15');
  await expect(page.getByLabel('Valor de pedido em sistema (R$)', { exact: true })).toHaveValue('555,55');
  await expect(page.getByLabel('Faturamento mês (exceto COMLURB) (R$)', { exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Observação dos indicadores', exact: true })).toHaveValue('Registro sintético 1.');
  await page.getByLabel('Data de referência do resumo', { exact: true }).fill('2026-10-16');
  await expect(page.getByLabel('Valor de pedido em sistema (R$)', { exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Observação dos indicadores', exact: true })).toHaveValue('');
  expect(fixture.calls.filter(call => call.name === 'read_director_inputs').map(call => call.body.p_reference_date)).toEqual(['2026-10-16', '2026-10-15', '2026-10-16']);
});

test('network uncertainty preserves the draft and requires rereading the actual saved revision before retry', async ({ page }) => {
  const options: Options = { failSave: 'XX000', saveDespiteFailure: true }; const { calls, rows } = await setup(page, options); await fill(page);
  page.once('dialog', dialog => dialog.accept()); await submit(page).click();
  await expect(page.locator('.director-inputs-form').getByRole('alert')).toContainText('Não foi possível confirmar o salvamento');
  await expect(submit(page)).toBeDisabled();
  await expect(page.getByLabel('Faturamento mês (exceto COMLURB) (R$)', { exact: true })).toHaveValue('1.234,56');
  await expect(page.getByRole('textbox', { name: 'Observação dos indicadores', exact: true })).toHaveValue('Posição conferida na documentação oficial.');
  await expect(page.getByText('private query and secret')).toHaveCount(0);
  await expect(page.locator('.director-inputs-form').getByRole('status')).toHaveCount(0);
  options.failSave = undefined;
  await page.getByRole('button', { name: 'Atualizar posição salva', exact: true }).click();
  await expect(submit(page)).toBeEnabled();
  await expect(page.locator('.director-inputs-position')).toContainText('A alteração criará uma nova versão');
  await expect(page.getByLabel('Faturamento mês (exceto COMLURB) (R$)', { exact: true })).toHaveValue('1.234,56');
  expect(calls.filter(call => call.name === 'save_director_inputs')).toHaveLength(1);
  expect(rows).toHaveLength(1);
});

test('an optimistic conflict shows a friendly message and rereads the new revision without overwriting the draft', async ({ page }) => {
  const options: Options = { rows: [position(1, '2026-10-16', { orders_cents: 20000 })], failSave: '40001' }; const { rows, calls } = await setup(page, options);
  await fill(page, '300,25'); page.once('dialog', dialog => dialog.accept()); await submit(page).click();
  await expect(page.locator('.director-inputs-form').getByRole('alert')).toContainText('atualizada por outra pessoa');
  rows.push(position(2, '2026-10-16', { orders_cents: 40000 })); options.failSave = undefined;
  await page.getByRole('button', { name: 'Atualizar posição salva', exact: true }).click();
  await expect(submit(page)).toBeEnabled();
  await expect(page.getByLabel('Faturamento mês (exceto COMLURB) (R$)', { exact: true })).toHaveValue('300,25');
  await page.getByText('Conferir valores salvos desta data', { exact: true }).click();
  await expect(page.locator('.director-inputs-saved')).toContainText('R$ 400,00');
  page.once('dialog', dialog => dialog.accept()); await submit(page).click();
  await expect(page.locator('.director-inputs-form').getByRole('status')).toContainText('salvos');
  expect(calls.filter(call => call.name === 'save_director_inputs').at(-1)?.body.p_expected_id).toBe(rows[1].id);
});

test('a failed date read never exposes the preceding date values or enables saving against its revision', async ({ page }) => {
  const options: Options = { rows: [position(1, '2026-10-16', { orders_cents: 55555 })], failDate: '2026-10-15' }; const { calls } = await setup(page, options);
  await expect(page.getByLabel('Valor de pedido em sistema (R$)', { exact: true })).toHaveValue('555,55');
  await page.getByLabel('Data de referência do resumo', { exact: true }).fill('2026-10-15');
  await expect(page.locator('.director-inputs-position').getByRole('alert')).toContainText('Não foi possível consultar');
  await expect(page.getByLabel('Valor de pedido em sistema (R$)', { exact: true })).toHaveValue('');
  await expect(page.locator('.director-inputs-position')).not.toContainText('R$ 555,55');
  await expect(submit(page)).toBeDisabled();
  expect(calls.some(call => call.name === 'save_director_inputs')).toBe(false);
});

test('a failed refresh keeps the draft and blocks writes until the same date can be read again', async ({ page }) => {
  const options: Options = {}; await setup(page, options); await fill(page);
  options.failRead = true; await page.getByRole('button', { name: 'Atualizar posição salva', exact: true }).click();
  await expect(page.locator('.director-inputs-position').getByRole('alert')).toContainText('Seus campos foram preservados');
  await expect(page.getByLabel('Faturamento mês (exceto COMLURB) (R$)', { exact: true })).toHaveValue('1.234,56');
  await expect(submit(page)).toBeDisabled();
  options.failRead = false; await page.getByRole('button', { name: 'Atualizar posição salva', exact: true }).click();
  await expect(submit(page)).toBeEnabled();
  await expect(page.getByLabel('Faturamento mês (exceto COMLURB) (R$)', { exact: true })).toHaveValue('1.234,56');
});

test('a delayed response for a previous selection never replaces the newly selected date', async ({ page }) => {
  const { held, calls } = await setup(page, { holdDate: '2026-10-15', rows: [position(1, '2026-10-15', { orders_cents: 55555 })] });
  await page.getByLabel('Data de referência do resumo', { exact: true }).fill('2026-10-15');
  await expect.poll(() => held.length).toBe(1);
  await page.getByLabel('Data de referência do resumo', { exact: true }).fill('2026-10-14');
  await expect(page.locator('.director-inputs-position')).toContainText('Nenhum indicador complementar informado em 14/10/2026');
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/rpc/read_director_inputs') && response.request().postDataJSON()?.p_reference_date === '2026-10-15');
  held[0](); await oldResponse;
  await expect(page.getByLabel('Data de referência do resumo', { exact: true })).toHaveValue('2026-10-14');
  await expect(page.getByLabel('Valor de pedido em sistema (R$)', { exact: true })).toHaveValue('');
  await expect(page.locator('.director-inputs-position')).toContainText('Nenhum indicador complementar informado em 14/10/2026');
  expect(calls.filter(call => call.name === 'read_director_inputs').at(-1)?.body.p_reference_date).toBe('2026-10-14');
});

test('saved observations are escaped and the dashboard action returns to the executive view', async ({ page }) => {
  const row = position(1, '2026-10-16', { orders_cents: 10000 }); row.observation = '<script>window.fixtureExecuted=true</script>';
  await setup(page, { rows: [row] }); await page.getByText('Conferir valores salvos desta data', { exact: true }).click();
  await expect(page.locator('.director-inputs-saved')).toContainText(row.observation);
  expect(await page.evaluate(() => (window as any).fixtureExecuted)).toBeUndefined();
  await page.getByRole('button', { name: 'Ir para o Painel Gerencial', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Painel Gerencial', exact: true })).toBeVisible();
});

for (const role of ['contas_pagar', 'contas_receber', 'diretor'] as const) test(`${role} cannot open the supplemental report input card or query its management RPC`, async ({ page }) => {
  const { calls } = await setup(page, { role });
  await expect(page.getByRole('tab', { name: 'Resumo da Diretoria', exact: true })).toHaveCount(0);
  await expect(submit(page)).toHaveCount(0);
  expect(calls.some(call => ['save_director_inputs', 'read_director_inputs'].includes(call.name))).toBe(false);
});

test('manager without the official summary write permission cannot open report inputs', async ({ page }) => {
  const { calls } = await setup(page, { noWrite: true });
  await expect(page.getByRole('tab', { name: 'Resumo da Diretoria', exact: true })).toHaveCount(0);
  expect(calls.some(call => ['save_director_inputs', 'read_director_inputs'].includes(call.name))).toBe(false);
});
