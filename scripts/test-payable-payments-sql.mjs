import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Disposable PostgreSQL: all identities, balances, invoices and files are synthetic.
const db=new PGlite();
const roles=['gerente_geral','diretor','contas_pagar','contas_receber','rh_dp','cobradora_1','cobradora_2'];
const uid=i=>`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const sid=i=>`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].r;
const role=async name=>{await db.exec('RESET ROLE');await db.exec(`SET ROLE ${name}`);};
const actor=async i=>{await role('postgres');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
  [uid(i),JSON.stringify({session_id:sid(i),role:'admin'})]);await role('authenticated');};
const rejects=async(sql,args=[],code='42501')=>assert.rejects(db.query(sql,args),e=>{assert.equal(e.code,code,e.message);return true;});
const sqlFile=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const names=['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql',
  '007_director_positions.sql','008_receivables.sql','009_collections.sql','010_bank_import.sql','011_receivables_positions.sql',
  '012_treasury_accounts.sql','013_director_report.sql','014_payables_forecast.sql'];
const regSql='SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) AS r';
const cancelSql='SELECT public.cancel_payable_payment($1,$2,$3) AS r';
const listSql='SELECT public.list_payable_payments($1,$2,$3,$4,$5,$6,$7) AS r';
let today,yesterday,due,bank,bank2,latestImport=null,sequence=0,passed=0;
const test=async(name,run)=>{await run();passed++;console.log('PASS',name);};
const fixture=(entry_number,amount_cents,plan='ORDINARIO TESTE',extra={})=>({entry_number,amount_cents,plan,
  description:'Fornecedor sintético',branch:'2 - TESTE',due_date:due,issued_on:yesterday,source_status:'ABERTO',...extra});
