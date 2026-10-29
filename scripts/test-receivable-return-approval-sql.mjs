import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivableReturnApprovalSql } from './bundle-receivable-return-approval.mjs';

const f=await createCostFixture(),{db,users,id,owner,actor,scalar,file,snapshot}=f;
let passed=0,seq=97000,today,importId,agent;
const add=(d,n)=>{const v=new Date(d+'T12:00:00Z');v.setUTCDate(v.getUTCDate()+n);return v.toISOString().slice(0,10)};
const current=async t=>{await owner();return scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[t.id])};
const title=async(options={})=>{
 await owner('manager');const n=++seq,r={amount:20000,due:add(today,-80),status:'OPEN',source:null,collector:agent,reported:false,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,reported_in_collection,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$1,$2,cf_private.receivable_customer_key($2,NULL),'4',$3,$4,$5,$6,CASE WHEN $6='PENDING_VALIDATION' THEN 'PENDING' ELSE 'NONE' END,$7,CASE WHEN $6='PENDING_VALIDATION' THEN $8::date END,$9,$10,$10) RETURNING to_jsonb(receivable_titles) r`,['NF-RET-SINT-'+n,'Cliente sintético retorno '+n,r.due,r.amount,r.collector,r.status,r.source,today,r.reported,importId]);
};
const source=t=>({document:t.document,client_name:t.client_name,client_document:t.client_document,branch:t.branch,issued_on:t.issued_on,due_date:t.due_date,amount_cents:t.amount_cents});
const receipt=async t=>(await scalar('SELECT to_jsonb(r) r FROM public.effective_receivable_receipts r WHERE title_id=$1',[t.id]))??null;
const preview=(rows,o={})=>scalar('SELECT public.preview_receivables_open_report($1,$2,$3,$4,$5,$6) r',['grupo-consolidado',JSON.stringify(rows),o.full??true,today,JSON.stringify(o.titles??{}),JSON.stringify(o.collectors??{})]);
const approve=(item,o={})=>scalar('SELECT public.approve_receivable_report_return($1,$2,$3,$4,$5,$6,$7) r',[item.title_id,o.revision??item.expected_revision,Object.hasOwn(o,'receipt')?o.receipt:item.receipt_id,o.receiptFingerprint??item.receipt_fingerprint,JSON.stringify(o.row??item.source_row),o.reason??'Baixa sintética conferida e feita por engano',o.request??randomUUID()]);
const commit=async(rows,p,o={})=>{
 const bytes=Buffer.from(o.source??`arquivo-sintetico-retorno-${++seq}`),who=o.user??'manager';await owner();await db.exec('SET ROLE service_role');
 const result=await scalar('SELECT public.commit_receivables_open_report_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) r',[
  users[who].id,users[who].session,'grupo-consolidado','retorno-sintetico.xlsx',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),JSON.stringify(o.titles??{}),p.previous_import_id,p.financial_revision,JSON.stringify(o.collectors??{}),o.full??true,today,o.request??randomUUID()]);
 await actor(who);return result;
};
const paid=async(options={})=>{const t=await title({status:'PENDING_VALIDATION',source:'COBRANCA',reported:true,...options});await actor('manager');await scalar('SELECT public.validate_receivable_payment_v2($1,$2,$3,$4,NULL,$5,$6,$7) r',[t.id,'CONFIRM',today,t.amount_cents,'Validação sintética anterior',t.revision,randomUUID()]);return current(t)};
const retire=async(t,worked=false)=>{await owner('manager');const rq=randomUUID();await scalar('SELECT cf_private.record_receivable_report_event($1,$2,$3,$4,$5) r',[t.id,worked?'RETIRED_WORKED':'RETIRED_UNWORKED',importId,rq,today]);await db.query("INSERT INTO cf_private.receivable_open_report_requests(request_id,actor_id,payload_hash,source_import_id,full_report,reference_date,result) VALUES($1,$2,repeat('e',64),$3,true,$4,'{}')",[rq,users.manager.id,importId,today]);return current(t)};
const reject=async(fn,code='42501')=>{await db.exec('SAVEPOINT expected_error');try{await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}finally{await db.exec('ROLLBACK TO SAVEPOINT expected_error;RELEASE SAVEPOINT expected_error')}};
const test=async(name,fn)=>{await owner();await db.exec('BEGIN');try{await fn();passed++;console.log('PASS',name)}finally{await db.exec('ROLLBACK');await actor('manager')}};

try{
 await owner();for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql'])await db.exec(await file(name));
 today=await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");
 agent=id(++seq);await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,'Responsável sintética retorno']);
 importId=await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES('grupo-consolidado','base-retorno-sintetica.csv',repeat('f',64),$1,1,1,0,0,0,'OPEN') RETURNING id r",[users.manager.id]);
 const installer=await buildReceivableReturnApprovalSql(),before=await snapshot();await db.exec(installer);
 const after=await snapshot();for(const s of [before,after])delete s['public.central_schema_migrations'];
 for(const key of Object.keys(after))if(!(key in before)){assert.deepEqual(after[key],[],key);delete after[key]}
 assert.deepEqual(after,before);await db.exec(installer);assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='057_receivable_return_approval'"),1);
 assert.equal(await readFile(new URL('../supabase/dashboard/ativar-aprovacao-retorno-recebiveis.sql',import.meta.url),'utf8'),installer);
 console.log('PASS combined installation is repeatable and preserves financial records');passed++;

 await test('paid title reappearing requires manager approval and approval alone never changes money or status',async()=>{
  const t=await paid();await actor();let p=await preview([source(t)]);assert.equal(p.return_count,1);assert.equal(p.return_unapproved_count,1);assert.equal(p.can_commit,false);assert.equal(p.return_items[0].reason_kind,'VALIDATED');
  await reject(()=>commit([source(t)],p),'P0047');await actor();const beforeReceipt=await receipt(t),r=await approve(p.return_items[0]);assert.equal(r.format_version,'057');assert.equal(r.title_revision,t.revision);assert.equal((await current(t)).status,'VALIDATED');await actor();assert.deepEqual(await receipt(t),beforeReceipt);
  p=await preview([source(t)]);assert.equal(p.can_commit,true);assert.equal(p.return_unapproved_count,0);assert.equal(p.return_items[0].approval_id,r.approval_id);
 });
 await test('confirmation atomically reverses a paid receipt and restores exact nominal open/overdue amounts without duplicating debt',async()=>{
  const t=await paid({amount:12345});await actor();let p=await preview([source(t)]);const original=await receipt(t);await approve(p.return_items[0]);p=await preview([source(t)]);const r=await commit([source(t)],p);
  assert.equal(r.returned_count,1);const now=await current(t);assert.equal(now.id,t.id);assert.equal(now.status,'OPEN');assert.equal(now.retired_from_report,false);assert.equal(now.amount_cents,12345);assert.equal(now.due_date,t.due_date);await actor();assert.equal(await receipt(t),null);
  assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipts WHERE title_id=$1',[t.id]),1);assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipt_reversals WHERE receipt_id=$1',[original.id]),1);await owner();assert.equal(await scalar('SELECT count(*)::int r FROM cf_private.receivable_return_consumptions'),1);
  const summary=await scalar('SELECT public.receivables_management_summary() r');assert.equal(summary.open_cents,12345);assert.equal(summary.overdue_cents,12345);
 });
 await test('retired unpaid title also requires approval and returns with original owner and history',async()=>{
  const t=await retire(await title());await actor();let p=await preview([source(t)]);assert.equal(p.return_count,1);assert.equal(p.return_items[0].reason_kind,'RETIRED');assert.equal(p.return_items[0].receipt_id,null);assert.equal(p.can_commit,false);await approve(p.return_items[0]);p=await preview([source(t)]);const r=await commit([source(t)],p);assert.equal(r.returned_count,1);
  const now=await current(t);assert.equal(now.retired_from_report,false);assert.equal(now.collector_id,t.collector_id);assert.equal(now.status,'OPEN');await actor();assert.equal(await receipt(t),null);assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipt_reversals'),0);
 });
 await test('approved return clears a retired pending payment report through the existing not-located workflow without inventing a receipt',async()=>{
  for(const paymentSource of ['COBRANCA','IMPORTACAO_DIARIA']){
   let t=await title({status:'PENDING_VALIDATION',source:paymentSource,reported:true});await owner();
   const report=await scalar("INSERT INTO public.receivable_collection_events(title_id,collector_id,action,observation,payment_date,created_by) VALUES($1,$2,'PAID','Relato sintético original preservado',$3,$4) RETURNING to_jsonb(receivable_collection_events) r",[t.id,agent,today,users.collector.id]);
   t=await retire(t,true);await actor();let p=await preview([source(t)],{full:false});assert.equal(p.return_items[0].reason_kind,'RETIRED');assert.equal(p.return_items[0].receipt_id,null);await approve(p.return_items[0]);p=await preview([source(t)],{full:false});await commit([source(t)],p,{full:false});
   const restored=await current(t);assert.equal(restored.status,'NOT_LOCATED');assert.equal(restored.validation_status,'NONE');assert.equal(restored.retired_from_report,false);assert.equal(restored.payment_source,null);assert.equal(restored.payment_reported_date,null);assert.equal(restored.collector_id,agent);assert.equal(restored.next_action,'RETRY');assert.equal(restored.next_action_date,today);
   assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipts WHERE title_id=$1',[t.id]),0);assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipt_reversals WHERE title_id=$1',[t.id]),0);assert.deepEqual(await scalar('SELECT to_jsonb(e) r FROM public.receivable_collection_events e WHERE id=$1',[report.id]),report);
   await actor();const queue=await scalar('SELECT public.collection_workbench() r');assert(queue.rows.some(row=>row.id===t.id));assert.equal(await scalar("SELECT count(*)::int r FROM public.receivable_titles WHERE id=$1 AND status='PENDING_VALIDATION' AND validation_status='PENDING'",[t.id]),0);
  }
 });
 await test('a title that is both retired and subsequently validated reverses and reappears only after one approval',async()=>{
  let t=await title();await owner();await db.query("INSERT INTO public.receivable_collection_events(title_id,collector_id,action,observation,created_by) VALUES($1,$2,'CONTACT','Contato sintético anterior',$3)",[t.id,agent,users.collector.id]);t=await retire(t,true);await actor();await scalar('SELECT public.validate_receivable_payment_v2($1,$2,$3,$4,NULL,$5,$6,$7) r',[t.id,'CONFIRM',today,t.amount_cents,'Confirmação sintética anterior',t.revision,randomUUID()]);t=await current(t);
  await actor();let p=await preview([source(t)]);assert.equal(p.return_count,1);assert.equal(p.return_items[0].retired_from_report,true);await approve(p.return_items[0]);p=await preview([source(t)]);await commit([source(t)],p);const now=await current(t);assert.equal(now.retired_from_report,false);assert.equal(now.status,'OPEN');assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipt_reversals'),1);assert.equal(await scalar("SELECT count(*)::int r FROM public.receivable_report_retirement_events WHERE title_id=$1 AND action='REAPPEARED'",[t.id]),1);
 });
 await test('incremental reports enforce the same return approval while preserving other active titles',async()=>{
  const other=await title({amount:777}),t=await retire(await title());await actor();let p=await preview([source(t)],{full:false});assert.equal(p.return_count,1);assert.equal(p.retired_count,0);await approve(p.return_items[0]);p=await preview([source(t)],{full:false});await commit([source(t)],p,{full:false});assert.equal((await current(other)).retired_from_report,false);
 });
 await test('title changes and different incoming rows invalidate approval instead of silently reusing it',async()=>{
  const t=await retire(await title());await actor();let p=await preview([source(t)]);await approve(p.return_items[0]);await owner();await db.query("UPDATE public.receivable_titles SET collector_locked=NOT collector_locked WHERE id=$1",[t.id]);await actor();p=await preview([source(t)]);assert.equal(p.return_unapproved_count,1);
  const changed={...source(t),amount_cents:t.amount_cents+1};p=await preview([changed]);assert.equal(p.return_unapproved_count,1);await reject(()=>approve(p.return_items[0],{revision:t.revision}),'40001');
 });
 await test('approval replays exact proof but rejects changed reason/source and another manager cannot consume it',async()=>{
  const t=await paid();await actor();let p=await preview([source(t)]),item=p.return_items[0],request=randomUUID(),r=await approve(item,{request});assert.deepEqual(await approve(item,{request}),r);await reject(()=>approve(item,{request,reason:'Outro motivo'}),'22023');await actor('manager2');p=await preview([source(t)]);assert.equal(p.return_unapproved_count,1);await reject(()=>commit([source(t)],p,{user:'manager2'}),'P0047');
 });
 await test('a receipt-only ERP adjustment invalidates approval even when the title revision has not changed',async()=>{
  const t=await paid();await actor();const r=await receipt(t);await owner();
  await db.query('INSERT INTO public.receivable_receipt_import_provenance(receipt_id,first_import_id,nominal_amount_cents,original_due_date,created_by) VALUES($1,$2,$3,$4,$5)',[r.id,importId,t.amount_cents,t.due_date,users.manager.id]);
  await actor();let p=await preview([source(t)]);await approve(p.return_items[0]);await owner();
  await db.query("INSERT INTO public.receivable_receipt_adjustments(receipt_id,revision,amount_cents,nominal_amount_cents,original_due_date,payment_date,delay_days,delay_band,collector_id,import_id,created_by) VALUES($1,1,$2,$3,$4,$5,80,'61_90',$6,$7,$8)",[r.id,t.amount_cents-123,t.amount_cents,t.due_date,today,agent,importId,users.manager.id]);
  assert.equal((await current(t)).revision,t.revision);await actor();await reject(()=>approve(p.return_items[0]),'40001');p=await preview([source(t)]);assert.equal(p.return_unapproved_count,1);assert.equal(p.return_items[0].received_amount_cents,t.amount_cents-123);assert.equal(p.can_commit,false);
 });
 await test('lost final response repeats the original import proof and creates no second reversal, consumption or title',async()=>{
  const t=await paid();await actor();let p=await preview([source(t)]);await approve(p.return_items[0]);p=await preview([source(t)]);const options={request:randomUUID(),source:'arquivo-replay-sintetico'};const r=await commit([source(t)],p,options);const before=await snapshot();const replay=await commit([source(t)],p,options);assert.equal(replay.idempotent,true);assert.equal(replay.import_id,r.import_id);assert.deepEqual(await snapshot(),before);
 });
 await test('a new reconciliation of an already imported file uses current preview counts while preserving the original request replay',async()=>{
  const row={document:'NF-PRIMEIRA-CARGA-'+(++seq),client_name:'Cliente sintético de arquivo reaproveitado',client_document:null,branch:'4',issued_on:null,due_date:add(today,-80),amount_cents:12345};
  await owner();const key=await scalar('SELECT cf_private.receivable_customer_key($1,NULL) r',[row.client_name]),collectors={[key]:agent};await actor();const firstPreview=await preview([row],{collectors}),firstOptions={source:'mesmos-bytes-arquivo-retorno',collectors,request:randomUUID()},first=await commit([row],firstPreview,firstOptions);assert.equal(first.new_count,1);
  await owner();let t=await scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE document=$1',[row.document]);await db.query("UPDATE public.receivable_titles SET status='PENDING_VALIDATION',validation_status='PENDING',payment_source='COBRANCA',payment_reported_date=$2,reported_in_collection=true WHERE id=$1",[t.id,today]);t=await current(t);await actor();await scalar('SELECT public.validate_receivable_payment_v2($1,$2,$3,$4,NULL,$5,$6,$7) r',[t.id,'CONFIRM',today,t.amount_cents,'Validação sintética feita por engano',t.revision,randomUUID()]);
  let p=await preview([row]);assert.equal(p.new_count,0);assert.equal(p.validated_in_source_count,1);await approve(p.return_items[0]);p=await preview([row]);const result=await commit([row],p,{source:firstOptions.source});assert.equal(result.import_id,first.import_id);assert.equal(result.new_count,0);assert.equal(result.open_count,p.open_count);assert.equal(result.changed_count,p.changed_count);assert.equal(result.validated_in_source_count,p.validated_in_source_count);assert.equal(result.returned_count,1);assert.equal(result.idempotent,false);
  await owner();assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_titles WHERE document=$1',[row.document]),1);const storedImport=await scalar('SELECT to_jsonb(i) r FROM public.receivable_imports i WHERE id=$1',[first.import_id]);assert.equal(storedImport.new_count,1);await actor();const originalReplay=await commit([row],firstPreview,firstOptions);assert.equal(originalReplay.new_count,first.new_count);assert.equal(originalReplay.returned_count,first.returned_count);assert.equal(originalReplay.idempotent,true);
 });
 await test('approval cannot authorize an unrelated identity or changed paid amount/due date',async()=>{
  const t=await paid();await actor();const p=await preview([source(t)]),item=p.return_items[0];await reject(()=>approve(item,{row:{...source(t),document:'OUTRA-NF'}}),'23514');await reject(()=>approve(item,{row:{...source(t),amount_cents:t.amount_cents+1}}),'23514');await reject(()=>approve(item,{row:{...source(t),due_date:add(t.due_date,1)}}),'23514');
 });
 await test('only an approved manager session may approve; direct private writes and anonymous/service approval are rejected',async()=>{
  const t=await paid();await actor();const item=(await preview([source(t)])).return_items[0];for(const role of ['director','cr','cp','collector']){await actor(role);await reject(()=>approve(item))}await actor('manager',randomUUID());await reject(()=>approve(item));await owner();for(const role of ['anon','service_role']){await db.exec('SET ROLE '+role);await reject(()=>approve(item));await db.exec('RESET ROLE')}
  await actor();await reject(()=>db.exec("INSERT INTO cf_private.receivable_return_consumptions SELECT * FROM cf_private.receivable_return_consumptions"));
 });
 await test('a late audit error rolls back the import, financial reversal, title return and approval consumption together',async()=>{
  const t=await paid();await actor();let p=await preview([source(t)]);await approve(p.return_items[0]);p=await preview([source(t)]);await owner();await db.exec("CREATE FUNCTION cf_private.synthetic_return_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='receivable_return_approvals' AND NEW.action='REOPEN' THEN RAISE EXCEPTION 'Falha sintética' USING ERRCODE='22023';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_return_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_return_failure()");const before=await snapshot();await reject(()=>commit([source(t)],p),'22023');assert.deepEqual(await snapshot(),before);
 });
 await test('an unassigned paid title returns without inventing an owner and exposes the assignment warning',async()=>{
  const t=await paid({collector:null});await owner();await db.query('UPDATE public.receivable_titles SET collector_locked=true WHERE id=$1',[t.id]);const now=await current(t);await actor();let p=await preview([source(now)]);assert.equal(p.return_items[0].requires_collector_assignment,true);assert.equal(p.return_items[0].collector_id,null);await approve(p.return_items[0]);p=await preview([source(now)]);await commit([source(now)],p);const restored=await current(t);assert.equal(restored.collector_id,null);assert.equal(restored.collector_locked,false);assert.equal(restored.status,'OPEN');
 });
 await test('991 matched source titles with one return keep the approval preview below the configured 8 second request budget',async()=>{
  const paidTitle=await paid();await owner();await db.query(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,first_import_id,last_import_id)
   SELECT 'grupo-consolidado','PERF-RET-'||n,'PERF-RET-'||n,'Cliente de desempenho '||n,cf_private.receivable_customer_key('Cliente de desempenho '||n,NULL),'4',$1,10000,$2,'OPEN','NONE',$3,$3 FROM generate_series(1,990)n`,[add(today,-10),agent,importId]);
  const rows=(await db.query('SELECT document,client_name,client_document,branch,issued_on::text,due_date::text,amount_cents FROM public.receivable_titles ORDER BY document')).rows;await db.exec('ANALYZE public.receivable_titles;ANALYZE public.receivable_receipts');await actor();const started=performance.now(),p=await preview(rows),ms=performance.now()-started;assert.equal(p.row_count,991);assert.equal(p.return_count,1);assert.equal(p.return_items[0].title_id,paidTitle.id);assert(ms<8000,`991 rows preview took ${ms.toFixed(0)}ms`);console.log(`PERF 991-title approval preview: ${ms.toFixed(0)}ms`);
 });
 console.log(`${passed} receivable return approval SQL checks passed.`);
}catch(error){console.error('FAIL',error.message,error.code??'',error.where??'',error.stack);process.exitCode=1}finally{await db.close()}
