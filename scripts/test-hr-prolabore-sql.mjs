import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Synthetic people, amounts and source bytes only; no production payroll.
const db = new PGlite();
const id = n => `93700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const users = Object.fromEntries(['rh_dp', 'diretor', 'contas_pagar'].map((role, n) => [role, { id: id(n + 1), session: id(n + 11) }]));
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
const owner = () => db.exec('RESET ROLE');
const actor = async (role = 'rh_dp') => {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [users[role].id, JSON.stringify({ session_id: users[role].session })]);
  await db.exec('SET ROLE authenticated');
};
const reject = (fn, code = '42501') => assert.rejects(fn, error => { assert.equal(error.code, code, error.message); return true; });
const row = (n, changes = {}) => ({ source_row: n + 1, branch: 'EMPRESA A SINTÉTICA', employee: `Pessoa sintética ${n}`, sector: 'OPERAÇÃO', admitted_on: '2020-10-10', birthday_on: '2000-10-20', salary_base_cents: 200000, payroll_salary_cents: 170000, transport_cents: 12000, advance_cents: 20000, cost_allowance_cents: 45000, total_cents: null, count_label: null, ...changes });
const preview = rows => scalar("SELECT public.preview_hr_total_import($1,'2026-10-19') AS r", [JSON.stringify(rows)]);
const report = () => scalar("SELECT public.hr_report('2026-10-01') AS r");
const stats = async rows => {
  await owner();
  return scalar("SELECT cf_private.hr_statistics($1,'2026-10-01') AS r", [JSON.stringify(rows)]);
};
async function commit({ rows, source = 'synthetic-payroll-prolabore', previous = null, role = 'rh_dp' } = {}) {
  await owner();
  await db.exec('SET ROLE service_role');
  const bytes = Buffer.from(source);
  return scalar('SELECT public.commit_hr_total_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8) AS r', [users[role].id, users[role].session, 'folha.csv', createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), '2026-10-19', previous]);
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
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 36).sort();
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
  const sourceRows = [
    row(1, { total_cents: 111 }),
    row(2, { sector: 'SÓCIO', salary_base_cents: 400000, payroll_salary_cents: 300000, transport_cents: 0, advance_cents: -30000, cost_allowance_cents: 5000, total_cents: 222 }),
    row(3, { branch: 'EMPRESA B SINTÉTICA', salary_base_cents: 300000, payroll_salary_cents: 250000, transport_cents: 0, advance_cents: 0, cost_allowance_cents: 0, total_cents: 333 }),
    row(4, { branch: 'EMPRESA B SINTÉTICA', sector: 'sócio', salary_base_cents: 100000, payroll_salary_cents: 90000, transport_cents: 0, advance_cents: 1000, cost_allowance_cents: 0, total_cents: 444 }),
  ];
  const original = await commit({ rows: sourceRows });
  await owner();
  const originalBefore = await scalar('SELECT to_jsonb(h) AS r FROM cf_private.hr_imports h WHERE id=$1', [original.import_id]);
  const auditBefore = await scalar("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS r FROM public.audit_events a WHERE entity='hr_imports'");
  const sql = await readFile(new URL('../supabase/migrations/037_hr_prolabore.sql', import.meta.url), 'utf8');
  await db.exec(sql);

  await test('037 separates both salary components from both pro-labore components without changing the five-field total', async () => {
    await actor('diretor');
    const r = await report();
    assert.equal(r.summary.salary_base_cents, 500000);
    assert.equal(r.summary.payroll_salary_employees_cents, 420000);
    assert.equal(r.summary.prolabore_base_cents, 500000);
    assert.equal(r.summary.prolabore_received_cents, 390000);
    assert.equal(r.summary.employee_total_cents, 997000);
    assert.equal(r.summary.partner_total_cents, 866000);
    assert.equal(r.summary.total_cents, 1863000);
    assert.equal(r.summary.total_cents, r.summary.employee_total_cents + r.summary.partner_total_cents);
    assert.equal(r.summary.salary_base_all_cents, 1000000);
    assert.equal(r.summary.payroll_salary_cents, 810000);
    assert.equal(r.summary.reported_total_cents, 1110);
    assert.equal(r.summary.employees, 2);
    assert.equal(r.summary.partners, 2);
    assert.equal(r.compensation_groups_version, 'rh-compensation-groups-v1');
    assert.equal(r.summary.compensation_groups_version, r.compensation_groups_version);
    assert.equal(r.total_formula_version, 'rh-five-fields-v1');
    assert.equal(r.total_formula_caption, 'Total = remuneração sem descontos + VT total + remuneração recebida + Adiantamento + Ajuda de Custo');
    assert.equal(r.summary.total_formula_caption, r.total_formula_caption);
  });

  await test('new projections preserve original rows, original file, import versions and audit; reapplying is safe', async () => {
    await owner();
    await db.exec(sql);
    assert.deepEqual(await scalar('SELECT to_jsonb(h) AS r FROM cf_private.hr_imports h WHERE id=$1', [original.import_id]), originalBefore);
    assert.deepEqual(await scalar("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS r FROM public.audit_events a WHERE entity='hr_imports'"), auditBefore);
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), 1);
    assert.equal(await scalar("SELECT count(*)::integer AS r FROM public.central_schema_migrations WHERE version='037_hr_prolabore'"), 1);
    assert.deepEqual(await commit({ rows: sourceRows }), { import_id: original.import_id, row_count: 4, idempotent: true });
    await owner();
    assert.deepEqual(await scalar("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS r FROM public.audit_events a WHERE entity='hr_imports'"), auditBefore);
    await reject(() => db.query('UPDATE cf_private.hr_imports SET rows=$1 WHERE id=$2', [JSON.stringify([row(1)]), original.import_id]));
    await reject(() => db.query('DELETE FROM cf_private.hr_imports WHERE id=$1', [original.import_id]));
  });

  await test('preview uses the same classification and amounts as the report and retains source columns', async () => {
    await actor();
    const p = await preview(sourceRows);
    const r = await report();
    assert.deepEqual(p.summary, r.summary);
    assert.deepEqual(p.quality, r.quality);
    assert.deepEqual(p.rows, r.rows);
    assert.equal(p.previous_import_id, original.import_id);
    for (let i = 0; i < sourceRows.length; i++) {
      for (const [key, value] of Object.entries(sourceRows[i])) if (key !== 'total_cents') assert.deepEqual(r.rows[i][key], value, key);
      assert.equal(r.rows[i].reported_total_cents, sourceRows[i].total_cents);
      assert.equal(r.rows[i].compensation_kind, i === 1 || i === 3 ? 'prolabore' : 'salary');
    }
  });

  await test('branch and sector summaries keep people counts and split salary from pro-labore', async () => {
    await actor();
    const r = await report();
    assert.deepEqual(r.by_branch, [
      { label: 'EMPRESA A SINTÉTICA', count: 2, employee_count: 1, partner_count: 1, salary_base_cents: 200000, prolabore_base_cents: 400000 },
      { label: 'EMPRESA B SINTÉTICA', count: 2, employee_count: 1, partner_count: 1, salary_base_cents: 300000, prolabore_base_cents: 100000 },
    ]);
    const employees = r.by_sector.find(g => g.label === 'OPERAÇÃO');
    assert.deepEqual(employees, { label: 'OPERAÇÃO', count: 2, employee_count: 2, partner_count: 0, salary_base_cents: 500000, prolabore_base_cents: 0 });
    for (const group of r.by_sector.filter(g => g.label !== 'OPERAÇÃO')) {
      assert.equal(group.employee_count, 0);
      assert.equal(group.partner_count, 1);
      assert.equal(group.salary_base_cents, 0);
      assert.ok(group.prolabore_base_cents > 0);
    }
    for (const group of [...r.by_branch, ...r.by_sector]) assert.equal(group.count, group.employee_count + group.partner_count);
  });

  await test('birthday and company-anniversary detail preserves the same salary/pro-labore classification', async () => {
    await actor();
    const r = await report();
    for (const list of [r.birthdays, r.work_anniversaries]) {
      assert.equal(list.length, 4);
      for (const entry of list) {
        const source = r.rows.find(item => item.source_row === entry.source_row);
        assert.equal(entry.compensation_kind, source.compensation_kind);
        assert.equal(entry.total_cents, source.total_cents);
        assert.equal(entry.reported_total_cents, source.reported_total_cents);
      }
    }
  });

  await test('unknown employee amounts do not invalidate known pro-labore amounts or totals', async () => {
    await actor();
    for (const field of ['salary_base_cents', 'payroll_salary_cents', 'transport_cents', 'advance_cents', 'cost_allowance_cents']) {
      const p = await preview([row(1, { [field]: null }), sourceRows[1]]);
      assert.equal(p.summary.employee_total_cents, null, field);
      assert.equal(p.summary.partner_total_cents, 675000, field);
      assert.equal(p.summary.prolabore_base_cents, 400000, field);
      assert.equal(p.summary.prolabore_received_cents, 300000, field);
      assert.equal(p.summary.total_cents, null, field);
    }
    const s = await stats([row(1, { salary_base_cents: null }), sourceRows[1]]);
    assert.equal(s.by_branch[0].salary_base_cents, null);
    assert.equal(s.by_branch[0].prolabore_base_cents, 400000);
  });

  await test('unknown partner amounts do not invalidate known salaries or totals', async () => {
    await actor();
    for (const field of ['salary_base_cents', 'payroll_salary_cents', 'transport_cents', 'advance_cents', 'cost_allowance_cents']) {
      const p = await preview([row(1), { ...sourceRows[1], [field]: null }]);
      assert.equal(p.summary.partner_total_cents, null, field);
      assert.equal(p.summary.employee_total_cents, 447000, field);
      assert.equal(p.summary.salary_base_cents, 200000, field);
      assert.equal(p.summary.payroll_salary_employees_cents, 170000, field);
      assert.equal(p.summary.total_cents, null, field);
    }
    const s = await stats([row(1), { ...sourceRows[1], salary_base_cents: null }]);
    assert.equal(s.by_branch[0].salary_base_cents, 200000);
    assert.equal(s.by_branch[0].prolabore_base_cents, null);
  });

  await test('all-employee, all-partner and empty sources return zero for absent compensation groups', async () => {
    for (const [rows, absent, total] of [
      [[row(1)], ['prolabore_base_cents', 'prolabore_received_cents', 'partner_total_cents'], 447000],
      [[sourceRows[1]], ['salary_base_cents', 'payroll_salary_employees_cents', 'employee_total_cents'], 675000],
      [[], ['salary_base_cents', 'payroll_salary_employees_cents', 'employee_total_cents', 'prolabore_base_cents', 'prolabore_received_cents', 'partner_total_cents'], 0],
    ]) {
      const s = await stats(rows);
      for (const key of absent) assert.equal(s.summary[key], 0, key);
      assert.equal(s.summary.total_cents, total);
      if (!rows.length) assert.deepEqual(s.by_branch, []);
    }
    const s = await stats([row(1, { employee: 'Pessoa Socio sintética', sector: 'OPERAÇÃO' })]);
    assert.equal(s.rows[0].compensation_kind, 'salary');
    assert.equal(s.summary.partners, 0);
  });

  await test('signed cents stay exact in their own group and the existing precision fence stays active', async () => {
    await actor();
    const p = await preview([
      row(1, { salary_base_cents: 1, payroll_salary_cents: -2, transport_cents: 3, advance_cents: -4, cost_allowance_cents: 5 }),
      row(2, { sector: 'SÓCIO', salary_base_cents: 6, payroll_salary_cents: -7, transport_cents: -8, advance_cents: 9, cost_allowance_cents: -10 }),
    ]);
    assert.equal(p.summary.employee_total_cents, 3);
    assert.equal(p.summary.partner_total_cents, -10);
    assert.equal(p.summary.total_cents, -7);
    assert.equal(p.summary.prolabore_base_cents, 6);
    assert.equal(p.summary.prolabore_received_cents, -7);
    await reject(() => preview([row(1, { salary_base_cents: 9007199254740991, payroll_salary_cents: 1, transport_cents: 0, advance_cents: 0, cost_allowance_cents: 0 })]), '22003');
  });

  await test('new payroll projections retain private data boundaries and director read-only permissions', async () => {
    await owner();
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar('SELECT has_function_privilege($1,$2,$3) AS r', [role, 'cf_private.hr_statistics(jsonb,date)', 'EXECUTE']), false);
    await db.exec('SET ROLE service_role');
    await reject(() => db.query('SELECT rows,original_bytes FROM cf_private.hr_imports'));
    await actor('contas_pagar');
    await reject(report);
    await reject(() => preview([row(1)]));
    await actor('diretor');
    assert.equal((await report()).summary.prolabore_received_cents, 390000);
    await reject(() => preview([row(1)]));
    await reject(() => commit({ role: 'diretor', rows: [row(1)], source: 'denied-director' }));
    await owner();
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'), 1);
    assert.deepEqual(await scalar('SELECT to_jsonb(h) AS r FROM cf_private.hr_imports h WHERE id=$1', [original.import_id]), originalBefore);
  });
} finally { await db.close(); }
console.log(`${passed} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
