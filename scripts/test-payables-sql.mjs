import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Banco PostgreSQL isolado e descartável: somente identidades e arquivos sintéticos.
const db = new PGlite();
const roles = ['gerente_geral', 'diretor', 'contas_pagar', 'contas_receber', 'rh_dp', 'cobradora_1', 'cobradora_2'];
const users = Object.fromEntries(roles.map((role, i) => [role, {
  id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  session: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
}]));
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
  assert.equal(e.code, code, e.message);
  return true;
});
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const row = (entry, overrides = {}) => ({
  entry_number: entry, description: `Fornecedor sintético ${entry}`, due_date: '2026-10-10',
  amount_cents: 10000, source_status: 'Pendente', plan: 'INVESTIMENTOS',
  bank_account: 'Banco de teste', branch: '2 - TESTE', issued_on: '2026-10-01', ...overrides,
});
const preview = (scope, rows) => scalar('SELECT public.preview_payables_import($1,$2::jsonb) AS r', [scope, JSON.stringify(rows)]);
const original = name => {
  const bytes = Buffer.from(`Relatório de teste, nunca usar como base real: ${name}\n`);
  return { hash: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
};
const directCommitSql = 'SELECT public.commit_payables_import($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::uuid) AS r';
const commitSql = 'SELECT public.commit_payables_import_from_gateway($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::uuid) AS r';
const params = (scope, rows, name, previous = null, mappings = {}, complete = true) => {
  const file = original(name);
  return [users[currentActor].id, users[currentActor].session, scope, `${name}.csv`, file.hash, file.base64, JSON.stringify(rows), JSON.stringify(mappings), complete, previous];
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
    (SELECT count(*)::int FROM public.payable_imports) AS imports,
    (SELECT count(*)::int FROM public.payable_titles) AS titles,
    (SELECT count(*)::int FROM public.payable_plan_mappings) AS mappings,
    (SELECT count(*)::int FROM cf_private.payable_import_files) AS files,
    (SELECT count(*)::int FROM public.audit_events) AS audits`))[0];
};

try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for (const migration of ['001_identidade_rbac.sql', '003_auth_gateway.sql', '004_password_recovery.sql', '005_payables.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  for (const [name, user] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [user.id, `${name}@example.test`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$3,true)',
      [user.id, `Test_${name}`, name]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [user.session, user.id]);
  }
  await test('seed preserves official fourteen macros and only three explicit plan classifications', async () => {
    assert.equal((await query('SELECT * FROM public.payable_macros')).length, 14);
    assert.deepEqual(await query('SELECT plan,macro FROM public.payable_plan_mappings ORDER BY plan'), [
      { plan: 'FRACIONAMENTO DE PACOTES', macro: 'VARIÁVEL' },
      { plan: 'HOSPEDAGEM - COMERCIAL', macro: 'VARIÁVEL' },
      { plan: 'INVESTIMENTOS', macro: 'VARIÁVEL' },
    ]);
    assert.equal(await scalar("SELECT encode(sha256(convert_to('hello','UTF8')),'hex') AS r"),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
  await test('only manager and CP can preview/import; all other five roles and anonymous are denied', async () => {
    for (const name of roles) {
      await actor(name);
      // Even legitimate importers cannot submit browser-chosen rows or identities.
      const args = params('grupo-consolidado', [row('A')], `browser-${name}`);
      await reject(directCommitSql, args.slice(2));
      await reject(commitSql, args);
      if (['gerente_geral', 'contas_pagar'].includes(name)) {
        assert.equal((await preview('grupo-consolidado', [row('A')])).new_count, 1);
      } else {
        await reject('SELECT public.preview_payables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify([row('A')])]);
        await rejectCommit(params('grupo-consolidado', [row('A')], `forbidden-${name}`));
      }
    }
    await role('anon');
    await reject('SELECT public.preview_payables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify([row('A')])]);
    await reject(commitSql, params('grupo-consolidado', [row('A')], 'forbidden-anon'));
    await reject(directCommitSql, params('grupo-consolidado', [row('A')], 'forbidden-anon').slice(2));
  });
  await test('unclassified or invalid plans, unconfirmed completeness, invalid file and duplicate rows roll back everything', async () => {
    const before = await state();
    const invalids = [
      { rows: [row('A', { plan: 'PLANO NOVO' })], mappings: {}, code: '23514' },
      { rows: [row('A', { plan: 'PLANO NOVO' })], mappings: { 'PLANO NOVO': 'NÃO CLASSIFICADO' }, code: '22023' },
      { rows: [row('A')], complete: false, code: '22023' },
      { rows: [row('A')], mappings: { 'PLANO AUSENTE': 'FIXO' }, code: '22023' },
      { rows: [row('A'), row('A')], code: '23505' },
    ];
    for (const [i, invalid] of invalids.entries()) {
      await actor('contas_pagar');
      await rejectCommit(params('grupo-consolidado', invalid.rows, `invalid-${i}`, null, invalid.mappings ?? {}, invalid.complete ?? true), invalid.code);
      assert.deepEqual(await state(), before);
    }
    await actor('contas_pagar');
    const corrupted = params('grupo-consolidado', [row('A')], 'wrong-hash'); corrupted[4] = '0'.repeat(64);
    await rejectCommit(corrupted, '22023');
    assert.deepEqual(await state(), before);
  });
  await test('preview and commit enforce identical strict dates, string types, limits and integral cents', async () => {
    const invalidRows = [
      [], Array(5001).fill(row('A')), [null], [row('A', { due_date: '2026-02-30' })],
      [row('A', { due_date: '10/10/2026' })], [row('A', { issued_on: '2026-13-01' })],
      [row('A', { amount_cents: 1.2 })], [row('A', { amount_cents: -1 })],
      [row('A', { amount_cents: '10000' })], [row('A', { amount_cents: 9007199254740992 })],
      [row('A', { branch: '' })], [row('A', { description: false })],
      [row('A', { branch: '\t\n' })], [row('A', { plan: '\t\n' })],
      [row('A', { plan: ' '.repeat(301) })], [row('A', { bank_account: 12 })],
      [row('A', { source_key: 'forged' })],
    ];
    for (const [i, rows] of invalidRows.entries()) {
      await actor('contas_pagar');
      await reject('SELECT public.preview_payables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify(rows)], '22023');
      await rejectCommit(params('grupo-consolidado', rows, `bad-row-${i}`), '22023');
    }
    await actor('contas_pagar');
    await reject('SELECT public.preview_payables_import($1,$2::jsonb)', ['../outro escopo', JSON.stringify([row('A')])], '22023');
    await rejectCommit(params('../outro escopo', [row('A')], 'bad-scope'), '22023');
  });
  await test('maximum batch of 5,000 distinct titles has stable keys and produces a complete preview', async () => {
    await actor('contas_pagar');
    const rows = Array.from({ length: 5000 }, (_, i) => row(`LOTE-${i}`, { amount_cents: 1 }));
    const p = await preview('grupo-consolidado', rows);
    assert.deepEqual(p, { previous_import_id: null, new_count: 5000, open_count: 0, settled_count: 0, row_count: 5000 });
  });
  let first;
  await test('CP imports new titles atomically, classifies normalized plans and archives original bytes privately', async () => {
    await actor('contas_pagar');
    const rows = [row('A'), row('B', { amount_cents: 23001, plan: '  Plano\tNovo  ' })];
    assert.deepEqual(await preview('grupo-consolidado', rows), {
      previous_import_id: null, new_count: 2, open_count: 0, settled_count: 0, row_count: 2,
    });
    first = await commit('grupo-consolidado', rows, 'first', null, { ' Plano\tNovo ': 'FIXO' });
    assert.equal(first.new_count, 2);
    assert.equal(first.row_count, 2);
    const titles = await query('SELECT entry_number,plan,macro,status,first_import_id,last_import_id FROM public.payable_titles ORDER BY entry_number');
    assert.equal(titles.length, 2); assert(titles.every(t => t.status === 'NEW'));
    assert.deepEqual(titles[1], { entry_number: 'B', plan: 'PLANO NOVO', macro: 'FIXO', status: 'NEW', first_import_id: first.import_id, last_import_id: first.import_id });
    await reject('SELECT * FROM cf_private.payable_import_files');
    await role('postgres');
    assert.equal(await scalar("SELECT encode(file_bytes,'base64') AS r FROM cf_private.payable_import_files WHERE import_id=$1", [first.import_id]), original('first').base64);
    const importAudit = await query("SELECT * FROM public.audit_events WHERE module='contas_pagar' AND entity='payable_imports'");
    assert.equal(importAudit.length, 1); assert.equal(importAudit[0].action, 'IMPORT');
    assert.equal(importAudit[0].username, 'Test_contas_pagar');
    assert(!JSON.stringify(importAudit).includes(original('first').base64));
  });
  await test('RLS prevents CR/RH/collectors from seeing CP rows; director reads but cannot write; direct mutations denied for manager too', async () => {
    for (const name of roles) {
      await actor(name);
      const allowed = ['gerente_geral', 'contas_pagar', 'diretor'].includes(name);
      assert.equal((await query('SELECT * FROM public.payable_titles')).length, allowed ? 2 : 0);
      assert.equal((await query('SELECT * FROM public.payable_imports')).length, allowed ? 1 : 0);
      assert.equal((await query('SELECT * FROM public.payable_macros')).length, allowed ? 14 : 0);
      await reject("UPDATE public.payable_titles SET description='alterado'");
      await reject('DELETE FROM public.payable_titles');
      await reject("INSERT INTO public.payable_macros(name) VALUES('INDEVIDO')");
      await reject("UPDATE public.payable_plan_mappings SET macro='FRETE'");
      await reject("INSERT INTO public.payable_imports(scope) VALUES('forjado')");
      await reject('SELECT * FROM cf_private.payable_import_files');
    }
  });
  await test('arbitrary scopes cannot duplicate the group base or inflate executive aggregates', async () => {
    const before = await state();
    await actor('gerente_geral');
    await reject('SELECT public.preview_payables_import($1,$2::jsonb)', ['outra-filial', JSON.stringify([row('X')])], '22023');
    await rejectCommit(params('outra-filial', [row('X')], 'other-scope'), '22023');
    assert.deepEqual(await state(), before);
    await actor('gerente_geral');
    assert.equal((await query("SELECT * FROM public.payable_titles WHERE scope='grupo-consolidado' AND status='NEW'")).length, 2);
  });
  let second;
  await test('complete daily import marks present OPEN, absent SETTLED_IMPORT, new NEW and preserves history and previous amounts', async () => {
    await actor('gerente_geral');
    const rows = [row('B', { amount_cents: 23001, plan: 'plano novo', description: 'Favorecido atualizado' }), row('C', { amount_cents: 40000 })];
    const p = await preview('grupo-consolidado', rows);
    assert.deepEqual(p, { previous_import_id: first.import_id, new_count: 1, open_count: 1, settled_count: 1, row_count: 2 });
    second = await commit('grupo-consolidado', rows, 'second', p.previous_import_id);
    assert.equal(second.new_count, 1); assert.equal(second.open_count, 1); assert.equal(second.settled_count, 1);
    const titles = await query("SELECT * FROM public.payable_titles WHERE scope='grupo-consolidado' ORDER BY entry_number");
    assert.equal(titles.length, 3);
    assert.equal(titles[0].status, 'SETTLED_IMPORT'); assert(titles[0].settled_at);
    assert.equal(titles[0].first_import_id, first.import_id); assert.equal(titles[0].last_import_id, second.import_id);
    assert.equal(titles[1].status, 'OPEN'); assert.equal(titles[1].description, 'Favorecido atualizado');
    assert.equal(titles[1].first_import_id, first.import_id); assert.equal(titles[2].status, 'NEW');
    const audits = await query("SELECT * FROM public.audit_events WHERE entity='payable_titles' AND action='AUTO_RECONCILE'");
    assert.equal(audits.length, 1); assert.equal(audits[0].before_value.status, 'NEW'); assert.equal(audits[0].after_value.status, 'SETTLED_IMPORT');
    assert.equal(audits[0].before_value.amount_cents, 10000); assert.equal(audits[0].after_value.last_import_id, second.import_id);
  });
  await test('stale preview and duplicate original SHA are rejected atomically without resetting settled history', async () => {
    const before = await state();
    await actor('gerente_geral');
    await rejectCommit(params('grupo-consolidado', [row('A')], 'stale', first.import_id), '40001');
    await rejectCommit(params('grupo-consolidado', [row('A')], 'second', second.import_id), '23505');
    assert.deepEqual(await state(), before);
  });
  await test('previously settled title is reopened under same stable ID with explicit REOPEN audit; row order is not identity', async () => {
    await actor('contas_pagar');
    const before = (await query("SELECT id,first_import_id FROM public.payable_titles WHERE scope='grupo-consolidado' AND entry_number='A'"))[0];
    const rows = [row('C', { amount_cents: 40000 }), row('A')];
    const p = await preview('grupo-consolidado', rows);
    assert.equal(p.new_count, 0); assert.equal(p.open_count, 2); assert.equal(p.settled_count, 1);
    const third = await commit('grupo-consolidado', rows, 'third', second.import_id);
    const after = (await query("SELECT * FROM public.payable_titles WHERE scope='grupo-consolidado' AND entry_number='A'"))[0];
    assert.equal(after.id, before.id); assert.equal(after.first_import_id, before.first_import_id);
    assert.equal(after.last_import_id, third.import_id); assert.equal(after.status, 'OPEN'); assert.equal(after.settled_at, null);
    await role('postgres');
    const audits = await query("SELECT * FROM public.audit_events WHERE entity='payable_titles' AND action='REOPEN'");
    assert.equal(audits.length, 1); assert.equal(audits[0].record_id, before.id);
  });
  await test('executive summary exposes only aggregates to CR and respects Saturday-Friday date boundaries', async () => {
    // All active group titles due Saturday; settled titles are excluded.
    for (const name of ['contas_receber', 'diretor', 'gerente_geral', 'contas_pagar']) {
      await actor(name);
      const p = await scalar('SELECT public.payables_summary($1,$2) AS r', ['2026-10-10', '2026-10-16']);
      assert.equal(p.period_cents, 50000); assert.equal(p.open_cents, 50000); assert.equal(p.active_count, 2);
      assert(p.latest_import_at); assert.deepEqual(Object.keys(p).sort(), ['active_count', 'latest_import_at', 'open_cents', 'overdue_cents', 'period_cents']);
      const priorWeek = await scalar('SELECT public.payables_summary($1,$2) AS r', ['2026-10-03', '2026-10-09']);
      assert.equal(priorWeek.period_cents, 0);
    }
    for (const name of ['rh_dp', 'cobradora_1', 'cobradora_2']) {
      await actor(name); await reject('SELECT public.payables_summary($1,$2)', ['2026-10-10', '2026-10-16']);
    }
  });
  await test('overdue uses São Paulo civil day: yesterday overdue, today and tomorrow excluded', async () => {
    await actor('gerente_geral');
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date());
    const part = name => parts.find(p => p.type === name).value;
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    const shift = days => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    const before = await scalar('SELECT public.payables_summary($1,$1) AS r', [today]);
    const p = await preview('grupo-consolidado', [row('A'), row('C', { amount_cents: 40000 })]);
    await commit('grupo-consolidado', [row('A'), row('C', { amount_cents: 40000 }),
      row('ONTEM', { due_date: shift(-1), amount_cents: 1 }), row('HOJE', { due_date: today, amount_cents: 2 }),
      row('AMANHA', { due_date: shift(1), amount_cents: 4 })], 'timezone', p.previous_import_id);
    const after = await scalar('SELECT public.payables_summary($1,$1) AS r', [today]);
    assert.equal(after.overdue_cents - before.overdue_cents, 1);
    assert.equal(after.period_cents - before.period_cents, 2);
  });
  await test('consolidated summaries reject totals exceeding exact browser precision even for future privileged migrations', async () => {
    await role('postgres');
    // A future owner-level migration must not turn an oversized aggregate into
    // an imprecise JSON number even though each individual amount fits bigint.
    await db.exec(`INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,
      source_status,plan,bank_account,branch,issued_on,macro,status,first_import_id,last_import_id,settled_at)
      SELECT scope,'precision-guard-owner-fixture','PRECISION','Fixture sintética',due_date,9007199254740991,
        source_status,plan,bank_account,branch,issued_on,macro,'OPEN',first_import_id,last_import_id,NULL
      FROM public.payable_titles LIMIT 1`);
    await actor('gerente_geral');
    await reject('SELECT public.payables_summary($1,$2)', ['2026-10-10', '2026-10-16'], '22003');
  });
  await test('manager audit is append-only and archived bytes have no direct browser or service table grants', async () => {
    await actor('gerente_geral');
    assert((await query("SELECT * FROM public.audit_events WHERE module='contas_pagar'")).length > 10);
    await reject("DELETE FROM public.audit_events WHERE module='contas_pagar'");
    await reject("UPDATE public.audit_events SET after_value='{}'::jsonb WHERE module='contas_pagar'");
    await role('service_role'); await reject('SELECT * FROM cf_private.payable_import_files');
    await role('postgres');
    await reject("UPDATE public.audit_events SET after_value='{}'::jsonb WHERE module='contas_pagar'");
    const tables = await query("SELECT rowsecurity FROM pg_tables WHERE tablename IN ('payable_macros','payable_plan_mappings','payable_imports','payable_titles','payable_import_files')");
    assert.equal(tables.length, 5); assert(tables.every(t => t.rowsecurity));
  });
  await test('revoked or unapproved sessions lose CP reads, import RPC and aggregate access immediately', async () => {
    await role('postgres');
    await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)', [users.contas_pagar.session, users.contas_pagar.id]);
    await actor('contas_pagar');
    assert.equal((await query('SELECT * FROM public.payable_titles')).length, 0);
    await reject('SELECT public.preview_payables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify([row('A')])]);
    await rejectCommit(params('grupo-consolidado', [row('A')], 'revoked'));
    await reject('SELECT public.payables_summary($1,$2)', ['2026-10-10', '2026-10-16']);
    await role('postgres');
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ session_id: '20000000-0000-4000-8000-999999999999' })]);
    await role('authenticated');
    await reject('SELECT public.preview_payables_import($1,$2::jsonb)', ['grupo-consolidado', JSON.stringify([row('A')])]);
    const forged = params('grupo-consolidado', [row('A')], 'wrong-session');
    forged[0] = users.gerente_geral.id;
    forged[1] = users.contas_receber.session;
    await rejectCommit(forged);
  });
  console.log(`${passed} passed; 0 failed (local PostgreSQL, emulated Supabase identity)`);
} catch (error) {
  console.error(`FAILED after ${passed} passed:`, error.message, error.code ?? '');
  process.exitCode = 1;
} finally {
  await db.close();
}
