import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildCollectionReferenceAnalysisSql } from './bundle-collection-reference-analysis.mjs';

// PostgreSQL descartável. Fontes, clientes e contatos exclusivamente sintéticos.
const f=await createCostFixture(),{db,users,id,scalar,owner,actor,file}=f;
const activation=await buildCollectionReferenceAnalysisSql();
const digest=value=>createHash('sha256').update(value).digest('hex');
let sequence=20000,passed=0,failed=0,importId,agent;
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message,JSON.stringify({code:e.code,where:e.where,detail:e.detail}));}};
const reject=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
const gateway=async(name,args=[],who='cr')=>{
 await owner(who);await db.exec('SET ROLE service_role');
 try{return await scalar(`SELECT public.${name}(${[users[who].id,users[who].session,...args].map((_,i)=>'$'+(i+1)).join(',')}) r`,[users[who].id,users[who].session,...args]);}
 finally{await actor(who);}
};
const contact=(name,extra={})=>({source_line:2,client_name:name,client_document:null,emails:['financeiro@example.invalid'],phones:[],notes:null,...extra});
const description=(name,document,extra={})=>({source_line:2,client_name:name,client_document:null,branch:'Filial sintética',document,description:'Objeto sintético do contrato',contract:null,...extra});
const title=async({name='Cliente Alfa',document='NF-ALFA',cnpj=null,days=10,status='OPEN'}={})=>{
 await owner('cr');return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,client_document,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_date,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$2,$3,$4,cf_private.receivable_customer_key($3,$4),'Filial sintética',current_date-$5::integer,10000,$6,$7,CASE WHEN $7='VALIDATED' THEN 'VALIDATED' ELSE 'NONE' END,CASE WHEN $7='VALIDATED' THEN current_date END,$8,$8) RETURNING id r`,[`reference-analysis-${++sequence}`,document,name,cnpj,days,agent,status,importId]);
};
const ready=async(mode,rows,label=`preparacao-${++sequence}`)=>{
 const bytes=Buffer.from('Original privado sintético '+label),j=await gateway('begin_collection_reference_import_from_gateway',[mode,label+'.xlsx',bytes.length,digest(bytes)]);
 await actor('cr');await db.query('INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3::jsonb)',['collection-reference-files',j.storage_path,JSON.stringify({size:bytes.length,synthetic_sha256:digest(bytes)})]);
 await gateway('verify_collection_reference_original_from_gateway',[j.job_id,digest(bytes),bytes.length]);
 const artifact=Buffer.from('source_line,synthetic\n'+rows.map(r=>`${r.source_line},sintetico`).join('\n'));
 await gateway('stage_collection_reference_chunk_from_gateway',[j.job_id,0,digest(artifact),artifact.toString('base64'),JSON.stringify(rows),'[]']);
 return gateway('finish_collection_reference_prepare_from_gateway',[j.job_id,1]);
};
const preview=(j,who='cr')=>gateway('preview_collection_reference_import_from_gateway',[j.job_id],who);
const publish=(j,p,request=randomUUID())=>gateway('publish_collection_reference_import_from_gateway',[j.job_id,p.financial_revision,true,request]);
const cache=async j=>{await owner();return scalar("SELECT jsonb_build_object('analysis_at',analysis_at,'financial',analysis_financial_revision,'context',analysis_context_revision,'ctid',ctid::text) r FROM cf_private.collection_reference_jobs WHERE id=$1",[j.job_id]);};
const immutable=async j=>{await owner();return scalar(`SELECT jsonb_build_object(
 'job',(SELECT to_jsonb(t)-ARRAY['analysis_at','analysis_financial_revision','analysis_context_revision','status','published_at','last_result'] FROM cf_private.collection_reference_jobs t WHERE id=$1),
 'rows',(SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(jsonb_build_array(row_hash,source_line,canonical,problems,customer_key,context_key,invalid)::text,E'\\n' ORDER BY row_hash),''),'UTF8')),'hex')) FROM cf_private.collection_reference_rows WHERE job_id=$1),
 'chunks',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY chunk_index),'[]') FROM cf_private.collection_reference_chunks c WHERE job_id=$1),
 'original',(SELECT to_jsonb(s) FROM storage.objects s JOIN cf_private.collection_reference_jobs t ON t.storage_path=s.name WHERE t.id=$1 AND s.bucket_id='collection-reference-files')) r`,[j.job_id]);};
const protectedState=async()=>{
 await owner();const s={};for(const t of ['public.receivable_titles','public.receivable_receipts','public.receivable_imports','public.receivable_collection_events','public.bank_accounts','public.profiles','public.role_permissions','public.collector_bindings','auth.users'])s[t]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') r FROM ${t} t`);return s;
};
// Imita uma preparação já persistida pelo serviço anterior, sem repetir upload
// ou reler o XLSX. Cada artefato/hash e o manifesto são preservados na ativação.
const largeReady=async(mode,count)=>{
 const jobId=id(++sequence),sourceHash=digest('original-escalado-'+mode),chunks=Math.ceil(count/500);
 await owner('cr');await db.query(`INSERT INTO cf_private.collection_reference_jobs(id,created_by,mode,source_name,source_size,source_sha256,storage_path,status,original_verified,verified_at,staged_rows,staged_chunks,staged_input_rows,staged_bytes)
 VALUES($1,$2,$3,$4,$5,$6,$2::uuid::text||'/'||$1::uuid::text||'/original','STAGING',true,clock_timestamp(),$7::integer,$8,$7::integer,$7::bigint)`,[jobId,users.cr.id,mode,mode==='DESCRIPTIONS'?'descricoes-sinteticas.xlsx':'contatos-sinteticos.xlsx',mode==='DESCRIPTIONS'?9400000:157000,sourceHash,count,chunks]);
 await db.query(`INSERT INTO storage.objects(bucket_id,name,metadata) SELECT 'collection-reference-files',storage_path,jsonb_build_object('size',source_size,'synthetic_sha256',source_sha256) FROM cf_private.collection_reference_jobs WHERE id=$1`,[jobId]);
 await db.query(`WITH data AS(SELECT g,jsonb_build_object('client_name','Cliente Escala '||g,'client_document',NULL)||CASE WHEN $3='DESCRIPTIONS' THEN jsonb_build_object('document','NF-ESCALA-'||g,'branch','Filial sintética','description',repeat('Descrição sintética ',8),'contract',NULL) ELSE jsonb_build_object('emails',jsonb_build_array('financeiro'||g||'@example.invalid'),'phones','[]'::jsonb,'notes',NULL) END canonical FROM generate_series(1,$2)g)
 INSERT INTO cf_private.collection_reference_rows(job_id,row_hash,source_line,canonical,problems,customer_key,context_key,invalid)
 SELECT $1,encode(sha256(convert_to(canonical::text,'UTF8')),'hex'),g+1,canonical,'[]',cf_private.receivable_customer_key(canonical->>'client_name',NULL),CASE WHEN $3='DESCRIPTIONS' THEN cf_private.collection_reference_key(canonical->>'branch',canonical->>'document',cf_private.receivable_customer_key(canonical->>'client_name',NULL)) END,false FROM data`,[jobId,count,mode]);
 await db.query(`WITH batches AS(SELECT (source_line-2)/500 i,count(*)::integer n,string_agg(source_line::text||',sintetico',E'\\n' ORDER BY source_line) artifact,string_agg(row_hash,E'\\n' ORDER BY row_hash) row_hashes FROM cf_private.collection_reference_rows WHERE job_id=$1 GROUP BY 1)
 INSERT INTO cf_private.collection_reference_chunks(job_id,chunk_index,sha256,rows_sha256,artifact,row_count,problems)
 SELECT $1,i,encode(sha256(convert_to(artifact,'UTF8')),'hex'),encode(sha256(convert_to(row_hashes,'UTF8')),'hex'),convert_to(artifact,'UTF8'),n,'[]' FROM batches`,[jobId]);
 return gateway('finish_collection_reference_prepare_from_gateway',[jobId,chunks]);
};

