import { expect, test, type Page } from '@playwright/test';
const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const day = '2026-10-18', initial = '2026-10-18T15:00:00.000Z';
const id = (n: number) => `99000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = id(20);
const workflow = { version: '029', normal_pause: true, finish_requires_started: true, pending_read_only: true, returns_priority: true };
type Options = { legacy?: boolean; returns?: boolean; unassigned?: boolean; director?: boolean; resume?: boolean; unknown?: 'START' | 'PAUSE' | 'SAVE' | 'FINISH'; recovery?: boolean; computerWrong?: boolean };
async function setup(page: Page, options: Options = {}) {
  await page.clock.install({ time: new Date(options.computerWrong ? '2026-10-14T15:00:00Z' : initial) }); await page.clock.pauseAt(new Date(options.computerWrong ? '2026-10-14T15:00:01Z' : '2026-10-18T15:00:01Z'));
  const manager = options.unassigned, collector = !manager && !options.director;
  const access = { profile: { id: id(1), username: 'TesteFluxo', display_name: 'Operadora de teste', role_key: manager ? 'gerente_geral' : options.director ? 'diretor' : 'cobradora_1', enabled: true }, collector_id: collector ? own : null, permissions: [{ resource: 'cobranca', action: 'read' }, ...(!options.director ? [{ resource: 'cobranca', action: 'write' }] : []), ...(!collector ? [{ resource: 'contas_receber', action: 'read' }] : []), ...(manager ? [{ resource: 'contas_receber', action: 'write' }] : [])] };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id(1), session_id: id(2), exp: Date.parse(initial) / 1000 + 86400, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const make = (n: number, changes: Record<string, unknown> = {}) => ({ id: id(100 + n), customer_key: `name:ORGAO FLUXO ${n}`, document: `FLUXO-${n}`, client_name: `Órgão de fluxo ${n}`, client_document: null, branch: 'Filial sintética', due_date: '2026-10-08', amount_cents: 10000 + n, collector_id: own, collector_name: 'Operadora de teste', status: 'OPEN', validation_status: 'NONE', payment_source: null, payment_reported_date: null, revision: 1, operational_status: 'NOVO TÍTULO - COBRAR', case_revision: 0, observation: null, next_action_text: null, next_date: null, delay_days: 10, total_work_seconds: 0, finalized_at: null, ...changes });
  const rows: any[] = [make(1, options.unassigned ? { collector_id: null, collector_name: null } : options.returns ? { next_action_text: 'Retornar por telefone', next_date: '2026-10-17' } : {}), make(2), make(3, { next_action_text: 'Retorno futuro', next_date: '2026-10-19' }), make(4, { status: 'PENDING_VALIDATION', validation_status: 'PENDING', payment_source: 'COBRANCA', payment_reported_date: day })];
  for (const row of rows) row.agenda_date = row.next_date;
  const state = { now: Date.parse(initial), runningId: options.resume || options.recovery ? rows[0].id as string | null : null, started: new Set<string>(options.resume ? [rows[0].id] : []), starts: new Map<string, number>(options.resume || options.recovery ? [[rows[0].id, Date.parse(initial) - 60000]] : []), totals: new Map<string, number>(), replies: new Map<string, any>(), unknown: options.unknown, inaccessible: !!options.recovery, events: [] as any[], financialWrites: 0, saves: 0 };
  const calls: { name: string; body: any }[] = [];
  const due = (row: any) => ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && row.agenda_date && row.agenda_date <= day;
  const priority = () => { const pending = rows.filter(due); return { collector_id: collector ? own : null, due_count: pending.length, total_cents: pending.reduce((sum, row) => sum + row.amount_cents, 0), next_title_id: pending[0]?.id ?? null, next_due_date: pending[0]?.agenda_date ?? null }; };
  function timer(row: any) { const elapsed = state.runningId === row.id ? Math.floor((state.now - (state.starts.get(row.id) ?? state.now)) / 1000) : 0; return { title_id: row.id, running: state.runningId === row.id, session_id: state.runningId === row.id ? id(500) : null, started_at: state.runningId === row.id ? new Date(state.starts.get(row.id)!).toISOString() : null, elapsed_seconds: elapsed, total_seconds: (state.totals.get(row.id) ?? 0) + elapsed, actor_total_seconds: (state.totals.get(row.id) ?? 0) + elapsed, server_now: new Date(state.now).toISOString(), recovery_allowed: state.inaccessible && row.id === rows[0].id }; }
  function flags(row: any) { const reason = options.director ? 'READ_ONLY' : !row.collector_id ? 'UNASSIGNED' : row.status === 'PENDING_VALIDATION' ? 'PENDING_VALIDATION' : row.status === 'VALIDATED' ? 'SETTLED' : state.runningId ? 'ALREADY_RUNNING' : priority().due_count && !due(row) ? 'RETURN_PRIORITY' : null; return { return_due: !!due(row), return_due_date: due(row) ? row.agenda_date : null, can_start: reason === null, start_block_reason: reason }; }
  const listed = (row: any) => ({ ...row, ...(!options.legacy ? flags(row) : {}), current_timer: timer(row), total_work_seconds: timer(row).total_seconds });
  function detail(row: any) { return { title: listed(row), case: { status: row.operational_status, observation: row.observation, next_action: row.next_action_text, next_date: row.next_date, payment_date: row.case_payment_date ?? row.payment_reported_date, revision: row.case_revision, updated_at: initial, updated_by: id(1), finalized_at: row.finalized_at }, timer: timer(row), history: state.events.filter(event => event.title_id === row.id), case_history: [], work_sessions: [], ...(!options.legacy ? { workflow: { ...workflow, started: state.started.has(row.id), can_finish: !options.director && state.started.has(row.id) && row.status !== 'PENDING_VALIDATION', recovery_allowed: false }, priority: priority() } : {}) }; }
  function pause(row: any) { state.totals.set(row.id, timer(row).total_seconds); state.runningId = null; }
  await page.route(`${project}/**`, async route => {
    const request = route.request(), name = new URL(request.url()).pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON(); calls.push({ name, body });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 86400, token_type: 'bearer' }, access });
    if (name === 'user') return reply({ id: id(1), aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: initial, app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (['collections_overdue_summary', 'receivables_management_summary', 'collection_work_summary', 'collection_customer_context'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'collection_agents') return reply([{ id: own, display_name: 'Operadora de teste', enabled: true }]);
    if (name === 'collection_workbench') {
      let visible = rows.filter(row => !state.inaccessible || row.id !== rows[0].id);
      if (body.p_queue === 'returns') visible = visible.filter(due); else if (body.p_queue === 'active') visible = visible.filter(row => !['PENDING_VALIDATION', 'VALIDATED'].includes(row.status)); else if (body.p_queue === 'history') visible = visible.filter(row => row.status === 'VALIDATED');
      if (body.p_financial_status && body.p_financial_status !== 'ACTIVE') visible = visible.filter(row => row.status === body.p_financial_status);
      if (body.p_search) visible = visible.filter(row => row.client_name.includes(body.p_search));
      return reply({ as_of_date: day, server_now: new Date(state.now).toISOString(), count: visible.length, total_cents: visible.reduce((sum, row) => sum + row.amount_cents, 0), snapshot_revision: `fixture-${state.saves}`, active_timer: state.runningId ? timer(rows.find(row => row.id === state.runningId)) : null, rows: visible.slice(body.p_offset, body.p_offset + body.p_limit).map(listed), ...(!options.legacy ? { workflow, priority: priority() } : {}) });
    }
    if (name === 'collection_case_detail') { const row = rows.find(row => row.id === body.p_title_id); return row && !(state.inaccessible && row.id === rows[0].id) ? reply(detail(row)) : reply({ code: '42501' }, 403); }
    if (name === 'collection_work_action' || name === 'save_collection_case') {
      if (state.replies.has(body.p_request_id)) return reply(state.replies.get(body.p_request_id));
      const row = rows.find(row => row.id === body.p_title_id)!; if (options.director) return reply({ code: '42501' }, 403);
      if (name === 'collection_work_action') {
        if (body.p_action === 'START') { if (flags(row).start_block_reason === 'RETURN_PRIORITY') return reply({ code: 'P0029' }, 409); state.runningId = row.id; state.started.add(row.id); state.starts.set(row.id, state.now); }
        else pause(row);
        const response = timer(row); state.replies.set(body.p_request_id, response); if (state.unknown === body.p_action) { state.unknown = undefined; return route.abort('failed'); } return reply(response);
      }
      if (body.p_finish && !state.started.has(row.id)) return reply({ code: '55000' }, 409);
      row.operational_status = body.p_status; row.observation = body.p_observation; row.next_action_text = body.p_next_action; row.next_date = body.p_next_date; row.case_payment_date = body.p_payment_date; row.case_revision++; state.saves++;
      if (body.p_finish) { row.agenda_date = body.p_status === 'TÍTULO PAGO' ? null : body.p_next_date; row.revision++; row.finalized_at = new Date(state.now).toISOString(); if (state.runningId === row.id) pause(row); state.started.delete(row.id); if (body.p_status === 'TÍTULO PAGO') { row.status = 'PENDING_VALIDATION'; row.validation_status = 'PENDING'; row.payment_source = 'COBRANCA'; row.payment_reported_date = body.p_payment_date; row.observation += `\nPagamento informado em ${body.p_payment_date.split('-').reverse().join('/')}.`; row.next_action_text = 'Aguardar validação financeira'; row.next_date = null; } state.events.push({ id: id(800 + state.events.length), title_id: row.id, action: body.p_status === 'TÍTULO PAGO' ? 'PAID' : 'OTHER', observation: row.observation, payment_date: body.p_payment_date, created_at: initial }); }
      const response = { title_id: row.id, revision: row.revision, case_revision: row.case_revision, event_id: body.p_finish ? state.events.at(-1).id : null, finished: !!body.p_finish, timer: timer(row) }; state.replies.set(body.p_request_id, response);
      if (state.unknown === (body.p_finish ? 'FINISH' : 'SAVE')) { state.unknown = undefined; return route.abort('failed'); } return reply(response);
    }
    if (['collection_overdue_titles', 'receivable_titles', 'effective_receivable_receipts', 'receivable_receipts', 'receivable_collection_events', 'receivable_imports'].includes(name)) return reply([], 200, 0);
    throw new Error(`Unexpected workflow fixture request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('TesteFluxo'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click(); await expect(page.getByRole('button', { name: /Sair/ })).toBeVisible(); await page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true }).click(); await page.getByRole('tab', { name: 'Títulos', exact: true }).click();
  return { calls, rows, state, advance: async (milliseconds: number) => { state.now += milliseconds; await page.clock.fastForward(milliseconds); } };
}
const panel = (page: Page) => page.getByRole('region', { name: 'Atendimento do título', exact: true });
async function open(page: Page, n = 1) { await page.getByRole('button', { name: `Abrir título FLUXO-${n}`, exact: true }).click(); await expect(panel(page)).toContainText(`FLUXO-${n}`); }
const button = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });
const observation = (page: Page) => panel(page).getByRole('textbox', { name: 'Observações', exact: true });
async function completeDraft(page: Page) { await observation(page).fill('Contato sintético confirmado'); await panel(page).getByRole('textbox', { name: 'Próxima ação', exact: true }).fill('Retornar ao cliente'); await panel(page).getByLabel('Data da próxima ação', { exact: true }).fill('2026-10-20'); }
const workCalls = (calls: { name: string; body: any }[]) => calls.filter(call => call.name === 'collection_work_action');
const saves = (calls: { name: string; body: any }[]) => calls.filter(call => call.name === 'save_collection_case');

test('Iniciar independente de rascunho; Pausar e Salvar explicam claramente quando estão indisponíveis', async ({ page }) => {
  const seen = await setup(page); await open(page); await expect(button(page, 'Iniciar')).toBeEnabled(); await expect(button(page, 'Pausar')).toBeDisabled(); await expect(button(page, 'Salvar andamento')).toBeDisabled(); await expect(panel(page)).toContainText('após alterar os campos'); await expect(panel(page)).toContainText('Pausar fica disponível somente'); await expect(observation(page)).toBeEnabled(); await observation(page).fill('Rascunho antes de iniciar'); await expect(button(page, 'Salvar andamento')).toBeEnabled(); await expect(button(page, 'Iniciar')).toBeEnabled(); await button(page, 'Iniciar').click(); await expect(button(page, 'Pausar')).toBeEnabled(); await expect(observation(page)).toHaveValue('Rascunho antes de iniciar'); expect(workCalls(seen.calls).map(call => call.body.p_action)).toEqual(['START']);
});

test('salva antes e depois da pausa, sem perder rascunho nem somar o tempo pausado', async ({ page }) => {
  const seen = await setup(page); await open(page); await button(page, 'Iniciar').click(); await expect(button(page, 'Pausar')).toBeEnabled(); await observation(page).fill('Andamento enquanto executa'); await button(page, 'Salvar andamento').click(); await expect(page.getByRole('status').filter({ hasText: 'Andamento salvo na base central' })).toBeVisible(); await seen.advance(61000); await expect(panel(page).getByRole('timer')).toHaveText('00:01:01'); await observation(page).fill('Rascunho preservado ao pausar'); await button(page, 'Pausar').click(); await expect(button(page, 'Iniciar')).toBeEnabled(); await expect(observation(page)).toHaveValue('Rascunho preservado ao pausar'); await button(page, 'Salvar andamento').click(); await expect.poll(() => seen.state.saves).toBe(2); await seen.advance(600000); await expect(panel(page).getByRole('timer')).toHaveText('00:01:01'); expect(workCalls(seen.calls).map(call => call.body.p_action)).toEqual(['START', 'PAUSE']); expect(saves(seen.calls)).toHaveLength(2);
});

test('finalizar exige início, aceita sessão pausada e mantém o título sem abrir outra NF automaticamente', async ({ page }) => {
  const seen = await setup(page); await open(page); await completeDraft(page); await expect(button(page, 'Finalizar atendimento')).toBeDisabled(); await expect(panel(page)).toContainText('exigem que este atendimento tenha sido iniciado'); await button(page, 'Iniciar').click(); await expect(button(page, 'Pausar')).toBeEnabled(); await button(page, 'Pausar').click(); await expect(button(page, 'Finalizar atendimento')).toBeEnabled(); await button(page, 'Finalizar atendimento').click(); await expect(page.getByRole('status').filter({ hasText: 'Atendimento finalizado e registrado' })).toBeVisible(); await expect(panel(page)).toContainText('FLUXO-1'); await expect(button(page, 'Finalizar atendimento')).toBeDisabled(); expect(saves(seen.calls).filter(call => call.body.p_finish)).toHaveLength(1); expect(seen.state.started.has(id(101))).toBe(false);
});

test('atendimento em execução impede abrir outra NF; pausar permite retomar depois', async ({ page }) => {
  await setup(page); await open(page); await button(page, 'Iniciar').click(); await expect(button(page, 'Pausar')).toBeEnabled(); await expect(page.getByRole('button', { name: 'Abrir título FLUXO-2', exact: true })).toBeDisabled(); await button(page, 'Pausar').click(); await expect(page.getByRole('button', { name: 'Abrir título FLUXO-2', exact: true })).toBeEnabled(); await open(page, 2); await expect(button(page, 'Iniciar')).toBeEnabled();
});

test('retorno de ontem bloqueia novo, fila explícita usa returns e agenda futura não bloqueia', async ({ page }) => {
  const seen = await setup(page, { returns: true, computerWrong: true }); await open(page, 2); await expect(button(page, 'Iniciar')).toBeDisabled(); await expect(panel(page)).toContainText('Atenda primeiro os retornos devidos'); await page.getByRole('button', { name: 'Abrir retornos devidos', exact: true }).click(); await expect.poll(() => seen.calls.filter(call => call.name === 'collection_workbench').at(-1)?.body.p_queue).toBe('returns'); await expect(page.getByRole('button', { name: /^Abrir título FLUXO-/ })).toHaveCount(1); await open(page); await button(page, 'Iniciar').click(); await expect(button(page, 'Pausar')).toBeEnabled(); await completeDraft(page); await button(page, 'Salvar andamento').click(); await expect(page.getByRole('status').filter({ hasText: 'Andamento salvo na base central' })).toBeVisible(); expect(seen.rows[0].agenda_date).toBe('2026-10-17'); await button(page, 'Finalizar atendimento').click(); await expect.poll(() => seen.state.started.size).toBe(0); await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click(); await open(page, 3); await expect(button(page, 'Iniciar')).toBeEnabled(); expect(seen.rows[2].next_date).toBe('2026-10-19');
});

test('Marcar como título pago abre campos faltantes e depois envia fechamento atômico sem próxima data manual', async ({ page }) => {
  const seen = await setup(page); await open(page); await button(page, 'Iniciar').click(); await expect(button(page, 'Pausar')).toBeEnabled(); await button(page, 'Marcar como título pago').click(); await expect(panel(page).getByRole('alert')).toContainText('preencha a observação e a data real'); expect(saves(seen.calls)).toHaveLength(0); await observation(page).fill('Cliente informou liquidação'); await panel(page).getByLabel('Data do pagamento informado', { exact: false }).fill(day); await expect(panel(page).getByRole('textbox', { name: 'Próxima ação', exact: true })).toHaveValue('Aguardar validação financeira'); await expect(panel(page).getByLabel('Data da próxima ação', { exact: true })).toBeDisabled(); await button(page, 'Salvar andamento').click(); await expect(page.getByRole('status').filter({ hasText: 'Andamento salvo na base central' })).toBeVisible(); expect(seen.rows[0].status).toBe('OPEN'); expect(saves(seen.calls)[0].body.p_finish).toBe(false); page.once('dialog', dialog => dialog.accept()); await button(page, 'Marcar como título pago').click(); await expect.poll(() => seen.rows[0].status).toBe('PENDING_VALIDATION'); expect(saves(seen.calls).at(-1)?.body).toMatchObject({ p_finish: true, p_status: 'TÍTULO PAGO', p_payment_date: day, p_next_action: null, p_next_date: null }); expect(seen.rows[0].observation).toContain('18/10/2026'); expect(seen.state.events).toHaveLength(1); expect(seen.state.runningId).toBeNull(); expect(seen.calls.some(call => call.name === 'validate_receivable_payment')).toBe(false);
});

test('banco anterior mantém leitura com aviso explícito de ativação e não dispara escrita', async ({ page }) => {
  const seen = await setup(page, { legacy: true }); await open(page); await expect(panel(page)).toContainText('Ative a atualização 029'); await expect(button(page, 'Iniciar')).toBeDisabled(); await expect(button(page, 'Pausar')).toBeDisabled(); await expect(observation(page)).toBeDisabled(); expect(workCalls(seen.calls)).toHaveLength(0); expect(saves(seen.calls)).toHaveLength(0);
});

test('sem responsável o motivo direciona à importação e não exige escolher por atendimento', async ({ page }) => {
  await setup(page, { unassigned: true }); await open(page); await expect(button(page, 'Iniciar')).toBeDisabled(); await expect(panel(page)).toContainText('Importar Bases → Contas a Receber'); await expect(observation(page)).toBeDisabled();
});

test('pendentes saem da carteira normal e só aparecem em filtro explícito como leitura', async ({ page }) => {
  const seen = await setup(page); await expect(page.getByRole('button', { name: 'Abrir título FLUXO-4', exact: true })).toHaveCount(0); await page.locator('.collection-extra-filters > summary').click(); await page.getByRole('combobox', { name: 'Situação financeira', exact: true }).selectOption('PENDING_VALIDATION'); await open(page, 4); await expect(observation(page)).toBeDisabled(); await expect(button(page, 'Iniciar')).toBeDisabled(); await expect(panel(page)).toContainText('aguarda validação de Contas a Receber'); expect(seen.calls.filter(call => call.name === 'collection_workbench').at(-1)?.body.p_queue).toBe('all');
});

for (const action of ['START', 'PAUSE', 'SAVE'] as const) test(`resposta incerta de ${action} repete o mesmo UUID e não duplica intervalo ou andamento`, async ({ page }) => {
  const seen = await setup(page, { unknown: action }); await open(page);
  if (action !== 'SAVE') { await button(page, 'Iniciar').click(); if (action === 'PAUSE') { await expect(button(page, 'Pausar')).toBeEnabled(); await button(page, 'Pausar').click(); } }
  else { await observation(page).fill('Andamento único'); await button(page, 'Salvar andamento').click(); }
  await expect(button(page, 'Repetir confirmação pendente')).toBeEnabled(); await button(page, 'Repetir confirmação pendente').click(); await expect(button(page, 'Repetir confirmação pendente')).toHaveCount(0); const requests = action === 'SAVE' ? saves(seen.calls) : workCalls(seen.calls).filter(call => call.body.p_action === action); expect(requests).toHaveLength(2); expect(requests[0].body).toEqual(requests[1].body); if (action === 'SAVE') expect(seen.state.saves).toBe(1); else expect(seen.state.runningId).toBe(action === 'START' ? id(101) : null);
});

test('intervalo inacessível só oferece recuperação oficial e nunca confirma pagamento', async ({ page }) => {
  const seen = await setup(page, { recovery: true }); const recover = page.getByRole('button', { name: 'Finalizar intervalo indisponível', exact: true }); await expect(recover).toBeVisible(); page.once('dialog', dialog => dialog.accept()); await recover.click(); await expect(recover).toHaveCount(0); expect(workCalls(seen.calls).map(call => call.body.p_action)).toEqual(['FINISH']); expect(seen.state.runningId).toBeNull(); expect(saves(seen.calls)).toHaveLength(0);
});