const gateway=async rows=>{
  const bytes=Buffer.from(`Relatório completo sintético ${++sequence}`);await role('service_role');
  const out=await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,$9) AS r',[
    uid(0),sid(0),'grupo-consolidado',`teste-${sequence}.csv`,createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),
    JSON.stringify(rows),JSON.stringify(Object.fromEntries(rows.map(r=>[r.plan,r.plan.includes('MERCADORIA')?'COMPRA DE MERCADORIA':r.plan.includes('SALARIO')?'SALÁRIOS':'VARIÁVEL']))),latestImport]);
  latestImport=out.import_id;await actor(0);return out;
};
const title=async entry=>(await db.query('SELECT to_jsonb(t) r FROM public.payable_financial_titles t WHERE entry_number=$1',[entry])).rows[0].r;
const args=(t,amount,date=yesterday,account=bank,request=randomUUID())=>[t.id,amount,date,account,'Comprovante sintético conferido',t.payment_revision,request,t.last_import_id];
const pay=async(t,amount,date=yesterday,account=bank)=>scalar(regSql,args(t,amount,date,account));
const summary=(start=yesterday,end=start)=>scalar('SELECT public.payable_payment_summary($1,$2) AS r',[start,end]);
const cp=()=>scalar('SELECT public.payables_summary($1,$1) AS r',[due]);
const revision=()=>scalar('SELECT public.get_payables_revision() AS r');
const rows=async table=>(await db.query(`SELECT to_jsonb(t) r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const state=async()=>({payments:await rows('public.payable_payments'),reversals:await rows('public.payable_payment_reversals'),audit:await rows('public.audit_events'),revision:await revision()});
const bootstrap=`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`;

try{
 await db.exec(bootstrap);for(const name of names)await db.exec(await sqlFile(name));
 for(const[i,name]of roles.entries()){
   await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(i),`payments-${i}@example.invalid`]);
   await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[uid(i),`Payment${i}`,`Pessoa sintética ${i}`,name]);
   await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(i),uid(i)]);
 }
 const dates=(await db.query(`SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,
   ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text yesterday,
   ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+3)::text due`)).rows[0];
 ({today,yesterday,due}=dates);await actor(0);
 [bank,bank2]=(await db.query('SELECT id FROM public.bank_accounts WHERE enabled ORDER BY display_name LIMIT 2')).rows.map(r=>r.id);
 await scalar("SELECT public.set_bank_balance($1,$2,98765,'Posição anterior sintética',null) AS r",[bank,today]);
 await scalar("SELECT public.save_manual_stock(65432,$1,'Estoque sintético anterior') AS r",[today]);
 const initial=[fixture('PAGAMENTO',10000),fixture('CHEQUE',20000,'ORDINARIO TESTE',{source_status:'CHEQUE'}),fixture('MERCADORIA',30000,'MERCADORIA TESTE')];
 await gateway(initial);await scalar('SELECT public.save_director_position($1,$1) AS r',[today]);
 await role('postgres');
 const protectedTables=['public.profiles','public.payable_imports','public.payable_titles','cf_private.payable_import_files',
   'public.bank_accounts','public.bank_balance_positions','public.stock_positions','public.director_positions','public.audit_events'];
 const before=Object.fromEntries(await Promise.all(protectedTables.map(async t=>[t,await rows(t)])));
 await db.exec(await sqlFile('015_payable_payments.sql'));
 await test('incremental ledger activation preserves every existing financial, audit, import, user and snapshot row',async()=>{
   for(const table of protectedTables)assert.deepEqual(await rows(table),before[table],table);
   assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='015_payable_payments'"),1);
 });
 await actor(0);
 await test('no payment is fabricated from nominal values, cheque status or automatic import settlement',async()=>{
   assert.equal((await summary()).total_paid_cents,0);assert.equal((await summary()).payment_count,0);
   assert.equal((await title('CHEQUE')).financial_status,'OPEN');
   await gateway(initial.slice(0,2));const t=await title('MERCADORIA');
   assert.equal(t.status,'SETTLED_IMPORT');assert.equal(t.financial_status,'PENDING_RECONCILIATION');
   assert.equal(t.paid_cents,0);assert.equal(t.outstanding_cents,0);assert.equal(t.payment_remaining_cents,30000);
   assert.equal((await summary()).pending_reconciliation_count,1);
   assert.equal((await summary()).total_paid_cents,0);
 });
 let payment1,payment2,firstArgs;
 await test('partial payment records actual prior-day date, chosen bank and macro without changing the imported source',async()=>{
   await actor(2);const t=await title('PAGAMENTO');firstArgs=args(t,3501);payment1=await scalar(regSql,firstArgs);
   const next=await title('PAGAMENTO');assert.equal(next.paid_cents,3501);assert.equal(next.outstanding_cents,6499);
   assert.equal(next.payment_remaining_cents,6499);assert.equal(next.financial_status,'PARTIAL');
   assert.equal(next.amount_cents,10000);assert.equal(next.status,t.status);assert.equal(next.due_date,due);
   assert.equal(next.last_payment_date,yesterday);assert.equal(next.payment_revision,payment1);
   const row=(await db.query('SELECT to_jsonb(p) r FROM public.payable_payments p WHERE id=$1',[payment1])).rows[0].r;
   assert.equal(row.paid_on,yesterday);assert.equal(row.created_by,uid(2));assert.equal(row.bank_account_id,bank);
   assert.equal(await scalar("SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text r FROM public.payable_payments WHERE id=$1",[payment1]),today);
   assert.equal(row.macro_snapshot,'VARIÁVEL');assert.equal(row.title_amount_cents,10000);assert.equal(row.due_date,due);
   const real=await summary();assert.equal(real.total_paid_cents,3501);assert.equal(real.payment_count,1);
   assert.equal(real.by_macro.find(m=>m.macro==='VARIÁVEL').amount_cents,3501);
   assert.equal((await summary(due)).total_paid_cents,0);assert.equal((await summary(today)).total_paid_cents,0);
 });
 await test('repeating an identical request is idempotent even after successful response loss',async()=>{
   const old=await state();assert.equal(await scalar(regSql,firstArgs),payment1);assert.deepEqual(await state(),old);
   await rejects(regSql,[...firstArgs.slice(0,1),3502,...firstArgs.slice(2)],'22023');assert.deepEqual(await state(),old);
   await actor(0);await rejects(regSql,firstArgs,'22023');await actor(2);
 });
 await test('invalid amount, future or absent date, unknown bank, missing observation and overpayment reject atomically',async()=>{
   const t=await title('PAGAMENTO'),old=await state(),valid=args(t,100);
   for(const amount of [0,-1,6500,9007199254740992])await rejects(regSql,[t.id,amount,...valid.slice(2)],'22023');
   await rejects(regSql,[t.id,'1.5',...valid.slice(2)],'22P02');
   for(const date of [null,'1899-12-31','9999-12-31']){const a=[...valid];a[2]=date;await rejects(regSql,a,'22023');}
   const absent=[...valid];absent[3]=randomUUID();await rejects(regSql,absent,'22023');
   const noReason=[...valid];noReason[4]=' ';await rejects(regSql,noReason,'22023');
   assert.deepEqual(await state(),old);
 });
 await test('stale payment and import revisions refuse a second financial change',async()=>{
   const t=await title('PAGAMENTO'),old=await state(),valid=args(t,100);
   const stale=[...valid];stale[5]=null;await rejects(regSql,stale,'40001');
   const staleImport=[...valid];staleImport[7]=randomUUID();await rejects(regSql,staleImport,'40001');
   assert.deepEqual(await state(),old);
 });
 await test('a second payment on another day and bank completes only the remaining nominal amount',async()=>{
   payment2=await pay(await title('PAGAMENTO'),6499,today,bank2);
   const t=await title('PAGAMENTO');assert.equal(t.financial_status,'PAID');assert.equal(t.paid_cents,10000);assert.equal(t.outstanding_cents,0);
   assert.equal(t.payment_remaining_cents,0);assert.equal(t.payment_revision,payment2);assert.equal(t.last_payment_date,today);
   assert.equal((await summary(today)).total_paid_cents,6499);assert.equal((await summary(yesterday,today)).total_paid_cents,10000);
   await rejects(regSql,args(t,1),'22023');assert.equal((await cp()).open_cents,20000);
 });
 await test('normal daily reimport preserves ledger, amounts realized and completed state',async()=>{
   await role('postgres');const old=await rows('public.payable_payments');await gateway(initial);
   assert.deepEqual(await rows('public.payable_payments'),old);const t=await title('PAGAMENTO');
   assert.equal(t.status,'OPEN');assert.equal(t.financial_status,'PAID');assert.equal(t.paid_cents,10000);assert.equal(t.outstanding_cents,0);
   assert.equal((await summary(yesterday,today)).total_paid_cents,10000);
 });
 await test('source absence after partial payment retains the unpaid remainder instead of marking it paid',async()=>{
   const t=await title('CHEQUE');await pay(t,7000);await gateway([fixture('PAGAMENTO',10000),fixture('MERCADORIA',30000,'MERCADORIA TESTE')]);
   const next=await title('CHEQUE');assert.equal(next.status,'SETTLED_IMPORT');assert.equal(next.financial_status,'PARTIAL');
   assert.equal(next.paid_cents,7000);assert.equal(next.outstanding_cents,13000);assert.equal(next.payment_remaining_cents,13000);
   assert.equal((await cp()).open_cents,43000);
 });
 await test('financial forecast and cheques subtotal include only the remaining amount, once',async()=>{
   const f=await scalar('SELECT public.payables_forecast() AS r');const w=f.weeks.find(w=>due>=w.start&&due<=w.end);
   assert(w);assert.equal(w.real_cents,43000);assert.equal(w.cheques_cents,13000);assert.equal(w.cheque_count,1);assert.equal(w.title_count,2);
   assert.equal(w.macros.find(m=>m.macro==='VARIÁVEL').real_cents,13000);
 });
 await test('salary provision offset stays nominal after partial payment; only real weekly cash obligation decreases',async()=>{
   const oldImport=latestImport;await role('postgres');await db.exec('BEGIN');
   try{
     const salaryDate=await scalar("SELECT (date_trunc('month',$1::date)+interval '1 month 4 days')::date::text r",[today]);
     await gateway([...initial,fixture('SALARIO',50000,'SALARIO TESTE',{due_date:salaryDate})]);
     await scalar("SELECT public.map_payable_forecast_plan('SALARIO TESTE','SALARIOS',$1,'Vínculo sintético',null) r",[today]);
     const a=await scalar('SELECT public.payables_forecast() r');
     const beforeP=a.weeks.flatMap(w=>w.provisions).find(p=>p.rule_key==='SALARIOS'&&p.due_date===salaryDate);
     assert(beforeP);assert.equal(beforeP.actual_cents,50000);assert.equal(beforeP.remaining_cents,4550000);
     const beforeW=a.weeks.find(w=>salaryDate>=w.start&&salaryDate<=w.end);
     await pay(await title('SALARIO'),1001);
     const b=await scalar('SELECT public.payables_forecast() r');
     const afterP=b.weeks.flatMap(w=>w.provisions).find(p=>p.rule_key==='SALARIOS'&&p.due_date===salaryDate);
     const afterW=b.weeks.find(w=>salaryDate>=w.start&&salaryDate<=w.end);
     assert.equal(afterP.actual_cents,50000);assert.equal(afterP.remaining_cents,4550000);
     assert.equal(beforeW.real_cents-afterW.real_cents,1001);
   }finally{await role('postgres');await db.exec('ROLLBACK');latestImport=oldImport;await actor(0);}
 });
 await test('director merchandise obligation follows actual remaining balance while saved snapshots remain untouched',async()=>{
   await actor(0);await pay(await title('MERCADORIA'),12345);
   const report=await scalar('SELECT public.director_report($1,$1) AS r',[today]);assert.equal(report.indicators.merchandise_cents,17655);
   await role('postgres');assert.deepEqual(await rows('public.director_positions'),before['public.director_positions']);
   assert.deepEqual(await rows('public.bank_balance_positions'),before['public.bank_balance_positions']);
   await actor(0);
 });
 await test('macro and bank display changes never recalculate historical realized classification',async()=>{
   const t=await title('MERCADORIA');await role('postgres');
   await db.query("UPDATE public.payable_titles SET macro='FIXO' WHERE id=$1",[t.id]);
   await db.query("UPDATE public.bank_accounts SET display_name='BANCO RENOMEADO SINTÉTICO' WHERE id=$1",[bank]);
   await actor(0);const s=await summary();assert.equal(s.by_macro.find(m=>m.macro==='COMPRA DE MERCADORIA').amount_cents,12345);
   assert.equal(s.by_macro.find(m=>m.macro==='FIXO').amount_cents,0);
   const history=await scalar(listSql,[null,null,0,25,t.id,null,null]);assert.equal(history.rows[0].macro_snapshot,'COMPRA DE MERCADORIA');
   assert.notEqual(history.rows[0].bank_label,'BANCO RENOMEADO SINTÉTICO');
 });
 let reversal;
 await test('cancellation appends a reasoned reversal, removes realized value, and restores only the corresponding balance',async()=>{
   const t=await title('PAGAMENTO');await rejects(cancelSql,[payment2,' ',t.payment_revision],'22023');
   await rejects(cancelSql,[payment2,'Conferência sintética',payment1],'40001');
   reversal=await scalar(cancelSql,[payment2,'Comprovante sintético duplicado',t.payment_revision]);
   const next=await title('PAGAMENTO');assert.equal(next.payment_revision,reversal);assert.equal(next.financial_status,'PARTIAL');
   assert.equal(next.paid_cents,3501);assert.equal(next.outstanding_cents,6499);assert.equal((await summary(today)).total_paid_cents,0);
   const old=await state();assert.equal(await scalar(cancelSql,[payment2,'Comprovante sintético duplicado',t.payment_revision]),reversal);
   assert.deepEqual(await state(),old);
 });
 await test('title history includes cancelled originals with author, reason and date; daily realized excludes them',async()=>{
   const t=await title('PAGAMENTO');const h=await scalar(listSql,[null,null,0,25,t.id,null,null]);assert.equal(h.count,2);
   const c=h.rows.find(r=>r.id===payment2);assert.equal(c.status,'CANCELLED');assert.equal(c.cancellation_id,reversal);
   assert.equal(c.cancellation_observation,'Comprovante sintético duplicado');assert.equal(c.cancelled_by,uid(0));assert(c.cancelled_at);
   assert(c.created_by_name);assert(c.created_by_username);assert(c.cancelled_by_name);
   const all=await scalar(listSql,[yesterday,today,0,500,null,null,null]);assert(!all.rows.some(r=>r.id===payment2));
   const page=await scalar(listSql,[null,null,0,1,t.id,null,null]);assert.equal(page.rows.length,1);assert.equal(page.count,2);
   const next=await scalar(listSql,[null,null,1,1,t.id,null,null]);assert.equal(next.rows.length,1);assert.notEqual(page.rows[0].id,next.rows[0].id);
   await rejects(listSql,[null,null,0,25,null,null,null],'22023');
 });
 await test('reversing all registered payments for an absent source restores pending reconciliation without inventing outstanding cash',async()=>{
   await role('postgres');await db.exec('BEGIN');
   try{
     await actor(0);const t=await title('CHEQUE');assert.equal(t.status,'SETTLED_IMPORT');assert.equal(t.financial_status,'PARTIAL');
     const history=await scalar(listSql,[null,null,0,25,t.id,null,null]);const p=history.rows.find(p=>p.status==='ACTIVE');
     await scalar(cancelSql,[p.id,'Pagamento não confirmado na conciliação sintética',t.payment_revision]);
     const next=await title('CHEQUE');assert.equal(next.financial_status,'PENDING_RECONCILIATION');
     assert.equal(next.paid_cents,0);assert.equal(next.outstanding_cents,0);assert.equal(next.payment_remaining_cents,20000);
   }finally{await role('postgres');await db.exec('ROLLBACK');await actor(0);}
 });
 await test('ledger and reversal history reject direct UPDATE, DELETE and INSERT, even for manager',async()=>{
   for(const table of ['payable_payments','payable_payment_reversals']){
     await rejects(`UPDATE public.${table} SET observation='Alterar história'`);
     await rejects(`DELETE FROM public.${table}`);
   }
   await rejects('INSERT INTO public.payable_payment_reversals(payment_id,event_revision,observation,created_by) VALUES($1,999,$2,$3)',[payment1,'Manual',uid(0)]);
   await role('postgres');for(const table of ['payable_payments','payable_payment_reversals']){
     await rejects(`UPDATE public.${table} SET observation='Alterar história'`);await rejects(`DELETE FROM public.${table}`);
   }await actor(0);
 });
 await test('imported nominal amount corrections retain actual payments and explicitly expose overpaid differences',async()=>{
   const t=await title('PAGAMENTO');await role('postgres');await db.query('UPDATE public.payable_titles SET amount_cents=3000 WHERE id=$1',[t.id]);
   await actor(0);const next=await title('PAGAMENTO');assert.equal(next.financial_status,'OVERPAID');assert.equal(next.paid_cents,3501);
   assert.equal(next.overpaid_cents,501);assert.equal(next.outstanding_cents,0);assert.equal(next.payment_remaining_cents,0);
   await rejects(regSql,args(next,1),'22023');assert.equal((await summary()).total_paid_cents,22846);
   await role('postgres');await db.query('UPDATE public.payable_titles SET amount_cents=10000 WHERE id=$1',[t.id]);await actor(0);
 });
 await test('central audit records financial validation and reversal with official actor and preserved values',async()=>{
   await role('postgres');const events=(await db.query("SELECT * FROM public.audit_events WHERE entity IN ('payable_payments','payable_payment_reversals') ORDER BY occurred_at")).rows;
   const created=events.find(e=>e.record_id===payment1),cancelled=events.find(e=>e.record_id===reversal);
   assert.equal(created.action,'VALIDATE');assert.equal(created.user_id,uid(2));assert.equal(created.role_key,'contas_pagar');
   assert.equal(created.after_value.amount_cents,3501);assert.equal(created.after_value.paid_on,yesterday);
   assert.equal(cancelled.action,'REOPEN');assert.equal(cancelled.before_value.id,payment2);assert.equal(cancelled.after_value.payment_id,payment2);
   assert.equal(cancelled.role_key,'gerente_geral');await actor(0);
 });
 await test('disabled official accounts cannot receive new payments and configuration never exposes balances',async()=>{
   const accounts=await scalar('SELECT public.get_payable_payment_accounts() AS r');assert.equal(accounts.length,17);
   assert(accounts.some(a=>a.account_type==='CASH'));assert(accounts.every(a=>!('balance' in a)&&!('amount_cents' in a)));
   await role('postgres');await db.query('UPDATE public.bank_accounts SET enabled=false WHERE id=$1',[bank2]);await actor(0);
   await rejects(regSql,args(await title('PAGAMENTO'),100,yesterday,bank2),'22023');
   assert.equal((await scalar('SELECT public.get_payable_payment_accounts() AS r')).length,16);
   await role('postgres');await db.query('UPDATE public.bank_accounts SET enabled=true WHERE id=$1',[bank2]);await actor(0);
 });
 await test('failed audit rolls back payment, revision and realized amount in the same transaction',async()=>{
   const t=await title('PAGAMENTO'),old=await state();await role('postgres');
   await db.exec("CREATE FUNCTION cf_private.test_reject_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='payable_payments' THEN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE='P0001'; END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.test_reject_payment_audit()");
   await actor(0);await rejects(regSql,args(t,1),'P0001');assert.deepEqual(await state(),old);
   await role('postgres');await db.exec('DROP TRIGGER synthetic_audit_failure ON public.audit_events;DROP FUNCTION cf_private.test_reject_payment_audit()');await actor(0);
 });
 await test('director reads realized values and history but cannot register or reverse despite forged role',async()=>{
   await actor(1);assert((await summary()).total_paid_cents>0);assert((await title('PAGAMENTO')).id);
   assert.equal((await scalar('SELECT public.get_payable_payment_accounts() AS r')).length,17);
   await rejects(regSql,args(await title('PAGAMENTO'),1));await rejects(cancelSql,[payment1,'Tentativa do diretor',reversal]);
 });
 await test('CR, RH and each collector cannot read title/payment histories or execute reconciliation RPCs',async()=>{
   for(const i of [3,4,5,6]){await actor(i);
     for(const table of ['payable_financial_titles','payable_payments','payable_payment_reversals'])assert.equal((await db.query(`SELECT * FROM public.${table}`)).rows.length,0);
     for(const sql of ['SELECT public.get_payables_revision()','SELECT public.get_payable_payment_accounts()',"SELECT public.payable_payment_summary('2020-01-01','2020-01-01')",'SELECT public.list_payable_payments(null,null,0,25,$1)'])
       await rejects(sql,sql.includes('$1')?[payment1]:[]);
     await rejects(regSql,firstArgs);await rejects(cancelSql,[payment1,'Tentativa indevida',reversal]);
   }
 });
 await test('missing CP write permission immediately prevents new finance mutations for otherwise active manager',async()=>{
   await role('postgres');await db.exec("DELETE FROM public.role_permissions WHERE role_key='gerente_geral' AND resource='contas_pagar' AND action='write'");
   await actor(0);await rejects(regSql,args(await title('PAGAMENTO'),1));
   await role('postgres');await db.exec("INSERT INTO public.role_permissions VALUES('gerente_geral','contas_pagar','write')");await actor(0);
 });
 await test('revoked and expired sessions immediately lose both ledger RLS and public RPC access',async()=>{
   await role('postgres');await db.query('UPDATE cf_private.approved_sessions SET expires_at=now()-interval \'1 second\' WHERE user_id=$1',[uid(2)]);
   await actor(2);assert.equal((await db.query('SELECT * FROM public.payable_payments')).rows.length,0);await rejects('SELECT public.get_payables_revision()');
   await role('postgres');await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[sid(1),uid(1)]);
   await actor(1);await rejects('SELECT public.get_payable_payment_accounts()');
 });
 await test('anonymous and service browser roles have no direct ledger, view or financial endpoint grants',async()=>{
   for(const name of ['anon','service_role']){await role(name);for(const table of ['payable_financial_titles','payable_payments','payable_payment_reversals'])await rejects(`SELECT * FROM public.${table}`);
     await rejects('SELECT public.get_payables_revision()');await rejects('SELECT public.get_payable_payment_accounts()');await rejects(regSql,firstArgs);
   }
 });
 await test('exact large cent values survive native integer storage and global aggregate overflow is refused',async()=>{
   await actor(0);await gateway([fixture('LIMITE',9007199254740991)]);
   const old=await state();await rejects(regSql,args(await title('LIMITE'),9007199254740991),'22003');assert.deepEqual(await state(),old);
   const previous=(await summary(yesterday,today)).total_paid_cents;
   const exact=9007199254740991-previous;assert(Number.isSafeInteger(exact));
   await pay(await title('LIMITE'),exact);assert.equal((await title('LIMITE')).paid_cents,exact);
   assert.equal((await summary(yesterday,today)).total_paid_cents,9007199254740991);
   await role('postgres');assert.deepEqual(await rows('public.bank_balance_positions'),before['public.bank_balance_positions']);
   assert.deepEqual(await rows('public.stock_positions'),before['public.stock_positions']);
 });
}catch(error){console.error('FAIL',error);process.exitCode=1;}
finally{await db.close();}
console.log(`${passed} passed (synthetic local PostgreSQL, emulated Supabase identity)`);
