import { test, expect, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const userId = '10000000-0000-4000-8000-000000000001', importId = '30000000-0000-4000-8000-000000000001';
function row(index: number, missing = false) { return { id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`, import_id: importId, line_number: index + 1, code: `ITEM-${index}`, product: `Produto sintético ${index}`, client: 'Cliente sintético', employee: 'Pessoa sintética', invoice: `NF-${index}`, cost_center: 'PRIVADO', branch: 'FILIAL TESTE', issued_on: '2026-10-01', quantity: 1, sale_cents: 10000, freight_cents: missing ? null : 0, tax_cents: missing ? null : 500, cost_cents: missing ? null : 7500, commission_cents: missing ? null : 0, margin_cents: missing ? null : 2000, margin_percent: missing ? null : 20, margin_source: missing ? 'UNAVAILABLE' : 'PROVIDED' }; }
interface Options { import?: boolean; export?: boolean; missing?: boolean; empty?: boolean; unsafe?: boolean; failRefresh?: boolean; changedExport?: boolean; pages?: boolean; salesOnlyHr?: boolean }
async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(new Date('2026-10-19T15:00:00Z'));
  const permissions = [{ resource: 'faturamento', action: 'read' }];
  if (!options.salesOnlyHr) permissions.push({ resource: 'margens', action: 'read' });
  if (options.export) permissions.push({ resource: 'faturamento', action: 'export' }, { resource: 'margens', action: 'export' });
  if (options.import) permissions.push({ resource: 'importar_bases', action: 'read' }, { resource: 'fechamento', action: 'import' });
  const access = { profile: { id: userId, username: 'PessoaSintetica', display_name: 'Pessoa sintética', role_key: options.salesOnlyHr ? 'rh_dp' : options.import ? 'gerente_geral' : 'diretor', enabled: true }, permissions, collector_id: null };
  const claims = { sub: userId, session_id: '20000000-0000-4000-8000-000000000001', exp: Math.floor(new Date('2026-10-19T15:00:00Z').getTime() / 1000) + 3600, role: 'authenticated' };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), Buffer.from('synthetic').toString('base64url')].join('.');
  const calls: { name: string; body: any }[] = []; let reads = 0;
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json });
    const name = url.pathname.split('/').at(-1)!;
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: '2026-10-19T15:00:00Z', app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    const body = request.postDataJSON(); calls.push({ name, body });
    if (name === 'list_commercial_items') {
      reads++;
      if (options.failRefresh && reads > 1) return reply({ code: 'XX000', message: 'private SQL error' }, 503);
      const count = options.empty ? 0 : options.pages ? 26 : 1, offset = body.p_offset ?? 0, size = body.p_limit ?? 25;
      return reply({ month: body.p_month || '2026-10-01', revision: options.changedExport && reads > 2 ? 'changed' : 'revision-1', count, rows: Array.from({ length: Math.min(size, Math.max(0, count - offset)) }, (_, index) => (() => { const item: Record<string, unknown> = row(offset + index + 1, options.missing); if (options.salesOnlyHr) for (const key of ['cost_cents', 'freight_cents', 'tax_cents', 'commission_cents', 'margin_cents', 'margin_percent', 'margin_source']) delete item[key]; return item; })()), source: options.empty ? null : { import_id: importId, month: '2026-10-01', file_name: 'Fechamento_sintetico.xlsx', updated_at: '2026-10-19T14:00:00Z' }, options: { months: ['2026-10-01', '2026-09-01'], branches: ['FILIAL TESTE'], centres: ['PRIVADO'], employees: ['Pessoa sintética'] }, summary: { sale_cents: options.unsafe ? Number.MAX_SAFE_INTEGER + 1 : count * 10000, margin_cents: options.missing || options.salesOnlyHr ? null : count * 2000, margin_percent: options.missing || options.salesOnlyHr ? null : 20, filtered_sale_cents: count * 10000, filtered_margin_cents: options.missing || options.salesOnlyHr ? null : count * 2000, filtered_margin_percent: options.missing || options.salesOnlyHr ? null : 20, row_count: count, filtered_count: count, margin_missing_count: options.salesOnlyHr ? null : options.missing ? count : 0, filtered_margin_missing_count: options.salesOnlyHr ? null : options.missing ? count : 0 } });
    }
    if (name === 'business-import') {
      const buffer = Buffer.from(body.file_base64, 'base64');
      if (body.action === 'preview') return reply({ rows: [row(1)], file_sha256: createHash('sha256').update(buffer).digest('hex'), preview: { row_count: 1, month: body.month, previous_import_id: null, sale_cents: 10000, margin_cents: 2000, margin_missing_count: 0 } });
      return reply({ import_id: importId, row_count: 1, month: body.month, idempotent: false });
    }
    throw new Error(`Unexpected request: ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('PessoaSintetica'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click();
  await expect(page.getByRole('heading', { name: 'Faturamento por item' })).toBeVisible();
  return calls;
}

test('sales filters reach the server, paginate all closing items, and open item provenance read only', async ({ page }) => {
  const calls = await setup(page, { pages: true });
  await expect(page.getByText('26 item(ns) · página 1 de 2')).toBeVisible();
  await page.getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(page.getByRole('button', { name: 'Abrir item ITEM-26', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Centro de custo', exact: true }).selectOption('PRIVADO');
  await expect.poll(() => calls.at(-1)?.body.p_centre).toBe('PRIVADO'); expect(calls.at(-1)?.body.p_offset).toBe(0);
  await page.getByLabel('Buscar item', { exact: true }).fill('NF-1'); await expect.poll(() => calls.at(-1)?.body.p_search).toBe('NF-1');
  await page.getByRole('button', { name: 'Abrir item ITEM-1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Item ITEM-1 · NF NF-1', exact: true })).toBeVisible();
  await expect(page.getByText('Margem final informada no arquivo, sem novo desconto dos componentes.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Importar fechamento', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Baixar Excel', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/central-faturamento-013.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/central-faturamento-mobile-013.png' });
});

test('margins preserve the closing margin and filter by the original final margin bands', async ({ page }) => {
  const calls = await setup(page); await page.getByRole('navigation').getByRole('button', { name: 'Fechamento', exact: true }).click();
  const table = page.getByRole('table', { name: 'Margens por item do fechamento' }); await expect(table).toBeVisible();
  await expect(table.getByRole('cell', { name: 'R$ 20,00', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '20,00%', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Faixa de margem final', exact: true }).selectOption('lt10'); await expect.poll(() => calls.at(-1)?.body.p_margin_band).toBe('lt10');
  await page.getByRole('combobox', { name: 'Funcionário', exact: true }).selectOption('Pessoa sintética'); await expect.poll(() => calls.at(-1)?.body.p_employee).toBe('Pessoa sintética');
});

test('missing cost components keep margin unknown instead of reporting a zero cost or margin', async ({ page }) => {
  await setup(page, { missing: true }); await page.getByRole('navigation').getByRole('button', { name: 'Fechamento', exact: true }).click();
  const table = page.getByRole('table', { name: 'Margens por item do fechamento' }); await expect(table).toBeVisible();
  await expect(table.getByRole('cell', { name: 'Não informado', exact: true })).toHaveCount(6); await expect(table.getByRole('cell', { name: 'R$ 0,00', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Indicadores de margem').getByText('Não informado', { exact: true })).toHaveCount(4);
});

test('RH can read Faturamento when confidential cost and margin fields are omitted by the server', async ({ page }) => {
  await setup(page, { salesOnlyHr: true });
  const table = page.getByRole('table', { name: 'Itens do faturamento' }); await expect(table).toBeVisible();
  await expect(table.getByRole('cell', { name: 'R$ 100,00', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Fechamento', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Abrir item ITEM-1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Item ITEM-1 · NF NF-1', exact: true })).toBeVisible();
  await expect(page.getByText('Margem indisponível nesta consulta.', { exact: false })).toBeVisible();
  await expect(page.getByText('R$ 20,00', { exact: true })).toHaveCount(0);
  await expect(page.getByText('R$ 75,00', { exact: true })).toHaveCount(0);
});

test('a failed refresh clears stale financial cards and item details without leaking SQL', async ({ page }) => {
  await setup(page, { failRefresh: true }); await page.getByRole('button', { name: 'Abrir item ITEM-1', exact: true }).click(); await page.getByRole('button', { name: 'Atualizar faturamento', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível consultar'); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Item ITEM-1 · NF NF-1' })).toHaveCount(0); await expect(page.getByText('private SQL error')).toHaveCount(0);
});

test('an empty or unsafe closing does not present a fabricated financial position', async ({ page }) => {
  await setup(page, { empty: true }); await expect(page.getByLabel('Indicadores de faturamento').getByText('Sem base', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('cell', { name: 'Nenhum fechamento importado para este mês.' })).toBeVisible();
});

test('Excel exports every filtered page with literal item fields and closing metadata', async ({ page }) => {
  const calls = await setup(page, { pages: true, export: true }); await expect(page.getByRole('table')).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar Excel', exact: true }).click();
  const file = await download; expect(file.suggestedFilename()).toMatch(/^Faturamento_2026-10_/);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile((await file.path())!);
  expect(book.getWorksheet('Faturamento')!.rowCount).toBe(27); expect(book.getWorksheet('Faturamento')!.getCell('A27').value).toBe('ITEM-26'); expect(book.getWorksheet('Consulta')!.getCell('B3').value).toBe('Fechamento_sintetico.xlsx');
  expect(calls.filter(call => call.name === 'list_commercial_items').some(call => call.body.p_limit === 500)).toBe(true);
});

test('Excel refuses a closing that changes during generation', async ({ page }) => {
  await setup(page, { export: true, changedExport: true }); await expect(page.getByRole('table')).toBeVisible();
  let downloaded = false; page.on('download', () => { downloaded = true; }); await page.getByRole('button', { name: 'Baixar Excel', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('A base mudou durante a exportação'); expect(downloaded).toBe(false);
});

test('closing import uses the original bytes and requires the reviewed month and totals before committing', async ({ page }) => {
  const calls = await setup(page, { import: true }); await expect(page.getByRole('button', { name: 'Importar fechamento', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Importar fechamento', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Faturamento e Margens', exact: true })).toBeVisible();
  await page.getByLabel('Mês da base de faturamento', { exact: true }).fill('2026-10');
  const bytes = Buffer.from('Produto;Venda total;Emissão;Cliente;Filial\nProduto sintético;100,00;01/10/2026;Cliente sintético;FILIAL TESTE');
  await page.getByLabel('Planilha de faturamento e margens', { exact: false }).setInputFiles({ name: 'Fechamento.csv', mimeType: 'text/csv', buffer: bytes });
  await page.getByRole('button', { name: 'Analisar fechamento', exact: true }).click();
  const commit = page.getByRole('button', { name: 'Confirmar importação do fechamento', exact: true }); await expect(commit).toBeDisabled();
  expect(calls.filter(call => call.name === 'business-import').at(-1)?.body.file_base64).toBe(bytes.toString('base64'));
  await page.getByRole('checkbox', { name: /Conferi o mês e os totais/ }).check(); await commit.click();
  await expect(page.getByRole('status')).toContainText('Fechamento importado');
  expect(calls.filter(call => call.name === 'business-import').at(-1)?.body).toMatchObject({ action: 'commit', mode: 'commercial', month: '2026-10-01', previous_import_id: null, complete: true });
});
