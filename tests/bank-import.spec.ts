import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const stamp = '2026-10-15T12:00:00Z';
const names = [['F2G', 'Bradesco'], ['EASY CLEAN', 'Bradesco'], ['EASY CLEAN', 'Banco do Brasil'], ['FAST CLEAN', 'Bradesco'], ['FAST CLEAN', 'Banco do Brasil'], ['ECOPLAST', 'Bradesco'], ['ECOPLAST', 'Banco do Brasil'], ['GAMMA', 'Bradesco'], ['LIMPE FÁCIL', 'Bradesco'], ['LIMPE FÁCIL', 'Cora'], ['MY CLEAN', 'Cora']];
const bankDisplayNames = ['BRADESCO F2G', 'BRADESCO EASY CLEAN', 'BANCO DO BRASIL EASY CLEAN', 'BRADESCO FAST CLEAN', 'BANCO DO BRASIL FAST CLEAN', 'BRADESCO ECOPLAST', 'BANCO DO BRASIL ECOPLAST', 'BRADESCO GAMMA IND', 'BRADESCO LIMPE FACIL', 'BANCO CORA LIMPE FACIL', 'BANCO CORA MY CLEAN'];
const expandedAccounts = names.map(([company, bank], index) => ({ company, bank, account_label: '', account_type: 'BANK' as const, display_name: bankDisplayNames[index] })).concat([{ company: 'ECOPLAST', bank: 'Cora', account_label: '', account_type: 'BANK', display_name: 'BANCO CORA ECO PLAST' }]);
const cashCompanies = ['ECOPLAST', 'LIMPE FÁCIL', 'GAMMA', 'FAST CLEAN', 'EASY CLEAN'];
const physicalCash = cashCompanies.map(company => ({ company, bank: 'Caixa', account_label: 'Caixa da empresa', account_type: 'CASH' as const, display_name: `CAIXA ${company.replace('Á', 'A')}` }));
const fileBytes = Buffer.from('%PDF-1.4\nSynthetic support fixture only\n');
async function setup(page: Page, options: { complete?: boolean; stale?: boolean; role?: 'gerente_geral' | 'diretor'; expanded?: boolean; originalKnown?: boolean } = {}) {
  await page.clock.setFixedTime(new Date('2026-10-15T15:00:00Z'));
  const id = '90000000-0000-4000-8000-000000000001';
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, session_id: '90000000-0000-4000-8000-000000000002', exp: Math.floor(new Date('2026-10-15T15:00:00Z').getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const role = options.role ?? 'gerente_geral';
  const permissions = ['painel', 'caixa'].map(resource => ({ resource, action: 'read' }));
  if (role === 'gerente_geral') permissions.push({ resource: 'importar_bases', action: 'read' }, { resource: 'caixa', action: 'import' });
  const roster = options.expanded ? [...expandedAccounts, ...physicalCash] : names.map(([company, bank]) => ({ company, bank, account_label: '' }));
  let accounts = roster.map((account, index) => {
    const current = options.complete || (options.originalKnown ? index < 11 : index === 0);
    const earlier = !options.originalKnown && !options.expanded && index === 1;
    return { ...account, id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, amount_cents: current || earlier ? 10000 : null, balance_date: current ? '2026-10-15' : earlier ? '2026-10-14' : null, updated_at: current || earlier ? stamp : null };
  });
  const support: any[] = []; const calls: { name: string; body: any }[] = [];
  await page.route(`${project}/**`, async route => {
    const request = route.request(); const url = new URL(request.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,authorization,content-type,x-client-info', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range', 'content-range': support.length ? `0-${support.length - 1}/${support.length}` : '*/0' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json }); const body = request.postDataJSON(); const name = url.pathname.split('/').at(-1)!;
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' } });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'fixture@test.invalid', email_confirmed_at: stamp, created_at: stamp, app_metadata: {}, user_metadata: {} });
    calls.push({ name, body });
    if (url.pathname === '/rest/v1/rpc/receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'current_access') return reply({ profile: { id, username: 'TesteBancos', display_name: 'Pessoa Teste', role_key: role, enabled: true }, permissions, collector_id: null });
    if (name === 'cash_position') {
      const position = body.p_as_of === '2026-10-15' ? accounts : accounts.map(account => ({ ...account, amount_cents: null, balance_date: null, updated_at: null }));
      const reported = position.filter(account => account.amount_cents !== null);
      return reply({ accounts: position, total_cents: reported.length === position.length ? reported.reduce((total, account) => total + account.amount_cents!, 0) : null, reported_accounts: reported.length, expected_accounts: accounts.length, latest_position_date: '2026-10-15' });
    }
    if (name === 'current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (name === 'payables_summary' || name === 'receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (name === 'bank_support_files') return reply(support);
    if (name === 'save_bank_position') {
      if (options.stale) return reply({ code: '40001', message: 'private SQL secret' }, 409);
      accounts = accounts.map(account => { const saved = body.p_positions.find((row: any) => row.account_id === account.id); return { ...account, amount_cents: saved.amount_cents, balance_date: body.p_balance_date, updated_at: stamp }; });
      return reply({ position_date: body.p_balance_date, total_cents: body.p_positions.reduce((sum: number, row: any) => sum + row.amount_cents, 0), account_count: accounts.length });
    }
    if (name === 'register_bank_support') { const fileId = '10000000-0000-4000-8000-000000000100'; support.unshift({ id: fileId, file_name: body.p_file_name, file_sha256: body.p_file_sha256, size_bytes: fileBytes.length, account_id: body.p_account_id, reference_date: body.p_reference_date, description: body.p_description, created_at: stamp }); return reply(fileId); }
    if (name === 'download_bank_support') return reply({ file_name: support[0].file_name, file_base64: fileBytes.toString('base64') });
    throw new Error(`Unexpected request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('TesteBancos'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  if (role === 'gerente_geral') { await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click(); await expect(page.getByRole('tab', { name: 'Caixa / Bancos', exact: true })).toBeVisible(); await expect(page.getByText('Carregando contas bancárias e caixas…')).toHaveCount(0); }
  return { calls };
}

test('Importar Bases contains all 11 bank accounts, and earlier or missing balances remain blank', async ({ page }) => {
  const { calls } = await setup(page);
  const inputs = page.locator('.bank-import-table input'); await expect(inputs).toHaveCount(11); await expect(inputs.nth(0)).toHaveValue('100,00');
  // EASY CLEAN's older balance is shown only as context, never copied into today's input.
  await expect(inputs.nth(1)).toHaveValue(''); await expect(page.locator('.bank-import-table')).toContainText('Último registro: 14/10/2026');
  await expect(page.locator('.bank-import-total')).toContainText('POSIÇÃO INCOMPLETA'); await expect(page.locator('.bank-import-total')).toContainText('1 de 11 contas preenchidas');
  await expect(page.getByRole('button', { name: 'Salvar posição de caixa', exact: true })).toBeDisabled();
  expect(calls.some(call => call.name === 'save_bank_position')).toBe(false);
  await page.screenshot({ path: '/tmp/central-bank-import.png', fullPage: true });
});

test('bank position records exact negative and explicit zero cents atomically only after confirmation', async ({ page }) => {
  const { calls } = await setup(page);
  const inputs = page.locator('.bank-import-table input'); for (let index = 0; index < 11; index++) await inputs.nth(index).fill(index === 0 ? '-1.234,56' : '0,00');
  await page.getByLabel('Observação da posição', { exact: true }).fill('Saldos conferidos nos extratos oficiais.');
  await expect(page.locator('.bank-import-total')).toContainText('-R$ 1.234,56');
  await expect(page.locator('.bank-import-table').getByText('Saldo negativo — cobrir hoje', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Salvar posição de caixa', exact: true }).click(); expect(calls.some(call => call.name === 'save_bank_position')).toBe(false);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição de caixa', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Posição de 15/10/2026 salva' })).toBeVisible();
  const saved = calls.find(call => call.name === 'save_bank_position')!.body;
  expect(saved.p_positions).toHaveLength(11); expect(saved.p_positions[0]).toEqual({ account_id: '10000000-0000-4000-8000-000000000001', amount_cents: -123456, expected_updated_at: stamp });
  expect(saved.p_positions[1].amount_cents).toBe(0); expect(saved.p_positions[1].expected_updated_at).toBeNull(); expect(saved.p_balance_date).toBe('2026-10-15');
});

test('invalid decimal precision and missing bank value prevent accidental rounding or partial positions', async ({ page }) => {
  const { calls } = await setup(page, { complete: true });
  await page.locator('.bank-import-table input').nth(0).fill('1,234'); await expect(page.locator('.bank-import-total')).toContainText('1 valor(es) inválido(s)');
  await expect(page.getByRole('button', { name: 'Salvar posição de caixa', exact: true })).toBeDisabled();
  await page.locator('.bank-import-table input').nth(0).fill(''); await expect(page.locator('.bank-import-total')).toContainText('10 de 11 contas preenchidas');
  expect(calls.some(call => call.name === 'save_bank_position')).toBe(false);
});

test('stale bank revisions keep the draft, block overwrites, and permit explicit reload', async ({ page }) => {
  const { calls } = await setup(page, { complete: true, stale: true });
  await page.locator('.bank-import-table input').nth(0).fill('555,55'); await page.getByLabel('Observação da posição').fill('Conferência simultânea.');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição de caixa', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Nenhum saldo desta operação foi gravado'); await expect(page.locator('.bank-import-table input').nth(0)).toHaveValue('555,55');
  await expect(page.getByRole('button', { name: 'Salvar posição de caixa', exact: true })).toBeDisabled(); await expect(page.getByText('private SQL secret')).toHaveCount(0);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Atualizar posição', exact: true }).click();
  await expect(page.locator('.bank-import-table input').nth(0)).toHaveValue('100,00'); expect(calls.filter(call => call.name === 'save_bank_position')).toHaveLength(1);
});

test('support file keeps original bytes and hash, downloads safely, and does not update bank balances', async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByLabel('Arquivo de apoio', { exact: true }).setInputFiles({ name: 'extrato-sintetico.pdf', mimeType: 'application/pdf', buffer: fileBytes });
  await page.getByLabel('Descrição do arquivo', { exact: true }).fill('Extrato apenas para conferência.');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Registrar arquivo de apoio', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Os saldos não foram alterados' })).toBeVisible(); await expect(page.locator('.bank-support-history')).toContainText('extrato-sintetico.pdf');
  const registered = calls.find(call => call.name === 'register_bank_support')!.body; expect(Buffer.from(registered.p_file_base64, 'base64')).toEqual(fileBytes); expect(registered.p_file_sha256).toMatch(/^[a-f0-9]{64}$/); expect(registered.p_account_id).toBeNull();
  expect(calls.some(call => call.name === 'save_bank_position' || call.name === 'set_bank_balance')).toBe(false);
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar original', exact: true }).click(); const download = await downloadPromise; expect(download.suggestedFilename()).toBe('extrato-sintetico.pdf'); expect(await readFile((await download.path())!)).toEqual(fileBytes);
  await expect(page.locator('.bank-import-table input').nth(1)).toHaveValue('');
});

test('empty and oversized support files cannot be registered', async ({ page }) => {
  const { calls } = await setup(page); await page.getByLabel('Descrição do arquivo', { exact: true }).fill('Validação do tamanho do arquivo.');
  for (const size of [0, 2097153]) {
    await page.getByLabel('Arquivo de apoio', { exact: true }).setInputFiles({ name: 'extrato.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(size) });
    await page.getByRole('button', { name: 'Registrar arquivo de apoio', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('arquivo não vazio de até 2 MiB');
  }
  expect(calls.some(call => call.name === 'register_bank_support')).toBe(false);
});

test('director can consult bank balances but has no bank import or write controls', async ({ page }) => {
  const { calls } = await setup(page, { role: 'diretor' });
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Abrir Caixa →', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Registrar saldo de conta', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Salvar posição de caixa', exact: true })).toHaveCount(0);
  expect(calls.some(call => call.name === 'save_bank_position' || call.name === 'register_bank_support')).toBe(false);
});


test('expanded roster preserves the eleven known balances and leaves Cora Ecoplast plus five company cash balances pending', async ({ page }) => {
  const { calls } = await setup(page, { expanded: true, originalKnown: true });
  const inputs = page.locator('.bank-import-table input'); await expect(inputs).toHaveCount(17);
  for (const account of [...expandedAccounts, ...physicalCash]) {
    await expect(page.locator('.bank-import-table').getByText(account.display_name, { exact: true })).toBeVisible();
    await expect(page.getByLabel(`Saldo ${account.display_name}`, { exact: true })).toHaveValue(bankDisplayNames.includes(account.display_name) ? '100,00' : '');
  }
  await expect(page.locator('.bank-import-total')).toContainText('11 de 17 contas preenchidas');
  await expect(page.locator('.bank-import-total')).toContainText('POSIÇÃO INCOMPLETA');
  await expect(page.getByRole('button', { name: 'Salvar posição de caixa', exact: true })).toBeDisabled();
  expect(calls.some(call => call.name === 'save_bank_position')).toBe(false);
  await page.screenshot({ path: '/tmp/central-importar-17-contas.png', fullPage: true });
});

test('expanded position saves twelve bank balances and five company cash balances in one atomic payload', async ({ page }) => {
  const { calls } = await setup(page, { expanded: true, originalKnown: true });
  await page.getByLabel('Saldo BANCO CORA ECO PLAST', { exact: true }).fill('123,45');
  for (const account of physicalCash) await page.getByLabel(`Saldo ${account.display_name}`, { exact: true }).fill(account.company === 'ECOPLAST' ? '200,00' : '0,00');
  await page.getByLabel('Observação da posição', { exact: true }).fill('Contas bancárias e caixas conferidos.');
  await expect(page.locator('.bank-import-total')).toContainText('17 de 17 contas preenchidas');
  await expect(page.locator('.bank-import-total')).toContainText('R$ 1.423,45');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Salvar posição de caixa', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'salva com 17 contas' })).toBeVisible();
  const positions = calls.find(call => call.name === 'save_bank_position')!.body.p_positions;
  expect(positions).toHaveLength(17);
  expect(positions.find((item: any) => item.account_id.endsWith('000012'))).toEqual({ account_id: '10000000-0000-4000-8000-000000000012', amount_cents: 12345, expected_updated_at: null });
  expect(positions.find((item: any) => item.account_id.endsWith('000013'))).toEqual({ account_id: '10000000-0000-4000-8000-000000000013', amount_cents: 20000, expected_updated_at: null });
  expect(positions.filter((item: any) => item.expected_updated_at === stamp)).toHaveLength(11);
  expect(calls.filter(call => call.name === 'save_bank_position')).toHaveLength(1);
});
