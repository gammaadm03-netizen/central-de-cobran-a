import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Financial amounts below are synthetic fixtures in an ephemeral database.
const db = new PGlite();
let passed = 0, failed = 0;
const roles = ['gerente_geral', 'diretor', 'contas_pagar', 'contas_receber', 'rh_dp', 'cobradora_1', 'cobradora_2'];
const identities = Object.fromEntries(roles.map((name, i) => [name, {
  user: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  session: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
}]));
const asRole = async name => { await db.exec('RESET ROLE'); await db.exec(`SET ROLE ${name}`); };
const asUser = async name => {
  const identity = identities[name];
  await asRole('postgres');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claims',$2,false)", [identity.user, JSON.stringify({ session_id: identity.session })]);
  await asRole('authenticated');
};
const result = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
const rejects = async (sql, args = [], code = '42501') => assert.rejects(db.query(sql, args), error => error.code === code);
const cash = date => result('SELECT public.cash_position($1) AS r', [date]);
const stock = () => result('SELECT public.current_stock() AS r');
const setBalance = (id, date, cents, note = 'Conferência de teste', expected = null) => result('SELECT public.set_bank_balance($1,$2,$3,$4,$5) AS r', [id, date, cents, note, expected]);
const timestamp = async id => (await db.query('SELECT updated_at::text AS stamp FROM public.bank_balance_positions WHERE id=$1', [id])).rows[0].stamp;
const test = async (name, run) => {
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.message); }
};

