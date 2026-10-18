import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// All companies, identities, files and monetary values below are synthetic.
const db=new PGlite();let passed=0,sequence=0,latest=null,today,yesterday,weekStart,weekEnd,bank,selectedMonth;
const roles=['gerente_geral','diretor','contas_pagar','contas_receber','rh_dp','cobradora_1','cobradora_2'];
const uid=i=>`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const sid=i=>`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].r;
const role=async name=>{await db.exec('RESET ROLE');await db.exec(`SET ROLE ${name}`);};
const actor=async i=>{await role('postgres');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[uid(i),JSON.stringify({session_id:sid(i),role:'admin'})]);await role('authenticated');};
const rejects=async(sql,args=[],code='42501')=>assert.rejects(db.query(sql,args),e=>{assert.equal(e.code,code,e.message);return true;});
const test=async(name,run)=>{await run();passed++;console.log('PASS',name);};
const sqlFile=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const migrations=['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql',
 '007_director_positions.sql','008_receivables.sql','009_collections.sql','010_bank_import.sql','011_receivables_positions.sql',
 '012_treasury_accounts.sql','013_director_report.sql','014_payables_forecast.sql','015_payable_payments.sql','016_payable_identity_updates.sql',
 '017_payable_month_closing.sql','018_payable_full_payment.sql','019_payable_cheques.sql'];
const query='SELECT public.payables_management_summary($1) r';
const report=(date=null)=>scalar(query,[date]);
const monthlyReport=(week=null,month=null)=>scalar('SELECT public.payables_management_summary($1,$2) r',[week,month]);
const title=entry=>scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1 AND closing_eligible',[entry]);
const addDays=(date,n)=>{const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const fixture=(entry_number,amount_cents,macro,due_date,extra={})=>({entry_number,amount_cents,plan:`PLANO TESTE ${macro}`,
 description:'Fornecedor sintético',branch:'2 - TESTE',due_date,issued_on:'2026-01-01',source_status:'ABERTO',bank_account:'ORIGEM TESTE',...extra});
const gateway=async list=>{
 const file=Buffer.from(`Relatório integral sintético ${++sequence}`);await role('service_role');
 const result=await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,$9) r',[
  uid(0),sid(0),'grupo-consolidado',`teste-${sequence}.csv`,createHash('sha256').update(file).digest('hex'),file.toString('base64'),JSON.stringify(list),
  JSON.stringify(Object.fromEntries(list.map(r=>[r.plan,r.plan.replace('PLANO TESTE ','')]))),latest]);latest=result.import_id;await actor(0);return result;
};
const pay=async(entry,date=today)=>{const t=await title(entry);return scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r',[
 t.id,t.payment_remaining_cents,date,bank,'Comprovante sintético conferido',t.payment_revision,randomUUID(),t.last_import_id]);};
