import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildCollectionOperationalStatusesSql } from './bundle-collection-operational-statuses.mjs';

// PostgreSQL local descartável. Nenhuma conexão ou informação financeira real.
const f=await createCostFixture(),{db,users,id,owner,actor,scalar,file,snapshot}=f;
const installer=await buildCollectionOperationalStatusesSql();
const statuses=['MERCADORIA A RECOLHER','NOTA A CANCELAR','AGUARDANDO NOTA ASSINADA','NOTA COM PENDÊNCIA','PAUSAR COBRANÇA'];
const legacy=['NOVO TÍTULO - COBRAR','SEM SUCESSO','AGUARDANDO RETORNO','COBRANCA VIA EMAIL','COBRANCA POR WHATSAPP','AGUARDANDO LIQUIDACAO','SEM PRAZO','SEM PREVISAO DE PG','PAGAMENTO PROGRAMADO','TÍTULO PAGO'];
let passed=0,seq=87000,today,tomorrow,importId,agent;
const add=(d,n)=>{const v=new Date(d+'T12:00:00Z');v.setUTCDate(v.getUTCDate()+n);return v.toISOString().slice(0,10)};
const detail=t=>scalar('SELECT public.collection_case_detail($1) r',[t.id]);
const current=async t=>{await owner();return scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[t.id])};
const title=async(options={})=>{
 await owner('cr');const n=++seq,r={amount:12345,due:add(today,-45),status:'OPEN',collector:agent,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$1,$2,cf_private.receivable_customer_key($2,NULL),'4',$3,$4,$5,$6,CASE WHEN $6='PENDING_VALIDATION' THEN 'PENDING' ELSE 'NONE' END,CASE WHEN $6='PENDING_VALIDATION' THEN 'COBRANCA' END,CASE WHEN $6='PENDING_VALIDATION' THEN $7::date END,$8,$8) RETURNING to_jsonb(receivable_titles) r`,['NF-SINT-'+n,'Cliente sintético '+n,r.due,r.amount,r.collector,r.status,today,importId]);
};
const args=async(t,c={})=>{const d=await detail(t);return [t.id,c.status??statuses[0],Object.hasOwn(c,'observation')?c.observation:'Observação sintética',Object.hasOwn(c,'next')?c.next:'Conferir providência',Object.hasOwn(c,'nextDate')?c.nextDate:tomorrow,c.revision??d.title.revision,c.caseRevision??d.case.revision,c.paymentDate??null,c.finish??false,c.request??randomUUID()]};
const call=a=>scalar('SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',a);
const save=async(t,c={})=>call(await args(t,c));
const work=(t,action,revision=null)=>scalar('SELECT public.collection_work_action($1,$2,$3,$4) r',[t.id,action,revision,randomUUID()]);
const start=async t=>work(t,'START',(await detail(t)).title.revision);
const list=(status,queue='active',financial=null)=>scalar('SELECT public.collection_workbench($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) r',['',null,false,null,'delay_desc',status,0,25,queue,null,null,null,financial]);
const reject=async(fn,code='42501')=>{await db.exec('SAVEPOINT expected_error');try{await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}finally{await db.exec('ROLLBACK TO SAVEPOINT expected_error;RELEASE SAVEPOINT expected_error')}};
const test=async(name,fn)=>{await owner();await db.exec('BEGIN');try{await fn();passed++;console.log('PASS',name)}finally{await db.exec('ROLLBACK');await actor('collector')}};

try{
 await owner();await assert.rejects(()=>db.exec(installer),e=>e.code==='22023');await db.exec('ROLLBACK');
 assert.equal(await scalar("SELECT count(*)::integer r FROM public.central_schema_migrations WHERE version='054_collection_operational_statuses'"),0);
 for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql','053_receivable_financial_validation.sql'])await db.exec(await file(name));
 today=await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");tomorrow=add(today,1);
 agent=id(++seq);await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,'Cobradora sintética']);
 await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users.collector.id,agent,users.manager.id]);
 importId=await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES('grupo-consolidado','base-sintetica.csv',repeat('d',64),$1,1,1,0,0,0,'OPEN') RETURNING id r",[users.cr.id]);
 const old=await title();await actor('collector');await start(old);await work(old,'PAUSE');await save(old,{status:'AGUARDANDO RETORNO'});
 const oldFinancialFunction=await scalar("SELECT pg_get_functiondef('public.validate_receivable_payment_v2(uuid,text,date,bigint,text,text,bigint,uuid)'::regprocedure) r");
 const oldPolicy=await scalar("SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) r FROM pg_policies p WHERE tablename IN('collection_cases','collection_case_events','collection_work_sessions','receivable_titles')");
 const privilegesSql="SELECT jsonb_agg(jsonb_build_object('name',proname,'acl',proacl,'security_definer',prosecdef,'configuration',proconfig) ORDER BY proname) r FROM pg_proc WHERE oid IN('public.save_collection_case(uuid,text,text,text,date,bigint,bigint,date,boolean,uuid)'::regprocedure,'public.collection_workbench(text,uuid,boolean,text,text,text,integer,integer,text,date,date,text,text)'::regprocedure)";
 const oldPrivileges=await scalar(privilegesSql);
 const before=await snapshot();await db.exec(installer);const after=await snapshot();delete before['public.central_schema_migrations'];delete after['public.central_schema_migrations'];assert.deepEqual(after,before);
 assert.equal(await scalar("SELECT pg_get_functiondef('public.validate_receivable_payment_v2(uuid,text,date,bigint,text,text,bigint,uuid)'::regprocedure) r"),oldFinancialFunction);
 assert.deepEqual(await scalar("SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) r FROM pg_policies p WHERE tablename IN('collection_cases','collection_case_events','collection_work_sessions','receivable_titles')"),oldPolicy);
 assert.deepEqual(await scalar(privilegesSql),oldPrivileges);
 await db.exec(installer);assert.equal(await scalar("SELECT count(*)::integer r FROM public.central_schema_migrations WHERE version='054_collection_operational_statuses'"),1);
 assert.equal(await readFile(new URL('../supabase/dashboard/ativar-status-atendimento-cobranca.sql',import.meta.url),'utf8'),installer);
 console.log('PASS 054 requires 047, reapplies safely and preserves financial data, histories, policies and financial RPC');passed++;

 for(const status of statuses)await test(`${status}: draft, reload, filter and finalization preserve exact operational status`,async()=>{
  const t=await title();await actor('collector');await save(t,{status});let d=await detail(t);assert.equal(d.case.status,status);assert.equal(d.title.operational_status,status);assert.equal(d.case_history[0].status,status);assert.equal(d.case_history[0].finalized,false);
  assert.equal((await list(status)).rows.find(r=>r.id===t.id).operational_status,status);assert.equal(d.title.next_action_date,null);assert.equal(d.timer.running,false);
  await start(t);assert.equal((await detail(t)).timer.running,true);const result=await save(t,{status,finish:true});assert.equal(result.finished,true);d=await detail(t);assert.equal(d.case.status,status);assert.equal(d.timer.running,false);assert.equal(d.case_history[0].finalized,true);assert.equal(d.case_history[0].status,status);assert(d.history.some(e=>e.action==='OTHER'&&e.return_note.includes(status)));
  const now=await current(t);assert.equal(now.status,'OPEN');assert.equal(now.validation_status,'NONE');assert.equal(now.amount_cents,t.amount_cents);assert.equal(now.due_date,t.due_date);assert.equal(now.collector_id,agent);assert.equal(now.payment_source,null);assert.equal(now.payment_date,null);assert.equal(now.next_action_date,tomorrow);
  assert.equal(await scalar('SELECT count(*)::integer r FROM public.receivable_receipts WHERE title_id=$1',[t.id]),0);assert.equal(await scalar('SELECT count(*)::integer r FROM public.receivable_receipt_adjustments a JOIN public.receivable_receipts r ON r.id=a.receipt_id WHERE r.title_id=$1',[t.id]),0);
 });
 await test('all ten previous statuses remain valid and paid still enters financial validation only on finish',async()=>{
  for(const status of legacy){const t=await title();await actor('collector');await save(t,{status,paymentDate:status==='TÍTULO PAGO'?today:null});assert.equal((await detail(t)).case.status,status);assert((await list(status)).rows.some(r=>r.id===t.id));assert.equal((await current(t)).status,'OPEN')}
  const paid=await title();await actor('collector');await start(paid);await save(paid,{status:'TÍTULO PAGO',paymentDate:today,finish:true});const now=await current(paid);assert.equal(now.status,'PENDING_VALIDATION');assert.equal(now.validation_status,'PENDING');assert.equal(now.payment_reported_date,today);assert.equal(await scalar('SELECT count(*)::integer r FROM public.receivable_receipts WHERE title_id=$1',[paid.id]),0);
 });
 await test('PAUSAR COBRANÇA is a saved status and does not silently end a running timer',async()=>{
  const t=await title();await actor('collector');await start(t);await save(t,{status:'PAUSAR COBRANÇA'});const d=await detail(t);assert.equal(d.timer.running,true);assert.equal(d.workflow.can_finish,true);await work(t,'PAUSE');assert.equal((await detail(t)).case.status,'PAUSAR COBRANÇA');assert.equal((await detail(t)).timer.running,false);assert.equal((await detail(t)).workflow.can_finish,true);
 });
 await test('all new statuses still require an initiated attendance, observation, next action and a nonpast return date to finish',async()=>{
  for(const status of statuses){const t=await title();await actor('collector');await reject(()=>save(t,{status,finish:true}),'55000');await start(t);for(const bad of [{observation:' '},{next:' '},{nextDate:null},{nextDate:add(today,-1)}])await reject(()=>save(t,{status,finish:true,...bad}),'23514');assert.equal((await detail(t)).timer.running,true);await work(t,'PAUSE')}
 });
 await test('unknown status, missing payment date and unrelated payment dates fail without writes',async()=>{
  const t=await title();await actor('collector');for(const status of ['MERCADORIA A RECOLHERX','NOTA COM PENDENCIA','PAUSAR COBRANCA',''])await reject(()=>save(t,{status}),'23514');await reject(()=>save(t,{status:'TÍTULO PAGO'}),'23514');for(const status of statuses)await reject(()=>save(t,{status,paymentDate:today}),'23514');await reject(()=>list('STATUS DESCONHECIDO'),'22023');assert.equal((await detail(t)).case.revision,0);
 });
 await test('title and case revision conflicts retain old histories and reject stale changes',async()=>{
  const t=await title();await actor('collector');const first=await args(t);await save(t,{status:'AGUARDANDO NOTA ASSINADA'});await reject(()=>call(first),'40001');assert.equal((await detail(t)).case.status,'AGUARDANDO NOTA ASSINADA');const stale=await args(t);await owner();await db.query("UPDATE public.receivable_titles SET next_action='RETRY' WHERE id=$1",[t.id]);await actor('collector');await reject(()=>call(stale),'40001');assert.equal((await detail(t)).case_history.length,1);
 });
 await test('same protocol replay remains exact and cannot duplicate finalization or change its payload',async()=>{
  const t=await title();await actor('collector');await start(t);const payload=await args(t,{status:'NOTA COM PENDÊNCIA',finish:true}),r=await call(payload),before=await snapshot();await actor('collector');assert.deepEqual(await call(payload),r);assert.deepEqual(await snapshot(),before);await actor('collector');const collision=[...payload];collision[1]='NOTA A CANCELAR';await reject(()=>call(collision),'22023');assert.equal((await detail(t)).case_history.length,1);
 });
 await test('new status filters preserve 047 retired history visibility and prevent retired, future and pending writes',async()=>{
  const retired=await title();await actor('collector');await start(retired);await save(retired,{status:'MERCADORIA A RECOLHER'});await owner();await scalar("SELECT cf_private.record_receivable_report_event($1,'RETIRED_WORKED',$2,$3,$4) r",[retired.id,importId,randomUUID(),today]);await actor('collector');assert.equal((await list('MERCADORIA A RECOLHER')).rows.some(r=>r.id===retired.id),false);assert.equal((await list('MERCADORIA A RECOLHER','history','RETIRED_FROM_REPORT')).rows.some(r=>r.id===retired.id),true);await reject(()=>save(retired),'42501');
  const future=await title({due:tomorrow});await actor('collector');await reject(()=>save(future),'42501');const pending=await title({status:'PENDING_VALIDATION'});await actor('collector');await reject(()=>save(pending),'23514');
 });
 await test('collector ownership, read-only profiles, approved sessions and direct DML permissions remain enforced',async()=>{
  const other=id(++seq);await owner();await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[other,'Outra responsável sintética']);const t=await title({collector:other});await actor('manager');const payload=await args(t);await actor('collector');await reject(()=>call(payload));
  for(const who of ['director','cp','rh']){await actor(who);await reject(()=>call(payload))}await owner();await db.query('DELETE FROM cf_private.approved_sessions WHERE session_id=$1',[users.cr.session]);await actor('cr');await reject(()=>call(payload));await actor('collector');await reject(()=>db.query("UPDATE public.collection_cases SET status='PAUSAR COBRANÇA' WHERE title_id=$1",[old.id]));await owner();for(const role of ['anon','service_role']){await db.exec('SET ROLE '+role);await reject(()=>call(payload));await db.exec('RESET ROLE')}
 });
 await test('an audit failure rolls the status, event, timer and request back atomically',async()=>{
  const t=await title();await actor('collector');await start(t);const payload=await args(t,{status:'NOTA A CANCELAR',finish:true});await owner();await db.exec("CREATE FUNCTION cf_private.synthetic_status_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='collection_case_events' THEN RAISE EXCEPTION 'Falha sintética' USING ERRCODE='22023';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_status_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_status_failure()");const before=await snapshot();await actor('collector');await reject(()=>call(payload),'22023');assert.deepEqual(await snapshot(),before);
 });
 console.log(`${passed} collection operational status SQL checks passed.`);
}catch(error){console.error('FAIL',error.message,error.code??'',error.where??'',error.stack);process.exitCode=1}finally{await db.close()}
