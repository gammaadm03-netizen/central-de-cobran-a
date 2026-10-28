import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const id = (n: number) => `97000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = id(20), other = id(21), titleId = id(30);
interface Options { role?: 'gerente_geral' | 'diretor' | 'cobradora_1'; stale?: boolean; unassigned?: boolean; sourceCollection?: boolean; existingReceipt?: boolean; receiptDenied?: boolean; timeMissing?: boolean; timeEmpty?: boolean; timeMany?: boolean; wrongScope?: boolean; clockWrong?: boolean }
async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(new Date(options.clockWrong ? '2027-12-10T15:00:00Z' : '2026-10-18T15:00:00Z'));
  const role = options.role ?? 'gerente_geral', collector = role === 'cobradora_1', director = role === 'diretor';
  const permissions = [{ resource: 'cobranca', action: 'read' }, ...(!director ? [{ resource: 'cobranca', action: 'write' }] : []), ...(!collector ? [{ resource: 'contas_receber', action: 'read' }] : []), ...(!collector && !director ? [{ resource: 'contas_receber', action: 'write' }, { resource: 'contas_receber', action: 'validate' }] : [])];
  const access = { profile: { id: id(1), username: 'TesteSecundario', display_name: 'Pessoa sintética', role_key: role, enabled: true }, permissions, collector_id: collector ? own : null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id(1), session_id: id(2), exp: 4070908800, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const title = { id: titleId, scope: 'grupo-consolidado', document: 'NF-SEC-1', client_name: 'Cliente sintético pendente', branch: 'Filial sintética', due_date: '2026-09-01', amount_cents: 123456, collector_id: options.unassigned ? null : own, status: 'PENDING_VALIDATION', validation_status: 'PENDING', retired_from_report: false, payment_source: options.sourceCollection ? 'COBRANCA' : 'IMPORTACAO_DIARIA', payment_reported_date: null as string | null, revision: 4 };
  const calls: { name: string; body: any; query: string }[] = [], writes: { name: string; body: any }[] = [];
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!, body = request.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    calls.push({ name, body, query: url.search });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600 }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: id(1), aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: '2026-10-18T10:00:00Z', app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (name === 'collection_workbench') return reply({ as_of_date: '2026-10-18', server_now: '2026-10-18T15:00:00Z', snapshot_revision: 'secondary-empty-returns', active_timer: null, count: 0, total_cents: 0, rows: [], workflow: { version: '029', normal_pause: true, finish_requires_started: true, pending_read_only: true, returns_priority: true }, priority: { collector_id: collector ? own : null, due_count: 0, total_cents: 0, next_title_id: null, next_due_date: null } });
    if (name === 'receivable_collection_events') return reply(options.sourceCollection ? [{ id: id(91), title_id: titleId, action: 'PAID', collector_id: own, contact_date: '2026-10-17', observation: 'Pagamento informado no atendimento sintético.', return_note: null, payment_date: title.payment_reported_date, created_at: '2026-10-17T15:00:00Z' }] : []);
    if (['collections_overdue_summary', 'receivables_management_summary'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'collection_agents') return reply([{ id: own, display_name: 'Responsável A' }, ...(!collector ? [{ id: other, display_name: 'Responsável B' }] : [])]);
    if (name === 'receivable_titles' || name === 'collection_overdue_titles') {
      let rows = url.searchParams.has('id') || title.status === 'PENDING_VALIDATION' ? [title] : [];
      if (url.searchParams.get('retired_from_report') === 'eq.false') rows = rows.filter(row => !row.retired_from_report);
      const filter = url.searchParams.get('collector_id');
      if (filter === 'is.null') rows = rows.filter(row => row.collector_id === null);
      else if (filter?.startsWith('eq.')) rows = rows.filter(row => row.collector_id === filter.slice(3));
      return reply(rows, 200, rows.length);
    }
    if (name === 'effective_receivable_receipts') return options.receiptDenied ? reply({ code: '42501', message: 'private details' }, 403) : reply(options.existingReceipt ? [{ id: id(90), title_id: titleId, amount_cents: 120000, payment_date: '2026-10-17', validated_at: '2026-10-18T10:00:00Z' }] : []);
    if (name === 'collection_work_summary') {
      if (options.timeMissing) return reply({ code: 'PGRST202', message: 'private SQL' }, 404);
      const selected = collector ? own : body.p_collector_id || own;
      const owner = options.wrongScope ? other : selected;
      const rows = options.timeEmpty ? [] : Array.from({ length: options.timeMany ? 31 : 2 }, (_, index) => ({ title_id: titleId, document: `NF-TIME-${index + 1}`, client_name: 'Cliente sintético do tempo', branch: 'Filial sintética', collector_id: owner, collector_name: 'Responsável A', actor_id: id(1), actor_name: 'Pessoa sintética', session_id: id(100 + index), started_at: index === 1 ? '2026-10-18T14:29:50Z' : new Date(Date.UTC(2026, 9, 17, index)).toISOString(), ended_at: index === 1 ? null : new Date(Date.UTC(2026, 9, 17, index + 1)).toISOString(), end_reason: index === 1 ? null : 'PAUSE', seconds: index === 1 ? 1810 : 3600, running: index === 1 }));
      const seconds = rows.reduce((total, row) => total + row.seconds, 0), start = body.p_start ?? '2026-10-01', end = body.p_end ?? '2026-10-31';
      return reply({ start, end, as_of_date: '2026-10-18', server_now: '2026-10-18T15:00:00Z', total_seconds: seconds, session_count: rows.length, running_count: rows.length ? 1 : 0, title_count: rows.length ? 1 : 0, truncated: false,
        by_collector: rows.length ? [{ collector_id: owner, display_name: options.wrongScope ? 'Nome que não deve aparecer' : 'Responsável A', total_seconds: seconds, session_count: rows.length, running_count: 1, title_count: 1 }] : [],
        by_day: rows.length ? [{ date: '2026-10-18', total_seconds: seconds, session_count: rows.length, title_count: 1 }] : [], rows });
    }
    if (name === 'set_receivable_payment_date' || name === 'validate_receivable_payment_v2') {
      writes.push({ name, body });
      if (options.stale) return reply({ code: '40001', message: 'private sensitive SQL details' }, 409);
      if (body.p_payment_date && body.p_payment_date > '2026-10-18') return reply({ code: 'PV004', message: 'private date constraint' }, 400);
      title.revision++;
      if (name === 'set_receivable_payment_date') title.payment_reported_date = body.p_payment_date;
      else { title.status = body.p_decision === 'CONFIRM' ? 'VALIDATED' : 'NOT_LOCATED'; title.validation_status = body.p_decision === 'CONFIRM' ? 'VALIDATED' : 'NONE'; }
      return reply(name === 'set_receivable_payment_date' ? null : { format_version: '053', request_id: body.p_request_id, title_id: titleId, decision: body.p_decision, receipt_id: body.p_decision === 'CONFIRM' ? id(90) : null, payment_date: body.p_payment_date, nominal_cents: title.amount_cents, received_cents: body.p_decision === 'CONFIRM' ? body.p_received_cents : null, adjustment_cents: body.p_decision === 'CONFIRM' ? title.amount_cents - body.p_received_cents : null, adjustment_reason: body.p_adjustment_reason, title_revision: title.revision });
    }
    throw new Error(`Unexpected offline secondary request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('TesteSecundario'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible(); await page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true }).click();
  return { calls, writes, title };
}
async function validation(page: Page) { await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click(); await page.getByRole('button', { name: 'Conferir NF-SEC-1', exact: true }).click(); }
async function time(page: Page) { await page.getByRole('tab', { name: 'Tempo de trabalho', exact: true }).click(); }

