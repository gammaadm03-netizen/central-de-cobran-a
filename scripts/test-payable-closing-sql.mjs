import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Disposable PostgreSQL; all people, balances, files and obligations are synthetic.
const db=new PGlite();let inTransaction=false;let passed=0,sequence=0,latestImport=null,today,month,nextMonth,nextDue,due,bank,closing,nextClosing,initial;
const roles=['gerente_geral','diretor','contas_pagar','contas_receber','rh_dp','cobradora_1','cobradora_2'];
const uid=i=>`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const sid=i=>`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].r;
const role=async name=>{await db.exec('RESET ROLE');await db.exec(`SET ROLE ${name}`);};
const actor=async i=>{await role('postgres');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[uid(i),JSON.stringify({session_id:sid(i),role:'admin'})]);await role('authenticated');};
const rejects=async(sql,args=[],code='42501')=>{if(inTransaction)await db.exec('SAVEPOINT expected_rejection');try{await assert.rejects(db.query(sql,args),e=>{assert.equal(e.code,code,e.message);return true;});}finally{if(inTransaction){await db.exec('ROLLBACK TO SAVEPOINT expected_rejection');await db.exec('RELEASE SAVEPOINT expected_rejection');}}};
const test=async(name,run)=>{await run();passed++;console.log('PASS',name);};
const sqlFile=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const names=['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql','007_director_positions.sql',
 '008_receivables.sql','009_collections.sql','010_bank_import.sql','011_receivables_positions.sql','012_treasury_accounts.sql','013_director_report.sql',
 '014_payables_forecast.sql','015_payable_payments.sql','016_payable_identity_updates.sql'];
