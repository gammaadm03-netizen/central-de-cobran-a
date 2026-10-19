import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// PostgreSQL descartável e dados exclusivamente sintéticos. Sem conexão remota.
const db = new PGlite();
const uuid = n => `96000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const roles = ['gerente_geral', 'diretor', 'contas_receber', 'contas_pagar', 'cobradora_1', 'cobradora_2'];
const users = Object.fromEntries(roles.map((role, i) => [role, { id: uuid(i + 1), session: uuid(i + 11) }]));
const agents = [uuid(30), uuid(31)];
let today, tomorrow, importId, sequence = 100, passed = 0, failed = 0;
const sql = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const scalar = async (statement, args = []) => (await db.query(statement, args)).rows[0].r;
const owner = async () => { await db.exec('RESET ROLE'); await db.query("SELECT set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claims','{}',false)"); };
const actor = async (role = 'cobradora_1', session = users[role].session, extra = {}) => {
  await owner(); await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [users[role].id, JSON.stringify({ ...(session ? { session_id: session } : {}), ...extra })]);
  await db.exec('SET ROLE authenticated');
};
const reject = (run, code = '42501') => assert.rejects(run, error => { assert.equal(error.code, code, error.message); return true; });
const test = async (name, run) => { try { await run(); passed++; console.log('PASS', name); } catch (error) { failed++; console.error('FAIL', name, error.stack ?? error.message); } };
const state = async () => {
  await owner(); const result = {};
  const tables = (await db.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN('auth','public','cf_private','storage') ORDER BY schemaname,tablename")).rows;
  for (const { name } of tables) result[name] = await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS r FROM ${name} t`);
  return result;
};
const fixture = async (options = {}) => {
  await owner(); const n = ++sequence;
  const r = { name: `Cliente sintético ${n}`, days: 10, amount: 10000, collector: agents[0], status: 'OPEN', document: `NF-${n}`, branch: 'Filial sintética', clientDocument: null, ...options };
  return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,client_document,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_date,first_import_id,last_import_id)
    VALUES('grupo-consolidado',$1,$2,$3,$4,cf_private.receivable_customer_key($3,$4),$5,$6::date-$7::int,$8,$9,$10,$11,$12,
    CASE WHEN $10='VALIDATED' THEN $6::date END,$13,$13) RETURNING id AS r`, [
    `synthetic-${n}`, r.document, r.name, r.clientDocument, r.branch, today, r.days, r.amount, r.collector, r.status,
    r.status === 'VALIDATED' ? 'VALIDATED' : r.status === 'PENDING_VALIDATION' ? 'PENDING' : 'NONE',
    ['VALIDATED', 'PENDING_VALIDATION'].includes(r.status) ? 'IMPORTACAO_DIARIA' : null, importId,
  ]);
};
const title = id => scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1', [id]);
const detail = id => scalar('SELECT public.collection_case_detail($1) AS r', [id]);
const work = async (id, request = randomUUID()) => scalar('SELECT public.collection_work_action($1,$2,$3,$4) AS r', [id, 'START', (await detail(id)).title.revision, request]);
const save = async (id, request = randomUUID(), finish = true, paid = false) => {
  const d = await detail(id);
  await scalar('SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r', [id,
    paid ? 'TÍTULO PAGO' : 'COBRANCA POR WHATSAPP', 'Observação INTERNA que não pode ir no e-mail',
    paid ? null : 'Retorno interno confidencial', paid ? null : tomorrow, d.title.revision, d.case.revision, paid ? today : null, finish, request]);
  return request;
};
const finish = async (id, role = 'cobradora_1', paid = false) => { await actor(role); await work(id); return save(id, randomUUID(), true, paid); };
const draft = request => scalar('SELECT public.prepare_collection_customer_email($1) AS r', [request]);
const receipt = async id => {
  await owner(); return scalar(`INSERT INTO public.receivable_receipts(title_id,amount_cents,payment_date,delay_days,delay_band,collector_id,payment_source,reported_in_collection,validated_by)
    VALUES($1,10000,$2,10,'ATE_30',$3,'IMPORTACAO_DIARIA',false,$4) RETURNING id AS r`, [id, today, agents[0], users.contas_receber.id]);
};
try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  const migration = await sql('040_collection_email_draft.sql');
  await test('040 refuses missing application prerequisites atomically', async () => {
    await reject(() => db.exec(migration), '22023'); await db.exec('ROLLBACK');
    assert.equal(await scalar("SELECT to_regprocedure('public.prepare_collection_customer_email(uuid)')::text AS r"), null);
  });
  for (const name of ['001_identidade_rbac.sql', '003_auth_gateway.sql', '004_password_recovery.sql', '005_payables.sql', '006_treasury.sql', '007_director_positions.sql',
    '008_receivables.sql', '009_collections.sql', '022_collections_overdue_only.sql', '023_receivable_sync.sql', '024_receivable_received_import.sql',
    '025_collections_management.sql', '026_collection_workbench.sql', '027_collection_customer_context.sql']) await db.exec(await sql(name));
  await db.exec(`CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;`);
  await db.exec(await sql('028_collection_reference_imports.sql')); await db.exec(await sql('029_collection_workflow.sql'));
  // No039: this feature requires the established collection workflow only.
  await db.exec(await sql('031_director_readonly.sql'));
  for (const [role, user] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [user.id, `${role}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)', [user.id, role]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [user.session, user.id]);
  }
  for (const [i, agent] of agents.entries()) {
    await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)', [agent, `Responsável sintética ${i + 1}`]);
    await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)', [users[`cobradora_${i + 1}`].id, agent, users.gerente_geral.id]);
  }
  ({ today, tomorrow } = (await db.query("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text AS tomorrow")).rows[0]);
  importId = await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count)
    VALUES('grupo-consolidado','synthetic.csv',repeat('a',64),$1,1,1,0,0,0) RETURNING id AS r`, [users.contas_receber.id]);
  const customer = 'Cliente de e-mail sintético';
  const anchor = await fixture({ name: customer, amount: 10101, document: 'NF-ANCHOR' });
  const overdue = await fixture({ name: customer, amount: 20202, days: 3, document: 'NF-OVERDUE', branch: 'Outra filial' });
  const dueToday = await fixture({ name: customer, amount: 30303, days: 0, document: 'NF-TODAY' });
  const upcoming = await fixture({ name: customer, amount: 40404, days: -15, document: 'NF-FUTURE' });
  await fixture({ name: customer, collector: agents[1], document: 'OTHER-COLLECTOR' });
  await fixture({ name: 'Clíente de e-mail sintético', document: 'OTHER-CUSTOMER' });
  await fixture({ name: customer, clientDocument: '12345678000199', document: 'SAME-NAME-DIFFERENT-KEY' });
  const paid = await fixture({ name: customer, status: 'VALIDATED', document: 'SETTLED' });
  const pending = await fixture({ name: customer, status: 'PENDING_VALIDATION', document: 'PENDING' });
  const received = await fixture({ name: customer, document: 'RECEIPT-DESYNCHRONIZED' }); await receipt(received);
  const finishRequest = await finish(anchor);

  await test('activation is repeatable and preserves financial, contact, workflow and audit histories', async () => {
    const before = await state(); await db.exec(migration);
    const after = await state();
    assert.deepEqual({ ...after, 'public.central_schema_migrations': before['public.central_schema_migrations'] }, before);
    await db.exec(migration); assert.deepEqual(await state(), after);
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='040_collection_email_draft'"), 1);
  });
  await test('own confirmed finish returns every eligible exact-customer/current-wallet title with exact overdue and upcoming totals', async () => {
    await actor(); const result = await draft(finishRequest);
    assert.equal(result.request_id, finishRequest); assert.equal(result.title_id, anchor); assert.equal(result.client_name, customer); assert.equal(result.as_of_date, today);
    assert.deepEqual(result.rows.map(row => row.title_id), [anchor, overdue, dueToday, upcoming]);
    assert.deepEqual(result.rows.map(row => row.category), ['OVERDUE', 'OVERDUE', 'UPCOMING', 'UPCOMING']);
    assert.equal(result.overdue_count, 2); assert.equal(result.upcoming_count, 2); assert.equal(result.total_count, 4);
    assert.equal(result.overdue_cents, 30303); assert.equal(result.upcoming_cents, 70707); assert.equal(result.total_cents, 101010);
    assert.equal(result.rows[1].branch, 'Outra filial'); assert.match(result.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.emails, []);
    assert(result.rows.every(row => Object.keys(row).sort().join(',') === 'amount_cents,branch,category,document,due_date,title_id'));
    assert(!JSON.stringify(result).includes('INTERNA')); assert(!JSON.stringify(result).includes('confidencial'));
    assert(!result.rows.some(row => [paid, pending, received].includes(row.title_id)));
  });
  await test('drafts are pure reads and do not widen workbench or direct RLS to future titles', async () => {
    const before = await state(); await actor(); const first = await draft(finishRequest); const second = await draft(finishRequest);
    assert.deepEqual(first, second);
    assert.equal((await db.query('SELECT id FROM public.receivable_titles WHERE id=$1', [upcoming])).rows.length, 0);
    const visible = await scalar('SELECT public.collection_workbench() AS r'); assert(!visible.rows.some(row => [upcoming, dueToday].includes(row.id)));
    assert.deepEqual(await state(), before);
  });
  await test('only immutable own successful case-finish requests can authorize a draft', async () => {
    await actor(); await reject(() => draft(null)); await reject(() => draft(randomUUID()));
    const unfinished = await fixture(); await actor();
    const workRequest = randomUUID(); await work(unfinished, workRequest); await reject(() => draft(workRequest));
    const saveRequest = await save(unfinished, randomUUID(), false); await reject(() => draft(saveRequest));
    await owner(); await db.query("UPDATE public.collection_work_sessions SET ended_at=greatest(started_at,clock_timestamp()),end_reason='PAUSE' WHERE ended_at IS NULL");
    for (const [payload, result] of [
      [{ kind: 'case', title_id: anchor, finish: true }, { title_id: upcoming, finished: true }],
      [{ kind: 'case', title_id: upcoming, finish: true }, { title_id: anchor, finished: true }],
      [{ kind: 'case', title_id: anchor, finish: 'true' }, { title_id: anchor, finished: true }],
      [{ kind: 'case', title_id: anchor, finish: true }, { title_id: anchor, finished: false }],
    ]) {
      await owner(); const request = randomUUID(); await db.query('INSERT INTO public.collection_work_requests(actor_id,request_id,title_id,payload,result) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)', [users.cobradora_1.id, request, anchor, JSON.stringify(payload), JSON.stringify(result)]);
      await actor(); await reject(() => draft(request));
    }
    await reject(() => db.query('INSERT INTO public.collection_work_requests(actor_id,request_id,title_id,payload,result) VALUES($1,$2,$3,\'{}\',\'{}\')', [users.cobradora_1.id, randomUUID(), anchor]));
  });
  await test('another collector and privileged finance users cannot reuse someone else’s finish request', async () => {
    for (const role of ['cobradora_2', 'contas_receber', 'gerente_geral']) { await actor(role); await reject(() => draft(finishRequest)); }
    for (const role of ['diretor', 'contas_pagar']) { await actor(role); await reject(() => draft(finishRequest)); }
    for (const role of ['anon', 'service_role']) { await owner(); await db.exec(`SET ROLE ${role}`); await reject(() => draft(finishRequest)); }
  });
  await test('reassignment, disabled collectors and changed bindings immediately deny stale finish references', async () => {
    await owner(); await db.query('UPDATE public.receivable_titles SET collector_id=$2 WHERE id=$1', [anchor, agents[1]]);
    await actor(); await reject(() => draft(finishRequest));
    await owner(); await db.query('UPDATE public.receivable_titles SET collector_id=$2 WHERE id=$1', [anchor, agents[0]]); await db.query('UPDATE public.collection_agents SET enabled=false WHERE id=$1', [agents[0]]);
    await actor(); await reject(() => draft(finishRequest));
    await owner(); await db.query('UPDATE public.collection_agents SET enabled=true WHERE id=$1', [agents[0]]); await db.query('DELETE FROM public.collector_bindings WHERE user_id=$1', [users.cobradora_1.id]);
    await actor(); await reject(() => draft(finishRequest));
    await owner(); await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)', [users.cobradora_1.id, agents[0], users.gerente_geral.id]);
  });
  await test('disabled, expired and unapproved sessions and forged role metadata cannot authorize the RPC', async () => {
    for (const session of [null, uuid(999)]) { await actor('cobradora_1', session); await reject(() => draft(finishRequest)); }
    await owner(); await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [users.cobradora_1.session]);
    await actor(); await reject(() => draft(finishRequest));
    await owner(); await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE session_id=$1", [users.cobradora_1.session]); await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1', [users.cobradora_1.id]);
    await actor(); await reject(() => draft(finishRequest));
    await owner(); await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1', [users.cobradora_1.id]);
    await actor('cobradora_2', users.cobradora_2.session, { role: 'service_role', user_metadata: { role: 'gerente_geral' } }); await reject(() => draft(finishRequest));
  });
  await test('current official imported contacts and later manual edits determine recipients without exposing notes', async () => {
    await owner(); const t = await title(anchor);
    await db.query(`INSERT INTO public.collection_customer_contacts(customer_key,client_name,emails,phones,notes,updated_by)
      VALUES($1,$2,$3::jsonb,'[]','Nota de contato INTERNA',$4)`, [t.customer_key, t.client_name, JSON.stringify([' Imported@Example.Invalid ', 'imported@example.invalid', 'another@example.invalid']), users.contas_receber.id]);
    await actor(); const imported = await draft(finishRequest); assert.deepEqual(imported.emails, ['another@example.invalid', 'imported@example.invalid']);
    const context = await scalar('SELECT public.collection_customer_context($1) AS r', [anchor]);
    await scalar('SELECT public.save_collection_customer_contacts($1,$2::jsonb,$3::jsonb,$4,$5,$6) AS r', [anchor, JSON.stringify(['manual@example.invalid']), '[]', 'Nota manual INTERNA', context.contact.revision, randomUUID()]);
    const manual = await draft(finishRequest); assert.deepEqual(manual.emails, ['manual@example.invalid']); assert.notEqual(manual.revision, imported.revision); assert(!JSON.stringify(manual).includes('INTERNA'));
    await owner(); await db.query("UPDATE public.collection_customer_contacts SET emails='[\"bad;extra@example.invalid\"]'::jsonb WHERE customer_key=$1", [t.customer_key]);
    await actor(); await reject(() => draft(finishRequest), '22023');
    for (const email of ['x'.repeat(65) + '@example.invalid', 'x'.repeat(64) + '@' + 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(62)]) {
      await owner(); await db.query('UPDATE public.collection_customer_contacts SET emails=$2::jsonb WHERE customer_key=$1', [t.customer_key, JSON.stringify([email])]);
      await actor(); await reject(() => draft(finishRequest), '22023');
    }
    const boundaryEmail = 'x'.repeat(64) + '@' + 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(61);
    assert.equal(boundaryEmail.length, 254);
    await owner(); await db.query('UPDATE public.collection_customer_contacts SET emails=$2::jsonb WHERE customer_key=$1', [t.customer_key, JSON.stringify([boundaryEmail])]);
    await actor(); assert.deepEqual((await draft(finishRequest)).emails, [boundaryEmail]);
    await owner(); await db.query("UPDATE public.collection_customer_contacts SET emails='[\"manual@example.invalid\"]'::jsonb WHERE customer_key=$1", [t.customer_key]);
  });
  await test('paid finalization and later financial validation exclude only settled/pending rows, without reopening the debt', async () => {
    const name = 'Cliente pagamento sintético'; const paidAnchor = await fixture({ name }); const remaining = await fixture({ name, days: -2, amount: 12345 });
    const request = await finish(paidAnchor, 'cobradora_1', true); await actor();
    assert.equal((await title(paidAnchor)).status, 'PENDING_VALIDATION'); assert.deepEqual((await draft(request)).rows.map(row => row.title_id), [remaining]);
    await actor('contas_receber'); const current = await title(paidAnchor);
    await scalar('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5) AS r', [paidAnchor, 'CONFIRM', today, 'Conferência sintética', current.revision]);
    await actor(); assert.deepEqual((await draft(request)).rows.map(row => row.title_id), [remaining]);
    await owner(); await receipt(remaining); await actor();
    const empty = await draft(request); assert.deepEqual(empty.rows, []); assert.equal(empty.total_count, 0); assert.equal(empty.total_cents, 0);
    await owner(); assert.equal((await title(paidAnchor)).status, 'VALIDATED');
  });
  await test('CR and manager may prepare only their own finalized current assigned-wallet cases', async () => {
    for (const role of ['contas_receber', 'gerente_geral']) {
      const name = `Cliente ${role} sintético`; const a = await fixture({ name, collector: agents[1] }); const future = await fixture({ name, collector: agents[1], days: -3 });
      await fixture({ name, collector: agents[0], document: 'OTHER-WALLET' }); const request = await finish(a, role);
      await actor(role); assert.deepEqual((await draft(request)).rows.map(row => row.title_id), [a, future]);
    }
  });
  await test('more than a page of future titles is returned completely and the 5000-title ceiling fails visibly', async () => {
    const name = 'Cliente volumoso sintético'; const a = await fixture({ name }); const request = await finish(a);
    await owner();
    await db.query(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,first_import_id,last_import_id)
      SELECT 'grupo-consolidado','bulk-synthetic-'||i,'NF-BULK-'||lpad(i::text,5,'0'),$1,cf_private.receivable_customer_key($1,NULL),'Filial sintética',$2::date+1,1,$3,'OPEN','NONE',$4,$4 FROM generate_series(1,80)i`, [name, today, agents[0], importId]);
    await actor(); const many = await draft(request); assert.equal(many.total_count, 81); assert.equal(many.upcoming_count, 80); assert.equal(many.total_cents, 10080);
    await owner();
    await db.query(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,first_import_id,last_import_id)
      SELECT 'grupo-consolidado','bulk-synthetic-'||i,'NF-BULK-'||lpad(i::text,5,'0'),$1,cf_private.receivable_customer_key($1,NULL),'Filial sintética',$2::date+1,1,$3,'OPEN','NONE',$4,$4 FROM generate_series(81,5000)i`, [name, today, agents[0], importId]);
    await actor(); await reject(() => draft(request), '54000');
    await owner(); assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_titles WHERE client_name=$1', [name]), 5001);
  });
  await test('unsafe aggregate cents raise a precision error instead of returning rounded amounts', async () => {
    const name = 'Cliente total excedido sintético'; const a = await fixture({ name, amount: 9007199254740991 }); await fixture({ name, amount: 1 });
    const request = await finish(a); await actor(); await reject(() => draft(request), '22003');
  });
} catch (error) { failed++; console.error('SETUP FAILURE', error.stack ?? error.message); }
finally { await db.close(); }
console.log(`${passed} passed; ${failed} failed (local PostgreSQL; emulated Supabase identity)`);
if (failed) process.exitCode = 1;
