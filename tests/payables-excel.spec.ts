import { test, expect, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = new Date('2026-10-18T15:00:00Z');
const stamp = now.toISOString();
function fixtureRows(month: string, previous = false) {
  return Array.from({ length: 30 }, (_, index) => ({
    id: `30000000-0000-4000-8000-${String((previous ? 100 : 0) + index + 1).padStart(12, '0')}`,
    scope: 'grupo-consolidado', source_key: `synthetic-${month}-${index}`, entry_number: `CP-${index + 1}`,
    description: index === 0 ? '=SUM(1,2)' : `Fornecedor sintético ${index + 1}`, branch: index % 2 ? '3 - TESTE' : '2 - TESTE',
    due_date: `${month}-${index === 0 ? '02' : '16'}`, issued_on: `${month}-01`, amount_cents: (previous ? 200 : 100) + index,
    source_status: index === 1 ? 'CHEQUE' : 'ABERTO', plan: index % 2 ? 'PLANO B TESTE' : 'PLANO A TESTE',
    macro: index % 2 ? 'VARIÁVEL' : 'FIXO', status: index === 29 ? 'SETTLED_IMPORT' : 'OPEN',
    settled_at: index === 29 ? '2026-10-18T02:30:00Z' : null, bank_account: 'Conta sintética',
  }));
}
async function setup(page: Page, options: { changed?: boolean; noBase?: boolean; precision?: boolean; cheque?: boolean; tooMany?: boolean; holdExport?: () => Promise<void> } = {}) {
  await page.clock.setFixedTime(now);
  const id = '10000000-0000-4000-8000-000000000001';
  const access = { profile: { id, username: 'DiretorTeste', display_name: 'Pessoa Teste', role_key: 'diretor', enabled: true }, permissions: ['painel', 'contas_pagar'].map(resource => ({ resource, action: 'read' })), collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, session_id: '20000000-0000-4000-8000-000000000001', exp: Math.floor(now.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const current = fixtureRows('2026-10'), previous = fixtureRows('2026-09', true);
  if (options.cheque) Object.assign(current[0], { cheque_number: '000719' });
  if (options.precision) current[0].amount_cents = Number.MAX_SAFE_INTEGER;
  let importReads = 0;
  const queries: string[] = [], financialWrites: string[] = [];
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,authorization,content-type,x-client-info', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const name = url.pathname.split('/').at(-1)!;
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' } });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'synthetic@test.invalid', email_confirmed_at: stamp, created_at: stamp, app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (name === 'payables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (['payable_review_titles', 'payable_financial_titles'].includes(name)) return reply({ code: 'PGRST205' }, 404);
    if (['get_payable_payment_accounts', 'payable_payment_summary', 'list_payable_payments', 'get_payables_revision', 'get_payable_month_status', 'payables_month_status', 'list_payable_month_closures'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'cash_position') return reply({ accounts: [], total_cents: null, reported_accounts: 0, expected_accounts: 17, latest_position_date: null });
    if (name === 'current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (name === 'payables_summary' || name === 'receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (name === 'payables_forecast') return reply({ code: 'PGRST202' }, 404);
    if (name === 'payable_macros') return reply([{ name: 'FIXO' }, { name: 'VARIÁVEL' }], 200, 2);
    if (name === 'payable_imports') {
      importReads++;
      return reply(options.noBase ? [] : [{ id: options.changed && importReads > 1 ? '40000000-0000-4000-8000-000000000002' : '40000000-0000-4000-8000-000000000001' }], 200, options.noBase ? 0 : 1);
    }
    if (name === 'payable_titles') {
      queries.push(url.search);
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 25);
      if (limit === 500 && options.holdExport) await options.holdExport();
      let rows = [...current, ...previous];
      for (const key of ['status', 'macro', 'branch']) {
        const value = url.searchParams.get(key); if (value?.startsWith('eq.')) rows = rows.filter(row => row[key as 'status'] === value.slice(3));
      }
      const start = url.searchParams.get('due_date')?.startsWith('gte.') ? url.searchParams.get('due_date')!.slice(4) : '';
      const end = url.searchParams.getAll('due_date').find(value => value.startsWith('lte.'))?.slice(4) ?? '';
      if (start) rows = rows.filter(row => row.due_date >= start); if (end) rows = rows.filter(row => row.due_date <= end);
      rows.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));
      return reply(rows.slice(offset, offset + limit), 200, options.tooMany && limit === 500 ? 20001 : rows.length);
    }
    if (request.method() !== 'GET') financialWrites.push(name);
    throw new Error(`Unexpected offline request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('DiretorTeste'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Contas a Pagar', exact: true }).click();
  await expect(page.getByText('Carregando títulos…')).toHaveCount(0);
  await page.getByLabel('Mês do relatório Excel').fill('2026-10');
  return { queries, financialWrites };
}
async function downloadWorkbook(page: Page, full = false) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: full ? 'Baixar mês completo — lançamento por lançamento' : 'Baixar Excel dos filtros', exact: true }).click();
  const download = await pending, workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await download.path())!);
  return { workbook, download };
}

test('Director exports the entire month with all 14 columns and all pages while keeping read-only access', async ({ page }) => {
  const seen = await setup(page);
  const { workbook, download } = await downloadWorkbook(page, true);
  expect(download.suggestedFilename()).toBe('Contas_a_Pagar_Lancamento_por_Lancamento_2026-10.xlsx');
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['TODOS OS LANÇAMENTOS', 'Resumo por Macro', 'Comparativo por Macro', 'Resumo do mês']);
  const sheet = workbook.worksheets[0]; expect(sheet.rowCount).toBe(31); expect(sheet.columnCount).toBe(14);
  expect(sheet.getCell('G2').value).toBeInstanceOf(Date); expect(sheet.getCell('H2').value).toBeInstanceOf(Date); expect(typeof sheet.getCell('J2').value).toBe('number');
  expect(sheet.getCell('C2').value).toBe('=SUM(1,2)'); expect(sheet.getCell('C2').type).toBe(ExcelJS.ValueType.String);
  expect(sheet.getCell('I2').value).toContain('26/09/2026'); expect(sheet.getCell('I2').value).toContain('02/10/2026');
  const saved = sheet.getCell('N31').value as Date; expect(saved).toBeInstanceOf(Date); expect(saved.toISOString().slice(0, 10)).toBe('2026-10-17');
  expect(seen.queries.some(query => new URLSearchParams(query).get('limit') === '500')).toBe(true);
  expect(seen.financialWrites).toEqual([]);
});

test('Excel per Macro honors active filters and compares the matching days of the prior month', async ({ page }) => {
  const seen = await setup(page);
  await page.locator('#payables-macro').selectOption('FIXO'); await page.locator('#payables-start').fill('2026-10-10'); await page.locator('#payables-end').fill('2026-10-20');
  const { workbook } = await downloadWorkbook(page);
  const detail = workbook.worksheets[0]; expect(detail.rowCount).toBe(15);
  detail.eachRow((row, index) => { if (index > 1) expect(row.getCell(1).value).toBe('FIXO'); });
  expect(seen.queries.some(query => { const values = new URLSearchParams(query); return values.get('macro') === 'eq.FIXO' && values.getAll('due_date').includes('gte.2026-09-10') && values.getAll('due_date').includes('lte.2026-09-20'); })).toBe(true);
});

test('month and macro consultation replaces operational filters and keeps historical titles in the selected month', async ({ page }) => {
  const seen = await setup(page);
  await page.getByLabel('Pesquisar histórico / favorecido', { exact: true }).fill('Filtro anterior');
  await page.locator('#payables-status').selectOption('OPEN'); await page.locator('#payables-branch').fill('3 - TESTE');
  await page.getByLabel('Mês do relatório Excel', { exact: true }).fill('2026-09');
  await page.getByLabel('Mês dos títulos', { exact: true }).fill('2026-10');
  await page.getByRole('combobox', { name: 'Centro de Custo Macro do mês', exact: true }).selectOption('FIXO');
  await page.getByRole('button', { name: 'Exibir títulos', exact: true }).click();
  await expect(page.getByLabel('Pesquisar histórico / favorecido', { exact: true })).toHaveValue('');
  await expect(page.locator('#payables-status')).toHaveValue(''); await expect(page.locator('#payables-branch')).toHaveValue('');
  await expect(page.getByLabel('Mês do relatório Excel', { exact: true })).toHaveValue('2026-10');
  await expect.poll(() => seen.queries.some(query => { const values = new URLSearchParams(query); return values.get('macro') === 'eq.FIXO' && values.getAll('due_date').includes('gte.2026-10-01') && values.getAll('due_date').includes('lte.2026-10-31') && !values.has('status') && !values.has('branch') && !values.has('description'); })).toBe(true);
  await expect(page.locator('section[aria-labelledby="payables-title"] tbody tr')).toHaveCount(15);
  await expect(page.getByRole('cell', { name: '=SUM(1,2)', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Centro de Custo Macro do mês', exact: true }).selectOption('VARIÁVEL'); await page.getByRole('button', { name: 'Exibir títulos', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Fornecedor sintético 30', exact: true })).toBeVisible(); await expect(page.locator('section[aria-labelledby="payables-title"] tbody').getByText('Quitado por importação', { exact: true })).toBeVisible();
});

test('full-month export explicitly includes settled titles even when visible filters are restrictive', async ({ page }) => {
  await setup(page); await page.locator('#payables-status').selectOption('OPEN'); await page.locator('#payables-macro').selectOption('FIXO'); await page.locator('#payables-branch').fill('2 - TESTE');
  const { workbook } = await downloadWorkbook(page, true);
  expect(workbook.worksheets[0].rowCount).toBe(31);
  const statuses: unknown[] = []; workbook.worksheets[0].eachRow((row, index) => { if (index > 1) statuses.push(row.getCell(11).value); });
  expect(statuses).toContain('Quitado por importação');
});

test('a concurrent import aborts the export instead of downloading mixed versions', async ({ page }) => {
  await setup(page, { changed: true }); const downloads: string[] = []; page.on('download', item => downloads.push(item.suggestedFilename()));
  await page.getByRole('button', { name: 'Baixar Excel dos filtros', exact: true }).click();
  await expect(page.locator('section[aria-labelledby="payables-title"]').getByRole('alert')).toContainText('A base mudou durante a exportação'); expect(downloads).toEqual([]);
});

test('Excel precision loss is refused and CSV remains available', async ({ page }) => {
  await setup(page, { precision: true }); await page.getByRole('button', { name: 'Baixar Excel dos filtros', exact: true }).click();
  await expect(page.locator('section[aria-labelledby="payables-title"]').getByRole('alert')).toContainText('Excel'); await expect(page.getByRole('button', { name: 'Baixar CSV dos filtros', exact: true })).toBeEnabled();
});

test('row limits and a missing official base never produce partial or invented reports', async ({ page }) => {
  await setup(page, { tooMany: true }); await page.getByRole('button', { name: 'Baixar Excel dos filtros', exact: true }).click();
  await expect(page.locator('section[aria-labelledby="payables-title"]').getByRole('alert')).toContainText('20.000 lançamentos');
  await page.unrouteAll({ behavior: 'wait' }); await setup(page, { noBase: true }); await page.getByRole('button', { name: 'Baixar Excel dos filtros', exact: true }).click();
  await expect(page.locator('section[aria-labelledby="payables-title"]').getByRole('alert')).toContainText('Importe a primeira base de Contas a Pagar');
});

test('an unrelated month and date filter are rejected with a clear message', async ({ page }) => {
  await setup(page); await page.locator('#payables-start').fill('2026-11-01'); await page.locator('#payables-end').fill('2026-11-30');
  await page.getByRole('button', { name: 'Baixar Excel dos filtros', exact: true }).click();
  await expect(page.locator('section[aria-labelledby="payables-title"]').getByRole('alert')).toBeVisible();
  await expect(page.locator('section[aria-labelledby="payables-title"]').getByRole('alert')).not.toContainText('stack');
});

test('leaving CP cancels an in-progress export without downloading it', async ({ page }) => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const seen = await setup(page, { holdExport: () => held }); const downloads: string[] = []; page.on('download', item => downloads.push(item.suggestedFilename()));
  await page.getByRole('button', { name: 'Baixar Excel dos filtros', exact: true }).click();
  await expect.poll(() => seen.queries.some(query => new URLSearchParams(query).get('limit') === '500')).toBe(true);
  await page.getByRole('navigation').getByRole('button', { name: 'Painel Gerencial', exact: true }).click(); release();
  await expect(page.getByRole('heading', { name: 'Painel Gerencial', exact: true })).toBeVisible(); expect(downloads).toEqual([]);
});


test('Excel exports cheque as a text column with leading zeros and leaves unknown cheque numbers blank', async ({ page }) => {
  await setup(page, { cheque: true });
  const { workbook } = await downloadWorkbook(page, true), detail = workbook.worksheets[0];
  expect(detail.columnCount).toBe(15); expect(detail.getCell('O1').value).toBe('Nº cheque');
  expect(detail.getCell('O2').value).toBe('000719'); expect(detail.getCell('O2').type).toBe(ExcelJS.ValueType.String); expect(detail.getCell('O2').numFmt).toBe('@');
  expect(detail.getCell('B2').value).toBe('CP-1'); expect(detail.getCell('O3').value).toBeNull();
});
