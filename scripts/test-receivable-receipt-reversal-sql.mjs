import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivableReceiptReversalSql } from './bundle-receivable-receipt-reversal.mjs';

// PostgreSQL local descartável, sem informações financeiras reais.
const f=await createCostFixture(),{db,users,id,owner,actor,scalar,file,snapshot}=f;
const installer=await buildReceivableReceiptReversalSql();
let passed=0,seq=91000,today,agent,importId;
const add=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const title=async(options={})=>{
 await owner('cr');const n=++seq,r={amount:20000,due:add(today,-80),source:'COBRANCA',reported:true,collector:agent,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,reported_in_collection,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$1,$2,cf_private.receivable_customer_key($2,NULL),'4',$3,$4,$5,'PENDING_VALIDATION','PENDING',$6,$7,$8,$9,$9) RETURNING to_jsonb(receivable_titles) r`,['NF-SYN-'+n,'Órgão sintético '+n,r.due,r.amount,r.collector,r.source,add(today,-1),r.reported,importId]);
};
const current=async t=>{await owner();return scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[t.id])};
const validate=async(t,c={})=>{await actor('cr');return scalar('SELECT public.validate_receivable_payment_v2($1,$2,$3,$4,$5,$6,$7,$8) r',[t.id,'CONFIRM',c.date??today,c.received??t.amount_cents,c.reason??null,'Conferência sintética',t.revision,c.request??randomUUID()])};
const paid=async(options={})=>{const t=await title(options),proof=await validate(t,options),receipt=await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipts r WHERE id=$1',[proof.receipt_id]);return {t:await current(t),receipt,proof}};
const reverseArgs=(p,c={})=>[p.receipt.id,c.reason??'Validação manual feita por engano; recebimento não ocorreu.',c.revision??p.t.revision,c.request??randomUUID()];
const call=a=>scalar('SELECT public.reverse_receivable_receipt($1,$2,$3,$4) r',a);
const reverse=async(p,c={})=>{await actor('manager');return call(reverseArgs(p,c))};
const active=async t=>{await owner();return scalar("SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') r FROM public.active_receivable_receipts r WHERE title_id=$1",[t.id])};
const effective=async t=>{await owner();return scalar("SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') r FROM public.effective_receivable_receipts r WHERE title_id=$1",[t.id])};
const commissions=()=>scalar("SELECT public.commissions_report('COLLECTOR',$1,$1,NULL,NULL,0,100) r",[today]);
const reject=async(fn,code='42501')=>{await db.exec('SAVEPOINT expected_failure');try{await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}finally{await db.exec('ROLLBACK TO SAVEPOINT expected_failure;RELEASE SAVEPOINT expected_failure')}};
const test=async(name,fn)=>{await owner();await db.exec('BEGIN');try{await fn();passed++;console.log('PASS',name)}finally{await db.exec('ROLLBACK');await actor('manager')}};

try{
 await owner();for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql'])await db.exec(await file(name));
 const core=await file('056_receivable_receipt_reversal.sql');
 await assert.rejects(()=>db.exec(core),e=>e.code==='22023');await db.exec('ROLLBACK');
 assert.equal(await scalar("SELECT to_regclass('public.active_receivable_receipts')::text r"),null);
 for(const name of ['053_receivable_financial_validation.sql','054_collection_operational_statuses.sql','055_receivable_validation_commissions.sql'])await db.exec(await file(name));
 today=await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");
 agent=id(++seq);await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,'Responsável sintética']);
 await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users.collector.id,agent,users.manager.id]);
 importId=await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES('grupo-consolidado','base-sintetica.csv',repeat('f',64),$1,1,1,0,0,0,'OPEN') RETURNING id r",[users.cr.id]);
 const old=await paid({received:18000,reason:'Desconto sintético conferido'}),before=await snapshot();
 await owner();await db.exec(installer);const after=await snapshot();delete before['public.central_schema_migrations'];delete after['public.central_schema_migrations'];delete after['public.receivable_receipt_reversals'];delete after['cf_private.receivable_active_receipts'];assert.deepEqual(after,before);
 assert.equal(await scalar('SELECT count(*)::integer r FROM cf_private.receivable_active_receipts'),1);
 assert.equal((await active(old.t))[0].id,old.receipt.id);
 await db.exec(installer);assert.equal(await scalar("SELECT count(*)::integer r FROM public.central_schema_migrations WHERE version='056_receivable_receipt_reversal'"),1);
 assert.equal(await readFile(new URL('../supabase/dashboard/ativar-estorno-validacao-recebiveis.sql',import.meta.url),'utf8'),installer);
 assert((await file('056_receivable_receipt_reversal.sql')).includes(await readFile(new URL('../supabase/fragments/receivable-reversal-consumers.sql',import.meta.url),'utf8')));
 console.log('PASS installer requires 055, preserves old financial data and histories, backfills exclusive active pointers and reapplies safely');passed++;
 await actor('manager');await scalar("SELECT public.configure_commission_rule('COLLECTOR','1900-01-01','',$1,'Regra sintética') r",[JSON.stringify({eligible_collector_ids:[agent]})]);

 await test('manual reversal preserves immutable receipt and restores nominal active debt and the original collector',async()=>{
  const p=await paid({received:18000,reason:'Retenção sintética'});await actor('manager');const pre=await scalar('SELECT public.receivables_management_summary() r'),base=await commissions();assert(base.rows.some(r=>r.id===p.receipt.id));
  const r=await reverse(p),now=await current(p.t);assert.equal(r.format_version,'056');assert.equal(r.receipt_id,p.receipt.id);assert.equal(r.title_id,p.t.id);assert.equal(r.receipt_amount_cents,18000);assert.equal(r.nominal_cents,20000);assert.equal(r.restored_status,'OPEN');assert.equal(r.title_revision,p.t.revision+1);
  for(const field of ['amount_cents','due_date','collector_id','retired_from_report','in_latest_report','last_import_id'])assert.equal(now[field],p.t[field]);
  assert.equal(now.status,'OPEN');assert.equal(now.validation_status,'NONE');assert.equal(now.payment_date,null);assert.equal(now.payment_reported_date,null);assert.equal(now.payment_source,null);assert.equal(now.next_action,'RETRY');assert.equal(now.next_action_date,today);
  assert.deepEqual(await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipts r WHERE id=$1',[p.receipt.id]),p.receipt);assert.deepEqual(await active(p.t),[]);assert.deepEqual(await effective(p.t),[]);
  const rev=await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipt_reversals r WHERE receipt_id=$1',[p.receipt.id]);assert.deepEqual(rev.original_receipt,p.receipt);assert.deepEqual(rev.original_title,p.t);assert.equal(rev.created_by,users.manager.id);assert.equal(rev.result.reversal_id,rev.id);
  await actor('manager');const post=await scalar('SELECT public.receivables_management_summary() r');assert.equal(post.open_cents-pre.open_cents,20000);assert.equal(post.overdue_cents-pre.overdue_cents,20000);assert(!(await commissions()).rows.some(r=>r.id===p.receipt.id));
  const event=await scalar("SELECT to_jsonb(e) r FROM public.receivable_collection_events e WHERE title_id=$1 AND action='RECEIPT_REVERSAL'",[p.t.id]);assert(event);assert.equal(event.payment_date,null);
 });
 await test('lost response replay is exact, while a reused request with changed payload and a new request for the old receipt are rejected',async()=>{
  const p=await paid(),a=reverseArgs(p);await actor('manager');const proof=await call(a),before=await snapshot();await actor('manager');assert.deepEqual(await call(a),proof);assert.deepEqual(await snapshot(),before);
  await actor('manager');const changed=[...a];changed[1]='Outro motivo';await reject(()=>call(changed),'22023');await reject(()=>call(reverseArgs(p)),'RV001');
 });
 await test('the original financial validation proof remains exact after reversal without resurrecting the receipt',async()=>{
  const t=await title(),request=randomUUID(),proof=await validate(t,{request}),p={t:await current(t),receipt:{id:proof.receipt_id}};await reverse(p);const before=await snapshot();
  assert.deepEqual(await validate(t,{request}),proof);assert.deepEqual(await snapshot(),before);assert.deepEqual(await active(t),[]);assert.equal((await current(t)).status,'OPEN');
 });
 await test('one active receipt is enforced by a database primary key, and a correct future receipt can use the original title',async()=>{
  const p=await paid();await owner();await reject(()=>db.query('INSERT INTO public.receivable_receipts(title_id,amount_cents,payment_date,delay_days,delay_band,collector_id,payment_source,reported_in_collection,validated_by) VALUES($1,100,$2,0,\'ATE_30\',$3,\'COBRANCA\',true,$4)',[p.t.id,today,agent,users.cr.id]),'23505');
  await reverse(p);const t=await current(p.t);await actor('collector');await scalar("SELECT public.collection_work_action($1,'START',$2,$3) r",[t.id,t.revision,randomUUID()]);
  const d=await scalar('SELECT public.collection_case_detail($1) r',[t.id]);await scalar('SELECT public.save_collection_case($1,$2,$3,NULL,NULL,$4,$5,$6,true,$7) r',[t.id,'TÍTULO PAGO','Recebimento correto informado',d.title.revision,d.case.revision,today,randomUUID()]);
  const second=await validate(await current(t));assert.notEqual(second.receipt_id,p.receipt.id);assert.equal((await active(t)).length,1);assert.equal((await effective(t))[0].id,second.receipt_id);
  assert.equal(await scalar('SELECT count(*)::integer r FROM public.receivable_receipts WHERE title_id=$1',[t.id]),2);assert.equal(await scalar('SELECT count(*)::integer r FROM public.receivable_receipt_reversals WHERE title_id=$1',[t.id]),1);assert.equal(await scalar('SELECT count(*)::integer r FROM cf_private.receivable_active_receipts WHERE title_id=$1',[t.id]),1);
 });
 await test('retired history stays retired after reversal and does not re-enter active balances until the open report reappears',async()=>{
  const t=await title();await owner('cr');await scalar("SELECT cf_private.record_receivable_report_event($1,'RETIRED_WORKED',$2,$3,$4) r",[t.id,importId,randomUUID(),today]);
  // Move the prepared receipt to a genuinely retired title through the normal 055 flow.
  const rt=await current(t),proof=await validate(rt),rp={t:await current(rt),receipt:(await active(rt))[0]};await reverse(rp);const now=await current(rt);assert.equal(now.retired_from_report,true);assert.equal(now.in_latest_report,false);assert.equal(now.next_action,null);assert.equal(now.next_action_date,null);
  await actor('manager');assert(!(await scalar("SELECT public.collection_workbench(p_queue=>'active') r")).rows.some(r=>r.id===rt.id));assert((await scalar("SELECT public.collection_workbench(p_queue=>'history',p_financial_status=>'RETIRED_FROM_REPORT') r")).rows.some(r=>r.id===rt.id));
 });
 await test('reversal does not invent collection work when none occurred and does not commission a later unworked receipt',async()=>{
  const p=await paid({source:'IMPORTACAO_DIARIA',reported:false});await reverse(p);await owner();assert.equal(await scalar('SELECT cf_private.receivable_report_title_worked($1,clock_timestamp()) r',[p.t.id]),false);
  assert.equal(await scalar("SELECT count(*)::integer r FROM public.receivable_collection_events WHERE title_id=$1 AND action='RECEIPT_REVERSAL'",[p.t.id]),1);
 });
 await test('missing reason, missing request, stale revision and future conflicting financial state reject without partial writes',async()=>{
  const p=await paid();await actor('manager');for(const a of [[p.receipt.id,'',p.t.revision,randomUUID()],[p.receipt.id,'x',p.t.revision,null]])await reject(()=>call(a),'22023');await reject(()=>call(reverseArgs(p,{revision:p.t.revision-1})),'40001');assert.equal((await active(p.t)).length,1);
 });
 await test('ERP provenance and latest adjustments stay immutable and the reversal snapshots the effective received amount and date',async()=>{
  const p=await paid();await owner('cr');await db.query('INSERT INTO public.receivable_receipt_import_provenance(receipt_id,first_import_id,nominal_amount_cents,original_due_date,created_by) VALUES($1,$2,$3,$4,$5)',[p.receipt.id,importId,p.t.amount_cents,p.t.due_date,users.cr.id]);
  await db.query("INSERT INTO public.receivable_receipt_adjustments(receipt_id,revision,amount_cents,nominal_amount_cents,original_due_date,payment_date,delay_days,delay_band,collector_id,import_id,created_by) VALUES($1,1,19000,$2,$3,$4,79,'61_90',$5,$6,$7)",[p.receipt.id,p.t.amount_cents,p.t.due_date,add(today,-1),agent,importId,users.cr.id]);
  const original=await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipt_adjustments r WHERE receipt_id=$1',[p.receipt.id]);const proof=await reverse(p);assert.equal(proof.receipt_amount_cents,19000);assert.equal(proof.payment_date,add(today,-1));
  const rev=await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipt_reversals r WHERE receipt_id=$1',[p.receipt.id]);assert.equal(rev.effective_receipt.amount_cents,19000);assert.deepEqual(rev.original_receipt,p.receipt);assert.deepEqual(await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipt_adjustments r WHERE receipt_id=$1',[p.receipt.id]),original);assert.deepEqual(await active(p.t),[]);
 });
 await test('only an approved enabled manager can reverse; financial operators, Director and collector remain blocked',async()=>{
  const p=await paid(),a=reverseArgs(p);for(const who of ['cr','director','collector','cp','rh']){await actor(who);await reject(()=>call(a))}
  await owner();await db.query('DELETE FROM cf_private.approved_sessions WHERE session_id=$1',[users.manager.session]);await actor('manager');await reject(()=>call(a));
  for(const role of ['anon','service_role']){await owner();await db.exec('SET ROLE '+role);await reject(()=>call(a))}
 });
 await test('receipt and reversal histories remain visible through the existing portfolio RLS while operational reads exclude them',async()=>{
  const p=await paid();await reverse(p);for(const who of ['manager','cr','director','collector']){await actor(who);assert.equal(await scalar('SELECT count(*)::integer r FROM public.receivable_receipts WHERE id=$1',[p.receipt.id]),1);assert.equal(await scalar('SELECT count(*)::integer r FROM public.receivable_receipt_reversals WHERE receipt_id=$1',[p.receipt.id]),1);assert.equal(await scalar('SELECT count(*)::integer r FROM public.active_receivable_receipts WHERE id=$1',[p.receipt.id]),0)}
  await actor('collector');await reject(()=>db.query('DELETE FROM public.receivable_receipt_reversals WHERE receipt_id=$1',[p.receipt.id]));await reject(()=>db.query('UPDATE public.receivable_receipts SET amount_cents=1 WHERE id=$1',[p.receipt.id]));await reject(()=>db.query('SELECT * FROM cf_private.receivable_active_receipts'));
  await owner();await reject(()=>db.query('DELETE FROM public.receivable_receipt_reversals WHERE receipt_id=$1',[p.receipt.id]),'42501');await reject(()=>db.query('UPDATE public.receivable_receipts SET amount_cents=1 WHERE id=$1',[p.receipt.id]),'42501');
 });
 await test('late audit failure rolls title, case, pointer, reversal and all events back atomically',async()=>{
  const p=await paid();await owner();await db.exec("CREATE FUNCTION cf_private.synthetic_reversal_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='receivable_receipt_reversals' THEN RAISE EXCEPTION 'Falha sintética' USING ERRCODE='22023';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_reversal_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_reversal_failure()");const before=await snapshot();await actor('manager');await reject(()=>call(reverseArgs(p)),'22023');assert.deepEqual(await snapshot(),before);
 });
 console.log(`${passed} receivable receipt reversal SQL checks passed.`);
}catch(error){console.error('FAIL',error.message,error.code??'',error.where??'',error.stack);process.exitCode=1}finally{await db.close()}
