import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
// Dados exclusivamente sintéticos e PostgreSQL descartável; nenhuma conexão remota.
const db=new PGlite(),roles=['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const uuid=n=>`98000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const users=Object.fromEntries(roles.map((r,i)=>[r,{id:uuid(i+1),session:uuid(i+11)}]));
const agents=[uuid(30),uuid(31)];let today,yesterday,tomorrow,importId,sequence=100,passed=0,failed=0,ready=false;
const sql=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const scalar=async(s,args=[])=>(await db.query(s,args)).rows[0].r;
const owner=()=>db.exec('RESET ROLE');
const actor=async(name='cobradora_1')=>{await owner();await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[users[name].id,JSON.stringify({session_id:users[name].session})]);await db.exec('SET ROLE authenticated');};
const reject=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
const reset=async()=>{await owner();await db.exec("UPDATE public.collection_work_sessions SET ended_at=greatest(started_at,clock_timestamp()),end_reason='PAUSE' WHERE ended_at IS NULL;UPDATE public.receivable_titles SET next_action=NULL,next_action_date=NULL WHERE next_action_date IS NOT NULL;");};
const test=async(name,fn)=>{try{if(ready)await reset();await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack??e.message,JSON.stringify({position:e.position,where:e.where}));}};
const fixture=async(options={})=>{await owner();const n=++sequence,r={days:10,amount:10000,collector:agents[0],status:'OPEN',nextDate:null,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_date,next_action,next_action_date,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$2,$3,cf_private.receivable_customer_key($3,NULL),'Filial sintética',$4::date-$5::int,$6,$7,$8,$9,$10,
 CASE WHEN $8='VALIDATED' THEN $4::date END,CASE WHEN $11::date IS NULL THEN NULL ELSE 'OTHER' END,$11,$12,$12) RETURNING id AS r`,[
 `synthetic-${n}`,`NF-${n}`,`Cliente sintético ${n}`,today,r.days,r.amount,r.collector,r.status,
 r.status==='VALIDATED'?'VALIDATED':r.status==='PENDING_VALIDATION'?'PENDING':'NONE',
 ['VALIDATED','PENDING_VALIDATION'].includes(r.status)?'IMPORTACAO_DIARIA':null,r.nextDate,importId]);};
const title=id=>scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1',[id]);
const detail=id=>scalar('SELECT public.collection_case_detail($1) AS r',[id]);
const list=(f={})=>scalar('SELECT public.collection_workbench($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS r',[
 f.search??'',f.collector??null,f.unassigned??false,f.band??null,f.sort??'delay_desc',f.status??null,f.offset??0,f.limit??25,f.queue??'active',f.start??null,f.end??null,f.next??null,f.financial??null]);
const work=(id,action,revision,request=randomUUID())=>scalar('SELECT public.collection_work_action($1,$2,$3,$4) AS r',[id,action,revision,request]);
const save=async(id,c={})=>{const d=await detail(id);return scalar('SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',[
 id,c.status??'COBRANCA POR WHATSAPP',c.observation===undefined?'Contato sintético':c.observation,c.next===undefined?'Retomar por telefone':c.next,
 c.nextDate===undefined?tomorrow:c.nextDate,c.revision??d.title.revision,c.caseRevision??d.case.revision,c.paymentDate??null,c.finish??false,c.request??randomUUID()]);};
const start=async id=>work(id,'START',(await detail(id)).title.revision);
const validate=async(id,decision,date=null)=>{await actor('contas_receber');return scalar('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5) AS r',[id,decision,date,'Conferência sintética',(await title(id)).revision]);};
const summary=()=>scalar('SELECT public.collection_work_summary($1,$2,NULL) AS r',[today,today]);
const state=async(tables=['receivable_titles','receivable_receipts','receivable_receipt_adjustments','receivable_collection_events','collection_cases','collection_case_events','collection_work_sessions','collection_work_requests','audit_events','bank_accounts'])=>{await owner();const s={};for(const t of tables)s[t]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS r FROM public.${t} t`);return s;};
const receipt=async(id,amount=10000)=>{await owner();return scalar(`INSERT INTO public.receivable_receipts(title_id,amount_cents,payment_date,delay_days,delay_band,collector_id,payment_source,reported_in_collection,validated_by)
 VALUES($1,$2,$3,10,'ATE_30',$4,'IMPORTACAO_DIARIA',false,$5) RETURNING id AS r`,[id,amount,today,agents[0],users.contas_receber.id]);};
