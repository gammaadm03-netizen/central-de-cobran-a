import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivableReceiptReversalSql } from './bundle-receivable-receipt-reversal.mjs';
import { buildReceivableReversalConsumersSql, RECEIVABLE_REVERSAL_CONSUMER_SIGNATURES } from './receivable-reversal-consumers.mjs';

// Banco descartável; títulos, valores e comprovantes exclusivamente sintéticos.
const f = await createCostFixture(), { db, users, id, owner, actor, scalar, file } = f;
const fragment = await buildReceivableReversalConsumersSql();
let passed = 0, today, due, agent, importId, titleId, originalReceipt;
const current = () => scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1', [titleId]);
const detail = () => scalar('SELECT public.collection_case_detail($1) r', [titleId]);
const count = table => scalar('SELECT count(*)::integer r FROM ' + table + ' WHERE ' + (table === 'public.receivable_titles' ? 'id' : 'title_id') + '=$1', [titleId]);
const definition = signature => scalar('SELECT pg_get_functiondef($1::regprocedure) r', [signature]);
const metadata = signature => scalar("SELECT jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig,'strict',p.proisstrict,'volatile',p.provolatile,'parallel',p.proparallel,'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid)) r FROM pg_proc p WHERE p.oid=$1::regprocedure", [signature]);
const reject = async (fn, code) => {
 await db.exec('SAVEPOINT expected_error');
 try { await assert.rejects(fn, error => { assert.equal(error.code, code, error.message); return true; }); }
 finally { await db.exec('ROLLBACK TO SAVEPOINT expected_error; RELEASE SAVEPOINT expected_error'); }
};
const test = async (name, fn) => {
 await owner(); await db.exec('BEGIN');
 try { await fn(); passed++; console.log('PASS', name); }
 finally { await db.exec('ROLLBACK'); await actor('manager'); }
};
const reverse = async receiptId => {
 await actor('manager'); const title = await current();
 return scalar('SELECT public.reverse_receivable_receipt($1,$2,$3,$4) r', [receiptId, 'Confirmação incorreta no cenário sintético', title.revision, randomUUID()]);
};
const reportPayment = async () => {
 await actor('collector'); const title = await current();
 await scalar("SELECT public.collection_work_action($1,'START',$2,$3) r", [titleId, title.revision, randomUUID()]);
 const d = await detail();
 await scalar("SELECT public.save_collection_case($1,'TÍTULO PAGO','Novo pagamento sintético conferido',NULL,NULL,$2,$3,$4,true,$5) r", [titleId, d.title.revision, d.case.revision, today, randomUUID()]);
};
const validateNet = async (amount = 18500) => {
 await reportPayment(); await actor('cr'); const title = await current();
 return scalar("SELECT public.validate_receivable_payment_v2($1,'CONFIRM',$2,$3,$4,'Comprovante sintético posterior ao estorno',$5,$6) r",
  [titleId, today, amount, amount === title.amount_cents ? null : 'Retenção sintética conferida', title.revision, randomUUID()]);
};
const sourceRow = amount => ({ document: 'NF-REV-CONSUMER-SYN', client_name: 'Cliente de estorno sintético', client_document: null,
 branch: '4', issued_on: null, due_date: due, amount_cents: 20000, received_on: today, received_amount_cents: amount });
const commitPaid = async (rows, label = 'Relatório de Quitados sintético após estorno') => {
 await actor('cr'); const token = await scalar('SELECT public.get_receivables_sync_revision() r');
 const bytes = Buffer.from(label);
 await owner(); await db.exec('SET ROLE service_role');
 return scalar("SELECT public.commit_receivables_received_import_from_gateway($1,$2,'grupo-consolidado','quitados-sinteticos.csv',$3,$4,$5,'{}',$6,$7,false) r",
  [users.cr.id, users.cr.session, createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), token.import_id, token.financial_revision]);
};
const report = () => scalar("SELECT public.commissions_report('COLLECTOR',$1,$1,NULL,NULL,0,100) r", [today]);

