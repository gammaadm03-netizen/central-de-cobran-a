import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Only synthetic people, source files and amounts belong in payroll tests.
const db = new PGlite();
const id = n => `93600000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const users = Object.fromEntries(['gerente_geral', 'rh_dp', 'diretor', 'contas_pagar'].map((role, n) => [role, { id: id(n + 1), session: id(n + 11) }]));
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
const owner = () => db.exec('RESET ROLE');
const actor = async (role = 'rh_dp') => {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [users[role].id, JSON.stringify({ session_id: users[role].session })]);
  await db.exec('SET ROLE authenticated');
};
const reject = (fn, code = '42501') => assert.rejects(fn, error => { assert.equal(error.code, code, error.message); return true; });
const row = (n, changes = {}) => ({ source_row: n + 1, branch: 'EMPRESA SINTÉTICA', employee: `Pessoa sintética ${n}`, sector: 'OPERAÇÃO', admitted_on: '2020-10-10', birthday_on: '2000-10-20', salary_base_cents: 200000, payroll_salary_cents: 170000, transport_cents: 12000, advance_cents: 20000, cost_allowance_cents: 45000, total_cents: null, count_label: null, ...changes });
const preview = (rows, legacy = false) => scalar(`SELECT public.${legacy ? 'preview_hr_import' : 'preview_hr_total_import'}($1,'2026-10-19') AS r`, [JSON.stringify(rows)]);
const report = () => scalar("SELECT public.hr_report('2026-10-01') AS r");
async function commit({ rows, source = 'synthetic-payroll', previous = null, role = 'rh_dp', session = users[role].session, version = 3 } = {}) {
  await owner();
  await db.exec('SET ROLE service_role');
  const bytes = Buffer.from(source);
  const functionName = version === 1 ? 'commit_hr_import_from_gateway' : version === 2 ? 'commit_hr_report_import_from_gateway' : 'commit_hr_total_import_from_gateway';
  return scalar(`SELECT public.${functionName}($1,$2,$3,$4,$5,$6,$7,$8) AS r`, [users[role].id, session, 'folha.csv', createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), '2026-10-19', previous]);
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
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 35).sort();
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
  const originalRows = [row(1, { total_cents: 111 }), row(2, { sector: 'SÓCIO', salary_base_cents: 400000, payroll_salary_cents: 300000, transport_cents: 0, advance_cents: -30000, cost_allowance_cents: 5000, total_cents: 222 })];
  const original = await commit({ rows: originalRows, version: 2 });
  await owner();
  const storedBefore = await scalar('SELECT to_jsonb(h) AS r FROM cf_private.hr_imports h WHERE id=$1', [original.import_id]);
  const auditBefore = await scalar("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS r FROM public.audit_events a WHERE entity='hr_imports'");
  await db.exec(await readFile(new URL('../supabase/migrations/036_hr_total.sql', import.meta.url), 'utf8'));

  await test('036 recalculates existing reports without rewriting original rows, files, history or audit', async () => {
    await owner();
    assert.deepEqual(await scalar('SELECT to_jsonb(h) AS r FROM cf_private.hr_imports h WHERE id=$1', [original.import_id]), storedBefore);
    assert.deepEqual(await scalar("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS r FROM public.audit_events a WHERE entity='hr_imports'"), auditBefore);
    assert.equal(await scalar("SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version='036_hr_total'"), 1);
    await actor('diretor');
    const r = await report();
    assert.equal(r.snapshot.id, original.import_id);
    assert.equal(r.snapshot.format_version, 2);
    assert.equal(r.rows[0].total_cents, 447000);
    assert.equal(r.rows[1].total_cents, 675000);
    assert.equal(r.rows[0].reported_total_cents, 111);
    assert.equal(r.rows[1].reported_total_cents, 222);
    assert.equal(r.summary.reported_total_cents, 333);
    assert.equal(r.summary.total_cents, 1122000);
    assert.equal(r.quality.missing_total, 0);
  });

  await test('both salaries enter total, while employee payroll card excludes partners', async () => {
    await actor('diretor');
    const r = await report();
    assert.equal(r.summary.salary_base_cents, 200000);
    assert.equal(r.summary.salary_base_all_cents, 600000);
    assert.equal(r.summary.payroll_salary_cents, 470000);
    assert.equal(r.summary.payroll_salary_employees_cents, 170000);
    assert.equal(r.summary.transport_cents, 12000);
    assert.equal(r.summary.advance_cents, -10000);
    assert.equal(r.summary.cost_allowance_cents, 50000);
    assert.equal(r.total_formula_version, 'rh-five-fields-v1');
    assert.equal(r.summary.total_formula_version, r.total_formula_version);
    assert.equal(r.summary.total_formula_caption, 'Total = Salário Base + VT total + Salário recebido + Adiantamento + Ajuda de Custo');
  });

  await test('preview and report use the same exact policy and preserve ordinary source columns', async () => {
    await actor();
    const p = await preview(originalRows);
    const r = await report();
    assert.deepEqual(p.summary, r.summary);
    assert.deepEqual(p.quality, r.quality);
    assert.deepEqual(p.rows, r.rows);
    assert.equal(p.rows[0].total_cents, 447000);
    assert.equal(p.rows[0].reported_total_cents, 111);
    assert.equal(p.rows[1].total_cents, 675000);
    assert.equal(p.rows[1].reported_total_cents, 222);
    assert.equal(p.previous_import_id, original.import_id);
    for (let i = 0; i < originalRows.length; i++) {
      for (const [key, value] of Object.entries(originalRows[i])) {
        if (key !== 'total_cents') assert.deepEqual(r.rows[i][key], value, key);
      }
    }
  });

  await test('the same v2 original replays idempotently after derived totals change', async () => {
    assert.deepEqual(await commit({ rows: originalRows, version: 2 }), { import_id: original.import_id, row_count: 2, idempotent: true });
    await owner();
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), 1);
    assert.deepEqual(await scalar('SELECT rows AS r FROM cf_private.hr_imports WHERE id=$1', [original.import_id]), originalRows);
    await reject(() => db.query('UPDATE cf_private.hr_imports SET rows=$1 WHERE id=$2', [JSON.stringify([row(1)]), original.import_id]));
    await reject(() => db.query('DELETE FROM cf_private.hr_imports WHERE id=$1', [original.import_id]));
  });

  await test('a missing original TOTAL does not hide the sum of the five known inputs', async () => {
    await actor();
    const p = await preview([row(1)]);
    assert.equal(p.summary.total_cents, 447000);
    assert.equal(p.summary.reported_total_cents, null);
    assert.equal(p.rows[0].total_cents, 447000);
    assert.equal(p.rows[0].reported_total_cents, null);
    assert.equal(p.quality.missing_total, 0);
  });

  await test('unknown components stay pending even with a supplied source TOTAL', async () => {
    await actor();
    for (const key of ['salary_base_cents', 'payroll_salary_cents', 'transport_cents', 'advance_cents', 'cost_allowance_cents']) {
      const p = await preview([row(1, { [key]: null, total_cents: 999999 })]);
      assert.equal(p.summary.total_cents, null, key);
      assert.equal(p.summary.reported_total_cents, 999999);
      assert.equal(p.quality.missing_total, 1, key);
    }
    const legacy = row(1, { total_cents: 999999 });
    delete legacy.cost_allowance_cents;
    const p = await preview([legacy], true);
    assert.equal(p.summary.total_cents, null);
    assert.equal(p.quality.missing_cost_allowance, 1);
    assert.equal(p.quality.missing_total, 1);
    const employeeMissing = await preview([row(1, { payroll_salary_cents: null }), row(2, { sector: 'SÓCIO' })]);
    assert.equal(employeeMissing.summary.payroll_salary_employees_cents, null);
    const partnerMissing = await preview([row(1), row(2, { sector: 'SÓCIO', payroll_salary_cents: null })]);
    assert.equal(partnerMissing.summary.payroll_salary_employees_cents, 170000);
    assert.equal(partnerMissing.summary.payroll_salary_cents, null);
  });

  await test('empty data stays empty with exact zero totals and no invented payroll', async () => {
    await owner();
    const r = await scalar("SELECT cf_private.hr_statistics('[]','2026-10-01') AS r");
    assert.deepEqual(r.rows, []);
    for (const key of ['salary_base_cents', 'salary_base_all_cents', 'payroll_salary_cents', 'payroll_salary_employees_cents', 'transport_cents', 'advance_cents', 'cost_allowance_cents', 'total_cents']) assert.equal(r.summary[key], 0, key);
    assert.equal(r.summary.employees, 0);
    assert.equal(r.summary.partners, 0);
    assert.equal(r.quality.missing_total, 0);
  });

  await test('signed integer cents remain exact and row or absolute aggregate overflow is refused', async () => {
    await actor();
    const signed = await preview([row(1, { salary_base_cents: 1, payroll_salary_cents: -2, transport_cents: 3, advance_cents: -4, cost_allowance_cents: 5 })]);
    assert.equal(signed.summary.total_cents, 3);
    const max = 9007199254740991;
    const atLimit = row(1, { salary_base_cents: max - 4, payroll_salary_cents: 1, transport_cents: 1, advance_cents: 1, cost_allowance_cents: 1 });
    assert.equal((await preview([atLimit])).summary.total_cents, max);
    await reject(() => preview([row(1, { ...atLimit, salary_base_cents: max - 3 })]), '22003');
    const positive = row(1, { salary_base_cents: max, payroll_salary_cents: 0, transport_cents: 0, advance_cents: 0, cost_allowance_cents: 0 });
    const negative = row(2, { salary_base_cents: 0, payroll_salary_cents: -max, transport_cents: 0, advance_cents: 0, cost_allowance_cents: 0 });
    await reject(() => preview([positive, negative]), '22003');
    await owner();
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), 1);
  });

  let corrected;
  const correctedRows = [row(1, { salary_base_cents: 210000, payroll_salary_cents: 160000, total_cents: 111 }), originalRows[1]];
  await test('format 3 safely reimports the same original with corrected salary bindings', async () => {
    await actor();
    const p = await preview(correctedRows);
    corrected = await commit({ rows: correctedRows, previous: p.previous_import_id });
    assert.notEqual(corrected.import_id, original.import_id);
    await actor('diretor');
    const r = await report();
    assert.equal(r.snapshot.id, corrected.import_id);
    assert.equal(r.snapshot.format_version, 3);
    assert.equal(r.summary.salary_base_cents, 210000);
    assert.equal(r.summary.payroll_salary_cents, 460000);
    assert.equal(r.summary.total_cents, 1122000);
    assert.equal(r.rows[0].reported_total_cents, 111);
    await owner();
    assert.deepEqual(await scalar('SELECT to_jsonb(h) AS r FROM cf_private.hr_imports h WHERE id=$1', [original.import_id]), storedBefore);
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), 2);
    assert.equal(await scalar("SELECT count(*)::integer AS r FROM public.audit_events WHERE entity='hr_imports' AND after_value->>'format_version'='3'"), 1);
  });

  await test('format 3 replays are exact and superseded gateways cannot append new snapshots', async () => {
    assert.deepEqual(await commit({ rows: correctedRows }), { import_id: corrected.import_id, row_count: 2, idempotent: true });
    assert.deepEqual(await commit({ rows: originalRows, version: 2 }), { import_id: original.import_id, row_count: 2, idempotent: true });
    await reject(() => commit({ rows: originalRows }), '22023');
    await reject(() => commit({ rows: originalRows, source: 'outdated-v2', previous: corrected.import_id, version: 2 }), '40001');
    const legacy = row(1);
    delete legacy.cost_allowance_cents;
    await reject(() => commit({ rows: [legacy], source: 'outdated-v1', previous: corrected.import_id, version: 1 }), '40001');
    await actor();
    assert.equal((await report()).snapshot.id, corrected.import_id);
    await owner();
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), 2);
  });

  await test('format 3 commit keeps its preview fence and validates source and exact cents atomically', async () => {
    await reject(() => commit({ rows: [row(1)], source: 'stale-v3', previous: original.import_id }), '40001');
    await reject(() => commit({ rows: [row(1, { cost_allowance_cents: 0.5 })], source: 'invalid-v3', previous: corrected.import_id }), '22023');
    await actor();
    const tooLarge = row(1, { salary_base_cents: 9007199254740991, payroll_salary_cents: 1, transport_cents: 0, advance_cents: 0, cost_allowance_cents: 0 });
    await reject(() => commit({ rows: [tooLarge], source: 'overflow-v3', previous: corrected.import_id }), '22003');
    await owner();
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), 2);
  });

  await test('the private statistics function and original rows remain unavailable to browser and service roles', async () => {
    await owner();
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar('SELECT has_function_privilege($1,$2,$3) AS r', [role, 'cf_private.hr_statistics(jsonb,date)', 'EXECUTE']), false);
    assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.commit_hr_total_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid)','EXECUTE') AS r"), false);
    assert.equal(await scalar("SELECT has_function_privilege('anon','public.preview_hr_total_import(jsonb,date)','EXECUTE') AS r"), false);
    await db.exec('SET ROLE service_role');
    await reject(() => db.query('SELECT rows,original_bytes FROM cf_private.hr_imports'));
    await actor('contas_pagar');
    await reject(report);
    await reject(() => preview([row(1)]));
    await actor('diretor');
    assert.equal((await report()).summary.total_cents, 1122000);
    await reject(() => preview([row(1)]));
    await reject(() => commit({ role: 'diretor', rows: [row(1)], source: 'denied-director' }));
  });

  await test('disabled users and revoked approved sessions cannot access the newly derived totals', async () => {
    await owner();
    await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1', [users.rh_dp.id]);
    await actor();
    await reject(report);
    await reject(() => preview([row(1)]));
    await owner();
    await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1', [users.rh_dp.id]);
    await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)', [users.rh_dp.session, users.rh_dp.id]);
    await actor();
    await reject(report);
    await reject(() => commit({ rows: [row(1)], source: 'revoked' }));
  });
} finally { await db.close(); }
console.log(`${passed} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
