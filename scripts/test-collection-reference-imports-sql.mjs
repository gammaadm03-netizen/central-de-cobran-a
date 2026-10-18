import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
// PostgreSQL descartável; nomes, contatos e arquivos exclusivamente sintéticos.
const db=new PGlite(),roles=['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const uuid=n=>`97000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const users=Object.fromEntries(roles.map((r,i)=>[r,{id:uuid(i+1),session:uuid(i+11)}]));
const agents=[uuid(30),uuid(31)];let today,importId,sequence=100,passed=0,failed=0;
const sql=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const scalar=async(s,args=[]) => (await db.query(s,args)).rows[0].r;
const owner=()=>db.exec('RESET ROLE');
const actor=async(name='contas_receber')=>{await owner();await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[users[name].id,JSON.stringify({session_id:users[name].session})]);await db.exec('SET ROLE authenticated');};
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message,JSON.stringify({position:e.position,internalPosition:e.internalPosition,internalQuery:e.internalQuery,where:e.where}));}};
const reject=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
const fixture=async(options={})=>{await owner();const n=++sequence,r={days:10,name:`Cliente sintético ${n}`,document:`NF-${n}`,branch:'Filial sintética',amount:10000,collector:agents[0],status:'OPEN',cnpj:null,...options};
 return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,client_document,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_date,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$2,$3,$4,cf_private.receivable_customer_key($3,$4),$5,$6::date-$7::int,$8,$9,$10,$11,$12,CASE WHEN $10='VALIDATED' THEN $6::date END,$13,$13) RETURNING id AS r`,[`synthetic-${n}`,r.document,r.name,r.cnpj,r.branch,today,r.days,r.amount,r.collector,r.status,r.status==='VALIDATED'?'VALIDATED':'NONE',r.status==='VALIDATED'?'IMPORTACAO_DIARIA':null,importId]);};
const context=id=>scalar('SELECT public.collection_customer_context($1) AS r',[id]);
const save=async(id,{emails=[],phones=[],notes=null,revision,request=randomUUID()}={})=>{const c=revision===undefined?await context(id):null;return scalar('SELECT public.save_collection_customer_contacts($1,$2::jsonb,$3::jsonb,$4,$5,$6) AS r',[id,JSON.stringify(emails),JSON.stringify(phones),notes,revision??c.contact.revision,request]);};
const report=(options={})=>scalar('SELECT public.collection_customer_contact_report($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',[options.search??'',options.collector??null,options.coverage??'ALL',options.start??null,options.end??null,options.by??null,options.offset??0,options.limit??25,options.view??'coverage',options.revision??null]);
const financialState=async()=>{await owner();const s={};for(const t of ['receivable_titles','receivable_receipts','receivable_imports','receivable_collection_events','bank_accounts'])s[t]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS r FROM public.${t} t`);return s;};
const setup=async()=>{
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 for(const f of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql','007_director_positions.sql','008_receivables.sql','009_collections.sql','022_collections_overdue_only.sql','023_receivable_sync.sql','024_receivable_received_import.sql','025_collections_management.sql','026_collection_workbench.sql'])await db.exec(await sql(f));
 for(const[r,u]of Object.entries(users)){await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[u.id,`${r}@example.invalid`]);await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)',[u.id,r]);await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[u.session,u.id]);}
 for(const[i,a]of agents.entries()){await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[a,`Responsável sintética ${i+1}`]);await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users[`cobradora_${i+1}`].id,a,users.gerente_geral.id]);}
 today=await scalar("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS r");
 importId=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count)VALUES('grupo-consolidado','synthetic.csv',repeat('a',64),$1,1,1,0,0,0) RETURNING id AS r`,[users.contas_receber.id]);
};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
let currentActor='contas_receber';
const as=async name=>{currentActor=name;await actor(name);};
const gateway=async(name,args=[])=>{await owner();await db.exec('SET ROLE service_role');try{return await scalar(`SELECT public.${name}(${[users[currentActor].id,users[currentActor].session,...args].map((_,i)=>'$'+(i+1)).join(',')}) AS r`,[users[currentActor].id,users[currentActor].session,...args]);}finally{await db.exec('RESET ROLE;SET ROLE authenticated');}};
const contact=(name,extra={})=>({source_line:1,client_name:name,client_document:null,emails:['financeiro@example.invalid'],phones:[],notes:null,...extra});
const description=(name,document,extra={})=>({source_line:1,client_name:name,client_document:null,document,branch:'Filial sintética',description:'Descrição sintética',contract:null,...extra});
const begin=async(mode,name=`source-${++sequence}`)=>{const bytes=Buffer.from(`Original sintético privado ${name}`),job=await gateway('begin_collection_reference_import_from_gateway',[mode,`${name}.xlsx`,bytes.length,digest(bytes)]);return {...job,bytes};};
const upload=async job=>{await actor(currentActor);await db.query('INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3::jsonb)',['collection-reference-files',job.storage_path,JSON.stringify({size:job.bytes.length})]);};
const verify=job=>gateway('verify_collection_reference_original_from_gateway',[job.job_id,digest(job.bytes),job.bytes.length]);
const chunk=rows=>{const csv=Buffer.from('source_line,synthetic\n'+rows.map(r=>`${r.source_line},${r.client_name}`).join('\n'));return {bytes:csv,hash:digest(csv),base64:csv.toString('base64')};};
const stage=(job,rows,index=0,problems=[],artifact=chunk(rows))=>gateway('stage_collection_reference_chunk_from_gateway',[job.job_id,index,artifact.hash,artifact.base64,JSON.stringify(rows),JSON.stringify(problems)]);
const prepare=job=>gateway('finish_collection_reference_prepare_from_gateway',[job.job_id,1]);
const preview=job=>gateway('preview_collection_reference_import_from_gateway',[job.job_id]);
const publish=(job,p,{ack=false,request=randomUUID()}={})=>gateway('publish_collection_reference_import_from_gateway',[job.job_id,p.financial_revision,ack,request]);
const ready=async(mode,rows,name,problems=[])=>{const j=await begin(mode,name);await upload(j);await verify(j);await stage(j,rows,0,problems);await prepare(j);return j;};
const liveState=async()=>{await owner();const s={};for(const t of ['collection_customer_contacts','collection_description_references','collection_contact_events','audit_events'])s[t]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS r FROM public.${t} t`);s.finance=await financialState();return s;};
try{
 await setup();await db.exec(await sql('027_collection_customer_context.sql'));
 await db.exec(`CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;
 CREATE POLICY legacy_wide_storage ON storage.objects FOR ALL TO anon,authenticated USING(true) WITH CHECK(true);`);
 await test('028 activation creates only private source infrastructure and preserves financial records',async()=>{
  const before=await financialState();await db.exec(await sql('028_collection_reference_imports.sql'));assert.deepEqual(await financialState(),before);
  assert.equal(await scalar("SELECT public AS r FROM storage.buckets WHERE id='collection-reference-files'"),false);
 });
 const known=await fixture({name:'Cliente Alfa',document:'NF-A'}),future=await fixture({name:'Cliente Alfa',document:'NF-FUT',days:-30});
 const paid=await fixture({name:'Cliente Pago',document:'NF-PAGO',status:'VALIDATED'});
 await fixture({name:'Cliente CNPJ',document:'NF-CNPJ',cnpj:'12345678000100'});
 await test('only official CR and manager may begin jobs; browser callers cannot call service RPCs',async()=>{
  for(const name of roles){await as(name);if(['gerente_geral','contas_receber'].includes(name)){assert((await begin('CONTACTS',`role-${name}`)).job_id);}else await reject(()=>begin('CONTACTS',`role-${name}`));}
  await as('contas_receber');await reject(()=>db.query('SELECT public.begin_collection_reference_import_from_gateway($1,$2,$3,$4,$5,$6)',[users.contas_receber.id,users.contas_receber.session,'CONTACTS','x.xlsx',1,'b'.repeat(64)]));
 });
let j,firstPublicationRequest;
 await test('source upload path is derived from owner/job, private and immutable even under broad legacy Storage policies',async()=>{
  await as('contas_receber');j=await begin('CONTACTS','initial-contacts');assert.equal(j.storage_path,`${users.contas_receber.id}/${j.job_id}/original`);
  await upload(j);assert.equal((await begin('CONTACTS','initial-contacts')).job_id,j.job_id);
  await db.query('UPDATE storage.objects SET metadata=$1 WHERE name=$2',[JSON.stringify({forged:true}),j.storage_path]);
  assert.equal((await db.query('SELECT metadata FROM storage.objects WHERE name=$1',[j.storage_path])).rows[0].metadata.forged,undefined);
  await db.query('DELETE FROM storage.objects WHERE name=$1',[j.storage_path]);assert.equal((await db.query('SELECT id FROM storage.objects WHERE name=$1',[j.storage_path])).rows.length,1);
  await actor('diretor');assert.equal((await db.query('SELECT id FROM storage.objects WHERE name=$1',[j.storage_path])).rows.length,0);
  await owner();await db.exec('SET ROLE anon');assert.equal((await db.query('SELECT id FROM storage.objects WHERE name=$1',[j.storage_path])).rows.length,0);
  await reject(()=>db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',['collection-reference-files','anonymous/original']));
 });
 await test('unverified originals, corrupt hashes, wrong owner paths and oversized chunks are refused',async()=>{
  await as('contas_receber');await reject(()=>stage(j,[contact('Cliente Alfa')]),'22023');
  await reject(()=>gateway('verify_collection_reference_original_from_gateway',[j.job_id,'0'.repeat(64),j.bytes.length]),'22023');
  await verify(j);const invalid=chunk([contact('Cliente Alfa')]);invalid.hash='0'.repeat(64);await reject(()=>stage(j,[contact('Cliente Alfa')],0,[],invalid),'22023');
  await as('gerente_geral');await reject(()=>gateway('get_collection_reference_job_from_gateway',[j.job_id]));
  await as('contas_receber');await reject(()=>db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',['collection-reference-files',users.contas_receber.id+'/'+randomUUID()+'/original']));
 });
 await test('chunk retry is idempotent; changed chunk content and noncontiguous preparation are refused',async()=>{
  await as('contas_receber');const rows=[contact('Cliente Alfa')];const first=await stage(j,rows);assert.equal(first.staged_rows,1);
  assert.equal((await stage(j,rows)).duplicate,true);await reject(()=>stage(j,[contact('Cliente Alfa',{emails:['outro@example.invalid']})]),'22023');
  await reject(()=>gateway('finish_collection_reference_prepare_from_gateway',[j.job_id,2]),'22023');
  await prepare(j);await reject(()=>stage(j,[contact('Cliente Alfa')],1),'22023');
 });
 await test('preview never publishes; first contacts seed is unreviewed and publish replay preserves the canonical result',async()=>{
  await as('contas_receber');const p=await preview(j);assert.equal(p.eligible_count,1);assert.equal(p.can_publish,true);assert.equal((await context(known)).contact.emails.length,0);
  const request=randomUUID();firstPublicationRequest=request;const r=await publish(j,p,{request});assert.equal(r.done,true);assert.equal(r.published_rows,1);
  const c=await context(known);assert.deepEqual(c.contact.emails,['financeiro@example.invalid']);assert.equal(c.contact.reviewed_at,null);assert.equal(c.contact.manually_edited,false);
  const before=await liveState();await as('contas_receber');assert.deepEqual(await publish(j,p,{request}),r);assert.deepEqual(await liveState(),before);
 });
 await test('reimport merges a new email with empty phones and retains every valid channel',async()=>{
  await as('contas_receber');const update=await ready('CONTACTS',[contact('Cliente Alfa',{emails:['novo@example.invalid'],phones:[]})],'contacts-new-email');
  await publish(update,await preview(update));const c=await context(known);assert.deepEqual(c.contact.emails,['financeiro@example.invalid','novo@example.invalid']);assert.deepEqual(c.contact.phones,[]);
 });
 await test('manual edits including deletions permanently protect the card against future seeding',async()=>{
  await as('contas_receber');await save(known,{emails:[],phones:[],notes:'Remoção manual conferida'});
  const before=await context(known);const seed=await ready('CONTACTS',[contact('Cliente Alfa')],'contacts-after-delete');const p=await preview(seed);assert.equal(p.manual_preserved_count,1);
  await publish(seed,p);assert.deepEqual((await context(known)).contact,before.contact);
 });
 await test('unmatched, paid-only and name-versus-CNPJ ambiguity stay private and require explicit quarantine consent',async()=>{
  await as('contas_receber');const job=await ready('DESCRIPTIONS',[description('Sem Cliente','NF-X'),description('Cliente Pago','NF-PAGO',{source_line:2}),description('Cliente CNPJ','NF-CNPJ',{source_line:3})],'unmatched-references');
  const p=await preview(job);assert.equal(p.unmatched_count,1);assert.equal(p.paid_only_count,1);assert.equal(p.ambiguous_count,1);assert.equal(p.quarantine_count,3);
  await reject(()=>publish(job,p),'P0028');await publish(job,p,{ack:true});
  await actor('diretor');assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_description_references'),0);await reject(()=>context(paid));
 });
 await test('descriptions preserve blank contracts and multiple variants; upcoming references are stored but never displayed early',async()=>{
  await as('contas_receber');const rows=[description('Cliente Alfa','NF-A'),description('Cliente Alfa','NF-A',{source_line:2,description:'Segunda variante sem data'}),description('Cliente Alfa','NF-FUT',{source_line:3})];
  const job=await ready('DESCRIPTIONS',rows,'description-variants');const p=await preview(job);assert.equal(p.variant_count,1);await publish(job,p);
  assert.equal(p.matched_title_count,2);
  const c=await context(known);assert.equal(c.descriptions.state,'PENDING_VARIANTS');assert.equal(c.descriptions.variants.length,2);assert(c.descriptions.variants.every(v=>v.contract===null));
  await reject(()=>context(future));assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_description_references'),2);
  await owner();assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_description_references'),3);
 });
 await test('a title validated between preview and publish blocks the entire publication',async()=>{
  const target=await fixture({name:'Mudança Financeira',document:'NF-RACE'});await as('contas_receber');
  const job=await ready('DESCRIPTIONS',[description('Mudança Financeira','NF-RACE')],'financial-race');const p=await preview(job);
  await owner();await db.query("UPDATE public.receivable_titles SET status='VALIDATED',validation_status='VALIDATED',payment_date=$1 WHERE id=$2",[today,target]);
  await as('contas_receber');await reject(()=>publish(job,p),'40001');assert.equal((await preview(job)).paid_only_count,1);
 });
 await test('warning-only invalid email can still seed a valid phone without claiming manual review',async()=>{
  const target=await fixture({name:'Contato Parcial'});await as('contas_receber');
  const job=await ready('CONTACTS',[contact('Contato Parcial',{emails:[],phones:['(31) 3333-4444']})],'partial-methods',[{source_line:1,code:'WARN_INVALID_EMAIL',column:'Endereço:email',severity:'warning'}]);
  const p=await preview(job);assert.equal(p.warning_count,1);assert.equal(p.quarantine_count,0);await publish(job,p);
  const c=await context(target);assert.deepEqual(c.contact.emails,[]);assert.deepEqual(c.contact.phones,['(31) 3333-4444']);assert.equal(c.contact.reviewed_at,null);
 });
 await test('aggregated client channel limit quarantines excess rather than truncating or creating an uneditable card',async()=>{
  const target=await fixture({name:'Limite Canais'});await as('contas_receber');const emails=Array.from({length:50},(_,i)=>`p${i}@example.invalid`);
  const initial=await ready('CONTACTS',[contact('Limite Canais',{emails})],'limit-initial');await publish(initial,await preview(initial));
  const extra=await ready('CONTACTS',[contact('Limite Canais',{emails:['extra@example.invalid']})],'limit-excess');const p=await preview(extra);assert.equal(p.invalid_count,1);assert(p.examples[0].problem.includes('LIMIT_METHODS'));
  await publish(extra,p,{ack:true});assert.equal((await context(target)).contact.emails.length,50);
 });
 await test('unchanged repeated analyses do not rewrite private rows, including aggregate channel-limit quarantine',async()=>{
  await as('contas_receber');const rows=[description('Cliente Alfa','NF-A'),description('Ainda sem título','NF-UNMATCHED',{source_line:2})];
  const job=await ready('DESCRIPTIONS',rows,'stable-analysis');await preview(job);
  await owner();const before=await scalar("SELECT jsonb_object_agg(row_hash,ctid::text) AS r FROM cf_private.collection_reference_rows WHERE job_id=$1",[job.job_id]);
  await as('contas_receber');await preview(job);await owner();assert.deepEqual(await scalar("SELECT jsonb_object_agg(row_hash,ctid::text) AS r FROM cf_private.collection_reference_rows WHERE job_id=$1",[job.job_id]),before);
  const target=await fixture({name:'Limite Reanálise'});await as('contas_receber');const emails=Array.from({length:50},(_,i)=>`b${i}@example.invalid`);
  const initial=await ready('CONTACTS',[contact('Limite Reanálise',{emails})],'stable-limit-base');await publish(initial,await preview(initial));
  const extra=await ready('CONTACTS',[contact('Limite Reanálise',{emails:['new-limit@example.invalid']})],'stable-limit-excess');assert.equal((await preview(extra)).invalid_count,1);
  await owner();const limitBefore=await scalar("SELECT jsonb_object_agg(row_hash,ctid::text) AS r FROM cf_private.collection_reference_rows WHERE job_id=$1",[extra.job_id]);
  await as('contas_receber');assert.equal((await preview(extra)).invalid_count,1);await owner();assert.deepEqual(await scalar("SELECT jsonb_object_agg(row_hash,ctid::text) AS r FROM cf_private.collection_reference_rows WHERE job_id=$1",[extra.job_id]),limitBefore);
  await as('contas_receber');assert.equal((await context(target)).contact.emails.length,50);
 });
 await test('initial valid contacts seed a hidden global registry and a later eligible title inherits them without reimport',async()=>{
  // Coexistem uma chave por nome e outra por CNPJ: a origem sem documento
  // continua ambígua, mesmo havendo uma correspondência nominal exata.
  await fixture({name:'Cliente CNPJ'});
  await as('contas_receber');const job=await ready('CONTACTS',[contact('Órgão Somente Cadastro'),contact('Cliente Pago',{source_line:2}),contact('Cliente CNPJ',{source_line:3})],'global-initial-contacts');
  const before=await financialState();await as('contas_receber');const p=await preview(job);assert.equal(p.eligible_count,2);assert.equal(p.ambiguous_count,1);
  await publish(job,p,{ack:true});assert.deepEqual(await financialState(),before);
  await actor('diretor');assert.equal(await scalar("SELECT count(*)::int AS r FROM public.collection_customer_contacts WHERE customer_key IN ('name:ÓRGÃO SOMENTE CADASTRO','name:CLIENTE PAGO','name:CLIENTE CNPJ')"),0);
  await owner();assert.equal(await scalar("SELECT count(*)::int AS r FROM public.collection_customer_contacts WHERE customer_key='name:ÓRGÃO SOMENTE CADASTRO'"),1);
  assert.equal(await scalar("SELECT count(*)::int AS r FROM public.collection_customer_contacts WHERE customer_key='name:CLIENTE CNPJ'"),0);
  const later=await fixture({name:'  ÓRGÃO   SOMENTE CADASTRO  '});await actor('cobradora_1');const c=await context(later);
  assert.deepEqual(c.contact.emails,['financeiro@example.invalid']);assert.equal(c.contact.manually_edited,false);assert.equal(c.contact.reviewed_at,null);
 });
 await test('publication audit failure rolls back every live card/reference and the job can be safely retried',async()=>{
  const target=await fixture({name:'Publicação Atômica'});await as('contas_receber');const job=await ready('CONTACTS',[contact('Publicação Atômica')],'atomic-publish'),p=await preview(job);
  const before=await liveState();await db.exec(`CREATE FUNCTION public.reject_reference_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='collection_reference_publication' THEN RAISE EXCEPTION 'synthetic failure' USING ERRCODE='P0099';END IF;RETURN NEW;END$$;CREATE TRIGGER reject_reference_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_reference_audit();`);
  try{await as('contas_receber');await reject(()=>publish(job,p),'P0099');assert.deepEqual(await liveState(),before);}finally{await owner();await db.exec('DROP TRIGGER reject_reference_audit ON public.audit_events;DROP FUNCTION public.reject_reference_audit()');}
  await as('contas_receber');await publish(job,p);assert.equal((await context(target)).contact.emails.length,1);
 });
 await test('unmatched source can be reanalyzed and attached only after a genuine active title exists',async()=>{
  await as('contas_receber');const job=await ready('DESCRIPTIONS',[description('Cliente Posterior','NF-LATER')],'later-source');await publish(job,await preview(job),{ack:true});
  const later=await fixture({name:'Cliente Posterior',document:'NF-LATER'});await as('contas_receber');const p=await preview(job);assert.equal(p.eligible_count,1);await publish(job,p);
  assert.equal((await context(later)).descriptions.count,1);
 });
 await test('publication request collision across jobs is denied and missing financial tokens never create a new write',async()=>{
  await as('contas_receber');const job=await ready('DESCRIPTIONS',[description('Cliente Alfa','NF-A')],'request-collision'),p=await preview(job);
  await reject(()=>publish(job,p,{request:firstPublicationRequest}),'22023');
  await reject(()=>gateway('publish_collection_reference_import_from_gateway',[job.job_id,null,false,randomUUID()]),'40001');
 });
 await test('SQL independently quarantines missing content and rejects canonical client identity injection and bounds',async()=>{
  await as('contas_receber');const job=await ready('CONTACTS',[contact('Cliente Alfa',{emails:[],phones:[]})],'missing-contact');assert.equal((await preview(job)).invalid_count,1);
  const raw=await begin('CONTACTS','invalid-stage-boundaries');await upload(raw);await verify(raw);
  await reject(()=>stage(raw,[{...contact('Cliente Alfa'),customer_key:'forged'}]),'22023');
  await reject(()=>stage(raw,Array(501).fill(contact('Cliente Alfa'))),'22023');
  const bytes=Buffer.alloc(262145,65);await reject(()=>stage(raw,[contact('Cliente Alfa')],0,[],{hash:digest(bytes),base64:bytes.toString('base64')}),'22023');
  await reject(()=>gateway('begin_collection_reference_import_from_gateway',['CONTACTS','too-large.xlsx',16777217,'b'.repeat(64)]),'22023');
 });
 await test('anonymous legacy access to unrelated Storage buckets still works while reference artifacts remain private',async()=>{
  await owner();await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('legacy-other','public-object')");await db.exec('SET ROLE anon');
  assert.equal((await db.query("SELECT name FROM storage.objects WHERE bucket_id='legacy-other'")).rows.length,1);
  assert.equal((await db.query("SELECT name FROM storage.objects WHERE bucket_id='collection-reference-files'")).rows.length,0);
  await actor('contas_receber');await reject(()=>db.query('SELECT artifact FROM cf_private.collection_reference_chunks'));
  await reject(()=>db.query('UPDATE cf_private.collection_reference_rows SET canonical=$1',[JSON.stringify({forged:true})]));
 });
 console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
}finally{await db.close();}
