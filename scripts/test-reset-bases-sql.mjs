import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';

// Disposable PostgreSQL only. Every source, person, account position and amount is synthetic.
const scope = JSON.parse(await readFile(new URL('./lib/base-reset-scope.json', import.meta.url), 'utf8'));
const resetSql = await readFile(new URL('../supabase/admin/zerar-bases-teste.sql', import.meta.url), 'utf8');
const restoreSql = await readFile(new URL('../supabase/admin/restaurar-bases-teste.sql', import.meta.url), 'utf8');
const operation = 'preparacao-base-oficial-2026-10-22-v1';
const f = await createCostFixture();
const { db, owner, actor, scalar, file, users, id } = f;
const quote = text => '"' + text.replaceAll('"', '""') + '"';
const relation = name => name.split('.').map(quote).join('.');
let passed = 0, phase = 'setup', sequence = 0, baseline, backupSchema, costSource;
const test = async (name, fn) => { phase = name; await fn(); passed++; console.log('PASS', name); };
const state = async (tables) => {
  await owner();
  const result = {};
  for (const table of tables) result[table] = (await db.query(`SELECT to_jsonb(t) r FROM ${relation(table)} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.r);
  return result;
};
const allState = async () => {
  await owner();
  const names = (await db.query("SELECT schemaname||'.'||tablename name FROM pg_tables WHERE schemaname IN('auth','storage','public','cf_private','cf_operations') OR schemaname LIKE 'cf_base_backup_%' ORDER BY 1")).rows.map(row => row.name);
  return state(names);
};
const triggers = async () => {
  await owner();
  return (await db.query("SELECT n.nspname||'.'||c.relname relation,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN('public','cf_private') ORDER BY 1,2")).rows;
};
const runScript = async (sql, role = null) => {
  await owner();
  if (role) await db.exec(`SET ROLE ${role}`);
  try { return await db.exec(sql); }
  catch (error) { await db.exec('ROLLBACK'); throw error; }
  finally { await owner(); }
};
const rejects = (fn, code) => assert.rejects(fn, error => { if (code) assert.equal(error.code, code, error.message); return true; });
const gateway = async (name, args) => {
  await owner(); await db.exec('SET ROLE service_role');
  try { return await scalar(`SELECT public.${name}(${args.map((_, index) => '$' + (index + 1)).join(',')}) r`, args); }
  finally { await actor(); }
};
const sourceArgs = (label) => { const bytes = Buffer.from(`Fonte sintética de limpeza ${label}\u0000\u00ff`); return [`${label}.csv`, createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64')]; };
const tableCounts = async () => {
  await owner(); const result = {};
  for (const table of scope.targets) result[table] = Number(await scalar(`SELECT count(*) r FROM ${relation(table)}`));
  return result;
};
const registry = () => scalar('SELECT to_jsonb(r) r FROM cf_operations.base_resets r WHERE operation_key=$1', [operation]);
const newSchemas = () => scalar("SELECT coalesce(jsonb_agg(nspname ORDER BY nspname),'[]') r FROM pg_namespace WHERE nspname='cf_operations' OR nspname LIKE 'cf_base_backup_%'");
let today, older, month, bank, cpImport, cpTitle, stayTitle, originalTriggers;

async function seed() {
  // The shared fixture bootstraps 001..034 and 039; load every remaining migration through 047.
  await owner();
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) > 34 && Number(name.slice(0, 3)) <= 47 && !name.startsWith('039_')).sort();
  for (const name of names) await db.exec(await file(name));
  ({ today, older, month } = (await db.query("SELECT d::text today,(d-90)::text older,date_trunc('month',d)::date::text AS \"month\" FROM(SELECT(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date d)s")).rows[0]);
  await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)', [id(101), 'Responsável sintética de preparação']);
  await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)', [users.collector.id, id(101), users.manager.id]);
  await actor();
  bank = await scalar('SELECT id r FROM public.bank_accounts WHERE enabled ORDER BY id LIMIT 1');
  await scalar("SELECT public.set_bank_balance($1,$2,123456,'Saldo sintético de preparação',NULL) r", [bank, today]);
  await scalar("SELECT public.save_manual_stock(56789,$1,'Estoque sintético de preparação') r", [today]);
  await scalar("SELECT public.save_director_inputs($1,$2,'Indicadores sintéticos de preparação',NULL) r", [today, JSON.stringify({ turnover_month_cents: 123400, previous_month_taxes_cents: 1200 })]);
  await scalar("SELECT public.create_management_message('normal',NULL,'Configuração de mensagem sintética preservada') r");

  const payable = { entry_number: 'CP-RESET-SYN-1', description: 'Fornecedor sintético de preparação', due_date: today, amount_cents: 10000, source_status: 'ABERTO', plan: 'INVESTIMENTOS', bank_account: 'Conta sintética', branch: '2', issued_on: older };
  const cpSource = sourceArgs('contas-pagar-sinteticas');
  const cpRevision = await scalar('SELECT public.get_payables_revision() r');
  cpImport = await gateway('commit_payables_forecast_import_v2_from_gateway', [users.manager.id, users.manager.session, 'grupo-consolidado', ...cpSource, JSON.stringify([payable]), '{}', cpRevision.import_id, false, '{}', cpRevision.financial_revision, randomUUID()]);
  cpTitle = await scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1', [payable.entry_number]);
  await scalar("SELECT public.register_payable_payment($1,10000,$2,$3,'Pagamento integral sintético',$4,$5,$6) r", [cpTitle.id, today, bank, cpTitle.payment_revision, randomUUID(), cpTitle.last_import_id]);
  cpTitle = await scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE id=$1', [cpTitle.id]);
  await scalar("SELECT public.review_payable_title($1,'Título sintético conferido',$2) r", [cpTitle.id, cpTitle.review_fingerprint]);
  const closingStatus = await scalar('SELECT public.payables_month_status($1) r', [month]);
  if (closingStatus.can_close) {
    const closed = await scalar("SELECT public.close_payables_month($1,'Fechamento sintético para restauração',$2) r", [month, JSON.stringify(closingStatus.revision)]);
    await scalar("SELECT public.reopen_payables_month($1,'Reabertura sintética para restauração',$2) r", [month, closed]);
  }
  await scalar("SELECT public.set_payable_forecast_completion('ADIANTAMENTO',$1,true,'Conferência sintética de previsão',NULL) r", [month]);

  const paid = { document: 'CR-PAGO-SYN', client_name: 'Cliente sintético pago', client_document: null, branch: '2', issued_on: older, due_date: older, amount_cents: 12000 };
  const retired = { ...paid, document: 'CR-RETIRADO-SYN', client_name: 'Cliente sintético retirado' };
  const stay = { ...paid, document: 'CR-PRESENTE-SYN', client_name: 'Cliente sintético presente' };
  async function open(rows, full) {
    const collectors = Object.fromEntries(rows.map(row => ['name:' + row.client_name.toUpperCase(), id(101)]));
    const preview = await scalar('SELECT public.preview_receivables_open_report($1,$2,$3,$4,$5,$6) r', ['grupo-consolidado', JSON.stringify(rows), full, today, '{}', JSON.stringify(collectors)]);
    return gateway('commit_receivables_open_report_from_gateway', [users.manager.id, users.manager.session, 'grupo-consolidado', ...sourceArgs(`receber-abertos-${++sequence}`), JSON.stringify(rows), '{}', preview.previous_import_id, preview.financial_revision, JSON.stringify(collectors), full, today, randomUUID()]);
  }
  await open([paid, retired, stay], false);
  const retiredTitle = await scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE document=$1', [retired.document]);
  await scalar("SELECT public.collection_work_action($1,'START',$2,$3) r", [retiredTitle.id, retiredTitle.revision, randomUUID()]);
  stayTitle = await scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE document=$1', [stay.document]);
  const context = await scalar('SELECT public.collection_customer_context($1) r', [stayTitle.id]);
  await scalar('SELECT public.save_collection_customer_contacts($1,$2,$3,$4,$5,$6) r', [stayTitle.id, JSON.stringify(['financeiro@example.invalid']), JSON.stringify(['(31) 3333-4444']), 'Contato sintético para restauração', context.contact.revision, randomUUID()]);
  const sync = await scalar('SELECT public.get_receivables_sync_revision() r');
  await gateway('commit_receivables_received_import_from_gateway', [users.manager.id, users.manager.session, 'grupo-consolidado', ...sourceArgs('recebidos-sinteticos'), JSON.stringify([{ ...paid, received_on: today, received_amount_cents: 11500 }]), '{}', sync.import_id, sync.financial_revision, false]);
  await open([stay], true);

  await owner();
  const job = id(201), path = `${users.manager.id}/${job}/original.xlsx`, artifact = Buffer.from([0, 1, 255, 128, 97]);
  await db.query('INSERT INTO cf_private.collection_reference_jobs(id,created_by,mode,source_name,source_size,source_sha256,storage_path) VALUES($1,$2,$3,$4,$5,$6,$7)', [job, users.manager.id, 'DESCRIPTIONS', 'referencias-sinteticas.xlsx', artifact.length, createHash('sha256').update(artifact).digest('hex'), path]);
  await db.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('collection-reference-files',$1,$2)", [path, JSON.stringify({ size: artifact.length, mimetype: 'application/octet-stream' })]);
  await db.query("INSERT INTO cf_private.collection_reference_chunks(job_id,chunk_index,sha256,rows_sha256,artifact,row_count,problems) VALUES($1,0,$2,$2,$3,1,'[]')", [job, 'a'.repeat(64), artifact]);
  await db.query("INSERT INTO cf_private.collection_reference_rows(job_id,row_hash,source_line,canonical,problems,invalid) VALUES($1,$2,2,'{}','[]',false)", [job, 'b'.repeat(64)]);
  await db.query("INSERT INTO cf_private.collection_reference_publish_requests(actor_id,request_id,job_id,payload,result) VALUES($1,$2,$3,'{}','{}')", [users.manager.id, randomUUID(), job]);
  await db.query("INSERT INTO public.collection_description_references(context_key,customer_key,branch,document,description,contract,content_sha256,source_job_id) VALUES(cf_private.collection_reference_key($1,$2,$3),$3,$1,$2,'Descrição sintética para restauração','CONTRATO SINTÉTICO',$4,$5)", [stay.branch, stay.document, stayTitle.customer_key, 'c'.repeat(64), job]);
  const support = await scalar("INSERT INTO public.bank_support_files(file_name,file_sha256,size_bytes,account_id,reference_date,description,created_by) VALUES('banco-sintetico.csv',$1,$2,$3,$4,'Comprovante sintético',$5) RETURNING id r", [createHash('sha256').update(artifact).digest('hex'), artifact.length, bank, today, users.manager.id]);
  await db.query('INSERT INTO cf_private.bank_support_bytes(file_id,file_bytes) VALUES($1,$2)', [support, artifact]);

  costSource = await f.costCommit([f.row(2, '001-SINT', '6.555'), f.row(3, '002-SINT', '10.123456')], { source: 'arquivo-custos-sinteticos', reference: today, previous: null });
  const commercial = await f.commercialCommit([f.commercialRow(2, '001-SINT'), f.commercialRow(3, '002-SINT')], { source: 'arquivo-fechamento-sintetico' });
  await scalar("SELECT public.configure_commission_rule('SELLER','2026-10-01','Vendedor sintético',$1,'Política sintética que deve ser preservada') r", [JSON.stringify({ policy: 'COMMERCIAL', minimum_margin_bps: 1000 })]);
  const commission = await scalar("SELECT public.commissions_report('SELLER','2026-10-01','2026-10-31',NULL,NULL,0,5000) r");
  await scalar("SELECT public.save_commission_assessment('SELLER','2026-10-01','2026-10-31',NULL,NULL,$1) r", [commission.revision]);
  await gateway('commit_product_cost_recalculation_from_gateway', [users.manager.id, users.manager.session, costSource.import_id, '2026-10-01', commercial.import_id, randomUUID()]);
  const payroll = [{ source_row: 2, branch: 'FILIAL SINTÉTICA', employee: 'Pessoa sintética de preparação', sector: 'OPERAÇÃO', admitted_on: '2020-01-01', birthday_on: '1990-01-01', salary_base_cents: 200000, payroll_salary_cents: 170000, transport_cents: 12000, advance_cents: 20000, cost_allowance_cents: 10000, total_cents: 212000, count_label: null }];
  await gateway('commit_hr_sheet_import_from_gateway', [users.rh.id, users.rh.session, ...sourceArgs('folha-sintetica'), JSON.stringify(payroll), today, null, null]);
  await actor(); await scalar('SELECT public.save_director_position($1,$1) r', [today]);
  await owner();
  await db.exec('ALTER TABLE public.receivable_report_retirement_events DISABLE TRIGGER receivable_report_event_immutable; ALTER TABLE public.collection_description_references ENABLE ALWAYS TRIGGER collection_description_immutable;');
  originalTriggers = await triggers();
  baseline = await state([...scope.targets, ...scope.preserved, 'auth.users', 'storage.buckets', 'storage.objects']);
  const filled = scope.targets.filter(name => baseline[name].length > 0);
  assert(filled.length >= 30, `Expected broad operational fixture, found ${filled.length} tables`);
  assert(baseline['public.receivable_report_retirement_events'].some(row => row.event_sequence > 0));
  assert(baseline['cf_private.bank_support_bytes'][0].file_bytes.startsWith('\\x0001ff80'));
  console.log('Synthetic fixture:', filled.length, 'populated target tables, all', scope.targets.length, 'targets installed.');
}

try {
  await seed();
  if (process.env.CF_RESET_SEED_ONLY === '1') { console.log('Seed-only fixture passed.'); }
  else {
    await test('API roles cannot invoke either administrative script, even with an approved manager session', async () => {
      const before = await allState();
      for (const role of ['anon', 'authenticated', 'service_role']) { await rejects(() => runScript(resetSql, role), '42501'); await rejects(() => runScript(restoreSql, role), '42501'); }
      assert.deepEqual(await allState(), before); assert.deepEqual(await newSchemas(), []);
    });
    await test('an unknown foreign-key dependent aborts instead of silently cascading into another schema', async () => {
      await owner(); await db.exec('CREATE SCHEMA synthetic_extension; CREATE TABLE synthetic_extension.dependent(title_id uuid REFERENCES public.payable_titles(id));');
      await db.query('INSERT INTO synthetic_extension.dependent VALUES($1)', [cpTitle.id]);
      const before = await allState(); await rejects(() => runScript(resetSql)); assert.deepEqual(await allState(), before); assert.deepEqual(await newSchemas(), []);
      assert.equal(Number(await scalar('SELECT count(*) r FROM synthetic_extension.dependent')), 1);
      await db.exec('DROP TABLE synthetic_extension.dependent;DROP SCHEMA synthetic_extension;');
    });
    await test('an unclassified application table stops the reset even without a foreign key', async () => {
      await owner(); await db.exec('CREATE TABLE public.synthetic_unclassified_base(id integer PRIMARY KEY,payload text);INSERT INTO public.synthetic_unclassified_base VALUES(1,\'synthetic\');');
      const before = await allState(); await rejects(() => runScript(resetSql), '22023'); assert.deepEqual(await allState(), before); assert.deepEqual(await newSchemas(), []);
      await db.exec('DROP TABLE public.synthetic_unclassified_base;');
    });
    await test('a late reset audit failure rolls back backup DDL, truncation, revision bumps and operation registration together', async () => {
      await owner(); await db.exec("CREATE FUNCTION public.synthetic_reset_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic reset audit failure' USING ERRCODE='22023';END$$;CREATE TRIGGER synthetic_reset_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_reset_audit_failure();");
      const before = await allState(); await rejects(() => runScript(resetSql), '22023'); assert.deepEqual(await allState(), before); assert.deepEqual(await newSchemas(), []);
      await db.exec('DROP TRIGGER synthetic_reset_audit_failure ON public.audit_events;DROP FUNCTION public.synthetic_reset_audit_failure();');
    });
    await test('reset empties all business bases while preserving users, access, rules, audit history, Storage and byte-exact owner-only backups', async () => {
      await runScript(resetSql); const record = await registry(); backupSchema = record.backup_schema;
      assert(record.completed_at); assert.equal(record.restored_at, null);
      const counts = await tableCounts(); assert(Object.values(counts).every(count => count === 0));
      const after = await state([...scope.preserved, 'auth.users', 'storage.buckets', 'storage.objects']);
      for (const name of [...scope.preserved, 'auth.users', 'storage.buckets', 'storage.objects']) {
        if (scope.revision_states.includes(name)) assert(after[name][0].revision > baseline[name][0].revision, name);
        else if (name === 'public.audit_events') { assert.equal(after[name].length, baseline[name].length + 1); for (const original of baseline[name]) assert(after[name].some(row => row.id === original.id)); }
        else assert.deepEqual(after[name], baseline[name], name);
      }
      assert.deepEqual(await triggers(), originalTriggers);
      const metadata = (await db.query(`SELECT * FROM ${quote(backupSchema)}._tables ORDER BY relation_name`)).rows;
      assert.equal(metadata.length, scope.targets.length);
      for (const table of metadata) {
        assert.equal(Number(table.row_count), baseline[table.relation_name].length, table.relation_name);
        const copied = (await db.query(`SELECT to_jsonb(t) r FROM ${quote(backupSchema)}.${quote(table.backup_table)} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.r);
        assert.deepEqual(copied, baseline[table.relation_name], table.relation_name);
      }
      assert.equal(Number(record.removed_rows), scope.targets.reduce((sum, name) => sum + baseline[name].length, 0));
      for (const role of ['anon', 'authenticated', 'service_role']) {
        await owner(); await db.exec(`SET ROLE ${role}`);
        await rejects(() => db.query(`SELECT * FROM ${quote(backupSchema)}._tables`), '42501');
        await rejects(() => db.query('SELECT * FROM cf_operations.base_resets'), '42501');
      }
      await actor(); assert.equal((await scalar("SELECT public.list_commercial_items('2026-10-01') r")).source, null);
      assert.equal((await scalar('SELECT public.receivables_summary($1,$1) r', [today])).active_count, 0);
      await owner();
    });
    await test('a same-size backup edit is rejected by its content hash before any business rows are restored', async () => {
      await owner(); const before = await allState();
      const table = await scalar(`SELECT backup_table r FROM ${quote(backupSchema)}._tables WHERE relation_name='cf_private.bank_support_bytes'`);
      await db.exec('BEGIN');
      try {
        await db.exec(`UPDATE ${quote(backupSchema)}.${quote(table)} SET file_bytes=decode('0102030405','hex')`);
        await rejects(() => runScript(restoreSql), '23514');
      } finally { await db.exec('ROLLBACK'); await owner(); }
      assert.deepEqual(await allState(), before);
    });
    await test('schema changes since the copy stop restoration before inserts or trigger mode changes', async () => {
      await owner(); const before = await allState(), modes = await triggers();
      await db.exec('BEGIN');
      try {
        await db.exec('ALTER TABLE public.stock_positions ADD COLUMN synthetic_extra text');
        await rejects(() => runScript(restoreSql), '22023');
      } finally { await db.exec('ROLLBACK'); await owner(); }
      assert.deepEqual(await allState(), before); assert.deepEqual(await triggers(), modes);
    });
    await test('the same source can be imported again as fresh official data after the reset', async () => {
      await owner(); await db.exec('BEGIN');
      try {
        const result = await f.costCommit([f.row(2, '001-SINT', '6.555'), f.row(3, '002-SINT', '10.123456')], { source: 'arquivo-custos-sinteticos', reference: today, previous: null });
        assert.notEqual(result.import_id, costSource.import_id); assert.equal(result.idempotent, false);
        assert.equal((await f.list()).count, 2);
      } finally { await db.exec('ROLLBACK'); await owner(); }
      assert(Object.values(await tableCounts()).every(count => count === 0));
    });
    await test('replaying reset never erases a new official import and restore refuses to overwrite it', async () => {
      await actor(); const official = await scalar("SELECT public.save_manual_stock(76543,$1,'Nova posição oficial sintética') r", [today]);
      const before = await allState(); await runScript(resetSql); assert.deepEqual(await allState(), before);
      await rejects(() => runScript(restoreSql)); assert.deepEqual(await allState(), before);
      await owner(); await db.query('DELETE FROM public.stock_positions WHERE id=$1', [official]);
    });
    await test('a late restore audit failure rolls back inserts, trigger modes, revisions and restore status', async () => {
      await owner(); await db.exec("CREATE FUNCTION public.synthetic_restore_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic restore audit failure' USING ERRCODE='22023';END$$;CREATE TRIGGER synthetic_restore_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_restore_audit_failure();");
      const before = await allState(), modes = await triggers(); await rejects(() => runScript(restoreSql), '22023'); assert.deepEqual(await allState(), before); assert.deepEqual(await triggers(), modes);
      await db.exec('DROP TRIGGER synthetic_restore_audit_failure ON public.audit_events;DROP FUNCTION public.synthetic_restore_audit_failure();');
    });
    await test('restore recovers every original row including raw bytes, HR totals, ledger identity and exact trigger modes', async () => {
      const oldStates = await state(scope.revision_states); await runScript(restoreSql);
      const restored = await state(scope.targets); for (const name of scope.targets) assert.deepEqual(restored[name], baseline[name], name);
      assert.deepEqual(await triggers(), originalTriggers);
      const states = await state(scope.revision_states); for (const name of scope.revision_states) assert(states[name][0].revision > oldStates[name][0].revision, name);
      assert((await registry()).restored_at);
      const before = await allState(); await runScript(resetSql); assert.deepEqual(await allState(), before); await runScript(restoreSql); assert.deepEqual(await allState(), before);
      await owner(); await rejects(() => db.query('UPDATE public.payable_payments SET amount_cents=1'), '42501');
      const row = baseline['public.receivable_report_retirement_events'][0];
      const sequenceName = await scalar("SELECT pg_get_serial_sequence('public.receivable_report_retirement_events','event_sequence') r");
      assert(Number(await scalar(`SELECT last_value r FROM ${relation(sequenceName)}`)) >= row.event_sequence);
    });
    await test('the same scripts safely handle installed earlier modules without assuming optional 044/045/047 tables', async () => {
      const partial = await createCostFixture();
      try {
        await partial.commercialCommit([partial.commercialRow(2, 'PARTIAL-SYN')], { source: 'partial-closing-source' });
        await partial.owner();
        const beforeUsers = (await partial.db.query('SELECT to_jsonb(p) r FROM public.profiles p ORDER BY id')).rows;
        await partial.db.exec(resetSql);
        const run = await partial.scalar('SELECT to_jsonb(r) r FROM cf_operations.base_resets r WHERE operation_key=$1', [operation]);
        assert(Object.keys(run.counts).length < scope.targets.length);
        assert(!Object.hasOwn(run.counts, 'public.receivable_report_retirement_events'));
        assert.equal((await partial.scalar("SELECT public.list_commercial_items('2026-10-01') r")).count, 0);
        await partial.db.exec(restoreSql);
        assert.equal((await partial.scalar("SELECT public.list_commercial_items('2026-10-01') r")).count, 1);
        assert.deepEqual((await partial.db.query('SELECT to_jsonb(p) r FROM public.profiles p ORDER BY id')).rows, beforeUsers);
      } finally { await partial.db.close(); }
    });
    console.log(`${passed} administrative reset/recovery SQL tests passed.`);
  }
} catch (error) {
  console.error('FAIL', phase, JSON.stringify({ code: error.code, message: error.message, where: error.where, stack: String(error.stack ?? '').split('\n').slice(0, 5).join('\n') }));
  process.exitCode = 1;
} finally { await db.close(); }
