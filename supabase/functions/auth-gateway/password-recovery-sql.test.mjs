import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('password recovery SQL preserves data, denies browser RPCs, enforces rate and audits/revokes atomically',async()=>{
 const db=new PGlite();
 const user='10000000-0000-4000-8000-000000000001', session='20000000-0000-4000-8000-000000000001', recovery='20000000-0000-4000-8000-000000000002';
 const role=async name=>{await db.exec('RESET ROLE');await db.exec(`SET ROLE ${name}`);};
 const result=async(sql,args=[])=>(await db.query(sql,args)).rows[0].r;
 const denied=async(sql,args=[])=>{await assert.rejects(db.query(sql,args),e=>e.code==='42501');};
 try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$; GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for(const migration of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql'])await db.exec(await readFile(new URL(`../../migrations/${migration}`,import.meta.url),'utf8'));
  await db.query('insert into auth.users(id,email) values($1,$2)',[user,'private-email@example.test']);
  await db.query("insert into public.profiles(id,username,display_name,role_key,enabled) values($1,'TestManager','Teste','gerente_geral',true)",[user]);
  await db.query('insert into cf_private.approved_sessions(session_id,user_id) values($1,$2)',[session,user]);
  for(const browser of ['anon','authenticated']){
   await role(browser);
   await denied('select public.finish_password_recovery($1,true,null)',[user]);
   await denied('select public.begin_password_change($1,$2,null)',[user,recovery]);
   await denied('select public.finish_password_change($1,true)',[user]);
   for(const table of ['password_change_attempts','password_change_buckets'])await denied(`select * from cf_private.${table}`);
  }
  await role('service_role');
  const first=await result("select public.resolve_login('TestManager',$1) as r",['a'.repeat(64)]);assert.equal(first.allowed,true);
  assert.equal(await result('select public.finish_password_recovery($1,true,$2) as r',[first.ticket,'test-agent']),true);
  assert.equal(await result('select public.finish_password_recovery($1,true,null) as r',[first.ticket]),false);
  await role('postgres');
  const bucket=(await db.query("select * from cf_private.login_buckets where bucket_key like 'account:%'")).rows[0];assert.equal(bucket.attempts,1);assert.equal(bucket.lease_id,null);
  assert.equal((await db.query("select count(*)::int n from public.audit_events where action='LOGIN'")).rows[0].n,0);
  const audits=(await db.query("select * from public.audit_events where action='PASSWORD_CHANGE'")).rows;assert.equal(audits[0].after_value.stage,'recovery_requested');assert(!JSON.stringify(audits).includes('private-email'));
  // Recovery JWT is valid for Auth only and is never approved for app data.
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[user,JSON.stringify({session_id:recovery})]);
  await role('authenticated');await denied('select public.current_access()');assert.equal((await db.query('select * from public.profiles')).rows.length,0);
  await role('service_role');
  const admitted=await result('select public.begin_password_change($1,$2,$3) as r',[user,recovery,'test-agent']);assert.equal(admitted.allowed,true);
  const concurrent=await result('select public.begin_password_change($1,$2,null) as r',[user,recovery]);assert.equal(concurrent.allowed,false);
  await role('postgres');
  assert.equal((await db.query('select * from cf_private.revoked_sessions where user_id=$1',[user])).rows.length,1);
  assert.equal((await db.query('select count(*)::int n from cf_private.approved_sessions where user_id=$1 and expires_at>clock_timestamp()',[user])).rows[0].n,0);
  await role('service_role');const overlapping=await result("select public.resolve_login('TestManager',$1) as r",['c'.repeat(64)]);assert.equal(overlapping.allowed,true);
  assert.equal(await result('select public.finish_login($1,true,$2,null) as r',[overlapping.ticket,'20000000-0000-4000-8000-000000000088']),false);
  // Simulate a login admitted during the Auth password-update HTTP request.
  await role('service_role');const pending=await result("select public.resolve_login('TestManager',$1) as r",['b'.repeat(64)]);assert.equal(pending.allowed,true);
  assert.equal(await result('select public.finish_password_change($1,true) as r',[admitted.ticket]),true);
  assert.equal(await result('select public.finish_login($1,true,$2,null) as r',[pending.ticket,'20000000-0000-4000-8000-000000000099']),false);
  assert.equal(await result('select public.finish_password_change($1,true) as r',[admitted.ticket]),false);
  assert.deepEqual(await result('select public.begin_password_change($1,$2,null) as r',[user,recovery]),{allowed:false,reason:'inactive'});
  const newRecovery='20000000-0000-4000-8000-000000000003';
  for(let i=0;i<2;i++){const a=await result('select public.begin_password_change($1,$2,null) as r',[user,newRecovery]);assert.equal(a.allowed,true);assert.equal(await result('select public.finish_password_change($1,false) as r',[a.ticket]),true);}
  const throttled=await result('select public.begin_password_change($1,$2,null) as r',[user,newRecovery]);assert.equal(throttled.allowed,false);assert(throttled.retry_after>0);
  // Move expired guards out of this test's current time: future logins must not
  // remain locked permanently after an interrupted recovery operation.
  await role('postgres');await db.exec("update cf_private.password_change_attempts set created_at=created_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes',completed_at=completed_at-interval '16 minutes'; update cf_private.password_change_buckets set window_started_at=window_started_at-interval '16 minutes'; update cf_private.login_buckets set window_started_at=window_started_at-interval '16 minutes';");
  await role('service_role');const future=await result("select public.resolve_login('TestManager',$1) as r",['d'.repeat(64)]);assert.equal(future.allowed,true);assert.equal(await result('select public.finish_login($1,true,$2,null) as r',[future.ticket,'20000000-0000-4000-8000-000000000077']),true);
  const uncertain=await result('select public.begin_password_change($1,$2,null) as r',[user,newRecovery]);assert.equal(uncertain.allowed,true);assert.equal(await result('select public.finish_password_change($1,null) as r',[uncertain.ticket]),true);
  // An interrupted Auth write stays fail-closed after its lease, but a new
  // completed recovery resolves it without falsely declaring the old write failed.
  await role('postgres');await db.exec("update cf_private.password_change_buckets set window_started_at=clock_timestamp()-interval '16 minutes'");
  await role('service_role');const abandoned=await result('select public.begin_password_change($1,$2,null) as r',[user,'20000000-0000-4000-8000-000000000004']);assert.equal(abandoned.allowed,true);
  await role('postgres');await db.exec("update cf_private.password_change_buckets set lease_until=clock_timestamp()-interval '1 second'; update cf_private.password_change_attempts set expires_at=clock_timestamp()-interval '1 second' where completed_at is null");
  await role('service_role');const duringOutage=await result("select public.resolve_login('TestManager',$1) as r",['e'.repeat(64)]);assert.equal(duringOutage.allowed,true);assert.equal(await result('select public.finish_login($1,true,$2,null) as r',[duringOutage.ticket,'20000000-0000-4000-8000-000000000066']),false);
  const next=await result('select public.begin_password_change($1,$2,null) as r',[user,'20000000-0000-4000-8000-000000000005']);assert.equal(next.allowed,true);assert.equal(await result('select public.finish_password_change($1,true) as r',[next.ticket]),true);
  await role('postgres');assert.equal((await db.query('select count(*)::int n from cf_private.password_change_attempts where completed_at is null')).rows[0].n,0);
  await role('postgres');await db.query('update public.profiles set enabled=false where id=$1',[user]);
  await role('service_role');assert.deepEqual(await result('select public.begin_password_change($1,$2,null) as r',[user,recovery]),{allowed:false,reason:'inactive'});
  await role('postgres');assert.equal((await db.query('select count(*)::int n from auth.users')).rows[0].n,1);
  const rows=(await db.query("select * from public.audit_events where action='PASSWORD_CHANGE' order by occurred_at")).rows;assert(rows.some(r=>r.after_value.stage==='requested'));assert(rows.some(r=>r.after_value.stage==='changed'));assert(rows.some(r=>r.after_value.stage==='failed'));assert(rows.some(r=>r.after_value.stage==='uncertain'));assert(!JSON.stringify(rows).includes('private-email'));
  const tables=(await db.query("select rowsecurity from pg_tables where schemaname='cf_private' and tablename like 'password_change_%'")).rows;assert.equal(tables.length,2);assert(tables.every(r=>r.rowsecurity));
 } finally {await db.close();}
});
