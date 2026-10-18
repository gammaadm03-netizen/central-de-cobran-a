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
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack??e.message);}};
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
try{
 await setup();const a=await fixture({name:'Cliente Compartilhado',document:'NF-A'}),same=await fixture({name:'Cliente Compartilhado',document:'NF-B',branch:'Outra filial'});
 const future=await fixture({name:'Cliente Compartilhado',document:'NF-FUT',days:-10}),paid=await fixture({name:'Cliente Compartilhado',document:'NF-PAID',status:'VALIDATED'});
 const other=await fixture({name:'Cliente Outra Carteira',collector:agents[1]}),accent=await fixture({name:'Clíente Compartilhado'});
 await test('027 activation creates no financial records and preserves every original title and receipt',async()=>{
  const before=await financialState();await db.exec(await sql('027_collection_customer_context.sql'));assert.deepEqual(await financialState(),before);
  assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_customer_contacts'),0);
 });
 await test('context is only active and strictly overdue for every official role, including Director',async()=>{
  for(const r of roles){await actor(r);if(['gerente_geral','contas_receber','diretor','cobradora_1'].includes(r)){
   const c=await context(a);assert.equal(c.contact.record_revision,0);assert.equal(c.contact.emails.length,0);assert.equal(c.can_edit,r!=='diretor');
   await reject(()=>context(future));await reject(()=>context(paid));
  }else await reject(()=>context(a));}
  await actor('diretor');await reject(()=>save(a));await actor('cobradora_1');await reject(()=>context(other));
 });
 let first;
 await test('manual edits normalize and deduplicate multiple channels and record official reviewer without changing finances',async()=>{
  const before=await financialState();await actor('cobradora_1');first=await save(a,{emails:[' Financeiro@Example.Invalid ','financeiro@example.invalid','segundo@example.invalid'],phones:['(31) 3333-4444','+55 31 99999-1111'],notes:'Observação sintética'});
  assert.deepEqual(first.contact.emails,['financeiro@example.invalid','segundo@example.invalid']);assert.equal(first.contact.phones.length,2);assert(first.contact.reviewed_at);
  assert.equal(first.contact.reviewed_by,users.cobradora_1.id);assert.equal(first.contact.manually_edited,true);assert.deepEqual(await financialState(),before);
 });
 await test('all installments and branches share exact customer contacts; accent-different names never merge',async()=>{
  await actor('cobradora_1');assert.deepEqual((await context(same)).contact,first.contact);assert.equal((await context(accent)).contact.emails.length,0);
 });
 await test('empty arrays are an explicit reviewed manual deletion, not permission to seed again',async()=>{
  await actor('cobradora_1');const c=await save(a);assert.deepEqual(c.contact.emails,[]);assert.deepEqual(c.contact.phones,[]);assert(c.contact.manually_edited);assert(c.contact.reviewed_at);
  assert.equal(c.contact.record_revision,2);
 });
 await test('stale edits fail and exact request replay is canonical while changed UUID payload is refused',async()=>{
  await actor('cobradora_1');const c=await context(a);const request=randomUUID();const args=[a,JSON.stringify(['novo@example.invalid']),JSON.stringify([]),'Nota',c.contact.revision,request];
  const statement='SELECT public.save_collection_customer_contacts($1,$2::jsonb,$3::jsonb,$4,$5,$6) AS r';const result=await scalar(statement,args);
  assert.deepEqual(await scalar(statement,args),result);const changed=[...args];changed[3]='Outra nota';await reject(()=>scalar(statement,changed),'22023');
  await reject(()=>save(a,{revision:c.contact.revision}),'40001');
 });
 await test('validation rejects malformed channels, excessive counts and missing request or revision',async()=>{
  await actor('cobradora_1');for(const changes of [{emails:['bad']},{phones:['sem número']},{emails:Array(51).fill('valid@example.invalid')},{notes:'x'.repeat(5001)},{phones:['123\n456']}])await reject(()=>save(a,changes),'22023');
  await reject(()=>save(a,{revision:'forged'}),'40001');
 });
 await test('description RLS matches the same invoice/branch/customer and never leaks future or paid notes through another active invoice',async()=>{
  await owner();for(const titleId of [a,future,paid]){
   const t=await scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1',[titleId]);
   await db.query(`INSERT INTO public.collection_description_references(context_key,customer_key,branch,document,description,contract,content_sha256,source_job_id)
    VALUES(cf_private.collection_reference_key($1,$2,$3),$3,$1,$2,$4,NULL,encode(sha256(convert_to($4,'UTF8')),'hex'),$5)`,[t.branch,t.document,t.customer_key,'Descrição sintética '+t.document,uuid(999)]);
  }
  await actor('diretor');assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_description_references'),1);
  const c=await context(a);assert.equal(c.descriptions.state,'AVAILABLE');assert.equal(c.descriptions.variants[0].contract,null);
  await reject(()=>context(future));await reject(()=>context(paid));
 });
 await test('multiple variants with no source date remain pending and no last description is chosen automatically',async()=>{
  await owner();const t=await scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1',[a]);
  await db.query(`INSERT INTO public.collection_description_references(context_key,customer_key,branch,document,description,contract,content_sha256,source_job_id)
   VALUES(cf_private.collection_reference_key($1,$2,$3),$3,$1,$2,'Outra descrição sem data',NULL,repeat('b',64),$4)`,[t.branch,t.document,t.customer_key,uuid(999)]);
  await actor('cobradora_1');const c=await context(a);assert.equal(c.descriptions.state,'PENDING_VARIANTS');assert.equal(c.descriptions.count,2);assert.equal(c.descriptions.variants.length,2);
 });
 await test('coverage counts customers rather than installments; filters and audit snapshots use official actors/dates',async()=>{
  await actor('cobradora_1');const r=await report();assert.equal(r.scope_count,2);assert.equal(r.reviewed_count,1);assert.equal(r.with_contact_count,1);
  assert.equal(r.rows.find(c=>c.customer_key==='name:CLIENTE COMPARTILHADO').title_count,2);
  assert.equal((await report({coverage:'MISSING_EMAIL'})).count,1);assert.equal((await report({coverage:'REVIEWED'})).count,1);
  const changes=await report({view:'changes',start:today,end:today,by:users.cobradora_1.id});assert(changes.count>=3);assert(changes.rows.every(e=>e.created_by===users.cobradora_1.id));
  assert(changes.rows.some(e=>e.before===null));assert(changes.rows.some(e=>Array.isArray(e.after.emails)));assert(changes.rows.every(e=>e.after.reviewed_by===users.cobradora_1.id));
 });
 await test('paginated exports are fenced against both contact edits and wallet changes',async()=>{
  await actor('cobradora_1');const r=await report({limit:1});assert.equal(r.rows.length,1);assert.equal(r.count,2);
  await save(a,{emails:['fence@example.invalid']});await reject(()=>report({revision:r.snapshot_revision}),'40001');
  const next=await report();await owner();await db.query('UPDATE public.receivable_titles SET amount_cents=amount_cents+1 WHERE id=$1',[a]);await actor('cobradora_1');
  await reject(()=>report({revision:next.snapshot_revision}),'40001');
 });
 await test('direct tables are read-only and RLS rejects forged module grants for another official role',async()=>{
  await actor('cobradora_2');assert.equal(await scalar("SELECT count(*)::int AS r FROM public.collection_customer_contacts WHERE customer_key='name:CLIENTE COMPARTILHADO'"),0);
  await actor('cobradora_1');await reject(()=>db.query('UPDATE public.collection_customer_contacts SET emails=$1',[JSON.stringify([])]));await reject(()=>db.query('DELETE FROM public.collection_contact_events'));
  await owner();await db.exec("INSERT INTO public.role_permissions VALUES('rh_dp','cobranca','read')");
  await actor('rh_dp');await reject(()=>context(a));assert.equal(await scalar('SELECT count(*)::int AS r FROM public.collection_customer_contacts'),0);
 });
 await test('audit failure rolls back cards, reviewer, event and idempotency metadata together',async()=>{
  await owner();await db.exec(`CREATE FUNCTION public.reject_contact_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='collection_customer_contacts' THEN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE='P0099';END IF;RETURN NEW;END$$;CREATE TRIGGER reject_contact_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_contact_audit();`);
  await actor('cobradora_1');const before=await context(a);
  try{await reject(()=>save(a,{emails:['rollback@example.invalid']}),'P0099');const after=await context(a);delete before.server_now;delete after.server_now;assert.deepEqual(after,before);}
  finally{await owner();await db.exec('DROP TRIGGER reject_contact_audit ON public.audit_events;DROP FUNCTION public.reject_contact_audit()');}
 });
 console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
}finally{await db.close();}
