import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db=new PGlite(),uid='10000000-0000-4000-8000-000000000001',sid='20000000-0000-4000-8000-000000000001';
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS',name);}
async function actor(role='authenticated'){
  await db.exec('RESET ROLE');
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[uid,JSON.stringify({sub:uid,session_id:sid,role:'authenticated'})]);
  await db.exec(`SET ROLE ${role}`);
}
async function scalar(sql,args=[]){return(await db.query(sql,args)).rows[0].r;}
function file(label){const bytes=Buffer.from(label);return{base64:bytes.toString('base64'),hash:createHash('sha256').update(bytes).digest('hex')};}
async function importCR(rows,previous,label){
  await actor('service_role');const source=file(label);
  const result=await scalar('select public.commit_receivables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,true,$8) as r',[uid,sid,'grupo-consolidado','cr.csv',source.hash,source.base64,JSON.stringify(rows),previous]);
  await actor();return result;
}
try{
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for(const name of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql'])await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/dashboard/ativar-financeiro.sql',import.meta.url),'utf8'));
  await db.query('insert into auth.users(id,email) values($1,$2)',[uid,'fixture@example.invalid']);
  await db.query("insert into public.profiles(id,username,display_name,role_key,enabled) values($1,'TestManager','Teste','gerente_geral',true)",[uid]);
  await db.query('insert into cf_private.approved_sessions(session_id,user_id) values($1,$2)',[sid,uid]);
  await actor();
  const today=await scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text as r");
  const accounts=(await db.query('select id from public.bank_accounts order by company,bank')).rows;
  for(const account of accounts)await scalar('select public.set_bank_balance($1,$2,100000,$3,null) as r',[account.id,today,'Posição original do teste']);
  const source=file('CP sintético anterior à migração');
  const cp=[{entry_number:'CP-1',description:'Fornecedor sintético',due_date:today,amount_cents:25000,source_status:'Aberto',plan:'INVESTIMENTOS',bank_account:'Banco teste',branch:'2',issued_on:today}];
  await actor('service_role');
  await scalar('select public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,null) as r',[uid,sid,'grupo-consolidado','cp.csv',source.hash,source.base64,JSON.stringify(cp),JSON.stringify({'INVESTIMENTOS':'VARIÁVEL'})]);
  await actor();
  const previousTitle=(await db.query('select * from public.payable_titles')).rows[0];
  const previousPositionId=await scalar('select public.save_director_position($1,$1) as r',[today]);
  const previousPosition=(await db.query('select * from public.director_positions where id=$1',[previousPositionId])).rows[0];
  const previousBalances=(await db.query('select * from public.bank_balance_positions order by account_id')).rows;
  await test('combined v0.4 activation preserves existing users, CP, eleven balances and historical position',async()=>{
    await db.exec('RESET ROLE');await db.exec(await readFile(new URL('../supabase/dashboard/ativar-recebiveis.sql',import.meta.url),'utf8'));await actor();
    assert.deepEqual((await db.query('select * from public.payable_titles')).rows[0],previousTitle);
    assert.deepEqual((await db.query('select * from public.bank_balance_positions order by account_id')).rows,previousBalances);
    assert.deepEqual((await db.query('select * from public.director_positions where id=$1',[previousPositionId])).rows[0],previousPosition);
    assert.equal((await db.query('select * from public.profiles')).rows.length,1);
    assert.equal((await db.query('select * from public.central_schema_migrations')).rows.length,7);
  });
  await test('new snapshot keeps missing CR null and current existing cash and CP intact',async()=>{
    const id=await scalar('select public.save_director_position($1,$1) as r',[today]);
    const row=(await db.query('select * from public.director_positions where id=$1',[id])).rows[0];
    assert.equal(row.schema_version,'0.4.0');assert.equal(row.indicators.cash_cents,1100000);assert.equal(row.indicators.payable_period_cents,25000);
    assert.equal(row.indicators.receivable_cents,null);assert.equal(row.indicators.projected_cash_cents,null);
  });
  const rowA={document:'NF-1',client_name:'Cliente Teste',client_document:null,branch:'2',issued_on:today,due_date:today,amount_cents:100000};
  const rowB={...rowA,document:'NF-2',amount_cents:200000};
  let first;
  await test('import and fresh disappearance affect receivables but do not create received money',async()=>{
    first=await importCR([rowA],null,'CR base sintética 1');
    await importCR([rowB],first.import_id,'CR base sintética 2');
    const summary=await scalar('select public.receivables_summary($1,$1) as r',[today]);
    assert.equal(summary.open_cents,300000);assert.equal(summary.pending_count,1);assert.equal(summary.received_period_cents,0);
    assert.equal((await db.query('select * from public.receivable_receipts')).rows.length,0);
  });
  await test('financial confirmation supplies the actual date and updates real income and projection only once',async()=>{
    const title=(await db.query("select id,revision from public.receivable_titles where document='NF-1'")).rows[0];
    await scalar("select public.validate_receivable_payment($1,'CONFIRM',$2,'Conferência de teste',$3) as r",[title.id,today,title.revision]);
    const summary=await scalar('select public.receivables_summary($1,$1) as r',[today]);
    assert.equal(summary.open_cents,200000);assert.equal(summary.received_period_cents,100000);
    const id=await scalar('select public.save_director_position($1,$1) as r',[today]);
    const indicators=(await db.query('select indicators from public.director_positions where id=$1',[id])).rows[0].indicators;
    assert.equal(indicators.receivable_cents,200000);assert.equal(indicators.receivable_received_period_cents,100000);
    assert.equal(indicators.projected_cash_cents,1275000);assert.equal(indicators.current_assets_millions,null);assert.equal(indicators.complete,false);
  });
  await test('batch bank update reuses revisions and cannot change older saved snapshots',async()=>{
    const current=await scalar('select public.cash_position($1) as r',[today]);
    const changes=current.accounts.map((account,index)=>({account_id:account.id,amount_cents:index===0?110000:account.amount_cents,expected_updated_at:account.updated_at}));
    const saved=await scalar('select public.save_bank_position($1,$2,$3) as r',[today,JSON.stringify(changes),'Posição completa de teste']);
    assert.equal(saved.total_cents,1110000);
    assert.equal((await db.query('select indicators from public.director_positions where id=$1',[previousPositionId])).rows[0].indicators.cash_cents,1100000);
    await assert.rejects(db.query('select public.save_bank_position($1,$2,$3)',[today,JSON.stringify(changes),'Repetição desatualizada']),e=>e.code==='40001');
    assert.equal((await scalar('select public.cash_position($1) as r',[today])).total_cents,1110000);
  });
  console.log(`${passed} upgrade checks passed (synthetic local PostgreSQL, no remote mutation).`);
}finally{await db.close();}
