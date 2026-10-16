import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Disposable local PostgreSQL; every identity, value and file is synthetic.
const db = new PGlite();
const roles = ['gerente_geral','diretor','contas_pagar','contas_receber','rh_dp','cobradora_1','cobradora_2'];
const uid = index => `10000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
const sid = index => `20000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
const scalar = async (sql,args=[]) => (await db.query(sql,args)).rows[0].r;
const role = async name => { await db.exec('RESET ROLE'); await db.exec(`SET ROLE ${name}`); };
const actor = async index => {
  await role('postgres');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [uid(index),JSON.stringify({session_id:sid(index),role:'admin'})]); // Forged client role is ignored.
  await role('authenticated');
};
const rejected = async (sql,args=[],code='42501') => assert.rejects(db.query(sql,args),e=>{assert.equal(e.code,code,e.message);return true;});
const keys = ['turnover_month_cents','turnover_comlurb_cents','orders_cents','blocked_orders_cents',
  'pending_orders_cents','overdue_comlurb_cents','installments_cents','previous_month_taxes_cents'];
const zeroInputs = () => Object.fromEntries(keys.map(key=>[key,0]));
const saveSql = 'SELECT public.save_director_inputs($1,$2::jsonb,$3,$4) AS r';
const readSql = 'SELECT public.read_director_inputs($1) AS r';
const reportSql = 'SELECT public.director_report($1,$2) AS r';
const save = (date,values,expected=null,note='Conferência sintética oficial') => scalar(saveSql,[date,JSON.stringify(values),note,expected]);
const report = () => scalar(reportSql,[today,today]);
const original = name => { const bytes=Buffer.from(`Arquivo sintético ${name}`);return {hash:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')}; };
let today, yesterday, oldId, oldPosition, beforeData, latestInput, latestCp=null, latestCr=null, passed=0;
const test = async (name,run) => {await run();passed++;console.log('PASS',name);};
const state = async () => {
  await role('postgres');
  return (await db.query(`SELECT (SELECT count(*)::int FROM public.director_report_inputs) AS inputs,
    (SELECT count(*)::int FROM public.audit_events) AS audits,
    (SELECT count(*)::int FROM public.director_positions) AS positions`)).rows[0];
};
const gatewayCP = async (rows,label) => {
  const file=original(label);await role('service_role');
  const result=await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,$9) AS r',[
    uid(0),sid(0),'grupo-consolidado',`${label}.csv`,file.hash,file.base64,JSON.stringify(rows),
    JSON.stringify(Object.fromEntries(rows.map(row=>[row.plan,row.plan==='MERCADORIA TESTE'?'COMPRA DE MERCADORIA':'VARIÁVEL']))),latestCp]);
  latestCp=result.import_id;await actor(0);return result;
};
const cpRow = (entry_number,amount_cents,plan='MERCADORIA TESTE') => ({entry_number,amount_cents,plan,
  description:'Fornecedor sintético',branch:'2 - TESTE',due_date:today,issued_on:yesterday});
const gatewayCR = async (rows,label) => {
  const file=original(label);await role('service_role');
  const result=await scalar('SELECT public.commit_receivables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,true,$8) AS r',[
    uid(0),sid(0),'grupo-consolidado',`${label}.csv`,file.hash,file.base64,JSON.stringify(rows),latestCr]);
  latestCr=result.import_id;await actor(0);return result;
};
const crRow = (document,amount_cents) => ({document,amount_cents,client_name:`Cliente sintético ${document}`,
  client_document:null,branch:'2 - TESTE',due_date:yesterday,issued_on:yesterday});

