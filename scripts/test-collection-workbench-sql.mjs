import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Somente dados sintéticos em PostgreSQL descartável, sem conexão remota.
const db=new PGlite();
const roles=['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const id=n=>`96000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const users=Object.fromEntries(roles.map((r,i)=>[r,{id:id(i+1),session:id(i+11)}]));
const agents=[id(30),id(31)];let today,importId,sequence=100,passed=0,failed=0;
const migration=await readFile(new URL('../supabase/migrations/026_collection_workbench.sql',import.meta.url),'utf8');
const file=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const scalar=async(sql,args=[])=> (await db.query(sql,args)).rows[0].r;
const owner=()=>db.exec('RESET ROLE');
const actor=async(name='cobradora_1')=>{await owner();await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[
  users[name].id,JSON.stringify({session_id:users[name].session})]);await db.exec('SET ROLE authenticated');};
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack??e.message);}};
const reject=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
const title=titleId=>scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1',[titleId]);
const detail=titleId=>scalar('SELECT public.collection_case_detail($1) AS r',[titleId]);
const list=async(filters={})=>scalar(`SELECT public.collection_workbench($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS r`,[
  filters.search??'',filters.collector??null,filters.unassigned??false,filters.band??null,filters.sort??'delay_desc',filters.status??null,
  filters.offset??0,filters.limit??25,filters.queue??'active',filters.start??null,filters.end??null,filters.next??null,filters.financial??null]);
const work=(titleId,action,revision,request=randomUUID())=>scalar('SELECT public.collection_work_action($1,$2,$3,$4) AS r',[titleId,action,revision,request]);
const save=async(titleId,changes={})=>{
  const d=await detail(titleId);
  return scalar('SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',[
    titleId,changes.status??'COBRANCA POR WHATSAPP',changes.observation===undefined?'Observação sintética':changes.observation,
    changes.next===undefined?'Telefonar novamente':changes.next,changes.nextDate===undefined?today:changes.nextDate,
    changes.revision??d.title.revision,changes.caseRevision??d.case.revision,changes.paymentDate??null,changes.finish??false,changes.request??randomUUID()]);
};
const summary=(start=today,end=today,collector=null)=>scalar('SELECT public.collection_work_summary($1,$2,$3) AS r',[start,end,collector]);
const fixture=async(options={})=>{
  await owner();const n=++sequence,r={days:10,amount:10000,collector:agents[0],status:'OPEN',...options};
  return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,
   collector_id,status,validation_status,payment_source,payment_date,first_import_id,last_import_id)
   VALUES('grupo-consolidado',$1,$2,$3,cf_private.receivable_customer_key($3,NULL),'Filial sintética',$4::date-$5::int,$6,$7,$8,$9,$10,
   CASE WHEN $8='VALIDATED' THEN $4::date END,$11,$11) RETURNING id AS r`,[
    `synthetic-${n}`,`NF-${n}`,`Cliente sintético ${n}`,today,r.days,r.amount,r.collector,r.status,
    r.status==='VALIDATED'?'VALIDATED':r.status==='PENDING_VALIDATION'?'PENDING':'NONE',
    ['VALIDATED','PENDING_VALIDATION'].includes(r.status)?'IMPORTACAO_DIARIA':null,importId]);
};
const state=async()=>{
  await owner();const state={};
  for(const table of ['receivable_titles','receivable_imports','receivable_receipts','receivable_collection_events','audit_events',
    'collection_cases','collection_case_events','collection_work_sessions','collection_work_requests','bank_accounts'])
    state[table]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS r FROM public.${table} t`);
  state.revision=await scalar('SELECT revision::text AS r FROM cf_private.collection_workbench_state');return state;
};
const unchanged=async(fn)=>{const before=await state();await actor();await fn();assert.deepEqual(await state(),before);};

