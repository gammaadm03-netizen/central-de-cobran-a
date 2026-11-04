import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createCostFixture } from './lib/product-cost-sql-fixture.mjs';
import { buildPayableOpenStatusSql } from './bundle-payable-open-status.mjs';
import { buildPayableReportContentsSql } from './bundle-payable-report-contents.mjs';
import { validContentsPreview, validContentsCommit } from '../supabase/functions/payables-import/report-contents-reconciliation.mjs';

// Disposable PostgreSQL only. Files, titles, accounts and people are synthetic.
// Bundle the browser's actual guards; importing them never opens a network connection.
const uiBundle = await build({ entryPoints: [new URL('../src/lib/payable-report-contents.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' }, loader: { '.css': 'empty' } });
const uiModule = { exports: {} };
new Function('require', 'module', 'exports', uiBundle.outputFiles[0].text)(createRequire(import.meta.url), uiModule, uiModule.exports);
const { validContentsCanonical, validContentsResult } = uiModule.exports;
const syntheticHash = 'f'.repeat(64);
const f = await createCostFixture(), { db, users, owner, actor, scalar, file, snapshot } = f;
const scope = 'grupo-consolidado', plan = 'COMPRA DE MERCADORIA', branch = 'FILIAL CONTEUDO SINTETICA';
const mappings = { [plan]: 'COMPRA DE MERCADORIA' };
const failures = [];
let passed = 0, sequence = 0, today, yesterday, tomorrow, bank, bankLabel;
let originalSource, badSource, seedRows, seedPaidRows, legacyBad, beforeInstall;
const original = (content = `Arquivo sintético de conteúdo ${++sequence}`) => {
  const bytes = Buffer.from(content);
  return { name: `conteudo-${++sequence}.csv`, hash: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
};
const row = (entry_number, amount_cents = 10000, extra = {}) => ({ entry_number, amount_cents, branch,
  description: `Fornecedor sintético ${entry_number}`, due_date: yesterday, issued_on: yesterday,
  source_status: '', plan, bank_account: bankLabel, ...extra });
const title = entry => scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1 AND branch=$2', [entry, branch]);
const currentHead = async () => {
  await owner();
  try { return await scalar("SELECT to_jsonb(d) r FROM cf_private.payable_daily_reports d WHERE report_kind='ALL' ORDER BY created_at DESC,id DESC LIMIT 1"); }
  finally { await actor(); }
};
const all = table => scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') r FROM ${table} t`);
async function financialState() {
  await owner(); const out = {};
  for (const name of ['public.payable_payments','public.payable_payment_reversals','public.bank_balance_positions']) out[name] = await all(name);
  await actor(); return out;
}
async function state() { const value = await snapshot(); await actor(); return value; }
async function test(name, run) {
  await owner(); await db.exec('BEGIN'); await actor();
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { failures.push({ name, error }); console.error('FAIL', name, error.message, error.code ?? '', error.where ?? ''); }
  finally { await db.exec('ROLLBACK'); await actor(); }
}
async function rejects(run, code) {
  await db.exec('SAVEPOINT expected_failure');
  try { await assert.rejects(run, error => { if (code) assert.equal(error.code, code, error.message); return true; }); }
  finally { await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure'); await actor(); }
}
async function preview(sourceRows, { contents = 'FULL_OPEN', map, choices = {}, empty = false, rounding = [], confirm = false } = {}) {
  map ??= contents === 'FULL_OPEN' && sourceRows.length ? mappings : {};
  const p = await scalar('SELECT public.preview_payables_status_contents_report($1,$2::jsonb,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9) r',
    [scope, JSON.stringify(sourceRows), 'ALL', contents, JSON.stringify(map), JSON.stringify(choices), empty, JSON.stringify(rounding), confirm]);
  assert.equal(validContentsPreview(p, { sourceRows, resolutionChoices: choices, roundingAdjustments: rounding,
    reportContents: contents, emptyReportConfirmed: empty, confirmLargeReduction: confirm }), true,
  'Actual SQL preview must satisfy the production gateway proof: ' + JSON.stringify(p));
  assert.equal(validContentsCanonical({ rows: sourceRows, preview: p, file_sha256: syntheticHash }, syntheticHash, contents, empty, rounding, confirm), true,
    'Actual SQL preview must satisfy the production browser proof: ' + JSON.stringify(p));
  return p;
}
async function freeze(sourceRows, options = {}) {
  const contents = options.contents ?? 'FULL_OPEN';
  const config = { contents, map: contents === 'FULL_OPEN' && sourceRows.length ? mappings : {}, choices: {}, empty: false, rounding: [], confirm: false, ...options };
  return { ...config, rows: sourceRows, preview: await preview(sourceRows, config), original: options.original ?? original(), request: randomUUID() };
}
async function commit(request, user = 'manager', session = users[user].session) {
  const p = request.preview, o = request.original;
  let completed = false;
  await owner(); await db.exec('SET ROLE service_role');
  try {
    const result = await scalar('SELECT public.commit_payables_status_contents_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14::date,$15,$16,$17::jsonb,$18) r',
      [users[user].id, session, scope, o.name, o.hash, o.base64, JSON.stringify(request.rows), 'ALL', request.contents,
        JSON.stringify(request.map), JSON.stringify(request.choices), p.previous_import_id, p.financial_revision, p.report_date,
        request.request, request.empty, JSON.stringify(request.rounding), request.confirm]);
    const body = { action: 'commit', mode: 'open_status', status_report_version: '065', report_kind: 'ALL',
      report_contents: request.contents, file_name: o.name, file_base64: o.base64, mappings: request.map,
      resolution_choices: request.choices, complete: true, previous_import_id: p.previous_import_id,
      previous_financial_revision: p.financial_revision, expected_report_date: p.report_date, request_id: request.request,
      confirm_large_reduction: request.confirm, ...(request.empty ? { empty_report_confirmed: true } : {}) };
    assert.equal(validContentsCommit(result, { sourceRows: request.rows, request: body, roundingAdjustments: request.rounding }), true,
      'Actual SQL commit must satisfy the production gateway proof: ' + JSON.stringify(result));
    assert.equal(validContentsResult(result, body, request.rows.length, request.rounding), true,
      'Actual SQL commit must satisfy the production browser proof: ' + JSON.stringify(result));
    completed = true;
    return result;
  } finally { if (completed) await actor(); }
}
async function baseline(sourceRows) {
  const request = await freeze(sourceRows, { confirm: true });
  assert.equal(request.preview.can_commit, true, JSON.stringify(request.preview.errors));
  return commit(request);
}
async function legacyPreview(sourceRows) {
  return scalar('SELECT public.preview_payables_open_status_report($1,$2::jsonb,$3,$4::jsonb) r', [scope, JSON.stringify(sourceRows), 'ALL', JSON.stringify(mappings)]);
}
async function legacyCommit(sourceRows, source) {
  const p = await legacyPreview(sourceRows);
  await owner(); await db.exec('SET ROLE service_role');
  try {
    return await scalar('SELECT public.commit_payables_open_status_report_from_gateway($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13::date,$14) r',
      [users.manager.id, users.manager.session, scope, source.name, source.hash, source.base64, JSON.stringify(sourceRows), 'ALL', JSON.stringify(mappings), '{}', p.previous_import_id, p.financial_revision, p.report_date, randomUUID()]);
  } finally { await actor(); }
}
async function actualPayment(t) {
  return scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r',
    [t.id, t.payment_remaining_cents, yesterday, bank, 'Comprovante financeiro sintético verdadeiro', t.payment_revision, randomUUID(), t.last_import_id]);
}
const date = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

try {
  ({ today, yesterday, tomorrow } = (await db.query("SELECT d::text today,(d-1)::text yesterday,(d+1)::text tomorrow FROM(SELECT(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date d)s")).rows[0]);
  const account = (await db.query("SELECT id,display_name FROM public.bank_accounts WHERE enabled AND account_type='BANK' ORDER BY id LIMIT 1")).rows[0];
  bank = account.id; bankLabel = account.display_name;
  await owner(); await db.exec(await buildPayableOpenStatusSql()); await actor();
  await test('a paid-status file cannot establish a missing global open baseline', async () => {
    await owner(); await db.exec((await file('065_payable_report_contents.sql')).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')); await actor();
    const p = await preview([row('SEM-BASE')], { contents: 'PAID_STATUS' });
    assert.equal(p.can_commit, false); assert.equal(p.status_actions.length, 0); assert(p.errors.length > 0);
    assert.equal(await currentHead(), undefined);
  });
  seedRows = Array.from({ length: 30 }, (_, index) => row(`ANTERIOR-${index + 1}`, 10000 + index));
  seedPaidRows = seedRows.slice(0, 2); originalSource = original(); badSource = original();
  await legacyCommit(seedRows, originalSource);
  await actualPayment(await title('ANTERIOR-30'));
  legacyBad = await legacyCommit(seedPaidRows, badSource);
  assert.equal(legacyBad.marked_paid_count, 28);
  beforeInstall = await state();
  await owner(); await db.exec(await file('065_payable_report_contents.sql')); await actor();

  await test('activation preserves every source, financial record and existing operational event', async () => {
    const before = structuredClone(beforeInstall), after = await state();
    delete before['public.central_schema_migrations']; delete after['public.central_schema_migrations'];
    assert.deepEqual(after, before);
    const cap = await scalar('SELECT public.payables_import_capabilities() r');
    assert.equal(cap.status_report_version, '065');
    const installed = await state();
    await owner(); const source = (await file('065_payable_report_contents.sql')).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
    await db.exec(source); await actor(); assert.deepEqual(await state(), installed);
  });
  await test('old API import writers cannot bypass the typed contents contract', async () => {
    const functions = (await db.query("SELECT p.oid::regprocedure::text name,has_function_privilege('service_role',p.oid,'EXECUTE') allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'commit_payables%' AND p.proname<>'commit_payables_status_contents_report_from_gateway'")).rows;
    assert(functions.length > 5); assert(functions.every(item => !item.allowed), JSON.stringify(functions));
    assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.commit_payables_status_contents_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,text,jsonb,jsonb,uuid,text,date,uuid,boolean,jsonb,boolean)','EXECUTE') r"), false);
  });
  await test('a fresh true global open report repairs the mistaken paid file without erasing its history', async () => {
    const correctOpen = [...seedRows.slice(2), row('NOVO-REAL', 45000)], preserved = await financialState();
    const oldEvents = await scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY created_at,id) r FROM public.payable_report_status_events e");
    const p = await preview(correctOpen);
    assert.equal(p.reopened_count, 28); assert.equal(p.marked_paid_count, 2);
    const result = await commit(await freeze(correctOpen));
    assert.equal(result.reopened_count, 28); assert.equal(result.marked_paid_count, 2); assert.equal(result.payments_created, 0);
    assert.equal((await title('ANTERIOR-1')).report_paid, true); assert.equal((await title('ANTERIOR-2')).report_paid, true);
    for (const source of correctOpen) assert.equal((await title(source.entry_number)).report_paid, false);
    const events = await scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY created_at,id) r FROM public.payable_report_status_events e");
    assert.deepEqual(events.filter(e => oldEvents.some(old => old.id === e.id)), oldEvents);
    assert.deepEqual(await financialState(), preserved);
    assert.equal((await title('ANTERIOR-30')).paid_cents, 10029);
  });
  await test('a paid report marks only its listed known titles and preserves absent open titles', async () => {
    const sourceRows = [row('PAGO-A', 12000), row('FICA-ABERTO', 34000), row('PAGO-B', 56000)];
    await baseline(sourceRows); const before = await financialState();
    const request = await freeze([sourceRows[0], sourceRows[2]], { contents: 'PAID_STATUS' }), p = request.preview;
    assert.equal(p.row_count, 2); assert.equal(p.position_count, 1); assert.equal(p.marked_paid_count, 2);
    assert.equal(p.new_count, 0); assert.equal(p.reopened_count, 0); assert.equal(p.changed_count, 0); assert.equal(p.can_commit, true, JSON.stringify(p.errors));
    const result = await commit(request), head = await currentHead();
    assert.equal(result.row_count, 2); assert.equal(result.position_count, 1); assert.equal(result.marked_paid_count, 2);
    assert.equal(head.rows.length, 2); assert.equal(head.position.length, 1);
    assert.equal((await title('FICA-ABERTO')).report_paid, false); assert.equal((await title('FICA-ABERTO')).outstanding_cents, 34000);
    assert.equal((await title('PAGO-A')).report_paid, true); assert.equal((await title('PAGO-B')).report_paid, true);
    assert.deepEqual(await financialState(), before);
  });
  await test('a status-only paid report never overwrites nominal value, due date or source description', async () => {
    const source = row('PAGO-SEM-REESCRITA', 25000); await baseline([source, row('OUTRO-ABERTO')]);
    const previous = await title(source.entry_number);
    const classification = await scalar("SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY plan),'[]') r FROM public.payable_plan_mappings m");
    await commit(await freeze([{ ...source, amount_cents: 43000, due_date: tomorrow, description: 'Texto diferente do arquivo baixado',
      plan: 'PLANO DIFERENTE SOMENTE NO ARQUIVO BAIXADO', bank_account: 'Banco previsto diferente no arquivo baixado' }], { contents: 'PAID_STATUS' }));
    const current = await title(source.entry_number);
    assert.equal(current.amount_cents, previous.amount_cents); assert.equal(date(current.due_date), date(previous.due_date));
    assert.equal(current.description, previous.description); assert.equal(current.plan, previous.plan);
    assert.equal(current.bank_account, previous.bank_account); assert.equal(current.report_paid, true);
    assert.deepEqual(await scalar("SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY plan),'[]') r FROM public.payable_plan_mappings m"), classification);
  });
  await test('unknown paid titles are blocked instead of creating forecast obligations or confirming unrelated titles', async () => {
    await baseline([row('CONHECIDO')]); const before = await state();
    const request = await freeze([row('CONHECIDO'), row('NAO-EXISTE')], { contents: 'PAID_STATUS' });
    assert.equal(request.preview.can_commit, false); assert.equal(request.preview.new_count, 1);
    assert(request.preview.errors.length > 0); await rejects(() => commit(request));
    assert.equal(await title('NAO-EXISTE'), undefined); assert.deepEqual(await state(), before);
  });
  await test('full open reports retain automatic inclusion, value and maturity updates under the same identity', async () => {
    const beforeRows = [row('ATUALIZAR', 10000), row('MANTER', 20000)]; await baseline(beforeRows);
    const old = await title('ATUALIZAR'), source = [row('ATUALIZAR', 32000, { due_date: tomorrow }), row('NOVO', 9000)];
    const p = await preview(source); assert.equal(p.can_commit, true); assert.equal(p.changed_count, 1); assert.equal(p.new_count, 1);
    await commit(await freeze(source)); const changed = await title('ATUALIZAR');
    assert.equal(changed.id, old.id); assert.equal(changed.amount_cents, 32000); assert.equal(date(changed.due_date), tomorrow);
    assert.equal((await title('MANTER')).report_paid, true); assert.equal((await title('NOVO')).outstanding_cents, 9000);
  });
  await test('large reductions in a full report require explicit confirmation and do not mutate on refusal', async () => {
    const source = Array.from({ length: 20 }, (_, i) => row(`LIMITE-${i}`, 1000 + i)); await baseline(source);
    const before = await state(), request = await freeze(source.slice(0, 9));
    assert.equal(request.preview.requires_large_reduction_confirmation, true); assert.equal(request.preview.large_reduction_confirmed, false);
    assert.equal(request.preview.can_commit, false); await rejects(() => commit(request)); assert.deepEqual(await state(), before);
    const approved = await freeze(source.slice(0, 9), { confirm: true }); assert.equal(approved.preview.can_commit, true);
    const result = await commit(approved); assert.equal(result.marked_paid_count, 11); assert.equal(result.position_count, 9);
  });
  await test('a fifty percent reduction and small prior reports do not trigger the exceptional large-drop gate', async () => {
    const source = Array.from({ length: 20 }, (_, i) => row(`METADE-${i}`, 2000 + i)); await baseline(source);
    const half = await preview(source.slice(0, 10)); assert.equal(half.requires_large_reduction_confirmation, false); assert.equal(half.can_commit, true);
    await commit(await freeze(source.slice(0, 10)));
    const small = await preview(source.slice(0, 1)); assert.equal(small.requires_large_reduction_confirmation, false); assert.equal(small.can_commit, true);
  });
  await test('paid reports can settle all currently open titles without a full-report reduction declaration', async () => {
    const source = Array.from({ length: 25 }, (_, i) => row(`PAGAR-TODOS-${i}`, 3000 + i)); await baseline(source);
    const request = await freeze(source, { contents: 'PAID_STATUS' }); assert.equal(request.preview.can_commit, true);
    assert.equal(request.preview.position_count, 0); assert.equal(request.preview.requires_large_reduction_confirmation, false);
    await commit(request); assert.equal((await currentHead()).position.length, 0);
    assert.equal((await title(source[0].entry_number)).report_paid, true);
  });
  await test('request retries preserve the exact source, operation and protocol and never duplicate paid events', async () => {
    const source = [row('REPLAY-PAGO'), row('REPLAY-ABERTO')]; await baseline(source);
    const request = await freeze([source[0]], { contents: 'PAID_STATUS' }), first = await commit(request), before = await state();
    const replay = await commit(request); assert.equal(replay.idempotent, true); assert.equal(replay.report_id, first.report_id);
    assert.deepEqual(await state(), before);
    await rejects(() => commit({ ...request, contents: 'FULL_OPEN' }), '22023'); assert.deepEqual(await state(), before);
    await rejects(() => commit({ ...request, confirm: true }), '22023'); assert.deepEqual(await state(), before);
  });
  await test('the same current paid file under a new protocol cannot create a second paid event', async () => {
    const source = [row('MESMO-PAGO'), row('MESMO-ABERTO')]; await baseline(source);
    const first = await freeze([source[0]], { contents: 'PAID_STATUS' }); await commit(first);
    const oldEvents = await all('public.payable_report_status_events'), before = await financialState();
    const next = await freeze([source[0]], { contents: 'PAID_STATUS', original: first.original });
    assert.equal(next.preview.marked_paid_count, 0); assert.equal(next.preview.can_commit, true);
    const repeated = await commit(next); assert.equal(repeated.marked_paid_count, 0);
    assert.deepEqual(await all('public.payable_report_status_events'), oldEvents); assert.deepEqual(await financialState(), before);
    assert.equal((await title('MESMO-ABERTO')).outstanding_cents, 10000);
  });
  await test('older full-report bytes cannot overwrite a newer position under a new request', async () => {
    const source = [row('HASH-BASE'), row('HASH-OTHER')], first = await freeze(source); await commit(first);
    await commit(await freeze([...source, row('HASH-NOVO')])); const before = await state();
    const stale = await freeze(source, { original: first.original, confirm: true }); await rejects(() => commit(stale), '23505');
    assert.deepEqual(await state(), before);
  });
  await test('a current full file cannot overwrite a later manual provision correction', async () => {
    const source = [row('CORRECAO-MANUAL')], first = await freeze(source); await commit(first);
    await owner(); await db.query('UPDATE public.payable_titles SET amount_cents=amount_cents+77 WHERE entry_number=$1 AND branch=$2', ['CORRECAO-MANUAL', branch]); await actor();
    const request = await freeze(source, { original: first.original }), before = await state();
    await rejects(() => commit(request), '23505'); assert.deepEqual(await state(), before);
    assert.equal((await title('CORRECAO-MANUAL')).amount_cents, 10077);
  });
  await test('a concurrent head change rejects a frozen import and leaves existing sources untouched', async () => {
    const source = [row('CAS-BASE'), row('CAS-OUTRO')]; await baseline(source);
    const old = await freeze([source[0]], { contents: 'PAID_STATUS' });
    await commit(await freeze([...source, row('CAS-NOVO')])); const before = await state();
    await rejects(() => commit(old), '40001'); assert.deepEqual(await state(), before);
  });
  await test('valid approved CP sessions may import both contents while read-only and other modules cannot', async () => {
    await actor('cp'); const request = await freeze([row('CP-ESCOPO')]); await commit(request, 'cp');
    for (const user of ['director','cr','rh','collector']) {
      await actor(user); await rejects(() => preview([row('FORBIDDEN')]));
      await rejects(() => commit(request, user));
    }
    await rejects(() => commit(request, 'cp', randomUUID()), '42501');
  });
  await test('missing, unknown or inconsistent report contents and empty paid files are rejected', async () => {
    for (const contents of [null, 'INCREMENTAL', 'PAID', '']) await rejects(() => preview([row('TIPO')], { contents }), '22023');
    await rejects(() => preview([], { contents: 'PAID_STATUS', empty: true }), '22023');
    await rejects(() => preview([row('BAIXADO-EM-ABERTOS', 10000, { source_status: 'BAIXADO' })]), '22023');
  });
  await test('closed status words cannot be imported as full open titles or overwrite a valid earlier row', async () => {
    const source = row('STATUS-EXISTENTE', 14000); await baseline([source, row('STATUS-PRESERVADO')]);
    const statuses = ['PAGO', 'PAGA', 'PAGOS', 'PAGAS', 'QUITADO', 'QUITADA', 'QUITADOS', 'QUITADAS',
      'BAIXADO', 'BAIXADA', 'BAIXADOS', 'BAIXADAS', 'LIQUIDADO', 'LIQUIDADA', 'LIQUIDADOS', 'LIQUIDADAS',
      'COMPENSADO', 'COMPENSADA', 'COMPENSADOS', 'COMPENSADAS', 'CANCELADO', 'CANCELADA', 'CANCELADOS', 'CANCELADAS',
      'ESTORNADO', 'ESTORNADA', 'ESTORNADOS', 'ESTORNADAS'];
    const validRequest = await freeze([{ ...source, amount_cents: 19000, due_date: tomorrow }, row('STATUS-NOVO')]);
    const before = await state();
    for (const source_status of statuses) {
      const changed = { ...source, amount_cents: 19000, due_date: tomorrow, description: 'Não deve sobrescrever a provisão', source_status };
      for (const rows of [[changed, row('STATUS-NOVO')], [row('STATUS-NOVO'), changed]]) {
        await rejects(() => preview(rows), '22023');
        await rejects(() => commit({ ...validRequest, rows }), '22023');
      }
    }
    assert.deepEqual(await state(), before); assert.equal(await title('STATUS-NOVO'), undefined);
    assert.equal((await title(source.entry_number)).amount_cents, 14000);
  });
  await test('recognized closed status words are accepted only as listed paid statuses without financial facts', async () => {
    const statuses = ['PAGO', 'PAGA', 'PAGOS', 'PAGAS', 'QUITADO', 'QUITADA', 'QUITADOS', 'QUITADAS',
      'BAIXADO', 'BAIXADA', 'BAIXADOS', 'BAIXADAS', 'LIQUIDADO', 'LIQUIDADA', 'LIQUIDADOS', 'LIQUIDADAS',
      'COMPENSADO', 'COMPENSADA', 'COMPENSADOS', 'COMPENSADAS', 'CANCELADO', 'CANCELADA', 'CANCELADOS', 'CANCELADAS',
      'ESTORNADO', 'ESTORNADA', 'ESTORNADOS', 'ESTORNADAS'];
    const source = statuses.map((_, index) => row(`STATUS-BAIXADO-${index}`, 15000 + index));
    await baseline([...source, row('STATUS-AUSENTE-ABERTO')]); const before = await financialState(), priorStatuses = new Map();
    for (const item of source) priorStatuses.set(item.entry_number, (await title(item.entry_number)).source_status);
    const request = await freeze(source.map((item, index) => ({ ...item, source_status: statuses[index] })), { contents: 'PAID_STATUS' });
    assert.equal(request.preview.can_commit, true); const result = await commit(request);
    assert.equal(result.marked_paid_count, statuses.length); assert.equal(result.payments_created, 0); assert.equal(result.position_count, 1);
    for (const item of source) { const current = await title(item.entry_number); assert.equal(current.report_paid, true); assert.equal(current.source_status, priorStatuses.get(item.entry_number)); }
    assert.equal((await title('STATUS-AUSENTE-ABERTO')).report_paid, false); assert.deepEqual(await financialState(), before);
  });
  await test('an explicitly empty full open report closes the previous position with a preserved header-only file', async () => {
    await baseline([row('VAZIO-UM'), row('VAZIO-DOIS')]); const before = await financialState();
    const request = await freeze([], { empty: true, original: original('Lançamento;Histórico;Plano cp - Conta: nome;Plano cc - Conta: nome;Emissão: valor do lançamento;Emissão: data;Vencimento: data;Cheque: número;Filial\r\n') });
    assert.equal(request.preview.can_commit, true, JSON.stringify(request.preview.errors));
    const result = await commit(request); assert.equal(result.row_count, 0); assert.equal(result.position_count, 0);
    assert.equal(result.marked_paid_count, 2); assert.equal((await currentHead()).rows.length, 0);
    assert.equal((await title('VAZIO-UM')).report_paid, true); assert.deepEqual(await financialState(), before);
  });
  await test('actual payments remain intact when a paid-status file closes the same title', async () => {
    const source = [row('PAGO-REAL', 45000), row('ABERTO-REAL', 23000)]; await baseline(source);
    await actualPayment(await title('PAGO-REAL')); const before = await financialState();
    await commit(await freeze([source[0]], { contents: 'PAID_STATUS' }));
    const t = await title('PAGO-REAL'); assert.equal(t.report_paid, true); assert.equal(t.paid_cents, 45000); assert.equal(t.financial_status, 'PAID');
    assert.deepEqual(await financialState(), before);
  });
  await test('a paid-file cent marker cannot overwrite or administratively close a previously larger title', async () => {
    const source = [row('CENTAVO-DIVERGENTE', 19000), row('OUTRO-CENTAVO', 23000)]; await baseline(source);
    const before = await state(), request = await freeze([{ ...source[0], amount_cents: 1 }], { contents: 'PAID_STATUS' });
    assert.equal(request.preview.can_commit, false); assert(request.preview.errors.length > 0);
    await rejects(() => commit(request)); assert.deepEqual(await state(), before);
    assert.equal((await title('CENTAVO-DIVERGENTE')).amount_cents, 19000);
  });
  await test('a confirmed administrative cent remains outside financial sums without a paid-status payment', async () => {
    const source = [row('CENTAVO-CONFIRMADO', 1), row('CENTAVO-ABERTO', 17000)];
    const request = await freeze(source, { choices: { 'row:1': { action: 'WRITE_OFF', reason: 'Marcador sintético confirmado individualmente.' } } });
    assert.equal(request.preview.can_commit, true, JSON.stringify(request.preview.errors));
    await commit(request); const before = await financialState(), administrative = await all('public.payable_administrative_writeoffs');
    const paid = await freeze([source[0]], { contents: 'PAID_STATUS' }); assert.equal(paid.preview.can_commit, true, JSON.stringify(paid.preview.errors));
    const result = await commit(paid); assert.equal(result.written_off_count, 0); assert.equal(result.payments_created, 0);
    assert.equal((await title(source[0].entry_number)).financial_status, 'ADMIN_WRITEOFF');
    assert.deepEqual(await financialState(), before); assert.deepEqual(await all('public.payable_administrative_writeoffs'), administrative);
  });
  await test('a paid-file cent with a different source due date requires individual closure and preserves the current title fields', async () => {
    const source = row('CENTAVO-DATA-ATUAL', 10000), absent = row('CENTAVO-DATA-AUSENTE', 17000); await baseline([source, absent]);
    // An old open cent can predate the individual-writeoff import rule. Model a nominal correction
    // without creating a payment, changing the original report, or closing that existing identity.
    await owner(); await db.query('UPDATE public.payable_titles SET amount_cents=1 WHERE entry_number=$1 AND branch=$2', [source.entry_number, branch]); await actor();
    const current = await title(source.entry_number), before = await financialState();
    const paidSource = { ...source, amount_cents: 1, due_date: tomorrow, issued_on: tomorrow, source_status: 'LIQUIDADO',
      description: 'Informação apenas do arquivo baixado', plan: 'PLANO SOMENTE DO ARQUIVO BAIXADO', bank_account: 'Banco somente do arquivo baixado' };
    const pending = await freeze([paidSource], { contents: 'PAID_STATUS' }), preserved = await state();
    assert.equal(pending.preview.can_commit, false); assert.equal(pending.preview.exceptions.length, 1);
    assert.equal(pending.preview.exceptions[0].due_date, yesterday); assert.equal(pending.preview.rows[0].due_date, tomorrow);
    await rejects(() => commit(pending)); assert.deepEqual(await state(), preserved);
    const request = await freeze([paidSource], { contents: 'PAID_STATUS', choices: { 'row:1': { action: 'WRITE_OFF', reason: 'Baixa individual do marcador de centavo legado.' } } });
    assert.equal(request.preview.can_commit, true); const result = await commit(request), updated = await title(source.entry_number);
    assert.equal(result.written_off_count, 1); assert.equal(result.marked_paid_count, 0); assert.equal(result.payments_created, 0); assert.equal(result.position_count, 1);
    assert.equal(updated.financial_status, 'ADMIN_WRITEOFF');
    for (const field of ['amount_cents', 'description', 'plan', 'bank_account', 'source_status', 'issued_on', 'due_date']) assert.deepEqual(updated[field], current[field], field);
    assert.equal((await title(absent.entry_number)).report_paid, false); assert.equal((await title(absent.entry_number)).outstanding_cents, absent.amount_cents);
    assert.deepEqual(await financialState(), before);
  });
  await test('per-title cent rounding stays bound to the source and the confirmed request', async () => {
    const source = [row('ARREDONDAMENTO', 2335)], rounding = [{ line: 2, original_amount: '23,345', amount_cents: 2335 }];
    const result = await commit(await freeze(source, { rounding })); assert.deepEqual(result.rounding_adjustments, rounding);
    assert.equal((await title('ARREDONDAMENTO')).amount_cents, 2335);
  });
  await test('status imports leave users, permissions, cash, receivables and every other module unchanged', async () => {
    const source = [row('ISOLADO-PAGO'), row('ISOLADO-ABERTO')]; await baseline(source);
    const before = await state(); await commit(await freeze([source[0]], { contents: 'PAID_STATUS' })); const after = await state();
    for (const [name, value] of Object.entries(before)) {
      if (/^(?:public|cf_private)[.]payable_/.test(name) || name === 'public.audit_events') continue;
      assert.deepEqual(after[name], value, name);
    }
  });
  await test('a late audit failure rolls back the file, position, paid statuses and protocol atomically', async () => {
    const source = [row('FALHA-PAGO'), row('FALHA-ABERTO')]; await baseline(source);
    const request = await freeze([source[0]], { contents: 'PAID_STATUS' }); await owner();
    await db.exec("CREATE FUNCTION cf_private.synthetic_contents_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.entity='PAYABLE_REPORT_CONTENTS_IMPORT' THEN RAISE EXCEPTION 'Falha sintética' USING ERRCODE='22023';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_contents_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.synthetic_contents_failure()");
    await actor(); const before = await state(); await rejects(() => commit(request), '22023'); assert.deepEqual(await state(), before);
  });
  await test('the complete SQL Editor installer is byte exact and repeatable without changing imported or financial data', async () => {
    const installer = await buildPayableReportContentsSql();
    assert.equal(await readFile(new URL('../supabase/dashboard/ativar-tipos-relatorios-contas-pagar.sql', import.meta.url), 'utf8'), installer);
    assert.equal((installer.match(/^BEGIN;\s*$/gm) ?? []).length, 1); assert.equal((installer.match(/^COMMIT;\s*$/gm) ?? []).length, 1);
    await baseline([row('INSTALACAO-PAGO'), row('INSTALACAO-ABERTO')]); await commit(await freeze([row('INSTALACAO-PAGO')], { contents: 'PAID_STATUS' }));
    const before = await state(); await owner();
    const withinTest = installer.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''); await db.exec(withinTest); await actor();
    const after = await state(); delete before['public.central_schema_migrations']; delete after['public.central_schema_migrations']; assert.deepEqual(after, before);
    const installed = await state(); await owner(); await db.exec(withinTest); await actor(); assert.deepEqual(await state(), installed);
  });
  if (failures.length) { process.exitCode = 1; for (const failure of failures) console.error(failure.name, failure.error.stack); }
  console.log(`${passed} passed, ${failures.length} failed (payable report contents065, synthetic local PostgreSQL)`);
} catch (error) { console.error('FAIL', error.message, error.code ?? '', error.where ?? '', error.stack); process.exitCode = 1; }
finally { await db.close(); }
