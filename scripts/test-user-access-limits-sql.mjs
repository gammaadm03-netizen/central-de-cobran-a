import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Banco descartável; somente identidades, contas e documentos sintéticos.
const db = new PGlite();
const id = n => `97000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const users = Object.fromEntries([
  ['target', 'contas_pagar'], ['other', 'contas_pagar'], ['manager', 'gerente_geral'], ['director', 'diretor'],
].map(([name, role], i) => [name, { id: id(i + 1), session: id(i + 11), role }]));
const cap = ['contas_pagar', 'importar_bases', 'mensagens_cp', 'painel'];
const menus = ['painel', 'caixa', 'contas_pagar', 'contas_receber', 'cobranca', 'comissoes', 'faturamento', 'margens', 'rh_dp', 'importar_bases'];
const migration = await readFile(new URL('../supabase/migrations/039_user_access_limits.sql', import.meta.url), 'utf8');
let passed = 0, failed = 0, today, bankId, payableId, importId;
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
const owner = async () => {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claims','{}',false)");
};
const actor = async (name = 'target', session = users[name].session, extra = {}) => {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [
    users[name].id, JSON.stringify({ ...(session ? { session_id: session } : {}), ...extra }),
  ]);
  await db.exec('SET ROLE authenticated');
};
const reject = (sql, args = [], code = '42501') => assert.rejects(db.query(sql, args), error => {
  assert.equal(error.code, code, error.message); return true;
});
const test = async (name, run) => {
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack ?? error.message); }
};
const permissions = () => scalar('SELECT public.current_access() AS r');
const permit = (resource, action = 'read') => scalar('SELECT cf_private.has_permission($1,$2) AS r', [resource, action]);
const restrict = userId => scalar('SELECT cf_private.restrict_payables_user($1) AS r', [userId]);
const rows = table => scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS r FROM ${table} t`);
const snapshot = async () => {
  await owner();
  const names = (await db.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN('auth','public','cf_private') ORDER BY schemaname,tablename")).rows.map(row => row.name);
  const data = {};
  for (const name of names) data[name] = await rows(name);
  return data;
};
try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  await test('039 rejects missing prerequisites atomically', async () => {
    await assert.rejects(db.exec(migration), error => error.code === '22023');
    await db.exec('ROLLBACK');
    assert.equal(await scalar("SELECT to_regclass('cf_private.user_access_limits')::text AS r"), null);
  });
  // Representative CP import/payment workflow and treasury RLS, not the full suite.
  for (const name of ['001_identidade_rbac.sql', '003_auth_gateway.sql', '005_payables.sql', '006_treasury.sql',
    '007_director_positions.sql', '012_treasury_accounts.sql', '013_director_report.sql',
    '014_payables_forecast.sql', '015_payable_payments.sql', '031_director_readonly.sql']) {
    if (name === '031_director_readonly.sql') {
      await test('039 requires the Director baseline ledger before introducing a newer permission helper', async () => {
        await assert.rejects(db.exec(migration), error => error.code === '22023');
        await db.exec('ROLLBACK');
        assert.equal(await scalar("SELECT to_regclass('cf_private.user_access_limits')::text AS r"), null);
      });
    }
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  for (const [name, user] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [user.id, `${name}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$3,true)', [user.id, `Synthetic_${name}`, user.role]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [user.session, user.id]);
  }
  today = await scalar("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS r");
  bankId = await scalar('SELECT id AS r FROM public.bank_accounts ORDER BY id LIMIT 1');
  await db.query(`INSERT INTO public.bank_balance_positions(account_id,balance_date,amount_cents,observation,created_by)
    SELECT id,$1,1000,'Saldo sintético',$2 FROM public.bank_accounts`, [today, users.manager.id]);
  await db.query("INSERT INTO public.stock_positions(value_cents,reference_date,observation,created_by) VALUES(500000,$1,'Estoque sintético',$2)", [today, users.manager.id]);
  const initialMatrix = await rows('public.role_permissions');
  const initialProfiles = await rows('public.profiles');
  await db.exec(migration);

  await test('migration seeds no limits and preserves profiles and shared role grants', async () => {
    await owner();
    assert.deepEqual(await rows('cf_private.user_access_limits'), []);
    assert.deepEqual(await rows('public.role_permissions'), initialMatrix);
    assert.deepEqual(await rows('public.profiles'), initialProfiles);
  });
  await test('owner helper creates only the canonical four-resource cap and repeated calls change nothing', async () => {
    await owner();
    const result = await restrict(users.target.id);
    assert.deepEqual(result, { user_id: users.target.id, allowed_resources: cap });
    const before = await snapshot();
    assert.deepEqual(await restrict(users.target.id), result);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await rows('public.role_permissions'), initialMatrix);
    assert.deepEqual(await rows('public.profiles'), initialProfiles);
  });
  await test('target has exactly three navigation modules and retains CP read, write, import and export', async () => {
    await actor();
    const access = await permissions();
    assert.equal(access.profile.role_key, 'contas_pagar');
    assert.deepEqual(menus.filter(resource => access.permissions.some(p => p.resource === resource && p.action === 'read')), ['painel', 'contas_pagar', 'importar_bases']);
    for (const action of ['read', 'write', 'import', 'export']) assert.equal(await permit('contas_pagar', action), true, action);
    assert.equal(await permit('mensagens_cp'), true);
    assert.equal(await permit('mensagens_cp', 'write'), false);
    assert.equal(await permit('caixa'), false);
    assert.equal(await permit('caixa', 'export'), false);
  });
  await test('another user with the same CP role retains Caixa and all original role permissions', async () => {
    await actor('other');
    const access = await permissions();
    assert.equal(await permit('caixa'), true);
    assert.equal(await permit('caixa', 'export'), true);
    assert.equal((await db.query('SELECT * FROM public.bank_balance_positions')).rows.length, 17);
    const expected = initialMatrix.filter(row => row.role_key === 'contas_pagar').map(({ resource, action }) => ({ resource, action }));
    assert.deepEqual(access.permissions.map(p => `${p.resource}/${p.action}`).sort(), expected.map(p => `${p.resource}/${p.action}`).sort());
  });
  await test('target can import, read/export and register a CP payment without gaining bank balance access', async () => {
    await actor();
    const report = [{ entry_number: 'SYNTHETIC-CP', description: 'Fornecedor sintético', due_date: today,
      amount_cents: 25000, plan: 'INVESTIMENTOS', branch: 'Filial sintética' }];
    const preview = await scalar('SELECT public.preview_payables_import($1,$2::jsonb) AS r', ['grupo-consolidado', JSON.stringify(report)]);
    assert.equal(preview.new_count, 1);
    const bytes = Buffer.from('Arquivo sintético para teste de limite individual');
    await db.exec('RESET ROLE'); await db.exec('SET ROLE service_role');
    const imported = await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,true,NULL) AS r', [
      users.target.id, users.target.session, 'grupo-consolidado', 'synthetic.csv', createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(report), '{}',
    ]);
    importId = imported.import_id;
    await actor();
    payableId = (await db.query('SELECT id FROM public.payable_titles WHERE last_import_id=$1', [importId])).rows[0].id;
    const accounts = await scalar('SELECT public.get_payable_payment_accounts() AS r');
    assert.equal(accounts.length, 17);
    assert(accounts.every(account => !Object.hasOwn(account, 'amount_cents')));
    const payment = await scalar('SELECT public.register_payable_payment($1,5000,$2,$3,$4,NULL,$5,$6) AS r', [
      payableId, today, bankId, 'Pagamento sintético', id(80), importId,
    ]);
    assert.equal((await db.query('SELECT amount_cents FROM public.payable_payments WHERE id=$1', [payment])).rows[0].amount_cents, 5000);
    assert.equal((await db.query('SELECT paid_cents FROM public.payable_financial_titles WHERE id=$1', [payableId])).rows[0].paid_cents, 5000);
    assert.equal((await db.query('SELECT * FROM public.bank_balance_positions')).rows.length, 0);
  });
  await test('Painel aggregate dependencies remain available while Caixa tables and details are denied', async () => {
    await actor();
    const cash = await scalar('SELECT public.cash_position($1) AS r', [today]);
    assert.deepEqual(cash.accounts, []); assert.equal(cash.total_cents, 17000);
    assert.equal((await db.query('SELECT * FROM public.bank_accounts')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM public.bank_balance_positions')).rows.length, 0);
    assert.equal((await scalar('SELECT public.current_stock() AS r')).value_cents, 500000);
    assert.equal((await scalar('SELECT public.payables_summary($1,$1) AS r', [today])).open_cents, 20000);
    await reject('SELECT public.set_bank_balance($1,$2,99999,$3,NULL)', [bankId, today, 'Proibido']);
  });
  await test('anonymous, browser and service roles cannot configure limits or invoke the private helper', async () => {
    for (const name of ['anon', 'authenticated', 'service_role']) {
      await owner(); await db.exec(`SET ROLE ${name}`);
      await reject('SELECT * FROM cf_private.user_access_limits');
      await reject('DELETE FROM cf_private.user_access_limits WHERE user_id=$1', [users.target.id]);
      await reject('UPDATE cf_private.user_access_limits SET allowed_resources=ARRAY[\'caixa\'] WHERE user_id=$1', [users.target.id]);
      await reject('INSERT INTO cf_private.user_access_limits(user_id,allowed_resources,reason) VALUES($1,ARRAY[\'caixa\'],\'escalada\')', [users.other.id]);
      await reject('SELECT cf_private.restrict_payables_user($1)', [users.other.id]);
    }
    await actor();
    await reject('SELECT public.manage_profile($1,$2,$3,$4,true)', [users.target.id, 'Escalation', 'Escalation', 'gerente_geral']);
  });
  await test('unapproved, expired, missing, disabled and forged metadata sessions never bypass limits', async () => {
    for (const session of [null, id(98)]) { await actor('target', session); await reject('SELECT public.current_access()'); }
    await owner(); await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [users.target.session]);
    await actor(); await reject('SELECT public.current_access()'); assert.equal((await db.query('SELECT * FROM public.payable_titles')).rows.length, 0);
    await owner(); await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE session_id=$1", [users.target.session]);
    await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1', [users.target.id]);
    assert.deepEqual((await restrict(users.target.id)).allowed_resources, cap);
    assert.equal(await scalar('SELECT enabled AS r FROM public.profiles WHERE id=$1', [users.target.id]), false);
    await actor(); await reject('SELECT public.current_access()'); assert.equal(await permit('contas_pagar', 'write'), false);
    await owner(); await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1', [users.target.id]);
    await actor('target', users.target.session, { role: 'service_role', user_metadata: { role: 'gerente_geral' }, allowed_resources: ['caixa'] });
    assert.equal(await permit('caixa'), false); assert.equal((await permissions()).profile.role_key, 'contas_pagar');
    await owner(); await db.exec('SET ROLE anon'); await reject('SELECT public.current_access()');
  });
  await test('a cap never grants rights absent from the role and an empty cap denies all resources', async () => {
    await owner(); await db.query('UPDATE cf_private.user_access_limits SET allowed_resources=$2 WHERE user_id=$1', [users.target.id, ['caixa', 'rh_dp']]);
    await actor(); assert.equal(await permit('caixa'), true); assert.equal(await permit('rh_dp'), false);
    assert.equal(await permit('caixa', 'write'), false);
    await owner(); await db.query('UPDATE cf_private.user_access_limits SET allowed_resources=ARRAY[]::text[] WHERE user_id=$1', [users.target.id]);
    await actor(); assert.deepEqual((await permissions()).permissions, []);
    await owner(); await restrict(users.target.id);
  });
  await test('existing Director read-only behavior remains enforced even if old write grants reappear', async () => {
    await owner(); await db.exec("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('diretor','caixa','write'),('diretor','importar_bases','read')");
    await actor('director');
    assert.equal(await permit('caixa'), true); assert.equal(await permit('caixa', 'write'), false);
    assert.equal(await permit('importar_bases'), false); assert.equal(await permit('mensagens_cp', 'write'), false);
    await reject("SELECT public.create_management_message('normal',NULL,'Não autorizado')");
    await owner(); await db.exec("DELETE FROM public.role_permissions WHERE role_key='diretor' AND (resource='importar_bases' OR action='write')");
  });
  await test('limits require CP profiles and block any role change until the owner removes the cap', async () => {
    await owner();
    for (const name of ['manager', 'director']) {
      await reject('INSERT INTO cf_private.user_access_limits(user_id,allowed_resources,reason) VALUES($1,ARRAY[\'painel\'],\'Proibido\')', [users[name].id], '23514');
      await reject('SELECT cf_private.restrict_payables_user($1)', [users[name].id], '22023');
    }
    await reject('SELECT cf_private.restrict_payables_user($1)', [id(99)], '22023');
    for (const role of ['gerente_geral', 'contas_receber']) await reject('UPDATE public.profiles SET role_key=$2 WHERE id=$1', [users.target.id, role], '23514');
    await actor('manager');
    await reject('SELECT public.manage_profile($1,$2,$3,$4,true)', [users.target.id, 'Synthetic_target', 'Synthetic_target', 'gerente_geral'], '23514');
    await owner(); await db.query('DELETE FROM cf_private.user_access_limits WHERE user_id=$1', [users.target.id]);
    await db.query("UPDATE public.profiles SET role_key='contas_receber' WHERE id=$1", [users.target.id]);
    await db.query("UPDATE public.profiles SET role_key='contas_pagar' WHERE id=$1", [users.target.id]);
    await restrict(users.target.id);
  });
  await test('resource lists are bounded and canonical; invalid names and NULLs are rejected', async () => {
    await owner();
    for (const resources of [['Caixa'], ['unknown'], ['painel', null], Array(21).fill('painel')]) {
      await reject('UPDATE cf_private.user_access_limits SET allowed_resources=$2 WHERE user_id=$1', [users.target.id, resources], '23514');
    }
    await db.query('UPDATE cf_private.user_access_limits SET allowed_resources=$2 WHERE user_id=$1', [users.target.id, ['painel', 'contas_pagar', 'painel']]);
    assert.deepEqual(await scalar('SELECT allowed_resources AS r FROM cf_private.user_access_limits WHERE user_id=$1', [users.target.id]), ['contas_pagar', 'painel']);
    await restrict(users.target.id);
  });
  await test('limit changes are centrally audited and repeating migration preserves every existing record', async () => {
    await owner();
    const audits = (await rows('public.audit_events')).filter(row => row.entity === 'user_access_limits');
    assert(audits.some(row => row.action === 'CREATE' && row.record_id === users.target.id));
    assert(audits.some(row => row.action === 'UPDATE' && row.before_value && row.after_value));
    assert(audits.some(row => row.action === 'DELETE' && row.before_value && !row.after_value));
    assert(audits.every(row => row.module === 'administracao'));
    assert.equal(await scalar("SELECT relrowsecurity AS r FROM pg_class WHERE oid='cf_private.user_access_limits'::regclass"), true);
    const before = await snapshot(); await db.exec(migration); assert.deepEqual(await snapshot(), before);
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='039_user_access_limits'"), 1);
    assert.deepEqual(await rows('public.role_permissions'), initialMatrix);
  });
  await test('guarded Director activation bundle cannot replace the newer permission ceiling', async () => {
    await owner(); const before = await snapshot();
    await db.exec(await readFile(new URL('../supabase/dashboard/ativar-acesso-diretoria.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshot(), before);
    await actor(); assert.equal(await permit('caixa'), false);
    const access = await permissions();
    assert.deepEqual(menus.filter(resource => access.permissions.some(p => p.resource === resource && p.action === 'read')), ['painel', 'contas_pagar', 'importar_bases']);
  });
} catch (error) { failed++; console.error('SETUP FAILURE', error.stack ?? error.message); }
finally { await db.close(); }
console.log(`${passed} passed; ${failed} failed (local PostgreSQL; emulated Supabase identity)`);
if (failed) process.exitCode = 1;
