import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildPayablesOperationsSql, PAYABLES_OPERATION_MIGRATIONS, writePayablesOperationsBundle } from './bundle-payables-operations.mjs';

// Isolated PostgreSQL only. Every identity, amount, file and observation is synthetic.
const uid = '10000000-0000-4000-8000-000000000001', sid = '20000000-0000-4000-8000-000000000001';
const baseMigrations = ['001_identidade_rbac.sql', '003_auth_gateway.sql', '004_password_recovery.sql', '005_payables.sql', '006_treasury.sql', '007_director_positions.sql', '008_receivables.sql', '009_collections.sql', '010_bank_import.sql', '011_receivables_positions.sql'];
const baselineTables = ['auth.users', 'public.profiles', 'public.bank_balance_positions', 'public.stock_positions', 'public.payable_imports', 'public.payable_titles', 'cf_private.payable_import_files', 'public.payable_plan_mappings', 'public.management_messages', 'public.director_positions', 'public.audit_events'];
const databases = [];
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS', name); };
const scalar = async (db, sql, args = []) => (await db.query(sql, args)).rows[0].r;
const source = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const forecastSql = 'SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r';
const paidImportSql = 'SELECT public.commit_payables_paid_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS r';
function importArgs(label, rows, previous, payments = false, corrections = false, financialRevision = null) {
  const bytes = Buffer.from(`Relatório original sintético de ativação: ${label}.`);
  const base = [uid, sid, 'grupo-consolidado', `${label}.csv`, createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), '{}', previous];
  return payments ? [...base, corrections, '{}', financialRevision] : base;
}
async function gateway(db, sql, args) {
  await actor(db, 'service_role');
  try { return await scalar(db, sql, args); }
  finally { await actor(db); }
}
async function actor(db, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [uid, JSON.stringify({ session_id: sid, role: 'authenticated' })]);
  await db.exec(`SET ROLE ${role}`);
}
async function tableState(db, tables, ignoreAddedMetadata = false) {
  await db.exec('RESET ROLE');
  return Object.fromEntries(await Promise.all(tables.map(async table => {
    // Compare pre-upgrade business fields; assert new nullable cheque/default LEGACY metadata separately.
    let value = ignoreAddedMetadata && ['public.payable_titles', 'public.payable_payments'].includes(table) ? "to_jsonb(t)-'cheque_number'" : 'to_jsonb(t)';
    if (ignoreAddedMetadata && table === 'public.payable_imports') value += "-'import_mode'";
    return [table, await scalar(db, `SELECT coalesce(jsonb_agg(${value} ORDER BY (${value})::text),'[]') AS r FROM ${table} t`)];
  })));
}
async function allTableState(db) {
  await db.exec('RESET ROLE');
  const tables = (await db.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN ('public','cf_private','auth') ORDER BY schemaname,tablename")).rows.map(row => row.name);
  return tableState(db, tables);
}
async function originalAccounts(db) {
  await db.exec('RESET ROLE');
  return (await db.query('SELECT id,company,bank,account_label,enabled,created_at FROM public.bank_accounts ORDER BY id')).rows;
}
async function fixture(preinstalled = []) {
  const db = new PGlite(); databases.push(db);
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for (const name of [...baseMigrations, ...preinstalled]) await db.exec(await source(name));
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [uid, 'synthetic-activation@example.invalid']);
  await db.query("INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,'SyntheticActivation','Teste sintético','gerente_geral',true)", [uid]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [sid, uid]);
  await actor(db);
  const today = await scalar(db, "SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS r");
  const bank = await scalar(db, 'SELECT id AS r FROM public.bank_accounts WHERE enabled ORDER BY id LIMIT 1');
  await scalar(db, "SELECT public.set_bank_balance($1,$2,12345,'Saldo sintético anterior à ativação',null) AS r", [bank, today]);
  await scalar(db, "SELECT public.save_manual_stock(45678,$1,'Estoque sintético anterior à ativação') AS r", [today]);
  await scalar(db, "SELECT public.create_management_message('normal',null,'Mensagem sintética preservada') AS r");
  const bytes = Buffer.from('Arquivo completo sintético de ativação, sem dados reais.');
  const rows = [{ entry_number: 'CP-SYNTHETIC-1', description: 'Fornecedor sintético preservado', due_date: today, amount_cents: 12000, source_status: 'ABERTO', plan: 'INVESTIMENTOS', bank_account: 'Banco sintético da base', branch: '2 - TESTE', issued_on: today }];
  await actor(db, 'service_role');
  const imported = await scalar(db, 'SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,null) AS r', [uid, sid, 'grupo-consolidado', 'fixture.csv', createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), '{}']);
  await actor(db);
  await scalar(db, 'SELECT public.save_director_position($1,$1) AS r', [today]);
  await db.exec('RESET ROLE');
  return { db, today, bank, imported };
}
async function assertUpgradeAbsent(db) {
  assert.equal(await scalar(db, "SELECT to_regclass('public.payable_payments')::text AS r"), null);
  assert.equal(await scalar(db, "SELECT to_regclass('public.payable_forecast_rules')::text AS r"), null);
  assert.equal(await scalar(db, "SELECT to_regclass('cf_private.payable_identity_registry')::text AS r"), null);
  assert.equal(await scalar(db, "SELECT to_regclass('public.payable_month_closures')::text AS r"), null);
  assert.equal(await scalar(db, "SELECT to_regclass('public.payable_import_modes')::text AS r"), null);
  assert.equal(await scalar(db, "SELECT to_regprocedure('public.payables_management_summary(date,date)')::text AS r"), null);
  assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM information_schema.columns WHERE table_schema='public' AND table_name='bank_accounts' AND column_name='account_type'"), 0);
  assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version>='012'"), 0);
}

