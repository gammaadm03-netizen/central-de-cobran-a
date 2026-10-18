import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Disposable PostgreSQL; every file, account, invoice and person is synthetic.
const db=new PGlite();let passed=0,sequence=0,latestImport=null,today,month,nextMonth,nextDue,bank,initial,oldClosure,oldSnapshot;
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
 '014_payables_forecast.sql','015_payable_payments.sql','016_payable_identity_updates.sql','017_payable_month_closing.sql','018_payable_full_payment.sql'];
const regSql='SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r';
const correctionOld='SELECT public.correct_payable_title($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r';
const correctionNew='SELECT public.correct_payable_title($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r';
const title=async entry=>scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1',[entry]);
const rows=async(table,strip=false)=>(await db.query(`SELECT to_jsonb(t)${strip?"-'cheque_number'":''} r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const revision=()=>scalar('SELECT public.get_payables_revision() r');
const status=(m=month)=>scalar('SELECT public.payables_month_status($1) r',[m]);
const state=async()=>({revision:await revision(),titles:await rows('public.payable_titles'),payments:await rows('public.payable_payments'),audit:await rows('public.audit_events')});
const payArgs=(t,amount=t.payment_remaining_cents)=>[t.id,amount,today,bank,'Comprovante sintético',t.payment_revision,randomUUID(),t.last_import_id];
const review=async t=>scalar('SELECT public.review_payable_title($1,$2,$3) r',[t.id,'Conferência sintética integral',t.review_fingerprint]);
const close=async(m=month)=>scalar('SELECT public.close_payables_month($1,$2,$3) r',[m,'Fechamento sintético',(await status(m)).revision]);
const correctionArgs=(t,change={})=>[t.id,change.due_date??t.due_date,change.amount_cents??t.amount_cents,t.bank_account,change.description??t.description,t.issued_on,t.macro,'Correção sintética',t.review_fingerprint,false];
const cheque=async(t,value)=>scalar(correctionNew,[...correctionArgs(t),value,true]);
const fixture=(entry_number,amount_cents,extra={})=>({entry_number,amount_cents,plan:'DESPESA TESTE',description:'Fornecedor sintético',branch:'2 - TESTE',due_date:nextDue,issued_on:today,source_status:'CHEQUE',bank_account:'BANCO ORIGEM',...extra});
const fileBytes=n=>Buffer.from(`Relatório sintético completo ${n}`);
const gateway=async(list,duplicate=null)=>{
 const n=++sequence,bytes=duplicate===null?fileBytes(n):fileBytes(duplicate);await role('service_role');
 try{
  const out=await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,$9) r',[
   uid(0),sid(0),'grupo-consolidado',`teste-${n}.csv`,createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(list),JSON.stringify({'DESPESA TESTE':'FIXO'}),latestImport]);
  latestImport=out.import_id;return out;
 }finally{await actor(0);}
};
const bootstrap=`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`;

try{
 await db.exec(bootstrap);for(const name of names)await db.exec(await sqlFile(name));
 for(const[i,name]of roles.entries()){
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(i),`cheques-${i}@example.invalid`]);
  await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[uid(i),`Cheque${i}`,`Pessoa sintética ${i}`,name]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(i),uid(i)]);
 }
 const d=(await db.query(`SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,
 date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS "month",
 (date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')+interval '1 month')::date::text next,
 (date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')+interval '1 month 4 days')::date::text next_due`)).rows[0];
 today=d.today;month=d.month;nextMonth=d.next;nextDue=d.next_due;await actor(0);
 bank=(await db.query('SELECT id FROM public.bank_accounts WHERE enabled ORDER BY id LIMIT 1')).rows[0].id;
 await scalar("SELECT public.set_bank_balance($1,$2,98765,'Saldo sintético anterior',null) r",[bank,today]);
 initial=[fixture('ANTIGO',10000,{due_date:today}),fixture('CHEQUE-1',12000),fixture('CHEQUE-2',8000)];await gateway(initial);
 await scalar(regSql,payArgs(await title('ANTIGO')));await review(await title('ANTIGO'));oldClosure=await close();
 oldSnapshot=await scalar('SELECT public.read_payable_month_closure($1) r',[oldClosure]);const oldTitle=await title('ANTIGO');await role('postgres');
 const protectedTables=['public.profiles','public.payable_imports','cf_private.payable_import_files','public.bank_accounts','public.bank_balance_positions',
  'public.payable_title_reviews','public.payable_month_closures','public.payable_month_events','public.audit_events','public.payable_title_control_revisions'];
 const before=Object.fromEntries(await Promise.all(protectedTables.map(async t=>[t,await rows(t)])));
 const beforeTitles=await rows('public.payable_titles'),beforePayments=await rows('public.payable_payments');
 const viewNames=['payable_financial_titles','payable_review_titles','payable_effective_payments'];
 const columns=async name=>(await db.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',[`public.${name}`])).rows.map(r=>r.attname);
 const oldColumns=Object.fromEntries(await Promise.all(viewNames.map(async v=>[v,await columns(v)])));
 await db.exec(await sqlFile('019_payable_cheques.sql'));
 await test('incremental activation adds nullable fields without altering previous title values, payments, audits or closed positions',async()=>{
  for(const t of protectedTables)assert.deepEqual(await rows(t),before[t],t);
  assert.deepEqual(await rows('public.payable_titles',true),beforeTitles);assert.deepEqual(await rows('public.payable_payments',true),beforePayments);
  assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='019_payable_cheques'"),1);
 });await actor(0);
 await test('all three security-invoker views retain every previous column position and append cheque_number at the end',async()=>{
  for(const v of viewNames){assert.deepEqual(await columns(v),[...oldColumns[v],'cheque_number']);
   const options=await scalar('SELECT reloptions r FROM pg_class WHERE oid=$1::regclass',[`public.${v}`]);assert(options.includes('security_invoker=true'));}
 });
 await test('adding an unknown null cheque does not invalidate existing reviewed fingerprints or closed-month snapshots',async()=>{
  const t=await title('ANTIGO');assert.equal(t.cheque_number,null);assert.equal(t.review_fingerprint,oldTitle.review_fingerprint);assert.equal(t.review_status,'CONCILIADO');assert.equal((await status()).status,'CLOSED');
  assert.deepEqual(await scalar('SELECT public.read_payable_month_closure($1) r',[oldClosure]),oldSnapshot);
 });
 await test('capabilities are available only to officially authorized importers, never Director, RH or collectors',async()=>{
  assert.deepEqual(await scalar('SELECT public.payables_import_capabilities() r'),{schema_version:'019_payable_cheques',cheque_number:true});
  await actor(2);assert.equal((await scalar('SELECT public.payables_import_capabilities() r')).cheque_number,true);
  for(const i of [1,3,4,5,6]){await actor(i);await rejects('SELECT public.payables_import_capabilities()');}await actor(0);
 });
 await test('manual cheque correction preserves zeros, invalidates payment/review tokens and audits automatic month reopening',async()=>{
  const t=await title('ANTIGO');await cheque(t,' 000123 ');const next=await title('ANTIGO');assert.equal(next.cheque_number,'000123');
  assert.notEqual(next.review_fingerprint,t.review_fingerprint);assert.notEqual(next.payment_revision,t.payment_revision);assert.equal(next.review_status,'A_CONCILIAR');assert.equal((await status()).status,'OPEN');
  const events=(await db.query("SELECT * FROM public.payable_month_events WHERE action='REOPEN'")).rows;assert.equal(events.length,1);assert.equal(events[0].automatic,true);
  const history=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(history.rows[0].cheque_number,null);
  assert.deepEqual(await scalar('SELECT public.read_payable_month_closure($1) r',[oldClosure]),oldSnapshot);
 });
 await test('old ten-argument correction clients remain unambiguous and preserve the existing cheque',async()=>{
  const t=await title('ANTIGO');await scalar(correctionOld,correctionArgs(t,{description:'Favorecido corrigido'}));assert.equal((await title('ANTIGO')).cheque_number,'000123');
  const count=await scalar("SELECT count(*)::int r FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='correct_payable_title'");assert.equal(count,1);
 });
 await test('stale cheque corrections are rejected and partial payments remain forbidden under the current full-payment rule',async()=>{
  const t=await title('CHEQUE-1');await cheque(t,'000987');await rejects(correctionNew,[...correctionArgs(t),'000999',true],'40001');
  await rejects(regSql,payArgs(await title('CHEQUE-1'),11999),'22023');
 });
 await test('full report hydration updates the same UUID, permits a shared cheque across titles and never changes the source identity',async()=>{
  const a=await title('CHEQUE-1'),b=await title('CHEQUE-2');const list=initial.map(r=>r.entry_number.startsWith('CHEQUE')?{...r,cheque_number:'000987'}:r);
  const out=await gateway(list);assert.equal(out.new_count,0);assert.equal(out.changed_count,2); // ANTIGO description is restored by the official source, plus CHEQUE-2 number.
  for(const old of[a,b]){const t=await title(old.entry_number);assert.equal(t.id,old.id);assert.equal(t.first_import_id,old.first_import_id);assert.equal(t.source_key,old.source_key);assert.equal(t.cheque_number,'000987');}
  assert.equal((await title('ANTIGO')).cheque_number,'000123');
 });
 await test('the immutable payment captures the current explicit cheque once; subsequent source corrections do not rewrite it',async()=>{
  const t=await title('CHEQUE-1');const request=payArgs(t);const id=await scalar(regSql,request);assert.equal(await scalar(regSql,request),id);
  let h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(h.rows[0].cheque_number,'000987');
  await cheque(await title('CHEQUE-1'),'000999');h=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(h.rows[0].cheque_number,'000987');assert.equal((await title('CHEQUE-1')).cheque_number,'000999');
 });
 await test('a missing optional source column preserves the current cheque; explicit blank or null clears it',async()=>{
  await gateway(initial);assert.equal((await title('CHEQUE-1')).cheque_number,'000999');
  let list=initial.map(r=>r.entry_number==='CHEQUE-1'?{...r,cheque_number:''}:r);await gateway(list);assert.equal((await title('CHEQUE-1')).cheque_number,null);
  await cheque(await title('CHEQUE-1'),'00-12/AB');list=initial.map(r=>r.entry_number==='CHEQUE-1'?{...r,cheque_number:null}:r);await gateway(list);assert.equal((await title('CHEQUE-1')).cheque_number,null);
  const t=await title('CHEQUE-2');await cheque(t,'ABC-0007/02');assert.equal((await title('CHEQUE-2')).cheque_number,'ABC-0007/02');
 });
 await test('invalid cheque types, excessive length, controls and unknown input columns abort validation without mutations',async()=>{
  const old=await state();for(const number of [123,true,{},'X'.repeat(151),'00\n123']){
   await rejects('SELECT public.preview_payables_import($1,$2)', ['grupo-consolidado',JSON.stringify([{...initial[1],cheque_number:number}])],'22023');
  }
  await rejects('SELECT public.preview_payables_import($1,$2)', ['grupo-consolidado',JSON.stringify([{...initial[1],chequeNumber:'0001'}])],'22023');
  const t=await title('CHEQUE-2');await rejects(correctionNew,[...correctionArgs(t),'00\n123',true],'22023');assert.deepEqual(await state(),old);
 });
 await test('file hash duplication remains blocked atomically instead of silently replaying old reports to hydrate numbers',async()=>{
  const old=await state();await assert.rejects(gateway(initial.map(r=>({...r,cheque_number:'007'})),1),e=>{assert.equal(e.code,'23505');return true;});assert.deepEqual(await state(),old);
 });
 await test('new closed positions include explicit source and payment cheque snapshots while previous positions remain unchanged',async()=>{
  await review(await title('ANTIGO'));const newer=await close();const report=await scalar('SELECT public.read_payable_month_closure($1) r',[newer]);
  assert.equal(report.snapshot.titles[0].cheque_number,'000123');assert.equal(report.snapshot.payments[0].cheque_number,null);
  await scalar(regSql,payArgs(await title('CHEQUE-2')));for(const entry of ['CHEQUE-1','CHEQUE-2'])await review(await title(entry));
  const future=await close(nextMonth);const next=await scalar('SELECT public.read_payable_month_closure($1) r',[future]);assert.equal(next.snapshot.titles.length,2);
  assert(next.snapshot.payments.some(p=>p.cheque_number==='000987'));assert(next.snapshot.payments.some(p=>p.cheque_number==='ABC-0007/02'));
  assert.deepEqual(await scalar('SELECT public.read_payable_month_closure($1) r',[oldClosure]),oldSnapshot);
 });
 await test('CP may correct explicitly, while Director, CR, RH and collectors cannot write cheque data or alter snapshots',async()=>{
  await actor(2);let t=await title('CHEQUE-2');await cheque(t,'000888');assert.equal((await title('CHEQUE-2')).cheque_number,'000888');
  await actor(1);t=await title('CHEQUE-2');assert.equal(t.cheque_number,'000888');await rejects(correctionNew,[...correctionArgs(t),'000777',true]);await rejects("UPDATE public.payable_titles SET cheque_number='000777'");
  for(const i of[3,4,5,6]){await actor(i);assert.equal((await db.query('SELECT * FROM public.payable_review_titles')).rows.length,0);await rejects(correctionNew,[...correctionArgs(t),'000777',true]);}await actor(0);
 });
 await test('anonymous/service roles and revoked sessions cannot call the new capability or correction endpoints',async()=>{
  const t=await title('CHEQUE-2');for(const r of['anon','service_role']){await role(r);await rejects('SELECT public.payables_import_capabilities()');await rejects(correctionNew,[...correctionArgs(t),'000777',true]);}
  await role('postgres');await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[sid(2),uid(2)]);await actor(2);await rejects('SELECT public.payables_import_capabilities()');await rejects(correctionNew,[...correctionArgs(t),'000777',true]);await actor(0);
 });
 await test('no payment or cheque mutation debits manually entered bank positions',async()=>{await role('postgres');assert.deepEqual(await rows('public.bank_balance_positions'),before['public.bank_balance_positions']);});
}catch(error){console.error('FAIL',error);process.exitCode=1;}finally{await db.close();}
console.log(`${passed} passed (synthetic local PostgreSQL, emulated Supabase identity)`);