try{
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
  GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 for(const name of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql',
  '007_director_positions.sql','008_receivables.sql','009_collections.sql'])await db.exec(await file(name));
 await test('022 dependency is explicit and failed activation leaves no partial workbench',async()=>{
  await reject(()=>db.exec(migration),'22023');await db.exec('ROLLBACK');
  assert.equal(await scalar("SELECT to_regclass('public.collection_cases')::text AS r"),null);
 });
 await db.exec(await file('022_collections_overdue_only.sql'));await db.exec(await file('025_collections_management.sql'));
 for(const[name,u]of Object.entries(users)){
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[u.id,`${name}@example.invalid`]);
  await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)',[u.id,name]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[u.session,u.id]);
 }
 for(const[i,agent]of agents.entries()){
  await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,`Responsável sintética ${i+1}`]);
  await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users[`cobradora_${i+1}`].id,agent,users.gerente_geral.id]);
 }
 today=await scalar("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS r");
 importId=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count)
  VALUES('grupo-consolidado','synthetic.csv',repeat('a',64),$1,1,1,0,0,0) RETURNING id AS r`,[users.gerente_geral.id]);
 const a=await fixture(),b=await fixture({days:40,amount:20000}),other=await fixture({collector:agents[1],amount:30000});
 const unassigned=await fixture({collector:null,amount:40000}),dueToday=await fixture({days:0}),future=await fixture({days:-10}),settled=await fixture({status:'VALIDATED'});
 await test('activation preserves all old financial, ownership and audit records without backfill',async()=>{
  await owner();const before={};for(const table of ['receivable_titles','receivable_receipts','receivable_collection_events','audit_events','bank_accounts'])
   before[table]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS r FROM public.${table} t`);
  await db.exec(migration);const after=await state();for(const[key,value]of Object.entries(before))assert.deepEqual(after[key],value);
  assert.equal(after.collection_cases.length,0);assert.equal(after.collection_work_sessions.length,0);assert.equal(after.revision,'0');
 });
 await test('read scopes enforce own wallet, strict past-due and Director read-only',async()=>{
  for(const name of roles){
   await actor(name);
   if(['gerente_geral','contas_receber','diretor','cobradora_1','cobradora_2'].includes(name)){
    const r=await list();assert.equal(r.as_of_date,today);
    assert.equal(r.count,['gerente_geral','contas_receber','diretor'].includes(name)?4:name==='cobradora_1'?2:1);
    assert(!r.rows.some(t=>[future,dueToday,settled].includes(t.id)));
   }else await reject(()=>list());
  }
  await actor('cobradora_1');await reject(()=>detail(other));await reject(()=>detail(future));await reject(()=>detail(unassigned));
  await actor('diretor');await reject(()=>work(a,'START',1));await reject(()=>save(a));
  for(const role of ['anon','service_role']){await owner();await db.exec(`SET ROLE ${role}`);await reject(()=>list());}
 });
 await test('filters, precise server totals, pagination and stable sorting use the full visible wallet',async()=>{
  await actor('gerente_geral');const first=await list({limit:1,sort:'amount_asc'});assert.equal(first.count,4);assert.equal(first.total_cents,100000);assert.equal(first.rows.length,1);
  assert.equal(first.rows[0].id,a);assert.equal((await list({unassigned:true})).rows[0].id,unassigned);
  assert.equal((await list({collector:agents[1]})).count,1);assert.equal((await list({band:'31_60'})).rows[0].id,b);
  assert.equal((await list({start:today,end:today})).count,0);assert.equal((await list({queue:'history'})).rows[0].id,settled);
  assert.equal((await list({search:'%'})).count,0);assert.equal((await list({sort:'amount_desc',limit:1})).rows[0].id,unassigned);
  assert.equal((await list({financial:'ACTIVE'})).count,4);assert.equal((await list({next:'NONE'})).count,4);
  await reject(()=>list({sort:'forged'}),'22023');await reject(()=>list({limit:501}),'22023');await reject(()=>list({unassigned:true,collector:agents[0]}),'22023');
 });
 let startRequest,startResult;
 await test('START persists server time, requires assigned active title and permits one running title per actor',async()=>{
  await actor();assert.equal((await detail(a)).case.revision,0);startRequest=randomUUID();startResult=await work(a,'START',1,startRequest);
  assert.equal(startResult.running,true);assert(startResult.started_at);assert(startResult.session_id);
  assert.equal((await detail(a)).case.revision,0);assert.equal((await detail(a)).timer.session_id,startResult.session_id);
  const duplicate=await work(a,'START',1);assert.equal(duplicate.session_id,startResult.session_id);
  await reject(()=>work(b,'START',1),'23514');await reject(()=>work(other,'START',1));await reject(()=>work(future,'START',1));
  await actor('gerente_geral');await reject(()=>work(unassigned,'START',1),'23514');await reject(()=>work(settled,'START',1),'23514');
 });
 let paused;
 await test('reload preserves running interval; PAUSE uses server elapsed time and is retry-idempotent',async()=>{
  await actor();await db.query('SELECT pg_sleep(1.05)');const d=await detail(a);assert.equal(d.timer.running,true);assert(d.timer.elapsed_seconds>=1);
  assert(d.timer.actor_total_seconds>=1);const request=randomUUID();paused=await work(a,'PAUSE',999999,request);
  assert.equal(paused.running,false);assert.equal(paused.started_at,null);assert.equal(paused.elapsed_seconds,0);assert(paused.actor_total_seconds>=1);
  const before=await state();await actor();assert.deepEqual(await work(a,'PAUSE',999999,request),paused);assert.deepEqual(await state(),before);
  await actor();assert.equal((await work(a,'PAUSE',null)).actor_total_seconds,paused.actor_total_seconds);
  const replay=await work(a,'START',1,startRequest);assert.deepEqual(replay,startResult);assert.equal((await detail(a)).timer.running,false);
 });
 await test('request IDs cannot be reused with a changed action or another title',async()=>{
  await unchanged(()=>reject(()=>work(a,'FINISH',1,startRequest),'22023'));
  await actor();await reject(()=>work(a,'START',1,null),'22023');
 });
 await test('draft saves status and free-text agenda without fabricating contact, payment, time or owner changes',async()=>{
  await actor();const t=await title(a),eventsBefore=await scalar('SELECT count(*)::int AS r FROM public.receivable_collection_events');
  const r=await save(a,{observation:'Rascunho sintético',next:'Conferir protocolo livre',nextDate:null});assert.equal(r.finished,false);assert.equal(r.case_revision,1);assert.equal(r.event_id,null);
  assert.deepEqual(await title(a),t);assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_collection_events'),eventsBefore);
  const d=await detail(a);assert.equal(d.case.next_action,'Conferir protocolo livre');assert.equal(d.case.next_date,null);assert.equal(d.case_history.length,1);
 });
 await test('case and title revisions reject stale tabs and snapshot revision also covers draft-only changes',async()=>{
  await actor();const before=await list();await save(a,{next:'Nova agenda'});const after=await list();assert.notEqual(after.snapshot_revision,before.snapshot_revision);
  await unchanged(()=>reject(()=>save(a,{caseRevision:1}),'40001'));
  await actor();await reject(()=>save(a,{revision:99999}),'40001');
 });
 await test('Finalizar requires owner, observation and nonpaid free-text next action/date',async()=>{
  await unchanged(async()=>{
   for(const changes of [{observation:' '},{observation:'\u00a0\uFEFF'},{next:' '},{next:'\u00a0\uFEFF'},{nextDate:null}])await reject(()=>save(a,{...changes,finish:true}),'23514');
   await actor('gerente_geral');await reject(()=>save(unassigned,{finish:true}),'23514');
  });
 });
 await test('Finalizar atomically records official contact and agenda and ends only the current actor interval',async()=>{
  await actor();const started=await work(a,'START',(await title(a)).revision);const result=await save(a,{finish:true,next:'Enviar proposta comercial livre'});
  assert.equal(result.finished,true);assert.equal(result.timer.running,false);assert(result.event_id);assert.equal((await title(a)).last_action,'CONTACT');
  assert.equal((await title(a)).next_action,'OTHER');assert.equal((await title(a)).next_action_date,today);
  assert.equal((await detail(a)).work_sessions.find(s=>s.id===started.session_id).end_reason,'FINISH');
  assert.equal((await title(a)).status,'OPEN');assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts'),0);
 });
 await test('finalizing without START is allowed and never invents a work interval',async()=>{
  await actor();const result=await save(b,{finish:true,status:'SEM SUCESSO'});assert.equal(result.timer.actor_total_seconds,0);
  assert.equal((await detail(b)).work_sessions.length,0);assert.equal((await title(b)).last_action,'NO_RESPONSE');
 });
 await test('paid draft needs actual date but only Finalizar reports PAID awaiting financial validation',async()=>{
  await actor();await reject(()=>save(b,{status:'TÍTULO PAGO',paymentDate:null}),'23514');
  await save(b,{status:'TÍTULO PAGO',paymentDate:today,next:null,nextDate:null});assert.equal((await title(b)).status,'OPEN');
  const d=await detail(b),request=randomUUID();
  const args=[b,'TÍTULO PAGO','Pagamento informado sintético',null,null,d.title.revision,d.case.revision,today,true,request];
  const sql='SELECT public.save_collection_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r';
  const result=await scalar(sql,args);const t=await title(b);assert.equal(t.status,'PENDING_VALIDATION');assert.equal(t.payment_source,'COBRANCA');
  assert.equal(t.payment_date,null);assert.equal(t.payment_reported_date,today);assert.equal(t.reported_in_collection,true);
  assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts'),0);
  const before=await state();await actor();assert.deepEqual(await scalar(sql,args),result);assert.deepEqual(await state(),before);
  await actor();assert.equal((await list({financial:'PENDING_VALIDATION'})).rows[0].id,b);
  assert.equal((await list({status:'TÍTULO PAGO'})).rows[0].id,b);
 });
 await test('re-finalizing the same pending paid report does not duplicate PAID or clear its financial queue',async()=>{
  await actor();const count=await scalar("SELECT count(*)::int AS r FROM public.receivable_collection_events WHERE title_id=$1 AND action='PAID'",[b]);
  await save(b,{status:'TÍTULO PAGO',paymentDate:today,next:null,nextDate:null,finish:true});
  assert.equal(await scalar("SELECT count(*)::int AS r FROM public.receivable_collection_events WHERE title_id=$1 AND action='PAID'",[b]),count);
  assert.equal((await title(b)).status,'PENDING_VALIDATION');
 });
 await test('paid Finalizar replaces a prior collection agenda with financial validation while preserving its history',async()=>{
  const target=await fixture();await actor();
  const nextDay=await scalar('SELECT ($1::date+1)::text AS r',[today]);
  await save(target,{finish:true,next:'Retornar ao cliente após conferir protocolo',nextDate:nextDay});
  const before=await title(target),receiptCount=await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts');
  assert.equal(before.next_action_date,nextDay);assert.equal(before.next_action,'OTHER');
  await save(target,{status:'TÍTULO PAGO',paymentDate:today,finish:true,
   next:'Retornar ao cliente após conferir protocolo',nextDate:nextDay});
  const d=await detail(target);assert.equal(d.title.status,'PENDING_VALIDATION');assert.equal(d.title.payment_source,'COBRANCA');
  assert.equal(d.title.next_action,null);assert.equal(d.title.next_action_date,null);assert.equal(d.title.collector_id,before.collector_id);
  assert.equal(d.case.next_action,'VALIDAÇÃO FINANCEIRA');assert.equal(d.case.next_date,null);
  assert(d.history.some(e=>e.next_date===nextDay&&e.return_note?.includes('Retornar ao cliente após conferir protocolo')));
  assert(d.case_history.some(e=>e.next_date===nextDay&&e.next_action==='Retornar ao cliente após conferir protocolo'));
  assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts'),receiptCount);
  await owner();const audit=await scalar(`SELECT to_jsonb(a) AS r FROM public.audit_events a
   WHERE entity='receivable_titles' AND record_id=$1 AND after_value->>'status'='PENDING_VALIDATION'
   ORDER BY occurred_at DESC LIMIT 1`,[target]);
  assert.equal(audit.before_value.next_action_date,nextDay);assert.equal(audit.after_value.next_action_date,null);
 });
 await test('audit failure rolls back PAID, draft, event, timer closure and idempotency result atomically',async()=>{
  const target=await fixture();await actor();await work(target,'START',1);
  await owner();await db.exec(`CREATE FUNCTION public.reject_work_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
   IF NEW.entity='collection_case_events' THEN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE='P0099';END IF;RETURN NEW;END$$;
   CREATE TRIGGER reject_work_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_work_audit();`);
  try{await unchanged(()=>reject(()=>save(target,{status:'TÍTULO PAGO',paymentDate:today,finish:true,next:null,nextDate:null}),'P0099'));}
  finally{await owner();await db.exec('DROP TRIGGER reject_work_audit ON public.audit_events;DROP FUNCTION public.reject_work_audit()');}
  await actor();await work(target,'PAUSE',1);
 });
 await test('financial validation closes running time at server validation time and leaves immutable history',async()=>{
  await actor();await work(b,'START',(await title(b)).revision);await actor('contas_receber');
  await scalar("SELECT public.validate_receivable_payment($1,'CONFIRM',$2,'Conferência financeira sintética',$3) AS r",[b,today,(await title(b)).revision]);
  await actor();const d=await detail(b);assert.equal(d.title.status,'VALIDATED');assert.equal(d.timer.running,false);assert.equal(d.work_sessions[0].end_reason,'TITLE_SETTLED');
  await reject(()=>save(b,{finish:true}),'23514');await reject(()=>work(b,'START',d.title.revision),'23514');
  assert.equal((await work(b,'PAUSE',1)).running,false);assert(!(await list()).rows.some(t=>t.id===b));assert((await list({queue:'history'})).rows.some(t=>t.id===b));
  await owner();await reject(()=>db.query('DELETE FROM public.collection_work_sessions WHERE title_id=$1',[b]));
  await reject(()=>db.query("UPDATE public.collection_work_sessions SET started_at=started_at-interval '1 hour' WHERE title_id=$1",[b]));
 });
 await test('another operator cannot stop an actor timer; own stop remains allowed after wallet reassignment',async()=>{
  const target=await fixture();await actor();await work(target,'START',1);
  await actor('gerente_geral');await work(target,'PAUSE',1);await actor();assert.equal((await detail(target)).timer.running,true);
  await owner();await db.query('UPDATE public.receivable_titles SET collector_id=$1 WHERE id=$2',[agents[1],target]);
  await actor();await reject(()=>detail(target));const result=await work(target,'PAUSE',1);assert.equal(result.running,false);
 });
 await test('period summary is based on server intervals and own wallet, with Director read-only full totals',async()=>{
  await actor();const s=await summary();assert(s.total_seconds>=1);assert(s.session_count>=3);assert(s.title_count>=2);assert.equal(s.running_count,0);
  assert(s.rows.every(r=>r.actor_id===users.cobradora_1.id));assert.equal(s.truncated,false);assert.equal(s.start,today);
  assert.equal(s.by_collector.reduce((sum,r)=>sum+r.total_seconds,0),s.total_seconds);
  await actor('cobradora_2');const otherSummary=await summary();assert(otherSummary.rows.every(r=>r.collector_id===agents[1]));
  await actor('diretor');const director=await summary();assert(director.total_seconds>=s.total_seconds);assert.equal((await summary(null,null)).as_of_date,today);
  await reject(()=>summary(null,today),'22023');await reject(()=>summary('1900-01-01','2199-12-31'),'22023');
 });
 await test('protected tables deny direct writes and RLS hides another wallet and request result history',async()=>{
  await actor();await reject(()=>db.query("UPDATE public.collection_cases SET status='SEM SUCESSO'"));
  await reject(()=>db.query('INSERT INTO public.collection_work_sessions(title_id,actor_id,collector_id) VALUES($1,$2,$3)',[a,users.cobradora_1.id,agents[0]]));
  await reject(()=>db.query('SELECT * FROM public.collection_work_requests'));
  await actor('cobradora_2');assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_cases WHERE title_id=$1',[a]),0);
  assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_work_sessions WHERE title_id=$1',[a]),0);
 });
 await test('revoked or expired approved sessions and forged Director role never permit mutations',async()=>{
  await owner();await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[users.cobradora_1.session,users.cobradora_1.id]);
  try{await actor();await reject(()=>list());await reject(()=>work(a,'PAUSE',1));}finally{await owner();await db.query('DELETE FROM cf_private.revoked_sessions WHERE session_id=$1',[users.cobradora_1.session]);}
  await actor('diretor');await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({session_id:users.diretor.session,role:'gerente_geral'})]);
  await reject(()=>work(a,'START',1));await reject(()=>save(a));
 });
 await test('search includes operational status and observations and preserves old contact notes without inventing a channel',async()=>{
  const legacy=await fixture();await actor();
  await scalar("SELECT public.record_collection_action($1,'CONTACT',$2,'RETRY',$2,'Observação histórica única XYZ',NULL,NULL,1) AS r",[legacy,today]);
  const d=await detail(legacy);assert.equal(d.title.operational_label,'Sem status operacional');assert.equal(d.title.legacy_worked,true);
  assert.equal(d.case.observation,'Observação histórica única XYZ');assert.equal(d.case.next_action,'Nova tentativa');assert.equal(d.case.next_date,today);
  assert.equal((await list({search:'histórica única XYZ'})).rows[0].id,legacy);
  assert((await list({search:'SEM SUCESSO',queue:'all'})).count>=0);
  await save(legacy,{status:'SEM SUCESSO',observation:'Busca status caso ZQZ'});
  assert.equal((await list({search:'Busca status caso ZQZ'})).rows[0].id,legacy);
  assert((await list({search:'SEM SUCESSO'})).rows.some(t=>t.id===legacy));
 });
 await test('accidental CR.read grant cannot expand a collector portfolio or expose another actor time',async()=>{
  await actor('gerente_geral');const revision=(await title(a)).revision;
  await work(a,'START',revision);await work(a,'PAUSE',revision);
  await owner();await db.exec("INSERT INTO public.role_permissions VALUES('cobradora_1','contas_receber','read')");
  try{
   await actor();await reject(()=>detail(other));assert(!(await list()).rows.some(t=>t.id===other));
   assert((await detail(a)).work_sessions.every(s=>s.actor_id===users.cobradora_1.id));
   assert((await summary()).rows.every(s=>s.actor_id===users.cobradora_1.id));
   assert((await db.query('SELECT actor_id FROM public.collection_work_sessions')).rows.every(s=>s.actor_id===users.cobradora_1.id));
  }finally{await owner();await db.exec("DELETE FROM public.role_permissions WHERE role_key='cobradora_1' AND resource='contas_receber' AND action='read'");}
 });
 await test('historical own time survives future rescheduling and reassignment without exposing current title facts',async()=>{
  const target=await fixture();await actor();await work(target,'START',1);await work(target,'PAUSE',1);
  const oldName=(await title(target)).client_name;
  await owner();await db.query("UPDATE public.receivable_titles SET due_date=$1::date+10,collector_id=$2,client_name='Nome atual de outra carteira',customer_key=cf_private.receivable_customer_key('Nome atual de outra carteira',NULL) WHERE id=$3",[today,agents[1],target]);
  await actor();await reject(()=>detail(target));assert(!(await list({queue:'all'})).rows.some(t=>t.id===target));
  const historical=(await summary()).rows.find(s=>s.title_id===target);assert(historical);assert.equal(historical.client_name,oldName);assert.equal(historical.actor_id,users.cobradora_1.id);
  assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_work_sessions WHERE title_id=$1',[target]),1);
  await actor('cobradora_2');assert(!(await summary()).rows.some(s=>s.title_id===target));
 });
 await test('São Paulo day splitting preserves exact integer totals, nonnegative seconds and period clipping',async()=>{
  const target=await fixture();await owner();
  // Um intervalo sintético cruza a meia-noite de São Paulo em data histórica.
  await db.query(`INSERT INTO public.collection_work_sessions(title_id,actor_id,collector_id,document_snapshot,client_name_snapshot,branch_snapshot,collector_name_snapshot,started_at,ended_at,end_reason)
   VALUES($1,$2,$3,'NF-SP','Cliente sintético SP','Filial sintética','Responsável sintética 1','2020-01-02T02:59:58.200Z','2020-01-02T03:00:02.500Z','PAUSE')`,[target,users.cobradora_1.id,agents[0]]);
  await actor();const full=await summary('2020-01-01','2020-01-02');assert.equal(full.total_seconds,4);assert.equal(full.rows[0].seconds,4);
  assert.equal(full.by_day.reduce((sum,r)=>sum+r.total_seconds,0),4);assert(full.by_day.every(r=>r.total_seconds>=0));
  assert.equal((await summary('2020-01-01','2020-01-01')).total_seconds,1);assert.equal((await summary('2020-01-02','2020-01-02')).total_seconds,2);
  assert.equal((await summary('2019-12-31','2019-12-31')).total_seconds,0);
 });
 await test('own active timer is recoverable after reload, filters, future rescheduling and changed binding',async()=>{
  const target=await fixture();await actor();const started=await work(target,'START',1);
  const filtered=await list({search:'no matching synthetic document'});assert.equal(filtered.rows.length,0);
  assert.equal(filtered.active_timer.session_id,started.session_id);assert.equal(filtered.active_timer.title_id,target);
  await db.query('SELECT pg_sleep(1.05)');
  await owner();await db.query('UPDATE public.receivable_titles SET due_date=$1::date+20 WHERE id=$2',[today,target]);
  await actor();const reloaded=await list();assert(!reloaded.rows.some(t=>t.id===target));
  assert.equal(reloaded.active_timer.session_id,started.session_id);assert.equal(reloaded.active_timer.running,true);
  assert.equal(reloaded.active_timer.total_seconds,reloaded.active_timer.actor_total_seconds);
  assert(!('document' in reloaded.active_timer));assert(!('client_name' in reloaded.active_timer));
  await actor('cobradora_2');assert.equal((await list()).active_timer,null);
  await actor('gerente_geral');assert.equal((await list()).active_timer,null);
  await owner();await db.query('DELETE FROM public.collector_bindings WHERE user_id=$1',[users.cobradora_2.id]);
  await db.query('UPDATE public.collector_bindings SET agent_id=$1 WHERE user_id=$2',[agents[1],users.cobradora_1.id]);
  try{
   await actor();const changedBinding=(await list()).active_timer;assert.equal(changedBinding.session_id,started.session_id);
   assert(changedBinding.actor_total_seconds>=1);assert.equal(changedBinding.total_seconds,changedBinding.actor_total_seconds);
   const stopped=await work(target,'PAUSE',null);assert.equal(stopped.running,false);assert.equal((await list()).active_timer,null);
   const currentRevision=(await title(other)).revision;const next=await work(other,'START',currentRevision);assert(next.running);
   await work(other,'PAUSE',null);
  }finally{
   await owner();await db.query('UPDATE public.collector_bindings SET agent_id=$1 WHERE user_id=$2',[agents[0],users.cobradora_1.id]);
   await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users.cobradora_2.id,agents[1],users.gerente_geral.id]);
  }
 });
 await test('023/024 can activate after workbench and preserve all work and financial history',async()=>{
  const before=await state();await db.exec(await file('023_receivable_sync.sql'));await db.exec(await file('024_receivable_received_import.sql'));
  const after=await state();for(const row of after.receivable_imports)delete row.import_mode;
  assert.deepEqual(after,before);await actor('diretor');assert((await list()).count>0);
 });
 console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
}finally{await db.close();}
