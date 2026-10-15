import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message);}}
const uid='10000000-0000-4000-8000-000000000001';
const session='20000000-0000-4000-8000-000000000001';
async function role(name){await db.exec('RESET ROLE');await db.exec(`SET ROLE ${name}`);}
async function claim(sid=session){await db.exec('RESET ROLE');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[uid,JSON.stringify(sid?{session_id:sid}:{})]);await role('authenticated');}
async function denied(sql,args=[]){let code;try{await db.query(sql,args);}catch(e){code=e.code;}assert.equal(code,'42501');}
const resolve=async(name,network='a'.repeat(64))=>(await db.query('select public.resolve_login($1,$2) as r',[name,network])).rows[0].r;
const finish=async(ticket,success=false)=>(await db.query('select public.finish_login($1,$2,$3,$4) as r',[ticket,success,success?'20000000-0000-4000-8000-000000000003':null,'test-agent'])).rows[0].r;
try{
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 for(const file of ['001_identidade_rbac.sql','003_auth_gateway.sql'])await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
 await db.query('insert into auth.users(id,email) values($1,$2)',[uid,'manager@test.invalid']);
 await db.query("insert into public.profiles(id,username,display_name,role_key,enabled) values($1,'TestManager','Teste','gerente_geral',true)",[uid]);
 await test('anonymous and authenticated cannot resolve private login mappings or forge login/logout events',async()=>{
  for(const r of ['anon','authenticated']){await role(r);await denied('select public.resolve_login($1,$2)',['TestManager','a'.repeat(64)]);await denied('select public.finish_login($1,true,null,null)',['30000000-0000-4000-8000-000000000001']);await denied('select public.revoke_application_session($1,$2,null)',[uid,session]);}
 });
 await role('postgres');await db.query('insert into cf_private.approved_sessions(session_id,user_id) values($1,$3),($2,$3)',[session,'20000000-0000-4000-8000-000000000002',uid]);
 await test('valid approved-session claims permit access but missing session id denies access',async()=>{
  await claim();assert.equal((await db.query('select public.current_access() as r')).rows[0].r.profile.id,uid);
  await claim(null);await denied('select public.current_access()');assert.equal((await db.query('select * from public.profiles')).rows.length,0);
 });
 await test('direct Auth login without gateway approval cannot access application data',async()=>{
  await claim('20000000-0000-4000-8000-000000000099');await denied('select public.current_access()');assert.equal((await db.query('select * from public.profiles')).rows.length,0);
 });
 await test('server-only broker normalizes username and leases one in-flight attempt',async()=>{
  await role('service_role');const a=await resolve('tEsTmAnAgEr');assert.equal(a.allowed,true);assert.equal(a.email,'manager@test.invalid');assert.equal(a.user_id,uid);
  const b=await resolve('testmanager','b'.repeat(64));assert.equal(b.allowed,false);assert(b.retry_after>0);
  assert.equal(await finish(a.ticket,false),false);
 });
 await test('six failed attempts trigger username throttle even when network key changes',async()=>{
  await role('service_role');
  // One failed attempt was already counted above.
  for(let i=1;i<6;i++){const a=await resolve('testmanager',String(i).repeat(64));assert.equal(a.allowed,true);await finish(a.ticket,false);}
  assert.equal((await resolve('TESTMANAGER','c'.repeat(64))).allowed,false);
 });
 await test('expired login tickets cannot be promoted to a success or replayed',async()=>{
  await role('service_role');const a=await resolve('unknownuser');assert.equal(a.allowed,true);assert.equal(a.email,null);
  await role('postgres');await db.query("update cf_private.login_attempts set expires_at=clock_timestamp()-interval '1 second' where id=$1",[a.ticket]);
  await role('service_role');assert.equal(await finish(a.ticket,true),false);assert.equal(await finish(a.ticket,true),false);
 });
 await test('failed attempt audit contains no submitted login mapping or credentials',async()=>{
  await role('postgres');const rows=(await db.query("select * from public.audit_events where module='autenticacao' and action='LOGIN'")).rows;
  assert(rows.length>=7);assert(rows.every(r=>r.username===null&&r.after_value.outcome==='denied'));
  assert(!JSON.stringify(rows).includes('manager@test.invalid'));
 });
 await test('successful sign-in is audited only for active official profiles',async()=>{
  await role('postgres');await db.query("update cf_private.login_buckets set window_started_at=clock_timestamp()-interval '16 minutes'");
  await role('service_role');const a=await resolve('testmanager');assert(a.allowed);assert.equal(await finish(a.ticket,true),true);
  await role('postgres');const rows=(await db.query("select * from public.audit_events where action='LOGIN' and after_value->>'outcome'='success'")).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].username,'TestManager');assert.equal(rows[0].role_key,'gerente_geral');
 });
 await test('revoked JWT session loses RLS access and RPC writes immediately',async()=>{
  await claim();assert.equal((await db.query('select public.current_access() as r')).rows[0].r.profile.enabled,true);
  await role('service_role');await db.query('select public.revoke_application_session($1,$2,$3)',[uid,session,'test-agent']);
  await claim();await denied('select public.current_access()');assert.equal((await db.query('select * from public.profiles')).rows.length,0);
  await denied("select public.create_management_message('normal',null,'forbidden')");
  await denied('select public.manage_profile($1,$2,$3,$4,true)',[uid,'TestManager','Teste','gerente_geral']);
 });
 await test('a different session remains usable and blocking profile denies both broker and data access',async()=>{
  await claim('20000000-0000-4000-8000-000000000002');assert.equal((await db.query('select public.current_access() as r')).rows[0].r.profile.id,uid);
  await role('postgres');await db.query('update public.profiles set enabled=false where id=$1',[uid]);
  await claim('20000000-0000-4000-8000-000000000002');await denied('select public.current_access()');
  await role('service_role');const a=await resolve('testmanager');assert.equal(a.email,null);await finish(a.ticket,false);
 });
 await test('expired application approval denies data access independently of JWT expiration',async()=>{
  await role('postgres');await db.query('update public.profiles set enabled=true where id=$1',[uid]);
  await db.query("update cf_private.approved_sessions set expires_at=clock_timestamp()-interval '1 second' where session_id=$1",['20000000-0000-4000-8000-000000000002']);
  await claim('20000000-0000-4000-8000-000000000002');await denied('select public.current_access()');
 });
 await test('gateway tables enforce RLS and browser has no direct access',async()=>{
  await role('postgres');const r=await db.query("select tablename,rowsecurity from pg_tables where schemaname='cf_private'");assert.equal(r.rows.length,4);assert(r.rows.every(r=>r.rowsecurity));
  await role('authenticated');for(const t of ['login_buckets','login_attempts','revoked_sessions','approved_sessions'])await denied(`select * from cf_private.${t}`);
 });
}catch(e){failed++;console.error('SETUP FAILURE',e.message);}finally{await db.close();}
console.log(`${passed} passed; ${failed} failed (local PostgreSQL, emulated Supabase identity)`);if(failed)process.exitCode=1;
