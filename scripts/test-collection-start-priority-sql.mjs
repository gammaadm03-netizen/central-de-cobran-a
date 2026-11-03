import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivableImportCompletionSql } from './bundle-receivable-import-completion.mjs';
import { buildCollectionStartPrioritySql } from './bundle-collection-start-priority.mjs';

// Dados exclusivamente sintéticos e PostgreSQL local descartável; nenhuma conexão remota.
const f=await createCostFixture(),{db,users,id,owner,actor,scalar,file,snapshot}=f;
let passed=0,seq=63000,today,yesterday,tomorrow,importId,agents,own,other,installer;
const add=(date,n)=>{const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const rowSignature='cf_private.collection_workbench_row(public.receivable_titles,timestamp with time zone)';
const actionSignature='public.collection_work_action(uuid,text,bigint,uuid)';
const metadataSignature='cf_private.collection_workflow_metadata(uuid)';
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
const title=async(options={})=>{
 await owner();const n=++seq,r={collector:agents[1],days:80,amount:10000,status:'NEW',nextDate:null,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,
  collector_id,status,validation_status,payment_source,payment_date,first_import_id,last_import_id,next_action,next_action_date)
 VALUES('grupo-consolidado',$1,$1,$2,cf_private.receivable_customer_key($2,NULL),'Filial sintética',$3::date-$4::int,$5,$6,$7,$8,$9,
  CASE WHEN $7='VALIDATED' THEN $3::date END,$10,$10,CASE WHEN $11::date IS NOT NULL THEN 'RETRY' END,$11) RETURNING id r`,[
  `NF-START-SYN-${n}`,`Cliente sintético ${n}`,today,r.days,r.amount,r.collector,r.status,
  r.status==='VALIDATED'?'VALIDATED':r.status==='PENDING_VALIDATION'?'PENDING':'NONE',
  ['VALIDATED','PENDING_VALIDATION'].includes(r.status)?'IMPORTACAO_DIARIA':null,importId,r.nextDate]);
};
const current=titleId=>scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[titleId]);
const detail=titleId=>scalar('SELECT public.collection_case_detail($1) r',[titleId]);
const list=(args={})=>scalar('SELECT public.collection_workbench($1,$2,$3,NULL,$4,NULL,$5,$6,$7,NULL,NULL,NULL,NULL) r',[
 args.search??'',args.collector??null,args.unassigned??false,args.sort??'delay_desc',args.offset??0,args.limit??100,args.queue??'active']);
const work=(titleId,action,revision=null,request=randomUUID())=>scalar('SELECT public.collection_work_action($1,$2,$3,$4) r',[titleId,action,revision,request]);
const start=async titleId=>work(titleId,'START',(await detail(titleId)).title.revision);
const saveArgs=async(titleId,c={})=>{const d=await detail(titleId);return [titleId,c.status??'SEM SUCESSO',
 c.observation===undefined?'Contato sintético sem sucesso':c.observation,c.next===undefined?'Tentar contato novamente':c.next,
 c.nextDate===undefined?today:c.nextDate,c.revision??d.title.revision,c.caseRevision??d.case.revision,c.paymentDate??null,c.finish??true,c.request??randomUUID()]};
const callSave=args=>scalar('SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',args);
const save=async(titleId,c={})=>callSave(await saveArgs(titleId,c));
const reject=async(fn,code='42501')=>{
 await db.exec('SAVEPOINT expected_failure');
 try{await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}
 finally{await db.exec('ROLLBACK TO SAVEPOINT expected_failure;RELEASE SAVEPOINT expected_failure')}
};
const test=async(name,fn)=>{
 await owner();await db.exec('BEGIN');
 try{await fn();passed++;console.log('PASS',name)}
 finally{await db.exec('ROLLBACK');await owner()}
};
const withoutMigration=s=>{const result=structuredClone(s);delete result['public.central_schema_migrations'];return result};
const stableAgenda=r=>({count:r.count,total_cents:r.total_cents,priority:r.priority,rows:r.rows.map(t=>({id:t.id,amount_cents:t.amount_cents,
 next_action:t.next_action,next_action_date:t.next_action_date,return_due:t.return_due,return_due_date:t.return_due_date}))});
const validate=async titleId=>{
 await actor('cr');const t=await current(titleId);
 return scalar('SELECT public.validate_receivable_payment_v2($1,\'CONFIRM\',$2,$3,NULL,$4,$5,$6) r',[
  titleId,today,t.amount_cents,'Conferência financeira sintética',t.revision,randomUUID()]);
};

try{
 installer=await buildCollectionStartPrioritySql();
 assert.equal(await readFile(new URL('../supabase/dashboard/ativar-inicio-atendimento-cobranca.sql',import.meta.url),'utf8'),installer);
 assert.equal((installer.match(/^BEGIN;\s*$/gm)??[]).length,1);assert.equal((installer.match(/^COMMIT;\s*$/gm)??[]).length,1);
 await owner();
 for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql','054_collection_operational_statuses.sql'])await db.exec(await file(name));
 // A ordem real das migrações conserva os consumidores da visão ativa atualizados pela 056.
 await db.exec(await buildReceivableImportCompletionSql());
 today=await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");yesterday=add(today,-1);tomorrow=add(today,1);
 users.collector2={id:id(++seq),session:id(++seq),role:'cobradora_2'};
 await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[users.collector2.id,'collector2-start-synthetic@example.invalid']);
 await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[
 users.collector2.id,'StartSynthetic_collector2','Emanuelle sintética','cobradora_2']);
 await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[users.collector2.session,users.collector2.id]);
 agents=[id(++seq),id(++seq)];
 for(const [index,user]of ['collector','collector2'].entries()){
  await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agents[index],`Cobradora sintética ${index+1}`]);
  await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users[user].id,agents[index],users.manager.id]);
 }
 importId=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode)
 VALUES('grupo-consolidado','start-synthetic.csv',repeat('c',64),$1,3,3,0,0,0,'OPEN') RETURNING id r`,[users.cr.id]);
 own=[await title({status:'OPEN',nextDate:yesterday}),await title({amount:20000}),await title({amount:30000})];
 other=await title({collector:agents[0],nextDate:today,amount:70000});
 const oldPaid=await title({collector:agents[0],status:'PENDING_VALIDATION',amount:12345});
 const oldReceipt=await validate(oldPaid);assert(oldReceipt.receipt_id);
 await actor('collector');await start(other);await work(other,'PAUSE');await save(other,{finish:false});
 await owner();
 const cpImport=await scalar(`INSERT INTO public.payable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count)
 VALUES('grupo-consolidado','cp-start-synthetic.csv',repeat('d',64),$1,1,1,0,0) RETURNING id r`,[users.cp.id]);
 await db.query(`INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,plan,branch,macro,status,first_import_id,last_import_id)
 SELECT 'grupo-consolidado','CP-START-SYN','CP-SYN','Título CP sintético',$1,45678,plan,'Filial sintética',macro,'NEW',$2,$2 FROM public.payable_plan_mappings ORDER BY plan LIMIT 1`,[today,cpImport]);
 await db.query(`INSERT INTO public.bank_balance_positions(account_id,balance_date,amount_cents,observation,created_by)
 SELECT id,$1,987654,'Posição sintética preservada',$2 FROM public.bank_accounts ORDER BY id LIMIT 1`,[today,users.manager.id]);

 await actor('collector2');const beforeAgenda=stableAgenda(await list({queue:'returns'}));
 assert.equal(beforeAgenda.priority.due_count,1);assert.equal(beforeAgenda.priority.total_cents,10000);
 for(const titleId of own.slice(1)){
  assert.equal((await detail(titleId)).title.start_block_reason,'RETURN_PRIORITY');
  await assert.rejects(()=>start(titleId),e=>e.code==='P0029');
 }
 await owner();const before=await snapshot(),beforeAccess=await access(),beforeDefinitions=await definitions();
 // Pré-requisito ausente ou contrato inesperado falha antes de reescrever funções.
 await db.exec("BEGIN;DELETE FROM public.central_schema_migrations WHERE version='047_receivables_complete_report'");
 await assert.rejects(()=>db.exec(installer),e=>e.code==='22023');await db.exec('ROLLBACK');
 assert.deepEqual(await snapshot(),before);assert.deepEqual(await definitions(),beforeDefinitions);assert.deepEqual(await access(),beforeAccess);
 passed++;console.log('PASS installation requires 047 and rolls back without data, helper or permission changes');
 for(const [signature,needle,replacement]of [[rowSignature,"'RETURN_PRIORITY'","'SYNTHETIC_PRIORITY'"],
  [actionSignature,"ERRCODE='P0029'","ERRCODE='P9999'"],[metadataSignature,"'returns_priority',true","'returns_priority',false"]]){
  await db.exec('BEGIN');const source=await definition(signature);assert(source.includes(needle),signature);await db.exec(source.replace(needle,replacement));
  await assert.rejects(()=>db.exec(installer),e=>e.code==='22023');await db.exec('ROLLBACK');
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await definitions(),beforeDefinitions);assert.deepEqual(await access(),beforeAccess);
 }
 passed++;console.log('PASS all three source contracts are checked before atomic installation');
 await db.exec(installer);
 assert.deepEqual(withoutMigration(await snapshot()),withoutMigration(before));assert.deepEqual(await access(),beforeAccess);
 const afterDefinitions=await definitions(),changed=Object.keys(beforeDefinitions).filter(key=>beforeDefinitions[key]!==afterDefinitions[key]);
 const expectedChanged=await Promise.all([rowSignature,actionSignature,metadataSignature].map(signature=>scalar('SELECT $1::regprocedure::text r',[signature])));
 assert.deepEqual(changed.sort(),expectedChanged.sort());
 assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='063_collection_start_priority'"),1);
 const installed=await snapshot(),installedDefinitions=await definitions();await db.exec(installer);
 assert.deepEqual(await snapshot(),installed);assert.deepEqual(await definitions(),installedDefinitions);assert.deepEqual(await access(),beforeAccess);
 await actor('collector2');assert.deepEqual(stableAgenda(await list({queue:'returns'})),beforeAgenda);
 const metadata=(await list()).workflow;
 assert.equal(metadata.version,'029');assert.equal(metadata.returns_priority,true);assert.equal(metadata.returns_block_new,false);
 assert.equal(metadata.normal_pause,true);assert.equal(metadata.finish_requires_started,true);assert.equal(metadata.pending_read_only,true);
 passed++;console.log('PASS idempotent installation changes only three function bodies and one migration marker, preserving agenda, histories, financial data and access');

 await test('collector_2 can START, PAUSE and FINISH all three own titles while the first return stays due today',async()=>{
  await actor('collector2');for(const titleId of own){
   const d=await detail(titleId);assert.equal(d.title.can_start,true);assert.equal(d.title.start_block_reason,null);
   await start(titleId);assert.equal((await detail(titleId)).timer.running,true);
   if(titleId===own[0])await db.query('SELECT pg_sleep(1.05)');
   const paused=await work(titleId,'PAUSE');assert.equal((await detail(titleId)).workflow.can_finish,true);
   if(titleId===own[0])assert(paused.actor_total_seconds>=1);
   await save(titleId);const done=await detail(titleId);assert.equal(done.timer.running,false);assert.equal(done.workflow.started,false);
   assert.equal(done.timer.actor_total_seconds,paused.actor_total_seconds);
   assert.equal(done.title.next_action_date,today);assert.equal(done.title.return_due,true);
   const agenda=await list({queue:'returns'});assert(agenda.rows.some(row=>row.id===own[0]));
   assert.equal(agenda.priority.due_count,own.indexOf(titleId)+1);
  }
  await owner();const sessions=(await db.query('SELECT * FROM public.collection_work_sessions WHERE actor_id=$1',[users.collector2.id])).rows;
  assert.equal(sessions.length,3);assert(sessions.every(s=>s.end_reason==='PAUSE'&&s.ended_at));
 });
 await test('Agenda count, amount, chronological ordering, pagination and search independent priority remain intact',async()=>{
  const oldest=await title({nextDate:add(today,-2),days:20,amount:1111}),todayEarly=await title({nextDate:today,days:90,amount:2222}),todayLate=await title({nextDate:today,days:5,amount:3333});
  const future=await title({nextDate:tomorrow,amount:4444});await actor('collector2');
  const r=await list({queue:'returns',limit:2,sort:'amount_desc'});
  assert.equal(r.count,4);assert.equal(r.total_cents,16666);assert.equal(r.priority.due_count,4);assert.equal(r.priority.total_cents,16666);assert.equal(r.priority.next_title_id,oldest);
  assert.deepEqual(r.rows.map(t=>t.id),[oldest,own[0]]);
  assert.deepEqual((await list({queue:'returns',offset:2})).rows.map(t=>t.id),[todayEarly,todayLate]);
  const empty=await list({queue:'returns',search:'inexistente-sintetico'});assert.equal(empty.count,0);assert.deepEqual(empty.priority,r.priority);
  assert(!(await list({queue:'returns'})).rows.some(t=>t.id===future));assert.equal((await detail(future)).title.can_start,true);
  await start(own[1]);await work(own[1],'PAUSE');assert.deepEqual(stableAgenda(await list({queue:'returns',limit:2,sort:'amount_desc'})),stableAgenda(r));
 });
 await test('one active timer per actor still blocks other titles and PAUSE releases the actor',async()=>{
  await actor('collector2');await start(own[1]);assert.equal((await detail(own[2])).title.start_block_reason,'ALREADY_RUNNING');
  await reject(()=>start(own[2]),'23514');assert.equal((await list()).active_timer.title_id,own[1]);
  await work(own[1],'PAUSE');assert.equal((await detail(own[2])).title.can_start,true);await start(own[2]);
 });
 await test('FINISH still needs an unused START, observation, next action and a date today or later',async()=>{
  await actor('collector2');await reject(()=>save(own[1]),'55000');await start(own[1]);
  for(const change of [{observation:' '},{next:' '},{nextDate:null},{nextDate:yesterday}])await reject(()=>save(own[1],change),'23514');
  await reject(()=>work(own[1],'FINISH'),'23514');assert.equal((await detail(own[1])).timer.running,true);
  await save(own[1]);await reject(()=>save(own[1]),'55000');
  await start(own[2]);await save(own[2],{nextDate:tomorrow});assert.equal((await detail(own[2])).title.next_action_date,tomorrow);
 });
 await test('START, PAUSE and FINISH request replays return exact stored payloads; collisions and stale revisions remain rejected',async()=>{
  await actor('collector2');const revision=(await detail(own[1])).title.revision,startRequest=randomUUID(),pauseRequest=randomUUID();
  const started=await work(own[1],'START',revision,startRequest);assert.deepEqual(await work(own[1],'START',revision,startRequest),started);
  const paused=await work(own[1],'PAUSE',null,pauseRequest);assert.deepEqual(await work(own[1],'PAUSE',null,pauseRequest),paused);
  await reject(()=>work(own[1],'START',revision,pauseRequest),'22023');await reject(()=>work(own[2],'START',revision,startRequest),'22023');
  await reject(()=>work(own[2],'START',999999),'40001');
  const args=await saveArgs(own[1]),finished=await callSave(args),before=await snapshot();await actor('collector2');
  assert.deepEqual(await callSave(args),finished);assert.deepEqual(await snapshot(),before);await actor('collector2');
  const collision=[...args];collision[2]='Outro contato sintético';await reject(()=>callSave(collision),'22023');
 });
 await test('other wallets stay hidden through RLS and cannot be detailed, started, paused or saved by collector_2',async()=>{
  await actor('collector2');assert(!(await list()).rows.some(t=>t.id===other));assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_titles WHERE id=$1',[other]),0);
  assert.equal((await list({collector:agents[0]})).count,0);assert.equal((await list()).priority.collector_id,agents[1]);
  await reject(()=>detail(other));await reject(()=>work(other,'START',1));await reject(()=>work(other,'PAUSE'));await reject(()=>callSave([other,'SEM SUCESSO','Contato','Retomar',today,1,0,null,true,randomUUID()]));
  await reject(()=>db.query('UPDATE public.collection_work_sessions SET ended_at=clock_timestamp() WHERE actor_id=$1',[users.collector.id]));
 });
 await test('pending financial, validated, retired, unassigned, disabled and nonoverdue titles still reject START',async()=>{
  const pending=await title({status:'PENDING_VALIDATION'}),settled=await title({status:'VALIDATED'}),unassigned=await title({collector:null});
  const retired=await title(),dueToday=await title({days:0}),future=await title({days:-1});
  await owner('cr');await scalar("SELECT cf_private.record_receivable_report_event($1,'RETIRED_UNWORKED',$2,$3,$4) r",[retired,importId,randomUUID(),today]);
  await actor('manager');for(const titleId of [pending,settled,unassigned])await reject(()=>start(titleId),'23514');
  for(const titleId of [retired,dueToday,future])await reject(()=>start(titleId));
  assert.equal((await detail(pending)).title.start_block_reason,'PENDING_VALIDATION');assert.equal((await detail(settled)).title.start_block_reason,'SETTLED');
  assert.equal((await detail(retired)).title.start_block_reason,'REPORT_RETIRED');assert.equal((await detail(unassigned)).title.start_block_reason,'UNASSIGNED');
  await owner();await db.query('UPDATE public.collection_agents SET enabled=false WHERE id=$1',[agents[1]]);await actor('manager');
  assert.equal((await detail(own[1])).title.start_block_reason,'UNASSIGNED');await reject(()=>start(own[1]),'23514');
 });
 await test('an actual active receipt blocks START even when the title source says OPEN, while an audited reversal restores service',async()=>{
  const titleId=await title({status:'PENDING_VALIDATION',amount:23456}),proof=await validate(titleId);
  await owner();const receipt=await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipts r WHERE id=$1',[proof.receipt_id]);
  await db.exec('SAVEPOINT source_disagrees');await db.query("UPDATE public.receivable_titles SET status='OPEN',validation_status='NONE' WHERE id=$1",[titleId]);
  await actor('collector2');assert.equal((await detail(titleId)).title.start_block_reason,'SETTLED');await reject(()=>start(titleId),'23514');
  await db.exec('ROLLBACK TO SAVEPOINT source_disagrees;RELEASE SAVEPOINT source_disagrees');
  await actor('manager');const t=await current(titleId);const reversal=await scalar('SELECT public.reverse_receivable_receipt($1,$2,$3,$4) r',[
   proof.receipt_id,'Conferência sintética: recebimento não ocorreu',t.revision,randomUUID()]);assert.equal(reversal.restored_status,'OPEN');
  await owner();assert.deepEqual(await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipts r WHERE id=$1',[proof.receipt_id]),receipt);
  assert.equal(await scalar('SELECT count(*)::int r FROM public.active_receivable_receipts WHERE title_id=$1',[titleId]),0);
  assert.equal(await scalar("SELECT count(*)::int r FROM public.audit_events WHERE entity='receivable_financial_validation' AND record_id=$1",[titleId]),1);
  assert.equal(await scalar("SELECT count(*)::int r FROM public.audit_events WHERE entity='receivable_receipt_reversals' AND record_id=$1",[reversal.reversal_id]),1);
  await actor('collector2');assert.equal((await detail(titleId)).title.can_start,true);await start(titleId);await work(titleId,'PAUSE');await save(titleId);
  assert.equal((await detail(titleId)).title.status,'OPEN');assert.equal((await detail(titleId)).title.return_due,true);
 });
 await test('official API roles, disabled profiles and wrong approved sessions remain denied',async()=>{
  const before=await snapshot();
  for(const name of ['director','cp','rh']){await actor(name);await reject(()=>work(own[1],'START',1));await reject(()=>callSave([own[1],'SEM SUCESSO','Contato','Retomar',today,1,0,null,true,randomUUID()]));}
  for(const role of ['anon','service_role']){await owner('collector2');await db.exec(`SET ROLE ${role}`);await reject(()=>list());await reject(()=>work(own[1],'START',1));}
  await actor('collector2',users.collector.session);await reject(()=>list());await reject(()=>work(own[1],'START',1));
  assert.deepEqual(await snapshot(),before);await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[users.collector2.id]);
  await actor('collector2');await reject(()=>list());await reject(()=>work(own[1],'START',1));
 });
 await test('collection activity leaves CP, bank positions, receipts and existing audit records unchanged',async()=>{
  const before=await snapshot();await actor('collector2');await start(own[1]);await work(own[1],'PAUSE');await save(own[1]);const after=await snapshot();
  for(const table of Object.keys(before).filter(name=>/payable|bank_|stock_|receivable_receipt|receivable_financial_validation/.test(name)))assert.deepEqual(after[table],before[table],table);
  for(const event of before['public.audit_events'])assert(after['public.audit_events'].some(row=>row.id===event.id&&JSON.stringify(row)===JSON.stringify(event)));
  const added=after['public.audit_events'].filter(row=>!before['public.audit_events'].some(old=>old.id===row.id));assert(added.length>0);
  const collectionEntities=['collection_cases','collection_case_events','collection_work_sessions','receivable_collection_events'];
  assert(added.every(row=>row.user_id===users.collector2.id&&((row.module==='cobranca'&&collectionEntities.includes(row.entity))
   ||(row.module==='contas_receber'&&row.entity==='receivable_titles'&&row.record_id===own[1]&&row.action==='UPDATE'))),
   JSON.stringify(added.map(row=>({module:row.module,entity:row.entity,action:row.action}))));
 });
 console.log(`${passed} collection start priority SQL checks passed.`);
}catch(error){console.error('FAIL',error.message,error.code??'',error.where??'',error.stack);process.exitCode=1}
finally{await db.close()}