const regSql='SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r';
const correctionSql='SELECT public.correct_payable_title($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r';
const reviewSql='SELECT public.review_payable_title($1,$2,$3) r';
const closeSql='SELECT public.close_payables_month($1,$2,$3) r';
const rows=async table=>(await db.query(`SELECT to_jsonb(t) r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const title=async entry=>scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1',[entry]);
const status=(m=month)=>scalar('SELECT public.payables_month_status($1) r',[m]);
const summary=()=>scalar('SELECT public.payable_payment_summary($1,$1) r',[today]);
const fixture=(entry_number,amount_cents,extra={})=>({entry_number,amount_cents,plan:'DESPESA TESTE',description:'Fornecedor sintético',branch:'2 - TESTE',
 due_date:due,issued_on:today,source_status:'ABERTO',bank_account:'BANCO ORIGEM SINTÉTICO',...extra});
const gateway=async list=>{
 const bytes=Buffer.from(`Relatório sintético completo ${++sequence}`);await role('service_role');
 const out=await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,$9) r',[
 uid(0),sid(0),'grupo-consolidado',`teste-${sequence}.csv`,createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(list),
 JSON.stringify(Object.fromEntries(list.map(r=>[r.plan,r.plan==='NOVO PLANO TESTE'?'FRETE':'FIXO']))),latestImport]);
 latestImport=out.import_id;await actor(0);return out;
};
const pay=async(t,cents,date=today)=>scalar(regSql,[t.id,cents,date,bank,'Comprovante sintético',t.payment_revision,randomUUID(),t.last_import_id]);
const review=async t=>scalar(reviewSql,[t.id,'Conferência financeira sintética',t.review_fingerprint]);
const correct=async(t,change={},reclassify=false)=>scalar(correctionSql,[t.id,change.due_date??t.due_date,change.amount_cents??t.amount_cents,
 change.bank_account===undefined?t.bank_account:change.bank_account,change.description??t.description,change.issued_on===undefined?t.issued_on:change.issued_on,
 change.macro??t.macro,'Correção sintética autorizada',t.review_fingerprint,reclassify]);
const close=async(m=month)=>scalar(closeSql,[m,'Fechamento sintético conferido',(await status(m)).revision]);
const transaction=async run=>{const originalImport=latestImport;await role('postgres');await db.exec('BEGIN');inTransaction=true;try{await actor(0);await run();}
 finally{await db.exec('ROLLBACK');inTransaction=false;latestImport=originalImport;await actor(0);}};
const historical=async()=>{
 const canonical=await title('A');await role('postgres');const old=randomUUID();
 await db.query(`INSERT INTO public.payable_titles SELECT (jsonb_populate_record(NULL::public.payable_titles,to_jsonb(t)||
  jsonb_build_object('id',$1::uuid,'source_key','historical-synthetic-key','amount_cents',9000,'status','SETTLED_IMPORT','settled_at',clock_timestamp()))).* FROM public.payable_titles t WHERE id=$2`,[old,canonical.id]);
 await actor(0);return{old,canonical};
};
const bootstrap=`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`;

try{
 await db.exec(bootstrap);for(const name of names)await db.exec(await sqlFile(name));
 for(const[i,name]of roles.entries()){
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(i),`closing-${i}@example.invalid`]);
  await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[uid(i),`Closing${i}`,`Pessoa sintética ${i}`,name]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(i),uid(i)]);
 }
 const dates=(await db.query(`SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,
  date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS "month",
  (date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')+interval '1 month')::date::text next,
  (date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')+interval '1 month 4 days')::date::text next_due`)).rows[0];
 today=dates.today;month=dates.month;nextMonth=dates.next;nextDue=dates.next_due;due=today;await actor(0);
 bank=(await db.query('SELECT id FROM public.bank_accounts WHERE enabled ORDER BY id LIMIT 1')).rows[0].id;
 await scalar("SELECT public.set_bank_balance($1,$2,13579,'Saldo anterior sintético',null) r",[bank,today]);
 initial=[fixture('A',10000),fixture('B',20000,{source_status:'CHEQUE'}),fixture('C',30000),fixture('D',40000,{due_date:nextDue})];
 await gateway(initial);
 const oldA=await scalar("SELECT to_jsonb(t) r FROM public.payable_financial_titles t WHERE entry_number='A'");await pay(oldA,5000);
 await role('postgres');const protectedTables=['public.profiles','public.payable_titles','public.payable_imports','cf_private.payable_import_files',
  'public.bank_accounts','public.bank_balance_positions','public.payable_payments','public.payable_payment_reversals','public.audit_events','cf_private.payable_identity_registry'];
 const before=Object.fromEntries(await Promise.all(protectedTables.map(async t=>[t,await rows(t)])));
 await db.exec(await sqlFile('017_payable_month_closing.sql'));
 await test('activation preserves every existing title, payment, original import, identity, bank, user and audit row',async()=>{
  for(const t of protectedTables)assert.deepEqual(await rows(t),before[t],t);
  assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='017_payable_month_closing'"),1);
 });await actor(0);
 await test('new control starts A_CONCILIAR; unpaid, partial, zero and excessive-payment titles cannot be reviewed',async()=>{
  for(const entry of ['A','B','C','D'])assert.equal((await title(entry)).review_status,'A_CONCILIAR');
  for(const entry of ['A','B']){const t=await title(entry);await rejects(reviewSql,[t.id,'Ainda não está pago',t.review_fingerprint],'22023');}
  const s=await status();assert.equal(s.total_titles,3);assert.equal(s.pending_count,3);assert.equal(s.reconciled_count,0);assert.equal(s.can_close,false);
  await rejects(closeSql,[month,'Não concluir mês aberto',s.revision],'22023');
 });
 await test('an absent report title remains unreviewable without actual payment; pending monthly amount never becomes zero silently',async()=>transaction(async()=>{
  await gateway(initial.filter(t=>t.entry_number!=='C'));const t=await title('C');assert.equal(t.status,'SETTLED_IMPORT');assert.equal(t.outstanding_cents,0);
  assert.equal(t.payment_remaining_cents,30000);await rejects(reviewSql,[t.id,'Ausência não é pagamento',t.review_fingerprint],'22023');
  assert.equal((await status()).outstanding_cents,55000);
 }));
 await test('only exact full payment enables explicit review; registering payment alone does not mark CONCILIADO',async()=>{
  await actor(2);await pay(await title('A'),5000);let t=await title('A');assert.equal(t.financial_status,'PAID');assert.equal(t.review_status,'A_CONCILIAR');
  const id=await review(t);t=await title('A');assert.equal(t.review_status,'CONCILIADO');assert.equal(t.review_id,id);assert.equal(t.reviewed_by,uid(2));
  assert.equal(await review(t),id);await actor(0);
 });
 await test('the fingerprint ignores identical next-day imports, changing import UUID and NEW to OPEN',async()=>{
  const t=await title('A'),b=await title('B');assert.equal(b.status,'NEW');await gateway(initial);
  const after=await title('A');assert.equal(after.last_import_id,latestImport);assert.notEqual(after.last_import_id,t.last_import_id);
  assert.equal(after.review_fingerprint,t.review_fingerprint);assert.equal(after.review_status,'CONCILIADO');assert.equal((await title('B')).status,'OPEN');
 });
 await test('review is optimistic and stale fingerprints cannot approve changed commercial data',async()=>transaction(async()=>{
  const t=await title('A');await correct(t,{description:'Favorecido corrigido'});await rejects(reviewSql,[t.id,'Aprovação antiga',t.review_fingerprint],'40001');
  assert.equal((await title('A')).review_status,'A_CONCILIAR');assert.equal((await status()).pending_count,3);
 }));
 await test('changing commercial data and then restoring the old value cannot resurrect a prior review',async()=>transaction(async()=>{
  const t=await title('A');await correct(t,{description:'Descrição temporária'});await correct(await title('A'),{description:t.description});
  const next=await title('A');assert.equal(next.description,t.description);assert.notEqual(next.review_fingerprint,t.review_fingerprint);assert.equal(next.review_status,'A_CONCILIAR');
 }));
 await test('all titles must be explicitly reviewed before closing, including a fully paid cheque',async()=>{
  for(const entry of ['B','C','D']){const t=await title(entry);await pay(t,t.amount_cents);await review(await title(entry));}
  const s=await status();assert.equal(s.pending_count,0);assert.equal(s.total_titles,3);assert.equal(s.reconciled_count,3);assert.equal(s.can_close,true);
  closing=await close();nextClosing=await close(nextMonth);assert.equal((await status()).status,'CLOSED');assert.equal((await status(nextMonth)).status,'CLOSED');
 });
 let saved;
 await test('immutable snapshot separates titles by due month from actual paid date, including titles due in another month',async()=>{
  saved=await scalar('SELECT public.read_payable_month_closure($1) r',[closing]);assert.equal(saved.total_titles,3);assert.equal(saved.total_nominal_cents,60000);
  assert.equal(saved.snapshot.titles.length,3);assert.equal(saved.snapshot.realized.total_paid_cents,100000);
  assert.equal(saved.snapshot.realized.rows.length,5);assert(saved.snapshot.realized.rows.some(p=>p.entry_number==='D'));
  assert(saved.snapshot.titles.every(t=>t.review_status==='CONCILIADO'));assert.equal(saved.version,1);
  const n=await scalar('SELECT public.read_payable_month_closure($1) r',[nextClosing]);assert.equal(n.total_titles,1);assert.equal(n.snapshot.realized.total_paid_cents,0);
 });
 await test('closed month survives identical full reimports without audit reopen or loss of review',async()=>{
  const fingerprint=(await title('A')).review_fingerprint;await gateway(initial);
  assert.equal((await status()).status,'CLOSED');assert.equal((await status(nextMonth)).status,'CLOSED');assert.equal((await title('A')).review_fingerprint,fingerprint);
  assert.deepEqual(await scalar('SELECT public.read_payable_month_closure($1) r',[closing]),saved);
 });
 await test('changed source data invalidates the affected title and automatically reopens its prior due month and paid month',async()=>transaction(async()=>{
  await gateway(initial.map(t=>t.entry_number==='A'?{...t,bank_account:'OUTRO BANCO ORIGEM'}:t));
  assert.equal((await title('A')).review_status,'A_CONCILIAR');assert.equal((await title('B')).review_status,'CONCILIADO');
  assert.equal((await status()).status,'OPEN');assert.equal((await status(nextMonth)).status,'CLOSED');
  const events=(await db.query("SELECT * FROM public.payable_month_events WHERE action='REOPEN'")).rows;assert.equal(events.length,1);assert.equal(events[0].automatic,true);
 }));
 await test('moving a corrected due date reopens both old and new due months and preserves old snapshot contents',async()=>transaction(async()=>{
  await correct(await title('A'),{due_date:nextDue});assert.equal((await status()).status,'OPEN');assert.equal((await status(nextMonth)).status,'OPEN');
  assert.deepEqual(await scalar('SELECT public.read_payable_month_closure($1) r',[closing]),saved);
 }));
 await test('manual corrections change the payment token, so a stale payment confirmation cannot silently use the new nominal value or macro',async()=>transaction(async()=>{
  const t=await title('A');const originalToken=t.payment_revision;await correct(t,{amount_cents:15000,description:'Título atualizado'});
  const updated=await title('A');assert.notEqual(updated.payment_revision,originalToken);assert.equal(updated.last_import_id,t.last_import_id);
  await rejects(regSql,[t.id,5000,today,bank,'Confirmação obsoleta',originalToken,randomUUID(),t.last_import_id],'40001');
  await rejects(reviewSql,[updated.id,'Ainda parcial',updated.review_fingerprint],'22023');
 }));
 await test('a nominal value below actual paid produces OVERPAID and cannot be reviewed or closed',async()=>transaction(async()=>{
  await correct(await title('A'),{amount_cents:9999});const t=await title('A');assert.equal(t.financial_status,'OVERPAID');assert.equal(t.overpaid_cents,1);
  await rejects(reviewSql,[t.id,'Não presumir desconto',t.review_fingerprint],'22023');assert.equal((await status()).can_close,false);
 }));
 await test('macro corrections require explicit payment reclassification and preserve original immutable payment values',async()=>transaction(async()=>{
  const t=await title('A');await rejects(correctionSql,[t.id,t.due_date,t.amount_cents,t.bank_account,t.description,t.issued_on,'FRETE','Corrigir macro',t.review_fingerprint,false],'22023');
  await correct(t,{macro:'FRETE'},true);const actual=await summary();assert.equal(actual.by_macro.find(m=>m.macro==='FRETE').amount_cents,10000);
  const list=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);assert.equal(list.rows.length,2);
  assert(list.rows.every(p=>p.macro_snapshot==='FIXO'&&p.effective_macro==='FRETE'&&p.review_status==='A_CONCILIAR'));
  const original=(await db.query('SELECT macro_snapshot,amount_cents FROM public.payable_payments WHERE title_id=$1',[t.id])).rows;
  assert(original.every(p=>p.macro_snapshot==='FIXO'));assert.equal(original.reduce((n,p)=>n+Number(p.amount_cents),0),10000);
 }));
 await test('a one-title macro override survives the same plan reimport without invalidating its refreshed review or realized allocation',async()=>transaction(async()=>{
  await correct(await title('A'),{macro:'FRETE'},true);await review(await title('A'));const fingerprint=(await title('A')).review_fingerprint;
  await close();assert.equal((await status()).status,'CLOSED');
  await gateway(initial);const t=await title('A');assert.equal(t.macro,'FRETE');assert.equal(t.review_fingerprint,fingerprint);assert.equal(t.review_status,'CONCILIADO');
  assert.equal((await status()).status,'CLOSED');
  assert.equal((await title('B')).macro,'FIXO');assert.equal((await summary()).by_macro.find(m=>m.macro==='FRETE').amount_cents,10000);
 }));
 await test('a changed plan cancels the title override; returning to the old plan does not revive an obsolete override',async()=>transaction(async()=>{
  await correct(await title('A'),{macro:'VARIÁVEL'},true);await gateway(initial.map(t=>t.entry_number==='A'?{...t,plan:'NOVO PLANO TESTE'}:t));
  assert.equal((await title('A')).macro,'FRETE');assert.equal((await title('A')).review_status,'A_CONCILIAR');await gateway(initial);assert.equal((await title('A')).macro,'FIXO');
  assert.equal((await summary()).by_macro.find(m=>m.macro==='VARIÁVEL').amount_cents,10000);
 }));
 await test('a ledger-only reclassification can be explicitly applied when the current title already uses the intended macro',async()=>transaction(async()=>{
  await gateway(initial.map(t=>t.entry_number==='A'?{...t,plan:'NOVO PLANO TESTE'}:t));const t=await title('A');assert.equal(t.macro,'FRETE');
  await correct(t,{},true);assert.equal((await summary()).by_macro.find(m=>m.macro==='FRETE').amount_cents,10000);
 }));
 await test('payments and reversals invalidate prior review and reopen only affected due or actual-payment months',async()=>transaction(async()=>{
  const t=await title('D');const list=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[t.id]);
  await scalar('SELECT public.cancel_payable_payment($1,$2,$3) r',[list.rows[0].id,'Conferência sintética de comprovante',t.payment_revision]);
  assert.equal((await title('D')).review_status,'A_CONCILIAR');assert.equal((await status()).status,'OPEN');assert.equal((await status(nextMonth)).status,'OPEN');
 }));
 await test('a new unpaid title in an unrelated month does not reopen previously closed months',async()=>transaction(async()=>{
  const unrelated=await scalar("SELECT ($1::date+interval '2 months')::date::text r",[nextMonth]);await gateway([...initial,fixture('OUTRO',123,{due_date:unrelated})]);
  assert.equal((await status()).status,'CLOSED');assert.equal((await status(nextMonth)).status,'CLOSED');
 }));
 await test('proven superseded historical versions do not create duplicate debt or block canonical month closing',async()=>transaction(async()=>{
  const {old}=await historical();const row=await scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE id=$1',[old]);
  assert.equal(row.closing_eligible,false);assert(row.closing_exclusion_reason);assert.equal(row.amount_cents,9000);assert.equal(row.paid_cents,0);
  const s=await status();assert.equal(s.total_titles,3);assert.equal(s.excluded_historical_count,1);assert.equal(s.pending_count,0);assert.equal(s.can_close,true);
  await rejects(reviewSql,[old,'Não pagar duas vezes',row.review_fingerprint],'22023');
  const revision=await scalar('SELECT public.get_payables_revision() r');
  await rejects(regSql,[old,9000,today,bank,'Tentativa em versão anterior',row.payment_revision,randomUUID(),row.last_import_id],'P0016');
  assert.deepEqual(await scalar('SELECT public.get_payables_revision() r'),revision);
  const id=await close(),snapshot=await scalar('SELECT public.read_payable_month_closure($1) r',[id]);
  assert.equal(snapshot.total_nominal_cents,60000);assert.equal(snapshot.snapshot.titles.length,3);assert.equal(snapshot.snapshot.historical_titles.length,1);
  assert.equal(snapshot.snapshot.historical_titles[0].id,old);assert.equal(snapshot.snapshot.historical_titles[0].amount_cents,9000);
 }));
 await test('legacy duplicates with active payment history are never excluded, transferred, silently reviewed or paid again',async()=>transaction(async()=>{
  const {old,canonical}=await historical();await role('postgres');
  // Reproduce trusted legacy data from before 017, without invoking the new guard.
  await db.exec('SET session_replication_role=replica');
  await db.query(`INSERT INTO public.payable_payments SELECT (jsonb_populate_record(NULL::public.payable_payments,to_jsonb(p)||
   jsonb_build_object('id',gen_random_uuid(),'title_id',$1::uuid,'request_id',gen_random_uuid(),'event_revision',999999,'amount_cents',1))).*
   FROM public.payable_payments p WHERE title_id=$2 LIMIT 1`,[old,canonical.id]);
  await db.exec('SET session_replication_role=origin');await actor(0);
  const row=await scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE id=$1',[old]);assert.equal(row.closing_eligible,true);assert.equal(row.paid_cents,1);
  assert.equal((await status()).can_close,false);assert.equal((await status()).excluded_historical_count,0);
  const current=await title('A');await rejects(reviewSql,[current.id,'Não conciliar versões ambíguas',current.review_fingerprint],'P0016');
  await correct(current,{amount_cents:15000});const revised=await title('A');await rejects(regSql,[revised.id,5000,today,bank,'Não pagar versões ambíguas',revised.payment_revision,randomUUID(),revised.last_import_id],'P0016');
 }));
 await test('month reopening requires a reason and current closure ID, and reclose appends a new immutable version',async()=>transaction(async()=>{
  await rejects('SELECT public.reopen_payables_month($1,$2,$3)',[month,'',closing],'22023');
  await rejects('SELECT public.reopen_payables_month($1,$2,$3)',[month,'Reabrir',randomUUID()],'40001');
  await scalar('SELECT public.reopen_payables_month($1,$2,$3) r',[month,'Conferência administrativa sintética',closing]);assert.equal((await status()).status,'OPEN');
  const newer=await close();assert.notEqual(newer,closing);const h=await scalar('SELECT public.list_payable_month_closures($1,0,10) r',[month]);
  assert.equal(h.count,2);assert.equal(h.rows[0].version,2);assert(!('snapshot'in h.rows[0]));assert.deepEqual(await scalar('SELECT public.read_payable_month_closure($1) r',[closing]),saved);
 }));
 await test('stale month revisions block closing atomically, and an empty month cannot be closed',async()=>transaction(async()=>{
  await scalar('SELECT public.reopen_payables_month($1,$2,$3) r',[month,'Nova conferência sintética',closing]);const s=await status();await correct(await title('A'),{description:'Nova descrição'});
  await rejects(closeSql,[month,'Revisão antiga',s.revision],'40001');
  const empty=await scalar("SELECT ($1::date-interval '1 month')::date::text r",[month]);const e=await status(empty);assert.equal(e.total_titles,0);assert.equal(e.can_close,false);
  await rejects(closeSql,[empty,'Mês sem títulos',e.revision],'22023');
 }));
 await test('correction and closure histories are immutable; all reopening and correction events carry official audit actors',async()=>transaction(async()=>{
  await correct(await title('A'),{macro:'VARIÁVEL'},true);
  const tables=['payable_title_reviews','payable_title_corrections','payable_payment_reclassifications','payable_month_closures','payable_month_events','payable_title_macro_overrides'];
  for(const table of tables){await rejects(`DELETE FROM public.${table}`);await rejects(`UPDATE public.${table} SET created_at=now()`);}
  await role('postgres');for(const table of tables){await rejects(`DELETE FROM public.${table}`);await rejects(`UPDATE public.${table} SET created_at=now()`);}
  const audits=(await db.query("SELECT * FROM public.audit_events WHERE entity='payable_title_corrections'")).rows;assert(audits.length>0);assert.equal(audits[0].role_key,'gerente_geral');assert.equal(audits[0].user_id,uid(0));assert(audits[0].before_value);await actor(0);
 }));
 await test('director can read month status, history and snapshots but cannot correct, review, close or reopen',async()=>{
  await actor(1);assert.equal((await status()).status,'CLOSED');assert.equal((await scalar('SELECT public.read_payable_month_closure($1) r',[closing])).id,closing);
  const t=await title('A');await rejects(reviewSql,[t.id,'Diretor somente leitura',t.review_fingerprint]);await rejects(correctionSql,[t.id,t.due_date,t.amount_cents,t.bank_account,'Alterar',t.issued_on,t.macro,'Tentativa',t.review_fingerprint,false]);
  await rejects(closeSql,[month,'Tentativa',(await status()).revision]);await rejects('SELECT public.reopen_payables_month($1,$2,$3)',[month,'Tentativa',closing]);await actor(0);
 });
 await test('CR, RH, collectors, anonymous and service roles cannot access detailed review or closing data',async()=>{
  for(const i of [3,4,5,6]){await actor(i);for(const t of ['payable_review_titles','payable_effective_payments','payable_title_reviews','payable_month_closures'])assert.equal((await db.query(`SELECT * FROM public.${t}`)).rows.length,0);
   await rejects('SELECT public.payables_month_status($1)',[month]);await rejects('SELECT public.read_payable_month_closure($1)',[closing]);}
  for(const r of ['anon','service_role']){await role(r);await rejects('SELECT * FROM public.payable_review_titles');await rejects('SELECT public.payables_month_status($1)',[month]);}
  await actor(0);
 });
 await test('revoked sessions immediately lose review and closure access',async()=>transaction(async()=>{
  await role('postgres');await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[sid(2),uid(2)]);
  await actor(2);assert.equal((await db.query('SELECT * FROM public.payable_review_titles')).rows.length,0);await rejects('SELECT public.payables_month_status($1)',[month]);
 }));
 await test('all operations leave manual bank positions and original payment snapshots unchanged',async()=>{
  await role('postgres');assert.deepEqual(await rows('public.bank_balance_positions'),before['public.bank_balance_positions']);
  const original=(await db.query('SELECT macro_snapshot,amount_cents FROM public.payable_payments')).rows;assert(original.every(p=>p.macro_snapshot==='FIXO'));
 });
}catch(error){console.error('FAIL',error);process.exitCode=1;}finally{await db.close();}
console.log(`${passed} passed (synthetic local PostgreSQL, emulated Supabase identity)`);
