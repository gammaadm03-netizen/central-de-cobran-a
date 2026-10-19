import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Synthetic names and values only. The real payroll is never a fixture or seed.
const db = new PGlite();
const id = n => `93500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const users = Object.fromEntries(['gerente_geral', 'rh_dp', 'diretor', 'contas_pagar'].map((role, n) => [role, { id: id(n + 1), session: id(n + 11) }]));
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
const owner = () => db.exec('RESET ROLE');
const actor = async (role = 'rh_dp') => {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [users[role].id, JSON.stringify({ session_id: users[role].session })]);
  await db.exec('SET ROLE authenticated');
};
const reject = (fn, code = '42501') => assert.rejects(fn, error => { assert.equal(error.code, code, error.message); return true; });
const legacyRow = (n, changes = {}) => ({ source_row: n + 1, branch: 'EMPRESA SINTÉTICA', employee: `Pessoa sintética ${n}`, sector: 'OPERAÇÃO', admitted_on: '2020-10-10', birthday_on: '2000-10-20', salary_base_cents: 200000, payroll_salary_cents: 170000, transport_cents: null, advance_cents: null, total_cents: null, count_label: null, ...changes });
const row = (n, changes = {}) => ({ ...legacyRow(n), transport_cents: 0, advance_cents: 0, cost_allowance_cents: 0, ...changes });
const preview = (rows, legacy = false) => scalar(`SELECT public.${legacy ? 'preview_hr_import' : 'preview_hr_report_import'}($1,'2026-10-19') AS r`, [JSON.stringify(rows)]);
const report = () => scalar("SELECT public.hr_report('2026-10-01') AS r");
async function commit({ rows = [row(1)], source = 'synthetic-payroll', previous = null, legacy = false, role = 'rh_dp', session = users[role].session, date = '2026-10-19', hash, name = 'folha.csv' } = {}) {
  await owner();
  await db.exec('SET ROLE service_role');
  const bytes = Buffer.from(source);
  return scalar(`SELECT public.${legacy ? 'commit_hr_import_from_gateway' : 'commit_hr_report_import_from_gateway'}($1,$2,$3,$4,$5,$6,$7,$8) AS r`, [users[role].id, session, name, hash ?? createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), date, previous]);
}
let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack ?? error.message, JSON.stringify({ where: error.where, position: error.position })); }
};

try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 34).sort();
  for (const name of names) {
    if (name.startsWith('028_')) await db.exec(`CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;`);
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  for (const [role, u] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [u.id, `${role}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)', [u.id, role]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [u.session, u.id]);
  }
  const oldRows = [legacyRow(1), legacyRow(2, { sector: 'SÓCIO', salary_base_cents: 400000, payroll_salary_cents: 300000 })];
  const original = await commit({ legacy: true, rows: oldRows });
  await owner();
  const oldStored = await scalar('SELECT to_jsonb(h) AS r FROM cf_private.hr_imports h WHERE id=$1', [original.import_id]);
  const auditBefore = await scalar("SELECT count(*)::integer AS r FROM public.audit_events WHERE entity='hr_imports'");
  await db.exec(await readFile(new URL('../supabase/migrations/035_hr_report_model.sql', import.meta.url), 'utf8'));

  await test('035 preserves every old payroll value, source, identity, date and audit event', async () => {
    await owner();
    const now = await scalar('SELECT to_jsonb(h) AS r FROM cf_private.hr_imports h WHERE id=$1', [original.import_id]);
    assert.equal(now.format_version, 1);
    delete now.format_version;
    assert.deepEqual(now, oldStored);
    assert.equal(await scalar("SELECT count(*)::integer AS r FROM public.audit_events WHERE entity='hr_imports'"), auditBefore);
    assert.equal(await scalar("SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version='035_hr_report_model'"), 1);
  });

  await test('old positions remain readable and unknown benefits stay unknown', async () => {
    await actor('diretor');
    const result = await report();
    assert.equal(result.snapshot.format_version, 1);
    assert.equal(result.summary.salary_base_cents, 200000);
    assert.equal(result.summary.payroll_salary_cents, 470000);
    assert.equal(result.summary.cost_allowance_cents, null);
    assert.equal(result.summary.transport_cents, null);
    assert.equal(result.summary.advance_cents, null);
    assert.equal(result.summary.total_cents, null);
    assert.equal(result.quality.missing_cost_allowance, 2);
    assert.equal(result.rows[0].cost_allowance_cents, null);
  });

  let transitional;
  await test('old gateway can operate safely before the new format has been used', async () => {
    await actor();
    const p = await preview([legacyRow(1)], true);
    transitional = await commit({ legacy: true, source: 'legacy-before-v2', rows: [legacyRow(1)], previous: p.previous_import_id });
    assert.equal(transitional.idempotent, false);
  });

  const newRows = [row(1, { cost_allowance_cents: 450000 }), row(2, { sector: 'SÓCIO', salary_base_cents: 400000, payroll_salary_cents: 300000, cost_allowance_cents: 60000 })];
  let enriched;
  await test('same original reimports as enriched revision without rewriting or duplicating the active position', async () => {
    await actor();
    const p = await preview(newRows);
    assert.equal(p.previous_import_id, transitional.import_id);
    assert.equal(p.summary.payroll_salary_cents, 470000);
    assert.equal(p.summary.cost_allowance_cents, 510000);
    enriched = await commit({ rows: newRows, previous: p.previous_import_id });
    assert.notEqual(enriched.import_id, original.import_id);
    await actor();
    const result = await report();
    assert.equal(result.snapshot.id, enriched.import_id);
    assert.equal(result.snapshot.format_version, 2);
    assert.equal(result.rows.length, 2);
    assert.equal(result.summary.salary_base_cents, 200000);
    assert.equal(result.summary.payroll_salary_cents, 470000);
    assert.equal(result.summary.cost_allowance_cents, 510000);
    assert.equal(result.summary.transport_cents, 0);
    assert.equal(result.summary.advance_cents, 0);
    assert.equal(result.summary.total_cents, null);
    assert.equal(result.quality.missing_total, 2);
    assert.equal(result.quality.missing_cost_allowance, 0);
    await owner();
    assert.deepEqual(await scalar('SELECT rows AS r FROM cf_private.hr_imports WHERE id=$1', [original.import_id]), oldRows);
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports WHERE file_sha256=$1', [createHash('sha256').update('synthetic-payroll').digest('hex')]), 2);
    assert.equal(await scalar("SELECT count(*)::integer AS r FROM public.audit_events WHERE entity='hr_imports' AND after_value->>'format_version'='2'"), 1);
  });

  await test('each revision replay is idempotent and mismatched canonical rows are rejected', async () => {
    assert.deepEqual(await commit({ rows: newRows }), { import_id: enriched.import_id, row_count: 2, idempotent: true });
    assert.deepEqual(await commit({ legacy: true, rows: oldRows }), { import_id: original.import_id, row_count: 2, idempotent: true });
    await reject(() => commit({ rows: [row(1)] }), '22023');
    await reject(() => commit({ legacy: true, rows: [legacyRow(1)] }), '22023');
    await actor();
    assert.equal((await report()).snapshot.id, enriched.import_id);
  });

  await test('outdated gateway cannot append an incomplete position after revision 2 is active', async () => {
    await actor();
    const p = await preview([legacyRow(1)], true);
    await reject(() => commit({ legacy: true, rows: [legacyRow(1)], source: 'unsafe-old-new-source', previous: p.previous_import_id }), '40001');
    await actor();
    assert.equal((await report()).snapshot.id, enriched.import_id);
  });

  await test('stale canonical preview cannot overwrite a new full position', async () => {
    await actor();
    const p = await preview([row(1)]);
    const next = await commit({ rows: [row(1)], source: 'next-position', previous: p.previous_import_id });
    await reject(() => commit({ rows: [row(1)], source: 'stale-position', previous: p.previous_import_id }), '40001');
    await actor();
    assert.equal((await report()).snapshot.id, next.import_id);
  });

  await test('missing aid stays unknown while explicit zero remains a known value', async () => {
    await actor();
    const p = await preview([row(1, { cost_allowance_cents: null }), row(2)]);
    assert.equal(p.summary.cost_allowance_cents, null);
    assert.equal(p.quality.missing_cost_allowance, 1);
    const q = await preview([row(1), row(2)]);
    assert.equal(q.summary.cost_allowance_cents, 0);
    assert.equal(q.quality.missing_cost_allowance, 0);
  });

  await test('strict v2 schema and exact aid cents reject malformed or overflowing imports atomically', async () => {
    await owner();
    const before = await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports');
    const invalid = [[], [legacyRow(1)], [row(1, { cost_allowance_cents: '450000' })], [row(1, { cost_allowance_cents: 0.5 })], [row(1, { cost_allowance_cents: 9007199254740992 })], [row(1, { cost_allowance_cents: {} })], [{ ...row(1), protected: true }], [row(1, { employee: '' })], [row(1, { birthday_on: '2026-02-31' })]];
    for (const rows of invalid) await reject(() => commit({ rows, source: 'invalid-v2' }), '22023');
    await reject(() => commit({ rows: [row(1, { cost_allowance_cents: 9007199254740991 }), row(2, { cost_allowance_cents: 1 })], source: 'overflow-v2' }), '22003');
    await owner();
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), before);
  });

  await test('new private validator is not executable by public, browser or service role', async () => {
    await owner();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await scalar('SELECT has_function_privilege($1,$2,$3) AS r', [role, 'cf_private.hr_report_rows(jsonb)', 'EXECUTE']), false);
    }
    await db.exec('SET ROLE service_role');
    await reject(() => db.query('SELECT original_bytes FROM cf_private.hr_imports'));
  });

  await test('new API requires approved module identity and never grants Director import', async () => {
    for (const role of ['diretor', 'contas_pagar']) {
      await actor(role);
      await reject(() => preview([row(1)]));
      await reject(() => commit({ role, source: `denied-${role}` }));
    }
    await owner();
    await db.query("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('diretor','rh_dp','import'),('diretor','rh_dp','write'),('diretor','importar_bases','read') ON CONFLICT DO NOTHING");
    await actor('diretor');
    await reject(() => preview([row(1)]));
    await actor();
    await reject(() => scalar('SELECT public.commit_hr_report_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8) AS r', [users.rh_dp.id, users.rh_dp.session, 'folha.csv', 'a'.repeat(64), 'eA==', JSON.stringify([row(1)]), '2026-10-19', null]));
    await reject(() => commit({ session: id(999) }));
  });

  await test('original hash, dates and private history remain enforced in the new format', async () => {
    await actor();
    const current = (await report()).snapshot.id;
    await reject(() => commit({ source: 'invalid-hash', hash: 'f'.repeat(64) }), '22023');
    await reject(() => commit({ name: '../folha.csv' }), '22023');
    await reject(() => commit({ date: '2199-12-31' }), '22023');
    await owner();
    await reject(() => db.query('UPDATE cf_private.hr_imports SET format_version=1 WHERE id=$1', [current]));
    await reject(() => db.query('UPDATE cf_private.hr_imports SET rows=$1 WHERE id=$2', [JSON.stringify([row(1, { cost_allowance_cents: 1 })]), current]));
    await reject(() => db.query('DELETE FROM cf_private.hr_imports WHERE id=$1', [current]));
    assert.equal(await scalar("SELECT relrowsecurity AS r FROM pg_class WHERE oid='cf_private.hr_imports'::regclass"), true);
  });

  await test('disabled identity and revoked approved session cannot use the new report import', async () => {
    await owner();
    await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1', [users.rh_dp.id]);
    await actor();
    await reject(() => preview([row(1)]));
    await reject(() => commit({ source: 'disabled' }));
    await owner();
    await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1', [users.rh_dp.id]);
    await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)', [users.rh_dp.session, users.rh_dp.id]);
    await actor();
    await reject(report);
    await reject(() => commit({ source: 'revoked' }));
  });
} finally { await db.close(); }
console.log(`${passed} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
