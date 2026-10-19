import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createReceivablesGateway, RECEIVABLES_GATEWAY_SCHEMA } from './handler.mjs';
import { isReceivableIdentifierHeader, readReceivableIdentifierCell } from '../../../src/lib/receivables-parser.mjs';
import { receivableCustomerKey } from '../../../src/lib/receivables-parser.mjs';

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
const ERP_HEADER = ['Entidade 1 - Entidade: nome','Documento: número','Emissão: valor do lançamento','Emissão: data','Vencimento: data','Filial'];
const ERP_ROW = ['Cliente exclusivamente sintético','000123','125,90','01/10/2026 23:59','20/10/2026 00:01','FILIAL TESTE'];
const OPEN_CSV = ERP_HEADER.join(';') + '\r\n' + ERP_ROW.join(';') + '\r\n';
const RECEIVED_CSV = [...ERP_HEADER,'Quitação: data do recebimento','Quitação: valor recebido'].join(';') + '\r\n' + [...ERP_ROW,'17/10/2026 23:59','120,00'].join(';') + '\r\n';
const encode = value => Buffer.from(value).toString('base64');
const body = (action = 'preview', extra = {}) => ({ action, file_name: 'grupo.csv', file_base64: encode(CSV), ...(action === 'commit' ? { complete: true, previous_import_id: null, ...(extra.mode ? { previous_financial_revision:'17' } : {}) } : {}), ...extra });
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
function diagnostic(payload, code, stage) {
  assert.equal(payload.code, code); assert.equal(payload.stage, stage);
  assert.equal(payload.schema_version, RECEIVABLES_GATEWAY_SCHEMA);
  assert.match(payload.request_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
}

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
    const identifiers = [];
    sheet.getRow(1).eachCell((cell, column) => { if (isReceivableIdentifierHeader(cell.value)) identifiers.push(column); });
    for (let i = 1; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i), values = row.values.slice(1);
      if (i > 1) for (const column of identifiers) { const cell = row.getCell(column); values[column - 1] = readReceivableIdentifierCell(cell.value, cell.numFmt); }
      matrix.push(values);
    }
    return { matrix, excel1904: Boolean(workbook.properties.date1904) };
  });
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const data = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, data, init });
    assert(init.signal instanceof AbortSignal);
    if (options.delayAtPath === path) await new Promise((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(new DOMException('Private timeout details', 'AbortError')); };
      const timer = setTimeout(() => { init.signal.removeEventListener('abort', aborted); resolve(); }, options.delayMs ?? 200);
      init.signal.addEventListener('abort', aborted, { once: true }); if (init.signal.aborted) aborted();
    });
    if (options.networkFailure) throw new Error('secret database query and token must never appear');
    if (path === '/auth/v1/user') {
      assert.equal(init.method, 'GET'); assert.equal(init.headers.apikey, ANON);
      return json(options.authPayload ?? { id: USER }, options.authStatus ?? 200);
    }
    if (path === '/rest/v1/rpc/current_access') {
      assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization.startsWith('Bearer '), true);
      if (options.accessError) return json(options.accessError, 403);
      return json({ profile: { id: USER, enabled: options.enabled ?? true, role_key: options.role ?? 'contas_receber' }, permissions: options.permissions ?? ['import','read','write'].map(action => ({ resource:'contas_receber',action })) });
    }
    if (path === '/rest/v1/rpc/receivables_import_capabilities') {
      assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (options.capabilityError) return json(options.capabilityError, options.capabilityStatus ?? 404);
      return json(options.capabilities ?? { open_sync:true, received_import:true });
    }
    if (['/rest/v1/rpc/preview_receivables_import','/rest/v1/rpc/preview_receivables_open_import','/rest/v1/rpc/preview_receivables_received_import','/rest/v1/rpc/preview_receivables_open_import_with_collectors'].includes(path)) {
      assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
      if (options.previewPayload) return json(options.previewPayload);
      if (!path.endsWith('/preview_receivables_import')) {
        const withCollectors = path.endsWith('/preview_receivables_open_import_with_collectors');
        const mode = path.endsWith('/preview_receivables_open_import') || withCollectors ? 'open' : 'received';
        const groups = new Map(); for (const row of data.p_rows) { const key = receivableCustomerKey(row), group = groups.get(key) ?? []; group.push(row); groups.set(key, group); }
        const assignments = [...groups].map(([customer_key, rows]) => ({ customer_key, client_name: rows[0].client_name, client_document: rows[0].client_document, collector_id: data.p_collector_mappings?.[customer_key] ?? null, collector_name: data.p_collector_mappings?.[customer_key] ? 'Responsável sintética' : null, row_count: rows.length, requires_selection: true, locked: false }));
        const missing = assignments.filter(row => row.collector_id === null).length;
        return json({ mode,previous_import_id:null,financial_revision:'17',row_count:data.p_rows.length,new_count:data.p_rows.length,open_count:0,changed_count:0,pending_count:0,validated_in_source_count:0,received_count:data.p_rows.length,matched_count:0,correction_count:0,historical_count:0,conflict_count:0,can_commit:!withCollectors || missing === 0,errors:[],rows:data.p_rows.map((row,index) => ({ ...row,line:index+1,title_id:null,outcome:mode==='open'?'NEW':'NEW_RECEIPT',candidates:[], ...(withCollectors ? { customer_key: receivableCustomerKey(row) } : {}) })), ...(withCollectors ? { collector_assignment_version: '030', customer_collector_assignments: assignments, missing_collector_count: missing } : {}) });
      }
      return json({ previous_import_id: null, row_count: data.p_rows.length, new_count: data.p_rows.length, open_count: 0, pending_count: 0, validated_in_source_count: 0 });
    }
    if (['/rest/v1/rpc/commit_receivables_import_from_gateway','/rest/v1/rpc/commit_receivables_open_import_from_gateway','/rest/v1/rpc/commit_receivables_received_import_from_gateway','/rest/v1/rpc/commit_receivables_open_import_with_collectors_from_gateway'].includes(path)) {
      assert.equal(init.headers.apikey, SERVICE); assert.equal(init.headers.Authorization, `Bearer ${SERVICE}`);
      if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
      const withCollectors = path.endsWith('/commit_receivables_open_import_with_collectors_from_gateway');
      return json(options.commitPayload ?? { import_id: IMPORT, row_count: data.p_rows.length, new_count: data.p_rows.length, open_count: 0, pending_count: 0, validated_in_source_count: 0, ...(path.endsWith('/commit_receivables_open_import_from_gateway') || withCollectors ? { mode:'open' } : path.endsWith('/commit_receivables_received_import_from_gateway') ? { mode:'received' } : {}), ...(withCollectors ? { collector_assignment_version: '030', assigned_title_count: data.p_rows.length, assigned_customer_count: Object.keys(data.p_collector_mappings).length } : {}) });
    }
    throw new Error('Unexpected upstream path');
  };
  const settings = { ALLOWED_ORIGINS: ORIGIN, SUPABASE_URL: BASE, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, ...options.env };
  const handle = createReceivablesGateway({ env: name => settings[name], fetch: fetcher, loadWorkbook: async value => { workbookCalls++; return loader(value); }, log: message => logs.push(message), requestTimeoutMs: options.requestTimeoutMs });
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
    const payload = await response.json(); assert.equal(payload.error, message); diagnostic(payload, '23514', action);
    assert.deepEqual(app.logs, []);
  }
});

