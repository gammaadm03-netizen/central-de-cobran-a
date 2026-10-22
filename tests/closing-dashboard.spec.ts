import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = '2026-10-22T15:00:00Z';
const id = (value: number) => `96000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
interface Options { count?: number; missing?: boolean; empty?: boolean; changedPage?: boolean; failure?: boolean; unsafe?: boolean; wrongMonth?: boolean }
interface Call { name: string; body: any }

function item(index: number, count: number, month: string, missing = false) {
  const returned = count > 1 && index === count;
  const sign = returned ? -1 : 1;
  return { id: id(index + 100), import_id: id(10), line_number: index + 1, code: `ITEM-${index}`,
    product: `Produto sintético ${index}`, client: 'Cliente sintético', employee: 'Equipe sintética', invoice: `NF-${index}`,
    cost_center: returned ? 'LICITAÇÃO' : 'PRIVADO', branch: returned ? 'FILIAL B' : 'FILIAL A', issued_on: month,
    quantity: sign, sale_cents: sign * 10000, cost_cents: missing ? null : sign * 7500,
    tax_cents: missing ? null : sign * 500, freight_cents: 0, commission_cents: 0,
    margin_cents: missing ? null : sign * 2000, margin_percent: missing ? null : 20,
    margin_source: missing ? 'UNAVAILABLE' : 'PROVIDED' };
}

async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(new Date(now));
  const access = { profile: { id: id(1), username: 'DiretoriaSintetica', display_name: 'Diretoria sintética', role_key: 'diretor', enabled: true },
    permissions: [{ resource: 'margens', action: 'read' }], collector_id: null };
  const claims = { sub: id(1), session_id: id(2), role: 'authenticated', exp: Math.floor(Date.parse(now) / 1000) + 3600 };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), Buffer.from('synthetic-only').toString('base64url')].join('.');
  const calls: Call[] = [];
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const reply = (json: any, status = 200) => route.fulfill({ json, status, headers });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: id(1), aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: now, app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    const body = request.postDataJSON(); calls.push({ name, body });
    if (name !== 'list_commercial_items') throw new Error(`Unexpected dashboard request: ${name}`);
    if (options.failure) return reply({ code: 'XX000', message: 'private database statement and identifiers' }, 503);
    const count = options.empty ? 0 : options.count ?? 1;
    const month = options.wrongMonth ? '2026-10-01' : body.p_month || '2026-10-01', offset = body.p_offset ?? 0, size = body.p_limit ?? 25;
    const sale = (count > 1 ? count - 2 : count) * 10000;
    const margin = options.missing ? null : (count > 1 ? count - 2 : count) * 2000;
    return reply({ month, revision: options.changedPage && offset > 0 ? 'changed-version' : 'stable-version', count,
      rows: Array.from({ length: Math.min(size, Math.max(0, count - offset)) }, (_, n) => item(offset + n + 1, count, month, options.missing)),
      source: options.empty ? null : { import_id: id(10), month, file_name: `Fechamento_${month.slice(0, 7)}.xlsx`, updated_at: now },
      options: { months: ['2026-10-01', '2026-09-01'], branches: ['FILIAL A', 'FILIAL B'], centres: ['PRIVADO', 'LICITAÇÃO'], employees: ['Equipe sintética'] },
      summary: { sale_cents: options.unsafe ? Number.MAX_SAFE_INTEGER + 1 : sale, margin_cents: margin, margin_percent: options.missing || !sale ? null : margin! * 100 / sale,
        row_count: count, margin_missing_count: options.missing ? count : 0, filtered_sale_cents: options.unsafe ? Number.MAX_SAFE_INTEGER + 1 : sale, filtered_margin_cents: margin,
        filtered_margin_percent: options.missing || !sale ? null : margin! * 100 / sale, filtered_count: count, filtered_margin_missing_count: options.missing ? count : 0 } });
  });
  await page.goto('/');
  await page.getByLabel('Usuário', { exact: true }).fill('DiretoriaSintetica');
  await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboards do fechamento', exact: true })).toBeVisible();
  return calls;
}

function card(page: Page, title: string) {
  return page.getByRole('region', { name: 'Indicadores do fechamento', exact: true }).locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

test('closing dashboards aggregate every page and retain returns with negative amounts in totals and branch charts', async ({ page }) => {
  const calls = await setup(page, { count: 501 });
  await expect(card(page, 'Venda total')).toContainText('R$ 49.900,00');
  await expect(card(page, 'CMV total')).toContainText('R$ 37.425,00');
  await expect(card(page, 'Margem do fechamento')).toContainText('R$ 9.980,00');
  await expect(card(page, 'Margem do fechamento %')).toContainText('20,00%');
  await expect(card(page, 'Itens do fechamento')).toContainText('501');
  await expect(card(page, 'Impostos')).toContainText('R$ 2.495,00');
  const branches = page.getByRole('region', { name: 'Venda e margem por filial', exact: true });
  await expect(branches).toContainText('FILIAL A'); await expect(branches).toContainText('FILIAL B');
  await expect(branches).toContainText('R$ 50.000,00'); await expect(branches).toContainText('-R$ 100,00');
  const centres = page.getByRole('region', { name: 'Venda e margem por centro de custo', exact: true });
  await expect(centres).toContainText('PRIVADO'); await expect(centres).toContainText('LICITAÇÃO');
  expect(calls.some(call => call.body.p_limit === 500 && call.body.p_offset === 500 && call.body.p_month === '2026-10-01')).toBe(true);
  expect(calls.every(call => call.name === 'list_commercial_items' && !call.body.p_search && !call.body.p_branch && !call.body.p_centre && !call.body.p_employee && !call.body.p_margin_band)).toBe(true);
});

test('a version change during a dashboard refresh removes stale values and refuses partial branch results', async ({ page }) => {
  const options: Options = { count: 501 };
  await setup(page, options);
  await expect(card(page, 'Venda total')).toContainText('R$ 49.900,00');
  options.changedPage = true;
  await page.getByRole('button', { name: 'Atualizar dashboards', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Indicadores do fechamento', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Venda e margem por filial', exact: true })).toHaveCount(0);
  await expect(page.getByText('R$ 49.900,00', { exact: true })).toHaveCount(0);
});

test('missing closing components remain unknown in dashboard cards while known zero charges stay zero', async ({ page }) => {
  await setup(page, { missing: true });
  await expect(card(page, 'Venda total')).toContainText('R$ 100,00');
  await expect(card(page, 'CMV total')).toContainText('Não informado');
  await expect(card(page, 'Impostos')).toContainText('Não informado');
  await expect(card(page, 'Margem do fechamento')).toContainText('Não informado');
  await expect(card(page, 'Margem do fechamento %')).toContainText('Não informado');
  await expect(card(page, 'Itens sem margem')).toContainText('1');
  await expect(card(page, 'Fretes')).toContainText('R$ 0,00');
  await expect(card(page, 'Comissões do fechamento')).toContainText('R$ 0,00');
});

test('a month without a closing does not show fabricated zero financial cards or charts', async ({ page }) => {
  await setup(page, { empty: true });
  await expect(page.getByRole('region', { name: 'Indicadores do fechamento', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Venda e margem por filial', exact: true })).toHaveCount(0);
  await expect(page.getByText(/Nenhum fechamento importado|Sem fechamento importado/)).toBeVisible();
  await expect(page.getByText('R$ 0,00', { exact: true })).toHaveCount(0);
});

test('the Director changes the dashboard month and reads its actual source without gaining import or edit controls', async ({ page }) => {
  const calls = await setup(page);
  await expect(card(page, 'Venda total')).toContainText('R$ 100,00');
  await page.getByRole('combobox', { name: 'Mês dos dashboards do fechamento', exact: true }).selectOption('2026-09-01');
  await expect.poll(() => calls.at(-1)?.body.p_month).toBe('2026-09-01');
  await expect(page.getByText('Fechamento_2026-09.xlsx', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Importar fechamento|Importar custos|Aplicar custos e recalcular margens)$/ })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(calls.every(call => call.name === 'list_commercial_items')).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a failed dashboard refresh clears the former month position without revealing backend error details', async ({ page }) => {
  const options: Options = {};
  await setup(page, options);
  await expect(card(page, 'Venda total')).toContainText('R$ 100,00');
  options.failure = true;
  await page.getByRole('button', { name: 'Atualizar dashboards', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Indicadores do fechamento', exact: true })).toHaveCount(0);
  await expect(page.getByText('private database statement and identifiers', { exact: false })).toHaveCount(0);
  await expect(page.getByText('R$ 100,00', { exact: true })).toHaveCount(0);
});

test('unsafe closing totals are rejected before financial dashboard cards are shown', async ({ page }) => {
  await setup(page, { unsafe: true });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Indicadores do fechamento', exact: true })).toHaveCount(0);
});

test('a closing above the dashboard item limit never publishes a total from the first page', async ({ page }) => {
  const calls = await setup(page, { count: 20001 });
  await expect(page.getByRole('alert')).toContainText('20.000 itens');
  await expect(page.getByRole('region', { name: 'Indicadores do fechamento', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Venda e margem por filial', exact: true })).toHaveCount(0);
  expect(calls).toHaveLength(1);
});


test('an explicit dashboard month cannot display a response for another month', async ({ page }) => {
  const options: Options = {};
  await setup(page, options);
  await expect(card(page, 'Venda total')).toContainText('R$ 100,00');
  options.wrongMonth = true;
  await page.getByRole('combobox', { name: 'Mês dos dashboards do fechamento', exact: true }).selectOption('2026-09-01');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Indicadores do fechamento', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Venda e margem por filial', exact: true })).toHaveCount(0);
});
