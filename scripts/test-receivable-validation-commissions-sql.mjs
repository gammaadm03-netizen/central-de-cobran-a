import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivableValidationCommissionsSql } from './bundle-receivable-validation-commissions.mjs';

// PostgreSQL descartável com informações exclusivamente sintéticas.
const f=await createCostFixture(),{db,users,id,owner,actor,scalar,file,snapshot}=f;
const installer=await buildReceivableValidationCommissionsSql();
let passed=0,seq=89000,today,importId,agent;
const add=(d,n)=>{const v=new Date(d+'T12:00:00Z');v.setUTCDate(v.getUTCDate()+n);return v.toISOString().slice(0,10)};
const current=async t=>{await owner();return scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[t.id])};
const title=async(options={})=>{
 await owner('cr');const n=++seq,r={amount:20000,due:add(today,-80),status:'OPEN',source:null,collector:agent,reported:false,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,reported_in_collection,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$1,$2,cf_private.receivable_customer_key($2,NULL),'4',$3,$4,$5,$6,CASE WHEN $6='PENDING_VALIDATION' THEN 'PENDING' ELSE 'NONE' END,$7,CASE WHEN $6='PENDING_VALIDATION' THEN $8::date END,$9,$10,$10) RETURNING to_jsonb(receivable_titles) r`,['NF-SINT-'+n,'Cliente sintético '+n,r.due,r.amount,r.collector,r.status,r.source,add(today,-2),r.reported,importId]);
};
const movement=async(t,action='CONTACT')=>{await owner('cr');return scalar("INSERT INTO public.receivable_collection_events(title_id,collector_id,action,observation,created_by) VALUES($1,$2,$3,'Contato original sintético',$4) RETURNING to_jsonb(receivable_collection_events) r",[t.id,t.collector_id,action,users.collector.id])};
const retire=async(t,worked=true)=>{await owner('cr');await scalar('SELECT cf_private.record_receivable_report_event($1,$2,$3,$4,$5) r',[t.id,worked?'RETIRED_WORKED':'RETIRED_UNWORKED',importId,randomUUID(),today]);return current(t)};
const retired=async(options={})=>{const t=await title(options);await movement(t);return retire(t)};
const queue=(options={})=>scalar('SELECT public.receivable_retired_validation_queue($1,$2,$3,$4) r',[options.search??'',options.collector??null,options.offset??0,options.limit??25]);
const pending=()=>scalar("SELECT public.pending_collection_commissions('',NULL,0,100) r");
const commissions=(start=today,end=start)=>scalar("SELECT public.commissions_report('COLLECTOR',$1,$2,NULL,NULL,0,100) r",[start,end]);
const call=(t,options={})=>scalar('SELECT public.validate_receivable_payment_v2($1,$2,$3,$4,$5,$6,$7,$8) r',[
 t.id,options.decision??'CONFIRM',Object.hasOwn(options,'date')?options.date:today,Object.hasOwn(options,'received')?options.received:t.amount_cents,
 options.reason??null,options.observation??'Conferência bancária sintética',options.revision??t.revision,options.request??randomUUID()]);
const receipt=async t=>{await owner();return scalar('SELECT to_jsonb(r) r FROM public.receivable_receipts r WHERE title_id=$1',[t.id])};
const reject=async(fn,code='42501')=>{await db.exec('SAVEPOINT expected_error');try{await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}finally{await db.exec('ROLLBACK TO SAVEPOINT expected_error;RELEASE SAVEPOINT expected_error')}};
const test=async(name,fn)=>{await owner();await db.exec('BEGIN');try{await fn();passed++;console.log('PASS',name)}finally{await db.exec('ROLLBACK');await actor('cr')}};

try{
 await owner();for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql'])await db.exec(await file(name));
 today=await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");
 agent=id(++seq);await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,'Responsável sintética']);
 await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users.collector.id,agent,users.manager.id]);
 importId=await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES('grupo-consolidado','base-sintetica.csv',repeat('e',64),$1,1,1,0,0,0,'OPEN') RETURNING id r",[users.cr.id]);
 // Registra uma confirmação 053 antes da atualização para verificar o replay real.
 await db.exec(await file('053_receivable_financial_validation.sql'));
 const old=await title({status:'PENDING_VALIDATION',source:'COBRANCA',reported:true}),oldRequest=randomUUID();await actor('cr');const oldProof=await call(old,{request:oldRequest});assert.equal(oldProof.format_version,'053');
 await owner();const oldCalculation=await scalar("SELECT pg_get_functiondef('cf_private.collector_commission_rows(date,date,text)'::regprocedure) r");
 const oldLegacy=await scalar("SELECT pg_get_functiondef('public.validate_receivable_payment(uuid,text,date,text,bigint)'::regprocedure) r");
 const before=await snapshot();await db.exec(installer);const after=await snapshot();delete before['public.central_schema_migrations'];delete after['public.central_schema_migrations'];assert.deepEqual(after,before);
 assert.equal(await scalar("SELECT pg_get_functiondef('cf_private.collector_commission_rows(date,date,text)'::regprocedure) r"),oldCalculation);
 assert.equal(await scalar("SELECT pg_get_functiondef('public.validate_receivable_payment(uuid,text,date,text,bigint)'::regprocedure) r"),oldLegacy);
 await db.exec(installer);assert.equal(await scalar("SELECT count(*)::integer r FROM public.central_schema_migrations WHERE version='055_receivable_validation_commissions'"),1);
 assert.equal(await readFile(new URL('../supabase/dashboard/ativar-validacao-comissoes-recebiveis.sql',import.meta.url),'utf8'),installer);
 console.log('PASS complete installer reapplies safely without rewriting data, old receipts, calculation rules or legacy validation');passed++;
 await actor('manager');await scalar("SELECT public.configure_commission_rule('COLLECTOR','1900-01-01','',$1,'Regra sintética confirmada') r",[JSON.stringify({eligible_collector_ids:[agent]})]);

 await test('a request committed by 053 replays its exact original proof after 055 without duplicate receipts',async()=>{await actor('cr');const before=await snapshot();await actor('cr');assert.deepEqual(await call(old,{request:oldRequest}),oldProof);assert.deepEqual(await snapshot(),before)});
 await test('retired worked OPEN title with no reported payment can be financially confirmed and leaves both queues',async()=>{
  const t0=await title(),originalEvent=await movement(t0),t=await retire(t0);await actor('cr');assert((await queue()).rows.some(r=>r.id===t.id));await actor('manager');assert((await pending()).rows.some(r=>r.title_id===t.id));
  await actor('cr');const r=await call(t,{received:18000,reason:'Retenção sintética'});assert.equal(r.format_version,'055');assert.equal(r.nominal_cents,20000);assert.equal(r.received_cents,18000);assert.equal(r.adjustment_cents,2000);
  const now=await current(t);assert.equal(now.status,'VALIDATED');assert.equal(now.validation_status,'VALIDATED');assert.equal(now.retired_from_report,true);assert.equal(now.in_latest_report,false);assert.equal(now.amount_cents,t.amount_cents);assert.equal(now.due_date,t.due_date);assert.equal(now.collector_id,t.collector_id);assert.equal(now.payment_source,'COBRANCA');assert.equal(now.reported_in_collection,true);assert.equal(now.next_action_date,null);
  const row=await receipt(t);assert.equal(row.amount_cents,18000);assert.equal(row.payment_source,'COBRANCA');assert.equal(row.reported_in_collection,true);assert.equal(row.manual_nominal_amount_cents,20000);assert.equal(row.manual_adjustment_cents,2000);assert.equal(row.manual_original_due_date,t.due_date);
  assert.deepEqual(await scalar('SELECT to_jsonb(e) r FROM public.receivable_collection_events e WHERE id=$1',[originalEvent.id]),originalEvent);
  await actor('cr');assert(!(await queue()).rows.some(r=>r.id===t.id));await actor('manager');assert(!(await pending()).rows.some(r=>r.title_id===t.id));const wallet=await scalar("SELECT public.collection_workbench(p_queue=>'active') r");assert(!wallet.rows.some(r=>r.id===t.id));
  await actor('manager');const base=(await commissions()).rows.find(r=>r.title_id===t.id);assert(base);assert.equal(base.amount_cents,18000);assert.equal(base.date,today);assert.equal(base.eligibility,'ASSESSED');assert.equal(base.commission_cents,54);
 });
 await test('every retired operational status can be confirmed without reopening the title or changing its original source',async()=>{
  for(const status of ['NEW','OPEN','NOT_LOCATED','PENDING_VALIDATION']){const t=await retired({status,source:status==='PENDING_VALIDATION'?'IMPORTACAO_DIARIA':null});await actor('cr');await call(t);const now=await current(t);assert.equal(now.status,'VALIDATED');assert.equal(now.retired_from_report,true);assert.equal(now.payment_source,status==='PENDING_VALIDATION'?'IMPORTACAO_DIARIA':'COBRANCA')}
 });
 await test('a started work interval alone is enough collection evidence and remains preserved after retirement and validation',async()=>{
  const t0=await title();await actor('collector');await scalar("SELECT public.collection_work_action($1,'START',$2,$3) r",[t0.id,t0.revision,randomUUID()]);const t=await retire(t0);await actor('cr');assert((await queue()).rows.some(r=>r.id===t.id));await call(t);await owner();assert.equal(await scalar("SELECT count(*)::integer r FROM public.collection_work_sessions WHERE title_id=$1 AND end_reason='REPORT_RETIRED' AND ended_at IS NOT NULL",[t.id]),1);await actor('manager');assert((await commissions()).rows.some(r=>r.title_id===t.id))
 });
 await test('the existing active pending flow still confirms, closes its own running interval and sends worked net receipts to commissions',async()=>{
  const t=await title({status:'PENDING_VALIDATION',source:'COBRANCA',reported:true});await owner('collector');await db.query("INSERT INTO public.collection_work_sessions(title_id,actor_id,collector_id,document_snapshot,client_name_snapshot,branch_snapshot,collector_name_snapshot) VALUES($1,$2,$3,$4,$5,'4','Responsável sintética')",[t.id,users.collector.id,agent,t.document,t.client_name]);await actor('cr');const proof=await call(t);assert.equal(proof.format_version,'055');assert.equal((await current(t)).retired_from_report,false);assert.equal(await scalar('SELECT count(*)::integer r FROM public.collection_work_sessions WHERE title_id=$1 AND ended_at IS NULL',[t.id]),0);await actor('manager');assert((await commissions()).rows.some(r=>r.title_id===t.id))
 });
 await test('validation without collection movement records the actual receipt but does not invent a commissionable collection',async()=>{
  const t=await title({status:'PENDING_VALIDATION',source:'IMPORTACAO_DIARIA'});await actor('cr');await call(t);assert.equal((await receipt(t)).reported_in_collection,false);await actor('manager');assert(!(await commissions()).rows.some(r=>r.title_id===t.id))
 });
 await test('no collection movement means no retired queue entry or manual retired confirmation',async()=>{
  const t=await retire(await title(),false);await actor('cr');assert(!(await queue()).rows.some(r=>r.id===t.id));await reject(()=>call(t),'PV001');assert.equal(await receipt(t),undefined)
 });
 await test('receipt date selects its actual month and preserves the existing no-commission rule up to 30 days',async()=>{
  const paid=add(today,-70),t=await retired({due:add(paid,10)});await actor('cr');await call(t,{date:paid});await actor('manager');assert(!(await commissions()).rows.some(r=>r.title_id===t.id));const historical=(await commissions(paid)).rows.find(r=>r.title_id===t.id);assert(historical);assert.equal(historical.delay_days,0);assert.equal(historical.commission_cents,0);assert.equal(historical.eligibility,'NO_COMMISSION')
 });
 await test('a missing commission rule remains a configuration pendency without blocking the financial receipt',async()=>{
  const t=await retired();await owner();await db.exec('ALTER TABLE public.commission_rule_versions DISABLE TRIGGER commission_rule_versions_immutable');await db.exec("DELETE FROM public.commission_rule_versions WHERE kind='COLLECTOR'");await db.exec('ALTER TABLE public.commission_rule_versions ENABLE TRIGGER commission_rule_versions_immutable');await actor('cr');await call(t);await actor('manager');const row=(await commissions()).rows.find(r=>r.title_id===t.id);assert.equal(row.eligibility,'PENDING_RULE');assert.equal(row.commission_cents,null);assert(!(await pending()).rows.some(r=>r.title_id===t.id));
 });
 await test('a collector outside the configured commission rule still settles financially with zero commission',async()=>{
  const t=await retired();await actor('manager');await scalar("SELECT public.configure_commission_rule('COLLECTOR','1900-01-02','',$1,'Regra sintética sem responsável habilitada') r",[JSON.stringify({eligible_collector_ids:[]})]);await actor('cr');await call(t);await actor('manager');const row=(await commissions()).rows.find(r=>r.title_id===t.id);assert.equal(row.eligibility,'NOT_ELIGIBLE');assert.equal(row.commission_cents,0);assert(!(await pending()).rows.some(r=>r.title_id===t.id));
 });
 await test('later identical Quitados import matches the manual retired receipt without duplicating it; divergences stay blocked',async()=>{
  const t=await retired();await actor('cr');const proof=await call(t,{received:18000,reason:'Retenção sintética'}),row={document:t.document,client_name:t.client_name,client_document:null,branch:t.branch,issued_on:null,due_date:t.due_date,amount_cents:t.amount_cents,received_on:today,received_amount_cents:18000};
  const preview=await scalar("SELECT public.preview_receivables_received_import('grupo-consolidado',$1,$2) r",[JSON.stringify([row]),JSON.stringify({'1':t.id})]);assert.equal(preview.can_commit,true);assert.equal(preview.matched_count,1);assert.equal(preview.rows[0].receipt_id,proof.receipt_id);
  const conflict=await scalar("SELECT public.preview_receivables_received_import('grupo-consolidado',$1,$2) r",[JSON.stringify([{...row,received_amount_cents:17999}]),JSON.stringify({'1':t.id})]);assert.equal(conflict.can_commit,false);assert.equal(conflict.conflict_count,1);
  const token=await scalar('SELECT public.get_receivables_sync_revision() r'),bytes=Buffer.from('Quitados sintético após confirmação manual');await owner();await db.exec('SET ROLE service_role');const result=await scalar("SELECT public.commit_receivables_received_import_from_gateway($1,$2,'grupo-consolidado','quitados-sinteticos.csv',$3,$4,$5,$6,$7,$8,false) r",[users.cr.id,users.cr.session,createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify([row]),JSON.stringify({'1':t.id}),token.import_id,token.financial_revision]);assert.equal(result.matched_count,1);await owner();assert.equal(await scalar('SELECT count(*)::integer r FROM public.receivable_receipts WHERE title_id=$1',[t.id]),1);assert.equal((await receipt(t)).id,proof.receipt_id);assert.equal((await current(t)).retired_from_report,true);await actor('manager');assert.equal((await commissions()).rows.filter(r=>r.title_id===t.id).length,1);assert(!(await pending()).rows.some(r=>r.title_id===t.id));
 });
 await test('retired not-located cannot reopen or return a title through the receipt validation form',async()=>{
  const t=await retired();await actor('cr');await reject(()=>call(t,{decision:'NOT_LOCATED',date:null,received:null}),'PV001');assert.equal((await current(t)).retired_from_report,true);assert.equal(await receipt(t),undefined)
 });
 await test('retired confirmation still requires real dates, positive exact net amounts and justified full-settlement retention',async()=>{
  const t=await retired();for(const options of [{date:add(today,1),code:'PV004'},{date:null,code:'PV004'},{received:null,code:'PV005'},{received:0,code:'PV005'},{received:20001,code:'PV005'},{received:18000,code:'PV006'},{reason:'Sem desconto',code:'PV006'}]){await actor('cr');await reject(()=>call(t,options),options.code)}assert.equal(await receipt(t),undefined)
 });
 await test('same request replay is exact; another payload or a fresh confirmation cannot duplicate an existing receipt',async()=>{
  const t=await retired(),request=randomUUID();await actor('cr');const result=await call(t,{request}),before=await snapshot();await actor('cr');assert.deepEqual(await call(t,{request}),result);assert.deepEqual(await snapshot(),before);await actor('cr');await reject(()=>call(t,{request,received:19000,reason:'Outro desconto'}),'22023');await reject(()=>call(t),'PV003')
 });
 await test('a title reappearing or changing revision after queue read cannot be confirmed from that stale retirement',async()=>{
  const t=await retired();await owner('cr');await scalar("SELECT cf_private.record_receivable_report_event($1,'REAPPEARED',$2,$3,$4) r",[t.id,importId,randomUUID(),today]);await actor('cr');await reject(()=>call(t),'40001');const fresh=await current(t);await actor('cr');await reject(()=>call(fresh),'PV002');assert.equal(await receipt(t),undefined)
 });
 await test('retired queue search, collector filtering, paging and evidence are authoritative and bounded',async()=>{
  const first=await retired(),second=await retired(),other=id(++seq);await owner();await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[other,'Outra responsável']);const third=await retired({collector:other});await actor('cr');const all=await queue(),one=await queue({search:first.document}),page=await queue({offset:1,limit:1}),filtered=await queue({collector:agent});assert.equal(all.format_version,'055');assert.equal(all.count,3);assert.equal(one.count,1);assert.equal(one.rows[0].id,first.id);assert.equal(page.count,3);assert.equal(page.rows.length,1);assert.equal(filtered.count,2);assert(!filtered.rows.some(r=>r.id===third.id));assert(all.rows.every(r=>r.collection_worked===true&&r.retired_from_report===true));for(const options of [{offset:-1},{offset:1000001},{limit:0},{limit:101},{search:'x'.repeat(501)}])await reject(()=>queue(options),'22023');
 });
 await test('finance and manager may read and confirm; director may only read; all other profiles and unapproved sessions are blocked',async()=>{
  const t=await retired();for(const who of ['cr','manager','director']){await actor(who);assert((await queue()).rows.some(r=>r.id===t.id))}for(const who of ['cp','rh','collector']){await actor(who);await reject(()=>queue());await reject(()=>call(t))}await actor('director');await reject(()=>call(t));await owner();await db.query('DELETE FROM cf_private.approved_sessions WHERE session_id=$1',[users.cr.session]);await actor('cr');await reject(()=>queue());await reject(()=>call(t));
 });
 await test('anonymous and service roles cannot call the retired queue or validation RPC',async()=>{
  const t=await retired();for(const role of ['anon','service_role']){await owner('cr');await db.exec('SET ROLE '+role);await reject(()=>queue());await reject(()=>call(t));await owner()}
 });
 await test('a late audit failure rolls back receipt, title, queue state, collection event and replay proof together',async()=>{
  const t=await retired();await owner();await db.exec("CREATE FUNCTION cf_private.synthetic_retired_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='receivable_financial_validation' THEN RAISE EXCEPTION 'Falha sintética' USING ERRCODE='22023';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_retired_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_retired_failure()");const before=await snapshot();await actor('cr');await reject(()=>call(t,{received:19000,reason:'Retenção sintética'}),'22023');assert.deepEqual(await snapshot(),before)
 });
 console.log(`${passed} receivable validation and commission SQL checks passed.`);
}catch(error){console.error('FAIL',error.message,error.code??'',error.where??'',error.stack);process.exitCode=1}finally{await db.close()}
