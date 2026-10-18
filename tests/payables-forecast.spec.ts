import { test, expect, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = new Date('2026-10-18T15:00:00Z');
const identifier = (value: number) => `71000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
type Role = 'gerente_geral' | 'contas_pagar' | 'diretor';
interface Options { role?: Role; noImport?: boolean; missing?: boolean; failSave?: boolean; conflict?: boolean; failRead?: boolean; manyPlans?: boolean; ambiguous?: boolean }
function fixture() {
  const rules = [
    { id: identifier(10), rule_key: 'SALARIOS', label: 'Salários', macro: 'SALÁRIOS', amount_cents: 1234500, day_of_month: 5, effective_from: '2026-10-18', created_at: now.toISOString() },
    { id: identifier(11), rule_key: 'SALARIOS_SOCIOS', label: 'Salários Sócios', macro: 'SALÁRIOS', amount_cents: 234500, day_of_month: 5, effective_from: '2026-10-18', created_at: now.toISOString() },
    { id: identifier(12), rule_key: 'ADIANTAMENTO', label: 'Adiantamento', macro: 'ADIANTAMENTO', amount_cents: 45000, day_of_month: 20, effective_from: '2026-10-18', created_at: now.toISOString() },
    { id: identifier(13), rule_key: 'ADIANTAMENTO_SOCIOS', label: 'Adiantamento Sócios', macro: 'ADIANTAMENTO', amount_cents: 55000, day_of_month: 20, effective_from: '2026-10-18', created_at: now.toISOString() },
  ];
  const weeks = Array.from({ length: 8 }, (_, index) => {
    const start = new Date('2026-10-17T12:00:00Z'); start.setUTCDate(start.getUTCDate() + index * 7); const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), real_cents: index === 0 ? 70000 : 0, estimated_cents: index === 0 ? 80000 : 0, known_estimated_cents: index === 0 ? 80000 : 0, total_cents: index === 0 ? 150000 : 0, cheques_cents: index === 0 ? 12500 : 0, cheque_count: index === 0 ? 1 : 0, title_count: index === 0 ? 2 : 0,
      macros: [{ macro: 'ADIANTAMENTO', real_cents: index === 0 ? 20000 : 0, estimated_cents: index === 0 ? 80000 : 0, total_cents: index === 0 ? 100000 : 0 }, { macro: 'FIXO', real_cents: index === 0 ? 50000 : 0, estimated_cents: 0, total_cents: index === 0 ? 50000 : 0 }],
      provisions: index === 0 ? [
        { rule_key: 'ADIANTAMENTO', label: 'Adiantamento', macro: 'ADIANTAMENTO', month: '2026-10-01', due_date: '2026-10-20', expected_cents: 45000, actual_cents: 20000, remaining_cents: 25000 as number | null, completion_id: null as string | null, done: false, issues: [] as string[], rule_id: identifier(12) },
        { rule_key: 'ADIANTAMENTO_SOCIOS', label: 'Adiantamento Sócios', macro: 'ADIANTAMENTO', month: '2026-10-01', due_date: '2026-10-20', expected_cents: 55000, actual_cents: 0, remaining_cents: 55000 as number | null, completion_id: null as string | null, done: false, issues: [] as string[], rule_id: identifier(13) },
      ] : [],
    };
  });
  return { as_of_date: '2026-10-18', start_date: weeks[0].start, end_date: weeks[7].end, latest_import_id: identifier(20) as string | null, latest_import_at: now.toISOString(), weeks, rules, plans: [{ plan: 'SALÁRIO TESTE', macro: 'SALÁRIOS', rule_key: null as string | null, mapping_id: null as string | null, configured: false, effective_from: null as string | null }], missing_sources: [] as string[] };
}
async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(now); const role = options.role ?? 'gerente_geral'; const id = identifier(1);
  const permissions = ['painel', 'caixa', 'contas_pagar'].map(resource => ({ resource, action: 'read' }));
  if (role !== 'diretor') permissions.push({ resource: 'contas_pagar', action: 'write' }, { resource: 'contas_pagar', action: 'import' });
  if (role === 'gerente_geral') permissions.push({ resource: 'usuarios', action: 'admin' });
  const access = { profile: { id, username: 'PessoaTeste', display_name: 'Pessoa Teste', role_key: role, enabled: true }, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, session_id: identifier(2), exp: Math.floor(now.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const report = fixture(); const calls: { name: string; body: any }[] = [];
  if (options.noImport) { report.latest_import_id = null; report.missing_sources = ['NO_IMPORT']; }
  if (options.manyPlans) report.plans = Array.from({ length: 25 }, (_, index) => ({ plan: index === 0 ? '<script>window.syntheticExecuted=true</script>' : `PLANO TESTE ${String(index + 1).padStart(2, '0')}`, macro: 'SALÁRIOS', rule_key: null, mapping_id: null, configured: false, effective_from: null }));
  await page.route(`${project}/**`, async route => {
    const request = route.request(); const url = new URL(request.url()); const name = url.pathname.split('/').at(-1)!; const body = request.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range', 'content-range': '*/0' };
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' } });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'synthetic@test.invalid', created_at: now.toISOString(), app_metadata: {}, user_metadata: {} });
    calls.push({ name, body });
    if (name === 'current_access') return reply(access);
    if (name === 'payables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (['payable_review_titles', 'payable_financial_titles'].includes(name)) return reply({ code: 'PGRST205' }, 404);
    if (['get_payable_payment_accounts', 'payable_payment_summary', 'list_payable_payments', 'get_payables_revision', 'get_payable_month_status', 'payables_month_status', 'list_payable_month_closures'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'director_report') return reply({ code: 'PGRST202' }, 404);
    if (name === 'cash_position') return reply({ accounts: [], total_cents: null, reported_accounts: 0, expected_accounts: 17, latest_position_date: null });
    if (name === 'current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (name === 'payables_summary' || name === 'receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (name === 'payables_forecast') {
      if (options.missing) return reply({ code: 'PGRST202', message: 'private SQL query' }, 404);
      if (options.failRead) return reply({ code: 'XX000', message: 'private SQL query' }, 503);
      const response = structuredClone(report);
      if (options.noImport) for (const week of response.weeks) { (week as any).real_cents = null; (week as any).estimated_cents = null; (week as any).total_cents = null; (week as any).cheques_cents = null; }
      if (options.ambiguous) { const provision = response.weeks[0].provisions[0]; (provision as any).actual_cents = null; provision.remaining_cents = null; provision.issues = ['Há versões ou parcelas do mesmo lançamento no mês. Confira e conclua o ciclo quando não houver previsão restante.', 'private SQL query']; (response.weeks[0] as any).estimated_cents = null; (response.weeks[0] as any).total_cents = null; }
      return reply(response);
    }
    if (['save_payable_forecast_rule', 'map_payable_forecast_plan', 'set_payable_forecast_completion'].includes(name)) {
      if (options.failSave || options.conflict) return reply({ code: options.conflict ? '40001' : 'XX000', message: 'private SQL query' }, 409);
      if (name === 'save_payable_forecast_rule') { const rule = report.rules.find(item => item.rule_key === body.p_rule_key)!; rule.id = identifier(99); rule.amount_cents = body.p_amount_cents; rule.day_of_month = body.p_day_of_month; rule.effective_from = body.p_effective_from; }
      if (name === 'map_payable_forecast_plan') { const plan = report.plans.find(item => item.plan === body.p_plan)!; plan.mapping_id = identifier(99); plan.configured = true; plan.rule_key = body.p_rule_key; plan.effective_from = body.p_effective_from; }
      if (name === 'set_payable_forecast_completion') { const provision = report.weeks.flatMap(week => week.provisions).find(item => item.rule_key === body.p_rule_key && item.month === body.p_month)!; provision.done = body.p_done; provision.completion_id = identifier(99); provision.remaining_cents = body.p_done ? 0 : Math.max(provision.expected_cents - provision.actual_cents, 0); }
      return reply(identifier(99));
    }
    if (name === 'payable_macros') return reply([{ name: 'SALÁRIOS' }, { name: 'ADIANTAMENTO' }]);
    if (name === 'payable_titles') return route.fulfill({ status: 200, headers: { ...headers, 'content-range': '0-0/1' }, json: [{ id: identifier(30), scope: 'grupo-consolidado', source_key: 'synthetic', entry_number: 'S1', description: 'Fornecedor sintético preservado', due_date: '2026-10-20', amount_cents: 70000, source_status: 'ABERTO', plan: 'SALÁRIO TESTE', bank_account: 'Banco Teste', branch: 'Filial Teste', issued_on: '2026-10-01', macro: 'SALÁRIOS', status: 'NEW', settled_at: null }] });
    if (['payable_imports', 'payable_plan_mappings', 'director_positions'].includes(name)) return reply([]);
    throw new Error(`Unexpected offline request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('PessoaTeste'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click(); await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Contas a Pagar', exact: true }).click(); await expect(page.getByText('Carregando as 8 semanas financeiras…', { exact: true })).toHaveCount(0);
  return { report, calls, forecast: page.locator('.payable-forecast') };
}
async function configure(page: Page) { await page.locator('.payable-forecast-configuration > summary').click(); }
async function editRule(page: Page) { await configure(page); await page.getByRole('button', { name: 'Editar Salários', exact: true }).click(); await page.getByLabel('Observação da alteração', { exact: true }).fill('Regra conferida pela gerência.'); }

test('8 financial weeks start Saturday and end Friday; residual excludes linked actual and cheque is a separate subtotal', async ({ page }) => {
  const { forecast, calls } = await setup(page);
  await expect(forecast.locator('.payable-forecast-overview tbody tr')).toHaveCount(8);
  const first = forecast.locator('.payable-forecast-overview tbody tr').first(); await expect(first).toContainText('17/10/2026 a 23/10/2026'); await expect(first).toContainText('R$ 700,00'); await expect(first).toContainText('R$ 800,00'); await expect(first).toContainText('R$ 1.500,00');
  await forecast.locator('.payable-forecast-week > summary').first().click(); await expect(forecast.locator('.payable-cheques').first()).toContainText('CHEQUES DA SEMANA'); await expect(forecast.locator('.payable-cheques').first()).toContainText('R$ 125,00'); await expect(forecast.locator('.payable-cheques').first()).toContainText('já incluído');
  const provision = forecast.locator('.payable-forecast-provision').first(); await expect(provision).toContainText('Previsão R$ 450,00'); await expect(provision).toContainText('Real vinculado R$ 200,00'); await expect(provision).toContainText('Residual R$ 250,00');
  expect(calls.filter(call => call.name === 'payables_forecast')[0].body).toEqual({ p_start: null });
  await page.getByLabel('Pesquisar histórico / favorecido').fill('Outro fornecedor'); expect(calls.filter(call => call.name === 'payables_forecast')).toHaveLength(1);
});

test('missing full import never becomes a zero financial projection', async ({ page }) => {
  const { forecast } = await setup(page, { noImport: true });
  await expect(forecast).toContainText('RELATÓRIO COMPLETO AGUARDANDO IMPORTAÇÃO');
  await expect(forecast.locator('.payable-forecast-metrics')).not.toContainText('R$ 0,00'); await expect(forecast.locator('.payable-forecast-metrics')).toContainText('Aguardando informações');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('director can inspect forecasts but has no rule, binding or completion write controls', async ({ page }) => {
  const { forecast, calls } = await setup(page, { role: 'diretor' }); await configure(page); await forecast.locator('.payable-forecast-week > summary').first().click();
  await expect(forecast.getByRole('button', { name: /^Editar / })).toHaveCount(0); await expect(forecast.getByRole('button', { name: /^Vincular / })).toHaveCount(0); await expect(forecast.getByRole('button', { name: 'Marcar como atendida' })).toHaveCount(0);
  expect(calls.some(call => call.name.startsWith('save_') || call.name.startsWith('map_') || call.name.startsWith('set_'))).toBe(false);
});

test('CP can bind a plan and attend estimates but cannot change the central rule values', async ({ page }) => {
  const { forecast } = await setup(page, { role: 'contas_pagar' }); await configure(page); await forecast.locator('.payable-forecast-week > summary').first().click();
  await expect(forecast.getByRole('button', { name: /^Editar / })).toHaveCount(0); await expect(forecast.getByRole('button', { name: 'Vincular SALÁRIO TESTE' })).toBeVisible(); await expect(forecast.getByRole('button', { name: 'Marcar como atendida' })).toHaveCount(2);
});

test('manager rule reads its initial value from the database; cancelled confirmation never writes; save retains exact cents and revision', async ({ page }) => {
  const { calls } = await setup(page); await editRule(page); await expect(page.getByLabel('Valor da previsão (R$)')).toHaveValue('12345,00');
  await page.getByLabel('Valor da previsão (R$)').fill('12.345,67'); await page.getByLabel('Dia do vencimento mensal').fill('17'); await page.getByLabel('Início da vigência').fill('2026-11-01');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Salvar regra de previsão' }).click(); expect(calls.filter(call => call.name === 'save_payable_forecast_rule')).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar regra de previsão' }).click(); await expect(page.getByText('Alteração registrada com histórico e auditoria.')).toBeVisible();
  expect(calls.find(call => call.name === 'save_payable_forecast_rule')?.body).toEqual({ p_rule_key: 'SALARIOS', p_amount_cents: 1234567, p_day_of_month: 17, p_effective_from: '2026-11-01', p_observation: 'Regra conferida pela gerência.', p_expected_id: identifier(10) });
});

test('negative amounts, excess decimal precision and unsafe cents are rejected without a request', async ({ page }) => {
  const { calls } = await setup(page); await editRule(page);
  for (const amount of ['-0,01', '1,234', '90071992547409,92']) { await page.getByLabel('Valor da previsão (R$)').fill(amount); await page.getByRole('button', { name: 'Salvar regra de previsão' }).click(); await expect(page.locator('.payable-forecast').getByRole('alert')).toContainText('até duas casas decimais'); }
  expect(calls.filter(call => call.name === 'save_payable_forecast_rule')).toHaveLength(0);
});

test('explicit zero is a valid rule amount with exact safe-integer boundary', async ({ page }) => {
  const { calls } = await setup(page); await editRule(page); await page.getByLabel('Valor da previsão (R$)').fill('0,00'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar regra de previsão' }).click(); await expect(page.getByText('Alteração registrada com histórico e auditoria.')).toBeVisible();
  expect(calls.find(call => call.name === 'save_payable_forecast_rule')?.body.p_amount_cents).toBe(0);
  await page.getByRole('button', { name: 'Editar Salários', exact: true }).click(); await page.getByLabel('Valor da previsão (R$)').fill('90071992547409,91'); await page.getByLabel('Observação da alteração').fill('Limite sintético de precisão.'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar regra de previsão' }).click();
  await expect(page.getByText('Alteração registrada com histórico e auditoria.')).toBeVisible(); expect(calls.filter(call => call.name === 'save_payable_forecast_rule').at(-1)?.body.p_amount_cents).toBe(Number.MAX_SAFE_INTEGER);
});

test('plan NONE is an explicit persisted decision and an unclassified plan is never guessed from its name', async ({ page }) => {
  const { calls } = await setup(page, { role: 'contas_pagar' }); await configure(page); await expect(page.getByText('Vínculo pendente', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Vincular SALÁRIO TESTE' }).click(); await expect(page.getByLabel('Previsão vinculada ao plano')).toHaveValue('');
  await page.getByLabel('Previsão vinculada ao plano').selectOption('NONE'); await page.getByLabel('Observação da alteração').fill('Plano conferido: não substitui previsão fixa.'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar vínculo do plano' }).click();
  await expect(page.getByText('Nenhuma previsão fixa', { exact: true })).toBeVisible(); expect(calls.find(call => call.name === 'map_payable_forecast_plan')?.body).toEqual({ p_plan: 'SALÁRIO TESTE', p_rule_key: null, p_effective_from: '2026-10-18', p_observation: 'Plano conferido: não substitui previsão fixa.', p_expected_id: null });
});

test('attending and reopening a monthly estimate require confirmation and preserve optimistic completion identity', async ({ page }) => {
  const { forecast, calls } = await setup(page, { role: 'contas_pagar' }); await forecast.locator('.payable-forecast-week > summary').first().click(); await forecast.getByRole('button', { name: 'Marcar como atendida' }).first().click(); await page.getByLabel('Observação da alteração').fill('Previsão conferida como atendida.');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('nenhuma baixa financeira'); return dialog.accept(); }); await page.getByRole('button', { name: 'Confirmar estimativa atendida' }).click(); await expect(page.getByText('Alteração registrada com histórico e auditoria.')).toBeVisible();
  await forecast.getByRole('button', { name: 'Reabrir estimativa', exact: true }).click(); await page.getByLabel('Observação da alteração').fill('Reabertura conferida por CP.'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar reabertura' }).click(); await expect(page.getByText('Alteração registrada com histórico e auditoria.')).toBeVisible();
  const writes = calls.filter(call => call.name === 'set_payable_forecast_completion'); expect(writes[0].body).toMatchObject({ p_rule_key: 'ADIANTAMENTO', p_month: '2026-10-01', p_done: true, p_expected_id: null }); expect(writes[1].body).toMatchObject({ p_done: false, p_expected_id: identifier(99) });
});

test('uncertain write preserves the draft and blocks another save until a fresh read succeeds', async ({ page }) => {
  const options: Options = { failSave: true }; const { calls } = await setup(page, options); await editRule(page); await page.getByLabel('Valor da previsão (R$)').fill('1.234,56'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar regra de previsão' }).click(); await expect(page.locator('.payable-forecast').getByRole('alert')).toContainText('Não foi possível confirmar o salvamento'); await expect(page.getByRole('button', { name: 'Salvar regra de previsão' })).toBeDisabled(); await expect(page.getByLabel('Valor da previsão (R$)')).toHaveValue('1.234,56');
  options.failRead = true; await page.getByRole('button', { name: 'Atualizar previsão' }).click(); await expect(page.getByRole('button', { name: 'Salvar regra de previsão' })).toBeDisabled(); options.failRead = false; await page.getByRole('button', { name: 'Atualizar previsão' }).click(); await expect(page.getByRole('button', { name: 'Salvar regra de previsão' })).toBeEnabled(); expect(calls.filter(call => call.name === 'save_payable_forecast_rule')).toHaveLength(1); await expect(page.getByText('private SQL query')).toHaveCount(0);
});

test('optimistic conflict gives a friendly explanation and never falsely reports success', async ({ page }) => {
  await setup(page, { conflict: true }); await editRule(page); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar regra de previsão' }).click(); await expect(page.locator('.payable-forecast').getByRole('alert')).toContainText('alterada por outro usuário'); await expect(page.getByText('Alteração registrada com histórico e auditoria.')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Salvar regra de previsão' })).toBeDisabled();
});

test('missing migration is explained without blocking the previous list of titles', async ({ page }) => {
  const { forecast } = await setup(page, { missing: true }); await expect(forecast.getByRole('alert')).toContainText('atualização 014'); await expect(page.getByRole('cell', { name: 'Fornecedor sintético preservado', exact: true })).toBeVisible(); await expect(page.getByText('private SQL query')).toHaveCount(0);
});

test('a non-Saturday selection never changes the database period; Saturday is sent explicitly', async ({ page }) => {
  const { calls } = await setup(page); await page.getByLabel('Sábado inicial da previsão').fill('2026-10-19'); await page.getByRole('button', { name: 'Consultar período', exact: true }).click(); await expect(page.locator('.payable-forecast').getByRole('alert')).toContainText('Selecione um sábado'); expect(calls.filter(call => call.name === 'payables_forecast')).toHaveLength(1);
  await page.getByLabel('Sábado inicial da previsão').fill('2026-10-24'); await page.getByRole('button', { name: 'Consultar período', exact: true }).click(); await expect.poll(() => calls.filter(call => call.name === 'payables_forecast').at(-1)?.body.p_start).toBe('2026-10-24');
});

test('plan configuration paginates and escapes imported plan names', async ({ page }) => {
  const { forecast } = await setup(page, { manyPlans: true }); await configure(page); const plans = forecast.locator('.payable-forecast-configuration table').nth(1); await expect(plans.locator('tbody tr')).toHaveCount(20); await expect(forecast.getByText('<script>window.syntheticExecuted=true</script>', { exact: true })).toBeVisible(); expect(await page.evaluate(() => (window as any).syntheticExecuted)).toBeUndefined(); await forecast.getByRole('button', { name: 'Próximos planos' }).click(); await expect(plans.locator('tbody tr')).toHaveCount(5); await page.getByLabel('Pesquisar plano para previsão').fill('PLANO TESTE 03'); await expect(plans.locator('tbody tr')).toHaveCount(1);
});

test('ambiguous launch versions show the exact business reason while concealing unknown technical details', async ({ page }) => {
  const { forecast } = await setup(page, { ambiguous: true }); await forecast.locator('.payable-forecast-week > summary').first().click();
  const provision = forecast.locator('.payable-forecast-provision').first(); await expect(provision).toContainText('Há versões ou parcelas do mesmo lançamento no mês. Confira e conclua o ciclo quando não houver previsão restante.'); await expect(provision).toContainText('Real vinculado Aguardando informações'); await expect(provision).toContainText('Residual Aguardando informações'); await expect(page.getByText('private SQL query')).toHaveCount(0);
});