try {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;
  `);
  for (const file of ['001_identidade_rbac.sql', '003_auth_gateway.sql', '004_password_recovery.sql', '006_treasury.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
  for (const [i, name] of roles.entries()) {
    const identity = identities[name];
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [identity.user, `synthetic-${i}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)', [identity.user, `TestUser${i}`, `Teste ${name}`, name]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [identity.session, identity.user]);
  }
  let accounts, positionId, firstStamp;

  await test('migration seeds exactly official configuration and no financial amounts', async () => {
    await asUser('gerente_geral');
    accounts = (await db.query('SELECT * FROM public.bank_accounts ORDER BY company, bank')).rows;
    assert.equal(accounts.length, 11);
    assert.deepEqual(accounts.map(a => `${a.company}/${a.bank}`), [
      'EASY CLEAN/Banco do Brasil', 'EASY CLEAN/Bradesco', 'ECOPLAST/Banco do Brasil', 'ECOPLAST/Bradesco',
      'F2G/Bradesco', 'FAST CLEAN/Banco do Brasil', 'FAST CLEAN/Bradesco', 'GAMMA/Bradesco',
      'LIMPE FÁCIL/Bradesco', 'LIMPE FÁCIL/Cora', 'MY CLEAN/Cora',
    ]);
    assert.equal((await db.query('SELECT * FROM public.bank_balance_positions')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM public.stock_positions')).rows.length, 0);
    const current = await cash('2020-01-01');
    assert.equal(current.total_cents, null);
    assert.equal(current.reported_accounts, 0);
    assert.equal(current.expected_accounts, 11);
    assert.equal(current.latest_position_date, null);
    assert(current.accounts.every(a => a.amount_cents === null && a.balance_date === null));
    assert.deepEqual(await stock(), { value_cents: null, reference_date: null, source: null });
  });

  await test('manager records and corrects positions with actor and before/after audit', async () => {
    await asUser('gerente_geral');
    positionId = await setBalance(accounts[0].id, '2020-01-01', 1000);
    firstStamp = await timestamp(positionId);
    assert.equal(await setBalance(accounts[0].id, '2020-01-01', 1250, 'Correção conferida', firstStamp), positionId);
    const updatedStamp = await timestamp(positionId);
    assert.notEqual(updatedStamp, firstStamp);
    assert.equal(await setBalance(accounts[0].id, '2020-01-01', -250, 'Saldo devedor conferido', updatedStamp), positionId);
    const audits = (await db.query("SELECT * FROM public.audit_events WHERE entity='bank_balance_positions' ORDER BY occurred_at")).rows;
    assert.equal(audits.length, 3);
    assert.deepEqual(audits.map(a => a.action), ['CREATE', 'UPDATE', 'UPDATE']);
    assert(audits.every(a => a.user_id === identities.gerente_geral.user && a.module === 'caixa'));
    assert.equal(audits[1].before_value.amount_cents, 1000);
    assert.equal(audits[1].after_value.amount_cents, 1250);
    assert.equal(audits[2].after_value.amount_cents, -250);
    assert.equal((await cash('2020-01-01')).total_cents, null);
    assert.equal((await cash('2020-01-01')).reported_accounts, 1);
  });

  await test('stale and absent edit tokens cannot overwrite a saved position', async () => {
    await asUser('gerente_geral');
    for (const expected of [null, firstStamp]) await rejects('SELECT public.set_bank_balance($1,$2,$3,$4,$5)', [accounts[0].id, '2020-01-01', 999, 'Stale edit', expected], '40001');
    await rejects('SELECT public.set_bank_balance($1,$2,$3,$4,$5)', [accounts[0].id, '2020-01-02', 999, 'Unexpected previous position', firstStamp], '40001');
    assert.equal((await cash('2020-01-01')).accounts[0].amount_cents, -250);
  });

  await test('bank inputs enforce notes, bounded integer cents, existing accounts and São Paulo dates', async () => {
    await asUser('gerente_geral');
    const future = (await db.query("SELECT ((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text AS day")).rows[0].day;
    for (const args of [
      [accounts[1].id, null, 100, 'Teste'],
      [accounts[1].id, future, 100, 'Teste'],
      [accounts[1].id, '1899-12-31', 100, 'Teste'],
      [accounts[1].id, '2020-01-01', 100, '  '],
      [accounts[1].id, '2020-01-01', 100, 'x'.repeat(1001)],
      [accounts[1].id, '2020-01-01', '9007199254740992', 'Teste'],
      ['00000000-0000-4000-8000-000000000000', '2020-01-01', 100, 'Teste'],
    ]) await rejects('SELECT public.set_bank_balance($1,$2,$3,$4)', args, '23514');
    await rejects('SELECT public.set_bank_balance($1,$2,$3,$4)', [accounts[1].id, '2020-01-01', '1.5', 'Teste'], '22P02');
  });

  await test('consolidation waits for all eleven positions, includes negatives and respects as-of date', async () => {
    await asUser('gerente_geral');
    for (let i = 1; i < accounts.length; i++) await setBalance(accounts[i].id, '2020-01-01', 100 * (i + 1));
    const full = await cash('2020-01-31');
    assert.equal(full.total_cents, 6250);
    assert.equal(full.reported_accounts, 11);
    assert.equal(full.latest_position_date, '2020-01-01');
    const subtotals = Object.groupBy(full.accounts, a => a.company);
    assert.equal(subtotals['EASY CLEAN'].reduce((n, a) => n + a.amount_cents, 0), -50);
    assert.equal(subtotals['ECOPLAST'].reduce((n, a) => n + a.amount_cents, 0), 700);
    await setBalance(accounts[0].id, '2020-02-01', 500);
    assert.equal((await cash('2020-01-31')).total_cents, 6250);
    assert.equal((await cash('2020-02-01')).total_cents, 7000);
    assert.equal((await cash('2020-02-01')).latest_position_date, '2020-02-01');
    assert.equal((await cash('2019-12-31')).total_cents, null);
  });

  await test('unsafe consolidated and company sums are rejected before JavaScript rounding', async () => {
    await asUser('gerente_geral');
    const rows = (await db.query("SELECT id,account_id,amount_cents,updated_at::text AS stamp FROM public.bank_balance_positions WHERE balance_date='2020-01-01'")).rows;
    const replace = async (account, cents) => {
      const previous = rows.find(row => row.account_id === account.id);
      await setBalance(account.id, '2020-01-01', cents, 'Limite de precisão sintético', await timestamp(previous.id));
    };
    // Single-account company stays within the bound while the consolidated sum overflows.
    await replace(accounts[4], '9007199254740991');
    await rejects("SELECT public.cash_position('2020-01-31')", [], '22003');
    await replace(accounts[4], rows.find(row => row.account_id === accounts[4].id).amount_cents);
    // Opposite company sums cancel in the consolidated total, yet each is unsafe.
    for (let i = 0; i < 4; i++) await replace(accounts[i], i < 2 ? '4503599627370496' : '-4503599627370496');
    await rejects("SELECT public.cash_position('2020-01-31')", [], '22003');
    for (let i = 0; i < 4; i++) await replace(accounts[i], rows.find(row => row.account_id === accounts[i].id).amount_cents);
    assert.equal((await cash('2020-01-31')).total_cents, 6250);
  });

  await test('inactive account is excluded from consolidation and cannot receive manual balances', async () => {
    await asRole('postgres');
    await db.query('UPDATE public.bank_accounts SET enabled=false WHERE id=$1', [accounts[0].id]);
    await asUser('gerente_geral');
    const current = await cash('2020-02-01');
    assert.equal(current.expected_accounts, 10);
    assert.equal(current.reported_accounts, 10);
    assert.equal(current.total_cents, 6500);
    assert.equal(current.accounts.length, 10);
    await rejects('SELECT public.set_bank_balance($1,$2,$3,$4)', [accounts[0].id, '2020-02-02', 0, 'Inativa'], '23514');
    await asRole('postgres');
    await db.query('UPDATE public.bank_accounts SET enabled=true WHERE id=$1', [accounts[0].id]);
  });

  await test('director, CP and CR can consult financial data but cannot write manually or through RPCs', async () => {
    for (const name of ['diretor', 'contas_pagar', 'contas_receber']) {
      await asUser(name);
      assert.equal((await cash('2020-02-01')).total_cents, 7000);
      assert.equal((await db.query('SELECT * FROM public.bank_accounts')).rows.length, 11);
      await rejects('SELECT public.set_bank_balance($1,$2,$3,$4)', [accounts[0].id, '2020-01-02', 0, 'Não autorizado']);
      await rejects("SELECT public.save_manual_stock(0,'2020-01-01','Não autorizado')");
      await rejects('UPDATE public.bank_balance_positions SET amount_cents=1 WHERE id=$1', [positionId]);
      await rejects('DELETE FROM public.bank_balance_positions WHERE id=$1', [positionId]);
      await rejects("INSERT INTO public.bank_accounts(company,bank,account_label) VALUES('Fake','Fake','Fake')");
    }
  });

  await test('RH and collectors cannot read treasury or stock or use aggregate RPCs', async () => {
    for (const name of ['rh_dp', 'cobradora_1', 'cobradora_2']) {
      await asUser(name);
      for (const table of ['bank_accounts', 'bank_balance_positions', 'stock_positions']) assert.equal((await db.query(`SELECT * FROM public.${table}`)).rows.length, 0);
      await rejects("SELECT public.cash_position('2020-01-01')");
      await rejects('SELECT public.current_stock()');
      await rejects('SELECT public.set_bank_balance($1,$2,$3,$4)', [accounts[0].id, '2020-01-02', 0, 'Não autorizado']);
      await rejects("SELECT public.save_manual_stock(0,'2020-01-01','Não autorizado')");
    }
  });

  await test('panel-only permission can read total but never bank account details', async () => {
    await asRole('postgres');
    await db.exec("DELETE FROM public.role_permissions WHERE role_key='contas_pagar' AND resource='caixa' AND action='read'");
    await asUser('contas_pagar');
    const summary = await cash('2020-02-01');
    assert.equal(summary.total_cents, 7000);
    assert.deepEqual(summary.accounts, []);
    assert.equal((await db.query('SELECT * FROM public.bank_accounts')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM public.bank_balance_positions')).rows.length, 0);
    await asRole('postgres');
    await db.exec("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('contas_pagar','caixa','read')");
  });

  await test('manual stock preserves missing vs explicit zero, append-only history and official provenance', async () => {
    await asUser('gerente_geral');
    assert.equal((await stock()).value_cents, null);
    const first = await result("SELECT public.save_manual_stock(123456,'2020-01-01','Contagem manual de teste') AS r");
    assert.deepEqual(await stock(), { value_cents: 123456, reference_date: '2020-01-01', source: 'MANUAL' });
    await result("SELECT public.save_manual_stock(0,'2020-02-01','Contagem confirmou saldo zero') AS r");
    assert.deepEqual(await stock(), { value_cents: 0, reference_date: '2020-02-01', source: 'MANUAL' });
    await result("SELECT public.save_manual_stock(999,'2019-12-31','Registro antigo') AS r");
    assert.equal((await stock()).value_cents, 0);
    assert.equal((await db.query('SELECT * FROM public.stock_positions')).rows.length, 3);
    await rejects('UPDATE public.stock_positions SET value_cents=0 WHERE id=$1', [first]);
    await rejects('DELETE FROM public.stock_positions WHERE id=$1', [first]);
    const audits = (await db.query("SELECT * FROM public.audit_events WHERE entity='stock_positions'")).rows;
    assert.equal(audits.length, 3);
    assert(audits.every(a => a.action === 'CREATE' && a.module === 'estoque' && a.user_id === identities.gerente_geral.user));
  });

  await test('stock validates safe non-negative cents, date and justification', async () => {
    await asUser('gerente_geral');
    const future = (await db.query("SELECT ((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text AS day")).rows[0].day;
    for (const args of [[-1,'2020-01-01','Teste'], [null,'2020-01-01','Teste'], ['9007199254740992','2020-01-01','Teste'], [1,future,'Teste'], [1,null,'Teste'], [1,'2020-01-01',' '], [1,'2020-01-01','x'.repeat(1001)]]) {
      await rejects('SELECT public.save_manual_stock($1,$2,$3)', args, '23514');
    }
  });

  await test('anonymous callers cannot read tables or execute treasury RPCs', async () => {
    await asRole('anon');
    for (const table of ['bank_accounts', 'bank_balance_positions', 'stock_positions']) await rejects(`SELECT * FROM public.${table}`);
    await rejects("SELECT public.cash_position('2020-01-01')");
    await rejects('SELECT public.current_stock()');
    await rejects('SELECT public.set_bank_balance($1,$2,$3,$4)', [accounts[0].id,'2020-01-02',0,'Teste']);
    await rejects("SELECT public.save_manual_stock(0,'2020-01-01','Teste')");
  });

  await test('revoking an approved manager session immediately blocks RPCs and all treasury rows', async () => {
    await asRole('postgres');
    await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)', [identities.gerente_geral.session, identities.gerente_geral.user]);
    await asUser('gerente_geral');
    for (const table of ['bank_accounts', 'bank_balance_positions', 'stock_positions']) assert.equal((await db.query(`SELECT * FROM public.${table}`)).rows.length, 0);
    await rejects("SELECT public.cash_position('2020-01-01')");
    await rejects('SELECT public.current_stock()');
    await rejects('SELECT public.set_bank_balance($1,$2,$3,$4)', [accounts[0].id,'2020-01-02',0,'Teste']);
    await rejects("SELECT public.save_manual_stock(0,'2020-01-01','Teste')");
  });

  await test('audit entries remain immutable even through privileged SQL', async () => {
    await asRole('postgres');
    await rejects("UPDATE public.audit_events SET action='DELETE' WHERE entity='bank_balance_positions'");
    await rejects("DELETE FROM public.audit_events WHERE entity='stock_positions'");
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM public.stock_positions")).rows[0].n, 3);
  });
} catch (error) {
  failed++;
  console.error('SETUP FAILURE', error.message);
} finally {
  await db.close();
}
console.log(`${passed} passed; ${failed} failed (local PostgreSQL, emulated Supabase identity)`);
if (failed) process.exitCode = 1;
