import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Local disposable PostgreSQL. Every person, file and transaction is synthetic.
const db = new PGlite();
const roles = ['gerente_geral','diretor','contas_pagar','contas_receber','rh_dp','cobradora_1','cobradora_2'];
const uid = i => `10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const sid = i => `20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const scalar = async (sql,args=[]) => (await db.query(sql,args)).rows[0].r;
const role = async name => { await db.exec('RESET ROLE'); await db.exec(`SET ROLE ${name}`); };
const actor = async i => {
  await role('postgres');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [uid(i),JSON.stringify({session_id:sid(i),role:'admin'})]);
  await role('authenticated');
};
const rejects = async (sql,args=[],code='42501') => assert.rejects(db.query(sql,args),e=>{assert.equal(e.code,code,e.message);return true;});
const forecast = start => scalar('SELECT public.payables_forecast($1) AS r',[start??null]);
const mapSql='SELECT public.map_payable_forecast_plan($1,$2,$3,$4,$5) AS r';
const ruleSql='SELECT public.save_payable_forecast_rule($1,$2,$3,$4,$5,$6) AS r';
const completionSql='SELECT public.set_payable_forecast_completion($1,$2,$3,$4,$5) AS r';
const sqlFile= name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const migrationNames=['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql',
  '006_treasury.sql','007_director_positions.sql','008_receivables.sql','009_collections.sql','010_bank_import.sql',
  '011_receivables_positions.sql','012_treasury_accounts.sql','013_director_report.sql'];
let today,month,salaryDate,advanceDate,latestImport=null,sequence=0,passed=0;
const test=async(name,run)=>{await run();passed++;console.log('PASS',name);};
const fixture=(entry_number,amount_cents,plan='ORDINARIO TESTE',extra={})=>({entry_number,amount_cents,plan,
  description:'Fornecedor sintético',branch:'2 - TESTE',due_date:salaryDate,issued_on:today,...extra});
