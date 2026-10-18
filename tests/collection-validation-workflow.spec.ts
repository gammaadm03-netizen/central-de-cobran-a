import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const id = (value: number) => `98000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const userId = id(1), sessionId = id(2), agentId = id(20), titleId = id(30);
const originalObservation = 'Cliente informou pagamento e enviou comprovante.\nConferir a entrada bancária antes da baixa.';
interface Options { role?: 'contas_receber' | 'diretor' | 'cobradora_1'; reportDenied?: boolean; wrongReport?: boolean; noReport?: boolean; receiptExists?: boolean; stale?: boolean; unassigned?: boolean }

async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(new Date('2026-10-18T15:00:00Z'));
  const role = options.role ?? 'contas_receber', collector = role === 'cobradora_1', director = role === 'diretor';
  const permissions = [{ resource: 'cobranca', action: 'read' }, ...(!collector ? [{ resource: 'contas_receber', action: 'read' }] : []), ...(!director ? [{ resource: 'cobranca', action: 'write' }] : []), ...(!collector && !director ? ['write', 'validate'].map(action => ({ resource: 'contas_receber', action })) : [])];
  const access = { profile: { id: userId, username: 'FinanceiroSintetico', display_name: 'Pessoa financeira sintética', role_key: role, enabled: true }, permissions, collector_id: collector ? agentId : null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId, exp: 4070908800, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const title = { id: titleId, scope: 'grupo-consolidado', document: 'NF-FIN-1', client_name: 'Órgão sintético da conferência', client_document: null, customer_key: 'name:ÓRGÃO SINTÉTICO DA CONFERÊNCIA', branch: '4', issued_on: '2026-08-01', due_date: '2026-08-15', amount_cents: 123456,
    collector_id: options.unassigned ? null : agentId, status: 'PENDING_VALIDATION', validation_status: 'PENDING', payment_source: 'COBRANCA' as string | null, payment_reported_date: '2026-10-17' as string | null, payment_date: null as string | null,
    reported_in_collection: true, collector_locked: false, in_latest_report: true, revision: 7, updated_at: '2026-10-18T14:00:00Z', last_action: 'PAID', next_action: null as string | null, next_action_date: null as string | null };
  const reported = { id: id(40), title_id: options.wrongReport ? id(999) : titleId, action: 'PAID', collector_id: agentId, contact_date: '2026-10-18', next_action: null, next_date: null, observation: originalObservation, return_note: 'Status operacional: TÍTULO PAGO; próxima ação: VALIDAÇÃO FINANCEIRA', payment_date: '2026-10-17', created_at: '2026-10-18T14:10:00Z' };
  const receipts: Record<string, unknown>[] = options.receiptExists ? [{ id: id(50), title_id: titleId, amount_cents: title.amount_cents, payment_date: '2026-10-17', delay_days: 63, delay_band: '61_90', payment_source: 'COBRANCA', validated_at: '2026-10-18T14:30:00Z' }] : [];
  const calls: { name: string; query: string; body: any }[] = [], writes: { name: string; body: any }[] = [];
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!, body = request.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (payload: unknown, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json: payload });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    calls.push({ name, query: url.search, body });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.invalid', created_at: '2026-10-18T10:00:00Z', app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (['collections_overdue_summary', 'receivables_management_summary'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'collection_workbench') return reply({ as_of_date: '2026-10-18', server_now: '2026-10-18T15:00:00Z', snapshot_revision: 'financial-workflow-empty-returns', active_timer: null, count: 0, total_cents: 0, rows: [], workflow: { version: '029', normal_pause: true, finish_requires_started: true, pending_read_only: true, returns_priority: true }, priority: { collector_id: collector ? agentId : null, due_count: 0, total_cents: 0, next_title_id: null, next_due_date: null } });
    if (name === 'collection_agents') return reply([{ id: agentId, display_name: 'Cobradora sintética responsável', enabled: true }]);
    if (name === 'receivable_titles' || name === 'collection_overdue_titles') {
      let rows = [{ ...title, ...(name === 'collection_overdue_titles' ? { collection_as_of_date: '2026-10-18' } : {}) }];
      const status = url.searchParams.get('status'), validation = url.searchParams.get('validation_status'), owner = url.searchParams.get('collector_id');
      if (status?.startsWith('eq.')) rows = rows.filter(row => row.status === status.slice(3));
      else if (status === 'neq.VALIDATED') rows = rows.filter(row => row.status !== 'VALIDATED');
      if (validation?.startsWith('eq.')) rows = rows.filter(row => row.validation_status === validation.slice(3));
      if (owner === 'is.null') rows = rows.filter(row => row.collector_id === null);
      else if (owner?.startsWith('eq.')) rows = rows.filter(row => row.collector_id === owner.slice(3));
      return reply(rows, 200, rows.length);
    }
    if (name === 'receivable_collection_events') {
      if (options.reportDenied) return reply({ code: '42501', message: 'private SQL and another customer must never appear' }, 403);
      return reply(options.noReport ? [] : [reported]);
    }
    if (name === 'effective_receivable_receipts' || name === 'receivable_receipts') return reply(receipts);
    if (name === 'validate_receivable_payment') {
      writes.push({ name, body });
      if (director || collector) return reply({ code: '42501' }, 403);
      if (options.stale || body.p_expected_revision !== title.revision) return reply({ code: '40001', message: 'private SQL conflict details' }, 409);
      if (body.p_payment_date && body.p_payment_date > '2026-10-18') return reply({ code: '23514' }, 400);
      title.revision++;
      if (body.p_decision === 'CONFIRM') {
        title.status = 'VALIDATED'; title.validation_status = 'VALIDATED'; title.payment_date = body.p_payment_date;
        receipts.push({ id: id(50), title_id: titleId, amount_cents: title.amount_cents, payment_date: body.p_payment_date, delay_days: 62, delay_band: '61_90', collector_id: title.collector_id, payment_source: 'COBRANCA', validated_at: '2026-10-18T15:00:00Z' });
      } else {
        title.status = 'NOT_LOCATED'; title.validation_status = 'NONE'; title.payment_source = null; title.payment_reported_date = null; title.payment_date = null; title.reported_in_collection = false; title.collector_locked = true; title.last_action = 'PAYMENT_NOT_LOCATED'; title.next_action = 'RETRY'; title.next_action_date = '2026-10-18';
      }
      return reply(body.p_decision === 'CONFIRM' ? id(50) : null);
    }
    throw new Error(`Unexpected synthetic financial workflow request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('FinanceiroSintetico'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  if (!collector) await page.getByRole('navigation').getByRole('button', { name: 'Contas a Receber', exact: true }).click();
  return { calls, writes, title, reported, receipts };
}
const validationPanel = (page: Page) => page.getByRole('tabpanel', { name: 'Validação financeira', exact: true });
async function openValidation(page: Page) {
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await validationPanel(page).getByRole('button', { name: 'Conferir NF-FIN-1', exact: true }).click();
  await expect(validationPanel(page).getByRole('region', { name: 'Relato original da cobrança', exact: true })).toContainText(originalObservation);
}

