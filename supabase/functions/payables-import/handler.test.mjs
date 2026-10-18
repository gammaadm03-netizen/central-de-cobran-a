import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createPayablesGateway } from './handler.mjs';
import { isChequeNumberHeader, readPayableChequeCell } from '../../../src/lib/payables-parser.mjs';

const USER = '10000000-0000-4000-8000-000000000001';
const SESSION = '20000000-0000-4000-8000-000000000001';
const IMPORT = '30000000-0000-4000-8000-000000000001';
const BANK = '40000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://central.example.invalid';
const BASE = 'https://project.example.invalid';
const ANON = 'synthetic-public-key';
const SERVICE = 'synthetic-server-only-key';
const jwt = claims => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: USER, session_id: SESSION, ...claims })).toString('base64url')}.verified-only-by-auth`;
const TOKEN = jwt({});
const CSV = 'Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Filial;Emissão;Banco;Situação\r\nABC-1;Fornecedor sintético;16/10/2026;1.234,56;INVESTIMENTOS;2 - TESTE;01/10/2026;Banco teste;Pendente\r\n';
const PAID_CSV = 'Lançamento;Filial;Emissão: valor do lançamento;Plano cc - Conta: nome;Vencimento: data;Situação;Cheque: número;Histórico;Plano cp - Conta: nome;Emissão: data\r\nABC-1;2 - TESTE;1.234,56;Banco teste;17/10/2026 23:59;PAGO;000123;Histórico atualizado;INVESTIMENTOS;01/10/2026 15:03\r\n';
const encode = value => Buffer.from(value).toString('base64');
const body = (action = 'preview', extra = {}) => ({ action, file_name: 'grupo.csv', file_base64: encode(CSV), ...(action === 'commit' ? { complete: true, mappings: { INVESTIMENTOS: 'VARIÁVEL' }, previous_import_id: null, ...(extra.mode === 'payments' ? { previous_financial_revision:'17' } : {}) } : {}), ...extra });
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
    const chequeColumns = [];
    sheet.getRow(1).eachCell((cell, column) => { if (isChequeNumberHeader(cell.value)) chequeColumns.push(column); });
    for (let i = 1; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i), values = row.values.slice(1);
      if (i > 1) for (const column of chequeColumns) { const cell = row.getCell(column); values[column - 1] = readPayableChequeCell(cell.value, cell.numFmt); }
      matrix.push(values);
    }
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
      return json({ profile: { id: USER, enabled: options.enabled ?? true, role_key: options.role ?? 'contas_pagar' }, permissions: options.permissions ?? ['import', 'read', 'write'].map(action => ({ resource: 'contas_pagar', action })) });
    }
    if (path === '/rest/v1/rpc/payables_import_capabilities') {
      assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (options.capabilityError) return json(options.capabilityError, options.capabilityStatus ?? 404);
      return json(options.capabilities ?? { cheque_number:true, forecast_incremental:true, paid_import:true });
    }
    if (['/rest/v1/rpc/preview_payables_import', '/rest/v1/rpc/preview_payables_forecast_import', '/rest/v1/rpc/preview_payables_paid_import'].includes(path)) {
      assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
      if (options.previewPayload) return json(options.previewPayload);
      if (path.endsWith('/preview_payables_paid_import')) return json({ mode:'payments', previous_import_id:null, financial_revision:'17', row_count:data.p_rows.length, rows:data.p_rows.map((row, index) => ({ ...row, line:index+1, title_id:IMPORT, outcome:'NEW_PAYMENT', forecast_due_date:'2026-10-10', bank_mapping_key:JSON.stringify([row.branch.toUpperCase(), row.paid_bank.toUpperCase()]), bank_account_id:BANK, title_amount_cents:row.amount_paid_cents, problem:'' })), new_payment_count:data.p_rows.length, matched_payment_count:0, correction_count:0, conflict_count:0, errors:[], unmapped_banks:[], bank_options:[], unclassified_plans:[], can_commit:true });
      return json({ previous_import_id: null, row_count: data.p_rows.length, new_count: data.p_rows.length, open_count: 0, settled_count: 0, ...(path.endsWith('/preview_payables_forecast_import') ? { mode:'forecast', changed_count:0 } : {}) });
    }
    if (['/rest/v1/rpc/commit_payables_import_from_gateway', '/rest/v1/rpc/commit_payables_forecast_import_from_gateway', '/rest/v1/rpc/commit_payables_paid_import_from_gateway'].includes(path)) {
      assert.equal(init.headers.apikey, SERVICE); assert.equal(init.headers.Authorization, `Bearer ${SERVICE}`);
      if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
      return json(options.commitPayload ?? { import_id: IMPORT, row_count: data.p_rows.length, new_count: data.p_rows.length, open_count: 0, settled_count: 0, ...(path.endsWith('/commit_payables_forecast_import_from_gateway') ? { mode:'forecast' } : path.endsWith('/commit_payables_paid_import_from_gateway') ? { mode:'payments' } : {}) });
    }
    throw new Error('Unexpected upstream path');
  };
  const settings = { ALLOWED_ORIGINS: ORIGIN, SUPABASE_URL: BASE, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, ...options.env };
  const handle = createPayablesGateway({ env: name => settings[name], fetch: fetcher, loadWorkbook: async value => { workbookCalls++; return loader(value); }, log: message => logs.push(message) });
  const send = (data = body(), changes = {}) => handle(new Request(`${BASE}/functions/v1/payables-import`, {
    method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...changes.headers },
    body: JSON.stringify(data),
  }));
  return { calls, logs, handle, send, workbookCalls: () => workbookCalls };
}

async function xlsx() {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('CP');
  sheet.addRow(['Lançamento', 'Histórico', 'Vencimento', 'Valor', 'Plano de Contas', 'Filial']);
  sheet.addRow(['ABC-2', 'Fornecedor da planilha', new Date('2026-10-17T00:00:00.000Z'), 42.37, 'INVESTIMENTOS', '3 - TESTE']);
  return workbook.xlsx.writeBuffer();
}

test('preview derives canonical financial rows, hash and fixed scope from actual CSV bytes', async () => {
  const app = setup(); const response = await app.send();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  const payload = await response.json();
  assert.equal(payload.file_sha256, createHash('sha256').update(CSV).digest('hex'));
  assert.deepEqual(payload.rows, [{ entry_number: 'ABC-1', description: 'Fornecedor sintético', due_date: '2026-10-16', amount_cents: 123456, plan: 'INVESTIMENTOS', bank_account: 'Banco teste', branch: '2 - TESTE', issued_on: '2026-10-01', source_status: 'Pendente' }]);
  assert.equal(payload.preview.row_count, 1);
  assert.deepEqual(app.calls.map(call => call.path), ['/auth/v1/user', '/rest/v1/rpc/current_access', '/rest/v1/rpc/preview_payables_import']);
  assert.deepEqual(app.calls.at(-1).data, { p_scope: 'grupo-consolidado', p_rows: payload.rows });
  assert.equal(app.workbookCalls(), 0);
});

test('commit reparses bytes and forwards only verified identity and derived rows to service-only RPC', async () => {
  const app = setup(); const request = body('commit'); const response = await app.send(request);
  assert.equal(response.status, 200); assert.equal((await response.json()).import_id, IMPORT);
  const call = app.calls.at(-1);
  assert.equal(call.path, '/rest/v1/rpc/commit_payables_import_from_gateway');
  assert.equal(call.data.p_user_id, USER); assert.equal(call.data.p_session_id, SESSION);
  assert.equal(call.data.p_scope, 'grupo-consolidado'); assert.equal(call.data.p_rows[0].amount_cents, 123456);
  assert.equal(call.data.p_file_sha256, createHash('sha256').update(CSV).digest('hex'));
  assert.equal(call.data.p_file_base64, request.file_base64); assert.equal(call.data.p_file_name, 'grupo.csv');
  assert.deepEqual(call.data.p_mappings, { INVESTIMENTOS: 'VARIÁVEL' }); assert.equal(call.data.p_complete, true);
  assert.equal(call.data.p_previous_import_id, null);
});

test('browser cannot supply parsed rows, identity, role, hash or alternative scopes', async () => {
  for (const extra of [{ p_rows: [] }, { rows: [] }, { role: 'gerente_geral' }, { user_id: USER }, { session_id: SESSION }, { file_sha256: '0'.repeat(64) }, { scope: 'alternative' }]) {
    const app = setup(); const response = await app.send(body('commit', extra));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
});

test('unauthorized, disabled and recovery-only sessions are rejected before decoding or workbook parsing', async () => {
  for (const options of [{ permissions: [{ resource: 'contas_pagar', action: 'read' }], role: 'diretor' }, { permissions: [{ resource: 'contas_receber', action: 'import' }] }, { enabled: false }, { accessError: { code: '42501', message: 'private SQL detail' } }]) {
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

test('commit requires explicit completeness, bounded string mappings and a valid previous import token', async () => {
  for (const extra of [{ complete: false }, { complete: 'true' }, { mappings: [] }, { mappings: { PLAN: { macro: 'FIXO' } } }, { mappings: { '': 'FIXO' } }, { previous_import_id: 'invalid' }, { previous_import_id: undefined }]) {
    const app = setup(); assert.equal((await app.send(body('commit', extra))).status, 400); assert.equal(app.calls.length, 2);
  }
});

test('unrelated bytes, malformed dates, missing headers, invalid UTF8 and formulas cause no financial write', async () => {
  for (const input of ['this is not a financial CSV', CSV.replace('16/10/2026', '31/02/2026'), CSV.replace('Plano de Contas', 'Missing'), CSV.replace('Fornecedor sintético', '=1+1'), '"unclosed', Buffer.from([0xff, 0xfe, 0x00])]) {
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
  for (const [code, expected] of [['23505', 409], ['P0016', 409], ['P0019', 409], ['P0021', 409], ['40001', 409], ['42501', 403], ['22023', 400], ['23514', 400]]) {
    const app = setup({ rpcError: { code, message: 'SQL query containing private details', details: SERVICE, hint: TOKEN } });
    const response = await app.send(body('commit')); assert.equal(response.status, expected);
    const payload = await response.json(); assert.equal(payload.code, code); assert(!JSON.stringify(payload).includes('private')); assert(!JSON.stringify(payload).includes(SERVICE)); assert(!JSON.stringify(payload).includes(TOKEN));
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
  const response = await app.handle(new Request(`${BASE}/functions/v1/payables-import`, { method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': '1' }, body: stream, duplex: 'half' }));
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


test('ERP column names preserve account, cost plan and civil dates when the original XLSX includes hours', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('CP');
  sheet.addRow(['Lançamento', 'Histórico', 'Plano cp - Conta: nome', 'Plano cc - Conta: nome', 'Emissão: valor do lançamento', 'Emissão: data', 'Vencimento: data', 'Filial', 'Situação']);
  sheet.addRow(['ERP-TESTE-1', 'Fornecedor exclusivamente sintético', 'PLANO DO TESTE', 'CONTA BANCÁRIA DO TESTE', 123.45, new Date('2026-10-01T15:03:00Z'), new Date('2026-10-17T00:00:00Z'), 'FILIAL TESTE', 'CHEQUE']);
  sheet.addRow(['ERP-TESTE-2', 'Outro fornecedor sintético', 'PLANO DO TESTE', 'OUTRA CONTA SINTÉTICA', 50, new Date('2026-10-02T23:59:00Z'), new Date('2026-10-18T00:00:00Z'), 'OUTRA FILIAL TESTE', 'ABERTO']);
  sheet.getRow(3).hidden = true;
  for (const address of ['F2', 'G2', 'F3', 'G3']) sheet.getCell(address).numFmt = 'dd/mm/yyyy hh:mm';
  const bytes = await workbook.xlsx.writeBuffer(); const app = setup();
  const response = await app.send(body('commit', { file_name: 'modelo-erp.xlsx', file_base64: encode(bytes), mappings: { 'PLANO DO TESTE': 'FIXO' } }));
  assert.equal(response.status, 200);
  assert.equal(app.calls.at(-1).data.p_rows.length, 2);
  assert.equal(app.calls.at(-1).data.p_rows[1].branch, 'OUTRA FILIAL TESTE');
  assert.equal(app.calls.at(-1).data.p_rows[1].issued_on, '2026-10-02');
  const derived = app.calls.at(-1).data.p_rows[0];
  assert.deepEqual(derived, { entry_number: 'ERP-TESTE-1', description: 'Fornecedor exclusivamente sintético', plan: 'PLANO DO TESTE', bank_account: 'CONTA BANCÁRIA DO TESTE', amount_cents: 12345, issued_on: '2026-10-01', due_date: '2026-10-17', branch: 'FILIAL TESTE', source_status: 'CHEQUE' });
  assert.equal(app.calls.at(-1).data.p_file_base64, encode(bytes));
  assert.equal(app.calls.at(-1).data.p_file_sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('malformed ERP timestamps and missing branch reject all rows before a financial RPC', async () => {
  const headings = 'Lançamento;Histórico;Plano cp - Conta: nome;Plano cc - Conta: nome;Emissão: valor do lançamento;Emissão: data;Vencimento: data;Filial;Situação';
  const valid = 'ERP-TESTE-1;Fornecedor sintético;PLANO;CONTA TESTE;123,45;01/10/2026 15:03;17/10/2026 00:00;FILIAL TESTE;ABERTO';
  for (const invalid of [valid.replace('15:03', '24:03'), valid.replace('17/10/2026', '31/02/2026')]) {
    const app = setup(); const response = await app.send(body('commit', { file_base64: encode(headings + '\r\n' + valid + '\r\n' + invalid.replace('ERP-TESTE-1', 'ERP-TESTE-2')) }));
    assert.equal(response.status, 422); const payload = await response.json();
    assert.equal(payload.errors[0].line, 3); assert(payload.errors[0].problem.includes('inválido') || payload.errors[0].problem.includes('inexistente')); assert.equal(app.calls.length, 2);
  }
  const app = setup(); const noBranch = headings.replace(';Filial', '') + '\r\n' + valid.replace(';FILIAL TESTE', '');
  const response = await app.send(body('commit', { file_base64: encode(noBranch) }));
  assert.equal(response.status, 422); assert.equal((await response.json()).errors.find(error => error.column === 'Filial').problem, 'Coluna obrigatória ausente.'); assert.equal(app.calls.length, 2);
});

test('explicit forecast mode requires its capability and routes preview and commit without absence settlement', async () => {
  for (const action of ['preview', 'commit']) {
    const app = setup(); const response = await app.send(body(action, { mode:'forecast' }));
    assert.equal(response.status, 200); const payload = await response.json(); assert.equal(action === 'preview' ? payload.preview.mode : payload.mode, 'forecast');
    assert.deepEqual(app.calls.map(call => call.path), ['/auth/v1/user', '/rest/v1/rpc/current_access', '/rest/v1/rpc/payables_import_capabilities', `/rest/v1/rpc/${action === 'preview' ? 'preview_payables_forecast_import' : 'commit_payables_forecast_import_from_gateway'}`]);
    assert.equal(Object.hasOwn(app.calls.at(-1).data, 'p_complete'), false);
    assert.equal(Object.hasOwn(app.calls.at(-1).data, 'p_bank_mappings'), false);
  }
});

test('paid mode reparses actual value/date/bank and optional ERP metadata, forwarding only verified session and mappings', async () => {
  const bankMappings = { '["2 - TESTE","BANCO TESTE"]':BANK };
  for (const action of ['preview', 'commit']) {
    const app = setup(); const response = await app.send(body(action, { mode:'payments', file_base64:encode(PAID_CSV), bank_mappings:bankMappings, mappings:{ INVESTIMENTOS:'VARIÁVEL' }, ...(action === 'commit' ? { confirm_corrections:true } : {}) }));
    assert.equal(response.status, 200);
    const call = app.calls.at(-1);
    assert.equal(call.path, `/rest/v1/rpc/${action === 'preview' ? 'preview_payables_paid_import' : 'commit_payables_paid_import_from_gateway'}`);
    assert.deepEqual(call.data.p_bank_mappings, bankMappings);
    assert.deepEqual(call.data.p_mappings, { INVESTIMENTOS:'VARIÁVEL' });
    assert.deepEqual(call.data.p_rows, [{ branch:'2 - TESTE', entry_number:'ABC-1', source_status:'PAGO', paid_on:'2026-10-17', amount_paid_cents:123456, paid_bank:'Banco teste', cheque_number:'000123', description:'Histórico atualizado', plan:'INVESTIMENTOS', issued_on:'2026-10-01' }]);
    assert.equal(Object.hasOwn(call.data.p_rows[0], 'due_date'), false);
    assert.equal(Object.hasOwn(call.data, 'p_complete'), false);
    if (action === 'commit') {
      assert.equal(call.data.p_user_id, USER); assert.equal(call.data.p_session_id, SESSION); assert.equal(call.data.p_confirm_corrections, true);
      assert.equal(call.data.p_file_sha256, createHash('sha256').update(PAID_CSV).digest('hex'));
    }
  }
});

test('paid preview returns enriched official title matches to the interface and validates their identity and length', async () => {
  const request = body('preview', { mode:'payments', file_base64:encode(PAID_CSV) });
  const app = setup(); const response = await app.send(request);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.rows, payload.preview.rows);
  assert.equal(payload.rows[0].line, 1);
  assert.equal(payload.rows[0].outcome, 'NEW_PAYMENT');
  assert.equal(payload.rows[0].title_id, IMPORT);
  assert.equal(payload.rows[0].forecast_due_date, '2026-10-10');
  assert.equal(payload.rows[0].paid_on, '2026-10-17');
  assert.equal(payload.rows[0].bank_mapping_key, '["2 - TESTE","BANCO TESTE"]');
  assert.equal(payload.rows[0].bank_account_id, BANK);
  for (const rows of [[], [{ ...payload.rows[0], line:2 }], [{ ...payload.rows[0], title_id:'invalid' }], [{ ...payload.rows[0], outcome:'UNRECOGNIZED' }], [{ ...payload.rows[0], amount_paid_cents:1 }]]) {
    const malformed = setup({ previewPayload:{ ...payload.preview, rows } });
    const result = await malformed.send(request);
    assert.equal(result.status, 503);
    assert.equal(malformed.calls.at(-1).path, '/rest/v1/rpc/preview_payables_paid_import');
  }
});

test('paid mode permits an explicitly declared paid report without optional fields and never assumes correction approval', async () => {
  const minimal = 'Lançamento;Filial;Emissão: valor do lançamento;Plano cc - Conta: nome;Vencimento: data\nABC-1;2 - TESTE;1.234,56;Banco teste;17/10/2026 00:00';
  const request = body('commit', { mode:'payments', file_base64:encode(minimal) }); delete request.mappings;
  const app = setup(); const response = await app.send(request);
  assert.equal(response.status, 200);
  const call = app.calls.at(-1);
  assert.deepEqual(call.data.p_mappings, {}); assert.deepEqual(call.data.p_bank_mappings, {}); assert.equal(call.data.p_confirm_corrections, false);
  assert.equal(call.data.p_previous_financial_revision, '17');
  assert.deepEqual(call.data.p_rows[0], { branch:'2 - TESTE', entry_number:'ABC-1', source_status:'PAGO', paid_on:'2026-10-17', amount_paid_cents:123456, paid_bank:'Banco teste' });
});

test('missing 021 or 019 capabilities block only affected formats and never fall back to legacy writes', async () => {
  for (const mode of ['forecast', 'payments']) {
    for (const options of [{ capabilityError:{ code:'PGRST202', message:'private schema' } }, { capabilityError:{ code:'42883', message:'private query' } }, { capabilities:{ cheque_number:true } }]) {
      const app = setup(options); const response = await app.send(body('commit', { mode, ...(mode === 'payments' ? { file_base64:encode(PAID_CSV) } : {}) }));
      assert.equal(response.status, 409); assert.equal((await response.json()).code, 'P0021');
      assert.equal(app.calls.length, 3); assert.equal(app.calls.at(-1).path, '/rest/v1/rpc/payables_import_capabilities');
    }
  }
  const withCheque = CSV.replace(';Situação\r\n', ';Situação;Cheque: número\r\n').replace(';Pendente\r\n', ';Pendente;000123\r\n');
  for (const options of [{ capabilityError:{ code:'PGRST202' } }, { capabilities:{ cheque_number:false } }]) {
    const app = setup(options); const response = await app.send(body('commit', { file_base64:encode(withCheque) }));
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'P0019'); assert.equal(app.calls.length, 3);
  }
  const upgraded = setup({ capabilities:{ cheque_number:true } });
  assert.equal((await upgraded.send(body('commit', { file_base64:encode(withCheque) }))).status, 200);
  assert.equal(upgraded.calls.at(-1).path, '/rest/v1/rpc/commit_payables_import_from_gateway');
  assert.equal(upgraded.calls.at(-1).data.p_rows[0].cheque_number, '000123');
});

test('paid mode validates official write permission before decoding and rejects forged roles in every mode', async () => {
  for (const permissions of [[{ resource:'contas_pagar', action:'import' }], ['import', 'read'].map(action => ({ resource:'contas_pagar', action }))]) {
    const app = setup({ permissions, role:'gerente_geral' });
    const response = await app.send(body('commit', { mode:'payments', file_name:'invalid.xlsx', file_base64:'bad' }));
    assert.equal(response.status, 403); assert.equal(app.calls.length, 2); assert.equal(app.workbookCalls(), 0);
  }
  for (const mode of ['forecast', 'payments']) {
    const app = setup(); const response = await app.send(body('commit', { mode, role:'gerente_geral' }));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
});

test('mode-specific bank and plan mappings and correction confirmations are bounded and typed', async () => {
  for (const extra of [{ mode:null }, { mode:'paid' }, { mode:'forecast', bank_mappings:{} }, { mode:'forecast', confirm_corrections:false }, { mode:'payments', bank_mappings:[] }, { mode:'payments', bank_mappings:{ BANK:'not-a-uuid' } }, { mode:'payments', bank_mappings:{ '':BANK } }, { mode:'payments', confirm_corrections:'true' }, { mode:'payments', mappings:{ PLAN:{ macro:'FIXO' } } }]) {
    const app = setup(); const response = await app.send(body('commit', extra));
    assert.equal(response.status, 400, JSON.stringify(extra)); assert.equal(app.calls.length, 2);
  }
});

test('paid report rejects unpaid/canceled rows and invalid proof before capabilities or financial writes', async () => {
  for (const input of [PAID_CSV.replace(';PAGO;', ';ABERTO;'), PAID_CSV.replace(';PAGO;', ';CANCELADO;'), PAID_CSV.replace(';PAGO;', ';BAIXADO;'), PAID_CSV.replace('17/10/2026 23:59', '17/10/2026 24:00'), PAID_CSV.replace('1.234,56', '0,00'), PAID_CSV.replace('Banco teste;', ';')]) {
    const app = setup(); const response = await app.send(body('commit', { mode:'payments', file_base64:encode(input) }));
    assert.equal(response.status, 422); const payload = await response.json();
    assert.ok(payload.errors.length > 0); assert.ok(!payload.errors.some(error => error.problem.includes('SQL'))); assert.equal(app.calls.length, 2);
  }
});

test('server workbook adapter preserves numeric cheque display zeros and rejects unsupported numeric/date formats safely', async () => {
  for (const [format, value, expected] of [['000000', 123, '000123'], ['General', '000123', '000123'], ['0.00', 123, null], ['dd/mm/yyyy', 123, null]]) {
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('CP');
    sheet.addRow(['Lançamento','Filial','Emissão: valor do lançamento','Plano cc - Conta: nome','Vencimento: data','Cheque: número']);
    sheet.addRow(['ABC-1','2 - TESTE',123.45,'Banco teste',new Date('2026-10-17T23:59:00Z'),value]);
    sheet.getCell('E2').numFmt = 'dd/mm/yyyy hh:mm'; sheet.getCell('F2').numFmt = format;
    const app = setup(); const response = await app.send(body('commit', { mode:'payments', file_name:'cheques.xlsx', file_base64:encode(await workbook.xlsx.writeBuffer()) }));
    assert.equal(response.status, expected ? 200 : 422);
    if (expected) { assert.equal(app.calls.at(-1).data.p_rows[0].cheque_number, expected); assert.equal(app.calls.at(-1).data.p_rows[0].paid_on, '2026-10-17'); }
    else { assert.match((await response.json()).errors[0].problem, /Formato da célula do cheque não suportado/); assert.equal(app.calls.length, 2); }
  }
});

test('explicit forecast response cannot claim disappearance settlements and capability authorization errors remain denied', async () => {
  const app = setup({ previewPayload:{ mode:'forecast', previous_import_id:null, row_count:1, new_count:1, open_count:0, settled_count:1 } });
  const response = await app.send(body('preview', { mode:'forecast' }));
  assert.equal(response.status, 503); assert(!JSON.stringify(await response.json()).includes('SQL'));
  const denied = setup({ capabilityError:{ code:'42501', message:'private SQL' }, capabilityStatus:403 });
  const forbidden = await denied.send(body('preview', { mode:'forecast' }));
  assert.equal(forbidden.status, 403); assert.equal(denied.calls.length, 3); assert(!JSON.stringify(await forbidden.json()).includes('private SQL'));
});

test('paid commit carries the official preview financial revision and rejects invalid revision inputs or unrelated modes', async () => {
  const app = setup(); const previewResponse = await app.send(body('preview', { mode:'payments', file_base64:encode(PAID_CSV) }));
  assert.equal(previewResponse.status, 200); const preview = await previewResponse.json();
  assert.equal(preview.preview.financial_revision, '17');
  const committed = await app.send(body('commit', { mode:'payments', file_base64:encode(PAID_CSV), previous_financial_revision:preview.preview.financial_revision }));
  assert.equal(committed.status, 200); assert.equal(app.calls.at(-1).data.p_previous_financial_revision, '17');
  for (const previous_financial_revision of [undefined, null, '', ' 17 ', 17, false, {}, 'x'.repeat(257)]) {
    const invalid = setup(); const response = await invalid.send(body('commit', { mode:'payments', file_base64:encode(PAID_CSV), previous_financial_revision }));
    assert.equal(response.status, 400); assert.equal(invalid.calls.length, 2);
  }
  for (const financial_revision of [undefined, null, '', 'x'.repeat(257)]) {
    const invalid = setup({ previewPayload:{ ...preview.preview, financial_revision } });
    const response = await invalid.send(body('preview', { mode:'payments', file_base64:encode(PAID_CSV) }));
    assert.equal(response.status, 503); assert.equal(invalid.calls.at(-1).path, '/rest/v1/rpc/preview_payables_paid_import');
  }
  for (const mode of [undefined, 'forecast']) {
    const invalid = setup(); const response = await invalid.send(body('commit', { ...(mode ? { mode } : {}), previous_financial_revision:'17' }));
    assert.equal(response.status, 400); assert.equal(invalid.calls.length, 2);
  }
});
