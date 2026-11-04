import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivableImportCompletionSql } from './bundle-receivable-import-completion.mjs';
import { buildCollectionReturnPriorityRequiredSql } from './bundle-collection-return-priority-required.mjs';
import { buildCollectionTitleTimeSql } from './bundle-collection-title-time.mjs';

// PostgreSQL local descartável. Títulos, perfis, pagamentos e nomes são sintéticos.
const f=await createCostFixture(),{db,users,id,scalar,owner,actor,file,snapshot}=f;
let passed=0,seq=67000,today,now,agents,importId,main,other,unassigned,future,hidden,installer;
const timerSignature='cf_private.collection_workbench_timer(uuid,timestamp with time zone)';
const definition=signature=>scalar('SELECT pg_get_functiondef($1::regprocedure) r',[signature]);
const definitions=async()=>Object.fromEntries((await db.query(`SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','cf_private') AND p.prokind='f' ORDER BY 1`)).rows.map(r=>[r.signature,r.definition]));
const access=()=>scalar(`SELECT jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',p.proowner,'acl',p.proacl,
  'definer',p.prosecdef,'config',p.proconfig,'strict',p.proisstrict,'volatility',p.provolatile,'parallel',p.proparallel,
  'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid)) ORDER BY p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','cf_private') AND p.prokind='f'),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity) ORDER BY c.oid)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','cf_private') AND c.relkind IN('r','v','m','S')),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.schemaname,p.tablename,p.policyname) FROM pg_policies p WHERE schemaname IN('public','cf_private'))) r`);
