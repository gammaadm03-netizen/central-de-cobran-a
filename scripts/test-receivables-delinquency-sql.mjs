import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivablesDelinquencySql } from './bundle-receivables-delinquency.mjs';

// PostgreSQL local descartável. Todas as identidades, datas e dívidas são sintéticas.
const f=await createCostFixture(),{db,users,id,owner,actor,scalar,file,snapshot}=f;
const installer=await buildReceivablesDelinquencySql();
let passed=0,sequence=50000,today,previous,baseline,importId;
const add=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const call=(a=null,b=null)=>scalar('SELECT public.receivables_daily_delinquency($1,$2) r',[a,b]);
const reject=async(fn,code='42501')=>{await db.exec('SAVEPOINT expected_error');try{await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}finally{await db.exec('ROLLBACK TO SAVEPOINT expected_error;RELEASE SAVEPOINT expected_error')}};
const test=async(name,fn)=>{await owner();await db.exec('BEGIN');try{await fn();passed++;console.log('PASS',name)}finally{await db.exec('ROLLBACK');await actor()}};
const newImport=async date=>{await owner();return scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode,created_at)
 VALUES('grupo-consolidado','base-sintetica.csv',lpad($1::text,64,'0'),$2,1,1,0,0,0,'OPEN',($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')+interval '12 hours') RETURNING id r`,[++sequence,users.manager.id,date])};
const title=async({amount=10000,due=add(previous,-10),created=baseline+'T12:00:00-03:00',status='OPEN',retired=false}={})=>{
 await owner();const n=++sequence,t=await scalar(`INSERT INTO public.receivable_titles(id,scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,status,validation_status,payment_date,created_at,first_import_id,last_import_id)
 VALUES($1,'grupo-consolidado',$2,$2,'Cliente sintético',cf_private.receivable_customer_key('Cliente sintético',NULL),'Filial sintética',$3,$4,$5,CASE WHEN $5='VALIDATED' THEN 'VALIDATED' ELSE 'NONE' END,CASE WHEN $5='VALIDATED' THEN $3::date END,$6,$7,$7) RETURNING to_jsonb(receivable_titles) r`,[id(n),'NF-SINT-'+n,due,amount,status,created,importId]);
 if(retired){await db.exec('ALTER TABLE public.receivable_titles DISABLE TRIGGER guard_receivable_report_retirement');try{await db.query('UPDATE public.receivable_titles SET retired_from_report=true WHERE id=$1',[t.id])}finally{await db.exec('ALTER TABLE public.receivable_titles ENABLE TRIGGER guard_receivable_report_retirement')}return scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1',[t.id])}return t;
};
const event=async(t,{at=previous+'T12:00:00-03:00',revision=1,extra={},omit=[]}={})=>{
 await owner();const value={...t,revision,...extra};for(const key of omit)delete value[key];
 await db.query(`INSERT INTO public.audit_events(occurred_at,module,entity,record_id,action,after_value) VALUES($1,'contas_receber','receivable_titles',$2,'UPDATE',$3::jsonb)`,[at,t.id,JSON.stringify(value)]);
};
const available=p=>{assert.equal(p.available,true);assert.equal(p.bands.length,6);assert.deepEqual(p.bands.map(b=>b.key),['1_30','31_60','61_90','91_180','181_365','ACIMA_365']);assert.equal(p.total_cents,p.bands.reduce((sum,b)=>sum+b.amount_cents,0));assert.equal(p.title_count,p.bands.reduce((sum,b)=>sum+b.title_count,0))};
const unavailable=p=>{assert.equal(p.available,false);assert.equal(p.total_cents,null);assert.equal(p.title_count,null);assert.equal(p.bands.length,6);assert(p.bands.every(b=>b.amount_cents===null&&b.title_count===null))};

try{
 await owner();for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql'])await db.exec(await file(name));
 today=await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");previous=add(today,-1);baseline=add(today,-5);
 assert.equal(await readFile(new URL('../supabase/dashboard/ativar-variacao-diaria-inadimplencia.sql',import.meta.url),'utf8'),installer);
 const before=await snapshot();await owner();await db.exec(installer);const after=await snapshot();delete before['public.central_schema_migrations'];delete after['public.central_schema_migrations'];assert.deepEqual(after,before);await db.exec(installer);assert.equal(await scalar("SELECT count(*)::integer r FROM public.central_schema_migrations WHERE version='051_receivables_daily_delinquency'"),1);console.log('PASS installer applies twice without changing operational data, accounts, permissions or audit');passed++;
 await test('without any current import both positions are unavailable, never zero',async()=>{await actor();const r=await call();assert.equal(r.as_of_date,today);assert.equal(r.timezone,'America/Sao_Paulo');assert.equal(r.first_available_date,null);assert.equal(r.previous.date,previous);assert.equal(r.current.date,today);unavailable(r.previous);unavailable(r.current);assert.equal(r.previous.partial,false);assert.equal(r.current.partial,true)});
 await owner();importId=await newImport(baseline);
 await test('imported empty portfolio has real zero balances and dates before the current base stay unavailable',async()=>{await actor();let r=await call();available(r.previous);available(r.current);assert.equal(r.current.total_cents,0);assert.equal(r.first_available_date,baseline);r=await call(add(baseline,-2),add(baseline,-1));unavailable(r.previous);unavailable(r.current);assert.equal(r.current.partial,false)});
 await test('dates must be increasing, not in the future, and at least 1900',async()=>{await actor();for(const dates of [[today,today],[today,previous],[previous,add(today,1)],['1899-12-31',today]])await reject(()=>call(...dates),'22023');const r=await call(null,previous);assert.equal(r.previous.date,add(previous,-1));assert.equal(r.current.date,previous);assert.equal(r.current.partial,false)});
 await test('all aging boundaries use each position date and keep future and due-today out',async()=>{
  const expected=[0,0,0,0,0,0],limits=[1,30,31,60,61,90,91,180,181,365,366];
  for(let i=0;i<limits.length;i++){const delay=limits[i],amount=(i+1)*101,t=await title({due:add(previous,-delay),amount});await event(t);const bucket=delay<=30?0:delay<=60?1:delay<=90?2:delay<=180?3:delay<=365?4:5;expected[bucket]+=amount}
  for(const due of [previous,add(previous,1)]){const t=await title({due,amount:99999});await event(t)}
  await actor();const r=await call();available(r.previous);assert.deepEqual(r.previous.bands.map(b=>b.amount_cents),expected);assert.equal(r.previous.title_count,limits.length);assert.equal(r.current.title_count,limits.length+1);assert.equal(r.current.bands[0].amount_cents,expected[0]-202+99999);assert.equal(r.current.bands[1].amount_cents,expected[1]+202-404);
 });
 await test('historical amounts, due dates and statuses come from the latest revision before the cutoff',async()=>{
  const t=await title({amount:7000,due:add(today,-100)});await event(t,{revision:1,extra:{amount_cents:1000,due_date:add(previous,-10)}});await event(t,{revision:2,extra:{amount_cents:2500,due_date:add(previous,-40)}});
  await actor();let r=await call();assert.equal(r.previous.total_cents,2500);assert.equal(r.previous.bands[1].amount_cents,2500);assert.equal(r.current.bands[3].amount_cents,7000);
  await event(t,{revision:3,extra:{status:'VALIDATED',validation_status:'VALIDATED',payment_date:previous}});await actor();r=await call();assert.equal(r.previous.total_cents,0);assert.equal(r.current.total_cents,7000);
 });
 await test('equal audit timestamps select highest title revision rather than arbitrary audit UUID',async()=>{
  const t=await title();await event(t,{revision:9,extra:{amount_cents:900}});await event(t,{revision:2,extra:{amount_cents:200}});await event(t,{revision:7,extra:{amount_cents:700}});await actor();assert.equal((await call()).previous.total_cents,900);
 });
 await test('São Paulo midnight excludes the following-day update even when it shares the UTC calendar date',async()=>{
  const t=await title();const midnight=await scalar("SELECT(($1::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')::text r",[previous]);const ms=Date.parse(midnight);await event(t,{at:new Date(ms-1).toISOString(),revision:2,extra:{amount_cents:1234}});await event(t,{at:new Date(ms).toISOString(),revision:3,extra:{amount_cents:9999}});await actor();assert.equal((await call()).previous.total_cents,1234);
 });
 await test('retired and validated titles leave the totals while pending validation remains overdue',async()=>{
  const pending=await title({amount:300,status:'PENDING_VALIDATION'}),settled=await title({amount:400,status:'VALIDATED'}),retired=await title({amount:500,retired:true});for(const t of [pending,settled,retired])await event(t);
  await actor();const r=await call();assert.equal(r.previous.total_cents,300);assert.equal(r.current.total_cents,300);assert.equal(r.previous.title_count,1);
 });
 await test('older audit rows without the later retirement column retain their original active state',async()=>{const t=await title({amount:567});await event(t,{omit:['retired_from_report']});await actor();assert.equal((await call()).previous.total_cents,567)});
 await test('a title first created today never appears in the previous day',async()=>{const t=await title({amount:222,created:today+'T00:00:00-03:00'});await actor();const r=await call();available(r.previous);assert.equal(r.previous.total_cents,0);assert.equal(r.current.total_cents,t.amount_cents)});
 await test('missing historical audit makes the whole historical position unavailable instead of silently omitting debt',async()=>{await title({amount:789});await actor();const r=await call();unavailable(r.previous);available(r.current);assert.equal(r.current.total_cents,789)});
 await test('preserved audit from removed test-base IDs cannot enter the current base',async()=>{const orphan={id:id(++sequence),scope:'grupo-consolidado',status:'OPEN',due_date:add(previous,-10),amount_cents:999999,retired_from_report:false,created_at:baseline+'T12:00:00-03:00'};await event(orphan);const t=await title({amount:321});await event(t);await actor();const r=await call();assert.equal(r.previous.total_cents,321);assert.equal(r.current.total_cents,321)});
 await test('total cents cannot exceed JavaScript safe integer precision',async()=>{for(const amount of [9007199254740991,1]){const t=await title({amount});await event(t)}await actor();await reject(()=>call(),'22003')});
 await test('dashboard and receivables readers receive totals without audit access, other profiles are denied',async()=>{
  for(const who of ['manager','director','cp','cr']){await actor(who);available((await call()).current)}
  for(const who of ['rh','collector']){await actor(who);await reject(()=>call())}
  await owner();await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[users.cr.id]);await actor('cr');await reject(()=>call());
 });
 await test('repeated reads never persist positions, alter titles or add audit events',async()=>{const t=await title({amount:618});await event(t);const before=await snapshot();await actor();const first=await call(),second=await call();assert.deepEqual(second,first);assert.deepEqual(await snapshot(),before)});
 await test('a full 980-title portfolio with several revisions returns integral totals efficiently',async()=>{
  await owner();await db.query(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,status,created_at,first_import_id,last_import_id)
   SELECT 'grupo-consolidado','SCALE-'||g,'NF-SCALE-'||g,'Cliente escala '||g,cf_private.receivable_customer_key('Cliente escala '||g,NULL),'Filial sintética',$1::date-10,100,'OPEN',$2::date::timestamp AT TIME ZONE 'America/Sao_Paulo',$3,$3 FROM generate_series(1,980)g`,[previous,baseline,importId]);
  await db.query(`INSERT INTO public.audit_events(occurred_at,module,entity,record_id,action,after_value)
   SELECT($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')+interval '12 hours','contas_receber','receivable_titles',t.id::text,'UPDATE',to_jsonb(t)||jsonb_build_object('revision',g)
   FROM public.receivable_titles t CROSS JOIN generate_series(1,4)g WHERE t.source_key LIKE 'SCALE-%'`,[previous]);
  await db.exec('ANALYZE public.audit_events;ANALYZE public.receivable_titles');await actor();const start=performance.now(),r=await call(),elapsed=Math.round(performance.now()-start);available(r.previous);available(r.current);assert.equal(r.previous.total_cents,98000);assert.equal(r.previous.title_count,980);assert.equal(r.current.total_cents,98000);console.log('PERF 980 títulos × 4 revisões: '+elapsed+' ms');
 });
 await test('revoked approved sessions cannot read the consolidated report',async()=>{await owner();await db.query('DELETE FROM cf_private.approved_sessions WHERE session_id=$1',[users.cr.session]);await actor('cr');await reject(()=>call())});
 await test('function ACL exposes only the aggregate public RPC to authenticated users',async()=>{
  await owner();for(const role of ['anon','service_role']){await db.exec('SET ROLE '+role);await reject(()=>call());await db.exec('RESET ROLE')}
  await actor('cp');await reject(()=>scalar('SELECT cf_private.receivables_delinquency_position($1,$2,$3) r',[previous,today,baseline]));assert.equal(await scalar("SELECT count(*)::integer r FROM public.audit_events WHERE entity='receivable_titles'"),0);
  await owner();assert.equal(await scalar("SELECT count(*)::integer r FROM pg_indexes WHERE indexname='receivable_title_audit_daily'"),1);
 });
 console.log(`${passed} daily delinquency SQL checks passed.`);
}finally{await db.close()}
