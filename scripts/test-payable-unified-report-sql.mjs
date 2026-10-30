import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildPayableUnifiedReportSql } from './bundle-payable-unified-report.mjs';
import { validDailyPreview, validDailyCommit } from '../supabase/functions/payables-import/daily-reconciliation.mjs';

// Compare real PostgreSQL results with the production browser's proof guards.
// Build into memory only; no browser, network, credentials or published bundle.
const browserBuild = await build({ entryPoints: [new URL('../src/lib/payable-daily.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' }, loader: { '.css': 'empty' } });
const browserModule = { exports: {} };
new Function('require', 'module', 'exports', browserBuild.outputFiles[0].text)(createRequire(import.meta.url), browserModule, browserModule.exports);
const { validDailyCanonical, validDailyResult } = browserModule.exports;
const proofHash = 'e'.repeat(64);

// Disposable PostgreSQL. Every report, title, account and value is synthetic.
const f = await createCostFixture(), { db, users, owner, actor, scalar, file } = f;
const scope = 'grupo-consolidado', plan = 'PLANO UNICO SINTETICO', branch = 'FILIAL UNICA SINTETICA';
const mappings = { [plan]: 'FIXO' };
let passed = 0, sequence = 0, today, yesterday, tomorrow, bank, bankLabel, otherBank, chequeBank;
const freshnessConsumers = ['public.payables_summary(date,date)','public.payables_management_summary(date,date)','public.payables_forecast(date)'];
const consumerMetadata = new Map();
const metadata = signature => scalar("SELECT jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig,'strict',p.proisstrict,'volatile',p.provolatile,'parallel',p.proparallel,'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid)) r FROM pg_proc p WHERE p.oid=$1::regprocedure", [signature]);
const date = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const original = (content = `Relatório único sintético ${++sequence}`) => {
  const bytes = Buffer.from(content); return { name: `unico-${++sequence}.csv`, hash: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
};
const emptyOriginal = () => original('Lançamento;Histórico;Plano cp - Conta: nome;Plano cc - Conta: nome;Emissão: valor do lançamento;Emissão: data;Vencimento: data;Cheque: número;Filial\r\n');
const row = (entry_number, amount_cents = 10000, extra = {}) => ({ entry_number, amount_cents, branch, description: `Fornecedor sintético ${entry_number}`, due_date: yesterday, issued_on: yesterday, source_status: 'ABERTO', plan, bank_account: bankLabel, ...extra });
const cheque = (entry, amount = 20000, extra = {}) => row(entry, amount, { cheque_number: '000' + entry, ...extra });
const title = entry => scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1 AND branch=$2', [entry, branch]);
const tables = ['public.payable_titles','public.payable_imports','cf_private.payable_import_files','public.payable_payments','public.payable_payment_reversals','public.payable_title_reviews','public.payable_administrative_writeoffs','public.payable_import_modes','public.payable_paid_bank_mappings','cf_private.payable_import_resolution_requests','cf_private.payable_daily_reports','cf_private.payable_daily_requests','cf_private.payable_daily_actions','cf_private.payable_payment_state','cf_private.payable_control_state','public.audit_events','public.bank_accounts','public.bank_balance_positions','public.profiles','public.role_permissions'];
async function state() {
  await owner(); const out = {};
  for (const name of tables) out[name] = await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') r FROM ${name} t`);
  await actor(); return out;
}
async function test(name, run) {
  await owner(); await db.exec('BEGIN'); await actor();
  try { await run(); passed++; console.log('PASS', name); }
  finally { await db.exec('ROLLBACK'); await actor(); }
}
async function rejects(run, code) {
  await db.exec('SAVEPOINT expected_failure');
  try { await assert.rejects(run, error => { if (code) assert.equal(error.code, code, error.message); return true; }); }
  finally { await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure'); await actor(); }
}
async function preview(rows, { kind = 'ALL', choices = {}, banks = {}, map = mappings, empty = false } = {}) {
  const p = await scalar('SELECT public.preview_payables_unified_report($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) r', [scope, JSON.stringify(rows), kind, JSON.stringify(map), JSON.stringify(banks), JSON.stringify(choices), empty]);
  assert.equal(validDailyPreview(p, { sourceRows: rows, reportKind: kind, resolutionChoices: choices, emptyReportConfirmed: empty }), true, 'Actual SQL preview must satisfy gateway proof: ' + JSON.stringify(p));
  assert.equal(validDailyCanonical({ rows: p.rows, preview: p, file_sha256: proofHash }, proofHash, kind, empty), true, 'Actual SQL preview must satisfy browser proof: ' + JSON.stringify(p));
  return p;
}
async function frozen(rows, options = {}) {
  const config = { choices: {}, banks: {}, map: options.empty ? {} : mappings, kind: 'ALL', empty: false, ...options };
  const p = await preview(rows, config);
  return { rows, ...config, preview: p, original: options.original ?? original(), request: randomUUID() };
}
async function commit(request, user = 'manager', session = users[user].session) {
  await owner(); await db.exec('SET ROLE service_role');
  const p = request.preview, o = request.original;
  const result = await scalar('SELECT public.commit_payables_unified_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::date,$15,$16) r', [users[user].id, session, scope, o.name, o.hash, o.base64, JSON.stringify(request.rows), request.kind, JSON.stringify(request.map), JSON.stringify(request.banks), JSON.stringify(request.choices), p.previous_import_id, p.financial_revision, p.report_date, request.request, request.empty]);
  await actor();
  const body = { action: 'commit', mode: 'daily', daily_report_version: '060', report_kind: request.kind, file_name: o.name, file_base64: o.base64, mappings: request.map, bank_mappings: request.banks, resolution_choices: request.choices, complete: true, previous_import_id: p.previous_import_id, previous_financial_revision: p.financial_revision, expected_report_date: p.report_date, request_id: request.request, ...(request.empty ? { empty_report_confirmed: true } : {}) };
  assert.equal(validDailyCommit(result, { sourceRows: request.rows, request: body }), true, 'Actual SQL commit must satisfy gateway proof: ' + JSON.stringify(result));
  assert.equal(validDailyResult(result, body, request.rows.length), true, 'Actual SQL commit must satisfy browser proof: ' + JSON.stringify(result));
  return result;
}
const choice = (item, extra = {}) => ({ action: 'PAID', reason: 'Dados efetivos conferidos individualmente no relatório sintético', paid_on: yesterday, amount_paid_cents: item.payment_remaining_cents, bank_account_id: bank, ...extra });
async function baseline(rows) {
  const p = await preview(rows); assert.equal(p.baseline_only, true); assert.equal(p.missing_count, 0); assert.equal(p.can_commit, true, JSON.stringify(p.errors));
  return commit(await frozen(rows));
}
const actualBank = id => scalar('SELECT bank_account_id r FROM public.payable_effective_payments WHERE title_id=$1', [id]);

try {
  ({ today, yesterday, tomorrow } = (await db.query("SELECT d::text today,(d-1)::text yesterday,(d+1)::text tomorrow FROM(SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date d)s")).rows[0]);
  const account = (await db.query("SELECT id,display_name FROM public.bank_accounts WHERE enabled AND account_type='BANK' AND display_name<>'BRADESCO F2G' ORDER BY id LIMIT 1")).rows[0];
  bank = account.id; bankLabel = account.display_name;
  otherBank = await scalar("SELECT id r FROM public.bank_accounts WHERE enabled AND account_type='BANK' AND id<>$1 AND display_name<>'BRADESCO F2G' ORDER BY id LIMIT 1", [bank]);
  chequeBank = await scalar("SELECT id r FROM public.bank_accounts WHERE enabled AND account_type='BANK' AND display_name='BRADESCO F2G'"); assert(chequeBank);
  const old = original(); await owner(); await db.exec('SET ROLE service_role');
  await scalar('SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,NULL) r', [users.manager.id, users.manager.session, scope, old.name, old.hash, old.base64, JSON.stringify([row('LEGACY-UNOWNED', 45000)]), JSON.stringify(mappings)]);
  await owner(); for (const name of ['042_payable_administrative_writeoff.sql','043_payable_import_reconciliation.sql','050_paid_bank_rules.sql','058_payable_daily_reports.sql','059_payable_column_rules.sql']) await db.exec(await file(name)); await actor();
  const oldRevision = await scalar('SELECT public.get_payables_revision() r'), beforeInstall = await state();
  for (const name of freshnessConsumers) consumerMetadata.set(name, await metadata(name));
  await owner(); await db.exec(await file('060_payable_unified_report.sql')); await actor();

  await test('060 activation and repeated activation change policy metadata without rewriting financial history', async () => {
    assert.deepEqual(await state(), beforeInstall);
    for (const name of freshnessConsumers) assert.deepEqual(await metadata(name), consumerMetadata.get(name), 'Freshness consumer retains OID, owner, grants and execution settings: ' + name);
    const cap = await scalar('SELECT public.payables_import_capabilities() r'); assert.equal(cap.daily_report_version, '060');
    assert.notEqual((await scalar('SELECT public.get_payables_revision() r')).financial_revision, oldRevision.financial_revision);
    await owner(); await db.exec(await file('060_payable_unified_report.sql')); await actor(); assert.deepEqual(await state(), beforeInstall);
  });
  await test('obsolete public import writers are closed for API roles after the new policy is activated', async () => {
    const writes = (await db.query("SELECT p.oid::regprocedure::text name,has_function_privilege('service_role',p.oid,'EXECUTE') allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'commit_payables%' AND p.proname<>'commit_payables_unified_report_from_gateway'")).rows;
    assert(writes.length >= 4); assert(writes.every(item => item.allowed === false), JSON.stringify(writes));
    const request = await frozen([row('KEEP')]), p = request.preview, o = request.original, before = await state();
    await rejects(async () => { await owner(); await db.exec('SET ROLE service_role'); await scalar('SELECT public.commit_payables_daily_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::date,$15,$16) r', [users.manager.id, users.manager.session, scope, o.name, o.hash, o.base64, JSON.stringify(request.rows), 'NORMAL', JSON.stringify(request.map), '{}', '{}', p.previous_import_id, p.financial_revision, p.report_date, request.request, false]); }, '42501');
    assert.deepEqual(await state(), before);
  });
  await test('the CP operator can establish and reconcile the same unified report without management-only access', async () => {
    await actor('cp'); const rows = [row('CP-KEEP'), cheque('CP-MISSING', 24000)], initial = await frozen(rows); await commit(initial, 'cp');
    await actor('cp'); const request = await frozen([row('CP-KEEP')]), result = await commit(request, 'cp'); assert.equal(result.paid_count, 1); assert.equal(result.payment_cents, 24000);
  });
  await test('first ALL report creates one mixed baseline and never adopts older absent titles', async () => {
    const rows = [row('KEEP'), cheque('NUMBERED', 23000), row('STATUS-CHEQUE', 17000, { source_status: 'CHEQUE' })], p = await preview(rows);
    assert.equal(p.daily_report_version, '060'); assert.equal(p.report_kind, 'ALL'); assert.equal(p.row_count, 3); assert.equal(p.new_count, 3); assert.equal(p.baseline_origin, 'FIRST_REPORT'); assert.equal(p.baseline_only, true); assert.equal(p.auto_payment_count, 0); assert.equal(p.empty_report_confirmed, false);
    const result = await baseline(rows); assert.equal(result.paid_count, 0); assert.equal(result.row_count, 3); assert.equal((await title('LEGACY-UNOWNED')).paid_cents, 0);
    await owner(); assert.equal(await scalar("SELECT count(*)::int r FROM cf_private.payable_daily_reports WHERE report_kind='ALL'"), 1); await actor();
  });
  await test('one later mixed report updates known identities and settles absent ordinary and cheque members at their distinct dates', async () => {
    const rows = [row('KEEP'), row('ORDINARY-MISSING', 31000), cheque('CHEQUE-MISSING', 47000, { bank_account: 'CAIXA INTERNO' })];
    await baseline(rows); const keep = await title('KEEP');
    const next = [row('KEEP', 15555, { due_date: today, issued_on: yesterday, description: 'Descrição e parcela atualizadas' }), row('NEW', 8800)];
    const p = await preview(next); assert.equal(p.baseline_only, false); assert.equal(p.missing_count, 2); assert.equal(p.auto_payment_count, 2); assert.equal(p.auto_payment_cents, 78000); assert.equal(p.changed_count, 1);
    const ordinaryAction = p.automatic_actions.find(item => item.entry_number === 'ORDINARY-MISSING'), chequeAction = p.automatic_actions.find(item => item.entry_number === 'CHEQUE-MISSING');
    assert.equal(ordinaryAction.rule, 'DUE_DATE'); assert.equal(ordinaryAction.paid_on, yesterday); assert.equal(chequeAction.rule, 'IMPORT_DATE'); assert.equal(chequeAction.paid_on, today); assert.equal(chequeAction.bank_account_id, chequeBank);
    const result = await commit(await frozen(next)); assert.equal(result.paid_count, 2); assert.equal(result.payment_cents, 78000); assert.equal(result.new_count, 1);
    const updated = await title('KEEP'); assert.equal(updated.id, keep.id); assert.equal(updated.amount_cents, 15555); assert.equal(date(updated.due_date), today); assert.equal(updated.description, 'Descrição e parcela atualizadas');
    const ordinary = await title('ORDINARY-MISSING'), paidCheque = await title('CHEQUE-MISSING'); assert.equal(ordinary.financial_status, 'PAID'); assert.equal(ordinary.review_status, 'CONCILIADO'); assert.equal(date(ordinary.last_payment_date), yesterday); assert.equal(date(paidCheque.last_payment_date), today); assert.equal(paidCheque.bank_account, 'CAIXA INTERNO'); assert.equal(await actualBank(paidCheque.id), chequeBank); assert.equal((await title('LEGACY-UNOWNED')).paid_cents, 0);
  });
  await test('status-only cheques use the import date without inventing a cheque number or forcing the numbered-cheque bank', async () => {
    await baseline([row('KEEP'), row('STATUS-MISSING', 22000, { source_status: 'CHEQUE' })]);
    const p = await preview([row('KEEP')]), item = p.automatic_actions[0]; assert.equal(item.rule, 'IMPORT_DATE'); assert.equal(item.paid_on, today); assert.equal(item.bank_account_id, bank); assert.equal(item.cheque_number, null);
    await commit(await frozen([row('KEEP')])); const t = await title('STATUS-MISSING'); assert.equal(t.cheque_number, null); assert.equal(date(t.last_payment_date), today);
  });
  await test('present and missing one-cent markers require individual nonfinancial closure', async () => {
    await baseline([row('KEEP'), row('NOMINAL-CENT', 73000)]);
    const rows = [row('KEEP'), row('NOMINAL-CENT', 1), row('NEW-CENT', 1, { bank_account: 'CAIXA INTERNO', cheque_number: '000001' })], p = await preview(rows);
    assert.equal(p.can_commit, false); assert.equal(p.exceptions.length, 2);
    const decisions = Object.fromEntries(p.exceptions.map(item => [item.key, { action: 'WRITE_OFF', reason: 'Marcador de um centavo conferido individualmente sem pagamento' }]));
    const checked = await preview(rows, { choices: decisions }); assert.equal(checked.can_commit, true);
    const result = await commit(await frozen(rows, { choices: decisions })); assert.equal(result.written_off_count, 2); assert.equal(result.paid_count, 0); assert.equal(result.payment_cents, 0); assert.equal((await title('NOMINAL-CENT')).amount_cents, 73000); assert.equal((await title('NOMINAL-CENT')).financial_status, 'ADMIN_WRITEOFF'); assert.equal((await title('NEW-CENT')).paid_cents, 0);
    await owner(); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_payments'), 0); await actor();
  });
  await test('an absent one-cent marker cannot enter realized payment and cannot be silently closed', async () => {
    const first = [row('KEEP'), row('MISSING-CENT', 1)], pFirst = await preview(first), firstChoices = { [pFirst.exceptions[0].key]: { action: 'WRITE_OFF', reason: 'Confirmação inicial individual do marcador' } };
    await commit(await frozen(first, { choices: firstChoices }));
    const p = await preview([row('KEEP')]); assert.equal(p.missing_count, 0); assert.equal(p.auto_payment_count, 0); assert.equal(p.can_commit, true); assert.equal((await title('MISSING-CENT')).paid_cents, 0);
  });
  await test('ordinary Caixa Interno absence requires an actual account and remains a real payment', async () => {
    await baseline([row('KEEP'), row('CASH-MISSING', 64000, { bank_account: 'CAIXA INTERNO' })]);
    const p = await preview([row('KEEP')]), item = p.exceptions[0]; assert.equal(p.can_commit, false); assert.equal(item.kind, 'MISSING'); assert.deepEqual(item.allowed_actions, ['PAID']);
    const decisions = { [item.key]: choice(item, { bank_account_id: otherBank }) }, checked = await preview([row('KEEP')], { choices: decisions }); assert.equal(checked.can_commit, true);
    const result = await commit(await frozen([row('KEEP')], { choices: decisions })); assert.equal(result.paid_count, 1); assert.equal(result.payment_cents, 64000); assert.equal(result.written_off_count, 0); const t = await title('CASH-MISSING'); assert.equal(await actualBank(t.id), otherBank); assert.equal(t.bank_account, 'CAIXA INTERNO');
  });
  await test('future ordinary maturity needs an explicit actual date while ordinary actual-bank edits remain one-off', async () => {
    await baseline([row('KEEP'), row('FUTURE-MISSING', 42000, { due_date: tomorrow })]);
    const p = await preview([row('KEEP')]), item = p.exceptions[0]; assert.equal(p.can_commit, false); assert.equal(item.paid_on, tomorrow);
    const decisions = { [item.key]: choice(item, { paid_on: today, bank_account_id: otherBank }) };
    const checked = await preview([row('KEEP')], { choices: decisions }); assert.equal(checked.can_commit, true);
    await commit(await frozen([row('KEEP')], { choices: decisions })); const t = await title('FUTURE-MISSING'); assert.equal(date(t.last_payment_date), today); assert.equal(await actualBank(t.id), otherBank); assert.equal(t.bank_account, bankLabel);
    await owner(); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_paid_bank_mappings WHERE bank_account_id=$1', [otherBank]), 0); await actor();
  });
  await test('numbered cheque account cannot be overridden and missing official F2G cannot be guessed', async () => {
    await baseline([row('KEEP'), cheque('FIXED-CHEQUE', 33000)]);
    const p = await preview([row('KEEP')]), item = p.automatic_actions[0], wrong = { [item.key]: choice(item, { paid_on: today, bank_account_id: otherBank }) };
    assert.equal((await preview([row('KEEP')], { choices: wrong })).can_commit, false);
    await owner(); await db.query('UPDATE public.bank_accounts SET enabled=false WHERE id=$1', [chequeBank]); await actor();
    const missingBank = await preview([row('KEEP')]); assert.equal(missingBank.can_commit, false); assert.equal(missingBank.exceptions[0].bank_account_id, null);
  });
  await test('exact same protocol replays without duplication while a new protocol can record an unchanged latest report as a fresh position', async () => {
    await baseline([row('KEEP'), row('MISSING', 27000)]); const request = await frozen([row('KEEP')]), result = await commit(request), before = await state();
    const replay = await commit(request); assert.equal(replay.idempotent, true); assert.equal(replay.report_id, result.report_id); assert.deepEqual(await state(), before);
    await rejects(() => commit({ ...request, rows: [row('KEEP', 20000)] }), '22023'); assert.deepEqual(await state(), before);
    const revisionBefore = await scalar('SELECT public.get_payables_revision() r'), duplicate = await frozen([row('KEEP')], { original: request.original }), fresh = await commit(duplicate);
    assert.equal(fresh.idempotent, false); assert.notEqual(fresh.report_id, result.report_id); assert.equal(fresh.import_id, result.import_id); assert.equal(fresh.paid_count, 0); assert.equal(fresh.payment_cents, 0); assert.equal(fresh.new_count, 0); assert.equal(fresh.open_count, 1); assert.equal(fresh.changed_count, 0);
    const after = await state(); assert.deepEqual(after['public.payable_imports'], before['public.payable_imports']); assert.deepEqual(after['cf_private.payable_import_files'], before['cf_private.payable_import_files']); assert.deepEqual(after['public.payable_payments'], before['public.payable_payments']); assert.deepEqual(await scalar('SELECT public.get_payables_revision() r'), revisionBefore);
    assert.equal(after['cf_private.payable_daily_reports'].length, before['cf_private.payable_daily_reports'].length + 1);
    assert.notEqual((await preview([row('KEEP')])).financial_revision, duplicate.preview.financial_revision, 'A new unchanged head still invalidates an older preview');
    assert.equal((await commit(duplicate)).report_id, fresh.report_id); assert.deepEqual(await state(), after);
  });
  await test('an older non-head file cannot replace a later changed report even under a fresh protocol', async () => {
    const first = await frozen([row('KEEP'), row('MISSING', 28000)]); await commit(first);
    await commit(await frozen([row('KEEP', 17000), row('MISSING', 28000)]));
    const older = await frozen(first.rows, { original: first.original }), before = await state();
    await rejects(() => commit(older), '23505'); assert.deepEqual(await state(), before); assert.equal((await title('KEEP')).amount_cents, 17000);
  });
  await test('an unchanged head artifact cannot overwrite a subsequent manual source correction', async () => {
    const first = await frozen([row('KEEP'), cheque('MANUAL-CHANGE', 26000)]); await commit(first);
    await owner(); await db.query("UPDATE public.payable_titles SET amount_cents=27000,description='Descrição corrigida manualmente e preservada' WHERE entry_number=$1 AND branch=$2", ['MANUAL-CHANGE', branch]); await actor();
    const next = await frozen(first.rows, { original: first.original }), before = await state();
    await rejects(() => commit(next), '23505'); assert.deepEqual(await state(), before); assert.equal((await title('MANUAL-CHANGE')).amount_cents, 27000);
  });
  await test('an unchanged latest report refreshes all three source dates without changing amounts, original import timestamps or preserved bytes', async () => {
    async function reports() {
      return {
        summary: await scalar('SELECT public.payables_summary($1,$2) r', [yesterday, tomorrow]),
        management: await scalar('SELECT public.payables_management_summary(NULL::date,NULL::date) r'),
        forecast: await scalar('SELECT public.payables_forecast(NULL::date) r'),
      };
    }
    const fallback = await scalar("SELECT to_jsonb(created_at) r FROM public.payable_imports WHERE scope=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [scope]);
    for (const value of Object.values(await reports())) assert.equal(value.latest_import_at, fallback, 'Before the first ALL position the original import date remains available');
    const firstRequest = await frozen([row('FRESH-KEEP', 50000), cheque('FRESH-CHEQUE', 32000)]), first = await commit(firstRequest), before = await state(), priorReports = await reports();
    await owner(); const firstTime = await scalar("SELECT to_jsonb(created_at) r FROM cf_private.payable_daily_reports WHERE id=$1", [first.report_id]); await actor();
    for (const value of Object.values(priorReports)) assert.equal(value.latest_import_at, firstTime);
    const second = await commit(await frozen(firstRequest.rows, { original: firstRequest.original })), nextReports = await reports();
    await owner(); const latestTime = await scalar("SELECT to_jsonb(created_at) r FROM cf_private.payable_daily_reports WHERE id=$1", [second.report_id]); await actor();
    assert.notEqual(latestTime, firstTime); assert.notEqual(second.report_id, first.report_id); assert.equal(second.import_id, first.import_id);
    const stripDate = ({ latest_import_at, ...rest }) => rest;
    for (const [name, value] of Object.entries(nextReports)) { assert.equal(value.latest_import_at, latestTime); assert.deepEqual(stripDate(value), stripDate(priorReports[name]), name + ': only the freshness date changes'); }
    const after = await state(); assert.deepEqual(after['public.payable_imports'], before['public.payable_imports']); assert.deepEqual(after['cf_private.payable_import_files'], before['cf_private.payable_import_files']); assert.deepEqual(after['public.payable_payments'], before['public.payable_payments']);
    await owner(); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_imports WHERE id=$1', [first.import_id]), 1); await actor();
  });
  await test('a repeated one-cent head still needs individual confirmation and preserves the nominal and original administrative event', async () => {
    await baseline([row('KEEP'), row('CENT-REPEAT', 87000)]);
    const rows = [row('KEEP'), row('CENT-REPEAT', 1)], p = await preview(rows), key = p.exceptions[0].key, decisions = { [key]: { action: 'WRITE_OFF', reason: 'Marcador conferido individualmente antes de concluir a primeira baixa' } };
    const first = await frozen(rows, { choices: decisions }), result = await commit(first), before = await state();
    const unchecked = await preview(rows); assert.equal(unchecked.can_commit, false); assert.equal(unchecked.exceptions[0].selected_action, null);
    const uncheckedRequest = await frozen(rows, { original: first.original }); await rejects(() => commit(uncheckedRequest), 'P0060'); assert.deepEqual(await state(), before);
    const repeatedChoices = { [key]: { action: 'WRITE_OFF', reason: 'Marcador de um centavo reconferido individualmente no novo relatório diário' } }, repeated = await frozen(rows, { original: first.original, choices: repeatedChoices }), fresh = await commit(repeated);
    assert.equal(fresh.idempotent, false); assert.notEqual(fresh.report_id, result.report_id); assert.equal(fresh.import_id, result.import_id); assert.equal(fresh.paid_count, 0); assert.equal(fresh.payment_cents, 0); assert.equal((await title('CENT-REPEAT')).amount_cents, 87000);
    const after = await state(); assert.deepEqual(after['public.payable_administrative_writeoffs'], before['public.payable_administrative_writeoffs']); assert.deepEqual(after['public.payable_payments'], before['public.payable_payments']); assert.deepEqual(after['cf_private.payable_daily_actions'], before['cf_private.payable_daily_actions']);
  });
  await test('an explicit header-only ALL report settles every prior ordinary and cheque exactly once', async () => {
    await baseline([row('ORDINARY-EMPTY', 19000), cheque('CHEQUE-EMPTY', 29000)]);
    await rejects(() => preview([], { map: {} }), '22023');
    const p = await preview([], { empty: true, map: {} }); assert.equal(p.empty_report_confirmed, true); assert.equal(p.row_count, 0); assert.equal(p.missing_count, 2); assert.equal(p.auto_payment_count, 2); assert.equal(p.auto_payment_cents, 48000);
    const request = await frozen([], { empty: true, original: emptyOriginal() }), result = await commit(request); assert.equal(result.row_count, 0); assert.equal(result.paid_count, 2); assert.equal(result.payment_cents, 48000);
    await db.exec('SET CONSTRAINTS ALL IMMEDIATE'); const before = await state(); assert.equal((await commit(request)).idempotent, true); assert.deepEqual(await state(), before); assert.equal((await title('LEGACY-UNOWNED')).paid_cents, 0);
  });
  await test('an empty first report creates only its initial baseline and cannot sweep older titles', async () => {
    const request = await frozen([], { empty: true, original: emptyOriginal() }); assert.equal(request.preview.baseline_only, true); assert.equal(request.preview.missing_count, 0);
    const result = await commit(request); assert.equal(result.paid_count, 0); assert.equal(result.row_count, 0); await db.exec('SET CONSTRAINTS ALL IMMEDIATE'); assert.equal((await title('LEGACY-UNOWNED')).paid_cents, 0);
  });
  await test('the same empty artifact can be reused after a nonempty report without replaying an old position', async () => {
    const empty = emptyOriginal(), first = await commit(await frozen([], { empty: true, original: empty }));
    await commit(await frozen([row('NEW-AFTER-EMPTY', 61000), cheque('NEW-CHEQUE-AFTER-EMPTY', 41000)]));
    const next = await frozen([], { empty: true, original: empty }), result = await commit(next); assert.equal(result.paid_count, 2); assert.equal(result.payment_cents, 102000); assert.equal(result.import_id, first.import_id); assert.notEqual(result.report_id, first.report_id); await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  });
  await test('empty declaration is explicit, exclusive and cannot authorize a malformed channel or a nonempty file', async () => {
    await rejects(() => preview([], { kind: 'NORMAL', empty: true, map: {} }), '22023'); await rejects(() => preview([row('KEEP')], { empty: true }), '22023');
    await rejects(() => preview([row('KEEP')], { kind: 'CHEQUES' }), '22023');
    const before = await state(); await rejects(async () => { await owner(); await db.query("INSERT INTO public.payable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode) VALUES($1,'orphan-zero.csv',repeat('f',64),$2,0,0,0,0,'FORECAST')", [scope, users.manager.id]); await db.exec('SET CONSTRAINTS ALL IMMEDIATE'); }, '22023'); assert.deepEqual(await state(), before);
  });
  await test('a changed head or account registry invalidates a previously reviewed frozen request', async () => {
    await baseline([row('KEEP'), row('MISSING', 18000)]); const stale = await frozen([row('KEEP')]);
    await commit(await frozen([row('KEEP'), row('MISSING', 18000), row('NEW-HEAD', 4000)])); const before = await state(); await rejects(() => commit(stale), '40001'); assert.deepEqual(await state(), before);
    const accountStale = await frozen([row('KEEP'), row('MISSING', 18000), row('NEW-HEAD', 4000)]);
    await owner(); await db.query("UPDATE public.bank_accounts SET account_label=account_label||' atualizado sintético' WHERE id=$1", [bank]); await actor(); const changed = await state(); await rejects(() => commit(accountStale), '40001'); assert.deepEqual(await state(), changed);
  });
  await test('paid titles that reappear stay blocked instead of creating another debt or erasing the payment', async () => {
    await baseline([row('KEEP'), row('PAID-RETURN', 32000)]); await commit(await frozen([row('KEEP')]));
    const p = await preview([row('KEEP'), row('PAID-RETURN', 35000)]); assert.equal(p.can_commit, false); assert.equal(p.exceptions.find(item => item.entry_number === 'PAID-RETURN').kind, 'REAPPEARED'); assert.equal((await title('PAID-RETURN')).paid_cents, 32000);
  });
  await test('director and CR cannot preview or commit the unified report even with an approved session', async () => {
    const request = await frozen([row('KEEP')]), before = await state();
    for (const user of ['director','cr']) { await actor(user); await rejects(() => preview([row('KEEP')]), '42501'); await rejects(() => commit(request, user), '42501'); }
    assert.deepEqual(await state(), before);
  });
  await test('gateway commitment requires the verified approved session and preserves all rows when it is missing', async () => {
    const request = await frozen([row('KEEP')]), before = await state(); await rejects(() => commit(request, 'manager', randomUUID()), '42501'); assert.deepEqual(await state(), before);
  });
  await test('late audit failure rolls back source preservation, forecast updates, payments and reconciliation atomically', async () => {
    await baseline([row('KEEP'), row('ATOMIC-MISSING', 57000)]); const request = await frozen([row('KEEP', 29000)]), before = await state();
    await owner(); await db.exec("ALTER TABLE public.audit_events ADD CONSTRAINT synthetic_reject_unified CHECK(entity<>'payable_unified_report' AND entity<>'payable_daily_report') NOT VALID"); await actor();
    await rejects(() => commit(request), '23514'); await owner(); await db.exec('ALTER TABLE public.audit_events DROP CONSTRAINT synthetic_reject_unified'); await actor(); assert.deepEqual(await state(), before);
  });
  await test('the complete activation installer is byte exact and safe to repeat without reopening obsolete writers', async () => {
    const bundle = await buildPayableUnifiedReportSql();
    assert.equal(await readFile(new URL('../supabase/dashboard/ativar-relatorio-unico-contas-pagar.sql', import.meta.url), 'utf8'), bundle);
    await baseline([row('INSTALL-KEEP'), cheque('INSTALL-MISSING', 23000)]); await commit(await frozen([row('INSTALL-KEEP')])); const before = await state();
    await owner(); await db.exec(bundle); await db.exec(bundle); await actor(); assert.deepEqual(await state(), before);
    assert.equal(await scalar("SELECT has_function_privilege('service_role','public.commit_payables_daily_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,uuid,text,date,uuid,boolean)','EXECUTE') r"), false);
  });
  console.log(`${passed} passed (unified daily payable report 060, synthetic local PostgreSQL)`);
} catch (error) { console.error('FAIL', error.message, error.code ?? '', error.where ?? '', error.stack); process.exitCode = 1; }
finally { await db.close(); }
