import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Todos os valores, arquivos e usuários são sintéticos em PostgreSQL descartável.
const db = new PGlite();
const roles = ['gerente_geral','diretor','contas_pagar','contas_receber','rh_dp','cobradora_1','cobradora_2'];
const users = Object.fromEntries(roles.map((name,i)=>[name,{
  id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
  session:`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
}]));
let currentActor='gerente_geral', passed=0, latest=null, serial=0;
const role=async name=>{await db.exec('RESET ROLE');await db.exec(`SET ROLE ${name}`);};
const actor=async name=>{currentActor=name;await role('postgres');const u=users[name];
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[u.id,JSON.stringify({session_id:u.session,role:'admin'})]);
  await role('authenticated');};
const rows=async(sql,args=[]) => (await db.query(sql,args)).rows;
const scalar=async(sql,args=[]) => (await rows(sql,args))[0].r;
const reject=async(sql,args=[],code='42501')=>assert.rejects(db.query(sql,args),e=>{assert.equal(e.code,code,e.message);return true;});
const test=async(name,run)=>{await run();passed++;console.log('PASS',name);};
const row=(entry,extra={})=>({entry_number:entry,description:`Fornecedor sintético ${entry}`,due_date:'2026-10-10',amount_cents:10000,
  source_status:'Pendente',plan:'INVESTIMENTOS',bank_account:'Conta de origem A',branch:'2 - TESTE',issued_on:'2026-10-01',...extra});
const preview=data=>scalar('SELECT public.preview_payables_import($1,$2) AS r',['grupo-consolidado',JSON.stringify(data)]);
const commitSql='SELECT public.commit_payables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,true,$9) AS r';
const commitArgs=(data,label=`arquivo-${++serial}`,previous=latest,mappings={})=>{
  const file=Buffer.from(`Arquivo sintético ${label}`);
  return [users[currentActor].id,users[currentActor].session,'grupo-consolidado',`${label}.csv`,createHash('sha256').update(file).digest('hex'),file.toString('base64'),JSON.stringify(data),JSON.stringify(mappings),previous];
};
const gateway=async args=>{await role('service_role');try{return await scalar(commitSql,args);}finally{await role('authenticated');}};
const commit=async(data,label,previous=latest,mappings={})=>{const r=await gateway(commitArgs(data,label,previous,mappings));latest=r.import_id;return r;};
const rejectedCommit=async(args,code='42501')=>assert.rejects(gateway(args),e=>{assert.equal(e.code,code,e.message);return true;});
const titles=()=>rows('SELECT * FROM public.payable_titles ORDER BY entry_number,id');
const ledger=()=>scalar("SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') AS r FROM public.payable_payments p");
const financial=id=>scalar('SELECT to_jsonb(t) AS r FROM public.payable_financial_titles t WHERE id=$1',[id]);
const stockState=async()=>{await role('postgres');const s=await scalar(`SELECT jsonb_build_object(
  'titles',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.payable_titles t),
  'imports',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.payable_imports t),
  'payments',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.payable_payments t),
  'files',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY import_id),'[]') FROM cf_private.payable_import_files t),
  'mappings',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY plan),'[]') FROM public.payable_plan_mappings t),
  'audits',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.audit_events t)) AS r`);return s;};
const paySql='SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) AS r';
const pay=async(id,cents,bank,expectedImport=null)=>{const t=await financial(id);return scalar(paySql,[id,cents,'2026-10-09',bank,'Conferência sintética',t.payment_revision,randomUUID(),expectedImport??t.last_import_id]);};
const seedLegacy=async(entry,cents,due='2026-10-10',status='SETTLED_IMPORT')=>{
  await role('postgres');
  const id=await scalar(`INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,source_status,plan,
    bank_account,branch,issued_on,macro,status,first_import_id,last_import_id,settled_at)
    SELECT scope,jsonb_build_array(branch,$1::text,$3::date,$2::bigint)::text,$1,'Versão histórica sintética',$3,$2,source_status,plan,
      bank_account,branch,issued_on,macro,$4,first_import_id,last_import_id,CASE WHEN $4='SETTLED_IMPORT' THEN clock_timestamp() ELSE NULL END
    FROM public.payable_titles WHERE branch='2 - TESTE' ORDER BY id LIMIT 1 RETURNING id AS r`,[entry,cents,due,status]);
  await actor('contas_pagar');return id;
};
const sql016=await readFile(new URL('../supabase/migrations/016_payable_identity_updates.sql',import.meta.url),'utf8');
try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  for(const file of ['001_identidade_rbac.sql','003_auth_gateway.sql','004_password_recovery.sql','005_payables.sql','006_treasury.sql',
    '007_director_positions.sql','008_receivables.sql','009_collections.sql','010_bank_import.sql','011_receivables_positions.sql',
    '012_treasury_accounts.sql','013_director_report.sql','014_payables_forecast.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  }
  await test('missing 015 blocks activation atomically before schema changes',async()=>{
    await assert.rejects(db.exec(sql016),e=>e.code==='22023');await db.exec('ROLLBACK');
    assert.equal(await scalar("SELECT to_regclass('cf_private.payable_identity_registry')::text AS r"),null);
    assert.equal(await scalar("SELECT to_regprocedure('cf_private.payable_business_key(text,text)')::text AS r"),null);
  });
  await db.exec(await readFile(new URL('../supabase/migrations/015_payable_payments.sql',import.meta.url),'utf8'));
  for(const[name,u] of Object.entries(users)){
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[u.id,`${name}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$3,true)',[u.id,`Test_${name}`,name]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[u.session,u.id]);
  }
  await actor('contas_pagar');
  const initial=[row('A'),row('B'),row('C',{amount_cents:9000})];
  const first=await commit(initial,'baseline');
  const [a,b,c]=await titles();
  const banks=await scalar('SELECT public.get_payable_payment_accounts() AS r');
  const bankA=banks[0].id,bankB=banks[1].id;
  await pay(b.id,5000,bankA);await pay(c.id,9000,bankB);
  const beforeActivation=await stockState();
  await test('activation preserves original IDs, source keys, amounts, files, actual payments and immutable audit',async()=>{
    await role('postgres');await db.exec(sql016);assert.deepEqual(await stockState(),beforeActivation);
    assert.equal(await scalar('SELECT count(*)::integer AS r FROM cf_private.payable_identity_registry'),0);
  });
  let currentRows=[row('A',{amount_cents:14000,due_date:'2026-10-17',bank_account:'Conta de origem B'}),row('B',{amount_cents:17000}),row('C',{amount_cents:9000})];
  await test('preview is read-only and identifies changed amount/date/bank as existing, not new or disappeared',async()=>{
    const before=await stockState();await actor('contas_pagar');
    const p=await preview(currentRows);assert.deepEqual(p,{previous_import_id:first.import_id,new_count:0,open_count:3,changed_count:2,settled_count:0,row_count:3});
    assert.deepEqual(await stockState(),before);await role('postgres');assert.equal(await scalar('SELECT count(*)::int AS r FROM cf_private.payable_identity_registry'),0);
  });
  let afterFirst;
  await test('daily changes update same UUID, first import is preserved and audit contains old and new values',async()=>{
    await actor('contas_pagar');const imported=await commit(currentRows,'changed');assert.equal(imported.changed_count,2);
    afterFirst=await financial(a.id);assert.equal(afterFirst.first_import_id,first.import_id);assert.equal(afterFirst.last_import_id,imported.import_id);
    assert.equal(afterFirst.amount_cents,14000);assert.equal(afterFirst.due_date,'2026-10-17');assert.equal(afterFirst.bank_account,'Conta de origem B');
    assert.equal((await titles()).length,3);assert.equal(afterFirst.source_key,'["2 - TESTE", "A"]');
    await role('postgres');const audits=await rows("SELECT before_value,after_value FROM public.audit_events WHERE entity='payable_titles' AND record_id=$1 AND action='UPDATE'",[a.id]);
    assert(audits.some(e=>e.before_value.amount_cents===10000 && e.after_value.amount_cents===14000
      &&e.before_value.due_date==='2026-10-10'&&e.after_value.due_date==='2026-10-17'
      &&e.before_value.bank_account==='Conta de origem A'&&e.after_value.bank_account==='Conta de origem B'));
    assert.equal(await scalar('SELECT count(*)::int AS r FROM cf_private.payable_identity_registry'),3);
  });
  await test('partial payment history survives nominal update and full paid reappearance remains PAID',async()=>{
    await actor('contas_pagar');const pb=await financial(b.id),pc=await financial(c.id);
    assert.equal(pb.paid_cents,5000);assert.equal(pb.outstanding_cents,12000);assert.equal(pb.financial_status,'PARTIAL');
    assert.equal(pc.paid_cents,9000);assert.equal(pc.outstanding_cents,0);assert.equal(pc.financial_status,'PAID');
    const entries=await ledger();assert.equal(entries.length,2);
    assert.deepEqual(entries,beforeActivation.payments);assert.equal(entries.find(p=>p.title_id===b.id).title_amount_cents,10000);
    const summary=await scalar("SELECT public.payable_payment_summary('2026-10-09','2026-10-09') AS r");assert.equal(summary.total_paid_cents,14000);
  });
  await test('same number in a different branch is distinct while case/space changes preserve identity',async()=>{
    await actor('contas_pagar');currentRows=[currentRows[0],{...currentRows[1],entry_number:' b ',branch:'  2 - teste '},currentRows[2],row('A',{branch:'9 - TESTE'})];
    const p=await preview(currentRows);assert.equal(p.new_count,1);assert.equal(p.open_count,3);
    await commit(currentRows,'normalization');assert.equal((await titles()).length,4);assert.equal((await financial(b.id)).entry_number,'b');
    const raw=await rows("SELECT id FROM public.payable_titles WHERE branch='9 - TESTE' AND entry_number='A'");assert.equal(raw.length,1);assert.notEqual(raw[0].id,a.id);
  });
  await test('lower updated nominal than paid flags OVERPAID and leaves realized bank/date/macro untouched',async()=>{
    await actor('contas_pagar');currentRows=currentRows.map(r=>r.entry_number.trim().toUpperCase()==='B'?{...r,amount_cents:4000,bank_account:'Outra conta de origem'}:r);
    await commit(currentRows,'lower-nominal');const pb=await financial(b.id);
    assert.equal(pb.financial_status,'OVERPAID');assert.equal(pb.overpaid_cents,1000);assert.equal(pb.outstanding_cents,0);
    assert.deepEqual(await ledger(),beforeActivation.payments);
    const summary=await scalar("SELECT public.payable_payment_summary('2026-10-09','2026-10-09') AS r");assert.equal(summary.total_paid_cents,14000);
  });
  await test('daily disappearance preserves title and ledger, reappearance uses canonical UUID',async()=>{
    await actor('contas_pagar');const withoutA=currentRows.filter(r=>!(r.entry_number==='A'&&r.branch==='2 - TESTE'));
    assert.equal((await preview(withoutA)).settled_count,1);await commit(withoutA,'absence');
    assert.equal((await financial(a.id)).status,'SETTLED_IMPORT');const p=await preview(currentRows);assert.equal(p.new_count,0);assert.equal(p.open_count,4);
    await commit(currentRows,'return');assert.equal((await financial(a.id)).id,a.id);assert.equal((await financial(a.id)).status,'OPEN');
    await role('postgres');assert((await rows("SELECT id FROM public.audit_events WHERE record_id=$1 AND action='REOPEN'",[a.id])).length===1);
  });
  await test('duplicate business identity within one file is ambiguous even with changed due/amount; no partial import',async()=>{
    const before=await stockState();await actor('contas_pagar');
    for(const data of [[...currentRows,row('A',{amount_cents:1,due_date:'2026-10-24'})],[...currentRows,currentRows[0]]]){
      await reject('SELECT public.preview_payables_import($1,$2)',['grupo-consolidado',JSON.stringify(data)],'P0016');
      await rejectedCommit(commitArgs(data),'P0016');
    }
    assert.deepEqual(await stockState(),before);
  });
  await test('multiple existing active IDs block matching and leave source, ledger and files unchanged',async()=>{
    const conflict=await seedLegacy('A',19000,'2026-10-18','OPEN');const before=await stockState();await actor('contas_pagar');
    await reject('SELECT public.preview_payables_import($1,$2)',['grupo-consolidado',JSON.stringify(currentRows)],'P0016');
    await rejectedCommit(commitArgs(currentRows),'P0016');assert.deepEqual(await stockState(),before);
    await role('postgres');await db.query('DELETE FROM public.payable_titles WHERE id=$1',[conflict]);
  });
  let oldInactive, selectedInactive;
  await test('several inactive historical versions without exact old tuple block instead of choosing newest',async()=>{
    oldInactive=await seedLegacy('H',1000,'2026-10-10');selectedInactive=await seedLegacy('H',2000,'2026-10-11');
    const before=await stockState();await actor('contas_pagar');const data=[...currentRows,row('H',{amount_cents:3000,due_date:'2026-10-12'})];
    await reject('SELECT public.preview_payables_import($1,$2)',['grupo-consolidado',JSON.stringify(data)],'P0016');
    await rejectedCommit(commitArgs(data),'P0016');assert.deepEqual(await stockState(),before);
  });
  await test('unique exact legacy tuple resolves inactive history once, then later amount/date changes use chosen UUID',async()=>{
    await actor('contas_pagar');const untouched=(await rows('SELECT * FROM public.payable_titles WHERE id=$1',[oldInactive]))[0];
    currentRows=[...currentRows,row('H',{amount_cents:2000,due_date:'2026-10-11'})];
    assert.equal((await preview(currentRows)).new_count,0);await commit(currentRows,'resolve-inactive');
    assert.equal((await financial(selectedInactive)).status,'OPEN');assert.deepEqual((await rows('SELECT * FROM public.payable_titles WHERE id=$1',[oldInactive]))[0],untouched);
    currentRows=currentRows.map(r=>r.entry_number==='H'?{...r,amount_cents:1500,due_date:'2026-10-20'}:r);
    await commit(currentRows,'update-resolved');assert.equal((await financial(selectedInactive)).amount_cents,1500);
    assert.deepEqual((await rows('SELECT * FROM public.payable_titles WHERE id=$1',[oldInactive]))[0],untouched);
  });
  await test('single active legacy version wins while closed previous versions are preserved untouched',async()=>{
    const closed=await seedLegacy('U',1000);const active=await seedLegacy('U',2000,'2026-10-11','OPEN');
    const before=(await rows('SELECT * FROM public.payable_titles WHERE id=$1',[closed]))[0];
    currentRows=[...currentRows,row('U',{amount_cents:3000,due_date:'2026-10-23'})];
    assert.equal((await preview(currentRows)).new_count,0);await commit(currentRows,'resolve-active');
    assert.equal((await financial(active)).amount_cents,3000);assert.equal((await financial(active)).status,'OPEN');
    assert.deepEqual((await rows('SELECT * FROM public.payable_titles WHERE id=$1',[closed]))[0],before);
  });
  let guardedHistorical,guardedActive,guardedPayment;
  await test('active payments on an unchosen historical version block preview and commit without merging ledger',async()=>{
    guardedHistorical=await seedLegacy('LEDGER-GUARD',1000);
    guardedPayment=await pay(guardedHistorical,500,bankA);
    guardedActive=await seedLegacy('LEDGER-GUARD',2000,'2026-10-11','OPEN');
    const data=[...currentRows,row('LEDGER-GUARD',{amount_cents:3000,due_date:'2026-10-23'})];
    const before=await stockState();await actor('contas_pagar');
    await reject('SELECT public.preview_payables_import($1,$2)',['grupo-consolidado',JSON.stringify(data)],'P0016');
    await rejectedCommit(commitArgs(data,'historical-payment-conflict'),'P0016');
    assert.deepEqual(await stockState(),before);
    await role('postgres');
    assert.equal(await scalar("SELECT count(*)::int AS r FROM cf_private.payable_identity_registry WHERE business_key=cf_private.payable_business_key('2 - TESTE','LEDGER-GUARD')"),0);
    await actor('contas_pagar');
    assert.equal((await financial(guardedHistorical)).paid_cents,500);
    assert.equal((await financial(guardedActive)).paid_cents,0);
  });
  await test('fully reversed historical payments preserve their history and allow the unambiguous active candidate',async()=>{
    const historical=await financial(guardedHistorical);
    const reversal=await scalar('SELECT public.cancel_payable_payment($1,$2,$3) AS r',[guardedPayment,'Estorno sintético após conferência da origem',historical.payment_revision]);
    const paymentsBefore=await ledger();
    currentRows=[...currentRows,row('LEDGER-GUARD',{amount_cents:3000,due_date:'2026-10-23'})];
    assert.equal((await preview(currentRows)).new_count,0);
    await commit(currentRows,'resolved-historical-payment');
    assert.equal((await financial(guardedActive)).amount_cents,3000);
    assert.equal((await financial(guardedActive)).paid_cents,0);
    assert.equal((await financial(guardedHistorical)).status,'SETTLED_IMPORT');
    assert.equal((await financial(guardedHistorical)).paid_cents,0);
    assert.deepEqual(await ledger(),paymentsBefore);
    assert.equal(await scalar('SELECT count(*)::int AS r FROM public.payable_payment_reversals WHERE id=$1 AND payment_id=$2',[reversal,guardedPayment]),1);
  });
  await test('stale preview, duplicate file and unclassified plan roll back changes to data and identity registry',async()=>{
    const before=await stockState();await actor('contas_pagar');
    await rejectedCommit(commitArgs(currentRows,'stale',first.import_id),'40001');
    await rejectedCommit(commitArgs(currentRows,'resolve-active'),'23505');
    await rejectedCommit(commitArgs([...currentRows,row('NEW',{plan:'PLANO SEM CLASSIFICAÇÃO'})]),'23514');
    assert.deepEqual(await stockState(),before);
    await role('postgres');assert.equal(await scalar("SELECT count(*)::int AS r FROM cf_private.payable_identity_registry WHERE business_key='[\"2 - TESTE\", \"NEW\"]'"),0);
  });
  await test('source plan classification updates current title without rewriting historical realized macro or bank',async()=>{
    await actor('contas_pagar');const before=await ledger();
    currentRows=currentRows.map(r=>r.entry_number.trim().toUpperCase()==='B'?{...r,plan:'PLANO SINTÉTICO ATUALIZADO',bank_account:'Nova origem'}:r);
    await commit(currentRows,'macro-updated',latest,{'PLANO SINTÉTICO ATUALIZADO':'FIXO'});
    assert.equal((await financial(b.id)).macro,'FIXO');assert.deepEqual(await ledger(),before);
    const summary=await scalar("SELECT public.payable_payment_summary('2026-10-09','2026-10-09') AS r");
    assert.equal(summary.by_macro.find(m=>m.macro==='VARIÁVEL').amount_cents,14000);
    assert.equal(summary.by_macro.find(m=>m.macro==='FIXO').amount_cents,0);
  });
  await test('new identity path retains strict nine-field validation and numeric precision limits',async()=>{
    await actor('contas_pagar');
    for(const data of [[row('BAD',{amount_cents:1.2})],[row('BAD',{amount_cents:-1})],
      [row('BAD',{amount_cents:'1'})],[row('BAD',{due_date:'2026-02-30'})],[row('BAD',{source_key:'forjado'})],
      [row('BAD',{branch:123})],[row('BAD',{bank_account:1})],
      [row('L1',{amount_cents:9007199254740991}),row('L2',{amount_cents:1})]]){
      await reject('SELECT public.preview_payables_import($1,$2)',['grupo-consolidado',JSON.stringify(data)],'22023');
      await rejectedCommit(commitArgs(data),'22023');
    }
  });
  await test('maximum full report resolves 5,000 distinct stable identities without writing during preview',async()=>{
    const before=await stockState();await actor('contas_pagar');
    const data=Array.from({length:5000},(_,i)=>row(`LOTE-${i}`,{amount_cents:1}));
    const p=await preview(data);assert.equal(p.row_count,5000);assert.equal(p.new_count,5000);assert.equal(p.open_count,0);assert.equal(p.changed_count,0);
    assert.deepEqual(await stockState(),before);
  });
  await test('stale title import token blocks payment after same-ID source update',async()=>{
    await actor('contas_pagar');const t=await financial(a.id);await reject(paySql,[a.id,100,'2026-10-09',bankA,'Conferência sintética',t.payment_revision,randomUUID(),first.import_id],'40001');
    await pay(a.id,100,bankA);assert.equal((await financial(a.id)).paid_cents,100);
  });
  await test('director may read but cannot import/write, CP is allowed, CR and restricted profiles are denied',async()=>{
    for(const name of roles){await actor(name);const allowed=['gerente_geral','diretor','contas_pagar'].includes(name);
      assert.equal((await rows('SELECT * FROM public.payable_financial_titles')).length>0,allowed);
      if(['gerente_geral','contas_pagar'].includes(name))assert.equal((await preview(currentRows)).row_count,currentRows.length);
      else {await reject('SELECT public.preview_payables_import($1,$2)',['grupo-consolidado',JSON.stringify(currentRows)]);await rejectedCommit(commitArgs(currentRows));}
      await reject("UPDATE public.payable_titles SET amount_cents=1");await reject('SELECT * FROM cf_private.payable_identity_registry');
      await reject("SELECT cf_private.resolve_payable_identity_rows('grupo-consolidado','[]')");
    }
    await role('postgres');await reject("UPDATE cf_private.payable_identity_registry SET business_key='forjado'");
    await reject('DELETE FROM cf_private.payable_identity_registry');
  });
  await test('revoked session cannot inspect or update matching identities',async()=>{
    await role('postgres');await db.query('INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES($1,$2)',[users.contas_pagar.session,users.contas_pagar.id]);
    await actor('contas_pagar');assert.equal((await rows('SELECT * FROM public.payable_financial_titles')).length,0);
    await reject('SELECT public.preview_payables_import($1,$2)',['grupo-consolidado',JSON.stringify(currentRows)]);await rejectedCommit(commitArgs(currentRows));
  });
  console.log(`${passed} passed; 0 failed (isolated PostgreSQL, emulated Supabase identity)`);
}catch(error){console.error(`FAILED after ${passed} passed:`,error.message,error.code??'');process.exitCode=1;}
finally{await db.close();}