test('Contas a Receber abre a fila dedicada e exibe o último PAID original sem reutilizar sua observação como decisão financeira', async ({ page }) => {
  const seen = await setup(page);
  await page.getByRole('button', { name: 'Abrir fila de validação', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Validação financeira', exact: true })).toHaveAttribute('aria-selected', 'true');
  await validationPanel(page).getByRole('button', { name: 'Conferir NF-FIN-1', exact: true }).click();
  const original = validationPanel(page).getByRole('region', { name: 'Relato original da cobrança', exact: true });
  await expect(original).toContainText(originalObservation); await expect(original).toContainText('17/10/2026'); await expect(original).toContainText('Cobradora sintética responsável');
  await expect(validationPanel(page).getByLabel('Data real do recebimento', { exact: true })).toHaveValue('2026-10-17');
  await expect(validationPanel(page).getByRole('textbox', { name: 'Justificativa / observação da validação', exact: true })).toHaveValue('');
  const read = seen.calls.find(call => call.name === 'receivable_collection_events')!;
  const query = new URLSearchParams(read.query); expect(query.get('title_id')).toBe(`eq.${titleId}`); expect(query.get('action')).toBe('eq.PAID'); expect(query.get('limit')).toBe('1'); expect(query.get('order')).toBe('created_at.desc,id.desc');
  expect(seen.calls.some(call => call.name === 'receivable_titles' && new URLSearchParams(call.query).get('validation_status') === 'eq.PENDING')).toBe(true);
  expect(seen.writes).toHaveLength(0);
});

test('confirmar usa a data real escolhida no financeiro e preserva o relato original e a responsável', async ({ page }) => {
  const seen = await setup(page); await openValidation(page);
  await validationPanel(page).getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-16');
  await validationPanel(page).getByRole('textbox', { name: 'Justificativa / observação da validação', exact: true }).fill('Entrada bancária conferida pelo financeiro.');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('16/10/2026'); return dialog.accept(); });
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('status')).toContainText('Recebimento validado');
  expect(seen.writes).toEqual([{ name: 'validate_receivable_payment', body: { p_title_id: titleId, p_decision: 'CONFIRM', p_payment_date: '2026-10-16', p_observation: 'Entrada bancária conferida pelo financeiro.', p_expected_revision: 7 } }]);
  expect(seen.receipts).toHaveLength(1); expect(seen.title.collector_id).toBe(agentId); expect(seen.title.amount_cents).toBe(123456); expect(seen.title.due_date).toBe('2026-08-15');
  expect(seen.reported.payment_date).toBe('2026-10-17'); expect(seen.reported.observation).toBe(originalObservation);
  await expect(validationPanel(page).getByText('Nenhum pagamento pendente para este filtro.', { exact: true })).toBeVisible();
});

