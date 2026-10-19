import { test, expect, type Page } from '@playwright/test';
const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const userId = '10000000-0000-4000-8000-000000000001', receiptId = '30000000-0000-4000-8000-000000000001', titleId = '40000000-0000-4000-8000-000000000001', collectorId = '50000000-0000-4000-8000-000000000001', ruleId = '60000000-0000-4000-8000-000000000001', savedId = '70000000-0000-4000-8000-000000000001';
const bands = [
  { band: 'ATE_30', label: '1–30 dias', reference_cents: 0, commission_reference_cents: 0 },
  { band: '31_60', label: '31–60 dias', reference_cents: 20000000, commission_reference_cents: 10000 },
  { band: '61_90', label: '61–90 dias', reference_cents: 10000000, commission_reference_cents: 30000 },
  { band: '91_180', label: '91–180 dias', reference_cents: 10000000, commission_reference_cents: 60000 },
  { band: '181_365', label: '181–365 dias', reference_cents: 8000000, commission_reference_cents: 100000 },
  { band: 'ACIMA_365', label: '>365 dias', reference_cents: 3500000, commission_reference_cents: 150000 },
];
function response(body: any, options: { unsafe?: boolean; pages?: boolean; pending?: boolean } = {}) {
  const seller = body.p_kind === 'SELLER', offset = Number(body.p_offset), count = options.pages ? 26 : 1, pending = !!options.pending;
  const base = { id: receiptId, source_revision: seller ? 'synthetic-closing-revision' : '0', date: '2026-10-16', document: 'NF-001', client_name: 'Cliente sintético', branch: 'FILIAL TESTE', subject: seller ? 'Funcionário sintético' : collectorId, subject_name: seller ? 'Funcionário sintético' : 'Responsável sintética', amount_cents: 9000,
    commission_cents: pending ? null : seller ? 45 : 5, rule_id: pending ? null : ruleId, rule_effective_from: pending ? null : '2026-10-01', rule_config: { bands, eligible_collector_ids: [collectorId] }, eligibility: pending ? 'PENDING_RULE' : 'ASSESSED', band: seller ? '10_15' : '31_60',
    ...(seller ? { product: 'Produto sintético', cost_center: 'PRIVADO', policy: 'COMMERCIAL', margin_cents: pending ? null : 1305, margin_bps: pending ? null : 1450, rate_bps: pending ? null : 50, cost_cents: 7500, freight_cents: 100, tax_cents: 50 }
      : { title_id: titleId, due_date: '2026-09-01', nominal_amount_cents: 10000, delay_days: 45, rate_numerator: 10000, rate_denominator: 20000000 }) };
  const number = seller ? 45 : 5;
  return { kind: body.p_kind, start: body.p_start, end: body.p_end, subject: body.p_subject, band: body.p_band,
    rows: options.pages ? Array.from({ length: Math.min(body.p_limit ?? 25, count - offset) }, (_, i) => ({ ...base, id: `30000000-0000-4000-8000-${String(offset + i + 1).padStart(12, '0')}`, document: `NF-${offset + i + 1}` })) : [base], count,
    total_amount_cents: options.unsafe ? Number.MAX_SAFE_INTEGER + 1 : 9000 * count, eligible_amount_cents: pending ? 0 : 9000 * count, commission_cents: pending ? 0 : number * count, margin_cents: seller ? 1305 * count : 0, pending_count: pending ? count : 0, assessed_count: pending ? 0 : count, average_delay_days: seller ? 0 : 45, complete: !pending,
    summaries: [{ subject: base.subject, subject_name: base.subject_name, count, amount_cents: 9000 * count, commission_cents: pending ? null : number * count, margin_cents: seller ? 1305 * count : null, pending_count: pending ? count : 0 }],
    bands: [{ band: base.band, count, amount_cents: 9000 * count, commission_cents: pending ? null : number * count, pending_count: pending ? count : 0 }],
    options: [{ id: base.subject, name: base.subject_name, enabled: true }],
    rule_versions: pending ? [] : [{ id: ruleId, kind: body.p_kind, subject: seller ? base.subject : '', effective_from: '2026-10-01', created_at: '2026-10-15T12:00:00Z', reason: 'Regra sintética confirmada', config: seller ? { policy: 'COMMERCIAL', minimum_margin_bps: 1000 } : { eligible_collector_ids: [collectorId], bands } }], collector_bands: bands,
    revision: 'a'.repeat(32), assessments: [{ id: savedId, kind: body.p_kind, period_start: body.p_start, period_end: body.p_end, subject: null, band: null, revision: 'b'.repeat(32), created_at: '2026-10-17T12:00:00Z' }] };
}
async function setup(page: Page, options: { missing?: boolean; unsafe?: boolean; pages?: boolean; failureOnRefresh?: boolean; manager?: boolean; export?: boolean; pending?: boolean } = {}) {
  const access = { profile: { id: userId, username: 'PessoaSintetica', display_name: 'Pessoa sintética', role_key: options.manager ? 'gerente_geral' : 'diretor', enabled: true }, permissions: [{ resource: 'comissoes', action: 'read' }, ...(options.manager ? [{ resource: 'comissoes', action: 'write' }, { resource: 'usuarios', action: 'admin' }] : []), ...(options.export ? [{ resource: 'comissoes', action: 'export' }] : [])], collector_id: null };
  const claims = { sub: userId, session_id: '20000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), role: 'authenticated' };
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-only'].join('.');
  const seen: any[] = [], writes: any[] = []; let latest: any;
  await page.route(`${project}/**`, async route => {
    const req = route.request(), url = new URL(req.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.invalid', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/current_access') return reply(access);
    if (url.pathname === '/rest/v1/rpc/commissions_report') {
      const body = req.postDataJSON(); seen.push(body);
      if (options.missing) return reply({ code: 'PGRST202', message: 'private SQL error' }, 404);
      if (options.failureOnRefresh && seen.length > 1) return reply({ message: 'private SQL error' }, 503);
      latest = response(body, options); return reply(latest);
    }
    if (url.pathname === '/rest/v1/rpc/configure_commission_rule' || url.pathname === '/rest/v1/rpc/save_commission_assessment') { writes.push({ rpc: url.pathname.split('/').at(-1), body: req.postDataJSON() }); return reply(ruleId); }
    if (url.pathname === '/rest/v1/rpc/restore_seller_commission_policy') { writes.push({ rpc: 'restore_seller_commission_policy', body: req.postDataJSON() }); return reply({ rule_ids: [ruleId], created_count: 1 }); }
    if (url.pathname === '/rest/v1/rpc/commission_assessment') return reply({ id: savedId, created_at: '2026-10-17T12:00:00Z', report: { ...latest, commission_cents: 3, revision: 'b'.repeat(32), rows: [{ ...latest.rows[0], commission_cents: 3 }], assessments: undefined } });
    if (url.pathname === '/rest/v1/profiles' || url.pathname === '/rest/v1/collection_agents' || url.pathname === '/rest/v1/collector_bindings') return reply([]);
    throw new Error(`Unexpected request ${req.method()} ${url.pathname}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('PessoaSintetica'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click();
  await expect(page.getByRole('heading', { name: 'Apuração de comissões das cobradoras' })).toBeVisible();
  return { seen, writes };
}
test('collector commission uses the actual amount, preserves nominal value in details, and Director stays read only', async ({ page }) => {
  await setup(page); const table = page.getByRole('table', { name: 'Recebimentos confirmados para comissões' });
  await expect(table.getByRole('cell', { name: 'R$ 90,00', exact: true })).toBeVisible(); await expect(table.getByRole('cell', { name: 'R$ 0,05', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir recebimento NF-001' }).click(); await expect(page.getByRole('heading', { name: 'Recebimento NF-001' })).toBeVisible();
  await expect(page.getByText('R$ 100,00', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Configurar comissões' })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Salvar apuração' })).toHaveCount(0); await expect(page.getByRole('button', { name: /Pagar comissão/ })).toHaveCount(0);
});
test('period, collector and receipt band filters reach the canonical server and restart pagination', async ({ page }) => {
  const { seen } = await setup(page); await expect(page.getByRole('table', { name: 'Recebimentos confirmados para comissões' })).toBeVisible();
  await page.getByLabel('Recebimento inicial', { exact: true }).fill('2026-09-01'); await page.getByLabel('Recebimento final', { exact: true }).fill('2026-09-30'); await page.getByRole('combobox', { name: 'Cobradora da comissão', exact: true }).selectOption(collectorId); await page.getByRole('combobox', { name: 'Faixa de atraso', exact: true }).selectOption('31_60');
  await page.getByRole('button', { name: 'Consultar comissões', exact: true }).click();
  await expect.poll(() => seen.at(-1)).toEqual({ p_kind: 'COLLECTOR', p_start: '2026-09-01', p_end: '2026-09-30', p_subject: collectorId, p_band: '31_60', p_offset: 0, p_limit: 25 });
});
test('commission receipt detail paginates on the server', async ({ page }) => {
  const { seen } = await setup(page, { pages: true }); await expect(page.getByText('26 item(ns) · página 1 de 2')).toBeVisible();
  await page.getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(page.getByText('26 item(ns) · página 2 de 2')).toBeVisible();
  expect(seen.at(-1).p_offset).toBe(25); await expect(page.getByRole('button', { name: 'Abrir recebimento NF-26' })).toBeVisible();
});
test('missing activation and unsafe monetary totals fail closed without exposing server errors or inventing totals', async ({ page }) => {
  await setup(page, { missing: true }); await expect(page.getByRole('alert')).toContainText('apuração de comissões precisa da atualização'); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByText('private SQL error')).toHaveCount(0);
});
test('unsafe monetary totals are rejected before rendering commission totals', async ({ page }) => {
  await setup(page, { unsafe: true }); await expect(page.getByRole('alert')).toContainText('Não foi possível consultar'); await expect(page.getByRole('table')).toHaveCount(0);
});
test('failed refresh clears stale detail and amounts for the Director', async ({ page }) => {
  await setup(page, { failureOnRefresh: true }); await page.getByRole('button', { name: 'Abrir recebimento NF-001' }).click(); await page.getByRole('button', { name: 'Atualizar comissões' }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível consultar'); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Recebimento NF-001' })).toHaveCount(0); await expect(page.getByText('private SQL error')).toHaveCount(0);
});
test('seller tab shows recalculated margin separately and makes a seller-specific server query', async ({ page }) => {
  const { seen } = await setup(page); await page.getByRole('tab', { name: 'Comissões — Vendedores' }).click();
  await expect(page.getByRole('heading', { name: 'Apuração de comissões dos vendedores' })).toBeVisible(); await expect(page.getByRole('table', { name: 'Vendas para comissões' })).toBeVisible(); expect(seen.at(-1).p_kind).toBe('SELLER');
  await page.getByRole('button', { name: 'Abrir venda NF-001' }).click(); await expect(page.getByText('Margem após comissão calculada', { exact: true })).toBeVisible(); await expect(page.getByText('14,5%', { exact: false }).last()).toBeVisible();
});
test('manager explicitly enables existing collectors with a new effective rule', async ({ page }) => {
  const { writes } = await setup(page, { manager: true, pending: true }); await page.getByRole('button', { name: 'Configurar comissões' }).click();
  await page.getByLabel('Responsável sintética', { exact: true }).check(); await page.getByLabel('Vigência a partir de', { exact: true }).fill('2026-10-01'); await page.getByLabel('Justificativa da regra', { exact: true }).fill('Ativar responsável sintética conforme regra vigente');
  await page.getByRole('button', { name: 'Salvar regra com vigência' }).click();
  await expect.poll(() => writes.at(-1)?.body).toEqual({ p_kind: 'COLLECTOR', p_effective_from: '2026-10-01', p_subject: '', p_config: { eligible_collector_ids: [collectorId] }, p_reason: 'Ativar responsável sintética conforme regra vigente' });
  await expect(page.getByText('Regra salva com vigência.', { exact: false })).toBeVisible();
});
test('manager recovers confirmed seller vigencies atomically after selecting the real employee', async ({ page }) => {
  const { writes } = await setup(page, { manager: true, pending: true }); await page.getByRole('tab', { name: 'Comissões — Vendedores' }).click(); await page.getByRole('button', { name: 'Configurar comissões' }).click();
  await page.getByRole('combobox', { name: 'Funcionário do fechamento', exact: true }).selectOption('Funcionário sintético'); await page.getByRole('combobox', { name: 'Política do vendedor', exact: true }).selectOption('MATEUS'); await expect(page.getByLabel('Margem mínima confirmada (%)', { exact: true })).toHaveValue('14');
  await page.getByLabel('Justificativa da regra', { exact: true }).fill('Recuperar regras vigentes confirmadas'); await page.getByRole('button', { name: 'Recuperar regras confirmadas' }).click();
  await expect.poll(() => writes.at(-1)).toEqual({ rpc: 'restore_seller_commission_policy', body: { p_subject: 'Funcionário sintético', p_policy: 'MATEUS', p_reason: 'Recuperar regras vigentes confirmadas' } });
});
test('saved assessments open their immutable figures and return to the current basis', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: /Abrir apuração/ }).click(); await expect(page.getByText('Apuração salva em', { exact: false })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Recebimentos confirmados para comissões' }).getByRole('cell', { name: 'R$ 0,03', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Voltar à base atual' }).click(); await expect(page.getByRole('table', { name: 'Recebimentos confirmados para comissões' }).getByRole('cell', { name: 'R$ 0,05', exact: true })).toBeVisible();
});
test('Excel export retrieves every page of the same revision and honors export permission', async ({ page }) => {
  const { seen } = await setup(page, { export: true, pages: true }); const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar Excel das comissões' }).click(); const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^Comissoes_Cobradoras_.*\.xlsx$/); expect(seen.some(body => body.p_limit === 1000)).toBe(true);
});