try{
 await owner();for(const name of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql'])await db.exec(await file(name));
 agent=id(10001);await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,'Responsável sintética']);
 await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users.collector.id,agent,users.manager.id]);
 importId=await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES('grupo-consolidado','carteira-sintetica.csv',repeat('a',64),$1,980,980,0,0,0,'OPEN') RETURNING id r",[users.cr.id]);
 await db.query(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,first_import_id,last_import_id)
 SELECT 'grupo-consolidado','escala-'||g,'NF-ESCALA-'||g,'Cliente Escala '||g,cf_private.receivable_customer_key('Cliente Escala '||g,NULL),'Filial sintética',current_date-10,10000,$2,'OPEN',$1,$1 FROM generate_series(1,980)g`,[importId,agent]);
 const alfa=await title(),future=await title({name:'Cliente Futuro',document:'NF-FUTURO',days:-20});
 await title({name:'Cliente Pago',document:'NF-PAGO',status:'VALIDATED'});
 await title({name:'Órgão CNPJ',document:'NF-CNPJ',cnpj:'12345678000100'});
 const manual=await title({name:'Cliente Manual',document:'NF-MANUAL'});
 await actor('cr');const ctx=await scalar('SELECT public.collection_customer_context($1) r',[manual]);
 await scalar('SELECT public.save_collection_customer_contacts($1,$2::jsonb,$3::jsonb,$4,$5,$6) r',[manual,'["confirmado@example.invalid"]','[]','Contato conferido pela cobradora',ctx.contact.revision,randomUUID()]);
 const contacts=await ready('CONTACTS',[
  contact('Cliente Alfa'),contact('Cliente Pago',{source_line:3}),contact('Órgão CNPJ',{source_line:4}),
  contact('Órgão CNPJ',{source_line:5,client_document:'12345678000100'}),contact('Cadastro sem título',{source_line:6}),
  contact('Cliente Manual',{source_line:7}),contact('CNPJ desconhecido',{source_line:8,client_document:'12345678000290'}),
  contact('',{source_line:9}),contact('  cliente\u00a0Alfa  ',{source_line:10,emails:['outro@example.invalid']})]);
 const descriptions=await ready('DESCRIPTIONS',[
  description('Cliente Alfa','NF-ALFA'),description('Cliente Alfa','NF-ALFA',{source_line:3,description:'Outra variante'}),
  description('Cliente Pago','NF-PAGO',{source_line:4}),description('Órgão CNPJ','NF-CNPJ',{source_line:5}),
  description('Órgão CNPJ','NF-CNPJ',{source_line:6,client_document:'12345678000100'}),
  description('Cliente Futuro','NF-FUTURO',{source_line:7}),description('Sem título','NF-X',{source_line:8}),
  description('','NF-ALFA',{source_line:9})]);
 const oldPublished=await ready('CONTACTS',[contact('Cadastro já publicado')]);await publish(oldPublished,await preview(oldPublished));
 const oldSource=await immutable(oldPublished),publishedBefore=await gateway('get_collection_reference_job_from_gateway',[oldPublished.job_id]);
 const largeDescriptions=await largeReady('DESCRIPTIONS',63780),largeContacts=await largeReady('CONTACTS',4356);
 const oldPrepared=[contacts,descriptions,largeDescriptions,largeContacts],rawBefore=await Promise.all(oldPrepared.map(immutable));
 const oldPreviews=[];for(const j of [contacts,descriptions])oldPreviews.push(await preview(j));
 const financeBefore=await protectedState();
 await test('048 activates without financial, permission, original, chunk or canonical-row changes; an existing PREPARED job resumes',async()=>{
  assert.equal(await readFile(new URL('../supabase/dashboard/ativar-conferencia-contatos-descricoes.sql',import.meta.url),'utf8'),activation);
  await owner();await db.exec(activation);assert.deepEqual(await protectedState(),financeBefore);
  for(let i=0;i<oldPrepared.length;i++)assert.deepEqual(await immutable(oldPrepared[i]),rawBefore[i]);
  assert.deepEqual(await gateway('get_collection_reference_job_from_gateway',[oldPublished.job_id]),publishedBefore);assert.deepEqual(await immutable(oldPublished),oldSource);
  for(let i=0;i<2;i++)assert.deepEqual(await preview(oldPrepared[i]),oldPreviews[i]);
 });
 await test('canonical matching preserves CNPJ ambiguity, paid-only, manual protection, variants, future references and invalid rows',async()=>{
  const c=await preview(contacts),d=await preview(descriptions);
  assert.equal(c.ambiguous_count,1);assert.equal(c.manual_preserved_count,1);assert.equal(c.invalid_count,1);assert.equal(c.unmatched_count,1);
  assert.equal(d.ambiguous_count,1);assert.equal(d.paid_only_count,1);assert.equal(d.invalid_count,1);assert.equal(d.unmatched_count,1);assert.equal(d.variant_count,1);
  const before=await protectedState();const r=await publish(descriptions,d);assert.equal(r.done,true);assert.deepEqual(await protectedState(),before);
  await actor('cr');assert.equal((await scalar('SELECT public.collection_customer_context($1) r',[alfa])).descriptions.variants.length,2);
  await reject(()=>scalar('SELECT public.collection_customer_context($1) r',[future]));
 });
 await test('repeated previews reuse classification only while both revisions match and keep rows unchanged',async()=>{
  await preview(contacts);const before=await cache(contacts),source=await immutable(contacts);
  const p=await preview(contacts);assert.equal(p.status,'PREPARED');assert.deepEqual(await cache(contacts),before);assert.deepEqual(await immutable(contacts),source);
  const p1=await preview(oldPublished),publishedCache=await cache(oldPublished),p2=await preview(oldPublished);
  assert.equal(p1.status,'PUBLISHED');assert.equal(p2.published_rows,1);assert.equal(p2.remaining_rows,0);assert.deepEqual(await cache(oldPublished),publishedCache);
 });
 await test('a manual save invalidates the cache without a financial change and imported contacts cannot overwrite it',async()=>{
  const j=await ready('CONTACTS',[contact('Cliente Alfa',{emails:['origem@example.invalid']})]);await preview(j);const old=await cache(j);
  await actor('cr');const c=await scalar('SELECT public.collection_customer_context($1) r',[alfa]);
  await scalar('SELECT public.save_collection_customer_contacts($1,$2::jsonb,$3::jsonb,$4,$5,$6) r',[alfa,'["manual@example.invalid"]','["(31) 3333-4444"]','Atualização manual preservada',c.contact.revision,randomUUID()]);
  const p=await preview(j),now=await cache(j);assert.equal(p.manual_preserved_count,1);assert.equal(now.financial,old.financial);assert.notEqual(now.context,old.context);assert.notEqual(now.analysis_at,old.analysis_at);
  await publish(j,p);await actor('cr');const after=await scalar('SELECT public.collection_customer_context($1) r',[alfa]);assert.deepEqual(after.contact.emails,['manual@example.invalid']);assert.equal(after.contact.notes,'Atualização manual preservada');
 });
 await test('settlement and audited retirement invalidate classification, preserving retired titles outside descriptions',async()=>{
  const paid=await title({name:'Cliente Liquidação',document:'NF-LIQ'}),retired=await title({name:'Cliente Retirado',document:'NF-RET'});
  const j=await ready('DESCRIPTIONS',[description('Cliente Liquidação','NF-LIQ'),description('Cliente Retirado','NF-RET',{source_line:3})]);assert.equal((await preview(j)).eligible_count,2);const before=await cache(j);
  await owner('cr');await db.query("UPDATE public.receivable_titles SET status='VALIDATED',validation_status='VALIDATED',payment_date=current_date WHERE id=$1",[paid]);
  const request=randomUUID();await db.query("INSERT INTO cf_private.receivable_open_report_requests(request_id,actor_id,payload_hash,source_import_id,full_report,reference_date,result) VALUES($1,$2,repeat('b',64),$3,true,current_date,'{}')",[request,users.cr.id,importId]);
  await scalar("SELECT cf_private.record_receivable_report_event($1,'RETIRED_UNWORKED',$2,$3,current_date) r",[retired,importId,request]);
  const p=await preview(j),now=await cache(j);assert.equal(p.eligible_count,0);assert.equal(p.paid_only_count,1);assert.equal(p.unmatched_count,1);assert.notEqual(now.financial,before.financial);assert.notEqual(now.context,before.context);
 });
 await test('wallet and profile changes invalidate context-only cache entries',async()=>{
  const j=await ready('CONTACTS',[contact('Cadastro carteira')]);await preview(j);let old=await cache(j);
  await owner();await db.query('UPDATE public.collector_bindings SET updated_by=$1 WHERE user_id=$2',[users.manager2.id,users.collector.id]);
  await preview(j);let now=await cache(j);assert.equal(now.financial,old.financial);assert.notEqual(now.context,old.context);old=now;
  await owner();await db.query("UPDATE public.profiles SET display_name=display_name||' atualizado' WHERE id=$1",[users.collector.id]);await preview(j);now=await cache(j);assert.notEqual(now.context,old.context);
 });
 await test('new collection work invalidates the financial revision even when the contact context stays unchanged',async()=>{
  const target=await title({name:'Cliente Atendimento',document:'NF-ATEND'}),j=await ready('DESCRIPTIONS',[description('Cliente Atendimento','NF-ATEND')]);await preview(j);const before=await cache(j);
  await actor('cr');const detail=await scalar('SELECT public.collection_case_detail($1) r',[target]);
  await scalar("SELECT public.collection_work_action($1,'START',$2,$3) r",[target,detail.title.revision,randomUUID()]);
  await preview(j);const now=await cache(j);assert.notEqual(now.financial,before.financial);assert.equal(now.context,before.context);assert.notEqual(now.analysis_at,before.analysis_at);
 });
 await test('the merged 50-channel limit quarantines excess without truncating or rewriting valid manual contacts',async()=>{
  const emails=Array.from({length:50},(_,i)=>`canal${i}@example.invalid`),j=await ready('CONTACTS',[contact('Limite canais',{emails}),contact('Limite canais',{source_line:3,emails:['excesso@example.invalid']})]);
  const p=await preview(j);assert.equal(p.invalid_count,2);assert(p.examples.every(r=>r.problem.startsWith('LIMIT_METHODS')));const before=await cache(j);assert.equal((await preview(j)).invalid_count,2);assert.deepEqual(await cache(j),before);
  await publish(j,p);await owner();assert.equal(await scalar("SELECT count(*)::integer r FROM public.collection_customer_contacts WHERE customer_key='name:LIMITE CANAIS'"),0);
 });
 await test('revision changes during classification abort atomically, without storing a false cache entry',async()=>{
  const j=await ready('CONTACTS',[contact('Concorrência sintética')]);await owner();const source=await immutable(j),ctx=await scalar('SELECT revision::text r FROM cf_private.collection_context_state WHERE singleton');
  await db.exec(`CREATE FUNCTION cf_private.synthetic_analysis_revision_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE cf_private.collection_context_state SET revision=revision+1 WHERE singleton;RETURN NULL;END $$;
   CREATE TRIGGER synthetic_analysis_revision_race AFTER UPDATE ON cf_private.collection_reference_rows FOR EACH STATEMENT EXECUTE FUNCTION cf_private.synthetic_analysis_revision_race();`);
  try{await reject(()=>preview(j),'40001');}finally{await owner();await db.exec('DROP TRIGGER synthetic_analysis_revision_race ON cf_private.collection_reference_rows;DROP FUNCTION cf_private.synthetic_analysis_revision_race();');}
  assert.equal(await scalar('SELECT revision::text r FROM cf_private.collection_context_state WHERE singleton'),ctx);assert.equal((await cache(j)).analysis_at,null);assert.deepEqual(await immutable(j),source);assert.equal((await preview(j)).eligible_count,1);
 });
 await test('prepared sources remain actor-owned; no caller gains a private setter or browser execution grant',async()=>{
  for(const who of ['manager','manager2','director','cp','collector'])await reject(()=>preview(largeDescriptions,who));
  for(const role of ['anon','authenticated','service_role']){await owner();await db.exec('SET ROLE '+role);await reject(()=>scalar('SELECT cf_private.analyze_collection_reference_job($1) r',[largeDescriptions.job_id]));}
  await owner();assert.deepEqual((await db.query("SELECT proname,proconfig FROM pg_proc WHERE oid IN('public.preview_collection_reference_import_from_gateway(uuid,text,uuid)'::regprocedure,'public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid)'::regprocedure) ORDER BY proname")).rows.map(r=>[r.proname,r.proconfig.includes('lock_timeout=5s')]),[['preview_collection_reference_import_from_gateway',true],['publish_collection_reference_import_from_gateway',true]]);
  for(const name of ['collection_reference_jobs','collection_reference_chunks','collection_reference_rows'])assert.equal(await scalar('SELECT relrowsecurity r FROM pg_class WHERE oid=$1::regclass',['cf_private.'+name]),true);
 });
 await test('63,780 descriptions and 4,356 contacts preview and reuse the prepared source with a 980-title portfolio',async()=>{
  const before=await protectedState(),rows=[largeDescriptions,largeContacts],expected=[980,4356];
  for(let i=0;i<rows.length;i++){
   await owner();await db.exec("SET statement_timeout='45000'");const start=performance.now(),p=await preview(rows[i]),first=Math.round(performance.now()-start),cached=await cache(rows[i]);
   const repeatStart=performance.now(),repeat=await preview(rows[i]),second=Math.round(performance.now()-repeatStart);
   assert.equal(p.row_count,i===0?63780:4356);assert.equal(p.eligible_count,expected[i]);assert.equal(p.matched_title_count,980);assert.deepEqual(repeat,p);assert.deepEqual(await cache(rows[i]),cached);assert.deepEqual(await immutable(rows[i]),rawBefore[i+2]);
   console.log(`PERF ${p.mode}: ${p.row_count} linhas; primeira análise ${first} ms; reuso ${second} ms`);
  }
  assert.deepEqual(await protectedState(),before);
 });
 await test('activation rerun does not reset prepared/published jobs, raw hashes, cache or permissions',async()=>{
  await owner();const before=await protectedState(),jobs=await scalar("SELECT jsonb_agg(to_jsonb(j) ORDER BY id) r FROM cf_private.collection_reference_jobs j"),sources=await Promise.all(oldPrepared.map(immutable));
  await owner();await db.exec(activation);assert.deepEqual(await protectedState(),before);await owner();assert.deepEqual(await scalar("SELECT jsonb_agg(to_jsonb(j) ORDER BY id) r FROM cf_private.collection_reference_jobs j"),jobs);
  for(let i=0;i<oldPrepared.length;i++)assert.deepEqual(await immutable(oldPrepared[i]),sources[i]);
 });
}catch(e){failed++;console.error('FAIL fixture',e.message,JSON.stringify({code:e.code,where:e.where,detail:e.detail}));}finally{await db.close();}
console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