test('validação exige data efetiva e confirmação; vencimento e valor original permanecem imutáveis', async ({ page }) => {
  const seen = await setup(page); await validation(page);
  await expect(page.getByLabel('Data real do recebimento', { exact: true })).toHaveValue('');
  await page.getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1234,56');
  await page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Informe a data real'); expect(seen.writes).toHaveLength(0);
  await page.getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-17'); page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click(); expect(seen.writes).toHaveLength(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Confira a entrada bancária'); return dialog.accept(); }); await page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Recebimento validado'); expect(seen.writes).toHaveLength(1); expect(seen.writes[0]).toEqual({ name: 'validate_receivable_payment_v2', body: { p_title_id: titleId, p_decision: 'CONFIRM', p_payment_date: '2026-10-17', p_received_cents: 123456, p_adjustment_reason: null, p_observation: '', p_expected_revision: 4, p_request_id: expect.any(String) } }); expect(seen.writes[0].body.p_request_id).toMatch(/^[a-f0-9-]{36}$/i);
  expect(seen.title.amount_cents).toBe(123456); expect(seen.title.due_date).toBe('2026-09-01');
});
test('data real pode ser salva sem confirmar recebimento nem retirar o título da fila', async ({ page }) => {
  const seen = await setup(page); await validation(page); await page.getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-17');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('mantém o recebimento pendente'); return dialog.accept(); }); await page.getByRole('button', { name: 'Salvar data real sem validar', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('continua aguardando validação financeira'); expect(seen.writes[0]).toEqual({ name: 'set_receivable_payment_date', body: { p_title_id: titleId, p_payment_date: '2026-10-17', p_expected_revision: 4 } }); expect(seen.title.status).toBe('PENDING_VALIDATION');
});
test('não localizado exige justificativa e volta para a mesma responsável sem data de pagamento', async ({ page }) => {
  const seen = await setup(page); await validation(page); await page.getByRole('combobox', { name: /^Decisão da validação/ }).selectOption('NOT_LOCATED');
  await page.getByRole('button', { name: 'Devolver à mesma responsável', exact: true }).click(); expect(seen.writes).toHaveLength(0);
  await page.getByLabel('Justificativa / observação da validação', { exact: true }).fill('Entrada não localizada no extrato');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('mesma responsável'); return dialog.accept(); }); await page.getByRole('button', { name: 'Devolver à mesma responsável', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Título devolvido à mesma responsável'); expect(seen.writes[0].body).toMatchObject({ p_title_id: titleId, p_decision: 'NOT_LOCATED', p_payment_date: null, p_observation: 'Entrada não localizada no extrato' }); expect(seen.writes[0].body).not.toHaveProperty('p_collector_id'); expect(seen.title.collector_id).toBe(own);
});
for (const role of ['diretor', 'cobradora_1'] as const) {
  test(`${role}: consulta validação sem poder confirmar, devolver ou alterar data`, async ({ page }) => {
    const seen = await setup(page, { role }); await validation(page); await expect(page.getByText('Este acesso permite somente consulta.', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Data real do recebimento', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toHaveCount(0); expect(seen.writes).toHaveLength(0);
    if (role === 'cobradora_1') {
      const reads = seen.calls.filter(call => ['receivable_titles', 'collection_overdue_titles'].includes(call.name));
      expect(reads.every(call => call.name === 'collection_overdue_titles' && new URLSearchParams(call.query).get('collector_id') === `eq.${own}`)).toBe(true);
    }
  });
}
test('conferência bloqueada não expõe detalhes técnicos e exige revisão da fila', async ({ page }) => {
  const seen = await setup(page, { stale: true }); await validation(page); await page.getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-17'); await page.getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1234,56');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Este título mudou'); await expect(page.getByText('private sensitive SQL details')).toHaveCount(0); expect(seen.title.status).toBe('PENDING_VALIDATION');
});
test('recebimento efetivo existente e falha de leitura impedem nova validação', async ({ page }) => {
  await setup(page, { existingReceipt: true }); await validation(page); await expect(page.getByText('Já existe recebimento validado:', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toBeDisabled();
});
test('fila filtra responsável no servidor sem alterar a carteira', async ({ page }) => {
  const seen = await setup(page); await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await page.getByRole('combobox', { name: /^Responsável pela carteira/ }).selectOption(other); await expect(page.getByText('Nenhum pagamento pendente para este filtro.', { exact: true })).toBeVisible();
  expect(seen.calls.some(call => call.name === 'receivable_titles' && new URLSearchParams(call.query).get('collector_id') === `eq.${other}`)).toBe(true); expect(seen.writes).toHaveLength(0);
});
test('tempo usa mês do servidor e soma somente segundos oficiais de intervalos pausados e em andamento', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor', clockWrong: true }); await time(page);
  await expect(page.getByLabel('Início do período de trabalho', { exact: true })).toHaveValue('2026-10-01'); await expect(page.getByLabel('Fim do período de trabalho', { exact: true })).toHaveValue('2026-10-31');
  await expect(page.locator('.collection-work-cards').getByText('01:30:10', { exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: 'Pausada', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: 'Em andamento', exact: true })).toBeVisible();
  expect(seen.calls.find(call => call.name === 'collection_work_summary')?.body).toEqual({ p_start: null, p_end: null, p_collector_id: null }); expect(seen.writes).toHaveLength(0);
});
test('tempo filtra período e responsável e pagina os detalhes sem recalcular os totais pela página', async ({ page }) => {
  const seen = await setup(page, { timeMany: true }); await time(page); await expect(page.getByRole('cell', { name: /NF-TIME-/ })).toHaveCount(25);
  const total = await page.locator('.collection-work-cards strong').allTextContents();
  await page.getByRole('button', { name: 'Próximos intervalos', exact: true }).click(); await expect(page.getByRole('cell', { name: /NF-TIME-/ })).toHaveCount(6); expect(await page.locator('.collection-work-cards strong').allTextContents()).toEqual(total);
  await page.getByLabel('Início do período de trabalho', { exact: true }).fill('2026-10-10'); await page.getByLabel('Fim do período de trabalho', { exact: true }).fill('2026-10-18'); await page.getByRole('combobox', { name: /^Responsável no tempo de trabalho/ }).selectOption(other); await page.getByRole('button', { name: 'Consultar tempo no período', exact: true }).click();
  await expect.poll(() => seen.calls.filter(call => call.name === 'collection_work_summary').at(-1)?.body).toEqual({ p_start: '2026-10-10', p_end: '2026-10-18', p_collector_id: other });
});
test('cobradora consulta somente tempo da própria carteira e rejeita resposta de outro escopo', async ({ page }) => {
  const seen = await setup(page, { role: 'cobradora_1', wrongScope: true }); await time(page); await expect(page.getByRole('alert')).toContainText('nenhum total foi presumido');
  expect(seen.calls.find(call => call.name === 'collection_work_summary')?.body.p_collector_id).toBe(own); await expect(page.getByRole('combobox', { name: /^Responsável no tempo de trabalho/ })).toHaveCount(0); await expect(page.getByText('Nome que não deve aparecer', { exact: true })).toHaveCount(0);
});
test('tempo sem atualização fica indisponível; uma consulta conhecida sem intervalos pode mostrar zero', async ({ page }) => {
  await setup(page, { timeMissing: true }); await time(page); await expect(page.getByRole('alert')).toContainText('Ative a atualização de Tempo de trabalho'); await expect(page.locator('.collection-work-cards').getByText('Não disponível', { exact: true })).toHaveCount(3);
});
test('consulta de tempo conhecida sem intervalos mostra zero e respeita a própria carteira', async ({ page }) => {
  const seen = await setup(page, { role: 'cobradora_1', timeEmpty: true }); await time(page);
  await expect(page.locator('.collection-work-cards').getByText('00:00:00', { exact: true })).toBeVisible();
  expect(seen.calls.find(call => call.name === 'collection_work_summary')?.body.p_collector_id).toBe(own); expect(seen.writes).toHaveLength(0);
});
test('falha de permissão ao conferir recebimentos não libera os botões financeiros', async ({ page }) => {
  const seen = await setup(page, { receiptDenied: true }); await validation(page); await expect(page.getByRole('alert')).toContainText('Seu perfil não permite esta consulta');
  await expect(page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toBeDisabled(); expect(seen.writes).toHaveLength(0);
});
test('financeiro usa limite de hoje do servidor e aceita data real mesmo com relógio local atrasado', async ({ page }) => {
  const seen = await setup(page); await page.clock.setFixedTime(new Date('2026-10-14T15:00:00Z')); await validation(page);
  await page.getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1234,56');
  await page.getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-19'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('data real'); expect(seen.title.status).toBe('PENDING_VALIDATION');
  await page.getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-18'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Recebimento validado'); expect(seen.writes.at(-1)?.body.p_payment_date).toBe('2026-10-18');
});
