import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Tudo é sintético e descartável. Não conecta ao projeto Supabase publicado.
const db=new PGlite();let passed=0,failed=0,sequence=0,current='gerente_geral';
const roles=['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const people=Object.fromEntries(roles.map((name,index)=>[name,{id:`10000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,
 session:`20000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`}]));
const agents=['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'];
const owner=()=>db.exec('RESET ROLE');
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].r;
const actor=async(name='contas_receber')=>{
 current=name;await owner();await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[
  people[name].id,JSON.stringify({session_id:people[name].session})]);await db.exec('SET ROLE authenticated');
};
const reject=(sql,args=[],code='42501')=>assert.rejects(db.query(sql,args),error=>{assert.equal(error.code,code,error.message);return true;});
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack??error.message);}};
const state=async()=>{
 await owner();const out={};for(const table of ['profiles','role_permissions','collection_agents','collector_bindings','receivable_titles','receivable_imports',
  'receivable_receipts','receivable_collection_events','receivable_sync_imports','audit_events'])
  out[table]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS r FROM public.${table} t`);
 for(const table of ['receivable_parcel_aliases','receivables_sync_state','receivable_import_files'])
  out[table]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS r FROM cf_private.${table} t`);
 for(const table of ['receivable_receipt_import_provenance','receivable_receipt_adjustments','receivable_received_import_rows'])
  if(await scalar('SELECT to_regclass($1)::text AS r',[`public.${table}`]))out[table]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS r FROM public.${table} t`);
 return out;
};
let today,yesterday,twoDays,future,monthStart,baseRows;
const row=(document,extra={})=>({document,client_name:`Cliente sintético ${document}`,client_document:null,branch:'Filial sintética',
 issued_on:'2020-01-01',due_date:yesterday,amount_cents:10000,...extra});
const received=(original,extra={})=>({...original,received_on:today,received_amount_cents:original.amount_cents,...extra});
const revision=()=>scalar('SELECT public.get_receivables_sync_revision() AS r');
const title=async(document,due=null)=>(await db.query('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE document=$1 AND ($2::date IS NULL OR due_date=$2)',[document,due])).rows[0]?.r;
const effective=async id=>(await db.query('SELECT to_jsonb(r) AS r FROM public.effective_receivable_receipts r WHERE title_id=$1',[id])).rows[0]?.r;
const preview=(rows,mappings={})=>scalar('SELECT public.preview_receivables_received_import($1,$2::jsonb,$3::jsonb) AS r',[
 'grupo-consolidado',JSON.stringify(rows),JSON.stringify(mappings)]);
const openPreview=(rows,mappings={})=>scalar('SELECT public.preview_receivables_open_import($1,$2::jsonb,$3::jsonb) AS r',[
 'grupo-consolidado',JSON.stringify(rows),JSON.stringify(mappings)]);
const bytes=n=>Buffer.from(`Relatório sintético CR ${n}. Nunca usar em produção.`);
const commitSql='SELECT public.commit_receivables_received_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11) AS r';
const commit=async(rows,{mappings={},confirm=false,token=null,file=null,role='contas_receber',override={}}={})=>{
 await actor(role);const expected=token??await revision(),number=file??++sequence,original=bytes(number);
 const args=[people[role].id,people[role].session,'grupo-consolidado',`received-${number}.csv`,
  createHash('sha256').update(original).digest('hex'),original.toString('base64'),JSON.stringify(rows),JSON.stringify(mappings),expected.import_id,expected.financial_revision,confirm];
 for(const[index,value]of Object.entries(override))args[Number(index)]=value;
 await owner();await db.exec('SET ROLE service_role');
 try{return await scalar(commitSql,args);}finally{await actor(role);}
};
const open=async(rows,mappings={})=>{
 await actor();const expected=await revision(),number=++sequence,original=bytes(number);
 await owner();await db.exec('SET ROLE service_role');
 try{return await scalar('SELECT public.commit_receivables_open_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) AS r',[
  people.contas_receber.id,people.contas_receber.session,'grupo-consolidado',`open-${number}.csv`,createHash('sha256').update(original).digest('hex'),
  original.toString('base64'),JSON.stringify(rows),JSON.stringify(mappings),expected.import_id,expected.financial_revision]);
 }finally{await actor();}
};
const failCommit=(rows,options={},code='P0024')=>assert.rejects(commit(rows,options),error=>{assert.equal(error.code,code,error.message);return true;});
const assign=async(document,agent=agents[0])=>{
 await actor();const item=await title(document);return scalar('SELECT public.assign_receivable_collector($1,$2,$3) AS r',[item.customer_key,agent,'Carteira sintética conferida']);
};
const manual=async(document)=>{
 await actor('cobradora_1');const item=await title(document);
 await scalar('SELECT public.record_collection_action($1,$2,$3,NULL,NULL,$4,NULL,$5,$6) AS r',[
  item.id,'PAID',today,'Pagamento informado sintético',today,item.revision]);
 await actor();const pending=await title(document);
 return scalar('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5) AS r',[pending.id,'CONFIRM',today,'Validação manual sintética',pending.revision]);
};
const management=(day=null)=>scalar('SELECT public.receivables_management_summary($1) AS r',[day]);
const commission=(start=monthStart,end=today,agent=null,offset=0,limit=25)=>scalar('SELECT public.receivable_commission_base($1,$2,$3,$4,$5) AS r',[start,end,agent,offset,limit]);

try {
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 const read=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
 for(const name of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql',
  '007_director_positions.sql','008_receivables.sql','009_collections.sql','022_collections_overdue_only.sql'])await db.exec(await read(name));
 const migration=await read('024_receivable_received_import.sql');
 await test('024 requires 023 and rolls back without creating partial ledgers',async()=>{
  await assert.rejects(db.exec(migration),error=>error.code==='22023');await db.exec('ROLLBACK');
  assert.equal(await scalar("SELECT to_regclass('public.effective_receivable_receipts')::text AS r"),null);
 });
 await db.exec(await read('023_receivable_sync.sql'));
 for(const[name,person]of Object.entries(people)) {
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[person.id,`${name}@example.invalid`]);
  await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)',[person.id,name]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[person.session,person.id]);
 }
 for(const[index,agent]of agents.entries()) {
  await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,`Responsável sintética ${index+1}`]);
  await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[people[`cobradora_${index+1}`].id,agent,people.gerente_geral.id]);
 }
 ({today,yesterday,twoDays,future,monthStart}=(await db.query(`SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today,
 ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text AS yesterday,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-2)::text AS "twoDays",
 ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+10)::text AS future,date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS "monthStart"`)).rows[0]);
 baseRows=[row('EXACT'),row('LESS'),row('MORE'),row('ADVANCE',{due_date:future}),row('MANUAL'),row('OTHER'),
  row('PARCEL',{due_date:twoDays}),row('PARCEL',{due_date:yesterday}),row('ACTIVE-OWNER',{client_name:'Cliente com carteira'}),row('STILL-OPEN')];
 await open(baseRows);for(const doc of ['EXACT','LESS','MORE','ADVANCE','MANUAL','PARCEL','ACTIVE-OWNER'])await assign(doc);
 await assign('OTHER',agents[1]);const manualReceipt=await manual('MANUAL');
 await test('incremental activation preserves every title, original file, manual receipt, owner, user and audit',async()=>{
  const before=await state();await db.exec(migration);const after=await state();for(const table of Object.keys(before))assert.deepEqual(after[table],before[table],table);
  assert.deepEqual(after.receivable_receipt_adjustments,[]);assert.deepEqual(after.receivable_receipt_import_provenance,[]);
 });
 await actor();
 await test('capabilities advertise both open sync and received imports without new privileged grants',async()=>{
  assert.deepEqual(await scalar('SELECT public.receivables_import_capabilities() AS r'),{schema_version:'024_receivable_received_import',open_sync:true,received_import:true});
  assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.commit_receivables_received_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean)','EXECUTE') AS r"),false);
  assert.equal(await scalar("SELECT has_table_privilege('service_role','public.receivable_receipt_adjustments','INSERT') AS r"),false);
 });
 let exactFile,exactId,exactReceipt;
 await test('ERP settlement records actual amount, validates once and removes active collection without a manual PAID action',async()=>{
  const source=received(baseRows[0]);const p=await preview([source]);assert.equal(p.can_commit,true);assert.equal(p.received_count,1);
  exactId=(await title('EXACT')).id;exactFile=sequence+1;const result=await commit([source]);assert.equal(result.received_count,1);
  const t=await title('EXACT'),r=await effective(t.id);exactReceipt=r.id;
  assert.equal(t.id,exactId);assert.equal(t.status,'VALIDATED');assert.equal(t.validation_status,'VALIDATED');assert.equal(t.payment_date,today);
  assert.equal(t.collector_id,agents[0]);assert.equal(r.amount_cents,10000);assert.equal(r.nominal_amount_cents,10000);
  assert.equal(r.reported_in_collection,false);assert.equal(r.payment_source,'IMPORTACAO_DIARIA');assert.equal(r.source_kind,'ERP_RECEIVED');
  await actor('cobradora_1');assert.equal((await db.query("SELECT id FROM public.collection_overdue_titles WHERE id=$1 AND status<>'VALIDATED'",[t.id])).rows.length,0);
  assert.equal((await db.query('SELECT * FROM public.collection_overdue_titles WHERE id=$1',[t.id])).rows.length,1);await actor();
 });
 await test('received amounts below and above nominal settle the whole title without a fabricated residual',async()=>{
  await commit([received(baseRows[1],{received_amount_cents:9000}),received(baseRows[2],{received_amount_cents:11500})]);
  for(const[doc,actual]of [['LESS',9000],['MORE',11500]]) {
   const t=await title(doc),r=await effective(t.id);assert.equal(t.status,'VALIDATED');assert.equal(t.amount_cents,10000);
   assert.equal(r.amount_cents,actual);assert.equal(r.nominal_amount_cents,10000);
  }
 });
 await test('advance receipts retain the original future due date and zero delay while closing the debt',async()=>{
  await commit([received(baseRows[3],{received_amount_cents:8500})]);const t=await title('ADVANCE'),r=await effective(t.id);
  assert.equal(t.due_date,future);assert.equal(t.status,'VALIDATED');assert.equal(r.payment_date,today);assert.equal(r.delay_days,0);assert.equal(r.amount_cents,8500);
 });
 await test('paid-only subsets leave all absent open obligations untouched',async()=>{
  const before=await title('STILL-OPEN');await commit([received(baseRows[0])]);assert.deepEqual(await title('STILL-OPEN'),before);
 });
 await test('mode-aware file replay is idempotent despite stale tokens, with no duplicate rows or audit',async()=>{
  const before=await state();const result=await commit([received(baseRows[0])],{file:exactFile,token:{import_id:null,financial_revision:null}});
  assert.equal(result.idempotent,true);assert.deepEqual(await state(),before);
 });
 await test('a different report containing the same receipt reuses its original ledger identity',async()=>{
  await actor();const p=await preview([received(baseRows[0])]);assert.equal(p.matched_count,1);
  const result=await commit([received(baseRows[0])]);assert.equal(result.matched_count,1);assert.equal((await effective(exactId)).id,exactReceipt);
  assert.equal((await db.query('SELECT * FROM public.receivable_receipt_adjustments WHERE receipt_id=$1',[exactReceipt])).rows.length,0);
 });
 await test('import-owned corrections require file confirmation and append immutable actual history',async()=>{
  const corrected=received(baseRows[0],{received_amount_cents:12500,received_on:yesterday});const p=await preview([corrected]);assert.equal(p.correction_count,1);
  const before=await state();await failCommit([corrected]);assert.deepEqual(await state(),before);
  await commit([corrected],{confirm:true});const r=await effective(exactId);assert.equal(r.id,exactReceipt);assert.equal(r.amount_cents,12500);
  assert.equal(r.payment_date,yesterday);assert.equal(r.receipt_revision,1);assert.equal(r.original_received_amount_cents,10000);assert.equal(r.original_payment_date,today);
  assert.equal(await scalar('SELECT amount_cents AS r FROM public.receivable_receipts WHERE id=$1',[exactReceipt]),10000);
  await reject('UPDATE public.receivable_receipt_adjustments SET amount_cents=1 WHERE receipt_id=$1',[exactReceipt]);
  await owner();await reject('DELETE FROM public.receivable_receipt_adjustments WHERE receipt_id=$1',[exactReceipt]);await actor();
 });
 await test('a confirmed due/nominal correction keeps the title UUID, recalculates receipt delay and retains old aliases',async()=>{
  const changed=received(baseRows[0],{due_date:twoDays,amount_cents:13000,received_amount_cents:12500,received_on:yesterday});
  const p=await preview([changed],{'1':exactId});assert.equal(p.correction_count,1);
  await commit([changed],{mappings:{'1':exactId},confirm:true});const t=await title('EXACT'),r=await effective(exactId);
  assert.equal(t.id,exactId);assert.equal(t.amount_cents,13000);assert.equal(t.due_date,twoDays);assert.equal(r.amount_cents,12500);
  assert.equal(r.nominal_amount_cents,13000);assert.equal(r.delay_days,1);assert.equal(r.receipt_revision,2);
  await owner();assert.equal(await scalar('SELECT count(*)::int AS r FROM cf_private.receivable_parcel_aliases WHERE title_id=$1',[exactId]),2);await actor();
 });
 await test('matching manual receipts are reused without taking import ownership; differences stay atomic conflicts',async()=>{
  const p=await preview([received(baseRows[4])]);assert.equal(p.matched_count,1);await commit([received(baseRows[4])]);
  const t=await title('MANUAL'),r=await effective(t.id);assert.equal(r.id,manualReceipt);assert.equal(r.source_kind,'MANUAL_VALIDATION');assert.equal(r.payment_source,'COBRANCA');
  const changed=received(baseRows[4],{received_amount_cents:9999});assert.equal((await preview([changed])).rows[0].outcome,'CONFLICT');
  const before=await state();await failCommit([changed],{confirm:true});assert.deepEqual(await state(),before);
 });
 await test('unknown historical settlements can inherit a unique active wallet without inventing open forecasts',async()=>{
  const unknown=received(row('HISTORY',{client_name:'Cliente com carteira',due_date:twoDays}),{received_amount_cents:12345});
  const p=await preview([unknown]);assert.equal(p.historical_count,1);assert.equal(p.rows[0].collector_id,agents[0]);
  await commit([unknown]);const t=await title('HISTORY'),r=await effective(t.id);assert.equal(t.status,'VALIDATED');assert.equal(t.in_latest_report,false);
  assert.equal(t.collector_id,agents[0]);assert.equal(r.amount_cents,12345);assert.equal(t.first_import_id,t.last_import_id);
  const unassigned=received(row('NO-OWNER',{due_date:twoDays}),{received_amount_cents:777});await commit([unassigned]);
  assert.equal((await title('NO-OWNER')).collector_id,null);
 });
 await test('same NF with distinct due dates stays separate and an ambiguous new parcel requires an explicit choice',async()=>{
  const exact=received(baseRows[6]);const p=await preview([exact]);assert.equal(p.rows[0].title_id,(await title('PARCEL',twoDays)).id);await commit([exact]);
  assert.equal((await title('PARCEL',yesterday)).status,'NEW');
  const changed=received(row('PARCEL',{due_date:'2020-05-01'}));const ambiguous=await preview([changed]);assert.equal(ambiguous.can_commit,false);assert.equal(ambiguous.rows[0].outcome,'AMBIGUOUS');
  await failCommit([changed]);assert.equal((await preview([changed],{'1':'NEW'})).rows[0].outcome,'HISTORICAL');await commit([changed],{mappings:{'1':'NEW'}});
  assert.equal((await db.query("SELECT * FROM public.receivable_titles WHERE document='PARCEL'")).rows.length,3);
 });
 await test('invalid actual dates, amounts, duplicate parcels and foreign mapping targets cannot make partial writes',async()=>{
  const good=received(row('INVALID-NEW'));const before=await state();
  for(const extra of [{received_amount_cents:0},{received_amount_cents:-1},{received_amount_cents:1.1},{received_on:future},{received_on:'2026-02-30'},
   {received_on:null},{received_amount_cents:'10000'},{unexpected:'x'}])await failCommit([{...good,...extra}],{},'22023');
  await failCommit([good,good],{},'23505');
  assert.equal((await preview([good],{'1':(await title('OTHER')).id})).can_commit,false);await failCommit([good],{mappings:{'1':(await title('OTHER')).id}});
  assert.deepEqual(await state(),before);
 });
 await test('stale financial or import revisions block commits, and every change refreshes the opaque financial revision',async()=>{
  const candidate=received(row('CONCURRENT')),p=await preview([candidate]);const token={import_id:p.previous_import_id,financial_revision:p.financial_revision};
  await assign('STILL-OPEN',agents[1]);await failCommit([candidate],{token},'40001');
  const before=await revision();await commit([received(row('OTHER-HISTORY'))]);assert.notEqual((await revision()).financial_revision,before.financial_revision);
  await failCommit([candidate],{token:{import_id:before.import_id,financial_revision:(await revision()).financial_revision}},'40001');
 });
 await test('management daily/monthly totals use effective actual receipts, while the legacy summary keeps its origin filter',async()=>{
  const got=await management(),all=(await db.query("SELECT amount_cents,payment_date::text AS payment_date FROM public.effective_receivable_receipts WHERE validation='VALIDADO'")).rows;
  assert.equal(got.received_date,today);assert.equal(got.as_of_date,today);
  assert.equal(got.received_day_cents,all.filter(r=>r.payment_date===today).reduce((sum,r)=>sum+Number(r.amount_cents),0));
  assert.equal(got.received_month_cents,all.filter(r=>r.payment_date>=monthStart&&r.payment_date<=today).reduce((sum,r)=>sum+Number(r.amount_cents),0));
  const legacy=await scalar('SELECT public.receivables_summary($1,$2) AS r',[monthStart,today]);assert.equal(got.received_month_cents-legacy.received_period_cents,10000);
  const yesterdaySummary=await management(yesterday);assert.equal(yesterdaySummary.received_date,yesterday);assert.equal(yesterdaySummary.received_day_cents,12500);
 });
 await test('commission base uses actual values, ERP-only settlement and original receipt delay without inventing a rate',async()=>{
  await actor('diretor');const result=await commission();assert.equal(result.rule_status,'AGUARDANDO_REGRAS');assert.equal(result.collectors.length,2);
  const less=result.rows.find(r=>r.document==='LESS');assert.equal(less.amount_cents,9000);assert.equal(less.nominal_amount_cents,10000);assert.equal(less.base_cents,9000);assert.equal(less.eligibility,'BASE_DISPONIVEL');
  const advance=result.rows.find(r=>r.document==='ADVANCE');assert.equal(advance.eligibility,'RECEBIDO_EM_DIA');assert.equal(advance.base_cents,8500);
  const unknown=result.rows.find(r=>r.document==='NO-OWNER');assert.equal(unknown.eligibility,'PENDENTE_RESPONSAVEL');assert(result.unassigned_count>0);
  assert.equal(result.eligible_base_cents,result.rows.filter(r=>r.eligibility==='BASE_DISPONIVEL').reduce((sum,r)=>sum+r.base_cents,0));
  assert(!('commission_amount_cents' in less));assert(!('rate' in less));
  const filtered=await commission(monthStart,today,agents[0],0,2);assert.equal(filtered.rows.length,2);assert(filtered.rows.every(r=>r.collector_id===agents[0]));
  await actor();
 });
 await test('global commission and receipt details require permissions; an explicitly enabled collector remains wallet-scoped',async()=>{
  for(const role of ['contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2']) {await actor(role);await reject('SELECT public.receivable_commission_base($1,$2)',[monthStart,today]);}
  await owner();await db.query("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('cobradora_1','comissoes','read')");
  await actor('cobradora_1');const own=await commission();assert(own.rows.length>0&&own.rows.every(r=>r.collector_id===agents[0]));
  assert.deepEqual(own.collectors.map(r=>r.id),[agents[0]]);assert.equal(own.unassigned_count,0);
  await reject('SELECT public.receivable_commission_base($1,$2,$3)',[monthStart,today,agents[1]]);
  assert((await db.query('SELECT * FROM public.effective_receivable_receipts')).rows.every(r=>r.collector_id===agents[0]));
  await actor('contas_pagar');assert.deepEqual((await db.query('SELECT * FROM public.effective_receivable_receipts')).rows,[]);
  await management();await actor();
 });
 await test('Director, CP, RH, collectors and anonymous callers cannot create receipts through public or service APIs',async()=>{
  const data=received(row('FORGED'));const before=await state();
  for(const role of roles) {
   await actor(role);await reject(commitSql,[people[role].id,people[role].session,'grupo-consolidado','forged.csv','a'.repeat(64),'eA==',JSON.stringify([data]),'{}',null,'0',false]);
   if(!['gerente_geral','contas_receber'].includes(role)) {
    await reject('SELECT public.preview_receivables_received_import($1,$2)', ['grupo-consolidado',JSON.stringify([data])]);
    await failCommit([data],{role},'42501');
   }
  }
  await owner();await db.exec('SET ROLE anon');await reject('SELECT * FROM public.effective_receivable_receipts');
  await reject('SELECT public.receivables_management_summary()');await reject('SELECT public.receivable_commission_base($1,$2)',[monthStart,today]);
  assert.deepEqual(await state(),before);await actor();
 });
 await test('previews, summary and commission GETs do not mutate ledger, aliases, owners, revision or audit',async()=>{
  const before=await state();await actor();await preview([received(row('READ-ONLY'))]);await management();
  await actor('diretor');await commission();await scalar('SELECT public.receivables_summary($1,$2) AS r',[monthStart,today]);
  assert.deepEqual(await state(),before);await actor();
 });
 await test('financial validation permission and session revocation block new imports without partial ledger changes',async()=>{
  await owner();await db.query("DELETE FROM public.role_permissions WHERE role_key='contas_receber' AND resource='contas_receber' AND action='validate'");
  await actor();const before=await state();await failCommit([received(row('NO-PERMISSION'))],{},'42501');assert.deepEqual(await state(),before);
  await owner();await db.query("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('contas_receber','contas_receber','validate')");
  await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[people.contas_receber.session,people.contas_receber.id]);
  await actor();await failCommit([received(row('REVOKED'))],{},'42501');
  await actor('gerente_geral');await reject('UPDATE public.receivable_receipts SET amount_cents=1 WHERE id=$1',[exactReceipt]);
  await owner();await reject('DELETE FROM public.receivable_receipt_import_provenance WHERE receipt_id=$1',[exactReceipt]);
 });
 await test('invalid management/commission ranges and independently overflowing actual totals are rejected',async()=>{
  await actor('gerente_geral');
  await reject('SELECT public.receivables_management_summary($1)',[future],'22023');
  for(const args of [[today,yesterday,null,0,25],[monthStart,today,null,-1,25],[monthStart,today,null,0,101]])
   await reject('SELECT public.receivable_commission_base($1,$2,$3,$4,$5)',args,'22023');
  const giant=received(row('PRECISION',{amount_cents:1}),{received_amount_cents:9007199254740991});
  await commit([giant],{role:'gerente_geral'});
  await reject('SELECT public.receivables_management_summary() ',[],'22003');
  await reject('SELECT public.receivable_commission_base($1,$2)',[monthStart,today],'22003');
 });
 await test('without an official import the management summary leaves every amount/count pending',async()=>{
  const empty=new PGlite();
  try {
   await empty.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
   for(const name of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql',
    '007_director_positions.sql','008_receivables.sql','009_collections.sql','022_collections_overdue_only.sql','023_receivable_sync.sql','024_receivable_received_import.sql'])await empty.exec(await read(name));
   await empty.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[people.gerente_geral.id,'empty@example.invalid']);
   await empty.query("INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,'EmptyManager','Empty','gerente_geral',true)",[people.gerente_geral.id]);
   await empty.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[people.gerente_geral.session,people.gerente_geral.id]);
   await empty.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[people.gerente_geral.id,JSON.stringify({session_id:people.gerente_geral.session})]);
   await empty.exec('SET ROLE authenticated');const result=(await empty.query('SELECT public.receivables_management_summary() AS r')).rows[0].r;
   for(const field of ['open_cents','overdue_cents','received_day_cents','received_month_cents','active_count','latest_import_at','latest_import_id'])assert.equal(result[field],null,field);
   assert.equal(result.as_of_date,today);assert.equal(result.received_date,today);
  }finally {await empty.close();}
 });
} catch(error) {failed++;console.error('SETUP FAILURE',error.stack??error.message);}
finally {await db.close();}
console.log(`${passed} passed; ${failed} failed (local PostgreSQL, synthetic Supabase identity)`);
if(failed)process.exitCode=1;
