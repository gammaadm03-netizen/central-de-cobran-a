import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buildCollectionEmailSql } from './bundle-collection-email.mjs';
import { buildReceivableImportPerformanceSql } from './bundle-receivable-import-performance.mjs';
import { validOpenReportPreview,validOpenReportCommit } from '../supabase/functions/receivables-import/open-report-contract.mjs';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';

// Disposable PostgreSQL only. Synthetic users, filenames, amounts and work history.
const f=await createCostFixture(),{db,scalar,owner,actor,file,users,id}=f;
let passed=0,phase='setup',sequence=0,current='cr';
const test=async(name,fn)=>{phase=name;await fn();console.log('PASS',name);passed++;};
const reject=(fn,code)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
const as=async(name='cr')=>{current=name;await actor(name);};
const agent=id(101),otherAgent=id(102),scope='grupo-consolidado';let today,older,future;
const row=(document,extra={})=>({document,client_name:`Cliente sintético ${document}`,client_document:null,branch:'2',issued_on:older,due_date:older,amount_cents:10000,...extra});
const key=r=>`name:${r.client_name.toUpperCase()}`;
const preview=(rows,full=true,collectors={},titles={},date=today)=>scalar('SELECT public.preview_receivables_open_report($1,$2,$3,$4,$5,$6) r',[scope,JSON.stringify(rows),full,date,JSON.stringify(titles),JSON.stringify(collectors)]);
const title=document=>scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE document=$1',[document]);
const params=async(rows,{full=true,source=`synthetic-open-${++sequence}`,collectors=Object.fromEntries(rows.map(r=>[key(r),agent])),titles={},request=randomUUID(),date=today}={})=>{
 const p=await preview(rows,full,collectors,titles,date),bytes=Buffer.from(source);
 return[users[current].id,users[current].session,scope,`${source}.csv`,createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),JSON.stringify(titles),p.previous_import_id,p.financial_revision,JSON.stringify(collectors),full,date,request];
};
const sql='SELECT public.commit_receivables_open_report_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) r';
const gateway=async(a,query=sql)=>{await owner(current);await db.exec('SET ROLE service_role');try{return await scalar(query,a);}finally{await as(current);}};
const commit=async(rows,opts)=>gateway(await params(rows,opts));
const queue=()=>scalar("SELECT public.pending_collection_commissions('',NULL,0,100) r");
const state=async()=>{await owner(current);const out={};for(const {name}of(await db.query("SELECT schemaname||'.'||tablename name FROM pg_tables WHERE schemaname IN('public','cf_private','auth') ORDER BY 1")).rows)out[name]=(await db.query(`SELECT to_jsonb(t) r FROM ${name} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.r);await as(current);return out;};
const unchanged=async(fn)=>{const before=await state();await fn();assert.deepEqual(await state(),before);};
let migration,A,B,C,D,aA,aFull;
try{
 await owner();await db.exec(await file('040_collection_email_draft.sql'));await db.exec(await file('041_receivable_import_performance.sql'));
 await owner();await db.query('INSERT INTO public.collection_agents(id,display_name)VALUES($1,$2),($3,$4)',[agent,'Responsável sintética A',otherAgent,'Responsável sintética B']);
 await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by)VALUES($1,$2,$1)',[users.collector.id,agent]);
 ({today,older,future}=(await db.query("SELECT d::text today,(d-100)::text older,(d+20)::text future FROM(SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date d)s")).rows[0]);
 migration=await file('047_receivables_complete_report.sql');await db.exec(migration);await as();
 await test('activation appends the flag and preserves users, base permissions, view order and repeat safety',async()=>{
  assert.equal((await scalar('SELECT public.current_access() r')).profile.role_key,'contas_receber');
  const cols=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='collection_overdue_titles' ORDER BY ordinal_position")).rows.map(x=>x.column_name);assert.deepEqual(cols.slice(-2),['collection_as_of_date','retired_from_report']);
  const before=await state();await owner();await db.exec(migration);await as();assert.deepEqual(await state(),before);
 });
 A=row('WORKED');B=row('UNWORKED');C=row('FUTURE',{due_date:future});D=row('REMAIN');
 await test('explicit incremental mode imports rows without retiring previous debts',async()=>{await commit([A,B,C],{full:false,source:'first'});await commit([D],{full:false,source:'second'});assert.equal((await preview([D],false,{})).retired_count,0);assert.equal((await scalar("SELECT public.receivables_summary($1,$1) r",[today])).active_count,4);});
 await test('work started after preview invalidates the financial CAS',async()=>{
  aA=await params([D],{collectors:{},source:'cas-work'});const t=await title('WORKED');await scalar("SELECT public.collection_work_action($1,'START',$2,$3) r",[t.id,t.revision,randomUUID()]);await unchanged(()=>reject(()=>gateway(aA),'40001'));
 });
 await test('FULL preview separates worked and unworked absence without modifying data or creating cash',async()=>{await unchanged(async()=>{const p=await preview([D],true,{});assert(validOpenReportPreview(p,{fullReport:true,referenceDate:today,rowCount:1}));assert.equal(p.retired_count,3);assert.equal(p.retired_worked_count,1);assert.equal(p.retired_unworked_count,2);assert.equal(p.retirement_items.length,3);assert.equal(p.can_commit,true);});});
 await test('FULL commit atomically archives absence, preserves nominal/wallet and closes timer nonfinancially',async()=>{
  aFull=await params([D],{collectors:{},source:'full'});const before=await title('WORKED'),r=await gateway(aFull);assert.equal(r.retired_count,3);assert.equal(r.retired_worked_count,1);assert.equal(r.request_id,aFull[13]);assert(validOpenReportCommit(r,{fullReport:true,referenceDate:today,rowCount:1,requestId:aFull[13]}));
  const after=await title('WORKED');assert.equal(after.retired_from_report,true);assert.equal(after.amount_cents,before.amount_cents);assert.equal(after.collector_id,before.collector_id);assert.equal(after.status,before.status);assert.equal(after.validation_status,before.validation_status);
  await owner();assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipts'),0);assert.equal(await scalar("SELECT end_reason r FROM public.collection_work_sessions WHERE title_id=$1",[after.id]),'REPORT_RETIRED');await as();
 });
 await test('only worked absence enters a separate pending queue with no commission or payment date',async()=>{await as('manager');const p=await queue();assert.equal(p.count,1);assert.equal(p.rows[0].title_id,(await title('WORKED')).id);assert.equal(p.rows[0].nominal_reference_cents,10000);assert.equal(p.rows[0].payment_date,null);assert.equal(p.rows[0].commission_cents,null);assert.equal(p.options.collectors.length,2);await as();});
 await test('exact request replay is immutable and succeeds after stale tokens, but changed payload is rejected',async()=>{await unchanged(async()=>{const r=await gateway(aFull);assert.equal(r.idempotent,true);});await unchanged(()=>reject(()=>gateway([...aFull.slice(0,11),false,...aFull.slice(12)]),'23505'));});
 await test('reusing an earlier imported source restores same UUID, wallet and clears stale pending',async()=>{
  const before=await title('WORKED'),r=await commit([A,B,C],{full:false,source:'first'});assert.equal(r.reappeared_count,3);assert.equal((await title('WORKED')).id,before.id);assert.equal((await title('WORKED')).collector_id,before.collector_id);assert.equal((await title('WORKED')).retired_from_report,false);await as('manager');assert.equal((await queue()).count,0);await as();
 });
 await test('same-file FULL after previous incremental reconciles absence and never duplicates the original',async()=>{await owner();const count=await scalar('SELECT count(*)::int r FROM public.receivable_imports');await as();const r=await commit([D],{source:'second',collectors:{}});assert.equal(r.retired_count,3);await owner();assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_imports'),count);await as();});
 await test('legacy manual payment-date and financial validation cannot confirm an archived debt',async()=>{
  await owner();await db.query("UPDATE public.receivable_titles SET status='PENDING_VALIDATION',validation_status='PENDING',payment_source='IMPORTACAO_DIARIA' WHERE document='WORKED'");await as();const t=await title('WORKED');
  await reject(()=>scalar('SELECT public.set_receivable_payment_date($1,$2,$3) r',[t.id,today,t.revision]),'23514');await reject(()=>scalar("SELECT public.validate_receivable_payment($1,'CONFIRM',$2,'Conferência sintética',$3) r",[t.id,today,t.revision]),'23514');
 });
 await test('paid report matches archived UUID and creates only real cash, then pending resolves normally',async()=>{
  const before=await title('WORKED'),token=await scalar('SELECT public.get_receivables_sync_revision() r'),bytes=Buffer.from('synthetic-received');const rr={...A,received_on:today,received_amount_cents:9500};
  await gateway([users.cr.id,users.cr.session,scope,'synthetic-received.csv',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify([rr]),'{}',token.import_id,token.financial_revision,false], 'SELECT public.commit_receivables_received_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r');
  const after=await title('WORKED');assert.equal(after.id,before.id);assert.equal(after.status,'VALIDATED');assert.equal(after.collector_id,before.collector_id);assert.equal(after.retired_from_report,true);const history=await scalar("SELECT public.collection_workbench('Cliente sintético WORKED',NULL,false,NULL,'delay_desc',NULL,0,25,'history',NULL,NULL,NULL,'VALIDATED') r");assert.equal(history.count,1);assert.equal(history.rows[0].id,before.id);assert.equal((await scalar('SELECT public.receivables_summary($1,$1) r',[today])).received_period_cents,9500);await as('manager');assert.equal((await queue()).count,0);const assessed=await scalar("SELECT public.commissions_report('COLLECTOR',$1,$1,NULL,NULL,0,100) r",[today]);assert.equal(assessed.count,1);assert.equal(assessed.rows[0].title_id,before.id);await as();
 });
 await test('reactivating a previously unassigned archived title audits and counts the explicit owner choice',async()=>{
  await owner();await db.query("UPDATE public.receivable_titles SET collector_id=NULL WHERE document='FUTURE'");await as();const r=await commit([C],{full:false,collectors:{[key(C)]:agent},source:'reactivate-unassigned'});assert.equal(r.reappeared_count,1);assert.equal(r.assigned_title_count,1);assert.equal(r.assigned_customer_count,1);assert.equal((await title('FUTURE')).collector_id,agent);await owner();assert.equal(await scalar("SELECT count(*)::int r FROM public.audit_events WHERE entity='customer_assignment' AND after_value->>'origin'='OPEN_REPORT_047'"),1);await as();await commit([D],{source:'retire-reactivated',collectors:{}});
 });
 await test('unknown full-report identity cannot retire anything before explicit parcel resolution',async()=>{const changed={...D,due_date:future};await unchanged(async()=>{const p=await preview([changed],true,{});assert.equal(p.can_commit,false);await reject(()=>commit([changed],{collectors:{}}),'P0047');});});
 await test('late ledger audit failure rolls back source, retirements, queue, timers and aliases atomically',async()=>{
  await owner();await db.exec("CREATE FUNCTION cf_private.synthetic_retirement_failure()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='receivable_report_retirement_events' THEN RAISE EXCEPTION 'Falha sintética' USING ERRCODE='22023';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_retirement_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_retirement_failure()");await as();
  await unchanged(()=>reject(()=>commit([row('ATOMIC')]),'22023'));await owner();await db.exec('DROP TRIGGER synthetic_retirement_failure ON public.audit_events;DROP FUNCTION cf_private.synthetic_retirement_failure()');await as();
 });
 await test('collector sees only own overdue archive history and cannot invoke full imports or privileged helpers',async()=>{
  await as('collector');const rows=(await db.query('SELECT title_snapshot FROM public.receivable_report_retirement_events')).rows;assert(rows.length>0);assert(rows.every(x=>x.title_snapshot.due_date<today));await reject(()=>preview([D],true,{}),'42501');const archivedId=await scalar("SELECT id r FROM public.receivable_titles WHERE document='UNWORKED'");await reject(()=>scalar("SELECT cf_private.record_receivable_report_event($1,'REAPPEARED',$2,$3,$4) r",[archivedId,aFull[8],randomUUID(),today]),'42501');await as();
 });
 await test('Director is read-only, CP cannot import CR, and unauthenticated/expired/disabled sessions are denied',async()=>{
  for(const name of ['director','cp','rh']){await as(name);await reject(()=>preview([D],true,{}),'42501');await reject(()=>scalar(sql,aFull),'42501');}
  await owner('cr',id(999));await db.exec('SET ROLE authenticated');await reject(()=>preview([D],true,{}),'42501');await owner();await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[users.cr.id]);await as();await reject(()=>preview([D],true,{}),'42501');await owner();await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1',[users.cr.id]);await db.exec('SET ROLE anon');await reject(()=>preview([D],true,{}),'42501');await as();
 });
 await test('reapplying email and performance installers preserves retired filters and identity behavior',async()=>{
  await owner();const before=await scalar("SELECT pg_get_functiondef('cf_private.resolve_receivable_sync_rows(text,jsonb,jsonb,text)'::regprocedure) r");await db.exec(await buildCollectionEmailSql());await db.exec(await buildReceivableImportPerformanceSql());const after=await scalar("SELECT pg_get_functiondef('cf_private.resolve_receivable_sync_rows(text,jsonb,jsonb,text)'::regprocedure) r");assert.equal(after,before);assert((await scalar("SELECT pg_get_functiondef('public.prepare_collection_customer_email(uuid)'::regprocedure) r")).includes('retired_from_report'));await as();
 });
 await test('one thousand synthetic titles preserve exact absence counts with bounded full reconciliation',async()=>{
  const rows=Array.from({length:1000},(_,n)=>row(`BENCH-${n}`,{client_name:`Cliente sintético lote ${Math.floor(n/10)}`}));
  let start=performance.now();await commit(rows,{full:false,source:'benchmark1000'});const importMs=Math.round(performance.now()-start);
  const present=[...rows.slice(10),D];start=performance.now();const p=await preview(present,true,{});const previewMs=Math.round(performance.now()-start);assert.equal(p.retired_count,10);assert.equal(p.retired_unworked_count,10);assert.equal(p.retired_worked_count,0);assert.equal(p.can_commit,true);start=performance.now();const r=await commit(present,{source:'benchmark990',collectors:{}});const commitMs=Math.round(performance.now()-start);assert.equal(r.retired_count,10);console.log('Synthetic1000 timings',JSON.stringify({import_ms:importMs,preview_ms:previewMs,commit_ms:commitMs}));
 });
 await test('direct DML and ledger/history mutation are denied to authenticated and service roles',async()=>{
  for(const role of ['authenticated','service_role']){await owner('cr');await db.exec(`SET ROLE ${role}`);await reject(()=>db.exec('UPDATE public.receivable_report_retirement_events SET worked=false'),'42501');await reject(()=>db.exec('DELETE FROM cf_private.receivable_open_report_requests'),'42501');}
  await owner();await reject(()=>db.exec("UPDATE public.receivable_report_retirement_events SET worked=false WHERE action='RETIRED_WORKED'"),'42501');await as();
 });
 console.log(`${passed} complete-report CR SQL tests passed.`);
}catch(e){console.error('FAIL',phase,JSON.stringify({code:e.code,message:e.message,stack:String(e.stack??'').split('\n').slice(0,3).join('\n')}));process.exitCode=1;}
finally{await db.close();}
