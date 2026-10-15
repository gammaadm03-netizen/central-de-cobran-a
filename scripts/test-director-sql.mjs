import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }
const roles = ['gerente_geral','diretor','contas_pagar','contas_receber','rh_dp','cobradora_1','cobradora_2'];
const uid = index => `10000000-0000-4000-8000-${String(index + 1).padStart(12,'0')}`;
const sid = index => `20000000-0000-4000-8000-${String(index + 1).padStart(12,'0')}`;
async function as(index) {
  await db.exec('RESET ROLE');
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [uid(index), JSON.stringify({session_id:sid(index)})]);
  await db.exec('SET ROLE authenticated');
}
async function denied(sql,args=[]) { await assert.rejects(db.query(sql,args), error => error.code === '42501'); }
try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for (const file of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  }
  await db.exec(await readFile(new URL('../supabase/dashboard/ativar-financeiro.sql',import.meta.url),'utf8'));
  for (let i=0;i<roles.length;i++) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(i),`test${i}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[uid(i),`User${i}`,'Pessoa Teste',roles[i]]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(i),uid(i)]);
  }
  let saved;
  await test('manager saves a server-computed position with unknown sources null',async()=>{
    await as(0);
    saved=(await db.query("select public.save_director_position('2026-01-03','2026-01-09') as id")).rows[0].id;
    const row=(await db.query('select * from public.director_positions where id=$1',[saved])).rows[0];
    assert.equal(row.created_by,uid(0)); assert.equal(row.indicators.complete,false);
    for(const key of ['cash_cents','payable_period_cents','stock_cents','receivable_cents','turnover_cents','current_assets_millions']) assert.equal(row.indicators[key],null,key);
    assert.equal(row.indicators.cash_expected_accounts,11);
    assert.deepEqual(row.indicators.missing_sources,['contas_receber','fechamento','parametros_financeiros']);
  });
  await test('snapshot audit keeps the official actor and preserves indicators',async()=>{
    const row=(await db.query("select * from public.audit_events where entity='director_positions' and record_id=$1",[saved])).rows[0];
    assert.equal(row.user_id,uid(0));assert.equal(row.role_key,'gerente_geral');assert.equal(row.action,'CREATE');assert.equal(row.after_value.indicators.complete,false);
  });
  await test('director can read positions but cannot save or modify them directly',async()=>{
    await as(1);assert.equal((await db.query('select * from public.director_positions')).rows.length,1);
    await denied("select public.save_director_position('2026-01-03','2026-01-09')");
    await denied("update public.director_positions set indicators='{}'");await denied('delete from public.director_positions');
  });
  await test('CP CR RH and collectors cannot read director history or save positions',async()=>{
    for(let i=2;i<roles.length;i++) { await as(i);assert.equal((await db.query('select * from public.director_positions')).rows.length,0);await denied("select public.save_director_position('2026-01-03','2026-01-09')"); }
  });
  await test('invalid periods do not create positions',async()=>{
    await as(0);
    for(const [start,end] of [[null,null],['2026-01-10','2026-01-09'],['2020-01-01','2026-01-09']]) await assert.rejects(db.query('select public.save_director_position($1,$2)',[start,end]),e=>e.code==='22023');
    assert.equal((await db.query('select * from public.director_positions')).rows.length,1);
  });
  await test('snapshot stays immutable when a later source is recorded',async()=>{
    await as(0);
    await db.query("select public.save_manual_stock(0,'2026-01-02','Zero informado explicitamente no teste')");
    const next=(await db.query("select public.save_director_position('2026-01-03','2026-01-09') as id")).rows[0].id;
    assert.equal((await db.query('select indicators from public.director_positions where id=$1',[next])).rows[0].indicators.stock_cents,0);
    assert.equal((await db.query('select indicators from public.director_positions where id=$1',[saved])).rows[0].indicators.stock_cents,null);
    await denied("insert into public.director_positions(created_by,period_start,period_end,indicators) values($1,'2026-01-03','2026-01-09','{}')",[uid(0)]);
  });
  await test('selected past period snapshots preserve the current cash displayed by the dashboard',async()=>{
    await as(0);
    const accounts=(await db.query('select id from public.bank_accounts')).rows;
    for(const account of accounts) await db.query("select public.set_bank_balance($1,(clock_timestamp() at time zone 'America/Sao_Paulo')::date,100,'Posição atual informada no teste',null)",[account.id]);
    const next=(await db.query("select public.save_director_position('2026-01-03','2026-01-09') as id")).rows[0].id;
    const row=(await db.query('select indicators from public.director_positions where id=$1',[next])).rows[0];
    assert.equal(row.indicators.cash_cents,1100);assert.match(row.indicators.cash_as_of_date,/^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await db.query('select indicators from public.director_positions where id=$1',[saved])).rows[0].indicators.cash_cents,null);
  });
  await test('revoked approval loses snapshot and schema access',async()=>{
    await db.exec('RESET ROLE');await db.query('insert into cf_private.revoked_sessions(session_id,user_id) values($1,$2)',[sid(0),uid(0)]);
    await as(0);await denied("select public.save_director_position('2026-01-03','2026-01-09')");assert.equal((await db.query('select * from public.director_positions')).rows.length,0);assert.equal((await db.query('select * from public.central_schema_migrations')).rows.length,0);
  });
  console.log(`${passed} director SQL checks passed.`);
} finally { await db.close(); }
