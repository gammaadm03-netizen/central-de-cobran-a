import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// PostgreSQL descartável; somente pessoas, títulos e arquivos sintéticos.
const db = new PGlite();
const roles = ['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const identities = Object.fromEntries(roles.map((role,index) => [role,{
  user:`10000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,
  session:`20000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,
}]));
const agents = ['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'];
const migration = await readFile(new URL('../supabase/migrations/022_collections_overdue_only.sql',import.meta.url),'utf8');
let passed=0,failed=0,sequence=0,importId,today,yesterday,tomorrow;
const owner = () => db.exec('RESET ROLE');
const scalar = async(sql,args=[]) => (await db.query(sql,args)).rows[0].r;
const asUser = async role => {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[
    identities[role].user,JSON.stringify({ session_id:identities[role].session })]);
  await db.exec('SET ROLE authenticated');
};
const reject = (sql,args=[],code='42501') => assert.rejects(db.query(sql,args),error => {
  assert.equal(error.code,code,error.message);return true;
});
const test = async(name,run) => {
  try { await run();passed++;console.log('PASS',name); }
  catch(error) { failed++;console.error('FAIL',name,error.stack??error.message); }
};
const title = async id => scalar('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1',[id]);
const ids = async(table='collection_overdue_titles',active=false) =>
  (await db.query(`SELECT id FROM public.${table}${active ? " WHERE status<>'VALIDATED'" : ''} ORDER BY id`)).rows.map(row=>row.id);
