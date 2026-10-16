import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Synthetic fixtures only. No production connection, file or financial value.
const db = new PGlite();
const roles = ['gerente_geral','diretor','contas_pagar','contas_receber','rh_dp','cobradora_1','cobradora_2'];
const identities = Object.fromEntries(roles.map((name,i) => [name,{
  user:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
  session:`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
}]));
let passed=0,failed=0,accounts,supportId;
const asRole = async name => { await db.exec('RESET ROLE'); await db.exec(`SET ROLE ${name}`); };
const asUser = async name => {
  await asRole('postgres');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[
    identities[name].user,JSON.stringify({session_id:identities[name].session}),
  ]);
  await asRole('authenticated');
};
const result = async (sql,args=[]) => (await db.query(sql,args)).rows[0].r;
const rejects = async (sql,args=[],code='42501') => assert.rejects(db.query(sql,args),e=>e.code===code);
const test = async (name,run) => {
  try { await run(); passed++; console.log('PASS',name); }
  catch(error) { failed++; console.error('FAIL',name,error.message); }
};
const makePositions = (amount=100) => accounts.map((account,i)=>({account_id:account.id,amount_cents:amount+i,expected_updated_at:null}));
const save = (date,rows,note='Posição de teste conferida') => result('SELECT public.save_bank_position($1,$2,$3) AS r',[date,JSON.stringify(rows),note]);
const saveReject = (date,rows,note='Posição de teste conferida',code='23514') => rejects('SELECT public.save_bank_position($1,$2,$3)',[date,JSON.stringify(rows),note],code);
const positionsAt = async date => (await db.query("SELECT account_id,amount_cents::text AS cents,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS stamp FROM public.bank_balance_positions WHERE balance_date=$1 ORDER BY account_id",[date])).rows;
const file = bytes => ({base64:bytes.toString('base64'),hash:createHash('sha256').update(bytes).digest('hex')});
const support = file(Buffer.from('Data;Valor\n01/01/2020;123,45\n'));
const supportArgs = (overrides=[]) => {
  const args=['extrato.csv',support.hash,support.base64,null,'2020-01-01','Extrato sintético de apoio, sem conciliação'];
  for(const [i,value] of overrides) args[i]=value;
  return args;
};
const registerSql='SELECT public.register_bank_support($1,$2,$3,$4,$5,$6) AS r';

try {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;
  `);
  for(const name of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql','007_director_positions.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
  }
  for(const [i,name] of roles.entries()) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[identities[name].user,`synthetic-${i}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[identities[name].user,`TestUser${i}`,`Teste ${name}`,name]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[identities[name].session,identities[name].user]);
  }
  accounts=(await db.query('SELECT * FROM public.bank_accounts ORDER BY company,bank')).rows;
  await asUser('gerente_geral');
  const existingId=await result("SELECT public.set_bank_balance($1,'2019-12-31',4567,'Posição existente antes da migração') AS r",[accounts[0].id]);
  const existingBefore=(await db.query('SELECT to_jsonb(b) AS r FROM public.bank_balance_positions b WHERE id=$1',[existingId])).rows[0].r;
  await asRole('postgres');
  await db.exec(await readFile(new URL('../supabase/migrations/010_bank_import.sql',import.meta.url),'utf8'));

  await test('migration preserves existing balances, accounts and history without reseeding',async()=>{
    await asUser('gerente_geral');
    assert.equal((await db.query('SELECT * FROM public.bank_accounts')).rows.length,11);
    assert.deepEqual((await db.query('SELECT to_jsonb(b) AS r FROM public.bank_balance_positions b WHERE id=$1',[existingId])).rows[0].r,existingBefore);
    assert.equal((await db.query('SELECT * FROM public.bank_balance_positions')).rows.length,1);
    assert.equal((await db.query("SELECT version FROM public.central_schema_migrations WHERE version='010_bank_import'")).rows.length,1);
  });

  await test('all eleven explicit balances save atomically including negative and zero, with row and batch audits',async()=>{
    const rows=makePositions(); rows[0].amount_cents=-250; rows[1].amount_cents=0;
    const total=rows.reduce((n,r)=>n+r.amount_cents,0);
    assert.deepEqual(await save('2020-01-01',rows),{position_date:'2020-01-01',total_cents:total,account_count:11});
    const cash=await result("SELECT public.cash_position('2020-01-01') AS r");
    assert.equal(cash.total_cents,total); assert.equal(cash.reported_accounts,11);
    const audits=(await db.query("SELECT * FROM public.audit_events WHERE entity IN ('bank_balance_positions','bank_position') ORDER BY occurred_at")).rows;
    assert.equal(audits.filter(a=>a.entity==='bank_balance_positions').length,12);
    const batch=audits.find(a=>a.entity==='bank_position');
    assert.equal(batch.action,'IMPORT'); assert.equal(batch.module,'caixa');
    assert.equal(batch.user_id,identities.gerente_geral.user);
    assert.equal(batch.after_value.total_cents,total);
    assert.equal(batch.after_value.source,'MANUAL');
  });

  await test('missing, duplicate, unknown, disabled, extra-field and malformed rows cannot enter a partial position',async()=>{
    const valid=makePositions();
    const duplicate=structuredClone(valid);duplicate[10]=duplicate[0];
    const unknown=structuredClone(valid);unknown[10].account_id='00000000-0000-4000-8000-000000000000';
    const extra=structuredClone(valid);extra[3].role='admin';
    const missing=structuredClone(valid);delete missing[3].expected_updated_at;
    const invalid=structuredClone(valid);invalid[3]=null;
    const invalidId=structuredClone(valid);invalidId[3].account_id='invalid';
    for(const rows of [valid.slice(1),[...valid,valid[0]],duplicate,unknown,extra,missing,invalid,invalidId,null,{}]) await saveReject('2020-02-01',rows);
    await asRole('postgres');await db.query('UPDATE public.bank_accounts SET enabled=false WHERE id=$1',[accounts[10].id]);
    await asUser('gerente_geral');
    // Keep expected count at ten while passing the disabled account in place of an active one.
    await saveReject('2020-02-01',[...valid.slice(0,9),valid[10]]);
    await asRole('postgres');await db.query('UPDATE public.bank_accounts SET enabled=true WHERE id=$1',[accounts[10].id]);
    await asUser('gerente_geral');
    assert.equal((await positionsAt('2020-02-01')).length,0);
  });

  await test('invalid dates, blank notes, fractional cents and unsafe account/company/consolidated totals fail before writes',async()=>{
    const valid=makePositions();
    const future=(await db.query("SELECT ((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text AS day")).rows[0].day;
    for(const date of [null,'1899-12-31',future]) await saveReject(date,valid);
    for(const note of [null,' ','x'.repeat(1001)]) await saveReject('2020-02-01',valid,note);
    for(const amount of [null,1.5,'100',true]) { const rows=structuredClone(valid);rows[0].amount_cents=amount;await saveReject('2020-02-01',rows); }
    const oversized=structuredClone(valid);oversized[0].amount_cents=9007199254740992;
    await saveReject('2020-02-01',oversized,'Teste precisão','22003');
    const grand=makePositions(0);grand[4].amount_cents=9007199254740991;
    await saveReject('2020-02-01',grand,'Teste total','22003');
    const company=makePositions(0);company[0].amount_cents=4503599627370496;company[1].amount_cents=4503599627370496;company[2].amount_cents=-4503599627370496;company[3].amount_cents=-4503599627370496;
    await saveReject('2020-02-01',company,'Teste subtotal','22003');
    assert.equal((await positionsAt('2020-02-01')).length,0);
  });

  await test('same-date optimistic versions are required and one stale account rolls back earlier rows and audit',async()=>{
    const previous=await positionsAt('2020-01-01');
    const rows=makePositions(200);
    for(const row of rows) row.expected_updated_at=previous.find(p=>p.account_id===row.account_id).stamp;
    const beforeAudits=(await db.query('SELECT count(*)::integer AS n FROM public.audit_events')).rows[0].n;
    const stale=structuredClone(rows);stale[10].expected_updated_at=null;
    await saveReject('2020-01-01',stale,'Stale final row','40001');
    assert.deepEqual(await positionsAt('2020-01-01'),previous);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.audit_events')).rows[0].n,beforeAudits);
    const badStamp=structuredClone(rows);badStamp[2].expected_updated_at='2020-01-01';
    await saveReject('2020-01-01',badStamp);
    await saveReject('2020-02-01',rows,'Versão de outra data','40001');
    assert.equal((await positionsAt('2020-02-01')).length,0);
    assert.equal((await save('2020-01-01',rows)).total_cents,rows.reduce((n,r)=>n+r.amount_cents,0));
    await saveReject('2020-01-01',rows,'Versões já utilizadas','40001');
  });

  await test('support original is archived privately with server-verified hash and never changes balances',async()=>{
    const before=await positionsAt('2020-01-01');
    supportId=await result(registerSql,supportArgs([[3,accounts[0].id]]));
    const metadata=(await db.query('SELECT * FROM public.bank_support_files WHERE id=$1',[supportId])).rows[0];
    assert.equal(metadata.file_name,'extrato.csv');assert.equal(metadata.file_sha256,support.hash);
    assert.equal(metadata.size_bytes,Buffer.from(support.base64,'base64').length);
    assert.equal(metadata.created_by,identities.gerente_geral.user);
    assert.equal(metadata.account_id,accounts[0].id);
    assert.deepEqual(await result('SELECT public.download_bank_support($1) AS r',[supportId]),{file_name:'extrato.csv',file_base64:support.base64});
    assert.deepEqual(await positionsAt('2020-01-01'),before);
    const audit=(await db.query("SELECT * FROM public.audit_events WHERE entity='bank_support_files'")).rows;
    assert.equal(audit.length,1);assert.equal(audit[0].action,'IMPORT');
    assert.equal(audit[0].after_value.purpose,'SUPPORT_ONLY');
    assert.equal('file_base64' in audit[0].after_value,false);
    assert.equal('file_bytes' in audit[0].after_value,false);
    await rejects('SELECT * FROM cf_private.bank_support_bytes');
    await rejects('UPDATE public.bank_support_files SET description=$1 WHERE id=$2',['Edit',supportId]);
    await rejects('DELETE FROM public.bank_support_files WHERE id=$1',[supportId]);
  });

  await test('duplicate hashes, altered bytes and malformed support inputs fail without metadata or audit leftovers',async()=>{
    await rejects(registerSql,supportArgs(),'23505');
    const future=(await db.query("SELECT ((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::text AS day")).rows[0].day;
    const newSupport=file(Buffer.from('different synthetic support'));
    const valid=supportArgs([[1,newSupport.hash],[2,newSupport.base64]]);
    const variants=[[[0,'../extrato.csv']],[[0,'C:\\extrato.csv']],[[0,'script.html']],[[0,'bad\nname.pdf']],[[0,'x'.repeat(201)+'.pdf']],[[1,'f'.repeat(64)]],[[2,'invalid base64']],[[2,'YR==']],[[3,'00000000-0000-4000-8000-000000000000']],[[4,future]],[[4,'1899-12-31']],[[4,null]],[[5,' ']],[[5,'x'.repeat(1001)]]];
    for(const overrides of variants) { const args=[...valid];for(const [i,value] of overrides)args[i]=value;await rejects(registerSql,args,'23514'); }
    const oversized=Buffer.alloc(2097153,65);const big=file(oversized);
    await rejects(registerSql,supportArgs([[1,big.hash],[2,big.base64]]),'23514');
    await asRole('postgres');await db.query('UPDATE public.bank_accounts SET enabled=false WHERE id=$1',[accounts[0].id]);
    await asUser('gerente_geral');await rejects(registerSql,[...valid.slice(0,3),accounts[0].id,...valid.slice(4)],'23514');
    await asRole('postgres');await db.query('UPDATE public.bank_accounts SET enabled=true WHERE id=$1',[accounts[0].id]);
    await asUser('gerente_geral');
    assert.equal((await db.query('SELECT * FROM public.bank_support_files')).rows.length,1);
    assert.equal((await db.query("SELECT * FROM public.audit_events WHERE entity='bank_support_files'")).rows.length,1);
  });

  await test('only official manager with import permission can save or archive, regardless of visible tabs',async()=>{
    for(const name of roles.filter(r=>r!=='gerente_geral')) {
      await asUser(name);
      await saveReject('2020-03-01',makePositions(),'Não autorizado','42501');
      await rejects(registerSql,supportArgs());
      const permitted=['diretor','contas_pagar','contas_receber'].includes(name);
      assert.equal((await db.query('SELECT * FROM public.bank_support_files')).rows.length,permitted?1:0);
      if(permitted) assert.equal((await result('SELECT public.download_bank_support($1) AS r',[supportId])).file_base64,support.base64);
      else await rejects('SELECT public.download_bank_support($1)',[supportId]);
      await rejects('SELECT * FROM cf_private.bank_support_bytes');
    }
    await asRole('postgres');
    await db.exec("DELETE FROM public.role_permissions WHERE role_key='gerente_geral' AND resource='caixa' AND action='import'");
    await asUser('gerente_geral');
    await saveReject('2020-03-01',makePositions(),'Permissão removida','42501');
    await rejects(registerSql,supportArgs());
    await asRole('postgres');
    await db.exec("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('gerente_geral','caixa','import')");
  });

  await test('anonymous and service callers have no direct data or RPC grants and support cannot be physically altered',async()=>{
    for(const role of ['anon','service_role']) {
      await asRole(role);
      await rejects('SELECT * FROM public.bank_support_files');
      await rejects('SELECT * FROM cf_private.bank_support_bytes');
      await rejects('SELECT public.download_bank_support($1)',[supportId]);
      await rejects(registerSql,supportArgs());
      await saveReject('2020-03-01',makePositions(),'Anon','42501');
    }
    await asRole('postgres');
    await rejects('UPDATE public.bank_support_files SET description=$1 WHERE id=$2',['Mutate',supportId]);
    await rejects('DELETE FROM public.bank_support_files WHERE id=$1',[supportId]);
    await rejects('UPDATE cf_private.bank_support_bytes SET file_bytes=decode($1,$2) WHERE file_id=$3',['dGVzdA==','base64',supportId]);
    await rejects('DELETE FROM cf_private.bank_support_bytes WHERE file_id=$1',[supportId]);
  });

  await test('revoking manager session immediately blocks metadata, support downloads and both writing RPCs',async()=>{
    await asRole('postgres');
    await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[identities.gerente_geral.session,identities.gerente_geral.user]);
    await asUser('gerente_geral');
    assert.equal((await db.query('SELECT * FROM public.bank_support_files')).rows.length,0);
    await rejects('SELECT public.download_bank_support($1)',[supportId]);
    await rejects(registerSql,supportArgs());
    await saveReject('2020-03-01',makePositions(),'Sessão revogada','42501');
  });
}catch(error){failed++;console.error('SETUP FAILURE',error.message);}
finally{await db.close();}
console.log(`${passed} passed; ${failed} failed (local PostgreSQL, emulated Supabase identity)`);
if(failed)process.exitCode=1;
