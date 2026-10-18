import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Disposable PostgreSQL: all identities, imports and transactions are synthetic.
const db=new PGlite();let passed=0,sequence=0,latestImport=null,today,yesterday,month,bank,bank2,initial,legacyArgs,legacyId,fullArgs,fullId;
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
 '014_payables_forecast.sql','015_payable_payments.sql','016_payable_identity_updates.sql','017_payable_month_closing.sql'];
const regSql='SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r';
const correctionSql='SELECT public.correct_payable_title($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r';
const title=async entry=>scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1',[entry]);
const rows=async table=>(await db.query(`SELECT to_jsonb(t) r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const revision=()=>scalar('SELECT public.get_payables_revision() r');
const state=async()=>({revision:await revision(),payments:await rows('public.payable_payments'),reversals:await rows('public.payable_payment_reversals'),audit:await rows('public.audit_events')});
const args=(t,cents,account=bank)=>[t.id,cents,yesterday,account,'Comprovante integral sintético',t.payment_revision,randomUUID(),t.last_import_id];
const correct=async(t,amount)=>scalar(correctionSql,[t.id,t.due_date,amount,t.bank_account,t.description,t.issued_on,t.macro,'Correção sintética autorizada',t.review_fingerprint,false]);
const review=async t=>scalar('SELECT public.review_payable_title($1,$2,$3) r',[t.id,'Título integralmente pago e conferido',t.review_fingerprint]);
const fixture=(entry_number,amount_cents,extra={})=>({entry_number,amount_cents,plan:'DESPESA TESTE',description:'Fornecedor sintético',branch:'2 - TESTE',due_date:today,issued_on:yesterday,source_status:'ABERTO',bank_account:'ORIGEM SINTÉTICA',...extra});
const gateway=async list=>{
 const bytes=Buffer.from(`Relatório completo sintético ${++sequence}`);await role('service_role');
 const out=await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,$9) r',[
  uid(0),sid(0),'grupo-consolidado',`teste-${sequence}.csv`,createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(list),JSON.stringify({'DESPESA TESTE':'FIXO'}),latestImport]);
 latestImport=out.import_id;await actor(0);return out;
};
const bootstrap=`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`;

try{
 await db.exec(bootstrap);for(const name of names)await db.exec(await sqlFile(name));
 for(const[i,name]of roles.entries()){
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(i),`full-payment-${i}@example.invalid`]);
  await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[uid(i),`FullPayment${i}`,`Pessoa sintética ${i}`,name]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(i),uid(i)]);
 }
 const d=(await db.query(`SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,
  ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text yesterday,
  date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS "month"`)).rows[0];
 ({today,yesterday,month}=d);await actor(0);
 [bank,bank2]=(await db.query('SELECT id FROM public.bank_accounts WHERE enabled ORDER BY display_name LIMIT 2')).rows.map(r=>r.id);
 await scalar("SELECT public.set_bank_balance($1,$2,87654,'Saldo sintético anterior',null) r",[bank,today]);
 initial=[fixture('NOVO',10000),fixture('ANTIGO',20000),fixture('AUSENTE',30000),fixture('JA-PAGO',40000)];await gateway(initial);
 legacyArgs=args(await title('ANTIGO'),5000);legacyId=await scalar(regSql,legacyArgs);
 await scalar(regSql,args(await title('JA-PAGO'),40000));await review(await title('JA-PAGO'));
 await gateway(initial.filter(r=>r.entry_number!=='AUSENTE'));await role('postgres');
 const tables=['public.profiles','public.payable_titles','public.payable_imports','cf_private.payable_import_files','public.bank_accounts','public.bank_balance_positions',
  'public.payable_payments','public.payable_payment_reversals','public.payable_title_reviews','public.payable_month_closures','public.audit_events',
  'cf_private.payable_payment_state','cf_private.payable_control_state','public.payable_title_control_revisions'];
 const before=Object.fromEntries(await Promise.all(tables.map(async t=>[t,await rows(t)])));await db.exec(await sqlFile('018_payable_full_payment.sql'));
 await test('incremental full-payment rule preserves historical partial and complete payments, reviews, banks and audits byte for byte',async()=>{
  for(const t of tables)assert.deepEqual(await rows(t),before[t],t);
  assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='018_payable_full_payment'"),1);
 });await actor(0);
 await test('direct API rejects a partial amount even one cent short, plus overpayment and invalid amounts without financial side effects',async()=>{
  const t=await title('NOVO'),old=await state();
  for(const amount of [1,9999,10001,0,-1,9007199254740992])await rejects(regSql,args(t,amount),'22023');
  await rejects(regSql,args(t,'1.5'),'22P02');assert.deepEqual(await state(),old);assert.equal((await title('NOVO')).paid_cents,0);
 });
 await test('CP can register exactly one integral payment with actual date, official chosen bank and original macro',async()=>{
  await actor(2);const t=await title('NOVO');fullArgs=args(t,10000,bank2);fullId=await scalar(regSql,fullArgs);
  const after=await title('NOVO');assert.equal(after.financial_status,'PAID');assert.equal(after.paid_cents,10000);assert.equal(after.payment_remaining_cents,0);
  const h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(h.rows.length,1);
  assert.equal(h.rows[0].amount_cents,10000);assert.equal(h.rows[0].paid_on,yesterday);assert.equal(h.rows[0].bank_account_id,bank2);assert.equal(h.rows[0].macro_snapshot,'FIXO');
 });
 await test('lost-response retry returns the same integral payment before enforcing the now-zero remaining balance',async()=>{
  const old=await state();assert.equal(await scalar(regSql,fullArgs),fullId);assert.deepEqual(await state(),old);
  const changed=[...fullArgs];changed[1]=9999;await rejects(regSql,changed,'22023');assert.deepEqual(await state(),old);
 });
 await test('new requests cannot pay an already fully paid title again, regardless of amount or request identifier',async()=>{
  const t=await title('NOVO'),old=await state();await rejects(regSql,args(t,10000),'22023');await rejects(regSql,args(t,1),'22023');assert.deepEqual(await state(),old);
  await actor(0);await rejects(regSql,args(await title('JA-PAGO'),40000),'22023');
 });
 await test('legacy partial record is retained and its original uncertain-result request remains idempotently confirmable',async()=>{
  const t=await title('ANTIGO');assert.equal(t.financial_status,'PARTIAL');assert.equal(t.paid_cents,5000);assert.equal(t.payment_remaining_cents,15000);
  const old=await state();assert.equal(await scalar(regSql,legacyArgs),legacyId);assert.deepEqual(await state(),old);
 });
 await test('a legacy partial balance accepts only its exact integral completion, never another partial receipt',async()=>{
  const t=await title('ANTIGO'),old=await state();await rejects(regSql,args(t,14999),'22023');await rejects(regSql,args(t,5000),'22023');assert.deepEqual(await state(),old);
  await scalar(regSql,args(t,15000));const after=await title('ANTIGO');assert.equal(after.financial_status,'PAID');assert.equal(after.paid_cents,20000);
  const h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(h.rows.length,2);assert(h.rows.some(p=>p.id===legacyId&&p.amount_cents===5000));
 });
 await test('source disappearance never creates realized payment but still permits one explicit exact integral reconciliation',async()=>{
  const t=await title('AUSENTE');assert.equal(t.status,'SETTLED_IMPORT');assert.equal(t.financial_status,'PENDING_RECONCILIATION');assert.equal(t.paid_cents,0);
  await rejects(regSql,args(t,29999),'22023');await scalar(regSql,args(t,30000));const after=await title('AUSENTE');assert.equal(after.financial_status,'PAID');assert.equal(after.status,'SETTLED_IMPORT');
 });
 await test('stale nominal or macro correction tokens still refuse a payment, and an incorrect nominal must be corrected first',async()=>{
  const t=await title('NOVO');await correct(t,12000);const current=await title('NOVO');assert.equal(current.payment_remaining_cents,2000);
  await rejects(regSql,[t.id,2000,yesterday,bank,'Confirmação antiga',t.payment_revision,randomUUID(),t.last_import_id],'40001');
  await rejects(regSql,args(current,1999),'22023');await correct(current,10000);assert.equal((await title('NOVO')).financial_status,'PAID');
 });
 await test('overpaid differences cannot be hidden by another payment or marked reconciled until corrected',async()=>{
  await correct(await title('ANTIGO'),19999);let t=await title('ANTIGO');assert.equal(t.financial_status,'OVERPAID');assert.equal(t.overpaid_cents,1);
  await rejects(regSql,args(t,1),'22023');await rejects('SELECT public.review_payable_title($1,$2,$3)',[t.id,'Não ajustar silenciosamente',t.review_fingerprint],'22023');
  await correct(t,20000);t=await title('ANTIGO');assert.equal(t.financial_status,'PAID');await review(t);
 });
 let closure;
 await test('exact integral payments remain compatible with explicit review, closing and immutable monthly reports',async()=>{
  for(const entry of ['NOVO','AUSENTE'])await review(await title(entry));const s=await scalar('SELECT public.payables_month_status($1) r',[month]);assert.equal(s.pending_count,0);assert.equal(s.can_close,true);
  closure=await scalar('SELECT public.close_payables_month($1,$2,$3) r',[month,'Fechamento integral sintético',s.revision]);
  const report=await scalar('SELECT public.read_payable_month_closure($1) r',[closure]);assert.equal(report.total_titles,4);assert.equal(report.total_paid_cents,100000);
  assert(report.snapshot.titles.every(t=>t.financial_status==='PAID'&&t.review_status==='CONCILIADO'));
 });
 await test('director reads completed reports but cannot register payments even with a forged admin role',async()=>{
  await actor(1);assert.equal((await scalar('SELECT public.read_payable_month_closure($1) r',[closure])).id,closure);
  await rejects(regSql,fullArgs);await actor(0);
 });
 await test('CR, RH, collectors, anonymous and service roles cannot bypass the full-payment API authorization',async()=>{
  for(const i of [3,4,5,6]){await actor(i);await rejects(regSql,fullArgs);assert.equal((await db.query('SELECT * FROM public.payable_payments')).rows.length,0);}
  for(const r of ['anon','service_role']){await role(r);await rejects(regSql,fullArgs);}await actor(0);
 });
 await test('revoked CP sessions cannot confirm even an earlier valid idempotent payment request',async()=>{
  await role('postgres');await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[sid(2),uid(2)]);await actor(2);await rejects(regSql,fullArgs);await actor(0);
 });
 await test('bank balances remain exactly as entered, and all active realized amounts retain actual paid dates',async()=>{
  const s=await scalar('SELECT public.payable_payment_summary($1,$1) r',[yesterday]);assert.equal(s.total_paid_cents,100000);
  await role('postgres');assert.deepEqual(await rows('public.bank_balance_positions'),before['public.bank_balance_positions']);
  const original=(await db.query('SELECT amount_cents FROM public.payable_payments WHERE id=$1',[legacyId])).rows[0];assert.equal(Number(original.amount_cents),5000);
 });
}catch(error){console.error('FAIL',error);process.exitCode=1;}finally{await db.close();}
console.log(`${passed} passed (synthetic local PostgreSQL, emulated Supabase identity)`);
