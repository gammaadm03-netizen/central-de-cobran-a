import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceivablesGateway, RECEIVABLES_GATEWAY_SCHEMA } from './handler.mjs';
import { validOpenReportStatus } from './open-report-status.mjs';

const origin = 'https://central.example.invalid', base = 'https://project.example.invalid';
const user = '10000000-0000-4000-8000-000000000001', session = '20000000-0000-4000-8000-000000000001';
const requestId = '30000000-0000-4000-8000-000000000001', importId = '40000000-0000-4000-8000-000000000001';
const token = 'header.' + Buffer.from(JSON.stringify({ sub: user, session_id: session })).toString('base64url') + '.verified-by-auth';
const hash = 'a'.repeat(64), reference = '2026-11-03';
const permissions = [...['read', 'write', 'import'].map(action => ({ resource: 'contas_receber', action })), { resource: 'importar_bases', action: 'read' }];
const body = { action: 'status', mode: 'open', request_id: requestId, file_sha256: hash, full_report: true, reference_date: reference, row_count: 1064 };
const expected = { requestId, fileSha256: hash, fullReport: true, referenceDate: reference, rowCount: 1064 };
const result = { format_version: 'receivables-open-report-v1', request_id: requestId, import_id: importId, mode: 'open', row_count: 1064,
  full_report: true, reference_date: reference, retired_count: 4, retired_worked_count: 3, retired_unworked_count: 1, reappeared_count: 1,
  collector_assignment_version: '030', assigned_title_count: 5, assigned_customer_count: 2, return_approval_version: '057', returned_count: 1, idempotent: true };
const completed = { format_version: 'receivables-open-report-status-v1', status: 'COMPLETED', request_id: requestId,
  source_sha256: hash, full_report: true, reference_date: reference, row_count: 1064, result };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function setup(options = {}) {
  const calls = [], logs = []; let parses = 0;
  const handle = createReceivablesGateway({
    env: key => ({ ALLOWED_ORIGINS: origin, SUPABASE_URL: base, SUPABASE_ANON_KEY: 'public-test', SUPABASE_SERVICE_ROLE_KEY: 'private-test' })[key],
    requestTimeoutMs: options.requestTimeoutMs,
    loadWorkbook: async () => { parses++; throw new Error('Status must never inflate a workbook'); },
    log: entry => logs.push(entry),
    fetch: async (url, init) => {
      const path = new URL(url).pathname; calls.push({ path, init, data: init.body ? JSON.parse(init.body) : null });
      if (path === '/auth/v1/user') return json({ id: user }, options.authStatus ?? 200);
      if (path === '/rest/v1/rpc/current_access') return json({ profile: { id: user, enabled: true }, permissions: options.permissions ?? permissions });
      assert.equal(path, '/rest/v1/rpc/receivable_open_report_request_status', 'Only the read-only status RPC is allowed');
      assert.equal(init.headers.apikey, 'public-test'); assert.equal(init.headers.Authorization, `Bearer ${token}`);
      if (options.delay) await new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new DOMException('Private upstream data', 'AbortError')), { once: true }); });
      return json(options.payload ?? completed, options.status ?? 200);
    },
  });
  return { calls, logs, parses: () => parses, send: (value = body) => handle(new Request(`${base}/functions/v1/receivables-import`, {
    method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
  })) };
}

