import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co', today = '2026-10-18';
const id = (n: number) => `98000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = id(20), other = id(21), workflow = { version: '029', normal_pause: true, finish_requires_started: true, pending_read_only: true, returns_priority: true };
const shifted = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
interface Options { manager?: boolean; director?: boolean; unbound?: boolean; missing?: boolean; wrongScope?: boolean; unsafe?: boolean; activeTimer?: boolean; futureOnly?: boolean; otherReturn?: boolean }

async function setup(page: Page, options: Options = {}) {
  await page.clock.install({ time: new Date('2026-10-18T15:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-18T15:00:01Z'));
  const isCollector = !options.manager && !options.director, role = options.director ? 'diretor' : options.manager ? 'gerente_geral' : 'cobradora_1';
  const access = { profile: { id: id(1), username: 'TesteAgenda', display_name: 'Pessoa sintética', role_key: role, enabled: true }, permissions: [{ resource: 'cobranca', action: 'read' }, ...(!options.director ? [{ resource: 'cobranca', action: 'write' }] : [])], collector_id: isCollector && !options.unbound ? own : null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id(1), session_id: id(2), exp: 4070908800, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const make = (n: number, nextDate: string | null, collector: string | null = own, status = 'OPEN') => ({ id: id(100 + n), customer_key: `name:CLIENTE SINTÉTICO ${n}`, client_name: `Cliente sintético ${n}`, client_document: null, document: `NF-AGENDA-${n}`, branch: 'Filial sintética', due_date: shifted(-30 - n), amount_cents: 10_000, collector_id: collector, collector_name: collector === own ? 'Responsável A' : collector === other ? 'Responsável B' : null, status, validation_status: status === 'PENDING_VALIDATION' ? 'PENDING' : 'NONE', payment_source: null, payment_reported_date: null, revision: 1, operational_status: status === 'PENDING_VALIDATION' ? 'TÍTULO PAGO' : 'AGUARDANDO RETORNO', case_revision: 1, observation: `Observação sintética ${n}`, next_action_text: 'Ligar no retorno combinado', next_date: nextDate, next_action_date: nextDate, delay_days: 30 + n, total_work_seconds: 0, current_timer: { session_id: null, started_at: null, running: false, elapsed_seconds: 0 } });
  const rows = options.futureOnly ? [make(8, shifted(1))] : [...Array.from({ length: 7 }, (_, n) => make(n + 1, shifted(n < 2 ? n - 2 : 0))), make(8, shifted(1), options.manager ? other : own), make(9, shifted(-1), own, 'PENDING_VALIDATION'), make(10, shifted(-2), null), ...(options.otherReturn ? [make(11, shifted(-3), other)] : [])];
  type Row = typeof rows[number];
  const calls: { name: string; body: any }[] = [], writes: any[] = [];
  const state = { running: options.activeTimer ? rows.find(row => row.document === 'NF-AGENDA-8')?.id ?? null : null as string | null, now: Date.parse('2026-10-18T15:00:00Z') };
  const visible = () => rows.filter(row => !isCollector || !options.unbound && row.collector_id === own);
  const due = () => visible().filter(row => ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && row.collector_id && row.next_action_date && row.next_action_date <= today).sort((a, b) => a.next_action_date!.localeCompare(b.next_action_date!) || a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));
  const priority = () => ({ collector_id: isCollector ? own : null, due_count: due().length, total_cents: due().length * 10_000, next_title_id: due()[0]?.id ?? null, next_due_date: due()[0]?.next_action_date ?? null });
  const timer = (title_id: string) => ({ title_id, running: state.running === title_id, session_id: state.running === title_id ? id(500) : null, started_at: state.running === title_id ? '2026-10-18T14:58:30Z' : null, elapsed_seconds: state.running === title_id ? 90 : 0, total_seconds: state.running === title_id ? 150 : 0, actor_total_seconds: state.running === title_id ? 150 : 0, server_now: new Date(state.now).toISOString(), recovery_allowed: false });
  function enrich(row: Row) {
    const returnDue = due().some(value => value.id === row.id), sameWalletReturns = due().some(value => value.collector_id === row.collector_id);
    const reason = options.director ? 'READ_ONLY' : !row.collector_id ? 'UNASSIGNED' : row.status === 'PENDING_VALIDATION' ? 'PENDING_VALIDATION' : state.running ? 'ALREADY_RUNNING' : sameWalletReturns && !returnDue ? 'RETURN_PRIORITY' : null;
    return { ...row, return_due: returnDue, return_due_date: row.next_action_date, can_start: reason === null, start_block_reason: reason, current_timer: timer(row.id) };
  }
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!, body = request.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    calls.push({ name, body });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 86400 }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: id(1), aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: '2026-10-18T10:00:00Z', app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (['collections_overdue_summary', 'collection_customer_context', 'collection_work_summary', 'collection_customer_contact_report'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'collection_agents') return reply([{ id: own, display_name: 'Responsável A', enabled: true }, ...(!isCollector ? [{ id: other, display_name: 'Responsável B', enabled: true }] : [])]);
    if (name === 'collection_workbench') {
      if (options.missing && body.p_queue === 'returns') return reply({ code: '22023', message: 'private old queue constraint' }, 400);
      let filtered = body.p_queue === 'returns' ? due() : visible().filter(row => ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status));
      if (body.p_search) filtered = filtered.filter(row => `${row.client_name} ${row.document}`.toLowerCase().includes(body.p_search.toLowerCase()));
      if (body.p_collector_id) filtered = filtered.filter(row => row.collector_id === body.p_collector_id);
      const returned = filtered.slice(body.p_offset ?? 0, (body.p_offset ?? 0) + (body.p_limit ?? 25)).map(enrich), totals = priority();
      if (options.wrongScope && body.p_queue === 'returns') { totals.collector_id = other; if (returned[0]) { returned[0].collector_id = other; returned[0].client_name = 'Outro escopo não pode aparecer'; } }
      return reply({ as_of_date: today, server_now: new Date(state.now).toISOString(), snapshot_revision: 'synthetic-agenda', count: filtered.length, total_cents: options.unsafe && body.p_queue === 'returns' ? Number.MAX_SAFE_INTEGER + 1 : filtered.length * 10_000, rows: returned, active_timer: state.running ? timer(state.running) : null, ...(options.missing ? {} : { workflow, priority: totals }) });
    }
    if (name === 'collection_case_detail') {
      const row = visible().find(value => value.id === body.p_title_id); if (!row) return reply({ code: '42501' }, 403);
      return reply({ title: enrich(row), case: { status: row.operational_status, observation: row.observation, next_action: row.next_action_text, next_date: row.next_date, payment_date: null, revision: row.case_revision, updated_at: null, updated_by: null, finalized_at: null }, timer: timer(row.id), history: [], work_sessions: [], ...(options.missing ? {} : { workflow: { ...workflow, started: state.running === row.id, can_finish: state.running === row.id, recovery_allowed: false }, priority: priority() }) });
    }
    if (name === 'collection_work_action' || name === 'save_collection_case') { writes.push({ name, body }); return reply({ code: '42501' }, 403); }
    if (['collection_overdue_titles', 'receivable_collection_events', 'effective_receivable_receipts', 'receivable_receipts'].includes(name)) return reply([], 200, 0);
    throw new Error(`Unexpected synthetic agenda request ${name}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('TesteAgenda'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  return { rows, calls, writes, state };
}
const agenda = (page: Page) => page.getByRole('region', { name: 'Agenda de retornos da cobrança', exact: true });
const enterTitles = (page: Page) => page.getByRole('tab', { name: 'Títulos', exact: true }).click();
const returnCalls = (calls: { name: string; body: any }[]) => calls.filter(call => call.name === 'collection_workbench' && call.body.p_queue === 'returns' && call.body.p_limit === 5);

