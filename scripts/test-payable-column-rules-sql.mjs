import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { validColumnRulesPaidPreview, validReconciliationPreview } from '../supabase/functions/payables-import/reconciliation.mjs';

// Use the production browser guard verbatim against real SQL output. Append an
// export only in this in-memory build; no browser, network or published bundle.
const componentUrl = new URL('../src/components/PayablePaidImport.tsx', import.meta.url);
const browserGuardBuild = await build({
  stdin: { contents: await readFile(componentUrl, 'utf8') + '\nexport { validCanonical };\n', resolveDir: new URL('../src/components/', import.meta.url).pathname, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  define: { 'import.meta.env': '{}' }, loader: { '.css': 'empty' },
});
const browserGuardModule = { exports: {} };
new Function('require', 'module', 'exports', browserGuardBuild.outputFiles[0].text)(createRequire(import.meta.url), browserGuardModule, browserGuardModule.exports);
const { validCanonical: validBrowserPaidCanonical } = browserGuardModule.exports;
const syntheticProofHash = 'e'.repeat(64);

// Independent disposable PostgreSQL checks. All titles, files and payments are synthetic.
const { db, users, owner, actor, scalar, file } = await createCostFixture();
const scope = 'grupo-consolidado', plan = 'PLANO COLUNAS SINTETICO', branch = 'FILIAL COLUNAS SINTETICA';
const mappings = { [plan]: 'FIXO' };
let passed = 0, sequence = 0, today, yesterday, earlier, bank, bankLabel, otherBank, otherBankLabel, chequeBank, migration, legacyPayment, legacyPaidRequest, legacyPaidResult, previousPaidRequest, previousDailyRequest;
const date = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const original = () => { const bytes = Buffer.from(`Arquivo de colunas sintético ${++sequence}`); return { name: `colunas-${sequence}.csv`, hash: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }; };
const row = (entry_number, amount_cents = 10000, extra = {}) => ({ entry_number, branch, description: `Fornecedor sintético ${entry_number} - parcela 2/6`, due_date: yesterday, amount_cents, issued_on: earlier, source_status: 'ABERTO', plan, bank_account: bankLabel, ...extra });
const paidRow = (entry_number, amount_paid_cents = 10000, extra = {}) => ({ entry_number, branch, source_status: 'PAGO', paid_on: today, amount_paid_cents, paid_bank: otherBankLabel, ...extra });
const title = entry => scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1 AND branch=$2', [entry, branch]);
const tables = ['public.payable_titles', 'public.payable_imports', 'cf_private.payable_import_files', 'public.payable_payments', 'public.payable_payment_reversals', 'public.payable_title_reviews', 'public.payable_paid_import_rows', 'public.payable_paid_bank_mappings', 'cf_private.payable_import_resolution_requests', 'cf_private.payable_daily_reports', 'cf_private.payable_daily_requests', 'cf_private.payable_daily_actions', 'public.payable_administrative_writeoffs', 'public.audit_events', 'public.bank_accounts', 'public.bank_balance_positions'];
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
async function openRows() {
  const result = await db.query('SELECT * FROM public.payable_review_titles WHERE closing_eligible AND payment_remaining_cents>0 AND administrative_writeoff_id IS NULL ORDER BY entry_number');
  return result.rows.map(item => row(item.entry_number, Number(item.amount_cents), { description: item.description, branch: item.branch, due_date: date(item.due_date), issued_on: item.issued_on ? date(item.issued_on) : null, source_status: item.source_status ?? '', plan: item.plan, bank_account: item.bank_account ?? '', cheque_number: item.cheque_number }));
}
const dailyPreview = (rows, kind = 'NORMAL', choices = {}, banks = {}, map = mappings, empty = false) => scalar('SELECT public.preview_payables_daily_report($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) r', [scope, JSON.stringify(rows), kind, JSON.stringify(map), JSON.stringify(banks), JSON.stringify(choices), empty]);
async function dailyRequest(rows, kind = 'NORMAL', options = {}) {
  const choices = options.choices ?? {}, banks = options.banks ?? {}, map = options.mappings ?? (options.empty ? {} : mappings);
  const preview = await dailyPreview(rows, kind, choices, banks, map, options.empty ?? false);
  return { rows, kind, choices, banks, mappings: map, empty: false, preview, original: original(), request: randomUUID(), ...options };
}
async function commitDaily(request) {
  await owner(); await db.exec('SET ROLE service_role');
  const p = request.preview, o = request.original;
  const result = await scalar('SELECT public.commit_payables_daily_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::date,$15,$16) r', [users.manager.id, users.manager.session, scope, o.name, o.hash, o.base64, JSON.stringify(request.rows), request.kind, JSON.stringify(request.mappings), JSON.stringify(request.banks), JSON.stringify(request.choices), p.previous_import_id, p.financial_revision, p.report_date, request.request, request.empty]);
  await actor(); return result;
}
async function paidPreview(rows, banks = {}, choices = {}) {
  const preview = await scalar('SELECT public.preview_payables_paid_import_v2($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb) r', [scope, JSON.stringify(rows), JSON.stringify(banks), '{}', JSON.stringify(choices)]);
  assert.equal(validColumnRulesPaidPreview(preview, rows), true, 'Actual SQL must satisfy the gateway cheque-bank contract: ' + JSON.stringify(preview));
  assert.equal(validReconciliationPreview(preview, { rowCount: rows.length, mode: 'payments', sourceRows: rows, resolutionChoices: choices, bankRulesVersion: '050', columnRulesVersion: '059' }), true, 'Actual SQL must satisfy the gateway financial-review contract: ' + JSON.stringify(preview));
  assert.equal(validBrowserPaidCanonical({ rows: preview.rows, preview, file_sha256: syntheticProofHash, payment_date_version: '2026-10-27.1', bank_rules_version: '050' }, syntheticProofHash), true, 'Actual SQL must satisfy the browser paid-import contract: ' + JSON.stringify(preview));
  return preview;
}
async function paidRequest(rows, options = {}) {
  const revision = await scalar('SELECT public.get_payables_revision() r');
  return { rows, banks: {}, choices: {}, confirm: false, original: original(), previous: revision.import_id, financial: revision.financial_revision, request: randomUUID(), ...options };
}
async function commitPaid(request) {
  await owner(); await db.exec('SET ROLE service_role'); const o = request.original;
  const result = await scalar('SELECT public.commit_payables_paid_import_v2_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,$13::jsonb,$14) r', [users.manager.id, users.manager.session, scope, o.name, o.hash, o.base64, JSON.stringify(request.rows), JSON.stringify(request.banks), request.previous, request.confirm, '{}', request.financial, JSON.stringify(request.choices), request.request]);
  await actor(); return result;
}
async function manualRequest(entry, paymentBank = bank) {
  const t = await title(entry);
  return { title: t.id, amount: t.payment_remaining_cents, bank: paymentBank, date: today, observation: 'Pagamento integral sintético conferido nas colunas', revision: t.payment_revision, import: t.last_import_id, request: randomUUID() };
}
const commitManual = request => scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r', [request.title, request.amount, request.date, request.bank, request.observation, request.revision, request.request, request.import]);
const actualBank = id => scalar('SELECT bank_account_id r FROM public.payable_payments WHERE title_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [id]);

try {
  ({ today, yesterday, earlier } = (await db.query("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text yesterday,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-10)::text earlier")).rows[0]);
  const banks = (await db.query("SELECT id,display_name FROM public.bank_accounts WHERE enabled AND account_type='BANK' AND display_name<>'BRADESCO F2G' ORDER BY id LIMIT 2")).rows;
  ({ id: bank, display_name: bankLabel } = banks[0]); ({ id: otherBank, display_name: otherBankLabel } = banks[1]);
  chequeBank = await scalar("SELECT id r FROM public.bank_accounts WHERE enabled AND account_type='BANK' AND display_name='BRADESCO F2G'"); assert(chequeBank);
  const initial = [row('KEEP'), row('ORDINARY', 20000), row('CHEQUE', 30000, { cheque_number: '000031', bank_account: 'CAIXA INTERNO' }), row('OMITTED', 40000, { cheque_number: '000041' }), row('CLEAR', 50000, { cheque_number: '000051' }), row('MANUAL', 60000, { cheque_number: '000061' }), row('REPLAY', 70000, { cheque_number: '000071' }), row('CENT', 80000, { cheque_number: '000081', bank_account: 'CAIXA INTERNO' }), row('PAID-CACHE', 110000, { cheque_number: '0000111' })];
  const o = original(); await owner(); await db.exec('SET ROLE service_role');
  await scalar('SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,null) r', [users.manager.id, users.manager.session, scope, o.name, o.hash, o.base64, JSON.stringify(initial), JSON.stringify(mappings)]);
  await actor(); legacyPayment = await manualRequest('REPLAY', bank); legacyPayment.id = await commitManual(legacyPayment);
  await owner(); for (const name of ['042_payable_administrative_writeoff.sql', '043_payable_import_reconciliation.sql', '050_paid_bank_rules.sql', '058_payable_daily_reports.sql']) await db.exec(await file(name)); await actor();
  legacyPaidRequest = await paidRequest([paidRow('PAID-CACHE', 110000, { cheque_number: '0000111' })]); legacyPaidResult = await commitPaid(legacyPaidRequest);
  assert.equal(await actualBank((await title('PAID-CACHE')).id), otherBank, 'The prior rules allowed this synthetic paid-file cheque to use another bank');
  previousPaidRequest = await paidRequest([paidRow('ORDINARY', 20000)]); previousDailyRequest = await dailyRequest(await openRows());
  const beforeInstall = await state();
  migration = (await readdir(new URL('../supabase/migrations/', import.meta.url))).find(name => /^059_.*\.sql$/.test(name)); assert(migration, 'The new 059 migration must exist before this suite runs');
  await owner(); await db.exec(await file(migration)); await actor();

  await test('059 activation and repeated activation preserve all existing financial rows and original reports', async () => {
    assert.deepEqual(await state(), beforeInstall); const capabilities = await scalar('SELECT public.payables_import_capabilities() r');
    assert.equal(capabilities.column_rules_version, '059'); assert.equal(capabilities.daily_report_version, '059');
    const before = await state(); await owner(); await db.exec(await file(migration)); await actor(); assert.deepEqual(await state(), before);
  });
  await test('activation invalidates paid and daily previews prepared under earlier column rules without applying them', async () => {
    const before = await state(); await rejects(() => commitPaid(previousPaidRequest), '40001'); assert.deepEqual(await state(), before);
    await rejects(() => commitDaily(previousDailyRequest), '40001'); assert.deepEqual(await state(), before);
  });
  await test('a new protocol cannot reuse a legacy paid file whose cheque used another bank, while its completed original protocol still replays', async () => {
    const p = await paidPreview(legacyPaidRequest.rows); assert.equal(p.correction_count, 1); assert.equal(p.rows[0].bank_account_id, chequeBank);
    const before = await state(), current = await paidRequest(legacyPaidRequest.rows, { original: legacyPaidRequest.original, confirm: true });
    await rejects(() => commitPaid(current), 'P0042'); assert.deepEqual(await state(), before);
    const replay = await commitPaid(legacyPaidRequest); assert.equal(replay.idempotent, true); assert.equal(replay.import_id, legacyPaidResult.import_id); assert.deepEqual(await state(), before);
    assert.equal(await actualBank((await title('PAID-CACHE')).id), otherBank, 'The legacy payment is preserved for explicit correction, never silently rewritten');
  });
  await test('the global report provisions every cheque while keeping its raw bank and separate cheque baseline', async () => {
    const rows = [...await openRows(), row('GLOBAL-NEW-CHEQUE', 12345, { cheque_number: '0000123', bank_account: 'BANCO PREVISTO SINTETICO' })], p = await dailyPreview(rows);
    assert.equal(p.daily_report_version, '059'); assert.equal(p.row_count, rows.length); assert.equal(p.ignored_cheque_count, 0); assert.equal(p.new_count, 1); assert.equal(p.can_commit, true);
    const result = await commitDaily(await dailyRequest(rows)); assert.equal(result.row_count, rows.length); assert.equal(result.paid_count, 0);
    const t = await title('GLOBAL-NEW-CHEQUE'); assert.equal(t.amount_cents, 12345); assert.equal(t.cheque_number, '0000123'); assert.equal(t.bank_account, 'BANCO PREVISTO SINTETICO'); assert.equal(t.paid_cents, 0);
    const cheque = await dailyPreview([rows.at(-1)], 'CHEQUES'); assert.equal(cheque.baseline_only, true); assert.equal(cheque.missing_count, 0);
  });
  await test('latest value, maturity, emission, history, plan and forecast bank update the same identity with audit', async () => {
    const first = await title('OMITTED'), rows = await openRows(), newPlan = 'PLANO COLUNAS ATUALIZADO', description = 'Descrição atualizada com parcela 3/6';
    const changed = rows.map(item => item.entry_number === 'OMITTED' ? { ...item, amount_cents: 45678, due_date: today, issued_on: yesterday, description, plan: newPlan, bank_account: otherBankLabel, cheque_number: '0000042' } : item);
    const map = { ...mappings, [newPlan]: 'VARIÁVEL' }, request = await dailyRequest(changed, 'NORMAL', { mappings: map }); assert.equal(request.preview.changed_count, 1); assert.equal(request.preview.can_commit, true);
    await commitDaily(request); const after = await title('OMITTED');
    assert.equal(after.id, first.id); assert.equal(after.first_import_id, first.first_import_id); assert.equal(after.amount_cents, 45678); assert.equal(date(after.due_date), today); assert.equal(date(after.issued_on), yesterday); assert.equal(after.description, description); assert.equal(after.plan, newPlan); assert.equal(after.macro, 'VARIÁVEL'); assert.equal(after.bank_account, otherBankLabel); assert.equal(after.cheque_number, '0000042');
    assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_titles WHERE entry_number=$1 AND branch=$2', ['OMITTED', branch]), 1);
    await owner(); const audit = await scalar("SELECT to_jsonb(a) r FROM public.audit_events a WHERE entity='payable_titles' AND record_id=$1 AND before_value->>'amount_cents'='40000' AND after_value->>'amount_cents'='45678' ORDER BY occurred_at DESC LIMIT 1", [first.id]); await actor(); assert(audit); assert.equal(audit.before_value.bank_account, bankLabel); assert.equal(audit.after_value.description, description);
  });
  await test('omitting a cheque from a later global report never settles it or advances the cheque comparison head', async () => {
    const all = await openRows(); await commitDaily(await dailyRequest(all)); const rows = all.filter(item => !item.cheque_number); const p = await dailyPreview(rows); assert.equal(p.can_commit, true); assert.equal(p.missing_count, 0);
    await commitDaily(await dailyRequest(rows)); assert.equal((await title('CHEQUE')).paid_cents, 0);
    await owner(); assert.equal(await scalar("SELECT count(*)::int r FROM cf_private.payable_daily_reports WHERE report_kind='CHEQUES'"), 0); await actor();
    const pCheque = await dailyPreview([all.find(item => item.entry_number === 'OMITTED')], 'CHEQUES'); assert.equal(pCheque.baseline_only, true); assert.equal(pCheque.missing_count, 0);
  });
  await test('ordinary actual payment can use another account without replacing the forecast bank', async () => {
    const before = await title('ORDINARY'), rows = [paidRow('ORDINARY', 20000)], p = await paidPreview(rows); assert.equal(p.can_commit, true); assert.equal(p.rows[0].bank_account_id, otherBank); assert.equal(p.rows[0].payment_bank_rule, 'SOURCE_BANK');
    const request = await paidRequest(rows), result = await commitPaid(request); assert.equal(result.new_payment_count, 1);
    const after = await title('ORDINARY'); assert.equal(after.bank_account, before.bank_account); assert.equal(await actualBank(after.id), otherBank); assert.equal(after.review_status, 'CONCILIADO');
    const stateBeforeReplay = await state(); assert.equal((await commitPaid(request)).idempotent, true); assert.deepEqual(await state(), stateBeforeReplay);
  });
  await test('a numbered cheque reported as Caixa Interno creates a real F2G payment and preserves its source bank', async () => {
    const rows = [paidRow('CHEQUE', 30000, { paid_bank: 'CAIXA INTERNO', cheque_number: '000031' })], p = await paidPreview(rows);
    assert.equal(p.column_rules_version, '059'); assert.equal(p.cheque_payment_bank_id, chequeBank); assert.equal(p.can_commit, true); assert.equal(p.writeoff_count, 0); assert.equal(p.rows[0].payment_bank_rule, 'CHEQUE_F2G'); assert.equal(p.rows[0].bank_account_id, chequeBank);
    await commitPaid(await paidRequest(rows)); const t = await title('CHEQUE'); assert.equal(t.financial_status, 'PAID'); assert.equal(t.bank_account, 'CAIXA INTERNO'); assert.equal(await actualBank(t.id), chequeBank);
    await owner(); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_administrative_writeoffs WHERE title_id=$1', [t.id]), 0); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_paid_bank_mappings WHERE bank_account_id=$1', [chequeBank]), 0); await actor();
  });
  await test('an incoming explicit cheque number selects F2G before the title has a cheque recorded', async () => {
    const rows = [paidRow('ORDINARY', 20000, { cheque_number: '0000099' })], p = await paidPreview(rows); assert.equal(p.can_commit, true); assert.equal(p.rows[0].bank_account_id, chequeBank); assert.equal(p.rows[0].payment_bank_rule, 'CHEQUE_F2G');
    await commitPaid(await paidRequest(rows)); const t = await title('ORDINARY'); assert.equal(t.cheque_number, '0000099'); assert.equal(t.bank_account, bankLabel); assert.equal(await actualBank(t.id), chequeBank);
  });
  await test('a shared source-bank mapping applies only to ordinary payments while cheques retain F2G', async () => {
    const rawBank = 'BANCO COMPARTILHADO SINTETICO', rows = [paidRow('ORDINARY', 20000, { paid_bank: rawBank }), paidRow('CHEQUE', 30000, { paid_bank: rawBank, cheque_number: '000031' })], pending = await paidPreview(rows);
    const item = pending.unmapped_banks.find(item => item.paid_bank === rawBank); assert(item); const banks = { [item.key]: otherBank }, p = await paidPreview(rows, banks); assert.equal(p.can_commit, true);
    assert.equal(p.rows.find(item => item.entry_number === 'ORDINARY').bank_account_id, otherBank); assert.equal(p.rows.find(item => item.entry_number === 'CHEQUE').bank_account_id, chequeBank);
    await commitPaid(await paidRequest(rows, { banks })); assert.equal(await actualBank((await title('ORDINARY')).id), otherBank); assert.equal(await actualBank((await title('CHEQUE')).id), chequeBank);
    await owner(); const configured = await scalar('SELECT jsonb_agg(bank_account_id) r FROM public.payable_paid_bank_mappings WHERE paid_bank=$1', [rawBank]); await actor(); assert.deepEqual(configured, [otherBank]); assert.equal((await title('CHEQUE')).bank_account, 'CAIXA INTERNO');
  });
  await test('an omitted cheque column uses the known title number and an explicit blank can clear it', async () => {
    const omitted = await paidPreview([paidRow('OMITTED', 40000)]); assert.equal(omitted.can_commit, true); assert.equal(omitted.rows[0].bank_account_id, chequeBank); assert.equal(omitted.rows[0].payment_bank_rule, 'CHEQUE_F2G');
    await commitPaid(await paidRequest([paidRow('OMITTED', 40000)])); const known = await title('OMITTED'); assert.equal(known.cheque_number, '000041'); assert.equal(await actualBank(known.id), chequeBank);
    const cleared = await paidPreview([paidRow('CLEAR', 50000, { cheque_number: '' })]); assert.equal(cleared.can_commit, true); assert.equal(cleared.rows[0].bank_account_id, otherBank); assert.equal(cleared.rows[0].payment_bank_rule, 'SOURCE_BANK');
    await commitPaid(await paidRequest([paidRow('CLEAR', 50000, { cheque_number: '' })])); const t = await title('CLEAR'); assert.equal(t.cheque_number, null); assert.equal(await actualBank(t.id), otherBank); assert.equal(t.bank_account, bankLabel);
  });
  await test('manual ordinary bank changes remain possible, while a numbered cheque only accepts F2G', async () => {
    const normal = await manualRequest('ORDINARY', otherBank); await commitManual(normal); assert.equal(await actualBank(normal.title), otherBank); assert.equal((await title('ORDINARY')).bank_account, bankLabel);
    const cheque = await manualRequest('MANUAL', otherBank), before = await state(); await rejects(() => commitManual(cheque), '22023'); assert.deepEqual(await state(), before);
    const valid = { ...cheque, bank: chequeBank }; const payment = await commitManual(valid); assert(payment); assert.equal(await actualBank(valid.title), chequeBank); assert.equal((await title('MANUAL')).bank_account, bankLabel);
  });
  await test('a completed old cheque request replays its exact original payment before the new bank rule', async () => {
    const before = await state(); assert.equal(await commitManual(legacyPayment), legacyPayment.id); assert.deepEqual(await state(), before); assert.equal(await actualBank(legacyPayment.title), bank);
  });
  await test('one-cent cheque markers still require individual nonfinancial closure and preserve the nominal', async () => {
    const rows = [paidRow('CENT', 1, { paid_bank: 'CAIXA INTERNO', cheque_number: '000081', paid_on: null })], p = await paidPreview(rows); assert.equal(p.can_commit, false); assert.equal(p.writeoff_count, 1);
    const before = await state(); await rejects(async () => commitPaid(await paidRequest(rows)), 'P0042'); assert.deepEqual(await state(), before);
    const choices = { 'row:1': { action: 'WRITE_OFF', reason: 'Marcador de um centavo confirmado individualmente no teste' } }; assert.equal((await paidPreview(rows, {}, choices)).can_commit, true);
    await commitPaid(await paidRequest(rows, { choices })); const t = await title('CENT'); assert.equal(t.amount_cents, 80000); assert.equal(t.financial_status, 'ADMIN_WRITEOFF'); assert.equal(t.paid_cents, 0); assert.equal(t.bank_account, 'CAIXA INTERNO');
  });
  await test('a separate cheque report settles absent known cheques at import date using F2G without bank-group pollution', async () => {
    const first = (await openRows()).filter(item => ['CHEQUE', 'OMITTED'].includes(item.entry_number)); assert.equal((await dailyPreview(first, 'CHEQUES')).baseline_only, true); await commitDaily(await dailyRequest(first, 'CHEQUES'));
    const rows = first.filter(item => item.entry_number === 'OMITTED'), p = await dailyPreview(rows, 'CHEQUES'); assert.equal(p.can_commit, true); assert.equal(p.auto_payment_count, 1); assert.equal(p.automatic_actions[0].bank_account_id, chequeBank); assert.equal(p.automatic_actions[0].paid_on, today);
    const result = await commitDaily(await dailyRequest(rows, 'CHEQUES')); assert.equal(result.paid_count, 1); const t = await title('CHEQUE'); assert.equal(await actualBank(t.id), chequeBank); assert.equal(date(t.last_payment_date), today); assert.equal(t.bank_account, 'CAIXA INTERNO');
    await owner(); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_paid_bank_mappings WHERE bank_account_id=$1', [chequeBank]), 0); await actor();
  });
  await test('missing or ambiguous official F2G accounts block new cheque payments and cannot be replaced by a different account', async () => {
    await owner(); await db.query('UPDATE public.bank_accounts SET enabled=false WHERE id=$1', [chequeBank]); await actor();
    let p = await paidPreview([paidRow('OMITTED', 40000)]); assert.equal(p.can_commit, false); assert.equal(p.cheque_payment_bank_id, null); assert.equal(p.rows[0].bank_account_id, null);
    const normal = await manualRequest('ORDINARY', otherBank); await commitManual(normal); assert.equal(await actualBank(normal.title), otherBank);
    const before = await state(); await rejects(async () => commitManual(await manualRequest('MANUAL', otherBank)), '22023'); assert.deepEqual(await state(), before);
    await owner(); await db.query('UPDATE public.bank_accounts SET enabled=true WHERE id=$1', [chequeBank]); await db.query("INSERT INTO public.bank_accounts(company,bank,account_label,account_type,display_name) VALUES('EMPRESA SINTETICA','Banco sintético','Conta duplicada sintética','BANK','  bradesco   f2g  ')"); await actor();
    p = await paidPreview([paidRow('OMITTED', 40000)]); assert.equal(p.can_commit, false); assert.equal(p.cheque_payment_bank_id, null); assert.equal(p.rows[0].bank_account_id, null);
    const beforeAmbiguous = await state(); await rejects(async () => commitManual(await manualRequest('MANUAL', chequeBank)), '22023'); assert.deepEqual(await state(), beforeAmbiguous);
  });
  await test('late audit rejection rolls back the paid file, title update, payment and financial revision together', async () => {
    const rows = [paidRow('CHEQUE', 30000, { cheque_number: '000031', paid_bank: 'CAIXA INTERNO' })], request = await paidRequest(rows), before = await state();
    await owner(); await db.exec("ALTER TABLE public.audit_events ADD CONSTRAINT synthetic_reject_columns CHECK(entity<>'payable_import_resolution') NOT VALID"); await actor();
    await rejects(() => commitPaid(request), '23514'); await owner(); await db.exec('ALTER TABLE public.audit_events DROP CONSTRAINT synthetic_reject_columns'); await actor(); assert.deepEqual(await state(), before);
  });
  console.log(`${passed} passed (payable column rules 059, independent synthetic local PostgreSQL)`);
} catch (error) { console.error('FAIL', error); process.exitCode = 1; } finally { await db.close(); }
