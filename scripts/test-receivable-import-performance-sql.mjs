import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildReceivableImportPerformanceSql } from './bundle-receivable-import-performance.mjs';

// PostgreSQL descartável. Todos os nomes, valores e arquivos são sintéticos.
const db = new PGlite();
const scope = 'grupo-consolidado';
const roles = ['gerente_geral', 'diretor', 'contas_receber', 'contas_pagar', 'rh_dp', 'cobradora_1', 'cobradora_2'];
const users = Object.fromEntries(roles.map((role, index) => [role, {
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  session: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
}]));
const agents = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'];
const read = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const migration = await read('041_receivable_import_performance.sql');
const owner = () => db.exec('RESET ROLE');
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
let passed = 0, failed = 0, sequence = 0, day, earlier, moved, current = 'contas_receber';
async function actor(role = 'contas_receber') {
  current = role; await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [users[role].id, JSON.stringify({ session_id: users[role].session })]);
  await db.exec('SET ROLE authenticated');
}
async function test(name, body) {
  try { await body(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack ?? error.message); }
}
const row = (document, changes = {}) => ({ document, client_name: `Cliente sintético ${document}`, client_document: null,
  branch: 'Matriz sintética', issued_on: '2020-01-01', due_date: earlier, amount_cents: 10000, ...changes });
