import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = '2026-10-18T15:00:00.000Z', today = '2026-10-18';
const id = (n: number) => `98000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = id(20), other = id(21), customerKey = 'name:ORGAO SINTETICO';
const workflow = { version: '029', normal_pause: true, finish_requires_started: true, pending_read_only: true, returns_priority: true };
type Options = { director?: boolean; manager?: boolean; empty?: boolean; variants?: boolean; partial?: boolean; missingContext?: boolean; missingReport?: boolean; unknown?: boolean; stale?: boolean; large?: boolean; staleExport?: boolean; wrongReportScope?: boolean };

async function setup(page: Page, options: Options = {}) {
  await page.clock.install({ time: new Date(now) }); await page.clock.pauseAt(new Date('2026-10-18T15:00:01Z'));
  const collector = !options.director && !options.manager;
  const access = { profile: { id: id(1), username: 'TesteContatos', display_name: 'Responsável sintética', role_key: options.director ? 'diretor' : options.manager ? 'gerente_geral' : 'cobradora_1', enabled: true }, collector_id: collector ? own : null,
    permissions: [{ resource: 'cobranca', action: 'read' }, ...(!options.director ? [{ resource: 'cobranca', action: 'write' }] : []), ...(!collector ? [{ resource: 'contas_receber', action: 'read' }] : []), ...(options.manager ? [{ resource: 'contas_receber', action: 'write' }] : [])] };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id(1), session_id: id(2), exp: Date.parse(now) / 1000 + 86400, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const make = (n: number, changes: Record<string, unknown> = {}) => ({ id: id(100 + n), customer_key: customerKey, document: `NF-C${n}`, client_name: 'Órgão sintético', client_document: null, branch: n === 1 ? 'Filial A' : 'Filial B', due_date: '2026-10-08', amount_cents: 10000 + n, collector_id: own as string | null, collector_name: 'Responsável sintética', status: 'OPEN', validation_status: 'NONE', payment_source: null, payment_reported_date: null, revision: 1, operational_status: 'NOVO TÍTULO - COBRAR', case_revision: 0, observation: null as string | null, next_action_text: null as string | null, next_date: null as string | null, delay_days: 10, total_work_seconds: 0, ...changes });
  const rows = [make(1), make(2), make(3, { customer_key: 'name:OUTRO ORGAO', client_name: 'Outro órgão reservado', collector_id: other, collector_name: 'Outra responsável' }), make(4, { due_date: today, delay_days: 0 }), make(5, { due_date: '2026-11-01', delay_days: 0 }), make(6, { status: 'VALIDATED', validation_status: 'CONFIRMED' })];
  const state = { contact: { emails: options.empty ? [] : ['financeiro@orgao.test', 'diretoria@orgao.test'], phones: options.empty ? [] : ['(11) 3333-4444', '(11) 3333-5555 ramal 12'], notes: null as string | null, revision: 'opaque-contact-0', record_revision: 0, manually_edited: false, reviewed_at: null as string | null, reviewed_by: null as string | null, reviewed_by_name: null as string | null, updated_at: null as string | null, updated_by: null as string | null, updated_by_name: null as string | null }, unknown: !!options.unknown, stale: !!options.stale, running: false, started: new Set<string>(), replies: new Map<string, any>(), events: [] as any[], reportRevision: 'contacts-fence-0', reportReads: 0, advanced: false };
  const calls: { name: string; body: any; method: string; query: string }[] = [];
  const active = () => rows.filter(row => row.due_date < today && ['NEW', 'OPEN', 'NOT_LOCATED'].includes(row.status) && (!collector || row.collector_id === own));
  const priority = (collector_id: string | null) => ({ collector_id, due_count: 0, total_cents: 0, next_title_id: null, next_due_date: null });
  const timer = (row: typeof rows[number]) => ({ title_id: row.id, running: state.running && row.id === rows[0].id, session_id: state.running && row.id === rows[0].id ? id(500) : null, started_at: state.running && row.id === rows[0].id ? now : null, elapsed_seconds: 0, total_seconds: 0, actor_total_seconds: 0, server_now: now, recovery_allowed: false });
  const listed = (row: typeof rows[number]) => { const block = options.director ? 'READ_ONLY' : row.status === 'VALIDATED' ? 'SETTLED' : row.status === 'PENDING_VALIDATION' ? 'PENDING_VALIDATION' : !row.collector_id ? 'UNASSIGNED' : state.running ? 'ALREADY_RUNNING' : null; return { ...row, current_timer: timer(row), return_due: false, return_due_date: null, can_start: block === null, start_block_reason: block }; };
  function context(row: typeof rows[number]) { return { title_id: row.id, customer_key: row.customer_key, client_name: row.client_name, client_document: null, can_edit: !options.director, can_review: !options.director, contact: structuredClone(state.contact), descriptions: { state: options.variants ? 'PENDING_VARIANTS' : 'AVAILABLE', count: options.partial ? 3 : options.variants ? 2 : 1, variants: [{ id: id(600), description: 'Serviço original de higienização sintética', contract: 'Contrato sintético A', source_import_id: id(700), imported_at: now }, ...(options.variants ? [{ id: id(601), description: 'Serviço alternativo de manutenção sintética', contract: 'Contrato sintético B', source_import_id: id(701), imported_at: '2026-10-17T15:00:00.000Z' }] : [])] }, as_of_date: today, server_now: now }; }
  function contactRows() {
    const result = [{ customer_key: customerKey, client_name: 'Órgão sintético', client_document: null, ...structuredClone(state.contact), collector_ids: [options.wrongReportScope ? other : own], title_count: 2, overdue_cents: 20003 }];
    if (options.large) for (let n = 1; n <= 502; n++) result.push({ ...result[0], customer_key: `name:ORG-${n}`, client_name: n === 502 ? '=formula sintética final' : `Órgão fictício ${String(n).padStart(3, '0')}`, emails: [`org${n}@synthetic.test`], phones: [], title_count: 1, overdue_cents: 100 });
    if (!collector) result.push({ ...result[0], customer_key: 'name:OUTRO ORGAO', client_name: 'Outro órgão reservado', collector_ids: [other] });
    return result;
  }
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON(); calls.push({ name, body, method: request.method(), query: url.search });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 86400, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: id(1), aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: now, app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (['collections_overdue_summary', 'receivables_management_summary', 'collection_work_summary'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'collection_agents') return reply([{ id: own, display_name: 'Responsável sintética', enabled: true }, ...(!collector ? [{ id: other, display_name: 'Outra responsável', enabled: true }] : [])]);
    if (name === 'collection_workbench') {
      let visible = rows.filter(row => row.due_date < today && (!collector || row.collector_id === own));
      if ((body.p_queue ?? 'active') === 'active') visible = active(); else if (body.p_queue === 'history') visible = visible.filter(row => row.status === 'VALIDATED'); else if (body.p_queue === 'returns') visible = [];
      if (body.p_financial_status && body.p_financial_status !== 'ACTIVE') visible = visible.filter(row => row.status === body.p_financial_status);
      return reply({ as_of_date: today, server_now: now, count: visible.length, total_cents: visible.reduce((sum, row) => sum + row.amount_cents, 0), snapshot_revision: 'financial-fence', active_timer: state.running ? timer(rows[0]) : null, rows: visible.slice(body.p_offset, body.p_offset + body.p_limit).map(listed), workflow, priority: priority(collector ? own : body.p_collector_id ?? null) });
    }
    if (name === 'collection_case_detail') {
      const row = rows.find(row => row.id === body.p_title_id && row.due_date < today && (!collector || row.collector_id === own));
      return row ? reply({ title: listed(row), case: { status: row.operational_status, observation: row.observation, next_action: row.next_action_text, next_date: row.next_date, payment_date: null, revision: row.case_revision, updated_at: now, updated_by: id(1), finalized_at: null }, timer: timer(row), history: [], case_history: [], work_sessions: [], workflow: { ...workflow, started: state.started.has(row.id), can_finish: !options.director && row.status === 'OPEN' && state.started.has(row.id), recovery_allowed: false }, priority: priority(row.collector_id) }) : reply({ code: '42501' }, 403);
    }
    if (name === 'collection_customer_context') {
      if (options.missingContext) return reply({ code: 'PGRST202', message: 'private implementation detail' }, 404);
      const row = active().find(row => row.id === body.p_title_id); return row ? reply(context(row)) : reply({ code: '42501' }, 403);
    }
    if (name === 'save_collection_customer_contacts') {
      const row = active().find(row => row.id === body.p_title_id);
      if (!row || options.director) return reply({ code: '42501' }, 403);
      if (state.replies.has(body.p_request_id)) return reply(state.replies.get(body.p_request_id));
      if (state.stale) { state.stale = false; state.contact.emails = ['outro-editor@orgao.test']; state.contact.notes = 'Alteração da outra pessoa'; state.contact.record_revision++; state.contact.revision = 'opaque-contact-other'; return reply({ code: '40001', message: 'sensitive SQL' }, 409); }
      if (body.p_expected_revision !== state.contact.revision) return reply({ code: '40001' }, 409);
      const before = structuredClone(state.contact);
      state.contact = { ...state.contact, emails: [...new Set((body.p_emails as string[]).map(value => value.trim().toLowerCase()))], phones: [...new Set((body.p_phones as string[]).map(value => value.trim()))], notes: body.p_notes.trim() || null, record_revision: state.contact.record_revision + 1, revision: `opaque-contact-${state.contact.record_revision + 1}`, manually_edited: true, reviewed_at: now, reviewed_by: id(1), reviewed_by_name: 'Responsável sintética', updated_at: now, updated_by: id(1), updated_by_name: 'Responsável sintética' };
      state.reportRevision = `contacts-fence-${state.contact.record_revision}`;
      state.events.push({ event_id: id(800 + state.events.length), customer_key: row.customer_key, client_name: row.client_name, client_document: null, created_at: now, created_by: id(1), created_by_name: 'Responsável sintética', action: 'MANUAL_SAVE', before: { emails: before.emails, phones: before.phones, notes: before.notes, revision: before.record_revision }, after: { emails: state.contact.emails, phones: state.contact.phones, notes: state.contact.notes, revision: state.contact.record_revision } });
      const response = context(row); state.replies.set(body.p_request_id, response);
      if (state.unknown) { state.unknown = false; return route.abort('failed'); }
      return reply(response);
    }
    if (name === 'collection_customer_contact_report') {
      if (options.missingReport) return reply({ code: 'PGRST202' }, 404);
      state.reportReads++;
      if (body.p_expected_revision && (body.p_expected_revision !== state.reportRevision || options.staleExport && body.p_offset >= 500)) return reply({ code: '40001' }, 409);
      let result: any[] = body.p_view === 'changes' ? [...state.events] : contactRows();
      if (body.p_search) result = result.filter(row => row.client_name.toLowerCase().includes(body.p_search.toLowerCase()));
      if (body.p_view === 'coverage') result = result.filter(row => body.p_coverage === 'MISSING_EMAIL' ? !row.emails.length : body.p_coverage === 'MISSING_PHONE' ? !row.phones.length : body.p_coverage === 'MISSING_CONTACT' ? !row.emails.length && !row.phones.length : body.p_coverage === 'WITH_CONTACT' ? row.emails.length || row.phones.length : body.p_coverage === 'REVIEWED' ? !!row.reviewed_at : body.p_coverage === 'NOT_REVIEWED' ? !row.reviewed_at : true);
      if (body.p_changed_start) result = result.filter(row => (row.created_at ?? row.updated_at ?? '').slice(0, 10) >= body.p_changed_start);
      if (body.p_changed_end) result = result.filter(row => (row.created_at ?? row.updated_at ?? '').slice(0, 10) <= body.p_changed_end);
      const scoped = contactRows();
      return reply({ as_of_date: today, server_now: now, snapshot_revision: state.reportRevision, count: result.length, scope_count: scoped.length, with_contact_count: scoped.filter(row => row.emails.length || row.phones.length).length, reviewed_count: scoped.filter(row => row.reviewed_at).length, rows: result.slice(body.p_offset, body.p_offset + body.p_limit) });
    }
    if (name === 'collection_work_action') { state.running = body.p_action === 'START'; if (body.p_action === 'START') state.started.add(body.p_title_id); return reply(timer(rows[0])); }
    if (name === 'save_collection_case') {
      const row = rows.find(row => row.id === body.p_title_id)!; row.operational_status = body.p_status; row.observation = body.p_observation; row.next_action_text = body.p_next_action; row.next_date = body.p_next_date; row.case_revision++;
      return reply({ title_id: row.id, revision: row.revision, case_revision: row.case_revision, event_id: body.p_finish ? id(900) : null, finished: !!body.p_finish, timer: timer(row) });
    }
    if (['collection_overdue_titles', 'receivable_titles', 'receivable_collection_events', 'effective_receivable_receipts', 'receivable_receipts', 'receivable_imports'].includes(name)) return reply([], 200, 0);
    throw new Error(`Unexpected offline contacts request: ${request.method()} ${url.pathname}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('TesteContatos'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: /Sair/ })).toBeVisible(); await page.getByRole('navigation').getByRole('button', { name: 'Cobrança', exact: true }).click(); await page.getByRole('tab', { name: 'Títulos', exact: true }).click();
  return { calls, rows, state };
}
const sidebar = (page: Page) => page.getByRole('region', { name: 'Atendimento do título', exact: true });
const contextPanel = (page: Page) => page.locator('.collection-customer-context');
const report = (page: Page) => page.getByRole('region', { name: 'Relatório de contatos', exact: true });
const contactWrites = (calls: { name: string; body: any }[]) => calls.filter(call => call.name === 'save_collection_customer_contacts');
const financialWrites = (calls: { name: string }[]) => calls.filter(call => ['validate_receivable_payment', 'set_receivable_payment_date', 'record_collection_action', 'save_collection_case'].includes(call.name));
async function open(page: Page, document = 'NF-C1') { await page.getByRole('button', { name: `Abrir título ${document}`, exact: true }).click(); await expect(sidebar(page)).toContainText(document); }
async function expand(page: Page) { await contextPanel(page).locator('summary').click(); }
async function contactTab(page: Page) { await page.getByRole('tab', { name: 'Contatos', exact: true }).click(); await expect(report(page)).toBeVisible(); }

