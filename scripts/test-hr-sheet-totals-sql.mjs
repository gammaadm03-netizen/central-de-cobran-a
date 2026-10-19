import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Synthetic people and cents only. No production payroll is included in this fixture.
let db = new PGlite();
const id = n => `93800000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const users = Object.fromEntries(['rh_dp', 'diretor', 'contas_pagar'].map((role, n) => [role, { id: id(n + 1), session: id(n + 11) }]));
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
const owner = () => db.exec('RESET ROLE');
const actor = async (role = 'rh_dp') => {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [users[role].id, JSON.stringify({ session_id: users[role].session })]);
  await db.exec('SET ROLE authenticated');
};
const reject = (fn, code = '42501') => assert.rejects(fn, error => { assert.equal(error.code, code, error.message); return true; });
const row = (n, changes = {}) => ({ source_row: n + 1, branch: 'EMPRESA A SINTÉTICA', employee: `Pessoa sintética ${n}`, sector: 'OPERAÇÃO', admitted_on: '2020-10-10', birthday_on: '2000-10-20', salary_base_cents: 200000, payroll_salary_cents: 170000, transport_cents: 12000, advance_cents: 20000, cost_allowance_cents: 45000, total_cents: 247000, count_label: null, ...changes });
const moneyKeys = ['salary_base_cents', 'payroll_salary_cents', 'transport_cents', 'advance_cents', 'cost_allowance_cents', 'total_cents'];
const footer = rows => Object.fromEntries([['source_row', Math.max(...rows.map(r => r.source_row)) + 1], ...moneyKeys.map(key => [key, rows.some(r => r[key] == null) ? null : rows.reduce((n, r) => n + r[key], 0)])]);
const preview = (rows, totals = null) => scalar("SELECT public.preview_hr_sheet_import($1,'2026-10-19',$2) AS r", [JSON.stringify(rows), totals == null ? null : JSON.stringify(totals)]);
const report = () => scalar("SELECT public.hr_report('2026-10-01') AS r");
async function commit({ rows, totals = null, source = 'synthetic-payroll-sheet', previous = null, role = 'rh_dp', version = 4 } = {}) {
  await owner();
  await db.exec('SET ROLE service_role');
  const bytes = Buffer.from(source);
  const args = [users[role].id, users[role].session, 'folha.csv', createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), '2026-10-19', previous];
  const names = { 1: 'commit_hr_import_from_gateway', 2: 'commit_hr_report_import_from_gateway', 3: 'commit_hr_total_import_from_gateway', 4: 'commit_hr_sheet_import_from_gateway' };
  if (version === 4) args.push(totals == null ? null : JSON.stringify(totals));
  return scalar(`SELECT public.${names[version]}(${args.map((_, n) => `$${n + 1}`).join(',')}) AS r`, args);
}
const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 38).sort();
const sql = await readFile(new URL('../supabase/migrations/038_hr_sheet_totals.sql', import.meta.url), 'utf8');
async function setup(until) {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for (const name of files.filter(name => Number(name.slice(0, 3)) <= until)) {
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
}
let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack ?? error.message, JSON.stringify({ where: error.where, position: error.position })); }
};
try {
  await setup(37);
  const rows = [row(1), row(2, { sector: 'SÓCIO', salary_base_cents: 400000, payroll_salary_cents: 300000, transport_cents: 0, advance_cents: -30000, cost_allowance_cents: 5000, total_cents: 275000 }), row(3, { salary_base_cents: 300000, payroll_salary_cents: 250000, transport_cents: 0, advance_cents: 0, cost_allowance_cents: 0, total_cents: 250000 }), row(4, { sector: 'sócio', salary_base_cents: 100000, payroll_salary_cents: 90000, transport_cents: 0, advance_cents: 1000, cost_allowance_cents: 0, total_cents: 91000 })];
  const totals = footer(rows);
  const old = await commit({ rows, version: 3 });
  await owner();
  const oldBefore = await scalar('SELECT to_jsonb(h) AS r FROM cf_private.hr_imports h WHERE id=$1', [old.import_id]);
  const auditsBefore = await scalar("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS r FROM public.audit_events a WHERE entity='hr_imports'");
  await db.exec(sql);

  await test('existing positions read source TOTAL rather than adding gross and net remuneration', async () => {
    await actor('diretor');
    const r = await report();
    assert.equal(r.summary.salary_base_all_cents, 1000000);
    assert.equal(r.summary.salary_base_cents, 500000);
    assert.equal(r.summary.prolabore_base_cents, 500000);
    assert.equal(r.summary.payroll_salary_employees_cents, 420000);
    assert.equal(r.summary.prolabore_received_cents, 390000);
    assert.equal(r.summary.employee_total_cents, 497000);
    assert.equal(r.summary.partner_total_cents, 366000);
    assert.equal(r.summary.total_cents, 863000);
    assert.equal(r.summary.reported_total_cents, 863000);
    assert.equal(r.summary.total_formula_version, 'rh-reported-total-v1');
    assert.equal(r.total_formula_caption, 'Total informado na coluna TOTAL do relatório');
    assert.equal(r.report_totals, null);
    for (let i = 0; i < rows.length; i++) {
      assert.equal(r.rows[i].total_cents, rows[i].total_cents);
      assert.equal(r.rows[i].reported_total_cents, rows[i].total_cents);
    }
    for (const calendar of [r.birthdays, r.work_anniversaries]) for (const entry of calendar) assert.equal(entry.total_cents, rows.find(s => s.source_row === entry.source_row).total_cents);
  });

  await test('migration preserves old snapshots, original bytes and audit and can be reapplied', async () => {
    await owner();
    await db.exec(sql);
    const after = await scalar('SELECT to_jsonb(h)-\'report_totals\' AS r FROM cf_private.hr_imports h WHERE id=$1', [old.import_id]);
    assert.deepEqual(after, oldBefore);
    assert.deepEqual(await scalar("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS r FROM public.audit_events a WHERE entity='hr_imports'"), auditsBefore);
    assert.equal(await scalar("SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version='038_hr_sheet_totals'"), 1);
  });

  await test('footer is separate from people and preview matches the reported gross and total amounts', async () => {
    await actor();
    const p = await preview(rows, totals);
    assert.equal(p.row_count, 4);
    assert.equal(p.summary.employees, 2);
    assert.equal(p.summary.partners, 2);
    assert.equal(p.summary.salary_base_all_cents, totals.salary_base_cents);
    assert.equal(p.summary.total_cents, totals.total_cents);
    assert.deepEqual(p.report_totals, totals);
    assert.deepEqual(p.summary.report_totals, totals);
    assert.equal(p.previous_import_id, old.import_id);
    assert.equal(p.rows.length, 4);
    assert.equal(p.quality.missing_total, 0);
  });

  await test('every known footer amount is reconciled exactly and unknown footer fields are allowed', async () => {
    await actor();
    for (const key of moneyKeys) {
      await reject(() => preview(rows, { ...totals, [key]: totals[key] + 1 }), '22023');
      assert.equal((await preview(rows, { ...totals, [key]: null })).summary.total_cents, 863000);
      const missing = rows.map((r, n) => n ? r : { ...r, [key]: null });
      await reject(() => preview(missing, totals), '22023');
      const p = await preview(missing, { ...totals, [key]: null });
      if (key === 'total_cents') assert.equal(p.summary.total_cents, null);
    }
  });

  await test('footer schema refuses extra keys, absent keys, strings, decimals, unsafe cents and invalid source rows', async () => {
    await actor();
    const noKey = { ...totals }; delete noKey.total_cents;
    for (const bad of [[], 'total', { ...totals, extra: 1 }, noKey, { ...totals, total_cents: '863000' }, { ...totals, total_cents: 1.2 }, { ...totals, total_cents: 9007199254740992 }, { ...totals, source_row: 5 }, { ...totals, source_row: 1 }, { ...totals, source_row: 5022 }, { ...totals, source_row: '6' }, { ...totals, source_row: 6.1 }]) await reject(() => preview(rows, bad), '22023');
  });

  await test('unknown source TOTAL remains unknown even when all five other fields are known', async () => {
    await actor();
    const p = await preview([row(1, { total_cents: null }), rows[1]]);
    assert.equal(p.summary.total_cents, null);
    assert.equal(p.summary.employee_total_cents, null);
    assert.equal(p.summary.partner_total_cents, 275000);
    assert.equal(p.quality.missing_total, 1);
    assert.equal(p.rows[0].total_cents, null);
    assert.equal(p.summary.report_totals, null);
  });

  await test('the obsolete five-field precision fence cannot reject a safe source TOTAL', async () => {
    await actor();
    const safe = row(1, { salary_base_cents: 9007199254740991, payroll_salary_cents: 9007199254740991, transport_cents: 0, advance_cents: 0, cost_allowance_cents: 0, total_cents: 1 });
    const p = await preview([safe], footer([safe]));
    assert.equal(p.summary.total_cents, 1);
    assert.equal(p.summary.salary_base_all_cents, 9007199254740991);
    await reject(() => preview([row(1, { total_cents: 9007199254740991 }), row(2, { total_cents: -9007199254740991 })]), '22003');
  });

  let current;
  await test('reimporting the same original creates a format4 revision with footer and preserves format3', async () => {
    current = await commit({ rows, totals, previous: old.import_id });
    assert.equal(current.idempotent, false);
    assert.notEqual(current.import_id, old.import_id);
    await owner();
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), 2);
    assert.deepEqual(await scalar('SELECT to_jsonb(h)-\'report_totals\' AS r FROM cf_private.hr_imports h WHERE id=$1', [old.import_id]), oldBefore);
    const stored = await scalar('SELECT jsonb_build_object(\'rows\',rows,\'report_totals\',report_totals,\'format_version\',format_version) AS r FROM cf_private.hr_imports WHERE id=$1', [current.import_id]);
    assert.deepEqual(stored, { rows, report_totals: totals, format_version: 4 });
    await actor('diretor');
    const r = await report();
    assert.equal(r.snapshot.id, current.import_id);
    assert.deepEqual(r.report_totals, totals);
    assert.equal(r.summary.total_cents, totals.total_cents);
  });

  await test('format4 replay is idempotent and detects changed canonical rows or footer for the same original', async () => {
    await owner();
    const countBefore = await scalar("SELECT count(*)::integer AS r FROM public.audit_events WHERE entity='hr_imports'");
    assert.deepEqual(await commit({ rows, totals }), { ...current, idempotent: true });
    await reject(() => commit({ rows: rows.map((r, n) => n ? r : { ...r, employee: 'Outra pessoa sintética' }), totals }), '22023');
    await reject(() => commit({ rows, totals: null }), '22023');
    await owner();
    assert.equal(await scalar("SELECT count(*)::integer AS r FROM public.audit_events WHERE entity='hr_imports'"), countBefore);
  });

  await test('format4 rejects stale preview, permits a fresh next original, and audits footer', async () => {
    await reject(() => commit({ rows, totals, source: 'new-source-stale', previous: old.import_id }), '40001');
    const next = await commit({ rows, totals, source: 'new-source-fresh', previous: current.import_id });
    assert.equal(next.idempotent, false);
    await owner();
    const audit = await scalar("SELECT after_value AS r FROM public.audit_events WHERE entity='hr_imports' AND record_id=$1", [next.import_id]);
    assert.equal(audit.format_version, 4);
    assert.deepEqual(audit.report_totals, totals);
    current = next;
  });

  await test('format3 replay stays harmless, while new obsolete writes are fenced after format4', async () => {
    assert.deepEqual(await commit({ rows, version: 3 }), { ...old, idempotent: true });
    for (const version of [1, 2, 3]) {
      const prepared = version === 1 ? rows.map(({ cost_allowance_cents, ...r }) => r) : rows;
      await reject(() => commit({ rows: prepared, version, source: `old-writer-${version}`, previous: current.import_id }), '40001');
    }
  });

  await test('rows, footer and file remain immutable, and table checks reject forged footer metadata', async () => {
    await owner();
    await reject(() => db.query('UPDATE cf_private.hr_imports SET report_totals=NULL WHERE id=$1', [current.import_id]));
    await reject(() => db.query('DELETE FROM cf_private.hr_imports WHERE id=$1', [current.import_id]));
    const bytes = Buffer.from('invalid-footer-direct');
    await reject(() => db.query('INSERT INTO cf_private.hr_imports(reference_date,file_name,file_sha256,original_bytes,rows,row_count,created_by,format_version,report_totals) VALUES($1,$2,$3,$4,$5,$6,$7,4,$8)', ['2026-10-19', 'folha.csv', createHash('sha256').update(bytes).digest('hex'), bytes, JSON.stringify(rows), rows.length, users.rh_dp.id, JSON.stringify({ ...totals, total_cents: 1 })]), '22023');
  });

  await test('private payroll boundaries and director read-only remain enforced', async () => {
    await owner();
    for (const role of ['anon', 'authenticated', 'service_role']) for (const signature of ['cf_private.hr_sheet_totals(jsonb,jsonb)', 'cf_private.hr_sheet_statistics(jsonb,date,jsonb)', 'cf_private.hr_statistics(jsonb,date)']) assert.equal(await scalar('SELECT has_function_privilege($1,$2,$3) AS r', [role, signature, 'EXECUTE']), false);
    await db.exec('SET ROLE service_role');
    await reject(() => db.query('SELECT report_totals,rows,original_bytes FROM cf_private.hr_imports'));
    await actor('contas_pagar');
    await reject(report);
    await reject(() => preview(rows, totals));
    await actor('diretor');
    assert.equal((await report()).summary.total_cents, 863000);
    await reject(() => preview(rows, totals));
    await reject(() => commit({ role: 'diretor', rows, totals, source: 'director-denied' }));
    await owner(); await db.exec('SET ROLE anon');
    await reject(report);
    await reject(() => preview(rows, totals));
    await actor();
    await reject(() => scalar('SELECT public.commit_hr_sheet_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r', [users.rh_dp.id, users.rh_dp.session, 'folha.csv', '0'.repeat(64), 'c3ludGhldGlj', JSON.stringify(rows), '2026-10-19', current.import_id, JSON.stringify(totals)]));
  });

  await test('a fresh format4-only database fences all three obsolete import formats', async () => {
    await db.close(); db = new PGlite(); await setup(38);
    const first = await commit({ rows, totals });
    await owner();
    assert.deepEqual(await scalar('SELECT jsonb_agg(DISTINCT format_version) AS r FROM cf_private.hr_imports'), [4]);
    for (const version of [1, 2, 3]) {
      const prepared = version === 1 ? rows.map(({ cost_allowance_cents, ...r }) => r) : rows;
      await reject(() => commit({ rows: prepared, version, source: `fresh-old-writer-${version}`, previous: first.import_id }), '40001');
    }
    await owner(); assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), 1);
  });
} finally { await db.close(); }
console.log(`${passed} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
