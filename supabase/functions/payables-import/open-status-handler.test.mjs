import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPayablesGateway } from './handler.mjs';

const USER = '10000000-0000-4000-8000-000000000001', SESSION = '20000000-0000-4000-8000-000000000001';
const IMPORT = '30000000-0000-4000-8000-000000000001', REPORT = '40000000-0000-4000-8000-000000000001';
const REQUEST = '50000000-0000-4000-8000-000000000001', TITLE = '60000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://central.example.invalid', BASE = 'https://project.example.invalid';
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: USER, session_id: SESSION })).toString('base64url')}.verified`;
const HEADER = 'Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Filial;Emissão;Banco;Situação;Cheque: número';
const NORMAL = 'TESTE-001;Fornecedor sintético;20/11/2026;100,00;PLANO NOVO;Filial sintética;01/10/2026;CAIXA INTERNO;PENDENTE;';
const CSV = `${HEADER}\r\n${NORMAL}\r\n`, encode = value => Buffer.from(value).toString('base64');
const body = (extra = {}) => ({ action: 'preview', mode: 'open_status', status_report_version: '061', report_kind: 'ALL',
  file_name: 'sintetico.csv', file_base64: encode(CSV), mappings: {}, resolution_choices: {}, ...extra });
const commit = (extra = {}) => body({ action: 'commit', complete: true, previous_import_id: null, previous_financial_revision: '061:17',
  expected_report_date: '2026-10-30', request_id: REQUEST, ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const capabilities = { status_from_report: true, status_report_version: '061' };
function setup(options = {}) {
  const calls = [], logs = [];
  const allPermissions = [...['read', 'write', 'import'].map(action => ({ resource: 'contas_pagar', action })), { resource: 'importar_bases', action: 'read' }];
  const handler = createPayablesGateway({ now: () => new Date(options.now ?? '2026-10-30T13:00:00Z'), log: event => logs.push(event),
    env: name => ({ ALLOWED_ORIGINS: ORIGIN, SUPABASE_URL: BASE, SUPABASE_ANON_KEY: 'public-synthetic', SUPABASE_SERVICE_ROLE_KEY: 'service-synthetic' })[name],
    loadWorkbook: async () => { throw new Error('Workbook must not be inflated'); },
    fetch: async (url, init) => {
      const path = new URL(url).pathname, data = init.body ? JSON.parse(init.body) : null;
      calls.push({ path, data, init });
      if (path === '/auth/v1/user') return json({ id: USER });
      if (path === '/rest/v1/rpc/current_access') return json({ profile: { id: USER, enabled: true }, permissions: options.permissions ?? allPermissions });
      if (path === '/rest/v1/rpc/payables_import_capabilities') return json(options.capabilities ?? capabilities);
      if (path === '/rest/v1/rpc/preview_payables_open_status_report') {
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        if (options.rpcError) return json(options.rpcError, 409);
        const p = { mode: 'open_status', status_report_version: '061', status_only: true, report_kind: 'ALL', report_date: '2026-10-30',
          previous_import_id: null, financial_revision: '061:17', rows: data.p_rows, row_count: data.p_rows.length, new_count: data.p_rows.length,
          open_count: 0, changed_count: 0, marked_paid_count: 0, marked_paid_cents: 0, reopened_count: 0,
          baseline_only: true, baseline_origin: 'FIRST_REPORT', status_actions: [], exceptions: [], errors: [],
          can_commit: true, unmapped_plans: [{ plan: 'PLANO NOVO', count: 1, total_cents: 10000 }], macro_options: ['NÃO CLASSIFICADO'],
          rounding_adjustments: data.p_rounding_adjustments, empty_report_confirmed: data.p_empty_report_confirmed };
        return json(options.preview ? options.preview(p, data) : p);
      }
      if (path === '/rest/v1/rpc/commit_payables_open_status_report_from_gateway') {
        assert.equal(init.headers.Authorization, 'Bearer service-synthetic');
        if (options.rpcError) return json(options.rpcError, 409);
        const r = { mode: 'open_status', status_report_version: '061', status_only: true, report_kind: 'ALL', report_date: data.p_expected_report_date,
          request_id: data.p_request_id, report_id: REPORT, import_id: IMPORT, row_count: data.p_rows.length, new_count: data.p_rows.length,
          open_count: 0, updated_count: 0, marked_paid_count: 0, marked_paid_cents: 0, reopened_count: 0, written_off_count: 0, baseline_only: true,
          paid_count: 0, payment_cents: 0, payments_created: 0, idempotent: options.replay ?? false,
          rounding_adjustments: data.p_rounding_adjustments, empty_report_confirmed: data.p_empty_report_confirmed };
        return json(options.result ? options.result(r) : r);
      }
      throw new Error('Unexpected upstream route');
    },
  });
  const send = value => handler(new Request(`${BASE}/functions/v1/payables-import`, { method: 'POST',
    headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value ?? body()) }));
  return { send, calls, logs };
}

test('061 reparses source bytes, accepts unknown classification and source Caixa Interno without a payment bank', async () => {
  const app = setup(), response = await app.send();
  assert.equal(response.status, 200); const value = await response.json(), call = app.calls.at(-1);
  assert.equal(value.file_sha256, createHash('sha256').update(CSV).digest('hex'));
  assert.equal(value.rows[0].due_date, '2026-11-20'); assert.equal(value.rows[0].bank_account, 'CAIXA INTERNO');
  assert.equal(value.preview.can_commit, true); assert.equal(value.preview.unmapped_plans.length, 1);
  assert.equal(call.data.p_scope, 'grupo-consolidado'); assert.deepEqual(call.data.p_rows, value.rows);
  assert.deepEqual(call.data.p_rounding_adjustments, []); assert(!Object.hasOwn(call.data, 'p_bank_mappings'));
  assert(!app.calls.some(call => /unified_report|paid_import/.test(call.path)));
});

test('061 exact per-title rounding is derived from raw bytes and echoed with raw source audit proof', async () => {
  const source = CSV.replace('100,00;', '23,345;'), app = setup();
  const response = await app.send(commit({ file_base64: encode(source) }));
  assert.equal(response.status, 200); const result = await response.json(), call = app.calls.at(-1);
  assert.equal(call.data.p_rows[0].amount_cents, 2335);
  assert.deepEqual(call.data.p_rounding_adjustments, [{ line: 2, original_amount: '23,345', amount_cents: 2335 }]);
  assert.deepEqual(result.rounding_adjustments, call.data.p_rounding_adjustments);
  assert.equal(call.data.p_file_base64, encode(source)); assert.equal(call.data.p_file_sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(call.data.p_user_id, USER); assert.equal(call.data.p_session_id, SESSION);
  assert.equal(result.payment_cents, 0); assert.equal(result.payments_created, 0);
});

test('status-only disappearances can mark ordinary and cheque titles paid without a bank or a fabricated paid_on', async () => {
  const action = { kind: 'PAID', title_id: TITLE, source_key: JSON.stringify(['FILIAL SINTÉTICA', 'ANTERIOR-001']), amount_cents: 9300 };
  const app = setup({ preview: p => ({ ...p, baseline_only: false, baseline_origin: 'PREVIOUS_REPORT', marked_paid_count: 1,
    marked_paid_cents: 9300, status_actions: [action] }) });
  const response = await app.send(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).preview.status_actions, [action]);
});

test('061 rejects browser financial rows, bank selections, rounding overrides and financial resolution choices before parsing', async () => {
  for (const extra of [{ rows: [] }, { user_id: USER }, { bank_mappings: {} }, { rounding_adjustments: [] },
    { status_report_version: '060' }, { report_kind: 'CHEQUES' }, { empty_report_confirmed: 'true' },
    { resolution_choices: { 'row:1': { action: 'REOPEN', reason: 'Not a cent write-off.' } } },
    { resolution_choices: { 'row:1': { action: 'PAID', reason: 'Not a payment.', paid_on: '2026-10-30', amount_paid_cents: 100, bank_account_id: TITLE } } }]) {
    const app = setup(), response = await app.send(body({ file_base64: '!', ...extra }));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
});

test('every CP read/write/import and Importar Bases permission is required before parsing', async () => {
  const permissions = [...['read', 'write', 'import'].map(action => ({ resource: 'contas_pagar', action })), { resource: 'importar_bases', action: 'read' }];
  for (let index = 0; index < permissions.length; index++) {
    const app = setup({ permissions: permissions.filter((_, i) => i !== index) });
    assert.equal((await app.send(body({ file_base64: '!' }))).status, 403); assert.equal(app.calls.length, 2);
  }
});

test('061 capability is mandatory and old060 financial writers are retired when status-only is active', async () => {
  const old = setup({ capabilities: { daily_reports: true, unified_daily_report: true, daily_report_version: '060' } });
  const absent = await old.send(); assert.equal(absent.status, 409); assert.equal((await absent.json()).activation_required, true);
  const app = setup(), legacy = body({ mode: 'daily', daily_report_version: '060', bank_mappings: {} }); delete legacy.status_report_version;
  const response = await app.send(legacy); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'P0061');
  assert(!app.calls.some(call => /preview_payables_unified|commit_/.test(call.path)));
});

test('malformed status-only proof cannot pass as a successful commit or preview', async () => {
  for (const changes of [{ payment_cents: 1 }, { paid_count: 1 }, { payments_created: 1 }, { status_only: false },
    { request_id: TITLE }, { rounding_adjustments: [{ line: 2, original_amount: '999', amount_cents: 99900 }] },
    { row_count: 0 }, { updated_count: 1 }, { baseline_only: true, marked_paid_count: 1 }]) {
    const app = setup({ result: r => ({ ...r, ...changes }) }); assert.equal((await app.send(commit())).status, 503);
  }
  for (const changes of [{ rows: [] }, { report_date: '2026-11-01' }, { marked_paid_count: 1 },
    { marked_paid_cents: 1 }, { errors: [{ line: 1, column: 'Valor', problem: 'Erro', correction: 'Corrija' }] },
    { status_actions: [{ kind: 'PAID', title_id: TITLE, source_key: 'x', amount_cents: 100, paid_on: '2026-10-30' }] }]) {
    const app = setup({ preview: p => ({ ...p, ...changes }) }); assert.equal((await app.send()).status, 503);
  }
});

test('unknown-outcome retry forwards the identical request identity and reviewed date even on a later day', async () => {
  const input = commit(), app = setup({ now: '2026-10-31T13:00:00Z', replay: true });
  for (let attempt = 0; attempt < 2; attempt++) { const response = await app.send(input); assert.equal(response.status, 200); assert.equal((await response.json()).idempotent, true); }
  const writes = app.calls.filter(call => /commit_/.test(call.path)); assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].data, writes[1].data); assert.equal(writes[0].data.p_request_id, REQUEST);
  assert.equal(writes[0].data.p_expected_report_date, '2026-10-30'); assert(!app.calls.some(call => /preview_/.test(call.path)));
});

test('header-only reports require a typed empty flag and never allow empty flag to erase real rows', async () => {
  const missing = setup(); assert.equal((await missing.send(body({ file_base64: encode(HEADER) }))).status, 422);
  const typed = setup(), response = await typed.send(body({ file_base64: encode(HEADER), empty_report_confirmed: true }));
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).rows, []);
  const nonempty = setup(); assert.equal((await nonempty.send(body({ empty_report_confirmed: true }))).status, 422);
});

test('each new one-cent marker needs its individual nonfinancial choice; no paid action is accepted', async () => {
  const cent = CSV.replace('100,00;', '0,01;'), exception = { key: 'row:1', kind: 'CENT', line: 1, title_id: null,
    branch: 'Filial sintética', entry_number: 'TESTE-001', description: 'Fornecedor sintético', due_date: '2026-11-20', amount_cents: 1,
    allowed_actions: ['WRITE_OFF'], selected_action: null, requires_resolution: true, problem: null,
    payment_remaining_cents: 0, paid_on: null, bank_account_id: null, bank_label: null };
  const app = setup({ preview: (p, d) => ({ ...p, can_commit: !!d.p_resolution_choices['row:1'], exceptions: [{ ...exception,
    selected_action: d.p_resolution_choices['row:1']?.action ?? null }] }) });
  const pending = await app.send(body({ file_base64: encode(cent) })); assert.equal(pending.status, 200); assert.equal((await pending.json()).preview.can_commit, false);
  const confirmed = await app.send(body({ file_base64: encode(cent), resolution_choices: { 'row:1': { action: 'WRITE_OFF', reason: 'Baixa sem pagamento confirmada individualmente.' } } }));
  assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).preview.can_commit, true);
  const omitted = setup(); assert.equal((await omitted.send(body({ file_base64: encode(cent) }))).status, 503);
});

test('a reported title reopens only its report status using the updated amount, preserving real financial history', async () => {
  const action = { kind: 'REOPEN', title_id: TITLE, source_key: JSON.stringify(['FILIAL SINTÉTICA', 'TESTE-001']), amount_cents: 10000 };
  const preview = p => ({ ...p, new_count: 0, open_count: 1, changed_count: 1, baseline_only: false, baseline_origin: 'PREVIOUS_REPORT',
    reopened_count: 1, status_actions: [action] });
  const app = setup({ preview }); assert.equal((await app.send()).status, 200);
  for (const changes of [{ amount_cents: 9999 }, { source_key: '["FILIAL SINTÉTICA", "OUTRO"]' }, { kind: 'PAID' }, { payment_id: IMPORT }]) {
    const invalid = setup({ preview: p => ({ ...preview(p), status_actions: [{ ...action, ...changes }] }) });
    assert.equal((await invalid.send()).status, 503);
  }
});

test('duplicate or impossible status actions and nonzero hidden financial counters fail closed', async () => {
  const action = { kind: 'PAID', title_id: TITLE, source_key: '["FILIAL SINTÉTICA", "ANTERIOR"]', amount_cents: 10000 };
  const correct = p => ({ ...p, baseline_only: false, baseline_origin: 'PREVIOUS_REPORT', marked_paid_count: 1, marked_paid_cents: 10000, status_actions: [action] });
  for (const mutation of [p => ({ ...p, status_actions: [action, action], marked_paid_count: 2, marked_paid_cents: 20000 }),
    p => ({ ...p, status_actions: [{ ...action, source_key: '["FILIAL SINTÉTICA", "TESTE-001"]' }] }),
    p => ({ ...p, status_actions: [{ ...action, amount_cents: 1 }], marked_paid_cents: 1 }),
    p => ({ ...p, auto_payment_cents: 1 }), p => ({ ...p, auto_payment_count: 1 }), p => ({ ...p, payments_created: 1 })]) {
    const app = setup({ preview: p => mutation(correct(p)) }); assert.equal((await app.send()).status, 503);
  }
});

test('known administrative cent markers do not require a second confirmation on every import', async () => {
  const cent = CSV.replace('100,00;', '0,01;'), app = setup({ preview: p => ({ ...p, exceptions: [{ key: 'row:1', kind: 'CENT', line: 1,
    title_id: TITLE, branch: 'Filial sintética', entry_number: 'TESTE-001', description: 'Fornecedor sintético', due_date: '2026-11-20', amount_cents: 1,
    allowed_actions: [], selected_action: null, requires_resolution: false, already_written_off: true, problem: null,
    payment_remaining_cents: 0, paid_on: null, bank_account_id: null, bank_label: null }] }) });
  const response = await app.send(body({ file_base64: encode(cent) })); assert.equal(response.status, 200);
  assert.equal((await response.json()).preview.can_commit, true);
});

test('source validation remains active for duplicates, formulas and missing headers despite automatic import', async () => {
  for (const source of [CSV + NORMAL, CSV.replace('Fornecedor sintético', '=1+1'), CSV.replace('Valor;', 'Desconhecido;')]) {
    const app = setup(), response = await app.send(body({ file_base64: encode(source) }));
    assert.equal(response.status, 422); assert.equal((await response.json()).code, 'SOURCE_VALIDATION_FAILED');
    assert.equal(app.calls.length, 2);
  }
});
