import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildReceivableReturnApprovalSql } from './bundle-receivable-return-approval.mjs';
import { buildReceivableImportCompletionSql } from './bundle-receivable-import-completion.mjs';
import { validOpenReportCommit } from '../supabase/functions/receivables-import/open-report-contract.mjs';
import { validOpenReportStatus } from '../supabase/functions/receivables-import/open-report-status.mjs';

// Disposable PostgreSQL only. Every customer, title, report and payment is synthetic.
// A status lookup is deliberately distinct from an import retry: UNCONFIRMED
// cannot establish whether another transaction is still processing the request.
const f = await createCostFixture(), { db, users, owner, actor, scalar, file, snapshot } = f;
const scope = 'grupo-consolidado', failures = [];
let passed = 0, seq = 620000, today, agent, importId;
const add = (day, days) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const source = t => ({ document: t.document, client_name: t.client_name, client_document: t.client_document, branch: t.branch, issued_on: t.issued_on, due_date: t.due_date, amount_cents: t.amount_cents });
async function current(t) { await owner(); return scalar('SELECT to_jsonb(t) r FROM public.receivable_titles t WHERE id=$1', [t.id]); }
async function title(options = {}) {
  await owner(); const n = ++seq, o = { amount: 20000, due: add(today, -80), collector: agent, status: 'OPEN', ...options };
  return scalar(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,reported_in_collection,first_import_id,last_import_id)
  VALUES($1,$2,$2,$3,cf_private.receivable_customer_key($3,NULL),'4',$4,$5,$6,$7,CASE WHEN $7='PENDING_VALIDATION' THEN 'PENDING' ELSE 'NONE' END,CASE WHEN $7='PENDING_VALIDATION' THEN 'COBRANCA' END,CASE WHEN $7='PENDING_VALIDATION' THEN $8::date END,$7='PENDING_VALIDATION',$9,$9)
  RETURNING to_jsonb(receivable_titles) r`, [scope, `COMPLETE-SYN-${n}`, `Cliente sintético conclusão ${n}`, o.due, o.amount, o.collector, o.status, today, importId]);
}
async function preview(rows, options = {}) {
  return scalar('SELECT public.preview_receivables_open_report($1,$2::jsonb,$3,$4,$5::jsonb,$6::jsonb) r', [scope, JSON.stringify(rows), options.full ?? false, options.date ?? today, JSON.stringify(options.titles ?? {}), JSON.stringify(options.collectors ?? {})]);
}
async function frozen(rows, options = {}) {
  const bytes = Buffer.from(options.bytes ?? `Conteúdo original sintético ${++seq}`), p = await preview(rows, options);
  return { rows, p, bytes, hash: createHash('sha256').update(bytes).digest('hex'), name: 'conclusao-sintetica.csv', request: randomUUID(), full: options.full ?? false, date: options.date ?? today, titles: options.titles ?? {}, collectors: options.collectors ?? {}, ...options };
}
async function commit(r, user = 'manager', session = users[user].session) {
  await owner(); await db.exec('SET ROLE service_role');
  const result = await scalar('SELECT public.commit_receivables_open_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,$13,$14) r', [users[user].id, session, scope, r.name, r.hash, r.bytes.toString('base64'), JSON.stringify(r.rows), JSON.stringify(r.titles), r.p.previous_import_id, r.p.financial_revision, JSON.stringify(r.collectors), r.full, r.date, r.request]);
  await actor(user); return result;
}
async function status(r, extra = {}) {
  return scalar('SELECT public.receivable_open_report_request_status($1,$2,$3,$4,$5,$6) r', [extra.request ?? r.request, extra.scope ?? scope, extra.hash ?? r.hash, extra.full ?? r.full, extra.date ?? r.date, extra.count ?? r.rows.length]);
}
function assertStatus(p, r, expected = 'COMPLETED') {
  assert.equal(validOpenReportStatus(p, { requestId: r.request, fileSha256: r.hash, fullReport: r.full, referenceDate: r.date, rowCount: r.rows.length }), true, 'Actual SQL must satisfy the production gateway and browser status proof: ' + JSON.stringify(p));
  assert.equal(p.format_version, 'receivables-open-report-status-v1'); assert.equal(p.status, expected);
  assert.equal(p.request_id, r.request); assert.equal(p.source_sha256, r.hash); assert.equal(p.full_report, r.full); assert.equal(p.reference_date, r.date); assert.equal(p.row_count, r.rows.length);
  if (expected === 'COMPLETED') { assert.equal(p.result.request_id, r.request); assert.equal(p.result.row_count, r.rows.length); assert.equal(p.result.idempotent, true); assert(validOpenReportCommit(p.result, { requestId: r.request, fullReport: r.full, referenceDate: r.date, rowCount: r.rows.length })); }
  else assert.equal(p.result, null);
}
async function rejects(run, code = '42501') {
  await db.exec('SAVEPOINT expected_failure');
  try { await assert.rejects(run, e => { assert.equal(e.code, code, e.message); return true; }); }
  finally { await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure'); await actor(); }
}
async function test(name, run) {
  await owner(); await db.exec('BEGIN'); await actor();
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { failures.push({ name, error }); console.error('FAIL', name, error.message, error.code ?? '', error.where ?? ''); }
  finally { await db.exec('ROLLBACK'); await actor(); }
}
async function paid(amount = 12345) {
  let t = await title({ amount, status: 'PENDING_VALIDATION' }); await actor();
  await scalar('SELECT public.validate_receivable_payment_v2($1,$2,$3,$4,NULL,$5,$6,$7) r', [t.id, 'CONFIRM', today, t.amount_cents, 'Recebimento real sintético preservado', t.revision, randomUUID()]);
  return current(t);
}
async function collectorParityCases() {
  await owner(); const agent2 = randomUUID(), inactive = randomUUID();
  await db.query('INSERT INTO public.collection_agents(id,display_name,enabled) VALUES($1,$2,true),($3,$4,false)', [agent2, 'Segunda cobradora sintética', inactive, 'Cobradora sintética inativa']);
  const incoming = (t, extra = {}) => ({ ...source(t), customer_key: t.customer_key, title_id: t.id, outcome: 'MATCHED', ...extra });
  const cases = [], addCase = (name, rows, mappings = {}) => cases.push({ name, preview: { rows }, mappings });
  const fresh = { ...source(await title()), client_name: `Cliente novo de paridade ${++seq}` }; const freshKey = await scalar('SELECT cf_private.receivable_customer_key($1,NULL) r', [fresh.client_name]); const newRow = { ...fresh, customer_key: freshKey, title_id: null, outcome: 'NEW' };
  addCase('new customer has no inferred collector', [newRow]); addCase('new customer explicitly assigned', [newRow], { [freshKey]: agent });
  addCase('inactive selected collector', [newRow], { [freshKey]: inactive }); addCase('unknown selected collector', [newRow], { [freshKey]: randomUUID() }); addCase('unknown mapped customer', [newRow], { 'name:CLIENTE AUSENTE': agent });
  const owned = await title(); addCase('active existing owner', [incoming(owned)]); addCase('same existing owner selected', [incoming(owned)], { [owned.customer_key]: agent }); addCase('redistribution rejected', [incoming(owned)], { [owned.customer_key]: agent2 });
  const locked = await title({ collector: null }); await db.query('UPDATE public.receivable_titles SET collector_locked=true WHERE id=$1', [locked.id]); addCase('locked null owner', [incoming(locked)]);
  const conflictFirst = await title(), conflict = await title({ collector: agent2 }); await db.query('UPDATE public.receivable_titles SET client_name=$2,customer_key=$3 WHERE id=$1', [conflict.id, conflictFirst.client_name, conflictFirst.customer_key]); addCase('two existing owners', [incoming(conflictFirst), incoming({ ...conflict, client_name: conflictFirst.client_name, customer_key: conflictFirst.customer_key })]);
  const off = await title({ collector: inactive }); addCase('inactive existing owner', [incoming(off)]);
  const retired = await title(); const rq = randomUUID(); await db.query("INSERT INTO cf_private.receivable_open_report_requests(request_id,actor_id,payload_hash,source_import_id,full_report,reference_date,result) VALUES($1,$2,repeat('b',64),$3,true,$4,'{}')", [rq, users.manager.id, importId, today]); await scalar('SELECT cf_private.record_receivable_report_event($1,$2,$3,$4,$5) r', [retired.id, 'RETIRED_UNWORKED', importId, rq, today]);
  addCase('retired title present keeps original owner', [incoming(retired)]); addCase('retired absent title does not own another new parcel', [incoming(retired, { document: `NEW-PARCEL-${++seq}`, due_date: add(today, 15), title_id: null, outcome: 'NEW' })]);
  const activeReceipt = await paid(8383); await owner(); addCase('active receipt is not assignable', [incoming(activeReceipt)]); addCase('active receipt selected owner rejected', [incoming(activeReceipt)], { [activeReceipt.customer_key]: agent });
  const reversed = await paid(8484); await actor(); const rev = await scalar('SELECT to_jsonb(r) r FROM public.effective_receivable_receipts r WHERE title_id=$1', [reversed.id]); await scalar('SELECT public.reverse_receivable_receipt($1,$2,$3,$4) r', [rev.id, 'Correção sintética de paridade', reversed.revision, randomUUID()]); const reversedNow = await current(reversed); addCase('reversed receipt title is assignable again', [incoming(reversedNow)]);
  const multibranch = await title(); addCase('same customer across multiple rows and branches', [incoming(multibranch), incoming(multibranch, { title_id: null, outcome: 'NEW', branch: '6', document: `NEW-BRANCH-${++seq}` })]);
  async function run(item) {
    await owner(); await db.exec('SAVEPOINT plan_comparison');
    try { return { result: await scalar('SELECT cf_private.receivable_import_collector_plan($1::jsonb,$2::jsonb) r', [JSON.stringify(item.preview), JSON.stringify(item.mappings)]) }; }
    catch (e) { return { error: e.code }; }
    finally { await db.exec('ROLLBACK TO SAVEPOINT plan_comparison; RELEASE SAVEPOINT plan_comparison'); }
  }
  for (const c of cases) c.expected = await run(c);
  return { cases, run };
}
async function approve(item) {
  return scalar('SELECT public.approve_receivable_report_return($1,$2,$3,$4,$5::jsonb,$6,$7) r', [item.title_id, item.expected_revision, item.receipt_id, item.receipt_fingerprint, JSON.stringify(item.source_row), 'Retorno sintético conferido, preservando histórico', randomUUID()]);
}
try {
  await owner(); for (const name of ['040_collection_email_draft.sql', '041_receivable_import_performance.sql', '047_receivables_complete_report.sql']) await db.exec(await file(name));
  today = await scalar("SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text r");
  agent = randomUUID(); await db.query('INSERT INTO public.collection_agents(id,display_name) VALUES($1,$2)', [agent, 'Cobradora sintética conclusão']);
  importId = await scalar("INSERT INTO public.receivable_imports(scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode) VALUES($1,'base-conclusao-sintetica.csv',repeat('c',64),$2,1,1,0,0,0,'OPEN') RETURNING id r", [scope, users.manager.id]);
  const legacy047Title = await title(); await actor(); const legacy047 = await frozen([source(legacy047Title)]), old047 = await commit(legacy047); assert.equal(old047.return_approval_version, undefined);
  await owner(); await db.exec(await buildReceivableReturnApprovalSql());
  const legacy057Title = await title(); await actor(); const legacy057 = await frozen([source(legacy057Title)]), old057 = await commit(legacy057); assert.equal(old057.return_approval_version, '057');
  await owner(); for (const name of ['042_payable_administrative_writeoff.sql', '043_payable_import_reconciliation.sql', '050_paid_bank_rules.sql', '058_payable_daily_reports.sql', '059_payable_column_rules.sql', '060_payable_unified_report.sql', '061_payable_report_status.sql']) await db.exec(await file(name));
  await owner(); await db.exec('BEGIN'); const parity = await collectorParityCases(); await db.exec('COMMIT');
  const installer = await buildReceivableImportCompletionSql(), beforeInstall = await snapshot(); await db.exec(installer); const afterInstall = await snapshot();
  for (const s of [beforeInstall, afterInstall]) delete s['public.central_schema_migrations'];
  assert.deepEqual(afterInstall, beforeInstall); await db.exec(installer); assert.deepEqual(await snapshot().then(s => { delete s['public.central_schema_migrations']; return s; }), beforeInstall);
  assert.equal(await readFile(new URL('../supabase/dashboard/ativar-confirmacao-importacao-recebiveis.sql', import.meta.url), 'utf8'), installer);
  passed++; console.log('PASS full activation is byte exact, repeatable, and changes no financial, source or protocol data');

  await test('optimized collector planning preserves every legacy ownership and eligibility decision', async () => {
    for (const item of parity.cases) assert.deepEqual(await parity.run(item), item.expected, item.name);
  });
  await test('legacy047 and057 completed protocols are discovered without replaying the original mutation', async () => {
    const before = await snapshot(); await actor(); assertStatus(await status(legacy047), legacy047); assertStatus(await status(legacy057), legacy057); assert.deepEqual(await snapshot(), before);
  });
  await test('an unknown UUID remains unconfirmed with no financial, audit, revision or protocol side effects', async () => {
    const unknown = { ...legacy057, request: randomUUID() }, before = await snapshot(); await actor(); assertStatus(await status(unknown), unknown, 'UNCONFIRMED'); assert.deepEqual(await snapshot(), before);
  });
  await test('a manager cannot discover another actor completed request, even with its exact file proof', async () => {
    const before = await snapshot(); await actor('manager2'); assertStatus(await status(legacy057), legacy057, 'UNCONFIRMED'); assert.deepEqual(await snapshot(), before);
  });
  await test('an authorized CR operator can consult only its own completed protocol', async () => {
    await actor('cr'); const r = await frozen(legacy057.rows, { bytes: legacy057.bytes }); const result = await commit(r, 'cr');
    await owner(); assert.equal(await scalar('SELECT created_by::text r FROM public.receivable_imports WHERE id=$1', [result.import_id]), users.manager.id, 'A cached source artifact can belong to the original importing manager');
    const before = await snapshot();
    await actor('cr'); assertStatus(await status(r), r); assert.deepEqual(await snapshot(), before); await actor('manager'); assertStatus(await status(r), r, 'UNCONFIRMED');
  });
  await test('completed protocol metadata must bind the exact preserved file, report scope, date and count', async () => {
    for (const change of [{ hash: 'a'.repeat(64) }, { full: !legacy057.full }, { date: add(today, -1) }, { count: legacy057.rows.length + 1 }, { scope: 'outra-origem' }]) {
      await actor(); const before = await snapshot(); await actor(); await rejects(() => status(legacy057, change), '22023'); assert.deepEqual(await snapshot(), before);
    }
  });
  await test('invalid input shapes and unsafe report metadata cannot query completion status', async () => {
    for (const args of [[null, scope, legacy057.hash, false, today, 1], [randomUUID(), scope, 'not-a-hash', false, today, 1], [randomUUID(), scope, legacy057.hash, null, today, 1], [randomUUID(), scope, legacy057.hash, false, null, 1], [randomUUID(), scope, legacy057.hash, false, today, 0], [randomUUID(), scope, legacy057.hash, false, today, 5001]]) await rejects(() => scalar('SELECT public.receivable_open_report_request_status($1,$2,$3,$4,$5,$6) r', args), '22023');
  });
  await test('read-only roles and users without CR import permission cannot query recorded outcomes', async () => {
    for (const user of ['director', 'cp', 'rh', 'collector']) { await actor(user); await rejects(() => status(legacy057)); }
    await actor('manager', randomUUID()); await rejects(() => status(legacy057));
    await owner(); await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1', [users.manager.id]); await actor(); await rejects(() => status(legacy057));
  });
  await test('status is authenticated-only and private protocol history remains inaccessible to API roles', async () => {
    await owner(); for (const role of ['anon', 'service_role']) { await db.exec(`SET ROLE ${role}`); await rejects(() => status(legacy057)); await owner(); }
    await actor(); await rejects(() => db.exec('SELECT * FROM cf_private.receivable_open_report_requests'));
  });
  await test('API roles cannot bypass validation by invoking the private optimized apply helper', async () => {
    await owner();
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_function_privilege($1,'cf_private.apply_receivables_open_preview_062(text,text,text,text,jsonb)','EXECUTE') r", [role]), false);
    assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.commit_receivables_open_report_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb,boolean,date,uuid)','EXECUTE') r"), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role','public.commit_receivables_open_report_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb,boolean,date,uuid)','EXECUTE') r"), true);
  });
  await test('status uses an indexed read with no financial advisory locks', async () => {
    await actor(); const before = await scalar("SELECT count(*)::int r FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()");
    const start = performance.now(); assertStatus(await status(legacy057), legacy057); const elapsed = performance.now() - start;
    assert.equal(await scalar("SELECT count(*)::int r FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()"), before); assert(elapsed < 1000, `Status lookup took ${elapsed.toFixed(0)}ms`);
  });
  await test('completion lookup never invokes the write-actor helper used by blocking import retries', async () => {
    await owner(); await db.exec("CREATE OR REPLACE FUNCTION cf_private.set_receivable_sync_actor(p_user_id uuid,p_session_id text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$BEGIN RAISE EXCEPTION 'The write actor is unavailable in this synthetic status-only test' USING ERRCODE='22023';END$$");
    const before = await snapshot(); await actor(); assertStatus(await status(legacy047), legacy047); assertStatus(await status(legacy057), legacy057); assert.deepEqual(await snapshot(), before);
  });
  await test('an exact frozen retry returns the existing completion even after subsequent financial revisions', async () => {
    const t = await title(); await actor(); const r = await frozen([source(t)]), result = await commit(r), state = await snapshot();
    await actor(); const repeated = await commit(r); assert.equal(repeated.import_id, result.import_id); assert.equal(repeated.idempotent, true); assert.deepEqual(await snapshot(), state);
    const unrelated = await title({ amount: 9876 }); await actor(); const prior = await snapshot(); await actor(); assertStatus(await status(r), r); assert.deepEqual(await snapshot(), prior); assert.equal((await current(unrelated)).amount_cents, 9876);
  });
  await test('changing a frozen request under the same UUID is rejected atomically', async () => {
    const t = await title(); await actor(); const r = await frozen([source(t)]); await commit(r); const before = await snapshot();
    await actor(); await rejects(() => commit({ ...r, rows: [{ ...r.rows[0], amount_cents: t.amount_cents + 1 }] }), '23505'); assert.deepEqual(await snapshot(), before);
  });
  await test('a stale financial revision blocks new writes while status remains a read of the original outcome', async () => {
    const t = await title(); await actor(); const r = await frozen([source(t)]); await title({ amount: 9876 }); const before = await snapshot();
    await actor(); await rejects(() => commit(r), '40001'); assert.deepEqual(await snapshot(), before); await actor(); assertStatus(await status(r), r, 'UNCONFIRMED');
  });
  await test('new titles and source amount or maturity updates preserve identity, owner, and exact original bytes', async () => {
    const t = await title(); await actor(); const newRow = { ...source(t), document: `NOVO-${++seq}`, client_name: t.client_name, amount_cents: 7777 };
    const updated = { ...source(t), amount_cents: 21005, due_date: add(today, 15), issued_on: add(today, -3) }, r = await frozen([updated, newRow], { titles: { '1': t.id } }); assert.equal(r.p.can_commit, true); const result = await commit(r);
    assert.equal(result.new_count, 1); assert.equal(result.changed_count, 1); const after = await current(t); assert.equal(after.amount_cents, 21005); assert.equal(after.due_date, updated.due_date); assert.equal(after.collector_id, t.collector_id); assert.equal(after.id, t.id); assert(after.revision > t.revision);
    assert.equal(await scalar("SELECT count(*)::int r FROM public.audit_events WHERE module='contas_receber' AND entity='receivable_titles' AND record_id=$1 AND action='UPDATE' AND before_value->>'amount_cents'=$2 AND after_value->>'amount_cents'='21005' AND after_value->>'due_date'=$3", [t.id, String(t.amount_cents), updated.due_date]), 1);
    assert.equal(await scalar("SELECT encode(file_bytes,'base64') r FROM cf_private.receivable_import_files WHERE import_id=$1", [result.import_id]), r.bytes.toString('base64')); await actor(); assertStatus(await status(r), r);
  });
  await test('full report retirement removes worked and unworked absences without inventing receipts or commissions', async () => {
    const keep = await title(), unworked = await title(), worked = await title(); await owner();
    await db.query("INSERT INTO public.receivable_collection_events(title_id,collector_id,action,observation,created_by) VALUES($1,$2,'CONTACT','Contato sintético anterior à retirada',$3)", [worked.id, agent, users.collector.id]);
    await actor(); const receiptBefore = await scalar('SELECT count(*)::int r FROM public.receivable_receipts'), r = await frozen([source(keep)], { full: true }); assert(r.p.retired_count >= 2); await commit(r);
    assert.equal((await current(keep)).retired_from_report, false); assert.equal((await current(unworked)).retired_from_report, true); assert.equal((await current(worked)).retired_from_report, true); assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipts'), receiptBefore);
    assert.equal(await scalar("SELECT count(*)::int r FROM public.receivable_report_retirement_events WHERE title_id=$1 AND action='RETIRED_WORKED'", [worked.id]), 1); assert.equal(await scalar("SELECT count(*)::int r FROM public.receivable_report_retirement_events WHERE title_id=$1 AND action='RETIRED_UNWORKED'", [unworked.id]), 1);
  });
  await test('an already validated title still blocks the full import until individual approval, with real receipt preserved', async () => {
    const t = await paid(); await actor(); const r = await frozen([source(t)], { full: true }); assert.equal(r.p.return_unapproved_count, 1); const before = await snapshot();
    await actor(); await rejects(() => commit(r), 'P0047'); assert.deepEqual(await snapshot(), before); assert.equal((await current(t)).status, 'VALIDATED');
  });
  await test('approved return and receipt reversal remain one atomic operation and a readonly status cannot repeat them', async () => {
    const t = await paid(14141); await actor(); let p = await preview([source(t)]); await approve(p.return_items[0]); const r = await frozen([source(t)]), result = await commit(r); assert.equal(result.returned_count, 1);
    const restored = await current(t); assert.equal(restored.status, 'OPEN'); assert.equal(restored.retired_from_report, false); assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipt_reversals WHERE title_id=$1', [t.id]), 1);
    const before = await snapshot(); await actor(); assertStatus(await status(r), r); await commit(r); assert.deepEqual(await snapshot(), before); assert.equal(await scalar('SELECT count(*)::int r FROM public.receivable_receipts WHERE title_id=$1', [t.id]), 1);
  });
  await test('a late audit failure rolls back source updates, retirement, immutable bytes and the completion record together', async () => {
    const keep = await title(), missing = await title(); await actor(); const r = await frozen([{ ...source(keep), amount_cents: 29999 }], { full: true }); await owner();
    await db.exec("CREATE FUNCTION cf_private.synthetic_completion_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='receivable_report_retirement_events' THEN RAISE EXCEPTION 'Falha sintética de auditoria' USING ERRCODE='22023';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_completion_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_completion_failure()");
    const before = await snapshot(); await actor(); await rejects(() => commit(r), '22023'); assert.deepEqual(await snapshot(), before); assert.equal((await current(missing)).retired_from_report, false);
  });
  await test('complete import and confirmation leave CP061, bank balances, users and every other module byte exact', async () => {
    const t = await title(), before = await snapshot(); await actor(); const r = await frozen([{ ...source(t), amount_cents: t.amount_cents + 1 }]); await commit(r); assertStatus(await status(r), r); const after = await snapshot();
    const allowed = /^(public\.(receivable_|audit_events)|cf_private\.(receivable_|receivables_sync_state|collection_context_state|collection_workbench_state))/;
    for (const [name, rows] of Object.entries(before)) if (!allowed.test(name)) assert.deepEqual(after[name], rows, name);
  });
  await test('1,200 title daily commits handle updates, new customers and absences inside the normal request budget', async () => {
    await owner(); const prefix = `PERF062-${++seq}-`;
    await db.query(`INSERT INTO public.receivable_titles(scope,source_key,document,client_name,customer_key,branch,due_date,amount_cents,collector_id,status,validation_status,first_import_id,last_import_id)
    SELECT $1,$2||n,$2||n,'Cliente conclusão desempenho '||n,cf_private.receivable_customer_key('Cliente conclusão desempenho '||n,NULL),'4',$3,10000,$4,'OPEN','NONE',$5,$5 FROM generate_series(1,1200)n`, [scope, prefix, add(today, -10), agent, importId]);
    const original = (await db.query('SELECT document,client_name,client_document,branch,issued_on::text,due_date::text,amount_cents FROM public.receivable_titles WHERE document LIKE $1 ORDER BY document', [prefix + '%'])).rows;
    await db.exec('ANALYZE public.receivable_titles; ANALYZE public.receivable_receipts'); await actor(); const first = await frozen(original, { full: true }); let start = performance.now(); const firstResult = await commit(first); const initialMs = performance.now() - start;
    await owner(); assert.equal(await scalar("SELECT count(DISTINCT record_id)::int r FROM public.audit_events WHERE module='contas_receber' AND entity='receivable_titles' AND action='UPDATE' AND after_value->>'document' LIKE $1 AND after_value->>'last_import_id'=$2", [prefix + '%', firstResult.import_id]), 1200);
    const nextRows = original.slice(0, 1000).map((r, i) => i < 150 ? { ...r, amount_cents: 10001, due_date: add(today, 10) } : r);
    for (let i = 0; i < 100; i++) nextRows.push({ ...original[0], document: `${prefix}NEW-${i}`, amount_cents: 20000 });
    await owner(); const identities = Object.fromEntries((await db.query('SELECT document,id FROM public.receivable_titles WHERE document LIKE $1', [prefix + '%'])).rows.map(t => [t.document, t.id]));
    const titles = Object.fromEntries(nextRows.slice(0, 150).map((r, i) => [String(i + 1), identities[r.document]]));
    await actor(); const next = await frozen(nextRows, { full: true, titles }); assert.equal(next.p.new_count, 100); assert.equal(next.p.changed_count, 150); assert.equal(next.p.retired_count, 200); start = performance.now(); const result = await commit(next); const dailyMs = performance.now() - start;
    assert.equal(result.row_count, 1100); assert.equal(result.new_count, 100); assert.equal(result.retired_count, 200); assert(initialMs < 8000, `Initial commit ${initialMs.toFixed(0)}ms`); assert(dailyMs < 8000, `Daily commit ${dailyMs.toFixed(0)}ms`); assertStatus(await status(next), next);
    await owner(); assert.equal(await scalar("SELECT count(DISTINCT record_id)::int r FROM public.audit_events WHERE module='contas_receber' AND entity='receivable_titles' AND action='UPDATE' AND after_value->>'document' LIKE $1 AND after_value->>'last_import_id'=$2 AND coalesce(after_value->>'retired_from_report','false')='false' AND after_value->>'first_import_id'<>$2", [prefix + '%', result.import_id]), 1000);
    await actor(); assert.notEqual((await scalar('SELECT public.get_receivables_sync_revision() r')).financial_revision, next.p.financial_revision);
    console.log(`PERF 062 full commits: first=${initialMs.toFixed(0)}ms, updated daily=${dailyMs.toFixed(0)}ms`);
  });
  if (failures.length) { process.exitCode = 1; for (const { name, error } of failures) console.error(name, error.stack); }
  console.log(`${passed} passed, ${failures.length} failed (receivable import completion062, synthetic local PostgreSQL)`);
} catch (error) { console.error('FAIL', error.message, error.code ?? '', error.where ?? '', error.stack); process.exitCode = 1; }
finally { await db.close(); }