try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for(const name of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql',
    '006_treasury.sql','007_director_positions.sql','008_receivables.sql','009_collections.sql','010_bank_import.sql',
    '011_receivables_positions.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
  }
  await test('missing account migration 012 blocks activation before new DDL and rolls back without changing the previous schema',async()=>{
    const before=(await db.query('SELECT to_jsonb(t) AS r FROM public.bank_accounts t ORDER BY id')).rows;
    assert.equal(before.length,11);
    const sql=await readFile(new URL('../supabase/migrations/013_director_report.sql',import.meta.url),'utf8');
    await assert.rejects(db.exec(sql),error=>{
      assert.equal(error.code,'22023');assert.match(error.message,/Aplique a atualização 012/);return true;
    });
    await db.exec('ROLLBACK');
    assert.equal(await scalar("SELECT to_regclass('public.director_report_inputs')::text AS r"),null);
    assert.equal(await scalar("SELECT to_regprocedure('public.director_report(date,date)')::text AS r"),null);
    assert.equal(await scalar("SELECT to_regprocedure('cf_private.normalize_director_inputs(jsonb)')::text AS r"),null);
    assert.deepEqual((await db.query('SELECT to_jsonb(t) AS r FROM public.bank_accounts t ORDER BY id')).rows,before);
    assert.equal((await db.query("SELECT * FROM public.central_schema_migrations WHERE version='013_director_report'")).rows.length,0);
    assert.equal((await db.query("SELECT * FROM public.central_schema_migrations WHERE version='011_receivables_positions'")).rows.length,1);
  });
  await db.exec(await readFile(new URL('../supabase/migrations/012_treasury_accounts.sql',import.meta.url),'utf8'));
  for(const [i,name] of roles.entries()) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(i),`synthetic-${i}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[uid(i),`TestUser${i}`,`Pessoa ${i}`,name]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(i),uid(i)]);
  }
  ({today,yesterday}= (await db.query(`SELECT to_char(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS today,
    to_char((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1,'YYYY-MM-DD') AS yesterday`)).rows[0]);
  await actor(0);
  oldId=await scalar('SELECT public.save_director_position($1,$1) AS r',[today]);
  oldPosition=(await db.query('SELECT * FROM public.director_positions WHERE id=$1',[oldId])).rows[0];
  await role('postgres');
  beforeData=(await db.query(`SELECT jsonb_build_object(
    'profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.profiles t),
    'banks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.bank_accounts t),
    'audits',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.audit_events t),
    'positions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.director_positions t)) AS r`)).rows[0].r;
  await db.exec(await readFile(new URL('../supabase/migrations/013_director_report.sql',import.meta.url),'utf8'));

  await test('incremental migration preserves identities, all seventeen account IDs, audits and historical snapshots',async()=>{
    const after=(await db.query(`SELECT jsonb_build_object(
      'profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.profiles t),
      'banks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.bank_accounts t),
      'audits',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.audit_events t),
      'positions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.director_positions t)) AS r`)).rows[0].r;
    assert.deepEqual(after,beforeData);
    assert.equal((await db.query("SELECT * FROM public.central_schema_migrations WHERE version='013_director_report'")).rows.length,1);
  });
  await test('missing sources remain null and report uses today in São Paulo independently of selected cash-flow period',async()=>{
    await actor(0);const r=await scalar(reportSql,['2020-01-01','2020-01-31']);
    assert.equal(r.as_of_date,today);assert.equal(r.inputs,null);assert.equal(r.complete,false);assert.equal(r.cash.expected_accounts,17);
    for(const key of ['turnover_cents','cash_cents','stock_cents','receivable_cents','merchandise_cents','current_assets_millions'])assert.equal(r.indicators[key],null,key);
    assert(r.missing_sources.some(s=>s.includes('Estoque aguardando atualização')));
    assert.equal(r.formula_version,'2026-10-sem-m49');
  });
  await test('having only a previous-day complement does not silently fill the current report',async()=>{
    await save(yesterday,{orders_cents:999});
    assert.equal((await scalar(readSql,[yesterday])).values.orders_cents,999);
    const r=await report();assert.equal(r.inputs,null);assert.equal(r.indicators.orders_cents,null);
  });
  await test('manual values are partial, normalized, audited with official identity, and explicit zero is valid',async()=>{
    latestInput=await save(today,{turnover_month_cents:0});
    const input=await scalar(readSql,[today]);assert.equal(input.id,latestInput);assert.equal(input.created_by,uid(0));
    assert.deepEqual(input.values,{...Object.fromEntries(keys.map(k=>[k,null])),turnover_month_cents:0});
    const audit=(await db.query("SELECT * FROM public.audit_events WHERE entity='director_report_inputs' AND record_id=$1",[latestInput])).rows[0];
    assert.equal(audit.role_key,'gerente_geral');assert.equal(audit.user_id,uid(0));assert.equal(audit.action,'CREATE');assert.equal(audit.after_value.values.turnover_month_cents,0);
  });
  await test('invalid dates, observations, extra keys, strings, negative/fractional/unsafe cents and all-blank requests roll back',async()=>{
    const before=await state();await actor(0);
    const invalid=[{},null,[],{foo:1},{turnover_month_cents:'100'},{turnover_month_cents:-1},
      {turnover_month_cents:1.1},{turnover_month_cents:9007199254740992},{turnover_month_cents:true},
      Object.fromEntries(keys.map(k=>[k,null]))];
    for(const value of invalid)await rejected(saveSql,[today,JSON.stringify(value),'Conferência',latestInput],'22023');
    for(const [date,note] of [[null,'Ok'],['1899-12-31','Ok'],['2999-01-01','Ok'],[today,null],[today,' '],[today,'a'.repeat(1001)]]) {
      await rejected(saveSql,[date,JSON.stringify({orders_cents:0}),note,latestInput],'22023');
    }
    await rejected(saveSql,[today,JSON.stringify({turnover_month_cents:9007199254740991,turnover_comlurb_cents:1}),'Acima do limite',latestInput],'22003');
    assert.deepEqual(await state(),before);
  });
  await test('optimistic revision prevents overwriting and each replacement preserves the previous immutable record',async()=>{
    await actor(0);const prior=latestInput;latestInput=await save(today,zeroInputs(),prior);
    assert.notEqual(latestInput,prior);assert.equal((await scalar(readSql,[today])).id,latestInput);
    assert.equal((await db.query('SELECT * FROM public.director_report_inputs WHERE reference_date=$1',[today])).rows.length,2);
    await rejected(saveSql,[today,JSON.stringify({orders_cents:1}),'Desatualizado',prior],'40001');
    await rejected(saveSql,[today,JSON.stringify({orders_cents:1}),'Desatualizado',null],'40001');
    const audit=(await db.query("SELECT * FROM public.audit_events WHERE entity='director_report_inputs' AND record_id=$1",[latestInput])).rows[0];
    assert.equal(audit.action,'UPDATE');assert.equal(audit.before_value.id,prior);assert.equal(audit.after_value.id,latestInput);
    await rejected('UPDATE public.director_report_inputs SET observation=$1 WHERE id=$2',['Alterada',prior]);
    await rejected('DELETE FROM public.director_report_inputs WHERE id=$1',[prior]);
    await rejected("INSERT INTO public.director_report_inputs(reference_date,values,observation,created_by) VALUES($1,'{}','Não pode',$2)",[today,uid(0)]);
    await role('postgres');await rejected('UPDATE public.director_report_inputs SET observation=$1 WHERE id=$2',['Alterada',prior]);
    await rejected('DELETE FROM public.director_positions WHERE id=$1',[oldId]);
  });
  await test('Director reads all report data and history but every write is denied by the database',async()=>{
    await actor(1);assert.equal((await scalar(readSql,[today])).id,latestInput);assert.equal((await report()).as_of_date,today);
    assert.equal((await db.query('SELECT * FROM public.director_report_inputs')).rows.length,3);
    await rejected(saveSql,[today,JSON.stringify(zeroInputs()),'Diretor tentando escrever',latestInput]);
    await rejected('SELECT public.save_director_position($1,$1)',[today]);
    await rejected('DELETE FROM public.director_report_inputs');
    await rejected("UPDATE public.director_positions SET indicators='{}'");
  });
  await test('CP, CR, RH and collectors cannot call director endpoints or read supplemental records',async()=>{
    for(let i=2;i<roles.length;i++){
      await actor(i);await rejected(readSql,[today]);await rejected(reportSql,[today,today]);
      await rejected(saveSql,[today,JSON.stringify(zeroInputs()),'Sem acesso',latestInput]);
      assert.equal((await db.query('SELECT * FROM public.director_report_inputs')).rows.length,0);
    }
  });
  await test('anonymous and service roles have no direct function/table privileges',async()=>{
    for(const deniedRole of ['anon','service_role']){
      await role(deniedRole);await rejected(readSql,[today]);await rejected(reportSql,[today,today]);
      await rejected(saveSql,[today,JSON.stringify(zeroInputs()),'Sem acesso',latestInput]);
      await rejected('SELECT * FROM public.director_report_inputs');
    }
  });
  await test('prior-day supplemental inputs never replace the current day and the latest same-date revision wins',async()=>{
    await actor(0);assert.equal((await scalar(readSql,[yesterday])).values.orders_cents,999);
    assert.equal((await report()).indicators.orders_cents,0);
    await db.exec('RESET ROLE');
    await db.exec("UPDATE public.director_report_inputs SET reference_date=reference_date").then(()=>assert.fail('History accepted update'),e=>assert.equal(e.code,'42501'));
    await actor(0);
    await rejected(readSql,[null],'22023');await rejected(readSql,['2999-01-01'],'22023');
    for(const [start,end] of [[null,today],[today,null],['2020-01-02','2020-01-01'],['2020-01-01','2022-01-01'],['1899-01-01','1899-01-02']])await rejected(reportSql,[start,end],'22023');
  });
  await test('merchandise comes only from active officially classified CP titles; settled and other macros are excluded',async()=>{
    await actor(0);
    await gatewayCP([cpRow('M-ATIVO',700),cpRow('M-ANTIGO',500),cpRow('OUTRO',300,'INVESTIMENTOS')],'cp-primeiro');
    assert.equal((await report()).indicators.merchandise_cents,1200);
    await gatewayCP([cpRow('M-ATIVO',700),cpRow('OUTRO',300,'INVESTIMENTOS')],'cp-segundo');
    assert.equal((await report()).indicators.merchandise_cents,700);
    assert.equal((await db.query("SELECT status FROM public.payable_titles WHERE entry_number='M-ANTIGO'")).rows[0].status,'SETTLED_IMPORT');
  });
  await test('all seventeen cash positions are included once, including negative balances and the five physical cash accounts',async()=>{
    const accounts=(await db.query('SELECT id,account_type FROM public.bank_accounts ORDER BY display_name')).rows;
    assert.equal(accounts.length,17);assert.equal(accounts.filter(a=>a.account_type==='CASH').length,5);
    for(const [i,a] of accounts.entries())await scalar('SELECT public.set_bank_balance($1,$2,$3,$4,null) AS r',[a.id,today,i===0?-100:100,'Saldo sintético']);
    await scalar('SELECT public.save_manual_stock($1,$2,$3) AS r',[20000,today,'Estoque sintético']);
    await gatewayCR([crRow('NF-UM',10000),crRow('NF-DOIS',30000)],'cr-completo');
    const r=await report();assert.equal(r.cash.accounts.length,17);assert.equal(r.indicators.cash_cents,1500);assert.equal(r.indicators.receivable_cents,40000);
    assert.equal(r.indicators.stock_cents,20000);
  });
  await test('official formula excludes M49, counts receivables once, uses general turnover and retains fractional cents exactly',async()=>{
    latestInput=await save(today,{...zeroInputs(),turnover_month_cents:10001,turnover_comlurb_cents:5000,
      orders_cents:123,blocked_orders_cents:2,pending_orders_cents:3,overdue_comlurb_cents:500,
      previous_month_taxes_cents:2500,installments_cents:1200},latestInput);
    const r=await report(),i=r.indicators;assert.equal(i.turnover_cents,15001);
    // (1500 + 40000 + 20000 - 2500 - 15001*14/100 - 700 - 1200)/100000000.
    assert.equal(await scalar('SELECT $1::numeric=0.0005499986 AS r',[i.current_assets_millions]),true);
    assert.equal(typeof i.current_assets_millions,'string');assert.equal(i.receivable_overdue_comlurb_cents,500);
    assert.equal(i.receivable_overdue_bps,10000);assert.equal(r.complete,true);assert.deepEqual(r.missing_sources,[]);
    assert.equal(i.previous_taxes_month,await scalar("SELECT to_char($1::date-interval '1 month','YYYY-MM') AS r",[today]));
  });
  await test('current assets can be negative and explicit zero inputs do not become missing',async()=>{
    latestInput=await save(today,{...zeroInputs(),previous_month_taxes_cents:100000},latestInput);
    let r=await report();assert.equal(await scalar('SELECT $1::numeric=(-0.000392) AS r',[r.indicators.current_assets_millions]),true);
    latestInput=await save(today,zeroInputs(),latestInput);r=await report();assert.equal(r.complete,true);assert.equal(r.indicators.turnover_cents,0);
    assert.equal(await scalar('SELECT $1::numeric=0.000608 AS r',[r.indicators.current_assets_millions]),true);
  });
  await test('manual COMLURB overdue above the latest official overdue is hidden and explicitly flagged',async()=>{
    latestInput=await save(today,{...zeroInputs(),overdue_comlurb_cents:40001},latestInput);
    let r=await report();assert.equal(r.indicators.receivable_overdue_comlurb_cents,null);assert.equal(r.complete,false);
    assert(r.missing_sources.some(s=>s.includes('COMLURB excede')));
    latestInput=await save(today,zeroInputs(),latestInput);r=await report();assert.equal(r.indicators.receivable_overdue_comlurb_cents,0);
  });
  await test('missing formula component blocks only the formula; absent unrelated orders do not manufacture zero',async()=>{
    latestInput=await save(today,{...zeroInputs(),previous_month_taxes_cents:null},latestInput);
    let r=await report();assert.equal(r.indicators.current_assets_millions,null);assert(r.missing_sources.some(s=>s.includes('Impostos do mês passado')));
    latestInput=await save(today,{...zeroInputs(),orders_cents:null},latestInput);
    r=await report();assert.equal(r.indicators.orders_cents,null);assert.notEqual(r.indicators.current_assets_millions,null);assert.equal(r.complete,false);
    latestInput=await save(today,zeroInputs(),latestInput);
  });
  await test('new snapshots preserve full bank detail, input provenance and exact formula; old snapshots remain byte-for-byte unchanged',async()=>{
    const r=await report();const id=await scalar('SELECT public.save_director_position($1,$1) AS r',[today]);
    const snap=(await db.query('SELECT * FROM public.director_positions WHERE id=$1',[id])).rows[0];
    assert.equal(snap.schema_version,'0.6.0');assert.equal(snap.indicators.current_assets_millions,r.indicators.current_assets_millions);
    assert.equal(snap.indicators.cash_accounts.length,17);assert.equal(snap.indicators.report_inputs.id,latestInput);
    assert.equal(snap.indicators.formula_version,'2026-10-sem-m49');
    assert.deepEqual((await db.query('SELECT * FROM public.director_positions WHERE id=$1',[oldId])).rows[0],oldPosition);
    const audit=(await db.query("SELECT * FROM public.audit_events WHERE entity='director_positions' AND record_id=$1",[id])).rows[0];
    assert.deepEqual(audit.after_value.indicators,snap.indicators);assert.equal(audit.user_id,uid(0));
    await save(today,{...zeroInputs(),installments_cents:100},latestInput);
    assert.equal((await db.query('SELECT indicators FROM public.director_positions WHERE id=$1',[id])).rows[0].indicators.installments_cents,0);
  });
  await test('an audit failure rolls back the entire supplemental revision',async()=>{
    const before=await state();
    await db.exec(`CREATE FUNCTION cf_private.test_reject_director_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.entity='director_report_inputs' THEN RAISE EXCEPTION 'Synthetic audit failure' USING ERRCODE='P0001'; END IF;RETURN NEW;END;$$;
      CREATE TRIGGER test_reject_director_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.test_reject_director_audit();`);
    await actor(0);const previous=(await scalar(readSql,[today])).id;
    await rejected(saveSql,[today,JSON.stringify(zeroInputs()),'Falha sintética',previous],'P0001');
    assert.deepEqual(await state(),before);
    await db.exec('DROP TRIGGER test_reject_director_audit ON public.audit_events; DROP FUNCTION cf_private.test_reject_director_audit()');
    await actor(0);assert.equal((await scalar(readSql,[today])).id,previous);
  });
  await test('explicit zero from every official source produces exactly zero current assets without inventing a percentage',async()=>{
    await gatewayCP([cpRow('M-ZERO',0)],'cp-zero');
    await gatewayCR([crRow('NF-ZERO',0)],'cr-zero');
    const pending=(await db.query("SELECT id,revision FROM public.receivable_titles WHERE status='PENDING_VALIDATION'")).rows;
    for(const title of pending)await scalar("SELECT public.validate_receivable_payment($1,'CONFIRM',$2,$3,$4) AS r",[
      title.id,today,'Validação explícita de teste para zerar a carteira',title.revision]);
    const position=await scalar('SELECT public.cash_position($1) AS r',[today]);
    for(const account of position.accounts)await scalar('SELECT public.set_bank_balance($1,$2,0,$3,$4) AS r',[
      account.id,today,'Zero explícito sintético',account.updated_at]);
    await scalar('SELECT public.save_manual_stock(0,$1,$2) AS r',[today,'Zero explícito sintético']);
    latestInput=await save(today,zeroInputs(),(await scalar(readSql,[today])).id);
    const r=await report();assert.equal(r.complete,true);assert.equal(r.indicators.receivable_cents,0);
    assert.equal(r.indicators.merchandise_cents,0);assert.equal(r.indicators.cash_cents,0);assert.equal(r.indicators.stock_cents,0);
    assert.equal(r.indicators.receivable_overdue_bps,null);
    assert.equal(r.indicators.current_assets_millions,'0');
    latestInput=await save(today,{...zeroInputs(),turnover_month_cents:1},latestInput);
    const tiny=await report();assert.equal(tiny.indicators.current_assets_millions,'-0.0000000014');
  });
  await test('removing write permission, blocking the user, unapproved/expired/revoked sessions all deny write and hide data',async()=>{
    await role('postgres');await db.exec("DELETE FROM public.role_permissions WHERE role_key='gerente_geral' AND resource='resumo_diretoria' AND action='write'");
    await actor(0);await rejected(saveSql,[today,JSON.stringify(zeroInputs()),'Sem permissão',latestInput]);
    await role('postgres');await db.exec("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('gerente_geral','resumo_diretoria','write')");
    for(const mode of ['blocked','unapproved','expired','revoked']){
      await role('postgres');
      if(mode==='blocked')await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1',[uid(0)]);
      if(mode==='unapproved')await db.query('DELETE FROM cf_private.approved_sessions WHERE session_id=$1',[sid(0)]);
      if(mode==='expired')await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE session_id=$1",[sid(0)]);
      if(mode==='revoked')await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[sid(0),uid(0)]);
      await actor(0);await rejected(readSql,[today]);await rejected(reportSql,[today,today]);await rejected(saveSql,[today,JSON.stringify(zeroInputs()),'Sessão inválida',latestInput]);
      assert.equal((await db.query('SELECT * FROM public.director_report_inputs')).rows.length,0);
      await role('postgres');
      if(mode==='blocked')await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1',[uid(0)]);
      if(mode==='unapproved')await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(0),uid(0)]);
      if(mode==='expired')await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE session_id=$1",[sid(0)]);
    }
  });
  console.log(`${passed} director report SQL checks passed (synthetic local PostgreSQL).`);
} finally { await db.close(); }