test('devolução exige justificativa e mantém a mesma cobradora sem informar data nem criar recebimento', async ({ page }) => {
  const seen = await setup(page); await openValidation(page);
  await validationPanel(page).getByRole('combobox', { name: /^Decisão da validação/ }).selectOption('NOT_LOCATED');
  await validationPanel(page).getByRole('button', { name: 'Devolver à mesma responsável', exact: true }).click(); expect(seen.writes).toHaveLength(0);
  await validationPanel(page).getByRole('textbox', { name: 'Justificativa / observação da validação', exact: true }).fill('Comprovante não corresponde à entrada da conta. Retornar à responsável.');
  page.once('dialog', dialog => dialog.accept()); await validationPanel(page).getByRole('button', { name: 'Devolver à mesma responsável', exact: true }).click();
  await expect(validationPanel(page).getByRole('status')).toContainText('Título devolvido à mesma responsável');
  expect(seen.writes[0].body).toMatchObject({ p_title_id: titleId, p_decision: 'NOT_LOCATED', p_payment_date: null, p_expected_revision: 7 }); expect(seen.writes[0].body).not.toHaveProperty('p_collector_id');
  expect(seen.title.status).toBe('NOT_LOCATED'); expect(seen.title.collector_id).toBe(agentId); expect(seen.title.collector_locked).toBe(true); expect(seen.receipts).toHaveLength(0);
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click(); await expect(page.getByRole('tabpanel', { name: 'Títulos', exact: true }).getByRole('table').getByText('Pagamento não localizado — cobrar novamente', { exact: true })).toBeVisible();
});

test('a conferência mantém a decisão e sua justificativa ao alternar as subabas de Contas a Receber', async ({ page }) => {
  await setup(page); await openValidation(page);
  await validationPanel(page).getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-16');
  await validationPanel(page).getByRole('textbox', { name: 'Justificativa / observação da validação', exact: true }).fill('Conferência ainda em andamento.');
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click(); await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await expect(validationPanel(page).getByLabel('Data real do recebimento', { exact: true })).toHaveValue('2026-10-16');
  await expect(validationPanel(page).getByRole('textbox', { name: 'Justificativa / observação da validação', exact: true })).toHaveValue('Conferência ainda em andamento.');
});

