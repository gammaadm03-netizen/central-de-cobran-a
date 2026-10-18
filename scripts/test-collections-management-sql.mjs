import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// PostgreSQL descartável. Nomes, datas relativas e valores são exclusivamente sintéticos.
const db=new PGlite(),roles=['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const uuid=n=>`95000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const users=Object.fromEntries(roles.map((role,index)=>[role,{id:uuid(index+1),session:uuid(index+11)}]));
const agents=[uuid(30),uuid(31)];let today,importId,sequence=100,passed=0,failed=0;
const sql=async(file)=>readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8');
const scalar=async(query,args=[]) => (await db.query(query,args)).rows[0].r;
const owner=()=>db.exec('RESET ROLE');
const asUser=async role=>{await owner();await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[users[role].id,JSON.stringify({session_id:users[role].session})]);await db.exec('SET ROLE authenticated');};
const summary=()=>scalar('SELECT public.collections_overdue_summary() AS r');
const reject=(query,args=[],code='42501')=>assert.rejects(db.query(query,args),error=>{assert.equal(error.code,code,error.message);return true;});
const test=async(name,run)=>{try{await run();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack??error.message);}};
const fixture=async(options={})=>{
 await owner();const n=++sequence,r={days:1,amount:1000,agent:agents[0],status:'OPEN',customer:`customer-${n}`,last:null,next:null,nextDays:null,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,
  amount_cents,collector_id,status,validation_status,payment_source,payment_date,first_import_id,last_import_id,last_action,next_action,next_action_date)
  VALUES('grupo-consolidado',$1,$2,$3,cf_private.receivable_customer_key($3,NULL),'Filial sintética',$4::date-$5::int,$6,$7,$8,$9,$10,
   CASE WHEN $8='VALIDATED' THEN $4::date ELSE NULL END,$11,$11,$12,$13,
   CASE WHEN $14::int IS NULL THEN NULL ELSE $4::date+$14::int END) RETURNING id AS r`,[
  `synthetic-${n}`,`NF-${n}`,r.customer,today,r.days,r.amount,r.agent,r.status,
  r.status==='PENDING_VALIDATION'?'PENDING':r.status==='VALIDATED'?'VALIDATED':'NONE',
  ['PENDING_VALIDATION','VALIDATED'].includes(r.status)?'IMPORTACAO_DIARIA':null,importId,r.last,r.next,r.nextDays]);
};
const snapshot=async()=>{await owner();const state={};for(const name of ['receivable_titles','receivable_imports','receivable_receipts','receivable_collection_events','audit_events'])state[name]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS r FROM public.${name} t`);return state;};

