import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPayablesGateway } from './handler.mjs';
import { dailyReportSourceRows } from './daily-reconciliation.mjs';

const USER = '10000000-0000-4000-8000-000000000001';
const SESSION = '20000000-0000-4000-8000-000000000001';
const IMPORT = '30000000-0000-4000-8000-000000000001';
const REPORT = '40000000-0000-4000-8000-000000000001';
const REQUEST = '50000000-0000-4000-8000-000000000001';
const BANK = '60000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://central.example.invalid';
const BASE = 'https://project.example.invalid';
const ANON = 'synthetic-public-key', SERVICE = 'synthetic-service-only-key';
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: USER, session_id: SESSION })).toString('base64url')}.auth-verified-only`;
const HEADER = 'Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Filial;Emissão;Banco;Situação;Cheque: número';
const NORMAL = 'NORMAL-001;Fornecedor sintético;20/10/2026;100,00;PLANO SINTETICO;Filial sintética;01/10/2026;BANCO TESTE;PENDENTE;';
const CHEQUE = 'CHEQUE-001;Fornecedor sintético;20/10/2026;50,00;PLANO SINTETICO;Filial sintética;01/10/2026;BANCO TESTE;CHEQUE;000123';
const CSV = HEADER + '\r\n' + NORMAL + '\r\n';
const encode = value => Buffer.from(value).toString('base64');
const body = (extra = {}) => ({ action: 'preview', mode: 'daily', daily_report_version: '059', report_kind: 'NORMAL',
  file_name: 'relatorio-sintetico.csv', file_base64: encode(CSV), mappings: {}, bank_mappings: {}, resolution_choices: {}, ...extra });
const commit = extra => body({ action: 'commit', complete: true, previous_import_id: null, previous_financial_revision: '17',
  expected_report_date: '2026-10-29', request_id: REQUEST, ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function setup(options = {}) {
  const calls = [], logs = [];
  let workbookCalls = 0;
  const now = options.now ?? '2026-10-29T13:00:00Z';
  const permissions = options.permissions ?? [...['read', 'write', 'import'].map(action => ({ resource: 'contas_pagar', action })),
    { resource: 'importar_bases', action: 'read' }];
  const handle = createPayablesGateway({ now: () => new Date(now), log: event => logs.push(event),
    env: name => ({ ALLOWED_ORIGINS: ORIGIN, SUPABASE_URL: BASE, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE })[name],
    loadWorkbook: async () => { workbookCalls++; throw new Error('Synthetic unsupported workbook'); },
    fetch: async (url, init) => {
      const path = new URL(url).pathname, data = init.body ? JSON.parse(init.body) : null;
      calls.push({ path, data, init });
      if (path === '/auth/v1/user') return json({ id: USER });
      if (path === '/rest/v1/rpc/current_access') return json({ profile: { id: USER, enabled: options.enabled ?? true }, permissions });
      if (path === '/rest/v1/rpc/payables_import_capabilities') return json(options.capabilities ?? { daily_reports: true, daily_report_version: '059', column_rules_version: '059' }, options.capabilityStatus ?? 200);
      if (path === '/rest/v1/rpc/preview_payables_daily_report') {
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(init.headers.apikey, ANON);
        if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
        const rows = dailyReportSourceRows(data.p_rows, data.p_report_kind), baseline = data.p_report_kind === 'CHEQUES';
        const preview = { mode: 'daily', daily_report_version: '059', report_kind: data.p_report_kind, report_date: '2026-10-29',
          empty_cheques_confirmed: data.p_empty_cheques_confirmed,
          previous_import_id: null, financial_revision: '17', rows, ignored_cheque_count: data.p_rows.length - rows.length,
          row_count: rows.length, new_count: rows.length, open_count: 0, changed_count: 0, baseline_only: baseline,
          baseline_origin: baseline ? 'FIRST_REPORT' : 'EXISTING_BASE', auto_payment_count: 0, auto_payment_cents: 0,
          missing_count: 0, automatic_actions: [], exceptions: [], reconciliation_items: [], errors: [], bank_options: [], can_commit: true };
        return json(options.preview ? options.preview(preview) : preview);
      }
      if (path === '/rest/v1/rpc/commit_payables_daily_report_from_gateway') {
        assert.equal(init.headers.Authorization, `Bearer ${SERVICE}`); assert.equal(init.headers.apikey, SERVICE);
        if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
        const rows = dailyReportSourceRows(data.p_rows, data.p_report_kind);
        const result = { mode: 'daily', daily_report_version: '059', report_kind: data.p_report_kind, report_date: data.p_expected_report_date,
          empty_cheques_confirmed: data.p_empty_cheques_confirmed,
          request_id: data.p_request_id, report_id: REPORT, import_id: IMPORT, row_count: rows.length, new_count: rows.length,
          open_count: 0, changed_count: 0, paid_count: 0, written_off_count: 0, automatic_paid_count: 0,
          payment_cents: 0, idempotent: options.replay ?? false };
        return json(options.result ? options.result(result) : result);
      }
      throw new Error('Unexpected upstream route');
    },
  });
  const send = value => handle(new Request(BASE + '/functions/v1/payables-import', { method: 'POST',
    headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value ?? body()) }));
  return { send, calls, logs, workbookCalls: () => workbookCalls };
}

test('daily preview reparses actual bytes with fixed scope and only caller-token read RPC', async () => {
  const app = setup(), response = await app.send();
  assert.equal(response.status, 200);
  const value = await response.json(), call = app.calls.at(-1);
  assert.equal(value.file_sha256, createHash('sha256').update(CSV).digest('hex'));
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].amount_cents, 10000);
  assert.deepEqual(call.data, { p_scope: 'grupo-consolidado', p_rows: value.rows, p_report_kind: 'NORMAL', p_mappings: {}, p_bank_mappings: {}, p_resolution_choices: {}, p_empty_cheques_confirmed: false });
  assert.deepEqual(app.calls.map(call => call.path), ['/auth/v1/user', '/rest/v1/rpc/current_access',
    '/rest/v1/rpc/payables_import_capabilities', '/rest/v1/rpc/preview_payables_daily_report']);
});

test('daily commit forwards only verified identity, raw-file integrity and frozen review protocol', async () => {
  const app = setup(), input = commit(), response = await app.send(input);
  assert.equal(response.status, 200);
  const value = await response.json(), call = app.calls.at(-1);
  assert.equal(value.report_id, REPORT); assert.equal(value.request_id, REQUEST);
  assert.equal(call.data.p_user_id, USER); assert.equal(call.data.p_session_id, SESSION);
  assert.equal(call.data.p_scope, 'grupo-consolidado'); assert.equal(call.data.p_expected_report_date, input.expected_report_date);
  assert.equal(call.data.p_previous_financial_revision, '17'); assert.equal(call.data.p_request_id, REQUEST);
  assert.equal(call.data.p_file_name, input.file_name); assert.equal(call.data.p_file_base64, input.file_base64);
  assert.equal(call.data.p_file_sha256, createHash('sha256').update(CSV).digest('hex'));
  assert.equal(call.data.p_rows[0].amount_cents, 10000);
});

test('normal global report provisions every source row including cheques without advancing the cheque channel', async () => {
  const app = setup(), response = await app.send(body({ file_base64: encode(HEADER + '\r\n' + NORMAL + '\r\n' + CHEQUE) }));
  assert.equal(response.status, 200); const value = await response.json();
  assert.equal(app.calls.at(-1).data.p_rows.length, 2);
  assert.equal(value.rows.length, 2); assert.equal(value.rows[0].entry_number, 'NORMAL-001');
  assert.equal(value.rows[1].cheque_number, '000123'); assert.equal(value.preview.ignored_cheque_count, 0);
});

test('explicit cheque report gets separate initial baseline without invoking common forecast settlement', async () => {
  const app = setup(), response = await app.send(body({ report_kind: 'CHEQUES', file_base64: encode(HEADER + '\r\n' + CHEQUE) }));
  assert.equal(response.status, 200); const value = await response.json();
  assert.equal(value.preview.report_kind, 'CHEQUES'); assert.equal(value.preview.baseline_only, true);
  assert.equal(value.rows[0].cheque_number, '000123');
  assert(app.calls.every(call => !/forecast/.test(call.path)));
});

test('wrong or empty source partition is blocked before querying any financial report', async () => {
  for (const input of [body({ report_kind: 'CHEQUES' }), body({ report_kind: 'CHEQUES', file_base64: encode(HEADER + '\r\n' + NORMAL + '\r\n' + CHEQUE) }),
    body({ file_base64: encode(HEADER) })]) {
    const app = setup(), response = await app.send(input);
    assert.equal(response.status, 422); assert.equal(app.calls.length, 2);
  }
});

test('explicit zero-cheque declaration permits only a valid header-only cheque report and preserves its exact bytes', async () => {
  const app = setup(), input = body({ report_kind: 'CHEQUES', empty_cheques_confirmed: true, file_base64: encode(HEADER + '\r\n') });
  const response = await app.send(input);
  assert.equal(response.status, 200); const value = await response.json();
  assert.equal(value.preview.empty_cheques_confirmed, true); assert.equal(value.preview.row_count, 0);
  assert.equal(value.preview.baseline_only, true); assert.deepEqual(value.rows, []);
  assert.deepEqual(app.calls.at(-1).data.p_rows, []); assert.equal(app.calls.at(-1).data.p_empty_cheques_confirmed, true);
  assert.equal(value.file_sha256, createHash('sha256').update(HEADER + '\r\n').digest('hex'));
});

test('zero-cheque declaration cannot bypass malformed headers, nonempty titles, orphan lines or formulas', async () => {
  for (const csv of [HEADER.replace('Valor;', 'Coluna ausente;'), HEADER + '\r\n' + CHEQUE,
    HEADER + '\r\n' + NORMAL, HEADER + '\r\n\n;Título incompleto', HEADER + ';Extra\r\n;;;;;;;;;;=1+1']) {
    const app = setup(), response = await app.send(body({ report_kind: 'CHEQUES', empty_cheques_confirmed: true, file_base64: encode(csv) }));
    assert.equal(response.status, 422); assert.equal(app.calls.length, 2);
    const value = await response.json(); assert(value.errors.length > 0);
    if (csv.includes(CHEQUE)) assert.equal(value.errors[0].problem, 'O relatório contém títulos. Desmarque a declaração de posição sem cheques pendentes.');
  }
});

test('zero-cheque flag is a typed cheque-only declaration and never changes normal or legacy modes', async () => {
  for (const input of [body({ empty_cheques_confirmed: true }), body({ empty_cheques_confirmed: false }),
    body({ report_kind: 'CHEQUES', empty_cheques_confirmed: 'true' }),
    body({ mode: 'forecast', reconciliation_version: '043', full_report: true, empty_cheques_confirmed: true })]) {
    const app = setup(), response = await app.send(input);
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
  const app = setup(), response = await app.send(body({ report_kind: 'CHEQUES', empty_cheques_confirmed: false, file_base64: encode(HEADER) }));
  assert.equal(response.status, 422); assert.equal(app.calls.length, 2);
});

test('a confirmed zero-cheque position can settle every preceding cheque without fabricating a source title', async () => {
  const automatic = { key: `title:${IMPORT}`, kind: 'MISSING', line: null, title_id: IMPORT, branch: 'Filial sintética',
    entry_number: 'CHEQUE-ANTERIOR', description: 'Cheque sintético ausente', due_date: '2026-10-20', amount_cents: 5000,
    payment_remaining_cents: 5000, allowed_actions: ['PAID'], selected_action: 'PAID', requires_resolution: false,
    already_written_off: false, problem: null, paid_on: '2026-10-29', bank_account_id: BANK,
    bank_label: 'BANCO TESTE', cheque_number: '000009', rule: 'IMPORT_DATE' };
  const app = setup({ preview: value => ({ ...value, baseline_only: false, baseline_origin: 'PREVIOUS_REPORT',
    missing_count: 1, auto_payment_count: 1, auto_payment_cents: 5000, automatic_actions: [automatic],
    bank_options: [{ id: BANK, display_name: 'BRADESCO F2G', account_type: 'BANK' }] }) });
  const response = await app.send(body({ report_kind: 'CHEQUES', empty_cheques_confirmed: true, file_base64: encode(HEADER) }));
  assert.equal(response.status, 200); const value = await response.json();
  assert.equal(value.preview.missing_count, 1); assert.equal(value.preview.auto_payment_cents, 5000); assert.deepEqual(value.rows, []);
});

test('empty-cheque confirmation forwards frozen flag and accepts only its exact success echo', async () => {
  const input = commit({ report_kind: 'CHEQUES', empty_cheques_confirmed: true, file_base64: encode(HEADER) });
  const app = setup(), response = await app.send(input);
  assert.equal(response.status, 200); assert.equal((await response.json()).row_count, 0);
  const call = app.calls.at(-1); assert.equal(call.data.p_empty_cheques_confirmed, true); assert.deepEqual(call.data.p_rows, []);
  assert.equal(call.data.p_request_id, REQUEST); assert.equal(call.data.p_file_base64, input.file_base64);
  for (const options of [{ result: value => ({ ...value, empty_cheques_confirmed: false }) },
    { result: value => ({ ...value, empty_cheques_confirmed: undefined }) },
    { preview: value => ({ ...value, empty_cheques_confirmed: false }) }]) {
    const changed = setup(options), result = await changed.send(options.preview ? { ...input, action: 'preview', complete: undefined,
      previous_import_id: undefined, previous_financial_revision: undefined, expected_report_date: undefined, request_id: undefined } : input);
    assert.equal(result.status, 503);
  }
});

test('unsupported daily contract or browser-supplied identities and financial rows never reach parsing', async () => {
  for (const extra of [{ daily_report_version: '043' }, { daily_report_version: undefined }, { report_kind: 'ALL' },
    { user_id: USER }, { rows: [] }, { scope: 'other' }, { expected_report_date: '2026-10-29' }, { full_report: true },
    { reconciliation_version: '043' }, { bank_rules_version: '050' }, { report_date: '2026-10-29' }]) {
    const app = setup(), response = await app.send(body({ file_base64: '!', ...extra }));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
});

test('daily reconciliation requires read/write/import and Importar Bases authorization before loading workbook', async () => {
  const full = [...['read', 'write', 'import'].map(action => ({ resource: 'contas_pagar', action })), { resource: 'importar_bases', action: 'read' }];
  for (let index = 0; index < full.length; index++) {
    const app = setup({ permissions: full.filter((_, key) => key !== index) });
    const response = await app.send(body({ file_name: 'invalid.xlsx', file_base64: '!' }));
    assert.equal(response.status, 403); assert.equal(app.calls.length, 2); assert.equal(app.workbookCalls(), 0);
  }
});

test('only complete confirmations with valid request identity, date and financial revision reach daily write RPC', async () => {
  for (const extra of [{ complete: false }, { previous_import_id: undefined }, { previous_financial_revision: '' },
    { request_id: 'not-a-uuid' }, { expected_report_date: '2026-02-30' }, { bank_mappings: { key: 'invented' } },
    { resolution_choices: { 'row:2': { action: 'WRITE_OFF', reason: 'Not in source.' } } }]) {
    const app = setup(), response = await app.send(commit(extra));
    assert.equal(response.status, 400); assert(app.calls.every(call => !/commit_/.test(call.path)));
  }
});

test('missing daily SQL or RPC returns explicit activation notice without falling back to legacy import', async () => {
  for (const options of [{ capabilities: {} }, { capabilities: { daily_reports: true, daily_report_version: '057' } },
    { capabilities: { code: 'PGRST202', message: 'private schema' }, capabilityStatus: 404 },
    { rpcError: { code: '42883', message: 'private schema' }, rpcStatus: 404 }]) {
    const app = setup(options), response = await app.send();
    assert.equal(response.status, 409); const value = await response.json();
    assert.equal(value.code, 'P0059'); assert.equal(value.activation_required, true);
    assert(!JSON.stringify(value).includes('private schema'));
    assert(app.calls.every(call => !/forecast|commit_/.test(call.path)));
  }
});

test('daily preview fails closed on dropped rows, altered cents, mismatched channel or missing proof', async () => {
  for (const changes of [{ rows: [] }, { ignored_cheque_count: 1 }, { financial_revision: '' }, { report_kind: 'CHEQUES' },
    { row_count: 0 }, { auto_payment_count: 1 }, { rows: [{ amount_cents: 1 }] }, { daily_report_version: '043' }, { report_date: '2026-10-30' }]) {
    const app = setup({ preview: value => ({ ...value, ...changes }) }), response = await app.send();
    assert.equal(response.status, 503); assert.deepEqual(app.logs, ['request_unavailable']);
  }
});

test('daily commit refuses malformed success metadata while preserving an unknown confirmation outcome', async () => {
  for (const changes of [{ request_id: REPORT }, { report_date: '2026-10-30' }, { report_kind: 'CHEQUES' }, { row_count: 0 },
    { import_id: null }, { report_id: 'invented' }, { automatic_paid_count: 1 }, { paid_count: -1 }, { payment_cents: 0.1 }]) {
    const app = setup({ result: value => ({ ...value, ...changes }) }), response = await app.send(commit());
    assert.equal(response.status, 503); assert.equal(app.calls.filter(call => /commit_/.test(call.path)).length, 1);
  }
});

test('same-protocol replay forwards the original reviewed date even after the Sao Paulo day changed', async () => {
  const app = setup({ replay: true, now: '2026-10-30T04:00:00Z' });
  const response = await app.send(commit());
  assert.equal(response.status, 200); assert.equal((await response.json()).idempotent, true);
  assert.equal(app.calls.at(-1).data.p_expected_report_date, '2026-10-29');
});

test('stale revision and denied daily commits report controlled failures without leaking database errors', async () => {
  for (const [code, status] of [['40001', 409], ['42501', 403], ['22023', 400], ['23514', 400], ['P0058', 409]]) {
    const app = setup({ rpcError: { code, message: 'private bank title and token' } }), response = await app.send(commit());
    assert.equal(response.status, status); const value = await response.json(); assert.equal(value.code, code);
    if (code === 'P0058') assert.equal(value.activation_required, false);
    assert(!JSON.stringify(value).includes('private bank title and token'));
  }
});
