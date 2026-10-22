import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const now = '2026-10-19T15:00:00Z';
const day = '2026-10-19';
const uuid = (value: number) => `81000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const moduleLabels = ['Painel Gerencial', 'Caixa / Bancos', 'Contas a Pagar', 'Contas a Receber', 'Cobrança', 'Comissões', 'Faturamento', 'Fechamento', 'RH / DP'];
const resources = ['painel', 'caixa', 'contas_pagar', 'contas_receber', 'cobranca', 'comissoes', 'faturamento', 'margens', 'rh_dp', 'resumo_diretoria', 'mensagens_cp', 'usuarios', 'configuracoes', 'auditoria'];
const workflow = { version: '029', normal_pause: true, finish_requires_started: true, pending_read_only: true, returns_priority: true };
const priority = { collector_id: null, due_count: 0, total_cents: 0, next_title_id: null, next_due_date: null };

/** Every response is synthetic. No fixture request reaches the production project. */
async function setup(page: Page, stalePermissions = true, retiredStatus?: 'OPEN' | 'VALIDATED') {
  await page.clock.setFixedTime(new Date(now));
  const permissions = resources.flatMap(resource => [{ resource, action: 'read' }, { resource, action: 'export' }]);
  if (stalePermissions) {
    for (const resource of [...resources, 'importar_bases']) for (const action of ['read', 'write', 'import', 'validate', 'admin']) permissions.push({ resource, action });
  }
  const profile = { id: uuid(1), username: 'DiretoriaSintetica', display_name: 'Diretoria de teste', role_key: 'diretor', enabled: true, updated_at: now };
  const access = { profile, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: profile.id, session_id: uuid(2), role: 'authenticated', exp: Math.floor(Date.parse(now) / 1000) + 3600 })).toString('base64url'), 'synthetic-test-only'].join('.');
  const agent = { id: uuid(3), display_name: 'Responsável sintética', enabled: true, updated_at: now };
  const bank = { id: uuid(4), company: 'EMPRESA SINTÉTICA', bank: 'BANCO SINTÉTICO', display_name: 'Conta de teste', account_label: 'Conta sintética', account_type: 'BANK', balance_date: day, amount_cents: 123456, updated_at: now };
  const payable = { id: uuid(5), scope: 'grupo-consolidado', source_key: 'synthetic-payable', entry_number: 'CP-SINTETICO', description: 'Fornecedor de teste', branch: '3', due_date: '2026-10-08', amount_cents: 20000, source_status: 'ABERTO', plan: 'ENERGIA', bank_account: bank.display_name, issued_on: '2026-10-01', macro: 'FIXO', status: 'SETTLED_IMPORT', settled_at: now, last_import_id: uuid(6), payment_revision: uuid(7), cheque_number: null, paid_cents: 20000, outstanding_cents: 0, payment_remaining_cents: 0, overpaid_cents: 0, last_payment_date: '2026-10-18', last_payment_bank: bank.display_name, financial_status: 'PAID' };
  const payment = { id: uuid(7), request_id: uuid(8), title_id: payable.id, event_revision: 1, entry_number: payable.entry_number, cheque_number: null, description: payable.description, branch: payable.branch, macro_snapshot: payable.macro, plan_snapshot: payable.plan, due_date: payable.due_date, title_amount_cents: payable.amount_cents, amount_cents: payable.amount_cents, paid_on: '2026-10-18', bank_account_id: bank.id, bank_label: bank.display_name, observation: 'Comprovante sintético', created_at: now, created_by: uuid(9), created_by_name: 'Financeiro sintético', created_by_username: 'FinanceiroSintetico', cancelled_at: null, cancelled_by_name: null, cancellation_observation: null, status: 'ACTIVE' };
  const receivable = { id: uuid(10), scope: 'grupo-consolidado', document: 'NF-LEITURA', client_name: 'Órgão sintético', client_document: null, customer_key: 'name:orgao-sintetico', branch: '3', issued_on: '2026-10-01', due_date: '2026-10-08', amount_cents: 50000, collector_id: agent.id, status: retiredStatus ?? 'OPEN', validation_status: retiredStatus === 'VALIDATED' ? 'VALIDATED' : 'NONE', payment_source: retiredStatus === 'VALIDATED' ? 'IMPORTACAO_DIARIA' : null, payment_reported_date: null, payment_date: retiredStatus === 'VALIDATED' ? '2026-10-18' : null, reported_in_collection: !!retiredStatus, collector_locked: true, in_latest_report: !retiredStatus, retired_from_report: !!retiredStatus, revision: 1, updated_at: now, last_action: null, next_action: null, next_action_date: null };
  const pending = { ...receivable, id: uuid(11), document: 'NF-VALIDACAO', status: 'PENDING_VALIDATION', validation_status: 'PENDING', payment_source: 'COBRANCA', payment_reported_date: '2026-10-18', payment_date: null, reported_in_collection: true, in_latest_report: true, retired_from_report: false, last_action: 'PAID' };
  const row = { ...receivable, collector_name: agent.display_name, operational_status: 'NOVO TÍTULO - COBRAR', case_revision: 0, observation: 'Observação somente para consulta', next_action_text: null, next_date: null, delay_days: 11, total_work_seconds: 120, current_timer: { session_id: null, started_at: null, running: false, elapsed_seconds: 0 }, return_due: false, return_due_date: null, can_start: false, start_block_reason: 'READ_ONLY' };
  const timer = { title_id: row.id, running: false, session_id: null, started_at: null, elapsed_seconds: 0, total_seconds: 120, actor_total_seconds: 0, server_now: now, recovery_allowed: false };
  const message = { id: uuid(12), author_name: 'Gerência sintética', author_role: 'gerente_geral', priority: 'normal', reference: payable.entry_number, message: 'Mensagem de teste disponível para consulta', status: 'pendente', created_at: now, completed_at: null, reopened_at: null };
  const audit = { id: uuid(13), occurred_at: now, username: 'FinanceiroSintetico', role_key: 'contas_receber', module: 'contas_receber', entity: 'receivable_titles', record_id: pending.id, action: 'PAYMENT_REPORTED' };
  const calls: { name: string; body: any; method: string; query: Record<string, string> }[] = [], mutations: string[] = [], unhandled: string[] = [];
  const tables: Record<string, any[]> = {
    profiles: [profile, { id: uuid(14), username: 'CobradoraSintetica', display_name: 'Operadora de teste', role_key: 'cobradora_1', enabled: true, updated_at: now }],
    collection_agents: [agent], collector_bindings: [{ user_id: uuid(14), agent_id: agent.id }], audit_events: [audit], management_messages: [message],
    payable_macros: [{ name: 'FIXO' }], payable_plan_mappings: [], payable_imports: [{ id: payable.last_import_id, created_at: now }], director_positions: [], receivable_imports: [],
    receivable_collection_events: [{ id: uuid(15), title_id: pending.id, action: 'PAID', collector_id: agent.id, contact_date: '2026-10-18', observation: 'Pagamento informado pela responsável', return_note: null, payment_date: pending.payment_reported_date, next_action: null, next_date: null, created_at: now }], effective_receivable_receipts: [], receivable_receipts: [],
  };
  const unavailableReads = new Set(['payables_management_summary', 'receivables_management_summary', 'collections_overdue_summary', 'director_report', 'payables_forecast', 'get_payable_month_status', 'payables_month_status', 'list_payable_month_closures', 'collection_customer_contact_report']);
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!;
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count !== undefined ? { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' } : {}) }, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON(); calls.push({ name, body, method: request.method(), query: Object.fromEntries(url.searchParams) });
    if (name === 'auth-gateway') {
      if (body.action === 'sign_out') return reply({ signed_out: true });
      return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh-token', expires_in: 3600, token_type: 'bearer' }, access });
    }
    if (url.pathname === '/auth/v1/user') return reply({ id: profile.id, aud: 'authenticated', role: 'authenticated', email: 'director@test.invalid', created_at: now, app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (unavailableReads.has(name)) return reply({ code: 'PGRST202' }, 404);
    if (name === 'cash_position') return reply({ accounts: [bank], total_cents: bank.amount_cents, reported_accounts: 1, expected_accounts: 1, latest_position_date: day });
    if (name === 'current_stock') return reply({ value_cents: 750000, reference_date: day, source: 'MANUAL' });
    if (name === 'payables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: now });
    if (name === 'receivables_summary') return reply({ open_cents: 100000, overdue_cents: 100000, period_cents: 0, active_count: 2, pending_count: 1, unassigned_count: 0, received_period_cents: 0, latest_import_at: now, overdue_bps: 10000, overdue_comlurb_cents: 0 });
    if (name === 'get_payable_payment_accounts') return reply([bank]);
    if (name === 'get_payables_revision') return reply({ import_id: payable.last_import_id, financial_revision: '1' });
    if (name === 'get_receivables_sync_revision') return reply({ import_id: null, financial_revision: '1' });
    if (name === 'payable_payment_summary') return reply({ total_paid_cents: 20000, payment_count: 1, by_macro: [{ macro: 'FIXO', amount_cents: 20000, count: 1 }], pending_reconciliation_count: 0, revision: { import_id: payable.last_import_id, financial_revision: '1' } });
    if (name === 'list_payable_payments') return reply({ rows: [payment], count: 1, revision: { import_id: payable.last_import_id, financial_revision: '1' } });
    if (name === 'payable_review_titles') return reply({ code: 'PGRST205' }, 404);
    if (['payable_titles', 'payable_financial_titles'].includes(name)) return reply(url.searchParams.has('id') ? payable : [payable], 200, 1);
    if (['receivable_titles', 'collection_overdue_titles'].includes(name)) {
      let rows = [receivable, pending];
      const status = url.searchParams.get('status');
      if (status?.startsWith('eq.')) rows = rows.filter(title => title.status === status.slice(3));
      if (status?.startsWith('neq.')) rows = rows.filter(title => title.status !== status.slice(4));
      const retired = url.searchParams.get('retired_from_report');
      if (retired === 'eq.false' || retired === 'eq.true') rows = rows.filter(title => title.retired_from_report === (retired === 'eq.true'));
      if (url.searchParams.get('id')) rows = rows.filter(title => title.id === url.searchParams.get('id')!.slice(3));
      return reply(rows, 200, rows.length);
    }
    if (name === 'collection_workbench') {
      const rows = retiredStatus ? body.p_queue === 'history' && (!body.p_financial_status || body.p_financial_status === 'RETIRED_FROM_REPORT' || body.p_financial_status === retiredStatus) ? [row] : [] : body.p_queue === 'returns' || body.p_queue === 'history' ? [] : [row];
      return reply({ as_of_date: day, server_now: now, count: rows.length, total_cents: rows.reduce((sum, title) => sum + title.amount_cents, 0), snapshot_revision: 'director-readonly-1', rows, active_timer: null, workflow, priority });
    }
    if (name === 'collection_case_detail') return reply({ title: row, case: { status: row.operational_status, observation: row.observation, next_action: null, next_date: null, payment_date: null, revision: 0, updated_at: now, updated_by: uuid(14), finalized_at: null }, timer, history: [], report_history: retiredStatus ? [{ id: uuid(18), action: 'RETIRED_WORKED', worked: true, reference_date: day, created_at: now }] : [], case_history: [], work_sessions: [], workflow: { ...workflow, started: false, can_finish: false, recovery_allowed: false }, priority });
    if (name === 'collection_customer_context') return reply({ title_id: row.id, customer_key: row.customer_key, client_name: row.client_name, client_document: null, can_edit: false, can_review: false,
      contact: { emails: ['contato@synthetic.test'], phones: ['(11) 3333-4444'], notes: 'Contato conferido em teste', revision: 'synthetic-contact-revision', record_revision: 1, manually_edited: true, reviewed_at: now, reviewed_by: uuid(14), reviewed_by_name: 'Operadora de teste', updated_at: now, updated_by: uuid(14), updated_by_name: 'Operadora de teste' },
      descriptions: { state: 'AVAILABLE', count: 1, variants: [{ id: uuid(16), description: 'Descrição sintética do contrato', contract: 'CONTRATO-SINTETICO', source_import_id: uuid(17), imported_at: now }] }, as_of_date: day, server_now: now });
    if (name === 'collection_work_summary') return reply({ start: body.p_start ?? '2026-10-01', end: body.p_end ?? '2026-10-31', as_of_date: day, server_now: now, total_seconds: 120, session_count: 1, running_count: 0, title_count: 1, by_collector: [{ collector_id: agent.id, display_name: agent.display_name, total_seconds: 120, session_count: 1, running_count: 0, title_count: 1 }], by_day: [{ date: day, total_seconds: 120, session_count: 1, title_count: 1 }], rows: [], truncated: false });
    if (name === 'receivable_commission_base') return reply({ rows: [], count: 0, total_received_cents: 0, eligible_base_cents: 0, unassigned_count: 0, rule_status: 'AGUARDANDO_REGRAS', collectors: [{ id: agent.id, display_name: agent.display_name }] });
    if (['commissions_report', 'pending_collection_commissions', 'list_commercial_items', 'hr_report'].includes(name)) return reply({ code: 'PGRST202' }, 404);
    if (request.method() === 'GET' && Object.hasOwn(tables, name)) return reply(tables[name], 200, tables[name].length);
    if (url.pathname.startsWith('/rest/v1/rpc/') || request.method() !== 'GET') { mutations.push(name); return reply({ code: '42501', message: 'Synthetic fixture rejects all writes' }, 403); }
    unhandled.push(`${request.method()} ${name}`); return reply({ code: 'PGRST205' }, 404);
  });
  await page.goto('/');
  await page.getByLabel('Usuário', { exact: true }).fill(profile.username);
  await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  return { calls, mutations, unhandled, payable, pending, receivable };
}
async function navigate(page: Page, label: string) {
  await page.getByRole('navigation', { name: 'Módulos da Central' }).getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true, level: 1 })).toBeVisible();
}
async function noFinancialWrites(page: Page) {
  await expect(page.getByRole('button', { name: /^(Registrar saldo|Salvar estoque manual|Salvar posição|Confirmar pagamento|Estornar pagamento|Corrigir título|Confirmar atribuição|Registrar ação|Informar pagamento para validação|Salvar data real sem validar|Confirmar recebimento financeiro|Devolver à mesma responsável|Enviar mensagem|Concluir mensagem de .+|Reabrir mensagem de .+|Iniciar|Pausar|Salvar andamento|Finalizar atendimento|Marcar como título pago|Salvar contatos e confirmar revisão|Vincular conta existente|Editar|Revisar e salvar.*|Fechar mês|Reabrir mês)$/ })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
}

test('Director with official read grants sees nine modules and Administration, never Importar Bases', async ({ page }) => {
  const seen = await setup(page, false);
  const nav = page.getByRole('navigation', { name: 'Módulos da Central' });
  await expect(nav.getByRole('button')).toHaveCount(9);
  for (const label of moduleLabels) await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Administração', exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Importar Bases|Ir para Importar|Informar posição da Diretoria/ })).toHaveCount(0);
  await noFinancialWrites(page);
  expect(seen.mutations).toEqual([]); expect(seen.unhandled).toEqual([]);
});

test('stale Director write, import, validation and admin grants cannot restore mutation controls in any module', async ({ page }) => {
  const seen = await setup(page);
  for (const label of moduleLabels) {
    await navigate(page, label);
    await noFinancialWrites(page);
    await expect(page.getByRole('button', { name: /Importar Bases|Ir para Importar|Informar posição da Diretoria/ })).toHaveCount(0);
  }
  await expect(page.getByRole('navigation', { name: 'Módulos da Central' }).getByRole('button')).toHaveCount(9);
  expect(seen.mutations).toEqual([]); expect(seen.unhandled).toEqual([]);
});

test('Director Administration reads users, linked collectors and immutable audit without edit or binding forms', async ({ page }) => {
  const seen = await setup(page);
  await page.getByRole('button', { name: 'Administração', exact: false }).click();
  const admin = page.getByRole('region', { name: 'Administração da Central Financeira', exact: true });
  await expect(admin.getByRole('heading', { name: 'Usuários e permissões', exact: true })).toBeVisible();
  await expect(admin).toContainText('Acesso somente para consulta');
  await expect(admin.getByRole('cell', { name: 'DiretoriaSintetica', exact: true })).toBeVisible();
  await expect(admin.locator('form')).toHaveCount(0); await noFinancialWrites(page);
  await admin.getByRole('button', { name: 'Cobradoras', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Cobradoras e carteiras', exact: true })).toBeVisible();
  await expect(admin.getByRole('cell', { name: 'Responsável sintética', exact: true })).toBeVisible();
  await expect(admin.getByRole('cell', { name: 'CobradoraSintetica', exact: true })).toBeVisible();
  await expect(admin.locator('form')).toHaveCount(0); await noFinancialWrites(page);
  await admin.getByRole('button', { name: 'Auditoria', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Auditoria central', exact: true })).toBeVisible();
  await expect(admin.getByRole('cell', { name: 'PAYMENT_REPORTED', exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(admin.getByRole('cell', { name: 'PAYMENT_REPORTED', exact: true })).toBeVisible();
  await expect(admin.locator('form')).toHaveCount(0); await noFinancialWrites(page);
  expect(seen.mutations).toEqual([]); expect(seen.unhandled).toEqual([]);
});

test('Director reads CP messages, realized payments and reversal history without sending, closing or editing', async ({ page }) => {
  const seen = await setup(page); await navigate(page, 'Contas a Pagar');
  await expect(page.getByText('Mensagem de teste disponível para consulta', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Consultar pagamentos', exact: true }).click();
  const detail = page.locator('.payable-reconciliation-editor');
  await expect(detail).toContainText('Comprovante sintético');
  await expect(detail).toContainText('Conta de teste');
  await expect(page.getByRole('textbox', { name: 'Observação do pagamento', exact: true })).toHaveCount(0);
  await noFinancialWrites(page);
  expect(seen.calls.some(call => call.name === 'list_payable_payments' && call.body.p_title_id === seen.payable.id)).toBe(true);
  expect(seen.mutations).toEqual([]); expect(seen.unhandled).toEqual([]);
});

test('Director consults cash balances and pending receivable validations without balance, assignment or validation forms', async ({ page }) => {
  const seen = await setup(page); await navigate(page, 'Caixa / Bancos');
  await expect(page.getByRole('cell', { name: 'Conta de teste', exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Registrar saldo de conta', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Estoque manual', exact: true })).toHaveCount(0);
  await noFinancialWrites(page);
  await navigate(page, 'Contas a Receber');
  await page.getByRole('button', { name: 'Detalhar título NF-VALIDACAO de Órgão sintético', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Título NF-VALIDACAO · Órgão sintético', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Histórico do título', exact: true })).toBeVisible();
  await noFinancialWrites(page);
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await page.getByRole('button', { name: 'Conferir NF-VALIDACAO', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Conferência financeira de NF-VALIDACAO', exact: true });
  await expect(confirmation).toContainText('Este acesso permite somente consulta');
  await expect(confirmation).toContainText('Pagamento informado pela responsável');
  await expect(confirmation.locator('form')).toHaveCount(0); await noFinancialWrites(page);
  expect(seen.mutations).toEqual([]); expect(seen.unhandled).toEqual([]);
});

test('Director collection desk, customer contacts and all secondary panels remain read-only despite stale grants', async ({ page }) => {
  const seen = await setup(page); await navigate(page, 'Cobrança');
  for (const tab of ['Visão geral', 'Títulos', 'Validação financeira', 'Tempo de trabalho', 'Contatos']) await expect(page.getByRole('tab', { name: tab, exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir título NF-LEITURA', exact: true }).click();
  const sidebar = page.getByRole('region', { name: 'Atendimento do título', exact: true });
  await expect(sidebar.getByRole('combobox', { name: 'Status do atendimento', exact: true })).toBeDisabled();
  await expect(sidebar.getByRole('textbox', { name: 'Observações', exact: true })).toBeDisabled();
  await sidebar.locator('.collection-customer-context > summary').click();
  await expect(sidebar.getByRole('link', { name: 'contato@synthetic.test', exact: true })).toHaveAttribute('href', 'mailto:contato%40synthetic.test');
  await expect(sidebar).toContainText('Descrição sintética do contrato');
  await expect(sidebar.getByRole('textbox', { name: 'E-mails do órgão', exact: true })).toHaveCount(0); await noFinancialWrites(page);
  await page.getByRole('tab', { name: 'Validação financeira', exact: true }).click();
  await page.getByRole('button', { name: 'Conferir NF-VALIDACAO', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conferência financeira de NF-VALIDACAO', exact: true })).toContainText('Este acesso permite somente consulta');
  await noFinancialWrites(page);
  await page.getByRole('tab', { name: 'Tempo de trabalho', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tempo de trabalho', exact: true, level: 2 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tempo de trabalho', exact: true }).getByText('00:02:00', { exact: true }).first()).toBeVisible(); await noFinancialWrites(page);
  await page.getByRole('tab', { name: 'Contatos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Relatório de contatos', exact: true })).toBeVisible(); await noFinancialWrites(page);
  expect(seen.mutations).toEqual([]); expect(seen.unhandled).toEqual([]);
});

test('Director reads a worked title retired from the complete report in collection history without restoring write access', async ({ page }) => {
  const seen = await setup(page, true, 'OPEN');
  await navigate(page, 'Contas a Receber');
  await expect.poll(() => seen.calls.some(call => call.name === 'receivable_titles' && call.query.status === 'neq.VALIDATED' && call.query.retired_from_report === 'eq.false')).toBe(true);
  await expect(page.getByRole('button', { name: 'Detalhar título NF-LEITURA de Órgão sintético', exact: true })).toHaveCount(0);
  await navigate(page, 'Cobrança');
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click();
  await page.getByText('Vencimentos e situação financeira', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Situação financeira', exact: true }).selectOption('RETIRED_FROM_REPORT');
  await page.getByRole('button', { name: 'Abrir título NF-LEITURA', exact: true }).click();
  const sidebar = page.getByRole('region', { name: 'Atendimento do título', exact: true });
  await expect(sidebar).toContainText('Título retirado da carteira ativa por ausência no relatório completo.');
  await expect(sidebar.getByRole('timer', { name: 'Tempo do atendimento' })).toHaveText('00:02:00');
  await expect(sidebar.getByRole('combobox', { name: 'Status do atendimento', exact: true })).toBeDisabled();
  await expect(sidebar.getByRole('textbox', { name: 'Observações', exact: true })).toBeDisabled();
  await sidebar.getByText('Movimentações por relatório completo', { exact: true }).click();
  await expect(sidebar).toContainText('Pendente em Comissões, aguardando o relatório de quitados.');
  await noFinancialWrites(page);
  expect(seen.calls.some(call => call.name === 'collection_workbench' && call.body.p_queue === 'history' && call.body.p_financial_status === 'RETIRED_FROM_REPORT')).toBe(true);
  expect(seen.mutations).toEqual([]); expect(seen.unhandled).toEqual([]);
});

test('Director sees a formerly retired title confirmed in Quitados as validated without pending commission notices', async ({ page }) => {
  const seen = await setup(page, true, 'VALIDATED');
  await navigate(page, 'Contas a Receber');
  await page.getByRole('combobox', { name: 'Situação do título', exact: true }).selectOption('VALIDATED');
  await expect(page.getByRole('button', { name: 'Detalhar título NF-LEITURA de Órgão sintético', exact: true })).toBeVisible();
  await expect.poll(() => seen.calls.some(call => call.name === 'receivable_titles' && call.query.status === 'eq.VALIDATED' && !Object.hasOwn(call.query, 'retired_from_report'))).toBe(true);
  const table = page.getByRole('table', { name: 'Contas a Receber com filtros e paginação' });
  await expect(table).toContainText('Quitado — validado');
  await expect(table).not.toContainText('Retirado da carteira ativa');
  await page.getByRole('button', { name: 'Detalhar título NF-LEITURA de Órgão sintético', exact: true }).click();
  await expect(page.getByText('Título retirado anteriormente por ausência no relatório completo. O recebimento foi confirmado; o histórico permanece disponível.', { exact: true })).toBeVisible();
  await navigate(page, 'Cobrança');
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click();
  await page.getByText('Vencimentos e situação financeira', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Situação financeira', exact: true }).selectOption('VALIDATED');
  await page.getByRole('button', { name: 'Abrir título NF-LEITURA', exact: true }).click();
  const sidebar = page.getByRole('region', { name: 'Atendimento do título', exact: true });
  await expect(sidebar).toContainText('O recebimento foi confirmado; o histórico e o tempo de atendimento foram preservados.');
  await expect(sidebar).toContainText('Recebimento validado. Este registro está disponível somente para consulta do histórico.');
  await sidebar.getByText('Movimentações por relatório completo', { exact: true }).click();
  await expect(sidebar).not.toContainText('Pendente em Comissões, aguardando o relatório de quitados.');
  await expect(sidebar).not.toContainText('a confirmação financeira depende do relatório de quitados.');
  await expect(sidebar.getByRole('textbox', { name: 'Observações', exact: true })).toBeDisabled();
  await noFinancialWrites(page);
  expect(seen.mutations).toEqual([]); expect(seen.unhandled).toEqual([]);
});
