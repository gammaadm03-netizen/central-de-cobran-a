import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { buildPayableColumnRulesSql } from './bundle-payable-column-rules.mjs';
import { validDailyPreview, validDailyCommit } from '../supabase/functions/payables-import/daily-reconciliation.mjs';

// Disposable local PostgreSQL; every customer, report, account and amount is synthetic.
const db = new PGlite();
// Exercise the actual browser contract guards against SQL output, without a
// browser, a published bundle, a network request, or an application login.
const uiBundle = await build({ entryPoints: [new URL('../src/lib/payable-daily.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' }, loader: { '.css': 'empty' } });
const uiModule = { exports: {} };
new Function('require', 'module', 'exports', uiBundle.outputFiles[0].text)(createRequire(import.meta.url), uiModule, uiModule.exports);
const { validDailyCanonical, validDailyResult } = uiModule.exports;
const syntheticHash = 'f'.repeat(64);
let passed = 0, sequence = 0, today, yesterday, tomorrow, bank, bankLabel, otherBank;
const ids = Array.from({ length: 4 }, (_, index) => `16000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const sessions = Array.from({ length: 4 }, (_, index) => `26000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const scope = 'grupo-consolidado', plans = { 'PLANO DIARIO SINTETICO': 'FIXO' };
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
const owner = () => db.exec('RESET ROLE');
async function actor(index = 0) {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [ids[index], JSON.stringify({ session_id: sessions[index] })]);
  await db.exec('SET ROLE authenticated');
}
const source = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
const reject = (run, code) => assert.rejects(run, error => { if (code) assert.equal(error.code, code, error.message); return true; });
const dateText = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const row = (entry_number, amount_cents = 10000, extra = {}) => ({ entry_number, amount_cents, plan: 'PLANO DIARIO SINTETICO', description: 'Fornecedor sintético ' + entry_number, branch: 'FILIAL SINTETICA', due_date: yesterday, issued_on: yesterday, source_status: 'ABERTO', bank_account: bankLabel, ...extra });
const cheque = (entry, amount = 20000, extra = {}) => row(entry, amount, { source_status: 'CHEQUE', cheque_number: '000' + entry, ...extra });
const file = () => { const bytes = Buffer.from(`Original sintético diário ${++sequence}`); return { name: `diario-${sequence}.csv`, sha: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }; };
const title = entry => scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1', [entry]);
async function preview(rows, kind = 'NORMAL', choices = {}, banks = {}, mappings = plans, empty = false) {
  const p = await scalar('SELECT public.preview_payables_daily_report($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) r', [scope, JSON.stringify(rows), kind, JSON.stringify(mappings), JSON.stringify(banks), JSON.stringify(choices), empty]);
  assert.equal(validDailyPreview(p, { sourceRows: rows, reportKind: kind, resolutionChoices: choices, emptyChequesConfirmed: empty }), true, 'Actual SQL preview must satisfy the gateway contract: ' + JSON.stringify(p));
  assert.equal(validDailyCanonical({ rows: p.rows, preview: p, file_sha256: syntheticHash }, syntheticHash, kind, empty), true, 'Actual SQL preview must satisfy the browser contract: ' + JSON.stringify(p));
  return p;
}
async function frozen(rows, kind = 'NORMAL', choices = {}, extra = {}) {
  const mappings = extra.mappings ?? (extra.empty ? {} : plans), empty = extra.empty ?? false;
  const p = await preview(rows, kind, choices, extra.banks ?? {}, mappings, empty);
  return { rows, kind, choices, banks: {}, mappings, empty, original: file(), previous: p.previous_import_id, financial: p.financial_revision, date: p.report_date, request: randomUUID(), ...extra };
}
async function commit(request, index = 0) {
  await owner(); await db.exec('SET ROLE service_role');
  try {
    const result = await scalar('SELECT public.commit_payables_daily_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::date,$15,$16) r', [ids[index], sessions[index], scope, request.original.name, request.original.sha, request.original.base64, JSON.stringify(request.rows), request.kind, JSON.stringify(request.mappings), JSON.stringify(request.banks), JSON.stringify(request.choices), request.previous, request.financial, request.date, request.request, request.empty ?? false]);
    const guardRequest = { report_kind: request.kind, expected_report_date: request.date, request_id: request.request, ...(request.kind === 'CHEQUES' ? { empty_cheques_confirmed: request.empty ?? false } : {}) };
    assert.equal(validDailyCommit(result, { sourceRows: request.rows, request: guardRequest }), true, 'Actual SQL result must satisfy the gateway contract: ' + JSON.stringify(result));
    const expectedRows = request.rows;
    assert.equal(validDailyResult(result, guardRequest, expectedRows.length), true, 'Actual SQL result must satisfy the browser contract: ' + JSON.stringify(result));
    return result;
  } finally { await actor(); }
}
async function normalRows() {
  const result = await db.query("SELECT t.* FROM public.payable_review_titles t WHERE t.closing_eligible AND t.payment_remaining_cents>0 AND upper(coalesce(trim(t.source_status),''))<>'CHEQUE' AND coalesce(trim(t.cheque_number),'')='' ORDER BY t.entry_number");
  return result.rows.map(item => row(item.entry_number, Number(item.amount_cents), { description: item.description, branch: item.branch, due_date: dateText(item.due_date), issued_on: item.issued_on ? dateText(item.issued_on) : null, source_status: item.source_status, bank_account: item.bank_account, cheque_number: item.cheque_number }));
}
async function state() {
  await owner(); const out = {};
  const fixed = ['public.payable_titles','public.payable_imports','cf_private.payable_import_files','public.payable_payments','public.payable_payment_reversals','public.payable_title_reviews','public.payable_administrative_writeoffs','public.payable_import_modes','public.payable_paid_bank_mappings','cf_private.payable_import_resolution_requests','public.audit_events','cf_private.payable_payment_state','cf_private.payable_control_state','public.bank_accounts','public.bank_balance_positions','cf_private.payable_paid_bank_aliases','public.profiles','public.role_permissions'];
  const dynamic = (await db.query("SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','cf_private') AND c.relkind='r' AND c.relname LIKE 'payable_daily%'")).rows.map(item => item.name);
  for (const name of [...fixed, ...dynamic]) out[name] = await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') r FROM ${name} t`);
  await actor(); return out;
}
const paidChoice = (item, extra = {}) => ({ action: 'PAID', reason: 'Dados efetivos conferidos no comprovante sintético', paid_on: yesterday, amount_paid_cents: item.payment_remaining_cents ?? item.amount_cents, bank_account_id: bank, ...extra });
async function bankMapping(paid_bank) { await owner(); const result = await scalar('SELECT (SELECT to_jsonb(m) FROM public.payable_paid_bank_mappings m WHERE branch=$1 AND paid_bank IS NOT DISTINCT FROM $2) r', ['FILIAL SINTETICA', paid_bank]); await actor(); return result ?? null; }
try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 21).sort()) await db.exec(await source(name));
  for (const [index, role] of ['gerente_geral', 'contas_pagar', 'diretor', 'contas_pagar'].entries()) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [ids[index], `daily-${index}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$3,true)', [ids[index], `DailySynthetic${index}`, role]);
    if (index < 3) await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [sessions[index], ids[index]]);
  }
  await actor();
  ({ today, yesterday, tomorrow } = (await db.query("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text yesterday,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text tomorrow")).rows[0]);
  const account = (await db.query("SELECT id,display_name FROM public.bank_accounts WHERE enabled AND account_type='BANK' ORDER BY id LIMIT 1")).rows[0]; bank = account.id; bankLabel = account.display_name;
  otherBank = await scalar("SELECT id r FROM public.bank_accounts WHERE enabled AND account_type='BANK' AND id<>$1 ORDER BY id LIMIT 1", [bank]);
  const alias = 'BANCO DIARIO SINTETICO — CONTA DE TESTE';
  const initial = [row('NORMAL-KEEP'), row('NORMAL-MISSING', 30000, { bank_account: alias }), row('LEGACY-MISSING-CENT', 1), cheque('LEGACY-CHEQUE', 45000)], original = file();
  await owner(); await db.exec('SET ROLE service_role');
  await scalar('SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,null) r', [ids[0], sessions[0], scope, original.name, original.sha, original.base64, JSON.stringify(initial), JSON.stringify(plans)]);
  await actor();
  for (const name of ['042_payable_administrative_writeoff.sql', '043_payable_import_reconciliation.sql', '050_paid_bank_rules.sql']) { await owner(); await db.exec(await source(name)); await actor(); }
  await owner(); await db.query('INSERT INTO cf_private.payable_paid_bank_aliases(source_key,official_bank_name) VALUES(cf_private.payable_paid_bank_text_key($1),$2)', [alias, bankLabel]); await actor();
  const beforeInstall = await state(); await owner(); await db.exec(await source('058_payable_daily_reports.sql')); await db.exec(await source('059_payable_column_rules.sql')); await actor();
  await test('058/059 installation does not change titles, payments, balances, roles or original reports', async () => {
    const after = await state(); for (const name of Object.keys(beforeInstall)) assert.deepEqual(after[name], beforeInstall[name], name);
    const capabilities = await scalar('SELECT public.payables_import_capabilities() r'); assert.equal(capabilities.daily_report_version, '059');
  });
  await test('an explicitly empty first CHEQUES report establishes only its own baseline without fake titles or legacy payments', async () => {
    const before = await state(); await owner(); await db.exec('BEGIN');
    try {
      await actor(); const p = await preview([], 'CHEQUES', {}, {}, {}, true); assert.equal(p.baseline_only, true); assert.equal(p.row_count, 0); assert.equal(p.missing_count, 0); assert.equal(p.auto_payment_count, 0); assert.equal(p.empty_cheques_confirmed, true); assert.equal(p.can_commit, true);
      const result = await commit(await frozen([], 'CHEQUES', {}, { empty: true })); assert.equal(result.row_count, 0); assert.equal(result.paid_count, 0); assert.equal(result.empty_cheques_confirmed, true); assert.equal((await title('LEGACY-CHEQUE')).paid_cents, 0);
      await owner(); await db.exec('SET CONSTRAINTS public.payable_empty_cheques_import_guard IMMEDIATE'); await actor();
      const inside = await state(); assert.deepEqual(inside['public.payable_titles'], before['public.payable_titles']); assert.deepEqual(inside['public.payable_payments'], before['public.payable_payments']);
    } finally { await owner(); await db.exec('ROLLBACK'); await actor(); }
    assert.deepEqual(await state(), before);
  });
  await test('zero-row public imports cannot bypass the deferred empty-cheque proof guard', async () => {
    const before = await state(), original = file(); await owner();
    await reject(db.query("INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode) VALUES($1,$2,$3,$4,$5,0,0,0,0,'FORECAST')", [randomUUID(), scope, original.name, original.sha, ids[0]]), '22023');
    const existing = await scalar('SELECT id r FROM public.payable_imports ORDER BY created_at,id LIMIT 1');
    await reject(db.query('UPDATE public.payable_imports SET row_count=0,new_count=0,open_count=0,settled_count=0 WHERE id=$1', [existing]), '22023');
    await actor(); assert.deepEqual(await state(), before);
  });
  let normalRequest, normalResult;
  await test('first NORMAL updates ordinary and cheque source rows and settles only absent ordinary titles', async () => {
    const rows = [row('NORMAL-KEEP'), cheque('LEGACY-CHEQUE', 45000)], before = await state(), p = await preview(rows);
    assert.equal(p.daily_report_version, '059'); assert.equal(p.report_date, today); assert.equal(p.report_kind, 'NORMAL');
    assert.equal(p.ignored_cheque_count, 0); assert.equal(p.row_count, 2); assert.equal(p.missing_count, 2); assert.equal(p.auto_payment_count, 1); assert.equal(p.auto_payment_cents, 30000); assert.equal(p.can_commit, false);
    assert.deepEqual(await state(), before);
    await reject(commit(await frozen(rows)), 'P0058'); assert.deepEqual(await state(), before);
    const cent = await title('LEGACY-MISSING-CENT'), choices = { ['title:' + cent.id]: { action: 'WRITE_OFF', reason: 'Baixa individual do marcador de um centavo ausente' } };
    assert.equal((await preview(rows, 'NORMAL', choices)).can_commit, true);
    normalRequest = await frozen(rows, 'NORMAL', choices); normalResult = await commit(normalRequest, 1);
    assert.equal(normalResult.daily_report_version, '059'); assert.equal(normalResult.paid_count, 1); assert.equal(normalResult.written_off_count, 1);
    const missing = await title('NORMAL-MISSING'); assert.equal(missing.financial_status, 'PAID'); assert.equal(missing.review_status, 'CONCILIADO'); assert.equal(dateText(missing.last_payment_date), yesterday);
    assert.equal((await title('LEGACY-CHEQUE')).paid_cents, 0); assert.equal((await title('NORMAL-KEEP')).paid_cents, 0);
    const summary = await scalar('SELECT public.payable_payment_summary($1,$1) r', [yesterday]); assert.equal(summary.total_paid_cents, 30000);
    assert.equal((await title('LEGACY-MISSING-CENT')).financial_status, 'ADMIN_WRITEOFF'); assert.equal((await title('LEGACY-MISSING-CENT')).paid_cents, 0);
  });
  await test('same request replay returns the original proof and rejects a changed payload without another financial event', async () => {
    const before = await state(), replay = await commit(normalRequest, 1); assert.equal(replay.idempotent, true); assert.equal(replay.report_id, normalResult.report_id); assert.deepEqual(await state(), before);
    await reject(commit({ ...normalRequest, rows: [row('NORMAL-KEEP', 99999)] }, 1), '22023'); assert.deepEqual(await state(), before);
  });
  await test('the same file under a new request is identified without replaying old counts or financial events', async () => {
    const before = await state(), next = await frozen(normalRequest.rows, 'NORMAL', {}, { original: normalRequest.original });
    await reject(commit(next, 1), '23505'); assert.deepEqual(await state(), before);
  });
  let chequeSeedRequest;
  await test('first CHEQUES report establishes a separate baseline and cannot pay an older omitted cheque', async () => {
    const rows = [cheque('CHEQUE-KEEP', 50000), cheque('CHEQUE-MISSING', 60000), row('CHEQUE-NUMBER-ONLY', 35000, { source_status: 'ABERTO', cheque_number: '0000090' })], p = await preview(rows, 'CHEQUES');
    assert.equal(p.baseline_only, true); assert.equal(p.missing_count, 0); assert.equal(p.auto_payment_count, 0); assert.equal(p.can_commit, true);
    chequeSeedRequest = await frozen(rows, 'CHEQUES'); const result = await commit(chequeSeedRequest);
    assert.equal(result.paid_count, 0); assert.equal((await title('LEGACY-CHEQUE')).paid_cents, 0); assert.equal((await title('NORMAL-KEEP')).paid_cents, 0);
  });
  await test('next CHEQUES report pays only an absent member of the preceding cheque position on the import date', async () => {
    const rows = [cheque('CHEQUE-KEEP', 50000), row('CHEQUE-NUMBER-ONLY', 35000, { source_status: 'ABERTO', cheque_number: '0000090' })], p = await preview(rows, 'CHEQUES');
    assert.equal(p.baseline_only, false); assert.equal(p.missing_count, 1); assert.equal(p.auto_payment_count, 1); assert.equal(p.auto_payment_cents, 60000); assert.equal(p.can_commit, true);
    const result = await commit(await frozen(rows, 'CHEQUES')); assert.equal(result.paid_count, 1);
    const missing = await title('CHEQUE-MISSING'); assert.equal(missing.financial_status, 'PAID'); assert.equal(dateText(missing.last_payment_date), today); assert.equal(missing.cheque_number, '000CHEQUE-MISSING');
    assert.equal((await title('LEGACY-CHEQUE')).paid_cents, 0); assert.equal((await title('NORMAL-KEEP')).paid_cents, 0);
    await reject(commit(await frozen(chequeSeedRequest.rows, 'CHEQUES', {}, { original: chequeSeedRequest.original })), '23505');
  });
  await test('cheque classification requires an explicit status or number and a wrong or empty report never closes a channel', async () => {
    const before = await state(); await reject(preview([row('WRONG-CHANNEL')], 'CHEQUES'), '22023'); await reject(preview([], 'CHEQUES'), '22023'); await reject(preview([], 'NORMAL'), '22023'); const allCheques = await preview([cheque('ONLY-CHEQUES')], 'NORMAL'); assert.equal(allCheques.row_count, 1); assert.equal(allCheques.ignored_cheque_count, 0);
    await reject(preview([row('INVALID-KIND')], 'OUTRO'), '22023'); assert.deepEqual(await state(), before);
  });
  await test('empty confirmation is valid only for zero CHEQUES rows and cannot authorize another report shape', async () => {
    const before = await state(); await reject(preview([], 'NORMAL', {}, {}, {}, true), '22023'); await reject(preview([cheque('NONEMPTY-CONFIRMATION')], 'CHEQUES', {}, {}, plans, true), '22023');
    await reject(preview([], 'CHEQUES', {}, {}, {}, false), '22023'); assert.deepEqual(await state(), before);
  });
  await test('existing canonical identity is updated without duplicating its title or inheriting cheque numbers', async () => {
    const before = await title('NORMAL-KEEP'), changed = row('NORMAL-KEEP', 12345, { due_date: today }), p = await preview([changed]);
    assert.equal(p.new_count, 0); assert.equal(p.changed_count, 1); await commit(await frozen([changed]));
    const after = await title('NORMAL-KEEP'); assert.equal(after.id, before.id); assert.equal(after.amount_cents, 12345); assert.equal(dateText(after.due_date), today); assert.equal(after.cheque_number, null);
  });
  await test('unknown banks block all changes until an exact actual bank and payment are explicitly supplied', async () => {
    const keep = await normalRows(), unknown = row('UNKNOWN-BANK', 70000, { bank_account: 'CONTA SINTETICA NAO CADASTRADA' });
    await commit(await frozen([...keep, unknown])); const current = await normalRows(), rows = current.filter(item => item.entry_number !== unknown.entry_number), p = await preview(rows);
    assert.equal(p.can_commit, false); assert.equal(p.missing_count, 1); assert(p.exceptions.length > 0);
    const before = await state(); await reject(commit(await frozen(rows))); assert.deepEqual(await state(), before);
    const item = await title(unknown.entry_number), choices = { ['title:' + item.id]: paidChoice(item) }, fixed = await preview(rows, 'NORMAL', choices); assert.equal(fixed.can_commit, true);
    await commit(await frozen(rows, 'NORMAL', choices)); assert.equal((await title(unknown.entry_number)).financial_status, 'PAID');
    assert.equal(await bankMapping(unknown.bank_account), null, 'A per-title actual payment must not configure a bank group');
    const next = row('UNKNOWN-BANK-REUSE', 71000, { bank_account: unknown.bank_account }); await commit(await frozen([...await normalRows(), next]));
    const remaining = (await normalRows()).filter(item => item.entry_number !== next.entry_number), pendingAgain = await preview(remaining); assert.equal(pendingAgain.can_commit, false);
    const banks = { [pendingAgain.exceptions[0].bank_mapping_key]: bank }; assert.equal((await preview(remaining, 'NORMAL', {}, banks)).can_commit, true);
    await commit(await frozen(remaining, 'NORMAL', {}, { banks })); assert.equal((await title(next.entry_number)).financial_status, 'PAID'); assert.equal((await bankMapping(unknown.bank_account)).bank_account_id, bank);
    const future = row('UNKNOWN-BANK-PERSISTED', 72000, { bank_account: unknown.bank_account }); await commit(await frozen([...await normalRows(), future]));
    const withoutFuture = (await normalRows()).filter(item => item.entry_number !== future.entry_number), reused = await preview(withoutFuture); assert.equal(reused.can_commit, true); assert.equal(reused.auto_payment_count, 1); assert.equal(reused.exceptions.length, 0);
    await commit(await frozen(withoutFuture)); assert.equal((await title(future.entry_number)).financial_status, 'PAID');
  });
  await test('one explicit bank mapping resolves all absent titles sharing that source bank without per-title decisions', async () => {
    const keep = await normalRows(), sameBank = 'CONTA SINTETICA DE UM MESMO GRUPO';
    const a = row('BANK-GROUP-A', 12300, { bank_account: sameBank }), b = row('BANK-GROUP-B', 22200, { bank_account: sameBank }); await commit(await frozen([...keep, a, b]));
    const rows = (await normalRows()).filter(item => ![a.entry_number, b.entry_number].includes(item.entry_number)), pending = await preview(rows);
    assert.equal(pending.can_commit, false); assert.equal(pending.exceptions.length, 2); assert.equal(pending.exceptions[0].bank_mapping_key, pending.exceptions[1].bank_mapping_key);
    const banks = { [pending.exceptions[0].bank_mapping_key]: bank }, ready = await preview(rows, 'NORMAL', {}, banks); assert.equal(ready.can_commit, true); assert.equal(ready.auto_payment_count, 2); assert.equal(ready.auto_payment_cents, 34500);
    const result = await commit(await frozen(rows, 'NORMAL', {}, { banks })); assert.equal(result.paid_count, 2);
    assert.equal((await title(a.entry_number)).financial_status, 'PAID'); assert.equal((await title(b.entry_number)).financial_status, 'PAID');
  });
  await test('an actual bank override pays one title without remapping its original official bank', async () => {
    const special = row('OFFICIAL-BANK-OVERRIDE', 13300); await commit(await frozen([...await normalRows(), special]));
    const rows = (await normalRows()).filter(item => item.entry_number !== special.entry_number), t = await title(special.entry_number), choice = { ['title:' + t.id]: paidChoice(t, { bank_account_id: otherBank }) };
    assert.equal((await preview(rows, 'NORMAL', choice)).can_commit, true); await commit(await frozen(rows, 'NORMAL', choice));
    assert.equal(await scalar('SELECT bank_account_id r FROM public.payable_payments WHERE title_id=$1', [t.id]), otherBank); assert.equal(await bankMapping(bankLabel), null);
    const next = row('OFFICIAL-BANK-STILL-ORIGINAL', 14400); await commit(await frozen([...await normalRows(), next]));
    const remaining = (await normalRows()).filter(item => item.entry_number !== next.entry_number), p = await preview(remaining); assert.equal(p.can_commit, true); assert.equal(p.automatic_actions.find(item => item.entry_number === next.entry_number).bank_account_id, bank);
    await commit(await frozen(remaining));
  });
  await test('a group mapping and a per-title bank override preserve their separate scopes', async () => {
    const sourceBank = 'GRUPO SINTETICO COM EXCECAO', special = row('GROUP-ACTUAL-OVERRIDE', 15500, { bank_account: sourceBank }); await commit(await frozen([...await normalRows(), special]));
    const rows = (await normalRows()).filter(item => item.entry_number !== special.entry_number), p = await preview(rows), t = await title(special.entry_number);
    const banks = { [p.exceptions[0].bank_mapping_key]: bank }, choices = { ['title:' + t.id]: paidChoice(t, { bank_account_id: otherBank }) };
    assert.equal((await preview(rows, 'NORMAL', choices, banks)).can_commit, true); await commit(await frozen(rows, 'NORMAL', choices, { banks }));
    assert.equal(await scalar('SELECT bank_account_id r FROM public.payable_payments WHERE title_id=$1', [t.id]), otherBank); assert.equal((await bankMapping(sourceBank)).bank_account_id, bank);
    const next = row('GROUP-AFTER-EXCEPTION', 16600, { bank_account: sourceBank }); await commit(await frozen([...await normalRows(), next]));
    const remaining = (await normalRows()).filter(item => item.entry_number !== next.entry_number), reused = await preview(remaining); assert.equal(reused.can_commit, true); assert.equal(reused.automatic_actions.find(item => item.entry_number === next.entry_number).bank_account_id, bank); await commit(await frozen(remaining));
  });
  await test('a blank source bank permits an explicit actual payment without creating an empty bank mapping', async () => {
    const special = row('BLANK-SOURCE-BANK', 17700, { bank_account: '' }); await commit(await frozen([...await normalRows(), special]));
    const rows = (await normalRows()).filter(item => item.entry_number !== special.entry_number), p = await preview(rows), t = await title(special.entry_number); assert.equal(p.can_commit, false);
    const choices = { ['title:' + t.id]: paidChoice(t, { bank_account_id: otherBank }) }; assert.equal((await preview(rows, 'NORMAL', choices)).can_commit, true); await commit(await frozen(rows, 'NORMAL', choices));
    assert.equal(await scalar('SELECT bank_account_id r FROM public.payable_payments WHERE title_id=$1', [t.id]), otherBank); assert.equal(await bankMapping(null), null); assert.equal(await bankMapping(''), null);
  });
  await test('a future due date never becomes a future actual payment and requires a real-date override', async () => {
    const keep = await normalRows(), future = row('FUTURE-DUE', 80000, { due_date: tomorrow }); await commit(await frozen([...keep, future]));
    const rows = (await normalRows()).filter(item => item.entry_number !== future.entry_number), p = await preview(rows); assert.equal(p.can_commit, false);
    const item = await title(future.entry_number), before = await state(); await reject(commit(await frozen(rows))); assert.deepEqual(await state(), before);
    const choices = { ['title:' + item.id]: paidChoice(item, { paid_on: today }) }; assert.equal((await preview(rows, 'NORMAL', choices)).can_commit, true); await commit(await frozen(rows, 'NORMAL', choices));
    assert.equal(dateText((await title(future.entry_number)).last_payment_date), today); assert.equal(dateText((await title(future.entry_number)).due_date), tomorrow);
  });
  await test('one-cent markers require individual administrative confirmation and never enter paid totals', async () => {
    const rows = [...await normalRows(), row('CENT-MARKER', 1)], p = await preview(rows), item = p.reconciliation_items.find(item => item.kind === 'CENT');
    assert(item); assert.equal(p.can_commit, false); const before = await state(); await reject(commit(await frozen(rows))); assert.deepEqual(await state(), before);
    const choices = { [item.key]: { action: 'WRITE_OFF', reason: 'Marcador de um centavo conferido individualmente' } };
    assert.equal((await preview(rows, 'NORMAL', choices)).can_commit, true); const result = await commit(await frozen(rows, 'NORMAL', choices)); assert.equal(result.written_off_count, 1);
    const written = await title('CENT-MARKER'); assert.equal(written.financial_status, 'ADMIN_WRITEOFF'); assert.equal(written.paid_cents, 0); assert.equal(written.amount_cents, 1);
  });
  await test('an existing nominal converted to a one-cent source marker passes both guards and preserves the nominal in review', async () => {
    const rows = await normalRows(), original = await title('NORMAL-KEEP'), markers = rows.map(item => item.entry_number === original.entry_number ? { ...item, amount_cents: 1 } : item), p = await preview(markers), item = p.exceptions.find(item => item.entry_number === original.entry_number);
    assert.equal(p.can_commit, false); assert.equal(item.kind, 'CENT'); assert.equal(item.amount_cents, original.amount_cents); assert.equal(item.source_amount_cents, 1); assert.equal(item.title_id, original.id);
    const choices = { [item.key]: { action: 'WRITE_OFF', reason: 'Marcador administrativo conferido sem alterar nominal histórico' } }, ready = await preview(markers, 'NORMAL', choices); assert.equal(ready.can_commit, true);
    const paidMarker = [...rows, row('NORMAL-MISSING', 1)], blocked = await preview(paidMarker), paidItem = blocked.exceptions.find(item => item.entry_number === 'NORMAL-MISSING'); assert.equal(blocked.can_commit, false); assert.deepEqual(paidItem.allowed_actions, []); assert.equal(paidItem.kind, 'CENT');
  });
  await test('paid or administratively written-off reappearances demand explicit review without erasing the original history', async () => {
    const before = await state();
    assert.equal((await preview([...await normalRows(), row('NORMAL-MISSING', 30000)])).can_commit, false);
    assert.equal((await preview([...await normalRows(), row('CENT-MARKER', 90000)])).can_commit, false);
    assert.deepEqual(await state(), before);
  });
  await test('stale financial tokens, changed import date and forged original bytes reject atomically', async () => {
    const rows = await normalRows(), stale = await frozen(rows); await commit(await frozen([...rows, row('REVISION-ADVANCE')])); const before = await state();
    await reject(commit(stale), '40001'); await reject(commit(await frozen(await normalRows(), 'NORMAL', {}, { date: yesterday })), '40001');
    const forged = await frozen(await normalRows()); forged.original.sha = '0'.repeat(64); await reject(commit(forged), '22023'); assert.deepEqual(await state(), before);
  });
  await test('changing a bank alias after preview invalidates the financial token even without a title import', async () => {
    const rows = await normalRows(), request = await frozen(rows), before = await state();
    await owner(); await db.query('UPDATE cf_private.payable_paid_bank_aliases SET official_bank_name=$2 WHERE source_key=cf_private.payable_paid_bank_text_key($1)', [alias, 'OUTRA CONTA SINTETICA']); await actor();
    try { await reject(commit(request), '40001'); } finally { await owner(); await db.query('UPDATE cf_private.payable_paid_bank_aliases SET official_bank_name=$2 WHERE source_key=cf_private.payable_paid_bank_text_key($1)', [alias, bankLabel]); await actor(); }
    assert.deepEqual(await state(), before);
  });
  await test('an ordinary title listed explicitly as a cheque is provisioned without being treated as absent or paid', async () => {
    const rows = await normalRows(), target = rows.find(item => item.entry_number === 'NORMAL-KEEP'), before = await state(); assert(target);
    const mixed = rows.map(item => item.entry_number === target.entry_number ? { ...item, source_status: 'CHEQUE', cheque_number: '0000042' } : item), p = await preview(mixed);
    assert.equal(p.ignored_cheque_count, 0); assert.equal(p.missing_count, 0); assert.equal(p.can_commit, true); assert(!p.automatic_actions.some(item => item.entry_number === target.entry_number));
    assert.deepEqual(await state(), before); assert.equal((await title(target.entry_number)).paid_cents, 0);
  });
  await test('an unchanged legacy partial payment remains registered and a changed financial source requires review', async () => {
    const keep = await normalRows(), partial = row('LEGACY-PARTIAL', 20000); await commit(await frozen([...keep, partial])); const t = await title(partial.entry_number);
    await owner(); await db.query(`WITH revision AS(UPDATE cf_private.payable_payment_state SET revision=revision+1 WHERE singleton RETURNING revision)
      INSERT INTO public.payable_payments(title_id,request_id,event_revision,amount_cents,paid_on,bank_account_id,bank_label,bank_company,bank_name,account_type,macro_snapshot,entry_number,description,branch,plan_snapshot,due_date,title_amount_cents,expected_revision,expected_import_id,observation,created_by)
      SELECT t.id,$1,revision.revision,5000,$2::date,b.id,b.display_name,b.company,b.bank,b.account_type,t.macro,t.entry_number,t.description,t.branch,t.plan,t.due_date,t.amount_cents,NULL,t.last_import_id,'Pagamento parcial sintético histórico',$3 FROM public.payable_titles t CROSS JOIN revision CROSS JOIN public.bank_accounts b WHERE t.id=$4 AND b.id=$5`, [randomUUID(), yesterday, ids[0], t.id, bank]); await actor();
    const rows = await normalRows(), p = await preview(rows); assert.equal(p.can_commit, true); assert(!p.exceptions.some(item => item.entry_number === partial.entry_number));
    await commit(await frozen(rows)); const after = await title(partial.entry_number); assert.equal(after.id, t.id); assert.equal(after.paid_cents, 5000); assert.equal(after.payment_remaining_cents, 15000); assert.equal(after.financial_status, 'PARTIAL');
    const before = await state(), altered = rows.map(item => item.entry_number === partial.entry_number ? { ...item, amount_cents: 21000 } : item); assert.equal((await preview(altered)).can_commit, false); assert.deepEqual(await state(), before);
  });
  await test('a late audit failure rolls back source bytes, titles, inferred payments and every new daily record', async () => {
    const keep = await normalRows(), disappear = row('ATOMIC-MISSING', 99900); await commit(await frozen([...keep, disappear]));
    const rows = (await normalRows()).filter(item => item.entry_number !== disappear.entry_number), request = await frozen(rows), before = await state();
    await owner(); await db.exec("ALTER TABLE public.audit_events ADD CONSTRAINT synthetic_reject_daily_payment CHECK(entity<>'payable_payments') NOT VALID"); await actor();
    try { await reject(commit(request), '23514'); } finally { await owner(); await db.exec('ALTER TABLE public.audit_events DROP CONSTRAINT synthetic_reject_daily_payment'); await actor(); }
    assert.deepEqual(await state(), before);
  });
  await test('director, unapproved sessions and authenticated direct gateway calls cannot mutate daily reports', async () => {
    const rows = await normalRows(), request = await frozen(rows), before = await state();
    await actor(2); await reject(preview(rows), '42501'); await actor(); await reject(commit(request, 2), '42501'); await reject(commit(request, 3), '42501');
    await reject(scalar('SELECT public.commit_payables_daily_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::date,$15) r', [ids[0], sessions[0], scope, request.original.name, request.original.sha, request.original.base64, JSON.stringify(rows), 'NORMAL', JSON.stringify(plans), '{}', '{}', request.previous, request.financial, today, request.request]), '42501');
    assert.deepEqual(await state(), before);
  });
  await test('daily positions, request proofs and settlement provenance are private and immutable', async () => {
    const before = await state();
    for (const name of ['payable_daily_reports', 'payable_daily_requests', 'payable_daily_actions']) {
      await reject(db.query(`SELECT * FROM cf_private.${name}`), '42501');
      await owner();
      const column = name === 'payable_daily_reports' ? 'rows' : name === 'payable_daily_requests' ? 'payload' : 'title_snapshot';
      await reject(db.query(`UPDATE cf_private.${name} SET ${column}=${column}`), '42501');
      await reject(db.query(`DELETE FROM cf_private.${name}`), '42501');
      await actor();
    }
    await owner();
    const inferred = await scalar("SELECT jsonb_build_object('kind',a.rule_kind,'date',a.effective_on,'snapshot',a.title_snapshot,'paid',p.amount_cents,'payment_date',p.paid_on,'original_sha',i.file_sha256,'bytes_sha',encode(sha256(f.file_bytes),'hex')) r FROM cf_private.payable_daily_actions a JOIN public.payable_payments p ON p.id=a.payment_id JOIN cf_private.payable_daily_reports d ON d.id=a.report_id JOIN public.payable_imports i ON i.id=d.source_import_id JOIN cf_private.payable_import_files f ON f.import_id=i.id WHERE p.entry_number='NORMAL-MISSING'");
    assert.equal(inferred.kind, 'DUE_DATE'); assert.equal(inferred.date, yesterday); assert.equal(inferred.payment_date, yesterday); assert.equal(inferred.paid, 30000); assert.equal(inferred.snapshot.amount_cents, 30000); assert.equal(inferred.original_sha, normalRequest.original.sha); assert.equal(inferred.bytes_sha, normalRequest.original.sha);
    await actor(); assert.deepEqual(await state(), before);
  });
  await test('one thousand current rows and one hundred missing titles are compared as complete sets', async () => {
    const keep = await normalRows(), bulk = Array.from({ length: 1100 }, (_, index) => row('BULK-' + String(index).padStart(5, '0'), 100 + index)); await commit(await frozen([...keep, ...bulk]));
    const rows = [...keep, ...bulk.slice(0, 1000)], started = performance.now(), p = await preview(rows), elapsed = Math.round(performance.now() - started);
    assert.equal(p.row_count, rows.length); assert.equal(p.missing_count, 100); assert.equal(p.auto_payment_count, 100); assert.equal(p.can_commit, true); assert.equal(p.auto_payment_cents, bulk.slice(1000).reduce((sum, item) => sum + item.amount_cents, 0));
    assert(elapsed < 15000, `Daily preview took ${elapsed}ms`); console.log(`BENCHMARK ${rows.length} current / 100 missing: ${elapsed}ms (local PGlite)`);
  });
  let emptyRequest, emptyResult;
  await test('an explicitly empty CHEQUES position closes all prior cheque members on the import day atomically', async () => {
    const p = await preview([], 'CHEQUES', {}, {}, {}, true); assert.equal(p.can_commit, true); assert.equal(p.baseline_only, false); assert.equal(p.row_count, 0); assert.equal(p.missing_count, 2); assert.equal(p.auto_payment_count, 2); assert.equal(p.auto_payment_cents, 85000);
    emptyRequest = await frozen([], 'CHEQUES', {}, { empty: true }); const before = await state();
    await owner(); await db.exec("ALTER TABLE public.audit_events ADD CONSTRAINT synthetic_reject_empty_daily CHECK(entity<>'payable_daily_report') NOT VALID"); await actor();
    try { await reject(commit(emptyRequest), '23514'); } finally { await owner(); await db.exec('ALTER TABLE public.audit_events DROP CONSTRAINT synthetic_reject_empty_daily'); await actor(); }
    assert.deepEqual(await state(), before); emptyResult = await commit(emptyRequest); assert.equal(emptyResult.paid_count, 2); assert.equal(emptyResult.row_count, 0); assert.equal(emptyResult.empty_cheques_confirmed, true);
    for (const entry of ['CHEQUE-KEEP', 'CHEQUE-NUMBER-ONLY']) { const t = await title(entry); assert.equal(t.financial_status, 'PAID'); assert.equal(dateText(t.last_payment_date), today); }
    assert.equal((await title('LEGACY-CHEQUE')).paid_cents, 0);
    const after = await state(); assert.deepEqual(after['public.payable_titles'], before['public.payable_titles']);
    await owner(); const artifact = await scalar('SELECT to_jsonb(i) r FROM public.payable_imports i WHERE id=$1', [emptyResult.import_id]); assert.equal(artifact.row_count, 0); assert.equal(artifact.file_sha256, emptyRequest.original.sha); await actor();
  });
  await test('an empty-cheque confirmation replays only its original protocol and rejects a changed declaration', async () => {
    const before = await state(), replay = await commit(emptyRequest); assert.equal(replay.idempotent, true); assert.equal(replay.report_id, emptyResult.report_id); assert.equal(replay.paid_count, 2); assert.deepEqual(await state(), before);
    await reject(commit({ ...emptyRequest, empty: false }), '22023'); assert.deepEqual(await state(), before);
  });
  await test('the same empty artifact after a nonempty cheque report creates a fresh position and closes its new members', async () => {
    const rows = [cheque('AFTER-EMPTY-A', 18800), cheque('AFTER-EMPTY-B', 19900)]; await commit(await frozen(rows, 'CHEQUES'));
    const p = await preview([], 'CHEQUES', {}, {}, {}, true); assert.equal(p.missing_count, 2); assert.equal(p.auto_payment_cents, 38700);
    const fresh = await frozen([], 'CHEQUES', {}, { empty: true, original: emptyRequest.original }), result = await commit(fresh); assert.equal(result.paid_count, 2); assert.notEqual(result.report_id, emptyResult.report_id); assert.equal(result.import_id, emptyResult.import_id);
    for (const entry of rows.map(item => item.entry_number)) { const t = await title(entry); assert.equal(t.financial_status, 'PAID'); assert.equal(dateText(t.last_payment_date), today); }
    await owner(); const count = await scalar('SELECT count(*)::integer r FROM cf_private.payable_daily_reports WHERE report_kind=\'CHEQUES\' AND file_sha256=$1', [emptyRequest.original.sha]); assert.equal(count, 2); await actor();
  });
  await test('a new empty position invalidates a stale token even when it reuses its artifact and creates no payment', async () => {
    const stale = await frozen(await normalRows()), beforeRevision = await scalar('SELECT public.get_payables_revision() r'), before = await state();
    const noChange = await frozen([], 'CHEQUES', {}, { empty: true, original: emptyRequest.original }), result = await commit(noChange); assert.equal(result.paid_count, 0); assert.equal(result.row_count, 0);
    assert.deepEqual(await scalar('SELECT public.get_payables_revision() r'), beforeRevision); const after = await state(); assert.deepEqual(after['public.payable_payments'], before['public.payable_payments']); assert.deepEqual(after['public.payable_imports'], before['public.payable_imports']);
    await reject(commit(stale), '40001'); assert.deepEqual(await state(), after);
  });
  await test('standalone installer is byte exact and repeated activation preserves daily and financial history', async () => {
    const sql = await buildPayableColumnRulesSql(); assert.equal(await readFile(new URL('../supabase/dashboard/ativar-colunas-contas-pagar.sql', import.meta.url), 'utf8'), sql);
    const before = await state(); await owner(); await db.exec(sql); await actor(); assert.deepEqual(await state(), before);
  });
  console.log(`${passed} passed (daily payable reports, synthetic local PostgreSQL)`);
} catch (error) { console.error('FAIL', error); process.exitCode = 1; } finally { await db.close(); }
