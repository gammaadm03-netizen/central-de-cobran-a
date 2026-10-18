import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Disposable PostgreSQL: every identity, original file and transaction is synthetic.
const db=new PGlite();let passed=0,seq=0,latestImport=null,today,yesterday,month,nextMonth,bank,bank2,bankName,bankName2,initial,oldClosure,oldSnapshot,firstPaidFile,paidA,firstPaymentA;
const roles=['gerente_geral','diretor','contas_pagar','contas_receber','rh_dp','cobradora_1','cobradora_2'];
const uid=i=>`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const sid=i=>`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].r;
const role=async name=>{await db.exec('RESET ROLE');await db.exec(`SET ROLE ${name}`);};
const actor=async i=>{await role('postgres');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[uid(i),JSON.stringify({session_id:sid(i),role:'admin'})]);await role('authenticated');};
const rejects=async(sql,args=[],code='42501')=>assert.rejects(db.query(sql,args),e=>{assert.equal(e.code,code,e.message);return true;});
const test=async(name,run)=>{await run();passed++;console.log('PASS',name);};
const sqlFile=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const names=['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql','007_director_positions.sql',
 '008_receivables.sql','009_collections.sql','010_bank_import.sql','011_receivables_positions.sql','012_treasury_accounts.sql','013_director_report.sql',
 '014_payables_forecast.sql','015_payable_payments.sql','016_payable_identity_updates.sql','017_payable_month_closing.sql','018_payable_full_payment.sql','019_payable_cheques.sql','020_payables_management.sql'];
