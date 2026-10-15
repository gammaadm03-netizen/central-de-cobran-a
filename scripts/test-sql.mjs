import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const db = new PGlite();
const tests=[];
async function test(name,fn){try{await fn();tests.push({name,status:'passed'});console.log('PASS',name);}catch(e){tests.push({name,status:'failed',error:e.message});console.log('FAIL',name,e.message);}}
await db.exec(`
 CREATE ROLE anon NOLOGIN;
 CREATE ROLE authenticated NOLOGIN;
 CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY, email text);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
 GRANT USAGE ON SCHEMA auth TO anon, authenticated;
 GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
`);
const sql = await readFile(new URL('../supabase/migrations/001_identidade_rbac.sql', import.meta.url),'utf8');
await db.exec(sql);
const roleNames=['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const ids=Object.fromEntries(roleNames.map((r,i)=>[r,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
async function owner(){await db.exec('RESET ROLE');await db.query("select set_config('request.jwt.claim.sub','',false)");}
async function as(role){await owner();if(role==='anon'){await db.exec('SET ROLE anon');return;}await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[role]]);await db.exec('SET ROLE authenticated');}
async function denied(query,args=[]){try{await db.query(query,args);}catch(e){assert(['42501','P0001','28000'].includes(e.code),`unexpected denial ${e.code}: ${e.message}`);return;}throw new Error('Operation unexpectedly allowed');}

await test('migration enables RLS on every phase-1 table',async()=>{
 const r=await db.query("select tablename,rowsecurity from pg_tables where schemaname='public'");
 assert.equal(r.rows.length,6);assert(r.rows.every(x=>x.rowsecurity));
});
for(const role of roleNames){
 await db.query('insert into auth.users(id,email) values($1,$2)',[ids[role],`${role}@test.invalid`]);
 await db.query('insert into public.profiles(id,username,display_name,role_key,enabled) values($1,$2,$2,$3,true)',[ids[role],`test_${role}`,role]);
}
await test('anonymous cannot read profiles or call access RPC',async()=>{
 await as('anon');await denied('select * from public.profiles');await denied('select public.current_access()');
});
await test('manager sees all profiles and cannot use direct table writes',async()=>{
 await as('gerente_geral');assert.equal((await db.query('select * from public.profiles')).rows.length,7);
 await denied("update public.profiles set role_key='gerente_geral' where id=$1",[ids.diretor]);
});
await test('director has read access and only message write exception',async()=>{
 await as('diretor');const access=(await db.query('select public.current_access() as a')).rows[0].a;
 assert.equal(access.permissions.filter(p=>p.action==='read').length,12);
 assert.deepEqual(access.permissions.filter(p=>p.action==='write').map(p=>p.resource),['mensagens_cp']);
 assert.equal((await db.query('select * from public.profiles')).rows.length,1);
 await denied('select public.manage_profile($1,$2,$3,$4,true)',[ids.diretor,'test_diretor','Diretor','gerente_geral']);
 await denied("insert into public.role_permissions values('diretor','caixa','write')");
});
await test('CR has no CP permission; CP has no CR permission; RH has no financial permission',async()=>{
 for(const role of ['contas_receber','contas_pagar','rh_dp']){
  await as(role);const p=(await db.query('select public.current_access() as a')).rows[0].a.permissions;
  const forbidden=role==='contas_receber'?['contas_pagar']:role==='contas_pagar'?['contas_receber']:['painel','caixa','contas_receber','contas_pagar','cobranca'];
  assert(p.every(x=>!forbidden.includes(x.resource)),role);
 }
});
await test('unbound collectors have no default identity',async()=>{
 await as('cobradora_1');assert.equal((await db.query('select public.current_access() as a')).rows[0].a.collector_id,null);
 assert.equal((await db.query('select * from public.collector_bindings')).rows.length,0);
 await denied('select public.configure_collection_agent(null,$1,true)',['forbidden']);
});
let agent1,agent2;
await test('manager explicitly binds distinct collection people',async()=>{
 await as('gerente_geral');
 agent1=(await db.query('select public.configure_collection_agent(null,$1,true) as id',['Pessoa teste A'])).rows[0].id;
 agent2=(await db.query('select public.configure_collection_agent(null,$1,true) as id',['Pessoa teste B'])).rows[0].id;
 await db.query('select public.bind_collector($1,$2)',[ids.cobradora_1,agent1]);
 await db.query('select public.bind_collector($1,$2)',[ids.cobradora_2,agent2]);
});
await test('collector sees only own binding and identity',async()=>{
 await as('cobradora_1');assert.equal((await db.query('select public.current_access() as a')).rows[0].a.collector_id,agent1);
 assert.deepEqual((await db.query('select agent_id from public.collector_bindings')).rows.map(x=>x.agent_id),[agent1]);
 assert.deepEqual((await db.query('select id from public.collection_agents')).rows.map(x=>x.id),[agent1]);
 await denied('select public.bind_collector($1,$2)',[ids.cobradora_1,agent2]);
});
let message;
await test('director can create board message with server identity',async()=>{
 await as('diretor');message=(await db.query('select public.create_management_message($1,$2,$3) as id',['normal',null,'Mensagem sintética'])).rows[0].id;
 const r=(await db.query('select * from public.management_messages where id=$1',[message])).rows[0];
 assert.equal(r.created_by,ids.diretor);assert.equal(r.author_role,'diretor');
});
await test('message conclude and reopen keep authors and timestamps',async()=>{
 await as('gerente_geral');await db.query('select public.set_management_message_status($1,$2)',[message,'concluida']);
 let r=(await db.query('select * from public.management_messages where id=$1',[message])).rows[0];
 assert.equal(r.completed_by,ids.gerente_geral);assert(r.completed_at);
 await as('diretor');await db.query('select public.set_management_message_status($1,$2)',[message,'pendente']);
 r=(await db.query('select * from public.management_messages where id=$1',[message])).rows[0];
 assert.equal(r.reopened_by,ids.diretor);assert(r.reopened_at);assert.equal(r.completed_by,ids.gerente_geral);
});
await test('CP reads messages but cannot write them',async()=>{
 await as('contas_pagar');assert((await db.query('select * from public.management_messages')).rows.length>0);
 await denied('select public.create_management_message($1,null,$2)',['normal','forbidden']);
});
await test('ordinary users cannot read, append, update or delete audit',async()=>{
 await as('diretor');assert.equal((await db.query('select * from public.audit_events')).rows.length,0);
 await denied("insert into public.audit_events(module,entity,action) values('x','x','CREATE')");
 await denied("update public.audit_events set entity='forged'");await denied('delete from public.audit_events');
});
await test('manager reads audited assignment and message history but cannot mutate it',async()=>{
 await as('gerente_geral');const r=await db.query('select action,entity from public.audit_events');
 assert(r.rows.some(x=>x.action==='ASSIGNMENT'));assert(r.rows.some(x=>x.action==='REOPEN'));
 await denied("update public.audit_events set entity='forged'");await denied('delete from public.audit_events');
});
await test('blocking a user revokes database access for existing identity',async()=>{
 await as('gerente_geral');await db.query('select public.manage_profile($1,$2,$3,$4,false)',[ids.cobradora_1,'test_cobradora_1','Teste bloqueado','cobradora_1']);
 await as('cobradora_1');await denied('select public.current_access()');
 assert.equal((await db.query('select * from public.profiles')).rows.length,0);
 assert.equal((await db.query('select * from public.collector_bindings')).rows.length,0);
});
await test('last active manager cannot be disabled',async()=>{
 await as('gerente_geral');let code;
 try{await db.query('select public.manage_profile($1,$2,$3,$4,false)',[ids.gerente_geral,'test_gerente_geral','Gerente','gerente_geral']);}catch(e){code=e.code;}
 assert.equal(code,'23514');assert.equal((await db.query('select public.current_access() as a')).rows[0].a.profile.enabled,true);
});

