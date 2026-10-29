import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const id = (value: number) => `98000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const userId = id(1), sessionId = id(2), agentId = id(20), titleId = id(30);
const originalObservation = 'Cliente informou pagamento e enviou comprovante.\nConferir a entrada bancária antes da baixa.';
interface Options { role?: 'contas_receber' | 'diretor' | 'cobradora_1'; reportDenied?: boolean; wrongReport?: boolean; noReport?: boolean; receiptExists?: boolean; stale?: boolean; unassigned?: boolean; retired?: boolean; ignoreRetiredFilter?: boolean; missingRetirement?: boolean; detailRetired?: boolean; detailDenied?: boolean; wrongDetail?: boolean; missing053?: boolean; netExample?: boolean; commitRace?: 'retired' | 'validated'; uncertain?: 'lost-after-commit' | 'proof'; retiredQueue?: boolean; retiredSourceMissing?: boolean; retiredQueueUnsafe?: boolean; retiredProofOld?: boolean; format055?: boolean }

async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(new Date('2026-10-18T15:00:00Z'));
  const role = options.role ?? 'contas_receber', collector = role === 'cobradora_1', director = role === 'diretor';
  const permissions = [{ resource: 'cobranca', action: 'read' }, ...(!collector ? [{ resource: 'contas_receber', action: 'read' }] : []), ...(!director ? [{ resource: 'cobranca', action: 'write' }] : []), ...(!collector && !director ? ['write', 'validate'].map(action => ({ resource: 'contas_receber', action })) : [])];
  const access = { profile: { id: userId, username: 'FinanceiroSintetico', display_name: 'Pessoa financeira sintética', role_key: role, enabled: true }, permissions, collector_id: collector ? agentId : null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId, exp: 4070908800, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const title = { id: titleId, scope: 'grupo-consolidado', document: 'NF-FIN-1', client_name: 'Órgão sintético da conferência', client_document: null, customer_key: 'name:ÓRGÃO SINTÉTICO DA CONFERÊNCIA', branch: '4', issued_on: '2026-08-01', due_date: '2026-08-15', amount_cents: 123456,
    collector_id: options.unassigned ? null : agentId, status: 'PENDING_VALIDATION', validation_status: 'PENDING', payment_source: 'COBRANCA' as string | null, payment_reported_date: '2026-10-17' as string | null, payment_date: null as string | null,
    retired_from_report: options.retiredQueue || options.retired || false, reported_in_collection: true, collector_locked: false, in_latest_report: true, revision: 7, updated_at: '2026-10-18T14:00:00Z', last_action: 'PAID', next_action: null as string | null, next_action_date: null as string | null };
  if (options.netExample) { title.amount_cents = 424020; title.document = 'NF-FIN-1'; title.payment_reported_date = '2026-08-07'; }
  if (options.retiredSourceMissing) { title.status = 'OPEN'; title.validation_status = 'NONE'; title.payment_source = null; title.payment_reported_date = null; title.reported_in_collection = false; title.last_action = 'CONTACT'; }
  const reported = { id: id(40), title_id: options.wrongReport ? id(999) : titleId, action: 'PAID', collector_id: agentId, contact_date: '2026-10-18', next_action: null, next_date: null, observation: originalObservation, return_note: 'Status operacional: TÍTULO PAGO; próxima ação: VALIDAÇÃO FINANCEIRA', payment_date: '2026-10-17', created_at: '2026-10-18T14:10:00Z' };
  const receipts: Record<string, unknown>[] = options.receiptExists ? [{ id: id(50), title_id: titleId, amount_cents: title.amount_cents, payment_date: '2026-10-17', delay_days: 63, delay_band: '61_90', payment_source: 'COBRANCA', validated_at: '2026-10-18T14:30:00Z' }] : [];
  const results = new Map<string, Record<string, unknown>>();
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
    if (name === 'receivable_retired_validation_queue') {
      const eligible = options.retiredQueue && title.retired_from_report && title.status !== 'VALIDATED' && !receipts.length && (!body.p_search || `${title.document} ${title.client_name}`.includes(body.p_search));
      const rows = eligible ? [{ ...title, collection_worked: !options.retiredQueueUnsafe }] : [];
      return reply({ format_version: '055', count: rows.length, rows });
    }
    if (name === 'receivable_titles' || name === 'collection_overdue_titles') {
      if (url.searchParams.has('id') && options.detailDenied) return reply({ code: '42501', message: 'private title details' }, 403);
      if (url.searchParams.has('id') && options.detailRetired) title.retired_from_report = true;
      let rows = [{ ...title, ...(options.missingRetirement ? { retired_from_report: undefined } : {}), ...(url.searchParams.has('id') && options.wrongDetail ? { id: id(999) } : {}), ...(name === 'collection_overdue_titles' ? { collection_as_of_date: '2026-10-18' } : {}) }];
      const status = url.searchParams.get('status'), validation = url.searchParams.get('validation_status'), owner = url.searchParams.get('collector_id');
      if (status?.startsWith('eq.')) rows = rows.filter(row => row.status === status.slice(3));
      else if (status === 'neq.VALIDATED') rows = rows.filter(row => row.status !== 'VALIDATED');
      const retired = url.searchParams.get('retired_from_report');
      if (!options.ignoreRetiredFilter && retired === 'eq.false' && title.retired_from_report) rows = [];
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
    if (name === 'validate_receivable_payment_v2') {
      writes.push({ name, body });
      if (options.missing053) return reply({ code: 'PGRST202', message: 'private function signature' }, 404);
      if (results.has(body.p_request_id)) return reply(results.get(body.p_request_id));
      if (director || collector) return reply({ code: '42501' }, 403);
      if (options.commitRace === 'retired') { title.retired_from_report = true; title.revision++; return reply({ code: 'PV001', message: 'private retirement query' }, 409); }
      if (options.commitRace === 'validated') { title.status = 'VALIDATED'; title.validation_status = 'VALIDATED'; title.revision++; receipts.push({ id: id(50), title_id: titleId, amount_cents: title.amount_cents, payment_date: '2026-10-17', validated_at: '2026-10-18T15:00:00Z' }); return reply({ code: 'PV003' }, 409); }
      if (options.stale || body.p_expected_revision !== title.revision) return reply({ code: '40001', message: 'private SQL conflict details' }, 409);
      if (body.p_payment_date && body.p_payment_date > '2026-10-18') return reply({ code: 'PV004', message: 'private future guard' }, 400);
      if (title.retired_from_report && (!options.retiredQueue || body.p_decision !== 'CONFIRM')) return reply({ code: 'PV001' }, 409);
      title.revision++;
      if (body.p_decision === 'CONFIRM') {
        title.status = 'VALIDATED'; title.validation_status = 'VALIDATED'; title.payment_date = body.p_payment_date;
        receipts.push({ id: id(50), title_id: titleId, amount_cents: body.p_received_cents, payment_date: body.p_payment_date, delay_days: 62, delay_band: '61_90', collector_id: title.collector_id, payment_source: 'COBRANCA', validated_at: '2026-10-18T15:00:00Z' });
      } else {
        title.status = 'NOT_LOCATED'; title.validation_status = 'NONE'; title.payment_source = null; title.payment_reported_date = null; title.payment_date = null; title.reported_in_collection = false; title.collector_locked = true; title.last_action = 'PAYMENT_NOT_LOCATED'; title.next_action = 'RETRY'; title.next_action_date = '2026-10-18';
      }
      const proof = { format_version: options.retiredProofOld ? '053' : options.retiredQueue || options.format055 ? '055' : '053', request_id: body.p_request_id, title_id: titleId, decision: body.p_decision, receipt_id: body.p_decision === 'CONFIRM' ? id(50) : null,
        payment_date: body.p_payment_date, nominal_cents: title.amount_cents, received_cents: body.p_received_cents,
        adjustment_cents: body.p_decision === 'CONFIRM' ? title.amount_cents - body.p_received_cents : null,
        adjustment_reason: body.p_adjustment_reason, title_revision: title.revision };
      results.set(body.p_request_id, proof);
      if (options.uncertain === 'lost-after-commit') return reply({ code: 'upstream error', message: 'private token details' }, 503);
      if (options.uncertain === 'proof') return reply({ ...proof, received_cents: Number(proof.received_cents) + 1 });
      return reply(proof);
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
  const seen = await setup(page, { format055: true }); await openValidation(page);
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
  await validationPanel(page).getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-16');
  await validationPanel(page).getByRole('textbox', { name: 'Justificativa / observação da validação', exact: true }).fill('Entrada bancária conferida pelo financeiro.');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('16/10/2026'); return dialog.accept(); });
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('status')).toContainText('Recebimento validado');
  expect(seen.writes).toEqual([{ name: 'validate_receivable_payment_v2', body: expect.objectContaining({ p_title_id: titleId, p_decision: 'CONFIRM', p_payment_date: '2026-10-16', p_observation: 'Entrada bancária conferida pelo financeiro.', p_expected_revision: 7, p_received_cents: 123456, p_adjustment_reason: null, p_request_id: expect.any(String) }) }]);
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
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
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

test('a fila exclui títulos retirados e solicita explicitamente o indicador de retirada', async ({ page }) => {
  const seen = await setup(page, { retired: true });
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await expect(validationPanel(page).getByText('Nenhum pagamento pendente para este filtro.', { exact: true })).toBeVisible();
  await expect(validationPanel(page).getByRole('button', { name: 'Conferir NF-FIN-1', exact: true })).toHaveCount(0);
  const request = seen.calls.find(call => call.name === 'receivable_titles' && new URLSearchParams(call.query).get('validation_status') === 'eq.PENDING')!;
  expect(new URLSearchParams(request.query).get('retired_from_report')).toBe('eq.false');
  expect(new URLSearchParams(request.query).get('select')).toContain('retired_from_report');
  expect(seen.writes).toHaveLength(0);
});

for (const options of [{ retired: true, ignoreRetiredFilter: true }, { missingRetirement: true }]) test(`fila inconsistente não oferece validação: ${JSON.stringify(options)}`, async ({ page }) => {
  const seen = await setup(page, options);
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText('Não foi possível carregar a fila');
  await expect(validationPanel(page).getByRole('button', { name: 'Conferir NF-FIN-1', exact: true })).toHaveCount(0);
  expect(seen.writes).toHaveLength(0);
});

test('retirada entre a fila e a conferência mantém o relato e exige reabrir pela fila atualizada', async ({ page }) => {
  const seen = await setup(page, { detailRetired: true }); await openValidation(page);
  await expect(validationPanel(page).getByRole('alert')).toContainText('Este título mudou. Atualize a fila');
  await expect(validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toBeDisabled();
  await expect(validationPanel(page).getByRole('region', { name: 'Relato original da cobrança', exact: true })).toContainText(originalObservation);
  expect(seen.writes).toHaveLength(0);
});

test('retirada após abrir a conferência é detectada novamente antes de enviar a confirmação', async ({ page }) => {
  const seen = await setup(page); await openValidation(page);
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
  seen.title.retired_from_report = true; seen.title.revision++;
  page.once('dialog', dialog => dialog.accept());
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText('Este título mudou. Atualize a fila');
  await expect(validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toBeDisabled();
  expect(seen.writes).toHaveLength(0); expect(seen.receipts).toHaveLength(0);
});

for (const race of ['retired', 'validated'] as const) test(`mudança concorrente ${race} apresenta a situação atual sem repetir gravação`, async ({ page }) => {
  const seen = await setup(page, { commitRace: race }); await openValidation(page);
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
  page.once('dialog', dialog => dialog.accept());
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText(race === 'retired' ? 'Este título mudou. Atualize a fila' : 'Já existe recebimento validado');
  await expect(validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toBeDisabled();
  await expect(page.getByText('private retirement query', { exact: true })).toHaveCount(0);
  expect(seen.writes).toHaveLength(1);
});

for (const option of ['detailDenied', 'wrongDetail'] as const) test(`estado financeiro ${option} bloqueia a conferência sem alterar o relato`, async ({ page }) => {
  const seen = await setup(page, { [option]: true });
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await validationPanel(page).getByRole('button', { name: 'Conferir NF-FIN-1', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toBeVisible();
  await expect(validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toBeDisabled();
  await expect(page.getByText('private title details', { exact: true })).toHaveCount(0);
  expect(seen.writes).toHaveLength(0);
});

test('confirmação com retenção exige valor líquido, justificativa e quitação integral explícita', async ({ page }) => {
  const seen = await setup(page, { netExample: true }); await openValidation(page);
  const amount = validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true });
  await expect(amount).toHaveValue('');
  await expect(validationPanel(page).getByText('Valor original R$ 4.240,20', { exact: false })).toBeVisible();
  await amount.fill('4.189,32');
  await expect(validationPanel(page).getByText('R$ 50,88', { exact: true })).toBeVisible();
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText('justificativa do desconto');
  await validationPanel(page).getByLabel('Desconto ou retenção — justificativa', { exact: true }).fill('Retenção confirmada no documento de recebimento.');
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText('integralmente quitado');
  expect(seen.writes).toHaveLength(0);
  await validationPanel(page).getByLabel('Confirmo que a diferença é desconto ou retenção e que o título está integralmente quitado.', { exact: true }).check();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('4.189,32'); expect(dialog.message()).toContain('50,88'); expect(dialog.message()).toContain('07/08/2026'); return dialog.accept(); });
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('status')).toContainText('Recebimento validado: R$ 4.189,32');
  expect(seen.writes[0].body).toMatchObject({ p_received_cents: 418932, p_adjustment_reason: 'Retenção confirmada no documento de recebimento.', p_payment_date: '2026-08-07' });
  expect(seen.receipts[0].amount_cents).toBe(418932); expect(seen.title.amount_cents).toBe(424020); expect(seen.reported.observation).toBe(originalObservation);
});

for (const invalid of ['-1,00', '0,00', '1.234,567', '1.234,57', '900719925474099,91']) test(`valor recebido inválido é recusado sem requisição financeira: ${invalid}`, async ({ page }) => {
  const seen = await setup(page); await openValidation(page);
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill(invalid);
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText('Informe o valor efetivamente recebido');
  expect(seen.writes).toHaveLength(0); expect(seen.receipts).toHaveLength(0);
});

test('data futura usa o bloqueio do servidor e permite corrigir a data sem alterar o relato', async ({ page }) => {
  const seen = await setup(page); await openValidation(page);
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
  await validationPanel(page).getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-19');
  page.once('dialog', dialog => dialog.accept());
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText('data real do recebimento, até hoje');
  await expect(validationPanel(page).getByLabel('Data real do recebimento', { exact: true })).toBeEnabled();
  expect(seen.receipts).toHaveLength(0); expect(seen.reported.observation).toBe(originalObservation);
});

test('banco sem SQL 053 mostra ativação e nunca usa a validação nominal antiga', async ({ page }) => {
  const seen = await setup(page, { missing053: true }); await openValidation(page);
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
  page.once('dialog', dialog => dialog.accept());
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText('Ative o SQL 053');
  expect(seen.calls.some(call => call.name === 'validate_receivable_payment')).toBe(false); expect(seen.receipts).toHaveLength(0);
});

for (const uncertain of ['lost-after-commit', 'proof'] as const) test(`resultado ${uncertain} congela o mesmo protocolo e recupera sem novo recebimento`, async ({ page }) => {
  const seen = await setup(page, { uncertain }); await openValidation(page);
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
  page.once('dialog', dialog => dialog.accept());
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('button', { name: 'Conferir confirmação pendente', exact: true })).toBeVisible();
  await expect(validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true })).toBeDisabled();
  await expect(validationPanel(page).getByRole('button', { name: 'Atualizar fila', exact: true })).toBeDisabled();
  await expect(validationPanel(page).getByRole('button', { name: 'Fechar conferência', exact: true })).toBeDisabled();
  await expect(validationPanel(page).getByLabel('Responsável pela carteira', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeDisabled();
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Contas a Receber', exact: true })).toBeDisabled();
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true })).toBeDisabled();
  await validationPanel(page).getByRole('button', { name: 'Conferir confirmação pendente', exact: true }).click();
  await expect(validationPanel(page).getByRole('status')).toContainText('Recebimento validado');
  expect(seen.writes).toHaveLength(2); expect(seen.writes[1].body).toEqual(seen.writes[0].body); expect(seen.receipts).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeEnabled();
});

test('retirado com trabalho confirmado pelo servidor e sem relato PAID permite conferência explícita sem presumir data ou valor', async ({ page }) => {
  const seen = await setup(page, { retiredQueue: true, retiredSourceMissing: true });
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await validationPanel(page).getByRole('button', { name: 'Conferir retirado NF-FIN-1', exact: true }).click();
  await expect(validationPanel(page).getByLabel('Data real do recebimento', { exact: true })).toHaveValue('');
  await expect(validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true })).toHaveValue('');
  await expect(validationPanel(page).getByRole('option', { name: 'Não localizado — cobrar novamente', exact: true })).toHaveJSProperty('disabled', true);
  await expect(validationPanel(page).getByRole('combobox', { name: /^Decisão da validação/ })).toHaveValue('CONFIRM');
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
  await validationPanel(page).getByLabel('Data real do recebimento', { exact: true }).fill('2026-08-07');
  page.once('dialog', dialog => dialog.accept());
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('status')).toContainText('O título saiu da carteira ativa e das pendências de recebimento');
  await expect(validationPanel(page).getByRole('status')).toContainText('período da data real do recebimento');
  await expect(validationPanel(page).getByText('Nenhum título retirado aguardando confirmação neste filtro.', { exact: true })).toBeVisible();
  expect(seen.receipts).toHaveLength(1); expect(seen.title.retired_from_report).toBe(true); expect(seen.title.status).toBe('VALIDATED');
  expect(seen.writes[0].body).toMatchObject({ p_payment_date: '2026-08-07', p_received_cents: 123456 });
});

test('fila retirada sem prova de movimento de cobrança é recusada antes de oferecer uma confirmação', async ({ page }) => {
  const seen = await setup(page, { retiredQueue: true, retiredQueueUnsafe: true });
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await expect(validationPanel(page).getByRole('alert')).toContainText('Não foi possível consultar os títulos retirados');
  await expect(validationPanel(page).getByRole('button', { name: 'Conferir retirado NF-FIN-1', exact: true })).toHaveCount(0);
  expect(seen.writes).toHaveLength(0);
});

test('prova antiga não comprova confirmação de retirado e mantém o protocolo protegido', async ({ page }) => {
  const seen = await setup(page, { retiredQueue: true, retiredProofOld: true });
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await validationPanel(page).getByRole('button', { name: 'Conferir retirado NF-FIN-1', exact: true }).click();
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
  page.once('dialog', dialog => dialog.accept());
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('button', { name: 'Conferir confirmação pendente', exact: true })).toBeVisible();
  await expect(validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true })).toBeDisabled();
  await expect(validationPanel(page).getByRole('button', { name: 'Atualizar títulos retirados', exact: true })).toBeDisabled();
  await expect(validationPanel(page).getByRole('button', { name: 'Consultar títulos retirados', exact: true })).toBeDisabled();
  await expect(validationPanel(page).getByRole('status').filter({ hasText: 'Recebimento validado' })).toHaveCount(0);
  expect(seen.calls.some(call => call.name === 'validate_receivable_payment')).toBe(false);
});

test('resposta perdida de confirmação retirada usa o mesmo protocolo e encerra a pendência uma única vez', async ({ page }) => {
  const seen = await setup(page, { retiredQueue: true, uncertain: 'lost-after-commit' });
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await validationPanel(page).getByRole('button', { name: 'Conferir retirado NF-FIN-1', exact: true }).click();
  await validationPanel(page).getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1.234,56');
  page.once('dialog', dialog => dialog.accept());
  await validationPanel(page).getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validationPanel(page).getByRole('button', { name: 'Conferir confirmação pendente', exact: true })).toBeVisible();
  await validationPanel(page).getByRole('button', { name: 'Conferir confirmação pendente', exact: true }).click();
  await expect(validationPanel(page).getByRole('status')).toContainText('Recebimento validado');
  expect(seen.writes).toHaveLength(2); expect(seen.writes[1].body).toEqual(seen.writes[0].body); expect(seen.receipts).toHaveLength(1);
  await expect(validationPanel(page).getByText('Nenhum título retirado aguardando confirmação neste filtro.', { exact: true })).toBeVisible();
});
