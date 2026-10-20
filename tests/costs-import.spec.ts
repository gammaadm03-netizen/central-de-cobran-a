import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = '2026-10-20T15:00:00Z';
const id = (value: number) => `94000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const costImportId = id(10), previousCostImportId = id(11), closingImportId = id(20), recalculatedImportId = id(21);
const reference = '2026-10-20', month = '2026-10-01';
const source = { import_id: costImportId, reference_date: reference, file_name: 'Custos-sinteticos.xlsx', created_at: now };
const costRows = [
  { line_number: 2, code: '001-SINT-A', product: 'Produto sintético A', weight_kg: '0.5', unit_cost: '1.234567', source_lines: [2] },
  { line_number: 3, code: 'SINT-B', product: 'Produto sintético B', weight_kg: null, unit_cost: '5.25', source_lines: [3] },
];
interface Call { name: string; body: any }
interface Options { permission?: 'manager' | 'director' | 'no-costs'; conflict?: boolean; stale?: boolean; unknownCommit?: boolean; applyBlocked?: 'missing_cost' | 'zero_cost' | 'missing_quantity'; apply?: boolean; applyStale?: boolean; applyUnknown?: boolean; alreadyApplied?: boolean; noClosing?: boolean }

async function syntheticWorkbook(duplicate = false) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Custos sintéticos');
  sheet.addRow(['Produto: código', 'Produto: nome', 'peso', 'custo atual']);
  sheet.addRow(['001-SINT-A', 'Produto sintético A', .5, 1.234567]);
  sheet.addRow(['SINT-B', 'Produto sintético B', null, duplicate ? 0 : 5.25]);
  if (duplicate) sheet.addRow(['SINT-B', 'Produto sintético B', null, 5.25]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function costReport() {
  return { rows: costRows, count: costRows.length, revision: 'costs-revision-synthetic', source,
    quality: { zero_cost_count: 0, missing_cost_count: 0, missing_weight_count: 1 }, options: { reference_dates: [reference] } };
}
function commercialReport() {
  return { month, revision: 'closing-revision-synthetic', count: 0, rows: [], source: null,
    options: { months: [month], branches: [], centres: [], employees: [] },
    summary: { sale_cents: 0, margin_cents: null, margin_percent: null, filtered_sale_cents: 0, filtered_margin_cents: null, filtered_margin_percent: null, row_count: 0, filtered_count: 0, margin_missing_count: 0, filtered_margin_missing_count: 0 } };
}
function recalculation(options: Options) {
  const blocked = options.applyBlocked;
  const bad = !!blocked;
  const preview = { format_version: 'costs-recalculation-v1', month, cost_import_id: costImportId, previous_import_id: closingImportId,
    source: { import_id: closingImportId, month, file_name: 'Fechamento-sintetico.xlsx' }, cost_source: source,
    row_count: 1, matched_count: blocked === 'missing_cost' ? 0 : 1, missing_code_count: 0, missing_quantity_count: blocked === 'missing_quantity' ? 1 : 0,
    invalid_quantity_count: 0, missing_cost_count: blocked === 'missing_cost' ? 1 : 0, zero_cost_count: blocked === 'zero_cost' ? 1 : 0, missing_components_count: 0,
    can_apply: !bad, revision: 'recalculation-revision-synthetic',
    totals: { previous_cost_cents: 500, new_cost_cents: bad ? null : 370, previous_margin_cents: 1200, new_margin_cents: bad ? null : 1330 },
    rows: [{ id: id(30), line_number: 2, code: '001-SINT-A', product: 'Produto sintético A', invoice: 'NF-SINT-1', branch: 'FILIAL SINTÉTICA',
      quantity: blocked === 'missing_quantity' ? null : '3', unit_cost: blocked === 'missing_cost' ? null : blocked === 'zero_cost' ? '0' : '1.234567',
      previous_cost_cents: 500, new_cost_cents: bad ? null : 370, previous_margin_cents: 1200, new_margin_cents: bad ? null : 1330,
      error_codes: blocked ? [blocked.toUpperCase()] : [] }] };
  if (options.noClosing) return { ...preview, previous_import_id: null, source: null, row_count: 0, matched_count: 0, can_apply: false,
    totals: { previous_cost_cents: null, new_cost_cents: null, previous_margin_cents: null, new_margin_cents: null }, rows: [] };
  if (options.alreadyApplied) return { ...preview, previous_import_id: recalculatedImportId,
    source: { import_id: recalculatedImportId, month, file_name: 'Fechamento-sintetico-custos-aplicados.xlsx' }, already_applied: true, can_apply: false,
    totals: { previous_cost_cents: 370, new_cost_cents: 370, previous_margin_cents: 1330, new_margin_cents: 1330 },
    rows: preview.rows.map(row => ({ ...row, id: id(31), previous_cost_cents: 370, previous_margin_cents: 1330 })) };
  return preview;
}

async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(new Date(now));
  const permission = options.permission ?? 'manager';
  const permissions = permission === 'manager'
    ? [{ resource: 'importar_bases', action: 'read' }, { resource: 'margens', action: 'read' }, ...['read', 'import', 'write'].map(action => ({ resource: 'custos', action }))]
    : [{ resource: 'faturamento', action: 'read' }, ...(permission === 'director' ? [{ resource: 'importar_bases', action: 'read' }, { resource: 'custos', action: 'import' }] : [{ resource: 'importar_bases', action: 'read' }])];
  if (options.apply) permissions.push({ resource: 'faturamento', action: 'read' }, { resource: 'margens', action: 'read' }, { resource: 'fechamento', action: 'import' });
  const profile = { id: id(1), username: 'CustosSinteticos', display_name: 'Usuário sintético de custos', role_key: permission === 'director' ? 'diretor' : 'gerente_geral', enabled: true };
  const access = { profile, permissions, collector_id: null };
  const claims = { sub: profile.id, session_id: id(2), role: 'authenticated', exp: Math.floor(Date.parse(now) / 1000) + 3600 };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), Buffer.from('synthetic-only').toString('base64url')].join('.');
  const calls: Call[] = []; let commits = 0, applies = 0;
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postData() ? request.postDataJSON() : null; calls.push({ name, body });
    const reply = (json: any, status = 200) => route.fulfill({ json, status, headers });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: profile.id, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: now, app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (name === 'list_commercial_items') return reply(commercialReport());
    if (name === 'list_product_costs') return reply(costReport());
    if (name === 'list_product_cost_imports') return reply({ rows: [{ ...source, id: costImportId, row_count: 2, item_count: 2 }], count: 1 });
    if (name === 'business-import') {
      if (body.mode === 'costs_recalculation') {
        if (body.action === 'preview') return reply(recalculation(options));
        applies++;
        if (options.applyStale) return reply({ code: '40001', message: 'private closing revision' }, 409);
        if (options.applyUnknown && applies === 1) return reply({ error: 'private interrupted application' }, 503);
        return reply({ format_version: 'costs-recalculation-v1', import_id: recalculatedImportId, source_import_id: closingImportId, cost_import_id: costImportId, month, row_count: 1, idempotent: applies > 1, request_id: body.request_id });
      }
      if (body.mode !== 'costs') throw new Error(`Unexpected business mode: ${body.mode}`);
      const bytes = Buffer.from(body.file_base64, 'base64'), selected = body.resolutions?.['SINT-B'] === 4;
      const canonicalRows = costRows.map(row => options.conflict && row.code === 'SINT-B' ? { ...row, line_number: selected ? 4 : 3, unit_cost: selected ? '5.25' : null, source_lines: [3,4], duplicate_count: 1, cost_conflict: true, resolved: selected, selected_line_number: selected ? 4 : null } : row);
      if (body.action === 'preview') return reply({ format_version: 'costs-v1', file_sha256: createHash('sha256').update(bytes).digest('hex'), rows: canonicalRows,
        preview: { format_version: 'costs-v1', row_count: options.conflict ? 3 : 2, item_count: 2, reference_date: body.reference_date,
          previous_import_id: previousCostImportId, new_count: 1, changed_count: 1, unchanged_count: 0, zero_cost_count: 0, missing_cost_count: options.conflict && !selected ? 1 : 0, missing_weight_count: 1,
          conflicts: options.conflict ? [{ code: 'SINT-B', product: 'Produto sintético B', options: [{ line_number: 3, unit_cost: '0', weight_kg: null }, { line_number: 4, unit_cost: '5.25', weight_kg: null }], selected_line_number: selected ? 4 : null }] : [],
          can_commit: !options.conflict || selected } });
      commits++;
      if (options.stale) return reply({ code: '40001', message: 'private revision details' }, 409);
      if (options.unknownCommit && commits === 1) return reply({ error: 'private raw database text' }, 503);
      return reply({ format_version: 'costs-v1', import_id: costImportId, row_count: options.conflict ? 3 : 2, item_count: 2, reference_date: body.reference_date, idempotent: commits > 1 });
    }
    throw new Error(`Unexpected request: ${name}`);
  });
  await page.goto('/');
  await page.getByLabel('Usuário', { exact: true }).fill(profile.username); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  return calls;
}

async function openCosts(page: Page, options: Options = {}) {
  const calls = await setup(page, options);
  await page.getByRole('navigation', { name: 'Módulos da Central' }).getByRole('button', { name: 'Importar Bases', exact: true }).click();
  await page.getByRole('tab', { name: 'Custos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Importar custos por item', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Custos por item cadastrados', exact: true })).toBeVisible();
  return calls;
}
async function analyzeCosts(page: Page, duplicate = false) {
  const bytes = await syntheticWorkbook(duplicate);
  await page.getByLabel('Data de referência dos custos', { exact: true }).fill(reference);
  await page.getByLabel('Planilha de custos por item', { exact: true }).setInputFiles({ name: 'Custos-sinteticos.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
  await page.getByRole('button', { name: 'Analisar custos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferência dos custos', exact: true })).toBeVisible();
  return bytes;
}

test('Director cannot import costs despite stale grants, and a manager without costs import sees no Costs tab', async ({ page }) => {
  const calls = await setup(page, { permission: 'director' });
  await expect(page.getByRole('navigation', { name: 'Módulos da Central' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Importar Bases', exact: true })).toHaveCount(0);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  expect(calls.some(call => call.name === 'business-import' || call.name === 'list_product_costs')).toBe(false);
});

test('cost import permission is enforced independently of access to the Importar Bases module', async ({ page }) => {
  const calls = await setup(page, { permission: 'no-costs' });
  await page.getByRole('navigation', { name: 'Módulos da Central' }).getByRole('button', { name: 'Importar Bases', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Custos', exact: true })).toHaveCount(0);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  expect(calls.some(call => call.name === 'business-import' || call.name === 'list_product_costs')).toBe(false);
});

test('cost import preserves original bytes, leading-zero codes and six decimal unit precision until explicit confirmation', async ({ page }) => {
  const calls = await openCosts(page);
  const catalog = page.getByRole('table', { name: 'Custos por item cadastrados', exact: true });
  await expect(catalog.getByRole('cell', { name: '001-SINT-A', exact: true })).toBeVisible();
  await expect(catalog.getByRole('cell', { name: 'R$ 1,234567', exact: true })).toBeVisible();
  const bytes = await analyzeCosts(page);
  const commit = page.getByRole('button', { name: 'Confirmar importação dos custos', exact: true });
  await expect(commit).toBeDisabled();
  const sample = page.getByRole('table', { name: 'Amostra dos custos por produto', exact: true });
  await expect(sample.getByRole('cell', { name: 'R$ 1,234567', exact: true })).toBeVisible();
  await expect(sample.getByRole('cell', { name: '001-SINT-A', exact: true })).toBeVisible();
  const previews = calls.filter(call => call.name === 'business-import' && call.body.action === 'preview');
  expect(previews.at(-1)?.body).toMatchObject({ mode: 'costs', reference_date: reference, file_name: 'Custos-sinteticos.xlsx', file_base64: bytes.toString('base64'), resolutions: {} });
  expect(calls.some(call => call.name === 'business-import' && call.body.action === 'commit')).toBe(false);
  await page.getByRole('checkbox', { name: 'Conferi os custos, os valores zerados e as escolhas dos códigos repetidos.', exact: true }).check();
  await commit.click();
  await expect(page.getByRole('status').filter({ hasText: /Base de custos importada/ })).toBeVisible();
  const body = calls.filter(call => call.name === 'business-import' && call.body.action === 'commit').at(-1)?.body;
  expect(body).toEqual({ action: 'commit', mode: 'costs', reference_date: reference, file_name: 'Custos-sinteticos.xlsx', file_base64: bytes.toString('base64'), resolutions: {}, previous_import_id: previousCostImportId, complete: true });
  expect(body).not.toHaveProperty('rows');
});

test('divergent duplicate costs require a chosen source row and a new validated preview before import', async ({ page }) => {
  const calls = await openCosts(page, { conflict: true });
  const bytes = await analyzeCosts(page, true);
  const choice = page.getByRole('combobox', { name: 'Custo para o código SINT-B', exact: true });
  await expect(choice).toHaveValue('');
  const reviewed = page.getByRole('checkbox', { name: 'Conferi os custos, os valores zerados e as escolhas dos códigos repetidos.', exact: true });
  const commit = page.getByRole('button', { name: 'Confirmar importação dos custos', exact: true });
  await expect(reviewed).toBeDisabled(); await expect(commit).toBeDisabled();
  await choice.selectOption('4');
  await expect(page.getByRole('status').filter({ hasText: 'Escolhas alteradas.' })).toBeVisible();
  await expect(commit).toBeDisabled();
  await page.getByRole('button', { name: 'Validar escolhas dos custos', exact: true }).click();
  await expect(reviewed).toBeEnabled(); await expect(commit).toBeDisabled();
  const validated = calls.filter(call => call.name === 'business-import' && call.body.action === 'preview').at(-1)?.body;
  expect(validated.resolutions).toEqual({ 'SINT-B': 4 }); expect(validated.file_base64).toBe(bytes.toString('base64'));
  await reviewed.check(); await commit.click();
  await expect(page.getByRole('status').filter({ hasText: /Base de custos importada/ })).toBeVisible();
  expect(calls.filter(call => call.name === 'business-import' && call.body.action === 'commit').at(-1)?.body.resolutions).toEqual({ 'SINT-B': 4 });
});

test('a changed cost base blocks stale confirmation without exposing server error text', async ({ page }) => {
  const calls = await openCosts(page, { stale: true }); await analyzeCosts(page);
  await page.getByRole('checkbox', { name: 'Conferi os custos, os valores zerados e as escolhas dos códigos repetidos.', exact: true }).check();
  await page.getByRole('button', { name: 'Confirmar importação dos custos', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('A base mudou desde a análise');
  await expect(page.getByRole('button', { name: 'Confirmar importação dos custos', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Repetir confirmação pendente dos custos', exact: true })).toHaveCount(0);
  await expect(page.getByText('private revision details', { exact: false })).toHaveCount(0);
  expect(calls.filter(call => call.name === 'business-import' && call.body.action === 'commit')).toHaveLength(1);
});

test('an unknown import result freezes the original request and retries the exact same bytes and choices', async ({ page }) => {
  const calls = await openCosts(page, { unknownCommit: true }); await analyzeCosts(page);
  await page.getByRole('checkbox', { name: 'Conferi os custos, os valores zerados e as escolhas dos códigos repetidos.', exact: true }).check();
  await page.getByRole('button', { name: 'Confirmar importação dos custos', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Repetir confirmação pendente dos custos', exact: true }); await expect(retry).toBeVisible();
  await expect(page.getByLabel('Data de referência dos custos', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Planilha de custos por item', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Analisar custos', exact: true })).toBeDisabled();
  const first = calls.filter(call => call.name === 'business-import' && call.body.action === 'commit').at(-1)?.body;
  await expect(page.getByText('private raw database text', { exact: false })).toHaveCount(0);
  await retry.click();
  await expect(page.getByRole('status').filter({ hasText: /Esta base já estava registrada/ })).toBeVisible();
  const writes = calls.filter(call => call.name === 'business-import' && call.body.action === 'commit');
  expect(writes).toHaveLength(2); expect(writes[1].body).toEqual(first);
});

async function analyzeImpact(page: Page) {
  const section = page.locator('section.cost-closing-application');
  await expect(section.getByRole('heading', { name: 'Aplicar custos ao fechamento', exact: true })).toBeVisible();
  await section.getByLabel('Mês do fechamento para aplicar custos', { exact: true }).fill('2026-10');
  await section.getByRole('button', { name: 'Analisar impacto dos custos', exact: true }).click();
  await expect(section.getByRole('table', { name: 'Conferência do CMV e da margem por item', exact: true })).toBeVisible();
  return section;
}

test('applying costs reviews quantity times full unit precision and creates a new closing with both source IDs', async ({ page }) => {
  const calls = await openCosts(page, { apply: true });
  const section = await analyzeImpact(page), table = section.getByRole('table', { name: 'Conferência do CMV e da margem por item', exact: true });
  const detail = table.getByRole('row').nth(1).getByRole('cell');
  await expect(detail.nth(2)).toHaveText('3');
  await expect(detail.nth(3)).toHaveText('R$ 1,234567');
  await expect(detail.nth(4)).toHaveText('R$ 5,00');
  await expect(detail.nth(5)).toHaveText('R$ 3,70');
  await expect(detail.nth(6)).toHaveText('R$ 13,30');
  await expect(section.locator('.cost-application-summary > div').filter({ hasText: 'Novo CMV com a base de custos' })).toContainText('R$ 3,70');
  const commit = section.getByRole('button', { name: 'Aplicar custos e recalcular margens', exact: true }); await expect(commit).toBeDisabled();
  await section.getByRole('checkbox', { name: 'Conferi o impacto. Quero substituir o CMV e recalcular as margens deste mês em uma nova versão do fechamento.', exact: true }).check();
  await commit.click();
  await expect(section.getByRole('status')).toContainText('Custos aplicados e margens recalculadas');
  await expect(section.getByRole('status')).toContainText('fechamento anterior e os arquivos originais permanecem no histórico');
  const previews = calls.filter(call => call.name === 'business-import' && call.body.mode === 'costs_recalculation' && call.body.action === 'preview');
  expect(previews.at(-1)?.body).toEqual({ action: 'preview', mode: 'costs_recalculation', month, cost_import_id: costImportId });
  const write = calls.filter(call => call.name === 'business-import' && call.body.mode === 'costs_recalculation' && call.body.action === 'commit').at(-1)?.body;
  expect(write).toMatchObject({ action: 'commit', mode: 'costs_recalculation', month, cost_import_id: costImportId, previous_import_id: closingImportId, complete: true });
  expect(write.request_id).toMatch(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
  expect(write).not.toHaveProperty('file_base64'); expect(write).not.toHaveProperty('rows'); expect(write).not.toHaveProperty('new_cost_cents');
});

test('an already applied cost base preserves the existing closing without a false missing-data error or duplicate application', async ({ page }) => {
  const calls = await openCosts(page, { apply: true, alreadyApplied: true });
  const section = await analyzeImpact(page);
  await expect(section.getByRole('status')).toContainText('Os custos desta base já estão aplicados a este fechamento');
  await expect(section.getByRole('status')).toContainText('A versão existente está preservada');
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.getByText('Fechamento-sintetico-custos-aplicados.xlsx', { exact: false })).toBeVisible();
  const row = section.getByRole('table').getByRole('row').nth(1).getByRole('cell');
  await expect(row.nth(4)).toHaveText('R$ 3,70'); await expect(row.nth(5)).toHaveText('R$ 3,70'); await expect(row.nth(6)).toHaveText('R$ 13,30');
  await expect(section.getByRole('checkbox')).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Aplicar custos e recalcular margens', exact: true })).toBeDisabled();
  expect(calls.filter(call => call.name === 'business-import' && call.body.mode === 'costs_recalculation' && call.body.action === 'commit')).toHaveLength(0);
});

test('a month without a closing asks for the source file and does not invent zero costs or margins', async ({ page }) => {
  const calls = await openCosts(page, { apply: true, noClosing: true });
  const section = await analyzeImpact(page);
  await expect(section.getByRole('status')).toContainText('Importe primeiro o fechamento deste mês em Fechamento / Faturamento');
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.getByRole('table').getByRole('row')).toHaveCount(1);
  await expect(section.locator('.cost-application-summary').getByText('Não informado', { exact: true })).toHaveCount(4);
  await expect(section.getByText('R$ 0,00', { exact: true })).toHaveCount(0);
  await expect(section.getByRole('checkbox')).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Aplicar custos e recalcular margens', exact: true })).toBeDisabled();
  expect(calls.filter(call => call.name === 'business-import' && call.body.mode === 'costs_recalculation' && call.body.action === 'commit')).toHaveLength(0);
});

for (const [blocked, message] of [['missing_cost', 'Custo unitário não informado ou inválido'], ['zero_cost', 'Custo unitário zerado: confira o custo correto'], ['missing_quantity', 'Quantidade não informada no fechamento']] as const) {
  test(`applying costs blocks ${blocked} and keeps unknown calculated values unknown`, async ({ page }) => {
    const calls = await openCosts(page, { apply: true, applyBlocked: blocked });
    const section = await analyzeImpact(page);
    await expect(section.getByRole('alert')).toContainText('A aplicação está bloqueada');
    await expect(section.getByRole('cell', { name: message, exact: true })).toBeVisible();
    const row = section.getByRole('table').getByRole('row').nth(1).getByRole('cell');
    await expect(row.nth(5)).toHaveText('Não informado'); await expect(row.nth(6)).toHaveText('Não informado');
    await expect(section.getByRole('checkbox')).toBeDisabled();
    await expect(section.getByRole('button', { name: 'Aplicar custos e recalcular margens', exact: true })).toBeDisabled();
    expect(calls.filter(call => call.name === 'business-import' && call.body.mode === 'costs_recalculation' && call.body.action === 'commit')).toHaveLength(0);
  });
}

test('a closing revision change rejects application and requires a new impact preview', async ({ page }) => {
  const calls = await openCosts(page, { apply: true, applyStale: true });
  const section = await analyzeImpact(page);
  await section.getByRole('checkbox').check(); await section.getByRole('button', { name: 'Aplicar custos e recalcular margens', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('A base mudou desde a análise');
  await expect(section.getByRole('table')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Repetir aplicação pendente', exact: true })).toHaveCount(0);
  await expect(page.getByText('private closing revision', { exact: false })).toHaveCount(0);
  expect(calls.filter(call => call.name === 'business-import' && call.body.mode === 'costs_recalculation' && call.body.action === 'commit')).toHaveLength(1);
});

test('an interrupted application freezes month and cost selection and repeats the same protocol', async ({ page }) => {
  const calls = await openCosts(page, { apply: true, applyUnknown: true });
  const section = await analyzeImpact(page);
  await section.getByRole('checkbox').check(); await section.getByRole('button', { name: 'Aplicar custos e recalcular margens', exact: true }).click();
  const retry = section.getByRole('button', { name: 'Repetir aplicação pendente', exact: true }); await expect(retry).toBeVisible();
  await expect(section.getByLabel('Mês do fechamento para aplicar custos', { exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Versão da base de custos', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Planilha de custos por item', { exact: true })).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Analisar impacto dos custos', exact: true })).toBeDisabled();
  const first = calls.filter(call => call.name === 'business-import' && call.body.mode === 'costs_recalculation' && call.body.action === 'commit').at(-1)?.body;
  await retry.click();
  await expect(section.getByRole('status')).toContainText('Esta aplicação já estava registrada');
  const writes = calls.filter(call => call.name === 'business-import' && call.body.mode === 'costs_recalculation' && call.body.action === 'commit');
  expect(writes).toHaveLength(2); expect(writes[1].body).toEqual(first);
  await expect(page.getByText('private interrupted application', { exact: false })).toHaveCount(0);
});
