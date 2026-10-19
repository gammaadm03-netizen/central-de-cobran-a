import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const initialTime = new Date('2026-10-18T15:00:01Z');
const today = '2026-10-18';
const id = (n: number) => `97000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = id(20), other = id(21);
const statuses = ['NOVO TÍTULO - COBRAR', 'SEM SUCESSO', 'AGUARDANDO RETORNO', 'COBRANCA VIA EMAIL', 'COBRANCA POR WHATSAPP', 'AGUARDANDO LIQUIDACAO', 'SEM PRAZO', 'SEM PREVISAO DE PG', 'PAGAMENTO PROGRAMADO', 'TÍTULO PAGO'];
const workflow = { version: '029', normal_pause: true, finish_requires_started: true, pending_read_only: true, returns_priority: true };
const shifted = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
type Options = { director?: boolean; manager?: boolean; unbound?: boolean; unassigned?: boolean; large?: boolean; wrongScope?: boolean; unsafe?: boolean; failure?: 'stale' | 'uncertain'; pending?: boolean };

async function setup(page: Page, options: Options = {}) {
  await page.clock.install({ time: new Date('2026-10-18T15:00:00Z') });
  await page.clock.pauseAt(initialTime);
  const isCollector = !options.director && !options.manager;
  const role = options.director ? 'diretor' : options.manager ? 'gerente_geral' : 'cobradora_1';
  const access = {
    profile: { id: id(1), username: 'TesteAtendimento', display_name: 'Pessoa sintética', role_key: role, enabled: true },
    permissions: [{ resource: 'cobranca', action: 'read' }, ...(!options.director ? [{ resource: 'cobranca', action: 'write' }] : []), ...(!isCollector ? [{ resource: 'contas_receber', action: 'read' }, ...(options.manager ? [{ resource: 'contas_receber', action: 'write' }] : [])] : [])],
    collector_id: isCollector && !options.unbound ? own : null,
  };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id(1), session_id: id(2), exp: Math.floor(initialTime.getTime() / 1000) + 86_400, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const make = (n: number, days: number, collector = own) => ({
    id: id(100 + n), scope: 'grupo-consolidado', source_key: `synthetic-desk-${n}`, document: `NF-${n}`, client_name: `Cliente sintético ${n}`, client_document: null,
    customer_key: `name:CLIENTE SINTÉTICO ${n}`, branch: 'Filial sintética', issued_on: shifted(-500), due_date: shifted(-days), amount_cents: 10_000 + n,
    collector_id: (options.unassigned && n === 1 ? null : collector) as string | null, status: options.pending && n === 1 ? 'PENDING_VALIDATION' : 'OPEN', validation_status: options.pending && n === 1 ? 'PENDING' : 'NONE',
    payment_source: options.pending && n === 1 ? 'COBRANCA' : null, payment_reported_date: options.pending && n === 1 ? shifted(-1) : null, payment_date: null,
    reported_in_collection: !!options.pending && n === 1, collector_locked: false, in_latest_report: true, revision: 1, updated_at: initialTime.toISOString(),
    last_action: null as string | null, next_action: null as string | null, next_action_date: null as string | null,
    operational_status: statuses[0], case_revision: n === 1 ? 0 : 1, observation: n === 1 ? null : `Observação sintética ${n}`, next_action_text: null as string | null, next_date: null as string | null,
    delay_days: days, collector_name: options.unassigned && n === 1 ? null : collector === own ? 'Responsável A' : 'Responsável B', total_work_seconds: 0,
    case_payment_date: null as string | null, finalized_at: null as string | null,
  });
  const rows = options.large ? Array.from({ length: 31 }, (_, i) => make(i + 1, 31 - i)) : [make(1, 45), make(2, 10), make(3, 200, other)];
  type Row = typeof rows[number];
  const state = { now: initialTime.getTime(), failure: options.failure, events: [] as any[], caseEvents: [] as any[], started: new Set<string>(), sessions: new Map<string, { session_id: string | null; started_at: string | null; running: boolean; total_seconds: number }>(), replies: new Map<string, any>() };
  const calls: { name: string; body: any; method: string; query: string }[] = [];
  const visible = () => rows.filter(row => row.due_date < today && (!isCollector || !options.unbound && row.collector_id === own));
  const collectible = (row: Row) => ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && !!row.collector_id;
  const priority = (collector: string | null) => {
    const due = visible().filter(row => collectible(row) && row.collector_id === collector && row.next_action_date && row.next_action_date <= today).sort((a, b) => a.next_action_date!.localeCompare(b.next_action_date!));
    return { collector_id: collector, due_count: due.length, total_cents: due.reduce((sum, row) => sum + row.amount_cents, 0), next_title_id: due[0]?.id ?? null, next_due_date: due[0]?.next_action_date ?? null };
  };
  function timer(row: Row) {
    const session = state.sessions.get(row.id);
    const elapsed = session?.running && session.started_at ? Math.max(0, Math.floor((state.now - Date.parse(session.started_at)) / 1000)) : 0;
    const total = (session?.total_seconds ?? 0) + elapsed;
    return { title_id: row.id, running: !!session?.running, session_id: session?.session_id ?? null, started_at: session?.started_at ?? null, elapsed_seconds: elapsed, total_seconds: total, actor_total_seconds: total, server_now: new Date(state.now).toISOString(), recovery_allowed: !!session?.running && (!collectible(row) || row.due_date >= today) };
  }
  function listed(row: Row) {
    const current = timer(row);
    const due = !!row.next_action_date && row.next_action_date <= today && collectible(row), hasRunning = [...state.sessions].some(([, session]) => session.running);
    const block = options.director ? 'READ_ONLY' : !row.collector_id ? 'UNASSIGNED' : row.status === 'PENDING_VALIDATION' ? 'PENDING_VALIDATION' : row.status === 'VALIDATED' ? 'SETTLED' : hasRunning ? 'ALREADY_RUNNING' : !due && priority(row.collector_id).due_count ? 'RETURN_PRIORITY' : null;
    return { ...row, total_work_seconds: current.total_seconds, current_timer: current, return_due: due, return_due_date: due ? row.next_action_date : null, can_start: block === null, start_block_reason: block };
  }
  function detail(row: Row) {
    return { title: listed(row), case: { status: row.operational_status, observation: row.observation, next_action: row.next_action_text, next_date: row.next_date, payment_date: row.case_payment_date, revision: row.case_revision, updated_at: row.updated_at, updated_by: id(1), finalized_at: row.finalized_at }, timer: timer(row), history: state.events.filter(event => event.title_id === row.id), case_history: state.caseEvents.filter(event => event.title_id === row.id), work_sessions: [], workflow: { ...workflow, started: state.started.has(row.id), can_finish: state.started.has(row.id) && collectible(row) && !options.director, recovery_allowed: timer(row).recovery_allowed }, priority: priority(row.collector_id) };
  }
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON(); calls.push({ name, body, method: request.method(), query: url.search });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 86_400, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: id(1), aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: initialTime.toISOString(), app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    // Previous database remains usable while the optional 027 context is not activated.
    if (name === 'collection_customer_context') return reply({ code: 'PGRST202' }, 404);
    if (name === 'collections_overdue_summary' || name === 'receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'collection_agents') return reply([{ id: own, display_name: 'Responsável A', enabled: true }, ...(!isCollector ? [{ id: other, display_name: 'Responsável B', enabled: true }] : [])]);
    if (name === 'collection_workbench') {
      let filtered = visible();
      if ((body.p_queue ?? 'active') === 'active') filtered = filtered.filter(row => ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status));
      if (body.p_queue === 'history') filtered = filtered.filter(row => row.status === 'VALIDATED');
      if (body.p_queue === 'returns') filtered = filtered.filter(row => collectible(row) && row.next_action_date && row.next_action_date <= today);
      if (body.p_search) { const query = String(body.p_search).toLocaleLowerCase('pt-BR'); filtered = filtered.filter(row => [row.client_name, row.document, row.operational_status, row.observation].some(value => (value ?? '').toLocaleLowerCase('pt-BR').includes(query))); }
      if (body.p_collector_id) filtered = filtered.filter(row => row.collector_id === body.p_collector_id);
      if (body.p_unassigned) filtered = filtered.filter(row => row.collector_id === null);
      if (body.p_status) filtered = filtered.filter(row => row.operational_status === body.p_status);
      if (body.p_band) {
        const bounds: Record<string, [number, number]> = { '1_30': [1, 30], '31_60': [31, 60], '61_90': [61, 90], '91_180': [91, 180], '181_365': [181, 365], ACIMA_365: [366, Infinity] };
        const range = bounds[body.p_band]; if (range) filtered = filtered.filter(row => row.delay_days >= range[0] && row.delay_days <= range[1]);
      }
      if (body.p_due_start) filtered = filtered.filter(row => row.due_date >= body.p_due_start);
      if (body.p_due_end) filtered = filtered.filter(row => row.due_date <= body.p_due_end);
      if (body.p_financial_status && body.p_financial_status !== 'ACTIVE') filtered = filtered.filter(row => row.status === body.p_financial_status);
      const count = filtered.length, total = filtered.reduce((sum, row) => sum + row.amount_cents, 0);
      filtered.sort((a, b) => body.p_sort === 'amount_desc' ? b.amount_cents - a.amount_cents : b.delay_days - a.delay_days);
      const returned = filtered.slice(body.p_offset ?? 0, (body.p_offset ?? 0) + (body.p_limit ?? 25)).map(listed);
      if (options.wrongScope && returned[0]) returned[0].collector_id = other;
      const running = [...state.sessions].find(([, session]) => session.running), active = running && rows.find(row => row.id === running[0]);
      return reply({ as_of_date: today, server_now: new Date(state.now).toISOString(), count, total_cents: options.unsafe ? Number.MAX_SAFE_INTEGER + 1 : total, snapshot_revision: `synthetic-${rows.reduce((sum, row) => sum + row.revision + row.case_revision, 0)}`, active_timer: active ? timer(active) : null, rows: returned, workflow, priority: priority(isCollector ? own : body.p_collector_id ?? null) });
    }
    if (name === 'collection_case_detail') { const row = visible().find(row => row.id === body.p_title_id); return row ? reply(detail(row)) : reply({ code: '42501' }, 403); }
    if (name === 'collection_work_action' || name === 'save_collection_case') {
      const row = name === 'collection_work_action' && ['PAUSE', 'FINISH'].includes(body.p_action) && state.sessions.get(body.p_title_id)?.running ? rows.find(row => row.id === body.p_title_id) : visible().find(row => row.id === body.p_title_id);
      if (!row || options.director) return reply({ code: '42501', message: 'sensitive SQL details' }, 403);
      if (state.replies.has(body.p_request_id)) return reply(state.replies.get(body.p_request_id));
      if (state.failure === 'stale') {
        state.failure = undefined; row.revision++; row.case_revision++; row.observation = 'Observação alterada por outra operação'; row.operational_status = 'SEM SUCESSO';
        return reply({ code: '40001', message: 'private SQL details and sensitive stack trace' }, 409);
      }
      if (name === 'collection_work_action') {
        const current = timer(row), existing = state.sessions.get(row.id);
        if (body.p_action === 'START') { state.started.add(row.id); state.sessions.set(row.id, { session_id: id(500 + calls.filter(call => call.name === 'collection_work_action').length), started_at: new Date(state.now).toISOString(), running: true, total_seconds: existing?.total_seconds ?? 0 }); }
        else { if (body.p_action === 'FINISH') state.started.delete(row.id); state.sessions.set(row.id, { session_id: null, started_at: null, running: false, total_seconds: current.total_seconds }); }
        const response = timer(row); state.replies.set(body.p_request_id, response);
        if (state.failure === 'uncertain') { state.failure = undefined; return route.abort('failed'); }
        return reply(response);
      }
      if (body.p_finish && !state.started.has(row.id)) return reply({ code: '55000' }, 409);
      row.operational_status = body.p_status; row.observation = body.p_observation; row.next_action_text = body.p_next_action; row.next_date = body.p_next_date; if (body.p_finish) row.revision++; row.case_revision++; row.updated_at = new Date(state.now).toISOString();
      row.case_payment_date = body.p_payment_date;
      if (body.p_finish && body.p_status === statuses[9]) { row.status = 'PENDING_VALIDATION'; row.validation_status = 'PENDING'; row.payment_source = 'COBRANCA'; row.payment_reported_date = body.p_payment_date; row.reported_in_collection = true; row.last_action = 'PAID'; }
      if (body.p_finish) {
        state.started.delete(row.id); row.next_action_date = body.p_next_date; row.next_action = body.p_next_date ? 'OTHER' : null;
        const current = timer(row); state.sessions.set(row.id, { session_id: null, started_at: null, running: false, total_seconds: current.total_seconds }); row.finalized_at = row.updated_at;
        state.events.unshift({ id: id(900 + state.events.length), title_id: row.id, collector_id: row.collector_id, action: row.last_action ?? 'CONTACT', contact_date: today, next_action: null, next_date: row.next_date, observation: row.observation, return_note: null, payment_date: body.p_payment_date, created_at: row.updated_at });
      }
      const response = { title_id: row.id, revision: row.revision, case_revision: row.case_revision, event_id: body.p_finish ? state.events[0].id : null, finished: !!body.p_finish, timer: timer(row) }; state.replies.set(body.p_request_id, response);
      if (state.failure === 'uncertain') { state.failure = undefined; return route.abort('failed'); }
      return reply(response);
    }
    if (['collection_overdue_titles', 'receivable_titles'].includes(name)) {
      const pending = url.searchParams.get('status') === 'eq.PENDING_VALIDATION' ? visible().filter(row => row.status === 'PENDING_VALIDATION') : [];
      return reply(pending, 200, pending.length);
    }
    if (['receivable_collection_events', 'effective_receivable_receipts', 'receivable_receipts', 'receivable_imports'].includes(name)) return reply([]);
    throw new Error(`Unexpected offline workbench request ${request.method()} ${url.pathname}`);
  });
  async function login() {
    await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('TesteAtendimento'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true }).click();
    await page.getByRole('tab', { name: 'Títulos', exact: true }).click();
  }
  await login();
  return { calls, rows, state, login, advance: async (milliseconds: number) => { state.now += milliseconds; await page.clock.fastForward(milliseconds); } };
}

const desk = (page: Page) => page.getByRole('region', { name: 'Central operacional da cobrança', exact: true });
const sidebar = (page: Page) => page.getByRole('region', { name: 'Atendimento do título', exact: true });
const writes = (calls: { name: string }[]) => calls.filter(call => ['collection_work_action', 'save_collection_case', 'record_collection_action', 'validate_receivable_payment'].includes(call.name));
const listCalls = (calls: { name: string; body: any }[]) => calls.filter(call => call.name === 'collection_workbench' && call.body.p_queue !== 'returns');
async function open(page: Page, document = 'NF-1') { await page.getByRole('button', { name: `Abrir título ${document}`, exact: true }).click(); await expect(sidebar(page)).toContainText(document); }

test('carteira mostra contagem e soma integrais, pagina no servidor e pesquisa cliente, documento, status ou observação', async ({ page }) => {
  const { calls, rows, advance } = await setup(page, { large: true });
  await expect(desk(page)).toContainText('31'); await expect(desk(page)).toContainText('R$ 3.104,96');
  await expect(page.getByRole('button', { name: /^Abrir título NF-/ })).toHaveCount(25);
  await desk(page).getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(page.getByRole('button', { name: /^Abrir título NF-/ })).toHaveCount(6);
  expect(listCalls(calls).at(-1)?.body).toMatchObject({ p_offset: 25, p_limit: 25 });
  for (const term of ['Cliente sintético 2', 'NF-2', 'NOVO TÍTULO', 'Observação sintética 2']) {
    await page.getByLabel('Buscar na carteira', { exact: true }).fill(term);
    await advance(400);
    await expect.poll(() => listCalls(calls).at(-1)?.body.p_search).toBe(term);
    expect(listCalls(calls).at(-1)?.body.p_offset).toBe(0);
    await expect(page.getByRole('button', { name: 'Abrir título NF-2', exact: true })).toBeVisible();
  }
  expect(rows).toHaveLength(31); expect(writes(calls)).toHaveLength(0);
});

test('filtros de carteira são oficiais e a gerência consulta a responsável sem redistribuir dentro do atendimento', async ({ page }) => {
  const { calls } = await setup(page, { manager: true });
  await page.getByRole('combobox', { name: 'Status da cobrança', exact: true }).selectOption(statuses[0]);
  await page.getByRole('combobox', { name: 'Cobradora', exact: true }).selectOption(other);
  await page.getByRole('combobox', { name: 'Faixa de atraso', exact: true }).selectOption('181_365');
  await page.getByRole('combobox', { name: 'Ordenar carteira', exact: true }).selectOption('amount_desc');
  await expect.poll(() => listCalls(calls).at(-1)?.body).toMatchObject({ p_status: statuses[0], p_collector_id: other, p_band: '181_365', p_sort: 'amount_desc', p_offset: 0 });
  await expect(page.getByRole('button', { name: /^Abrir título NF-/ })).toHaveCount(1); await expect(page.getByRole('button', { name: 'Abrir título NF-3', exact: true })).toBeVisible();
  await open(page, 'NF-3');
  const owner = sidebar(page).getByRole('textbox', { name: 'Cobradora responsável', exact: true });
  await expect(owner).toHaveValue('Responsável B'); await expect(owner).toHaveAttribute('readonly', '');
  await expect(sidebar(page).getByText('Gerenciar responsável', { exact: true })).toHaveCount(0);
  await expect(sidebar(page).getByRole('combobox', { name: 'Nova cobradora', exact: true })).toHaveCount(0);
  await expect(sidebar(page).getByRole('textbox', { name: 'Motivo da atribuição', exact: true })).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: 'Atribuir cobradora', exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.name === 'assign_receivable_collector')).toHaveLength(0); expect(writes(calls)).toHaveLength(0);
});

test('iniciar e pausar persistem o cronômetro; pausa congela o tempo e reabertura não perde o atendimento', async ({ page }) => {
  const seen = await setup(page); await open(page);
  await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeDisabled(); await expect(sidebar(page)).toContainText('Pausar fica disponível somente enquanto o atendimento está em andamento.');
  await expect(sidebar(page).getByRole('button', { name: 'Finalizar atendimento', exact: true })).toBeDisabled(); await expect(sidebar(page)).toContainText('Finalizar e marcar como pago exigem que este atendimento tenha sido iniciado.');
  await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
  await seen.advance(62_000); await expect(sidebar(page).getByRole('timer')).toContainText('00:01:02');
  await sidebar(page).getByRole('button', { name: 'Pausar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Iniciar', exact: true })).toBeEnabled(); await expect(sidebar(page).getByRole('timer')).toContainText('00:01:02');
  await seen.advance(3_600_000); await expect(sidebar(page).getByRole('timer')).toContainText('00:01:02');
  await page.reload(); await seen.login(); await open(page); await expect(sidebar(page).getByRole('timer')).toContainText('00:01:02');
  expect(seen.calls.filter(call => call.name === 'collection_work_action').map(call => call.body.p_action)).toEqual(['START', 'PAUSE']);
  expect(seen.calls.filter(call => call.name === 'collection_work_action').every(call => call.body.p_title_id === id(101) && call.body.p_expected_revision === 1 && /^[0-9a-f-]{36}$/i.test(call.body.p_request_id))).toBe(true);
});

test('título sem cobradora explica por que Iniciar está indisponível sem enviar uma operação', async ({ page }) => {
  const seen = await setup(page, { manager: true, unassigned: true }); await open(page);
  await expect(sidebar(page).getByRole('button', { name: 'Iniciar', exact: true })).toBeDisabled();
  await expect(sidebar(page)).toContainText('Este título está sem responsável definida.'); await expect(sidebar(page)).toContainText('Importar Bases → Contas a Receber'); await expect(sidebar(page)).not.toContainText('A Gerência Geral também pode conferir a atribuição excepcional.');
  await expect(sidebar(page).getByText('Gerenciar responsável', { exact: true })).toHaveCount(0); expect(seen.calls.filter(call => call.name === 'assign_receivable_collector')).toHaveLength(0);
  await expect(sidebar(page).getByRole('textbox', { name: 'Observações', exact: true })).toBeDisabled(); for (const name of ['Salvar andamento', 'Finalizar atendimento', 'Marcar como título pago']) { const action = sidebar(page).getByRole('button', { name, exact: true }); await expect(action).toBeVisible(); await expect(action).toBeDisabled(); } expect(writes(seen.calls)).toHaveLength(0);
});

test('reabrir um atendimento em execução usa o início persistido pelo servidor sem criar outra sessão', async ({ page }) => {
  const seen = await setup(page); await open(page); await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled(); await seen.advance(35_000);
  await page.reload(); await seen.login(); await open(page); await expect(sidebar(page).getByRole('timer')).toContainText('00:00:35'); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
  expect(seen.calls.filter(call => call.name === 'collection_work_action')).toHaveLength(1);
});

test('troca de título pede confirmação e cancelar preserva status, observações e próxima ação não salvos', async ({ page }) => {
  const { calls } = await setup(page); await open(page);
  await page.getByRole('combobox', { name: 'Status do atendimento', exact: true }).selectOption('AGUARDANDO RETORNO'); await page.getByRole('textbox', { name: 'Observações', exact: true }).fill('Rascunho sintético ainda não salvo'); await sidebar(page).getByLabel('Próxima ação', { exact: true }).fill('Retornar por telefone');
  page.once('dialog', async dialog => { expect(dialog.message()).toMatch(/não salv|descartar/i); await dialog.dismiss(); }); await page.getByRole('button', { name: 'Abrir título NF-2', exact: true }).click();
  await expect(sidebar(page)).toContainText('NF-1'); await expect(page.getByRole('textbox', { name: 'Observações', exact: true })).toHaveValue('Rascunho sintético ainda não salvo'); await expect(page.getByRole('combobox', { name: 'Status do atendimento', exact: true })).toHaveValue('AGUARDANDO RETORNO');
  expect(writes(calls)).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Abrir título NF-2', exact: true }).click(); await expect(sidebar(page)).toContainText('NF-2');
});

test('iniciar, pausar, salvar e finalizar preservam rascunho e tempo com as duas revisões oficiais', async ({ page }) => {
  const seen = await setup(page); await open(page);
  await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled(); await seen.advance(12_000);
  await page.getByRole('combobox', { name: 'Status do atendimento', exact: true }).selectOption('PAGAMENTO PROGRAMADO'); await page.getByRole('textbox', { name: 'Observações', exact: true }).fill('Programação sintética confirmada'); await sidebar(page).getByLabel('Próxima ação', { exact: true }).fill('Confirmar recebimento no retorno'); await page.getByLabel('Data da próxima ação', { exact: true }).fill('2026-10-20');
  await sidebar(page).getByRole('button', { name: 'Pausar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Iniciar', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Observações', exact: true })).toHaveValue('Programação sintética confirmada'); await expect(sidebar(page).getByRole('button', { name: 'Finalizar atendimento', exact: true })).toBeEnabled();
  await sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true }).click(); await expect.poll(() => seen.calls.filter(call => call.name === 'save_collection_case').length).toBe(1);
  expect(seen.calls.find(call => call.name === 'save_collection_case')?.body).toMatchObject({ p_expected_revision: 1, p_expected_case_revision: 0, p_finish: false });
  await expect(sidebar(page).getByRole('button', { name: 'Finalizar atendimento', exact: true })).toBeEnabled();
  await sidebar(page).getByRole('button', { name: 'Finalizar atendimento', exact: true }).click();
  await expect.poll(() => seen.calls.filter(call => call.name === 'save_collection_case').length).toBe(2);
  expect(seen.calls.filter(call => call.name === 'save_collection_case').at(-1)?.body).toMatchObject({ p_title_id: id(101), p_status: 'PAGAMENTO PROGRAMADO', p_observation: 'Programação sintética confirmada', p_next_action: 'Confirmar recebimento no retorno', p_next_date: '2026-10-20', p_expected_revision: 1, p_expected_case_revision: 1, p_finish: true, p_payment_date: null });
  expect(seen.calls.filter(call => call.name === 'collection_work_action').map(call => call.body.p_action)).toEqual(['START', 'PAUSE']);
  await expect(sidebar(page)).toContainText('NF-1');
  await expect(sidebar(page).getByRole('timer')).toContainText('00:00:12'); await seen.advance(60_000); await expect(sidebar(page).getByRole('timer')).toContainText('00:00:12');
});

test('há dez status, rascunho não informa pagamento e título pago sai da carteira ativa para validação', async ({ page }) => {
  const seen = await setup(page);
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Nenhum pagamento pendente para este filtro.', exact: true })).toBeVisible();
  const validationReads = () => seen.calls.filter(call => ['collection_overdue_titles', 'receivable_titles'].includes(call.name) && new URLSearchParams(call.query).get('status') === 'eq.PENDING_VALIDATION').length;
  const before = validationReads();
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click(); await open(page);
  await expect(page.getByRole('combobox', { name: 'Status do atendimento', exact: true }).locator('option')).toHaveText(statuses);
  await page.getByRole('combobox', { name: 'Status do atendimento', exact: true }).selectOption('AGUARDANDO LIQUIDACAO');
  await page.getByRole('textbox', { name: 'Observações', exact: true }).fill('Pagamento informado em contato sintético');
  await sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true }).click();
  await expect.poll(() => seen.calls.filter(call => call.name === 'save_collection_case').length).toBe(1);
  expect(seen.calls.find(call => call.name === 'save_collection_case')?.body).toMatchObject({ p_status: 'AGUARDANDO LIQUIDACAO', p_payment_date: null, p_finish: false });
  expect(seen.rows[0].status).toBe('OPEN'); expect(seen.state.events).toHaveLength(0);
  await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Status do atendimento', exact: true }).selectOption('TÍTULO PAGO'); await page.getByLabel('Data do pagamento informado', { exact: false }).fill('2026-10-17');
  await sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true }).click();
  await expect.poll(() => seen.calls.filter(call => call.name === 'save_collection_case').length).toBe(2);
  expect(seen.calls.filter(call => call.name === 'save_collection_case').at(-1)?.body).toMatchObject({ p_status: 'TÍTULO PAGO', p_payment_date: '2026-10-17', p_finish: false });
  expect(seen.rows[0].status).toBe('OPEN'); expect(seen.rows[0].validation_status).toBe('NONE'); expect(seen.state.events).toHaveLength(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Ele seguirá para validação de Contas a Receber.'); return dialog.accept(); });
  await sidebar(page).getByRole('button', { name: 'Finalizar atendimento', exact: true }).click();
  await expect.poll(() => seen.calls.filter(call => call.name === 'save_collection_case').length).toBe(3);
  expect(seen.calls.filter(call => call.name === 'save_collection_case').at(-1)?.body).toMatchObject({ p_status: 'TÍTULO PAGO', p_payment_date: '2026-10-17', p_finish: true });
  expect(seen.calls.some(call => ['record_collection_action', 'validate_receivable_payment'].includes(call.name))).toBe(false);
  await expect(page.getByRole('tab', { name: 'Validação financeira', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(validationReads).toBeGreaterThan(before); await expect(page.getByRole('button', { name: 'Conferir NF-1', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Abrir título NF-1', exact: true })).toHaveCount(0); expect(seen.rows[0].payment_date).toBeNull();
  await desk(page).locator('.collection-extra-filters > summary').click(); await page.getByRole('combobox', { name: 'Situação financeira', exact: true }).selectOption('PENDING_VALIDATION');
  await expect(page.getByRole('button', { name: 'Abrir título NF-1', exact: true })).toBeVisible(); await open(page);
  await expect(sidebar(page).getByRole('button', { name: 'Iniciar', exact: true })).toBeDisabled(); await expect(sidebar(page).getByRole('textbox', { name: 'Observações', exact: true })).toBeDisabled();
});

test('pagamento informado exige data real até a data oficial e não envia um pagamento futuro', async ({ page }) => {
  const { calls } = await setup(page); await open(page); await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled(); await sidebar(page).getByRole('button', { name: 'Marcar como título pago', exact: true }).click();
  await expect(page.getByLabel('Data do pagamento informado', { exact: false })).toHaveAttribute('max', today);
  await page.getByLabel('Data do pagamento informado', { exact: false }).fill('2026-10-19'); await expect(sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true })).toBeDisabled();
  expect(calls.filter(call => call.name === 'save_collection_case')).toHaveLength(0); expect(await page.getByLabel('Data do pagamento informado', { exact: false }).evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(false);
  await sidebar(page).getByRole('button', { name: 'Finalizar atendimento', exact: true }).click(); await expect(sidebar(page).getByRole('alert')).toContainText(/futuro|até hoje/); expect(calls.filter(call => call.name === 'save_collection_case')).toHaveLength(0);
});

test('cobradora consulta somente sua carteira e não recebe seleção de outra responsável', async ({ page }) => {
  const { calls } = await setup(page); await expect(page.getByRole('button', { name: 'Abrir título NF-3', exact: true })).toHaveCount(0); await expect(page.getByRole('combobox', { name: 'Cobradora', exact: true })).toHaveCount(0);
  await open(page); await expect(page.getByText('Responsável B', { exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.name === 'collection_workbench').every(call => call.body.p_collector_id === own)).toBe(true); expect(writes(calls)).toHaveLength(0);
});

test('diretor consulta a operação e o histórico sem controles nem requisições de escrita', async ({ page }) => {
  const { calls, state } = await setup(page, { director: true });
  const createdAt = '2026-10-17T02:30:00Z';
  state.events.push({ id: id(950), title_id: id(101), action: 'CONTACT', observation: 'Contato oficial sintético antes da meia-noite UTC', contact_date: '2026-10-16', next_action: null, next_date: null, payment_date: null, return_note: null, created_at: createdAt });
  state.caseEvents.push({ id: id(951), title_id: id(101), status: 'AGUARDANDO RETORNO', observation: 'Andamento sintético salvo antes da meia-noite UTC', next_action: 'Retornar por telefone', next_date: '2026-10-19', finalized: false, created_at: createdAt });
  await open(page);
  await expect(sidebar(page).getByRole('button', { name: /^(Iniciar|Pausar|Finalizar atendimento|Salvar andamento|Marcar como título pago)$/ })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Status do atendimento', exact: true })).toBeDisabled(); await expect(page.getByRole('textbox', { name: 'Observações', exact: true })).toBeDisabled(); expect(writes(calls)).toHaveLength(0);
  const officialHistory = sidebar(page).getByRole('listitem').filter({ hasText: 'Contato oficial sintético antes da meia-noite UTC' });
  await expect(officialHistory.locator('time')).toContainText('16/10/2026'); await expect(officialHistory.locator('time')).toContainText('23:30'); await expect(officialHistory.locator('time')).not.toContainText('17/10/2026');
  await sidebar(page).getByText('Andamentos salvos', { exact: true }).click();
  const savedHistory = sidebar(page).getByRole('listitem').filter({ hasText: 'Andamento sintético salvo antes da meia-noite UTC' });
  await expect(savedHistory.locator('time')).toContainText('16/10/2026'); await expect(savedHistory.locator('time')).toContainText('23:30'); await expect(savedHistory.locator('time')).not.toContainText('17/10/2026');
});

test('cobradora sem vínculo não lê carteiras ou detalhes de títulos', async ({ page }) => {
  const { calls } = await setup(page, { unbound: true }); await expect(page.getByText('Seu login ainda não está vinculado', { exact: false })).toBeVisible();
  expect(calls.some(call => ['collection_workbench', 'collection_case_detail', 'collection_overdue_titles', 'receivable_titles'].includes(call.name))).toBe(false); expect(writes(calls)).toHaveLength(0);
});

for (const option of ['wrongScope', 'unsafe'] as const) {
  test(`resposta incompatível (${option}) é recusada antes de exibir carteira ou soma inválida`, async ({ page }) => {
    const { calls } = await setup(page, { [option]: true }); await expect(desk(page).getByRole('alert')).toBeVisible(); await expect(page.getByRole('button', { name: /^Abrir título NF-/ })).toHaveCount(0); expect(writes(calls)).toHaveLength(0);
  });
}

for (const failure of ['stale', 'uncertain'] as const) {
  test(`${failure}: mantém rascunho e bloqueia nova escrita até confirmar o resultado`, async ({ page }) => {
    const seen = await setup(page, { failure }); await open(page); await page.getByRole('textbox', { name: 'Observações', exact: true }).fill('Nota sintética preservada após falha'); await sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true }).click();
    await expect(sidebar(page).getByRole('alert')).toBeVisible(); await expect(page.getByRole('textbox', { name: 'Observações', exact: true })).toHaveValue('Nota sintética preservada após falha'); await expect(sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true })).toBeDisabled(); await expect(sidebar(page).getByRole('button', { name: 'Iniciar', exact: true })).toBeDisabled();
    await expect(page.getByText('private SQL details', { exact: false })).toHaveCount(0); expect(seen.calls.filter(call => call.name === 'save_collection_case')).toHaveLength(1);
    if (failure === 'uncertain') {
      const original = seen.calls.find(call => call.name === 'save_collection_case')!.body;
      await sidebar(page).getByRole('button', { name: 'Repetir confirmação pendente', exact: true }).click();
      await expect.poll(() => seen.calls.filter(call => call.name === 'save_collection_case').length).toBe(2);
      expect(seen.calls.filter(call => call.name === 'save_collection_case').at(-1)!.body).toEqual(original);
      expect(seen.rows[0].case_revision).toBe(1); await expect(sidebar(page).getByRole('button', { name: 'Repetir confirmação pendente', exact: true })).toHaveCount(0); await expect(sidebar(page).getByRole('button', { name: 'Iniciar', exact: true })).toBeEnabled();
    } else {
      await sidebar(page).getByRole('button', { name: /Atualizar/ }).click(); await expect(sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true })).toBeDisabled();
      await expect(sidebar(page)).toContainText('Observação no banco: Observação alterada por outra operação'); await expect(page.getByRole('textbox', { name: 'Observações', exact: true })).toHaveValue('Nota sintética preservada após falha');
      expect(seen.calls.filter(call => call.name === 'save_collection_case')).toHaveLength(1);
      await sidebar(page).getByRole('button', { name: 'Manter rascunho após conferência', exact: true }).click(); await sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true }).click();
      await expect.poll(() => seen.calls.filter(call => call.name === 'save_collection_case').length).toBe(2);
      expect(seen.calls.filter(call => call.name === 'save_collection_case').at(-1)?.body).toMatchObject({ p_observation: 'Nota sintética preservada após falha', p_expected_revision: 2, p_expected_case_revision: 1 });
    }
  });
}

test('início com resposta perdida repete a mesma confirmação sem criar um segundo intervalo', async ({ page }) => {
  const seen = await setup(page, { failure: 'uncertain' }); await open(page); await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect(sidebar(page).getByRole('alert')).toBeVisible(); await expect(sidebar(page).getByRole('button', { name: 'Iniciar', exact: true })).toBeDisabled();
  const original = seen.calls.find(call => call.name === 'collection_work_action')!.body, session = seen.state.sessions.get(id(101))!.session_id;
  await sidebar(page).getByRole('button', { name: 'Repetir confirmação pendente', exact: true }).click();
  await expect.poll(() => seen.calls.filter(call => call.name === 'collection_work_action').length).toBe(2);
  expect(seen.calls.filter(call => call.name === 'collection_work_action').at(-1)!.body).toEqual(original); expect(seen.state.sessions.get(id(101))!.session_id).toBe(session);
  await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
});

test('atualização externa com rascunho exige escolha e carregar versão do banco descarta só as alterações locais', async ({ page }) => {
  const seen = await setup(page); await open(page); await page.getByRole('textbox', { name: 'Observações', exact: true }).fill('Rascunho local sintético');
  seen.rows[0].revision++; seen.rows[0].case_revision++; seen.rows[0].observation = 'Registro sintético confirmado por outra operação'; seen.rows[0].operational_status = 'SEM SUCESSO';
  await sidebar(page).getByRole('button', { name: 'Atualizar detalhe', exact: true }).click();
  await expect(sidebar(page)).toContainText('O título ou o andamento mudou no banco.'); await expect(page.getByRole('textbox', { name: 'Observações', exact: true })).toHaveValue('Rascunho local sintético'); await expect(sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true })).toBeDisabled();
  await sidebar(page).getByRole('button', { name: 'Carregar versão do banco', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'Observações', exact: true })).toHaveValue('Registro sintético confirmado por outra operação'); await expect(page.getByRole('combobox', { name: 'Status do atendimento', exact: true })).toHaveValue('SEM SUCESSO');
  await expect(sidebar(page).getByRole('button', { name: 'Iniciar', exact: true })).toBeEnabled(); await expect(sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true })).toBeDisabled(); expect(writes(seen.calls)).toHaveLength(0);
});

test('intervalo de título reagendado pode ser finalizado em recuperação sem consultar o título oculto', async ({ page }) => {
  const seen = await setup(page); await open(page); await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled(); await seen.advance(17_000);
  const detailReads = () => seen.calls.filter(call => call.name === 'collection_case_detail' && call.body.p_title_id === id(101)).length;
  const before = detailReads(); seen.rows[0].due_date = shifted(1); seen.rows[0].revision++;
  await page.reload(); await seen.login();
  await expect(page.getByRole('button', { name: 'Abrir título NF-1', exact: true })).toHaveCount(0); await expect(desk(page)).toContainText('Existe um atendimento em andamento'); expect(detailReads()).toBe(before);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('nenhum pagamento será confirmado'); return dialog.accept(); }); await desk(page).getByRole('button', { name: 'Finalizar intervalo indisponível', exact: true }).click();
  await expect.poll(() => seen.state.sessions.get(id(101))?.running).toBe(false);
  expect(seen.calls.filter(call => call.name === 'collection_work_action').at(-1)?.body).toMatchObject({ p_title_id: id(101), p_action: 'FINISH', p_expected_revision: null }); expect(detailReads()).toBe(before);
  await open(page, 'NF-2'); await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
  expect(seen.calls.filter(call => call.name === 'collection_work_action').map(call => [call.body.p_title_id, call.body.p_action])).toEqual([[id(101), 'START'], [id(101), 'FINISH'], [id(102), 'START']]);
});

test('desktop mantém lista e atendimento lado a lado; celular empilha sem transbordamento da página', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await setup(page); await open(page);
  const table = desk(page).getByRole('table'); const list = await table.boundingBox(), detail = await sidebar(page).boundingBox(); expect(list).not.toBeNull(); expect(detail).not.toBeNull(); expect(detail!.x).toBeGreaterThan(list!.x); expect(Math.abs(detail!.y - list!.y)).toBeLessThan(100);
  async function checkTableEdges() {
    await table.evaluate(element => { if (element.parentElement) element.parentElement.scrollLeft = element.parentElement.scrollWidth; });
    const viewport = await table.locator('..').boundingBox(); expect(viewport).not.toBeNull();
    for (const element of [table.getByRole('cell', { name: 'Cliente sintético 1', exact: true }), table.getByRole('button', { name: 'Abrir título NF-1', exact: true })]) {
      const bounds = await element.boundingBox(); expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(viewport!.x - 1); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);
    }
  }
  await checkTableEdges();
  await table.evaluate(element => { if (element.parentElement) element.parentElement.scrollLeft = 0; });
  await page.screenshot({ path: '/tmp/central-cobranca-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); const mobileList = await table.boundingBox(), mobileDetail = await sidebar(page).boundingBox(); expect(mobileList).not.toBeNull(); expect(mobileDetail).not.toBeNull(); expect(mobileDetail!.y).toBeGreaterThan(mobileList!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await expect(sidebar(page).getByRole('button', { name: 'Salvar andamento', exact: true })).toBeVisible();
  await checkTableEdges();
  await table.evaluate(element => { if (element.parentElement) element.parentElement.scrollLeft = 0; });
  await page.screenshot({ path: '/tmp/central-cobranca-mobile.png', fullPage: true, animations: 'disabled' });
});
