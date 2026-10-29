import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';

// Disposable local PostgreSQL. Every report, account, title and payment is synthetic.
const f = await createCostFixture(), { db, users, owner, actor, scalar, file } = f;
const fragment = await readFile(new URL('../supabase/fragments/payable-daily-paid-consumers.sql', import.meta.url), 'utf8');
const chequeFragment = await readFile(new URL('../supabase/fragments/payable-daily-cheque-consumers.sql', import.meta.url), 'utf8');
const signature = 'cf_private.preview_payable_paid_rows(jsonb,jsonb,jsonb)';
const chequeConsumers = ['public.payables_management_summary(date,date)','public.payables_forecast(date)'];
const scope = 'grupo-consolidado', mappings = { 'PLANO COMPAT DIARIA': 'FIXO' };
let passed = 0, sequence = 0, today, yesterday, bank, bankLabel;
const source = () => { const bytes = Buffer.from('Relatório de compatibilidade sintético ' + ++sequence); return { name: `compat-diaria-${sequence}.csv`, sha: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }; };
const emptySource = (suffix = '') => { const bytes = Buffer.from('Lançamento;Histórico;Plano cp - Conta: nome;Plano cc - Conta: nome;Emissão: valor do lançamento;Emissão: data;Vencimento: data;Cheque: número;Filial\r\n' + suffix); return { name: 'sem-cheques-sinteticos.csv', sha: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }; };
const row = entry => ({ entry_number: entry, branch: 'FILIAL SINTETICA', description: 'Fornecedor sintético ' + entry, due_date: yesterday, amount_cents: 10000, issued_on: yesterday, source_status: 'ABERTO', plan: 'PLANO COMPAT DIARIA', bank_account: bankLabel });
const title = entry => scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1', [entry]);
const metadata = (target = signature) => scalar("SELECT jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig,'strict',p.proisstrict,'volatile',p.provolatile,'parallel',p.proparallel,'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid)) r FROM pg_proc p WHERE p.oid=$1::regprocedure", [target]);
const definition = () => scalar('SELECT pg_get_functiondef($1::regprocedure) r', [signature]);
const tables = ['public.payable_titles','public.payable_imports','cf_private.payable_import_files','public.payable_payments','public.payable_payment_reversals','public.payable_title_reviews','public.payable_paid_import_rows','public.payable_paid_bank_mappings','cf_private.payable_import_resolution_requests','cf_private.payable_daily_reports','cf_private.payable_daily_actions','public.audit_events','public.bank_accounts','public.bank_balance_positions'];
async function state() {
 await owner(); const out = {};
 for (const name of tables) out[name] = await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') r FROM ${name} t`);
 await actor(); return out;
}
async function reject(run, code) {
 await db.exec('SAVEPOINT expected_error');
 try { await assert.rejects(run, error => { assert.equal(error.code, code, error.message); return true; }); }
 finally { await db.exec('ROLLBACK TO SAVEPOINT expected_error; RELEASE SAVEPOINT expected_error'); await actor(); }
}
async function test(name, run) {
 await owner(); await db.exec('BEGIN'); await actor();
 try { await run(); passed++; console.log('PASS', name); }
 finally { await db.exec('ROLLBACK'); await actor(); }
}
async function dailyExcept(entry, { choices = {}, banks = {} } = {}) {
 const original = source();
 const current = (await db.query('SELECT entry_number FROM public.payable_financial_titles WHERE payment_remaining_cents>0 ORDER BY entry_number')).rows.map(item => item.entry_number);
 const rows = current.filter(value => value !== entry).map(row);
 const revision = await scalar('SELECT public.preview_payables_daily_report($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb) r', [scope, JSON.stringify(rows), 'NORMAL', JSON.stringify(mappings), JSON.stringify(banks), JSON.stringify(choices)]);
 await owner(); await db.exec('SET ROLE service_role');
 const result = await scalar('SELECT public.commit_payables_daily_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::date,$15) r', [users.manager.id, users.manager.session, scope, original.name, original.sha, original.base64, JSON.stringify(rows), 'NORMAL', JSON.stringify(mappings), JSON.stringify(banks), JSON.stringify(choices), revision.previous_import_id, revision.financial_revision, today, randomUUID()]);
 await actor(); return result;
}
const paidRow = (entry, amount = 9900) => ({ entry_number: entry, branch: 'FILIAL SINTETICA', source_status: 'PAGO', paid_on: today, amount_paid_cents: amount, paid_bank: bankLabel });
const paidPreview = rows => scalar('SELECT public.preview_payables_paid_import_v2($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb) r', [scope, JSON.stringify(rows), '{}', '{}', '{}']);
async function paidRequest(rows, confirm = true) {
 const revision = await scalar('SELECT public.get_payables_revision() r');
 return { rows, original: source(), previous: revision.import_id, financial: revision.financial_revision, request: randomUUID(), confirm };
}
async function commitPaid(request) {
 await owner(); await db.exec('SET ROLE service_role');
 const result = await scalar('SELECT public.commit_payables_paid_import_v2_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,$13::jsonb,$14) r', [users.manager.id, users.manager.session, scope, request.original.name, request.original.sha, request.original.base64, JSON.stringify(request.rows), '{}', request.previous, request.confirm, '{}', request.financial, '{}', request.request]);
 await actor(); return result;
}
async function manualPayment(entry) {
 const t = await title(entry);
 return scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r', [t.id, t.amount_cents, yesterday, bank, 'Pagamento manual sintético que não pertence à automação', t.payment_revision, randomUUID(), t.last_import_id]);
}
async function freezeCheques(rows, empty = false, original = emptySource()) {
 const selectedMappings = rows.length ? mappings : {};
 const preview = await scalar('SELECT public.preview_payables_daily_report($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) r', [scope, JSON.stringify(rows), 'CHEQUES', JSON.stringify(selectedMappings), '{}', '{}', empty]);
 return { rows, empty, original, mappings: selectedMappings, previous: preview.previous_import_id, financial: preview.financial_revision, date: preview.report_date, request: randomUUID(), preview };
}
async function commitCheques(request) {
 await owner(); await db.exec('SET ROLE service_role');
 const result = await scalar('SELECT public.commit_payables_daily_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::date,$15,$16) r', [users.manager.id, users.manager.session, scope, request.original.name, request.original.sha, request.original.base64, JSON.stringify(request.rows), 'CHEQUES', JSON.stringify(request.mappings), '{}', '{}', request.previous, request.financial, request.date, request.request, request.empty]);
 await actor(); return result;
}