// Everything below uses synthetic RPC responses. No request reaches a real database.
test('contexto compacto mostra múltiplos contatos e variantes sem escolher descrição nem inferir WhatsApp', async ({ page }) => {
  const seen = await setup(page, { variants: true, partial: true }); await open(page);
  await expect(contextPanel(page)).not.toHaveAttribute('open', ''); await expect(page.getByText('Serviço original de higienização sintética', { exact: true })).not.toBeVisible();
  await expand(page); await expect(contextPanel(page).getByRole('heading', { name: 'Conferir descrição', exact: true })).toBeVisible();
  await expect(contextPanel(page)).toContainText('Serviço original de higienização sintética'); await expect(contextPanel(page)).toContainText('Serviço alternativo de manutenção sintética');
  await expect(contextPanel(page)).toContainText('Exibindo 2 de 3 variantes'); await expect(contextPanel(page)).toContainText('Contrato sintético A'); await expect(contextPanel(page)).toContainText('Contrato sintético B');
  await expect(contextPanel(page).getByRole('link', { name: 'financeiro@orgao.test', exact: true })).toHaveAttribute('href', 'mailto:financeiro%40orgao.test');
  await expect(contextPanel(page).getByRole('link', { name: '(11) 3333-4444', exact: true })).toHaveAttribute('href', 'tel:1133334444');
  await expect(contextPanel(page).getByRole('link', { name: /ramal/ })).toHaveCount(0); await expect(contextPanel(page).locator('a[href*="wa.me"],a[href*="whatsapp"]')).toHaveCount(0);
  expect(contactWrites(seen.calls)).toHaveLength(0); expect(financialWrites(seen.calls)).toHaveLength(0);
});