const forecastSql='SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9) r';
const paidSql='SELECT public.commit_payables_paid_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r';
const rows=async table=>(await db.query(`SELECT to_jsonb(t) r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const title=async entry=>scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1',[entry]);
const revision=()=>scalar('SELECT public.get_payables_revision() r');
const state=async()=>{await role('postgres');try{return Object.fromEntries(await Promise.all(['public.payable_titles','public.payable_imports','cf_private.payable_import_files','public.payable_payments',
 'public.payable_payment_reversals','public.payable_title_reviews','public.payable_import_modes','public.payable_paid_import_rows','public.payable_paid_bank_mappings','public.audit_events',
 'public.payable_title_control_revisions','cf_private.payable_payment_state','cf_private.payable_control_state'].map(async t=>[t,await rows(t)])));}finally{await actor(0);}};
const preview=(list,mappings={},plans={})=>scalar('SELECT public.preview_payables_paid_import($1,$2,$3,$4) r',['grupo-consolidado',JSON.stringify(list),JSON.stringify(mappings),JSON.stringify(plans)]);
const forecastPreview=list=>scalar('SELECT public.preview_payables_forecast_import($1,$2) r',['grupo-consolidado',JSON.stringify(list)]);
const file=n=>Buffer.from(`Relatório original sintético ${n}`);
const forecastRow=(entry_number,amount_cents,extra={})=>({entry_number,amount_cents,plan:'DESPESA TESTE',description:'Fornecedor sintético',branch:'2 - TESTE',due_date:nextMonth.slice(0,8)+'05',issued_on:today,source_status:'ABERTO',bank_account:'ORIGEM ERP',...extra});
const paidRow=(entry_number,amount_paid_cents,extra={})=>({branch:'2 - TESTE',entry_number,source_status:'PAGO',amount_paid_cents,paid_on:yesterday,paid_bank:bankName,...extra});
const forecast=async(list,plans={'DESPESA TESTE':'FIXO'},identity=0)=>{
 const n=++seq,bytes=file(n);await role('service_role');try{
  const out=await scalar(forecastSql,[uid(identity),sid(identity),'grupo-consolidado',`previsao-${n}.csv`,createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(list),JSON.stringify(plans),latestImport]);latestImport=out.import_id;return out;
 }finally{await actor(0);}
};
const paid=async(list,{mappings={},plans={},confirm=false,identity=0,duplicate=null,expected=latestImport,financialRevision=undefined}={})=>{
 const expectedFinance=financialRevision===undefined?(await revision()).financial_revision:financialRevision;
 const n=duplicate??++seq,bytes=file(n);await role('service_role');try{
  const out=await scalar(paidSql,[uid(identity),sid(identity),'grupo-consolidado',`pagos-${n}.csv`,createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(list),JSON.stringify(mappings),expected,confirm,JSON.stringify(plans),expectedFinance]);
  if(!out.idempotent)latestImport=out.import_id;return out;
 }finally{await actor(0);}
};
const review=async t=>scalar('SELECT public.review_payable_title($1,$2,$3) r',[t.id,'Conferência sintética',t.review_fingerprint]);
const total=(start=yesterday,end=start)=>scalar('SELECT public.payable_payment_summary($1,$2) r',[start,end]);
const expectPaidFailure=async(list,opts={},code='P0021')=>assert.rejects(paid(list,opts),e=>{assert.equal(e.code,code,e.message);return true;});
const bootstrap=`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`;

try{
 await db.exec(bootstrap);for(const name of names)await db.exec(await sqlFile(name));
 for(const[i,name]of roles.entries()){
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(i),`paid-import-${i}@example.invalid`]);
  await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[uid(i),`PaidImport${i}`,`Pessoa sintética ${i}`,name]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(i),uid(i)]);
 }
 const d=(await db.query(`SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text yesterday,
 date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS "month",(date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')+interval '1 month')::date::text next`)).rows[0];
 today=d.today;yesterday=d.yesterday;month=d.month;nextMonth=d.next;await actor(0);
 const accounts=(await db.query('SELECT id,display_name FROM public.bank_accounts WHERE enabled ORDER BY display_name LIMIT 2')).rows;bank=accounts[0].id;bankName=accounts[0].display_name;bank2=accounts[1].id;bankName2=accounts[1].display_name;
 await scalar("SELECT public.set_bank_balance($1,$2,123456,'Saldo sintético anterior',null) r",[bank,today]);
 initial=[forecastRow('A',10000),forecastRow('B',20000,{due_date:nextMonth.slice(0,8)+'10'}),forecastRow('MANUAL',30000,{due_date:today}),forecastRow('UNPAID',40000,{due_date:nextMonth.slice(0,8)+'20'})];
 let bytes=file(++seq);await role('service_role');const base=await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,null) r',[
  uid(0),sid(0),'grupo-consolidado','inicial.csv',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(initial),JSON.stringify({'DESPESA TESTE':'FIXO'})]);latestImport=base.import_id;await actor(0);
 const m=await title('MANUAL');await scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r',[m.id,30000,yesterday,bank,'Pagamento manual sintético',m.payment_revision,randomUUID(),m.last_import_id]);await review(await title('MANUAL'));
 const ms=await scalar('SELECT public.payables_month_status($1) r',[month]);oldClosure=await scalar('SELECT public.close_payables_month($1,$2,$3) r',[month,'Fechamento anterior sintético',ms.revision]);oldSnapshot=await scalar('SELECT public.read_payable_month_closure($1) r',[oldClosure]);
 await role('postgres');const protectedTables=['public.profiles','public.payable_titles','public.payable_imports','cf_private.payable_import_files','public.payable_payments','public.payable_payment_reversals',
  'public.bank_accounts','public.bank_balance_positions','public.payable_title_reviews','public.payable_month_closures','public.payable_month_events','public.audit_events'];
 const before=Object.fromEntries(await Promise.all(protectedTables.map(async t=>[t,await rows(t)])));await db.exec(await sqlFile('021_payable_paid_import.sql'));
 await test('incremental activation preserves users, titles, original files, receipts, reviews, closed positions, banks and audits',async()=>{
  for(const t of protectedTables){const after=await rows(t);assert.deepEqual(t==='public.payable_imports'?after.map(({r})=>({r:Object.fromEntries(Object.entries(r).filter(([k])=>k!=='import_mode'))})):after,before[t],t);}
  assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='021_payable_paid_import'"),1);
 });await actor(0);
 await test('new capabilities identify incremental forecast and paid confirmation modes while preserving cheque support',async()=>{
  assert.deepEqual(await scalar('SELECT public.payables_import_capabilities() r'),{schema_version:'021_payable_paid_import',cheque_number:true,forecast_incremental:true,paid_import:true});
 });
 await test('Monday forecasts add only new titles without settling or modifying absent obligations',async()=>{
  const originals=Object.fromEntries(await Promise.all(initial.map(async t=>[t.entry_number,await title(t.entry_number)])));
  const n=forecastRow('NEW',50000,{due_date:nextMonth.slice(0,8)+'25'}),p=await forecastPreview([n]);assert.equal(p.new_count,1);assert.equal(p.settled_count,0);
  const out=await forecast([n]);assert.equal(out.new_count,1);assert.equal(out.settled_count,0);
  for(const entry of initial.map(t=>t.entry_number))assert.deepEqual(await title(entry),originals[entry],entry);
  assert.equal((await scalar('SELECT public.payables_month_status($1) r',[month])).status,'CLOSED');assert.equal((await total()).total_paid_cents,30000);
 });
 await test('incremental updates retain stable UUID and first import while revising amount/date/bank without a second debt',async()=>{
  const t=await title('NEW'),row=forecastRow('NEW',55000,{due_date:nextMonth.slice(0,8)+'26',bank_account:'BANCO ERP ATUALIZADO',cheque_number:'000765'});
  const p=await forecastPreview([row]);assert.equal(p.changed_count,1);const out=await forecast([row]);assert.equal(out.open_count,1);assert.equal(out.settled_count,0);
  const next=await title('NEW');assert.equal(next.id,t.id);assert.equal(next.first_import_id,t.first_import_id);assert.equal(next.amount_cents,55000);assert.equal(next.cheque_number,'000765');assert.equal(next.paid_cents,0);
 });
 await test('forecast mode refuses paid or cancelled statuses and unclassified plans atomically',async()=>{
  const old=await state();await assert.rejects(forecast([forecastRow('BAD',1,{source_status:'PAGO'})]),e=>e.code==='22023');
  await assert.rejects(forecast([forecastRow('BAD',1,{plan:'NÃO CLASSIFICADO TESTE'})],{}),e=>e.code==='23514');assert.deepEqual(await state(),old);
 });
 await test('the original public import APIs also preserve absent obligations after the new rule is installed',async()=>{
  const original=await title('A'),subset=[forecastRow('LEGACY-CLIENT',7000)];
  const p=await scalar('SELECT public.preview_payables_import($1,$2) r',['grupo-consolidado',JSON.stringify(subset)]);assert.equal(p.settled_count,0);
  const bytes=file(++seq);await role('service_role');const out=await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,$9) r',[
   uid(0),sid(0),'grupo-consolidado','cliente-antigo.csv',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(subset),JSON.stringify({'DESPESA TESTE':'FIXO'}),latestImport]);
  latestImport=out.import_id;await actor(0);assert.equal(out.settled_count,0);assert.deepEqual(await title('A'),original);
 });
 await test('paid preview requires an existing canonical title, real complete amount, actual date and exact official bank',async()=>{
  paidA=paidRow('A',10000,{description:'Favorecido atualizado pelo ERP',plan:'DESPESA TESTE',issued_on:null,cheque_number:'000111'});
  const p=await preview([paidA]);assert.equal(p.can_commit,true);assert.equal(p.new_payment_count,1);assert.equal(p.errors.length,0);assert.equal(p.rows[0].bank_account_id,bank);
  assert.equal(p.rows[0].forecast_due_date,nextMonth.slice(0,8)+'05');assert.equal(p.rows[0].paid_on,yesterday);assert.equal(p.rows[0].target_macro,'FIXO');
 });
 await test('paid report posts one integral actual receipt and automatically marks CONCILIADO while preserving original due date and nominal amount',async()=>{
  const t=await title('A');firstPaidFile=seq+1;const out=await paid([paidA]);assert.equal(out.new_payment_count,1);assert.equal(out.reviewed_count,1);
  const next=await title('A');assert.equal(next.id,t.id);assert.equal(next.due_date,t.due_date);assert.equal(next.amount_cents,t.amount_cents);assert.equal(next.description,paidA.description);assert.equal(next.issued_on,null);
  assert.equal(next.bank_account,bankName);assert.equal(next.financial_status,'PAID');assert.equal(next.review_status,'CONCILIADO');assert.equal(next.cheque_number,'000111');
  const h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(h.count,1);firstPaymentA=h.rows[0].id;
  assert.equal(h.rows[0].paid_on,yesterday);assert.equal(h.rows[0].amount_cents,10000);assert.equal(h.rows[0].cheque_number,'000111');assert.equal((await total()).total_paid_cents,40000);
  assert.equal((await title('UNPAID')).paid_cents,0);assert.equal((await title('UNPAID')).status,'NEW');
 });
 await test('actual paid month reopens its saved position without changing earlier immutable snapshots',async()=>{
  assert.equal((await scalar('SELECT public.payables_month_status($1) r',[month])).status,'OPEN');assert.deepEqual(await scalar('SELECT public.read_payable_month_closure($1) r',[oldClosure]),oldSnapshot);
 });
 await test('same paid file is idempotent even with an old preview token and cannot duplicate receipts, imports, reviews or audit',async()=>{
  const old=await state(),out=await paid([paidA],{duplicate:firstPaidFile,expected:null,financialRevision:null});assert.equal(out.idempotent,true);assert.deepEqual(await state(),old);
 });
 await test('a new report repeating the same actual receipt reuses its ledger record instead of paying twice',async()=>{
  const p=await preview([paidA]);assert.equal(p.matched_payment_count,1);assert.equal(p.new_payment_count,0);const out=await paid([paidA]);assert.equal(out.matched_payment_count,1);
  const h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[(await title('A')).id]);assert.equal(h.count,1);assert.equal(h.rows[0].id,firstPaymentA);
 });
 await test('matching manual receipts may be confirmed without changing their original payment or transferring its ownership',async()=>{
  const t=await title('MANUAL'),h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);const id=h.rows[0].id;
  const p=await preview([paidRow('MANUAL',30000)]);assert.equal(p.matched_payment_count,1);await paid([paidRow('MANUAL',30000)]);
  const after=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(after.count,1);assert.equal(after.rows[0].id,id);
  const conflict=await preview([paidRow('MANUAL',30000,{paid_on:today})]);assert.equal(conflict.rows[0].outcome,'CONFLICT');const old=await state();await expectPaidFailure([paidRow('MANUAL',30000,{paid_on:today})],{confirm:true});assert.deepEqual(await state(),old);
 });
 await test('unknown titles and future dates cannot silently create obligations or paid history',async()=>{
  const old=await state();assert.equal((await preview([paidRow('UNKNOWN',123)])).rows[0].outcome,'UNKNOWN_TITLE');await expectPaidFailure([paidRow('UNKNOWN',123)]);
  await rejects('SELECT public.preview_payables_paid_import($1,$2)',['grupo-consolidado',JSON.stringify([paidRow('B',20000,{paid_on:'9999-12-31'})])],'22023');assert.deepEqual(await state(),old);
 });
 await test('a new paid plan is blocked until its macro is explicitly classified, then source metadata updates without changing the original due date',async()=>{
  const row=paidRow('B',20000,{plan:'NOVO PLANO TESTE',description:'Fornecedor B atualizado',issued_on:yesterday});const p=await preview([row]);assert.equal(p.can_commit,false);assert.equal(p.unclassified_plans[0].plan,'NOVO PLANO TESTE');
  const plans={'NOVO PLANO TESTE':'FRETE'};const valid=await preview([row],{},plans);assert.equal(valid.can_commit,true);assert.equal(valid.rows[0].target_macro,'FRETE');const before=await title('B');await paid([row],{plans});
  const t=await title('B');assert.equal(t.plan,'NOVO PLANO TESTE');assert.equal(t.macro,'FRETE');assert.equal(t.description,row.description);assert.equal(t.issued_on,yesterday);assert.equal(t.due_date,before.due_date);assert.equal(t.review_status,'CONCILIADO');
  assert.equal((await total()).by_macro.find(m=>m.macro==='FRETE').amount_cents,20000);
 });
 await test('import-owned macro corrections require explicit consent and append reversal plus a new full receipt without rewriting originals',async()=>{
  const row=paidRow('B',20000,{plan:'DESPESA TESTE'}),p=await preview([row]);assert.equal(p.correction_count,1);assert.equal(p.can_commit,true);const old=await state();await expectPaidFailure([row]);assert.deepEqual(await state(),old);
  const t=await title('B'),h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);const previous=h.rows[0];await paid([row],{confirm:true});
  const next=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(next.count,2);assert(next.rows.some(r=>r.id===previous.id&&r.status==='CANCELLED'&&r.macro_snapshot==='FRETE'));
  assert(next.rows.some(r=>r.status==='ACTIVE'&&r.macro_snapshot==='FIXO'&&r.amount_cents===20000));assert.equal((await title('B')).review_status,'CONCILIADO');assert.equal((await total()).by_macro.find(m=>m.macro==='FRETE').amount_cents,0);
 });
 await test('import-owned bank/date corrections use confirmed reversal and a new exact receipt, preserving the forecast due date',async()=>{
  const row=paidRow('A',10000,{paid_on:today,paid_bank:bankName2}),p=await preview([row]);assert.equal(p.correction_count,1);const due=(await title('A')).due_date;await paid([row],{confirm:true});
  const t=await title('A');assert.equal(t.due_date,due);assert.equal(t.review_status,'CONCILIADO');const h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);
  assert(h.rows.some(r=>r.id===firstPaymentA&&r.status==='CANCELLED'&&r.paid_on===yesterday));assert(h.rows.some(r=>r.status==='ACTIVE'&&r.paid_on===today&&r.bank_account_id===bank2));assert.equal((await total(today)).total_paid_cents,10000);
 });
 await test('ERP value updates first revise the forecast; a later corrected paid report replaces the imported receipt with one full updated amount',async()=>{
  const t=await title('A');await forecast([forecastRow('A',12000,{due_date:nextMonth.slice(0,8)+'06'})]);assert.equal((await title('A')).financial_status,'PARTIAL');
  const row=paidRow('A',12000,{paid_on:today,paid_bank:bankName2});const p=await preview([row]);assert.equal(p.correction_count,1);await paid([row],{confirm:true});
  const after=await title('A');assert.equal(after.id,t.id);assert.equal(after.amount_cents,12000);assert.equal(after.paid_cents,12000);assert.equal(after.financial_status,'PAID');assert.equal(after.review_status,'CONCILIADO');
  const h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert(h.rows.some(r=>r.status==='ACTIVE'&&r.amount_cents===12000));assert(!h.rows.some(r=>r.status==='ACTIVE'&&r.amount_cents===2000));
 });
 await test('a full paid report updates the source nominal directly from 100 to 120, then a corrected 130 creates a new full receipt and preserves old history',async()=>{
  await forecast([forecastRow('ERP-VALUE',10000)]);const original=await title('ERP-VALUE'),row=paidRow('ERP-VALUE',12000);const p=await preview([row]);assert.equal(p.rows[0].amount_changed,true);assert.equal(p.rows[0].previous_amount_cents,10000);
  await paid([row]);let t=await title('ERP-VALUE');assert.equal(t.id,original.id);assert.equal(t.due_date,original.due_date);assert.equal(t.amount_cents,12000);assert.equal(t.paid_cents,12000);assert.equal(t.review_status,'CONCILIADO');
  const changed=paidRow('ERP-VALUE',13000);assert.equal((await preview([changed])).correction_count,1);await paid([changed],{confirm:true});t=await title('ERP-VALUE');assert.equal(t.amount_cents,13000);assert.equal(t.paid_cents,13000);
  const h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert(h.rows.some(r=>r.status==='CANCELLED'&&r.amount_cents===12000));assert(h.rows.some(r=>r.status==='ACTIVE'&&r.amount_cents===13000));assert(!h.rows.some(r=>r.amount_cents===1000));
 });
 await test('an explicit changed cheque replaces only imported receipts; omission preserves the snapshot and manual differences remain conflicts',async()=>{
  const current=await title('A'),row=paidRow('A',12000,{paid_on:today,paid_bank:bankName2,cheque_number:'000222'});assert.equal((await preview([row])).correction_count,1);await paid([row],{confirm:true});
  const h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[current.id]);assert(h.rows.some(r=>r.status==='ACTIVE'&&r.cheque_number==='000222'));
  assert.equal((await preview([paidRow('A',12000,{paid_on:today,paid_bank:bankName2})])).matched_payment_count,1);
  const manual=await preview([paidRow('MANUAL',30000,{cheque_number:'000333'})]);assert.equal(manual.rows[0].outcome,'CONFLICT');
 });
 await test('the same original bytes are valid in distinct forecast and payments modes, while a repeated payments mode remains idempotent',async()=>{
  const source=forecastRow('SAME-BYTES',9000,{due_date:yesterday});await forecast([source]);const sourceFile=seq,t=await title('SAME-BYTES'),row=paidRow('SAME-BYTES',9000);
  const out=await paid([row],{duplicate:sourceFile});assert.equal(out.new_payment_count,1);assert.equal((await title('SAME-BYTES')).id,t.id);
  const old=await state();assert.equal((await paid([row],{duplicate:sourceFile,financialRevision:null})).idempotent,true);assert.deepEqual(await state(),old);
 });
 await test('unmapped actual banks require explicit branch-specific choices and persist those mappings for future reports',async()=>{
  const row=paidRow('UNPAID',40000,{paid_bank:'BRADESCO'}),p=await preview([row]);assert.equal(p.rows[0].outcome,'UNMAPPED_BANK');assert.equal(p.unmapped_banks.length,1);
  const key=p.unmapped_banks[0].key,mappings={[key]:bank};assert.equal((await preview([row],mappings)).can_commit,true);await paid([row],{mappings});
  const next=await preview([row]);assert.equal(next.unmapped_banks.length,0);assert.equal(next.rows[0].bank_account_id,bank);assert.equal(next.matched_payment_count,1);
  const t=await title('UNPAID');assert.equal(t.bank_account,'BRADESCO');const h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(h.rows[0].bank_account_id,bank);
 });
 await test('the same bank text in another branch cannot inherit an unrelated account mapping',async()=>{
  await forecast([forecastRow('BRANCH3',5000,{branch:'3 - TESTE'})]);const row=paidRow('BRANCH3',5000,{branch:'3 - TESTE',paid_bank:'BRADESCO'}),p=await preview([row]);assert.equal(p.unmapped_banks.length,1);
  assert.equal(p.rows[0].bank_account_id,null);const mappings={[p.unmapped_banks[0].key]:bank2};await paid([row],{mappings});assert.equal((await preview([row])).rows[0].bank_account_id,bank2);
 });
 await test('a manual receipt with a different effective macro remains a conflict rather than being silently reclassified',async()=>{
  const row=paidRow('MANUAL',30000,{plan:'NOVO PLANO TESTE'});const p=await preview([row]);assert.equal(p.rows[0].outcome,'CONFLICT');assert(p.errors.some(e=>e.column==='Centro de Custo Macro'));
  const old=await state();await expectPaidFailure([row],{confirm:true});assert.deepEqual(await state(),old);
 });
 await test('invalid paid fields, duplicate identities and forged role keys are rejected before writes',async()=>{
  const old=await state();for(const override of [{paid_on:null},{paid_bank:''},{amount_paid_cents:1.5},{source_status:'ABERTO'},{role:'admin'}]){
   await rejects('SELECT public.preview_payables_paid_import($1,$2)',['grupo-consolidado',JSON.stringify([paidRow('NEW',55000,override)])],'22023');
  }
  await rejects('SELECT public.preview_payables_paid_import($1,$2)',['grupo-consolidado',JSON.stringify([paidRow('NEW',55000),paidRow('NEW',55000)])],'P0016');assert.deepEqual(await state(),old);
 });
 await test('stale preview tokens and original-file integrity failures roll back the entire paid import',async()=>{
  const old=await state();await expectPaidFailure([paidRow('NEW',55000)],{expected:null},'40001');assert.deepEqual(await state(),old);
  await role('service_role');await rejects(paidSql,[uid(0),sid(0),'grupo-consolidado','integridade.csv','0'.repeat(64),file(999).toString('base64'),JSON.stringify([paidRow('NEW',55000)]),'{}',latestImport,false,'{}',null],'22023');await actor(0);assert.deepEqual(await state(),old);
 });
 await test('a manual change after preview invalidates the financial token; new paid commits cannot bypass the guard with null',async()=>{
  const row=paidRow('NEW',55000),p=await preview([row]),t=await title('NEW');
  await scalar('SELECT public.correct_payable_title($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r',[t.id,t.due_date,t.amount_cents,t.bank_account,t.description,t.issued_on,t.macro,'Cheque corrigido após análise',t.review_fingerprint,false,'009999',true]);
  const old=await state();await expectPaidFailure([row],{financialRevision:p.financial_revision},'40001');await expectPaidFailure([row],{financialRevision:null},'40001');assert.deepEqual(await state(),old);
 });
 await test('a failure late in the import audit reverts receipt, review, source metadata, file and mapping changes atomically',async()=>{
  const old=await state();await role('postgres');await db.exec("CREATE FUNCTION cf_private.test_paid_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='payable_import_modes' THEN RAISE EXCEPTION 'synthetic paid audit failure' USING ERRCODE='P0001';END IF;RETURN NEW;END$$;CREATE TRIGGER paid_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.test_paid_audit_failure()");await actor(0);
  await expectPaidFailure([paidRow('NEW',55000)],{},'P0001');assert.deepEqual(await state(),old);await role('postgres');await db.exec('DROP TRIGGER paid_audit_failure ON public.audit_events;DROP FUNCTION cf_private.test_paid_audit_failure()');await actor(0);
 });
 await test('paid-only imports retain original bytes and immutable provenance linking each file, full receipt and automatic review',async()=>{
  await role('postgres');const data=(await db.query("SELECT m.import_id,m.mode,r.outcome,r.review_id,r.payment_ids,encode(f.file_bytes,'base64') original FROM public.payable_import_modes m JOIN public.payable_paid_import_rows r ON r.import_id=m.import_id JOIN cf_private.payable_import_files f ON f.import_id=m.import_id WHERE m.mode='PAYMENTS' LIMIT 1")).rows;
  assert.equal(data.length,1);assert(data[0].review_id);assert(data[0].payment_ids.length>0);assert(Buffer.from(data[0].original,'base64').toString().startsWith('Relatório original sintético'));await actor(0);
 });
 await test('new mode history and mappings are read-only and immutable; regular clients cannot invoke service-only writes',async()=>{
  for(const table of['payable_import_modes','payable_paid_import_rows','payable_paid_bank_mappings']){await rejects(`DELETE FROM public.${table}`);await rejects(table==='payable_paid_import_rows'?`UPDATE public.${table} SET outcome=outcome`:`UPDATE public.${table} SET created_by=$1`,table==='payable_paid_import_rows'?[]:[uid(1)]);}
  const bytes=file(1000);await rejects(paidSql,[uid(0),sid(0),'grupo-consolidado','browser.csv',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify([paidRow('NEW',55000)]),'{}',latestImport,false,'{}',null]);
 });
 await test('Director, CR, RH and collectors cannot preview or write imports even through forged service actor identities',async()=>{
  for(const i of[1,3,4,5,6]){await actor(i);await rejects('SELECT public.preview_payables_paid_import($1,$2)',['grupo-consolidado',JSON.stringify([paidRow('NEW',55000)])]);await rejects('SELECT public.preview_payables_forecast_import($1,$2)',['grupo-consolidado',JSON.stringify([forecastRow('BADROLE',1)])]);await expectPaidFailure([paidRow('NEW',55000)],{identity:i},'42501');}
  await actor(0);
 });
 await test('revoked import sessions immediately lose preview and gateway-side financial authorization',async()=>{
  await role('postgres');await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[sid(2),uid(2)]);await actor(2);
  await rejects('SELECT public.preview_payables_paid_import($1,$2)',['grupo-consolidado',JSON.stringify([paidRow('NEW',55000)])]);await expectPaidFailure([paidRow('NEW',55000)],{identity:2},'42501');await actor(0);
 });
 await test('all automated actuals and forecast imports preserve the manually entered bank balances',async()=>{
  await role('postgres');assert.deepEqual(await rows('public.bank_balance_positions'),before['public.bank_balance_positions']);assert.deepEqual(await scalar('SELECT public.read_payable_month_closure($1) r',[oldClosure]),oldSnapshot);
 });
}catch(error){console.error('FAIL',error);process.exitCode=1;}finally{await db.close();}
console.log(`${passed} passed (synthetic local PostgreSQL, emulated Supabase identity)`);
