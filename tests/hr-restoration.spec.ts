import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = '2026-10-19T15:00:00Z';
const id = (value: number) => `84000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const rows = [
  { source_row: 2, branch: 'Filial sintética A', employee: 'Ana Sintética', sector: 'Financeiro sintético', admitted_on: '2020-10-09', birthday_on: '1990-10-11', salary_base_cents: 200000, payroll_salary_cents: 190000, transport_cents: 20000, advance_cents: 10000, total_cents: 200000, count_label: '1', basket_eligible: true, basket_cost_cents: 11280, is_partner: false },
  { source_row: 3, branch: 'Filial sintética A', employee: 'Sócio Sintético', sector: 'SÓCIO', admitted_on: '2010-03-12', birthday_on: '1980-03-18', salary_base_cents: 1000000, payroll_salary_cents: 1000000, transport_cents: 0, advance_cents: 0, total_cents: 1000000, count_label: null, basket_eligible: true, basket_cost_cents: 11280, is_partner: true },
  { source_row: 4, branch: 'Filial sintética B', employee: 'GABRIEL PEDROSA MARQUES FERREIRA', sector: 'Operações sintéticas', admitted_on: '2026-10-10', birthday_on: '1992-02-10', salary_base_cents: 300000, payroll_salary_cents: null, transport_cents: null, advance_cents: null, total_cents: null, count_label: '1', basket_eligible: false, basket_cost_cents: 0, is_partner: false },
];
const summary = { employees: 2, partners: 1, admissions: 1, birthdays: 1, basket_eligible: 2, basket_excluded: 1, basket_unit_cents: 11280, basket_monthly_cents: 22560, basket_annual_cents: 270720, salary_base_cents: 500000, transport_cents: null, advance_cents: null, total_cents: null };
const quality = { missing_admission: 0, missing_birthday: 0, missing_branch: 0, missing_sector: 0, missing_salary_base: 0, missing_payroll_salary: 1, missing_transport: 1, missing_advance: 1, missing_total: 1 };
function report(month = '2026-10-01') {
  const selected = Number(month.slice(5, 7)), year = Number(month.slice(0, 4));
  return { calendar_month: month, snapshot: { id: id(8), reference_date: '2026-10-19', file_name: 'RH-SINTETICO.xlsx', imported_at: now, sha256: 'a'.repeat(64), row_count: rows.length }, summary: { ...summary, admissions: rows.filter(row => row.admitted_on.startsWith(month.slice(0, 7))).length, birthdays: rows.filter(row => Number(row.birthday_on.slice(5, 7)) === selected).length }, quality,
    rows, by_branch: [{ label: 'Filial sintética A', count: 2, salary_base_cents: 1200000 }, { label: 'Filial sintética B', count: 1, salary_base_cents: 300000 }], by_sector: [{ label: 'Financeiro sintético', count: 1, salary_base_cents: 200000 }, { label: 'SÓCIO', count: 1, salary_base_cents: 1000000 }, { label: 'Operações sintéticas', count: 1, salary_base_cents: 300000 }],
    birthdays: rows.filter(row => Number(row.birthday_on.slice(5, 7)) === selected).map(row => ({ ...row, day: Number(row.birthday_on.slice(8)) })), work_anniversaries: rows.filter(row => Number(row.admitted_on.slice(5, 7)) === selected && year > Number(row.admitted_on.slice(0, 4))).map(row => ({ ...row, day: Number(row.admitted_on.slice(8)), years: year - Number(row.admitted_on.slice(0, 4)) })) };
}
async function setup(page: Page, role: 'diretor' | 'rh_dp' = 'diretor', options: { empty?: boolean; importError?: boolean; stale?: boolean } = {}) {
  await page.clock.setFixedTime(new Date(now));
  const profile = { id: id(1), username: 'UsuarioRHSintetico', display_name: 'Usuário de RH sintético', role_key: role, enabled: true };
  const permissions = ['rh_dp'].flatMap(resource => ['read', 'export'].map(action => ({ resource, action })));
  if (role === 'rh_dp' || options.stale) for (const resource of ['rh_dp', 'importar_bases']) for (const action of ['read', 'write', 'import']) permissions.push({ resource, action });
  const access = { profile, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: profile.id, session_id: id(2), role: 'authenticated', exp: Math.floor(Date.parse(now) / 1000) + 3600 })).toString('base64url'), 'synthetic-only'].join('.');
  const calls: { name: string; body: any }[] = [];
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postData() ? request.postDataJSON() : null; calls.push({ name, body });
    const reply = (json: any, status = 200) => route.fulfill({ json, status, headers });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: profile.id, aud: 'authenticated', role: 'authenticated', email: 'rh@synthetic.test', created_at: now, app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (name === 'hr_report') {
      if (!options.empty) return reply(report(body.p_month));
      return reply({ calendar_month: body.p_month, snapshot: null, summary: Object.fromEntries(Object.entries(summary).map(([key]) => [key, key === 'basket_unit_cents' ? 11280 : 0])), quality: Object.fromEntries(Object.keys(quality).map(key => [key, 0])), rows: [], by_branch: [], by_sector: [], birthdays: [], work_anniversaries: [] });
    }
    if (name === 'business-import') {
      if (options.importError) return reply({ code: '22023', errors: [{ line: 4, column: 'Primeiro Salário — base', problem: 'Valor inválido na base sintética.', correction: 'Corrija a célula e exporte uma nova cópia.' }] }, 422);
      if (body.action === 'preview') return reply({ rows: rows.map(({ basket_eligible, basket_cost_cents, is_partner, ...row }) => row), preview: { row_count: rows.length, previous_import_id: id(8), summary, quality }, file_sha256: createHash('sha256').update(Buffer.from(body.file_base64, 'base64')).digest('hex') });
      return reply({ import_id: id(9), row_count: rows.length, idempotent: false });
    }
    return reply({ code: 'PGRST202' }, 404);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill(profile.username); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await page.getByRole('navigation', { name: 'Módulos da Central' }).getByRole('button', { name: 'RH / DP', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pessoas da base', exact: true })).toBeVisible();
  return calls;
}
test('RH original shows separate partners, exact basket exceptions and nullable payroll values', async ({ page }) => {
  await setup(page);
  const cards = page.locator('.hr-cards');
  await expect(cards.locator('article').filter({ has: page.getByRole('heading', { name: 'Colaboradores', exact: true }) })).toContainText('2');
  await expect(cards.locator('article').filter({ has: page.getByRole('heading', { name: 'Sócios', exact: true }) })).toContainText('1');
  await expect(cards.locator('article').filter({ has: page.getByRole('heading', { name: 'Custo mensal — cesta básica', exact: true }) })).toContainText('225,60');
  await expect(cards.locator('article').filter({ has: page.getByRole('heading', { name: 'Salário base — colaboradores', exact: true }) })).toContainText('5.000,00');
  await expect(cards.locator('article').filter({ has: page.getByRole('heading', { name: 'Vale-transporte', exact: true }) })).toContainText('Não informado');
  const detail = page.getByRole('table', { name: 'Funcionários, sócios e valores informados na base de RH / DP' });
  await expect(detail.getByRole('row').filter({ hasText: 'GABRIEL PEDROSA MARQUES FERREIRA' })).toContainText('Não informado');
  await page.getByLabel('Buscar pessoa', { exact: true }).fill('ana sintetica');
  await expect(detail.getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Limpar filtros de RH', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filial de RH', exact: true }).selectOption('Filial sintética B');
  await expect(detail.getByRole('row')).toHaveCount(2); await expect(detail).not.toContainText('Ana Sintética');
  await page.screenshot({ path: '/tmp/central-rh-013.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('RH month calendar uses selected month and tenure without changing the position date', async ({ page }) => {
  const calls = await setup(page);
  await page.getByRole('button', { name: 'Mar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Aniversariantes do mês (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Aniversário de empresa (1)', exact: true })).toBeVisible();
  await expect(page.locator('.hr-calendar-columns')).toContainText('16 anos');
  await expect(page.getByText(/Posição de 19\/10\/2026/)).toBeVisible();
  expect(calls.filter(call => call.name === 'hr_report').at(-1)?.body).toEqual({ p_month: '2026-03-01' });
});
test('Director exports filtered HR Excel and never sees import or write controls, even with stale grants', async ({ page }) => {
  const calls = await setup(page, 'diretor', { stale: true });
  await expect(page.getByRole('button', { name: /Importar base de RH|Importar Bases/ })).toHaveCount(0); await expect(page.locator('input[type=file]')).toHaveCount(0);
  await page.getByLabel('Buscar pessoa', { exact: true }).fill('Ana Sintética');
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar relatório de RH / DP', exact: true }).click();
  const download = await pending, path = await download.path(); expect(download.suggestedFilename()).toBe('RH_DP_2026-10.xlsx');
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(path!);
  const sheet = book.getWorksheet('Pessoas filtradas')!; expect(sheet.rowCount).toBe(2); expect(sheet.getCell('D2').value).toBe('Ana Sintética'); expect(sheet.getCell('I2').value).toBe(2000); expect(sheet.getCell('K2').value).toBe(1900);
  expect(book.getWorksheet('Origem e critérios')!.getCell('B2').value).toBe('RH-SINTETICO.xlsx');
  expect(calls.filter(call => call.name === 'business-import')).toEqual([]);
});
test('An empty RH base remains waiting for import and does not present fabricated zero balances', async ({ page }) => {
  await setup(page, 'diretor', { empty: true });
  await expect(page.getByText(/Aguardando a primeira importação de RH/)).toBeVisible();
  await expect(page.locator('.hr-cards').getByText('R$ 0,00', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Baixar relatório de RH / DP', exact: true })).toBeDisabled();
});
test('RH complete snapshot imports canonical original bytes only after preview and explicit confirmation', async ({ page }) => {
  const calls = await setup(page, 'rh_dp');
  await page.getByRole('button', { name: 'Importar base de RH / DP', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Importar base de RH / DP', exact: true })).toBeVisible();
  const bytes = Buffer.from('FILIAL;FUNCIONÁRIO;SETOR\nFilial sintética;Pessoa sintética;Setor sintético\n');
  await page.getByLabel('Arquivo da base de RH / DP', { exact: true }).setInputFiles({ name: 'RH-SINTETICO.csv', mimeType: 'text/csv', buffer: bytes });
  await page.getByRole('button', { name: 'Analisar base de RH / DP', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferência da posição de RH / DP', exact: true })).toBeVisible();
  const commit = page.getByRole('button', { name: 'Confirmar importação de RH / DP', exact: true }); await expect(commit).toBeDisabled();
  await page.getByLabel('Confirmo que esta é a base completa de RH / DP da data informada e conferi os campos apresentados.').check(); await commit.click();
  await expect(page.getByText(/Base de RH \/ DP registrada: 3 registro/)).toBeVisible();
  const writes = calls.filter(call => call.name === 'business-import'); expect(writes).toHaveLength(2);
  expect(writes[1].body).toEqual({ action: 'commit', mode: 'hr', reference_date: '2026-10-19', file_name: 'RH-SINTETICO.csv', file_base64: bytes.toString('base64'), previous_import_id: id(8), complete: true });
  expect(writes[1].body).not.toHaveProperty('rows');
});
test('RH import displays canonical line errors and prevents confirmation', async ({ page }) => {
  const calls = await setup(page, 'rh_dp', { importError: true });
  await page.getByRole('button', { name: 'Importar base de RH / DP', exact: true }).click();
  await page.getByLabel('Arquivo da base de RH / DP', { exact: true }).setInputFiles({ name: 'RH-INVALIDO.csv', mimeType: 'text/csv', buffer: Buffer.from('FILIAL;FUNCIONÁRIO;SETOR\nX;Pessoa;Setor') });
  await page.getByRole('button', { name: 'Analisar base de RH / DP', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Campos a corrigir no arquivo de RH / DP' })).toContainText('Valor inválido na base sintética.');
  await expect(page.getByRole('button', { name: 'Confirmar importação de RH / DP', exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.name === 'business-import' && call.body.action === 'commit')).toHaveLength(0);
});