const paid = (original, changes = {}) => ({ ...original, received_on: day, received_amount_cents: original.amount_cents, ...changes });
const preview = (mode, rows, mappings = {}) => scalar(`SELECT public.preview_receivables_${mode === 'open' ? 'open' : 'received'}_import($1,$2::jsonb,$3::jsonb) AS r`, [scope, JSON.stringify(rows), JSON.stringify(mappings)]);
async function commit(mode, rows, { mappings = {}, file = ++sequence, confirm = false } = {}) {
  await actor(); const revision = await scalar('SELECT public.get_receivables_sync_revision() AS r');
  const bytes = Buffer.from(`Arquivo exclusivamente sintético de regressão ${file}`);
  const args = [users.contas_receber.id, users.contas_receber.session, scope, `synthetic-${file}.csv`, createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), JSON.stringify(mappings), revision.import_id, revision.financial_revision];
  if (mode === 'received') args.push(confirm);
  await owner(); await db.exec('SET ROLE service_role');
  try { return await scalar(`SELECT public.commit_receivables_${mode === 'open' ? 'open' : 'received'}_import_from_gateway(${args.map((_, index) => `$${index + 1}${index === 6 || index === 7 ? '::jsonb' : ''}`).join(',')}) AS r`, args); }
  finally { await actor(); }
}
async function state() {
  await owner(); const result = {};
  for (const table of ['public.profiles', 'public.role_permissions', 'public.receivable_titles', 'public.receivable_imports', 'public.receivable_receipts', 'public.receivable_sync_imports', 'public.receivable_receipt_import_provenance', 'public.receivable_receipt_adjustments', 'public.receivable_received_import_rows', 'public.audit_events', 'cf_private.receivable_parcel_aliases', 'cf_private.receivables_sync_state', 'cf_private.receivable_import_files']) {
    result[table] = await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) AS r FROM ${table} r`);
  }
  return result;
}
async function functionContract() {
  await owner();
  return scalar(`SELECT jsonb_build_object('security_definer',prosecdef,'volatility',provolatile,'config',proconfig,'acl',proacl::text,'owner',proowner::text)
    AS r FROM pg_proc WHERE oid='cf_private.resolve_receivable_sync_rows(text,jsonb,jsonb,text)'::regprocedure`);
}
async function resultOrCode(mode, rows, mappings) {
  await actor();
  try { return { result: await preview(mode, rows, mappings) }; }
  catch (error) { return { code: error.code }; }
}
async function accessMatrix() {
  const result = {};
  for (const role of roles) {
    await actor(role);
    for (const mode of ['open', 'received']) {
      try { await preview(mode, mode === 'open' ? [row('ACCESS')] : [paid(row('ACCESS'))]); result[`${role}:${mode}`] = 'allowed'; }
      catch (error) { result[`${role}:${mode}`] = error.code; }
    }
  }
  await owner();
  result.acl = await scalar(`SELECT jsonb_agg(jsonb_build_object('role',role,'execute',has_function_privilege(role,'cf_private.resolve_receivable_sync_rows(text,jsonb,jsonb,text)','EXECUTE')) ORDER BY role) AS r
    FROM unnest(ARRAY['anon','authenticated','service_role']) role`);
  return result;
}

try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for (const name of ['001_identidade_rbac.sql', '003_auth_gateway.sql', '004_password_recovery.sql', '005_payables.sql', '006_treasury.sql', '007_director_positions.sql', '008_receivables.sql', '009_collections.sql', '022_collections_overdue_only.sql', '023_receivable_sync.sql']) await db.exec(await read(name));
  await test('041 refuses a database missing 024 and leaves no partial registration', async () => {
    await assert.rejects(db.exec(migration), error => error.code === '22023'); await db.exec('ROLLBACK');
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='041_receivable_import_performance'"), 0);
  });
  await db.exec(await read('024_receivable_received_import.sql'));
  for (const [role, user] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [user.id, `${role}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)', [user.id, role]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [user.session, user.id]);
  }
  for (const [index, id] of agents.entries()) {
    await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)', [id, `Responsável sintética ${index + 1}`]);
    await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)', [users[`cobradora_${index + 1}`].id, id, users.gerente_geral.id]);
  }
  ({ day, earlier, moved } = (await db.query(`SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,
    ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-10)::text AS earlier,
    ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-5)::text AS moved`)).rows[0]);
  const a = row('NF-PARCELA', { client_name: 'Órgão sintético A' });
  const a2 = { ...a, due_date: '2020-02-01', amount_cents: 20000 };
  const base = [a, a2, { ...a, client_name: 'Órgão sintético B' }, { ...a, branch: 'Filial sintética Sul' },
    row('00014'), row('14'), row('0'), row('000'), row('NF-CAPS'), row('SETTLED'), row('MANUAL'), row('CNPJ', { client_document: '12345678000195' })];
  await commit('open', base);
  await owner(); await db.query('UPDATE public.receivable_titles SET collector_id=$1', [agents[0]]);
  const titles = (await db.query('SELECT id,document,client_name,branch,due_date::text AS due_date FROM public.receivable_titles')).rows;
  const aid = titles.find(t => t.document === a.document && t.client_name === a.client_name && t.branch === a.branch && t.due_date === a.due_date).id;
  const otherId = titles.find(t => t.document === '14').id;
  await commit('received', [paid(row('SETTLED'), { received_amount_cents: 9000 })]);
  const manualId = titles.find(t => t.document === 'MANUAL').id;
  await actor('cobradora_1');
  let manualTitle = await scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1', [manualId]);
  await scalar("SELECT public.record_collection_action($1,'PAID',$2,NULL,NULL,'Pagamento sintético',NULL,$2,$3) AS r", [manualId, day, manualTitle.revision]);
  await actor(); manualTitle = await scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1', [manualId]);
  await scalar("SELECT public.validate_receivable_payment($1,'CONFIRM',$2,'Conferência sintética',$3) AS r", [manualId, day, manualTitle.revision]);
  const scenarios = [
    ['open exact and distinct clients/branches/zero identifiers', 'open', base.slice(0, 9), {}],
    ['open case and whitespace normalization', 'open', [row(' nf-caps ', { branch: '  Matriz   sintética  ' })], {}],
    ['open amount update', 'open', [{ ...a, amount_cents: 12000 }], {}],
    ['open changed due ambiguous', 'open', [{ ...a, due_date: moved }], {}],
    ['open changed due NEW', 'open', [{ ...a, due_date: moved }], { 1: 'NEW' }],
    ['open changed due explicit UUID', 'open', [{ ...a, due_date: moved }], { 1: aid }],
    ['open UUID of another group remains conflict', 'open', [{ ...a, due_date: moved }], { 1: otherId }],
    ['received exact', 'received', [paid(a)], {}],
    ['received changed due ambiguous', 'received', [paid({ ...a, due_date: moved })], {}],
    ['received changed due NEW', 'received', [paid({ ...a, due_date: moved })], { 1: 'NEW' }],
    ['received changed due explicit UUID', 'received', [paid({ ...a, due_date: moved })], { 1: aid }],
    ['received historical new group', 'received', [paid(row('HISTORICAL'))], {}],
    ['received existing receipt matched', 'received', [paid(row('SETTLED'), { received_amount_cents: 9000 })], {}],
    ['received existing receipt correction', 'received', [paid(row('SETTLED'), { received_amount_cents: 9500 })], {}],
    ['received manual conflict', 'received', [paid(row('MANUAL'), { received_amount_cents: 9500 })], {}],
    ['duplicate identity rejected', 'open', [a, { ...a, amount_cents: 12000 }], {}],
    ['different lines cannot target same UUID', 'received', [paid(a), paid({ ...a, due_date: moved })], { 2: aid }],
    ['CNPJ identity change rejected', 'open', [row('CNPJ')], {}],
  ];
  const baseline = [];
  for (const [, mode, rows, mappings] of scenarios) baseline.push(await resultOrCode(mode, rows, mappings));
  const accessBefore = await accessMatrix(), contractBefore = await functionContract(), financialBefore = await state();
  await owner(); await db.exec(migration);
  await test('activation preserves every financial row, alias, original, actor, audit and revision', async () => {
    assert.deepEqual(await state(), financialBefore);
    assert.equal(await scalar("SELECT to_regclass('public.collection_customer_contacts')::text AS r"), null);
    assert.equal(await scalar("SELECT to_regclass('public.receivable_sync_identity_lookup')::text AS r"), 'receivable_sync_identity_lookup');
  });
  for (const [index, [name, mode, rows, mappings]] of scenarios.entries()) {
    await test(`exact before/after parity: ${name}`, async () => { assert.deepEqual(await resultOrCode(mode, rows, mappings), baseline[index]); });
  }
  await test('only three index prefilters change the private resolver definition', async () => {
    const original = await read('023_receivable_sync.sql');
    const extract = source => source.slice(source.indexOf('FUNCTION cf_private.resolve_receivable_sync_rows('), source.indexOf('$$;', source.indexOf('AS $$', source.indexOf('FUNCTION cf_private.resolve_receivable_sync_rows('))) + 3);
    const optimized = extract(migration);
    const prefix = "upper(cf_private.normalize_receivable_text(t.branch))=upper(v_row->>'branch')\n   AND upper(cf_private.normalize_receivable_text(t.document))=upper(v_row->>'document')\n   AND t.customer_key=v_row->>'customer_key'\n   AND ";
    assert.equal(optimized.split(prefix).length - 1, 3);
    assert.equal(optimized.split(prefix).join(''), extract(original));
    assert.equal((optimized.match(/cf_private\.receivable_sync_group_key\(t\.branch,t\.document,t\.customer_key\)=v_row->>'group_key'/g) ?? []).length, 3);
    assert.deepEqual(await functionContract(), contractBefore);
  });
  await test('RPC authorization and private function ACL remain unchanged for all roles', async () => {
    assert.deepEqual(await accessMatrix(), accessBefore);
    for (const [key, value] of Object.entries(accessBefore)) if (key !== 'acl') assert.equal(value, key.startsWith('gerente_geral:') || key.startsWith('contas_receber:') ? 'allowed' : '42501');
    assert(accessBefore.acl.every(entry => entry.execute === false));
  });
  await test('confirmed due-date binding retains UUID, actual receipt and idempotent replay', async () => {
    const source = paid({ ...a, due_date: moved }, { received_amount_cents: 12345 });
    const file = ++sequence, result = await commit('received', [source], { mappings: { 1: aid }, file });
    await actor(); const settled = await scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1', [aid]);
    assert.equal(settled.id, aid); assert.equal(settled.status, 'VALIDATED'); assert.equal(settled.due_date, moved);
    assert.equal(await scalar('SELECT amount_cents AS r FROM public.effective_receivable_receipts WHERE title_id=$1', [aid]), 12345);
    const beforeReplay = await state(), replay = await commit('received', [source], { mappings: { 1: aid }, file });
    assert.equal(replay.import_id, result.import_id); assert.equal(replay.idempotent, true); assert.deepEqual(await state(), beforeReplay);
    await actor(); assert.equal((await preview('received', [source])).can_commit, true);
  });
  await test('standalone dashboard SQL matches the generator and repeats without data or revision changes', async () => {
    const sql = await buildReceivableImportPerformanceSql();
    assert.equal(await readFile(new URL('../supabase/dashboard/ativar-otimizacao-importacao-recebiveis.sql', import.meta.url), 'utf8'), sql);
    const before = await state(); await owner(); await db.exec(sql); assert.deepEqual(await state(), before);
    await db.exec(sql); assert.deepEqual(await state(), before);
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='041_receivable_import_performance'"), 1);
  });
} catch (error) { failed++; console.error('SETUP FAILURE', error.stack ?? error.message); }
finally { await db.close(); }
console.log(`${passed} passed; ${failed} failed (synthetic local PostgreSQL; no remote execution)`);
if (failed) process.exitCode = 1;
