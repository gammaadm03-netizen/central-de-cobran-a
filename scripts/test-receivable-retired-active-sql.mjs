import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
// PostgreSQL descartável e registros exclusivamente sintéticos; sem conexão remota.
const f=await createCostFixture(),{db,users,id,scalar,owner,actor,file}=f;
let today,tomorrow,importId,agent,seq=500,passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('PASS',name);};
const reject=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
const title=titleId=>scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[titleId]);
const retired=async(titleId,value=true)=>{await owner('cr');const request=randomUUID();
 await db.query("INSERT INTO cf_private.receivable_open_report_requests(request_id,actor_id,payload_hash,source_import_id,full_report,reference_date,result) VALUES($1,$2,repeat('a',64),$3,true,$4,'{}')",[request,users.cr.id,importId,today]);
 const worked=await scalar('SELECT cf_private.receivable_report_title_worked($1,clock_timestamp()) r',[titleId]);
 await scalar('SELECT cf_private.record_receivable_report_event($1,$2,$3,$4,$5) r',[titleId,value?(worked?'RETIRED_WORKED':'RETIRED_UNWORKED'):'REAPPEARED',importId,request,today]);
};
const fixture=async(options={})=>{await owner();const n=++seq,r={name:`Cliente de retirada sintético ${n}`,days:10,amount:10000,collector:agent,status:'OPEN',next:null,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_date,next_action,next_action_date,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$2,$3,cf_private.receivable_customer_key($3,NULL),'FILIAL SINTETICA',$4::date-$5::int,$6,$7,$8,$9,$10,
 CASE WHEN $8='VALIDATED' THEN $4::date END,CASE WHEN $11::date IS NULL THEN NULL ELSE 'OTHER' END,$11,$12,$12) RETURNING id r`,[
 `retirement-active-synthetic-${n}`,`NF-SYN-${n}`,r.name,today,r.days,r.amount,r.collector,r.status,
 r.status==='VALIDATED'?'VALIDATED':r.status==='PENDING_VALIDATION'?'PENDING':'NONE',
 ['VALIDATED','PENDING_VALIDATION'].includes(r.status)?'IMPORTACAO_DIARIA':null,r.next,importId]);};
const list=(search,queue='active',financial=null)=>scalar("SELECT public.collection_workbench($1,NULL,false,NULL,'delay_desc',NULL,0,500,$2,NULL,NULL,NULL,$3) r",[search,queue,financial]);
const details=titleId=>scalar('SELECT public.collection_case_detail($1) r',[titleId]);
const work=async(titleId)=>scalar("SELECT public.collection_work_action($1,'START',$2,$3) r",[titleId,(await title(titleId)).revision,randomUUID()]);
const summary=()=>scalar('SELECT public.receivables_summary($1,$1) r',[today]);
const management=()=>scalar('SELECT public.receivables_management_summary($1) r',[today]);
const financeCount=async()=>{await owner();return scalar('SELECT count(*)::int r FROM public.effective_receivable_receipts');};
try{
 await owner();for(const n of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(n=>/^\d{3}_.*\.sql$/.test(n)&&Number(n.slice(0,3))>=35&&Number(n.slice(0,3))<=46&&!n.startsWith('039_')).sort())await db.exec(await file(n));
 await db.exec(await file('047_receivables_complete_report.sql'));
 today=await scalar("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");tomorrow=await scalar('SELECT ($1::date+1)::text r',[today]);
 agent=id(71);await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,'Responsável sintética de retirada']);
 await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users.collector.id,agent,users.manager.id]);
 importId=await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES('grupo-consolidado','retirada-sintetica.xlsx',repeat('e',64),$1,1,1,0,0,0,'OPEN') RETURNING id r",[users.cr.id]);
 await test('retirement removes nominal debt from both CR summaries and the overdue collection summary without recording receipts',async()=>{
  const titleId=await fixture({amount:12345});await actor('cr');const before=await summary(),beforeManagement=await management(),beforeCollections=await scalar('SELECT public.collections_overdue_summary() r');
  const receipts=await financeCount();await retired(titleId);await actor('cr');const after=await summary(),afterManagement=await management(),afterCollections=await scalar('SELECT public.collections_overdue_summary() r');
  assert.equal(before.open_cents-after.open_cents,12345);assert.equal(before.overdue_cents-after.overdue_cents,12345);assert.equal(before.active_count-after.active_count,1);
  assert.equal(beforeManagement.open_cents-afterManagement.open_cents,12345);assert.equal(beforeManagement.overdue_cents-afterManagement.overdue_cents,12345);assert.equal(beforeManagement.active_count-afterManagement.active_count,1);
  assert.equal(beforeCollections.overdue_cents-afterCollections.overdue_cents,12345);assert.equal(beforeCollections.overdue_count-afterCollections.overdue_count,1);
  assert.equal(after.received_period_cents,before.received_period_cents);assert.equal(afterManagement.received_day_cents,beforeManagement.received_day_cents);assert.equal(await financeCount(),receipts);
 });
 await test('active workbench, return priority and financial ACTIVE exclude retired titles; history retains the same UUID as read-only',async()=>{
  const name=`Cliente de retorno sintético ${++seq}`,titleId=await fixture({name,next:today});await retired(titleId);await actor('collector');
  assert.equal((await list(name)).count,0);assert.equal((await list(name,'returns')).count,0);assert.equal((await list(name,'all','ACTIVE')).count,0);
  const history=await list(name,'history'),filtered=await list(name,'all','RETIRED_FROM_REPORT');assert.equal(history.count,1);assert.equal(filtered.count,1);
  assert.equal(history.rows[0].id,titleId);assert.equal(history.rows[0].retired_from_report,true);assert.equal(history.rows[0].can_start,false);assert.equal(history.rows[0].start_block_reason,'REPORT_RETIRED');
  assert.equal(history.priority.due_count,0);const d=await details(titleId);assert.equal(d.title.id,titleId);assert.equal(d.report_history.length,1);assert.equal(d.report_history[0].action,'RETIRED_UNWORKED');await reject(()=>work(titleId));
 });
 await test('retired pending payments cannot be manually dated, validated, reopened or assigned through finance writers',async()=>{
  const titleId=await fixture({status:'PENDING_VALIDATION',collector:null});await retired(titleId);const before=await financeCount();await actor('cr');const t=await title(titleId);
  await reject(()=>scalar('SELECT public.set_receivable_payment_date($1,$2,$3) r',[titleId,today,t.revision]),'23514');
  for(const decision of ['CONFIRM','NOT_LOCATED'])await reject(()=>scalar('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5) r',[titleId,decision,decision==='CONFIRM'?today:null,'Conferência sintética',t.revision]),'23514');
  await reject(()=>scalar('SELECT public.assign_receivable_collector($1,$2,$3) r',[t.customer_key,agent,'Atribuição sintética']),'23514');
  assert.equal(await financeCount(),before);assert.equal((await title(titleId)).status,'PENDING_VALIDATION');assert.equal((await title(titleId)).collector_id,null);
 });
 await test('retired collection writers cannot save contacts, drafts or legacy collection actions',async()=>{
  const titleId=await fixture();await retired(titleId);await actor('collector');const d=await details(titleId);
  await reject(()=>scalar('SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,NULL,false,$8) r',[titleId,'SEM SUCESSO','Teste sintético','Retornar',tomorrow,d.title.revision,d.case.revision,randomUUID()]));
  await reject(()=>scalar('SELECT public.record_collection_action($1,$2,$3,$4,$5,$6,NULL,NULL,$7) r',[titleId,'CONTACT',today,'RETRY',tomorrow,'Teste sintético',d.title.revision]));
  await reject(()=>scalar('SELECT public.save_collection_customer_contacts($1,$2,$3,NULL,$4,$5) r',[titleId,'[]','[]','synthetic-revision',randomUUID()]));
 });
 await test('contact cards and coverage leave the active queue while the stored contact remains available when the same title reappears',async()=>{
  const name=`Cliente contato preservado sintético ${++seq}`,titleId=await fixture({name});await actor('collector');const c=await scalar('SELECT public.collection_customer_context($1) r',[titleId]);
  await scalar('SELECT public.save_collection_customer_contacts($1,$2,$3,$4,$5,$6) r',[titleId,'["contato@example.invalid"]','["1133334444"]','Nota sintética preservada',c.contact.revision,randomUUID()]);
  await retired(titleId);await actor('collector');await reject(()=>scalar('SELECT public.collection_customer_context($1) r',[titleId]));
  const report=await scalar("SELECT public.collection_customer_contact_report($1) r",[name]);assert.equal(report.count,0);assert.equal(report.scope_count,0);
  await owner();assert.equal(await scalar('SELECT count(*)::int r FROM public.collection_customer_contacts WHERE customer_key=$1',[(await title(titleId)).customer_key]),1);
  await retired(titleId,false);await actor('collector');const restored=await scalar('SELECT public.collection_customer_context($1) r',[titleId]);assert.deepEqual(restored.contact.emails,['contato@example.invalid']);assert.equal(restored.contact.notes,'Nota sintética preservada');const history=(await details(titleId)).report_history;assert.deepEqual(history.map(e=>e.action),['REAPPEARED','RETIRED_UNWORKED']);assert.ok(history.every(e=>JSON.stringify(Object.keys(e).sort())===JSON.stringify(['action','created_at','id','reference_date','worked'])));
 });
 await test('description-reference matching does not count retired titles as an active financial match',async()=>{
  const titleId=await fixture();await retired(titleId);await owner();const t=await title(titleId),job=randomUUID(),context=await scalar('SELECT cf_private.collection_reference_key($1,$2,$3) r',[t.branch,t.document,t.customer_key]);
  await db.query("INSERT INTO cf_private.collection_reference_jobs(id,created_by,mode,source_name,source_size,source_sha256,storage_path) VALUES($1,$2,'DESCRIPTIONS','referencia-sintetica.xlsx',100,repeat('f',64),$3)",[job,users.cr.id,`synthetic/${job}`]);
  await db.query("INSERT INTO cf_private.collection_reference_rows(job_id,row_hash,source_line,canonical,problems,customer_key,context_key,invalid) VALUES($1,repeat('a',64),2,$2,'[]',$3,$4,false)",[job,JSON.stringify({client_name:t.client_name,client_document:null,branch:t.branch,document:t.document,description:'Descrição sintética'}),t.customer_key,context]);
  await db.query('SELECT cf_private.analyze_collection_reference_job($1)',[job]);const row=(await db.query('SELECT outcome,matched_title_count FROM cf_private.collection_reference_rows WHERE job_id=$1',[job])).rows[0];assert.equal(row.outcome,'UNMATCHED');assert.equal(row.matched_title_count,0);
 });
 await test('email draft separates real pending debt and omits retired titles without changing the stored financial history',async()=>{
  const name=`Cliente email de retirada sintético ${++seq}`,anchor=await fixture({name}),upcoming=await fixture({name,days:-10,amount:20000}),gone=await fixture({name,amount:30000});await actor('collector');await work(anchor);const d=await details(anchor),request=randomUUID();
  await scalar('SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,NULL,true,$8) r',[anchor,'COBRANCA VIA EMAIL','Nota interna sintética','Retornar',tomorrow,d.title.revision,d.case.revision,request]);
  const before=await scalar('SELECT public.prepare_collection_customer_email($1) r',[request]);assert.equal(before.total_cents,60000);
  await retired(gone);await actor('collector');const after=await scalar('SELECT public.prepare_collection_customer_email($1) r',[request]);assert.equal(after.total_cents,30000);assert.equal(after.overdue_cents,10000);assert.equal(after.upcoming_cents,20000);assert.deepEqual(new Set(after.rows.map(x=>x.title_id)),new Set([anchor,upcoming]));
  assert.equal((await title(gone)).amount_cents,30000);assert.equal((await title(gone)).status,'OPEN');
 });
 await test('another carteira, restricted CP and Director cannot use retirement to gain writer access',async()=>{
  const hidden=await fixture({collector:null});await retired(hidden);await actor('collector');await reject(()=>details(hidden));
  await actor('cp');await reject(()=>list(''));await reject(()=>scalar('SELECT public.validate_receivable_payment($1,$2,NULL,$3,$4) r',[hidden,'NOT_LOCATED','Teste sintético',1]));await actor('director');const h=await list('','history');assert.ok(h.rows.some(r=>r.retired_from_report));await reject(()=>work(hidden));
 });
 console.log(`Passed ${passed} retired receivable active-readmodel SQL tests.`);
}catch(error){console.error('FAIL',error.message,error.code??'',error.where??'',error.stack);process.exitCode=1;}finally{await db.close();}
