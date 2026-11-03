import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivableImportCompletionSql } from './bundle-receivable-import-completion.mjs';
import { buildCollectionStartPrioritySql } from './bundle-collection-start-priority.mjs';
import { buildCollectionReturnPriorityRequiredSql } from './bundle-collection-return-priority-required.mjs';

// Dados exclusivamente sintéticos e PostgreSQL local descartável; nenhuma conexão remota.
const f=await createCostFixture(),{db,users,id,owner,actor,scalar,file,snapshot}=f;
let passed=0,seq=64000,today,yesterday,tomorrow,importId,agents,own,other,installer;
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
  `NF-PRIORITY-SYN-${n}`,`Cliente sintético ${n}`,today,r.days,r.amount,r.collector,r.status,
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
 installer=await buildCollectionReturnPriorityRequiredSql();
 assert.equal(await readFile(new URL('../supabase/dashboard/ativar-retornos-prioritarios-cobranca.sql',import.meta.url),'utf8'),installer);
 assert.equal((installer.match(/^BEGIN;\s*$/gm)??[]).length,1);assert.equal((installer.match(/^COMMIT;\s*$/gm)??[]).length,1);
 await owner();
 for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql','054_collection_operational_statuses.sql'])await db.exec(await file(name));
 // 054 precede 056: todos os consumidores financeiros conservam a visão ativa.
 await db.exec(await buildReceivableImportCompletionSql());
 const legacyRowSource=await definition(rowSignature);
 await db.exec(await buildCollectionStartPrioritySql());
 today=await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");yesterday=add(today,-1);tomorrow=add(today,1);
 users.collector2={id:id(++seq),session:id(++seq),role:'cobradora_2'};
 await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[users.collector2.id,'collector2-priority-synthetic@example.invalid']);
 await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[
  users.collector2.id,'PrioritySynthetic_collector2','Emanuelle sintética','cobradora_2']);
 await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[users.collector2.session,users.collector2.id]);
 agents=[id(++seq),id(++seq)];
 for(const [index,user]of ['collector','collector2'].entries()){
  await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agents[index],`Cobradora sintética ${index+1}`]);
  await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users[user].id,agents[index],users.manager.id]);
 }
 importId=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode)
  VALUES('grupo-consolidado','priority-synthetic.csv',repeat('c',64),$1,3,3,0,0,0,'OPEN') RETURNING id r`,[users.cr.id]);
 own=[await title({status:'OPEN',nextDate:yesterday}),await title({amount:20000}),await title({amount:30000})];
 other=await title({collector:agents[0],nextDate:today,amount:70000});
 const oldPaid=await title({collector:agents[0],status:'PENDING_VALIDATION',amount:12345});assert((await validate(oldPaid)).receipt_id);
 await actor('collector');await start(other);await work(other,'PAUSE');await save(other,{finish:false});
 await owner();
 const cpImport=await scalar(`INSERT INTO public.payable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count)
  VALUES('grupo-consolidado','cp-priority-synthetic.csv',repeat('d',64),$1,1,1,0,0) RETURNING id r`,[users.cp.id]);
 await db.query(`INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,plan,branch,macro,status,first_import_id,last_import_id)
  SELECT 'grupo-consolidado','CP-PRIORITY-SYN','CP-SYN','Título CP sintético',$1,45678,plan,'Filial sintética',macro,'NEW',$2,$2 FROM public.payable_plan_mappings ORDER BY plan LIMIT 1`,[today,cpImport]);
 await db.query(`INSERT INTO public.bank_balance_positions(account_id,balance_date,amount_cents,observation,created_by)
  SELECT id,$1,987654,'Posição sintética preservada',$2 FROM public.bank_accounts ORDER BY id LIMIT 1`,[today,users.manager.id]);

 await actor('collector2');const beforeAgenda=stableAgenda(await list({queue:'returns'}));
 assert.equal(beforeAgenda.priority.due_count,1);assert.equal(beforeAgenda.priority.total_cents,10000);
 assert.equal((await list()).workflow.returns_block_new,false);
 assert.equal((await detail(own[1])).title.can_start,true);assert.equal((await detail(own[2])).title.can_start,true);
 const runningRevision=(await detail(own[1])).title.revision,runningRequest=randomUUID();
 const runningProof=await work(own[1],'START',runningRevision,runningRequest);
 await owner();const before=await snapshot(),beforeAccess=await access(),beforeDefinitions=await definitions();
 await db.exec("BEGIN;DELETE FROM public.central_schema_migrations WHERE version='047_receivables_complete_report'");
 await assert.rejects(()=>db.exec(installer),e=>e.code==='22023');await db.exec('ROLLBACK');
 assert.deepEqual(await snapshot(),before);assert.deepEqual(await definitions(),beforeDefinitions);assert.deepEqual(await access(),beforeAccess);
 passed++;console.log('PASS missing prerequisite fails atomically without modifying existing timers, histories, functions or access');
 // Os dois pontos de inserção e os metadados têm de corresponder ao contrato conhecido.
 for(const [signature,needle,replacement]of [[rowSignature,"ELSE NULL END;","ELSE 'SYNTHETIC_DRIFT' END;"],
  [actionSignature,"ERRCODE='40001'","ERRCODE='P9999'"],
  [metadataSignature,"'returns_block_new',false","'returns_block_new',true"]]){
  await db.exec('BEGIN');const source=await definition(signature);assert(source.includes(needle),signature);await db.exec(source.replace(needle,replacement));
  await assert.rejects(()=>db.exec(installer),e=>e.code==='22023');await db.exec('ROLLBACK');
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await definitions(),beforeDefinitions);assert.deepEqual(await access(),beforeAccess);
 }
 await db.exec('BEGIN');await db.exec(legacyRowSource);
 await assert.rejects(()=>db.exec(installer),e=>e.code==='22023');await db.exec('ROLLBACK');
 assert.deepEqual(await snapshot(),before);assert.deepEqual(await definitions(),beforeDefinitions);assert.deepEqual(await access(),beforeAccess);
 passed++;console.log('PASS unknown or mixed source contracts are rejected before any function rewrite');
 await db.exec(installer);
 assert.deepEqual(withoutMigration(await snapshot()),withoutMigration(before));assert.deepEqual(await access(),beforeAccess);
 const afterDefinitions=await definitions(),changed=Object.keys(beforeDefinitions).filter(key=>beforeDefinitions[key]!==afterDefinitions[key]);
 const expectedChanged=await Promise.all([rowSignature,actionSignature,metadataSignature].map(signature=>scalar('SELECT $1::regprocedure::text r',[signature])));
 assert.deepEqual(changed.sort(),expectedChanged.sort());
 assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='064_collection_return_priority_required'"),1);
 const installed=await snapshot(),installedDefinitions=await definitions();await db.exec(installer);
 assert.deepEqual(await snapshot(),installed);assert.deepEqual(await definitions(),installedDefinitions);assert.deepEqual(await access(),beforeAccess);
 await actor('collector2');assert.deepEqual(stableAgenda(await list({queue:'returns'})),beforeAgenda);
 const metadata=(await list()).workflow;
 assert.equal(metadata.version,'029');assert.equal(metadata.returns_priority,true);assert.equal(metadata.returns_block_new,true);
 assert.equal(metadata.normal_pause,true);assert.equal(metadata.finish_requires_started,true);assert.equal(metadata.pending_read_only,true);
 passed++;console.log('PASS 063 upgrade is atomic and idempotent, changes only three function bodies and a marker, and preserves all data and permissions');

 await db.exec('BEGIN');await actor('collector2');
 assert.equal((await list()).active_timer.title_id,own[1]);assert.equal((await detail(own[1])).title.can_start,true);
 assert.deepEqual(await work(own[1],'START',runningRevision,runningRequest),runningProof);
 await work(own[1],'START',runningRevision);await work(own[1],'PAUSE');await save(own[1],{finish:false});
 assert.equal((await detail(own[1])).workflow.can_finish,true);await save(own[1],{nextDate:tomorrow});
 assert.equal((await detail(own[1])).timer.running,false);assert.equal((await detail(own[1])).workflow.started,false);
 assert.equal((await detail(own[2])).title.start_block_reason,'RETURN_PRIORITY');await reject(()=>start(own[2]),'P0029');
 await db.exec('COMMIT');await owner();
 passed++;console.log('PASS a NEW timer running before activation can continue, pause, save and finish, then other START requests respect due returns');

 await test('due returns through today block other START requests in both row metadata and the server',async()=>{
  await actor('collector2');for(const titleId of own.slice(1)){
   const d=await detail(titleId);assert.equal(d.title.can_start,false);assert.equal(d.title.start_block_reason,'RETURN_PRIORITY');await reject(()=>start(titleId),'P0029');
  }
  assert.equal((await detail(own[0])).title.can_start,true);await start(own[0]);await work(own[0],'PAUSE');
 });
 await test('FINISH scheduled for today stays due; rescheduling that return for tomorrow releases new titles',async()=>{
  await actor('collector2');await start(own[0]);await save(own[0],{nextDate:today});
  assert.equal((await detail(own[0])).title.return_due,true);assert.equal((await list()).priority.due_count,1);
  assert.equal((await detail(own[2])).title.start_block_reason,'RETURN_PRIORITY');await reject(()=>start(own[2]),'P0029');
  await start(own[0]);await save(own[0],{nextDate:tomorrow});
  assert.equal((await list()).priority.due_count,0);assert.equal((await detail(own[2])).title.can_start,true);await start(own[2]);
 });
 await test('every due return must be addressed before a new title is released',async()=>{
  const second=await title({nextDate:today,amount:2222}),third=await title({nextDate:today,amount:3333});await actor('collector2');
  assert.equal((await list()).priority.due_count,3);
  for(const [index,titleId]of [own[0],second,third].entries()){
   await start(titleId);await save(titleId,{nextDate:tomorrow});assert.equal((await list()).priority.due_count,2-index);
   if(index<2){assert.equal((await detail(own[2])).title.start_block_reason,'RETURN_PRIORITY');await reject(()=>start(own[2]),'P0029')}
  }
  assert.equal((await detail(own[2])).title.can_start,true);await start(own[2]);
 });
 await test('future scheduled returns and due returns owned by another collector do not block this wallet',async()=>{
  const futureReturn=await title({nextDate:tomorrow});await actor('collector2');await start(own[0]);await save(own[0],{nextDate:tomorrow});
  const r=await list();assert.equal(r.priority.due_count,0);assert.equal(r.priority.total_cents,0);assert.equal(r.priority.next_title_id,null);
  assert(!r.rows.some(t=>t.id===other));assert.equal((await detail(futureReturn)).title.can_start,true);
  await start(futureReturn);await work(futureReturn,'PAUSE');assert.equal((await detail(own[2])).title.can_start,true);await start(own[2]);
  await actor('collector');assert.equal((await list()).priority.due_count,1);assert.equal((await list()).priority.next_title_id,other);
 });
 await test('Agenda count, amount, chronological ordering, pagination and search independent priority stay intact',async()=>{
  const oldest=await title({nextDate:add(today,-2),days:20,amount:1111}),todayEarly=await title({nextDate:today,days:90,amount:2222}),todayLate=await title({nextDate:today,days:5,amount:3333});
  const future=await title({nextDate:tomorrow,amount:4444});await actor('collector2');
  const r=await list({queue:'returns',limit:2,sort:'amount_desc'});
  assert.equal(r.count,4);assert.equal(r.total_cents,16666);assert.equal(r.priority.due_count,4);assert.equal(r.priority.total_cents,16666);assert.equal(r.priority.next_title_id,oldest);
  assert.deepEqual(r.rows.map(t=>t.id),[oldest,own[0]]);assert.deepEqual((await list({queue:'returns',offset:2})).rows.map(t=>t.id),[todayEarly,todayLate]);
  const empty=await list({queue:'returns',search:'inexistente-sintetico'});assert.equal(empty.count,0);assert.deepEqual(empty.priority,r.priority);
  assert(!(await list({queue:'returns'})).rows.some(t=>t.id===future));assert.equal((await detail(future)).title.start_block_reason,'RETURN_PRIORITY');
  await start(oldest);await work(oldest,'PAUSE');assert.deepEqual(stableAgenda(await list({queue:'returns',limit:2,sort:'amount_desc'})),stableAgenda(r));
 });
 await test('one active timer per actor remains enforced independently of return priority',async()=>{
  const secondReturn=await title({nextDate:today});await actor('collector2');await start(own[0]);
  assert.equal((await detail(secondReturn)).title.start_block_reason,'ALREADY_RUNNING');await reject(()=>start(secondReturn),'23514');
  assert.equal((await list()).active_timer.title_id,own[0]);await work(own[0],'PAUSE');assert.equal((await detail(secondReturn)).title.can_start,true);await start(secondReturn);
 });
 await test('FINISH still requires an unused START, observation, next action and a date today or later',async()=>{
  await actor('collector2');await reject(()=>save(own[0]),'55000');await start(own[0]);
  for(const change of [{observation:' '},{next:' '},{nextDate:null},{nextDate:yesterday}])await reject(()=>save(own[0],change),'23514');
  await reject(()=>work(own[0],'FINISH'),'23514');assert.equal((await detail(own[0])).timer.running,true);
  await save(own[0]);await reject(()=>save(own[0]),'55000');
 });
 await test('START, PAUSE and FINISH replays remain exact while payload collisions and stale revisions reject',async()=>{
  await actor('collector2');const revision=(await detail(own[0])).title.revision,startRequest=randomUUID(),pauseRequest=randomUUID();
  const started=await work(own[0],'START',revision,startRequest);assert.deepEqual(await work(own[0],'START',revision,startRequest),started);
  const paused=await work(own[0],'PAUSE',null,pauseRequest);assert.deepEqual(await work(own[0],'PAUSE',null,pauseRequest),paused);
  await reject(()=>work(own[0],'START',revision,pauseRequest),'22023');await reject(()=>work(own[2],'START',revision,startRequest),'22023');
  await reject(()=>work(own[2],'START',999999),'40001');
  const args=await saveArgs(own[0],{nextDate:tomorrow}),finished=await callSave(args),before=await snapshot();await actor('collector2');
  assert.deepEqual(await callSave(args),finished);assert.deepEqual(await snapshot(),before);await actor('collector2');
  const collision=[...args];collision[2]='Outro contato sintético';await reject(()=>callSave(collision),'22023');
 });
 await test('other wallets stay hidden through RLS, detail, START, PAUSE and save APIs',async()=>{
  await actor('collector2');assert(!(await list()).rows.some(t=>t.id===other));assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_titles WHERE id=$1',[other]),0);
  assert.equal((await list({collector:agents[0]})).count,0);assert.equal((await list()).priority.collector_id,agents[1]);assert.equal((await list()).priority.total_cents,10000);
  await reject(()=>detail(other));await reject(()=>work(other,'START',1));await reject(()=>work(other,'PAUSE'));await reject(()=>callSave([other,'SEM SUCESSO','Contato','Retomar',today,1,0,null,true,randomUUID()]));
  await reject(()=>db.query('UPDATE public.collection_work_sessions SET ended_at=clock_timestamp() WHERE actor_id=$1',[users.collector.id]));
 });
 await test('pending, validated, retired, unassigned, disabled and nonoverdue titles retain their existing guards',async()=>{
  const pending=await title({status:'PENDING_VALIDATION'}),settled=await title({status:'VALIDATED'}),unassigned=await title({collector:null});
  const retired=await title(),dueToday=await title({days:0}),future=await title({days:-1});
  await owner('cr');await scalar("SELECT cf_private.record_receivable_report_event($1,'RETIRED_UNWORKED',$2,$3,$4) r",[retired,importId,randomUUID(),today]);
  await actor('manager');for(const titleId of [pending,settled,unassigned])await reject(()=>start(titleId),'23514');
  for(const titleId of [retired,dueToday,future])await reject(()=>start(titleId));
  assert.equal((await detail(pending)).title.start_block_reason,'PENDING_VALIDATION');assert.equal((await detail(settled)).title.start_block_reason,'SETTLED');
  assert.equal((await detail(retired)).title.start_block_reason,'REPORT_RETIRED');assert.equal((await detail(unassigned)).title.start_block_reason,'UNASSIGNED');
  await owner();await db.query('UPDATE public.collection_agents SET enabled=false WHERE id=$1',[agents[1]]);await actor('manager');
  assert.equal((await detail(own[0])).title.start_block_reason,'UNASSIGNED');await reject(()=>start(own[0]),'23514');
 });
 await test('active receipts still block OPEN titles while an audited reversal makes its due return serviceable',async()=>{
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
  await actor('collector2');assert.equal((await detail(titleId)).title.can_start,true);await start(titleId);await work(titleId,'PAUSE');await save(titleId,{nextDate:tomorrow});
  assert.equal((await detail(titleId)).title.status,'OPEN');assert.equal((await list()).priority.due_count,1);await reject(()=>start(own[2]),'P0029');
 });
 await test('official role, profile and approved session restrictions still deny unauthorized API writes',async()=>{
  const before=await snapshot();
  for(const name of ['director','cp','rh']){await actor(name);await reject(()=>work(own[0],'START',1));await reject(()=>callSave([own[0],'SEM SUCESSO','Contato','Retomar',today,1,0,null,true,randomUUID()]));}
  for(const role of ['anon','service_role']){await owner('collector2');await db.exec(`SET ROLE ${role}`);await reject(()=>list());await reject(()=>work(own[0],'START',1));}
  await actor('collector2',users.collector.session);await reject(()=>list());await reject(()=>work(own[0],'START',1));
  assert.deepEqual(await snapshot(),before);await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[users.collector2.id]);
  await actor('collector2');await reject(()=>list());await reject(()=>work(own[0],'START',1));
 });
 await test('collection activity preserves CP, bank positions, receipts and every existing audit record',async()=>{
  const before=await snapshot();await actor('collector2');await start(own[0]);await work(own[0],'PAUSE');await save(own[0]);const after=await snapshot();
  for(const table of Object.keys(before).filter(name=>/payable|bank_|stock_|receivable_receipt|receivable_financial_validation/.test(name)))assert.deepEqual(after[table],before[table],table);
  for(const event of before['public.audit_events'])assert(after['public.audit_events'].some(row=>row.id===event.id&&JSON.stringify(row)===JSON.stringify(event)));
  const added=after['public.audit_events'].filter(row=>!before['public.audit_events'].some(old=>old.id===row.id));assert(added.length>0);
  const collectionEntities=['collection_cases','collection_case_events','collection_work_sessions','receivable_collection_events'];
  assert(added.every(row=>row.user_id===users.collector2.id&&((row.module==='cobranca'&&collectionEntities.includes(row.entity))
   ||(row.module==='contas_receber'&&row.entity==='receivable_titles'&&row.record_id===own[0]&&row.action==='UPDATE'))));
 });

 // A base mínima 047 já contém os bloqueios originais e não depende de 063, 054 ou 056.
 const minimal=await createCostFixture();
 try{
  await minimal.owner();for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql'])await minimal.db.exec(await minimal.file(name));
  const before=await minimal.snapshot(),rowBefore=await minimal.scalar('SELECT pg_get_functiondef($1::regprocedure) r',[rowSignature]),actionBefore=await minimal.scalar('SELECT pg_get_functiondef($1::regprocedure) r',[actionSignature]);
  assert(rowBefore.includes("'RETURN_PRIORITY'"));assert(actionBefore.includes("ERRCODE='P0029'"));
  assert.equal(await minimal.scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version IN('063_collection_start_priority','056_receivable_receipt_reversal')"),0);
  await minimal.db.exec(installer);assert.deepEqual(withoutMigration(await minimal.snapshot()),withoutMigration(before));
  assert.equal(await minimal.scalar('SELECT pg_get_functiondef($1::regprocedure) r',[rowSignature]),rowBefore);
  assert.equal(await minimal.scalar('SELECT pg_get_functiondef($1::regprocedure) r',[actionSignature]),actionBefore);
  const once=await minimal.snapshot();await minimal.db.exec(installer);assert.deepEqual(await minimal.snapshot(),once);
  await minimal.actor();const workflow=await minimal.scalar('SELECT public.collection_workbench() r');
  assert.equal(workflow.workflow.version,'029');assert.equal(workflow.workflow.returns_priority,true);assert.equal(workflow.workflow.returns_block_new,true);
  passed++;console.log('PASS legacy 047 installs without 063, preserves existing gates and data, and reapplies safely');
 }finally{await minimal.db.close()}
 console.log(`${passed} collection return priority required SQL checks passed.`);
}catch(error){console.error('FAIL',error.message,error.code??'',error.where??'',error.stack);process.exitCode=1}
finally{await db.close()}