const title=async({collector=agents[1],days=30,amount=10000,status='OPEN'}={})=>{
 await owner();const n=++seq;
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,
  collector_id,status,validation_status,payment_source,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$1,$2,cf_private.receivable_customer_key($2,NULL),'Filial sintética',$3::date-$4::int,$5,$6,$8,
  CASE WHEN $8='PENDING_VALIDATION' THEN 'PENDING' ELSE 'NONE' END,CASE WHEN $8='PENDING_VALIDATION' THEN 'IMPORTACAO_DIARIA' END,$7,$7) RETURNING id r`,[
  `NF-TIME-SYN-${n}`,`Cliente sintético ${n}`,today,days,amount,collector,importId,status]);
};
const session=async(titleId,user,seconds,{running=false,collector=agents[1],start=null}={})=>{
 await owner(user);
 return scalar(`INSERT INTO public.collection_work_sessions(title_id,actor_id,collector_id,document_snapshot,client_name_snapshot,branch_snapshot,collector_name_snapshot,
  started_at,ended_at,end_reason)
 SELECT id,$2,$3,document,client_name,branch,'Cobradora sintética',$4::timestamptz-make_interval(secs=>$5),
  CASE WHEN $6 THEN NULL ELSE $4::timestamptz END,CASE WHEN $6 THEN NULL ELSE 'PAUSE' END
 FROM public.receivable_titles WHERE id=$1 RETURNING id r`,[titleId,users[user].id,collector,start??now,seconds,running]);
};
const detail=titleId=>scalar('SELECT public.collection_case_detail($1) r',[titleId]);
const list=()=>scalar("SELECT public.collection_workbench('',NULL,false,NULL,'delay_desc',NULL,0,500,'active',NULL,NULL,NULL,NULL) r");
const timer=async(titleId,user,at=now)=>{await owner(user);return scalar('SELECT cf_private.collection_workbench_timer($1,$2::timestamptz) r',[titleId,at]);};
const test=async(name,fn)=>{
 await owner();await db.exec('BEGIN');
 try{await fn();passed++;console.log('PASS',name)}
 finally{await db.exec('ROLLBACK');await owner()}
};
const reject=async(fn,code='42501')=>{
 await db.exec('SAVEPOINT expected_failure');
 try{await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}
 finally{await db.exec('ROLLBACK TO SAVEPOINT expected_failure;RELEASE SAVEPOINT expected_failure')}
};
const withoutMigration=s=>{const r=structuredClone(s);delete r['public.central_schema_migrations'];return r};

try{
 installer=await readFile(new URL('../supabase/dashboard/ativar-tempo-total-titulo-cobranca.sql',import.meta.url),'utf8');
 assert.equal(installer,await buildCollectionTitleTimeSql());
 assert.equal((installer.match(/^BEGIN;\s*$/gm)??[]).length,1);assert.equal((installer.match(/^COMMIT;\s*$/gm)??[]).length,1);
 await owner();
 for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql','054_collection_operational_statuses.sql'])await db.exec(await file(name));
 await db.exec(await buildReceivableImportCompletionSql());
 await db.exec(await buildCollectionReturnPriorityRequiredSql());
 today=await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");
 now=await scalar("SELECT statement_timestamp()::text r");
 users.collector2={id:id(++seq),session:id(++seq),role:'cobradora_2'};
 await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[users.collector2.id,'collector2-time-synthetic@example.invalid']);
 await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[
  users.collector2.id,'TimeSynthetic_collector2','Emanuelle sintética','cobradora_2']);
 await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[users.collector2.session,users.collector2.id]);
 agents=[id(++seq),id(++seq)];
 for(const [i,user]of ['collector','collector2'].entries()){
  await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agents[i],`Cobradora sintética ${i+1}`]);
  await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users[user].id,agents[i],users.manager.id]);
 }
 importId=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode)
  VALUES('grupo-consolidado','title-time-synthetic.csv',repeat('e',64),$1,5,5,0,0,0,'OPEN') RETURNING id r`,[users.cr.id]);
 main=await title();other=await title({collector:agents[0]});unassigned=await title({collector:null});future=await title({days:-5});hidden=await title({collector:agents[0]});
 await session(main,'manager',85);await session(main,'collector2',2198);
 await session(other,'collector',120,{collector:agents[0]});await session(other,'manager',15,{collector:agents[0]});
 await session(unassigned,'manager',60);await session(future,'manager',100);
 await session(hidden,'manager',50,{collector:agents[0]});await session(hidden,'collector2',20,{running:true});
 await owner();
 // Preserve a genuine receipt and unrelated financial position during activation.
 const paid=await title({amount:12345,status:'PENDING_VALIDATION'});
 await actor('cr');const paidTitle=await scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[paid]);
 assert((await scalar("SELECT public.validate_receivable_payment_v2($1,'CONFIRM',$2,$3,NULL,$4,$5,$6) r",[
  paid,today,12345,'Pagamento sintético verdadeiro',paidTitle.revision,randomUUID()])).receipt_id);
 await owner();
 await db.query(`INSERT INTO public.bank_balance_positions(account_id,balance_date,amount_cents,observation,created_by)
  SELECT id,$1,456789,'Posição sintética preservada',$2 FROM public.bank_accounts ORDER BY id LIMIT 1`,[today,users.manager.id]);

 const before=await snapshot(),beforeAccess=await access(),beforeDefinitions=await definitions();
 const beforeManager=await timer(main,'manager'),beforeCollector=await timer(main,'collector2');
 assert.equal(beforeManager.total_seconds,2283);assert.equal(beforeManager.actor_total_seconds,85);
 assert.equal(beforeCollector.total_seconds,2198);assert.equal(beforeCollector.actor_total_seconds,2198);
 await owner();assert.equal(await scalar("SELECT count(*)::integer r FROM public.central_schema_migrations WHERE version='067_collection_title_time'"),0);
 await db.exec(installer); // Execute the published complete file on its first installation.

 await test('fresh complete SQL Editor installation preserves every interval, receipt, account and business record',async()=>{
  assert.deepEqual(withoutMigration(await snapshot()),withoutMigration(before));
  assert.equal(await scalar("SELECT count(*)::integer r FROM public.central_schema_migrations WHERE version='067_collection_title_time'"),1);
 });
 await test('function ownership, ACL, signatures, RLS and table policies remain byte exact',async()=>{
  assert.deepEqual(await access(),beforeAccess);
  const after=await definitions();
  assert.notEqual(after[timerSignature],beforeDefinitions[timerSignature]);
  delete after[timerSignature];const old={...beforeDefinitions};delete old[timerSignature];assert.deepEqual(after,old);
 });
 await test('manager and assigned collector see the identical 38:03 total but preserve 1:25 and 36:38 personal totals',async()=>{
  const m=await timer(main,'manager'),c=await timer(main,'collector2');
  assert.equal(m.total_seconds,2283);assert.equal(c.total_seconds,2283);assert.equal(m.actor_total_seconds,85);assert.equal(c.actor_total_seconds,2198);
  assert.equal(m.running,false);assert.equal(c.running,false);assert.equal(m.elapsed_seconds,0);assert.equal(c.elapsed_seconds,0);
 });
 await test('public detail and listing expose the same global total to manager, financial and assigned collector profiles',async()=>{
  for(const user of ['manager','manager2','cr','director','collector2']){
   await actor(user);const d=await detail(main),r=(await list()).rows.find(r=>r.id===main);
   assert.equal(d.timer.total_seconds,2283);assert.equal(d.title.total_work_seconds,2283);assert.equal(r.total_work_seconds,2283);assert.equal(r.current_timer.total_seconds,2283);
   assert.equal(d.timer.actor_total_seconds,user==='manager'?85:user==='collector2'?2198:0);
  }
 });
 await test('collector raw session rows and detail history continue to include only their own intervals',async()=>{
  await actor('collector2');const rows=(await db.query('SELECT actor_id FROM public.collection_work_sessions WHERE title_id=$1',[main])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].actor_id,users.collector2.id);
  const d=await detail(main);assert.equal(d.work_sessions.length,1);assert.equal(d.work_sessions[0].actor_id,users.collector2.id);
 });
 await test('the collector productivity summary continues to count only personal work, not the shared title aggregate',async()=>{
  await actor('collector2');const summary=await scalar('SELECT public.collection_work_summary($1,$1,NULL) r',[today]);
  assert(summary.rows.every(r=>r.actor_id===users.collector2.id));
  const rows=summary.rows.filter(r=>r.title_id===main);assert.equal(rows.length,1);assert.equal(rows[0].seconds,2198);
 });
 await test('retired title history retains the same shared total without allowing a new collection start',async()=>{
  await owner();const request=randomUUID();
  await db.query(`INSERT INTO cf_private.receivable_open_report_requests(request_id,actor_id,payload_hash,source_import_id,full_report,reference_date,result)
   VALUES($1,$2,repeat('f',64),$3,true,$4,'{}')`,[request,users.manager.id,importId,today]);
  await scalar("SELECT cf_private.record_receivable_report_event($1,'RETIRED_WORKED',$2,$3,$4) r",[main,importId,request,today]);
  for(const user of ['manager','collector2']){
   await actor(user);const d=await detail(main);assert.equal(d.timer.total_seconds,2283);assert.equal(d.title.start_block_reason,'REPORT_RETIRED');assert.equal(d.workflow.can_finish,false);
  }
 });
 await test('validated title history retains the same shared total and personal split without reopening the title',async()=>{
  await owner();await db.query("UPDATE public.receivable_titles SET status='PENDING_VALIDATION',validation_status='PENDING',payment_source='IMPORTACAO_DIARIA' WHERE id=$1",[main]);
  await actor('cr');const t=await scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[main]);
  await scalar("SELECT public.validate_receivable_payment_v2($1,'CONFIRM',$2,$3,NULL,$4,$5,$6) r",[main,today,t.amount_cents,'Recebimento sintético confirmado',t.revision,randomUUID()]);
  for(const user of ['manager','collector2']){
   await actor(user);const d=await detail(main);assert.equal(d.timer.total_seconds,2283);assert.equal(d.title.start_block_reason,'SETTLED');assert.equal(d.workflow.can_finish,false);assert.equal(d.timer.actor_total_seconds,user==='manager'?85:2198);
  }
 });
 await test('another collector cannot obtain the title, its global total or another actor session',async()=>{
  await actor('collector');assert(!(await list()).rows.some(r=>r.id===main));await reject(()=>detail(main));
  const hidden=await timer(main,'collector');assert.equal(hidden.total_seconds,0);assert.equal(hidden.actor_total_seconds,0);assert.equal(hidden.running,false);
 });
 await test('unassigned and future titles remain hidden from the collector',async()=>{
  await actor('collector2');for(const titleId of [unassigned,future])await reject(()=>detail(titleId));
  for(const titleId of [unassigned,future])assert.equal((await timer(titleId,'collector2')).total_seconds,0);
 });
 await test('own recovery on a title outside the wallet exposes only personal time, never other actors',async()=>{
  const t=await timer(hidden,'collector2');assert.equal(t.total_seconds,20);assert.equal(t.actor_total_seconds,20);assert.equal(t.elapsed_seconds,20);assert.equal(t.running,true);assert.equal(t.recovery_allowed,true);
  await actor('collector2');const listed=await list();assert(!listed.rows.some(r=>r.id===hidden));await reject(()=>detail(hidden));
  assert.equal(listed.active_timer.title_id,hidden);assert.equal(listed.active_timer.total_seconds,listed.active_timer.actor_total_seconds);assert(listed.active_timer.total_seconds>=20);
 });
 await test('hidden own recovery can pause only its own session without modifying another actor interval',async()=>{
  await owner();const before=await scalar('SELECT jsonb_agg(to_jsonb(s) ORDER BY id) r FROM public.collection_work_sessions s WHERE title_id=$1 AND actor_id<>$2',[hidden,users.collector2.id]);
  await actor('collector2');const t=await scalar("SELECT public.collection_work_action($1,'PAUSE',NULL,$2) r",[hidden,randomUUID()]);assert.equal(t.running,false);
  await owner();assert.deepEqual(await scalar('SELECT jsonb_agg(to_jsonb(s) ORDER BY id) r FROM public.collection_work_sessions s WHERE title_id=$1 AND actor_id<>$2',[hidden,users.collector2.id]),before);
 });
 await test('visible total includes prior collectors while personal time remains tied to the connected actor',async()=>{
  await session(main,'collector',40,{collector:agents[0]});
  assert.equal((await timer(main,'collector2')).total_seconds,2323);assert.equal((await timer(main,'collector2')).actor_total_seconds,2198);
  await actor('collector');await reject(()=>detail(main));
 });
 await test('another active actor contributes to the global aggregate without becoming the viewer running session',async()=>{
  await session(main,'manager2',10,{running:true});
  const c=await timer(main,'collector2'),m=await timer(main,'manager2');assert.equal(c.total_seconds,2293);assert.equal(m.total_seconds,2293);
  assert.equal(c.running,false);assert.equal(c.session_id,null);assert.equal(c.elapsed_seconds,0);assert.equal(c.actor_total_seconds,2198);
  assert.equal(m.running,true);assert.equal(m.elapsed_seconds,10);assert.equal(m.actor_total_seconds,10);
 });
 await test('running durations follow server time and stopped intervals never grow',async()=>{
  await session(main,'manager2',10,{running:true});
  const later=new Date(new Date(now).getTime()+62000).toISOString();
  const c=await timer(main,'collector2',later),m=await timer(main,'manager2',later);assert.equal(c.total_seconds,2355);assert.equal(m.actor_total_seconds,72);assert.equal(c.actor_total_seconds,2198);
 });
 await test('a title with hundreds of completed intervals has one role-independent exact aggregate',async()=>{
  await owner();await db.query(`INSERT INTO public.collection_work_sessions(title_id,actor_id,collector_id,document_snapshot,client_name_snapshot,branch_snapshot,collector_name_snapshot,started_at,ended_at,end_reason)
   SELECT $1,$2,$3,'SYN','Cliente sintético','Filial sintética','Cobradora sintética',$4::timestamptz-make_interval(secs=>n*2+1),$4::timestamptz-make_interval(secs=>n*2),'PAUSE' FROM generate_series(1,500)n`,[main,users.manager.id,agents[1],now]);
  assert.equal((await timer(main,'manager')).total_seconds,2783);assert.equal((await timer(main,'collector2')).total_seconds,2783);
  assert.equal((await timer(main,'collector2')).actor_total_seconds,2198);
 });
 await test('timer helper remains inaccessible through public, anonymous, authenticated and service execution grants',async()=>{
  await owner();for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar('SELECT has_function_privilege($1,$2,\'EXECUTE\') r',[role,timerSignature]),false);
 });
 await test('disabled and invalid-session profiles cannot access the collection detail RPC',async()=>{
  await owner();await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[users.collector2.id]);await actor('collector2');await reject(()=>detail(main));
  await owner();await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1',[users.collector2.id]);await actor('collector2',randomUUID());await reject(()=>detail(main));
 });
 await test('required follow-up and one-session rules remain in force after the aggregate correction',async()=>{
  await owner();await db.query("UPDATE public.receivable_titles SET next_action_date=$2,next_action='RETRY' WHERE id=$1",[main,today]);
  const next=await title();await actor('collector2');const d=await detail(next);assert.equal(d.title.start_block_reason,'ALREADY_RUNNING');
  await scalar("SELECT public.collection_work_action($1,'PAUSE',NULL,$2) r",[hidden,randomUUID()]);
  const after=await detail(next);assert.equal(after.title.start_block_reason,'RETURN_PRIORITY');
  await reject(()=>scalar("SELECT public.collection_work_action($1,'START',$2,$3) r",[next,after.title.revision,randomUUID()]),'P0029');
 });
 await test('complete published artifact can be rerun without changing any data, function or access rule',async()=>{
  const before=await snapshot(),defs=await definitions(),acl=await access();
  await db.exec(installer.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await definitions(),defs);assert.deepEqual(await access(),acl);
 });
 await test('an unexpected installed timer contract stops atomically instead of replacing access rules',async()=>{
  await owner();await db.exec("DELETE FROM public.central_schema_migrations WHERE version='067_collection_title_time'");
  const installed=await definition(timerSignature);await db.exec(installed.replace('(coalesce(v_visible,false) OR actor_id=auth.uid())','(actor_id=auth.uid())'));
  const before=await snapshot(),defs=await definitions();
  await reject(()=>db.exec(installer.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'')),'22023');
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await definitions(),defs);
 });
 console.log(`${passed} passed, 0 failed (collection title time067, synthetic local PostgreSQL)`);
}finally{await db.close()}
