import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createReceivablesGateway } from './handler.mjs';

const USER = '10000000-0000-4000-8000-000000000001';
const SESSION = '20000000-0000-4000-8000-000000000001';
const IMPORT = '30000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://central.example.invalid';
const BASE = 'https://project.example.invalid';
const ANON = 'synthetic-public-key';
const SERVICE = 'synthetic-server-only-key';
const jwt = claims => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: USER, session_id: SESSION, ...claims })).toString('base64url')}.verified-only-by-auth`;
const TOKEN = jwt({});
const CSV = 'Documento;Cliente;Vencimento;Valor;Filial;Emissão;CNPJ\r\nNF-1;Cliente sintético;16/10/2026;1.234,56;2 - TESTE;01/10/2026;12345678000195\r\n';
const encode = value => Buffer.from(value).toString('base64');
const body = (action = 'preview', extra = {}) => ({ action, file_name: 'grupo.csv', file_base64: encode(CSV), ...(action === 'commit' ? { complete: true, previous_import_id: null } : {}), ...extra });
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

function setup(options = {}) {
  const calls = [], logs = [];
  let workbookCalls = 0;
  const loader = options.loadWorkbook ?? (async buffer => {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
    const populated = workbook.worksheets.filter(sheet => sheet.actualRowCount > 0);
    if (populated.length !== 1) throw new Error('A cópia para importação deve conter uma única aba com dados.');
    const sheet = populated[0];
    if (sheet.rowCount > 5001 || sheet.columnCount > 100) throw new Error('Planilha excede 5.000 linhas ou 100 colunas.');
    const matrix = [];
    for (let i = 1; i <= sheet.rowCount; i++) matrix.push(sheet.getRow(i).values.slice(1));
    return { matrix, excel1904: Boolean(workbook.properties.date1904) };
  });
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const data = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, data, init });
    assert(init.signal instanceof AbortSignal);
    if (options.networkFailure) throw new Error('secret database query and token must never appear');
    if (path === '/auth/v1/user') {
      assert.equal(init.method, 'GET'); assert.equal(init.headers.apikey, ANON);
      return json(options.authPayload ?? { id: USER }, options.authStatus ?? 200);
    }
    if (path === '/rest/v1/rpc/current_access') {
      assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization.startsWith('Bearer '), true);
      if (options.accessError) return json(options.accessError, 403);
      return json({ profile: { id: USER, enabled: options.enabled ?? true, role_key: options.role ?? 'contas_receber' }, permissions: options.permissions ?? [{ resource: 'contas_receber', action: 'import' }] });
    }
    if (path === '/rest/v1/rpc/preview_receivables_import') {
      assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
      return json({ previous_import_id: null, row_count: data.p_rows.length, new_count: data.p_rows.length, open_count: 0, pending_count: 0, validated_in_source_count: 0 });
    }
    if (path === '/rest/v1/rpc/commit_receivables_import_from_gateway') {
      assert.equal(init.headers.apikey, SERVICE); assert.equal(init.headers.Authorization, `Bearer ${SERVICE}`);
      if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
      return json({ import_id: IMPORT, row_count: data.p_rows.length, new_count: data.p_rows.length, open_count: 0, pending_count: 0, validated_in_source_count: 0 });
    }
    throw new Error('Unexpected upstream path');
  };
  const settings = { ALLOWED_ORIGINS: ORIGIN, SUPABASE_URL: BASE, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, ...options.env };
  const handle = createReceivablesGateway({ env: name => settings[name], fetch: fetcher, loadWorkbook: async value => { workbookCalls++; return loader(value); }, log: message => logs.push(message) });
  const send = (data = body(), changes = {}) => handle(new Request(`${BASE}/functions/v1/receivables-import`, {
    method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...changes.headers },
    body: JSON.stringify(data),
  }));
  return { calls, logs, handle, send, workbookCalls: () => workbookCalls };
}

async function xlsx() {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('CP');
  sheet.addRow(['NF', 'Cliente', 'Vencimento', 'Valor', 'Filial']);
  sheet.addRow(['NF-2', 'Cliente da planilha', new Date('2026-10-17T00:00:00.000Z'), 42.37, '3 - TESTE']);
  return workbook.xlsx.writeBuffer();
}

test('preview derives canonical financial rows, hash and fixed scope from actual CSV bytes', async () => {
  const app = setup(); const response = await app.send();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  const payload = await response.json();
  assert.equal(payload.file_sha256, createHash('sha256').update(CSV).digest('hex'));
  assert.deepEqual(payload.rows, [{ document: 'NF-1', client_name: 'Cliente sintético', due_date: '2026-10-16', amount_cents: 123456, branch: '2 - TESTE', issued_on: '2026-10-01', client_document: '12345678000195' }]);
  assert.equal(payload.preview.row_count, 1);
  assert.deepEqual(app.calls.map(call => call.path), ['/auth/v1/user', '/rest/v1/rpc/current_access', '/rest/v1/rpc/preview_receivables_import']);
  assert.deepEqual(app.calls.at(-1).data, { p_scope: 'grupo-consolidado', p_rows: payload.rows });
  assert.equal(app.workbookCalls(), 0);
});

test('commit reparses bytes and forwards only verified identity and derived rows to service-only RPC', async () => {
  const app = setup(); const request = body('commit'); const response = await app.send(request);
  assert.equal(response.status, 200); assert.equal((await response.json()).import_id, IMPORT);
  const call = app.calls.at(-1);
  assert.equal(call.path, '/rest/v1/rpc/commit_receivables_import_from_gateway');
  assert.equal(call.data.p_user_id, USER); assert.equal(call.data.p_session_id, SESSION);
  assert.equal(call.data.p_scope, 'grupo-consolidado'); assert.equal(call.data.p_rows[0].amount_cents, 123456);
  assert.equal(call.data.p_file_sha256, createHash('sha256').update(CSV).digest('hex'));
  assert.equal(call.data.p_file_base64, request.file_base64); assert.equal(call.data.p_file_name, 'grupo.csv');
  assert(!('p_mappings' in call.data)); assert.equal(call.data.p_complete, true);
  assert.equal(call.data.p_previous_import_id, null);
});

test('browser cannot supply parsed rows, identity, role, hash or alternative scopes', async () => {
  for (const extra of [{ p_rows: [] }, { rows: [] }, { role: 'gerente_geral' }, { user_id: USER }, { session_id: SESSION }, { file_sha256: '0'.repeat(64) }, { scope: 'alternative' }]) {
    const app = setup(); const response = await app.send(body('commit', extra));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
});

test('unauthorized, disabled and recovery-only sessions are rejected before decoding or workbook parsing', async () => {
  for (const options of [{ permissions: [{ resource: 'contas_receber', action: 'read' }], role: 'diretor' }, { permissions: [{ resource: 'contas_pagar', action: 'import' }] }, { enabled: false }, { accessError: { code: '42501', message: 'private SQL detail' } }]) {
    const app = setup(options); const response = await app.send(body('commit', { file_name: 'invalid.xlsx', file_base64: '!not-base64!' }));
    assert.equal(response.status, 403); assert.equal(app.workbookCalls(), 0); assert.equal(app.calls.length, 2);
    assert(!JSON.stringify(await response.json()).includes('private SQL'));
  }
  const app = setup({ authStatus: 401, authPayload: { message: 'secret' } });
  assert.equal((await app.send()).status, 401); assert.equal(app.calls.length, 1);
});

test('missing and mismatched JWT identities never reach approved-session RPC or parsing', async () => {
  const missing = setup(); assert.equal((await missing.send(body(), { headers: { Authorization: '' } })).status, 401); assert.equal(missing.calls.length, 0);
  for (const token of [jwt({ sub: '10000000-0000-4000-8000-000000000002' }), jwt({ session_id: 'invalid' }), 'not-a-jwt']) {
    const app = setup(); assert.equal((await app.send(body(), { headers: { Authorization: `Bearer ${token}` } })).status, 401); assert.equal(app.calls.length, 1);
  }
});

test('canonical base64, file size and safe filenames are enforced', async () => {
  for (const file_base64 of ['', 'Zg=', 'Zh==', 'Zg==\n', '!bad!', encode(Buffer.alloc(2 * 1024 * 1024 + 1))]) {
    const app = setup(); assert.equal((await app.send(body('preview', { file_base64 }))).status, 400); assert.equal(app.calls.length, 2);
  }
  for (const file_name of ['../base.csv', 'path\\base.csv', 'base\u0000.csv', ' base.csv', 'base.csv ', 'x'.repeat(251) + '.csv', 'base.exe', 'base.xls']) {
    const app = setup(); assert.equal((await app.send(body('preview', { file_name }))).status, 400); assert.equal(app.calls.length, 2);
  }
});

test('commit requires explicit completeness, a valid previous import token and no client mappings', async () => {
  for (const extra of [{ complete: false }, { complete: 'true' }, { mappings: [] }, { mappings: { PLAN: 'FIXO' } }, { mappings: {} }, { previous_import_id: 'invalid' }, { previous_import_id: undefined }]) {
    const app = setup(); assert.equal((await app.send(body('commit', extra))).status, 400); assert.equal(app.calls.length, 2);
  }
});

test('unrelated bytes, malformed dates, missing headers, invalid UTF8 and formulas cause no financial write', async () => {
  for (const input of ['this is not a financial CSV', CSV.replace('16/10/2026', '31/02/2026'), CSV.replace('Cliente', 'Missing'), CSV.replace('Cliente sintético', '=1+1'), '"unclosed', Buffer.from([0xff, 0xfe, 0x00])]) {
    const app = setup(); const response = await app.send(body('commit', { file_base64: encode(input) }));
    assert.equal(response.status, 422); const payload = await response.json();
    assert(payload.errors.length > 0); assert(payload.errors.length <= 100); assert.equal(app.calls.length, 2);
    assert(payload.errors.every(error => typeof error.line === 'number' && typeof error.column === 'string' && typeof error.problem === 'string' && typeof error.correction === 'string'));
  }
});

test('XLSX is expanded safely and parsed server-side with Excel dates and numeric money', async () => {
  const bytes = await xlsx(); const app = setup();
  const response = await app.send(body('commit', { file_name: 'planilha.xlsx', file_base64: encode(bytes) }));
  assert.equal(response.status, 200); assert.equal(app.workbookCalls(), 1);
  const data = app.calls.at(-1).data;
  assert.equal(data.p_rows[0].amount_cents, 4237); assert.equal(data.p_rows[0].due_date, '2026-10-17');
  assert.equal(data.p_file_sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('forged ZIP expanded sizes are rejected before ExcelJS allocation', async () => {
  const zipped = await JSZip.loadAsync(await xlsx());
  const sheet = await zipped.file('xl/worksheets/sheet1.xml').async('string');
  zipped.file('xl/worksheets/sheet1.xml', sheet.replace('</worksheet>', '<!--' + 'X'.repeat(32768) + '--></worksheet>'));
  const bytes = await zipped.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  for (let i = 0; i + 46 < bytes.length; i++) if (bytes.readUInt32LE(i) === 0x02014b50) {
    const length = bytes.readUInt16LE(i + 28);
    if (bytes.subarray(i + 46, i + 46 + length).toString() === 'xl/worksheets/sheet1.xml') bytes.writeUInt32LE(1, i + 24);
  }
  const app = setup(); const response = await app.send(body('commit', { file_name: 'forged.xlsx', file_base64: encode(bytes) }));
  assert.equal(response.status, 422); assert.equal(app.workbookCalls(), 0); assert.equal(app.calls.length, 2);
});

test('untrusted library errors are replaced with a fixed file error', async () => {
  const app = setup({ loadWorkbook: async () => { throw new Error('TOP SECRET SQL and token'); } });
  const response = await app.send(body('commit', { file_name: 'broken.xlsx', file_base64: encode(await xlsx()) }));
  assert.equal(response.status, 422); assert(!JSON.stringify(await response.json()).includes('SECRET')); assert.deepEqual(app.logs, []);
});

test('SQL duplicate, stale and permission errors expose only safe allowlisted codes and messages', async () => {
  for (const [code, expected] of [['23505', 409], ['40001', 409], ['42501', 403], ['22023', 400], ['23514', 400]]) {
    const app = setup({ rpcError: { code, message: 'SQL query containing private details', details: SERVICE, hint: TOKEN } });
    const response = await app.send(body('commit')); assert.equal(response.status, expected);
    const payload = await response.json(); assert.equal(payload.code, code); assert(!JSON.stringify(payload).includes('private')); assert(!JSON.stringify(payload).includes(SERVICE)); assert(!JSON.stringify(payload).includes(TOKEN));
  }
});

test('ambiguous CNPJ identity change explains the correction without leaking database details', async () => {
  const message = 'Possível alteração de identificação do cliente. CNPJ incluído, removido ou alterado pode duplicar a dívida. Solicite correção administrativa antes de importar.';
  for (const action of ['preview', 'commit']) {
    const app = setup({ rpcError: { code: '23514', message, details: SERVICE, hint: TOKEN } });
    const response = await app.send(body(action));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: '23514', error: message });
    assert.deepEqual(app.logs, []);
  }
});

test('upstream failures never expose credentials, SQL, responses or raw exceptions in body or log', async () => {
  for (const options of [{ rpcError: { code: 'XX000', message: SERVICE, query: TOKEN }, rpcStatus: 502 }, { networkFailure: true }]) {
    const app = setup(options); const response = await app.send(body('commit')); assert.equal(response.status, 503);
    const serialized = JSON.stringify({ body: await response.json(), logs: app.logs });
    assert(!serialized.includes(SERVICE)); assert(!serialized.includes(TOKEN)); assert(!serialized.includes('SQL'));
    assert(app.logs.every(event => ['upstream_unavailable', 'request_unavailable'].includes(event)));
  }
});

test('actual streamed body bytes are bounded even when Content-Length lies', async () => {
  const app = setup(); let canceled = false, emitted = 0;
  const stream = new ReadableStream({ pull(controller) { emitted++; if (emitted > 8) return controller.close(); controller.enqueue(new Uint8Array(512 * 1024).fill(32)); }, cancel() { canceled = true; } });
  const response = await app.handle(new Request(`${BASE}/functions/v1/receivables-import`, { method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': '1' }, body: stream, duplex: 'half' }));
  assert.equal(response.status, 400); assert.equal(canceled, true); assert.equal(app.calls.length, 2);
});

test('CORS matches exact origins and only allows approved preflight headers and methods', async () => {
  for (const origin of ['', '*', 'https://central.example.invalid.evil.test', ORIGIN + '/']) {
    const app = setup(); const response = await app.send(body(), { headers: { Origin: origin } });
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null); assert.equal(app.calls.length, 0);
  }
  const app = setup(); const response = await app.handle(new Request(BASE, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, apikey, content-type, x-client-info' } }));
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN); assert.equal(app.calls.length, 0);
  const denied = await app.handle(new Request(BASE, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-unsafe' } }));
  assert.equal(denied.status, 403);
  const method = await app.handle(new Request(BASE, { method: 'GET', headers: { Origin: ORIGIN } }));
  assert.equal(method.status, 405);
});
