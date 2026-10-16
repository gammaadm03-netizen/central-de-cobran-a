import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Only synthetic fixtures in local PostgreSQL. Never connects to production.
const db = new PGlite();
const roleNames = ['gerente_geral', 'diretor', 'contas_pagar', 'contas_receber', 'rh_dp', 'cobradora_1', 'cobradora_2'];
const identities = Object.fromEntries(roleNames.map((name, i) => [name, {
  user: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  session: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
}]));
let passed = 0, failed = 0, accounts, originalAccounts, originalData, originalSnapshotId, supportId;
const role = async name => { await db.exec('RESET ROLE'); await db.exec(`SET ROLE ${name}`); };
const user = async name => {
  await role('postgres');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [
    identities[name].user, JSON.stringify({ session_id: identities[name].session }),
  ]);
  await role('authenticated');
};
const result = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
const rejects = async (sql, args = [], code = '42501') => assert.rejects(db.query(sql, args), error => error.code === code);
const cash = date => result('SELECT public.cash_position($1) AS r', [date]);
const saveSql = 'SELECT public.save_bank_position($1,$2,$3) AS r';
const save = (date, rows, note = 'Posição sintética conferida') => result(saveSql, [date, JSON.stringify(rows), note]);
const snapshot = () => result("SELECT public.save_director_position('2020-01-01','2020-01-31') AS r");
const file = label => {
  const bytes = Buffer.from(label);
  return { hash: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
};
const originalTables = [
  'public.profiles', 'public.bank_balance_positions', 'public.payable_imports', 'public.payable_titles',
  'cf_private.payable_import_files', 'public.receivable_imports', 'public.receivable_titles',
  'cf_private.receivable_import_files', 'public.bank_support_files', 'cf_private.bank_support_bytes',
  'public.director_positions', 'public.audit_events',
];
const rowsOf = async table => (await db.query(`SELECT to_jsonb(t) AS r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.r);
const test = async (name, run) => {
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.message); }
};
const batch = async (date, amount = 100) => {
  const current = await cash(date);
  return current.accounts.map((account, i) => ({
    account_id: account.id, amount_cents: amount + i,
    expected_updated_at: account.balance_date === date ? account.updated_at : null,
  }));
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
  for (const name of ['001_identidade_rbac.sql', '003_auth_gateway.sql', '004_password_recovery.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  // Run the exact previously published activation files before the new migration.
  for (const name of ['ativar-financeiro.sql', 'ativar-recebiveis.sql']) {
    await db.exec(await readFile(new URL(`../supabase/dashboard/${name}`, import.meta.url), 'utf8'));
  }
  for (const [i, name] of roleNames.entries()) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [identities[name].user, `synthetic-${i}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)', [
      identities[name].user, `TestUser${i}`, `Teste ${name}`, name,
    ]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [identities[name].session, identities[name].user]);
  }
  await user('gerente_geral');
  originalAccounts = (await db.query('SELECT * FROM public.bank_accounts ORDER BY id')).rows;
  for (const [i, account] of originalAccounts.entries()) {
    await result("SELECT public.set_bank_balance($1,'2020-01-01',$2,'Saldo existente antes da ampliação',null) AS r", [account.id, i < 2 ? -(i + 1) * 10000 : 10000 + i]);
  }
  const sourceCP = file('Relatório completo CP sintético anterior à ampliação');
  const sourceCR = file('Relatório completo CR sintético anterior à ampliação');
  await role('service_role');
  await result('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,null) AS r', [
    identities.gerente_geral.user, identities.gerente_geral.session, 'grupo-consolidado', 'cp.csv', sourceCP.hash, sourceCP.base64,
    JSON.stringify([{ entry_number: 'CP-ANTERIOR', description: 'Fornecedor sintético', due_date: '2020-01-15', amount_cents: 2500,
      source_status: 'Aberto', plan: 'INVESTIMENTOS', bank_account: 'Conta sintética', branch: '2', issued_on: '2020-01-01' }]),
    JSON.stringify({ INVESTIMENTOS: 'VARIÁVEL' }),
  ]);
  await result('SELECT public.commit_receivables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,true,null) AS r', [
    identities.gerente_geral.user, identities.gerente_geral.session, 'grupo-consolidado', 'cr.csv', sourceCR.hash, sourceCR.base64,
    JSON.stringify([{ document: 'NF-ANTERIOR', client_name: 'Cliente sintético', client_document: null, branch: '2',
      issued_on: '2020-01-01', due_date: '2020-01-15', amount_cents: 5000 }]),
  ]);
  await user('gerente_geral');
  const support = file('Arquivo sintético de apoio anterior à ampliação');
  supportId = await result('SELECT public.register_bank_support($1,$2,$3,$4,$5,$6) AS r', [
    'extrato.csv', support.hash, support.base64, originalAccounts[0].id, '2020-01-01', 'Extrato original de teste',
  ]);
  originalSnapshotId = await snapshot();
  await role('postgres');
  originalData = Object.fromEntries(await Promise.all(originalTables.map(async table => [table, await rowsOf(table)])));
  await db.exec(await readFile(new URL('../supabase/migrations/012_treasury_accounts.sql', import.meta.url), 'utf8'));

  await test('incremental activation preserves all previous IDs, financial data, original files, audits and historical snapshots', async () => {
    for (const table of originalTables) assert.deepEqual(await rowsOf(table), originalData[table], `${table} changed`);
    const preserved = (await db.query('SELECT id,company,bank,account_label,enabled,created_at FROM public.bank_accounts WHERE id=ANY($1::uuid[]) ORDER BY id', [originalAccounts.map(a => a.id)])).rows;
    assert.deepEqual(preserved, originalAccounts);
    assert.equal((await db.query("SELECT * FROM public.central_schema_migrations WHERE version='012_treasury_accounts'")).rows.length, 1);
  });

  await test('official list contains twelve banks and five physical cash accounts with the exact supplied names', async () => {
    await user('gerente_geral');
    accounts = (await db.query('SELECT * FROM public.bank_accounts ORDER BY company,bank')).rows;
    assert.equal(accounts.length, 17);
    assert.equal(accounts.filter(a => a.account_type === 'BANK').length, 12);
    assert.equal(accounts.filter(a => a.account_type === 'CASH').length, 5);
    assert.deepEqual(accounts.map(a => a.display_name).sort(), [
      'BRADESCO ECOPLAST', 'BRADESCO LIMPE FACIL', 'BRADESCO GAMMA IND', 'BRADESCO F2G', 'BRADESCO FAST CLEAN', 'BRADESCO EASY CLEAN',
      'BANCO DO BRASIL FAST CLEAN', 'BANCO DO BRASIL EASY CLEAN', 'BANCO DO BRASIL ECOPLAST',
      'BANCO CORA LIMPE FACIL', 'BANCO CORA MY CLEAN', 'BANCO CORA ECO PLAST',
      'CAIXA ECOPLAST', 'CAIXA LIMPE FACIL', 'CAIXA GAMMA', 'CAIXA FAST CLEAN', 'CAIXA EASY CLEAN',
    ].sort());
    assert(accounts.filter(a => a.account_type === 'CASH').every(a => a.bank === 'Caixa' && a.account_label === 'Caixa da empresa'));
    assert.equal(accounts.find(a => a.display_name === 'BRADESCO GAMMA IND').company, 'GAMMA');
    assert.equal(accounts.find(a => a.display_name === 'BANCO CORA ECO PLAST').company, 'ECOPLAST');
  });

  await test('six newly registered accounts have unknown balances, so the existing eleven balances cannot masquerade as a complete total', async () => {
    const current = await cash('2020-01-01');
    assert.equal(current.expected_accounts, 17); assert.equal(current.reported_accounts, 11);
    assert.equal(current.total_cents, null);
    const missing = current.accounts.filter(a => a.amount_cents === null);
    assert.equal(missing.length, 6);
    assert(missing.every(a => a.balance_date === null && a.updated_at === null));
    assert.equal(current.accounts.filter(a => a.amount_cents === 0).length, 0);
    assert(current.accounts.every(a => a.account_type && a.display_name && a.company && a.bank && a.account_label));
    // The positive accounts do not automatically transfer money to a negative account.
    assert.equal(current.negative_accounts_count, 2); assert.equal(current.coverage_required_cents, 30000);
    assert(current.accounts.filter(a => a.amount_cents > 0).reduce((n, a) => n + a.amount_cents, 0) > 30000);
    const earlier = await cash('2019-12-31');
    assert.equal(earlier.total_cents, null); assert.equal(earlier.reported_accounts, 0);
    assert.equal(earlier.negative_accounts_count, 0); assert.equal(earlier.coverage_required_cents, 0);
    assert(earlier.accounts.every(a => a.amount_cents === null));
    const currentSnapshot = await snapshot();
    const indicators = (await db.query('SELECT indicators FROM public.director_positions WHERE id=$1', [currentSnapshot])).rows[0].indicators;
    assert.equal(indicators.cash_cents, null); assert.equal(indicators.cash_expected_accounts, 17);
    assert.equal(indicators.projected_cash_cents, null);
    assert.equal((await db.query('SELECT indicators FROM public.director_positions WHERE id=$1', [originalSnapshotId])).rows[0].indicators.cash_expected_accounts, 11);
  });

  await test('an old eleven-account payload is rejected atomically and cannot overwrite any saved balance or audit', async () => {
    const before = await rowsOf('public.bank_balance_positions');
    const auditCount = (await db.query('SELECT count(*)::int AS n FROM public.audit_events')).rows[0].n;
    const legacy = (await batch('2020-01-01')).filter(row => originalAccounts.some(a => a.id === row.account_id));
    assert.equal(legacy.length, 11);
    await rejects(saveSql, ['2020-01-01', JSON.stringify(legacy), 'Cliente antigo desatualizado'], '23514');
    assert.deepEqual(await rowsOf('public.bank_balance_positions'), before);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.audit_events')).rows[0].n, auditCount);
  });

  await test('explicit zero is a known cash balance and is distinguished from the five other missing accounts', async () => {
    const account = accounts.find(a => a.display_name === 'CAIXA ECOPLAST');
    await result("SELECT public.set_bank_balance($1,'2020-01-01',0,'Caixa conferido sem numerário',null) AS r", [account.id]);
    const current = await cash('2020-01-01');
    assert.equal(current.reported_accounts, 12); assert.equal(current.total_cents, null);
    assert.equal(current.accounts.find(a => a.id === account.id).amount_cents, 0);
    assert.equal(current.accounts.filter(a => a.amount_cents === null).length, 5);
  });

  await test('one transaction saves all seventeen balances and includes bank and physical cash in company and consolidated totals', async () => {
    const rows = await batch('2020-01-01', 1000);
    rows.find(r => accounts.find(a => a.id === r.account_id).display_name === 'CAIXA ECOPLAST').amount_cents = 0;
    rows.find(r => accounts.find(a => a.id === r.account_id).display_name === 'BANCO CORA ECO PLAST').amount_cents = -250;
    const expected = rows.reduce((n, row) => n + row.amount_cents, 0);
    assert.deepEqual(await save('2020-01-01', rows), { position_date: '2020-01-01', total_cents: expected, account_count: 17 });
    const current = await cash('2020-01-31');
    assert.equal(current.expected_accounts, 17); assert.equal(current.reported_accounts, 17);
    assert.equal(current.total_cents, expected);
    assert.equal(current.negative_accounts_count, 1); assert.equal(current.coverage_required_cents, 250);
    for (const company of new Set(accounts.map(a => a.company))) {
      const ids = accounts.filter(a => a.company === company).map(a => a.id);
      assert.equal(current.accounts.filter(a => a.company === company).reduce((n, a) => n + a.amount_cents, 0), rows.filter(r => ids.includes(r.account_id)).reduce((n, r) => n + r.amount_cents, 0));
    }
    const newSnapshot = await snapshot();
    const indicators = (await db.query('SELECT indicators FROM public.director_positions WHERE id=$1', [newSnapshot])).rows[0].indicators;
    assert.equal(indicators.cash_cents, expected); assert.equal(indicators.cash_expected_accounts, 17);
    assert.equal(indicators.projected_cash_cents, expected + 5000 - 2500);
    const batchAudit = (await db.query("SELECT after_value FROM public.audit_events WHERE entity='bank_position' ORDER BY occurred_at DESC LIMIT 1")).rows[0].after_value;
    assert.equal(batchAudit.account_count, 17); assert.equal(batchAudit.total_cents, expected);
  });

  await test('stale cash revision rolls back every bank update and every audit in a complete position', async () => {
    const rows = await batch('2020-01-01', 3000);
    const cashId = accounts.find(a => a.display_name === 'CAIXA EASY CLEAN').id;
    const stale = rows.find(r => r.account_id === cashId); stale.expected_updated_at = null;
    // Put the invalid cash revision last so prior row updates must be rolled back.
    rows.push(rows.splice(rows.indexOf(stale), 1)[0]);
    const before = await rowsOf('public.bank_balance_positions');
    const audits = await rowsOf('public.audit_events');
    await rejects(saveSql, ['2020-01-01', JSON.stringify(rows), 'Versão de caixa desatualizada'], '40001');
    assert.deepEqual(await rowsOf('public.bank_balance_positions'), before);
    assert.deepEqual(await rowsOf('public.audit_events'), audits);
  });

  await test('negative physical cash joins bank coverage without positive offsets and clears only after a newly recorded nonnegative position', async () => {
    const account = accounts.find(a => a.display_name === 'CAIXA ECOPLAST');
    const previous = await cash('2020-01-01');
    await result("SELECT public.set_bank_balance($1,'2020-01-02',-500,'Caixa negativo conferido',null) AS r", [account.id]);
    const negative = await cash('2020-01-02');
    assert.equal(negative.negative_accounts_count, 2); assert.equal(negative.coverage_required_cents, 750);
    assert.equal(negative.total_cents, previous.total_cents - 500);
    assert.equal(negative.accounts.find(a => a.id === account.id).balance_date, '2020-01-02');
    assert.equal((await cash('2020-01-01')).coverage_required_cents, 250);
    await result("SELECT public.set_bank_balance($1,'2020-01-03',100,'Novo saldo de caixa conferido',null) AS r", [account.id]);
    assert.equal((await cash('2020-01-03')).negative_accounts_count, 1);
    assert.equal((await cash('2020-01-03')).coverage_required_cents, 250);
    assert.equal((await cash('2020-01-02')).coverage_required_cents, 750);
  });

  await test('precision checks include the physical cash in company totals even if another company cancels the consolidated excess', async () => {
    const rows = await batch('2020-02-01', 0);
    for (const row of rows) row.amount_cents = 0;
    rows.find(r => accounts.find(a => a.id === r.account_id).display_name === 'BRADESCO ECOPLAST').amount_cents = 9007199254740991;
    rows.find(r => accounts.find(a => a.id === r.account_id).display_name === 'CAIXA ECOPLAST').amount_cents = 1;
    rows.find(r => accounts.find(a => a.id === r.account_id).display_name === 'BRADESCO FAST CLEAN').amount_cents = -9007199254740991;
    assert.equal(rows.reduce((n, row) => BigInt(row.amount_cents) + n, 0n), 1n);
    await rejects(saveSql, ['2020-02-01', JSON.stringify(rows), 'Subtotais que se cancelam'], '22003');
    assert.equal((await db.query("SELECT * FROM public.bank_balance_positions WHERE balance_date='2020-02-01'")).rows.length, 0);
    const cashAccount = accounts.find(a => a.display_name === 'CAIXA ECOPLAST');
    const bankAccount = accounts.find(a => a.display_name === 'BRADESCO ECOPLAST');
    await result("SELECT public.set_bank_balance($1,'2020-02-01',9007199254740991,'Limite seguro de teste',null) AS r", [bankAccount.id]);
    await result("SELECT public.set_bank_balance($1,'2020-02-01',1,'Caixa que excede subtotal',null) AS r", [cashAccount.id]);
    await rejects("SELECT public.cash_position('2020-02-01')", [], '22003');
  });

  await test('coverage precision is checked separately from safe net and company totals before a batch writes any balance', async () => {
    await user('gerente_geral');
    const rows = (await cash('2020-01-01')).accounts.map(account => ({ account_id: account.id, amount_cents: 0, expected_updated_at: null }));
    const set = (name, amount) => { rows.find(r => accounts.find(a => a.id === r.account_id).display_name === name).amount_cents = amount; };
    set('BRADESCO ECOPLAST', -9007199254740991); set('BANCO CORA ECO PLAST', 9007199254740991);
    set('BRADESCO FAST CLEAN', -9007199254740991); set('BANCO DO BRASIL FAST CLEAN', 9007199254740991);
    assert.equal(rows.reduce((n, row) => n + BigInt(row.amount_cents), 0n), 0n);
    for (const company of new Set(accounts.map(a => a.company))) {
      assert.equal(rows.filter(row => accounts.find(a => a.id === row.account_id).company === company).reduce((n, row) => n + BigInt(row.amount_cents), 0n), 0n);
    }
    const before = await rowsOf('public.bank_balance_positions');
    const auditBefore = await rowsOf('public.audit_events');
    await assert.rejects(db.query(saveSql, ['2020-03-01', JSON.stringify(rows), 'Cobertura insegura sem saldo líquido negativo']), error => error.code === '22003' && error.message.includes('cobertura'));
    assert.deepEqual(await rowsOf('public.bank_balance_positions'), before);
    assert.deepEqual(await rowsOf('public.audit_events'), auditBefore);
    // Individual positions also remain protected when queried as an aggregate.
    for (const row of rows.filter(r => r.amount_cents !== 0)) {
      await result("SELECT public.set_bank_balance($1,'2020-03-01',$2,'Teste de precisão da leitura',null) AS r", [row.account_id, row.amount_cents]);
    }
    await assert.rejects(db.query("SELECT public.cash_position('2020-03-01')"), error => error.code === '22003' && error.message.includes('cobertura'));
  });

  await test('director, CP and CR can read all seventeen accounts but cannot write by RPC or direct database access', async () => {
    for (const name of ['diretor', 'contas_pagar', 'contas_receber']) {
      await user(name);
      assert.equal((await cash('2020-01-01')).accounts.length, 17);
      assert.equal((await db.query('SELECT * FROM public.bank_accounts')).rows.length, 17);
      const rows = await batch('2020-01-01');
      await rejects(saveSql, ['2020-01-01', JSON.stringify(rows), 'Sem permissão']);
      await rejects("SELECT public.set_bank_balance($1,'2020-01-01',1,'Sem permissão',null)", [accounts[0].id]);
      await rejects('UPDATE public.bank_accounts SET display_name=$1 WHERE id=$2', ['Nome falso', accounts[0].id]);
      await rejects('DELETE FROM public.bank_balance_positions WHERE account_id=$1', [accounts[0].id]);
      assert.equal((await result('SELECT public.download_bank_support($1) AS r', [supportId])).file_name, 'extrato.csv');
    }
  });

  await test('RH and both collectors have neither account access nor cash aggregate access', async () => {
    for (const name of ['rh_dp', 'cobradora_1', 'cobradora_2']) {
      await user(name);
      assert.equal((await db.query('SELECT * FROM public.bank_accounts')).rows.length, 0);
      assert.equal((await db.query('SELECT * FROM public.bank_balance_positions')).rows.length, 0);
      await rejects("SELECT public.cash_position('2020-01-01')");
      await rejects(saveSql, ['2020-01-01', '[]', 'Sem permissão']);
      await rejects('SELECT public.download_bank_support($1)', [supportId]);
    }
  });

  await test('panel-only permission retains the aggregate without exposing bank, cash or display-name details', async () => {
    await role('postgres');
    await db.exec("DELETE FROM public.role_permissions WHERE role_key='contas_pagar' AND resource='caixa' AND action='read'");
    await user('contas_pagar');
    const current = await cash('2020-01-01');
    assert.equal(current.expected_accounts, 17); assert.equal(current.reported_accounts, 17);
    assert.equal(typeof current.total_cents, 'number'); assert.deepEqual(current.accounts, []);
    assert.equal(current.negative_accounts_count, 1); assert.equal(current.coverage_required_cents, 250);
    assert.equal((await db.query('SELECT * FROM public.bank_accounts')).rows.length, 0);
    await role('postgres');
    await db.exec("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('contas_pagar','caixa','read')");
  });

  await test('new columns do not allow anonymous access and revoked sessions lose account access immediately', async () => {
    for (const deniedRole of ['anon', 'service_role']) {
      await role(deniedRole);
      await rejects('SELECT account_type,display_name FROM public.bank_accounts');
      await rejects("SELECT public.cash_position('2020-01-01')");
      await rejects(saveSql, ['2020-01-01', '[]', 'Sem sessão autenticada']);
    }
    await role('postgres');
    await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)', [identities.gerente_geral.session, identities.gerente_geral.user]);
    await user('gerente_geral');
    assert.equal((await db.query('SELECT * FROM public.bank_accounts')).rows.length, 0);
    await rejects("SELECT public.cash_position('2020-01-01')");
    await rejects(saveSql, ['2020-01-01', '[]', 'Sessão revogada']);
  });
} catch (error) {
  failed++; console.error('SETUP FAILURE', error.message);
} finally {
  await db.close();
}
console.log(`${passed} passed; ${failed} failed (synthetic local PostgreSQL, emulated Supabase identity)`);
if (failed) process.exitCode = 1;
