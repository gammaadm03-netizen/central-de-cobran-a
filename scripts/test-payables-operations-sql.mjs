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
async function actor(db, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [uid, JSON.stringify({ session_id: sid, role: 'authenticated' })]);
  await db.exec(`SET ROLE ${role}`);
}
async function tableState(db, tables) {
  await db.exec('RESET ROLE');
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, await scalar(db, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS r FROM ${table} t`)])));
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
  assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM information_schema.columns WHERE table_schema='public' AND table_name='bank_accounts' AND column_name='account_type'"), 0);
  assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version>='012'"), 0);
}

try {
  const bundle = await buildPayablesOperationsSql();
  await test('generated activation is current and contains all seven ordered, conditional source migrations under one transaction', async () => {
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
    const before = await tableState(db, baselineTables), accounts = await originalAccounts(db);
    await db.exec(bundle);
    assert.deepEqual(await tableState(db, baselineTables), before);
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
    const before = await tableState(db, [...baselineTables, 'public.bank_accounts', 'public.director_report_inputs']);
    const installedBefore = (await db.query("SELECT * FROM public.central_schema_migrations WHERE version IN ('012_treasury_accounts','013_director_report') ORDER BY version")).rows;
    await db.exec(bundle);
    assert.deepEqual(await tableState(db, [...baselineTables, 'public.bank_accounts', 'public.director_report_inputs']), before);
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

  await test('failure inside the last 018 source rolls back all earlier upgrades, config seeds and schema registry rows', async () => {
    const { db } = await fixture();
    const before = await allTableState(db);
    const marker = '-- END SOURCE BODY: 018_payable_full_payment.sql';
    assert.equal(bundle.split(marker).length, 2);
    const failing = bundle.replace(marker, `SELECT cf_private.synthetic_activation_018_failure();\n${marker}`);
    await assert.rejects(db.exec(failing), error => error.code === '42883' && error.message.includes('synthetic_activation_018_failure'));
    await db.exec('ROLLBACK');
    assert.deepEqual(await allTableState(db), before);
    await assertUpgradeAbsent(db);
  });

  await test('018 preserves earlier partial payments and accepts only exact settlement of the remaining balance', async () => {
    const { db, today, bank } = await fixture(PAYABLES_OPERATION_MIGRATIONS.filter(name => !name.startsWith('018_')));
    await actor(db);
    const title = await scalar(db, 'SELECT to_jsonb(t) AS r FROM public.payable_financial_titles t LIMIT 1');
    const registerSql = 'SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) AS r';
    await scalar(db, registerSql, [title.id, 2500, today, bank, 'Pagamento parcial sintético anterior à regra integral', title.payment_revision, randomUUID(), title.last_import_id]);
    const preservedTables = [...baselineTables, 'public.payable_payments', 'public.payable_payment_reversals', 'cf_private.payable_payment_state', 'cf_private.payable_control_state', 'public.payable_title_control_revisions'];
    const before = await tableState(db, preservedTables);
    await db.exec(bundle);
    assert.deepEqual(await tableState(db, preservedTables), before);
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

  console.log(`${passed} atomic, repeatable Contas a Pagar activation checks passed (local synthetic PostgreSQL only).`);
} finally {
  for (const db of databases) await db.close();
}