test('salvar múltiplos canais confirma revisão e preserva andamento, valores e revisões financeiras', async ({ page }) => {
  const seen = await setup(page); await open(page); await expand(page); const before = structuredClone(seen.rows);
  await sidebar(page).getByRole('textbox', { name: 'Observações', exact: true }).fill('Rascunho do atendimento separado dos contatos');
  await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill('CONTATO@ORGAO.TEST\nsegundo@orgao.test'); await page.getByRole('textbox', { name: 'Telefones do órgão', exact: true }).fill('(21) 3333-4444\n(21) 3333-5555 ramal 123'); await page.getByRole('textbox', { name: 'Observações dos contatos do órgão', exact: true }).fill('Ligar para financeiro pela manhã');
  await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click(); await expect(contextPanel(page).getByRole('status')).toContainText('revisão registrada');
  expect(contactWrites(seen.calls)).toHaveLength(1); expect(contactWrites(seen.calls)[0].body).toMatchObject({ p_title_id: id(101), p_emails: ['CONTATO@ORGAO.TEST', 'segundo@orgao.test'], p_phones: ['(21) 3333-4444', '(21) 3333-5555 ramal 123'], p_notes: 'Ligar para financeiro pela manhã', p_expected_revision: 'opaque-contact-0' });
  expect(contactWrites(seen.calls)[0].body.p_request_id).toMatch(/^[0-9a-f-]{36}$/i); expect(seen.rows).toEqual(before); expect(financialWrites(seen.calls)).toHaveLength(0);
  await expect(sidebar(page).getByRole('textbox', { name: 'Observações', exact: true })).toHaveValue('Rascunho do atendimento separado dos contatos'); await expect(contextPanel(page)).toContainText('Responsável sintética');
});

