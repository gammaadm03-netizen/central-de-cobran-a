import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Isolated PostgreSQL only. All report rows, identities and files are synthetic.
const db = new PGlite(); let passed = 0, sequence = 0, latest = null, today, yesterday, bank, bankName, legacyRequest, legacyResult, baselinePayments, baselineReviews;
const ids = ['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003'];
const sessions = ['20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003'];
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].r;
const role = async value => { await db.exec('RESET ROLE'); await db.exec(`SET ROLE ${value}`); };
const actor = async (index = 0) => { await role('postgres'); await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [ids[index],JSON.stringify({session_id:sessions[index],role:'authenticated'})]); await role('authenticated'); };
const source = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url),'utf8');
const test = async (name, run) => { await run(); passed++; console.log('PASS',name); };
const reject = (operation,code) => assert.rejects(operation,error => { assert.equal(error.code,code,error.message); return true; });
const revision = () => scalar('SELECT public.get_payables_revision() r');
const title = entry => scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1',[entry]);
const forecastRow = (entry_number,amount_cents) => ({entry_number,amount_cents,plan:'DESPESA SINTETICA',description:'Fornecedor sintético',branch:'FILIAL SINTETICA',due_date:today,issued_on:today,source_status:'ABERTO',bank_account:'CONTA ERP'});
const paidRow = (entry_number,amount_paid_cents,extra = {}) => ({entry_number,amount_paid_cents,branch:'FILIAL SINTETICA',source_status:'PAGO',paid_on:yesterday,paid_bank:bankName,...extra});
const file = () => { const bytes=Buffer.from(`Original sintético de conciliação ${++sequence}`); return {name:`sintetico-${sequence}.csv`,sha:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')}; };
const forecast = async list => { const f=file(); await role('service_role'); try { const out=await scalar('SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9) r',[ids[0],sessions[0],'grupo-consolidado',f.name,f.sha,f.base64,JSON.stringify(list),JSON.stringify({'DESPESA SINTETICA':'FIXO'}),latest]); latest=out.import_id;return out; } finally { await actor(); } };
const preview = (list,choices = {},mappings = {},plans = {}) => scalar('SELECT public.preview_payables_paid_import_v2($1,$2,$3,$4,$5) r',['grupo-consolidado',JSON.stringify(list),JSON.stringify(mappings),JSON.stringify(plans),JSON.stringify(choices)]);
const choice = reason => ({action:'WRITE_OFF',reason});
const frozen = async (list,choices = {},extra = {}) => ({list,choices,original:file(),request:randomUUID(),previous:latest,financial:(await revision()).financial_revision,confirm:false,...extra});
const commit = async (request,index=0) => { const {list,choices,original,previous,financial,confirm,request:requestId}=request; await role('service_role'); try { const out=await scalar('SELECT public.commit_payables_paid_import_v2_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) r',[ids[index],sessions[index],'grupo-consolidado',original.name,original.sha,original.base64,JSON.stringify(list),JSON.stringify(request.banks??{}),previous,confirm,JSON.stringify(request.plans??{}),financial,JSON.stringify(choices),requestId]); if(!out.idempotent) latest=out.import_id;return out; } finally { await actor(); } };
const tables=['public.payable_titles','public.payable_imports','cf_private.payable_import_files','public.payable_payments','public.payable_payment_reversals','public.payable_title_reviews','public.payable_administrative_writeoffs','public.payable_import_modes','public.payable_paid_import_rows','public.payable_paid_bank_mappings','public.audit_events','cf_private.payable_import_resolution_requests','public.bank_balance_positions','public.payable_title_control_revisions','cf_private.payable_payment_state','cf_private.payable_control_state'];
const state=async()=>{await role('postgres');try{return Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.query(`SELECT to_jsonb(t) r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows])));}finally{await actor();}};
const count = async table => { await role('postgres');try{return await scalar(`SELECT count(*)::int r FROM ${table}`);}finally{await actor();} };
const bootstrap=`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`;
const migrations=['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql','007_director_positions.sql','008_receivables.sql','009_collections.sql','010_bank_import.sql','011_receivables_positions.sql','012_treasury_accounts.sql','013_director_report.sql','014_payables_forecast.sql','015_payable_payments.sql','016_payable_identity_updates.sql','017_payable_month_closing.sql','018_payable_full_payment.sql','019_payable_cheques.sql','020_payables_management.sql','021_payable_paid_import.sql'];
try {
 await db.exec(bootstrap);for(const migration of migrations) await db.exec(await source(migration));
 for(const [index,profile] of ['gerente_geral','contas_pagar','diretor'].entries()) {
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[ids[index],`conciliation-${index}@example.invalid`]);
  await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[ids[index],`Conciliation${index}`,`Pessoa sintética ${index}`,profile]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sessions[index],ids[index]]);
 }
 const dates=(await db.query("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text yesterday")).rows[0];today=dates.today;yesterday=dates.yesterday;await actor();
 const account=(await db.query('SELECT id,display_name FROM public.bank_accounts WHERE enabled ORDER BY display_name LIMIT 1')).rows[0];bank=account.id;bankName=account.display_name;
 await forecast([forecastRow('CENT-A',1),forecastRow('CENT-B',9000),forecastRow('NORMAL',10000),forecastRow('CENT-MIX',1),forecastRow('CORRECT',20000),forecastRow('MANUAL',30000),forecastRow('LATER',40000),forecastRow('UPGRADE',1),forecastRow('ROLLBACK-NORMAL',50000),forecastRow('ROLLBACK-CENT',1),forecastRow('LEGACY-PAID',11111),forecastRow('REPLAY-BANK',12500)]);
 legacyRequest=await frozen([paidRow('LEGACY-PAID',11111,{paid_on:'1900-01-01',plan:'DESPESA SINTETICA'})]);
 await role('service_role');legacyResult=await scalar('SELECT public.commit_payables_paid_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r',
  [ids[0],sessions[0],'grupo-consolidado',legacyRequest.original.name,legacyRequest.original.sha,legacyRequest.original.base64,JSON.stringify(legacyRequest.list),'{}',latest,false,'{}',legacyRequest.financial]);latest=legacyResult.import_id;await actor();
 baselinePayments=await count('public.payable_payments');baselineReviews=await count('public.payable_title_reviews');
 await role('postgres');await db.exec(await source('042_payable_administrative_writeoff.sql'));await db.exec(await source('043_payable_import_reconciliation.sql'));await actor();
 await test('a repeated pre-043 noncent paid file returns complete v2 counters without duplicating its original cash or review',async()=>{
  assert.equal(legacyResult.writeoff_count,undefined);const beforePayments=await count('public.payable_payments'),beforeReviews=await count('public.payable_title_reviews'),beforeImports=await count('public.payable_imports');
  const request={...legacyRequest,request:randomUUID()},out=await commit(request);
  assert.equal(out.idempotent,true);assert.equal(out.import_id,legacyResult.import_id);assert.equal(out.request_id,request.request);assert.equal(out.reconciliation_version,'043');
  assert.equal(out.writeoff_count,0);assert.equal(out.new_writeoff_count,0);assert.equal(out.matched_writeoff_count,0);assert.equal(out.reviewed_count,1);
  assert.equal(await count('public.payable_payments'),beforePayments);assert.equal(await count('public.payable_title_reviews'),beforeReviews);assert.equal(await count('public.payable_imports'),beforeImports);
 });
 await test('cent preview preserves original values, requests every explicit writeoff and never needs an official bank for those rows',async()=>{
  const report=[paidRow('CENT-A',1,{paid_bank:'BANCO SEM VINCULO'}),paidRow('CENT-B',1,{paid_bank:'BANCO SEM VINCULO'})],before=await state(),p=await preview(report);
  assert.equal(p.can_commit,false);assert.equal(p.reconciliation_version,'043');assert.equal(p.reconciliation_items.length,2);assert.equal(p.unmapped_banks.length,0);assert.equal(p.writeoff_count,2);assert.equal(p.new_writeoff_count,2);assert.equal(p.matched_writeoff_count,0);
  assert.equal(p.reconciliation_items[1].amount_cents,9000);assert.equal(p.reconciliation_items[1].source_amount_cents,1);assert.equal(p.reconciliation_items[0].selected_action,null);
  assert.deepEqual(await state(),before);
 });
 await test('one missing cent confirmation blocks the entire mixed file before any import, cash or writeoff is recorded',async()=>{
  const report=[paidRow('NORMAL',10000),paidRow('CENT-A',1),paidRow('CENT-B',1)],choices={'row:2':choice('Sentinela confirmada A')};
  const p=await preview(report,choices);assert.equal(p.can_commit,false);assert.equal(p.new_payment_count,1);assert.equal(p.resolution_errors.length,1);
  const request=await frozen(report,choices),before=await state();await reject(commit(request),'P0042');assert.deepEqual(await state(),before);
 });
 let centRequest,centResult;
 await test('an all-cent file atomically writes only administrative provenance and preserves both original nominal and due date',async()=>{
  const beforeA=await title('CENT-A'),beforeB=await title('CENT-B');centRequest=await frozen([paidRow('CENT-A',1,{paid_bank:'SEM BANCO'}),paidRow('CENT-B',1,{paid_bank:'SEM BANCO'})],{'row:1':choice('Baixa individual A'),'row:2':choice('Baixa individual B')});
  assert.equal((await preview(centRequest.list,centRequest.choices)).can_commit,true);centResult=await commit(centRequest);
  assert.equal(centResult.request_id,centRequest.request);assert.equal(centResult.reconciliation_version,'043');assert(Number.isFinite(Date.parse(centResult.reconciled_at)));assert.equal(centResult.writeoff_count,2);assert.equal(centResult.new_writeoff_count,2);assert.equal(centResult.reviewed_count,0);assert.equal(centResult.new_payment_count,0);
  for(const [entry,before] of [['CENT-A',beforeA],['CENT-B',beforeB]]) {const after=await title(entry);assert.equal(after.amount_cents,before.amount_cents);assert.equal(after.due_date,before.due_date);assert.equal(after.financial_status,'ADMIN_WRITEOFF');assert.equal(after.paid_cents,0);assert.notEqual(after.review_status,'CONCILIADO');}
  assert.equal(await count('public.payable_payments'),baselinePayments);assert.equal(await count('public.payable_title_reviews'),baselineReviews);assert.equal(await count('public.payable_administrative_writeoffs'),2);assert.equal(await count('public.payable_paid_bank_mappings'),0);
 });
 await test('same request and file replays safely; changed choices under the same request cannot mutate the original resolution',async()=>{
  const before=await state(),out=await commit(centRequest);assert.equal(out.import_id,centResult.import_id);assert.deepEqual(await state(),before);
  await reject(commit({...centRequest,choices:{...centRequest.choices,'row:1':choice('Motivo diferente')}}),'22023');assert.deepEqual(await state(),before);
 });
 await test('same original file with a fresh request never duplicates financial, review or administrative events',async()=>{
  const cash=await count('public.payable_payments'),writeoffs=await count('public.payable_administrative_writeoffs'),imports=await count('public.payable_imports');
  const out=await commit({...centRequest,request:randomUUID()});assert.equal(out.idempotent,true);assert.equal(out.import_id,centResult.import_id);assert.equal(out.reconciliation_version,'043');
  assert.equal(await count('public.payable_payments'),cash);assert.equal(await count('public.payable_administrative_writeoffs'),writeoffs);assert.equal(await count('public.payable_imports'),imports);
 });
 await test('a fresh request repeating cent bytes still requires every individual writeoff confirmation',async()=>{
  const before=await state();await reject(commit({...centRequest,request:randomUUID(),choices:{}}),'P0042');assert.deepEqual(await state(),before);
  await reject(commit({...centRequest,request:randomUUID(),choices:{...centRequest.choices,'row:3':choice('Não pertence ao arquivo')}}),'22023');assert.deepEqual(await state(),before);
 });
 await test('mixed actual payments and cent writeoffs reconcile together, with only the true payment included in realized amounts',async()=>{
  const report=[paidRow('NORMAL',10000,{plan:'DESPESA SINTETICA'}),paidRow('CENT-MIX',1)];const request=await frozen(report,{'row:2':choice('Baixa individual no mesmo lote')});const out=await commit(request);
  assert.equal(out.new_payment_count,1);assert.equal(out.reviewed_count,1);assert.equal(out.writeoff_count,1);assert.equal((await title('NORMAL')).review_status,'CONCILIADO');
  const totals=await scalar('SELECT public.payable_payment_summary($1,$2) r',[yesterday,today]);assert.equal(totals.total_paid_cents,10000);assert.equal((await title('CENT-MIX')).paid_cents,0);
  const before=await state();await reject(commit({...request,request:randomUUID(),plans:{'DESPESA SINTETICA':'VARIÁVEL'}}),'P0042');assert.deepEqual(await state(),before);
  await role('postgres');const otherBank=await scalar('SELECT id r FROM public.bank_accounts WHERE enabled AND id<>$1 ORDER BY id LIMIT 1',[bank]);const bankKey=await scalar('SELECT cf_private.payable_paid_bank_key($1,$2) r',['FILIAL SINTETICA',bankName]);await actor();
  await reject(commit({...request,request:randomUUID(),banks:{[bankKey]:otherBank}}),'P0042');assert.deepEqual(await state(),before);

 });
 await test('a later report repeats an already active cent writeoff only after a fresh explicit confirmation and appends no duplicate event',async()=>{
  const report=[paidRow('CENT-A',1)],p=await preview(report);assert.equal(p.can_commit,false);assert.equal(p.reconciliation_items[0].already_written_off,true);
  const before=await count('public.payable_administrative_writeoffs'),out=await commit(await frozen(report,{'row:1':choice('Conferência posterior da mesma baixa')}));
  assert.equal(out.new_writeoff_count,0);assert.equal(out.matched_writeoff_count,1);assert.equal(await count('public.payable_administrative_writeoffs'),before);
 });
 await test('unknown cent rows block a whole file without inventing a title, original due date or payment',async()=>{
  const report=[paidRow('LATER',40000),paidRow('UNKNOWN-CENT',1)],p=await preview(report),item=p.reconciliation_items[0];
  assert.equal(p.can_commit,false);assert.equal(item.title_id,null);assert.equal(typeof item.description,'string');assert.equal(item.due_date,null);assert.equal(item.amount_cents,null);assert.deepEqual(item.allowed_actions,[]);assert.match(item.problem,/previsão/);
  const before=await state();await reject(commit(await frozen(report)),'P0042');assert.deepEqual(await state(),before);
 });
 await test('cent imports cannot erase an active manual payment and a real receipt cannot implicitly reopen a prior writeoff',async()=>{
  const t=await title('MANUAL');await scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r',[t.id,30000,yesterday,bank,'Pagamento manual sintético',t.payment_revision,randomUUID(),t.last_import_id]);
  const report=[paidRow('MANUAL',1)],choices={'row:1':choice('Baixa não deve apagar caixa')};assert.equal((await preview(report,choices)).can_commit,false);
  const before=await state();await reject(commit(await frozen(report,choices)),'P0042');assert.deepEqual(await state(),before);
  const p=await preview([paidRow('CENT-B',9000)]);assert.equal(p.can_commit,false);assert.equal(p.rows[0].outcome,'CONFLICT');assert.match(p.rows[0].problem,/Reabra/);
 });
 await test('a real payment replaces an unwritten cent placeholder with the actual nominal amount and is reconciled normally',async()=>{
  const report=[paidRow('UPGRADE',15000)],p=await preview(report);assert.equal(p.can_commit,true);assert.equal(p.reconciliation_items.length,0);assert.equal(p.new_payment_count,1);
  await commit(await frozen(report));const after=await title('UPGRADE');assert.equal(after.amount_cents,15000);assert.equal(after.paid_cents,15000);assert.equal(after.review_status,'CONCILIADO');
 });
 await test('normal imported corrections still require explicit consent and retain old receipts via reversal history',async()=>{
  await commit(await frozen([paidRow('CORRECT',20000)]));const corrected=[paidRow('CORRECT',21000,{paid_on:today})];assert.equal((await preview(corrected)).correction_count,1);
  const before=await state();await reject(commit(await frozen(corrected)),'P0042');assert.deepEqual(await state(),before);
  const out=await commit(await frozen(corrected,{}, {confirm:true}));assert.equal(out.correction_count,1);assert.equal((await title('CORRECT')).review_status,'CONCILIADO');
  const payments=await scalar('SELECT public.list_payable_payments(null,null,0,25,$1) r',[(await title('CORRECT')).id]);assert.equal(payments.count,2);assert(payments.rows.some(row=>row.status==='CANCELLED'&&row.amount_cents===20000));assert(payments.rows.some(row=>row.status==='ACTIVE'&&row.amount_cents===21000));
 });
 await test('stale financial previews and invalid original-file integrity reject the whole request before writes',async()=>{
  const request=await frozen([paidRow('LATER',40000)]),manual=await title('ROLLBACK-NORMAL');
  await scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r',[manual.id,50000,yesterday,bank,'Altera revisão financeira',manual.payment_revision,randomUUID(),manual.last_import_id]);
  const before=await state();await reject(commit(request),'40001');assert.deepEqual(await state(),before);
  await reject(commit({...request,request:randomUUID(),original:{...request.original,sha:'0'.repeat(64)}}),'22023');assert.deepEqual(await state(),before);
 });
 await test('late audit failure rolls back a mixed payment and writeoff, including source bytes and resolution-request ledger',async()=>{
  const report=[paidRow('LATER',40000),paidRow('ROLLBACK-CENT',1)],request=await frozen(report,{'row:2':choice('Baixa com auditoria obrigatória')}),before=await state();
  await role('postgres');await db.exec("CREATE FUNCTION cf_private.synthetic_paid_resolution_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='payable_import_modes' THEN RAISE EXCEPTION 'synthetic late failure' USING ERRCODE='P0001';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_paid_resolution_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_paid_resolution_failure()");await actor();
  await reject(commit(request),'P0001');assert.deepEqual(await state(),before);await role('postgres');await db.exec('DROP TRIGGER synthetic_paid_resolution_failure ON public.audit_events;DROP FUNCTION cf_private.synthetic_paid_resolution_failure()');await actor();
 });
 await test('an exact committed request still replays after its official bank is disabled, while a new request cannot use the disabled bank',async()=>{
  await role('postgres');const bankKey=await scalar('SELECT cf_private.payable_paid_bank_key($1,$2) r',['FILIAL SINTETICA','TEXTO ERP REPLAY']);await actor();
  const request=await frozen([paidRow('REPLAY-BANK',12500,{paid_bank:'TEXTO ERP REPLAY'})],{}, {banks:{[bankKey]:bank}}),original=await commit(request);
  await role('postgres');await db.query('UPDATE public.bank_accounts SET enabled=false WHERE id=$1',[bank]);await actor();const before=await state();
  try {
   const replay=await commit(request);assert.equal(replay.idempotent,true);assert.equal(replay.import_id,original.import_id);assert.equal(replay.request_id,request.request);assert.deepEqual(await state(),before);
   await reject(commit({...request,request:randomUUID()}),'22023');assert.deepEqual(await state(),before);
  } finally { await role('postgres');await db.query('UPDATE public.bank_accounts SET enabled=true WHERE id=$1',[bank]);await actor(); }
 });
 await test('the old paid gateway cannot bypass the new atomic reconciliation contract',async()=>{
  const before=await state(),request=await frozen([paidRow('LATER',40000)]),f=request.original;await role('service_role');
  try { await reject(db.query('SELECT public.commit_payables_paid_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[ids[0],sessions[0],'grupo-consolidado',f.name,f.sha,f.base64,JSON.stringify(request.list),'{}',latest,false,'{}',request.financial]),'P0043'); } finally { await actor(); }
  assert.deepEqual(await state(),before);
 });
 await test('client roles cannot invoke gateway writes or private resolution helpers; director and revoked sessions cannot preview or commit',async()=>{
  await reject(db.query('SELECT cf_private.preview_payable_paid_rows_v2($1,$2,$3,$4,$5)',['grupo-consolidado',JSON.stringify([paidRow('LATER',40000)]),'{}','{}','{}']),'42501');
  await actor(2);await reject(preview([paidRow('LATER',40000)]),'42501');await actor();await reject(commit(await frozen([paidRow('LATER',40000)]),2),'42501');
  await role('postgres');await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[sessions[1],ids[1]]);await actor(1);await reject(preview([paidRow('LATER',40000)]),'42501');await actor();await reject(commit(await frozen([paidRow('LATER',40000)]),1),'42501');
 });
 console.log(`${passed} passed (paid import v2, synthetic local PostgreSQL)`);
} catch(error) { console.error('FAIL',error);process.exitCode=1; } finally { await db.close(); }
