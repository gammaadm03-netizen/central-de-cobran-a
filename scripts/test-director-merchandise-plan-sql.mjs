import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildPayableOpenStatusSql } from './bundle-payable-open-status.mjs';

// PostgreSQL descartável; relatórios, pessoas, valores e contas são sintéticos.
// O plano define a obrigação; pagamentos/baixas continuam definindo o saldo real.
const f=await createCostFixture(),{db,users,owner,actor,scalar,file,snapshot}=f;
const plan='COMPRA DE MERCADORIA',otherPlan='OUTRO PLANO SINTETICO',scope='grupo-consolidado';
const mappings={[plan]:'FIXO',[otherPlan]:'COMPRA DE MERCADORIA'};
let today,yesterday,tomorrow,bank,bankLabel,sequence=0,passed=0,oldPosition,oldPositionRow,oldReport;
const failures=[];
const row=(entry_number,amount_cents=10000,extra={})=>({entry_number,amount_cents,plan,description:`Fornecedor sintético ${entry_number}`,
 branch:'FILIAL SINTETICA',bank_account:bankLabel,source_status:'ABERTO',issued_on:yesterday,due_date:today,...extra});
const title=entry=>scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1',[entry]);
const report=(start=today,end=start)=>scalar('SELECT public.director_report($1,$2) r',[start,end]);
const amount=async(start=today,end=start)=>(await report(start,end)).indicators.merchandise_cents;
const definition=()=>scalar("SELECT pg_get_functiondef('public.director_report(date,date)'::regprocedure) r");
const signature=()=>scalar("SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'definer',prosecdef,'config',proconfig,'volatility',provolatile,'arguments',pg_get_function_arguments(oid),'result',pg_get_function_result(oid)) r FROM pg_proc WHERE oid='public.director_report(date,date)'::regprocedure");
const source=()=>{const bytes=Buffer.from(`Posição sintética de mercadoria ${++sequence}`);return{name:`mercadoria-sintetica-${sequence}.csv`,hash:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')}};
const financial=async()=>{await owner();const values={};for(const name of ['public.payable_payments','public.payable_payment_reversals','public.bank_balance_positions','public.director_positions'])values[name]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') r FROM ${name} t`);await actor();return values;};
const sourceMappings=rows=>Object.fromEntries(Object.entries(mappings).filter(([key])=>rows.some(r=>r.plan.trim().replace(/\s+/g,' ').toUpperCase()===key)));
async function preview(rows,choices={}){
 return scalar('SELECT public.preview_payables_open_status_report($1,$2,$3,$4,$5,false,$6) r',[scope,JSON.stringify(rows),'ALL',JSON.stringify(sourceMappings(rows)),JSON.stringify(choices),'[]']);
}
async function importRows(rows,choices={}){
 const p=await preview(rows,choices),s=source();assert.equal(p.can_commit,true,JSON.stringify(p.errors));
 await owner();await db.exec('SET ROLE service_role');
 try{return await scalar('SELECT public.commit_payables_open_status_report_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false,$15) r',[
  users.manager.id,users.manager.session,scope,s.name,s.hash,s.base64,JSON.stringify(rows),'ALL',JSON.stringify(sourceMappings(rows)),JSON.stringify(choices),p.previous_import_id,p.financial_revision,p.report_date,randomUUID(),'[]']);}
 finally{await actor();}
}
async function pay(t){return scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r',[
 t.id,t.payment_remaining_cents,yesterday,bank,'Pagamento financeiro sintético conferido',t.payment_revision,randomUUID(),t.last_import_id]);}
async function test(name,run){await owner();await db.exec('BEGIN');await actor();try{await run();passed++;console.log('PASS',name)}catch(error){failures.push({name,error});console.error('FAIL',name,error.message,error.code??'',error.where??'')}finally{await db.exec('ROLLBACK');await actor()}}
async function reject(run,code='42501'){await db.exec('SAVEPOINT expected_failure');try{await assert.rejects(run,e=>{assert.equal(e.code,code,e.message);return true})}finally{await db.exec('ROLLBACK TO SAVEPOINT expected_failure;RELEASE SAVEPOINT expected_failure')}}
const unchangedData=(before,after)=>{const a=structuredClone(before),b=structuredClone(after);delete a['public.central_schema_migrations'];delete b['public.central_schema_migrations'];assert.deepEqual(b,a)};

try{
 await owner();await db.exec(await buildPayableOpenStatusSql());await actor();
 ({today,yesterday,tomorrow}=(await db.query("SELECT d::text today,(d-1)::text yesterday,(d+1)::text tomorrow FROM(SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date d)s")).rows[0]);
 const account=(await db.query("SELECT id,display_name FROM public.bank_accounts WHERE enabled AND account_type='BANK' ORDER BY id LIMIT 1")).rows[0];bank=account.id;bankLabel=account.display_name;
 await importRows([row('ANTES-PLANO',10000),row('ANTES-MACRO',20000,{plan:otherPlan})]);
 oldReport=await report();assert.equal(oldReport.indicators.merchandise_cents,20000);
 oldPosition=await scalar('SELECT public.save_director_position($1,$1) r',[today]);
 oldPositionRow=await scalar('SELECT to_jsonb(p) r FROM public.director_positions p WHERE id=$1',[oldPosition]);
 await owner();const before=await snapshot(),beforeSignature=await signature(),beforeDefinition=await definition();
 const migration=await file('066_director_merchandise_plan.sql');

 await db.exec("BEGIN;DELETE FROM public.central_schema_migrations WHERE version='015_payable_payments'");
 await assert.rejects(()=>db.exec(migration),e=>e.code==='22023');await db.exec('ROLLBACK');
 assert.equal(await definition(),beforeDefinition);assert.deepEqual(await signature(),beforeSignature);unchangedData(before,await snapshot());
 passed++;console.log('PASS missing financial balance prerequisite rejects activation without changing any source, ledger or permission');

 await db.exec('BEGIN');
 await db.exec(beforeDefinition.replace("AND macro='COMPRA DE MERCADORIA'","AND macro='FIXO'"));
 const divergent=await definition();await assert.rejects(()=>db.exec(migration),e=>e.code==='22023');await db.exec('ROLLBACK');
 assert.equal(await definition(),beforeDefinition);assert.notEqual(divergent,beforeDefinition);assert.deepEqual(await signature(),beforeSignature);unchangedData(before,await snapshot());
 passed++;console.log('PASS an unknown deployed indicator contract fails atomically before changing data or formulas');

 await db.exec(migration);const afterDefinition=await definition();
 assert.equal(afterDefinition,beforeDefinition.replace("AND macro='COMPRA DE MERCADORIA'","AND cf_private.normalize_payable_plan(plan)='COMPRA DE MERCADORIA'"));
 assert.deepEqual(await signature(),beforeSignature);unchangedData(before,await snapshot());
 await db.exec(migration);assert.equal(await definition(),afterDefinition);unchangedData(before,await snapshot());
 assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='066_director_merchandise_plan'"),1);
 await actor();assert.equal(await amount(),10000);
 passed++;console.log('PASS activation changes exactly the merchandise plan predicate, preserves ACLs and all rows, and repeats safely');

 await test('the original COMPRA DE MERCADORIA plan counts even when its title macro is FIXO',async()=>{
  await importRows([row('PLANO-CERTO',12345)]);assert.equal((await title('PLANO-CERTO')).macro,'FIXO');assert.equal(await amount(),12345);
 });
 await test('another source plan classified in the merchandise macro does not enter this indicator',async()=>{
  await importRows([row('APENAS-MACRO',54321,{plan:otherPlan})]);assert.equal((await title('APENAS-MACRO')).macro,'COMPRA DE MERCADORIA');assert.equal(await amount(),0);
 });
 await test('case and whitespace in the source plan use the official normalized identity',async()=>{
  await importRows([row('PLANO-NORMALIZADO',23456,{plan:'  compra   de mercadoria  '})]);assert.equal((await title('PLANO-NORMALIZADO')).plan,plan);assert.equal(await amount(),23456);
 });
 await test('all branches and numbered cheques count across overdue and future dates, independently of the selected period',async()=>{
  await importRows([row('ATRASADO',10001,{due_date:'2020-01-01',branch:'FILIAL A'}),row('FUTURO-CHEQUE',20002,{due_date:'2035-12-31',branch:'FILIAL B',cheque_number:'0000457'}),row('HOJE',30003,{branch:'FILIAL C'})]);
  const before=await financial();assert.equal(await amount(),60006);assert.equal(await amount('2020-01-01','2020-01-02'),60006);assert.equal(await amount('2035-12-30','2035-12-31'),60006);assert.equal((await title('FUTURO-CHEQUE')).cheque_number,'0000457');assert.deepEqual(await financial(),before);
 });
 await test('a genuine full payment leaves the plan obligation without changing any original payment',async()=>{
  await importRows([row('REAL-PAGO',25000),row('REAL-ABERTO',7000)]);await pay(await title('REAL-PAGO'));const before=await financial();assert.equal(await amount(),7000);assert.deepEqual(await financial(),before);
 });
 await test('the indicator includes only the genuine remaining balance after an automatic nominal update',async()=>{
  await importRows([row('REAL-PARCIAL',20000)]);await pay(await title('REAL-PARCIAL'));const before=await financial();
  await importRows([row('REAL-PARCIAL',25000,{due_date:tomorrow})]);const t=await title('REAL-PARCIAL');assert.equal(t.paid_cents,20000);assert.equal(t.outstanding_cents,5000);assert.equal(await amount(),5000);assert.deepEqual(await financial(),before);
 });
 await test('report-only Pago removes the listed obligation without inventing realized values and reappearance restores it',async()=>{
  await importRows([row('RELATORIO-ABERTO',17000),row('OUTRO-PLANO',5000,{plan:otherPlan})]);const before=await financial();
  await importRows([row('OUTRO-PLANO',5000,{plan:otherPlan})]);const t=await title('RELATORIO-ABERTO');assert.equal(t.report_paid,true);assert.equal(t.paid_cents,0);assert.equal(await amount(),0);assert.deepEqual(await financial(),before);
  await importRows([row('RELATORIO-ABERTO',19000),row('OUTRO-PLANO',5000,{plan:otherPlan})]);assert.equal((await title('RELATORIO-ABERTO')).report_paid,false);assert.equal(await amount(),19000);assert.deepEqual(await financial(),before);
 });
 await test('an individually confirmed one-cent administrative writeoff remains outside the obligation and actual payments',async()=>{
  await importRows([row('CENTAVO',1),row('ABERTO',32000)],{'row:1':{action:'WRITE_OFF',reason:'Baixa administrativa individual sintética'}});const t=await title('CENTAVO');assert.equal(t.financial_status,'ADMIN_WRITEOFF');assert.equal(t.amount_cents,1);assert.equal(t.paid_cents,0);assert.equal(await amount(),32000);
 });
 await test('positions saved under the prior rule remain immutable while new positions save the new plan-based amount',async()=>{
  assert.equal(await amount(),10000);assert.deepEqual(await scalar('SELECT to_jsonb(p) r FROM public.director_positions p WHERE id=$1',[oldPosition]),oldPositionRow);
  const id=await scalar('SELECT public.save_director_position($1,$1) r',[today]),fresh=await scalar('SELECT to_jsonb(p) r FROM public.director_positions p WHERE id=$1',[id]);assert.equal(fresh.indicators.merchandise_cents,10000);assert.equal(oldPositionRow.indicators.merchandise_cents,20000);assert.deepEqual(await scalar('SELECT to_jsonb(p) r FROM public.director_positions p WHERE id=$1',[oldPosition]),oldPositionRow);
 });
 await test('director access remains read-only and profiles without summary permission cannot read the indicator',async()=>{
  await actor('director');assert.equal(await amount(),10000);await reject(()=>scalar('SELECT public.save_director_position($1,$1) r',[today]));
  for(const name of ['cp','cr','rh','collector']){await actor(name);await reject(()=>report());}
 });
 await test('all unrelated indicators, historical positions and financial rows are unchanged by a read',async()=>{
  const before=await snapshot();await actor();const current=await report();const expected=structuredClone(oldReport),actual=structuredClone(current);delete expected.indicators.merchandise_cents;delete actual.indicators.merchandise_cents;assert.deepEqual(actual,expected);assert.deepEqual(await snapshot(),before);
 });
 if(failures.length){process.exitCode=1;for(const failure of failures)console.error(failure.name,failure.error.stack)}
 console.log(`${passed} passed, ${failures.length} failed (Director merchandise by source plan066, synthetic local PostgreSQL)`);
}catch(error){console.error('FAIL',error.message,error.code??'',error.where??'',error.stack);process.exitCode=1}finally{await db.close()}