test('ao entrar já mostra os cinco primeiros retornos oficiais e a contagem integral da própria carteira', async ({ page }) => {
  const seen = await setup(page);
  await expect(agenda(page)).toContainText('7 retorno(s) para atender'); await expect(agenda(page).getByRole('button', { name: /^Abrir retorno NF-/ })).toHaveCount(5);
  expect(returnCalls(seen.calls)[0].body).toEqual({ p_search: '', p_collector_id: own, p_unassigned: false, p_band: null, p_sort: 'next_date_asc', p_status: null, p_offset: 0, p_limit: 5, p_queue: 'returns', p_due_start: null, p_due_end: null, p_next_action: null, p_financial_status: 'ACTIVE' });
  await expect(agenda(page)).toContainText('Exibindo os primeiros 5 de 7'); await expect(agenda(page)).not.toContainText('NF-AGENDA-8'); await expect(agenda(page)).not.toContainText('NF-AGENDA-9'); await expect(agenda(page)).not.toContainText('NF-AGENDA-10'); expect(seen.writes).toHaveLength(0);
});
test('atender retornos abre a fila completa sem iniciar atendimento automaticamente', async ({ page }) => {
  const seen = await setup(page); await agenda(page).getByRole('button', { name: 'Atender retornos', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Títulos', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /^Abrir título NF-AGENDA-/ })).toHaveCount(7);
  expect(seen.calls.some(call => call.name === 'collection_workbench' && call.body.p_queue === 'returns' && call.body.p_limit === 25)).toBe(true); expect(seen.writes).toHaveLength(0);
});
test('abrir um retorno específico consulta seu título e mantém o protocolo somente em leitura', async ({ page }) => {
  const seen = await setup(page); await agenda(page).getByRole('button', { name: 'Abrir retorno NF-AGENDA-2', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Atendimento do título', exact: true })).toContainText('NF-AGENDA-2');
  expect(seen.calls.filter(call => call.name === 'collection_case_detail').at(-1)?.body.p_title_id).toBe(id(102)); expect(seen.writes).toHaveLength(0);
});
test('a agenda ignora filtros locais da mesa e o atalho restaura a fila de retornos', async ({ page }) => {
  const seen = await setup(page); await enterTitles(page); await page.getByLabel('Buscar na carteira', { exact: true }).fill('pesquisa sem correspondência'); await page.clock.fastForward(300);
  await expect(page.getByRole('button', { name: /^Abrir título NF-AGENDA-/ })).toHaveCount(0); await expect(agenda(page)).toContainText('7 retorno(s) para atender');
  await agenda(page).getByRole('button', { name: 'Atender retornos', exact: true }).click(); await expect(page.getByLabel('Buscar na carteira', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: /^Abrir título NF-AGENDA-/ })).toHaveCount(7); expect(returnCalls(seen.calls).every(call => call.body.p_search === '' && call.body.p_due_start === null && call.body.p_collector_id === own)).toBe(true);
});
test('retornos futuros não geram alerta nem bloqueiam o início quando a carteira não tem retornos devidos', async ({ page }) => {
  const seen = await setup(page, { futureOnly: true }); await page.clock.setFixedTime(new Date('2028-01-01T15:00:00Z')); await expect(agenda(page)).toContainText('Nenhum retorno devido em 18/10/2026'); await expect(agenda(page).getByRole('button', { name: 'Atender retornos', exact: true })).toHaveCount(0);
  await enterTitles(page); await page.getByRole('button', { name: 'Abrir título NF-AGENDA-8', exact: true }).click(); await expect(page.getByRole('button', { name: 'Iniciar', exact: true })).toBeEnabled(); expect(seen.writes).toHaveLength(0);
});
test('gestão consulta o conjunto e pode abrir outra carteira sem herdar bloqueio global dos retornos', async ({ page }) => {
  const seen = await setup(page, { manager: true }); await expect(agenda(page)).toContainText('7 retorno(s) para atender'); expect(returnCalls(seen.calls)[0].body.p_collector_id).toBeNull();
  await enterTitles(page); await page.getByRole('button', { name: 'Abrir título NF-AGENDA-8', exact: true }).click(); await expect(page.getByRole('button', { name: 'Iniciar', exact: true })).toBeEnabled(); expect(seen.writes).toHaveLength(0);
});
test('cronômetro em andamento é recuperado e retomado sem criar outro intervalo', async ({ page }) => {
  const seen = await setup(page, { activeTimer: true }); await expect(agenda(page).getByRole('timer')).toHaveText('00:02:30'); await page.clock.fastForward(2000); await expect(agenda(page).getByRole('timer')).toHaveText('00:02:32');
  await agenda(page).getByRole('button', { name: 'Retomar atendimento', exact: true }).click(); await expect(page.getByRole('region', { name: 'Atendimento do título', exact: true })).toContainText('NF-AGENDA-8'); expect(seen.writes).toHaveLength(0);
});
test('voltar à visão geral e recuperar foco renova a agenda sem desmontar o rascunho nas cinco abas', async ({ page }) => {
  const seen = await setup(page); await agenda(page).getByRole('button', { name: 'Abrir retorno NF-AGENDA-1', exact: true }).click();
  const attendance = page.getByRole('region', { name: 'Atendimento do título', exact: true }), observation = attendance.getByRole('textbox', { name: 'Observações', exact: true });
  await expect(attendance).toContainText('NF-AGENDA-1'); await expect(observation).toBeEditable(); await observation.fill('Rascunho sintético preservado entre abas.');
  const before = returnCalls(seen.calls).length;
  for (const tab of ['Tempo de trabalho', 'Contatos', 'Validação financeira', 'Visão geral']) await page.getByRole('tab', { name: tab, exact: true }).click();
  await expect.poll(() => returnCalls(seen.calls).length).toBeGreaterThan(before); await enterTitles(page); await expect(observation).toHaveValue('Rascunho sintético preservado entre abas.');
  const focusedBefore = returnCalls(seen.calls).length; const future = seen.rows.find(row => row.document === 'NF-AGENDA-8')!; future.next_action_date = today; future.next_date = today;
  await page.clock.fastForward(1600); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect.poll(() => returnCalls(seen.calls).length).toBeGreaterThan(focusedBefore); await expect(agenda(page)).toContainText('8 retorno(s) para atender'); expect(seen.writes).toHaveLength(0);
});
test('sem capacidade029 mantém leitura dos títulos e bloqueia iniciar/finalizar com orientação', async ({ page }) => {
  const seen = await setup(page, { missing: true }); await expect(agenda(page)).toContainText('agenda de retornos aguarda a atualização'); await enterTitles(page); await page.getByRole('button', { name: 'Abrir título NF-AGENDA-1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Iniciar', exact: true })).toBeDisabled(); for (const name of ['Salvar andamento', 'Finalizar atendimento', 'Marcar como título pago']) { const action = page.getByRole('button', { name, exact: true }); await expect(action).toBeVisible(); await expect(action).toBeDisabled(); } expect(seen.writes).toHaveLength(0);
});
test('escopo incompatível não exibe os dados de outra carteira', async ({ page }) => {
  await setup(page, { wrongScope: true }); await expect(agenda(page)).toContainText('Não foi possível consultar os retornos'); await expect(agenda(page)).not.toContainText('Outro escopo não pode aparecer'); await expect(agenda(page).getByRole('button', { name: /^Abrir retorno / })).toHaveCount(0);
});
test('valor impreciso rejeita a resposta da agenda sem presumir totais', async ({ page }) => {
  await setup(page, { unsafe: true }); await expect(agenda(page)).toContainText('Não foi possível consultar os retornos'); await expect(agenda(page).getByRole('button', { name: /^Abrir retorno / })).toHaveCount(0); await expect(agenda(page)).not.toContainText('7 retorno(s) para atender');
});
test('diretoria pode consultar retornos sem controles de escrita', async ({ page }) => {
  const seen = await setup(page, { director: true, otherReturn: true }); await expect(agenda(page)).toContainText('8 retorno(s) para atender'); await agenda(page).getByRole('button', { name: 'Abrir retorno NF-AGENDA-11', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Atendimento do título', exact: true })).toContainText('NF-AGENDA-11'); await expect(page.getByRole('button', { name: 'Iniciar', exact: true })).toHaveCount(0); expect(seen.writes).toHaveLength(0);
});
test('cobradora sem vínculo não consulta agenda, títulos ou dados de outra carteira', async ({ page }) => {
  const seen = await setup(page, { unbound: true }); await expect(page.getByRole('status')).toContainText('não está vinculado'); await expect(agenda(page)).toHaveCount(0); expect(seen.calls.some(call => call.name === 'collection_workbench' || call.name === 'collection_case_detail')).toBe(false);
});
