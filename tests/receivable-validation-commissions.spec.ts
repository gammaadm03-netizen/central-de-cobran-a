import { expect, test, type Page } from '@playwright/test';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const id = (value: number) => `98500000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const userId = id(1), sessionId = id(2), collectorId = id(20), titleId = id(30), receiptId = id(40), ruleId = id(50);
const now = '2026-10-29T15:00:00Z';
const collectorName = 'Responsável sintética da integração';
const bands = [
  { band: 'ATE_30', label: '1–30 dias', reference_cents: 0, commission_reference_cents: 0 },
  { band: '31_60', label: '31–60 dias', reference_cents: 20000000, commission_reference_cents: 10000 },
  { band: '61_90', label: '61–90 dias', reference_cents: 10000000, commission_reference_cents: 30000 },
  { band: '91_180', label: '91–180 dias', reference_cents: 10000000, commission_reference_cents: 60000 },
  { band: '181_365', label: '181–365 dias', reference_cents: 8000000, commission_reference_cents: 100000 },
  { band: 'ACIMA_365', label: '>365 dias', reference_cents: 3500000, commission_reference_cents: 150000 },
];
type Scenario = { label: string; due: string; paid: string; nominal: number; received: number; entered: string; delay: number; band: string; commission: number };
const scenarios: Scenario[] = [
  { label: 'recebimento trabalhado em mês anterior gera comissão sobre o líquido', due: '2026-08-01', paid: '2026-09-15', nominal: 100000, received: 99000, entered: '990,00', delay: 45, band: '31_60', commission: 50 },
  { label: 'recebimento anterior ao vencimento entra no mês real com comissão zero', due: '2026-08-26', paid: '2026-08-07', nominal: 424020, received: 418932, entered: '4.189,32', delay: 0, band: 'ATE_30', commission: 0 },
];

async function setup(page: Page, scenario: Scenario) {
  await page.clock.setFixedTime(new Date(now));
  const access = { profile: { id: userId, username: 'FinanceiroIntegracao', display_name: 'Financeiro sintético de integração', role_key: 'contas_receber', enabled: true },
    permissions: [{ resource: 'comissoes', action: 'read' }, ...['read', 'write', 'validate'].map(action => ({ resource: 'contas_receber', action }))], collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId, exp: 4070908800, role: 'authenticated' })).toString('base64url'), 'synthetic-integration-only'].join('.');
  const title = { id: titleId, scope: 'grupo-consolidado', source_key: 'synthetic-retired-integration', document: 'NF-INTEGRACAO-055', client_name: 'Órgão sintético do fluxo financeiro', client_document: null,
    customer_key: 'name:ORGAO SINTETICO DO FLUXO FINANCEIRO', branch: '4', issued_on: '2026-07-01', due_date: scenario.due, amount_cents: scenario.nominal, collector_id: collectorId,
    status: 'OPEN', validation_status: 'NONE', payment_source: null as string | null, payment_reported_date: null, payment_date: null as string | null,
    reported_in_collection: false, collector_locked: false, retired_from_report: true, in_latest_report: false, revision: 7, updated_at: now,
    first_import_id: id(60), last_import_id: id(60), last_action: 'CONTACT', next_action: 'OTHER' as string | null, next_action_date: '2026-10-30' as string | null };
  const receipts: Record<string, any>[] = [];
  const calls: { name: string; body: any; query: string }[] = [], writes: { name: string; body: any }[] = [];
  const proofs = new Map<string, Record<string, unknown>>();
  function commissionReport(body: any) {
    const included = receipts.length > 0 && scenario.paid >= body.p_start && scenario.paid <= body.p_end;
    const row = { id: receiptId, title_id: titleId, source_revision: '0', date: scenario.paid, document: title.document, client_name: title.client_name, branch: title.branch,
      subject: collectorId, subject_name: collectorName, amount_cents: scenario.received, nominal_amount_cents: scenario.nominal, due_date: title.due_date,
      delay_days: scenario.delay, band: scenario.band, commission_cents: scenario.commission, eligibility: scenario.commission ? 'ASSESSED' : 'NO_COMMISSION',
      rule_id: ruleId, rule_effective_from: '2026-01-01', rule_config: { eligible_collector_ids: [collectorId], bands },
      rate_numerator: scenario.delay ? 10000 : 0, rate_denominator: scenario.delay ? 20000000 : 0, payment_source: 'COBRANCA' };
    return { kind: 'COLLECTOR', start: body.p_start, end: body.p_end, subject: body.p_subject, band: body.p_band,
      rows: included ? [row] : [], count: included ? 1 : 0, total_amount_cents: included ? scenario.received : 0, eligible_amount_cents: included ? scenario.received : 0,
      commission_cents: included ? scenario.commission : 0, margin_cents: 0, pending_count: 0, assessed_count: included && scenario.commission ? 1 : 0,
      average_delay_days: included ? scenario.delay : 0, complete: true,
      summaries: included ? [{ subject: collectorId, subject_name: collectorName, count: 1, amount_cents: scenario.received, commission_cents: scenario.commission, margin_cents: null, pending_count: 0 }] : [],
      bands: included ? [{ band: scenario.band, count: 1, amount_cents: scenario.received, commission_cents: scenario.commission, pending_count: 0 }] : [],
      options: [{ id: collectorId, name: collectorName, enabled: true }],
      rule_versions: [{ id: ruleId, kind: 'COLLECTOR', subject: '', effective_from: '2026-01-01', created_at: '2026-01-01T12:00:00Z', reason: 'Regra sintética de integração', config: { eligible_collector_ids: [collectorId], bands } }],
      collector_bands: bands, revision: (receipts.length ? 'b' : 'a').repeat(32), assessments: [] };
  }
  await page.route(`${project}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), name = url.pathname.split('/').at(-1)!, body = request.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer,range,range-unit', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (payload: unknown, status = 200, count?: number) => route.fulfill({ status, headers: { ...headers, ...(count === undefined ? {} : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }) }, json: payload });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    calls.push({ name, body, query: url.search });
    if (name === 'auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.invalid', created_at: now, app_metadata: {}, user_metadata: {} });
    if (name === 'current_access') return reply(access);
    if (name === 'receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if (name === 'collection_agents') return reply([{ id: collectorId, display_name: collectorName, enabled: true }]);
    if (name === 'commissions_report') return reply(commissionReport(body));
    if (name === 'pending_collection_commissions') return reply({ format_version: 'pending-collection-commissions-v1', count: receipts.length ? 0 : 1, revision: String(title.revision), options: { collectors: [{ id: collectorId, display_name: collectorName }] },
      rows: receipts.length ? [] : [{ event_id: id(70), title_id: titleId, document: title.document, client_name: title.client_name, branch: title.branch, due_date: title.due_date, nominal_reference_cents: title.amount_cents,
        collector_id: collectorId, collector_name: collectorName, retired_at: '2026-10-28T12:00:00Z', reference_date: '2026-10-28', source_import_id: id(60), status: 'AWAITING_RECEIVED_REPORT', payment_date: null, commission_cents: null }] });
    if (name === 'receivable_retired_validation_queue') return reply({ format_version: '055', count: receipts.length ? 0 : 1, rows: receipts.length ? [] : [{ ...title, collection_worked: true }] });
    if (name === 'receivable_titles') {
      let rows = [{ ...title }];
      const status = url.searchParams.get('status'), retired = url.searchParams.get('retired_from_report'), validation = url.searchParams.get('validation_status');
      if (status?.startsWith('eq.')) rows = rows.filter(row => row.status === status.slice(3));
      if (status === 'neq.VALIDATED') rows = rows.filter(row => row.status !== 'VALIDATED');
      if (retired === 'eq.false') rows = rows.filter(row => !row.retired_from_report);
      if (validation?.startsWith('eq.')) rows = rows.filter(row => row.validation_status === validation.slice(3));
      return reply(rows, 200, rows.length);
    }
    if (name === 'effective_receivable_receipts' || name === 'receivable_receipts') return reply(receipts);
    if (name === 'receivable_collection_events') return reply([]);
    if (name === 'validate_receivable_payment_v2') {
      writes.push({ name, body });
      if (proofs.has(body.p_request_id)) return reply(proofs.get(body.p_request_id));
      if (body.p_expected_revision !== title.revision || receipts.length) return reply({ code: '40001' }, 409);
      title.status = 'VALIDATED'; title.validation_status = 'VALIDATED'; title.payment_date = body.p_payment_date;
      title.payment_source = 'COBRANCA'; title.reported_in_collection = true; title.next_action = null; title.next_action_date = null; title.revision++;
      receipts.push({ id: receiptId, title_id: titleId, amount_cents: body.p_received_cents, payment_date: body.p_payment_date, validated_at: now,
        collector_id: collectorId, delay_days: scenario.delay, delay_band: scenario.band, payment_source: 'COBRANCA', reported_in_collection: true,
        manual_nominal_amount_cents: scenario.nominal, manual_original_due_date: scenario.due,
        manual_adjustment_cents: scenario.nominal - body.p_received_cents, manual_adjustment_reason: body.p_adjustment_reason });
      const proof = { format_version: '055', request_id: body.p_request_id, title_id: titleId, decision: 'CONFIRM', receipt_id: receiptId,
        payment_date: body.p_payment_date, nominal_cents: scenario.nominal, received_cents: body.p_received_cents,
        adjustment_cents: scenario.nominal - body.p_received_cents, adjustment_reason: body.p_adjustment_reason, title_revision: title.revision };
      proofs.set(body.p_request_id, proof); return reply(proof);
    }
    throw new Error(`Unexpected integration request ${request.method()} ${url.pathname}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('FinanceiroIntegracao'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await page.getByRole('navigation', { name: 'Módulos da Central' }).getByRole('button', { name: 'Comissões', exact: true }).click();
  return { calls, writes, receipts, title };
}

for (const scenario of scenarios) test(scenario.label, async ({ page }) => {
  const seen = await setup(page, scenario);
  const pending = page.getByRole('region', { name: 'Aguardando confirmação de recebimento', exact: true });
  await expect(pending.getByRole('button', { name: 'Abrir pendência NF-INTEGRACAO-055', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Recebimentos confirmados para comissões', exact: true })).toContainText('Nenhum recebimento trabalhado e validado no filtro.');
  await pending.getByRole('button', { name: 'Abrir validação financeira', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Validação financeira', exact: true })).toHaveAttribute('aria-selected', 'true');
  const validation = page.getByRole('tabpanel', { name: 'Validação financeira', exact: true });
  await validation.getByRole('button', { name: 'Conferir retirado NF-INTEGRACAO-055', exact: true }).click();
  await validation.getByLabel('Data real do recebimento', { exact: true }).fill(scenario.paid);
  await validation.getByLabel('Valor efetivamente recebido (R$)', { exact: true }).fill(scenario.entered);
  await validation.getByLabel('Desconto ou retenção — justificativa', { exact: true }).fill('Retenção sintética conferida no comprovante.');
  await validation.getByRole('checkbox', { name: 'Confirmo que a diferença é desconto ou retenção e que o título está integralmente quitado.', exact: true }).check();
  await validation.getByLabel('Justificativa / observação da validação', { exact: true }).fill('Entrada bancária sintética conferida pelo financeiro.');
  page.once('dialog', dialog => dialog.accept());
  await validation.getByRole('button', { name: 'Confirmar recebimento financeiro', exact: true }).click();
  await expect(validation.getByRole('status').filter({ hasText: 'Recebimento validado:' })).toContainText('O título saiu da carteira ativa e das pendências de recebimento.');
  await expect(validation.getByRole('button', { name: 'Conferir retirado NF-INTEGRACAO-055', exact: true })).toHaveCount(0);
  expect(seen.writes).toEqual([{ name: 'validate_receivable_payment_v2', body: expect.objectContaining({ p_title_id: titleId, p_decision: 'CONFIRM', p_payment_date: scenario.paid,
    p_received_cents: scenario.received, p_adjustment_reason: 'Retenção sintética conferida no comprovante.', p_expected_revision: 7 }) }]);
  expect(seen.receipts).toHaveLength(1);
  expect(seen.title).toMatchObject({ status: 'VALIDATED', validation_status: 'VALIDATED', amount_cents: scenario.nominal, due_date: scenario.due,
    collector_id: collectorId, retired_from_report: true, next_action: null, next_action_date: null });
  await page.getByRole('tab', { name: 'Títulos', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Títulos', exact: true }).getByRole('button', { name: /Abrir.*NF-INTEGRACAO-055/ })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Módulos da Central' }).getByRole('button', { name: 'Comissões', exact: true }).click();
  await expect(pending).toContainText('Nenhum título aguardando confirmação de recebimento neste filtro.');
  const report = page.getByRole('table', { name: 'Recebimentos confirmados para comissões', exact: true });
  await expect(report).toContainText('Nenhum recebimento trabalhado e validado no filtro.');
  await page.getByLabel('Mês de recebimento', { exact: true }).fill(scenario.paid.slice(0, 7));
  await page.getByRole('button', { name: 'Consultar comissões', exact: true }).click();
  await expect(report.getByRole('button', { name: 'Abrir recebimento NF-INTEGRACAO-055', exact: true })).toBeVisible();
  const receiptRow = report.getByRole('row').filter({ hasText: 'NF-INTEGRACAO-055' });
  await expect(receiptRow).toContainText(scenario.commission ? 'Comissão apurada' : 'Sem comissão na faixa');
  await expect(receiptRow).toContainText(scenario.entered);
  await expect(receiptRow).toContainText(`${scenario.delay} dias`);
  const reportReads = seen.calls.filter(call => call.name === 'commissions_report');
  expect(reportReads.at(-1)?.body.p_start).toBe(`${scenario.paid.slice(0, 7)}-01`);
  expect(seen.calls.some(call => ['save_commission_assessment', 'configure_commission_rule', 'record_collection_action', 'validate_receivable_payment'].includes(call.name))).toBe(false);
  expect(seen.writes).toHaveLength(1);
});
