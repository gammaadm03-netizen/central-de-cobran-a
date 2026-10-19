import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
// All people and financial values below are synthetic fixtures.
const db=new PGlite();let passed=0,failed=0;
const roles=['gerente_geral','diretor','rh_dp','contas_pagar','contas_receber','cobradora_1'];
const id=n=>`93000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const users=Object.fromEntries(roles.map((role,index)=>[role,{id:id(index+1),session:id(index+11)}]));
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].r;
const owner=()=>db.exec('RESET ROLE');
const actor=async role=>{await owner();await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[users[role].id,JSON.stringify({session_id:users[role].session})]);await db.exec('SET ROLE authenticated');};
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack??error.message,JSON.stringify({where:error.where,position:error.position}));}};
const reject=(fn,code='42501')=>assert.rejects(fn,error=>{assert.equal(error.code,code,error.message);return true;});
const row=(n,changes={})=>({source_row:n+1,branch:'FILIAL SINTÉTICA',employee:`Pessoa sintética ${n}`,sector:'OPERAÇÃO',admitted_on:'2020-10-10',birthday_on:'2000-10-20',salary_base_cents:200000,payroll_salary_cents:180000,transport_cents:12000,advance_cents:20000,total_cents:212000,count_label:String(n),...changes});
const fixture=[row(1),row(2,{sector:'SÓCIO',salary_base_cents:400000}),row(3,{employee:'Gabriel Pedrosa Marques Ferreira'}),row(4,{employee:'Gustavo Marques Ferreira',birthday_on:'2000-02-29'})];
const report=()=>scalar("SELECT public.hr_report('2026-10-01') AS r");
const preview=(rows=fixture,date='2026-10-19')=>scalar('SELECT public.preview_hr_import($1,$2) AS r',[JSON.stringify(rows),date]);
async function commit({role='rh_dp',rows=fixture,source='synthetic-source',date='2026-10-19',previous=null,name='folha.csv',session=users[role].session,hash}={}){
 await owner();await db.exec('SET ROLE service_role');const bytes=Buffer.from(source);
 return scalar('SELECT public.commit_hr_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8) AS r',[users[role].id,session,name,hash??createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),date,previous]);
}
try{
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 const names=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(name=>/^\d{3}_.*\.sql$/.test(name)&&Number(name.slice(0,3))<=31).sort();
 for(const name of names){
  if(name.startsWith('028_'))await db.exec(`CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
   GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;`);
  await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
 }
 for(const[role,u]of Object.entries(users)){await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[u.id,`${role}@example.invalid`]);await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)',[u.id,role]);await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[u.session,u.id]);}
 await db.exec(await readFile(new URL('../supabase/migrations/033_hr.sql',import.meta.url),'utf8'));
 await test('RH starts without people, source values or historical seed',async()=>{await actor('rh_dp');const result=await report();assert.equal(result.snapshot,null);assert.equal(result.rows.length,0);assert.equal(result.summary.employees,0);});
 let first;
 await test('RH canonical import preserves distinct salaries and original privately',async()=>{
  await actor('rh_dp');assert.equal((await preview()).previous_import_id,null);first=await commit();assert.equal(first.idempotent,false);
  await actor('rh_dp');const result=await report();assert.equal(result.rows.length,4);assert.equal(result.rows[0].salary_base_cents,200000);assert.equal(result.rows[0].payroll_salary_cents,180000);assert.equal(result.snapshot.reference_date,'2026-10-19');
  await reject(()=>db.query('SELECT * FROM cf_private.hr_imports'));
  await owner();assert.equal(await scalar("SELECT convert_from(original_bytes,'UTF8') AS r FROM cf_private.hr_imports"),'synthetic-source');
 });
 await test('RH applies original headcount, basket, birthdays and tenure rules exactly',async()=>{
  await actor('diretor');const result=await report();assert.equal(result.summary.employees,3);assert.equal(result.summary.partners,1);assert.equal(result.summary.salary_base_cents,600000);
  assert.equal(result.summary.basket_eligible,2);assert.equal(result.summary.basket_excluded,2);assert.equal(result.summary.basket_monthly_cents,22560);assert.equal(result.summary.basket_annual_cents,270720);
  assert.equal(result.summary.admissions,0);assert.equal(result.summary.birthdays,3);assert.equal(result.work_anniversaries.length,4);assert.equal(result.work_anniversaries[0].years,6);
  assert.equal(result.by_branch[0].count,4);assert.equal(result.by_branch[0].salary_base_cents,1000000);
  const feb=await scalar("SELECT public.hr_report('2026-02-01') AS r");assert.equal(feb.birthdays.length,1);assert.equal(feb.birthdays[0].day,29);
 });
 await test('RH permissions deny direct commit, unrelated roles, revoked sessions and stale Director grants',async()=>{
  for(const role of ['contas_pagar','contas_receber','cobradora_1']){await actor(role);await reject(report);await reject(preview);await reject(()=>commit({role,source:`denied-${role}`,previous:first.import_id}));}
  await actor('rh_dp');await reject(()=>scalar('SELECT public.commit_hr_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8)',[users.rh_dp.id,users.rh_dp.session,'x.csv','a'.repeat(64),'eA==',JSON.stringify(fixture),'2026-10-19',first.import_id]));
  await owner();await db.query("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('diretor','rh_dp','import'),('diretor','rh_dp','write'),('diretor','importar_bases','read') ON CONFLICT DO NOTHING");
  await actor('diretor');await reject(preview);await reject(()=>commit({role:'diretor',previous:first.import_id}));
  await reject(()=>commit({session:id(99),previous:first.import_id}));
 });
 await test('RH replay is idempotent and changed rows under same original are rejected',async()=>{
  assert.deepEqual(await commit(),{import_id:first.import_id,row_count:4,idempotent:true});
  await reject(()=>commit({rows:[row(1)],previous:first.import_id}),'22023');
  await owner();assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'),1);
 });
 await test('RH stale preview never overwrites a concurrent snapshot, and old snapshots remain',async()=>{
  await actor('rh_dp');const p=await preview();const second=await commit({source:'synthetic-next',previous:p.previous_import_id,rows:[row(1,{salary_base_cents:300000})]});
  await reject(()=>commit({source:'stale-source',previous:p.previous_import_id}),'40001');
  await actor('rh_dp');assert.equal((await report()).snapshot.id,second.import_id);assert.equal((await report()).rows[0].salary_base_cents,300000);
  await owner();assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'),2);assert.equal(await scalar('SELECT rows->0->>\'salary_base_cents\' AS r FROM cf_private.hr_imports WHERE id=$1',[first.import_id]),'200000');
 });
 await test('RH incomplete monetary fields stay unknown and report data-quality counts',async()=>{
  await actor('rh_dp');const p=await preview();await commit({source:'unknown-source',previous:p.previous_import_id,rows:[row(1,{branch:'',sector:'',admitted_on:null,birthday_on:null,salary_base_cents:null,transport_cents:null,advance_cents:null,total_cents:null})]});
  await actor('rh_dp');const result=await report();for(const key of ['salary_base_cents','transport_cents','advance_cents','total_cents'])assert.equal(result.summary[key],null);
  assert.equal(result.quality.missing_branch,1);assert.equal(result.quality.missing_admission,1);assert.equal(result.quality.missing_salary_base,1);assert.equal(result.by_branch[0].label,'NÃO INFORMADO');assert.equal(result.by_branch[0].salary_base_cents,null);
 });
 await test('RH invalid rows, dates, source hash and file paths fail atomically',async()=>{
  await actor('rh_dp');const p=await preview();
  for(const rows of [[],[row(1,{salary_base_cents:1.5})],[row(1,{employee:''})],[row(1,{birthday_on:'2020-02-31'})],[row(1,{source_row:2}),row(2,{source_row:2})],[{...row(1),role:'manager'}],[row(1,{salary_base_cents:9007199254740991}),row(2,{salary_base_cents:1})]])await reject(()=>commit({source:'invalid',rows,previous:p.previous_import_id}),rows.length===2&&rows[0].salary_base_cents===9007199254740991?'22003':'22023');
  await reject(()=>commit({source:'invalid-hash',hash:'f'.repeat(64),previous:p.previous_import_id}),'22023');
  for(const name of ['../folha.csv','C:\\folha.csv','folha.html','folha\n.csv'])await reject(()=>commit({source:'invalid-path',name,previous:p.previous_import_id}),'22023');
  await reject(()=>commit({source:'future',date:'2199-12-31',previous:p.previous_import_id}),'22023');
  await owner();assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.hr_imports'),3);assert.equal(await scalar("SELECT count(*)::integer AS r FROM public.audit_events WHERE entity='hr_imports'"),3);
 });
 await test('RH a late historical import stays historical and append-only history cannot be altered',async()=>{
  await actor('rh_dp');const current=(await report()).snapshot.id;const p=await preview();
  const historical=await commit({date:'2020-01-01',source:'historical-source',rows:[row(1,{salary_base_cents:100})],previous:p.previous_import_id});
  await actor('diretor');assert.equal((await report()).snapshot.id,current);assert.notEqual(historical.import_id,current);
  await owner();assert.equal(await scalar("SELECT relrowsecurity AS r FROM pg_class WHERE oid='cf_private.hr_imports'::regclass"),true);
  await reject(()=>db.query('UPDATE cf_private.hr_imports SET file_name=$1 WHERE id=$2',['changed.csv',current]));
  await reject(()=>db.query('DELETE FROM cf_private.hr_imports WHERE id=$1',[current]));
  await db.exec('SET ROLE service_role');await reject(()=>db.query('SELECT original_bytes FROM cf_private.hr_imports'));
 });
 await test('RH disabled identity and revoked approved session cannot import or read',async()=>{
  await owner();await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[users.rh_dp.id]);
  await actor('rh_dp');await reject(report);await reject(()=>commit({source:'disabled-source'}));
  await owner();await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1',[users.rh_dp.id]);
  await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[users.rh_dp.session,users.rh_dp.id]);
  await actor('rh_dp');await reject(report);await reject(()=>commit({source:'revoked-source'}));
 });
}finally{await db.close();}
console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
