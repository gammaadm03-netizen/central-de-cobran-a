import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const userId = '10000000-0000-4000-8000-000000000001';
const ownAgent = '20000000-0000-4000-8000-000000000001';
const otherAgent = '20000000-0000-4000-8000-000000000002';
const titleId = '30000000-0000-4000-8000-000000000001';
type Options = { role?: 'gerente_geral' | 'diretor' | 'contas_receber' | 'cobradora_1'; unbound?: boolean; unassigned?: boolean; pending?: boolean; stale?: boolean; pages?: boolean; exportChange?: boolean };

async function setup(page: Page, options: Options = {}) {
  const role = options.role ?? 'gerente_geral', collector = role === 'cobradora_1';
  const permissions: { resource: string; action: string }[] = (collector ? ['cobranca'] : ['contas_receber', 'cobranca']).map(resource => ({ resource, action: 'read' }));
  if (role !== 'diretor') permissions.push(...['contas_receber', 'cobranca'].filter(resource => !collector || resource === 'cobranca').map(resource => ({ resource, action: 'write' })));
  if (!collector && role !== 'diretor') permissions.push({ resource: 'contas_receber', action: 'validate' }, { resource: 'contas_receber', action: 'import' });
  if (role === 'gerente_geral') permissions.push({ resource: 'usuarios', action: 'admin' });
  const access = { profile: { id: userId, username: 'TesteOperacional', display_name: 'Pessoa sintética', role_key: role, enabled: true }, permissions, collector_id: collector && !options.unbound ? ownAgent : null };
  const claims = { sub: userId, session_id: '40000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), role: 'authenticated' };
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-test-only'].join('.');
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'synthetic@test.invalid', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} };
  const title = {
    id: titleId, scope: 'grupo-consolidado', document: 'NF-120', client_name: 'Cliente sintético da carteira', client_document: '12345678000199', customer_key: 'cnpj:12345678000199', branch: '3', issued_on: '2026-08-01', due_date: '2026-08-15', amount_cents: 123456,
    collector_id: options.unassigned ? null : ownAgent, status: options.pending ? 'PENDING_VALIDATION' : 'OPEN', validation_status: options.pending ? 'PENDING' : 'NONE', payment_source: options.pending ? 'IMPORTACAO_DIARIA' : null, payment_reported_date: null as string | null, payment_date: null as string | null,
    reported_in_collection: false, collector_locked: false, in_latest_report: !options.pending, revision: 7, updated_at: '2026-10-15T10:00:00Z', last_action: null as string | null, next_action: null as string | null, next_action_date: null,
  };
  const seen = { titleQueries: [] as string[], writes: [] as { name: string; body: any }[], events: [] as any[], receipts: [] as any[], exportSnapshots: 0 };
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count !== undefined ? { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' } : {}) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply(user);
    if (url.pathname === '/rest/v1/rpc/current_access') return reply(access);
    if (url.pathname === '/rest/v1/collection_agents') return reply([{ id: ownAgent, display_name: 'Responsável A', enabled: true }, ...(collector ? [] : [{ id: otherAgent, display_name: 'Responsável B', enabled: true }])], 200, collector ? 1 : 2);
    if (url.pathname === '/rest/v1/receivable_titles') {
      seen.titleQueries.push(url.search);
      if (url.searchParams.get('select') === 'id,revision,updated_at') { seen.exportSnapshots++; return reply([{ id: title.id, revision: seen.exportSnapshots > 1 && options.exportChange ? 8 : 7, updated_at: title.updated_at }]); }
      if (options.unbound || title.status === 'VALIDATED' && url.searchParams.get('status') === 'neq.VALIDATED') return reply([], 200, 0);
      if (options.pages) { const offset = Number(url.searchParams.get('offset') ?? '0'), limit = Number(url.searchParams.get('limit') ?? '25'); return reply(Array.from({ length: Math.min(limit, 26 - offset) }, (_, i) => ({ ...title, id: `${titleId}-${offset + i}`, document: `NF-${offset + i + 1}` })), 200, 26); }
      return reply([title], 200, 1);
    }
    if (url.pathname === '/rest/v1/receivable_collection_events') return reply(seen.events);
    if (url.pathname === '/rest/v1/receivable_receipts') return reply(seen.receipts);
    if (url.pathname === '/rest/v1/receivable_imports') return reply([], 200, 0);
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1)!;
      seen.writes.push({ name, body });
      if (options.stale) return reply({ code: '40001', message: 'private SQL details and sensitive stack trace' }, 409);
      title.revision++;
      if (name === 'assign_receivable_collector') { title.collector_id = body.p_collector_id; return reply(2); }
      if (name === 'record_collection_action') {
        title.last_action = body.p_action;
        if (body.p_action === 'PAID') { title.status = 'PENDING_VALIDATION'; title.validation_status = 'PENDING'; title.payment_source = 'COBRANCA'; title.payment_reported_date = body.p_payment_date; title.reported_in_collection = true; }
        seen.events.unshift({ id: 'synthetic-event', action: body.p_action, contact_date: body.p_contact_date, next_action: body.p_next_action, next_date: body.p_next_date, observation: body.p_observation, return_note: body.p_return_note, payment_date: body.p_payment_date, created_at: '2026-10-15T14:00:00Z' });
        return reply('50000000-0000-4000-8000-000000000001');
      }
      if (name === 'validate_receivable_payment') {
        title.status = body.p_decision === 'CONFIRM' ? 'VALIDATED' : 'NOT_LOCATED'; title.validation_status = body.p_decision === 'CONFIRM' ? 'VALIDATED' : 'NONE';
        title.payment_date = body.p_payment_date;
        if (body.p_decision === 'NOT_LOCATED') { title.payment_source = null; title.payment_reported_date = null; title.next_action = 'RETRY'; }
        else seen.receipts.push({ id: 'synthetic-receipt', amount_cents: title.amount_cents, payment_date: body.p_payment_date, delay_days: 60, delay_band: '31_60', payment_source: title.payment_source, validated_at: '2026-10-15T15:00:00Z' });
        return reply(body.p_decision === 'CONFIRM' ? '60000000-0000-4000-8000-000000000001' : null);
      }
      throw new Error(`Unexpected RPC ${name}`);
    }
    throw new Error(`Unexpected offline request ${request.method()} ${url.pathname}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('TesteOperacional'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  return seen;
}

async function openDetail(page: Page) { await page.getByRole('button', { name: 'Detalhar título NF-120 de Cliente sintético da carteira', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Título NF-120 · Cliente sintético da carteira' })).toBeVisible(); }

test('CR atribui explicitamente todos os títulos não atribuídos do cliente sem presumir vínculo de login', async ({ page }) => {
  const seen = await setup(page, { role: 'contas_receber', unassigned: true }); await openDetail(page);
  await page.getByRole('combobox', { name: 'Cobradora responsável', exact: true }).selectOption(otherAgent); await page.getByLabel('Justificativa da atribuição').fill('Distribuição validada pela gerência');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('todos os títulos ativos ainda sem cobradora'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Confirmar atribuição' }).click();
  await expect(page.getByRole('status')).toContainText('2 título(s) atribuído(s) a Responsável B');
  expect(seen.writes).toEqual([{ name: 'assign_receivable_collector', body: { p_customer_key: 'cnpj:12345678000199', p_collector_id: otherAgent, p_observation: 'Distribuição validada pela gerência' } }]);
});

test('cobradora consulta somente sua carteira e pagamento exige data e confirmação sem validação financeira', async ({ page }) => {
  const seen = await setup(page, { role: 'cobradora_1' }); await expect(page.getByRole('heading', { name: 'Minha carteira de cobrança' })).toBeVisible();
  expect(seen.titleQueries.every(query => new URLSearchParams(query).get('collector_id') === `eq.${ownAgent}`)).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Cobradora', exact: true })).toHaveCount(0); await openDetail(page);
  await expect(page.getByText('Validar pagamento no financeiro', { exact: true })).toHaveCount(0); await expect(page.getByRole('combobox', { name: 'Cobradora responsável', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Ação de cobrança', exact: true }).selectOption('PAID'); await page.getByRole('button', { name: 'Informar pagamento para validação' }).click(); expect(seen.writes).toHaveLength(0);
  await page.getByLabel('Data do pagamento informado', { exact: true }).fill('2026-10-14');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('não confirma o recebimento'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Informar pagamento para validação' }).click();
  await expect(page.getByRole('status')).toContainText('Pagamento informado. O título permanece na carteira');
  expect(seen.writes[0].name).toBe('record_collection_action'); expect(seen.writes[0].body).toMatchObject({ p_title_id: titleId, p_action: 'PAID', p_payment_date: '2026-10-14', p_expected_revision: 7 });
  expect(seen.writes.some(write => write.name === 'validate_receivable_payment')).toBe(false);
  await expect(page.getByRole('table').getByText('Pago — aguardando validação', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
});

test('cobradora sem vínculo recebe orientação e não consulta títulos nem carteiras de outras pessoas', async ({ page }) => {
  const seen = await setup(page, { role: 'cobradora_1', unbound: true });
  await expect(page.getByRole('status')).toContainText('Seu login ainda não está vinculado');
  expect(seen.titleQueries).toHaveLength(0); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Registrar ação', exact: true })).toHaveCount(0);
});

test('recebimento exige data real e confirma financeiramente somente após confirmação explícita', async ({ page }) => {
  const seen = await setup(page, { role: 'contas_receber', pending: true }); await page.getByRole('button', { name: 'Abrir fila de validação' }).click(); await openDetail(page);
  await expect(page.getByText('Informe a data real do pagamento após conferir a entrada bancária.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar recebimento financeiro' }).click(); expect(seen.writes).toHaveLength(0);
  await page.getByLabel('Data real do pagamento', { exact: true }).fill('2026-10-14');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Confirmar recebimento financeiro' }).click(); expect(seen.writes).toHaveLength(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Confirmar financeiramente'); return dialog.accept(); }); await page.getByRole('button', { name: 'Confirmar recebimento financeiro' }).click();
  await expect(page.getByRole('status')).toContainText('Recebimento validado');
  expect(seen.writes[0]).toEqual({ name: 'validate_receivable_payment', body: { p_title_id: titleId, p_decision: 'CONFIRM', p_payment_date: '2026-10-14', p_observation: '', p_expected_revision: 7 } });
  await page.getByLabel('Situação do título').selectOption(''); await openDetail(page); await expect(page.getByText('Recebimento validado: R$ 1.234,56', { exact: false })).toBeVisible();
});

test('financeiro não localizado exige justificativa, preserva a mesma cobradora e solicita cobrar novamente', async ({ page }) => {
  const seen = await setup(page, { role: 'contas_receber', pending: true }); await openDetail(page);
  await page.getByLabel('Decisão financeira').selectOption('NOT_LOCATED'); await page.getByRole('button', { name: 'Devolver à mesma cobradora' }).click(); expect(seen.writes).toHaveLength(0);
  await page.getByLabel('Observação da validação').fill('Entrada não encontrada no extrato');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('mesma cobradora'); expect(dialog.message()).toContain('não gerará recebimento nem comissão'); return dialog.accept(); }); await page.getByRole('button', { name: 'Devolver à mesma cobradora' }).click();
  await expect(page.getByRole('status')).toContainText('Título devolvido à mesma cobradora');
  expect(seen.writes[0].body).toEqual({ p_title_id: titleId, p_decision: 'NOT_LOCATED', p_payment_date: null, p_observation: 'Entrada não encontrada no extrato', p_expected_revision: 7 });
  expect(seen.writes[0].body).not.toHaveProperty('p_collector_id'); await expect(page.getByRole('cell', { name: 'Responsável A', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: 'Cobrar novamente —', exact: false })).toBeVisible();
});

test('título alterado concorrentemente exige atualização sem expor erro técnico nem indicar sucesso', async ({ page }) => {
  const seen = await setup(page, { role: 'contas_receber', pending: true, stale: true }); await openDetail(page); await page.getByLabel('Data real do pagamento', { exact: true }).fill('2026-10-14');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar recebimento financeiro' }).click();
  await expect(page.getByRole('alert')).toContainText('Este título foi alterado por outra operação'); await expect(page.getByText('private SQL details', { exact: false })).toHaveCount(0); expect(seen.receipts).toHaveLength(0); await expect(page.getByRole('button', { name: 'Confirmar recebimento financeiro' })).toBeEnabled();
});

test('diretor consulta CR, carteiras e histórico sem ações de escrita', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor', pending: true }); await openDetail(page);
  await expect(page.getByText('Validar pagamento no financeiro', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Ir para Importar Bases' })).toHaveCount(0); await expect(page.getByRole('combobox', { name: 'Cobradora responsável', exact: true })).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true }).click(); await openDetail(page); await expect(page.getByText('Registrar ação de cobrança', { exact: true })).toHaveCount(0); expect(seen.writes).toHaveLength(0);
});

test('busca escapa curingas, envia filtros ao banco e pagina sem carregar todos os títulos', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor', pages: true }); await expect(page.getByRole('button', { name: 'Detalhar', exact: false })).toHaveCount(25);
  await page.getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(page.getByText('26 títulos · página 2 de 2')).toBeVisible(); await expect(page.getByRole('button', { name: 'Detalhar', exact: false })).toHaveCount(1);
  await page.getByLabel('Pesquisar cliente / órgão', { exact: true }).fill('Cliente_%'); await expect.poll(() => seen.titleQueries.some(query => new URLSearchParams(query).get('client_name') === 'ilike.%Cliente\\_\\%%')).toBe(true);
  await page.getByLabel('Filial', { exact: true }).fill('3'); await page.getByRole('combobox', { name: 'Cobradora', exact: true }).selectOption('unassigned');
  await expect.poll(() => seen.titleQueries.some(query => { const p = new URLSearchParams(query); return p.get('branch') === 'eq.3' && p.get('collector_id') === 'is.null'; })).toBe(true);
  await page.getByRole('button', { name: 'Limpar filtros' }).click(); await expect(page.getByLabel('Pesquisar cliente / órgão', { exact: true })).toHaveValue('');
});

test('CSV completo respeita os filtros e recusa baixar quando uma operação altera a base durante a exportação', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor', exportChange: true });
  await page.getByRole('button', { name: 'Baixar CSV dos filtros' }).click(); await expect(page.getByRole('alert')).toContainText('A base mudou durante a exportação'); expect(seen.exportSnapshots).toBe(2);
});

test('CSV da carteira exporta todos os registros filtrados além da primeira página', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor', pages: true });
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar CSV dos filtros' }).click();
  const download = await pending, path = await download.path(); expect(path).not.toBeNull();
  const content = await readFile(path!, 'utf8'); expect(content).toContain('"NF-26"'); expect(content.split('\r\n')).toHaveLength(27); expect(content).toContain('"1234,56"');
  expect(seen.titleQueries.some(query => { const p = new URLSearchParams(query); return p.get('limit') === '500' && p.get('status') === 'neq.VALIDATED'; })).toBe(true);
});