try {
  const bundle = await buildPayablesOperationsSql();
  await test('generated activation is current and contains all ten ordered, conditional source migrations under one transaction', async () => {
    await writePayablesOperationsBundle();
    assert.equal(await readFile(new URL('../supabase/dashboard/ativar-contas-pagar.sql', import.meta.url), 'utf8'), bundle);
    assert.equal((bundle.match(/^BEGIN;$/gm) ?? []).length, 1);
    assert.equal((bundle.match(/^COMMIT;$/gm) ?? []).length, 1);
    let previous = -1;
    for (const migration of PAYABLES_OPERATION_MIGRATIONS) {
      const position = bundle.indexOf(`-- SOURCE: ${migration}`);
      assert(position > previous); previous = position;
      assert(bundle.includes(`WHERE version='${migration.replace(/\.sql$/, '')}'`));
    }
  });

  await test('one activation from the eleven-account baseline preserves users, files, balances, stock, CP and immutable history', async () => {
    const { db } = await fixture();
    const before = await tableState(db, baselineTables, true), accounts = await originalAccounts(db);
    await db.exec(bundle);
    assert.deepEqual(await tableState(db, baselineTables, true), before);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_titles WHERE cheque_number IS NOT NULL'), 0);
    assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.payable_imports WHERE import_mode<>'LEGACY'"), 0);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.bank_accounts'), 17);
    const preserved = (await originalAccounts(db)).filter(account => accounts.some(old => old.id === account.id));
    assert.deepEqual(preserved, accounts);
    for (const migration of PAYABLES_OPERATION_MIGRATIONS) assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version=$1', [migration.replace(/\.sql$/, '')]), 1);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_forecast_rules'), 4);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_payments'), 0);
  });

  await test('repeating activation preserves exact registry timestamps, configured forecasts, payments and every persisted table', async () => {
    const { db, today, bank } = await fixture(); await db.exec(bundle);
    await actor(db);
    const forecastId = await scalar(db, "SELECT id AS r FROM public.payable_forecast_rules WHERE rule_key='SALARIOS' ORDER BY created_at DESC,id DESC LIMIT 1");
    const nextMonth = await scalar(db, "SELECT date_trunc('month',$1::date+interval '1 month')::date::text AS r", [today]);
    await scalar(db, "SELECT public.save_payable_forecast_rule('SALARIOS',123456,7,$1,'Configuração sintética após ativação',$2) AS r", [nextMonth, forecastId]);
    const title = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_financial_titles t LIMIT 1');
    await scalar(db, 'SELECT public.register_payable_payment($1,12000,$2,$3,$4,$5,$6,$7) AS r', [title.id, today, bank, 'Pagamento integral sintético preservado', title.payment_revision, randomUUID(), title.last_import_id]);
    const before = await allTableState(db);
    await db.exec(bundle);
    assert.deepEqual(await allTableState(db), before);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_forecast_rules'), 5);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_payments'), 1);
  });

  await test('already-installed 012 and 013 are skipped without resetting account settings or daily Director inputs', async () => {
    const { db, today } = await fixture(['012_treasury_accounts.sql', '013_director_report.sql']);
    await db.exec("UPDATE public.bank_accounts SET display_name='CONTA SINTÉTICA PERSONALIZADA',enabled=false WHERE company='ECOPLAST' AND bank='Cora'");
    await actor(db);
    await scalar(db, "SELECT public.save_director_inputs($1,$2,'Complemento sintético preservado',null) AS r", [today, JSON.stringify({ turnover_month_cents: 12300, installments_cents: 0 })]);
    const before = await tableState(db, [...baselineTables, 'public.bank_accounts', 'public.director_report_inputs'], true);
    const installedBefore = (await db.query("SELECT * FROM public.central_schema_migrations WHERE version IN ('012_treasury_accounts','013_director_report') ORDER BY version")).rows;
    await db.exec(bundle);
    assert.deepEqual(await tableState(db, [...baselineTables, 'public.bank_accounts', 'public.director_report_inputs'], true), before);
    assert.deepEqual((await db.query("SELECT * FROM public.central_schema_migrations WHERE version IN ('012_treasury_accounts','013_director_report') ORDER BY version")).rows, installedBefore);
  });

  await test('missing baseline migration aborts before the first upgrade and preserves all existing business rows', async () => {
    const { db } = await fixture();
    await db.exec("DELETE FROM public.central_schema_migrations WHERE version='011_receivables_positions'");
    const before = await allTableState(db);
    await assert.rejects(db.exec(bundle), error => error.code === '22023' && error.message.includes('011_receivables_positions'));
    await db.exec('ROLLBACK');
    assert.deepEqual(await allTableState(db), before);
    await assertUpgradeAbsent(db);
  });

  await test('failure inside the last 021 source rolls back all earlier upgrades, config seeds and schema registry rows', async () => {
    const { db } = await fixture();
    const before = await allTableState(db);
    const marker = '-- END SOURCE BODY: 021_payable_paid_import.sql';
    assert.equal(bundle.split(marker).length, 2);
    const failing = bundle.replace(marker, `SELECT cf_private.synthetic_activation_021_failure();\n${marker}`);
    await assert.rejects(db.exec(failing), error => error.code === '42883' && error.message.includes('synthetic_activation_021_failure'));
    await db.exec('ROLLBACK');
    assert.deepEqual(await allTableState(db), before);
    await assertUpgradeAbsent(db);
  });

  await test('018 preserves earlier partial payments and accepts only exact settlement of the remaining balance', async () => {
    const { db, today, bank } = await fixture(PAYABLES_OPERATION_MIGRATIONS.filter(name => Number(name.slice(0, 3)) < 18));
    await actor(db);
    const title = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_financial_titles t LIMIT 1');
    const registerSql = 'SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) AS r';
    await scalar(db, registerSql, [title.id, 2500, today, bank, 'Pagamento parcial sintético anterior à regra integral', title.payment_revision, randomUUID(), title.last_import_id]);
    const preservedTables = [...baselineTables, 'public.payable_payments', 'public.payable_payment_reversals', 'cf_private.payable_payment_state', 'cf_private.payable_control_state', 'public.payable_title_control_revisions'];
    const before = await tableState(db, preservedTables, true);
    await db.exec(bundle);
    assert.deepEqual(await tableState(db, preservedTables, true), before);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_payments WHERE cheque_number IS NOT NULL'), 0);
    await actor(db);
    const partial = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_financial_titles t WHERE id=$1', [title.id]);
    assert.equal(partial.paid_cents, 2500);
    assert.equal(partial.payment_remaining_cents, 9500);
    assert.equal(partial.financial_status, 'PARTIAL');
    const beforeRejected = await allTableState(db);
    await actor(db);
    await assert.rejects(scalar(db, registerSql, [title.id, 1000, today, bank, 'Tentativa sintética parcial recusada', partial.payment_revision, randomUUID(), partial.last_import_id]), error => error.code === '22023');
    assert.deepEqual(await allTableState(db), beforeRejected);
    await actor(db);
    await scalar(db, registerSql, [title.id, 9500, today, bank, 'Quitação integral sintética do saldo restante', partial.payment_revision, randomUUID(), partial.last_import_id]);
    const settled = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_financial_titles t WHERE id=$1', [title.id]);
    assert.equal(settled.paid_cents, 12000);
    assert.equal(settled.payment_remaining_cents, 0);
    assert.equal(settled.financial_status, 'PAID');
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_payments'), 2);
  });

  await test('019 upgrades an active 018 installation without inventing old cheque numbers or changing its saved monthly closure', async () => {
    const { db, today, bank } = await fixture(PAYABLES_OPERATION_MIGRATIONS.filter(name => Number(name.slice(0, 3)) < 19));
    await actor(db);
    const title = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_financial_titles t LIMIT 1');
    await scalar(db, 'SELECT public.register_payable_payment($1,12000,$2,$3,$4,$5,$6,$7) AS r', [title.id, today, bank, 'Quitação sintética anterior ao cadastro dos cheques', title.payment_revision, randomUUID(), title.last_import_id]);
    const review = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_review_titles t WHERE id=$1', [title.id]);
    await scalar(db, "SELECT public.review_payable_title($1,'Conferência sintética anterior aos cheques',$2) AS r", [title.id, review.review_fingerprint]);
    const month = `${today.slice(0, 7)}-01`;
    const revision = await scalar(db, 'SELECT public.get_payables_revision() AS r');
    await scalar(db, "SELECT public.close_payables_month($1,'Fechamento sintético anterior aos cheques',$2) AS r", [month, JSON.stringify(revision)]);
    const preservedTables = [...baselineTables, 'public.payable_payments', 'public.payable_payment_reversals', 'public.payable_title_reviews', 'public.payable_month_closures', 'public.payable_month_events', 'cf_private.payable_payment_state', 'cf_private.payable_control_state', 'public.payable_title_control_revisions'];
    const before = await tableState(db, preservedTables, true);
    await db.exec(bundle);
    assert.deepEqual(await tableState(db, preservedTables, true), before);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_titles WHERE cheque_number IS NOT NULL'), 0);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_payments WHERE cheque_number IS NOT NULL'), 0);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_month_closures'), 1);
    await actor(db);
    const upgraded = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_financial_titles t WHERE id=$1', [title.id]);
    assert.equal(upgraded.id, title.id);
    assert.equal(upgraded.paid_cents, 12000);
    assert.equal(upgraded.financial_status, 'PAID');
    assert.equal(upgraded.cheque_number, null);
  });

  let operational;
  await test('incremental forecast imports update stable identities and never settle obligations absent from a later file', async () => {
    operational = await fixture();
    const { db, today, imported } = operational;
    await db.exec(bundle); await actor(db);
    const original = await scalar(db, "SELECT to_jsonb(t) AS r FROM public.payable_titles t WHERE entry_number='CP-SYNTHETIC-1'");
    const row = { entry_number: original.entry_number, description: original.description, branch: original.branch, due_date: today, amount_cents: 12000, source_status: 'ABERTO', plan: 'INVESTIMENTOS', bank_account: 'Banco sintético da previsão', issued_on: today, cheque_number: '000123' };
    const first = await gateway(db, forecastSql, importArgs('forecast-one', [row, { ...row, entry_number: 'CP-INCREMENTAL-2', amount_cents: 23000, cheque_number: null }], imported.import_id));
    assert.equal(first.mode, 'forecast');
    assert.equal(first.settled_count, 0);
    const originalBeforeAbsence = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_titles t WHERE id=$1', [original.id]);
    const secondBefore = await scalar(db, "SELECT to_jsonb(t) AS r FROM public.payable_titles t WHERE entry_number='CP-INCREMENTAL-2'");
    const second = await gateway(db, forecastSql, importArgs('forecast-two', [{ ...row, entry_number: 'CP-INCREMENTAL-2', amount_cents: 24000, cheque_number: null }], first.import_id));
    assert.equal(second.settled_count, 0);
    assert.equal(second.changed_count, 1);
    const absent = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_titles t WHERE id=$1', [original.id]);
    const changed = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_titles t WHERE id=$1', [secondBefore.id]);
    assert.deepEqual(absent, originalBeforeAbsence);
    assert.notEqual(absent.status, 'SETTLED_IMPORT');
    assert.equal(absent.settled_at, null);
    assert.equal(changed.id, secondBefore.id);
    assert.equal(changed.first_import_id, secondBefore.first_import_id);
    assert.equal(changed.amount_cents, 24000);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_payments'), 0);
    assert.equal((await scalar(db, 'SELECT public.payable_payment_summary($1,$1) AS r', [today])).total_paid_cents, 0);
    operational = { ...operational, original, forecastImport: second };
  });

  await test('explicit paid report creates the actual ledger and review atomically while repeating the same file is idempotent', async () => {
    const { db, today, bank, original, forecastImport } = operational;
    await actor(db);
    const bankLabel = await scalar(db, 'SELECT display_name AS r FROM public.bank_accounts WHERE id=$1', [bank]);
    const paidRow = { branch: original.branch, entry_number: original.entry_number, source_status: 'PAGO', paid_on: today, amount_paid_cents: 12000, paid_bank: bankLabel, cheque_number: '000123', description: original.description, plan: 'INVESTIMENTOS', issued_on: today };
    const revision = await scalar(db, 'SELECT public.get_payables_revision() AS r');
    const args = importArgs('paid-report-one', [paidRow], forecastImport.import_id, true, false, revision.financial_revision);
    const paid = await gateway(db, paidImportSql, args);
    assert.equal(paid.mode, 'payments');
    assert.equal(paid.new_payment_count, 1);
    assert.equal(paid.reviewed_count, 1);
    assert.equal(paid.idempotent, false);
    const ledger = await scalar(db, 'SELECT to_jsonb(p) AS r FROM public.payable_payments p WHERE title_id=$1', [original.id]);
    assert.equal(ledger.amount_cents, 12000);
    assert.equal(ledger.paid_on, today);
    assert.equal(ledger.bank_account_id, bank);
    assert.equal(ledger.cheque_number, '000123');
    const reviewed = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_review_titles t WHERE id=$1', [original.id]);
    assert.equal(reviewed.financial_status, 'PAID');
    assert.equal(reviewed.review_status, 'CONCILIADO');
    assert.equal(reviewed.payment_remaining_cents, 0);
    const beforeRepeat = await allTableState(db);
    const repeated = await gateway(db, paidImportSql, args);
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.import_id, paid.import_id);
    assert.deepEqual(await allTableState(db), beforeRepeat);
    operational = { ...operational, paidRow, paidImport: paid, originalPayment: ledger };
  });

  await test('confirmed paid-report correction appends reversal and replacement without rewriting prior ledger, file or source history', async () => {
    const { db, today, original, paidRow, paidImport, originalPayment } = operational;
    await actor(db);
    const yesterday = await scalar(db, 'SELECT ($1::date-1)::text AS r', [today]);
    const bank = await scalar(db, 'SELECT id AS r FROM public.bank_accounts WHERE enabled AND id<>$1 ORDER BY id LIMIT 1', [originalPayment.bank_account_id]);
    const bankLabel = await scalar(db, 'SELECT display_name AS r FROM public.bank_accounts WHERE id=$1', [bank]);
    const preservedImport = await scalar(db, 'SELECT to_jsonb(i) AS r FROM public.payable_imports i WHERE id=$1', [paidImport.import_id]);
    await db.exec('RESET ROLE');
    const preservedFile = await scalar(db, 'SELECT to_jsonb(f) AS r FROM cf_private.payable_import_files f WHERE import_id=$1', [paidImport.import_id]);
    const preservedLink = await scalar(db, 'SELECT to_jsonb(r) AS r FROM public.payable_paid_import_rows r WHERE import_id=$1', [paidImport.import_id]);
    const revision = await scalar(db, 'SELECT public.get_payables_revision() AS r');
    const corrected = await gateway(db, paidImportSql, importArgs('paid-report-corrected', [{ ...paidRow, amount_paid_cents: 15000, paid_on: yesterday, paid_bank: bankLabel }], paidImport.import_id, true, true, revision.financial_revision));
    assert.equal(corrected.correction_count, 1);
    assert.equal(corrected.reviewed_count, 1);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_payments'), 2);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.payable_payment_reversals WHERE payment_id=$1', [originalPayment.id]), 1);
    assert.deepEqual(await scalar(db, 'SELECT to_jsonb(p) AS r FROM public.payable_payments p WHERE id=$1', [originalPayment.id]), originalPayment);
    assert.deepEqual(await scalar(db, 'SELECT to_jsonb(i) AS r FROM public.payable_imports i WHERE id=$1', [paidImport.import_id]), preservedImport);
    assert.deepEqual(await scalar(db, 'SELECT to_jsonb(r) AS r FROM public.payable_paid_import_rows r WHERE import_id=$1', [paidImport.import_id]), preservedLink);
    await db.exec('RESET ROLE');
    assert.deepEqual(await scalar(db, 'SELECT to_jsonb(f) AS r FROM cf_private.payable_import_files f WHERE import_id=$1', [paidImport.import_id]), preservedFile);
    await actor(db);
    const active = await scalar(db, 'SELECT to_jsonb(p) AS r FROM public.payable_payments p WHERE p.title_id=$1 AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)', [original.id]);
    assert.equal(active.amount_cents, 15000);
    assert.equal(active.paid_on, yesterday);
    assert.equal(active.bank_account_id, bank);
    assert.equal((await scalar(db, 'SELECT public.payable_payment_summary($1,$1) AS r', [today])).total_paid_cents, 0);
    assert.equal((await scalar(db, 'SELECT public.payable_payment_summary($1,$1) AS r', [yesterday])).total_paid_cents, 15000);
    const reviewed = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_review_titles t WHERE id=$1', [original.id]);
    assert.equal(reviewed.amount_cents, 15000);
    assert.equal(reviewed.paid_cents, 15000);
    assert.equal(reviewed.due_date, original.due_date);
    assert.equal(reviewed.review_status, 'CONCILIADO');
  });

  console.log(`${passed} atomic, repeatable Contas a Pagar activation checks passed (local synthetic PostgreSQL only).`);
} finally {
  for (const db of databases) await db.close();
}