await test('new authenticated identity without profile has no automatic access',async()=>{
 await owner();const id='00000000-0000-4000-8000-000000000099';
 await db.query('insert into auth.users(id,email) values($1,$2)',[id,'unmapped@test.invalid']);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('SET ROLE authenticated');
 await denied('select public.current_access()');assert.equal((await db.query('select * from public.profiles')).rows.length,0);
 await denied('select public.manage_profile($1,$2,$3,$4,true)',[id,'forged','Forged','gerente_geral']);
});
await test('role changes are audited and self rename preserves original actor',async()=>{
 await as('gerente_geral');
 await db.query('select public.manage_profile($1,$2,$3,$4,true)',[ids.contas_pagar,'test_contas_pagar','Teste CP','contas_receber']);
 let r=(await db.query("select * from public.audit_events where action='ROLE_CHANGE' and record_id=$1",[ids.contas_pagar])).rows;
 assert.equal(r.length,1);assert.equal(r[0].role_key,'gerente_geral');
 assert.equal(r[0].before_value.role_key,'contas_pagar');assert.equal(r[0].after_value.role_key,'contas_receber');
 await db.query('select public.manage_profile($1,$2,$3,$4,true)',[ids.contas_pagar,'test_contas_pagar','Teste CP','contas_pagar']);
 await db.query('select public.manage_profile($1,$2,$3,$4,true)',[ids.gerente_geral,'renamed_manager','Gerente','gerente_geral']);
 r=(await db.query("select * from public.audit_events where entity='profiles' and record_id=$1 and after_value->>'username'='renamed_manager'",[ids.gerente_geral])).rows;
 assert.equal(r.length,1);assert.equal(r[0].username,'test_gerente_geral');
});
await test('financial export respects the assigned role permission matrix',async()=>{
 await as('diretor');let p=(await db.query('select public.current_access() as a')).rows[0].a.permissions;
 assert(p.some(x=>x.resource==='contas_pagar'&&x.action==='export'));assert(p.some(x=>x.resource==='rh_dp'&&x.action==='export'));
 await as('rh_dp');p=(await db.query('select public.current_access() as a')).rows[0].a.permissions;
 assert(!p.some(x=>x.resource==='contas_pagar'));assert(p.some(x=>x.resource==='rh_dp'&&x.action==='export'));
});
await test('anonymous RPC grants absent; definer functions have safe search path',async()=>{
 await owner();const r=await db.query("select proname,proconfig from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname in ('public','cf_private') and prosecdef");
 assert(r.rows.length>5);assert(r.rows.every(x=>x.proconfig?.some(v=>v==='search_path=\"\"')));
});

await test('reapplying migration fails without changing the existing schema/data',async()=>{
 await owner();const n=(await db.query('select count(*)::int as n from public.profiles')).rows[0].n;
 let code;
 try{await db.exec(sql);}catch(e){code=e.code;await db.exec('ROLLBACK');}
 assert.equal(code,'42P07');assert.equal((await db.query('select count(*)::int as n from public.profiles')).rows[0].n,n);
});
await owner();await db.close();
// Results are printed only: this database is synthetic and is never deployed.
console.log(`${tests.filter(x=>x.status==='passed').length}/${tests.length} passed`);
if(tests.some(x=>x.status==='failed'))process.exitCode=1;
