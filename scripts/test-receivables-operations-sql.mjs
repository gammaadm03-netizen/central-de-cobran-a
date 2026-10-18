import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildReceivablesOperationsSql, RECEIVABLES_OPERATION_MIGRATIONS, writeReceivablesOperationsBundle } from './bundle-receivables-operations.mjs';

// Isolated PostgreSQL only. All people, amounts, files and observations are synthetic.
const roles = ['gerente_geral', 'diretor', 'contas_receber', 'contas_pagar', 'rh_dp', 'cobradora_1', 'cobradora_2'];
const people = Object.fromEntries(roles.map((name, i) => [name, {
  id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  session: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
}]));
const agents = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'];
const baseMigrations = ['001_identidade_rbac.sql', '003_auth_gateway.sql', '004_password_recovery.sql', '005_payables.sql', '006_treasury.sql', '007_director_positions.sql', '008_receivables.sql', '009_collections.sql'];
const baselineTables = ['auth.users', 'public.profiles', 'public.role_permissions', 'cf_private.approved_sessions', 'public.bank_accounts',
  'public.bank_balance_positions', 'public.stock_positions', 'public.payable_imports', 'public.payable_titles', 'cf_private.payable_import_files',
  'public.payable_plan_mappings', 'public.management_messages', 'public.director_positions', 'public.receivable_imports',
  'public.receivable_titles', 'public.receivable_receipts', 'public.receivable_collection_events', 'cf_private.receivable_import_files',
  'public.collection_agents', 'public.collector_bindings', 'public.audit_events'];
const databases = new Set();
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS', name); };
const scalar = async (db, sql, args = []) => (await db.query(sql, args)).rows[0].r;
const source = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const openSql = 'SELECT public.commit_receivables_open_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) AS r';
const receivedSql = 'SELECT public.commit_receivables_received_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11) AS r';
async function actor(db, name = 'gerente_geral', role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [people[name].id, JSON.stringify({ session_id: people[name].session })]);
  await db.exec(`SET ROLE ${role}`);
}
async function gateway(db, sql, args) {
  await actor(db, 'gerente_geral', 'service_role');
  try { return await scalar(db, sql, args); }
  finally { await actor(db); }
}
async function tableState(db, tables, ignoreAddedMetadata = false) {
  await db.exec('RESET ROLE');
  const result = {};
  for (const table of tables) {
    const value = ignoreAddedMetadata && table === 'public.receivable_imports' ? "to_jsonb(t)-'import_mode'" : 'to_jsonb(t)';
    result[table] = await scalar(db, `SELECT coalesce(jsonb_agg(${value} ORDER BY (${value})::text),'[]') AS r FROM ${table} t`);
  }
  return result;
}
async function allTableState(db) {
  await db.exec('RESET ROLE');
  const tables = (await db.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN ('public','cf_private','auth') ORDER BY schemaname,tablename")).rows.map(row => row.name);
  return tableState(db, tables);
}
async function close(db) { await db.close(); databases.delete(db); }
async function importArgs(db, label, rows, received = false, confirm = false) {
  await actor(db);
  const revision = await scalar(db, 'SELECT public.get_receivables_sync_revision() AS r');
  const bytes = Buffer.from(`Relatório original sintético CR: ${label}. Sem dados reais.`);
  const args = [people.gerente_geral.id, people.gerente_geral.session, 'grupo-consolidado', `${label}.csv`,
    createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), '{}', revision.import_id, revision.financial_revision];
  return received ? [...args, confirm] : args;
}
const title = (db, document) => scalar(db, 'SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE document=$1', [document]);

