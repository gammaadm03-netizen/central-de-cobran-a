import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const fixed = new Date('2026-10-18T15:00:00Z'), today = '2026-10-18';
const id = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = id(20), other = id(21);
const shifted = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
interface Options { director?: boolean; collector?: boolean; unbound?: boolean; empty?: boolean; missing?: boolean; unsafe?: boolean; wrongScope?: boolean; large?: boolean; serverDate?: string }
async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(fixed);
  const role = options.director ? 'diretor' : options.collector ? 'cobradora_1' : 'gerente_geral';
  const permissions = [{ resource: 'cobranca', action: 'read' }, ...(!options.director ? [{ resource: 'cobranca', action: 'write' }] : [])];
  const access = { profile: { id: id(1), username: 'TesteCobranca', display_name: 'Pessoa sintética', role_key: role, enabled: true }, permissions, collector_id: options.collector && !options.unbound ? own : null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id(1), session_id: id(2), exp: Math.floor(fixed.getTime() / 1000) + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const serverDate = options.serverDate ?? today;
  const make = (n: number, days: number, collector = own) => ({
    id: id(100 + n), scope: 'grupo-consolidado', source_key: `synthetic-${n}`, document: `NF-${n}`, client_name: `Cliente sintético ${n}`, client_document: null, customer_key: `name:CLIENTE SINTÉTICO ${n}`, branch: 'Filial sintética', issued_on: shifted(serverDate, -500), due_date: shifted(serverDate, -days), amount_cents: 10000,
    collector_id: collector as string | null, status: n === 2 ? 'PENDING_VALIDATION' : n === 3 ? 'NOT_LOCATED' : 'OPEN', validation_status: n === 2 ? 'PENDING' : 'NONE', payment_source: n === 2 ? 'IMPORTACAO_DIARIA' : null,
    payment_reported_date: n === 2 ? shifted(serverDate, -1) : null, payment_date: null, reported_in_collection: false, collector_locked: false, in_latest_report: true, retired_from_report: false, revision: 1, updated_at: fixed.toISOString(),
    last_action: n === 2 ? 'PAID' : n === 3 ? 'PAYMENT_NOT_LOCATED' : null, next_action: n === 2 ? 'CONTACT' : n === 3 ? 'RETRY' : null, next_action_date: n === 2 ? serverDate : n === 3 ? shifted(serverDate, -1) : null,
  });
  const records = options.empty ? [] : options.large ? Array.from({ length: 31 }, (_, i) => make(i + 1, i + 1)) : [
    ...[10, 45, 75, 100, 200, 400].map((days, i) => make(i + 1, days, i < 3 ? own : other)),
    { ...make(7, 20), collector_id: null }, make(8, 0), make(9, -1), { ...make(10, 40), status: 'VALIDATED', validation_status: 'VALIDATED' },
  ];
  const visible = () => records.filter(row => row.due_date < serverDate && (!options.collector || !options.unbound && row.collector_id === own));
  const active = () => visible().filter(row => row.status !== 'VALIDATED');
  function summary() {
    const rows = active(), sum = (items: typeof rows) => items.reduce((total, row) => total + row.amount_cents, 0);
    const days = (row: typeof rows[number]) => Math.round((Date.parse(`${serverDate}T12:00:00Z`) - Date.parse(`${row.due_date}T12:00:00Z`)) / 86400000);
    const group = (items: typeof rows) => ({ title_count: items.length, amount_cents: sum(items) });
    return {
      as_of_date: serverDate, overdue_cents: options.unsafe ? Number.MAX_SAFE_INTEGER + 1 : sum(rows), overdue_count: rows.length, client_count: new Set(rows.map(row => row.customer_key)).size,
      average_delay_days: rows.length ? Math.round(rows.reduce((total, row) => total + days(row), 0) / rows.length * 10) / 10 : 0,
      worked_count: rows.filter(row => row.last_action).length, no_action_count: rows.filter(row => !row.last_action).length,
      pending_validation_count: rows.filter(row => row.status === 'PENDING_VALIDATION').length, pending_validation_cents: sum(rows.filter(row => row.status === 'PENDING_VALIDATION')),
      over_180_count: rows.filter(row => days(row) > 180).length, returns_today_count: rows.filter(row => row.next_action && row.next_action_date === serverDate).length, returns_overdue_count: rows.filter(row => row.next_action_date && row.next_action_date < serverDate).length,
      unassigned_count: options.collector ? null : rows.filter(row => !row.collector_id).length, unassigned_cents: options.collector ? null : sum(rows.filter(row => !row.collector_id)),
      by_delay_bands: [[1, 30, '1_30'], [31, 60, '31_60'], [61, 90, '61_90'], [91, 180, '91_180'], [181, 365, '181_365'], [366, null, 'ACIMA_365']].map(([min, max, key]) => ({ key, label: 'Faixa sintética', min_days: min, max_days: max, ...group(rows.filter(row => days(row) >= Number(min) && (max === null || days(row) <= Number(max)))) })),
      by_status: ['NEW', 'OPEN', 'PENDING_VALIDATION', 'NOT_LOCATED'].map(status => ({ status, ...group(rows.filter(row => row.status === status)) })),
      by_next_action: ['NONE', 'CONTACT', 'NO_RESPONSE', 'PROMISE', 'RETRY', 'OTHER'].map(action => ({ action, ...group(rows.filter(row => (row.next_action ?? 'NONE') === action)) })),
      by_collector: [...new Set(rows.map(row => row.collector_id))].map(collector => ({ collector_id: options.wrongScope ? other : collector, display_name: collector === own ? 'Responsável A' : collector === other ? 'Responsável B' : 'Sem cobradora definida', ...group(rows.filter(row => row.collector_id === collector)) })),
    };
  }
  const calls: { name: string; query: string; body: any }[] = [], events: any[] = [];
  const workflow = { version: '029', normal_pause: true, finish_requires_started: true, pending_read_only: true, returns_priority: true };
  const started = new Set<string>(); let running: string | null = null;
  const caseState = new Map<string, { status: string; observation: string; next_action: string; next_date: string | null; revision: number }>();
  const timer = (title_id: string) => ({ title_id, running: running === title_id, session_id: running === title_id ? id(800) : null, started_at: running === title_id ? `${serverDate}T15:00:00Z` : null, elapsed_seconds: 0, total_seconds: 0, actor_total_seconds: 0, server_now: `${serverDate}T15:00:00Z`, recovery_allowed: false });
  const returns = () => visible().filter(row => ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && row.collector_id && row.next_action_date && row.next_action_date <= serverDate).sort((a, b) => a.next_action_date!.localeCompare(b.next_action_date!) || a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));
  const priority = () => ({ collector_id: options.collector ? own : null, due_count: returns().length, total_cents: returns().reduce((sum, row) => sum + row.amount_cents, 0), next_title_id: returns()[0]?.id ?? null, next_due_date: returns()[0]?.next_action_date ?? null });
  const stateOf = (row: typeof records[number]) => caseState.get(row.id) ?? { status: row.status === 'PENDING_VALIDATION' ? 'TÍTULO PAGO' : 'NOVO TÍTULO - COBRAR', observation: '', next_action: '', next_date: row.next_action_date, revision: 0 };
  const enrich = (row: typeof records[number]) => ({ ...row, collection_as_of_date: serverDate, operational_status: stateOf(row).status,
    case_revision: stateOf(row).revision, observation: stateOf(row).observation, next_action_text: stateOf(row).next_action,
    next_date: stateOf(row).next_date, delay_days: Math.max(0, Math.round((Date.parse(`${serverDate}T12:00:00Z`) - Date.parse(`${row.due_date}T12:00:00Z`)) / 86400000)),
    collector_name: row.collector_id === own ? 'Responsável A' : row.collector_id === other ? 'Responsável B' : null,
    total_work_seconds: 0, current_timer: timer(row.id), return_due: returns().some(item => item.id === row.id), return_due_date: returns().some(item => item.id === row.id) ? row.next_action_date : null,
    can_start: !options.director && !!row.collector_id && ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && (!running || running === row.id) && (!returns().some(item => item.collector_id === row.collector_id) || returns().some(item => item.id === row.id)), start_block_reason: null });
  function workbench(body: any) {
    let rows = visible();
    if ((body.p_queue ?? 'active') === 'active') rows = rows.filter(row => ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status));
    if (body.p_queue === 'returns') rows = returns();
    if (body.p_collector_id) rows = rows.filter(row => row.collector_id === body.p_collector_id);
    if (body.p_unassigned) rows = rows.filter(row => row.collector_id === null);
    if (body.p_financial_status && body.p_financial_status !== 'ACTIVE') rows = rows.filter(row => row.status === body.p_financial_status);
    if (body.p_due_start) rows = rows.filter(row => row.due_date >= body.p_due_start);
    if (body.p_due_end) rows = rows.filter(row => row.due_date <= body.p_due_end);
    if (body.p_next_action === 'NONE') rows = rows.filter(row => !row.next_action);
    else if (body.p_next_action) rows = rows.filter(row => row.next_action === body.p_next_action);
    if (body.p_status) rows = rows.filter(row => stateOf(row).status === body.p_status);
    if (body.p_search) rows = rows.filter(row => [row.client_name, row.document, stateOf(row).observation].join(' ').toLowerCase().includes(body.p_search.toLowerCase()));
    const count = rows.length, total_cents = rows.reduce((sum, row) => sum + row.amount_cents, 0), offset = body.p_offset ?? 0;
    return { as_of_date: serverDate, server_now: `${serverDate}T15:00:00Z`, snapshot_revision: 'management-fixture-stable', active_timer: running ? timer(running) : null, workflow, priority: priority(), count, total_cents, rows: rows.slice(offset, offset + (body.p_limit ?? 25)).map(enrich) };
  }
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON(); calls.push({ name, query: url.search, body });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600 }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: id(1), aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: fixed.toISOString(), app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (name === 'receivable_retired_validation_queue') return reply({ format_version: '055', count: 0, rows: [] });
    // Previous database remains usable while the optional 027 context is not activated.
    if (name === 'collection_customer_context') return reply({ code: 'PGRST202' }, 404);
    if (name === 'collections_overdue_summary') return options.missing ? reply({ code: 'PGRST202', message: 'private SQL sensitive details' }, 404) : reply(summary());
    if (name === 'collection_workbench') return reply(workbench(body));
    if (name === 'collection_case_detail') {
      const row = visible().find(item => item.id === body.p_title_id)!;
      return reply({ title: enrich(row), workflow: { ...workflow, started: started.has(row.id), can_finish: started.has(row.id) && row.status !== 'PENDING_VALIDATION', recovery_allowed: false }, priority: priority(), case: { ...stateOf(row), payment_date: row.payment_reported_date, finalized_at: null, updated_at: null, updated_by: null },
        timer: timer(row.id), history: events.filter(event => event.title_id === row.id), work_sessions: [] });
    }
    if (name === 'collection_work_action') { started.add(body.p_title_id); running = body.p_action === 'START' ? body.p_title_id : null; return reply(timer(body.p_title_id)); }
    if (name === 'save_collection_case') {
      const row = records.find(item => item.id === body.p_title_id)!, previous = stateOf(row);
      const next = { status: body.p_status, observation: body.p_observation, next_action: body.p_next_action, next_date: body.p_next_date, revision: previous.revision + 1 };
      caseState.set(row.id, next); row.revision++; row.last_action = 'CONTACT'; row.next_action = 'OTHER'; row.next_action_date = body.p_next_date; if (body.p_finish) { started.delete(row.id); running = null; }
      events.push({ id: id(900 + events.length), title_id: row.id, action: 'CONTACT', contact_date: serverDate,
        next_action: 'OTHER', next_date: body.p_next_date, observation: body.p_observation, return_note: null, payment_date: null, created_at: fixed.toISOString() });
      return reply({ title_id: row.id, revision: row.revision, case_revision: next.revision, event_id: events.at(-1)!.id, finished: body.p_finish, timer: timer(row.id) });
    }
    if (name === 'collection_agents') return reply([{ id: own, display_name: 'Responsável A', enabled: true }, ...(!options.collector ? [{ id: other, display_name: 'Responsável B', enabled: true }] : [])]);
    if (name === 'collection_overdue_titles') {
      let rows = visible(); const p = url.searchParams;
      for (const [key, value] of p) {
        if (key === 'status' && value === 'neq.VALIDATED') rows = rows.filter(row => row.status !== 'VALIDATED');
        else if (value.startsWith('eq.') && key in (rows[0] ?? {})) rows = rows.filter(row => String((row as any)[key]) === value.slice(3));
        if (value === 'is.null') rows = rows.filter(row => (row as any)[key] === null);
        if (key === 'due_date' && value.startsWith('gte.')) rows = rows.filter(row => row.due_date >= value.slice(4));
        if (key === 'due_date' && value.startsWith('lte.')) rows = rows.filter(row => row.due_date <= value.slice(4));
      }
      const count = rows.length, offset = Number(p.get('offset') ?? 0), limit = Number(p.get('limit') ?? 25);
      return reply(rows.slice(offset, offset + limit).map(row => ({ ...row, collection_as_of_date: serverDate })), 200, count);
    }
    if (name === 'receivable_collection_events') return reply(events.filter(event => `eq.${event.title_id}` === url.searchParams.get('title_id')));
    if (name === 'receivable_receipts' || name === 'effective_receivable_receipts') return reply([]);
    if (name === 'record_collection_action') {
      const row = records.find(item => item.id === body.p_title_id)!; row.last_action = body.p_action; row.revision++; row.next_action = body.p_next_action; row.next_action_date = body.p_next_date;
      events.push({ id: id(900), title_id: row.id, action: body.p_action, contact_date: body.p_contact_date, next_action: body.p_next_action, next_date: body.p_next_date, observation: body.p_observation, return_note: body.p_return_note, payment_date: null, created_at: fixed.toISOString() });
      return reply(id(900));
    }
    throw new Error(`Unexpected offline collection request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('TesteCobranca'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  return { calls, records };
}
const overview = (page: Page) => page.locator('.collections-management');
const card = (page: Page, name: string) => overview(page).locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
const titles = async (page: Page) => page.getByRole('tab', { name: 'Títulos', exact: true }).click();
const general = async (page: Page) => page.getByRole('tab', { name: 'Visão geral', exact: true }).click();

test('restores the overdue portfolio, aging bands, coverage and return indicators using the integral server summary', async ({ page }) => {
  const { calls } = await setup(page, { large: true });
  await expect(card(page, 'Carteira vencida atual')).toContainText('R$ 3.100,00'); await expect(card(page, 'Títulos vencidos').locator('strong')).toHaveText('31');
  await expect(overview(page).getByRole('button', { name: /^Ver títulos de/ })).toHaveCount(6);
  await expect(overview(page).getByText('Cobertura de cobrança', { exact: true })).toBeVisible();
  await titles(page); await expect(page.getByRole('button', { name: /^Abrir título / })).toHaveCount(25);
  expect(calls.filter(call => call.name === 'collections_overdue_summary')).toHaveLength(1);
  expect(calls.some(call => /^(commit_|validate_|record_|assign_|save_|collection_work_action)/.test(call.name))).toBe(false);
});

test('aging-band uses the server date and pending-payment shortcut opens financial validation', async ({ page }) => {
  const { calls } = await setup(page, { serverDate: '2026-11-05' });
  await overview(page).getByRole('button', { name: 'Ver títulos de 31–60 dias', exact: true }).click();
  await expect(page.getByLabel('Vencimento inicial')).toHaveValue(shifted('2026-11-05', -60)); await expect(page.getByLabel('Vencimento final')).toHaveValue(shifted('2026-11-05', -31));
  // This band contains one payment already reported; it remains in the global
  // obligation summary but no longer belongs to the operational active queue.
  await expect(page.getByRole('button', { name: /^Abrir título / })).toHaveCount(0);
  await general(page); await card(page, 'Pagamento informado').getByRole('button').click();
  await expect(page.getByRole('tab', { name: 'Validação financeira', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('A consulta depende do vínculo com sua carteira ou da permissão de Contas a Receber.', { exact: false })).toBeVisible();
  expect(calls.some(call => call.name === 'collection_workbench' && call.body.p_financial_status === 'PENDING_VALIDATION')).toBe(false);
});

test('wallet and next-action shortcuts retain visible filters and do not infer a responsible person', async ({ page }) => {
  await setup(page); await overview(page).getByRole('button', { name: 'Abrir carteira de Responsável B', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Cobradora', exact: true })).toHaveValue(other); await expect(page.getByRole('button', { name: /^Abrir título / })).toHaveCount(3);
  await general(page); await overview(page).getByRole('button').filter({ hasText: 'Sem próxima ação' }).click();
  await expect(page.getByRole('combobox', { name: 'Próxima ação da carteira', exact: true })).toHaveValue('NONE'); await expect(page.getByRole('combobox', { name: 'Cobradora', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: /^Abrir título / })).toHaveCount(5);
});

test('a collector sees only their own summary and can retain contact, return and historical workflows', async ({ page }) => {
  const { calls } = await setup(page, { collector: true });
  await expect(card(page, 'Carteira vencida atual')).toContainText('R$ 300,00'); await expect(overview(page).getByText('Responsável B', { exact: true })).toHaveCount(0); await expect(overview(page).getByText('Sem cobradora definida', { exact: true })).toHaveCount(0);
  await titles(page); await page.getByRole('button', { name: 'Abrir título NF-3', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Histórico do título', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Status do atendimento', exact: true })).toBeVisible(); await expect(page.getByLabel('Observações', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Status do atendimento', exact: true }).selectOption('AGUARDANDO RETORNO');
  await page.getByLabel('Observações', { exact: true }).fill('Contato sintético para organizar o retorno. Retorno sintético combinado.');
  await page.getByLabel('Próxima ação', { exact: true }).fill('Ligar novamente');
  await page.getByLabel('Data da próxima ação', { exact: true }).fill(today);
  await page.getByRole('button', { name: 'Finalizar atendimento', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('finalizado');
  await expect.poll(() => calls.filter(call => call.name === 'collections_overdue_summary').length).toBe(3);
  await general(page);
  await expect(card(page, 'Retornos para hoje').locator('strong')).toHaveText('2');
  expect(calls.find(call => call.name === 'save_collection_case')?.body).toMatchObject({ p_status: 'AGUARDANDO RETORNO', p_next_action: 'Ligar novamente', p_next_date: today, p_observation: 'Contato sintético para organizar o retorno. Retorno sintético combinado.', p_expected_revision: 1, p_expected_case_revision: 0, p_finish: true });
  expect(calls.some(call => call.name === 'validate_receivable_payment')).toBe(false); await titles(page);
  await page.getByRole('button', { name: 'Abrir título NF-3', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Histórico do título', exact: true })).toBeVisible(); await expect(page.locator('.collection-case-history').getByText('Contato sintético para organizar o retorno. Retorno sintético combinado.', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.name === 'collection_workbench').every(call => call.body.p_collector_id === own)).toBe(true);
});

test('the Director can drill down and consult history without collection write controls', async ({ page }) => {
  const { calls } = await setup(page, { director: true }); await overview(page).getByRole('button', { name: 'Ver títulos de Acima de 365 dias', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir título NF-6', exact: true }).click();
  await expect(page.getByText('Registrar ação de cobrança', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Cobradora responsável', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Cobradora responsável', { exact: true })).toBeDisabled();
  for (const name of ['Iniciar', 'Pausar', 'Salvar andamento', 'Finalizar atendimento']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  expect(calls.some(call => /^(commit_|validate_|record_|assign_|save_|collection_work_action)/.test(call.name))).toBe(false);
});

test('missing summary activation keeps the working overdue workspace and never falls back to all receivables', async ({ page }) => {
  const { calls } = await setup(page, { missing: true }); await expect(overview(page).getByRole('alert')).toContainText('aguarda ativação');
  await titles(page); await expect(page.getByRole('button', { name: /^Abrir título / })).toHaveCount(6);
  await expect(page.getByText('private SQL sensitive details')).toHaveCount(0); expect(calls.some(call => call.name === 'receivable_titles')).toBe(false);
});

test('unsafe money is rejected instead of displayed as a valid total', async ({ page }) => {
  await setup(page, { unsafe: true }); await expect(overview(page).getByRole('alert')).toContainText('Não foi possível consultar'); await expect(overview(page).locator('article')).toHaveCount(0);
});

test('an incompatible collector scope is rejected before displaying another wallet', async ({ page }) => {
  await setup(page, { collector: true, wrongScope: true }); await expect(overview(page).getByRole('alert')).toContainText('Não foi possível consultar'); await expect(overview(page).locator('article')).toHaveCount(0);
});

test('an unbound collector receives guidance without reading either title or management bases', async ({ page }) => {
  const { calls } = await setup(page, { collector: true, unbound: true }); await expect(page.getByRole('status')).toContainText('Seu login ainda não está vinculado'); await expect(overview(page)).toHaveCount(0);
  expect(calls.some(call => ['collections_overdue_summary', 'collection_workbench', 'collection_case_detail', 'collection_overdue_titles', 'receivable_titles'].includes(call.name))).toBe(false);
});

test('an empty overdue wallet has no invented balances, contacts or collector distribution', async ({ page }) => {
  await setup(page, { empty: true }); await expect(card(page, 'Carteira vencida atual')).toContainText('R$ 0,00'); await expect(card(page, 'Títulos vencidos').locator('strong')).toHaveText('0'); await expect(overview(page).getByText('Nenhum título vencido nesta carteira.')).toBeVisible();
});

test('refresh updates both the management summary and the existing title workspace', async ({ page }) => {
  const { calls } = await setup(page); await expect(card(page, 'Carteira vencida atual')).toContainText('R$ 700,00');
  await titles(page); await expect(page.getByRole('button', { name: /^Abrir título / })).toHaveCount(6); await general(page);
  const before = calls.filter(call => call.name === 'collection_workbench').length;
  await page.getByRole('button', { name: 'Atualizar visão da cobrança', exact: true }).click(); await expect.poll(() => calls.filter(call => call.name === 'collections_overdue_summary').length).toBe(2); await expect.poll(() => calls.filter(call => call.name === 'collection_workbench').length).toBeGreaterThan(before);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
});