const fixture = async(options={}) => {
  await owner();const number=++sequence;
  const row={document:`NF-${number}`,client_name:`Cliente sintético ${number}`,customer_key:`name:CLIENTE SINTÉTICO ${number}`,
    due_date:yesterday,amount_cents:10000,collector_id:agents[0],status:'NEW',validation_status:'NONE',
    payment_source:null,payment_date:null,...options};
  return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,
    amount_cents,collector_id,status,validation_status,payment_source,payment_date,first_import_id,last_import_id)
    VALUES('grupo-consolidado',$1,$2,$3,$4,'Filial sintética',$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id AS r`,[
    `synthetic-key-${number}`,row.document,row.client_name,row.customer_key,row.due_date,row.amount_cents,row.collector_id,
    row.status,row.validation_status,row.payment_source,row.payment_date,importId]);
};
const actionSql='SELECT public.record_collection_action($1,$2,$3,NULL,NULL,$4,NULL,$5,$6) AS r';
const act = (id,{action='CONTACT',paymentDate=null,revision=1}={}) =>
  scalar(actionSql,[id,action,today,'Contato sintético',paymentDate,revision]);
const financialValidate = async(id,date=today) => {
  const current=await title(id);
  return scalar('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5) AS r',[
    id,'CONFIRM',date,'Entrada financeira sintética conferida',current.revision]);
};
const preservedState = async() => {
  await owner();
  const names=['profiles','role_permissions','collection_agents','collector_bindings','receivable_imports','receivable_titles',
    'receivable_collection_events','receivable_receipts','audit_events','payable_titles','bank_accounts','director_positions'];
  const state={};
  for(const table of names) state[table]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS r FROM public.${table} t`);
  return state;
};
const unchangedDuring = async run => {
  const before=await preservedState();await run();assert.deepEqual(await preservedState(),before);
};

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

  await test('009 is required; a failed activation leaves no partial view or migration marker',async()=>{
    await assert.rejects(db.exec(migration),error=>error.code==='22023');await db.exec('ROLLBACK');
    assert.equal(await scalar("SELECT to_regclass('public.collection_overdue_titles')::text AS r"),null);
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='022_collections_overdue_only'"),0);
  });
  await db.exec(await readFile(new URL('../supabase/migrations/009_collections.sql',import.meta.url),'utf8'));
  for(const [role,identity] of Object.entries(identities)) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[identity.user,`${role}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$2,true)',[identity.user,role]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[identity.session,identity.user]);
  }
  for(const [index,agent] of agents.entries()) {
    await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)',[agent,`Cobradora sintética ${index+1}`]);
    await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)',[
      identities[`cobradora_${index+1}`].user,agent,identities.gerente_geral.user]);
  }
  ({today,yesterday,tomorrow}=(await db.query(`SELECT
    (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today,
    ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text AS yesterday,
    ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text AS tomorrow`)).rows[0]);
  importId=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count)
    VALUES('grupo-consolidado','synthetic.csv',repeat('a',64),$1,1,1,0,0,0) RETURNING id AS r`,[identities.gerente_geral.user]);
  const past=await fixture(),dueToday=await fixture({due_date:today}),future=await fixture({due_date:tomorrow});
  const otherPast=await fixture({collector_id:agents[1]}),otherFuture=await fixture({collector_id:agents[1],due_date:tomorrow});
  const unassigned=await fixture({collector_id:null}),futureUnassigned=await fixture({collector_id:null,due_date:tomorrow});
  const pending=await fixture({status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA'});
  const pastValidated=await fixture({status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA'});
  const futureValidated=await fixture({due_date:tomorrow,status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA'});
  const prepaid=await fixture({due_date:tomorrow,status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA'});
  await asUser('cobradora_1');const futureEvent=await act(future);
  await asUser('contas_receber');const oldReceipt=await financialValidate(pastValidated),futureReceipt=await financialValidate(futureValidated);

  await test('022 preserves every financial row, owner, validated receipt and historical event',async()=>{
    const before=await preservedState();await db.exec(migration);assert.deepEqual(await preservedState(),before);
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='022_collections_overdue_only'"),1);
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='021_payable_paid_import'"),0);
  });
  await test('the collection view has invoker RLS and appends only the official reference date',async()=>{
    const options=await scalar("SELECT reloptions AS r FROM pg_class WHERE oid='public.collection_overdue_titles'::regclass");
    assert(options.includes('security_invoker=true'));assert(options.includes('security_barrier=true'));
    const base=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='receivable_titles' ORDER BY ordinal_position")).rows.map(row=>row.column_name);
    const view=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='collection_overdue_titles' ORDER BY ordinal_position")).rows.map(row=>row.column_name);
    assert.deepEqual(view,[...base,'collection_as_of_date']);
    assert.equal(await scalar("SELECT has_function_privilege('authenticated','cf_private.require_collection_title(public.receivable_titles)','EXECUTE') AS r"),false);
  });
  await test('CR and Director retain all titles; collection consultation excludes today and future for both',async()=>{
    for(const role of ['gerente_geral','contas_receber','diretor']) {
      await asUser(role);
      const all=await ids('receivable_titles'),overdue=await ids();
      for(const id of [past,dueToday,future,otherFuture,pending,pastValidated,futureValidated])assert(all.includes(id));
      for(const id of [past,otherPast,unassigned,pending,pastValidated])assert(overdue.includes(id));
      for(const id of [dueToday,future,otherFuture,futureValidated,prepaid])assert(!overdue.includes(id));
      assert.equal(await scalar('SELECT min(collection_as_of_date)::text AS r FROM public.collection_overdue_titles'),today);
    }
  });
  await test('each collector sees only their own overdue titles, even when reading the underlying table',async()=>{
    for(const [role,agent,ownPast,other] of [
      ['cobradora_1',agents[0],past,otherPast],['cobradora_2',agents[1],otherPast,past],
    ]) {
      await asUser(role);
      for(const table of ['receivable_titles','collection_overdue_titles']) {
        const rows=(await db.query(`SELECT * FROM public.${table}`)).rows;
        assert(rows.length>0);assert(rows.every(row=>row.collector_id===agent));
        const visible=rows.map(row=>row.id);assert(visible.includes(ownPast));assert(!visible.includes(other));
        for(const id of [dueToday,future,otherFuture,futureValidated,futureUnassigned])assert(!visible.includes(id));
      }
    }
  });
  await test('pending overdue payments remain active; validated overdue titles remain available only as history',async()=>{
    await asUser('cobradora_1');const active=await ids('collection_overdue_titles',true),all=await ids();
    assert(active.includes(pending));assert(!active.includes(pastValidated));assert(all.includes(pastValidated));
    assert.equal((await title(pending)).collector_id,agents[0]);assert.equal((await title(pending)).validation_status,'PENDING');
    assert.equal((await db.query('SELECT * FROM public.receivable_receipts WHERE id=$1',[oldReceipt])).rows.length,1);
    assert.equal((await db.query('SELECT * FROM public.receivable_receipts WHERE id=$1',[futureReceipt])).rows.length,0);
  });
  await test('past contact and prepaid receipt history is preserved but hidden from collectors before the due date',async()=>{
    await asUser('cobradora_1');assert.equal((await db.query('SELECT * FROM public.receivable_collection_events WHERE id=$1',[futureEvent])).rows.length,0);
    await asUser('contas_receber');assert.equal((await db.query('SELECT * FROM public.receivable_collection_events WHERE id=$1',[futureEvent])).rows.length,1);
    assert.equal((await db.query('SELECT * FROM public.receivable_receipts WHERE id=$1',[futureReceipt])).rows.length,1);
  });
  await test('GET and export-style pagination cause no title, assignment, receipt or audit mutation',async()=>{
    await unchangedDuring(async()=>{
      for(const role of ['gerente_geral','diretor','contas_receber','cobradora_1','cobradora_2']) {
        await asUser(role);await db.query("SELECT id,revision,updated_at FROM public.collection_overdue_titles ORDER BY updated_at DESC,id LIMIT 1");
        await db.query("SELECT * FROM public.collection_overdue_titles WHERE status<>'VALIDATED' ORDER BY due_date,id LIMIT 2 OFFSET 1");
      }
    });
  });
  await test('manual collection API calls on today or future titles are denied for Manager, CR and collector',async()=>{
    await unchangedDuring(async()=>{
      for(const role of ['gerente_geral','contas_receber','cobradora_1']) {
        await asUser(role);
        for(const id of [dueToday,future])for(const action of ['CONTACT','PAID','RETRY'])
          await reject(actionSql,[id,action,today,'Tentativa sintética',action==='PAID'?today:null,1]);
      }
    });
  });
  await test('authorized collection actions still work on overdue debt and preserve pending validation',async()=>{
    await asUser('cobradora_1');const original=await title(past);await act(past,{action:'PAID',paymentDate:today,revision:original.revision});
    assert.equal((await title(past)).status,'PENDING_VALIDATION');assert.equal((await title(past)).payment_date,null);
    assert.equal((await title(past)).collector_id,agents[0]);assert((await ids('collection_overdue_titles',true)).includes(past));
    const before=await title(pending);await act(pending,{revision:before.revision});assert.equal((await title(pending)).status,'PENDING_VALIDATION');
    assert.equal((await db.query('SELECT * FROM public.receivable_receipts WHERE title_id=$1',[past])).rows.length,0);
  });
  await test('financial validation still accepts confirmed prepaid titles through CR',async()=>{
    await asUser('contas_receber');const receipt=await financialValidate(prepaid);
    assert.equal((await title(prepaid)).status,'VALIDATED');assert.equal((await title(prepaid)).payment_date,today);
    assert.equal(await scalar('SELECT delay_days AS r FROM public.receivable_receipts WHERE id=$1',[receipt]),0);
    assert(!(await ids()).includes(prepaid));
    await asUser('cobradora_1');assert(!(await ids('receivable_titles')).includes(prepaid));
  });
  await test('assignment can prepare future debt without exposing it to collection or changing ownership rules',async()=>{
    await asUser('contas_receber');const row=await title(futureUnassigned);
    assert.equal(await scalar('SELECT public.assign_receivable_collector($1,$2,$3) AS r',[row.customer_key,agents[0],'Responsável sintética conferida']),1);
    assert.equal((await title(futureUnassigned)).collector_id,agents[0]);
    await reject('SELECT public.assign_receivable_collector($1,$2,$3)',[row.customer_key,agents[1],'Troca indevida'],'23514');
    await asUser('cobradora_1');assert(!(await ids('receivable_titles')).includes(futureUnassigned));
  });
  await test('a complete CR import still keeps overdue, today and future titles without creating a receipt',async()=>{
    const rows=[yesterday,today,tomorrow].map((date,index)=>({document:`IMPORT-${index}`,client_name:'Cliente importado sintético',
      client_document:null,branch:'Filial sintética',issued_on:null,due_date:date,amount_cents:5000+index}));
    const bytes=Buffer.from('Original CR sintético completo, sem dados reais.');
    await owner();const before=await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts');
    await db.exec('SET ROLE service_role');
    await scalar('SELECT public.commit_receivables_import_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,true,$8) AS r',[
      identities.contas_receber.user,identities.contas_receber.session,'grupo-consolidado','complete-synthetic.csv',
      createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),importId]);
    await asUser('contas_receber');
    const imported=(await db.query("SELECT * FROM public.receivable_titles WHERE document LIKE 'IMPORT-%' ORDER BY document")).rows;
    assert.equal(imported.length,3);assert(imported.every(row=>row.status==='NEW'&&row.in_latest_report));
    const overdue=(await db.query("SELECT document FROM public.collection_overdue_titles WHERE document LIKE 'IMPORT-%' ORDER BY document")).rows;
    assert.deepEqual(overdue.map(row=>row.document),['IMPORT-0']);
    assert.equal(await scalar('SELECT count(*)::int AS r FROM public.receivable_receipts'),before);
    const importedCustomer=imported[0].customer_key;
    assert.equal(await scalar('SELECT public.assign_receivable_collector($1,$2,$3) AS r',[importedCustomer,agents[0],'Carteira importada sintética']),3);
    await asUser('cobradora_1');assert.deepEqual((await db.query("SELECT document FROM public.receivable_titles WHERE document LIKE 'IMPORT-%' ORDER BY document")).rows.map(row=>row.document),['IMPORT-0']);
  });
  await test('the persisted view predicate uses the São Paulo civil day across the UTC midnight boundary',async()=>{
    // Exercise the actual stored view definition with a fixed statement instant.
    // No production clock function or application date is replaced or introduced.
    await owner();const definition=await scalar("SELECT pg_get_viewdef('public.collection_overdue_titles'::regclass,true) AS r");
    assert(definition.includes('statement_timestamp()'));assert(definition.includes('America/Sao_Paulo'));
    const boundary=await fixture({due_date:'2026-10-17'});
    await asUser('gerente_geral');
    for(const [instant,expected,day] of [['2026-10-18 01:30:00+00',false,'2026-10-17'],['2026-10-18 03:00:00+00',true,'2026-10-18']]) {
      const query=definition.trim().replace(/;$/,'').replaceAll('statement_timestamp()',`TIMESTAMPTZ '${instant}'`);
      const rows=(await db.query(`SELECT id,collection_as_of_date::text AS day FROM (${query}) boundary_view WHERE id=$1`,[boundary])).rows;
      assert.equal(rows.length>0,expected);if(expected)assert.equal(rows[0].day,day);
    }
    for(const timezone of ['UTC','Pacific/Kiritimati','America/Los_Angeles']) {
      await db.query("SELECT set_config('TimeZone',$1,false)",[timezone]);
      assert.equal(await scalar('SELECT min(collection_as_of_date)::text AS r FROM public.collection_overdue_titles'),today);
    }
    await db.exec("SET TIME ZONE 'UTC'");
  });
  await test('Director is read-only; CP and RH get no collection details; anonymous users have no view grant',async()=>{
    await unchangedDuring(async()=>{
      await asUser('diretor');assert((await ids()).includes(past));
      await reject(actionSql,[past,'CONTACT',today,'Tentativa',null,1]);
      await reject('UPDATE public.collection_overdue_titles SET amount_cents=1 WHERE id=$1',[past]);
      await reject('DELETE FROM public.collection_overdue_titles WHERE id=$1',[past]);
      for(const role of ['contas_pagar','rh_dp']) {
        await asUser(role);assert.deepEqual(await ids(),[]);assert.deepEqual(await ids('receivable_titles'),[]);
        await reject(actionSql,[past,'CONTACT',today,'Tentativa',null,1]);
      }
      await owner();await db.exec('SET ROLE anon');await reject('SELECT * FROM public.collection_overdue_titles');
      await reject(actionSql,[past,'CONTACT',today,'Tentativa',null,1]);
      await owner();await db.exec('SET ROLE service_role');await reject('SELECT * FROM public.collection_overdue_titles');
    });
  });
  await test('revoked read/write permission and session immediately remove collection access and actions',async()=>{
    await owner();const permissions=(await db.query("SELECT * FROM public.role_permissions WHERE role_key='cobradora_1' AND resource='cobranca' AND action IN ('read','write')")).rows;
    try {
      await db.query("DELETE FROM public.role_permissions WHERE role_key='cobradora_1' AND resource='cobranca' AND action IN ('read','write')");
      await asUser('cobradora_1');assert.deepEqual(await ids(),[]);assert.deepEqual(await ids('receivable_titles'),[]);
      await reject(actionSql,[past,'CONTACT',today,'Tentativa',null,1]);
    } finally {
      await owner();for(const permission of permissions)await db.query('INSERT INTO public.role_permissions(role_key,resource,action) VALUES($1,$2,$3)',[
        permission.role_key,permission.resource,permission.action]);
    }
    await owner();await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[identities.cobradora_1.session,identities.cobradora_1.user]);
    await asUser('cobradora_1');assert.deepEqual(await ids(),[]);assert.deepEqual(await ids('receivable_titles'),[]);
    assert.equal((await db.query('SELECT * FROM public.receivable_collection_events')).rows.length,0);
    assert.equal((await db.query('SELECT * FROM public.receivable_receipts')).rows.length,0);
    await reject(actionSql,[past,'CONTACT',today,'Tentativa',null,1]);
    await asUser('gerente_geral');await db.query('SELECT public.bind_collector($1,NULL)',[identities.cobradora_2.user]);
    await asUser('cobradora_2');assert.deepEqual(await ids(),[]);await reject(actionSql,[otherPast,'CONTACT',today,'Tentativa',null,1]);
  });
} catch(error) { failed++;console.error('SETUP FAILURE',error.stack??error.message); }
finally { await db.close(); }
console.log(`${passed} passed; ${failed} failed (local PostgreSQL, synthetic Supabase identity)`);
if(failed)process.exitCode=1;