test('contato vazio pode ser revisado e limpo explicitamente e permanece compartilhado entre duas notas e filiais', async ({ page }) => {
  const seen = await setup(page, { empty: true }); await open(page); await expand(page); await expect(contextPanel(page)).toContainText('E-mail não informado.'); await expect(contextPanel(page)).toContainText('Telefone não informado.');
  await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click(); await expect(contextPanel(page)).toContainText('Revisado com pendências'); expect(contactWrites(seen.calls)[0].body).toMatchObject({ p_emails: [], p_phones: [], p_notes: '' });
  await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill('novo@orgao.test'); await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click(); await expect(contextPanel(page).getByRole('status')).toContainText('revisão registrada'); await expect.poll(() => seen.state.contact.record_revision).toBe(2);
  await open(page, 'NF-C2'); await expand(page); await expect(page.getByRole('textbox', { name: 'E-mails do órgão', exact: true })).toHaveValue('novo@orgao.test');
  await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill(''); await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click(); await expect(contextPanel(page)).toContainText('Revisado com pendências'); await expect.poll(() => seen.state.contact.emails).toEqual([]); expect(seen.state.contact.manually_edited).toBe(true); expect(contactWrites(seen.calls).at(-1)?.body.p_title_id).toBe(id(102));
});

test('diretoria consulta contatos e descrições sem controles de escrita', async ({ page }) => {
  const seen = await setup(page, { director: true }); await open(page); await expand(page); await expect(contextPanel(page)).toContainText('Contatos em leitura.');
  await expect(contextPanel(page).getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true })).toHaveCount(0); await expect(contextPanel(page).getByRole('textbox')).toHaveCount(0);
  await expect(contextPanel(page)).toContainText('Serviço original de higienização sintética'); await contactTab(page); await expect(report(page)).toContainText('Outro órgão reservado'); expect(contactWrites(seen.calls)).toHaveLength(0);
});

