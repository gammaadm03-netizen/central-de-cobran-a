import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// PostgreSQL descartável; dados e arquivos estritamente sintéticos.
const db = new PGlite();
const roles = ['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const users = Object.fromEntries(roles.map((name,i)=>[name,{
  id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
  session:`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
}]));
const agents=['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'];
const migration=await readFile(new URL('../supabase/migrations/023_receivable_sync.sql',import.meta.url),'utf8');
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].r;
let passed=0,failed=0,current='contas_receber',fileSequence=0;
const owner=()=>db.exec('RESET ROLE');
const actor=async(name='contas_receber')=>{
  current=name;await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[
    users[name].id,JSON.stringify({session_id:users[name].session})]);
  await db.exec('SET ROLE authenticated');
};
const reject=(fn,code='42501')=>assert.rejects(fn,error=>{assert.equal(error.code,code,error.message);return true;});
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack??error.message);}};
const row=(document,changes={})=>({document,client_name:`Cliente sintético ${document}`,client_document:null,
  branch:'2 - TESTE',issued_on:'2026-10-01',due_date:'2026-10-10',amount_cents:10000,...changes});
const preview=(rows,mappings={})=>scalar('SELECT public.preview_receivables_open_import($1,$2::jsonb,$3::jsonb) AS r',[
  'grupo-consolidado',JSON.stringify(rows),JSON.stringify(mappings)]);
const revision=()=>scalar('SELECT public.get_receivables_sync_revision() AS r');
const original=(name)=>{
  const bytes=Buffer.from(`Arquivo financeiro sintético ${name}\n`);
  return {hash:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
};
const commitSql='SELECT public.commit_receivables_open_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) AS r';
const args=async(rows,{name=`arquivo-${++fileSequence}`,mappings={},previous,financial}={})=>{
  const r=await revision(),file=original(name);
  return [users[current].id,users[current].session,'grupo-consolidado',`${name}.csv`,file.hash,file.base64,
    JSON.stringify(rows),JSON.stringify(mappings),previous===undefined?r.import_id:previous,financial===undefined?r.financial_revision:financial];
};
const gateway=async(parameters,sql=commitSql)=>{
  await owner();await db.exec('SET ROLE service_role');
  try{return await scalar(sql,parameters);}finally{await db.exec('RESET ROLE;SET ROLE authenticated');}
};
const commit=async(rows,options)=>gateway(await args(rows,options));
const title=id=>scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1',[id]);
const state=async()=>{
  await owner();
  return scalar(`SELECT jsonb_build_object(
   'imports',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.receivable_imports t),
   'titles',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.receivable_titles t),
   'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.receivable_receipts t),
   'files',(SELECT coalesce(jsonb_agg(jsonb_build_array(import_id,encode(file_bytes,'base64')) ORDER BY import_id),'[]') FROM cf_private.receivable_import_files),
   'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY source_key),'[]') FROM cf_private.receivable_parcel_aliases t),
   'provenance',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY import_id),'[]') FROM public.receivable_sync_imports t),
   'revision',cf_private.receivables_sync_revision_value(),
   'audits',(SELECT count(*) FROM public.audit_events),'banks',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.bank_accounts t)) AS r`);
};
const unchanged=async(fn)=>{const before=await state();await actor();await fn();assert.deepEqual(await state(),before);};

try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for(const file of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql',
    '006_treasury.sql','007_director_positions.sql','008_receivables.sql'])
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  await test('009 dependency failure rolls back all new structures',async()=>{
    await reject(()=>db.exec(migration),'22023');await db.exec('ROLLBACK');
    assert.equal(await scalar("SELECT to_regclass('public.receivable_sync_imports')::text AS r"),null);
  });
  await db.exec(await readFile(new URL('../supabase/migrations/009_collections.sql',import.meta.url),'utf8'));
  for(const [name,user] of Object.entries(users)){
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[user.id,`${name}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)',[user.id,name]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[user.session,user.id]);
  }
  for(const [i,id] of agents.entries()){
    await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[id,`Cobradora sintética ${i+1}`]);
    await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[users[`cobradora_${i+1}`].id,id,users.gerente_geral.id]);
  }
  const a=row('NF-A'),a2=row('NF-A',{due_date:'2026-10-20',amount_cents:20000}),paid=row('NF-P',{amount_cents:30000});
  await actor();const oldFile=original('legacy');
  const legacy=await gateway([users.contas_receber.id,users.contas_receber.session,'grupo-consolidado','legacy.csv',oldFile.hash,oldFile.base64,
    JSON.stringify([a,a2,paid]),true,null],
  'SELECT public.commit_receivables_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) AS r');
  await owner();
  const legacyRows=(await db.query('SELECT id,document,due_date::text FROM public.receivable_titles')).rows;
  const aid=legacyRows.find(t=>t.document==='NF-A'&&t.due_date==='2026-10-10').id;
  const a2id=legacyRows.find(t=>t.document==='NF-A'&&t.due_date==='2026-10-20').id;
  const pid=legacyRows.find(t=>t.document==='NF-P').id;
  await db.query("UPDATE public.receivable_titles SET collector_id=$1 WHERE document='NF-A'",[agents[0]]);
  await db.query("UPDATE public.receivable_titles SET status='PENDING_VALIDATION',validation_status='PENDING',payment_source='IMPORTACAO_DIARIA' WHERE id=$1",[pid]);
  await actor();
  await scalar("SELECT public.validate_receivable_payment($1,'CONFIRM','2026-10-11','Conferência sintética',$2) AS r",[pid,(await title(pid)).revision]);
  let oldState;
  await test('activation preserves source UUIDs, financial rows, receipts, original files and audit history',async()=>{
    await owner();
    oldState=await scalar(`SELECT jsonb_build_object('titles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.receivable_titles t),
      'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.receivable_receipts t),'audits',(SELECT count(*) FROM public.audit_events),
      'files',(SELECT jsonb_agg(jsonb_build_array(import_id,encode(file_bytes,'base64')) ORDER BY import_id) FROM cf_private.receivable_import_files)) AS r`);
    await db.exec(migration);
    const now=await state();for(const key of ['titles','receipts','audits','files'])assert.deepEqual(now[key],oldState[key]);
    assert.equal(await scalar("SELECT import_mode AS r FROM public.receivable_imports WHERE id=$1",[legacy.import_id]),'LEGACY');
    assert.equal(now.revision,'0');assert.equal(now.aliases.length,0);
  });
  await test('official CR and manager import; director reads revision only; no forged role or browser writes',async()=>{
    for(const name of roles){
      await actor(name);
      if(['contas_receber','gerente_geral'].includes(name)){
        assert.equal((await preview([row(`PERM-${name}`)])).new_count,1);
        assert.equal((await scalar('SELECT public.receivables_import_capabilities() AS r')).open_sync,true);
      }else await reject(()=>preview([row('FORGED')]));
      if(['contas_receber','gerente_geral','diretor'].includes(name))assert.equal(typeof (await revision()).financial_revision,'string');
      else await reject(()=>revision());
      await reject(()=>db.query('UPDATE public.receivable_titles SET amount_cents=0'));
      await reject(()=>db.query('SELECT * FROM cf_private.receivable_parcel_aliases'));
      await reject(()=>db.query('SELECT * FROM cf_private.receivable_import_files'));
      await reject(()=>db.query(commitSql,[users[name].id,users[name].session,'grupo-consolidado','x',oldFile.hash,oldFile.base64,JSON.stringify([a]),'{}',null,'0']));
    }
    await actor('diretor');await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({session_id:users.diretor.session,role:'gerente_geral'})]);
    await reject(()=>preview([a]));
    await owner();await db.exec('SET ROLE anon');await reject(()=>revision());
  });
  let first;
  await test('amount change preserves parcel UUID, collector and legacy source key; absence remains byte-identical',async()=>{
    await actor();const oldA=await title(aid),absent=await title(a2id),oldPaid=await title(pid);
    const p=await preview([{...a,amount_cents:11000}]);assert.equal(p.rows[0].title_id,aid);assert.equal(p.changed_count,1);assert.equal(p.pending_count,0);
    first=await commit([{...a,amount_cents:11000}],{name:'amount-update'});
    const now=await title(aid);assert.equal(now.id,aid);assert.equal(now.amount_cents,11000);assert.equal(now.collector_id,agents[0]);
    assert.equal(now.source_key,oldA.source_key);assert.equal(now.first_import_id,legacy.import_id);assert.equal(now.status,'OPEN');
    assert.deepEqual(await title(a2id),absent);assert.deepEqual(await title(pid),oldPaid);
    await owner();const audit=await scalar("SELECT to_jsonb(t) AS r FROM public.audit_events t WHERE entity='receivable_titles' AND record_id=$1 AND after_value->>'amount_cents'='11000' ORDER BY occurred_at DESC LIMIT 1",[aid]);
    assert.equal(audit.before_value.amount_cents,10000);assert.equal(audit.after_value.amount_cents,11000);
    assert.equal((await state()).receipts.length,1);
  });
  await test('same-file replay is idempotent even with stale financial and import tokens',async()=>{
    const before=await state();await actor();const parameters=await args([{...a,amount_cents:11000}],{name:'amount-update',previous:null,financial:null});
    const replay=await gateway(parameters);assert.equal(replay.import_id,first.import_id);assert.equal(replay.idempotent,true);
    assert.deepEqual(await state(),before);
  });
  const moved={...a,due_date:'2026-10-15',amount_cents:11000};
  await test('NF with known parcels and new due date is ambiguous until operator chooses title or NEW',async()=>{
    await actor();const p=await preview([moved]);assert.equal(p.can_commit,false);assert.equal(p.rows[0].outcome,'AMBIGUOUS');
    assert.equal(p.rows[0].candidates.length,2);assert.equal(p.conflict_count,1);assert.equal(p.errors[0].line,1);
    await unchanged(()=>reject(async()=>commit([moved],{name:'ambiguous'}),'P0023'));
  });
  await test('explicit due-date correction appends immutable alias and keeps history and ownership',async()=>{
    await actor();const old=await title(aid);await commit([moved],{name:'due-moved',mappings:{1:aid}});
    const now=await title(aid);assert.equal(now.id,aid);assert.equal(now.due_date,'2026-10-15');assert.equal(now.collector_id,old.collector_id);
    await owner();const aliases=await scalar('SELECT count(*)::int AS r FROM cf_private.receivable_parcel_aliases WHERE title_id=$1',[aid]);assert.equal(aliases,2);
    await reject(()=>db.query('UPDATE cf_private.receivable_parcel_aliases SET title_id=$1 WHERE title_id=$2',[a2id,aid]));
    await actor();assert.equal((await preview([{...a,amount_cents:11000}])).rows[0].title_id,aid);
  });
  await test('explicit NEW creates a distinct installment and inherits the sole active customer collector',async()=>{
    const next={...a,due_date:'2026-10-25',amount_cents:12000};await actor();
    const p=await preview([next],{1:'NEW'});assert.equal(p.can_commit,true);assert.equal(p.new_count,1);
    await commit([next],{name:'new-parcel',mappings:{1:'NEW'}});
    const created=await scalar("SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE document='NF-A' AND due_date='2026-10-25'");
    assert.notEqual(created.id,aid);assert.equal(created.collector_id,agents[0]);
    assert.equal((await preview([next],{1:'NEW'})).rows[0].outcome,'CONFLICT');
  });
  await test('first report can contain several installments of a previously unknown NF',async()=>{
    await actor();const rows=[row('NEW-GROUP'),row('NEW-GROUP',{due_date:'2026-11-10'})];
    assert.equal((await preview(rows)).new_count,2);const r=await commit(rows,{name:'new-multi'});assert.equal(r.new_count,2);
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.receivable_titles WHERE document='NEW-GROUP'"),2);
  });
  await test('duplicate parcel identity rejects differing amounts; mapping two aliases to one UUID rejects all',async()=>{
    await unchanged(async()=>{
      await reject(()=>preview([a,{...a,amount_cents:9}]),'23505');
      const p=await preview([{...a,amount_cents:11000},moved]);assert.equal(p.can_commit,false);assert.equal(p.conflict_count,2);
      await reject(()=>commit([{...a,amount_cents:11000},moved],{name:'two-alias-one-id'}),'P0023');
    });
  });
  await test('mapping is scoped by customer/document/branch and cannot steal another title UUID',async()=>{
    await unchanged(async()=>{
      const p=await preview([moved],{1:pid});assert.equal(p.can_commit,false);assert.equal(p.rows[0].outcome,'CONFLICT');
      await reject(()=>commit([moved],{name:'steal-id',mappings:{1:pid}}),'P0023');
      for(const mappings of [{foo:aid},{0:aid},{2:aid},{1:0},{1:'invalid'},{1:null}])await reject(()=>preview([moved],mappings),'22023');
    });
  });
  await test('strict canonical fields, cents, dates, scope and customer identity guards remain enforced',async()=>{
    await unchanged(async()=>{
      for(const bad of [{...a,amount_cents:-1},{...a,amount_cents:1.5},{...a,amount_cents:'100'},
        {...a,due_date:'2026-02-30'},{...a,collector_id:agents[1]},{...a,client_document:'123'},
        {...a,amount_cents:9007199254740992}])await reject(()=>preview([bad]),'22023');
      await reject(()=>preview([{...moved,amount_cents:12500,client_document:'12345678000100'}]),'23514');
      await reject(()=>db.query('SELECT public.preview_receivables_open_import($1,$2::jsonb)', ['branch-only',JSON.stringify([a])]),'22023');
    });
  });
  await test('changing CNPJ and amount together cannot bypass established customer identity',async()=>{
    await actor();const originalRow=row('CNPJ-STABLE',{client_document:'11111111000111'});
    await commit([originalRow],{name:'cnpj-original'});
    await unchanged(()=>reject(()=>preview([{...originalRow,client_document:'22222222000122',amount_cents:15000}]),'23514'));
  });
  await test('validated receipt is never reset, deleted or silently changed by open import',async()=>{
    await actor();const before=await title(pid),receipt=(await state()).receipts[0];await actor();
    const p=await preview([{...paid,amount_cents:31000}]);assert.equal(p.can_commit,false);assert.equal(p.rows[0].outcome,'CONFLICT');
    await reject(()=>commit([{...paid,amount_cents:31000}],{name:'paid-rewrite'}),'P0023');
    const exact=await commit([paid],{name:'paid-preserve'});assert.equal(exact.validated_in_source_count,1);
    assert.equal((await title(pid)).status,'VALIDATED');assert.equal((await title(pid)).payment_date,before.payment_date);
    assert.deepEqual((await state()).receipts[0],receipt);
  });
  await test('new writes require financial revision and latest import; stale preview after collection action fails atomically',async()=>{
    await actor();const p=await preview([moved]);
    await scalar("SELECT public.record_collection_action($1,'CONTACT','2026-10-11',NULL,NULL,'Contato sintético',NULL,NULL,$2) AS r",[aid,(await title(aid)).revision]);
    await unchanged(async()=>{
      await reject(()=>commit([moved],{name:'stale-finance',previous:p.previous_import_id,financial:p.financial_revision}),'40001');
      await reject(()=>commit([moved],{name:'null-finance',financial:null}),'40001');
      await reject(()=>commit([moved],{name:'old-import',previous:null}),'40001');
    });
  });
  await test('audit failure rolls back titles, alias, revision, original file and provenance as one transaction',async()=>{
    await owner();await db.exec(`CREATE FUNCTION public.reject_sync_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.entity='receivable_sync_imports' THEN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE='P0099';END IF;RETURN NEW;END$$;
      CREATE TRIGGER reject_sync_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_sync_audit();`);
    try{await unchanged(()=>reject(()=>commit([row('AUDIT-FAIL')],{name:'audit-fail'}),'P0099'));}
    finally{await owner();await db.exec('DROP TRIGGER reject_sync_audit ON public.audit_events;DROP FUNCTION public.reject_sync_audit()');}
  });
  await test('hash integrity, original bytes and filenames are checked before any source mutation',async()=>{
    await unchanged(async()=>{
      for(const [position,value] of [[4,'0'.repeat(64)],[3,'../synthetic.csv'],[5,'%%%']]){
        const parameters=await args([row('BAD-FILE')]);parameters[position]=value;await reject(()=>gateway(parameters),'22023');
      }
    });
  });
  await test('legacy public import now uses incremental absence semantics and does not create receipts',async()=>{
    await actor();const absent=await title(a2id),before=await revision(),file=original('legacy-client-new-safe');
    const result=await gateway([users.contas_receber.id,users.contas_receber.session,'grupo-consolidado','legacy-client.csv',file.hash,file.base64,
      JSON.stringify([row('LEGACY-NEW')]),true,before.import_id],
    'SELECT public.commit_receivables_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) AS r');
    assert.equal(result.pending_count,0);assert.equal(result.mode,'open');assert.deepEqual(await title(a2id),absent);
    assert.equal((await state()).receipts.length,1);
  });
  await test('original hash may be imported once in OPEN even when identical legacy file already exists',async()=>{
    await actor();const previous=await revision();
    const r=await gateway([users.contas_receber.id,users.contas_receber.session,'grupo-consolidado','legacy.csv',oldFile.hash,oldFile.base64,
      JSON.stringify([a,a2,paid]),'{}',previous.import_id,previous.financial_revision]);
    assert.notEqual(r.import_id,legacy.import_id);
    await owner();assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_imports WHERE file_sha256=$1',[oldFile.hash]),2);
  });
  await test('source/provenance are readable only by CR finance; director cannot mutate and no bank balance changes',async()=>{
    await actor('diretor');assert((await scalar('SELECT count(*)::int AS r FROM public.receivable_sync_imports'))>0);
    await reject(()=>db.query("DELETE FROM public.receivable_sync_imports"));await reject(()=>scalar('SELECT public.receivables_import_capabilities() AS r'));
    await actor('cobradora_1');assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_sync_imports'),0);
    await owner();await reject(()=>db.query("DELETE FROM public.receivable_sync_imports"));
    const beforeBanks=(await state()).banks;assert(beforeBanks.length>0);
    await actor();await commit([row('BANK-UNCHANGED')],{name:'no-bank-effect'});assert.deepEqual((await state()).banks,beforeBanks);
  });
  await test('service gateway cannot import as director or use another user session, expired or revoked approvals',async()=>{
    await actor();const parameters=await args([row('AUTH-GUARD')]);
    for(const [user,session] of [[users.diretor.id,users.diretor.session],[users.contas_receber.id,users.gerente_geral.session]]){
      const changed=[...parameters];changed[0]=user;changed[1]=session;await reject(()=>gateway(changed));
    }
    await owner();await db.query("INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)",[users.contas_receber.session,users.contas_receber.id]);
    try{await reject(()=>gateway(parameters));}
    finally{await owner();await db.query('DELETE FROM cf_private.revoked_sessions WHERE session_id=$1',[users.contas_receber.session]);}
    await db.query("UPDATE cf_private.approved_sessions SET expires_at=now()-interval '1 day' WHERE session_id=$1",[users.contas_receber.session]);
    try{await reject(()=>gateway(parameters));}
    finally{await owner();await db.query("UPDATE cf_private.approved_sessions SET expires_at=now()+interval '7 days' WHERE session_id=$1",[users.contas_receber.session]);}
  });
  await test('022 overdue-only collection RLS remains independent after the new sync migration',async()=>{
    await owner();await db.exec(await readFile(new URL('../supabase/migrations/022_collections_overdue_only.sql',import.meta.url),'utf8'));
    await actor();const future='2199-12-31';await commit([row('FUTURE',{due_date:future})],{name:'future'});
    await scalar("SELECT public.assign_receivable_collector($1,$2,'Atribuição sintética') AS r",['name:CLIENTE SINTÉTICO FUTURE',agents[0]]);
    await actor('cobradora_1');assert.equal(await scalar("SELECT count(*)::int AS r FROM public.receivable_titles WHERE document='FUTURE'"),0);
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.collection_overdue_titles WHERE document='FUTURE'"),0);
    await actor('contas_receber');assert.equal(await scalar("SELECT count(*)::int AS r FROM public.receivable_titles WHERE document='FUTURE'"),1);
  });
  console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
} finally {await db.close();}
