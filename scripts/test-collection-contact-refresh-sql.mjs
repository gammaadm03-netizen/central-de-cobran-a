import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildCollectionContactRefreshSql } from './bundle-collection-contact-refresh.mjs';
import { parseReferenceCsv, referenceCsvRow, REFERENCE_HEADERS } from '../src/lib/collection-reference-parser.mjs';

// PostgreSQL descartável. Fontes, órgãos, contatos e títulos são sintéticos.
const f=await createCostFixture(),{db,users,id,scalar,owner,actor,file}=f;
const installer=await buildCollectionContactRefreshSql(),digest=v=>createHash('sha256').update(v).digest('hex');
let seq=72000,passed=0,importId,agent;
const gateway=async(name,args=[],who='cr')=>{await owner(who);await db.exec('SET ROLE service_role');const r=await scalar(`SELECT public.${name}(${[users[who].id,users[who].session,...args].map((_,i)=>'$'+(i+1)).join(',')}) r`,[users[who].id,users[who].session,...args]);await actor(who);return r};
const contact=(name,extra={})=>({source_line:2,client_name:name,client_document:null,emails:['origem@example.invalid'],phones:[],notes:null,...extra});
const ready=async(mode,rows,{problems=[],label=`fonte-${++seq}`}={})=>{
 const bytes=Buffer.from('Original sintético '+label),j=await gateway('begin_collection_reference_import_from_gateway',[mode,label+'.xlsx',bytes.length,digest(bytes)]);
 await actor('cr');await db.query('INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3::jsonb)',['collection-reference-files',j.storage_path,JSON.stringify({size:bytes.length})]);
 await gateway('verify_collection_reference_original_from_gateway',[j.job_id,digest(bytes),bytes.length]);
 for(let offset=0;offset<rows.length;offset+=500){const part=rows.slice(offset,offset+500),bytes=Buffer.from('source_line,synthetic\n'+part.map(r=>r.source_line+',sintetico').join('\n'));await gateway('stage_collection_reference_chunk_from_gateway',[j.job_id,offset/500,digest(bytes),bytes.toString('base64'),JSON.stringify(part),JSON.stringify(problems)])}
 return gateway('finish_collection_reference_prepare_from_gateway',[j.job_id,Math.ceil(rows.length/500)]);
};
const preview=j=>gateway('preview_collection_reference_import_from_gateway',[j.job_id]);
const publish=(j,p,{ack=true,request=randomUUID()}={})=>gateway('publish_collection_reference_import_from_gateway',[j.job_id,p.financial_revision,ack,request]);
const seed=async(name,extra={})=>{const j=await ready('CONTACTS',[contact(name,extra)]);await publish(j,await preview(j));return j};
const card=async name=>{await owner();return scalar('SELECT to_jsonb(c) r FROM public.collection_customer_contacts c WHERE customer_key=cf_private.receivable_customer_key($1,NULL)',[name])};
const audit=async name=>{await owner();return scalar("SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY occurred_at,id),'[]') r FROM public.audit_events a WHERE entity='collection_customer_contacts' AND record_id=cf_private.receivable_customer_key($1,NULL)",[name])};
const cache=async j=>{await owner();return scalar('SELECT to_jsonb(j) r FROM cf_private.collection_reference_jobs j WHERE id=$1',[j.job_id])};
const protectedState=async()=>{await owner();const s={};for(const t of ['public.receivable_titles','public.receivable_imports','public.receivable_receipts','public.receivable_collection_events','public.receivable_received_import_rows','public.bank_accounts','public.payable_titles','public.payable_payments','public.profiles','public.role_permissions','public.collector_bindings','auth.users'])s[t]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') r FROM ${t} t`);return s};
const test=async(name,fn)=>{await owner();await db.exec('BEGIN');try{await fn();passed++;console.log('PASS',name)}finally{await owner();await db.exec('ROLLBACK');await actor('cr')}};
const reject=async(fn,code='42501')=>{await db.exec('SAVEPOINT expected_error');try{await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}finally{await db.exec('ROLLBACK TO SAVEPOINT expected_error;RELEASE SAVEPOINT expected_error')}};
const title=async(name,cnpj=null)=>{await owner('cr');const n=++seq;return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,client_document,customer_key,branch,due_date,amount_cents,collector_id,status,first_import_id,last_import_id)
 VALUES('grupo-consolidado',$1,$1,$2,$3,cf_private.receivable_customer_key($2,$3),'4',current_date-10,10000,$4,'OPEN',$5,$5) RETURNING id r`,['NF-SYN-'+n,name,cnpj,agent,importId])};

try{
 await owner();for(const n of ['040_collection_email_draft.sql','041_receivable_import_performance.sql','047_receivables_complete_report.sql','048_collection_reference_analysis.sql','049_collection_reference_preview_work.sql'])await db.exec(await file(n));
 agent=id(++seq);await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,'Responsável sintética']);
 await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users.collector.id,agent,users.manager.id]);
 importId=await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES('grupo-consolidado','carteira-sintetica.csv',repeat('a',64),$1,1,1,0,0,0,'OPEN') RETURNING id r",[users.cr.id]);
 const legacy=await ready('CONTACTS',[contact('Contato legado')]),legacyPreview=await preview(legacy),legacyRequest=randomUUID(),legacyResult=await publish(legacy,legacyPreview,{request:legacyRequest});
 const prepared=await ready('CONTACTS',[contact('Contato preparado')]);await preview(prepared);
 const desc=await ready('DESCRIPTIONS',[{source_line:2,client_name:'Cliente descrição',client_document:null,branch:'4',document:'NF-DESC',description:'Descrição sintética',contract:null}]);await preview(desc);
 await seed('Legado inválido',{emails:['preservado@example.invalid']});const legacyFifty=['preservado@example.invalid',...Array.from({length:49},(_,i)=>`legado${i}@example.invalid`)],legacyBrokenRows=[contact('Legado inválido',{emails:legacyFifty}),contact('Legado inválido',{source_line:3,emails:legacyFifty})],legacyBrokenProblems=[{source_line:3,code:'LIMIT_METHODS',field:'contacts',message:'Excesso sintético de canais'}];
 const legacyBroken=await ready('CONTACTS',legacyBrokenRows,{problems:legacyBrokenProblems});assert.equal((await preview(legacyBroken)).eligible_count,1);await owner();const legacyBrokenSource=await scalar('SELECT jsonb_agg(to_jsonb(r) ORDER BY row_hash) r FROM cf_private.collection_reference_rows r WHERE job_id=$1',[legacyBroken.job_id]);assert.equal(legacyBrokenSource.length,1);assert.equal(legacyBrokenSource[0].invalid,false);
 const financeBefore=await protectedState(),legacyBefore=await cache(legacy),descBefore=await cache(desc);await owner();await db.exec(installer);
 assert.deepEqual(await protectedState(),financeBefore);assert.deepEqual(await cache(legacy),legacyBefore);assert.deepEqual(await cache(desc),descBefore);assert.equal((await cache(prepared)).analysis_context_revision,null);assert.equal((await preview(prepared)).contact_refresh_version,'052');
 await owner();const beforeReapply=await f.snapshot();await db.exec(installer);assert.deepEqual(await f.snapshot(),beforeReapply);passed++;console.log('PASS complete installer preserves finance and immutable sources, invalidates only unpublished contacts and reapplies safely');

 await test('replacement removes obsolete imported emails and phones and preserves exact before/after audit',async()=>{
  await seed('Órgão atualizado',{emails:['antigo@example.invalid'],phones:['3133334444'],notes:'Telefone informado: 0800 antigo'});const before=await card('Órgão atualizado'),financial=await protectedState();
  const j=await ready('CONTACTS',[contact('Órgão atualizado',{emails:['novo@example.invalid'],phones:['31999998888'],notes:'WhatsApp cadastrado: (31) 99999-8888'})]);const p=await preview(j);assert.equal(p.contact_refresh_version,'052');assert.equal(p.eligible_count,1);const r=await publish(j,p);assert.equal(r.contact_refresh_version,'052');
  const after=await card('Órgão atualizado');assert.deepEqual(after.emails,['novo@example.invalid']);assert.deepEqual(after.phones,['31999998888']);assert.equal(after.notes,'WhatsApp cadastrado: (31) 99999-8888');assert.equal(after.revision,before.revision+1);
  const history=await audit('Órgão atualizado'),last=history.at(-1);assert.deepEqual(last.before_value,before);assert.deepEqual(last.after_value,after);assert.deepEqual(await protectedState(),financial);
 });
 await test('new report may clear an imported channel and imported annotation while retaining another valid channel',async()=>{
  await seed('Limpeza importada',{emails:['antigo@example.invalid'],phones:['3133334444'],notes:'WhatsApp antigo'});
  await seed('Limpeza importada',{emails:[],phones:['3133334444'],notes:null});const c=await card('Limpeza importada');assert.deepEqual(c.emails,[]);assert.deepEqual(c.phones,['3133334444']);assert.equal(c.notes,null);
 });
 await test('repeated source rows combine unique channels and deterministic distinct notes only within the new file',async()=>{
  await seed('Órgão múltiplo',{emails:['obsoleto@example.invalid']});const j=await ready('CONTACTS',[
   contact('Órgão múltiplo',{emails:['z@example.invalid'],phones:['31999998888'],notes:'WhatsApp cadastrado: (31) 99999-8888'}),
   contact('Órgão múltiplo',{source_line:3,emails:['a@example.invalid'],phones:['3133334444'],notes:'Telefone informado: 0800 111 2222'}),
   contact('Órgão múltiplo',{source_line:4,emails:['z@example.invalid'],phones:['3133334444'],notes:'Telefone informado: 0800 111 2222'})]);
  await publish(j,await preview(j));const c=await card('Órgão múltiplo');assert.deepEqual(c.emails,['a@example.invalid','z@example.invalid']);assert.deepEqual(c.phones,['3133334444','31999998888']);assert.equal(c.notes,'Telefone informado: 0800 111 2222\nWhatsApp cadastrado: (31) 99999-8888');
 });
 await test('customers absent from a partial contact file keep their original cards unchanged',async()=>{
  await seed('Órgão ausente');const old=await card('Órgão ausente');await seed('Outro órgão',{emails:['outro@example.invalid']});assert.deepEqual(await card('Órgão ausente'),old);
 });
 await test('manual contact edits and deletions preserve the whole card including notes',async()=>{
  const t=await title('Órgão manual');await seed('Órgão manual');await actor('cr');const context=await scalar('SELECT public.collection_customer_context($1) r',[t]);
  await scalar('SELECT public.save_collection_customer_contacts($1,$2::jsonb,$3::jsonb,$4,$5,$6) r',[t,'[]','[]','Exclusão manual conferida',context.contact.revision,randomUUID()]);
  const before=await card('Órgão manual'),j=await ready('CONTACTS',[contact('Órgão manual',{notes:'Observação da fonte'})]),p=await preview(j);assert.equal(p.manual_preserved_count,1);await publish(j,p);assert.deepEqual(await card('Órgão manual'),before);
 });
 await test('fatal invalid row quarantines all rows for that customer rather than deleting channels from a partial valid subset',async()=>{
  await seed('Órgão inválido',{emails:['preservado@example.invalid'],phones:['3133334444']});const before=await card('Órgão inválido');
  const j=await ready('CONTACTS',[contact('Órgão inválido',{emails:['novo@example.invalid']}),contact('Órgão inválido',{source_line:3,emails:[],phones:[]})]);const p=await preview(j);assert.equal(p.invalid_count,2);assert.equal(p.eligible_count,0);assert(p.examples.every(x=>x.problem.startsWith('INVALID_CUSTOMER_ROWS')));await reject(()=>publish(j,p,{ack:false}),'P0028');await publish(j,p);assert.deepEqual(await card('Órgão inválido'),before);
 });
 await test('incoming limits ignore obsolete channels and refuse more than 50 new channels without truncation',async()=>{
  await seed('Limite fonte',{emails:Array.from({length:50},(_,i)=>`old${i}@example.invalid`)});const j=await ready('CONTACTS',[contact('Limite fonte',{emails:['somente-novo@example.invalid']})]);assert.equal((await preview(j)).invalid_count,0);await publish(j,await preview(j));assert.deepEqual((await card('Limite fonte')).emails,['somente-novo@example.invalid']);
  const before=await card('Limite fonte'),excess=await ready('CONTACTS',[contact('Limite fonte',{emails:Array.from({length:50},(_,i)=>`new${i}@example.invalid`)}),contact('Limite fonte',{source_line:3,emails:['excesso@example.invalid']})]);const p=await preview(excess);assert.equal(p.invalid_count,2);assert(p.examples.every(x=>x.problem.startsWith('LIMIT_METHODS')));await publish(excess,p);assert.deepEqual(await card('Limite fonte'),before);
 });
 await test('fatal parser overflow cannot collide with an earlier valid canonical row and escape whole-customer quarantine',async()=>{
  await seed('Colisão canônica',{emails:['preservado@example.invalid']});const before=await card('Colisão canônica'),fifty=Array.from({length:50},(_,i)=>`canal${i}@example.invalid`);
  const csv=referenceCsvRow(['source_line',...REFERENCE_HEADERS.contacts])+referenceCsvRow(['2','Colisão canônica',fifty.join(','),'',''])+referenceCsvRow(['3','Colisão canônica',[...fifty,'excesso@example.invalid'].join(','),'','']);
  const parsed=parseReferenceCsv(csv,'contacts');assert(parsed.problems.some(p=>p.source_line===3&&p.code==='LIMIT_METHODS'));assert.deepEqual(parsed.rows[1].emails,fifty);assert.deepEqual(parsed.rows[1].phones,[]);
  const j=await ready('CONTACTS',parsed.rows,{problems:parsed.problems}),p=await preview(j);assert.equal(p.row_count,2);assert.equal(p.invalid_count,2);assert.equal(p.eligible_count,0);await publish(j,p);assert.deepEqual(await card('Colisão canônica'),before);
 });
 await test('legacy staged chunk retries preserve canonical payload hashes and return before applying the new invalid-row hash',async()=>{
  const artifact=Buffer.from('source_line,synthetic\n'+legacyBrokenRows.map(r=>r.source_line+',sintetico').join('\n'));
  const r=await gateway('stage_collection_reference_chunk_from_gateway',[legacyBroken.job_id,0,digest(artifact),artifact.toString('base64'),JSON.stringify(legacyBrokenRows),JSON.stringify(legacyBrokenProblems)]);assert.equal(r.duplicate,true);await owner();assert.deepEqual(await scalar('SELECT jsonb_agg(to_jsonb(r) ORDER BY row_hash) r FROM cf_private.collection_reference_rows r WHERE job_id=$1',[legacyBroken.job_id]),legacyBrokenSource);
 });
 await test('legacy preparation with an already-lost fatal row quarantines the job without rewriting immutable rows or contacts',async()=>{
  const before=await card('Legado inválido'),p=await preview(legacyBroken);assert.equal(p.eligible_count,0);assert.equal(p.invalid_count,1);assert.match(p.examples[0].problem,/^SOURCE_INVALID_ROWS_UNRESOLVED/);await publish(legacyBroken,p);assert.deepEqual(await card('Legado inválido'),before);await owner();const current=await scalar('SELECT jsonb_agg(to_jsonb(r) ORDER BY row_hash) r FROM cf_private.collection_reference_rows r WHERE job_id=$1',[legacyBroken.job_id]);for(const key of ['canonical','row_hash','source_line','invalid','problems'])assert.deepEqual(current[0][key],legacyBrokenSource[0][key]);
 });
 await test('aggregated annotations above 5000 characters quarantine the entire customer and retain previous source notes',async()=>{
  await seed('Notas extensas',{notes:'Anterior'});const before=await card('Notas extensas'),j=await ready('CONTACTS',[contact('Notas extensas',{notes:'A'.repeat(3000)}),contact('Notas extensas',{source_line:3,notes:'B'.repeat(3000)})]);const p=await preview(j);assert.equal(p.invalid_count,2);assert(p.examples.every(x=>x.problem.startsWith('LIMIT_NOTES')));await publish(j,p);assert.deepEqual(await card('Notas extensas'),before);
 });
 await test('older prepared sources cannot overwrite contacts from a newer completed file',async()=>{
  const older=await ready('CONTACTS',[contact('Fonte temporal',{emails:['antigo@example.invalid']})]);await seed('Fonte temporal',{emails:['atual@example.invalid']});const before=await card('Fonte temporal'),p=await preview(older);assert.equal(p.invalid_count,1);assert.match(p.examples[0].problem,/^SOURCE_OLDER/);await publish(older,p);assert.deepEqual(await card('Fonte temporal'),before);
 });
 await test('identical data from a different file does not rewrite the card and still prevents a delayed intermediate source rollback',async()=>{
  await seed('Arquivo idêntico',{emails:['atual@example.invalid']});const delayed=await ready('CONTACTS',[contact('Arquivo idêntico',{emails:['intermediario@example.invalid']})]);const oldPreview=await preview(delayed);assert.equal(oldPreview.eligible_count,1);assert.notEqual((await cache(delayed)).analysis_context_revision,null);const before=await card('Arquivo idêntico'),history=await audit('Arquivo idêntico');
  await seed('Arquivo idêntico',{emails:['atual@example.invalid']});assert.deepEqual(await card('Arquivo idêntico'),before);assert.deepEqual(await audit('Arquivo idêntico'),history);assert.equal((await cache(delayed)).analysis_context_revision,null);const p=await preview(delayed);assert.equal(p.invalid_count,1);assert.match(p.examples[0].problem,/^SOURCE_OLDER/);await reject(()=>publish(delayed,oldPreview,{ack:false}),'P0028');assert.deepEqual(await card('Arquivo idêntico'),before);
 });
 await test('lost response retries return the same publication result without repeated contact or audit mutations',async()=>{
  const j=await ready('CONTACTS',[contact('Repetição segura')]),p=await preview(j),request=randomUUID(),r=await publish(j,p,{request}),before=await card('Repetição segura'),history=await audit('Repetição segura');assert.deepEqual(await publish(j,p,{request}),r);assert.deepEqual(await card('Repetição segura'),before);assert.deepEqual(await audit('Repetição segura'),history);
 });
 await test('old already-published protocol replays remain idempotent without reapplying historical union data',async()=>{
  const before=await card('Contato legado');assert.equal(legacyResult.contact_refresh_version,undefined);assert.deepEqual(await publish(legacy,legacyPreview,{request:legacyRequest}),legacyResult);assert.deepEqual(await card('Contato legado'),before);assert.equal((await preview(legacy)).remaining_rows,0);
 });
 await test('cache reuses classification and source replacement invalidates older contact previews through context revision',async()=>{
  const j=await ready('CONTACTS',[contact('Cache contatos',{emails:['a@example.invalid']})]);await preview(j);const before=await cache(j);await preview(j);assert.deepEqual(await cache(j),before);await seed('Cache contatos',{emails:['b@example.invalid']});const p=await preview(j),after=await cache(j);assert.notEqual(after.analysis_context_revision,before.analysis_context_revision);assert.equal(p.invalid_count,1);
 });
 await test('name-only CNPJ ambiguity stays quarantined and description import remains unchanged',async()=>{
  await title('Órgão CNPJ','12345678000100');const j=await ready('CONTACTS',[contact('Órgão CNPJ')]),p=await preview(j);assert.equal(p.ambiguous_count,1);await publish(j,p);assert.equal(await card('Órgão CNPJ'),undefined);
  const t=await title('Cliente descrição');await owner();const document=await scalar('SELECT document r FROM public.receivable_titles WHERE id=$1',[t]);const d=await ready('DESCRIPTIONS',[{source_line:2,client_name:'Cliente descrição',client_document:null,branch:'4',document,description:'Descrição sintética',contract:null}]),q=await preview(d);assert.equal(q.contact_refresh_version,undefined);assert.equal(q.eligible_count,1);const r=await publish(d,q);assert.equal(r.contact_refresh_version,undefined);assert.equal(r.published_rows,1);
 });
 await test('a manual edit between preview and publish is reclassified and preserved without a financial change',async()=>{
  const t=await title('Edição concorrente'),j=await ready('CONTACTS',[contact('Edição concorrente')]),p=await preview(j);assert.equal(p.eligible_count,1);await actor('cr');const context=await scalar('SELECT public.collection_customer_context($1) r',[t]);await scalar('SELECT public.save_collection_customer_contacts($1,$2::jsonb,$3::jsonb,$4,$5,$6) r',[t,'["manual@example.invalid"]','[]','Observação manual preservada',context.contact.revision,randomUUID()]);const before=await card('Edição concorrente');const r=await publish(j,p);assert.equal(r.skipped_manual_rows,1);assert.deepEqual(await card('Edição concorrente'),before);
 });
 await test('financial changes after preview require a fresh analysis before publishing',async()=>{
  const j=await ready('CONTACTS',[contact('Revisão financeira')]),p=await preview(j);await title('Novo título financeiro');await reject(()=>publish(j,p),'40001');assert.equal(await card('Revisão financeira'),undefined);await publish(j,await preview(j));assert.deepEqual((await card('Revisão financeira')).emails,['origem@example.invalid']);
 });
 await test('context revision races during classification roll back derived results and never cache an inconsistent analysis',async()=>{
  const j=await ready('CONTACTS',[contact('Conferência concorrente')]);await owner();const revision=await scalar('SELECT revision r FROM cf_private.collection_context_state WHERE singleton');await db.exec(`CREATE FUNCTION cf_private.synthetic_contact_refresh_race() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE cf_private.collection_context_state SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;CREATE TRIGGER synthetic_contact_refresh_race AFTER UPDATE ON cf_private.collection_reference_rows FOR EACH STATEMENT EXECUTE FUNCTION cf_private.synthetic_contact_refresh_race();`);await reject(()=>preview(j),'40001');assert.equal((await cache(j)).analysis_at,null);assert.equal(await scalar('SELECT revision r FROM cf_private.collection_context_state WHERE singleton'),revision);await db.exec('DROP TRIGGER synthetic_contact_refresh_race ON cf_private.collection_reference_rows;DROP FUNCTION cf_private.synthetic_contact_refresh_race()');assert.equal((await preview(j)).eligible_count,1);
 });
 await test('private source ownership, function ACLs and revoked sessions stay enforced',async()=>{
  const j=await ready('CONTACTS',[contact('Acesso restrito')]);for(const who of ['manager','manager2','director','cp','collector'])await reject(()=>gateway('preview_collection_reference_import_from_gateway',[j.job_id],who));
  for(const role of ['anon','authenticated']){await owner();await db.exec('SET ROLE '+role);await reject(()=>scalar('SELECT public.preview_collection_reference_import_from_gateway($1,$2,$3) r',[users.cr.id,users.cr.session,j.job_id]))}
  await owner();await db.query('DELETE FROM cf_private.approved_sessions WHERE session_id=$1',[users.cr.session]);await reject(()=>preview(j));
 });
 await test('large contact refresh preserves both financial and context revision fences and remains cached',async()=>{
  const rows=Array.from({length:4356},(_,i)=>contact(`Órgão de escala ${i}`,{source_line:i+2,emails:i===5?[]:[`escala${i}@example.invalid`]}));const problems=[{source_line:7,code:'MISSING_CONTACT',field:'contacts',message:'Linha sintética sem canal válido'}];const j=await ready('CONTACTS',rows,{problems}),start=performance.now(),p=await preview(j),elapsed=Math.round(performance.now()-start),before=await cache(j);assert.equal(p.row_count,4356);assert.equal(p.eligible_count,4355);assert.equal(p.invalid_count,1);assert.equal(p.contact_refresh_version,'052');assert.deepEqual(await preview(j),p);assert.deepEqual(await cache(j),before);console.log(`PERF CONTACTS 4356 linhas com problemas fatais preservados: ${elapsed} ms`);
 });
 console.log(`${passed} contact refresh SQL checks passed.`);
}finally{await db.close()}