test('cobradora só consulta órgãos vencidos ativos da carteira e quitados não recebem contexto', async ({ page }) => {
  const seen = await setup(page); await expect(page.getByRole('button', { name: /^Abrir título NF-C/ })).toHaveCount(2); await open(page); await expand(page); await contactTab(page); await expect(report(page)).not.toContainText('Outro órgão reservado');
  expect(seen.calls.filter(call => call.name === 'collection_customer_contact_report').every(call => call.body.p_collector_id === own)).toBe(true);
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click(); await page.locator('.collection-extra-filters > summary').click(); await page.getByRole('combobox', { name: 'Situação financeira', exact: true }).selectOption('VALIDATED'); await open(page, 'NF-C6'); await expect(contextPanel(page)).toHaveCount(0);
  expect(seen.calls.filter(call => call.name === 'collection_customer_context').map(call => call.body.p_title_id)).toEqual([id(101)]);
});

test('rascunho dos contatos sobrevive às abas, avisa ao sair e cancelar troca ou finalização o preserva', async ({ page }) => {
  const seen = await setup(page); await open(page); await expand(page); await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill('rascunho@orgao.test');
  await contactTab(page); await page.getByRole('tab', { name: 'Títulos', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'E-mails do órgão', exact: true })).toHaveValue('rascunho@orgao.test');
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('contatos'); await dialog.dismiss(); }); await page.getByRole('button', { name: 'Abrir título NF-C2', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'E-mails do órgão', exact: true })).toHaveValue('rascunho@orgao.test');
  await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
  await sidebar(page).getByRole('textbox', { name: 'Observações', exact: true }).fill('Atendimento correto'); await sidebar(page).getByLabel('Próxima ação', { exact: true }).fill('Retornar'); await page.getByLabel('Data da próxima ação', { exact: true }).fill('2026-10-20');
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('contatos'); await dialog.dismiss(); }); await sidebar(page).getByRole('button', { name: 'Finalizar atendimento', exact: true }).click(); expect(financialWrites(seen.calls)).toHaveLength(0); await expect(page.getByRole('textbox', { name: 'E-mails do órgão', exact: true })).toHaveValue('rascunho@orgao.test');
});

