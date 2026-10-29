import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const userId = '10000000-0000-4000-8000-000000000001';
const ownAgent = '20000000-0000-4000-8000-000000000001';
const otherAgent = '20000000-0000-4000-8000-000000000002';
const titleId = '30000000-0000-4000-8000-000000000001';
const workflow = { version: '029', normal_pause: true, finish_requires_started: true, pending_read_only: true, returns_priority: true };
type Options = { role?: 'gerente_geral' | 'diretor' | 'contas_receber' | 'cobradora_1'; unbound?: boolean; unassigned?: boolean; pending?: boolean; stale?: boolean; pages?: boolean; exportChange?: boolean; dates?: boolean; serverToday?: string; missingCollection?: 'PGRST205' | '42P01'; malformedCollection?: boolean; missingReceipts?: 'PGRST205' | '42P01' | '42501'; correctedReceipt?: boolean };

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
    reported_in_collection: false, collector_locked: false, retired_from_report: false, in_latest_report: !options.pending, revision: 7, updated_at: '2026-10-15T10:00:00Z', last_action: null as string | null, next_action: null as string | null, next_action_date: null as string | null,
  };
  const seen = { titleQueries: [] as string[], titlePaths: [] as string[], receiptPaths: [] as string[], workbenchQueries: [] as any[], caseQueries: [] as string[], writes: [] as { name: string; body: any }[], events: [] as any[], receipts: [] as any[], exportSnapshots: 0 };
  const serverToday = options.serverToday ?? '2026-10-18';
  const shiftedDate = (days: number) => { const date = new Date(`${serverToday}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
  const fixtureId = (number: number) => `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const candidates = () => options.dates ? [
    { ...title, id: fixtureId(10), document: 'NF-VENCIDO', due_date: shiftedDate(-1), status: 'OPEN', validation_status: 'NONE', payment_source: null },
    { ...title, id: fixtureId(11), document: 'NF-HOJE', due_date: serverToday },
    { ...title, id: fixtureId(12), document: 'NF-FUTURO', due_date: shiftedDate(1) },
    { ...title, id: fixtureId(13), document: 'NF-PAGO', due_date: shiftedDate(-2), status: 'VALIDATED', validation_status: 'VALIDATED', payment_date: shiftedDate(-1) },
    ...(options.pending ? [{ ...title, id: fixtureId(14), document: 'NF-PENDENTE', due_date: shiftedDate(-3) }] : []),
  ] : options.pages ? Array.from({ length: 26 }, (_, i) => ({ ...title, id: fixtureId(i + 1), document: `NF-${i + 1}` })) : [{ ...title }];
  const caseState = new Map<string, { status: string; observation: string; next_action: string; next_date: string | null; revision: number }>();
  const started = new Set<string>(), running = new Set<string>();
  const timer = (id: string) => ({ title_id: id, running: running.has(id), session_id: running.has(id) ? '50000000-0000-4000-8000-000000000099' : null, started_at: running.has(id) ? `${serverToday}T15:00:00Z` : null, elapsed_seconds: 0, total_seconds: 0, actor_total_seconds: 0, server_now: `${serverToday}T15:00:00Z`, recovery_allowed: false });
  const priority = (collector_id: string | null) => {
    const due = candidates().filter(row => row.collector_id === collector_id && ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && row.due_date < serverToday && row.next_action_date && row.next_action_date <= serverToday);
    return { collector_id, due_count: due.length, total_cents: due.reduce((sum, row) => sum + row.amount_cents, 0), next_title_id: due[0]?.id ?? null, next_due_date: due[0]?.next_action_date ?? null };
  };
  const stateOf = (row: typeof title) => caseState.get(row.id) ?? { status: row.status === 'PENDING_VALIDATION' ? 'TÍTULO PAGO' : 'NOVO TÍTULO - COBRAR', observation: '', next_action: '', next_date: row.next_action_date, revision: 0 };
  const enrich = (row: typeof title) => ({ ...row, collection_as_of_date: serverToday, operational_status: stateOf(row).status, case_revision: stateOf(row).revision,
    observation: stateOf(row).observation, next_action_text: stateOf(row).next_action, next_date: stateOf(row).next_date,
    delay_days: Math.max(0, Math.round((Date.parse(`${serverToday}T12:00:00Z`) - Date.parse(`${row.due_date}T12:00:00Z`)) / 86400000)),
    collector_name: row.collector_id === ownAgent ? 'Responsável A' : row.collector_id === otherAgent ? 'Responsável B' : null, total_work_seconds: 0, current_timer: timer(row.id),
    return_due: ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && !!row.next_action_date && row.next_action_date <= serverToday, return_due_date: row.next_action_date && row.next_action_date <= serverToday ? row.next_action_date : null,
    can_start: role !== 'diretor' && !!row.collector_id && ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && !running.size,
    start_block_reason: role === 'diretor' ? 'READ_ONLY' : !row.collector_id ? 'UNASSIGNED' : row.status === 'PENDING_VALIDATION' ? 'PENDING_VALIDATION' : row.status === 'VALIDATED' ? 'SETTLED' : running.size ? 'ALREADY_RUNNING' : null });
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count !== undefined ? { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' } : {}) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply(user);
    if (url.pathname === '/rest/v1/rpc/receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (url.pathname === '/rest/v1/rpc/collections_overdue_summary') return reply({ code: 'PGRST202' }, 404);
    if (url.pathname === '/rest/v1/rpc/current_access') return reply(access);
    if (url.pathname === '/rest/v1/rpc/receivable_retired_validation_queue') return reply({ format_version: '055', count: 0, rows: [] });
    // Optional context is unavailable on the previous database used by this fixture.
    if (url.pathname === '/rest/v1/rpc/collection_customer_context') return reply({ code: 'PGRST202' }, 404);
    if (url.pathname === '/rest/v1/rpc/get_receivables_sync_revision') {
      seen.exportSnapshots++; return reply({ import_id: null, financial_revision: options.exportChange && seen.exportSnapshots > 1 ? 'revision-8' : 'revision-7' });
    }
    if (url.pathname === '/rest/v1/rpc/collection_workbench') {
      seen.workbenchQueries.push(body);
      if (body.p_limit === 1) seen.exportSnapshots++;
      if (options.missingCollection) return reply({ code: options.missingCollection, message: 'private relation name and SQL details' }, 404);
      let rows = candidates().filter(row => !collector || row.collector_id === ownAgent);
      if (!options.malformedCollection) rows = rows.filter(row => row.due_date < serverToday);
      if ((body.p_queue ?? 'active') === 'active') rows = rows.filter(row => ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status));
      if (body.p_queue === 'history') rows = rows.filter(row => row.status === 'VALIDATED');
      if (body.p_queue === 'returns') rows = rows.filter(row => ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && row.next_action_date && row.next_action_date <= serverToday);
      if (body.p_financial_status && body.p_financial_status !== 'ACTIVE') rows = rows.filter(row => row.status === body.p_financial_status);
      if (body.p_due_start) rows = rows.filter(row => row.due_date >= body.p_due_start);
      if (body.p_due_end) rows = rows.filter(row => row.due_date <= body.p_due_end);
      if (body.p_collector_id) rows = rows.filter(row => row.collector_id === body.p_collector_id);
      if (body.p_unassigned) rows = rows.filter(row => row.collector_id === null);
      if (body.p_status) rows = rows.filter(row => stateOf(row).status === body.p_status);
      const count = rows.length, offset = body.p_offset ?? 0, limit = body.p_limit ?? 25;
      return reply({ as_of_date: serverToday, server_now: `${serverToday}T15:00:00Z`, count,
        snapshot_revision: options.exportChange && seen.exportSnapshots > 1 ? 'revision-8' : 'revision-7',
        active_timer: running.size ? timer([...running][0]) : null, workflow, priority: priority(collector ? ownAgent : body.p_collector_id ?? null),
        total_cents: rows.reduce((sum, row) => sum + row.amount_cents, 0), rows: rows.slice(offset, offset + limit).map(enrich) });
    }
    if (url.pathname === '/rest/v1/rpc/collection_case_detail') {
      seen.caseQueries.push(body.p_title_id); const row = candidates().find(item => item.id === body.p_title_id)!;
      return reply({ title: enrich(row), case: { ...stateOf(row), payment_date: row.payment_reported_date, finalized_at: null, updated_at: null, updated_by: null },
        timer: timer(row.id), history: seen.events, work_sessions: [], workflow: { ...workflow, started: started.has(row.id), can_finish: role !== 'diretor' && started.has(row.id) && ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status), recovery_allowed: false }, priority: priority(row.collector_id) });
    }
    if (url.pathname === '/rest/v1/collection_agents') return reply([{ id: ownAgent, display_name: 'Responsável A', enabled: true }, ...(collector ? [] : [{ id: otherAgent, display_name: 'Responsável B', enabled: true }])], 200, collector ? 1 : 2);
    if (url.pathname === '/rest/v1/receivable_titles' || url.pathname === '/rest/v1/collection_overdue_titles') {
      const collection = url.pathname === '/rest/v1/collection_overdue_titles';
      seen.titlePaths.push(url.pathname);
      seen.titleQueries.push(url.search);
      if (collection && options.missingCollection) return reply({ code: options.missingCollection, message: 'private relation name and SQL details' }, 404);
      if (url.searchParams.get('select')?.startsWith('id,revision,updated_at')) { seen.exportSnapshots++; return reply([{ id: title.id, revision: seen.exportSnapshots > 1 && options.exportChange ? 8 : 7, updated_at: title.updated_at, ...(collection ? { collection_as_of_date: serverToday } : {}) }]); }
      const current = { ...title, ...(collection ? { collection_as_of_date: serverToday } : {}) };
      let candidates = options.dates ? [
        { ...current, id: fixtureId(10), document: 'NF-VENCIDO', due_date: shiftedDate(-1), status: 'OPEN', validation_status: 'NONE', payment_source: null },
        { ...current, id: `${titleId}-today`, document: 'NF-HOJE', due_date: serverToday },
        { ...current, id: `${titleId}-future`, document: 'NF-FUTURO', due_date: shiftedDate(1) },
        { ...current, id: `${titleId}-paid`, document: 'NF-PAGO', due_date: shiftedDate(-2), status: 'VALIDATED', validation_status: 'VALIDATED', payment_date: shiftedDate(-1) },
        ...(options.pending ? [{ ...current, id: fixtureId(14), document: 'NF-PENDENTE', due_date: shiftedDate(-3) }] : []),
      ] : [current];
      if (collection && !options.malformedCollection) candidates = candidates.filter(item => item.due_date < serverToday);
      const status = url.searchParams.get('status');
      if (status === 'neq.VALIDATED') candidates = candidates.filter(item => item.status !== 'VALIDATED');
      else if (status?.startsWith('eq.')) candidates = candidates.filter(item => item.status === status.slice(3));
      if (url.searchParams.has('due_date')) for (const filter of url.searchParams.getAll('due_date')) candidates = candidates.filter(item => filter.startsWith('gte.') ? item.due_date >= filter.slice(4) : filter.startsWith('lte.') ? item.due_date <= filter.slice(4) : true);
      if (options.unbound) return reply([], 200, 0);
      if (options.pages) { const offset = Number(url.searchParams.get('offset') ?? '0'), limit = Number(url.searchParams.get('limit') ?? '25'); return reply(Array.from({ length: Math.max(0, Math.min(limit, 26 - offset)) }, (_, i) => ({ ...current, id: `${titleId}-${offset + i}`, document: `NF-${offset + i + 1}` })), 200, 26); }
      return reply(candidates, 200, candidates.length);
    }
    if (url.pathname === '/rest/v1/receivable_collection_events') return reply(seen.events);
    if (url.pathname === '/rest/v1/effective_receivable_receipts' || url.pathname === '/rest/v1/receivable_receipts') {
      seen.receiptPaths.push(url.pathname);
      if (url.pathname === '/rest/v1/effective_receivable_receipts' && options.missingReceipts) return reply({ code: options.missingReceipts }, options.missingReceipts === '42501' ? 403 : 404);
      if (options.correctedReceipt) return reply([{ id: 'receipt-adjusted', title_id: titleId, amount_cents: url.pathname === '/rest/v1/effective_receivable_receipts' ? 120000 : 123456, payment_date: '2026-10-17', delay_days: 63, delay_band: '61_90', payment_source: 'IMPORTACAO_DIARIA', validated_at: '2026-10-18T10:00:00Z' }]);
      return reply(seen.receipts);
    }
    if (url.pathname === '/rest/v1/receivable_imports') return reply([], 200, 0);
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1)!;
      seen.writes.push({ name, body });
      if (options.stale) return reply({ code: '40001', message: 'private SQL details and sensitive stack trace' }, 409);
      if (name === 'collection_work_action') { if (body.p_action === 'START') { started.add(body.p_title_id); running.add(body.p_title_id); } else running.delete(body.p_title_id); return reply(timer(body.p_title_id)); }
      if (name === 'save_collection_case' && body.p_finish && !started.has(body.p_title_id)) return reply({ code: '55000' }, 409);
      if (name !== 'save_collection_case' || body.p_finish) title.revision++;
      if (name === 'assign_receivable_collector') { title.collector_id = body.p_collector_id; return reply(2); }
      if (name === 'record_collection_action') {
        title.last_action = body.p_action;
        if (body.p_action === 'PAID') { title.status = 'PENDING_VALIDATION'; title.validation_status = 'PENDING'; title.payment_source = 'COBRANCA'; title.payment_reported_date = body.p_payment_date; title.reported_in_collection = true; }
        seen.events.unshift({ id: 'synthetic-event', action: body.p_action, contact_date: body.p_contact_date, next_action: body.p_next_action, next_date: body.p_next_date, observation: body.p_observation, return_note: body.p_return_note, payment_date: body.p_payment_date, created_at: '2026-10-15T14:00:00Z' });
        return reply('50000000-0000-4000-8000-000000000001');
      }
      if (name === 'save_collection_case') {
        const previous = stateOf(title), next = { status: body.p_status, observation: body.p_observation, next_action: body.p_next_action, next_date: body.p_next_date, revision: previous.revision + 1 };
        caseState.set(title.id, next);
        if (body.p_finish) { title.last_action = body.p_status === 'TÍTULO PAGO' ? 'PAID' : 'CONTACT'; started.delete(title.id); running.delete(title.id); title.next_action_date = body.p_next_date; }
        if (body.p_finish && body.p_status === 'TÍTULO PAGO') { title.status = 'PENDING_VALIDATION'; title.validation_status = 'PENDING'; title.payment_source = 'COBRANCA'; title.payment_reported_date = body.p_payment_date; title.reported_in_collection = true; }
        if (body.p_finish) seen.events.unshift({ id: '50000000-0000-4000-8000-000000000001', title_id: title.id, collector_id: title.collector_id, action: title.last_action,
          contact_date: serverToday, observation: body.p_observation, return_note: null, next_action: body.p_next_action ? 'OTHER' : null,
          next_date: body.p_next_date, payment_date: body.p_payment_date, created_at: `${serverToday}T15:00:00Z` });
        return reply({ title_id: title.id, revision: title.revision, case_revision: next.revision, event_id: body.p_finish ? seen.events[0].id : null, finished: body.p_finish, timer: timer(title.id) });
      }
      if (name === 'validate_receivable_payment_v2') {
        title.status = body.p_decision === 'CONFIRM' ? 'VALIDATED' : 'NOT_LOCATED'; title.validation_status = body.p_decision === 'CONFIRM' ? 'VALIDATED' : 'NONE';
        title.payment_date = body.p_payment_date;
        running.delete(title.id); started.delete(title.id);
        if (body.p_decision === 'NOT_LOCATED') { title.payment_source = null; title.payment_reported_date = null; title.next_action = 'RETRY'; title.next_action_date = serverToday; caseState.set(title.id, { status: 'NOVO TÍTULO - COBRAR', observation: body.p_observation, next_action: 'Retomar cobrança', next_date: serverToday, revision: stateOf(title).revision + 1 }); }
        else seen.receipts.push({ id: '60000000-0000-4000-8000-000000000001', title_id: titleId, amount_cents: body.p_received_cents, payment_date: body.p_payment_date, delay_days: 60, delay_band: '31_60', payment_source: title.payment_source, validated_at: '2026-10-15T15:00:00Z' });
        return reply({ format_version: '053', request_id: body.p_request_id, title_id: titleId, decision: body.p_decision, receipt_id: body.p_decision === 'CONFIRM' ? '60000000-0000-4000-8000-000000000001' : null, payment_date: body.p_payment_date, nominal_cents: title.amount_cents, received_cents: body.p_decision === 'CONFIRM' ? body.p_received_cents : null, adjustment_cents: body.p_decision === 'CONFIRM' ? title.amount_cents - body.p_received_cents : null, adjustment_reason: body.p_adjustment_reason, title_revision: title.revision });
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
async function openCollectionTitles(page: Page) {
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Central operacional da cobrança', exact: true })).toBeVisible();
}
const collectionPanel = (page: Page) => page.getByRole('tabpanel', { name: 'Títulos', exact: true });

test('CR atribui explicitamente todos os títulos não atribuídos do cliente sem presumir vínculo de login', async ({ page }) => {
  const seen = await setup(page, { role: 'contas_receber', unassigned: true }); await openDetail(page);
  await page.getByRole('combobox', { name: 'Cobradora responsável', exact: true }).selectOption(otherAgent); await page.getByLabel('Justificativa da atribuição').fill('Distribuição validada pela gerência');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('todos os títulos ativos ainda sem cobradora'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Confirmar atribuição' }).click();
  await expect(page.getByRole('status')).toContainText('2 título(s) atribuído(s) a Responsável B');
  expect(seen.writes).toEqual([{ name: 'assign_receivable_collector', body: { p_customer_key: 'cnpj:12345678000199', p_collector_id: otherAgent, p_observation: 'Distribuição validada pela gerência' } }]);
});

test('cobradora consulta somente sua carteira e pagamento exige data e confirmação sem validação financeira', async ({ page }) => {
  const seen = await setup(page, { role: 'cobradora_1' }); await openCollectionTitles(page);
  expect(seen.workbenchQueries.length).toBeGreaterThan(0); expect(seen.workbenchQueries.every(query => query.p_collector_id === ownAgent)).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Cobradora', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Abrir título NF-120', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Histórico do título', exact: true })).toBeVisible();
  await expect(page.getByText('Validar pagamento no financeiro', { exact: true })).toHaveCount(0); await expect(page.getByRole('combobox', { name: 'Cobradora responsável', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Finalizar atendimento', exact: true })).toBeDisabled(); expect(seen.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Status do atendimento', exact: true }).selectOption('TÍTULO PAGO');
  await page.getByRole('button', { name: 'Finalizar atendimento', exact: true }).click(); expect(seen.writes.filter(write => write.name === 'save_collection_case')).toHaveLength(0);
  await page.getByLabel(/Data .*pagamento/).fill('2026-10-14'); await page.getByLabel('Observações', { exact: true }).fill('Pagamento informado pelo cliente; aguardando conferência financeira.');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('validação'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Finalizar atendimento', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Validação financeira', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(seen.writes.map(write => write.name)).toEqual(['collection_work_action', 'save_collection_case']); expect(seen.writes[1].body).toMatchObject({ p_title_id: titleId, p_status: 'TÍTULO PAGO', p_payment_date: '2026-10-14', p_expected_revision: 7, p_expected_case_revision: 0, p_finish: true });
  expect(seen.writes.some(write => write.name === 'validate_receivable_payment_v2')).toBe(false);
  await expect(page.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true })).toHaveCount(0); expect(seen.receipts).toHaveLength(0);
  await expect(page.getByRole('tabpanel', { name: 'Validação financeira', exact: true }).getByText('Consulta em leitura.', { exact: false })).toBeVisible();
  await openCollectionTitles(page); await expect(page.getByRole('button', { name: 'Abrir título NF-120', exact: true })).toHaveCount(0);
  await collectionPanel(page).locator('.collection-extra-filters > summary').click(); await page.getByRole('combobox', { name: 'Situação financeira', exact: true }).selectOption('PENDING_VALIDATION');
  await expect(collectionPanel(page).getByRole('table').getByText('Aguardando validação financeira', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
});

test('cobradora sem vínculo recebe orientação e não consulta títulos nem carteiras de outras pessoas', async ({ page }) => {
  const seen = await setup(page, { role: 'cobradora_1', unbound: true });
  await expect(page.getByRole('status')).toContainText('Seu login ainda não está vinculado');
  expect(seen.titleQueries).toHaveLength(0); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Registrar ação', exact: true })).toHaveCount(0);
});

test('recebimento exige data real e confirma financeiramente somente após confirmação explícita', async ({ page }) => {
  const seen = await setup(page, { role: 'contas_receber', pending: true }); await page.getByRole('button', { name: 'Abrir fila de validação' }).click(); await page.getByRole('button', { name: 'Conferir NF-120', exact: true }).click();
  await expect(page.getByLabel('Data real do recebimento', { exact: true })).toBeVisible();
  await page.getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1234,56');
  await page.getByRole('button', { name: 'Confirmar recebimento financeiro' }).click(); expect(seen.writes).toHaveLength(0);
  await page.getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-14');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Confirmar recebimento financeiro' }).click(); expect(seen.writes).toHaveLength(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Confirmar financeiramente'); return dialog.accept(); }); await page.getByRole('button', { name: 'Confirmar recebimento financeiro' }).click();
  await expect(page.getByRole('status')).toContainText('Recebimento validado');
  expect(seen.writes[0]).toEqual({ name: 'validate_receivable_payment_v2', body: { p_title_id: titleId, p_decision: 'CONFIRM', p_payment_date: '2026-10-14', p_received_cents: 123456, p_adjustment_reason: null, p_observation: '', p_expected_revision: 7, p_request_id: expect.any(String) } }); expect(seen.writes[0].body.p_request_id).toMatch(/^[a-f0-9-]{36}$/i);
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click(); await page.getByLabel('Situação do título').selectOption(''); await openDetail(page); await expect(page.locator('.receivable-detail').getByText('Recebimento validado: R$ 1.234,56', { exact: false })).toBeVisible();
});

test('financeiro não localizado exige justificativa, preserva a mesma cobradora e solicita cobrar novamente', async ({ page }) => {
  const seen = await setup(page, { role: 'contas_receber', pending: true }); await openDetail(page); await page.getByRole('button', { name: 'Abrir fila de validação financeira', exact: true }).click(); await page.getByRole('button', { name: 'Conferir NF-120', exact: true }).click();
  await page.getByLabel('Decisão da validação').selectOption('NOT_LOCATED'); await page.getByRole('button', { name: 'Devolver à mesma responsável' }).click(); expect(seen.writes).toHaveLength(0);
  await page.getByLabel('Justificativa / observação da validação').fill('Entrada não encontrada no extrato');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('mesma responsável'); expect(dialog.message()).toContain('Nenhum recebimento ou comissão'); return dialog.accept(); }); await page.getByRole('button', { name: 'Devolver à mesma responsável' }).click();
  await expect(page.getByRole('status')).toContainText('Título devolvido à mesma responsável');
  expect(seen.writes[0].body).toEqual({ p_title_id: titleId, p_decision: 'NOT_LOCATED', p_payment_date: null, p_received_cents: null, p_adjustment_reason: null, p_observation: 'Entrada não encontrada no extrato', p_expected_revision: 7, p_request_id: expect.any(String) });
  expect(seen.writes[0].body).not.toHaveProperty('p_collector_id'); await page.getByRole('tab', { name: 'Títulos', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Responsável A', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: 'Cobrar novamente 18/10/2026', exact: true })).toBeVisible(); expect(seen.receipts).toHaveLength(0);
});

test('título alterado concorrentemente exige atualização sem expor erro técnico nem indicar sucesso', async ({ page }) => {
  const seen = await setup(page, { role: 'contas_receber', pending: true, stale: true }); await openDetail(page); await page.getByRole('button', { name: 'Abrir fila de validação financeira', exact: true }).click(); await page.getByRole('button', { name: 'Conferir NF-120', exact: true }).click(); await page.getByLabel('Data real do recebimento', { exact: true }).fill('2026-10-14'); await page.getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill('1234,56');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar recebimento financeiro' }).click();
  await expect(page.getByRole('alert')).toContainText('Este título mudou'); await expect(page.getByText('private SQL details', { exact: false })).toHaveCount(0); expect(seen.receipts).toHaveLength(0); await expect(page.getByRole('button', { name: 'Confirmar recebimento financeiro' })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Atualizar fila', exact: true })).toBeEnabled(); expect(seen.writes).toHaveLength(1);
});

test('diretor consulta CR, carteiras e histórico sem ações de escrita', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor', pending: true }); await openDetail(page);
  await expect(page.getByText('Validar pagamento no financeiro', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Ir para Importar Bases' })).toHaveCount(0); await expect(page.getByRole('combobox', { name: 'Cobradora responsável', exact: true })).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true }).click(); await openCollectionTitles(page);
  await collectionPanel(page).locator('.collection-extra-filters > summary').click(); await page.getByRole('combobox', { name: 'Situação financeira', exact: true }).selectOption('PENDING_VALIDATION');
  await page.getByRole('button', { name: 'Abrir título NF-120', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Histórico do título', exact: true })).toBeVisible();
  for (const name of ['Iniciar', 'Pausar', 'Salvar andamento', 'Finalizar atendimento']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByText('Registrar ação de cobrança', { exact: true })).toHaveCount(0); expect(seen.writes).toHaveLength(0);
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

for (const role of ['gerente_geral', 'diretor', 'cobradora_1'] as const) {
  test(`${role}: Cobrança mostra apenas vencidos por São Paulo e CR conserva títulos de hoje e futuros`, async ({ page }) => {
    // Em UTC já é dia 18; em São Paulo ainda é dia 17.
    await page.clock.install({ time: new Date('2026-10-18T02:30:00Z') });
    const seen = await setup(page, { role, dates: true, pending: true, serverToday: '2026-10-17' });
    if (role !== 'cobradora_1') {
      await expect(page.getByRole('table').getByText('Documento / NF: NF-VENCIDO', { exact: true })).toBeVisible();
      await expect(page.getByRole('table').getByText('Documento / NF: NF-HOJE', { exact: true })).toBeVisible();
      await expect(page.getByRole('table').getByText('Documento / NF: NF-FUTURO', { exact: true })).toBeVisible();
      await page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true }).click();
    }
    await openCollectionTitles(page);
    await expect(collectionPanel(page).getByRole('table').getByText('NF-VENCIDO', { exact: true })).toBeVisible();
    await expect(collectionPanel(page).getByRole('table').getByText('NF-HOJE', { exact: true })).toHaveCount(0);
    await expect(collectionPanel(page).getByRole('table').getByText('NF-FUTURO', { exact: true })).toHaveCount(0);
    await expect(collectionPanel(page).getByRole('table').getByText('NF-PAGO', { exact: true })).toHaveCount(0);
    await collectionPanel(page).locator('summary').filter({ hasText: 'Vencimentos e situação financeira' }).click();
    await expect(page.getByRole('combobox', { name: 'Situação financeira', exact: true })).toHaveValue('ACTIVE');
    await expect(page.getByRole('option', { name: 'Vencidos em aberto', exact: true })).toHaveCount(1);
    await expect(page.getByLabel('Vencimento final', { exact: true })).toHaveAttribute('max', '2026-10-16');
    const collectionStart = seen.titlePaths.length, workbenchStart = seen.workbenchQueries.length;
    await page.getByRole('combobox', { name: 'Situação financeira', exact: true }).selectOption('');
    await expect(collectionPanel(page).getByRole('table').getByText('NF-PAGO', { exact: true })).toBeVisible();
    await expect(collectionPanel(page).getByRole('table').getByText('NF-HOJE', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Limpar filtros' }).click();
    await expect(page.getByRole('combobox', { name: 'Situação financeira', exact: true, includeHidden: true })).toHaveValue('ACTIVE');
    await expect(collectionPanel(page).getByRole('table').getByText('NF-PAGO', { exact: true })).toHaveCount(0);
    await expect(collectionPanel(page).getByRole('table').getByText('NF-PENDENTE', { exact: true })).toHaveCount(0);
    await expect(collectionPanel(page).getByRole('table').getByText('Aguardando validação financeira', { exact: true })).toHaveCount(0);
    expect(seen.workbenchQueries.length).toBeGreaterThan(workbenchStart);
    expect(seen.titlePaths.slice(collectionStart)).toHaveLength(0);
    expect(seen.workbenchQueries.every(query => role !== 'cobradora_1' || query.p_collector_id === ownAgent)).toBe(true);
    expect(seen.writes).toHaveLength(0);
  });
}

test('a carteira usa a nova data oficial após a meia-noite de São Paulo', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-18T03:30:00Z') });
  await setup(page, { role: 'cobradora_1', dates: true, serverToday: '2026-10-18' });
  await openCollectionTitles(page);
  await expect(collectionPanel(page).getByRole('table').getByText('NF-VENCIDO', { exact: true })).toBeVisible();
  await expect(collectionPanel(page).getByRole('table').getByText('NF-HOJE', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Vencimento final', { exact: true })).toHaveAttribute('max', '2026-10-17');
});

for (const code of ['PGRST205', '42P01'] as const) {
  test(`Cobrança sem atualização (${code}) orienta ativação e não consulta a base sem restrição`, async ({ page }) => {
    const seen = await setup(page, { role: 'diretor', missingCollection: code });
    await expect(page.getByRole('button', { name: 'Detalhar título NF-120 de Cliente sintético da carteira', exact: true })).toBeVisible();
    const previous = seen.titlePaths.length;
    await page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true }).click();
    await openCollectionTitles(page); const error = collectionPanel(page).getByRole('alert');
    await expect(error).toContainText('A central operacional da Cobrança precisa da atualização do banco');
    await expect(error).not.toContainText('private relation');
    await expect(page.getByRole('button', { name: 'Baixar CSV dos filtros' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Abrir título / })).toHaveCount(0);
    await page.getByRole('button', { name: 'Atualizar títulos' }).click();
    await expect(error).toBeVisible();
    expect(seen.workbenchQueries.length).toBeGreaterThan(0);
    expect(seen.titlePaths.slice(previous)).toHaveLength(0);
    expect(seen.writes).toHaveLength(0);
  });
}

test('ações ficam indisponíveis se um retorno desatualizado contiver vencimento de hoje ou futuro', async ({ page }) => {
  const seen = await setup(page, { role: 'cobradora_1', dates: true, malformedCollection: true }); await openCollectionTitles(page);
  await expect(collectionPanel(page).getByRole('alert')).toBeVisible();
  for (const document of ['NF-HOJE', 'NF-FUTURO']) await expect(page.getByRole('button', { name: `Abrir título ${document}`, exact: true })).toHaveCount(0);
  for (const name of ['Iniciar', 'Pausar', 'Salvar andamento', 'Finalizar atendimento']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByText('Registrar ação de cobrança', { exact: true })).toHaveCount(0); expect(seen.writes).toHaveLength(0);
});

test('CSV da Cobrança usa a visão de vencidos em todas as páginas e nas duas verificações da base', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor', pages: true });
  await page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true }).click();
  await openCollectionTitles(page); await expect(page.getByRole('button', { name: /^Abrir título / })).toHaveCount(25);
  const before = seen.titlePaths.length, queriesBefore = seen.workbenchQueries.length;
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar CSV dos filtros' }).click();
  const download = await pending, path = await download.path(); expect(path).not.toBeNull();
  expect(await readFile(path!, 'utf8')).toContain('"NF-26"');
  expect(seen.exportSnapshots).toBe(2);
  expect(seen.titlePaths.slice(before)).toHaveLength(0);
  expect(seen.workbenchQueries.slice(queriesBefore).filter(query => query.p_limit === 1)).toHaveLength(2);
  expect(seen.workbenchQueries.slice(queriesBefore).some(query => query.p_limit === 500 && query.p_queue === 'active')).toBe(true);
});

test('detalhe mostra recebimento efetivo corrigido e não consulta o valor antigo', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor', correctedReceipt: true }); await openDetail(page);
  await expect(page.getByText('Recebimento validado: R$ 1.200,00', { exact: false })).toBeVisible();
  expect(seen.receiptPaths).toEqual(['/rest/v1/effective_receivable_receipts']);
});
for (const code of ['PGRST205', '42P01'] as const) {
  test(`banco anterior à visão efetiva (${code}) preserva consulta do histórico legado`, async ({ page }) => {
    const seen = await setup(page, { role: 'diretor', correctedReceipt: true, missingReceipts: code }); await openDetail(page);
    await expect(page.getByText('Recebimento validado: R$ 1.234,56', { exact: false })).toBeVisible();
    expect(seen.receiptPaths).toEqual(['/rest/v1/effective_receivable_receipts', '/rest/v1/receivable_receipts']);
  });
}
test('permissão negada na visão efetiva não tenta consultar o histórico antigo', async ({ page }) => {
  const seen = await setup(page, { role: 'diretor', missingReceipts: '42501' }); await openDetail(page);
  await expect(page.getByRole('alert')).toContainText('Seu perfil não tem permissão');
  expect(seen.receiptPaths).toEqual(['/rest/v1/effective_receivable_receipts']);
});
