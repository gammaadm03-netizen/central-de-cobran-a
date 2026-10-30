import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildPayableUnifiedRestartSql } from './bundle-payable-unified-restart.mjs';

// Disposable PostgreSQL only. Every source, person, account position and amount is synthetic.
const allScope = JSON.parse(await readFile(new URL('./lib/base-reset-scope.json', import.meta.url), 'utf8'));
const payableScope = JSON.parse(await readFile(new URL('./lib/payable-reset-scope.json', import.meta.url), 'utf8'));
const scope = { targets: payableScope.targets, preserved: [...allScope.targets.filter(name => !payableScope.targets.includes(name)), ...allScope.preserved], revision_states: payableScope.revision_states };
const resetSql = await readFile(new URL('../supabase/admin/zerar-somente-contas-pagar-2026-10-30.sql', import.meta.url), 'utf8');
const restoreSql = await readFile(new URL('../supabase/admin/restaurar-somente-contas-pagar-2026-10-30.sql', import.meta.url), 'utf8');
const operation = 'cp-restart-2026-10-30-v1';
const combinedSql = await buildPayableUnifiedRestartSql();
const paidBankAlias = { source_key: 'BANCO SINTETICO DE PREPARACAO', official_bank_name: 'Banco sintético de preparação' };
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
  const names = (await db.query("SELECT schemaname||'.'||tablename name FROM pg_tables WHERE schemaname IN('auth','storage','public','cf_private','cf_operations') OR schemaname LIKE 'cf_payable_backup_%' ORDER BY 1")).rows.map(row => row.name);
  return state(names);
};
const triggers = async () => {
  await owner();
  return (await db.query("SELECT n.nspname||'.'||c.relname relation,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN('public','cf_private') ORDER BY 1,2")).rows;
};
const payableDefinitions = async () => {
  await owner();
  return (await db.query("SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,p.proacl::text acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','cf_private') AND p.proname LIKE '%payable%' ORDER BY 1,2,3")).rows;
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
const newSchemas = () => scalar("SELECT coalesce(jsonb_agg(nspname ORDER BY nspname),'[]') r FROM pg_namespace WHERE nspname='cf_operations' OR nspname LIKE 'cf_payable_backup_%'");
const bodyOnly = sql => sql.replace(/^BEGIN;[\t ]*\r?\n/m, '').replace(/^COMMIT;[\t ]*\r?\n/m, '');
let today, older, month, bank, cpImport, cpTitle, stayTitle, originalTriggers, payable, cpSource, cpBeforeRevision, cpRequestId;

async function seed() {
  // The shared fixture bootstraps 001..034 and 039; load remaining migrations through 047, private bank aliases and validation protocols.
  await owner();
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) > 34 && Number(name.slice(0, 3)) <= 47 && !name.startsWith('039_')).sort();
  for (const name of names) await db.exec(await file(name));
  await db.exec(await file('050_paid_bank_rules.sql'));
  await db.exec(await file('053_receivable_financial_validation.sql'));
  await db.exec(await file('055_receivable_validation_commissions.sql'));
  await db.exec(await file('056_receivable_receipt_reversal.sql'));
  await db.exec(await file('057_receivable_return_approval.sql'));
  await db.exec(await file('058_payable_daily_reports.sql'));
  await db.exec(await file('059_payable_column_rules.sql'));
  await db.query('INSERT INTO cf_private.payable_paid_bank_aliases(source_key,official_bank_name) VALUES($1,$2)', [paidBankAlias.source_key, paidBankAlias.official_bank_name]);
  ({ today, older, month } = (await db.query("SELECT d::text today,(d-90)::text older,date_trunc('month',d)::date::text AS \"month\" FROM(SELECT(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date d)s")).rows[0]);
  await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)', [id(101), 'Responsável sintética de preparação']);
  await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)', [users.collector.id, id(101), users.manager.id]);
  await actor();
  bank = await scalar('SELECT id r FROM public.bank_accounts WHERE enabled ORDER BY id LIMIT 1');
  await scalar("SELECT public.set_bank_balance($1,$2,123456,'Saldo sintético de preparação',NULL) r", [bank, today]);
  await scalar("SELECT public.save_manual_stock(56789,$1,'Estoque sintético de preparação') r", [today]);
  await scalar("SELECT public.save_director_inputs($1,$2,'Indicadores sintéticos de preparação',NULL) r", [today, JSON.stringify({ turnover_month_cents: 123400, previous_month_taxes_cents: 1200 })]);
  await scalar("SELECT public.create_management_message('normal',NULL,'Configuração de mensagem sintética preservada') r");

  payable = { entry_number: 'CP-RESET-SYN-1', description: 'Fornecedor sintético de preparação', due_date: today, amount_cents: 10000, source_status: 'ABERTO', plan: 'INVESTIMENTOS', bank_account: 'Conta sintética', branch: '2', issued_on: older };
  cpSource = sourceArgs('contas-pagar-sinteticas');
  cpBeforeRevision = await scalar('SELECT public.get_payables_revision() r'); cpRequestId=randomUUID();
  cpImport = await gateway('commit_payables_forecast_import_v2_from_gateway', [users.manager.id, users.manager.session, 'grupo-consolidado', ...cpSource, JSON.stringify([payable]), '{}', cpBeforeRevision.import_id, false, '{}', cpBeforeRevision.financial_revision, cpRequestId]);
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
  const validated = { ...paid, document: 'CR-VALIDACAO-SYN', client_name: 'Cliente sintético de validação', amount_cents: 15000 };
  async function open(rows, full) {
    await actor('manager');
    let preview = await scalar('SELECT public.preview_receivables_open_report($1,$2,$3,$4,$5,$6) r', ['grupo-consolidado', JSON.stringify(rows), full, today, '{}', '{}']);
    const collectors = Object.fromEntries((preview.customer_collector_assignments ?? []).filter(item => item.requires_selection && !item.collector_id).map(item => [item.customer_key, id(101)]));
    if (Object.keys(collectors).length) preview = await scalar('SELECT public.preview_receivables_open_report($1,$2,$3,$4,$5,$6) r', ['grupo-consolidado', JSON.stringify(rows), full, today, '{}', JSON.stringify(collectors)]);
    for (const item of preview.return_items ?? []) {
      if (!item.approval_id) await scalar('SELECT public.approve_receivable_report_return(p_title_id=>$1,p_expected_revision=>$2,p_expected_receipt_id=>$3,p_source_row=>$4,p_reason=>$5,p_request_id=>$6,p_expected_receipt_fingerprint=>$7) r', [item.title_id, item.expected_revision, item.receipt_id, JSON.stringify(item.source_row), 'Retorno sintético para verificar cópia e restauração', randomUUID(), item.receipt_fingerprint]);
    }
    if (preview.return_count) preview = await scalar('SELECT public.preview_receivables_open_report($1,$2,$3,$4,$5,$6) r', ['grupo-consolidado', JSON.stringify(rows), full, today, '{}', JSON.stringify(collectors)]);
    return gateway('commit_receivables_open_report_from_gateway', [users.manager.id, users.manager.session, 'grupo-consolidado', ...sourceArgs(`receber-abertos-${++sequence}`), JSON.stringify(rows), '{}', preview.previous_import_id, preview.financial_revision, JSON.stringify(collectors), full, today, randomUUID()]);
  }
  await open([paid, retired, stay, validated], false);
  const validationTitle = await scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE document=$1', [validated.document]);
  await scalar("SELECT public.collection_work_action($1,'START',$2,$3) r", [validationTitle.id, validationTitle.revision, randomUUID()]);
  await scalar("SELECT public.save_collection_case($1,'TÍTULO PAGO','Relato sintético para validação',NULL,NULL,$2,0,$3,true,$4) r", [validationTitle.id, validationTitle.revision, today, randomUUID()]);
  const pendingValidation = await scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1', [validationTitle.id]);
  const validationResult = await scalar("SELECT public.validate_receivable_payment_v2($1,'CONFIRM',$2,14500,'Retenção sintética','Conferência sintética para restauração',$3,$4) r", [pendingValidation.id, today, pendingValidation.revision, randomUUID()]);
  assert.equal(validationResult.received_cents, 14500);
  assert.equal(validationResult.adjustment_cents, 500);
  const retiredTitle = await scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE document=$1', [retired.document]);
  await scalar("SELECT public.collection_work_action($1,'START',$2,$3) r", [retiredTitle.id, retiredTitle.revision, randomUUID()]);
  stayTitle = await scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE document=$1', [stay.document]);
  const context = await scalar('SELECT public.collection_customer_context($1) r', [stayTitle.id]);
  await scalar('SELECT public.save_collection_customer_contacts($1,$2,$3,$4,$5,$6) r', [stayTitle.id, JSON.stringify(['financeiro@example.invalid']), JSON.stringify(['(31) 3333-4444']), 'Contato sintético para restauração', context.contact.revision, randomUUID()]);
  const sync = await scalar('SELECT public.get_receivables_sync_revision() r');
  await gateway('commit_receivables_received_import_from_gateway', [users.manager.id, users.manager.session, 'grupo-consolidado', ...sourceArgs('recebidos-sinteticos'), JSON.stringify([{ ...paid, received_on: today, received_amount_cents: 11500 }]), '{}', sync.import_id, sync.financial_revision, false]);
  await open([stay], true);
  // Um retorno aprovado estorna o recebido anterior sem apagar o livro original.
  await open([stay, paid], true);
  await open([retired], false);

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
  await actor();
  const dailyBank = await scalar('SELECT display_name r FROM public.bank_accounts WHERE id=$1', [bank]);
  const chequeA = { ...payable, entry_number: 'CP-CHQ-SYN-A', description: 'Cheque sintético de preparação A', bank_account: dailyBank, source_status: 'CHEQUE', cheque_number: '000001' };
  const chequeB = { ...chequeA, entry_number: 'CP-CHQ-SYN-B', description: 'Cheque sintético de preparação B', cheque_number: '000002' };
  async function dailyCheques(rows, empty = false) {
    await actor();
    const preview = await scalar('SELECT public.preview_payables_daily_report($1,$2,$3,$4,$5,$6,$7) r', ['grupo-consolidado', JSON.stringify(rows), 'CHEQUES', '{}', '{}', '{}', empty]);
    assert.equal(preview.can_commit, true, JSON.stringify(preview.errors));
    return gateway('commit_payables_daily_report_from_gateway', [users.manager.id, users.manager.session, 'grupo-consolidado', ...sourceArgs(`cheques-diarios-${++sequence}`), JSON.stringify(rows), 'CHEQUES', '{}', '{}', '{}', preview.previous_import_id, preview.financial_revision, preview.report_date, randomUUID(), empty]);
  }
  await dailyCheques([chequeA, chequeB]);
  const dailyResult = await dailyCheques([chequeB]);
  assert.equal(dailyResult.paid_count, 1);
  const emptyDailyResult = await dailyCheques([], true);
  assert.equal(emptyDailyResult.paid_count, 1);
  assert.equal(emptyDailyResult.row_count, 0);
  await actor(); await scalar('SELECT public.save_director_position($1,$1) r', [today]);
  await owner();
  await db.exec('ALTER TABLE public.receivable_report_retirement_events DISABLE TRIGGER receivable_report_event_immutable; ALTER TABLE public.collection_description_references ENABLE ALWAYS TRIGGER collection_description_immutable;');
  originalTriggers = await triggers();
  baseline = await state([...scope.targets, ...scope.preserved, 'auth.users', 'storage.buckets', 'storage.objects']);
  const filled = scope.targets.filter(name => baseline[name].length > 0);
  assert(filled.length >= 12, `Expected broad CP operational fixture, found ${filled.length} tables`);
  assert(baseline['public.receivable_report_retirement_events'].some(row => row.event_sequence > 0));
  assert(baseline['cf_private.bank_support_bytes'][0].file_bytes.startsWith('\\x0001ff80'));
  assert.deepEqual(baseline['cf_private.payable_paid_bank_aliases'], [paidBankAlias]);
  assert.equal(baseline['cf_private.receivable_financial_validation_requests'].length, 1);
  assert.deepEqual(baseline['cf_private.receivable_financial_validation_requests'][0].result, validationResult);
  const manualReceipt = baseline['public.receivable_receipts'].find(row => row.id === validationResult.receipt_id);
  assert.equal(manualReceipt.amount_cents, 14500);
  assert.equal(manualReceipt.manual_nominal_amount_cents, 15000);
  assert.equal(manualReceipt.manual_adjustment_cents, 500);
  assert.equal(manualReceipt.manual_adjustment_reason, 'Retenção sintética');
  assert.equal(manualReceipt.manual_original_due_date, older);
  assert.equal(baseline['public.receivable_receipt_reversals'].length, 1);
  assert.equal(baseline['cf_private.receivable_active_receipts'].length, 1);
  assert.equal(baseline['cf_private.receivable_return_approvals'].length, 2);
  assert.equal(baseline['cf_private.receivable_return_consumptions'].length, 2);
  assert.equal(baseline['cf_private.payable_daily_reports'].length, 3);
  assert.equal(baseline['cf_private.payable_daily_requests'].length, 3);
  assert.equal(baseline['cf_private.payable_daily_actions'].length, 2);
  assert.equal(baseline['public.payable_imports'].filter(row => row.row_count === 0).length, 1);
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
    await test('an unclassified CP table stops the reset even without a foreign key', async () => {
      await owner(); await db.exec('CREATE TABLE public.payable_unclassified_base(id integer PRIMARY KEY,payload text);INSERT INTO public.payable_unclassified_base VALUES(1,\'synthetic\');');
      const before = await allState(); await rejects(() => runScript(resetSql), '22023'); assert.deepEqual(await allState(), before); assert.deepEqual(await newSchemas(), []);
      await db.exec('DROP TABLE public.payable_unclassified_base;');
    });
    await test('an unrelated new application table is preserved and does not block a CP-only restart', async () => {
      await owner(); await db.exec('CREATE TABLE public.synthetic_unrelated_base(id integer PRIMARY KEY,payload text);INSERT INTO public.synthetic_unrelated_base VALUES(1,\'synthetic\');');
      const before = await allState(); await db.exec('BEGIN');
      try { await db.exec(bodyOnly(resetSql)); assert.equal(await scalar('SELECT payload r FROM public.synthetic_unrelated_base WHERE id=1'),'synthetic'); }
      finally { await db.exec('ROLLBACK'); await owner(); }
      assert.deepEqual(await allState(),before); await db.exec('DROP TABLE public.synthetic_unrelated_base;');
    });
    await test('a late reset audit failure rolls back backup DDL, truncation, revision bumps and operation registration together', async () => {
      await owner(); await db.exec("CREATE FUNCTION public.synthetic_reset_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic reset audit failure' USING ERRCODE='22023';END$$;CREATE TRIGGER synthetic_reset_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_reset_audit_failure();");
      const before = await allState(); await rejects(() => runScript(resetSql), '22023'); assert.deepEqual(await allState(), before); assert.deepEqual(await newSchemas(), []);
      await db.exec('DROP TRIGGER synthetic_reset_audit_failure ON public.audit_events;DROP FUNCTION public.synthetic_reset_audit_failure();');
    });
    await test('reset empties only CP while preserving every other business row, config, balance, access and exact private backups', async () => {
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
      await actor(); assert.notEqual((await scalar("SELECT public.list_commercial_items('2026-10-01') r")).source, null);
      assert((await scalar('SELECT public.receivables_summary($1,$1) r', [today])).active_count > 0);
      await owner();
    });
    await test('a same-size backup edit is rejected by its content hash before any business rows are restored', async () => {
      await owner(); const before = await allState();
      const table = await scalar(`SELECT backup_table r FROM ${quote(backupSchema)}._tables WHERE relation_name='cf_private.payable_import_files'`);
      await db.exec('BEGIN');
      try {
        await db.exec(`UPDATE ${quote(backupSchema)}.${quote(table)} SET file_bytes=decode(repeat('01',octet_length(file_bytes)),'hex')`);
        await rejects(() => runScript(restoreSql), '23514');
      } finally { await db.exec('ROLLBACK'); await owner(); }
      assert.deepEqual(await allState(), before);
    });
    await test('pre-reset completed import protocols cannot replay old financial results into the new epoch', async () => {
      const before=await allState();
      await rejects(()=>gateway('commit_payables_forecast_import_v2_from_gateway',[users.manager.id,users.manager.session,'grupo-consolidado',...cpSource,JSON.stringify([payable]),'{}',cpBeforeRevision.import_id,false,'{}',cpBeforeRevision.financial_revision,cpRequestId]),'40001');
      assert.deepEqual(await allState(),before);
    });
    await test('a newly added CP table or external FK stops restoration before any insertion', async () => {
      const before=await allState();
      for(const statement of [
        'CREATE TABLE public.payable_unknown_after_reset(id integer PRIMARY KEY)',
        'CREATE TABLE public.synthetic_external_dependency(id uuid REFERENCES public.payable_titles(id))'
      ]){
        await owner();await db.exec('BEGIN');
        try{await db.exec(statement);await db.exec('SAVEPOINT reject_restore');await rejects(()=>db.exec(bodyOnly(restoreSql)),'22023');await db.exec('ROLLBACK TO SAVEPOINT reject_restore');}
        finally{await db.exec('ROLLBACK');await owner();}
        assert.deepEqual(await allState(),before);
      }
    });
    await test('state snapshot corruption and an out-of-scope manifest relation are rejected without modifying either area', async () => {
      const before=await allState();
      for(const statement of [
        `UPDATE ${quote(backupSchema)}._states SET previous_rows=jsonb_build_array(jsonb_build_object('singleton',true,'revision',99999))`,
        `UPDATE ${quote(backupSchema)}._tables SET relation_name='public.receivable_titles' WHERE relation_name='public.payable_titles'`
      ]){
        await owner();await db.exec('BEGIN');
        try{await db.exec(statement);await db.exec('SAVEPOINT reject_restore');await rejects(()=>db.exec(bodyOnly(restoreSql)));await db.exec('ROLLBACK TO SAVEPOINT reject_restore');}
        finally{await db.exec('ROLLBACK');await owner();}
        assert.deepEqual(await allState(),before);
      }
    });
    await test('schema changes since the copy stop restoration before inserts or trigger mode changes', async () => {
      await owner(); const before = await allState(), modes = await triggers();
      await db.exec('BEGIN');
      try {
        await db.exec('ALTER TABLE public.payable_titles ADD COLUMN synthetic_extra text');
        await rejects(() => runScript(restoreSql), '22023');
      } finally { await db.exec('ROLLBACK'); await owner(); }
      assert.deepEqual(await allState(), before); assert.deepEqual(await triggers(), modes);
    });
    await test('the same source can be imported again as fresh official data after the reset', async () => {
      await owner(); await db.exec('BEGIN');
      try {
        await actor(); const revision=await scalar('SELECT public.get_payables_revision() r');
        const result = await gateway('commit_payables_forecast_import_v2_from_gateway', [users.manager.id, users.manager.session, 'grupo-consolidado', ...cpSource, JSON.stringify([payable]), '{}', revision.import_id, false, '{}', revision.financial_revision, randomUUID()]);
        assert.notEqual(result.import_id, cpImport.import_id); assert.equal(result.idempotent, false);
        assert.equal(Number(await scalar('SELECT count(*) r FROM public.payable_titles')),1);
      } finally { await db.exec('ROLLBACK'); await owner(); }
      assert(Object.values(await tableCounts()).every(count => count === 0));
    });
    await test('replaying reset never erases a new official import and restore refuses to overwrite it', async () => {
      const beforeReset=await allState(); await owner(); await db.exec('BEGIN');
      try {
        await actor(); const revision=await scalar('SELECT public.get_payables_revision() r');
        await gateway('commit_payables_forecast_import_v2_from_gateway', [users.manager.id, users.manager.session, 'grupo-consolidado', ...sourceArgs('cp-oficial-novo'), JSON.stringify([{...payable,entry_number:'CP-OFICIAL-NOVO'}]), '{}', revision.import_id, false, '{}', revision.financial_revision, randomUUID()]);
        const before=await allState(); await db.exec(bodyOnly(resetSql)); assert.deepEqual(await allState(),before);
        await db.exec('SAVEPOINT reject_restore'); await rejects(()=>db.exec(bodyOnly(restoreSql)),'23514'); await db.exec('ROLLBACK TO SAVEPOINT reject_restore');
        assert.deepEqual(await allState(),before);
      } finally { await owner(); await db.exec('ROLLBACK'); }
      assert.deepEqual(await allState(),beforeReset);
    });
    await test('restore refuses a changed CP revision even when the operational tables remain empty', async () => {
      const before=await allState(); await owner(); await db.exec('BEGIN');
      try {
        await db.exec('UPDATE cf_private.payable_payment_state SET revision=revision+1');
        await db.exec('SAVEPOINT reject_restore'); await rejects(()=>db.exec(bodyOnly(restoreSql)),'23514'); await db.exec('ROLLBACK TO SAVEPOINT reject_restore');
      } finally { await db.exec('ROLLBACK'); await owner(); }
      assert.deepEqual(await allState(),before);
    });
    await test('new unrelated stock operations survive recovery and do not invalidate CP state', async () => {
      const before=await allState(); await owner(); await db.exec('BEGIN');
      try {
        await actor(); const stock=await scalar("SELECT public.save_manual_stock(76543,$1,'Nova posição de outra área preservada') r",[today]); await owner();
        await db.exec(bodyOnly(restoreSql)); assert.equal(await scalar('SELECT value_cents r FROM public.stock_positions WHERE id=$1',[stock]),76543);
        assert.equal(Number(await scalar('SELECT count(*) r FROM public.payable_titles')),baseline['public.payable_titles'].length);
      } finally { await db.exec('ROLLBACK'); await owner(); }
      assert.deepEqual(await allState(),before);
    });
    await test('a late restore audit failure rolls back inserts, trigger modes, revisions and restore status', async () => {
      await owner(); await db.exec("CREATE FUNCTION public.synthetic_restore_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic restore audit failure' USING ERRCODE='22023';END$$;CREATE TRIGGER synthetic_restore_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_restore_audit_failure();");
      const before = await allState(), modes = await triggers(); await rejects(() => runScript(restoreSql), '22023'); assert.deepEqual(await allState(), before); assert.deepEqual(await triggers(), modes);
      await db.exec('DROP TRIGGER synthetic_restore_audit_failure ON public.audit_events;DROP FUNCTION public.synthetic_restore_audit_failure();');
    });
    await test('restore recovers every original row including raw bytes, HR totals, ledger identity and exact trigger modes', async () => {
      const oldStates = await state(scope.revision_states); await runScript(restoreSql);
      const restoredNames = [...scope.targets, 'cf_private.payable_paid_bank_aliases'];
      const restored = await state(restoredNames); for (const name of restoredNames) assert.deepEqual(restored[name], baseline[name], name);
      assert.deepEqual(await triggers(), originalTriggers);
      const states = await state(scope.revision_states); for (const name of scope.revision_states) assert(states[name][0].revision > oldStates[name][0].revision, name);
      assert((await registry()).restored_at);
      const before = await allState(); await runScript(resetSql); assert.deepEqual(await allState(), before); await runScript(restoreSql); assert.deepEqual(await allState(), before);
      await owner(); await rejects(() => db.query('UPDATE public.payable_payments SET amount_cents=1'), '42501');
      await rejects(() => db.query("UPDATE cf_private.receivable_financial_validation_requests SET result='{}'"), '42501');
      const row = baseline['public.receivable_report_retirement_events'][0];
      const sequenceName = await scalar("SELECT pg_get_serial_sequence('public.receivable_report_retirement_events','event_sequence') r");
      assert(Number(await scalar(`SELECT last_value r FROM ${relation(sequenceName)}`)) >= row.event_sequence);
    });
    await test('combined activation and restart denies all API roles before installing 060 or touching a backup', async () => {
      const before=await allState(),definitions=await payableDefinitions();
      for(const role of ['anon','authenticated','service_role'])await rejects(()=>runScript(combinedSql,role),'42501');
      assert.deepEqual(await allState(),before);assert.deepEqual(await payableDefinitions(),definitions);
    });
    await test('a late failure in the combined restart rolls back 060 functions, privileges, backup, cleanup and state changes', async () => {
      const before=await allState(),definitions=await payableDefinitions();await owner();await db.exec('BEGIN');
      await db.query('DELETE FROM cf_operations.base_resets WHERE operation_key=$1',[operation]);
      await db.exec("CREATE FUNCTION public.synthetic_combined_restart_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='payable_base_reset' THEN RAISE EXCEPTION 'Synthetic late combined failure' USING ERRCODE='22023'; END IF; RETURN NEW;END$$;CREATE TRIGGER synthetic_combined_restart_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_combined_restart_failure();");
      await rejects(()=>runScript(combinedSql),'22023');
      assert.deepEqual(await allState(),before);assert.deepEqual(await payableDefinitions(),definitions);
      assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version LIKE '060_%'"),0);
    });
    await test('combined060 activation resets only CP, restores legacy empty-cheque proof and protects the fresh ALL baseline', async () => {
      const before=await allState();
      await owner();await db.exec('BEGIN');
      try{
        // Disposable fixture only: simulate the first execution of the new owner operation.
        await db.query('DELETE FROM cf_operations.base_resets WHERE operation_key=$1',[operation]);
        await db.exec(bodyOnly(combinedSql));
        assert(Object.values(await tableCounts()).every(count=>count===0));
        await db.exec('SAVEPOINT empty_unified_epoch');
        await db.exec(bodyOnly(restoreSql));
        const recovered=await state(scope.targets);for(const name of scope.targets)assert.deepEqual(recovered[name],baseline[name],name);
        await db.exec('ROLLBACK TO SAVEPOINT empty_unified_epoch');
        await actor();const bankLabel=await scalar('SELECT display_name r FROM public.bank_accounts WHERE id=$1',[bank]);
        const rows=[{...payable,entry_number:'CP-ALL-BASELINE',bank_account:bankLabel}],raw=sourceArgs('cp-all-baseline');
        const p=await scalar('SELECT public.preview_payables_unified_report($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) r',['grupo-consolidado',JSON.stringify(rows),'ALL','{}','{}','{}',false]);
        assert.equal(p.can_commit,true,JSON.stringify(p.errors));assert.equal(p.baseline_only,true);assert.equal(p.missing_count,0);
        const result=await gateway('commit_payables_unified_report_from_gateway',[users.manager.id,users.manager.session,'grupo-consolidado',...raw,JSON.stringify(rows),'ALL','{}','{}','{}',p.previous_import_id,p.financial_revision,p.report_date,randomUUID(),false]);
        assert.equal(result.row_count,1);assert.equal(result.paid_count,0);assert.equal(Number(await scalar('SELECT count(*) r FROM public.payable_titles')),1);
        const official=await allState();await db.exec(bodyOnly(combinedSql));assert.deepEqual(await allState(),official);
        await db.exec('SAVEPOINT reject_new_base_restore');await rejects(()=>db.exec(bodyOnly(restoreSql)),'23514');await db.exec('ROLLBACK TO SAVEPOINT reject_new_base_restore');assert.deepEqual(await allState(),official);
      }finally{await owner();await db.exec('ROLLBACK');}
      assert.deepEqual(await allState(),before);
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
        assert(!Object.hasOwn(run.counts, 'cf_private.receivable_financial_validation_requests'));
        assert(!Object.hasOwn(run.counts, 'public.receivable_receipt_reversals'));
        assert(!Object.hasOwn(run.counts, 'cf_private.receivable_return_approvals'));
        assert.equal((await partial.scalar("SELECT public.list_commercial_items('2026-10-01') r")).count, 1);
        await partial.db.exec(restoreSql);
        assert.equal((await partial.scalar("SELECT public.list_commercial_items('2026-10-01') r")).count, 1);
        assert.deepEqual((await partial.db.query('SELECT to_jsonb(p) r FROM public.profiles p ORDER BY id')).rows, beforeUsers);
      } finally { await partial.db.close(); }
    });
    console.log(`${passed} CP-only reset/recovery SQL tests passed.`);
  }
} catch (error) {
  console.error('FAIL', phase, JSON.stringify({ code: error.code, message: error.message, where: error.where, stack: String(error.stack ?? '').split('\n').slice(0, 5).join('\n') }));
  process.exitCode = 1;
} finally { await db.close(); }