test('Diretoria consulta a fila de Contas a Receber e o relato original sem controles financeiros', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor' }); await openValidation(page);
  await expect(validationPanel(page).getByText('Este acesso permite somente consulta.', { exact: false })).toBeVisible();
  await expect(validationPanel(page).getByLabel('Data real do recebimento', { exact: true })).toHaveCount(0);
  await expect(validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toHaveCount(0); expect(seen.writes).toHaveLength(0);
});

test('cobradora acompanha sua própria pendência na Validação sem acesso à aba Contas a Receber ou à confirmação', async ({ page }) => {
  const seen = await setup(page, { role: 'cobradora_1' }); await openValidation(page);
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Contas a Receber', exact: true })).toHaveCount(0);
  await expect(validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toHaveCount(0);
  const reads = seen.calls.filter(call => call.name === 'collection_overdue_titles'); expect(reads.length).toBeGreaterThan(0);
  expect(reads.every(call => new URLSearchParams(call.query).get('collector_id') === `eq.${agentId}`)).toBe(true); expect(seen.writes).toHaveLength(0);
});

for (const option of ['reportDenied', 'wrongReport'] as const) {
  test(`leitura do relato ${option} bloqueia confirmação sem expor outro título ou erros privados`, async ({ page }) => {
    const seen = await setup(page, { [option]: true });
    await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click(); await validationPanel(page).getByRole('button', { name: 'Conferir NF-FIN-1', exact: true }).click();
    await expect(validationPanel(page).getByRole('alert')).toBeVisible();
    await expect(validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toBeDisabled();
    await expect(page.getByText('private SQL and another customer must never appear', { exact: true })).toHaveCount(0);
    await expect(validationPanel(page).getByText(originalObservation, { exact: true })).toHaveCount(0); expect(seen.writes).toHaveLength(0);
  });
}

test('recebimento já efetivado impede uma segunda confirmação financeira', async ({ page }) => {
  const seen = await setup(page, { receiptExists: true }); await openValidation(page);
  await expect(validationPanel(page).getByText('Já existe recebimento validado:', { exact: false })).toBeVisible();
  await expect(validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toBeDisabled(); expect(seen.writes).toHaveLength(0); expect(seen.receipts).toHaveLength(1);
});

test('conflito financeiro preserva o relato e exige atualizar a fila sem repetir a confirmação', async ({ page }) => {
  const seen = await setup(page, { stale: true }); await openValidation(page);
  page.once('dialog', dialog => dialog.accept()); await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText('Este título mudou'); await expect(validationPanel(page).getByRole('region', { name: 'Relato original da cobrança', exact: true })).toContainText(originalObservation);
  expect(seen.writes).toHaveLength(1); expect(seen.title.status).toBe('PENDING_VALIDATION'); expect(seen.receipts).toHaveLength(0);
});

test('ausência conhecida de relato não inventa observações, e responsável ausente tem orientação de atribuição', async ({ page }) => {
  const seen = await setup(page, { noReport: true, unassigned: true });
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click(); await validationPanel(page).getByRole('button', { name: 'Conferir NF-FIN-1', exact: true }).click();
  await expect(validationPanel(page).getByText('Não há relato de pagamento da cobrança disponível para este título.', { exact: true })).toBeVisible();
  await expect(validationPanel(page).getByText('Este título está sem responsável definida.', { exact: false })).toBeVisible();
  await expect(validationPanel(page).getByRole('combobox', { name: /^Decisão da validação/ }).locator('option[value="NOT_LOCATED"]')).toHaveJSProperty('disabled', true); expect(seen.writes).toHaveLength(0);
});
