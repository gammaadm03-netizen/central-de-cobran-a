import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { validOpenStatusPreview, validOpenStatusCommit } from '../supabase/functions/payables-import/open-status-reconciliation.mjs';
import { parseCsv, validatePayableDailyRows } from '../src/lib/payables-parser.mjs';
import { buildPayableOpenStatusSql } from './bundle-payable-open-status.mjs';

// Exercise the actual production browser proof guards against PostgreSQL results.
const browserBuild = await build({ entryPoints: [new URL('../src/lib/payable-open-status.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' }, loader: { '.css': 'empty' } });
const browserModule = { exports: {} };
new Function('require', 'module', 'exports', browserBuild.outputFiles[0].text)(createRequire(import.meta.url), browserModule, browserModule.exports);
const { validOpenStatusCanonical, validOpenStatusResult } = browserModule.exports;
const proofHash = 'e'.repeat(64);
const resetBody = (await readFile(new URL('../supabase/admin/zerar-somente-contas-pagar-2026-10-30.sql', import.meta.url), 'utf8')).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const restoreBody = (await readFile(new URL('../supabase/admin/restaurar-somente-contas-pagar-2026-10-30.sql', import.meta.url), 'utf8')).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const resetScope = JSON.parse(await readFile(new URL('./lib/payable-reset-scope.json', import.meta.url), 'utf8'));

// Disposable PostgreSQL only. All reports, people, accounts and amounts are synthetic.
// These tests distinguish an operational Pago from an actual financial payment.
const f = await createCostFixture(), { db, users, owner, actor, scalar, file } = f;
const scope = 'grupo-consolidado', plan = 'PLANO STATUS SINTETICO', branch = 'FILIAL STATUS SINTETICA';
const mappings = { [plan]: 'FIXO' };
let passed = 0, sequence = 0, today, yesterday, tomorrow, closingMonth, bank, bankLabel;
const failures = [];
const date = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const original = (content = `Relatório operacional sintético ${++sequence}`) => {
  const bytes = Buffer.from(content); return { name: `status-${++sequence}.csv`, hash: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
};
const emptyOriginal = () => original('Lançamento;Histórico;Plano cp - Conta: nome;Plano cc - Conta: nome;Emissão: valor do lançamento;Emissão: data;Vencimento: data;Cheque: número;Filial\r\n');
const row = (entry_number, amount_cents = 10000, extra = {}) => ({ entry_number, amount_cents, branch, description: `Fornecedor sintético ${entry_number}`, due_date: yesterday, issued_on: yesterday, source_status: 'ABERTO', plan, bank_account: bankLabel, ...extra });
const cheque = (entry, amount = 20000, extra = {}) => row(entry, amount, { cheque_number: '000' + entry, ...extra });
const title = entry => scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1 AND branch=$2', [entry, branch]);
const events = id => scalar("SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY created_at,id),'[]') r FROM public.payable_report_status_events e WHERE title_id=$1", [id]);
const tables = ['public.payable_titles','public.payable_imports','cf_private.payable_import_files','public.payable_payments','public.payable_payment_reversals','public.payable_title_reviews','public.payable_administrative_writeoffs','public.payable_report_status_events','public.payable_import_modes','public.payable_macros','public.payable_plan_mappings','public.payable_paid_bank_mappings','cf_private.payable_import_resolution_requests','cf_private.payable_daily_reports','cf_private.payable_daily_requests','cf_private.payable_daily_actions','cf_private.payable_payment_state','cf_private.payable_control_state','public.audit_events','public.bank_accounts','public.bank_balance_positions','public.profiles','public.role_permissions'];
async function rows(table) { return scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') r FROM ${table} t`); }
async function state() {
  await owner(); const out = {};
  for (const name of tables) out[name] = await rows(name);
  await actor(); return out;
}
async function financialState() {
  await owner(); const out = {};
  for (const name of ['public.payable_payments','public.payable_payment_reversals','public.payable_title_reviews','public.bank_balance_positions']) out[name] = await rows(name);
  await actor(); return out;
}
const triggerModes = () => db.query("SELECT n.nspname||'.'||c.relname relation,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN('public','cf_private') ORDER BY 1,2").then(result => result.rows);
async function repeat061WithinTest() {
  // Preserve the enclosing disposable test transaction; the published file has
  // its own transaction for SQL Editor installation.
  await db.exec((await file('061_payable_report_status.sql')).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
}
async function test(name, run) {
  await owner(); await db.exec('BEGIN'); await actor();
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { failures.push({ name, error }); console.error('FAIL', name, error.message, error.code ?? '', error.where ?? ''); }
  finally { await db.exec('ROLLBACK'); await actor(); }
}
async function rejects(run, code) {
  await db.exec('SAVEPOINT expected_failure');
  try { await assert.rejects(run, error => { if (code) assert.equal(error.code, code, error.message); return true; }); }
  finally { await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure'); await actor(); }
}
async function preview(sourceRows, { kind = 'ALL', choices = {}, map = mappings, empty = false, rounding = [] } = {}) {
  const p = await scalar('SELECT public.preview_payables_open_status_report($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb) r', [scope, JSON.stringify(sourceRows), kind, JSON.stringify(map), JSON.stringify(choices), empty, JSON.stringify(rounding)]);
  assert.equal(validOpenStatusPreview(p, { sourceRows, resolutionChoices: choices, roundingAdjustments: rounding, emptyReportConfirmed: empty }), true, 'Actual SQL preview must satisfy the gateway proof: ' + JSON.stringify(p));
  assert.equal(validOpenStatusCanonical({ rows: p.rows, preview: p, file_sha256: proofHash }, proofHash, empty, rounding), true, 'Actual SQL preview must satisfy the browser proof: ' + JSON.stringify(p));
  return p;
}
async function frozen(sourceRows, options = {}) {
  const config = { choices: {}, map: options.empty ? {} : mappings, kind: 'ALL', empty: false, rounding: [], ...options };
  return { rows: sourceRows, ...config, preview: await preview(sourceRows, config), original: options.original ?? original(), request: randomUUID() };
}
async function commit(request, user = 'manager', session = users[user].session) {
  await owner(); await db.exec('SET ROLE service_role');
  const p = request.preview, o = request.original;
  const result = await scalar('SELECT public.commit_payables_open_status_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13::date,$14,$15,$16::jsonb) r', [users[user].id, session, scope, o.name, o.hash, o.base64, JSON.stringify(request.rows), request.kind, JSON.stringify(request.map), JSON.stringify(request.choices), p.previous_import_id, p.financial_revision, p.report_date, request.request, request.empty, JSON.stringify(request.rounding)]);
  await actor();
  const body = { action: 'commit', mode: 'open_status', status_report_version: '061', report_kind: request.kind, file_name: o.name, file_base64: o.base64, mappings: request.map, resolution_choices: request.choices, complete: true, previous_import_id: p.previous_import_id, previous_financial_revision: p.financial_revision, expected_report_date: p.report_date, request_id: request.request, ...(request.empty ? { empty_report_confirmed: true } : {}) };
  assert.equal(validOpenStatusCommit(result, { sourceRows: request.rows, request: body, roundingAdjustments: request.rounding }), true, 'Actual SQL commit must satisfy the gateway proof: ' + JSON.stringify(result));
  assert.equal(validOpenStatusResult(result, body, request.rows.length, request.rounding), true, 'Actual SQL commit must satisfy the browser proof: ' + JSON.stringify(result));
  return result;
}
async function baseline(sourceRows) {
  const request = await frozen(sourceRows), p = request.preview;
  assert.equal(p.baseline_only, true); assert.equal(p.marked_paid_count, 0); assert.equal(p.can_commit, true, JSON.stringify(p.errors));
  return commit(request);
}
async function actualPayment(t, amount = t.amount_cents) {
  return scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r', [t.id, amount, yesterday, bank, 'Comprovante financeiro real sintético', t.payment_revision, randomUUID(), t.last_import_id]);
}
async function assertStatusPaid(entry, nominal) {
  const t = await title(entry);
  assert.equal(t.status, 'SETTLED_IMPORT'); assert.equal(t.report_paid, true); assert.equal(t.financial_status, 'REPORT_PAID'); assert.equal(t.review_status, 'PAGO_POR_RELATORIO');
  assert.equal(t.paid_cents, 0); assert.equal(t.outstanding_cents, 0); assert.equal(t.payment_remaining_cents, 0); assert.equal(t.amount_cents, nominal); assert.equal(t.last_payment_date, null);
  assert.equal((await events(t.id)).filter(e => e.event_type === 'PAID').length, 1);
  return t;
}

try {
  ({ today, yesterday, tomorrow, closingMonth } = (await db.query("SELECT d::text today,(d-1)::text yesterday,(d+1)::text tomorrow,date_trunc('month',d+interval '2 months')::date::text AS \"closingMonth\" FROM(SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date d)s")).rows[0]);
  const account = (await db.query("SELECT id,display_name FROM public.bank_accounts WHERE enabled AND account_type='BANK' ORDER BY id LIMIT 1")).rows[0];
  bank = account.id; bankLabel = account.display_name;
  const old = original(); await owner(); await db.exec('SET ROLE service_role');
  await scalar('SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,NULL) r', [users.manager.id, users.manager.session, scope, old.name, old.hash, old.base64, JSON.stringify([row('LEGACY-UNOWNED', 45000), row('LEGACY-REAL', 27000)]), JSON.stringify(mappings)]);
  await actor(); await actualPayment(await title('LEGACY-REAL'));
  const reviewable = await title('LEGACY-REAL'); await scalar('SELECT public.review_payable_title($1,$2,$3) r', [reviewable.id, 'Pagamento real conciliado antes da atualização061', reviewable.review_fingerprint]);
  await owner(); for (const name of ['042_payable_administrative_writeoff.sql','043_payable_import_reconciliation.sql','050_paid_bank_rules.sql','058_payable_daily_reports.sql','059_payable_column_rules.sql','060_payable_unified_report.sql']) await db.exec(await file(name)); await actor();
  const oldRevision = await scalar('SELECT public.get_payables_revision() r'), reviewedBeforeInstall = await title('LEGACY-REAL');
  await owner(); const beforeInstall = {};
  for (const name of tables.filter(n => !['public.payable_report_status_events','public.payable_macros'].includes(n))) beforeInstall[name] = await rows(name);
  await db.exec(await file('061_payable_report_status.sql')); await actor();

  await test('061 activation is repeatable and preserves every existing financial and source row', async () => {
    const after = await state(); for (const [name, value] of Object.entries(beforeInstall)) assert.deepEqual(after[name], value, name);
    assert.deepEqual(after['public.payable_report_status_events'], []);
    const reviewedAfterInstall = await title('LEGACY-REAL'); assert.equal(reviewedAfterInstall.review_status, 'CONCILIADO'); assert.equal(reviewedAfterInstall.review_fingerprint, reviewedBeforeInstall.review_fingerprint); assert.equal(reviewedAfterInstall.payment_revision, reviewedBeforeInstall.payment_revision); assert.equal(reviewedAfterInstall.paid_cents, 27000);
    assert.equal(await scalar("SELECT count(*)::int r FROM public.payable_macros WHERE name='NÃO CLASSIFICADO'"), 1);
    assert.notEqual((await scalar('SELECT public.get_payables_revision() r')).financial_revision, oldRevision.financial_revision);
    const cap = await scalar('SELECT public.payables_import_capabilities() r'); assert.equal(cap.status_report_version, '061'); assert.equal(cap.status_from_report, true); assert.equal(cap.status_only, true);
    await owner(); await repeat061WithinTest(); await actor(); assert.deepEqual(await state(), after);
  });
  await test('all obsolete import writers are closed to API roles', async () => {
    const writes = (await db.query("SELECT p.oid::regprocedure::text name,has_function_privilege('service_role',p.oid,'EXECUTE') allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'commit_payables%' AND p.proname<>'commit_payables_open_status_report_from_gateway'")).rows;
    assert(writes.length >= 5); assert(writes.every(item => item.allowed === false), JSON.stringify(writes));
    assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.commit_payables_open_status_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,uuid,text,date,uuid,boolean,jsonb)','EXECUTE') r"), false);
  });
  await test('the CP operator can establish and reconcile the daily report', async () => {
    await actor('cp'); await commit(await frozen([row('CP-KEEP'), row('CP-MISSING', 24000)]), 'cp');
    await actor('cp'); const result = await commit(await frozen([row('CP-KEEP')]), 'cp'); assert.equal(result.marked_paid_count, 1); assert.equal(result.paid_count, 0); assert.equal(result.payments_created, 0);
    await assertStatusPaid('CP-MISSING', 24000);
  });
  await test('the first ALL report is a baseline and never adopts older absent titles', async () => {
    const sourceRows = [row('KEEP'), cheque('NUMBERED', 23000)], p = await preview(sourceRows);
    assert.equal(p.status_report_version, '061'); assert.equal(p.status_only, true); assert.equal(p.mode, 'open_status'); assert.equal(p.report_kind, 'ALL'); assert.equal(p.row_count, 2); assert.equal(p.new_count, 2); assert.equal(p.baseline_only, true);
    await baseline(sourceRows); assert.equal((await title('LEGACY-UNOWNED')).status, 'NEW'); assert.equal((await title('LEGACY-UNOWNED')).paid_cents, 0); assert.equal((await title('LEGACY-REAL')).paid_cents, 27000);
  });
  await test('existing identity, original source bank and automatic new amount and maturity are kept together', async () => {
    await baseline([row('KEEP'), row('UPDATE', 31000)]); const oldTitle = await title('UPDATE');
    const sourceRows = [row('KEEP'), row('UPDATE', 15555, { due_date: tomorrow, issued_on: today, description: 'Nova descrição e parcela', bank_account: 'BANCO ORIGEM ATUALIZADO' }), row('NEW', 8800)];
    const p = await preview(sourceRows); assert.equal(p.can_commit, true, JSON.stringify(p)); assert.deepEqual(p.exceptions, []); assert.equal(p.changed_count, 1);
    const result = await commit(await frozen(sourceRows)); assert.equal(result.new_count, 1); assert.equal(result.updated_count, 1);
    const t = await title('UPDATE'); assert.equal(t.id, oldTitle.id); assert.equal(t.amount_cents, 15555); assert.equal(date(t.due_date), tomorrow); assert.equal(date(t.issued_on), today); assert.equal(t.description, 'Nova descrição e parcela'); assert.equal(t.bank_account, 'BANCO ORIGEM ATUALIZADO'); assert.equal(t.paid_cents, 0);
  });
  await test('an unmapped plan is imported as unclassified without inventing a macro or stopping the report', async () => {
    const sourceRows = [row('UNCLASSIFIED', 12345, { plan: 'PLANO AINDA NAO CLASSIFICADO' })], p = await preview(sourceRows, { map: {} });
    assert.equal(p.can_commit, true, JSON.stringify(p)); assert.deepEqual(p.exceptions, []); assert.equal(p.unmapped_plans.length, 1);
    await commit(await frozen(sourceRows, { map: {} })); const t = await title('UNCLASSIFIED'); assert.equal(t.plan, sourceRows[0].plan); assert.equal(t.macro, 'NÃO CLASSIFICADO');
  });
  await test('case and whitespace in an existing plan preserve its known macro without substituting unclassified', async () => {
    const sourceRows = [row('KNOWN-PLAN', 16700, { plan: 'investimentos' })], p = await preview(sourceRows, { map: {} });
    assert.equal(p.can_commit, true); assert.deepEqual(p.unmapped_plans, []); await commit(await frozen(sourceRows, { map: {} }));
    const t = await title('KNOWN-PLAN'); assert.equal(t.plan, 'INVESTIMENTOS'); assert.equal(t.macro, 'VARIÁVEL');
    assert.equal(await scalar("SELECT macro r FROM public.payable_plan_mappings WHERE plan='INVESTIMENTOS'"), 'VARIÁVEL');
  });
  await test('an absent ordinary title receives only operational Pago and no financial receipt', async () => {
    await baseline([row('KEEP'), row('ORDINARY-MISSING', 31000)]); const before = await financialState(), result = await commit(await frozen([row('KEEP')]));
    assert.equal(result.marked_paid_count, 1); assert.equal(result.paid_count, 0); assert.equal(result.payment_cents, 0); assert.equal(result.payments_created, 0);
    const t = await assertStatusPaid('ORDINARY-MISSING', 31000); assert.equal(date(t.due_date), yesterday); assert.equal(t.bank_account, bankLabel); assert.deepEqual(await financialState(), before);
  });
  await test('an absent numbered cheque does not require or fabricate a F2G bank payment', async () => {
    await baseline([row('KEEP'), cheque('CHEQUE-MISSING', 47000, { bank_account: 'CAIXA INTERNO' })]);
    await owner(); await db.exec("UPDATE public.bank_accounts SET enabled=false WHERE display_name='BRADESCO F2G'"); await actor();
    const p = await preview([row('KEEP')]); assert.equal(p.can_commit, true); assert.deepEqual(p.exceptions, []);
    await commit(await frozen([row('KEEP')])); const t = await assertStatusPaid('CHEQUE-MISSING', 47000); assert.equal(t.bank_account, 'CAIXA INTERNO'); assert.equal(t.cheque_number, '000CHEQUE-MISSING');
  });
  await test('future maturity never creates a guessed actual payment date', async () => {
    await baseline([row('KEEP'), row('FUTURE-MISSING', 42000, { due_date: tomorrow })]);
    const p = await preview([row('KEEP')]); assert.equal(p.can_commit, true); assert.deepEqual(p.exceptions, []);
    await commit(await frozen([row('KEEP')])); assert.equal(date((await assertStatusPaid('FUTURE-MISSING', 42000)).due_date), tomorrow);
  });
  await test('Caixa Interno absence has operational Pago without inventing an account or actual payment', async () => {
    await baseline([row('KEEP'), row('CASH-MISSING', 64000, { bank_account: 'CAIXA INTERNO' })]);
    const p = await preview([row('KEEP')]); assert.equal(p.can_commit, true); assert.deepEqual(p.exceptions, []);
    await commit(await frozen([row('KEEP')])); assert.equal((await assertStatusPaid('CASH-MISSING', 64000)).bank_account, 'CAIXA INTERNO');
  });
  await test('operational Pago leaves projections and reconciliation pending totals without entering realized totals', async () => {
    await baseline([row('KEEP', 5000), row('SUMMARY-MISSING', 40000), row('SUMMARY-FUTURE', 30000, { due_date: tomorrow })]);
    const before = await scalar('SELECT public.payables_management_summary(NULL::date,NULL::date) r');
    const forecastBefore = await scalar('SELECT public.payables_forecast(NULL::date) r');
    await commit(await frozen([row('KEEP', 5000)])); const t = await assertStatusPaid('SUMMARY-MISSING', 40000);
    const after = await scalar('SELECT public.payables_management_summary(NULL::date,NULL::date) r');
    assert.equal(after.pending_reconciliation_count, before.pending_reconciliation_count); assert.equal(after.overdue_cents, before.overdue_cents - 40000); assert.equal(after.future_cents, before.future_cents - 30000); assert.equal(after.planned_week_cents, before.planned_week_cents); assert.equal(after.paid_week_cents, before.paid_week_cents); assert.equal(after.monthly_paid_cents, before.monthly_paid_cents);
    const actual = await scalar('SELECT public.payable_payment_summary($1,$2) r', [today, tomorrow]); assert.equal(actual.total_paid_cents, 0);
    assert.equal(t.closing_eligible, true);
    const forecastAfter = await scalar('SELECT public.payables_forecast(NULL::date) r');
    const total = report => report.weeks.reduce((sum, week) => sum + week.real_cents, 0); assert.equal(total(forecastAfter), total(forecastBefore) - 70000);
  });
  await test('monthly closing accepts the distinct report-paid status while retaining a zero actual paid total', async () => {
    await baseline([row('MONTHLY-STATUS', 63000, { due_date: closingMonth })]); await commit(await frozen([row('OUTSIDE-MONTH', 5000)]));
    const status = await scalar('SELECT public.payables_month_status($1) r', [closingMonth]); assert.equal(status.pending_count, 0); assert.equal(status.can_close, true, JSON.stringify(status)); assert.equal(status.total_paid_cents, 0);
    const id = await scalar('SELECT public.close_payables_month($1,$2,$3) r', [closingMonth, 'Fechamento operacional sintético por relatório', status.revision]);
    const closure = await scalar('SELECT public.read_payable_month_closure($1) r', [id]); assert.equal(closure.total_paid_cents, 0); assert.equal(closure.total_titles, 1); assert.equal(closure.snapshot.titles[0].review_status, 'PAGO_POR_RELATORIO'); assert.equal(closure.snapshot.titles[0].paid_cents, 0);
  });
  await test('a report-paid title reappears automatically under the same identity and appends an OPEN history event', async () => {
    await baseline([row('KEEP'), row('RETURN', 32000)]); await commit(await frozen([row('KEEP')])); const oldTitle = await title('RETURN');
    const sourceRows = [row('KEEP'), row('RETURN', 35000, { due_date: tomorrow })], p = await preview(sourceRows); assert.equal(p.can_commit, true); assert.equal(p.reopened_count, 1); assert.deepEqual(p.exceptions, []);
    const result = await commit(await frozen(sourceRows)); assert.equal(result.reopened_count, 1);
    const t = await title('RETURN'); assert.equal(t.id, oldTitle.id); assert.equal(t.status, 'OPEN'); assert.equal(t.report_paid, false); assert.equal(t.financial_status, 'OPEN'); assert.equal(t.payment_remaining_cents, 35000); assert.equal(t.amount_cents, 35000);
    assert.deepEqual((await events(t.id)).map(e => e.event_type), ['PAID','REOPEN']);
  });
  await test('automatic source corrections never rewrite or reverse a genuine actual payment', async () => {
    await baseline([row('KEEP'), row('GENUINE-PAYMENT', 20000)]); const oldTitle = await title('GENUINE-PAYMENT'); await actualPayment(oldTitle); const before = await financialState();
    const sourceRows = [row('KEEP'), row('GENUINE-PAYMENT', 25000, { due_date: tomorrow })], p = await preview(sourceRows); assert.equal(p.can_commit, true); assert.deepEqual(p.exceptions, []);
    await commit(await frozen(sourceRows)); const t = await title('GENUINE-PAYMENT'); assert.equal(t.id, oldTitle.id); assert.equal(t.amount_cents, 25000); assert.equal(t.paid_cents, 20000); assert.equal(date(t.due_date), tomorrow); assert.deepEqual(await financialState(), before);
  });
  await test('absence preserves previous genuine financial payments rather than generating a second one', async () => {
    await baseline([row('KEEP'), row('ALREADY-PAID', 19000)]); await actualPayment(await title('ALREADY-PAID')); const before = await financialState();
    await commit(await frozen([row('KEEP')])); const t = await title('ALREADY-PAID'); assert.equal(t.paid_cents, 19000); assert.equal(t.financial_status, 'PAID'); assert.deepEqual(await financialState(), before);
  });
  for (const [sourceAmount, expectedStatus] of [[25000,'PARTIAL'],[15000,'OVERPAID']]) await test(`report disappearance and reappearance preserve the actual ${expectedStatus} ledger`, async () => {
    await baseline([row('KEEP'), row('REAL-DIFFERENCE', 20000)]); await actualPayment(await title('REAL-DIFFERENCE'));
    await commit(await frozen([row('KEEP'), row('REAL-DIFFERENCE', sourceAmount)])); const before = await financialState();
    assert.equal((await title('REAL-DIFFERENCE')).financial_status, expectedStatus);
    await commit(await frozen([row('KEEP')])); let t = await title('REAL-DIFFERENCE');
    assert.equal(t.financial_status, expectedStatus); assert.equal(t.report_paid, true); assert.equal(t.payment_remaining_cents, 0); assert.equal(t.outstanding_cents, 0); assert.equal(t.paid_cents, 20000); assert.deepEqual(await financialState(), before);
    await commit(await frozen([row('KEEP'), row('REAL-DIFFERENCE', 27000, { due_date: tomorrow })])); t = await title('REAL-DIFFERENCE');
    assert.equal(t.report_paid, false); assert.equal(t.financial_status, 'PARTIAL'); assert.equal(t.payment_remaining_cents, 7000); assert.equal(t.paid_cents, 20000); assert.equal(date(t.due_date), tomorrow); assert.deepEqual(await financialState(), before);
  });
  await test('a preserved 060 inferred actual payment is never undone or converted into a status-only receipt', async () => {
    async function legacy060(sourceRows) {
      await owner(); const p = await scalar('SELECT public.preview_payables_unified_report($1,$2::jsonb,\'ALL\',$3::jsonb,\'{}\',\'{}\',false) r', [scope, JSON.stringify(sourceRows), JSON.stringify(mappings)]), o = original();
      assert.equal(p.can_commit, true, JSON.stringify(p));
      const result = await scalar('SELECT public.commit_payables_unified_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,\'ALL\',$8::jsonb,\'{}\',\'{}\',$9,$10,$11::date,$12,false) r', [users.manager.id, users.manager.session, scope, o.name, o.hash, o.base64, JSON.stringify(sourceRows), JSON.stringify(mappings), p.previous_import_id, p.financial_revision, p.report_date, randomUUID()]); await actor(); return result;
    }
    await legacy060([row('KEEP'), row('LEGACY060-PAID', 21000)]); const paid = await legacy060([row('KEEP')]); assert.equal(paid.paid_count, 1); const before = await financialState(), t = await title('LEGACY060-PAID'); assert.equal(t.paid_cents, 21000);
    await owner(); await repeat061WithinTest(); await actor(); assert.deepEqual(await financialState(), before);
    const p = await preview([row('KEEP'), row('NEW061', 4200)]); assert.equal(p.baseline_only, false, 'The latest060 ALL position remains the initial061 comparison head'); await commit(await frozen([row('KEEP'), row('NEW061', 4200)])); assert.deepEqual(await financialState(), before); assert.equal((await title('LEGACY060-PAID')).paid_cents, 21000);
  });
  await test('an exact completed protocol is replayed without duplicating source files or status events', async () => {
    await baseline([row('KEEP'), row('MISSING', 27000)]); const request = await frozen([row('KEEP')]), result = await commit(request), before = await state();
    const replay = await commit(request); assert.equal(replay.idempotent, true); assert.equal(replay.report_id, result.report_id); assert.deepEqual(await state(), before);
    await rejects(() => commit({ ...request, rows: [row('KEEP', 20000)] }), '22023'); assert.deepEqual(await state(), before);
  });
  await test('the same current-head bytes create a fresh position without duplicating a preserved artifact or event', async () => {
    await baseline([row('KEEP'), row('MISSING', 27000)]); const request = await frozen([row('KEEP')]), result = await commit(request), before = await state();
    const fresh = await commit(await frozen(request.rows, { original: request.original })); assert.notEqual(fresh.report_id, result.report_id); assert.equal(fresh.import_id, result.import_id); assert.equal(fresh.marked_paid_count, 0);
    const after = await state(); assert.deepEqual(after['public.payable_imports'], before['public.payable_imports']); assert.deepEqual(after['cf_private.payable_import_files'], before['cf_private.payable_import_files']); assert.deepEqual(after['public.payable_report_status_events'], before['public.payable_report_status_events']); assert.deepEqual(after['public.payable_payments'], before['public.payable_payments']); assert.equal(after['cf_private.payable_daily_reports'].length, before['cf_private.payable_daily_reports'].length + 1);
  });
  await test('older non-head bytes cannot roll back a later report under a new request', async () => {
    const first = await frozen([row('KEEP'), row('MISSING', 28000)]); await commit(first); await commit(await frozen([row('KEEP', 17000)]));
    const older = await frozen(first.rows, { original: first.original }), before = await state(); await rejects(() => commit(older), '23505'); assert.deepEqual(await state(), before);
  });
  await test('stale report-head, source revision and official-date proofs are rejected atomically', async () => {
    await baseline([row('KEEP'), row('MISSING', 18000)]); const stale = await frozen([row('KEEP')]); await commit(await frozen([row('KEEP'), row('MISSING', 18000), row('NEW-HEAD', 4000)]));
    const before = await state(); await rejects(() => commit(stale), '40001'); assert.deepEqual(await state(), before);
    const changedDate = await frozen([row('KEEP')]); changedDate.preview.report_date = yesterday; await rejects(() => commit(changedDate), '40001'); assert.deepEqual(await state(), before);
    const sourceStale = await frozen([row('KEEP')]); await owner(); await db.exec("UPDATE public.payable_titles SET description='Fonte alterada durante a preparação' WHERE entry_number='KEEP'"); await actor(); const changed = await state(); await rejects(() => commit(sourceStale), '40001'); assert.deepEqual(await state(), changed);
  });
  await test('verified approved sessions and CP import permission are required even for a prepared request', async () => {
    const request = await frozen([row('KEEP')]), before = await state(); await rejects(() => commit(request, 'manager', randomUUID()), '42501');
    for (const user of ['director','cr','rh','collector']) { await actor(user); await rejects(() => preview([row('KEEP')]), '42501'); await rejects(() => commit(request, user), '42501'); }
    assert.deepEqual(await state(), before);
  });
  await test('each R$0.01 marker requires explicit writeoff and remains outside financial sums', async () => {
    await baseline([row('KEEP'), row('CENT-NOMINAL', 73000)]); const sourceRows = [row('KEEP'), row('CENT-NOMINAL', 1), row('CENT-NEW', 1)], p = await preview(sourceRows);
    assert.equal(p.can_commit, false); assert.equal(p.exceptions.length, 2); assert(p.exceptions.every(e => e.kind === 'CENT'));
    const choices = Object.fromEntries(p.exceptions.map(item => [item.key, { action: 'WRITE_OFF', reason: 'Marcador de um centavo individualmente conferido sem pagamento' }]));
    assert.equal((await preview(sourceRows, { choices })).can_commit, true);
    const result = await commit(await frozen(sourceRows, { choices })); assert.equal(result.written_off_count, 2); assert.equal(result.paid_count, 0); assert.equal(result.payment_cents, 0);
    assert.equal((await title('CENT-NOMINAL')).amount_cents, 73000); assert.equal((await title('CENT-NOMINAL')).financial_status, 'ADMIN_WRITEOFF'); assert.equal((await title('CENT-NEW')).paid_cents, 0);
  });
  await test('a repeated already-confirmed one-cent marker does not duplicate a writeoff or require a second closure', async () => {
    await baseline([row('KEEP'), row('CENT-REPEAT', 87000)]); const sourceRows = [row('KEEP'), row('CENT-REPEAT', 1)], p = await preview(sourceRows), key = p.exceptions[0].key;
    const choices = { [key]: { action: 'WRITE_OFF', reason: 'Primeira confirmação individual do marcador' } }, first = await frozen(sourceRows, { choices }); await commit(first); const before = await state();
    const repeated = await preview(sourceRows); assert.equal(repeated.can_commit, true); assert.equal(repeated.exceptions[0].requires_resolution, false); assert.deepEqual(repeated.exceptions[0].allowed_actions, []);
    await commit(await frozen(sourceRows, { original: first.original }));
    const after = await state(); assert.deepEqual(after['public.payable_administrative_writeoffs'], before['public.payable_administrative_writeoffs']); assert.deepEqual(after['public.payable_payments'], before['public.payable_payments']);
  });
  await test('a report-paid title returning as a one-cent marker requires its own nonfinancial closure without overlapping states', async () => {
    await baseline([row('KEEP'), row('STATUS-TO-CENT', 42000)]); await commit(await frozen([row('KEEP')])); const sourceRows = [row('KEEP'), row('STATUS-TO-CENT', 1)], p = await preview(sourceRows);
    assert.equal(p.can_commit, false); assert.equal(p.exceptions.length, 1); const choices = { [p.exceptions[0].key]: { action: 'WRITE_OFF', reason: 'Retorno como marcador de um centavo conferido sem pagamento' } }; await commit(await frozen(sourceRows, { choices }));
    const t = await title('STATUS-TO-CENT'); assert.equal(t.report_paid, false); assert.equal(t.financial_status, 'ADMIN_WRITEOFF'); assert.equal(t.amount_cents, 42000); assert.equal(t.paid_cents, 0); assert.deepEqual((await events(t.id)).map(e => e.event_type), ['PAID','REOPEN']);
  });
  await test('authoritative per-title rounding retains Brazilian source text and physical file line through every proof', async () => {
    const header = 'Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Filial;Emissão;Banco;Situação;Cheque: número';
    const source = `${header}\r\n\r\nROUND-CSV;Fornecedor sintético;${tomorrow};23,345;${plan};${branch};${yesterday};CAIXA INTERNO;ABERTO;\r\n`;
    const parsed = validatePayableDailyRows(parseCsv(source), { roundProvisionedAmounts: true }); assert.deepEqual(parsed.errors, []); assert.equal(parsed.rows[0].amount_cents, 2335); assert.deepEqual(parsed.rounding_adjustments, [{ line: 3, original_amount: '23,345', amount_cents: 2335 }]);
    const request = await frozen(parsed.rows, { rounding: parsed.rounding_adjustments, original: original(source) }); assert.equal(request.preview.can_commit, true); const result = await commit(request); assert.deepEqual(result.rounding_adjustments, parsed.rounding_adjustments); assert.equal((await title('ROUND-CSV')).amount_cents, 2335);
  });
  await test('currency grouping and a positive sub-cent amount use the same exact rounding proof across parser SQL and gateway', async () => {
    const header = 'Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Filial;Emissão;Banco;Situação;Cheque: número';
    const source = `${header}\r\nROUND-BR;Fornecedor sintético;${tomorrow};R$ 1.234,567;${plan};${branch};${yesterday};CAIXA INTERNO;ABERTO;\r\nROUND-ZERO;Fornecedor sintético;${tomorrow};0,0000001;${plan};${branch};${yesterday};CAIXA INTERNO;ABERTO;\r\n`;
    const parsed = validatePayableDailyRows(parseCsv(source), { roundProvisionedAmounts: true }); assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.rounding_adjustments, [{ line: 2, original_amount: 'R$ 1.234,567', amount_cents: 123457 }, { line: 3, original_amount: '0,0000001', amount_cents: 0 }]);
    const request = await frozen(parsed.rows, { rounding: parsed.rounding_adjustments, original: original(source) }), result = await commit(request); assert.deepEqual(result.rounding_adjustments, parsed.rounding_adjustments); assert.equal((await title('ROUND-BR')).amount_cents, 123457); assert.equal((await title('ROUND-ZERO')).amount_cents, 0);
    // A native XLSX number can stringify exponentially; scientific CSV text is
    // intentionally refused by the production parser.
    const matrix = parseCsv(source); matrix[2][3] = 1e-7;
    const numeric = validatePayableDailyRows(matrix, { roundProvisionedAmounts: true }); assert.deepEqual(numeric.errors, []); assert.deepEqual(numeric.rounding_adjustments[1], { line: 3, original_amount: '1e-7', amount_cents: 0 });
    await commit(await frozen(numeric.rows, { rounding: numeric.rounding_adjustments, original: original('Planilha sintética com valor numérico nativo 1e-7') }));
  });
  await test('a corrected real amount automatically reopens an administrative marker while preserving its history', async () => {
    const sourceRows = [row('CENT-RETURN', 1)], p = await preview(sourceRows), choices = { [p.exceptions[0].key]: { action: 'WRITE_OFF', reason: 'Marcador conferido para baixa administrativa' } }; await commit(await frozen(sourceRows, { choices }));
    await owner(); const before = await rows('public.payable_administrative_writeoffs'); await actor();
    const restored = [row('CENT-RETURN', 17000)], next = await preview(restored); assert.equal(next.can_commit, true); assert.deepEqual(next.exceptions, []); await commit(await frozen(restored));
    const t = await title('CENT-RETURN'); assert.equal(t.amount_cents, 17000); assert.equal(t.financial_status, 'OPEN'); assert.equal(t.payment_remaining_cents, 17000); await owner(); const after = await rows('public.payable_administrative_writeoffs'); await actor(); assert(after.length > before.length); assert.deepEqual(after.filter(e => before.some(prior => prior.id === e.id)), before);
  });
  await test('an explicit header-only report marks prior members paid once and keeps older unrelated titles untouched', async () => {
    await baseline([row('EMPTY-ORDINARY', 19000), cheque('EMPTY-CHEQUE', 29000)]); await rejects(() => preview([], { map: {} }), '22023');
    const request = await frozen([], { empty: true, original: emptyOriginal() }); assert.equal(request.preview.marked_paid_count, 2); const result = await commit(request); assert.equal(result.row_count, 0); assert.equal(result.marked_paid_count, 2); assert.equal(result.payment_cents, 0);
    await db.exec('SET CONSTRAINTS ALL IMMEDIATE'); const before = await state(); assert.equal((await commit(request)).idempotent, true); assert.deepEqual(await state(), before);
    await assertStatusPaid('EMPTY-ORDINARY', 19000); await assertStatusPaid('EMPTY-CHEQUE', 29000); assert.equal((await title('LEGACY-UNOWNED')).report_paid, false);
  });
  await test('an empty first report establishes only a baseline and requires the strict empty declaration', async () => {
    await rejects(() => preview([], { kind: 'NORMAL', empty: true, map: {} }), '22023'); await rejects(() => preview([row('KEEP')], { empty: true }), '22023');
    const request = await frozen([], { empty: true, original: emptyOriginal() }); assert.equal(request.preview.baseline_only, true); const result = await commit(request); assert.equal(result.marked_paid_count, 0); await db.exec('SET CONSTRAINTS ALL IMMEDIATE'); assert.equal((await title('LEGACY-UNOWNED')).report_paid, false);
  });
  await test('an orphan empty preserved import cannot bypass the deferred protocol proof', async () => {
    const before = await state(); await rejects(async () => { await owner(); await db.query("INSERT INTO public.payable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode) VALUES($1,'orphan-status.csv',repeat('f',64),$2,0,0,0,0,'FORECAST')", [scope, users.manager.id]); await db.exec('SET CONSTRAINTS ALL IMMEDIATE'); }, '22023'); assert.deepEqual(await state(), before);
  });
  await test('preserved original bytes and their hash must match before any source or status change', async () => {
    const request = await frozen([row('KEEP')]), before = await state(); request.original = { ...request.original, hash: 'd'.repeat(64) }; await rejects(() => commit(request), '22023'); assert.deepEqual(await state(), before);
  });
  await test('late audit failure rolls back the preserved file, source changes, status events and every protocol proof', async () => {
    await baseline([row('KEEP'), row('ATOMIC-MISSING', 57000)]); const request = await frozen([row('KEEP', 29000), row('ATOMIC-NEW', 2500, { plan: 'PLANO ATOMICO INEDITO' })], { map: {} }), before = await state();
    await owner(); await db.exec("ALTER TABLE public.audit_events ADD CONSTRAINT synthetic_reject_status CHECK(entity<>'PAYABLE_REPORT_STATUS_IMPORT') NOT VALID"); await actor();
    await rejects(() => commit(request), '23514'); await owner(); await db.exec('ALTER TABLE public.audit_events DROP CONSTRAINT synthetic_reject_status'); await actor(); assert.deepEqual(await state(), before);
  });
  await test('report status history is append-only and neither service nor authenticated clients can forge it', async () => {
    await baseline([row('KEEP'), row('IMMUTABLE', 19000)]); await commit(await frozen([row('KEEP')])); const t = await title('IMMUTABLE'), before = await state();
    await rejects(() => db.query("UPDATE public.payable_report_status_events SET reason='Alteração indevida' WHERE title_id=$1", [t.id]), '42501');
    await rejects(async () => { await owner(); await db.query("DELETE FROM public.payable_report_status_events WHERE title_id=$1", [t.id]); }, '42501');
    await rejects(async () => { await owner(); await db.exec('SET ROLE service_role'); await db.query("DELETE FROM public.payable_report_status_events WHERE title_id=$1", [t.id]); }, '42501'); assert.deepEqual(await state(), before);
  });
  await test('CP reconciliation preserves every other module, identity, official bank and treasury balance', async () => {
    const before = await f.snapshot(); await actor(); await baseline([row('KEEP'), row('ISOLATED', 35000)]); await commit(await frozen([row('KEEP', 17000), row('NEW', 4100)])); const after = await f.snapshot(); await actor();
    const mutable = /^(public\.payable_|cf_private\.payable_)/;
    for (const [name, value] of Object.entries(before)) if (!mutable.test(name) && name !== 'public.audit_events' && name !== 'public.payable_plan_mappings') assert.deepEqual(after[name], value, 'Unrelated table remains byte exact: ' + name);
  });
  await test('CP-only reset and restore preserve exact status history, actual ledger and trigger modes without touching other areas', async () => {
    await baseline([row('RESET-KEEP'), row('RESET-STATUS', 39000)]); await commit(await frozen([row('RESET-KEEP')])); await commit(await frozen([row('RESET-KEEP'), row('RESET-STATUS', 41000)])); await commit(await frozen([row('RESET-KEEP')]));
    const before = await f.snapshot(), financialBefore = await financialState(); await owner(); const modes = await triggerModes();
    await db.exec(resetBody);
    for (const name of resetScope.targets) if (await scalar('SELECT to_regclass($1)::text r', [name])) assert.equal(await scalar(`SELECT count(*)::int r FROM ${name}`), 0, name);
    const reset = await f.snapshot(); for (const [name, value] of Object.entries(before)) if (!resetScope.targets.includes(name) && !resetScope.revision_states.includes(name) && name !== 'public.audit_events') assert.deepEqual(reset[name], value, name);
    assert.deepEqual(await triggerModes(), modes); await db.exec(restoreBody); const restored = await f.snapshot();
    for (const name of resetScope.targets) if (Object.hasOwn(before, name)) assert.deepEqual(restored[name], before[name], name);
    assert.deepEqual(await financialState(), financialBefore); await owner(); assert.deepEqual(await triggerModes(), modes);
  });
  await test('a pre061 empty status manifest remains restorable but any new report status or financial revision blocks overwrite', async () => {
    const before = await f.snapshot(); await owner(); await db.exec(resetBody);
    const backup = await scalar("SELECT backup_schema r FROM cf_operations.base_resets WHERE operation_key='cp-restart-2026-10-30-v1'"); assert.match(backup, /^cf_payable_backup_[0-9a-f]{32}$/);
    await db.query(`DELETE FROM "${backup}"._tables WHERE relation_name='public.payable_report_status_events'`);
    await db.exec("UPDATE cf_operations.base_resets SET counts=counts-'public.payable_report_status_events' WHERE operation_key='cp-restart-2026-10-30-v1'");
    await db.exec('SAVEPOINT new_official_status'); await actor(); await baseline([row('OFFICIAL-KEEP'), row('OFFICIAL-MISSING', 28000)]); await commit(await frozen([row('OFFICIAL-KEEP')])); const official = await state();
    await rejects(async () => { await owner(); await db.exec(restoreBody); }, '23514'); assert.deepEqual(await state(), official); await db.exec('ROLLBACK TO SAVEPOINT new_official_status; RELEASE SAVEPOINT new_official_status');
    await owner(); await db.exec('SAVEPOINT new_financial_revision'); await db.exec('UPDATE cf_private.payable_payment_state SET revision=revision+1'); const changed = await state();
    await rejects(async () => { await owner(); await db.exec(restoreBody); }, '23514'); assert.deepEqual(await state(), changed); await db.exec('ROLLBACK TO SAVEPOINT new_financial_revision; RELEASE SAVEPOINT new_financial_revision');
    await owner(); await db.exec(restoreBody); const restored = await f.snapshot(); for (const name of resetScope.targets) if (Object.hasOwn(before, name)) assert.deepEqual(restored[name], before[name], name);
  });
  await test('the complete SQL Editor installer is byte exact and repeated activation preserves source and financial history', async () => {
    const installer = await buildPayableOpenStatusSql(); assert.equal(await readFile(new URL('../supabase/dashboard/ativar-status-relatorio-contas-pagar.sql', import.meta.url), 'utf8'), installer);
    await baseline([row('INSTALL-KEEP'), row('INSTALL-MISSING', 23000)]); await commit(await frozen([row('INSTALL-KEEP')])); const before = await state();
    await owner(); const withinTest = installer.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''); await db.exec(withinTest); await db.exec(withinTest); await actor(); assert.deepEqual(await state(), before);
    assert.equal(await scalar("SELECT has_function_privilege('service_role','public.commit_payables_unified_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,uuid,text,date,uuid,boolean)','EXECUTE') r"), false);
  });
  if (failures.length) { process.exitCode = 1; for (const failure of failures) console.error(failure.error.stack); }
  console.log(`${passed} passed, ${failures.length} failed (status-only daily payable report 061, synthetic local PostgreSQL)`);
} catch (error) { console.error('FAIL', error.message, error.code ?? '', error.where ?? '', error.stack); process.exitCode = 1; }
finally { await db.close(); }