try {
 ({ today, yesterday } = (await db.query("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text yesterday")).rows[0]);
 const account = (await db.query("SELECT id,display_name FROM public.bank_accounts WHERE enabled AND account_type='BANK' ORDER BY id LIMIT 1")).rows[0]; bank = account.id; bankLabel = account.display_name;
 const original = source();
 await owner(); await db.exec('SET ROLE service_role');
 await scalar('SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,null) r', [users.manager.id, users.manager.session, scope, original.name, original.sha, original.base64, JSON.stringify(['KEEP','AUTO','MANUAL','MIXED','ATOMIC'].map(row)), JSON.stringify(mappings)]);
 await owner(); for (const name of ['042_payable_administrative_writeoff.sql','043_payable_import_reconciliation.sql','050_paid_bank_rules.sql']) await db.exec(await file(name));
 const beforeMetadata = await metadata(), beforeChequeMetadata = new Map();
 for (const target of chequeConsumers) beforeChequeMetadata.set(target, await metadata(target));
 await db.exec(await file('058_payable_daily_reports.sql'));
 assert((await file('058_payable_daily_reports.sql')).includes(fragment.trim()), '058 must embed the reviewed paid-consumer fragment');
 assert((await file('058_payable_daily_reports.sql')).includes(chequeFragment.trim()), '058 must embed the reviewed cheque-consumer fragment');
 assert.deepEqual(await metadata(), beforeMetadata, 'Function identity, grants and execution settings remain unchanged');
 for (const [target, expected] of beforeChequeMetadata) assert.deepEqual(await metadata(target), expected, target);
 await actor();
 await test('bounded ownership fragment is repeatable and changes no sources, financial rows or privileges', async () => {
  const before = await state(), properties = await metadata(); await owner(); await db.exec(fragment); await db.exec(fragment); await actor();
  assert.deepEqual(await metadata(), properties); assert.deepEqual(await state(), before);
  const body = await definition(); assert.equal(body.split('payable_daily_058_owned').length - 1, 1);
  assert(body.includes('daily_058.payment_id=p.id AND daily_058.title_id=p.title_id'));
 });
 await test('actual paid report matches an inferred payment without duplicating it', async () => {
  await dailyExcept('AUTO'); const p = await paidPreview([{ ...paidRow('AUTO', 10000), paid_on: yesterday }]);
  assert.equal(p.rows[0].outcome, 'MATCHED'); assert.equal(p.correction_count, 0);
  const before = await scalar('SELECT count(*)::int r FROM public.payable_payments');
  const out = await commitPaid(await paidRequest([{ ...paidRow('AUTO', 10000), paid_on: yesterday }]));
  assert.equal(out.matched_payment_count, 1); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_payments'), before);
  assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_payment_reversals'), 0);
 });
 await test('real receipt details replace only the inferred payment after express correction confirmation', async () => {
  await dailyExcept('AUTO'); await owner(); const inferred = await scalar('SELECT to_jsonb(p) r FROM public.payable_payments p WHERE title_id=$1', [(await title('AUTO')).id]); await actor();
  const rows = [paidRow('AUTO')], p = await paidPreview(rows); assert.equal(p.rows[0].outcome, 'CORRECTION'); assert.equal(p.correction_count, 1); assert.equal(p.can_commit, true);
  const denied = await paidRequest(rows, false), before = await state(); await reject(() => commitPaid(denied), 'P0042'); assert.deepEqual(await state(), before);
  const request = await paidRequest(rows), out = await commitPaid(request); assert.equal(out.correction_count, 1);
  await owner();
  assert.deepEqual(await scalar('SELECT to_jsonb(p) r FROM public.payable_payments p WHERE id=$1', [inferred.id]), inferred);
  assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_payment_reversals WHERE payment_id=$1', [inferred.id]), 1);
  assert.equal(await scalar('SELECT count(*)::int r FROM cf_private.payable_daily_actions WHERE payment_id=$1', [inferred.id]), 1);
  const effective = await scalar('SELECT jsonb_agg(to_jsonb(p)) r FROM public.payable_effective_payments p WHERE title_id=$1 AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)', [inferred.title_id]);
  assert.equal(effective.length, 1); assert.equal(effective[0].amount_cents, 9900); assert.equal(effective[0].paid_on, today);
  await actor(); const paid = await title('AUTO'); assert.equal(paid.paid_cents, 9900); assert.equal(paid.financial_status, 'PAID'); assert.equal(paid.review_status, 'CONCILIADO');
  const after = await state(), replay = await commitPaid(request); assert.equal(replay.idempotent, true); assert.deepEqual(await state(), after);
 });
 await test('a true manual payment remains protected from report-driven replacement', async () => {
  const payment = await manualPayment('MANUAL'), rows = [paidRow('MANUAL')], p = await paidPreview(rows);
  assert.equal(p.rows[0].outcome, 'CONFLICT'); assert.equal(p.can_commit, false);
  const request = await paidRequest(rows), before = await state(); await reject(() => commitPaid(request), 'P0042'); assert.deepEqual(await state(), before);
  assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_payment_reversals WHERE payment_id=$1', [payment]), 0);
 });
 await test('mixed manual history and an inferred exact complement never become wholly owned by the importer', async () => {
  const t = await title('MIXED'); await owner();
  await db.query(`WITH revision AS(UPDATE cf_private.payable_payment_state SET revision=revision+1 WHERE singleton RETURNING revision)
   INSERT INTO public.payable_payments(title_id,request_id,event_revision,amount_cents,paid_on,bank_account_id,bank_label,bank_company,bank_name,account_type,macro_snapshot,entry_number,description,branch,plan_snapshot,due_date,title_amount_cents,expected_revision,expected_import_id,observation,created_by)
   SELECT t.id,$1,revision.revision,4000,$2::date,b.id,b.display_name,b.company,b.bank,b.account_type,t.macro,t.entry_number,t.description,t.branch,t.plan,t.due_date,t.amount_cents,NULL,t.last_import_id,'Pagamento parcial manual histórico sintético',$3
   FROM public.payable_titles t CROSS JOIN revision CROSS JOIN public.bank_accounts b WHERE t.id=$4 AND b.id=$5`, [randomUUID(), yesterday, users.manager.id, t.id, bank]);
  await actor(); await dailyExcept('MIXED'); assert.equal((await title('MIXED')).paid_cents, 10000);
  const p = await paidPreview([paidRow('MIXED')]); assert.equal(p.rows[0].outcome, 'CONFLICT'); assert.equal(p.can_commit, false);
  const before = await state(), request = await paidRequest([paidRow('MIXED')]); await reject(() => commitPaid(request), 'P0042'); assert.deepEqual(await state(), before);
 });
 await test('an individual actual-bank override never becomes a permanent mapping for future source-bank payments', async () => {
  const alternative = await scalar("SELECT id r FROM public.bank_accounts WHERE enabled AND account_type='BANK' AND id<>$1 ORDER BY id LIMIT 1", [bank]);
  assert(alternative); const t = await title('AUTO');
  await owner(); const key = await scalar('SELECT cf_private.payable_paid_bank_key($1,$2) r', [t.branch, t.bank_account]);
  const before = await scalar('SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY created_at,id),\'[]\') r FROM public.payable_paid_bank_mappings m WHERE mapping_key=$1', [key]); await actor();
  await dailyExcept('AUTO', { choices: { ['title:' + t.id]: { action: 'PAID', reason: 'Banco efetivo excepcional somente deste pagamento sintético', paid_on: today, amount_paid_cents: t.payment_remaining_cents, bank_account_id: alternative } } });
  assert.equal(await scalar('SELECT bank_account_id r FROM public.payable_effective_payments WHERE title_id=$1', [t.id]), alternative);
  await owner(); assert.deepEqual(await scalar('SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY created_at,id),\'[]\') r FROM public.payable_paid_bank_mappings m WHERE mapping_key=$1', [key]), before); await actor();
  await dailyExcept('MANUAL'); const follow = await title('MANUAL');
  assert.equal(await scalar('SELECT bank_account_id r FROM public.payable_effective_payments WHERE title_id=$1', [follow.id]), bank);
 });
 await test('an explicit group bank mapping persists its own account independently from one actual payment override', async () => {
  const alternative = await scalar("SELECT id r FROM public.bank_accounts WHERE enabled AND account_type='BANK' AND id<>$1 ORDER BY id LIMIT 1", [bank]);
  const t = await title('AUTO'); await owner(); const canonicalKey = await scalar('SELECT cf_private.payable_paid_bank_key($1,$2) r', [t.branch, t.bank_account]);
  const dailyKey = await scalar('SELECT cf_private.payable_daily_bank_key($1,$2) r', [t.branch, t.bank_account]); await actor();
  await dailyExcept('AUTO', { banks: { [dailyKey]: alternative }, choices: { ['title:' + t.id]: { action: 'PAID', reason: 'Banco deste comprovante difere do vínculo de grupo explicitamente escolhido', paid_on: today, amount_paid_cents: t.payment_remaining_cents, bank_account_id: bank } } });
  assert.equal(await scalar('SELECT bank_account_id r FROM public.payable_effective_payments WHERE title_id=$1', [t.id]), bank);
  assert.equal(await scalar('SELECT bank_account_id r FROM public.payable_paid_bank_mappings WHERE mapping_key=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [canonicalKey]), alternative);
  await dailyExcept('MANUAL'); const follow = await title('MANUAL');
  assert.equal(await scalar('SELECT bank_account_id r FROM public.payable_effective_payments WHERE title_id=$1', [follow.id]), alternative);
 });
 await test('cheque classification fragment preserves summaries, privileges and sources when repeated', async () => {
  const before = await state(), properties = new Map(); for (const target of chequeConsumers) properties.set(target, await metadata(target));
  await owner(); await db.exec(chequeFragment); await db.exec(chequeFragment); await actor();
  assert.deepEqual(await state(), before); for (const [target, expected] of properties) assert.deepEqual(await metadata(target), expected, target);
 });
 await test('explicit cheque numbers and CHEQUE status share the same subtotal without duplicating the planned or open amount', async () => {
  await owner(); await db.query('UPDATE public.payable_titles SET due_date=$1', [today]); await actor();
  const oldSummary = await scalar('SELECT public.payables_management_summary($1) r', [today]), oldForecast = await scalar('SELECT public.payables_forecast() r');
  assert.equal(oldSummary.cheques_week_cents, 0); assert.equal(oldForecast.weeks[0].cheques_cents, 0);
  await owner(); await db.exec("UPDATE public.payable_titles SET cheque_number='000123',source_status='ABERTO' WHERE entry_number='KEEP'; UPDATE public.payable_titles SET cheque_number=NULL,source_status='CHEQUE' WHERE entry_number='MIXED'"); await actor();
  const summary = await scalar('SELECT public.payables_management_summary($1) r', [today]), forecast = await scalar('SELECT public.payables_forecast() r');
  assert.equal(summary.cheques_week_cents, 20000); assert.equal(summary.cheques_week_count, 2);
  const strip = value => { const { cheques_week_cents, cheques_week_count, ...rest } = value; return rest; };
  assert.deepEqual(strip(summary), strip(oldSummary));
  assert.equal(forecast.weeks[0].cheques_cents, 20000); assert.equal(forecast.weeks[0].cheque_count, 2);
  const stripForecast = report => ({ ...report, weeks: report.weeks.map(({ cheques_cents, cheque_count, ...week }) => week) });
  assert.deepEqual(stripForecast(forecast), stripForecast(oldForecast));
  assert.equal((await title('KEEP')).source_status, 'ABERTO'); assert.equal((await title('KEEP')).cheque_number, '000123');
  const before = await state(); await scalar('SELECT public.payables_management_summary($1) r', [today]); await scalar('SELECT public.payables_forecast() r'); assert.deepEqual(await state(), before);
 });
 await test('titles sharing one cheque number stay separate and settled cheques leave both open subtotals exactly once', async () => {
  await owner(); await db.query('UPDATE public.payable_titles SET due_date=$1', [today]); await db.exec("UPDATE public.payable_titles SET cheque_number='000123',source_status='ABERTO' WHERE entry_number IN('KEEP','MIXED')"); await actor();
  assert.equal((await scalar('SELECT public.payables_management_summary($1) r', [today])).cheques_week_count, 2);
  const keep = await title('KEEP'); await scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r', [keep.id, keep.amount_cents, today, bank, 'Pagamento efetivo sintético de um título do cheque compartilhado', keep.payment_revision, randomUUID(), keep.last_import_id]);
  const summary = await scalar('SELECT public.payables_management_summary($1) r', [today]), forecast = await scalar('SELECT public.payables_forecast() r');
  assert.equal(summary.planned_week_cents, 50000); assert.equal(summary.open_week_cents, 40000); assert.equal(summary.paid_week_cents, 10000);
  assert.equal(summary.cheques_week_cents, 10000); assert.equal(summary.cheques_week_count, 1);
  assert.equal(forecast.weeks[0].real_cents, 40000); assert.equal(forecast.weeks[0].cheques_cents, 10000); assert.equal(forecast.weeks[0].cheque_count, 1);
 });
 await test('administrative cheque writeoffs stay outside both cheque subtotals and create no realized payment', async () => {
  await owner(); await db.query('UPDATE public.payable_titles SET due_date=$1', [today]); await db.exec("UPDATE public.payable_titles SET cheque_number='000123',source_status='ABERTO' WHERE entry_number='KEEP'"); await actor();
  const keep = await title('KEEP'); await owner(); await scalar('SELECT cf_private.record_payable_administrative_writeoff($1,NULL,$2,$3) r', [keep.id, 'Baixa administrativa sintética com nominal original preservado', keep.payment_revision]); await actor();
  const summary = await scalar('SELECT public.payables_management_summary($1) r', [today]), forecast = await scalar('SELECT public.payables_forecast() r');
  assert.equal(summary.planned_week_cents, 40000); assert.equal(summary.open_week_cents, 40000); assert.equal(summary.paid_week_cents, 0);
  assert.equal(summary.cheques_week_cents, 0); assert.equal(summary.cheques_week_count, 0);
  assert.equal(forecast.weeks[0].real_cents, 40000); assert.equal(forecast.weeks[0].cheques_cents, 0); assert.equal(forecast.weeks[0].cheque_count, 0);
  assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_payments'), 0); assert.equal((await title('KEEP')).amount_cents, 10000);
 });
 await test('the first explicitly empty cheque report establishes a baseline and satisfies the deferred source proof without paying old cheques', async () => {
  await owner(); await db.exec("UPDATE public.payable_titles SET source_status='CHEQUE',cheque_number='000001' WHERE entry_number='MANUAL'"); await actor();
  const request = await freezeCheques([], true); assert.equal(request.preview.baseline_only, true); assert.equal(request.preview.missing_count, 0); assert.equal(request.preview.can_commit, true);
  const result = await commitCheques(request); assert.equal(result.row_count, 0); assert.equal(result.paid_count, 0); assert.equal(result.empty_cheques_confirmed, true);
  await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  assert.equal((await title('MANUAL')).paid_cents, 0); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_payments'), 0);
  assert.equal(await scalar('SELECT row_count r FROM public.payable_imports WHERE id=$1', [result.import_id]), 0);
 });
 await test('normal empty files, unconfirmed empty cheques and orphan zero-row source inserts or updates remain forbidden', async () => {
  await reject(() => scalar('SELECT public.preview_payables_daily_report($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) r', [scope, '[]', 'NORMAL', '{}', '{}', '{}', true]), '22023');
  await reject(() => freezeCheques([], false), '22023');
  await reject(() => freezeCheques([{ ...row('INVALID-EMPTY-FLAG'), source_status: 'CHEQUE', cheque_number: '000001' }], true), '22023');
  await reject(() => scalar('SELECT public.preview_payables_forecast_import_v2($1,$2::jsonb,true,$3::jsonb) r', [scope, '[]', '{}']), '22023');
  await reject(async () => { await owner(); await db.query("INSERT INTO public.payable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode) VALUES($1,'zero-orphan-synthetic.csv',repeat('f',64),$2,0,0,0,0,'FORECAST')", [scope, users.manager.id]); await db.exec('SET CONSTRAINTS ALL IMMEDIATE'); }, '22023');
  const before = await state();
  await reject(async () => { await owner(); await db.exec("UPDATE public.payable_imports SET row_count=0,new_count=0,open_count=0 WHERE row_count>0"); await db.exec('SET CONSTRAINTS ALL IMMEDIATE'); }, '22023');
  assert.deepEqual(await state(), before);
 });
 await test('reusing the same empty source after a nonempty cheque position pays its missing members once and preserves the original bytes', async () => {
  const original = emptySource(), first = await commitCheques(await freezeCheques([], true, original));
  const live = { ...row('LAST-CHEQUE'), source_status: 'CHEQUE', cheque_number: '000009' };
  await commitCheques(await freezeCheques([live], false, source()));
  const request = await freezeCheques([], true, original); assert.equal(request.preview.auto_payment_count, 1); assert.equal(request.preview.auto_payment_cents, 10000);
  const result = await commitCheques(request); assert.equal(result.paid_count, 1); assert.equal(result.payment_cents, 10000); assert.equal(result.import_id, first.import_id); assert.notEqual(result.report_id, first.report_id);
  await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  const settled = await title('LAST-CHEQUE'); assert.equal(settled.financial_status, 'PAID'); assert.equal(settled.last_payment_date, today); assert.equal(settled.cheque_number, '000009');
  await owner(); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_imports WHERE file_sha256=$1', [original.sha]), 1);
  assert.equal(await scalar("SELECT encode(sha256(file_bytes),'hex') r FROM cf_private.payable_import_files WHERE import_id=$1", [first.import_id]), original.sha); await actor();
  const before = await state(), replay = await commitCheques(request); assert.equal(replay.idempotent, true); assert.equal(replay.report_id, result.report_id); assert.deepEqual(await state(), before);
 });
 await test('an empty-source reuse with no payment still changes the private-head revision and rejects another stale confirmation', async () => {
  const original = emptySource(), first = await commitCheques(await freezeCheques([], true, original));
  await commitCheques(await freezeCheques([], true, emptySource('\r\n')));
  const revision = await scalar('SELECT public.get_payables_revision() r'), stale = await freezeCheques([], true, emptySource('\r\n\r\n'));
  const repeat = await commitCheques(await freezeCheques([], true, original)); assert.equal(repeat.import_id, first.import_id); assert.equal(repeat.paid_count, 0);
  await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  assert.deepEqual(await scalar('SELECT public.get_payables_revision() r'), revision);
  const fresh = await freezeCheques([], true, emptySource('\r\n\r\n')); assert.notEqual(fresh.financial, stale.financial);
  const before = await state(); await reject(() => commitCheques(stale), '40001'); assert.deepEqual(await state(), before);
 });
 await test('late ERP correction failure rolls back the reversal, replacement and preserved original file together', async () => {
  await dailyExcept('ATOMIC'); const request = await paidRequest([paidRow('ATOMIC')]), before = await state();
  await owner(); await db.exec("ALTER TABLE public.audit_events ADD CONSTRAINT synthetic_reject_daily_correction CHECK(entity<>'payable_import_resolution') NOT VALID"); await actor();
  try { await reject(() => commitPaid(request), '23514'); }
  finally { await owner(); await db.exec('ALTER TABLE public.audit_events DROP CONSTRAINT synthetic_reject_daily_correction'); await actor(); }
  assert.deepEqual(await state(), before);
 });
 await test('an altered ownership contract fails closed instead of silently expanding correction rights', async () => {
  await owner(); const body = await definition(); await db.exec(body.replace('daily_058.title_id=p.title_id', 'daily_058.title_id IS NOT NULL'));
  await reject(() => db.exec(fragment), '22023');
 });
 console.log(`${passed} payable daily paid-consumer SQL checks passed.`);
} catch (error) { console.error('FAIL', error.message, error.code ?? '', error.where ?? '', error.stack); process.exitCode = 1; }
finally { await db.close(); }