const dataState=async()=>{await role('postgres');const data={};for(const table of ['payable_titles','payable_imports','payable_payments',
 'payable_payment_reversals','payable_title_reviews','payable_month_closures','bank_balance_positions','audit_events']) data[table]=(await db.query(`SELECT to_jsonb(t) r FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;return data;};
const macro=(r,name)=>r.by_macro.find(m=>m.macro===name);
try{
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 for(const name of migrations){
  if(name==='019_payable_cheques.sql')await test('activation without 019 refuses atomically before creating the management endpoint',async()=>{
   await assert.rejects(db.exec(await sqlFile('020_payables_management.sql')),e=>e.code==='22023');await db.exec('ROLLBACK');
   assert.equal(await scalar("SELECT to_regprocedure('public.payables_management_summary(date,date)')::text r"),null);
  });
  await db.exec(await sqlFile(name));
 }
 for(const[i,name]of roles.entries()){
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(i),`management-${i}@example.invalid`]);
  await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$3,true)',[uid(i),`Management${i}`,name]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(i),uid(i)]);
 }
 ({today,yesterday,week_start:weekStart,week_end:weekEnd}=(await db.query(`WITH d AS(SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date today),
 w AS(SELECT today,today-((extract(dow FROM today)::integer+1)%7) s FROM d)
 SELECT today::text,(today-1)::text yesterday,s::text week_start,(s+6)::text week_end FROM w`)).rows[0]);
 const activationBefore=await dataState();await db.exec(await sqlFile('020_payables_management.sql'));
 await test('read-only migration preserves existing source, bank, ledger and audit rows',async()=>assert.deepEqual(await dataState(),activationBefore));
 await actor(0);bank=await scalar('SELECT id r FROM public.bank_accounts WHERE enabled ORDER BY display_name LIMIT 1');
 await test('no import returns unknown totals and fourteen named macros instead of fabricated zero values',async()=>{
  const r=await report();assert.equal(r.latest_import_id,null);assert.equal(r.by_macro.length,14);assert.equal(r.missing_sources.length,1);
  for(const key of ['planned_week_cents','paid_week_cents','difference_week_cents','open_week_cents','future_cents','overdue_cents','week_title_count','future_title_count','cheques_week_cents','pending_reconciliation_count','monthly_paid_cents','monthly_paid_count'])assert.equal(r[key],null,key);
  assert.equal(r.month_start,`${today.slice(0,7)}-01`);
  for(const m of r.by_macro){assert.equal(typeof m.macro,'string');for(const[key,value]of Object.entries(m))if(key!=='macro')assert.equal(value,null,key);}
 });
 const original=[fixture('P1',10000,'FIXO',weekStart),fixture('P2',20000,'VARIÁVEL',today,{source_status:'CHEQUE',cheque_number:'000001'}),
  fixture('P3',30000,'IMPOSTO',addDays(today,100)),fixture('P4',40000,'FIXO',today),fixture('P5',50000,'IMPOSTO',yesterday),
  fixture('P6',6000,'VARIÁVEL',addDays(weekStart,-7))];
 await gateway(original);await pay('P1');const p6Payment=await pay('P6');await gateway(original.filter(r=>r.entry_number!=='P4'));
 const priorDayInWeek=yesterday>=weekStart?50000:0;
 await test('planned includes paid titles by due date while actual uses payment date, including another due week',async()=>{
  const r=await report();assert.equal(r.planned_week_cents,70000+priorDayInWeek);assert.equal(r.paid_week_cents,16000);
  assert.equal(r.difference_week_cents,54000+priorDayInWeek);assert.equal(r.open_week_cents,60000+priorDayInWeek);
  assert.equal(macro(r,'FIXO').planned_cents,50000);assert.equal(macro(r,'FIXO').paid_cents,10000);
  assert.equal(macro(r,'VARIÁVEL').planned_cents,20000);assert.equal(macro(r,'VARIÁVEL').paid_cents,6000);
 });
 await test('future includes all remaining dates beyond eight weeks and keeps overdue obligations separate',async()=>{
  const r=await report();assert.equal(r.future_cents,90000);assert.equal(r.future_title_count,3);assert.equal(r.overdue_cents,50000);
  assert.equal(macro(r,'IMPOSTO').future_cents,30000);assert.equal(macro(r,'IMPOSTO').overdue_cents,50000);
 });
 await test('unreconciled source disappearance remains tracked without creating realized payment',async()=>{
  const r=await report(),t=await title('P4');assert.equal(t.status,'SETTLED_IMPORT');assert.equal(t.paid_cents,0);
  assert.equal(r.pending_reconciliation_count,1);assert.equal(r.future_cents,90000);assert.equal(r.paid_week_cents,16000);
 });
 await test('cheque subtotal is part of remaining obligations, never an extra sum or inferred from its number',async()=>{
  const r=await report();assert.equal(r.cheques_week_cents,20000);assert.equal(r.cheques_week_count,1);
  assert.equal(r.open_week_cents,macro(r,'FIXO').open_week_cents+macro(r,'VARIÁVEL').open_week_cents+macro(r,'IMPOSTO').open_week_cents);
 });
 await test('proven historical noncanonical copies are excluded without deleting their original rows',async()=>{
  const before=await report(),canonical=await title('P2');await role('postgres');
  const id=await scalar(`INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,source_status,plan,bank_account,branch,issued_on,macro,status,first_import_id,last_import_id,settled_at)
   SELECT scope,jsonb_build_array(branch,entry_number,due_date,777)::text,entry_number,'Versão histórica sintética',due_date,777,source_status,plan,bank_account,branch,issued_on,macro,'SETTLED_IMPORT',first_import_id,last_import_id,clock_timestamp() FROM public.payable_titles WHERE id=$1 RETURNING id r`,[canonical.id]);
  await actor(0);assert.deepEqual(await report(),before);assert.equal(await scalar('SELECT closing_eligible r FROM public.payable_review_titles WHERE id=$1',[id]),false);
  assert.equal(await scalar('SELECT amount_cents r FROM public.payable_titles WHERE id=$1',[id]),777);
 });
 await test('reversal removes actual cash and restores remaining obligations without counting cancelled payments',async()=>{
  const t=await title('P6');await scalar('SELECT public.cancel_payable_payment($1,$2,$3) r',[p6Payment,'Estorno sintético confirmado',t.payment_revision]);
  const r=await report();assert.equal(r.paid_week_cents,10000);assert.equal(r.overdue_cents,56000);assert.equal(r.future_cents,90000);
 });
 await test('explicit macro correction changes effective realized allocation while preserving the original payment snapshot',async()=>{
  const t=await title('P1');await scalar('SELECT public.correct_payable_title($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',[
   t.id,t.due_date,t.amount_cents,t.bank_account,t.description,t.issued_on,'FRETE','Classificação sintética corrigida',t.review_fingerprint,true]);
  const r=await report();assert.equal(macro(r,'FIXO').paid_cents,0);assert.equal(macro(r,'FRETE').paid_cents,10000);
  assert.equal(await scalar('SELECT macro_snapshot r FROM public.payable_payments WHERE title_id=$1',[t.id]),'FIXO');
 });
 await test('any selected date normalizes to Saturday-Friday; an empty week has known zeros while total future stays complete',async()=>{
  const r=await report(addDays(weekStart,4));assert.equal(r.week_start,weekStart);assert.equal(r.week_end,weekEnd);
  const empty=await report(addDays(today,1000));assert.equal(empty.planned_week_cents,0);assert.equal(empty.paid_week_cents,0);assert.equal(empty.open_week_cents,0);
  assert.equal(empty.future_cents,90000);assert.equal(empty.missing_sources.length,0);
  for(const date of ['1899-12-31','2200-01-01','infinity'])await rejects(query,[date],'22023');
 });
 await test('management GET changes no titles, actual payments, balances, reviews, closures or audit rows',async()=>{
  const before=await dataState();await actor(0);await report();await report(weekEnd);assert.deepEqual(await dataState(),before);
 });
 await test('director and CP can read but CR, RH and collectors cannot obtain the management totals',async()=>{
  await actor(1);assert.equal((await report()).paid_week_cents,10000);await actor(2);assert.equal((await report()).future_cents,90000);
  for(const i of [3,4,5,6]){await actor(i);await rejects(query,[null]);}
 });
 await test('selected monthly paid totals use actual dates outside the selected week and invoice due month',async()=>{
  await actor(0);const firstCurrent=`${today.slice(0,7)}-01`,lastPrevious=addDays(firstCurrent,-1);
  selectedMonth=`${lastPrevious.slice(0,7)}-01`;
  await gateway([...original.filter(r=>r.entry_number!=='P4'),fixture('MONTH-FIRST',700,'OUTROS IMPOSTOS',addDays(today,200)),
   fixture('MONTH-LAST',800,'OUTROS IMPOSTOS',addDays(today,201)),fixture('OTHER-MONTH',900,'OUTROS IMPOSTOS',addDays(today,202))]);
  await pay('MONTH-FIRST',selectedMonth);await pay('MONTH-LAST',lastPrevious);await pay('OTHER-MONTH',addDays(selectedMonth,-1));
  const r=await monthlyReport(addDays(today,700),selectedMonth);assert.equal(r.month_start,selectedMonth);assert.equal(r.month_end,lastPrevious);
  assert.equal(r.paid_week_cents,0);assert.equal(r.monthly_paid_cents,1500);assert.equal(r.monthly_paid_count,2);
  assert.equal(macro(r,'OUTROS IMPOSTOS').paid_cents,0);
  const standard=await monthlyReport(addDays(today,700),null);assert.equal(standard.month_start,firstCurrent);
  assert.equal(standard.monthly_paid_cents,10000);assert.equal(standard.monthly_paid_count,1);
  const nextMonth=`${addDays(firstCurrent,32).slice(0,7)}-01`,emptyMonth=await monthlyReport(null,nextMonth);
  assert.equal(emptyMonth.monthly_paid_cents,0);assert.equal(emptyMonth.monthly_paid_count,0);assert.equal(emptyMonth.missing_sources.length,0);
 });
 await test('cancelled payments leave selected month totals and dates never normalize an invalid month silently',async()=>{
  const t=await title('MONTH-FIRST'),id=await scalar('SELECT id r FROM public.payable_payments WHERE title_id=$1',[t.id]);
  await scalar('SELECT public.cancel_payable_payment($1,$2,$3) r',[id,'Estorno mensal sintético',t.payment_revision]);
  const r=await monthlyReport(null,selectedMonth);assert.equal(r.monthly_paid_cents,800);assert.equal(r.monthly_paid_count,1);
  for(const date of [addDays(selectedMonth,1),'1899-12-01','2200-01-01','infinity'])await rejects('SELECT public.payables_management_summary($1,$2)',[null,date],'22023');
  await actor(1);assert.equal((await monthlyReport(null,selectedMonth)).monthly_paid_cents,800);
  await actor(3);await rejects('SELECT public.payables_management_summary($1,$2)',[null,selectedMonth]);await actor(0);
 });
 await test('Saturday and Friday obligations belong to the same week while adjacent Friday and Saturday are excluded',async()=>{
  const start=addDays(weekStart,700),end=addDays(start,6);await actor(0);
  await gateway([fixture('BOUNDARY-SATURDAY',111,'FIXO',start),fixture('BOUNDARY-FRIDAY',222,'FIXO',end),
   fixture('PREVIOUS-FRIDAY',333,'FIXO',addDays(start,-1)),fixture('NEXT-SATURDAY',444,'FIXO',addDays(start,7))]);
  const r=await report(end);assert.equal(r.week_start,start);assert.equal(r.week_end,end);assert.equal(r.week_title_count,2);
  assert.equal(r.planned_week_cents,333);assert.equal(r.open_week_cents,333);assert.equal(r.paid_week_cents,0);
  assert.equal(macro(r,'FIXO').planned_cents,333);assert.equal(macro(r,'FIXO').week_title_count,2);
 });
 await test('safe-integer overflow rejects the entire response without rounding any monetary aggregate',async()=>{
  await role('postgres');await db.exec("UPDATE public.payable_titles SET amount_cents=9007199254740991 WHERE entry_number='P3'");await actor(0);
  await rejects(query,[null],'22003');await role('postgres');await db.exec("UPDATE public.payable_titles SET amount_cents=30000 WHERE entry_number='P3'");
 });
 await test('monthly overflow is guarded even when the selected week and its actual total are empty',async()=>{
  await actor(0);const t=await title('OTHER-MONTH');await role('postgres');await db.exec('BEGIN');
  await db.query(`INSERT INTO public.payable_payments SELECT (jsonb_populate_record(NULL::public.payable_payments,
   to_jsonb(p)||jsonb_build_object('id',gen_random_uuid(),'request_id',gen_random_uuid(),
    'event_revision',(SELECT max(event_revision)+1 FROM public.payable_payments),'amount_cents',9007199254740991,'paid_on',$2::date))).*
   FROM public.payable_payments p WHERE p.title_id=$1 LIMIT 1`,[t.id,selectedMonth]);
  await role('authenticated');await rejects('SELECT public.payables_management_summary($1,$2)',[addDays(today,700),selectedMonth],'22003');
  await db.exec('ROLLBACK');await actor(0);assert.equal((await monthlyReport(null,selectedMonth)).monthly_paid_cents,800);
 });
 await test('revoked, expired, blocked and anonymous sessions cannot invoke the read-only endpoint',async()=>{
  await role('postgres');await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[sid(1),uid(1)]);await actor(1);await rejects(query,[null]);
  await role('postgres');await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE session_id=$1",[sid(2)]);await actor(2);await rejects(query,[null]);
  await role('postgres');await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[uid(0)]);await actor(0);await rejects(query,[null]);
  await role('anon');await rejects(query,[null]);await role('service_role');await rejects(query,[null]);
 });
 console.log(`${passed} passed; 0 failed (isolated PostgreSQL)`);
}finally{await db.close();}