const paid=async id=>{await actor();await start(id);return save(id,{status:'TÍTULO PAGO',paymentDate:today,finish:true});};
try{
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 for(const f of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql','007_director_positions.sql',
 '008_receivables.sql','009_collections.sql','022_collections_overdue_only.sql','023_receivable_sync.sql','024_receivable_received_import.sql','025_collections_management.sql','026_collection_workbench.sql','027_collection_customer_context.sql'])await db.exec(await sql(f));
 const migration=await sql('029_collection_workflow.sql');
 await test('029 requires 028 and a failed activation leaves no helper or grant changes',async()=>{
  await reject(()=>db.exec(migration),'22023');await db.exec('ROLLBACK');assert.equal(await scalar("SELECT to_regprocedure('cf_private.collection_workflow_started(uuid)')::text AS r"),null);
  assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.record_collection_action(uuid,text,date,text,date,text,text,date,bigint)','EXECUTE') AS r"),true);
 });
 await db.exec(`CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;`);
 await db.exec(await sql('028_collection_reference_imports.sql'));
 for(const[r,u]of Object.entries(users)){await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[u.id,`${r}@example.invalid`]);await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)',[u.id,r]);await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[u.session,u.id]);}
 for(const[i,a]of agents.entries()){await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[a,`Responsável sintética ${i+1}`]);await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users[`cobradora_${i+1}`].id,a,users.gerente_geral.id]);}
 ({today,yesterday,tomorrow}=(await db.query("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text AS yesterday,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text AS tomorrow")).rows[0]);
 importId=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count)
 VALUES('grupo-consolidado','synthetic.csv',repeat('a',64),$1,1,1,0,0,0) RETURNING id AS r`,[users.contas_receber.id]);
 const old=await fixture();await actor();await start(old);await work(old,'PAUSE',null);await save(old);
 await test('activation preserves financial, contact, case, closed timer and audit histories',async()=>{
  const before=await state();await db.exec(migration);assert.deepEqual(await state(),before);
  await actor();const r=await list();assert.equal(r.workflow.version,'029');assert.equal(r.workflow.normal_pause,true);assert.equal(r.workflow.finish_requires_started,true);
 });ready=true;
 await test('START, PAUSE, reload and paused FINISH retain official own time without inventing intervals',async()=>{
  const id=await fixture();await actor();let d=await detail(id);assert.equal(d.workflow.started,false);assert.equal(d.workflow.can_finish,false);
  await start(id);await db.query('SELECT pg_sleep(1.05)');const paused=await work(id,'PAUSE',null);assert.equal(paused.running,false);assert(paused.actor_total_seconds>=1);
  d=await detail(id);assert.equal(d.workflow.started,true);assert.equal(d.workflow.can_finish,true);const seconds=d.timer.actor_total_seconds;
  await save(id,{finish:true});d=await detail(id);assert.equal(d.workflow.started,false);assert.equal(d.timer.actor_total_seconds,seconds);
  const s=await summary();assert.equal(s.rows.find(r=>r.title_id===id).actor_id,users.cobradora_1.id);assert.equal(s.rows.filter(r=>r.title_id===id).length,1);
 });
 await test('PAUSE and START request replays are exact; collisions and other actors cannot stop intervals',async()=>{
  const id=await fixture();await actor();const rev=(await title(id)).revision,startRequest=randomUUID(),pauseRequest=randomUUID();const initial=await work(id,'START',rev,startRequest);
  assert.deepEqual(await work(id,'START',rev,startRequest),initial);const paused=await work(id,'PAUSE',null,pauseRequest);assert.deepEqual(await work(id,'PAUSE',null,pauseRequest),paused);
  await reject(()=>work(id,'START',rev,pauseRequest),'22023');await start(id);await actor('cobradora_2');await reject(()=>work(id,'PAUSE',null));
 });
 await test('draft saves without START or while paused work but cannot change official agenda or bypass finish',async()=>{
  const id=await fixture({nextDate:today});await actor();await save(id,{nextDate:tomorrow});assert.equal((await title(id)).next_action_date,today);
  assert.equal((await list({queue:'returns'})).rows.find(r=>r.id===id).return_due,true);
  await reject(()=>save(id,{finish:true}),'55000');await start(id);await work(id,'PAUSE',null);await save(id,{next:'Rascunho após pausa'});assert.equal((await detail(id)).workflow.started,true);
 });
 await test('finance may preserve a draft without an assigned collector while START and FINISH remain blocked',async()=>{
  const id=await fixture({collector:null});await actor('gerente_geral');await save(id,{nextDate:today});assert.equal((await detail(id)).title.collector_id,null);
  assert.equal((await title(id)).next_action_date,null);await reject(()=>start(id),'23514');await reject(()=>save(id,{finish:true}),'55000');
 });
 await test('FINISH requires an unused START plus observation, next action and a date today or later',async()=>{
  const id=await fixture();await actor();await reject(()=>save(id,{finish:true}),'55000');await start(id);
  for(const c of [{observation:' '},{next:' '},{nextDate:null},{nextDate:yesterday}])await reject(()=>save(id,{...c,finish:true}),'23514');
  await reject(()=>work(id,'FINISH',null),'23514');await save(id,{finish:true,nextDate:today});assert.equal((await title(id)).next_action_date,today);
  await save(id,{nextDate:tomorrow});assert.equal((await detail(id)).workflow.started,false);await reject(()=>save(id,{finish:true}),'55000');
 });
 await test('a previously paused cycle is invalidated by another actor finalizing the same title',async()=>{
  const id=await fixture();await actor();await start(id);await work(id,'PAUSE',null);await actor('gerente_geral');await start(id);await save(id,{finish:true});
  await actor();assert.equal((await detail(id)).workflow.started,false);await reject(()=>save(id,{finish:true}),'55000');await start(id);await save(id,{finish:true});
 });
 await test('due returns are independent of search and include today while drafts do not create priority',async()=>{
  const yesterdayId=await fixture({nextDate:yesterday,amount:15000}),todayId=await fixture({nextDate:today,amount:5000}),futureId=await fixture({nextDate:tomorrow});
  const draft=await fixture();await actor();await save(draft,{nextDate:yesterday});const r=await list({queue:'returns',limit:1});assert.equal(r.count,2);assert.equal(r.total_cents,20000);assert.equal(r.rows[0].id,yesterdayId);
  assert.equal(r.priority.due_count,2);assert.equal(r.priority.total_cents,20000);assert.equal(r.priority.next_title_id,yesterdayId);
  const filtered=await list({search:'texto inexistente',queue:'returns'});assert.equal(filtered.count,0);assert.equal(filtered.priority.due_count,2);assert.equal(filtered.priority.next_title_id,yesterdayId);
  assert(!r.rows.some(t=>[futureId,draft].includes(t.id)));await reject(()=>start(draft),'P0029');await start(todayId);
 });
 await test('server START blocks new titles until official due returns in that portfolio are addressed',async()=>{
  const ret=await fixture({nextDate:yesterday}),fresh=await fixture();await actor();assert.equal((await detail(fresh)).title.start_block_reason,'RETURN_PRIORITY');await reject(()=>start(fresh),'P0029');
  await start(ret);await save(ret,{finish:true,nextDate:today});await reject(()=>start(fresh),'P0029');
  await start(ret);await save(ret,{finish:true,nextDate:tomorrow});assert.equal((await detail(fresh)).title.can_start,true);await start(fresh);
 });
 await test('finance START priority is by target portfolio and collectors never access another wallet',async()=>{
  await fixture({nextDate:today});const other=await fixture({collector:agents[1]});await actor('gerente_geral');const r=await list({queue:'returns'});assert.equal(r.priority.collector_id,null);assert.equal(r.count,1);
  await start(other);await work(other,'PAUSE',null);await actor('contas_receber');await start(other);await work(other,'PAUSE',null);
  await actor();await reject(()=>detail(other));await reject(()=>start(other));const own=await list({queue:'returns',collector:agents[1]});assert.equal(own.count,0);assert.equal(own.priority.collector_id,agents[0]);assert.equal(own.priority.due_count,1);
 });
 await test('unassigned, pending, settled, today and future titles cannot START; pending leaves active but remains readable',async()=>{
  const pending=await fixture({status:'PENDING_VALIDATION'}),unassigned=await fixture({collector:null}),settled=await fixture({status:'VALIDATED'}),todayId=await fixture({days:0}),future=await fixture({days:-1});
  await actor('gerente_geral');for(const id of [pending,unassigned,settled])await reject(()=>start(id),'23514');for(const id of [todayId,future])await reject(()=>start(id));
  const active=await list(),all=await list({queue:'all'});assert(!active.rows.some(r=>r.id===pending));assert(all.rows.some(r=>r.id===pending));assert.equal((await detail(pending)).title.start_block_reason,'PENDING_VALIDATION');
  await reject(()=>save(pending),'23514');
 });
 await test('payment report adds real date once on the server and clears collection agenda without receipt',async()=>{
  const id=await fixture({nextDate:tomorrow});await actor();await start(id);const sentence=`Pagamento informado em ${today.split('-').reverse().join('/')}.`;
  const d=await detail(id),request=randomUUID(),args=[id,'TÍTULO PAGO','Comprovante informado', 'Antiga cobrança',tomorrow,d.title.revision,d.case.revision,today,true,request];
  const result=await scalar('SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',args);const pending=await title(id),after=await detail(id);
  assert.equal(pending.status,'PENDING_VALIDATION');assert.equal(pending.collector_id,agents[0]);assert.equal(pending.next_action,null);assert.equal(pending.next_action_date,null);
  assert.equal(after.case.next_action,'Aguardar validação de Contas a Receber');assert.equal(after.case.next_date,null);assert(after.case.observation.endsWith(sentence));assert.equal(after.case.observation.split(sentence).length-1,1);
  assert.equal(after.history[0].payment_date,today);assert.equal(after.history[0].observation,after.case.observation);assert.equal(after.timer.running,false);
  await owner();assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts WHERE title_id=$1',[id]),0);
  const before=await state();await actor();assert.deepEqual(await scalar('SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',args),result);assert.deepEqual(await state(),before);
 });
 await test('payment date already present is not duplicated; missing/future date and oversized appended notes fail atomically',async()=>{
  const id=await fixture();await actor();await start(id);for(const paymentDate of [null,tomorrow])await reject(()=>save(id,{status:'TÍTULO PAGO',paymentDate,finish:true}),'23514');
  await reject(()=>save(id,{status:'TÍTULO PAGO',paymentDate:today,finish:true,observation:'x'.repeat(4999)}),'23514');assert.equal((await detail(id)).timer.running,true);
  const sentence=`Pagamento informado em ${today.split('-').reverse().join('/')}.`;await save(id,{status:'TÍTULO PAGO',paymentDate:today,finish:true,observation:`Contato. ${sentence}`});assert.equal((await detail(id)).case.observation.split(sentence).length-1,1);
 });
 await test('NOT_LOCATED returns the same collector with today priority and resets paid case only through audited history',async()=>{
  const id=await fixture();await paid(id);await validate(id,'NOT_LOCATED');await actor();const d=await detail(id);
  assert.equal(d.title.status,'NOT_LOCATED');assert.equal(d.title.collector_id,agents[0]);assert.equal(d.title.next_action,'RETRY');assert.equal(d.title.next_action_date,today);
  assert.equal(d.case.status,'NOVO TÍTULO - COBRAR');assert.equal(d.case.next_action,'Retomar cobrança');assert.equal(d.case.payment_date,null);assert.equal(d.case.next_date,today);
  assert(d.case_history.some(e=>e.status==='TÍTULO PAGO'&&e.payment_date===today));assert.equal(d.title.return_due,true);assert.equal(d.workflow.started,false);
  const fresh=await fixture();await actor();await reject(()=>start(fresh),'P0029');await start(id);
 });
 await test('manual CR confirmation creates one nominal receipt and commission base uses the effective validated amount',async()=>{
  const id=await fixture({amount:12345});await paid(id);const receiptId=await validate(id,'CONFIRM',today);assert(receiptId);await reject(()=>validate(id,'CONFIRM',today),'23514');
  await actor('gerente_geral');const c=await scalar('SELECT public.receivable_commission_base($1,$2,NULL,0,100) AS r',[today,today]);const row=c.rows.find(r=>r.title_id===id);assert(row);assert.equal(row.amount_cents,12345);assert.equal(c.rule_status,'AGUARDANDO_REGRAS');
  assert.equal((await detail(id)).timer.running,false);await owner();assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts WHERE title_id=$1',[id]),1);
 });
 await test('a receipt independently closes all actors timers and an existing receipt blocks START even if source still OPEN',async()=>{
  const id=await fixture();await actor();await start(id);await actor('gerente_geral');await start(id);await receipt(id,12000);
  await actor();assert.equal((await detail(id)).timer.running,false);await reject(()=>start(id),'23514');await owner();const sessions=(await db.query('SELECT * FROM public.collection_work_sessions WHERE title_id=$1',[id])).rows;
  assert.equal(sessions.length,2);assert(sessions.every(s=>s.end_reason==='TITLE_SETTLED'&&s.ended_at));assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts WHERE title_id=$1',[id]),1);
 });
 await test('ERP actual received import closes official timers, preserves actual amount and never duplicates commission receipts',async()=>{
  const id=await fixture({amount:15000});await actor();await start(id);await actor('contas_receber');const t=await title(id),token=await scalar('SELECT public.get_receivables_sync_revision() AS r');
  const rows=[{document:t.document,client_name:t.client_name,client_document:null,branch:t.branch,issued_on:null,due_date:t.due_date,amount_cents:t.amount_cents,received_on:today,received_amount_cents:14750}];
  const bytes=Buffer.from(`ERP sintético ${++sequence}`),args=[users.contas_receber.id,users.contas_receber.session,'grupo-consolidado','synthetic-received.csv',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),'{}',token.import_id,token.financial_revision,false];
  await owner();await db.exec('SET ROLE service_role');await scalar('SELECT public.commit_receivables_received_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11) AS r',args);await actor();assert.equal((await detail(id)).timer.running,false);
  await actor('contas_receber');const effective=await scalar('SELECT to_jsonb(r) AS r FROM public.effective_receivable_receipts r WHERE title_id=$1',[id]);assert.equal(effective.amount_cents,14750);
  await owner();assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts WHERE title_id=$1',[id]),1);
 });
 await test('unavailable running interval is recoverable after reload without title data or agenda mutation',async()=>{
  const id=await fixture();await actor();await start(id);await owner();await db.query('UPDATE public.receivable_titles SET due_date=$1 WHERE id=$2',[tomorrow,id]);
  await actor();const r=await list({search:'nothing'});assert(!r.rows.some(t=>t.id===id));assert.equal(r.active_timer.title_id,id);assert.equal(r.active_timer.recovery_allowed,true);assert(!('client_name' in r.active_timer));
  await owner();const before=await title(id);await actor();const result=await work(id,'FINISH',null);assert.equal(result.running,false);await owner();assert.deepEqual(await title(id),before);await actor('cobradora_2');assert.equal((await list()).active_timer,null);
  const fresh=await fixture();await actor();await start(fresh);
 });
 await test('normal direct FINISH cannot bypass agenda, while pending recovery changes only own timer',async()=>{
  const id=await fixture();await actor();await start(id);await reject(()=>work(id,'FINISH',null),'23514');assert.equal((await detail(id)).timer.running,true);
  await owner();await db.query("UPDATE public.receivable_titles SET status='PENDING_VALIDATION',validation_status='PENDING',payment_source='IMPORTACAO_DIARIA' WHERE id=$1",[id]);
  await actor();assert.equal((await list()).active_timer.recovery_allowed,true);const before=await title(id);await work(id,'FINISH',null);assert.deepEqual(await title(id),before);
 });
 await test('legacy record action is not callable and all writes require an approved official role',async()=>{
  const id=await fixture();await actor();await reject(async()=>scalar('SELECT public.record_collection_action($1,$2,$3,$4,$5,$6,NULL,NULL,$7) AS r',[id,'OTHER',today,'OTHER',tomorrow,'Bypass',(await title(id)).revision]));
  for(const name of ['diretor','contas_pagar','rh_dp','cobradora_2']){await actor(name);await reject(()=>work(id,'START',1));await reject(()=>save(id));}
  await actor();await owner();await db.query('DELETE FROM cf_private.approved_sessions WHERE session_id=$1',[users.cobradora_1.session]);await actor();await reject(()=>list());await reject(()=>work(id,'START',1));
  await owner();await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[users.cobradora_1.session,users.cobradora_1.id]);
  for(const role of ['anon','service_role']){await owner();await db.exec(`SET ROLE ${role}`);await reject(()=>list());await reject(()=>work(id,'START',1));}
 });
 await test('forged finance grants do not widen collector wallets or permit validation',async()=>{
  const other=await fixture({collector:agents[1],nextDate:today});await owner();await db.exec("INSERT INTO public.role_permissions(role_key,resource,action) SELECT 'cobradora_1','contas_receber',unnest(ARRAY['read','write','import','validate']) ON CONFLICT DO NOTHING;");
  await actor();await reject(()=>detail(other));assert(!(await list()).rows.some(r=>r.id===other));await reject(()=>scalar('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5) AS r',[other,'CONFIRM',today,'Forjado',1]));
 });
 await test('stale title and case revisions, duplicate finalization and audit failures roll back all state',async()=>{
  const id=await fixture();await actor();await start(id);const before=await detail(id);await save(id);await reject(()=>save(id,{finish:true,caseRevision:before.case.revision}),'40001');
  await owner();await db.exec("CREATE FUNCTION public.reject_workflow_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic audit failure';END$$;CREATE TRIGGER reject_workflow_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_workflow_audit();");
  const snapshot=await state();await actor();await reject(()=>save(id,{finish:true}),'P0001');assert.deepEqual(await state(),snapshot);await db.exec('DROP TRIGGER reject_workflow_audit ON public.audit_events;DROP FUNCTION public.reject_workflow_audit();');
 });
 await test('closed intervals and financial amounts remain immutable through direct authenticated DML',async()=>{
  const id=await fixture();await actor();await start(id);await work(id,'PAUSE',null);await reject(()=>db.query('UPDATE public.collection_work_sessions SET ended_at=clock_timestamp() WHERE title_id=$1',[id]));
  await reject(()=>db.query('DELETE FROM public.collection_case_events WHERE title_id=$1',[id]));await reject(()=>db.query('UPDATE public.receivable_titles SET amount_cents=1 WHERE id=$1',[id]));
 });
}catch(e){failed++;console.error('SETUP FAILURE',e.stack??e.message,JSON.stringify({position:e.position,where:e.where}));}
finally{await db.close();}
console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