try{
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
  GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 for(const file of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql','007_director_positions.sql','008_receivables.sql','009_collections.sql'])await db.exec(await sql(file));
 const migration=await sql('025_collections_management.sql');
 await test('activation requires022 and leaves no partial function or registry marker',async()=>{
  await assert.rejects(db.exec(migration),e=>e.code==='22023');await db.exec('ROLLBACK');
  assert.equal(await scalar("SELECT to_regprocedure('public.collections_overdue_summary()')::text AS r"),null);
  assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='025_collections_management'"),0);
 });
 await db.exec(await sql('022_collections_overdue_only.sql'));
 for(const[role,u]of Object.entries(users)){
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[u.id,`${role}@example.invalid`]);
  await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)',[u.id,role]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[u.session,u.id]);
 }
 for(const[index,id]of agents.entries()){
  await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[id,`Responsável sintética ${index+1}`]);
  await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users[`cobradora_${index+1}`].id,id,users.gerente_geral.id]);
 }
 today=await scalar("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS r");
 await test('activation is read-only and independent of023024',async()=>{
  const before=await snapshot();await db.exec(migration);assert.deepEqual(await snapshot(),before);
  assert.equal(await scalar("SELECT prosecdef AS r FROM pg_proc WHERE oid='public.collections_overdue_summary()'::regprocedure"),false);
  assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version IN('023_receivable_stable_identity','024_receivable_paid_import')"),0);
 });
 await test('an empty visible overdue wallet returns explicit zero counts and six empty delay bands',async()=>{
  await asUser('gerente_geral');const s=await summary();assert.equal(s.as_of_date,today);assert.equal(s.overdue_count,0);assert.equal(s.overdue_cents,0);
  assert.equal(s.client_count,0);assert.equal(s.average_delay_days,0);assert.equal(s.by_delay_bands.length,6);assert(s.by_delay_bands.every(b=>b.title_count===0&&b.amount_cents===0));
 });
 await owner();importId=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count)
  VALUES('grupo-consolidado','synthetic.csv',repeat('a',64),$1,1,1,0,0,0) RETURNING id AS r`,[users.gerente_geral.id]);
 const boundaries=[1,30,31,60,61,90,91,180,181,365,366];
 for(const days of boundaries)await fixture({days,amount:days,customer:'shared-client'});
 const pending=await fixture({days:9,amount:800,agent:agents[1],status:'PENDING_VALIDATION',last:'PAID',next:'CONTACT',nextDays:0});
 await fixture({days:15,amount:900,agent:agents[1],status:'NOT_LOCATED',last:'PAYMENT_NOT_LOCATED',next:'RETRY',nextDays:-1});
 await fixture({days:20,amount:700,agent:null,status:'NEW'});
 await fixture({days:0,amount:555555});await fixture({days:-1,amount:666666});await fixture({days:10,amount:777777,status:'VALIDATED'});
 const total=boundaries.reduce((a,b)=>a+b,0)+2400;
 await test('all records are aggregated with exact delay boundaries, without pagination, today/future or validated history',async()=>{
  await asUser('gerente_geral');const s=await summary();assert.equal(s.overdue_cents,total);assert.equal(s.overdue_count,14);assert.equal(s.client_count,4);
  assert.deepEqual(s.by_delay_bands.map(b=>b.title_count),[5,2,2,2,2,1]);
  assert.equal(s.by_delay_bands.reduce((a,b)=>a+b.amount_cents,0),total);assert.equal(s.over_180_count,3);
  assert.equal(s.average_delay_days,Number(((boundaries.reduce((a,b)=>a+b,0)+44)/14).toFixed(1)));
 });
 await test('pending reports stay in the overdue wallet; contacts, return dates and unassigned debt have explicit counts',async()=>{
  await asUser('contas_receber');const s=await summary();assert.equal(s.pending_validation_count,1);assert.equal(s.pending_validation_cents,800);
  assert.equal(s.worked_count,2);assert.equal(s.no_action_count,12);assert.equal(s.returns_today_count,1);assert.equal(s.returns_overdue_count,1);
  assert.equal(s.unassigned_count,1);assert.equal(s.unassigned_cents,700);
  assert.equal(s.by_next_action.find(a=>a.action==='RETRY').title_count,1);assert.equal(s.by_status.find(a=>a.status==='NOT_LOCATED').title_count,1);
 });
 await test('each collector summary includes only their overdue assigned wallet and never another collector or unassigned statistics',async()=>{
  await asUser('cobradora_1');const a=await summary();assert.equal(a.overdue_count,11);assert.equal(a.client_count,1);assert.equal(a.overdue_cents,total-2400);
  assert.equal(a.unassigned_count,null);assert.equal(a.unassigned_cents,null);assert.equal(a.by_collector.length,1);assert.equal(a.by_collector[0].collector_id,agents[0]);
  await asUser('cobradora_2');const b=await summary();assert.equal(b.overdue_count,2);assert.equal(b.overdue_cents,1700);assert.equal(b.pending_validation_count,1);
  assert.equal(b.by_collector.length,1);assert.equal(b.by_collector[0].collector_id,agents[1]);assert.equal(b.over_180_count,0);
 });
 await test('the Director can read all debt and cannot write or validate titles',async()=>{
  await asUser('diretor');assert.equal((await summary()).overdue_cents,total);
  await reject('UPDATE public.receivable_titles SET amount_cents=1 WHERE id=$1',[pending]);
  await reject("SELECT public.validate_receivable_payment($1,'CONFIRM',$2,NULL,1)",[pending,today]);
 });
 await test('CP, RH, anonymous and service-only callers cannot invoke the collection summary',async()=>{
  for(const role of ['contas_pagar','rh_dp']){await asUser(role);await reject('SELECT public.collections_overdue_summary()');}
  for(const role of ['anon','service_role']){await owner();await db.exec(`SET ROLE ${role}`);await reject('SELECT public.collections_overdue_summary()');}
 });
 await test('blocking a login or revoking its collection permission takes effect immediately',async()=>{
  await owner();await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[users.cobradora_1.id]);await asUser('cobradora_1');await reject('SELECT public.collections_overdue_summary()');
  await owner();await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1',[users.cobradora_1.id]);
  await db.exec("DELETE FROM public.role_permissions WHERE role_key='cobradora_1' AND resource='cobranca' AND action='read'");await asUser('cobradora_1');await reject('SELECT public.collections_overdue_summary()');
  await owner();await db.exec("INSERT INTO public.role_permissions VALUES('cobradora_1','cobranca','read')");
 });
 await test('an unbound collector has an empty wallet rather than group-wide totals',async()=>{
  await owner();await db.query('DELETE FROM public.collector_bindings WHERE user_id=$1',[users.cobradora_2.id]);await asUser('cobradora_2');const s=await summary();assert.equal(s.overdue_count,0);assert.equal(s.overdue_cents,0);assert.deepEqual(s.by_collector,[]);
 });
 await test('GET calls never mutate titles, imports, receipts, contact history or audit',async()=>{
  const before=await snapshot();for(const role of ['gerente_geral','diretor','contas_receber','cobradora_1']){await asUser(role);await summary();}assert.deepEqual(await snapshot(),before);
 });
 await test('the official civil day is São Paulo independently of connection time zone',async()=>{
  for(const zone of ['UTC','Pacific/Kiritimati','America/Los_Angeles']){await asUser('gerente_geral');await db.query("SELECT set_config('TimeZone',$1,false)",[zone]);assert.equal((await summary()).as_of_date,today);}
 });
 await test('financial validation removes the title from active statistics without deleting historical information',async()=>{
  await asUser('contas_receber');await scalar("SELECT public.validate_receivable_payment($1,'CONFIRM',$2,'Conferência sintética',1) AS r",[pending,today]);
  const s=await summary();assert.equal(s.overdue_cents,total-800);assert.equal(s.pending_validation_count,0);
  assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts WHERE title_id=$1',[pending]),1);
  assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_overdue_titles WHERE id=$1',[pending]),1);
 });
 await test('unsafe totals are refused without rounding; another collector is not affected by hidden amounts',async()=>{
  await fixture({amount:Number.MAX_SAFE_INTEGER});await fixture({amount:Number.MAX_SAFE_INTEGER});
  await asUser('gerente_geral');await reject('SELECT public.collections_overdue_summary()',[],'22003');
  await asUser('cobradora_1');await reject('SELECT public.collections_overdue_summary()',[],'22003');
  await asUser('cobradora_2');assert.equal((await summary()).overdue_cents,0);
 });
}finally{await db.close();}
console.log(`\n${passed} passed; ${failed} failed.`);if(failed)process.exitCode=1;