test('conflito preserva rascunho e exige consultar a versão atual antes de escolher e salvar outra revisão', async ({ page }) => {
  const seen = await setup(page, { stale: true }); await open(page); await expand(page); await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill('meu-rascunho@orgao.test');
  await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click(); await expect(contextPanel(page).getByRole('alert')).toContainText('Seu rascunho foi preservado');
  await expect(page.getByRole('button', { name: 'Manter meu rascunho após conferência', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Conferir versão atual dos contatos', exact: true }).click(); await expect(contextPanel(page)).toContainText('outro-editor@orgao.test'); await expect(page.getByRole('button', { name: 'Manter meu rascunho após conferência', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Manter meu rascunho após conferência', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'E-mails do órgão', exact: true })).toHaveValue('meu-rascunho@orgao.test'); await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click();
  await expect(contextPanel(page).getByRole('status')).toContainText('revisão registrada'); expect(contactWrites(seen.calls).map(call => call.body.p_expected_revision)).toEqual(['opaque-contact-0', 'opaque-contact-other']); expect(seen.state.contact.emails).toEqual(['meu-rascunho@orgao.test']);
});

test('resposta incerta congela o UUID exato, preserva abas e bloqueia troca sem bloquear pausa do cronômetro', async ({ page }) => {
  const seen = await setup(page, { unknown: true }); await open(page); await expand(page); await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill('incerto@orgao.test'); await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click(); await expect(page.getByRole('button', { name: 'Repetir confirmação dos contatos', exact: true })).toBeEnabled(); await expect(page.getByRole('textbox', { name: 'E-mails do órgão', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Abrir título NF-C2', exact: true })).toBeDisabled(); await expect(sidebar(page)).toContainText('NF-C1');
  await contactTab(page); await page.getByRole('tab', { name: 'Títulos', exact: true }).click(); await expect(page.getByRole('button', { name: 'Repetir confirmação dos contatos', exact: true })).toBeEnabled();
  await sidebar(page).getByRole('button', { name: 'Pausar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Iniciar', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Abrir título NF-C2', exact: true }).click(); await expect(sidebar(page)).toContainText('Resolva a confirmação dos contatos'); await expect(sidebar(page)).toContainText('NF-C1');
  await page.getByRole('button', { name: 'Repetir confirmação dos contatos', exact: true }).click();
  await expect(contextPanel(page).getByRole('status')).toContainText('revisão registrada'); expect(contactWrites(seen.calls)).toHaveLength(2); expect(contactWrites(seen.calls)[1].body).toEqual(contactWrites(seen.calls)[0].body); expect(seen.state.contact.record_revision).toBe(1); expect(seen.state.events).toHaveLength(1); expect(seen.calls.filter(call => call.name === 'collection_work_action').map(call => call.body.p_action)).toEqual(['START', 'PAUSE']);
});

test('atualização que quita título oculta contexto e mantém aviso de rascunho sem exibir dados fora da carteira', async ({ page }) => {
  const seen = await setup(page); await open(page); await expand(page); await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill('rascunho-reservado@orgao.test'); seen.rows[0].status = 'VALIDATED'; seen.rows[0].revision++;
  await sidebar(page).getByRole('button', { name: 'Atualizar detalhe', exact: true }).click(); await expect(sidebar(page)).toContainText('O rascunho dos contatos foi preservado'); await expect(contextPanel(page)).toHaveCount(0); await expect(sidebar(page)).not.toContainText('financeiro@orgao.test'); await expect(sidebar(page)).not.toContainText('Serviço original de higienização sintética');
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true); expect(contactWrites(seen.calls)).toHaveLength(0);
});

test('banco anterior mantém atendimento funcionando e mostra ativação de contatos sem erro técnico', async ({ page }) => {
  const seen = await setup(page, { missingContext: true, missingReport: true }); await open(page); await expand(page); await expect(contextPanel(page)).toContainText('Contatos e descrições aguardam a atualização do banco'); await expect(contextPanel(page)).not.toContainText('private implementation detail');
  await sidebar(page).getByRole('button', { name: 'Iniciar', exact: true }).click(); await expect(sidebar(page).getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
  await contactTab(page); await expect(report(page).getByRole('alert')).toContainText('atualização do banco'); await expect(report(page)).toContainText('Não disponível'); expect(contactWrites(seen.calls)).toHaveLength(0);
});

test('formato inválido não envia contatos, enquanto telefone com ramal permanece permitido', async ({ page }) => {
  const seen = await setup(page); await open(page); await expand(page); await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill('sem-arroba'); await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click(); await expect(contextPanel(page).getByRole('alert')).toContainText('Confira os formatos'); expect(contactWrites(seen.calls)).toHaveLength(0);
  await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill('valido@orgao.test'); await page.getByRole('textbox', { name: 'Telefones do órgão', exact: true }).fill('(11) 3333-4444 ramal 123'); await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click(); await expect(contextPanel(page).getByRole('status')).toContainText('revisão registrada'); expect(contactWrites(seen.calls)[0].body.p_phones).toEqual(['(11) 3333-4444 ramal 123']);
});

test('relatório aplica nome, lacunas e período oficiais sem consultar cadastro global de perfis', async ({ page }) => {
  const seen = await setup(page, { empty: true }); await contactTab(page); await page.getByLabel('Nome do órgão / cliente', { exact: true }).fill('Órgão sintético'); await page.getByRole('combobox', { name: /^Cobertura dos contatos/ }).selectOption('MISSING_EMAIL'); await page.getByLabel('Alterações a partir de', { exact: true }).fill('2026-10-01'); await page.getByLabel('Alterações até', { exact: true }).fill('2026-10-18'); await page.getByRole('button', { name: 'Consultar contatos', exact: true }).click();
  await expect.poll(() => seen.calls.filter(call => call.name === 'collection_customer_contact_report').at(-1)?.body).toMatchObject({ p_search: 'Órgão sintético', p_collector_id: own, p_coverage: 'MISSING_EMAIL', p_changed_start: '2026-10-01', p_changed_end: '2026-10-18', p_changed_by: null, p_offset: 0, p_limit: 25, p_view: 'coverage' });
  await page.getByRole('button', { name: 'Limpar filtros de contatos', exact: true }).click(); await expect(report(page)).toContainText('Não informado'); expect(seen.calls.some(call => ['access_profiles', 'profiles'].includes(call.name))).toBe(false);
});

test('auditoria mostra antes, depois, data e autora da edição compartilhada', async ({ page }) => {
  await setup(page); await open(page); await expand(page); await page.getByRole('textbox', { name: 'E-mails do órgão', exact: true }).fill('novo-canal@orgao.test'); await page.getByRole('button', { name: 'Salvar contatos e confirmar revisão', exact: true }).click(); await expect(contextPanel(page).getByRole('status')).toContainText('revisão registrada');
  await contactTab(page); await page.getByRole('combobox', { name: /^Tipo de consulta de contatos/ }).selectOption('changes'); await expect(page.getByRole('combobox', { name: /^Cobertura dos contatos/ })).toBeDisabled(); await page.getByRole('button', { name: 'Consultar contatos', exact: true }).click(); await expect(report(page).getByRole('table')).toContainText('financeiro@orgao.test'); await expect(report(page).getByRole('table')).toContainText('novo-canal@orgao.test'); await expect(report(page).getByRole('table')).toContainText('Responsável sintética'); await expect(report(page).getByRole('table')).toContainText('18/10/2026');
});

test('CSV inclui todas as páginas autorizadas com cerca de revisão e neutraliza fórmulas', async ({ page }) => {
  const seen = await setup(page, { large: true }); await contactTab(page); await expect(report(page)).toContainText('503'); await report(page).getByRole('button', { name: 'Próximos contatos', exact: true }).click(); await expect.poll(() => seen.calls.filter(call => call.name === 'collection_customer_contact_report').at(-1)?.body.p_offset).toBe(25);
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar CSV completo dos contatos', exact: true }).click(); const download = await downloadPromise; const csv = await readFile((await download.path())!, 'utf8');
  expect(csv.split('\r\n')).toHaveLength(504); expect(csv).toContain('org502@synthetic.test'); expect(csv).toContain('"\'=formula sintética final"'); expect(csv).not.toContain('Outro órgão reservado');
  const exports = seen.calls.filter(call => call.name === 'collection_customer_contact_report' && call.body.p_expected_revision); expect(exports.map(call => [call.body.p_offset, call.body.p_limit])).toEqual([[0, 1], [0, 500], [500, 500], [0, 1]]); expect(exports.every(call => call.body.p_expected_revision === 'contacts-fence-0' && call.body.p_collector_id === own)).toBe(true);
});

test('alteração da cerca durante CSV cancela arquivo inteiro sem download parcial', async ({ page }) => {
  const seen = await setup(page, { large: true, staleExport: true }); let downloads = 0; page.on('download', () => downloads++); await contactTab(page); await page.getByRole('button', { name: 'Baixar CSV completo dos contatos', exact: true }).click(); await expect(report(page).getByRole('alert')).toContainText('Nenhum arquivo parcial foi gerado'); expect(downloads).toBe(0); expect(seen.calls.filter(call => call.name === 'collection_customer_contact_report' && call.body.p_offset === 500)).toHaveLength(1);
});

test('resposta de diretório fora da carteira não expõe nomes, números nem habilita CSV', async ({ page }) => {
  await setup(page, { wrongReportScope: true }); await contactTab(page); await expect(report(page).getByRole('alert')).toContainText('Não foi possível consultar os contatos oficiais'); await expect(report(page).getByRole('table')).not.toContainText('financeiro@orgao.test'); await expect(report(page).getByRole('button', { name: 'Baixar CSV completo dos contatos', exact: true })).toBeDisabled();
});
