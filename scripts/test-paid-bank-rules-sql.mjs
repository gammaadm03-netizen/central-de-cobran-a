import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createCostFixture} from './lib/product-cost-sql-fixture.mjs';
import {buildPaidBankRulesSql} from './bundle-paid-bank-rules.mjs';
// Disposable local PostgreSQL. Every identity, account alias, row and artifact is synthetic.
const f=await createCostFixture(),{db,users,owner,actor,scalar,file}=f;
let passed=0,seq=0,latest=null,today,yesterday,bank;
const test=async(name,run)=>{await run();passed++;console.log('PASS',name)};
const reject=(run,code)=>assert.rejects(run,e=>{assert.equal(e.code,code,e.message);return true});
const orig=()=>{const bytes=Buffer.from('Original sintético de bancos '+(++seq));return{name:`bancos-${seq}.csv`,sha:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')}};
const key=async(branch,name)=>{await owner();const r=await scalar('SELECT cf_private.payable_paid_bank_key($1,$2) r',[branch,name]);await actor();return r};
const paid=(entry,amount,paid_bank='CAIXA INTERNO',branch='1',extra={})=>({entry_number:entry,branch,source_status:'PAGO',paid_on:yesterday,amount_paid_cents:amount,paid_bank,...extra});
const seed=(entry,amount=10000,branch='1')=>({entry_number:entry,branch,description:'Fornecedor sintético '+entry,due_date:today,amount_cents:amount,issued_on:'2026-09-01',source_status:'ABERTO',plan:'PLANO SINTETICO',bank_account:'CONTA PREVISTA'});
const forecast=async rows=>{const o=orig();await owner();await db.exec('SET ROLE service_role');try{const r=await scalar('SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9) r',[users.manager.id,users.manager.session,'grupo-consolidado',o.name,o.sha,o.base64,JSON.stringify(rows),'{"PLANO SINTETICO":"FIXO"}',latest]);latest=r.import_id;return r}finally{await actor()}};
const preview=(rows,choices={},banks={},plans={})=>scalar('SELECT public.preview_payables_paid_import_v2($1,$2,$3,$4,$5) r',['grupo-consolidado',JSON.stringify(rows),JSON.stringify(banks),JSON.stringify(plans),JSON.stringify(choices)]);
const freeze=async(rows,choices={},banks={})=>({rows,choices,banks,o:orig(),request:randomUUID(),previous:latest,financial:(await scalar('SELECT public.get_payables_revision() r')).financial_revision});
const commit=async(r,user='manager')=>{await owner(user);await db.exec('SET ROLE service_role');try{const out=await scalar('SELECT public.commit_payables_paid_import_v2_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) r',[users[user].id,users[user].session,'grupo-consolidado',r.o.name,r.o.sha,r.o.base64,JSON.stringify(r.rows),JSON.stringify(r.banks),r.previous,r.confirm??false,'{}',r.financial,JSON.stringify(r.choices),r.request]);if(!out.idempotent)latest=out.import_id;return out}finally{await actor()}};
const choice=reason=>({action:'WRITE_OFF',reason});
const getTitle=entry=>scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1',[entry]);
const protectedState=async()=>{await owner();const out={};for(const name of ['public.bank_accounts','public.bank_balance_positions','public.payable_titles','public.payable_imports','cf_private.payable_import_files','public.payable_payments','public.payable_payment_reversals','public.payable_title_reviews','public.payable_administrative_writeoffs','public.payable_paid_import_rows','public.payable_paid_bank_mappings','cf_private.payable_import_resolution_requests','public.profiles','public.role_permissions','public.audit_events'])out[name]=await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') r FROM ${name} t`);await actor();return out};
const aliases=[
 ['BANCO ERP SINTETICO EASY - 900001-0','BRADESCO EASY CLEAN'],
 ['BANCO ERP SINTETICO ECOPLAST - 900002-0','BRADESCO ECOPLAST'],
 ['BANCO ERP SINTETICO PARTICIPAÇÕES - 900003-0','BRADESCO F2G'],
 ['BANCO ERP SINTETICO FAST - 900004-0','BRADESCO FAST CLEAN'],
 ['BANCO ERP SINTETICO GAMMA - 900005-0','BRADESCO GAMMA IND'],
 ['BANCO ERP SINTETICO LIMPE FÁCIL - 900006-0','BRADESCO LIMPE FACIL'],
 ['DEBITO SINTETICO ECOPLAST - 900007-0','BRADESCO ECOPLAST'],
];
const sql=await buildPaidBankRulesSql(aliases.map(([source,official_name])=>({source,official_name})));
assert.equal(await readFile(new URL('../supabase/dashboard/ativar-bancos-baixas-contas-pagar.sql',import.meta.url),'utf8'),await buildPaidBankRulesSql());
try{
 await actor();const dates=(await db.query("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text yesterday")).rows[0];today=dates.today;yesterday=dates.yesterday;
 bank=await scalar("SELECT id r FROM public.bank_accounts WHERE display_name='BRADESCO ECOPLAST' AND enabled");
 await forecast([...aliases.map((_,i)=>seed('ALIAS-'+i,12000+i,String(i+1))),seed('CASH-CENT',19000),seed('CASH-NONCENT',25000),seed('CASH-PAID',30000),seed('LEGACY-CASH',77777),seed('CENT-OTHER',8000),seed('NORMAL',9000),seed('UNKNOWN-ALIAS',10000),seed('DUPLICATE-ALIAS',11000),seed('CASH-ROLLBACK',41000),seed('BANK-ROLLBACK',42000),...Array.from({length:13},(_,i)=>seed('CASH-LIST-'+i,12500+i))]);
 await owner();for(const name of ['042_payable_administrative_writeoff.sql','043_payable_import_reconciliation.sql'])await db.exec(await file(name));await actor();
 // Seed a historical non-cent cash payment through the unmodified 043 contract.
 const legacy=await freeze([paid('LEGACY-CASH',77777)],{}, {[await key('1','CAIXA INTERNO')]:bank});const legacyResult=await commit(legacy);
 const beforeActivation=await protectedState();
 await test('050 installs without changing accounts, balances, permissions, original sources or any financial record',async()=>{await owner();await db.exec(sql);assert.deepEqual(await protectedState(),beforeActivation);await owner();assert.equal(await scalar('SELECT count(*)::integer r FROM cf_private.payable_paid_bank_aliases'),aliases.length);for(const [raw,official] of aliases)assert.equal(await scalar('SELECT cf_private.payable_paid_bank_alias_name($1) r',[raw]),official);await actor();const c=await scalar('SELECT public.payables_import_capabilities() r');assert.equal(c.reconciliation_version,'043');assert.equal(c.paid_bank_rules_version,'050');assert.equal(c.internal_cash_writeoff,true)});
 await test('all seven exact approved aliases resolve existing official BANK accounts across branches, preserving source descriptions',async()=>{
  const rows=aliases.map(([name],i)=>paid('ALIAS-'+i,12000+i,name,String(i+1))),p=await preview(rows);assert.equal(p.can_commit,true);assert.equal(p.unmapped_banks.length,0);
  for(let i=0;i<aliases.length;i++){assert.equal(p.rows[i].paid_bank,aliases[i][0]);assert.equal(p.rows[i].branch,String(i+1));assert.equal(p.rows[i].bank_account_id,await scalar('SELECT id r FROM public.bank_accounts WHERE display_name=$1 AND enabled',[aliases[i][1]]));}
  const state=await protectedState();await preview(rows);assert.deepEqual(await protectedState(),state);
 });
 await test('normalization accepts only case, accents and spacing variations; another account number is not guessed',async()=>{
  const p=await preview([paid('ALIAS-5',12005,'  banco  erp sintetico limpe facil - 900006-0  ','6')]);assert.equal(p.can_commit,true);assert.equal(p.rows[0].paid_bank,'banco erp sintetico limpe facil - 900006-0');
  for(const [raw,target] of aliases){const decomposed=raw.normalize('NFD');await owner();assert.equal(await scalar('SELECT cf_private.payable_paid_bank_alias_name($1) r',[decomposed]),target);await actor();}
  await owner();assert.equal(await scalar("SELECT cf_private.payable_paid_bank_text_key($1) r",['  CAIXA\u00a0INTERNO  ']),'CAIXA INTERNO');await actor();
  const unknown=await preview([paid('UNKNOWN-ALIAS',10000,'BANCO ERP SINTETICO ECOPLAST - 900002-9')]);assert.equal(unknown.rows[0].outcome,'UNMAPPED_BANK');assert.equal(unknown.can_commit,false);
 });
 await test('authoritative aliases replace wrong stored defaults and reject an explicit contradictory selection atomically',async()=>{
  const raw=aliases[0][0],k=await key('1',raw),correct=await scalar("SELECT id r FROM public.bank_accounts WHERE display_name='BRADESCO EASY CLEAN'");await owner();await db.query('INSERT INTO public.payable_paid_bank_mappings(mapping_key,branch,paid_bank,bank_account_id,created_by) VALUES($1,$2,$3,$4,$5)',[k,'1',raw,bank,users.manager.id]);await actor();
  assert.equal((await preview([paid('ALIAS-0',12000,raw)])).rows[0].bank_account_id,correct);const state=await protectedState();await reject(preview([paid('ALIAS-0',12000,raw)],{},{[k]:bank}),'22023');assert.deepEqual(await protectedState(),state);
 });
 await test('a missing, disabled or duplicated canonical account cannot use another account or a stale mapping',async()=>{
  const raw=aliases[0][0],correct=await scalar("SELECT id r FROM public.bank_accounts WHERE display_name='BRADESCO EASY CLEAN'");
  await owner();await db.query('UPDATE public.bank_accounts SET enabled=false WHERE id=$1',[correct]);await actor();let p=await preview([paid('ALIAS-0',12000,raw)]);assert.equal(p.rows[0].outcome,'UNMAPPED_BANK');assert.equal(p.unmapped_banks[0].official_bank_name,'BRADESCO EASY CLEAN');
  await owner();await db.query('UPDATE public.bank_accounts SET enabled=true,display_name=$2 WHERE id=$1',[correct,'NOME TEMPORARIO SINTETICO']);await actor();p=await preview([paid('ALIAS-0',12000,raw)]);assert.equal(p.rows[0].outcome,'UNMAPPED_BANK');
  await owner();await db.query('UPDATE public.bank_accounts SET display_name=$2 WHERE id=$1',[correct,'BRADESCO EASY CLEAN']);const duplicate=await scalar("INSERT INTO public.bank_accounts(company,bank,account_label,account_type,display_name) VALUES('SINTETICA','Bradesco','Duplicada','BANK','BRADESCO EASY CLEAN') RETURNING id r");await actor();p=await preview([paid('ALIAS-0',12000,raw)]);assert.equal(p.rows[0].outcome,'UNMAPPED_BANK');await owner();await db.query('DELETE FROM public.bank_accounts WHERE id=$1',[duplicate]);await actor();
 });
 await test('cash accepts absent or future administrative date but normal payments retain the actual-date guard',async()=>{
  for(const paid_on of [null,'2043-01-23']){const p=await preview([paid('CASH-NONCENT',12345,'Caixa Interno','1',{paid_on})]);assert.equal(p.writeoff_count,1);assert.equal(p.reconciliation_items[0].kind,'INTERNAL_CASH');assert.equal(p.rows[0].paid_on,paid_on);assert.equal(p.unmapped_banks.length,0);assert.equal(p.new_payment_count,0);assert.equal(p.can_commit,false);}
  await reject(preview([paid('NORMAL',9000,aliases[1][0],'1',{paid_on:null})]),'22023');await reject(preview([paid('NORMAL',9000,aliases[1][0],'1',{paid_on:'2043-01-23'})]),'22023');
 });
 await test('each cash row requires its own writeoff reason; a partial choice cannot import any part of a mixed report',async()=>{
  const rows=[paid('CASH-CENT',1,'CAIXA INTERNO','1',{paid_on:null}),paid('CASH-NONCENT',12345,'CAIXA INTERNO','1',{paid_on:null}),paid('NORMAL',9000,aliases[1][0])],choices={'row:1':choice('Confirmação individual sintética A')},p=await preview(rows,choices);assert.equal(p.can_commit,false);assert.equal(p.reconciliation_items.length,2);assert.equal(p.reconciliation_items[0].kind,'CENT');assert.equal(p.reconciliation_items[1].kind,'INTERNAL_CASH');assert.equal(p.reconciliation_items[1].amount_cents,25000);assert.equal(p.reconciliation_items[1].source_amount_cents,12345);
  const r=await freeze(rows,choices),state=await protectedState();await reject(commit(r),'P0042');assert.deepEqual(await protectedState(),state);
 });
 let mixed,mixedResult;
 await test('one atomic confirmation applies actual bank payment and cash writeoffs without changing original nominal/due date',async()=>{
  const rows=[paid('CASH-CENT',1,'CAIXA INTERNO','1',{paid_on:null}),paid('CASH-NONCENT',12345,'CAIXA INTERNO','1',{paid_on:null}),paid('NORMAL',9000,aliases[1][0])],choices={'row:1':choice('Baixa individual sintética A'),'row:2':choice('Baixa individual sintética B')},beforeA=await getTitle('CASH-CENT'),beforeB=await getTitle('CASH-NONCENT');
  mixed=await freeze(rows,choices);mixedResult=await commit(mixed);assert.equal(mixedResult.writeoff_count,2);assert.equal(mixedResult.new_payment_count,1);assert.equal(mixedResult.reviewed_count,1);
  for(const [entry,before] of [['CASH-CENT',beforeA],['CASH-NONCENT',beforeB]]){const t=await getTitle(entry);assert.equal(t.amount_cents,before.amount_cents);assert.equal(t.due_date,before.due_date);assert.equal(t.financial_status,'ADMIN_WRITEOFF');assert.equal(t.paid_cents,0);}
  await owner();assert.equal(await scalar('SELECT count(*)::integer r FROM public.payable_paid_import_rows WHERE import_id=$1',[mixedResult.import_id]),1);const raw=await scalar('SELECT encode(file_bytes,\'base64\') r FROM cf_private.payable_import_files WHERE import_id=$1',[mixedResult.import_id]);assert.equal(raw.replace(/\s/g,''),mixed.o.base64);await actor();
 });
 await test('lost acknowledgement, fresh same-hash replay and already written-off cash preserve every original financial event',async()=>{
  const state=await protectedState(),out=await commit(mixed);assert.equal(out.idempotent,true);assert.equal(out.import_id,mixedResult.import_id);assert.deepEqual(await protectedState(),state);
  const p=await preview(mixed.rows);assert.equal(p.can_commit,false);assert.equal(p.reconciliation_items[1].already_written_off,true);
  const next={...mixed,request:randomUUID()},replay=await commit(next);assert.equal(replay.idempotent,true);assert.equal(replay.import_id,mixedResult.import_id);
  const before=await protectedState();await reject(commit({...mixed,request:randomUUID(),choices:{'row:1':mixed.choices['row:1']}}),'P0042');assert.deepEqual(await protectedState(),before);
 });
 await test('cash cannot erase an existing actual payment or invent an unknown title',async()=>{
  const row=await getTitle('CASH-PAID');await scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r',[row.id,30000,yesterday,bank,'Pagamento manual sintético',row.payment_revision,randomUUID(),row.last_import_id]);
  for(const entry of ['CASH-PAID','UNKNOWN-CASH']){const report=[paid(entry,777,'CAIXA INTERNO','1',{paid_on:null})],p=await preview(report,entry==='CASH-PAID'?{'row:1':choice('Revisão sem apagar pagamento')}:{});assert.equal(p.can_commit,false);const state=await protectedState();await reject(commit(await freeze(report,entry==='CASH-PAID'?{'row:1':choice('Revisão sem apagar pagamento')}:{})),'P0042');assert.deepEqual(await protectedState(),state);}
 });
 await test('a pre050 positive cash payment preserves its old durable replay but a fresh administrative reinterpretation is refused',async()=>{
  const before=await protectedState(),replay=await commit(legacy);assert.equal(replay.import_id,legacyResult.import_id);assert.equal(replay.idempotent,true);assert.deepEqual(await protectedState(),before);
  const next={...legacy,request:randomUUID(),banks:{},choices:{'row:1':choice('Não converter pagamento antigo automaticamente')}};await reject(commit(next),'P0042');assert.deepEqual(await protectedState(),before);
 });
 await test('cash bank mappings are refused while all normal approved aliases persist with unchanged source texts',async()=>{
  await reject(preview([paid('CASH-CENT',1,'CAIXA INTERNO','1',{paid_on:null})],{}, {[await key('1','CAIXA INTERNO')]:bank}),'22023');
  const rows=aliases.map(([name],i)=>paid('ALIAS-'+i,12000+i,name,String(i+1))),r=await freeze(rows),out=await commit(r);assert.equal(out.new_payment_count,7);await owner();for(let i=0;i<aliases.length;i++){const stored=await scalar('SELECT source_row r FROM public.payable_paid_import_rows WHERE import_id=$1 AND source_row->>\'entry_number\'=$2',[out.import_id,'ALIAS-'+i]);assert.equal(stored.paid_bank,aliases[i][0]);assert.equal(stored.bank_account_id,await scalar('SELECT id r FROM public.bank_accounts WHERE display_name=$1 AND enabled',[aliases[i][1]]));}await actor();
 });
 await test('thirteen internal cash markers require thirteen independent confirmations and record no cash or payment',async()=>{
  const rows=Array.from({length:13},(_,i)=>paid('CASH-LIST-'+i,1,'CAIXA INTERNO','1',{paid_on:null})),choices=Object.fromEntries(rows.map((_,i)=>['row:'+(i+1),choice('Baixa administrativa individual sintética '+(i+1))]));
  const partial={...choices};delete partial['row:13'];assert.equal((await preview(rows,partial)).can_commit,false);const frozen=await freeze(rows,partial),before=await protectedState();await reject(commit(frozen),'P0042');assert.deepEqual(await protectedState(),before);
  const n=await scalar('SELECT count(*)::integer r FROM public.payable_payments'),out=await commit(await freeze(rows,choices));assert.equal(out.writeoff_count,13);assert.equal(out.new_payment_count,0);assert.equal(out.reviewed_count,0);assert.equal(await scalar('SELECT count(*)::integer r FROM public.payable_payments'),n);
 });
 await test('a late audit failure rolls back alias mappings, source bytes, writeoffs and actual payments together',async()=>{
  const rows=[paid('CASH-ROLLBACK',222,'CAIXA INTERNO','1',{paid_on:null}),paid('BANK-ROLLBACK',42000,aliases[1][0])],r=await freeze(rows,{'row:1':choice('Baixa sintética com teste de reversão integral')});
  await owner();await db.exec(`CREATE FUNCTION cf_private.synthetic_paid_bank_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='payable_import_resolution' THEN RAISE EXCEPTION 'Falha sintética tardia';END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_paid_bank_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_paid_bank_audit_failure();`);await actor();const before=await protectedState();
  try{await reject(commit(r),'P0001');assert.deepEqual(await protectedState(),before);}finally{await owner();await db.exec('DROP TRIGGER synthetic_paid_bank_audit_failure ON public.audit_events;DROP FUNCTION cf_private.synthetic_paid_bank_audit_failure();');await actor();}
 });
 await test('installation is idempotent, all private helpers remain inaccessible and director cannot import',async()=>{
  const before=await protectedState();await owner();const config=await scalar('SELECT jsonb_agg(to_jsonb(a) ORDER BY source_key) r FROM cf_private.payable_paid_bank_aliases a');await db.exec(sql);assert.deepEqual(await protectedState(),before);await owner();assert.deepEqual(await scalar('SELECT jsonb_agg(to_jsonb(a) ORDER BY source_key) r FROM cf_private.payable_paid_bank_aliases a'),config);await actor();
  for(const role of ['anon','authenticated','service_role']){await owner();await db.exec('SET ROLE '+role);await reject(scalar('SELECT count(*) r FROM cf_private.payable_paid_bank_aliases'),'42501');await reject(scalar("SELECT cf_private.payable_paid_bank_alias_name('BANCO ERP SINTETICO ECOPLAST - 900002-0') r"),'42501');}
  await actor('director');await reject(scalar('SELECT public.preview_payables_paid_import_v2($1,$2,$3,$4,$5) r',['grupo-consolidado',JSON.stringify([paid('NORMAL',9000,aliases[1][0])]),'{}','{}','{}']),'42501');await actor();
 });
 console.log(`${passed} passed (paid bank rules and internal cash, synthetic local PostgreSQL)`);
}catch(e){console.error('FAIL',e.message,JSON.stringify({code:e.code,detail:e.detail,where:e.where}));process.exitCode=1;}finally{await db.close()}
