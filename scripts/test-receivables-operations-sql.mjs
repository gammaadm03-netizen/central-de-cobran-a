import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  'public.collection_agents', 'public.collector_bindings', 'public.audit_events', 'storage.objects'];
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
  const tables = (await db.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN ('public','cf_private','auth','storage') ORDER BY schemaname,tablename")).rows.map(row => row.name);
  return tableState(db, tables);
}
async function schemaInventory(db) {
  await db.exec('RESET ROLE');
  return (await db.query(`SELECT 'relation' AS kind,n.nspname||'.'||c.relname AS name,c.relkind::text AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','cf_private','auth','storage')
    UNION ALL SELECT 'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','cf_private','auth','storage')
    UNION ALL SELECT 'policy',schemaname||'.'||tablename||'.'||policyname,coalesce(qual,'')||'/'||coalesce(with_check,'')
    FROM pg_policies WHERE schemaname IN('public','cf_private','auth','storage') ORDER BY kind,name`)).rows;
}
async function assertExistingTablesPreserved(db, before, ignored = ['public.central_schema_migrations']) {
  const names = Object.keys(before).filter(name => !ignored.includes(name));
  const after = await tableState(db, names);
  for (const name of names) {
    if (name === 'storage.buckets') {
      // The new private import bucket is additive; prior buckets stay byte-identical.
      for (const row of before[name]) assert.deepEqual(after[name].find(current => current.id === row.id), row);
    } else assert.deepEqual(after[name], before[name], name);
  }
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
async function referenceGateway(db, name, args) {
  const parameters = [people.gerente_geral.id, people.gerente_geral.session, ...args];
  return gateway(db, `SELECT public.${name}(${parameters.map((_, i) => `$${i + 1}`).join(',')}) AS r`, parameters);
}
const csvRecord = values => values.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(';') + '\r\n';
async function prepareReferenceJob(db, mode, label, row) {
  const headers = mode === 'CONTACTS' ? ['Entidade: nome', 'Endereço: email', 'T. 1: ddd', 'T. 1: número'] : ['CLIENTE', 'CONTRATO', 'NOTA FISCAL', 'DESCRIÇÃO', 'FILIAL'];
  const values = mode === 'CONTACTS' ? [row.client_name, row.emails.join(';'), '11', '999999999'] : [row.client_name, row.contract, row.document, row.description, row.branch];
  const original = Buffer.from(csvRecord(headers) + csvRecord(values));
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const beginArgs = [mode, `${label}.csv`, original.length, sourceHash];
  const job = await referenceGateway(db, 'begin_collection_reference_import_from_gateway', beginArgs);
  await actor(db);
  await db.query('INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3::jsonb)',
    [job.bucket, job.storage_path, JSON.stringify({ size: original.length, mimetype: 'text/csv' })]);
  await referenceGateway(db, 'verify_collection_reference_original_from_gateway', [job.job_id, sourceHash, original.length]);
  const artifact = Buffer.from(csvRecord(['source_line', ...headers]) + csvRecord([row.source_line, ...values]));
  const stageArgs = [job.job_id, 0, createHash('sha256').update(artifact).digest('hex'), artifact.toString('base64'), JSON.stringify([row]), '[]'];
  await referenceGateway(db, 'stage_collection_reference_chunk_from_gateway', stageArgs);
  await referenceGateway(db, 'finish_collection_reference_prepare_from_gateway', [job.job_id, 1]);
  return { job, beginArgs, stageArgs, artifact, original };
}

async function fixture() {
  const db = new PGlite(); databases.add(db);
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;
    -- Local Storage emulator only; production Storage is managed by Supabase.
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO authenticated,service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated,service_role;
    INSERT INTO storage.buckets VALUES('synthetic-existing','synthetic-existing',false,1024,ARRAY['text/plain']);
    INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('synthetic-existing','synthetic-preserved.txt','{"size":123}');`);
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
    'cf_private.receivables_sync_state', 'public.effective_receivable_receipts', 'public.receivable_receipt_adjustments', 'public.receivable_received_import_rows',
    'public.collection_cases', 'public.collection_case_events', 'public.collection_work_sessions', 'public.collection_work_requests',
    'cf_private.collection_workbench_state','public.collection_customer_contacts','public.collection_contact_events',
    'public.collection_description_references','cf_private.collection_contact_requests','cf_private.collection_context_state',
    'cf_private.collection_reference_jobs','cf_private.collection_reference_chunks','cf_private.collection_reference_rows',
    'cf_private.collection_reference_publish_requests']) {
    assert.equal(await scalar(db, 'SELECT to_regclass($1)::text AS r', [relation]), null, relation);
  }
  assert.equal(await scalar(db, "SELECT to_regprocedure('public.collections_overdue_summary()')::text AS r"), null);
  assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM information_schema.columns WHERE table_schema='public' AND table_name='receivable_imports' AND column_name='import_mode'"), 0);
  assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version>='022'"), 0);
}

try {
  const bundle = await buildReceivablesOperationsSql();
  await test('generated CR activation contains all seven ordered, conditional migrations in one current artifact and transaction', async () => {
    assert.equal(RECEIVABLES_OPERATION_MIGRATIONS.length, 7);
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

  await test('failure in 026 rolls back the whole activation including workbench cases, timers, permissions and audit structures', async () => {
    const { db } = await fixture();
    const before = await allTableState(db), schemaBefore = await schemaInventory(db);
    const marker = '-- END SOURCE BODY: 026_collection_workbench.sql'; assert.equal(bundle.split(marker).length, 2);
    const failing = bundle.replace(marker, `SELECT cf_private.synthetic_cr_activation_026_failure();\n${marker}`);
    await assert.rejects(db.exec(failing), error => error.code === '42883' && error.message.includes('synthetic_cr_activation_026_failure'));
    await db.exec('ROLLBACK');
    assert.deepEqual(await allTableState(db), before); assert.deepEqual(await schemaInventory(db), schemaBefore);
    await assertUpgradeAbsent(db); await close(db);
  });

  await test('failure in final 028 rolls back every upgrade, private import bucket, Storage policy and registry entry', async () => {
    const { db } = await fixture();
    const before = await allTableState(db), schemaBefore = await schemaInventory(db);
    const marker = '-- END SOURCE BODY: 028_collection_reference_imports.sql'; assert.equal(bundle.split(marker).length, 2);
    const failing = bundle.replace(marker, `SELECT cf_private.synthetic_cr_activation_028_failure();\n${marker}`);
    await assert.rejects(db.exec(failing), error => error.code === '42883' && error.message.includes('synthetic_cr_activation_028_failure'));
    await db.exec('ROLLBACK');
    assert.deepEqual(await allTableState(db), before); assert.deepEqual(await schemaInventory(db), schemaBefore);
    assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM storage.buckets WHERE id='collection-reference-files'"), 0);
    await assertUpgradeAbsent(db); await close(db);
  });

  await test('an existing 0.9 installation adds 026 through 028 while preserving original financial corrections, receipts, files and registry timestamps', async () => {
    const { db, dates, rows } = await fixture();
    for (const migration of RECEIVABLES_OPERATION_MIGRATIONS.slice(0, 4)) await db.exec(await source(migration));
    await gateway(db, receivedSql, await importArgs(db, 'before-workbench-received', [{ ...rows[0], received_on: dates.today, received_amount_cents: 8500 }], true));
    await gateway(db, receivedSql, await importArgs(db, 'before-workbench-corrected', [{ ...rows[0], received_on: dates.yesterday, received_amount_cents: 9000 }], true, true));
    const before = await allTableState(db);
    const beforeSchema = await schemaInventory(db);
    const marker = '-- END SOURCE BODY: 026_collection_workbench.sql';
    const failing = bundle.replace(marker, `SELECT cf_private.synthetic_cr_09_upgrade_failure();\n${marker}`);
    await assert.rejects(db.exec(failing), error => error.code === '42883' && error.message.includes('synthetic_cr_09_upgrade_failure'));
    await db.exec('ROLLBACK');
    assert.deepEqual(await allTableState(db), before); assert.deepEqual(await schemaInventory(db), beforeSchema);
    await db.exec(bundle);
    await assertExistingTablesPreserved(db, before);
    const registry = await scalar(db, "SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) AS r FROM public.central_schema_migrations m WHERE version<'026'");
    assert.deepEqual(registry, before['public.central_schema_migrations']);
    assert.equal(await scalar(db, "SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version='026_collection_workbench'"), 1);
    const effective = await scalar(db, 'SELECT to_jsonb(r) AS r FROM public.effective_receivable_receipts r JOIN public.receivable_titles t ON t.id=r.title_id WHERE t.document=$1', [rows[0].document]);
    assert.equal(effective.amount_cents, 9000); assert.equal(effective.original_received_amount_cents, 8500); assert.equal(effective.receipt_revision, 1);
    const upgraded = await allTableState(db); await db.exec(bundle); assert.deepEqual(await allTableState(db), upgraded);
    await close(db);
  });

  await test('0.10 upgrades only 027 and 028, preserving a running timer, saved case, receipts, cash and every previous audit event', async () => {
    const { db, dates } = await fixture();
    for (const migration of RECEIVABLES_OPERATION_MIGRATIONS.slice(0, 5)) await db.exec(await source(migration));
    await actor(db, 'cobradora_1');
    const item = await title(db, 'LEGACY-OPEN');
    await scalar(db, 'SELECT public.collection_work_action($1,$2,$3,$4) AS r', [item.id, 'START', item.revision, randomUUID()]);
    await scalar(db, 'SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',
      [item.id, 'AGUARDANDO RETORNO', 'Caso sintético anterior aos contatos', 'Retorno sintético agendado', dates.future, item.revision, 0, null, false, randomUUID()]);
    const before = await allTableState(db), schemaBefore = await schemaInventory(db);
    const marker = '-- END SOURCE BODY: 028_collection_reference_imports.sql'; assert.equal(bundle.split(marker).length, 2);
    const failing = bundle.replace(marker, `SELECT cf_private.synthetic_cr_010_reference_failure();\n${marker}`);
    await assert.rejects(db.exec(failing), error => error.code === '42883' && error.message.includes('synthetic_cr_010_reference_failure'));
    await db.exec('ROLLBACK');
    assert.deepEqual(await allTableState(db), before); assert.deepEqual(await schemaInventory(db), schemaBefore);
    await db.exec(bundle); await assertExistingTablesPreserved(db, before);
    const registry = await scalar(db, "SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) AS r FROM public.central_schema_migrations m WHERE version<'027'");
    assert.deepEqual(registry, before['public.central_schema_migrations']);
    const bucket = await scalar(db, "SELECT to_jsonb(b) AS r FROM storage.buckets b WHERE id='collection-reference-files'");
    assert.equal(bucket.public, false);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.collection_customer_contacts'), 0);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.collection_description_references'), 0);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.collection_work_sessions WHERE ended_at IS NULL'), 1);
    const upgraded = await allTableState(db); await db.exec(bundle); assert.deepEqual(await allTableState(db), upgraded);
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

  await test('026 starts and pauses an official timer, saves an owned case and summarizes work without changing financial receipts', async () => {
    const financialTables = ['public.receivable_receipts', 'public.receivable_receipt_adjustments', 'public.receivable_receipt_import_provenance',
      'public.receivable_received_import_rows', 'cf_private.receivable_import_files', 'public.payable_titles', 'public.bank_balance_positions'];
    const financialBefore = await tableState(db, financialTables);
    await actor(db, 'cobradora_1');
    const item = await title(db, 'LEGACY-OPEN');
    const timerSql = 'SELECT public.collection_work_action($1,$2,$3,$4) AS r';
    await scalar(db, timerSql, [item.id, 'START', item.revision, randomUUID()]);
    const pauseArgs = [item.id, 'PAUSE', (await title(db, 'LEGACY-OPEN')).revision, randomUUID()];
    const paused = await scalar(db, timerSql, pauseArgs);
    assert(paused && typeof paused === 'object');
    const beforeReplay = await allTableState(db); await actor(db, 'cobradora_1');
    const pauseReplay = await scalar(db, timerSql, pauseArgs); assert(pauseReplay && typeof pauseReplay === 'object');
    assert.deepEqual(await allTableState(db), beforeReplay); await actor(db, 'cobradora_1');
    const saved = await scalar(db, 'SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',
      [item.id, 'COBRANCA POR WHATSAPP', 'Contato sintético registrado após a atualização', 'Retornar contato sintético', dates.future,
        (await title(db, 'LEGACY-OPEN')).revision, 0, null, false, randomUUID()]);
    assert.equal(saved.title_id, item.id); assert.equal(saved.case_revision, 1); assert.equal(saved.finished, false);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.collection_cases WHERE title_id=$1', [item.id]), 1);
    assert((await scalar(db, 'SELECT count(*)::integer AS r FROM public.collection_case_events WHERE title_id=$1', [item.id])) >= 1);
    const summary = await scalar(db, 'SELECT public.collection_work_summary($1,$1) AS r', [dates.today]);
    assert.equal(summary.session_count, 1); assert.equal(summary.running_count, 0); assert.equal(summary.title_count, 1);
    assert(Number.isSafeInteger(summary.total_seconds) && summary.total_seconds >= 0);
    assert.equal(summary.by_collector.length, 1);
    assert.deepEqual(await tableState(db, financialTables), financialBefore);
    await actor(db, 'diretor');
    assert.equal((await scalar(db, 'SELECT public.collection_work_summary($1,$1) AS r', [dates.today])).session_count, 1);
    const beforeRead = await allTableState(db); await actor(db, 'diretor');
    await scalar(db, 'SELECT public.collection_work_summary($1,$1) AS r', [dates.today]);
    assert.deepEqual(await allTableState(db), beforeRead);
  });

  await test('verified contact jobs publish privately and all retries preserve manual corrections, raw artifacts and original provenance', async () => {
    const financialTables = ['public.receivable_titles', 'public.receivable_receipts', 'public.receivable_receipt_adjustments', 'public.payable_titles', 'public.bank_balance_positions'];
    const financialBefore = await tableState(db, financialTables); await actor(db);
    const item = await title(db, 'LEGACY-OPEN');
    const prepared = await prepareReferenceJob(db, 'CONTACTS', 'synthetic-contacts', {
      source_line: 2, client_name: item.client_name, client_document: null, emails: ['synthetic-reference@example.invalid'], phones: ['11999999999'], notes: null,
    });
    const preview = await referenceGateway(db, 'preview_collection_reference_import_from_gateway', [prepared.job.job_id]);
    assert.equal(preview.eligible_count, 1); assert.equal(preview.quarantine_count, 0);
    const publishArgs = [prepared.job.job_id, preview.financial_revision, false, randomUUID()];
    const published = await referenceGateway(db, 'publish_collection_reference_import_from_gateway', publishArgs);
    assert.equal(published.status, 'PUBLISHED'); assert.equal(published.published_rows, 1);
    let card = await scalar(db, 'SELECT to_jsonb(c) AS r FROM public.collection_customer_contacts c WHERE customer_key=$1', [item.customer_key]);
    assert.equal(card.source_job_id, prepared.job.job_id); assert.deepEqual(card.emails, ['synthetic-reference@example.invalid']);
    await actor(db, 'cobradora_1');
    const context = await scalar(db, 'SELECT public.collection_customer_context($1) AS r', [item.id]);
    const saveSql = 'SELECT public.save_collection_customer_contacts($1,$2::jsonb,$3::jsonb,$4,$5,$6) AS r';
    const saveArgs = [item.id, JSON.stringify(['synthetic-manual@example.invalid']), JSON.stringify(['11988888888']), 'Conferência sintética após importação', context.contact.revision, randomUUID()];
    const saved = await scalar(db, saveSql, saveArgs);
    const beforeReplay = await allTableState(db);
    await actor(db, 'cobradora_1'); assert.deepEqual(await scalar(db, saveSql, saveArgs), saved);
    assert.equal((await referenceGateway(db, 'begin_collection_reference_import_from_gateway', prepared.beginArgs)).job_id, prepared.job.job_id);
    assert.equal((await referenceGateway(db, 'stage_collection_reference_chunk_from_gateway', prepared.stageArgs)).duplicate, true);
    assert.deepEqual(await referenceGateway(db, 'publish_collection_reference_import_from_gateway', publishArgs), published);
    assert.deepEqual(await allTableState(db), beforeReplay);
    card = await scalar(db, 'SELECT to_jsonb(c) AS r FROM public.collection_customer_contacts c WHERE customer_key=$1', [item.customer_key]);
    assert.equal(card.manually_edited, true); assert.deepEqual(card.emails, ['synthetic-manual@example.invalid']); assert.equal(card.source_job_id, prepared.job.job_id);
    assert.equal(await scalar(db, 'SELECT encode(artifact,\'hex\') AS r FROM cf_private.collection_reference_chunks WHERE job_id=$1 AND chunk_index=0', [prepared.job.job_id]), prepared.artifact.toString('hex'));
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM storage.objects WHERE bucket_id=$1 AND name=$2', [prepared.job.bucket, prepared.job.storage_path]), 1);
    assert.equal(await scalar(db, 'SELECT count(*)::integer AS r FROM public.collection_contact_events WHERE customer_key=$1', [item.customer_key]), 1);
    assert.deepEqual(await tableState(db, financialTables), financialBefore);
  });

  await test('description jobs append variants with separate source identities while preserving title, timer, receipts and prior description history', async () => {
    const row = { document: 'REFERENCE-NF', client_name: 'Cliente sintético de referência', client_document: null, branch: '2', issued_on: dates.issued, due_date: dates.overdue, amount_cents: 28000 };
    await gateway(db, openSql, await importArgs(db, 'reference-title', [row]));
    const item = await title(db, row.document);
    await scalar(db, 'SELECT public.assign_receivable_collector($1,$2,$3) AS r', [item.customer_key, agents[0], 'Vínculo sintético de referência']);
    const financialTables = ['public.receivable_titles', 'public.receivable_receipts', 'public.receivable_receipt_adjustments', 'public.collection_cases', 'public.collection_work_sessions', 'public.payable_titles', 'public.bank_balance_positions'];
    const financialBefore = await tableState(db, financialTables);
    const first = await prepareReferenceJob(db, 'DESCRIPTIONS', 'synthetic-description-one', {
      source_line: 2, document: row.document, branch: row.branch, client_name: row.client_name, client_document: null, description: 'Descrição de contrato inteiramente sintética', contract: 'SYNTHETIC-CONTRACT',
    });
    const firstPreview = await referenceGateway(db, 'preview_collection_reference_import_from_gateway', [first.job.job_id]);
    assert.equal(firstPreview.eligible_count, 1); assert.equal(firstPreview.quarantine_count, 0);
    await referenceGateway(db, 'publish_collection_reference_import_from_gateway', [first.job.job_id, firstPreview.financial_revision, false, randomUUID()]);
    await actor(db, 'cobradora_1');
    const initial = await scalar(db, 'SELECT public.collection_customer_context($1) AS r', [item.id]);
    assert.equal(initial.descriptions.state, 'AVAILABLE'); assert.equal(initial.descriptions.count, 1);
    assert.equal(initial.descriptions.variants[0].source_import_id, first.job.job_id);
    const second = await prepareReferenceJob(db, 'DESCRIPTIONS', 'synthetic-description-two', {
      source_line: 2, document: row.document, branch: row.branch, client_name: row.client_name, client_document: null, description: 'Segunda variante sintética preservada', contract: 'SYNTHETIC-CONTRACT',
    });
    const nextPreview = await referenceGateway(db, 'preview_collection_reference_import_from_gateway', [second.job.job_id]);
    assert.equal(nextPreview.variant_count, 1);
    await referenceGateway(db, 'publish_collection_reference_import_from_gateway', [second.job.job_id, nextPreview.financial_revision, false, randomUUID()]);
    await actor(db, 'cobradora_1');
    const updated = await scalar(db, 'SELECT public.collection_customer_context($1) AS r', [item.id]);
    assert.equal(updated.descriptions.state, 'PENDING_VARIANTS'); assert.equal(updated.descriptions.count, 2);
    assert.deepEqual(updated.descriptions.variants.find(variant => variant.id === initial.descriptions.variants[0].id), initial.descriptions.variants[0]);
    assert.deepEqual(new Set(updated.descriptions.variants.map(variant => variant.source_import_id)), new Set([first.job.job_id, second.job.job_id]));
    assert.deepEqual(await tableState(db, financialTables), financialBefore);
  });

  await test('repeating complete activation preserves exact live receipts, correction history, file provenance, revision and registry timestamps', async () => {
    const before = await allTableState(db); await db.exec(bundle); assert.deepEqual(await allTableState(db), before);
  });
  console.log(`\n${passed} receivables activation tests passed.`);
} finally {
  for (const db of databases) await db.close();
}
