import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Descartável: identidades, CNPJs e arquivos sintéticos. Nenhuma conexão remota.
const db = new PGlite();
const roles = ['gerente_geral', 'diretor', 'contas_pagar', 'contas_receber', 'rh_dp', 'cobradora_1', 'cobradora_2'];
const users = Object.fromEntries(roles.map((name, i) => [name, {
  id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  session: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
}]));
const agents = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'];
let passed = 0;
let currentActor = 'gerente_geral';
const role = async name => { await db.exec('RESET ROLE'); await db.exec(`SET ROLE ${name}`); };
const actor = async name => {
  currentActor = name;
  await role('postgres');
  const user = users[name];
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user.id, JSON.stringify({ session_id: user.session })]);
  await role('authenticated');
};
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
const scalar = async (sql, args = []) => (await query(sql, args))[0].r;
const reject = async (sql, args = [], code = '42501') => assert.rejects(db.query(sql, args), e => {
  assert.equal(e.code, code, e.message); return true;
});
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const row = (document, overrides = {}) => ({
  document, client_name: `Cliente sintético ${document}`, client_document: null,
  branch: '2 - TESTE', issued_on: '2026-10-01', due_date: '2026-10-10', amount_cents: 10000, ...overrides,
});
const preview = rows => scalar('SELECT public.preview_receivables_import($1,$2::jsonb) AS r', ['grupo-consolidado', JSON.stringify(rows)]);
const original = name => {
  const bytes = Buffer.from(`Relatório sintético CR, nunca usar como base real: ${name}\n`);
  return { hash: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
};
const commitSql = 'SELECT public.commit_receivables_import_from_gateway($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::uuid) AS r';
const params = (rows, name, previous = null, complete = true) => {
  const file = original(name);
  return [users[currentActor].id, users[currentActor].session, 'grupo-consolidado', `${name}.csv`, file.hash, file.base64, JSON.stringify(rows), complete, previous];
};
const gatewayCommit = async args => {
  await role('service_role');
  try { return await scalar(commitSql, args); } finally { await role('authenticated'); }
};
const commit = (...args) => gatewayCommit(params(...args));
const rejectCommit = (args, code = '42501') => assert.rejects(gatewayCommit(args), e => { assert.equal(e.code, code, e.message); return true; });
const state = async () => {
  await role('postgres');
  return (await query(`SELECT
    (SELECT count(*)::int FROM public.receivable_imports) AS imports,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.receivable_titles t) AS titles,
    (SELECT count(*)::int FROM cf_private.receivable_import_files) AS files,
    (SELECT count(*)::int FROM public.audit_events) AS audits`))[0];
};
const title = async document => {
  const value = (await query('SELECT * FROM public.receivable_titles WHERE document=$1', [document]))[0];
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, v instanceof Date ? v.toISOString().slice(0, 10) : v]));
};
let latest = null;
const importNext = async (rows, name) => {
  await actor('contas_receber');
  const result = await commit(rows, name, latest);
  latest = result.import_id;
  return result;
};

