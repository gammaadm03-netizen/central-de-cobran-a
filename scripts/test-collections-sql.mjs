import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// All identities and amounts are synthetic; this database is discarded after the suite.
const db = new PGlite();
let passed = 0, failed = 0, sequence = 0;
const roles = ['gerente_geral','diretor','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2'];
const identities = Object.fromEntries(roles.map((role,i) => [role,{
  user:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
  session:`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
}]));
const owner = async () => db.exec('RESET ROLE');
const asUser = async role => {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[
    identities[role].user,JSON.stringify({session_id:identities[role].session})]);
  await db.exec('SET ROLE authenticated');
};
const scalar = async (sql,args=[]) => (await db.query(sql,args)).rows[0].r;
const denied = async (sql,args=[],code='42501') => assert.rejects(db.query(sql,args),error=>error.code===code);
const title = async id => (await db.query('SELECT to_jsonb(t) AS r FROM public.receivable_titles t WHERE id=$1',[id])).rows[0]?.r;
const revision = async id => (await title(id)).revision;
const summary = async (start='2020-01-04',end='2020-01-10') => scalar('SELECT public.receivables_summary($1,$2) AS r',[start,end]);
const act = async (id,action='CONTACT',extra={}) => scalar('SELECT public.record_collection_action($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r',[
  id,action,'2020-01-05',extra.next_action??null,extra.next_date??null,extra.observation??'Contato sintético',extra.return_note??null,extra.payment_date??null,
  extra.revision??await revision(id)]);
const validate = async (id,decision='CONFIRM',date='2020-01-05',note='Conferência sintética',rev=null) => scalar(
  'SELECT public.validate_receivable_payment($1,$2,$3,$4,$5) AS r',[id,decision,date,note,rev??await revision(id)]);
const assign = async (customer,agent,note='Responsável conferida') => scalar('SELECT public.assign_receivable_collector($1,$2,$3) AS r',[customer,agent,note]);
const test = async (name,run) => {
  try { await run(); passed++; console.log('PASS',name); }
  catch(error) { failed++; console.error('FAIL',name,error.message); }
};
let importId, agent1,agent2;
const fixture = async (overrides={}) => {
  await owner();
  const n=++sequence;
  const row={document:`NF-${n}`,client_name:`Cliente sintético ${n}`,customer_key:`name:CLIENTE SINTÉTICO ${n}`,
    due_date:'2019-12-01',amount_cents:10000,collector_id:null,status:'NEW',validation_status:'NONE',
    payment_source:null,payment_reported_date:null,reported_in_collection:false,collector_locked:false,...overrides};
  const result=await scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,
    amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,reported_in_collection,
    collector_locked,first_import_id,last_import_id) VALUES('grupo-consolidado',$1,$2,$3,$4,'3',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id AS r`,[
    `synthetic-key-${n}`,row.document,row.client_name,row.customer_key,row.due_date,row.amount_cents,row.collector_id,row.status,
    row.validation_status,row.payment_source,row.payment_reported_date,row.reported_in_collection,row.collector_locked,importId]);
  return result;
};
try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for(const file of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql','007_director_positions.sql','008_receivables.sql','009_collections.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  }
  for(const [role,identity] of Object.entries(identities)) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[identity.user,`${role}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[identity.user,role,role,role]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[identity.session,identity.user]);
  }
  importId=await scalar(`INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count)
    VALUES('grupo-consolidado','synthetic.csv',repeat('a',64),$1,1,1,0,0,0) RETURNING id AS r`,[identities.gerente_geral.user]);
  await asUser('gerente_geral');
  agent1=await scalar("SELECT public.configure_collection_agent(NULL,'Responsável sintética A',true) AS r");
  agent2=await scalar("SELECT public.configure_collection_agent(NULL,'Responsável sintética B',true) AS r");
  await db.query('SELECT public.bind_collector($1,$2)',[identities.cobradora_1.user,agent1]);
  await db.query('SELECT public.bind_collector($1,$2)',[identities.cobradora_2.user,agent2]);
  let own1,own2,unassigned,paid,notLocated,daily;

  await test('empty schema contains no invented financial data',async()=>{
    assert.equal((await summary()).active_count,0);
    assert.equal((await db.query('SELECT * FROM public.receivable_receipts')).rows.length,0);
  });
  await test('CR assigns all unassigned active customer titles and preserves existing ownership',async()=>{
    own1=await fixture({client_name:'Cliente da carteira A',customer_key:'name:CLIENTE DA CARTEIRA A'});
    unassigned=await fixture({client_name:'Cliente da carteira A',customer_key:'name:CLIENTE DA CARTEIRA A'});
    own2=await fixture({collector_id:agent2});
    await asUser('contas_receber');
    assert.equal(await assign('name:CLIENTE DA CARTEIRA A',agent1),2);
    assert.equal((await title(own1)).collector_id,agent1);
    assert.equal(await assign('name:CLIENTE DA CARTEIRA A',agent1),0);
    await denied('SELECT public.assign_receivable_collector($1,$2,$3)',['name:CLIENTE DA CARTEIRA A',agent2,'Troca indevida'],'23514');
    assert.equal((await title(own1)).collector_id,agent1);
  });
  await test('assignment accepts the full validated customer name length without truncation',async()=>{
    const client_name='A'.repeat(1500),customer_key='name:'+client_name;
    const id=await fixture({client_name,customer_key});await asUser('contas_receber');
    assert.equal(await assign(customer_key,agent1),1);assert.equal((await title(id)).collector_id,agent1);
  });
  await test('assignment rejects locked or conflicting customer debt and incomplete inputs atomically',async()=>{
    await fixture({client_name:'Conflito',customer_key:'name:CONFLITO',collector_id:agent1});
    const other=await fixture({client_name:'Conflito',customer_key:'name:CONFLITO',collector_id:agent2});
    const locked=await fixture({client_name:'Bloqueado',customer_key:'name:BLOQUEADO',collector_locked:true});
    await asUser('gerente_geral');
    await denied('SELECT public.assign_receivable_collector($1,$2,$3)',['name:CONFLITO',agent1,'Conflito'],'23514');
    await denied('SELECT public.assign_receivable_collector($1,$2,$3)',['name:BLOQUEADO',agent1,'Bloqueado'],'23514');
    await denied('SELECT public.assign_receivable_collector($1,$2,$3)',['name:AUSENTE',agent1,'Ausente'],'23514');
    await denied('SELECT public.assign_receivable_collector($1,$2,$3)',['name:CONFLITO',agent1,' '],'23514');
    assert.equal((await title(other)).collector_id,agent2);assert.equal((await title(locked)).collector_id,null);
  });
  await test('each collector reads only bound portfolio; no global summary or assignment',async()=>{
    for(const [role,agent,other] of [['cobradora_1',agent1,own2],['cobradora_2',agent2,own1]]){
      await asUser(role);
      const rows=(await db.query('SELECT * FROM public.receivable_titles')).rows;
      assert(rows.length>0&&rows.every(row=>row.collector_id===agent));
      assert.equal(await title(other),undefined);
      await denied('SELECT public.receivables_summary($1,$2)',['2020-01-04','2020-01-10']);
      await denied('SELECT public.assign_receivable_collector($1,$2,$3)',['name:CLIENTE DA CARTEIRA A',agent,'Troca']);
      await denied('SELECT public.record_collection_action($1,$2,$3,NULL,NULL,NULL,NULL,NULL,1)',[other,'CONTACT','2020-01-05']);
    }
  });
  await test('collection contact is immutable, revisioned, scoped and audited',async()=>{
    await asUser('cobradora_1');
    const before=await revision(own1);
    const event=await act(own1,'PROMISE',{next_action:'RETRY',next_date:'2020-01-10',return_note:'Retorno combinado'});
    assert.equal((await title(own1)).last_action,'PROMISE');
    assert.equal((await title(own1)).next_action_date,'2020-01-10');
    assert.equal(Number(await revision(own1)),Number(before)+1);
    assert.equal((await db.query('SELECT * FROM public.receivable_collection_events WHERE id=$1',[event])).rows[0].return_note,'Retorno combinado');
    await denied('UPDATE public.receivable_collection_events SET observation=$1 WHERE id=$2',['Troca',event]);
    await denied('DELETE FROM public.receivable_collection_events WHERE id=$1',[event]);
    await asUser('cobradora_2');
    assert.equal((await db.query('SELECT * FROM public.receivable_collection_events WHERE id=$1',[event])).rows.length,0);
    await asUser('gerente_geral');
    assert.equal((await db.query("SELECT * FROM public.audit_events WHERE entity='receivable_collection_events' AND record_id=$1",[event])).rows.length,1);
  });
  await test('invalid contact or payment inputs make no partial event/title writes',async()=>{
    await asUser('cobradora_1');
    const before=await title(own1);const count=(await db.query('SELECT * FROM public.receivable_collection_events')).rows.length;
    const future=await scalar("SELECT ((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text AS r");
    const sql='SELECT public.record_collection_action($1,$2,$3,$4,$5,$6,$7,$8,$9)';
    for(const args of [
      [own1,'PAID','2020-01-05',null,null,null,null,null,before.revision],
      [own1,'PAID','2020-01-05',null,null,null,null,future,before.revision],
      [own1,'CONTACT',future,null,null,null,null,null,before.revision],
      [own1,'CONTACT','2020-01-05','HACK',null,null,null,null,before.revision],
      [own1,'CONTACT','2020-01-05',null,'2020-01-06',null,null,null,before.revision],
      [own1,'CONTACT','2020-01-05',null,null,null,null,'2020-01-05',before.revision],
      [own1,'OTHER','2020-01-05',null,null,' ',null,null,before.revision],
    ]) await denied(sql,args,'23514');
    assert.equal((await title(own1)).revision,before.revision);
    assert.equal((await db.query('SELECT * FROM public.receivable_collection_events')).rows.length,count);
  });
  await test('paid report keeps owner and active debt, never creates unvalidated receipt',async()=>{
    paid=await fixture({collector_id:agent1,due_date:'2019-12-05',amount_cents:34567});
    await asUser('cobradora_1');
    await act(paid,'PAID',{payment_date:'2020-01-05'});
    const row=await title(paid);
    assert.equal(row.status,'PENDING_VALIDATION');assert.equal(row.validation_status,'PENDING');assert.equal(row.collector_id,agent1);
    assert.equal(row.payment_source,'COBRANCA');assert.equal(row.payment_reported_date,'2020-01-05');assert.equal(row.payment_date,null);
    assert.equal(row.reported_in_collection,true);
    assert.equal((await db.query('SELECT * FROM public.receivable_receipts')).rows.length,0);
    await denied('SELECT public.record_collection_action($1,$2,$3,NULL,NULL,NULL,NULL,$4,$5)',[paid,'PAID','2020-01-05','2020-01-05',row.revision],'23514');
    await act(paid,'CONTACT');
    assert.equal((await title(paid)).status,'PENDING_VALIDATION');assert.equal((await title(paid)).payment_source,'COBRANCA');
    await asUser('contas_receber');assert((await summary()).pending_count>=1);assert.equal((await summary()).received_period_cents,0);
  });
  await test('collector cannot validate or change financial dates even in own wallet',async()=>{
    await asUser('cobradora_1');
    await denied('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5)',[paid,'CONFIRM','2020-01-05','Teste',await revision(paid)]);
    await denied('SELECT public.set_receivable_payment_date($1,$2,$3)',[paid,'2020-01-05',await revision(paid)]);
    await denied("UPDATE public.receivable_titles SET status='VALIDATED',validation_status='VALIDATED',payment_date='2020-01-05' WHERE id=$1",[paid]);
  });
  await test('financial decisions validate real dates and reasons before changing debt',async()=>{
    await asUser('contas_receber');
    const before=await title(paid);
    const future=await scalar("SELECT ((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text AS r");
    for(const [decision,date,note] of [['CONFIRM',future,'Teste'],['CONFIRM','1899-12-31','Teste'],['NOT_LOCATED',null,' '],['NOT_LOCATED','2020-01-05','Data indevida']]) {
      await denied('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5)',[paid,decision,date,note,before.revision],'23514');
    }
    assert.equal((await title(paid)).revision,before.revision);
    assert.equal((await db.query('SELECT * FROM public.receivable_receipts WHERE title_id=$1',[paid])).rows.length,0);
  });
  await test('financial confirmation stores actual receiving date, correct band and immutable provenance',async()=>{
    await asUser('contas_receber');
    const receipt=await validate(paid,'CONFIRM','2020-01-06');
    const row=await scalar('SELECT to_jsonb(r) AS r FROM public.receivable_receipts r WHERE id=$1',[receipt]);
    assert.equal(row.payment_date,'2020-01-06');assert.equal(row.delay_days,32);assert.equal(row.delay_band,'31_60');
    assert.equal(row.amount_cents,34567);assert.equal(row.payment_source,'COBRANCA');assert.equal(row.reported_in_collection,true);
    assert.equal(row.collector_id,agent1);assert.equal(row.validation,'VALIDADO');assert.equal(row.validated_by,identities.contas_receber.user);
    assert.equal((await title(paid)).status,'VALIDATED');assert.equal((await title(paid)).payment_date,'2020-01-06');
    assert.equal((await summary()).received_period_cents,0);
    await denied('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5)',[paid,'CONFIRM','2020-01-06','Replay',await revision(paid)],'23514');
    await denied('UPDATE public.receivable_receipts SET amount_cents=1 WHERE id=$1',[receipt]);
    await denied('DELETE FROM public.receivable_receipts WHERE id=$1',[receipt]);
    await asUser('cobradora_2');assert.equal((await db.query('SELECT * FROM public.receivable_receipts WHERE id=$1',[receipt])).rows.length,0);
    await asUser('cobradora_1');assert.equal((await db.query('SELECT * FROM public.receivable_receipts WHERE id=$1',[receipt])).rows.length,1);
  });
  await test('not located returns to same locked collector, clears payment and creates no receipt',async()=>{
    notLocated=await fixture({collector_id:agent1});await asUser('cobradora_1');await act(notLocated,'PAID',{payment_date:'2020-01-05'});
    await asUser('contas_receber');
    assert.equal(await validate(notLocated,'NOT_LOCATED',null,'Crédito não localizado'),null);
    const row=await title(notLocated);
    assert.equal(row.status,'NOT_LOCATED');assert.equal(row.validation_status,'NONE');assert.equal(row.collector_id,agent1);
    assert.equal(row.collector_locked,true);assert.equal(row.next_action,'RETRY');assert.equal(row.payment_source,null);
    assert.equal(row.payment_reported_date,null);assert.equal(row.payment_date,null);assert.equal(row.reported_in_collection,false);
    assert.equal((await db.query('SELECT * FROM public.receivable_receipts WHERE title_id=$1',[notLocated])).rows.length,0);
    await denied('SELECT public.assign_receivable_collector($1,$2,$3)',[row.customer_key,agent2,'Redistribuição indevida'],'23514');
    await asUser('cobradora_1');await act(notLocated,'RETRY');assert.equal((await title(notLocated)).status,'NOT_LOCATED');
  });
  await test('unassigned daily debt requires explicit assignment before returning to collection',async()=>{
    const id=await fixture({status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA'});
    await asUser('contas_receber');
    await denied('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5)',[id,'NOT_LOCATED',null,'Crédito não localizado',await revision(id)],'23514');
    assert.equal((await title(id)).collector_locked,false);assert.equal((await title(id)).status,'PENDING_VALIDATION');
    await assign((await title(id)).customer_key,agent2);
    assert.equal(await validate(id,'NOT_LOCATED',null,'Crédito não localizado'),null);
    assert.equal((await title(id)).collector_id,agent2);assert.equal((await title(id)).collector_locked,true);
  });
  await test('daily pending requires finance date and only validated receipts enter selected Saturday to Friday',async()=>{
    daily=await fixture({collector_id:agent2,status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA',amount_cents:78901});
    await asUser('contas_receber');
    assert.equal((await summary()).received_period_cents,0);
    await denied('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5)',[daily,'CONFIRM',null,'Sem data',await revision(daily)],'23514');
    await db.query('SELECT public.set_receivable_payment_date($1,$2,$3)',[daily,'2020-01-10',await revision(daily)]);
    assert.equal((await title(daily)).payment_reported_date,'2020-01-10');assert.equal((await title(daily)).payment_date,null);
    await validate(daily,'CONFIRM','2020-01-10');
    assert.equal((await summary()).received_period_cents,78901);
    assert.equal((await summary('2020-01-11','2020-01-17')).received_period_cents,0);
    const saturday=await fixture({status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA',amount_cents:333});
    await asUser('gerente_geral');await validate(saturday,'CONFIRM','2020-01-04');
    assert.equal((await summary()).received_period_cents,79234);
    assert.equal((await summary('2019-12-28','2020-01-03')).received_period_cents,0);
  });
  await test('delay bands follow actual receipt date including early payment and exact edges',async()=>{
    for(const [days,band] of [[-1,'ATE_30'],[0,'ATE_30'],[30,'ATE_30'],[31,'31_60'],[60,'31_60'],[61,'61_90'],[90,'61_90'],[91,'91_180'],[180,'91_180'],[181,'181_365'],[365,'181_365'],[366,'ACIMA_365']]){
      await owner();const due=await scalar('SELECT (DATE \'2020-01-05\'-$1::integer)::text AS r',[days]);
      const id=await fixture({due_date:due,status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA'});
      await asUser('gerente_geral');const receipt=await validate(id);
      const row=await scalar('SELECT to_jsonb(r) AS r FROM public.receivable_receipts r WHERE id=$1',[receipt]);
      assert.equal(row.delay_days,Math.max(0,days));assert.equal(row.delay_band,band);
    }
  });
  await test('stale actions, dates and validations cannot overwrite newer activity',async()=>{
    const id=await fixture({collector_id:agent1});await asUser('cobradora_1');const old=await revision(id);await act(id,'CONTACT');
    await denied('SELECT public.record_collection_action($1,$2,$3,NULL,NULL,NULL,NULL,NULL,$4)',[id,'CONTACT','2020-01-05',old],'40001');
    await act(id,'PAID',{payment_date:'2020-01-05'});await asUser('contas_receber');
    await denied('SELECT public.validate_receivable_payment($1,$2,$3,$4,$5)',[id,'CONFIRM','2020-01-05','Teste',old],'40001');
    await denied('SELECT public.set_receivable_payment_date($1,$2,$3)',[id,'2020-01-05',old],'40001');
  });
  await test('director sees all details but every financial/collection write is denied',async()=>{
    await asUser('diretor');assert((await db.query('SELECT * FROM public.receivable_titles')).rows.length>0);
    assert((await db.query('SELECT * FROM public.receivable_collection_events')).rows.length>0);
    assert((await db.query('SELECT * FROM public.receivable_receipts')).rows.length>0);
    await summary();
    for(const [sql,args] of [
      ['SELECT public.assign_receivable_collector($1,$2,$3)',['name:CLIENTE DA CARTEIRA A',agent1,'Teste']],
      ['SELECT public.record_collection_action($1,$2,$3,NULL,NULL,NULL,NULL,NULL,$4)',[own1,'CONTACT','2020-01-05',await revision(own1)]],
      ['SELECT public.set_receivable_payment_date($1,$2,$3)',[daily,'2020-01-05',await revision(daily)]],
      ['SELECT public.validate_receivable_payment($1,$2,$3,$4,$5)',[paid,'CONFIRM','2020-01-05','Teste',await revision(paid)]],
      ['UPDATE public.receivable_titles SET amount_cents=1 WHERE id=$1',[own1]],
    ]) await denied(sql,args);
  });
  await test('CP sees aggregates only; RH sees no receivables and no aggregate',async()=>{
    for(const role of ['contas_pagar','rh_dp']){
      await asUser(role);for(const table of ['receivable_titles','receivable_collection_events','receivable_receipts'])assert.equal((await db.query(`SELECT * FROM public.${table}`)).rows.length,0);
      await denied('SELECT public.assign_receivable_collector($1,$2,$3)',['name:CLIENTE DA CARTEIRA A',agent1,'Teste']);
      await denied('SELECT public.validate_receivable_payment($1,$2,$3,$4,1)',[paid,'CONFIRM','2020-01-05','Teste']);
      if(role==='contas_pagar')assert((await summary()).active_count>0);else await denied('SELECT public.receivables_summary($1,$2)',['2020-01-04','2020-01-10']);
    }
  });
  await test('summary rejects unsafe sums and invalid ranges, never infers COMLURB',async()=>{
    await asUser('contas_receber');assert.equal((await summary()).overdue_comlurb_cents,null);
    await denied('SELECT public.receivables_summary($1,$2)',['2020-02-01','2020-01-01'],'22023');
    const huge=await fixture({amount_cents:'9007199254740991'});await asUser('contas_receber');
    await denied('SELECT public.receivables_summary($1,$2)',['2020-01-04','2020-01-10'],'22003');
    await owner();await db.query('UPDATE public.receivable_titles SET amount_cents=1 WHERE id=$1',[huge]);
  });
  await test('receipt aggregation rejects unsafe received totals independently of open debt',async()=>{
    const id=await fixture({due_date:'1990-01-01',amount_cents:'9007199254740991',status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA'});
    await asUser('contas_receber');await validate(id,'CONFIRM','1990-01-05');
    const other=await fixture({due_date:'1990-01-01',amount_cents:1,status:'PENDING_VALIDATION',validation_status:'PENDING',payment_source:'IMPORTACAO_DIARIA'});
    await asUser('contas_receber');await validate(other,'CONFIRM','1990-01-05');
    await denied('SELECT public.receivables_summary($1,$2)',['1990-01-01','1990-01-10'],'22003');
    assert((await summary()).active_count>0);
  });
  await test('unbound collector and revoked sessions lose scoped reads and all operation rights',async()=>{
    await asUser('gerente_geral');await db.query('SELECT public.bind_collector($1,NULL)',[identities.cobradora_2.user]);
    await asUser('cobradora_2');
    for(const table of ['receivable_titles','receivable_collection_events','receivable_receipts'])assert.equal((await db.query(`SELECT * FROM public.${table}`)).rows.length,0);
    await denied('SELECT public.record_collection_action($1,$2,$3,NULL,NULL,NULL,NULL,NULL,1)',[own2,'CONTACT','2020-01-05']);
    await owner();await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[identities.gerente_geral.session,identities.gerente_geral.user]);
    await asUser('gerente_geral');
    for(const table of ['receivable_titles','receivable_collection_events','receivable_receipts'])assert.equal((await db.query(`SELECT * FROM public.${table}`)).rows.length,0);
    await denied('SELECT public.receivables_summary($1,$2)',['2020-01-04','2020-01-10']);
    await denied('SELECT public.assign_receivable_collector($1,$2,$3)',['name:CLIENTE DA CARTEIRA A',agent1,'Teste']);
  });
  await test('anonymous callers and privileged history modification are rejected',async()=>{
    await owner();await db.exec('SET ROLE anon');
    for(const table of ['receivable_collection_events','receivable_receipts'])await denied(`SELECT * FROM public.${table}`);
    await denied('SELECT public.receivables_summary($1,$2)',['2020-01-04','2020-01-10']);
    await owner();
    await denied('UPDATE public.receivable_collection_events SET observation=\'Troca\'');
    await denied('DELETE FROM public.receivable_receipts');
  });
}catch(error){failed++;console.error('SETUP FAILURE',error.message,error.stack);}
finally{await db.close();}
console.log(`${passed} passed; ${failed} failed (local PostgreSQL, emulated Supabase identity)`);
if(failed)process.exitCode=1;