try {
 await owner();
 for (const name of ['040_collection_email_draft.sql', '041_receivable_import_performance.sql', '047_receivables_complete_report.sql', '053_receivable_financial_validation.sql', '054_collection_operational_statuses.sql', '055_receivable_validation_commissions.sql']) await db.exec(await file(name));
 today = await scalar("SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");
 due = await scalar("SELECT ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-45)::text r");
 agent = id(93000);
 await db.query("INSERT INTO public.collection_agents(id,display_name) VALUES($1,'Responsável de estorno sintética')", [agent]);
 await db.query('INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES($1,$2,$3)', [users.collector.id, agent, users.manager.id]);
 importId = await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES('grupo-consolidado','abertos-sinteticos.csv',repeat('7',64),$1,1,1,0,0,0,'OPEN') RETURNING id r", [users.cr.id]);
 titleId = await scalar("INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,reported_in_collection,first_import_id,last_import_id) VALUES('grupo-consolidado','NF-REV-CONSUMER-SYN','NF-REV-CONSUMER-SYN','Cliente de estorno sintético',cf_private.receivable_customer_key('Cliente de estorno sintético',NULL),'4',$1,20000,$2,'PENDING_VALIDATION','PENDING','COBRANCA',$3,true,$4,$4) RETURNING id r", [due, agent, today, importId]);
 await actor('cr'); const title = await current();
 const proof = await scalar("SELECT public.validate_receivable_payment_v2($1,'CONFIRM',$2,19000,'Retenção sintética','Confirmação sintética original',$3,$4) r", [titleId, today, title.revision, randomUUID()]);
 originalReceipt = proof.receipt_id;
 await actor('manager'); await scalar("SELECT public.configure_commission_rule('COLLECTOR','1900-01-01','',$1,'Regra sintética de teste') r", [JSON.stringify({ eligible_collector_ids: [agent] })]);
 await owner();
 const beforeMetadata = new Map();
 for (const signature of [...RECEIVABLE_REVERSAL_CONSUMER_SIGNATURES, 'public.save_commission_assessment(text,date,date,text,text,text)', 'public.commit_receivables_received_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean)']) beforeMetadata.set(signature, await metadata(signature));
 const original = await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipts r WHERE id=$1', [originalReceipt]);
 const installer = await buildReceivableReceiptReversalSql();
 assert((await file('056_receivable_receipt_reversal.sql')).includes(fragment.trim()), '056 must embed the reviewed consumer fragment');
 await db.exec(installer);
 for (const [signature, expected] of beforeMetadata) assert.deepEqual(await metadata(signature), expected, signature);
 assert.deepEqual(await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipts r WHERE id=$1', [originalReceipt]), original);
 console.log('PASS consumer migration preserves signatures, owners, grants, settings and immutable receipt rows'); passed++;

 await test('only bounded active queries change; ledger INSERTs, history IDs and snapshot fences remain explicit', async () => {
  for (const signature of RECEIVABLE_REVERSAL_CONSUMER_SIGNATURES) {
   const body = await definition(signature);
   assert(!/\b(?:FROM|JOIN)\s+public\.receivable_receipts\b/i.test(body), signature);
   assert(body.includes('public.active_receivable_receipts'), signature);
  }
  for (const signature of ['public.validate_receivable_payment(uuid,text,date,text,bigint)', 'public.validate_receivable_payment_v2(uuid,text,date,bigint,text,text,bigint,uuid)', 'public.commit_receivables_received_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean)']) assert((await definition(signature)).includes('INSERT INTO public.receivable_receipts'), signature);
  assert((await definition('public.reverse_receivable_receipt(uuid,text,bigint,uuid)')).includes('FROM public.receivable_receipts WHERE id=p_receipt_id'));
  const assessment = await definition('public.save_commission_assessment(text,date,date,text,text,text)');
  assert(assessment.indexOf('pg_advisory_xact_lock(2045812308)') < assessment.indexOf('LOCK TABLE'));
  assert(assessment.includes('public.receivable_receipt_reversals,cf_private.receivable_active_receipts'));
 });
 await test('fragment is repeatable and optional email remains optional without loosening missing required contracts', async () => {
  await db.exec(fragment); await db.exec('DROP FUNCTION public.prepare_collection_customer_email(uuid)'); await db.exec(fragment);
  await db.exec('DROP FUNCTION cf_private.collection_workflow_collectible(public.receivable_titles)');
  await reject(() => db.exec(fragment), '22023');
 });
 await test('reopened title accepts START, draft save and later title updates without a historical receipt closing its new timer', async () => {
  await reverse(originalReceipt); await actor('collector'); let currentTitle = await current();
  const workbench = await scalar("SELECT public.collection_workbench(p_queue=>'active') r");
  assert(workbench.rows.some(row => row.id === titleId)); assert.equal(workbench.rows.find(row => row.id === titleId).can_start, true);
  await scalar("SELECT public.collection_work_action($1,'START',$2,$3) r", [titleId, currentTitle.revision, randomUUID()]);
  let d = await detail();
  await scalar("SELECT public.save_collection_case($1,'NOTA COM PENDÊNCIA','Rascunho sintético após estorno','Conferir documento',$2,$3,$4,NULL,false,$5) r", [titleId, today, d.title.revision, d.case.revision, randomUUID()]);
  await owner(); await db.query("UPDATE public.receivable_titles SET next_action='RETRY' WHERE id=$1", [titleId]);
  await actor('collector'); d = await detail(); assert.equal(d.timer.running, true); assert.equal(d.title.operational_status, 'NOTA COM PENDÊNCIA');
  assert.equal(await count('public.receivable_receipts'), 1); assert.equal(await count('public.active_receivable_receipts'), 0);
 });
 await test('future net validation records one new active receipt on the same title and excludes the voided amount from commissions', async () => {
  await reverse(originalReceipt); const next = await validateNet(18500);
  assert.notEqual(next.receipt_id, originalReceipt); await owner();
  assert.equal(await count('public.receivable_titles'), 1);
  assert.equal(await count('public.receivable_receipts'), 2); assert.equal(await count('public.active_receivable_receipts'), 1);
  assert.equal(await scalar('SELECT amount_cents r FROM public.effective_receivable_receipts WHERE title_id=$1', [titleId]), 18500);
  await actor('manager'); const actual = await report();
  assert.equal(actual.rows.filter(row => row.title_id === titleId).length, 1);
  assert.equal(actual.rows.find(row => row.title_id === titleId).amount_cents, 18500);
 });
 await test('legacy financial validation can also register a later genuine payment without rewriting the reversed ledger row', async () => {
  await reverse(originalReceipt); await reportPayment(); await actor('cr'); const t = await current();
  const next = await scalar("SELECT public.validate_receivable_payment($1,'CONFIRM',$2,'Pagamento posterior sintético',$3) r", [titleId, today, t.revision]);
  assert.notEqual(next, originalReceipt); await owner(); assert.equal(await count('public.receivable_receipts'), 2); assert.equal(await count('public.active_receivable_receipts'), 1);
  assert.deepEqual(await scalar('SELECT to_jsonb(r) r FROM public.receivable_receipts r WHERE id=$1', [originalReceipt]), original);
 });
 await test('open preview, report retirement, pending commission queue and reappearance use active receipt evidence', async () => {
  await reverse(originalReceipt); await actor('cr');
  const openRow = sourceRow(18500); delete openRow.received_on; delete openRow.received_amount_cents;
  const preview = await scalar("SELECT public.preview_receivables_open_report('grupo-consolidado',$1,true,$2,'{}','{}') r", [JSON.stringify([openRow]), today]);
  assert.equal(preview.can_commit, true); assert.equal(preview.validated_in_source_count, 0); assert.equal(preview.rows[0].title_id, titleId);
  await owner('cr');
  await scalar("SELECT cf_private.record_receivable_report_event($1,'RETIRED_WORKED',$2,$3,$4) r", [titleId, importId, randomUUID(), today]);
  await actor('cr');
  const queue = await scalar("SELECT public.receivable_retired_validation_queue('',NULL,0,25) r"); assert(queue.rows.some(row => row.id === titleId));
  await actor('manager'); const pending = await scalar("SELECT public.pending_collection_commissions('',NULL,0,25) r"); assert(pending.rows.some(row => row.title_id === titleId));
  await owner('cr'); await scalar("SELECT cf_private.record_receivable_report_event($1,'REAPPEARED',$2,$3,$4) r", [titleId, importId, randomUUID(), today]);
  assert.equal((await current()).retired_from_report, false);
 });
 await test('saved assessment remains historical while the current commission basis excludes the reversal', async () => {
  await actor('manager'); const basis = await report();
  const saved = await scalar("SELECT public.save_commission_assessment('COLLECTOR',$1,$1,NULL,NULL,$2) r", [today, basis.revision]);
  const before = await scalar('SELECT public.commission_assessment($1) r', [saved]);
  await reverse(originalReceipt); await actor('manager');
  assert.equal((await report()).rows.length, 0);
  assert.deepEqual(await scalar('SELECT public.commission_assessment($1) r', [saved]), before);
 });
 await test('Quitados after reversal creates a genuine new receipt; replay after its reversal cannot revive the old file', async () => {
  await reverse(originalReceipt); const rows = [sourceRow(18500)], label = 'Quitados sintético para conferir cache após estorno';
  const committed = await commitPaid(rows, label); assert.equal(committed.received_count, 1);
  await owner(); const paid = await scalar('SELECT id r FROM public.active_receivable_receipts WHERE title_id=$1', [titleId]);
  assert.notEqual(paid, originalReceipt); assert.equal(await count('public.receivable_receipts'), 2);
  await reverse(paid);
  await reject(() => commitPaid(rows, label), 'P0024');
  await owner(); assert.equal(await count('public.receivable_receipts'), 2); assert.equal(await count('public.active_receivable_receipts'), 0);
  await validateNet(18500); await owner(); const before = await count('public.receivable_receipts');
  const replay = await commitPaid(rows, label); assert.equal(replay.idempotent, true);
  await owner(); assert.equal(await count('public.receivable_receipts'), before);
  const replacement = await scalar('SELECT id r FROM public.active_receivable_receipts WHERE title_id=$1', [titleId]);
  await reverse(replacement); await validateNet(18499);
  await reject(() => commitPaid(rows, label), 'P0024');
  await owner(); assert.equal(await count('public.active_receivable_receipts'), 1);
  assert.equal(await scalar('SELECT amount_cents r FROM public.effective_receivable_receipts WHERE title_id=$1', [titleId]), 18499);
 });
 console.log(passed + ' receivable reversal consumer SQL checks passed.');
} catch (error) {
 console.error('FAIL', error.message, error.code ?? '', error.where ?? '', error.stack); process.exitCode = 1;
} finally { await db.close(); }
