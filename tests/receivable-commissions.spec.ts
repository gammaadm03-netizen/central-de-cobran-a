import { test, expect, type Page } from '@playwright/test';
const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const userId = '10000000-0000-4000-8000-000000000001', receiptId = '30000000-0000-4000-8000-000000000001', titleId = '40000000-0000-4000-8000-000000000001', collectorId = '50000000-0000-4000-8000-000000000001';
async function setup(page: Page, options: { missing?: boolean; unsafe?: boolean; pages?: boolean; failureOnRefresh?: boolean } = {}) {
  const access = { profile: { id: userId, username: 'PessoaSintetica', display_name: 'Diretoria sintética', role_key: 'diretor', enabled: true }, permissions: [{ resource: 'comissoes', action: 'read' }], collector_id: null };
  const claims = { sub: userId, session_id: '20000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000), role: 'authenticated' };
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-only'].join('.');
  const seen: any[] = [];
  await page.route(`${project}/**`, async route => {
    const req = route.request(), url = new URL(req.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.invalid', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/current_access') return reply(access);
    if (url.pathname === '/rest/v1/rpc/receivable_commission_base') {
      const body = req.postDataJSON(); seen.push(body);
      if (options.missing) return reply({ code: 'PGRST202', message: 'private SQL error' }, 404);
      if (options.failureOnRefresh && seen.length > 1) return reply({ message: 'private SQL error' }, 503);
      const offset = Number(body.p_offset), count = options.pages ? 26 : 1;
      const row = { receipt_id: receiptId, title_id: titleId, document: 'NF-001', client_name: 'Cliente sintético', branch: 'FILIAL TESTE', due_date: '2026-10-01', payment_date: '2026-10-16', amount_cents: 9000, nominal_amount_cents: 10000, collector_id: collectorId, collector_name: 'Responsável sintética', delay_days: 15, delay_band: 'ATE_30', payment_source: 'IMPORTACAO_DIARIA', base_cents: 9000, eligibility: 'BASE_DISPONIVEL' };
      return reply({ rows: options.pages ? Array.from({ length: Math.min(25, count-offset) }, (_, i) => ({ ...row, receipt_id: `30000000-0000-4000-8000-${String(offset+i+1).padStart(12,'0')}`, document: `NF-${offset+i+1}` })) : [row], count, total_received_cents: options.unsafe ? Number.MAX_SAFE_INTEGER + 1 : 9000 * count, eligible_base_cents: 9000 * count, unassigned_count: 0, rule_status: 'AGUARDANDO_REGRAS', collectors: [{ id: collectorId, display_name: 'Responsável sintética' }] });
    }
    throw new Error(`Unexpected request ${req.method()} ${url.pathname}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('PessoaSintetica'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click();
  await expect(page.getByRole('heading', { name: 'Base de comissões de cobrança' })).toBeVisible();
  return seen;
}
test('commission base uses actual receipts and opens the original amount separately without calculating an unconfigured rate', async ({ page }) => {
  await setup(page); const table = page.getByRole('table', { name: 'Recebimentos confirmados para comissões' });
  await expect(table.getByRole('cell', { name: 'R$ 90,00', exact: true })).toBeVisible(); await expect(table.getByRole('cell', { name: 'R$ 100,00', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir recebimento NF-001' }).click(); await expect(page.getByRole('heading', { name: 'Recebimento NF-001' })).toBeVisible();
  await expect(page.getByText('Os percentuais e suas vigências aguardam definição', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Pagar comissão|Salvar comissão|Calcular comissão/ })).toHaveCount(0);
});
test('period and collector query reach the server with actual payment dates and restart pagination', async ({ page }) => {
  const seen = await setup(page); await expect(page.getByRole('table')).toBeVisible();
  await page.getByLabel('Recebimento inicial', { exact: true }).fill('2026-09-01'); await page.getByLabel('Recebimento final', { exact: true }).fill('2026-09-30'); await page.getByLabel('Cobradora da comissão').selectOption(collectorId);
  await page.getByRole('button', { name: 'Consultar base de comissões' }).click();
  await expect.poll(() => seen.at(-1)).toEqual({ p_start: '2026-09-01', p_end: '2026-09-30', p_collector_id: collectorId, p_offset: 0, p_limit: 25 });
});
test('commission receipts paginate on the server instead of truncating at the first page', async ({ page }) => {
  const seen = await setup(page, { pages: true }); await expect(page.getByText('26 recebimento(s) · página 1 de 2')).toBeVisible();
  await page.getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(page.getByText('26 recebimento(s) · página 2 de 2')).toBeVisible();
  expect(seen.at(-1).p_offset).toBe(25); await expect(page.getByRole('button', { name: 'Abrir recebimento NF-26' })).toBeVisible();
});
test('missing commission activation shows a specific message with no invented zero totals', async ({ page }) => {
  await setup(page, { missing: true }); await expect(page.getByRole('alert')).toContainText('base de comissões precisa da atualização'); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByText('private SQL error')).toHaveCount(0);
});
test('unsafe monetary totals fail closed instead of being rounded into a commission base', async ({ page }) => {
  await setup(page, { unsafe: true }); await expect(page.getByRole('alert')).toContainText('Não foi possível consultar'); await expect(page.getByRole('table')).toHaveCount(0);
});
test('a failed refresh clears old money and receipt details and remains read only for the Director', async ({ page }) => {
  await setup(page, { failureOnRefresh: true }); await page.getByRole('button', { name: 'Abrir recebimento NF-001' }).click(); await page.getByRole('button', { name: 'Atualizar base de comissões' }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível consultar'); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Recebimento NF-001' })).toHaveCount(0);
  await expect(page.getByText('private SQL error')).toHaveCount(0);
});