test('upstream failures never expose credentials, SQL, responses or raw exceptions in body or log', async () => {
  for (const options of [{ rpcError: { code: 'XX000', message: SERVICE, query: TOKEN }, rpcStatus: 502 }, { networkFailure: true }]) {
    const app = setup(options); const response = await app.send(body('commit')); assert.equal(response.status, 503);
    const serialized = JSON.stringify({ body: await response.json(), logs: app.logs });
    assert(!serialized.includes(SERVICE)); assert(!serialized.includes(TOKEN)); assert(!serialized.includes('SQL'));
    assert(app.logs.every(event => event.event === 'receivables_import_failure' && event.code === 'CR_SERVICE_UNAVAILABLE'));
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

test('explicit open mode routes a synthetic ERP report to source synchronization with verified proof and title mappings', async () => {
  for (const action of ['preview','commit']) {
    const app = setup(); const request = body(action, { mode:'open',file_base64:encode(OPEN_CSV),title_mappings:{ '1':'NEW' } });
    const response = await app.send(request); assert.equal(response.status, 200);
    const payload = await response.json(), call = app.calls.at(-1);
    assert.equal(call.path, `/rest/v1/rpc/${action === 'preview' ? 'preview_receivables_open_import' : 'commit_receivables_open_import_from_gateway'}`);
    assert.deepEqual(call.data.p_title_mappings, { '1':'NEW' });
    assert.deepEqual(call.data.p_rows, [{ document:'000123',client_name:'Cliente exclusivamente sintético',client_document:null,branch:'FILIAL TESTE',issued_on:'2026-10-01',due_date:'2026-10-20',amount_cents:12590 }]);
    assert.equal(Object.hasOwn(call.data, 'p_complete'), false); assert.equal(Object.hasOwn(call.data, 'p_confirm_corrections'), false);
    if (action === 'preview') { assert.equal(payload.rows[0].line, 1); assert.equal(payload.rows[0].outcome, 'NEW'); assert.deepEqual(payload.rows, payload.preview.rows); }
    else { assert.equal(call.data.p_user_id, USER); assert.equal(call.data.p_session_id, SESSION); assert.equal(call.data.p_file_sha256, createHash('sha256').update(OPEN_CSV).digest('hex')); assert.equal(call.data.p_file_base64, request.file_base64); assert.equal(call.data.p_previous_financial_revision, '17'); }
    assert.equal(app.calls[2].path, '/rest/v1/rpc/receivables_import_capabilities');
  }
});

test('received mode preserves nominal and actual amounts independently, including advance receipt, without inventing a bank', async () => {
  for (const action of ['preview','commit']) {
    const app = setup(); const request = body(action, { mode:'received',file_base64:encode(RECEIVED_CSV),title_mappings:{ '1':IMPORT },...(action === 'commit' ? { confirm_corrections:true } : {}) });
    const response = await app.send(request); assert.equal(response.status, 200);
    const payload = await response.json(), call = app.calls.at(-1);
    assert.equal(call.path, `/rest/v1/rpc/${action === 'preview' ? 'preview_receivables_received_import' : 'commit_receivables_received_import_from_gateway'}`);
    assert.deepEqual(call.data.p_rows[0], { document:'000123',client_name:'Cliente exclusivamente sintético',client_document:null,branch:'FILIAL TESTE',issued_on:'2026-10-01',due_date:'2026-10-20',amount_cents:12590,received_on:'2026-10-17',received_amount_cents:12000 });
    assert.equal(Object.hasOwn(call.data.p_rows[0], 'bank'), false); assert.deepEqual(call.data.p_title_mappings, { '1':IMPORT });
    if (action === 'preview') { assert.deepEqual(payload.rows, payload.preview.rows); assert.equal(payload.rows[0].outcome, 'NEW_RECEIPT'); assert.equal(payload.preview.financial_revision, '17'); }
    else { assert.equal(call.data.p_confirm_corrections, true); assert.equal(call.data.p_file_sha256, createHash('sha256').update(RECEIVED_CSV).digest('hex')); assert.equal(call.data.p_user_id, USER); assert.equal(call.data.p_session_id, SESSION); }
  }
  const app = setup(); assert.equal((await app.send(body('commit', { mode:'received',file_base64:encode(RECEIVED_CSV),title_mappings:{ '1':'NEW' } }))).status, 200); assert.equal(app.calls.at(-1).data.p_confirm_corrections, false);
});

test('open and legacy modes reject receipt columns even when the payment cells are blank, before financial calls', async () => {
  for (const mode of [undefined,'open']) for (const input of [RECEIVED_CSV, [...ERP_HEADER,'Quitação: valor recebido'].join(';')+'\n'+[...ERP_ROW,''].join(';')]) {
    const app = setup(); const response = await app.send(body('preview', { ...(mode ? { mode } : {}),file_base64:encode(input) }));
    assert.equal(response.status, 422); assert.match((await response.json()).errors[0].problem, /Selecione o modo Recebimentos/); assert.equal(app.calls.length, 2);
  }
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('CR');
  sheet.addRow([...ERP_HEADER,{ richText:[{ text:'Quitação: valor recebido' }] }]); sheet.addRow([...ERP_ROW,null]);
  const app = setup(); const response = await app.send(body('preview', { mode:'open',file_name:'modelo.xlsx',file_base64:encode(await workbook.xlsx.writeBuffer()) }));
  assert.equal(response.status, 422); assert.match((await response.json()).errors[0].problem, /colunas de quitação/); assert.equal(app.calls.length, 2);
});

test('missing mode capabilities never fall back to legacy writes and distinguish open from received activation', async () => {
  for (const mode of ['open','received']) for (const options of [{ capabilityError:{ code:'PGRST202',message:'private schema' } },{ capabilityError:{ code:'42883',message:'private function' } },{ capabilities:{ open_sync:mode !== 'open',received_import:mode !== 'received' } }]) {
    const app = setup(options); const response = await app.send(body('commit', { mode,file_base64:encode(mode === 'open' ? OPEN_CSV : RECEIVED_CSV) }));
    assert.equal(response.status, 409); const payload = await response.json(); assert.equal(payload.code, mode === 'open' ? 'P0023' : 'P0024'); assert.match(payload.error, /Ative a atualização/); assert(!payload.error.includes('private'));
    assert.equal(app.calls.length, 3); assert.equal(app.calls.at(-1).path, '/rest/v1/rpc/receivables_import_capabilities');
  }
});

test('new modes require official read/write/import permission before decoding and deny client roles or money', async () => {
  for (const mode of ['open','received']) {
    for (const permissions of [[{ resource:'contas_receber',action:'import' }],['import','read'].map(action => ({ resource:'contas_receber',action }))]) {
      const app = setup({ permissions,role:'gerente_geral' }); const response = await app.send(body('commit', { mode,file_name:'invalido.xlsx',file_base64:'!bad!' }));
      assert.equal(response.status, 403); assert.equal(app.calls.length, 2); assert.equal(app.workbookCalls(), 0);
    }
    for (const extra of [{ role:'gerente_geral' },{ user_id:USER },{ p_rows:[] },{ amount_cents:1 },{ received_amount_cents:1 }]) {
      const app = setup(); const response = await app.send(body('commit', { mode,...extra })); assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
    }
  }
});

test('title mappings, financial revisions and correction approval accept only their explicit bounded contracts', async () => {
  for (const extra of [{ mode:null },{ mode:'paid' },{ title_mappings:{} },{ previous_financial_revision:'17' },{ mode:'open',confirm_corrections:false },{ mode:'received',confirm_corrections:'true' },{ mode:'open',title_mappings:[] },{ mode:'open',title_mappings:{ '0':'NEW' } },{ mode:'open',title_mappings:{ '01':'NEW' } },{ mode:'open',title_mappings:{ '5001':'NEW' } },{ mode:'open',title_mappings:{ '1':'invalid' } },{ mode:'open',title_mappings:{ '1':{ title_id:IMPORT } } }]) {
    const app = setup(); const response = await app.send(body('commit', extra)); assert.equal(response.status, 400,JSON.stringify(extra)); assert.equal(app.calls.length, 2);
  }
  for (const mode of ['open','received']) for (const previous_financial_revision of [undefined,null,'',' 17 ',17,{},'x'.repeat(257)]) {
    const app = setup(); const response = await app.send(body('commit', { mode,previous_financial_revision })); assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
  const app = setup(); const response = await app.send(body('preview', { mode:'open',file_base64:encode(OPEN_CSV),title_mappings:{ '2':'NEW' } })); assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
});

test('received reports reject missing actual fields, bad clocks and invalid precision before capabilities or writes', async () => {
  for (const input of [OPEN_CSV,RECEIVED_CSV.replace('17/10/2026 23:59','17/10/2026 24:00'),RECEIVED_CSV.replace('120,00','0,00'),RECEIVED_CSV.replace('120,00','120,001'),RECEIVED_CSV.replace('Cliente exclusivamente sintético','=1+1')]) {
    const app = setup(); const response = await app.send(body('commit', { mode:'received',file_base64:encode(input) })); assert.equal(response.status, 422); assert.ok((await response.json()).errors.length > 0); assert.equal(app.calls.length, 2);
  }
});

test('new preview envelopes preserve official enriched matches and reject missing revisions or altered source facts', async () => {
  for (const mode of ['open','received']) {
    const request = body('preview', { mode,file_base64:encode(mode === 'open' ? OPEN_CSV : RECEIVED_CSV) });
    const app = setup(); const response = await app.send(request); assert.equal(response.status, 200); const payload = await response.json();
    assert.deepEqual(payload.rows, payload.preview.rows); assert.equal(payload.rows[0].line, 1); assert.equal(payload.rows[0].title_id, null); assert.deepEqual(payload.rows[0].candidates, []);
    for (const update of [{ rows:[] },{ financial_revision:null },{ financial_revision:'' },{ rows:[{ ...payload.rows[0],line:2 }] },{ rows:[{ ...payload.rows[0],title_id:'invalid' }] },{ rows:[{ ...payload.rows[0],amount_cents:1 }] },...(mode === 'received' ? [{ rows:[{ ...payload.rows[0],received_amount_cents:1 }] },{ rows:[{ ...payload.rows[0],received_on:'2026-10-20' }] }] : [])]) {
      const invalid = setup({ previewPayload:{ ...payload.preview,...update } }); const result = await invalid.send(request); assert.equal(result.status, 502); const failure = await result.json(); diagnostic(failure, 'CR_INVALID_PREVIEW', 'preview_validation'); assert(!JSON.stringify(failure).includes('SQL'));
    }
  }
});

test('native XLSX received imports preserve document display zeros and independent amounts and civil dates', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Recebimentos');
  sheet.addRow([...ERP_HEADER,'Quitação: data do recebimento','Quitação: valor recebido']);
  sheet.addRow([ERP_ROW[0],123,125.90,new Date('2026-10-01T23:59:00Z'),new Date('2026-10-20T00:01:00Z'),ERP_ROW[5],new Date('2026-10-17T23:59:00Z'),130]);
  sheet.getCell('B2').numFmt = '000000'; for (const address of ['D2','E2','G2']) sheet.getCell(address).numFmt = 'dd/mm/yyyy hh:mm';
  const bytes = await workbook.xlsx.writeBuffer(), app = setup(); const response = await app.send(body('commit', { mode:'received',file_name:'recebimentos.xlsx',file_base64:encode(bytes) })); assert.equal(response.status, 200);
  const data = app.calls.at(-1).data; assert.equal(data.p_rows[0].document, '000123'); assert.equal(data.p_rows[0].amount_cents, 12590); assert.equal(data.p_rows[0].received_amount_cents, 13000); assert.equal(data.p_rows[0].received_on, '2026-10-17'); assert.equal(data.p_rows[0].due_date, '2026-10-20'); assert.equal(data.p_file_sha256, createHash('sha256').update(bytes).digest('hex'));
  sheet.getCell('B2').numFmt = '0.00'; const invalid = setup(); const bad = await invalid.send(body('preview', { mode:'received',file_name:'documento.xlsx',file_base64:encode(await workbook.xlsx.writeBuffer()) })); assert.equal(bad.status, 422); assert.match((await bad.json()).errors[0].problem, /Formato do identificador não suportado/); assert.equal(invalid.calls.length, 2);
});

test('new mode SQL conflicts and capability denial expose safe guidance without raw database details', async () => {
  for (const code of ['P0023','P0024','40001']) {
    const app = setup({ rpcError:{ code,message:'SECRET SQL',details:SERVICE,hint:TOKEN } }); const response = await app.send(body('commit', { mode:'received',file_base64:encode(RECEIVED_CSV) })); assert.equal(response.status, 409);
    const serialized = JSON.stringify(await response.json()); assert(!serialized.includes('SECRET')); assert(!serialized.includes(SERVICE)); assert(!serialized.includes(TOKEN));
  }
  const app = setup({ capabilityError:{ code:'42501',message:'SECRET SQL' },capabilityStatus:403 }); const response = await app.send(body('preview', { mode:'open',file_base64:encode(OPEN_CSV) })); assert.equal(response.status, 403); assert.equal(app.calls.length, 3);
});

test('activation_required distinguishes missing schema capabilities from financial conflicts using the same safe code', async () => {
  for (const [mode,code] of [['open','P0023'],['received','P0024']]) {
    const request = body('commit', { mode,file_base64:encode(mode === 'open' ? OPEN_CSV : RECEIVED_CSV) });
    const missing = setup({ capabilityError:{ code:'PGRST202' } }); const unavailable = await missing.send(request);
    assert.equal(unavailable.status, 409); const activation = await unavailable.json(); assert.equal(activation.code, code); assert.equal(activation.activation_required, true);
    const conflict = setup({ rpcError:{ code,message:'private SQL' } }); const refused = await conflict.send(request);
    assert.equal(refused.status, 409); const financial = await refused.json(); assert.equal(financial.code, code); assert.equal(Object.hasOwn(financial, 'activation_required'), false);
  }
});

test('collector choices route only explicit open imports through 030 while preserving verified source and actor proof', async () => {
  const collector = '40000000-0000-4000-8000-000000000001';
  const choices = { 'name:CLIENTE EXCLUSIVAMENTE SINTÉTICO': collector };
  for (const action of ['preview', 'commit']) {
    const app = setup(), request = body(action, { mode: 'open', file_base64: encode(OPEN_CSV), title_mappings: { '1': 'NEW' }, collector_mappings: choices });
    const response = await app.send(request); assert.equal(response.status, 200);
    const payload = await response.json(), call = app.calls.at(-1);
    assert.equal(call.path, `/rest/v1/rpc/${action === 'preview' ? 'preview_receivables_open_import_with_collectors' : 'commit_receivables_open_import_with_collectors_from_gateway'}`);
    assert.deepEqual(call.data.p_collector_mappings, choices); assert.deepEqual(call.data.p_title_mappings, { '1': 'NEW' });
    assert.equal(call.data.p_rows[0].client_name, ERP_ROW[0]); assert.equal(call.data.p_rows[0].amount_cents, 12590);
    assert.equal(Object.hasOwn(call.data, 'p_complete'), false); assert.equal(Object.hasOwn(call.data, 'p_confirm_corrections'), false);
    if (action === 'preview') {
      assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(payload.preview.collector_assignment_version, '030');
      assert.equal(payload.preview.customer_collector_assignments[0].collector_id, collector); assert.equal(payload.preview.missing_collector_count, 0); assert.equal(payload.preview.can_commit, true);
      assert.deepEqual(Object.keys(call.data).sort(), ['p_collector_mappings', 'p_rows', 'p_scope', 'p_title_mappings']);
    } else {
      assert.equal(call.init.headers.Authorization, `Bearer ${SERVICE}`); assert.equal(call.data.p_user_id, USER); assert.equal(call.data.p_session_id, SESSION);
      assert.equal(call.data.p_previous_financial_revision, '17'); assert.equal(call.data.p_previous_import_id, null);
      assert.equal(call.data.p_file_sha256, createHash('sha256').update(OPEN_CSV).digest('hex')); assert.equal(call.data.p_file_base64, request.file_base64);
      assert.equal(payload.collector_assignment_version, '030'); assert.equal(payload.assigned_title_count, 1); assert.equal(payload.assigned_customer_count, 1); assert.equal(Object.keys(call.data).length, 11);
    }
  }
});

test('an explicit empty collector selection permits a read-only preview and keeps completion blocked', async () => {
  const app = setup(), response = await app.send(body('preview', { mode: 'open', collector_mappings: {}, file_base64: encode(OPEN_CSV) }));
  assert.equal(response.status, 200); const payload = await response.json();
  assert.equal(payload.preview.missing_collector_count, 1); assert.equal(payload.preview.can_commit, false);
  assert.deepEqual(payload.preview.customer_collector_assignments, [{ customer_key: 'name:CLIENTE EXCLUSIVAMENTE SINTÉTICO', client_name: ERP_ROW[0], client_document: null, collector_id: null, collector_name: null, row_count: 1, requires_selection: true, locked: false }]);
  assert.equal(app.calls.some(call => call.path.includes('/commit_')), false);
});

test('collector selections enforce bounded official keys and UUID values before decoding financial content', async () => {
  const collector = '40000000-0000-4000-8000-000000000001';
  const invalid = [null, [], 'selection', true, { 'name:CLIENTE': 'NEW' }, { 'name:CLIENTE': { id: collector } }, { 'name:CLIENTE': null }, { 'name:CLIENTE': 1 }, { 'name:CLIENTE': ' ' + collector },
    { '': collector }, { 'CLIENTE': collector }, { 'name:': collector }, { 'name: ': collector }, { 'name: CLIENTE': collector }, { 'name:CLIENTE ': collector }, { 'name:CLIENTE\n': collector }, { 'name:CLIENTE\u007f': collector }, { 'name:CLIENTE\u0085': collector }, { ['name:' + 'A'.repeat(1501)]: collector }, { 'cnpj:123': collector }, { 'cnpj:12345678000195x': collector }, { 'cnpj:12.345.678/0001-95': collector }, Object.fromEntries(Array.from({ length: 5001 }, (_, n) => [`name:CLIENTE ${n}`, collector]))];
  const oversized = Object.fromEntries(Array.from({ length: 5000 }, (_, n) => [`name:CLIENTE ${n} ${'A'.repeat(200)}`, collector]));
  assert(new TextEncoder().encode(JSON.stringify(oversized)).byteLength > 1024 * 1024); invalid.push(oversized);
  for (const collector_mappings of invalid) {
    const app = setup(), response = await app.send(body('commit', { mode: 'open', collector_mappings, file_name: 'invalid.xlsx', file_base64: '!bad!' }));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2); assert.equal(app.workbookCalls(), 0);
  }
});

test('legacy requests and received reports cannot carry collector choices, and absent choices preserve old RPCs', async () => {
  for (const mode of [undefined, 'received']) for (const action of ['preview', 'commit']) {
    const app = setup(), response = await app.send(body(action, { ...(mode ? { mode } : {}), collector_mappings: {}, file_base64: encode(mode === 'received' ? RECEIVED_CSV : OPEN_CSV) }));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
  for (const mode of ['open', 'received']) for (const action of ['preview', 'commit']) {
    const app = setup(), response = await app.send(body(action, { mode, file_base64: encode(mode === 'received' ? RECEIVED_CSV : OPEN_CSV) }));
    assert.equal(response.status, 200); assert.equal(Object.hasOwn(app.calls.at(-1).data, 'p_collector_mappings'), false);
    assert.equal(app.calls.at(-1).path.includes('with_collectors'), false);
  }
});

test('missing 030 functions require activation and never retry a permissive earlier import path', async () => {
  for (const action of ['preview', 'commit']) for (const code of ['PGRST202', '42883']) {
    const app = setup({ rpcError: { code, message: 'SECRET SQL', details: SERVICE, hint: TOKEN }, rpcStatus: 404 });
    const response = await app.send(body(action, { mode: 'open', collector_mappings: {}, file_base64: encode(OPEN_CSV) }));
    assert.equal(response.status, 409); const payload = await response.json(); assert.equal(payload.code, 'P0030'); assert.equal(payload.activation_required, true);
    assert.match(payload.error, /Ative a atualização/); assert.equal(app.calls.length, 4); assert(app.calls.at(-1).path.includes('with_collectors'));
    assert(!JSON.stringify({ payload, logs: app.logs }).includes('SECRET')); assert(!JSON.stringify(payload).includes(SERVICE)); assert(!JSON.stringify(payload).includes(TOKEN));
  }
});

test('030 selection conflicts return safe review guidance without falsely requesting schema activation', async () => {
  for (const action of ['preview', 'commit']) {
    const app = setup({ rpcError: { code: 'P0030', message: 'SECRET SQL', details: SERVICE, hint: TOKEN }, rpcStatus: 400 });
    const response = await app.send(body(action, { mode: 'open', collector_mappings: {}, file_base64: encode(OPEN_CSV) }));
    assert.equal(response.status, 409); const payload = await response.json(); assert.equal(payload.code, 'P0030'); assert.equal(Object.hasOwn(payload, 'activation_required'), false);
    assert.match(payload.error, /selecione a responsável/); assert.equal(app.calls.filter(call => call.path.includes('with_collectors')).length, 1);
    assert(!JSON.stringify({ payload, logs: app.logs }).includes('SECRET')); assert(!JSON.stringify(payload).includes(SERVICE)); assert(!JSON.stringify(payload).includes(TOKEN));
  }
});

test('030 preview validates official customer grouping and every assignment field without forwarding malformed envelopes', async () => {
  const request = body('preview', { mode: 'open', collector_mappings: {}, file_base64: encode(OPEN_CSV) }), app = setup();
  const response = await app.send(request); assert.equal(response.status, 200); const good = (await response.json()).preview, assignment = good.customer_collector_assignments[0];
  const updates = [{ collector_assignment_version: undefined }, { collector_assignment_version: '029' }, { customer_collector_assignments: null }, { customer_collector_assignments: [] }, { customer_collector_assignments: [assignment, assignment] }, { missing_collector_count: -1 }, { missing_collector_count: 0 }, { missing_collector_count: 1.5 }, { can_commit: true },
    ...[{ customer_key: 'name:OTHER' }, { client_name: 'Outra origem' }, { client_document: '12345678000195' }, { branch: 'Outra filial' }, { issued_on: '2026-10-02' }].map(update => ({ rows: [{ ...good.rows[0], ...update }] })),
    ...[{ customer_key: 'name:OTHER' }, { client_name: 'Outra origem' }, { client_document: '12345678000195' }, { row_count: 2 }, { row_count: '1' }, { collector_id: 'invalid' }, { collector_name: 'Sem vínculo' }, { requires_selection: 'true' }, { locked: null }].map(update => ({ customer_collector_assignments: [{ ...assignment, ...update }] }))];
  for (const update of updates) {
    const invalid = setup({ previewPayload: { ...good, ...update } }), result = await invalid.send(request);
    assert.equal(result.status, 502); diagnostic(await result.json(), 'CR_INVALID_PREVIEW', 'preview_validation');
  }
});

test('030 groups repeated customers across rows and preserves CNPJ identity and existing locked owners', async () => {
  const collector = '40000000-0000-4000-8000-000000000001', csv = CSV + CSV.split('\r\n')[1].replace('NF-1', 'NF-2') + '\r\n';
  const request = body('preview', { mode: 'open', collector_mappings: { 'cnpj:12345678000195': collector }, file_base64: encode(csv) }), app = setup();
  const response = await app.send(request); assert.equal(response.status, 200); const preview = (await response.json()).preview;
  assert.equal(preview.customer_collector_assignments.length, 1); assert.equal(preview.customer_collector_assignments[0].row_count, 2);
  const locked = setup({ previewPayload: { ...preview, customer_collector_assignments: [{ ...preview.customer_collector_assignments[0], requires_selection: false, locked: true }] } });
  const inherited = await locked.send({ ...request, collector_mappings: {} }); assert.equal(inherited.status, 200);
  assert.equal((await inherited.json()).preview.customer_collector_assignments[0].locked, true);
});

test('030 does not relax source limits, authenticated permissions, or financial revision fences', async () => {
  for (const extra of [{ file_base64: encode(Buffer.alloc(2 * 1024 * 1024 + 1)) }, { previous_financial_revision: null }, { complete: false }, { p_user_id: USER }]) {
    const app = setup(), response = await app.send(body('commit', { mode: 'open', collector_mappings: {}, file_base64: encode(OPEN_CSV), ...extra }));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
  const app = setup({ permissions: [{ resource: 'contas_receber', action: 'import' }] }), response = await app.send(body('commit', { mode: 'open', collector_mappings: {}, file_name: 'bad.xlsx', file_base64: '!bad!' }));
  assert.equal(response.status, 403); assert.equal(app.calls.length, 2); assert.equal(app.workbookCalls(), 0);
});

test('030 commit requires its assignment version and safe outcome counters before claiming success', async () => {
  const request = body('commit', { mode: 'open', collector_mappings: {}, file_base64: encode(OPEN_CSV) });
  const good = { mode: 'open', import_id: IMPORT, row_count: 1, collector_assignment_version: '030', assigned_title_count: 1, assigned_customer_count: 1 };
  for (const update of [{ collector_assignment_version: undefined }, { collector_assignment_version: '029' }, { assigned_title_count: -1 }, { assigned_customer_count: 2 }, { assigned_title_count: Number.MAX_SAFE_INTEGER + 1 }, { assigned_customer_count: '1' }]) {
    const app = setup({ commitPayload: { ...good, ...update } }), response = await app.send(request);
    assert.equal(response.status, 502); diagnostic(await response.json(), 'CR_INVALID_RESPONSE', 'commit_validation'); assert.equal(app.calls.filter(call => call.path.includes('/commit_')).length, 1);
  }
});

test('bounded request deadline identifies the exact HTTP phase without leaking request or upstream content', async () => {
  for (const [action, path, stage] of [
    ['preview', '/auth/v1/user', 'authenticate'],
    ['preview', '/rest/v1/rpc/preview_receivables_received_import', 'preview'],
    ['commit', '/rest/v1/rpc/commit_receivables_received_import_from_gateway', 'commit'],
  ]) {
    const app = setup({ requestTimeoutMs: 20, delayAtPath: path });
    const response = await app.send(body(action, { mode: 'received', file_base64: encode(RECEIVED_CSV), title_mappings: { '1': 'NEW' } }));
    assert.equal(response.status, 504); const payload = await response.json(); diagnostic(payload, 'CR_REQUEST_TIMEOUT', stage);
    assert.equal(app.logs.length, 1); const event = app.logs[0];
    assert.deepEqual(Object.keys(event).sort(), ['code', 'elapsed_ms', 'event', 'request_id', 'stage']);
    assert.equal(event.request_id, payload.request_id); assert.equal(event.stage, stage); assert.equal(event.code, payload.code);
    assert(Number.isSafeInteger(event.elapsed_ms) && event.elapsed_ms >= 0);
    assert(!JSON.stringify({ payload, event }).includes('Private')); assert(!JSON.stringify({ payload, event }).includes(SERVICE));
    if (action === 'commit') assert.equal(app.calls.filter(call => call.path.includes('/commit_')).length, 1);
  }
});

test('database cancellation and lock deadlines keep safe diagnostic codes instead of becoming unknown 503s', async () => {
  for (const [code, status] of [['57014', 504], ['55P03', 503]]) {
    const app = setup({ rpcError: { code, message: 'SECRET query and invoice', details: SERVICE, hint: TOKEN }, rpcStatus: 500 });
    const response = await app.send(body('preview', { mode: 'received', file_base64: encode(RECEIVED_CSV) }));
    assert.equal(response.status, status); const payload = await response.json(); diagnostic(payload, code, 'preview');
    assert(!JSON.stringify({ payload, logs: app.logs }).includes('SECRET')); assert(!JSON.stringify({ payload, logs: app.logs }).includes(TOKEN));
  }
});

test('received RPC absence differs from financial mapping conflicts without exposing SQL signatures', async () => {
  for (const action of ['preview', 'commit']) for (const code of ['PGRST202', '42883', '42P01']) {
    const app = setup({ rpcError: { code, message: 'SECRET missing SQL signature', details: SERVICE }, rpcStatus: 404 });
    const response = await app.send(body(action, { mode: 'received', file_base64: encode(RECEIVED_CSV), title_mappings: { '1': 'NEW' } }));
    assert.equal(response.status, 409); const payload = await response.json(); diagnostic(payload, code, action);
    assert.equal(payload.activation_required, true); assert(!JSON.stringify(payload).includes('SECRET')); assert(!JSON.stringify(payload).includes(SERVICE));
  }
});

test('upstream HTTP timeouts, rate limits and invalid mapping payloads have separate bounded codes', async () => {
  for (const [status, expected, code] of [[504, 504, 'CR_UPSTREAM_TIMEOUT'], [429, 429, 'CR_RATE_LIMITED']]) {
    const app = setup({ rpcError: { message: 'SECRET private upstream content' }, rpcStatus: status });
    const response = await app.send(body('preview', { mode: 'received', file_base64: encode(RECEIVED_CSV) }));
    assert.equal(response.status, expected); diagnostic(await response.json(), code, 'preview');
  }
  const app = setup(); const response = await app.send(body('preview', { mode: 'received', title_mappings: { '01': 'NEW' }, file_base64: encode(RECEIVED_CSV) }));
  assert.equal(response.status, 400); diagnostic(await response.json(), 'CR_REQUEST_INVALID', 'request');
  assert.equal(app.calls.some(call => call.path.includes('/preview_') || call.path.includes('/commit_')), false);
});