const gateway=async rows=>{
  const bytes=Buffer.from(`Arquivo sintético completo ${++sequence}`);
  await role('service_role');
  const result=await scalar('SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,$9) AS r',[
    uid(0),sid(0),'grupo-consolidado',`sintetico-${sequence}.csv`,createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),
    JSON.stringify(rows),JSON.stringify(Object.fromEntries(rows.map(r=>[r.plan,r.plan.includes('SALARIO')?'SALÁRIOS':r.plan.includes('ADIANTA')?'ADIANTAMENTO':'VARIÁVEL']))),latestImport]);
  latestImport=result.import_id;await actor(0);return result;
};
const allProvisions= f=>f.weeks.flatMap(w=>w.provisions);
const provision=(f,key,date=month)=>{const p=allProvisions(f).find(p=>p.rule_key===key&&p.month===date);assert(p,`missing ${key} ${date}`);return p;};
const weekFor=(f,date)=>f.weeks.find(w=>date>=w.start&&date<=w.end);
const bind=async(plan,key,expected=null,effective=today)=>scalar(mapSql,[plan,key,effective,'Vínculo sintético conferido',expected]);
const finish=async(key,done,expected=null)=>scalar(completionSql,[key,month,done,'Ciclo sintético conferido',expected]);
const rowsOf=async table=>(await db.query(`SELECT to_jsonb(t) AS r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const existingTables=['public.profiles','public.payable_imports','public.payable_titles','cf_private.payable_import_files',
  'public.bank_accounts','public.bank_balance_positions','public.stock_positions','public.director_positions','public.audit_events'];
const state=async()=>({rules:await rowsOf('public.payable_forecast_rules'),bindings:await rowsOf('public.payable_forecast_plan_bindings'),
  completions:await rowsOf('public.payable_forecast_completions'),audits:await rowsOf('public.audit_events')});
const bootstrap=`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
  GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`;

try {
  await db.exec(bootstrap);
  for(const name of migrationNames) await db.exec(await sqlFile(name));
  for(const [i,name] of roles.entries()) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(i),`forecast-${i}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$3,$4,true)',[uid(i),`Forecast${i}`,`Teste ${name}`,name]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(i),uid(i)]);
  }
  const dates=(await db.query(`SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,
    (date_trunc('month',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo'))+interval '1 month')::date::text AS "month"`)).rows[0];
  today=dates.today;month=dates.month;salaryDate=month.slice(0,8)+'05';advanceDate=month.slice(0,8)+'20';
  await actor(0);
  await scalar("SELECT public.save_manual_stock(12345,$1,'Estoque sintético anterior') AS r",[today]);
  const account=(await db.query('SELECT id FROM public.bank_accounts ORDER BY id LIMIT 1')).rows[0].id;
  await scalar("SELECT public.set_bank_balance($1,$2,-123,'Saldo sintético anterior',null) AS r",[account,today]);
  await gateway([fixture('ORIGINAL',123)]);
  await scalar('SELECT public.save_director_position($1,$1) AS r',[today]);
  await role('postgres');
  const before=Object.fromEntries(await Promise.all(existingTables.map(async t=>[t,await rowsOf(t)])));
  await db.exec(await sqlFile('014_payables_forecast.sql'));

  await test('incremental migration preserves financial data, original imports, IDs, users, snapshots and audits',async()=>{
    for(const table of existingTables) assert.deepEqual(await rowsOf(table),before[table],table);
    assert.equal(await scalar("SELECT count(*)::int AS r FROM public.central_schema_migrations WHERE version='014_payables_forecast'"),1);
    assert.equal((await rowsOf('public.payable_forecast_rules')).length,4);
  });

  await test('four explicit defaults start today and eight weeks always run Saturday to Friday',async()=>{
    await actor(0);const f=await forecast();
    assert.equal(f.weeks.length,8);assert.equal(f.as_of_date,today);assert.equal(f.latest_import_id,latestImport);
    assert.deepEqual(f.rules.map(r=>[r.rule_key,r.amount_cents,r.day_of_month,r.effective_from]).sort(),[
      ['SALARIOS',4600000,5,today],['SALARIOS_SOCIOS',3300000,5,today],['ADIANTAMENTO',2300000,20,today],['ADIANTAMENTO_SOCIOS',3300000,20,today]].sort());
    for(const [i,w] of f.weeks.entries()) {
      assert.equal(new Date(w.start+'T00:00Z').getUTCDay(),6);assert.equal(new Date(w.end+'T00:00Z').getUTCDay(),5);
      assert.equal((Date.parse(w.end)-Date.parse(w.start))/86400000,6);
      if(i) assert.equal((Date.parse(w.start)-Date.parse(f.weeks[i-1].end))/86400000,1);
      assert.equal(w.macros.length,14);
    }
    assert.equal(provision(f,'SALARIOS').due_date,salaryDate);assert.equal(provision(f,'ADIANTAMENTO').due_date,advanceDate);
    assert.equal(provision(f,'SALARIOS').remaining_cents,4600000);
  });

  await test('future year boundary retains eight Saturdays and original day 5/20 even on weekends',async()=>{
    const year=Number(today.slice(0,4));let d=new Date(Date.UTC(year,11,19));while(d.getUTCDay()!==6)d.setUTCDate(d.getUTCDate()+1);
    const start=d.toISOString().slice(0,10),f=await forecast(start);
    assert.equal(f.weeks[7].end.slice(0,4),String(year+1));
    for(const p of allProvisions(f)) assert.equal(Number(p.due_date.slice(-2)),p.rule_key.startsWith('SALARIOS')?5:20);
    const bad=new Date(d);bad.setUTCDate(bad.getUTCDate()+1);
    await rejects('SELECT public.payables_forecast($1)',[bad.toISOString().slice(0,10)],'22023');
    await rejects("SELECT public.payables_forecast('1900-01-06')",[],'22023');
  });

  await test('unbound payroll plans block residuals rather than adding full estimates to real titles',async()=>{
    await gateway([fixture('PAYROLL',100000,'SALARIO EQUIPE TESTE'),fixture('PARTNERS',200000,'SALARIO SOCIOS TESTE'),fixture('OTHER',50)]);
    const f=await forecast(),p=provision(f,'SALARIOS'),week=weekFor(f,salaryDate);
    assert.equal(p.remaining_cents,null);assert.equal(p.actual_cents,null);assert(p.issues.some(s=>s.includes('Vincule')));
    assert.equal(provision(f,'SALARIOS_SOCIOS').remaining_cents,null);
    assert.equal(week.real_cents,300050);assert.equal(week.estimated_cents,null);assert.equal(week.total_cents,null);
    assert.equal(week.macros.find(m=>m.macro==='SALÁRIOS').estimated_cents,null);
    assert(f.plans.filter(p=>p.macro==='SALÁRIOS').every(p=>!p.configured&&p.mapping_id===null));
  });

  let salaryBinding,partnersBinding,doneId;
  await test('explicit bindings keep employees and partners separate and reduce only their matching monthly provisions',async()=>{
    await actor(2);salaryBinding=await bind('SALARIO EQUIPE TESTE','SALARIOS');partnersBinding=await bind('SALARIO SOCIOS TESTE','SALARIOS_SOCIOS');
    const f=await forecast(),a=provision(f,'SALARIOS'),b=provision(f,'SALARIOS_SOCIOS');
    assert.equal(a.actual_cents,100000);assert.equal(a.remaining_cents,4500000);
    assert.equal(b.actual_cents,200000);assert.equal(b.remaining_cents,3100000);
    const w=weekFor(f,salaryDate);assert.equal(w.real_cents,300050);assert.equal(w.estimated_cents,7600000);assert.equal(w.total_cents,7900050);
    const m=w.macros.find(m=>m.macro==='SALÁRIOS');assert.deepEqual(m,{macro:'SALÁRIOS',real_cents:300000,estimated_cents:7600000,total_cents:7900000});
    await rejects(mapSql,['SALARIO EQUIPE TESTE','ADIANTAMENTO',today,'Macro incompatível',salaryBinding],'22023');
  });

  await test('settled titles keep reducing the monthly provision without remaining in real weekly payments',async()=>{
    await gateway([fixture('OTHER',50)]);
    const f=await forecast();assert.equal(provision(f,'SALARIOS').actual_cents,100000);
    assert.equal(provision(f,'SALARIOS').remaining_cents,4500000);
    assert.equal(weekFor(f,salaryDate).real_cents,50);assert.equal(weekFor(f,salaryDate).total_cents,7600050);
  });

  await test('exact CHEQUE status is a separate subtotal already included once in real payments',async()=>{
    await gateway([fixture('CHEQUE-1',501,'ORDINARIO TESTE',{source_status:' cheque '}),fixture('CHEQUE-2',702,'ORDINARIO TESTE',{source_status:'CHEQUE DEVOLVIDO'})]);
    const w=weekFor(await forecast(),salaryDate);assert.equal(w.real_cents,1203);assert.equal(w.cheques_cents,501);assert.equal(w.cheque_count,1);
    assert.equal(w.title_count,2);assert.equal(w.total_cents,w.real_cents+w.estimated_cents);
  });

  await test('explicit NONE binding is distinguished from an unconfigured plan',async()=>{
    await gateway([fixture('EXTRA',42,'SALARIO EXTRA TESTE')]);
    assert.equal(provision(await forecast(),'SALARIOS').remaining_cents,null);
    const id=await bind('SALARIO EXTRA TESTE',null);const f=await forecast();
    const plan=f.plans.find(p=>p.plan==='SALARIO EXTRA TESTE');assert.equal(plan.mapping_id,id);assert.equal(plan.configured,true);assert.equal(plan.rule_key,null);
    assert.equal(provision(f,'SALARIOS').remaining_cents,4500000);
  });

  await test('changed amount with same branch and entry is ambiguous, not two paid payroll titles',async()=>{
    await gateway([fixture('PAYROLL',110000,'SALARIO EQUIPE TESTE')]);
    const f=await forecast(),p=provision(f,'SALARIOS');assert.equal(p.remaining_cents,null);assert.equal(p.actual_cents,null);assert(p.issues.some(s=>s.includes('versões')));
    // Both records remain in the audited ledger; the forecast never merges them.
    assert.equal((await db.query("SELECT * FROM public.payable_titles WHERE entry_number='PAYROLL'")).rows.length,2);
    doneId=await finish('SALARIOS',true);const resolved=provision(await forecast(),'SALARIOS');
    assert.equal(resolved.done,true);assert.equal(resolved.completion_id,doneId);assert.equal(resolved.remaining_cents,0);
    doneId=await finish('SALARIOS',false,doneId);assert.equal(provision(await forecast(),'SALARIOS').remaining_cents,null);
  });

  await test('all same-month real titles offset one provision, never create negative remaining estimates',async()=>{
    await gateway([fixture('ADVANCE-1',1800000,'ADIANTA EQUIPE TESTE',{due_date:advanceDate}),fixture('ADVANCE-2',1600000,'ADIANTA EQUIPE TESTE',{due_date:advanceDate})]);
    await bind('ADIANTA EQUIPE TESTE','ADIANTAMENTO');
    const p=provision(await forecast(),'ADIANTAMENTO');assert.equal(p.actual_cents,3400000);assert.equal(p.remaining_cents,0);
  });

  await test('monthly offset includes different due weeks in the same month but excludes another month',async()=>{
    const otherMonth=await scalar("SELECT ($1::date+interval '1 month')::date::text AS r",[month]);
    const first=month.slice(0,8)+'01';
    await gateway([fixture('PARTNERS',200000,'SALARIO SOCIOS TESTE'),fixture('PARTNERS-EXTRA',300000,'SALARIO SOCIOS TESTE',{due_date:first}),
      fixture('PARTNERS-NEXT',400000,'SALARIO SOCIOS TESTE',{due_date:otherMonth.slice(0,8)+'05'})]);
    const p=provision(await forecast(),'SALARIOS_SOCIOS');assert.equal(p.actual_cents,500000);assert.equal(p.remaining_cents,2800000);
  });

  await test('changing a rule appends effective revisions and never modifies past rules or saved director snapshots',async()=>{
    const f=await forecast(),rule=f.rules.find(r=>r.rule_key==='SALARIOS_SOCIOS');
    const future=await scalar("SELECT ($1::date+interval '2 months')::date::text AS r",[month]);
    const id=await scalar(ruleSql,['SALARIOS_SOCIOS',4000000,6,future,'Nova vigência sintética',rule.id]);
    assert.equal((await forecast()).rules.find(r=>r.rule_key==='SALARIOS_SOCIOS').id,id);
    const old=provision(await forecast(),'SALARIOS_SOCIOS');assert.equal(old.expected_cents,3300000);assert.equal(old.due_date,salaryDate);
    await role('postgres');assert.deepEqual(await rowsOf('public.director_positions'),before['public.director_positions']);
    assert.equal(await scalar('SELECT count(*)::int AS r FROM public.payable_forecast_rules WHERE rule_key=$1',['SALARIOS_SOCIOS']),2);
    await actor(0);await rejects(ruleSql,['SALARIOS_SOCIOS',1,5,today,'Versão antiga',rule.id],'40001');
    await rejects(ruleSql,['SALARIOS_SOCIOS',1,5,'1900-01-01','Retroatividade proibida',id],'22023');
  });

  await test('a day or amount change after the old monthly due date cannot resurrect or rewrite that cycle',async()=>{
    await actor(0);const f=await forecast(),rule=f.rules.find(r=>r.rule_key==='SALARIOS');
    const effective=month.slice(0,8)+'18',oldState=await state();
    await rejects(ruleSql,['SALARIOS',4600000,25,effective,'Dia anterior já passou',rule.id],'22023');
    await rejects(ruleSql,['SALARIOS',4700000,5,effective,'Valor anterior já venceu',rule.id],'22023');
    assert.deepEqual(await state(),oldState);
    const unchanged=provision(await forecast(),'SALARIOS');assert.equal(unchanged.due_date,salaryDate);assert.equal(unchanged.expected_cents,4600000);
  });

  await test('explicit zero is a known provision amount and later revisions cannot backdate a scheduled effective date',async()=>{
    await actor(0);let f=await forecast();const old=f.rules.find(r=>r.rule_key==='ADIANTAMENTO_SOCIOS');
    const id=await scalar(ruleSql,[old.rule_key,0,20,month,'Zero explicitamente aprovado para teste',old.id]);
    assert.equal(provision(await forecast(),old.rule_key).expected_cents,0);
    assert.equal(provision(await forecast(),old.rule_key).remaining_cents,0);
    await rejects(ruleSql,[old.rule_key,3300000,20,today,'Não antecipar vigência posterior',id],'22023');
    await scalar(ruleSql,[old.rule_key,3300000,20,month,'Restaurar valor sintético na mesma vigência',id]);
  });

  await test('stale binding/completion revisions reject atomically with no extra history or audit',async()=>{
    await actor(0);const oldState=await state();
    await rejects(mapSql,['SALARIO EQUIPE TESTE',null,today,'Versão antiga',null],'40001');
    await rejects(completionSql,['SALARIOS',month,true,'Versão antiga',null],'40001');
    assert.deepEqual(await state(),oldState);
  });

  await test('all revisions have immutable history and central audits contain official actor, previous and new values',async()=>{
    await role('postgres');
    for(const table of ['payable_forecast_rules','payable_forecast_plan_bindings','payable_forecast_completions']) {
      await rejects(`UPDATE public.${table} SET observation='Tentativa de apagar histórico'`);
      await rejects(`DELETE FROM public.${table}`);
    }
    const events=(await db.query("SELECT * FROM public.audit_events WHERE entity='payable_forecast_completions' ORDER BY occurred_at")).rows;
    assert.equal(events.length,2);assert.equal(events[0].action,'VALIDATE');assert.equal(events[1].action,'REOPEN');
    assert.equal(events[1].before_value.id,events[0].after_value.id);assert.equal(events[1].after_value.done,false);
    assert.equal(events[0].role_key,'gerente_geral');assert.equal(events[0].user_id,uid(0));
  });

  await test('director can read forecasts and history but cannot write even with forged admin role',async()=>{
    await actor(1);const f=await forecast();assert.equal(f.weeks.length,8);
    const rule=f.rules[0];await rejects(ruleSql,[rule.rule_key,1,5,today,'Diretor não altera',rule.id]);
    await rejects(mapSql,['SALARIO EQUIPE TESTE',null,today,'Diretor não altera',salaryBinding]);
    await rejects(completionSql,['SALARIOS',month,true,'Diretor não altera',doneId]);
    await rejects("INSERT INTO public.payable_forecast_completions(rule_key,month,done,observation,created_by) VALUES('SALARIOS',$1,true,'Tentativa',$2)",[month,uid(1)]);
    assert((await db.query('SELECT * FROM public.payable_forecast_rules')).rows.length>=4);
  });

  await test('CP can bind and complete but changing financial rules requires manager plus explicit CP write permission',async()=>{
    await actor(2);const f=await forecast();const rule=f.rules[0];
    await rejects(ruleSql,[rule.rule_key,1,5,today,'CP não administra regra',rule.id]);
    const newId=await bind('SALARIO EQUIPE TESTE','SALARIOS',salaryBinding);salaryBinding=newId;
    assert.equal((await forecast()).plans.find(p=>p.plan==='SALARIO EQUIPE TESTE').mapping_id,newId);
    doneId=await finish('SALARIOS',true,doneId);
    await role('postgres');await db.exec("DELETE FROM public.role_permissions WHERE role_key='gerente_geral' AND resource='contas_pagar' AND action='write'");
    await actor(0);await rejects(ruleSql,[rule.rule_key,1,5,today,'Permissão removida',rule.id]);
    await role('postgres');await db.exec("INSERT INTO public.role_permissions(role_key,resource,action) VALUES('gerente_geral','contas_pagar','write')");
  });

  await test('CR, RH and collectors have no forecast detail access, RPC writes or configuration history',async()=>{
    for(const i of [3,4,5,6]) {
      await actor(i);await rejects('SELECT public.payables_forecast()');
      for(const table of ['payable_forecast_rules','payable_forecast_plan_bindings','payable_forecast_completions']) assert.equal((await db.query(`SELECT * FROM public.${table}`)).rows.length,0);
      await rejects(completionSql,['SALARIOS',month,true,'Não autorizado',doneId]);
      await rejects(mapSql,['SALARIO EQUIPE TESTE',null,today,'Não autorizado',salaryBinding]);
    }
    for(const name of ['anon','service_role']) {await role(name);await rejects('SELECT public.payables_forecast()');await rejects('SELECT * FROM public.payable_forecast_rules');}
  });

  await test('revoked and expired sessions immediately lose forecast and direct history access',async()=>{
    await role('postgres');await db.query('UPDATE cf_private.approved_sessions SET expires_at=now()-interval \'1 second\' WHERE user_id=$1',[uid(2)]);
    await actor(2);await rejects('SELECT public.payables_forecast()');assert.equal((await db.query('SELECT * FROM public.payable_forecast_rules')).rows.length,0);
    await role('postgres');await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[sid(1),uid(1)]);
    await actor(1);await rejects('SELECT public.payables_forecast()');
  });

  await test('unsafe sum across monthly forecast groups fails instead of silently losing cents',async()=>{
    await actor(0);let f=await forecast();const rule=f.rules.find(r=>r.rule_key==='ADIANTAMENTO_SOCIOS');
    await scalar(ruleSql,[rule.rule_key,9007199254740991,20,month,'Teste sintético de precisão',rule.id]);
    await rejects('SELECT public.payables_forecast()',[],'22003');
  });

  await test('no import remains unknown even with visible defaults; migration activates before optional director report 013',async()=>{
    const empty=new PGlite();
    try {
      await empty.exec(bootstrap);
      for(const name of migrationNames.slice(0,6)) await empty.exec(await sqlFile(name));
      await empty.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[uid(0),'empty@example.invalid']);
      await empty.query("INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,'EmptyManager','Teste','gerente_geral',true)",[uid(0)]);
      await empty.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[sid(0),uid(0)]);
      await empty.exec(await sqlFile('014_payables_forecast.sql'));
      await empty.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[uid(0),JSON.stringify({session_id:sid(0)})]);
      await empty.exec('SET ROLE authenticated');
      const f=(await empty.query('SELECT public.payables_forecast() AS r')).rows[0].r;
      assert.equal(f.latest_import_id,null);assert.equal(f.rules.length,4);assert(f.missing_sources.some(s=>s.includes('relatório completo')));
      assert(f.weeks.every(w=>w.real_cents===null&&w.estimated_cents===null&&w.total_cents===null&&w.cheques_cents===null));
      assert(allProvisions(f).length>0);assert(allProvisions(f).every(p=>p.expected_cents>0&&p.remaining_cents===null&&p.actual_cents===null));
    } finally {await empty.close();}
  });
} catch(error) {console.error('FAIL',error);process.exitCode=1;}
finally {await db.close();}
console.log(`${passed} passed (synthetic local PostgreSQL, emulated Supabase identity)`);