async function fixture() {
  const db = new PGlite(); databases.add(db);
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for (const name of baseMigrations) await db.exec(await source(name));
  for (const [name, person] of Object.entries(people)) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [person.id, `${name}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)', [person.id, name]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [person.session, person.id]);
  }
  for (const [i, id] of agents.entries()) {
    await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)', [id, `Responsável sintética ${i + 1}`]);
    await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)', [people[`cobradora_${i + 1}`].id, id, people.gerente_geral.id]);
  }
  await actor(db);
  const dates = (await db.query(`SELECT d::text AS today,(d-1)::text AS yesterday,(d-2)::text AS earlier,(d-10)::text AS overdue,(d+5)::text AS future,(d-30)::text AS issued
    FROM(SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS d)s`)).rows[0];
  const bank = await scalar(db, 'SELECT id AS r FROM public.bank_accounts WHERE enabled ORDER BY id LIMIT 1');
  await scalar(db, "SELECT public.set_bank_balance($1,$2,12345,'Saldo sintético anterior à ativação',null) AS r", [bank, dates.today]);
  await scalar(db, "SELECT public.save_manual_stock(45678,$1,'Estoque sintético anterior à ativação') AS r", [dates.today]);
  await scalar(db, "SELECT public.create_management_message('normal',null,'Mensagem sintética preservada') AS r");
  const cpBytes = Buffer.from('Arquivo CP sintético preservado pela ativação CR.');
  await gateway(db, 'SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,true,null) AS r',
    [people.gerente_geral.id, people.gerente_geral.session, 'grupo-consolidado', 'legacy-cp.csv', createHash('sha256').update(cpBytes).digest('hex'), cpBytes.toString('base64'),
      JSON.stringify([{ entry_number: 'CP-SYNTHETIC-1', description: 'Fornecedor sintético preservado', due_date: dates.today, amount_cents: 12000, source_status: 'ABERTO', plan: 'INVESTIMENTOS', bank_account: 'Banco sintético', branch: '2 - TESTE', issued_on: dates.issued }]), '{}']);
  const rows = ['LEGACY-OPEN', 'LEGACY-RECEIVED', 'LEGACY-FUTURE'].map((document, i) => ({ document, client_name: 'Cliente sintético legado', client_document: null,
    branch: '2 - TESTE', issued_on: dates.issued, due_date: i === 2 ? dates.future : dates.overdue, amount_cents: (i + 1) * 10000 }));
  const bytes = Buffer.from('Arquivo CR sintético legado integral preservado.');
  const imported = await gateway(db, 'SELECT public.commit_receivables_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,true,null) AS r',
    [people.gerente_geral.id, people.gerente_geral.session, 'grupo-consolidado', 'legacy-cr.csv', createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows)]);
  const legacy = await title(db, 'LEGACY-OPEN');
  await scalar(db, 'SELECT public.assign_receivable_collector($1,$2,$3) AS r', [legacy.customer_key, agents[0], 'Carteira sintética anterior à ativação']);
  await db.exec('RESET ROLE');
  const received = await title(db, 'LEGACY-RECEIVED');
  await db.query("UPDATE public.receivable_titles SET status='PENDING_VALIDATION',validation_status='PENDING',payment_source='IMPORTACAO_DIARIA' WHERE id=$1", [received.id]);
  await actor(db);
  await scalar(db, "SELECT public.validate_receivable_payment($1,'CONFIRM',$2,'Conferência sintética anterior à ativação',$3) AS r",
    [received.id, dates.earlier, (await title(db, 'LEGACY-RECEIVED')).revision]);
  await scalar(db, 'SELECT public.save_director_position($1,$1) AS r', [dates.today]);
  await db.exec('RESET ROLE');
  return { db, dates, rows, imported, bank };
}
async function assertUpgradeAbsent(db) {
  for (const relation of ['public.collection_overdue_titles', 'public.receivable_sync_imports', 'cf_private.receivable_parcel_aliases',
    'cf_private.receivables_sync_state', 'public.effective_receivable_receipts', 'public.receivable_receipt_adjustments', 'public.receivable_received_import_rows']) {
    assert.equal(await scalar(db, 'SELECT to_regclass($1)::text AS r', [relation]), null, relation);
  }
  assert.equal(await scalar(db, "SELECT to_regprocedure('public.collections_overdue_summary()')::text AS r"), null);
  assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM information_schema.columns WHERE table_schema='public' AND table_name='receivable_imports' AND column_name='import_mode'"), 0);
  assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version>='022'"), 0);
}

try {
  const bundle = await buildReceivablesOperationsSql();
  await test('generated CR activation contains all four ordered, conditional migrations in one current artifact and transaction', async () => {
    await writeReceivablesOperationsBundle();
    assert.equal(await readFile(new URL('../supabase/dashboard/ativar-recebiveis-operacao.sql', import.meta.url), 'utf8'), bundle);
    assert.equal((bundle.match(/^BEGIN;$/gm) ?? []).length, 1);
    assert.equal((bundle.match(/^COMMIT;$/gm) ?? []).length, 1);
    let previous = -1;
    for (const migration of RECEIVABLES_OPERATION_MIGRATIONS) {
      const index = bundle.indexOf(`-- SOURCE: ${migration}`); assert(index > previous); previous = index;
      assert(bundle.includes(`WHERE version='${migration.replace(/\.sql$/, '')}'`));
    }
  });

  await test('activation needs only the 009 baseline and preserves identities, receipts, files, cash, stock, users and immutable history', async () => {
    const { db } = await fixture();
    const before = await tableState(db, baselineTables, true);
    await db.exec(bundle);
    assert.deepEqual(await tableState(db, baselineTables, true), before);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.bank_accounts'), 11);
    assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.receivable_imports WHERE import_mode<>'LEGACY'"), 0);
    assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version>='010' AND version<'022'"), 0);
    assert.equal(await scalar(db, "SELECT to_regprocedure('public.payables_management_summary(date,date)')::text AS r"), null);
    for (const migration of RECEIVABLES_OPERATION_MIGRATIONS) assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version=$1', [migration.replace(/\.sql$/, '')]), 1);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.receivable_receipt_adjustments'), 0);
    await close(db);
  });

  await test('partially installed 022 and 023 are skipped without resetting imported aliases, revisions or configured wallets', async () => {
    const { db, dates } = await fixture();
    for (const migration of RECEIVABLES_OPERATION_MIGRATIONS.slice(0, 2)) await db.exec(await source(migration));
    const row = { document: 'PARTIAL-INSTALL', client_name: 'Cliente sintético parcial', client_document: null, branch: '2 - TESTE', issued_on: dates.issued, due_date: dates.overdue, amount_cents: 33333 };
    await gateway(db, openSql, await importArgs(db, 'partial-install', [row]));
    await db.exec('RESET ROLE');
    await db.query("UPDATE public.collection_agents SET display_name='Carteira sintética personalizada',enabled=false WHERE id=$1", [agents[1]]);
    const preserved = [...baselineTables, 'cf_private.receivable_parcel_aliases', 'cf_private.receivables_sync_state', 'public.receivable_sync_imports'];
    const before = await tableState(db, preserved);
    const registryBefore = await scalar(db, "SELECT jsonb_agg(to_jsonb(m) ORDER BY version) AS r FROM public.central_schema_migrations m WHERE version IN('022_collections_overdue_only','023_receivable_sync')");
    await db.exec(bundle);
    assert.deepEqual(await tableState(db, preserved), before);
    assert.deepEqual(await scalar(db, "SELECT jsonb_agg(to_jsonb(m) ORDER BY version) AS r FROM public.central_schema_migrations m WHERE version IN('022_collections_overdue_only','023_receivable_sync')"), registryBefore);
    const complete = await allTableState(db); await db.exec(bundle); assert.deepEqual(await allTableState(db), complete);
    await close(db);
  });

  await test('missing 009 registration aborts before any upgrade and preserves every existing row', async () => {
    const { db } = await fixture();
    await db.exec("DELETE FROM public.central_schema_migrations WHERE version='009_collections'");
    const before = await allTableState(db);
    await assert.rejects(db.exec(bundle), error => error.code === '22023' && error.message.includes('009_collections'));
    await db.exec('ROLLBACK'); assert.deepEqual(await allTableState(db), before); await assertUpgradeAbsent(db);
    await close(db);
  });

  await test('failure in final 025 source rolls back all earlier DDL, import metadata, RLS changes and schema registrations', async () => {
    const { db } = await fixture();
    const before = await allTableState(db), policy = await scalar(db, "SELECT qual AS r FROM pg_policies WHERE schemaname='public' AND tablename='receivable_titles' AND policyname='receivable_titles_read'");
    const marker = '-- END SOURCE BODY: 025_collections_management.sql'; assert.equal(bundle.split(marker).length, 2);
    const failing = bundle.replace(marker, `SELECT cf_private.synthetic_cr_activation_025_failure();\n${marker}`);
    await assert.rejects(db.exec(failing), error => error.code === '42883' && error.message.includes('synthetic_cr_activation_025_failure'));
    await db.exec('ROLLBACK'); assert.deepEqual(await allTableState(db), before); await assertUpgradeAbsent(db);
    assert.equal(await scalar(db, "SELECT qual AS r FROM pg_policies WHERE schemaname='public' AND tablename='receivable_titles' AND policyname='receivable_titles_read'"), policy);
    await close(db);
  });

  const operational = await fixture();
  const { db, dates } = operational;
  await db.exec(bundle);
  const row = { document: 'OPERATION-NF', client_name: 'Cliente sintético operacional', client_document: null, branch: '2 - TESTE', issued_on: dates.issued, due_date: dates.overdue, amount_cents: 18000 };
  let openTitle, receivedArgs, receipt, receivedResult;
  await test('open imports are incremental, keep absence unchanged and expose only overdue titles to the assigned collector', async () => {
    await gateway(db, openSql, await importArgs(db, 'operation-open', [row]));
    openTitle = await title(db, row.document);
    await scalar(db, 'SELECT public.assign_receivable_collector($1,$2,$3) AS r', [openTitle.customer_key, agents[0], 'Carteira operacional sintética']);
    openTitle = await title(db, row.document);
    const beforeAbsence = openTitle;
    await gateway(db, openSql, await importArgs(db, 'operation-subset', [{ ...row, document: 'FUTURE-OTHER', due_date: dates.future, amount_cents: 21000 }]));
    assert.deepEqual(await title(db, row.document), beforeAbsence);
    assert.notEqual(beforeAbsence.status, 'VALIDATED');
    await actor(db, 'cobradora_1');
    assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.collection_overdue_titles WHERE id=$1 AND status<>'VALIDATED'", [openTitle.id]), 1);
    assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.receivable_titles WHERE document='LEGACY-FUTURE'"), 0);
    const summary = await scalar(db, 'SELECT public.collections_overdue_summary() AS r');
    assert.equal(summary.overdue_cents, 28000); assert.equal(summary.overdue_count, 2);
    await actor(db, 'cobradora_2'); assert.equal((await scalar(db, 'SELECT public.collections_overdue_summary() AS r')).overdue_count, 0);
    await actor(db);
  });

  await test('received import validates the actual amount without altering nominal debt and removes the title from active collection', async () => {
    receivedArgs = await importArgs(db, 'operation-received', [{ ...row, received_on: dates.today, received_amount_cents: 13700 }], true);
    receivedResult = await gateway(db, receivedSql, receivedArgs);
    assert.equal(receivedResult.mode, 'received'); assert.equal(receivedResult.received_count, 1);
    const validated = await title(db, row.document);
    assert.equal(validated.id, openTitle.id); assert.equal(validated.amount_cents, 18000); assert.equal(validated.due_date, dates.overdue);
    assert.equal(validated.status, 'VALIDATED'); assert.equal(validated.validation_status, 'VALIDATED'); assert.equal(validated.collector_id, agents[0]);
    receipt = await scalar(db, 'SELECT to_jsonb(r) AS r FROM public.effective_receivable_receipts r WHERE title_id=$1', [openTitle.id]);
    assert.equal(receipt.amount_cents, 13700); assert.equal(receipt.nominal_amount_cents, 18000); assert.equal(receipt.source_kind, 'ERP_RECEIVED');
    await actor(db, 'cobradora_1');
    assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.collection_overdue_titles WHERE id=$1 AND status<>'VALIDATED'", [openTitle.id]), 0);
    assert.equal((await scalar(db, 'SELECT public.collections_overdue_summary() AS r')).overdue_cents, 10000);
    await actor(db);
  });

  await test('Director daily summary and commission base use actual receipt date and value without inventing a commission rate', async () => {
    const before = await allTableState(db); await actor(db, 'diretor');
    const summary = await scalar(db, 'SELECT public.receivables_management_summary($1) AS r', [dates.today]);
    assert.equal(summary.received_date, dates.today); assert.equal(summary.received_day_cents, 13700);
    assert.equal((await scalar(db, 'SELECT public.receivables_summary($1,$1) AS r', [dates.today])).received_period_cents, 13700);
    const commission = await scalar(db, 'SELECT public.receivable_commission_base($1,$1) AS r', [dates.today]);
    assert.equal(commission.total_received_cents, 13700); assert.equal(commission.eligible_base_cents, 13700); assert.equal(commission.rule_status, 'AGUARDANDO_REGRAS');
    assert.equal(commission.rows.length, 1); assert.equal(commission.rows[0].amount_cents, 13700); assert.equal(commission.rows[0].nominal_amount_cents, 18000);
    assert.equal(commission.rows[0].base_cents, 13700); assert.equal(commission.rows[0].eligibility, 'BASE_DISPONIVEL');
    assert(!('commission_amount_cents' in commission.rows[0])); assert(!('rate' in commission.rows[0]));
    assert.deepEqual(await allTableState(db), before); await actor(db);
  });

  await test('same received file is idempotent with stale tokens and a confirmed correction appends history without editing original receipts or files', async () => {
    const beforeReplay = await allTableState(db), staleArgs = [...receivedArgs]; staleArgs[8] = null; staleArgs[9] = null;
    const replay = await gateway(db, receivedSql, staleArgs); assert.equal(replay.idempotent, true); assert.equal(replay.import_id, receivedResult.import_id);
    assert.deepEqual(await allTableState(db), beforeReplay);
    await actor(db);
    const original = await scalar(db, 'SELECT to_jsonb(r) AS r FROM public.receivable_receipts r WHERE id=$1', [receipt.id]);
    const oldFiles = await tableState(db, ['cf_private.receivable_import_files']);
    const corrected = [{ ...row, received_on: dates.yesterday, received_amount_cents: 14000 }];
    const unconfirmedArgs = await importArgs(db, 'operation-correction', corrected, true, false);
    const beforeRejected = await allTableState(db);
    await assert.rejects(gateway(db, receivedSql, unconfirmedArgs), error => error.code === 'P0024');
    assert.deepEqual(await allTableState(db), beforeRejected);
    const confirmedArgs = await importArgs(db, 'operation-correction', corrected, true, true);
    const result = await gateway(db, receivedSql, confirmedArgs); assert.equal(result.correction_count, 1);
    const effective = await scalar(db, 'SELECT to_jsonb(r) AS r FROM public.effective_receivable_receipts r WHERE title_id=$1', [openTitle.id]);
    assert.equal(effective.id, receipt.id); assert.equal(effective.amount_cents, 14000); assert.equal(effective.payment_date, dates.yesterday); assert.equal(effective.receipt_revision, 1);
    assert.equal(effective.original_received_amount_cents, 13700); assert.equal(effective.original_payment_date, dates.today);
    assert.deepEqual(await scalar(db, 'SELECT to_jsonb(r) AS r FROM public.receivable_receipts r WHERE id=$1', [receipt.id]), original);
    const nowFiles = (await tableState(db, ['cf_private.receivable_import_files']))['cf_private.receivable_import_files'];
    for (const old of oldFiles['cf_private.receivable_import_files']) assert.deepEqual(nowFiles.find(file => file.import_id === old.import_id), old);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.receivable_receipt_adjustments WHERE receipt_id=$1', [receipt.id]), 1);
    await actor(db, 'diretor');
    assert.equal((await scalar(db, 'SELECT public.receivables_management_summary($1) AS r', [dates.today])).received_day_cents, 0);
    assert.equal((await scalar(db, 'SELECT public.receivables_management_summary($1) AS r', [dates.yesterday])).received_day_cents, 14000);
    assert.equal((await scalar(db, 'SELECT public.receivable_commission_base($1,$1) AS r', [dates.yesterday])).eligible_base_cents, 14000);
  });

  await test('repeating complete activation preserves exact live receipts, correction history, file provenance, revision and registry timestamps', async () => {
    const before = await allTableState(db); await db.exec(bundle); assert.deepEqual(await allTableState(db), before);
  });
  console.log(`\n${passed} receivables activation tests passed.`);
} finally {
  for (const db of databases) await db.close();
}
