import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildDirectorAccessSql } from './bundle-director-access.mjs';
// PostgreSQL descartável. Contas e documentos exclusivamente sintéticos.
const db=new PGlite(),roles=['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const id=n=>`99000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const users=Object.fromEntries(roles.map((role,index)=>[role,{id:id(index+1),session:id(index+11)}]));
const agents=[id(31),id(32)],readResources=['painel','caixa','contas_pagar','contas_receber','cobranca','comissoes','faturamento','margens','rh_dp','resumo_diretoria','mensagens_cp','usuarios','configuracoes','auditoria'];
let passed=0,failed=0,today,payableId,receivableId,messageId,bankId,crImport;
const migration=await readFile(new URL('../supabase/migrations/031_director_readonly.sql',import.meta.url),'utf8');
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].r;
const owner=()=>db.exec('RESET ROLE');
const actor=async(role='diretor',session=users[role].session,extra={})=>{await owner();await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[
 users[role].id,JSON.stringify({...(session?{session_id:session}:{}),...extra})]);await db.exec('SET ROLE authenticated');};
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack??e.message,JSON.stringify({where:e.where,position:e.position}));}};
const reject=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
const access=()=>scalar('SELECT public.current_access() AS r');
const permits=(resource,action='read')=>scalar('SELECT cf_private.has_permission($1,$2) AS r',[resource,action]);
const rows=table=>scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS r FROM ${table} t`);
const allState=async()=>{await owner();const tables=(await db.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN ('auth','public','cf_private','storage') ORDER BY schemaname,tablename")).rows.map(r=>r.name);
 const out={};for(const t of tables)out[t]=await rows(t);return out;};
try{
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 await test('031 fails atomically without the approved-session application base',async()=>{
  await reject(()=>db.exec(migration),'22023');await db.exec('ROLLBACK');assert.equal(await scalar("SELECT to_regprocedure('cf_private.director_read_allowed(text)')::text AS r"),null);
 });
 const names=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(name=>/^\d{3}_.*\.sql$/.test(name)&&Number(name.slice(0,3))<31).sort();
 for(const name of names){
  if(name.startsWith('028_'))await db.exec(`CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;`);
  await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
 }
 for(const[role,u]of Object.entries(users)){await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[u.id,`${role}@example.invalid`]);await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)',[u.id,role]);await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[u.session,u.id]);}
 for(const[index,agent]of agents.entries()){await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,`Responsável sintética ${index+1}`]);await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users[`cobradora_${index+1}`].id,agent,users.gerente_geral.id]);}
 today=await scalar("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS r");
 bankId=await scalar('SELECT id AS r FROM public.bank_accounts WHERE enabled ORDER BY id LIMIT 1');
 const cpImport=await scalar(`INSERT INTO public.payable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count)
 VALUES('grupo-consolidado','synthetic-payables.csv',repeat('b',64),$1,1,1,0,0) RETURNING id AS r`,[users.gerente_geral.id]);
 payableId=await scalar(`INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,source_status,plan,macro,bank_account,branch,status,first_import_id,last_import_id)
 VALUES('grupo-consolidado','synthetic-source','CP-SYNTHETIC','Fornecedor sintético',$1,12345,'ABERTO','INVESTIMENTOS','FIXO','Banco sintético','Filial sintética','OPEN',$2,$2) RETURNING id AS r`,[today,cpImport]);
 crImport=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count)
 VALUES('grupo-consolidado','synthetic-receivables.csv',repeat('c',64),$1,1,1,0,0,0) RETURNING id AS r`,[users.gerente_geral.id]);
 for(const[index,collector]of agents.entries()){
  const titleId=await scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,first_import_id,last_import_id)
  VALUES('grupo-consolidado',$1,$2,$3,cf_private.receivable_customer_key($3,NULL),'Filial sintética',$4::date-10,$5,$6,'OPEN','NONE',$7,$7) RETURNING id AS r`,[
   `synthetic-${index}`,`NF-${index}`,`Cliente sintético ${index}`,today,10000+index,collector,crImport]);if(index===0)receivableId=titleId;
 }
 await actor('gerente_geral');await scalar('SELECT public.set_bank_balance($1,$2,$3,$4,NULL) AS r',[bankId,today,45678,'Saldo sintético']);
 await scalar('SELECT public.save_manual_stock($1,$2,$3) AS r',[98765,today,'Estoque sintético']);
 messageId=await scalar('SELECT public.create_management_message($1,$2,$3) AS r',['normal',null,'Mensagem sintética preservada']);
 await actor();assert.equal(await permits('mensagens_cp','write'),true);assert.equal(await permits('importar_bases'),true);
 await owner();await db.exec("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('diretor','usuarios','admin'),('diretor','caixa','import'),('diretor','contas_receber','validate') ON CONFLICT DO NOTHING;");
 await test('activation changes only Director grants and adds permission audit without provisioning accounts or touching financial/auth/history data',async()=>{
  const before=await allState();await db.exec(await buildDirectorAccessSql());const after=await allState();
  for(const[table,value]of Object.entries(before))if(!['public.role_permissions','public.audit_events','public.central_schema_migrations','cf_private.collection_context_state'].includes(table))assert.deepEqual(after[table],value,table);
  assert.deepEqual(after['public.role_permissions'].filter(p=>p.role_key!=='diretor'),before['public.role_permissions'].filter(p=>p.role_key!=='diretor'));
  const oldAudit=new Set(before['public.audit_events'].map(e=>e.id));assert(before['public.audit_events'].every(e=>after['public.audit_events'].some(a=>a.id===e.id&&JSON.stringify(a)===JSON.stringify(e))));
  assert(after['public.audit_events'].filter(e=>!oldAudit.has(e.id)).every(e=>e.entity==='role_permissions'&&e.record_id.startsWith('diretor/')));
  assert(after['cf_private.collection_context_state'][0].revision>before['cf_private.collection_context_state'][0].revision,'Authorization fence must change when permissions change');
  assert.equal(after['auth.users'].length,roles.length);assert.equal(after['public.profiles'].length,roles.length);
 });
 await test('standalone dashboard artifact matches its guarded generator, and activation is repeatable without audit or financial mutations',async()=>{
  assert.equal(await readFile(new URL('../supabase/dashboard/ativar-acesso-diretoria.sql',import.meta.url),'utf8'),await buildDirectorAccessSql());
  const before=await allState();await db.exec(migration);assert.deepEqual(await allState(),before);
  assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='031_director_readonly'"),1);
 });
 await test('approved Director receives every read tab plus financial exports, with no Importar Bases or mutation permissions',async()=>{
  await actor();const a=await access();assert.equal(a.profile.id,users.diretor.id);assert.equal(a.profile.role_key,'diretor');assert.equal(a.collector_id,null);
  for(const resource of readResources){assert.equal(await permits(resource),true,resource);assert(a.permissions.some(p=>p.resource===resource&&p.action==='read'),resource);}
  for(const resource of readResources)for(const action of ['write','import','validate','admin'])assert.equal(await permits(resource,action),false,`${resource}.${action}`);
  assert(a.permissions.every(p=>['read','export'].includes(p.action)&&p.resource!=='importar_bases'));assert.equal(await permits('contas_pagar','export'),true);
 });
 await test('Director can read users, collectors, login bindings and immutable audit across the organization',async()=>{
  await actor();assert.equal((await rows('public.profiles')).length,roles.length);assert.equal((await rows('public.collection_agents')).length,2);
  assert.equal((await rows('public.collector_bindings')).length,2);assert((await rows('public.audit_events')).some(e=>e.entity==='profiles'&&e.record_id===users.contas_pagar.id));
  assert.equal((await rows('public.management_messages')).find(m=>m.id===messageId).message,'Mensagem sintética preservada');
 });
 await test('Director financial reading and summaries retain complete authorized data and create no snapshots or receipts',async()=>{
  const before=await allState();await actor();assert.equal((await rows('public.payable_titles')).find(t=>t.id===payableId).amount_cents,12345);
  assert.equal((await rows('public.receivable_titles')).length,2);assert.equal((await rows('public.bank_accounts')).length,17);
  assert.equal((await scalar('SELECT public.payables_summary($1,$1) AS r',[today])).open_cents,12345);
  assert.equal((await scalar('SELECT public.collection_workbench() AS r')).count,2);
  assert.equal((await scalar('SELECT public.receivable_commission_base($1,$1,NULL,0,25) AS r',[today])).count,0);
  assert.equal((await scalar('SELECT public.current_stock() AS r')).value_cents,98765);
  assert(await scalar('SELECT public.director_report($1,$1) AS r',[today]));assert.deepEqual(await allState(),before);
 });
 await test('Director cannot send messages, change their status, alter profiles or bind/configure collectors',async()=>{
  const before=await allState();await actor();await reject(()=>scalar("SELECT public.create_management_message('normal',NULL,'Envio proibido') AS r"));
  await reject(()=>scalar('SELECT public.set_management_message_status($1,$2) AS r',[messageId,'concluida']));
  await reject(()=>scalar('SELECT public.manage_profile($1,$2,$3,$4,true) AS r',[users.contas_pagar.id,'NovoLogin','Alteração indevida','gerente_geral']));
  await reject(()=>scalar('SELECT public.manage_profile($1,$2,$3,$4,true) AS r',[id(99),'SemAuth','Sem conta','diretor']));
  await reject(()=>scalar('SELECT public.configure_collection_agent($1,$2,true) AS r',[agents[0],'Troca indevida']));await reject(()=>scalar('SELECT public.bind_collector($1,$2) AS r',[users.cobradora_1.id,agents[1]]));
  assert.deepEqual(await allState(),before);
 });
 await test('direct DML and financial/collection mutation RPCs are denied without changing balances, titles, receipts or audit',async()=>{
  const before=await allState();await actor();for(const query of [
   "UPDATE public.profiles SET display_name='Indevido'",'DELETE FROM public.collector_bindings',"UPDATE public.management_messages SET status='concluida'",
   "INSERT INTO public.role_permissions(role_key,resource,action) VALUES('diretor','usuarios','admin')","UPDATE public.payable_titles SET amount_cents=1","UPDATE public.receivable_titles SET amount_cents=1"])
   await reject(()=>db.query(query));
  await reject(()=>scalar('SELECT public.set_bank_balance($1,$2,1,$3,NULL) AS r',[bankId,today,'Indevido']));await reject(()=>scalar('SELECT public.save_manual_stock(1,$1,$2) AS r',[today,'Indevido']));
  await reject(()=>scalar('SELECT public.collection_work_action($1,$2,1,$3) AS r',[receivableId,'START',id(90)]));
  await reject(()=>scalar('SELECT public.validate_receivable_payment($1,$2,$3,$4,1) AS r',[receivableId,'CONFIRM',today,'Indevido']));
  await reject(()=>scalar('SELECT public.register_payable_payment($1,12345,$2,$3,$4,NULL,$5,NULL) AS r',[payableId,today,bankId,'Indevido',id(91)]));
  assert.deepEqual(await allState(),before);
 });
 await test('injected stale Director permissions cannot restore sending, write, import, validation, administration or Importar Bases',async()=>{
  await owner();await db.exec("INSERT INTO public.role_permissions(role_key,resource,action) SELECT 'diretor',r.resource,a.action FROM (VALUES('mensagens_cp'),('caixa'),('contas_pagar'),('contas_receber'),('cobranca'),('usuarios'),('configuracoes'),('recurso_futuro'),('importar_bases'))r(resource) CROSS JOIN (VALUES('read'),('write'),('import'),('validate'),('admin'),('export'))a(action) ON CONFLICT DO NOTHING;");
  const before=await allState();await actor('diretor',users.diretor.session,{role:'gerente_geral',user_metadata:{role:'gerente_geral'}});
  for(const resource of [...readResources,'recurso_futuro','importar_bases'])for(const action of ['write','import','validate','admin'])assert.equal(await permits(resource,action),false);
  for(const action of ['read','export'])assert.equal(await permits('importar_bases',action),false);
  assert((await access()).permissions.every(p=>['read','export'].includes(p.action)&&p.resource!=='importar_bases'));
  await reject(()=>scalar("SELECT public.create_management_message('normal',NULL,'Permissão antiga') AS r"));await reject(()=>scalar('SELECT public.set_management_message_status($1,$2) AS r',[messageId,'concluida']));
  await reject(()=>scalar('SELECT public.manage_profile($1,$2,$3,$4,true) AS r',[users.contas_pagar.id,'ContasPagar','Indevido','gerente_geral']));
  await reject(()=>scalar('SELECT public.preview_receivables_open_import($1,$2::jsonb) AS r',['grupo-consolidado','[]']));assert.deepEqual(await allState(),before);
  await db.exec(migration);
 });
 await test('other official roles retain their own scopes and Director metadata does not grant administrative reading',async()=>{
  await actor('contas_pagar',users.contas_pagar.session,{user_metadata:{role:'diretor'}});assert.equal((await rows('public.profiles')).length,1);assert.equal((await rows('public.collection_agents')).length,0);assert.equal((await rows('public.audit_events')).length,0);
  assert.equal(await scalar("SELECT cf_private.director_read_allowed('usuarios') AS r"),false);
  await actor('cobradora_1');assert.equal((await rows('public.profiles')).length,1);assert.equal((await rows('public.collection_agents')).length,1);assert.equal((await rows('public.collector_bindings')).length,1);
  const r=await scalar('SELECT public.collection_workbench() AS r');assert.equal(r.count,1);assert.equal(r.rows[0].collector_id,agents[0]);
 });
 await test('manager still writes messages and profiles; all other role grants remain unchanged',async()=>{
  await owner();const before=(await rows('public.role_permissions')).filter(p=>p.role_key!=='diretor');await actor('gerente_geral');assert.equal(await permits('mensagens_cp','write'),true);assert.equal(await permits('usuarios','admin'),true);
  const message=await scalar("SELECT public.create_management_message('normal',NULL,'Mensagem da Gerência') AS r");await scalar('SELECT public.set_management_message_status($1,$2) AS r',[message,'concluida']);
  await scalar('SELECT public.manage_profile($1,$2,$3,$4,true) AS r',[users.contas_pagar.id,'contas_pagar','Nome sintético revisado','contas_pagar']);
  await owner();assert.equal(await scalar('SELECT display_name AS r FROM public.profiles WHERE id=$1',[users.contas_pagar.id]),'Nome sintético revisado');assert.deepEqual((await rows('public.role_permissions')).filter(p=>p.role_key!=='diretor'),before);
 });
 await test('missing, unapproved, expired, revoked and mismatched sessions fail both RPC and direct administrative reads',async()=>{
  const assertDenied=async()=>{await reject(()=>access());assert.equal(await permits('usuarios'),false);for(const t of ['public.profiles','public.collection_agents','public.collector_bindings','public.audit_events','public.management_messages'])assert.equal((await rows(t)).length,0,t);};
  await actor('diretor',null);await assertDenied();await actor('diretor',id(98));await assertDenied();await actor('diretor',users.gerente_geral.session);await assertDenied();
  await owner();await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",[users.diretor.session]);await actor();await assertDenied();
  await owner();await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()+interval '12 hours' WHERE session_id=$1",[users.diretor.session]);await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[users.diretor.session,users.diretor.id]);await actor();await assertDenied();
  await owner();await db.query('DELETE FROM cf_private.revoked_sessions WHERE session_id=$1',[users.diretor.session]);
 });
 await test('disabled Director cannot read the directory, audit, financial data or current_access',async()=>{
  await owner();await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[users.diretor.id]);await actor();await reject(()=>access());assert.equal(await permits('contas_pagar'),false);
  for(const t of ['public.profiles','public.audit_events','public.payable_titles','public.receivable_titles','public.bank_accounts'])assert.equal((await rows(t)).length,0,t);
  await owner();await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1',[users.diretor.id]);
 });
 await test('Director cannot inspect Auth users, approved sessions or the private login broker; anonymous and service roles gain no app RPC access',async()=>{
  await actor();for(const t of ['auth.users','cf_private.approved_sessions','cf_private.revoked_sessions'])await reject(()=>db.query(`SELECT * FROM ${t}`));await reject(()=>scalar('SELECT public.resolve_login($1,$2) AS r',['gerente_geral','a'.repeat(64)]));
  for(const role of ['anon','service_role']){await owner();await db.exec(`SET ROLE ${role}`);await reject(()=>access());await reject(()=>scalar("SELECT cf_private.director_read_allowed('usuarios') AS r"));}
 });
}catch(e){failed++;console.error('SETUP FAILURE',e.stack??e.message,JSON.stringify({where:e.where,position:e.position}));}
finally{await db.close();}
console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