try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for (const migration of ['001_identidade_rbac.sql', '003_auth_gateway.sql', '004_password_recovery.sql',
    '005_payables.sql', '006_treasury.sql', '007_director_positions.sql', '008_receivables.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  for (const [name, user] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [user.id, `${name}@example.test`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$3,true)',
      [user.id, `Test_${name}`, name]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [user.session, user.id]);
  }
  for (const [i, id] of agents.entries()) {
    await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)', [id, `Cobradora de teste ${i + 1}`]);
    await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',
      [users[`cobradora_${i + 1}`].id, id, users.gerente_geral.id]);
  }
  await test('CR and manager can preview/import; other five roles and anonymous denied; browser cannot commit rows or impersonate', async () => {
    for (const name of roles) {
      await actor(name);
      const args = params([row('A')], `browser-${name}`);
      await reject(commitSql, args);
      if (['gerente_geral', 'contas_receber'].includes(name)) {
        assert.equal((await preview([row('A')])).new_count, 1);
      } else {
        await reject('SELECT public.preview_receivables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify([row('A')])]);
        await rejectCommit(args);
      }
    }
    await role('anon');
    await reject('SELECT public.preview_receivables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify([row('A')])]);
    await reject(commitSql, params([row('A')], 'anon'));
  });
  await test('preview and commit strictly validate required fields, ISO dates, CNPJ, cents, unknown keys and full-group scope', async () => {
    const invalidRows = [[], Array(5001).fill(row('A')), [null], [row('A', { due_date: '2026-02-30' })],
      [row('A', { due_date: '10/10/2026' })], [row('A', { issued_on: '2026-13-01' })],
      [row('A', { amount_cents: 1.2 })], [row('A', { amount_cents: -1 })],
      [row('A', { amount_cents: '10000' })], [row('A', { amount_cents: 9007199254740992 })],
      [row('A', { branch: '\t\n' })], [row('A', { client_name: false })], [row('A', { document: '' })],
      [row('A', { client_name: ' '.repeat(1501) })], [row('A', { client_document: 12345678901234 })],
      [row('A', { client_document: '12.345.678/0001-00' })], [row('A', { client_document: '123' })],
      [row('A', { source_key: 'forged' })], [row('A', { collector_id: agents[0] })],
      [row('A', { amount_cents: 9007199254740991 }), row('B')],
    ];
    const before = await state();
    for (const [i, rows] of invalidRows.entries()) {
      await actor('contas_receber');
      await reject('SELECT public.preview_receivables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify(rows)], '22023');
      await rejectCommit(params(rows, `invalid-${i}`), '22023');
    }
    await actor('contas_receber');
    await reject('SELECT public.preview_receivables_import($1,$2::jsonb)', ['filial-2', JSON.stringify([row('A')])], '22023');
    const badScope = params([row('A')], 'bad-scope'); badScope[2] = 'filial-2';
    await rejectCommit(badScope, '22023');
    assert.deepEqual(await state(), before);
  });
  await test('unconfirmed report, duplicate normalized titles, corrupted SHA and unsafe filenames roll back all data', async () => {
    const before = await state();
    await actor('contas_receber');
    await rejectCommit(params([row('A')], 'unconfirmed', null, false), '22023');
    await rejectCommit(params([row('A'), row(' A ', { client_name: ' Cliente\tsintético  A ' })], 'duplicate'), '23505');
    for (const [index, value] of [[4, '0'.repeat(64)], [3, '../report.csv'], [5, '%%%']]) {
      const args = params([row('A')], 'invalid-file'); args[index] = value;
      await rejectCommit(args, '22023');
    }
    assert.deepEqual(await state(), before);
  });
  await test('5,000 distinct titles preview successfully without artificial balances', async () => {
    await actor('contas_receber');
    assert.deepEqual(await preview(Array.from({ length: 5000 }, (_, i) => row(`LOTE-${i}`, { amount_cents: 1 }))), {
      previous_import_id: null, row_count: 5000, new_count: 5000, open_count: 0, pending_count: 0, validated_in_source_count: 0,
    });
  });
  const a = row('A', { client_name: ' \u00a0Cliente\t Alfa\uFEFF ' });
  const b = row('B', { client_name: 'Cliente Beta', client_document: '12345678000100', amount_cents: 23001 });
  let first;
  await test('first report creates NEW titles, stable keys, exact normalized customers and private original archive', async () => {
    first = await importNext([a, b], 'first');
    assert.equal(first.new_count, 2); assert.equal(first.pending_count, 0);
    assert.equal(first.previous_import_id, null);
    const ta = await title('A'); const tb = await title('B');
    assert.equal(ta.client_name, 'Cliente Alfa'); assert.equal(ta.customer_key, 'name:CLIENTE ALFA');
    assert.deepEqual(JSON.parse(ta.source_key), ['2 - TESTE', 'A', 'name:CLIENTE ALFA', '2026-10-10', 10000]);
    assert.equal(tb.customer_key, 'cnpj:12345678000100');
    assert.equal(ta.status, 'NEW'); assert.equal(ta.validation_status, 'NONE');
    assert.equal(ta.payment_date, null); assert.equal(ta.collector_id, null); assert.equal(ta.revision, 1);
    await reject('SELECT * FROM cf_private.receivable_import_files');
    await role('postgres');
    assert.equal(await scalar("SELECT replace(encode(file_bytes,'base64'),chr(10),'') AS r FROM cf_private.receivable_import_files WHERE import_id=$1", [latest]), original('first').base64);
    const audit = await query("SELECT * FROM public.audit_events WHERE module='contas_receber' AND entity='receivable_imports'");
    assert.equal(audit.length, 1); assert.equal(audit[0].action, 'IMPORT');
    assert.equal(audit[0].username, 'Test_contas_receber');
    assert(!JSON.stringify(audit).includes(original('first').base64));
  });
  await test('RLS denies CP/RH, director only reads, collectors only own bound portfolio; no direct writes even manager', async () => {
    await role('postgres');
    await db.query("UPDATE public.receivable_titles SET collector_id=$1 WHERE document='A'", [agents[0]]);
    await db.query("UPDATE public.receivable_titles SET collector_id=$1 WHERE document='B'", [agents[1]]);
    for (const name of roles) {
      await actor(name);
      const visible = await query('SELECT document FROM public.receivable_titles ORDER BY document');
      const broad = ['gerente_geral', 'contas_receber', 'diretor'].includes(name);
      assert.deepEqual(visible.map(x => x.document), broad ? ['A', 'B'] : name === 'cobradora_1' ? ['A'] : name === 'cobradora_2' ? ['B'] : []);
      assert.equal((await query('SELECT * FROM public.receivable_imports')).length, broad ? 1 : 0);
      assert.equal((await query('SELECT * FROM public.collection_agents')).length, broad ? 2 : name.startsWith('cobradora_') ? 1 : 0);
      await reject("UPDATE public.receivable_titles SET amount_cents=0");
      await reject('DELETE FROM public.receivable_titles');
      await reject("INSERT INTO public.receivable_imports(scope) VALUES('forged')");
      await reject('SELECT * FROM cf_private.receivable_import_files');
    }
  });
  await test('adding, removing or changing optional CNPJ for an existing debt blocks preview and commit atomically, preserving owner', async () => {
    const before = await state();
    const variants = [
      [{ ...a, client_document: '11111111000111' }, b],
      [a, { ...b, client_document: null }],
      [a, { ...b, client_document: '22222222000122' }],
    ];
    for (const [i, rows] of variants.entries()) {
      await actor('contas_receber');
      await reject('SELECT public.preview_receivables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify(rows)], '23514');
      await rejectCommit(params(rows, `identity-change-${i}`, latest), '23514');
      assert.deepEqual(await state(), before);
    }
    await actor('contas_receber');
    assert.equal((await title('A')).collector_id, agents[0]);
    assert.equal((await title('B')).collector_id, agents[1]);
  });
  const c = row('C', { client_name: 'cliente\tALFA' });
  let second;
  await test('daily complete comparison keeps present OPEN, new NEW inherits active owner and absence only PENDING', async () => {
    await actor('contas_receber');
    assert.deepEqual(await preview([b, c]), { previous_import_id: latest, row_count: 2, new_count: 1, open_count: 1, pending_count: 1, validated_in_source_count: 0 });
    second = await importNext([{ ...b, client_name: 'Cliente Beta atualizado' }, c], 'second');
    const ta = await title('A'); const tb = await title('B'); const tc = await title('C');
    assert.equal(ta.status, 'PENDING_VALIDATION'); assert.equal(ta.validation_status, 'PENDING');
    assert.equal(ta.payment_source, 'IMPORTACAO_DIARIA'); assert.equal(ta.payment_date, null);
    assert.equal(ta.payment_reported_date, null); assert.equal(ta.in_latest_report, false);
    assert.equal(ta.collector_id, agents[0]); assert.equal(ta.first_import_id, first.import_id);
    assert.equal(tb.status, 'OPEN'); assert.equal(tb.client_name, 'Cliente Beta atualizado'); assert.equal(tc.status, 'NEW'); assert.equal(tc.collector_id, agents[0]);
    assert.equal(ta.collector_locked, true);
    await role('postgres');
    const audit = await query("SELECT * FROM public.audit_events WHERE entity='receivable_titles' AND action='AUTO_RECONCILE'");
    assert.equal(audit.length, 1); assert.equal(audit[0].before_value.status, 'NEW');
    assert.equal(audit[0].after_value.payment_date, null);
  });
  await test('stale preview and repeated original SHA do not alter titles, files, history or counts', async () => {
    const before = await state();
    await actor('contas_receber');
    await rejectCommit(params([a], 'stale', first.import_id), '40001');
    await rejectCommit(params([a], 'second', latest), '23505');
    assert.deepEqual(await state(), before);
  });
  await test('reported payment dates and collection flag survive disappearance while origin becomes daily import', async () => {
    await role('postgres');
    await db.exec("UPDATE public.receivable_titles SET status='PENDING_VALIDATION',validation_status='PENDING',payment_source='COBRANCA',payment_reported_date='2026-10-12',reported_in_collection=true,collector_locked=true WHERE document='B'");
    await importNext([c], 'third');
    const tb = await title('B');
    assert.equal(tb.status, 'PENDING_VALIDATION'); assert.equal(tb.payment_source, 'IMPORTACAO_DIARIA');
    assert.equal(tb.payment_reported_date, '2026-10-12'); assert.equal(tb.payment_date, null);
    assert.equal(tb.reported_in_collection, true); assert.equal(tb.collector_id, agents[1]);
  });
  await test('already absent NOT_LOCATED stays collecting across consecutive reports; reappearance and fresh disappearance requeues', async () => {
    await role('postgres');
    await db.exec("UPDATE public.receivable_titles SET status='NOT_LOCATED',validation_status='NONE',collector_locked=true WHERE document='B'");
    const previous = await title('B');
    for (const name of ['fourth', 'fifth']) {
      const result = await importNext([c], name);
      assert.equal(result.pending_count, 0);
      const tb = await title('B');
      assert.equal(tb.status, 'NOT_LOCATED'); assert.equal(tb.collector_id, agents[1]);
      assert.equal(tb.revision, previous.revision);
    }
    await importNext([c, b], 'sixth');
    assert.equal((await title('B')).status, 'NOT_LOCATED'); assert.equal((await title('B')).in_latest_report, true);
    const result = await importNext([c], 'seventh');
    assert.equal(result.pending_count, 1); assert.equal((await title('B')).status, 'PENDING_VALIDATION');
    assert.equal((await title('B')).collector_id, agents[1]);
  });
  await test('identity change remains blocked after an intermediate report already moved old debt to pending', async () => {
    const before = await state();
    await actor('contas_receber');
    const rows = [c, { ...b, client_document: '22222222000122' }];
    const old = await title('B');
    assert.equal(old.in_latest_report, false); assert.equal(old.status, 'PENDING_VALIDATION');
    await reject('SELECT public.preview_receivables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify(rows)], '23514');
    await rejectCommit(params(rows, 'identity-after-missing', latest), '23514');
    assert.deepEqual(await state(), before);
  });
  await test('conflicting active owners block entire import instead of choosing arbitrary collector', async () => {
    await role('postgres');
    await db.query("UPDATE public.receivable_titles SET collector_id=$1 WHERE document='C'", [agents[1]]);
    const before = await state();
    await actor('contas_receber');
    await rejectCommit(params([c, row('D', { client_name: 'Cliente Alfa' })], 'conflict', latest), '23514');
    assert.deepEqual(await state(), before);
    await role('postgres');
    await db.query("UPDATE public.receivable_titles SET collector_id=$1 WHERE document='C'", [agents[0]]);
  });
  await test('validated title appearing in source remains validated with warning and preserves final owner, date and collection flag', async () => {
    await role('postgres');
    await db.exec("UPDATE public.receivable_titles SET status='VALIDATED',validation_status='VALIDATED',payment_date='2026-10-12',payment_reported_date='2026-10-12',reported_in_collection=true WHERE document='A'");
    const before = await title('A');
    await actor('contas_receber');
    assert.equal((await preview([c, a])).validated_in_source_count, 1);
    const result = await importNext([c, a], 'validated-report');
    assert.equal(result.validated_in_source_count, 1); assert.equal(result.open_count, 1);
    assert.equal(result.new_count + result.open_count + result.validated_in_source_count, result.row_count);
    const after = await title('A');
    for (const field of ['id', 'status', 'validation_status', 'payment_source', 'payment_date', 'payment_reported_date', 'reported_in_collection', 'collector_id', 'first_import_id']) assert.equal(after[field], before[field]);
    assert.equal(after.in_latest_report, true); assert.equal(after.last_import_id, result.import_id);
    assert.equal(after.revision, before.revision + 1);
    const onlyValidatedPreview = await preview([a]);
    assert.deepEqual(onlyValidatedPreview, { previous_import_id: latest, row_count: 1, new_count: 0, open_count: 0, pending_count: 1, validated_in_source_count: 1 });
    const onlyValidated = await importNext([a], 'validated-only-report');
    assert.equal(onlyValidated.new_count, 0); assert.equal(onlyValidated.open_count, 0);
    assert.equal(onlyValidated.validated_in_source_count, 1); assert.equal(onlyValidated.row_count, 1);
    assert.equal((await title('A')).status, 'VALIDATED');
    assert.equal((await title('A')).in_latest_report, true);
    const result2 = await importNext([c], 'validated-absent');
    assert.equal(result2.pending_count, 0); assert.equal((await title('A')).status, 'VALIDATED');
    assert.equal((await title('A')).in_latest_report, false);
  });
  await test('new title does not inherit owner solely from validated historical debt; unbound/disabled collector loses reads', async () => {
    await role('postgres');
    await db.exec("UPDATE public.receivable_titles SET status='VALIDATED',validation_status='VALIDATED',payment_date='2026-10-12' WHERE document='C'");
    await importNext([row('E', { client_name: 'Cliente Alfa' })], 'new-debt');
    assert.equal((await title('E')).collector_id, null);
    await role('postgres');
    await db.query('DELETE FROM public.collector_bindings WHERE user_id=$1', [users.cobradora_1.id]);
    await actor('cobradora_1'); assert.equal((await query('SELECT * FROM public.receivable_titles')).length, 0);
    await role('postgres');
    await db.query('UPDATE public.collection_agents SET enabled=false WHERE id=$1', [agents[1]]);
    await actor('cobradora_2'); assert.equal((await query('SELECT * FROM public.receivable_titles')).length, 0);
  });
  await test('mixed name-only/CNPJ rows with identical evidence are ambiguous, but explicit independent CNPJs already established remain accepted', async () => {
    const named = row('IDENTIDADE', { client_name: 'Órgão de teste independente' });
    const identified = { ...named, client_document: '33333333000133' };
    const before = await state();
    await actor('contas_receber');
    await reject('SELECT public.preview_receivables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify([named, identified])], '23514');
    await rejectCommit(params([named, identified], 'ambiguous-first-file', latest), '23514');
    assert.deepEqual(await state(), before);
    const independent = [{ ...named, client_document: '33333333000133' }, { ...named, client_document: '44444444000144' }];
    const firstIndependent = await importNext(independent, 'explicit-independent-cnpjs');
    assert.equal(firstIndependent.new_count, 2);
    const firstKeys = (await query("SELECT id,source_key FROM public.receivable_titles WHERE document='IDENTIDADE' ORDER BY source_key"));
    await actor('contas_receber');
    const p = await preview([...independent].reverse());
    assert.equal(p.new_count, 0); assert.equal(p.open_count, 2);
    const again = await importNext([...independent].reverse(), 'established-independent-cnpjs');
    assert.equal(again.new_count, 0); assert.equal(again.open_count, 2);
    assert.deepEqual(await query("SELECT id,source_key FROM public.receivable_titles WHERE document='IDENTIDADE' ORDER BY source_key"), firstKeys);
  });
  await test('audit append-only, original archive has no direct service grants, all new tables RLS and migration recorded', async () => {
    await actor('gerente_geral');
    assert((await query("SELECT * FROM public.audit_events WHERE module='contas_receber'")).length > 10);
    await reject("UPDATE public.audit_events SET after_value='{}'::jsonb WHERE module='contas_receber'");
    await reject("DELETE FROM public.audit_events WHERE module='contas_receber'");
    await role('service_role'); await reject('SELECT * FROM cf_private.receivable_import_files');
    await reject('SELECT * FROM public.receivable_titles');
    await role('postgres');
    const tables = await query("SELECT rowsecurity FROM pg_tables WHERE tablename IN ('receivable_titles','receivable_imports','receivable_import_files')");
    assert.equal(tables.length, 3); assert(tables.every(x => x.rowsecurity));
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='008_receivables'"), 1);
    await reject("UPDATE public.audit_events SET after_value='{}'::jsonb WHERE module='contas_receber'");
  });
  await test('revoked, expired, unapproved and mismatched sessions lose read and write through official backend checks', async () => {
    await role('postgres');
    await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)', [users.contas_receber.session, users.contas_receber.id]);
    await actor('contas_receber');
    assert.equal((await query('SELECT * FROM public.receivable_titles')).length, 0);
    await reject('SELECT public.preview_receivables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify([row('X')])]);
    await rejectCommit(params([row('X')], 'revoked', latest));
    const args = params([row('X')], 'mismatch', latest); args[0] = users.gerente_geral.id;
    await rejectCommit(args);
    args[1] = '20000000-0000-4000-8000-999999999999'; await rejectCommit(args);
    await role('postgres');
    await db.query("UPDATE cf_private.approved_sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1", [users.gerente_geral.id]);
    await actor('gerente_geral'); assert.equal((await query('SELECT * FROM public.receivable_titles')).length, 0);
    await rejectCommit(params([row('X')], 'expired', latest));
  });
  console.log(`${passed} passed; 0 failed (local PostgreSQL, emulated Supabase identity)`);
} catch (error) {
  console.error(`FAILED after ${passed} passed:`, error.message, error.code ?? ''); process.exitCode = 1;
} finally { await db.close(); }
