import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivableFinancialValidationSql } from './bundle-receivable-financial-validation.mjs';

// PostgreSQL local descartável: nenhuma identidade, dívida ou retenção real.
const f=await createCostFixture(),{db,users,id,owner,actor,scalar,file,snapshot}=f;
const installer=await buildReceivableFinancialValidationSql();
let passed=0,seq=85000,today,importId,agent;
const add=(d,n)=>{const v=new Date(d+'T12:00:00Z');v.setUTCDate(v.getUTCDate()+n);return v.toISOString().slice(0,10)};
const title=async(options={})=>{
 await owner('cr');const n=++seq,r={amount:20000,due:add(today,-45),status:'PENDING_VALIDATION',source:'COBRANCA',collector:agent,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,reported_in_collection,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$1,'Órgão sintético',cf_private.receivable_customer_key('Órgão sintético',NULL),'4',$2,$3,$4,$5,CASE WHEN $5='PENDING_VALIDATION' THEN 'PENDING' ELSE 'NONE' END,$6,$7,true,$8,$8) RETURNING to_jsonb(receivable_titles) r`,['NF-TEST-'+n,r.due,r.amount,r.collector,r.status,r.source,add(today,-2),importId]);
};
const call=(t,options={})=>scalar('SELECT public.validate_receivable_payment_v2($1,$2,$3,$4,$5,$6,$7,$8) r',[
 options.titleId??t.id,options.decision??'CONFIRM',Object.hasOwn(options,'date')?options.date:today,
 Object.hasOwn(options,'received')?options.received:t.amount_cents,
 options.reason??null,options.observation??'Conferência bancária sintética',options.revision??t.revision,options.request??randomUUID()]);
const current=async t=>{await owner();return scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[t.id])};
const receipts=async t=>{await owner();return scalar("SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') r FROM public.receivable_receipts r WHERE title_id=$1",[t.id])};
const requests=async()=>{await owner();return scalar('SELECT count(*)::integer r FROM cf_private.receivable_financial_validation_requests')};
const reject=async(fn,code='42501')=>{await db.exec('SAVEPOINT expected_error');try{await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}finally{await db.exec('ROLLBACK TO SAVEPOINT expected_error;RELEASE SAVEPOINT expected_error')}};
const test=async(name,fn)=>{await owner();await db.exec('BEGIN');try{await fn();passed++;console.log('PASS',name)}finally{await db.exec('ROLLBACK');await actor('cr')}};
const receiptFields=['manual_nominal_amount_cents','manual_original_due_date','manual_adjustment_cents','manual_adjustment_reason'];

try {
 await owner();for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql'])await db.exec(await file(name));
 today=await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");
 agent=id(++seq);await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,'Responsável sintética']);
 await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users.collector.id,agent,users.manager.id]);
 importId=await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES('grupo-consolidado','base-sintetica.csv',repeat('c',64),$1,1,1,0,0,0,'OPEN') RETURNING id r",[users.cr.id]);
 const legacy=await title();await actor('cr');await scalar('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5) r',[legacy.id,'CONFIRM',today,'Validação legada sintética',legacy.revision]);
 const oldView=await scalar('SELECT to_jsonb(r) r FROM public.effective_receivable_receipts r WHERE title_id=$1',[legacy.id]);
 const oldFunction=await scalar("SELECT pg_get_functiondef('public.validate_receivable_payment(uuid,text,date,text,bigint)'::regprocedure) r");
 const before=await snapshot();await db.exec(installer);const after=await snapshot();
 delete before['public.central_schema_migrations'];delete after['public.central_schema_migrations'];delete after['cf_private.receivable_financial_validation_requests'];
 for(const row of after['public.receivable_receipts'])for(const key of receiptFields){assert.equal(row[key],null);delete row[key]}
 assert.deepEqual(after,before);assert.deepEqual(await scalar('SELECT to_jsonb(r) r FROM public.effective_receivable_receipts r WHERE title_id=$1',[legacy.id]),oldView);
 assert.equal(await scalar("SELECT pg_get_functiondef('public.validate_receivable_payment(uuid,text,date,text,bigint)'::regprocedure) r"),oldFunction);
 await db.exec(installer);assert.equal(await scalar("SELECT count(*)::integer r FROM public.central_schema_migrations WHERE version='053_receivable_financial_validation'"),1);
 assert.equal(await readFile(new URL('../supabase/dashboard/ativar-validacao-financeira-recebiveis.sql',import.meta.url),'utf8'),installer);
 console.log('PASS installer reapplies safely and preserves old data, effective receipts and legacy RPC');passed++;

 await test('a net receipt separates nominal, received value and explicit retention without changing the title or report',async()=>{
  const t=await title();await owner('cr');const event=await scalar("INSERT INTO public.receivable_collection_events(title_id,collector_id,action,observation,payment_date,created_by) VALUES($1,$2,'PAID',$3,$4,$5) RETURNING to_jsonb(receivable_collection_events) r",[t.id,agent,'Relato original preservado',add(today,-2),users.collector.id]);
  await actor('cr');const r=await call(t,{received:19000,reason:' Retenção fiscal sintética ',date:add(today,-1)});
  assert.equal(r.format_version,'053');assert.equal(r.title_id,t.id);assert.equal(r.received_cents,19000);assert.equal(r.nominal_cents,20000);assert.equal(r.adjustment_cents,1000);assert.equal(r.adjustment_reason,'Retenção fiscal sintética');assert.equal(r.payment_date,add(today,-1));
  const now=await current(t);assert.equal(now.amount_cents,t.amount_cents);assert.equal(now.due_date,t.due_date);assert.equal(now.collector_id,t.collector_id);assert.equal(now.status,'VALIDATED');assert.equal(now.revision,t.revision+1);
  const [receipt]=await receipts(t);assert.equal(receipt.amount_cents,19000);assert.equal(receipt.manual_nominal_amount_cents,20000);assert.equal(receipt.manual_original_due_date,t.due_date);assert.equal(receipt.manual_adjustment_cents,1000);assert.equal(receipt.manual_adjustment_reason,'Retenção fiscal sintética');
  const effective=await scalar('SELECT to_jsonb(r) r FROM public.effective_receivable_receipts r WHERE title_id=$1',[t.id]);assert.equal(effective.amount_cents,19000);assert.equal(effective.nominal_amount_cents,20000);assert.equal(effective.original_due_date,t.due_date);assert.equal(effective.source_kind,'MANUAL_VALIDATION');
  assert.deepEqual(await scalar('SELECT to_jsonb(e) r FROM public.receivable_collection_events e WHERE id=$1',[event.id]),event);
  const audit=await scalar("SELECT after_value r FROM public.audit_events WHERE entity='receivable_financial_validation' AND record_id=$1",[t.id]);assert.equal(audit.received_cents,19000);assert.equal(audit.adjustment_cents,1000);assert.equal(audit.observation,'Conferência bancária sintética');
 });
 await test('full receipt needs no adjustment reason and confirms the exact original cents',async()=>{const t=await title({amount:12345});await actor('cr');const r=await call(t);assert.equal(r.received_cents,12345);assert.equal(r.adjustment_cents,0);assert.equal(r.adjustment_reason,null);assert.equal((await receipts(t))[0].amount_cents,12345)});
 await test('lost-response replay returns the original proof exactly and never adds a second financial or audit event',async()=>{
  const t=await title(),request=randomUUID();await actor('cr');const r=await call(t,{received:19500,reason:'Desconto sintético',request}),before=await snapshot();await actor('cr');assert.deepEqual(await call(t,{received:19500,reason:'Desconto sintético',request}),r);assert.deepEqual(await snapshot(),before);
  await actor('cr');await reject(()=>call(t,{received:19000,reason:'Desconto sintético',request}),'22023');assert.equal((await receipts(t)).length,1);
 });
 await test('a fresh protocol cannot duplicate a title that already has a receipt',async()=>{const t=await title();await actor('cr');await call(t);await reject(()=>call(t),'PV003');assert.equal((await receipts(t)).length,1)});
 await test('exact cents at the safe integer bound are accepted without multiplication or floating point rounding',async()=>{
  const t=await title({amount:9007199254740991});await actor('cr');const r=await call(t,{received:9007199254740990,reason:'Ajuste sintético de um centavo'});assert.equal(r.received_cents,9007199254740990);assert.equal(r.adjustment_cents,1);assert.equal((await receipts(t))[0].amount_cents,9007199254740990);
 });
 await test('negative, missing, excess, unsafe and zero received amounts reject without any financial or protocol write',async()=>{
  const t=await title();for(const received of [null,-1,0,20001,9007199254740992]){await actor('cr');await reject(()=>call(t,{received}),'PV005')}assert.equal((await receipts(t)).length,0);assert.equal(await requests(),0);assert.equal((await current(t)).status,'PENDING_VALIDATION');
  await actor('cr');await reject(()=>call(t,{received:1.5}),'22P02');
 });
 await test('a legacy zero-value title remains supported only as a zero receipt without adjustment',async()=>{const t=await title({amount:0});await actor('cr');const r=await call(t,{received:0});assert.equal(r.received_cents,0);assert.equal(r.adjustment_cents,0);assert.equal((await receipts(t))[0].amount_cents,0)});
 await test('a difference requires a meaningful reason and a full receipt rejects an unrelated adjustment reason',async()=>{
  const t=await title();for(const reason of [null,'','   ','\n\t','\u00a0']){await actor('cr');await reject(()=>call(t,{received:19000,reason}),'PV006')}await actor('cr');await reject(()=>call(t,{reason:'Retenção sem diferença'}),'PV006');await reject(()=>call(t,{received:19000,reason:'x'.repeat(5001)}),'22023');assert.equal((await receipts(t)).length,0);
 });
 await test('real dates are bounded by São Paulo today, not the due date or collector report',async()=>{
  const t=await title({due:today});await actor('cr');const early=add(today,-10),r=await call(t,{date:early});assert.equal(r.payment_date,early);assert.equal((await receipts(t))[0].delay_days,0);
  const other=await title();for(const date of [null,'1899-12-31',add(today,1)]){await actor('cr');await reject(()=>call(other,{date}),'PV004')}assert.equal((await receipts(other)).length,0);
 });
 await test('a title retired by the complete report cannot be manually confirmed or returned to collection',async()=>{
  const t=await title();await owner('cr');await scalar("SELECT cf_private.record_receivable_report_event($1,'RETIRED_WORKED',$2,$3,$4) r",[t.id,importId,randomUUID(),today]);const gone=await current(t);
  for(const decision of ['CONFIRM','NOT_LOCATED']){await actor('cr');await reject(()=>call(gone,{decision,date:decision==='CONFIRM'?today:null,received:decision==='CONFIRM'?19000:null,reason:decision==='CONFIRM'?'Retenção sintética':null}),'PV001')}assert.equal((await receipts(t)).length,0);assert.equal(await requests(),0);
 });
 await test('stale revision and nonpending status are distinguished before any write',async()=>{
  const t=await title();await owner();await db.query("UPDATE public.receivable_titles SET next_action='RETRY' WHERE id=$1",[t.id]);await actor('cr');await reject(()=>call(t),'40001');
  const open=await title({status:'OPEN'});await actor('cr');await reject(()=>call(open),'PV002');const missingSource=await title({source:null});await actor('cr');await reject(()=>call(missingSource),'PV002');assert.equal((await receipts(t)).length,0);
 });
 await test('not located returns the same collector and preserves the reported event without creating cash or retention',async()=>{
  const t=await title();await actor('cr');const request=randomUUID(),r=await call(t,{decision:'NOT_LOCATED',date:null,received:null,observation:'Pagamento não localizado em conferência sintética',request});assert.equal(r.decision,'NOT_LOCATED');assert.equal(r.receipt_id,null);assert.equal(r.received_cents,null);assert.equal(r.adjustment_cents,null);assert.equal(r.payment_date,null);assert.equal((await receipts(t)).length,0);const now=await current(t);assert.equal(now.collector_id,t.collector_id);assert.equal(now.status,'NOT_LOCATED');assert.equal(now.collector_locked,true);await actor('cr');assert.deepEqual(await call(t,{decision:'NOT_LOCATED',date:null,received:null,observation:'Pagamento não localizado em conferência sintética',request}),r);
 });
 await test('not located requires a collector, justification and empty financial fields',async()=>{
  const t=await title();for(const options of [{date:today,received:null},{date:null,received:100},{date:null,received:null,reason:'Retenção indevida'}]){await actor('cr');await reject(()=>call(t,{decision:'NOT_LOCATED',...options}),'22023')}
  await actor('cr');await reject(()=>call(t,{decision:'NOT_LOCATED',date:null,received:null,observation:' '}),'PV006');const noOwner=await title({collector:null});await actor('cr');await reject(()=>call(noOwner,{decision:'NOT_LOCATED',date:null,received:null}),'PV006');
 });
 await test('daily and monthly financial summaries and commission rows use received net cents, not the retained amount',async()=>{
  const t=await title();await actor('cr');const before=await scalar('SELECT public.receivables_management_summary($1) r',[today]);await call(t,{received:18000,reason:'Retenção sintética'});const summary=await scalar('SELECT public.receivables_management_summary($1) r',[today]);assert.equal(summary.received_day_cents-before.received_day_cents,18000);await actor('manager');const month=await scalar("SELECT public.commissions_report('COLLECTOR',$1,$1,NULL,NULL,0,100) r",[today]);const row=month.rows.find(r=>r.title_id===t.id);assert.ok(row);assert.equal(row.received_cents??row.amount_cents??row.received_amount_cents,18000);
 });
 await test('receipts and successful request results are immutable even for the table owner',async()=>{
  const t=await title();await actor('cr');await call(t);await owner();await reject(()=>db.query('UPDATE public.receivable_receipts SET amount_cents=1 WHERE title_id=$1',[t.id]));await reject(()=>db.exec("UPDATE cf_private.receivable_financial_validation_requests SET result='{}'"));await reject(()=>db.exec('DELETE FROM cf_private.receivable_financial_validation_requests'));
 });
 await test('late audit failure rolls back receipt, title state, collection events and request atomically',async()=>{
  const t=await title();await owner();await db.exec("CREATE FUNCTION cf_private.synthetic_validation_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='receivable_financial_validation' THEN RAISE EXCEPTION 'Falha sintética' USING ERRCODE='22023';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_validation_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_validation_failure()");const before=await snapshot();await actor('cr');await reject(()=>call(t,{received:19000,reason:'Retenção sintética'}),'22023');assert.deepEqual(await snapshot(),before);
 });
 await test('only authorized finance profiles and approved active sessions can validate or replay',async()=>{
  for(const who of ['director','cp','rh','collector']){const t=await title();await actor(who);await reject(()=>call(t))}
  const t=await title();await actor('manager');await call(t);const other=await title();await owner();await db.query('DELETE FROM cf_private.approved_sessions WHERE session_id=$1',[users.cr.session]);await actor('cr');await reject(()=>call(other));await owner();await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[users.manager.id]);await actor('manager');await reject(()=>call(other));
 });
 await test('RPC grants and private request table deny direct access to anon, authenticated and service roles',async()=>{
  const t=await title();for(const role of ['anon','service_role']){await owner('cr');await db.exec('SET ROLE '+role);await reject(()=>call(t));await reject(()=>db.exec('SELECT * FROM cf_private.receivable_financial_validation_requests'));await owner()}
  await actor('cr');await reject(()=>db.exec('SELECT * FROM cf_private.receivable_financial_validation_requests'));await reject(()=>db.exec("INSERT INTO cf_private.receivable_financial_validation_requests(actor_id,request_id,payload_sha256,result) VALUES(auth.uid(),gen_random_uuid(),repeat('a',64),'{}')"));
 });
 await test('manual receipt metadata constraints reject partial or contradictory adjustment details',async()=>{
  const t=await title();await owner();const sql=`INSERT INTO public.receivable_receipts(title_id,amount_cents,payment_date,delay_days,delay_band,payment_source,reported_in_collection,validated_by,manual_nominal_amount_cents,manual_original_due_date,manual_adjustment_cents,manual_adjustment_reason)
   VALUES($1,19000,$2,0,'ATE_30','COBRANCA',true,$3,$4,$5,$6,$7)`;
  for(const fields of [[20000,t.due_date,1000,null],[20000,null,1000,'Retenção'],[null,t.due_date,1000,'Retenção'],[20000,t.due_date,null,'Retenção'],[20000,t.due_date,900,'Retenção']])await reject(()=>db.query(sql,[t.id,today,users.cr.id,...fields]),'23514');
 });
 console.log(`${passed} receivable financial validation SQL checks passed.`);
}catch(error){console.error('FAIL',error.message,error.code??'',error.where??'',error.stack);process.exitCode=1}finally{await db.close()}