test('062 status reads the exact frozen proof under the user token without parsing, previewing or committing again', async () => {
  const app = setup(), response = await app.send(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), completed);
  assert.equal(app.parses(), 0); assert.deepEqual(app.calls.map(call => call.path), ['/auth/v1/user', '/rest/v1/rpc/current_access', '/rest/v1/rpc/receivable_open_report_request_status']);
  assert.deepEqual(app.calls.at(-1).data, { p_request_id: requestId, p_scope: 'grupo-consolidado', p_file_sha256: hash, p_full_report: true, p_reference_date: reference, p_expected_row_count: 1064 });
});
test('062 an unconfirmed lookup reports only missing durable proof and never retries the writer', async () => {
  const value = { ...completed, status: 'UNCONFIRMED', result: null }, app = setup({ payload: value });
  const response = await app.send(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), value); assert.equal(app.calls.length, 3); assert.equal(app.parses(), 0);
});
test('062 status requires all approved financial and import-hub permissions before calling SQL', async () => {
  for (const missing of permissions) {
    const app = setup({ permissions: permissions.filter(item => item !== missing) }), response = await app.send();
    assert.equal(response.status, 403); assert.equal(app.calls.length, 2); assert.equal(app.parses(), 0);
  }
  const expired = setup({ authStatus: 401 }); assert.equal((await expired.send()).status, 401); assert.equal(expired.calls.length, 1);
});
test('062 malformed status requests and any file or changed-choice payload are refused before parsing or SQL', async () => {
  for (const patch of [{ request_id: 'bad' }, { file_sha256: 'bad' }, { mode: 'received' }, { full_report: null }, { reference_date: '2026-02-30' }, { row_count: 0 }, { row_count: 5001 }, { row_count: 1.5 }, { file_base64: 'private' }, { file_name: 'private.xlsx' }, { title_mappings: {} }, { previous_financial_revision: '17' }]) {
    const app = setup(), response = await app.send({ ...body, ...patch }); assert.equal(response.status, 400, JSON.stringify(patch)); assert.equal(app.calls.length, 2); assert.equal(app.parses(), 0);
  }
});
test('062 missing status activation is explicit and never falls back to a financial writer', async () => {
  const app = setup({ status: 404, payload: { code: 'PGRST202', message: 'Private SQL and credentials' } }), response = await app.send();
  assert.equal(response.status, 409); const value = await response.json(); assert.equal(value.code, 'P0062'); assert.equal(value.activation_required, true); assert.equal(value.stage, 'status'); assert.equal(app.calls.length, 3); assert(!JSON.stringify(value).includes('Private SQL'));
});
test('062 status rejects incompatible source, ownership proof, result counts and metadata without exposing a saved result', async () => {
  const mutations = [
    value => { value.status = 'MISSING'; }, value => { value.request_id = 17; }, value => { value.request_id = importId; },
    value => { value.source_sha256 = 'b'.repeat(64); }, value => { value.full_report = false; }, value => { value.reference_date = '2026-11-02'; },
    value => { value.row_count = 1063; }, value => { value.result.request_id = importId; }, value => { value.result.row_count--; },
    value => { value.result.retired_worked_count++; }, value => { value.result.returned_count = 1065; },
    value => { value.result.assigned_customer_count = 6; }, value => { value.status = 'UNCONFIRMED'; },
  ];
  for (const mutate of mutations) {
    const payload = structuredClone(completed); mutate(payload); const app = setup({ payload }), response = await app.send();
    assert.equal(response.status, 502, JSON.stringify(payload)); const value = await response.json(); assert.equal(value.code, 'CR_INVALID_RESPONSE'); assert.equal(value.stage, 'status_validation'); assert.equal(value.result, undefined);
  }
});
test('062 bounded status timeouts identify the read-only stage and preserve an uncertain result', async () => {
  const app = setup({ delay: true, requestTimeoutMs: 5 }), response = await app.send(); assert.equal(response.status, 504);
  const value = await response.json(); assert.equal(value.code, 'CR_REQUEST_TIMEOUT'); assert.equal(value.stage, 'status'); assert.equal(value.schema_version, RECEIVABLES_GATEWAY_SCHEMA); assert.equal(app.calls.length, 3); assert.equal(app.parses(), 0);
});
test('062 browser and gateway proof share the same completed and unconfirmed status contract', () => {
  assert.equal(validOpenReportStatus(completed, expected), true); assert.equal(validOpenReportStatus({ ...completed, status: 'UNCONFIRMED', result: null }, expected), true);
  assert.equal(validOpenReportStatus({ ...completed, status: 'UNCONFIRMED' }, expected), false);
  assert.equal(validOpenReportStatus({ ...completed, result: { ...result, idempotent: undefined } }, expected), false);
});
