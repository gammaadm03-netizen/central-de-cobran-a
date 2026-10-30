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
const PAYMENT_DATE_VERSION = '2026-10-27.1';
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
    const parsedUrl = new URL(url), path = parsedUrl.pathname;
    const data = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, data, init, search: parsedUrl.search });
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
    if (path === '/rest/v1/payable_paid_import_rows') {
      assert.equal(init.method, 'GET'); assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(init.body, undefined); assert.equal(parsedUrl.searchParams.get('select'), 'source_row');
      assert.equal(parsedUrl.searchParams.get('import_id'), 'eq.' + IMPORT); assert.equal(parsedUrl.searchParams.get('order'), 'title_id.asc');
      assert.equal(parsedUrl.searchParams.get('limit'), '500');
      if (options.historyFailure) return json({ message: 'private history SQL, token and bank' }, options.historyFailure);
      if (Object.hasOwn(options, 'historyPayload')) return json(options.historyPayload);
      const offset = Number(parsedUrl.searchParams.get('offset'));
      return json((options.historyRows ?? []).slice(offset, offset + 500));
    }
    if (path === '/rest/v1/rpc/payables_import_capabilities') {
      assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (options.capabilityError) return json(options.capabilityError, options.capabilityStatus ?? 404);
      return json(options.capabilities ?? { cheque_number:true, forecast_incremental:true, paid_import:true, import_reconciliation:true, reconciliation_version:'043' });
    }
    if (['/rest/v1/rpc/preview_payables_import', '/rest/v1/rpc/preview_payables_forecast_import', '/rest/v1/rpc/preview_payables_paid_import', '/rest/v1/rpc/preview_payables_forecast_import_v2', '/rest/v1/rpc/preview_payables_paid_import_v2'].includes(path)) {
      assert.equal(init.headers.apikey, ANON); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
      if (options.previewPayload) return json(options.previewPayload);
      const defaultDecisions = Object.entries(data.p_resolution_choices ?? {}).map(([key,choice]) => ({ key,kind:'MISSING',line:null,title_id:key.slice(6),branch:'Filial sintética',entry_number:'AUSENTE-SINTETICO',description:'Título sintético ausente',due_date:'2026-10-18',amount_cents:10000,allowed_actions:['PAID','WRITE_OFF'],selected_action:choice.action,requires_resolution:true,problem:null }));
      const reconciliation = path.endsWith('_v2') ? { reconciliation_version:'043', financial_revision:'17', full_report:data.p_full_report ?? false, reconciliation_items:options.reconciliationItems ?? defaultDecisions, resolution_errors:[], can_commit:options.reconciliationCanCommit ?? true, bank_accounts:[] } : {};
      if (path.includes('/preview_payables_paid_import')) return json({ mode:'payments', previous_import_id:null, financial_revision:'17', row_count:data.p_rows.length, rows:data.p_rows.map((row, index) => ({ ...row, line:index+1, title_id:IMPORT, outcome:options.paidOutcome ?? 'NEW_PAYMENT', forecast_due_date:'2026-10-10', bank_mapping_key:JSON.stringify([row.branch.toUpperCase(), row.paid_bank.toUpperCase()]), bank_account_id:BANK, title_amount_cents:row.amount_paid_cents, problem:'' })), new_payment_count:data.p_rows.length, matched_payment_count:0, correction_count:0, conflict_count:0, errors:[], unmapped_banks:[], bank_options:[], unclassified_plans:[], can_commit:true, ...reconciliation });
      return json({ previous_import_id: null, row_count: data.p_rows.length, new_count: data.p_rows.length, open_count: 0, settled_count: 0, ...(path.includes('/preview_payables_forecast_import') ? { mode:'forecast', changed_count:0 } : {}), ...reconciliation });
    }
    if (['/rest/v1/rpc/commit_payables_import_from_gateway', '/rest/v1/rpc/commit_payables_forecast_import_from_gateway', '/rest/v1/rpc/commit_payables_paid_import_from_gateway', '/rest/v1/rpc/commit_payables_forecast_import_v2_from_gateway', '/rest/v1/rpc/commit_payables_paid_import_v2_from_gateway'].includes(path)) {
      assert.equal(init.headers.apikey, SERVICE); assert.equal(init.headers.Authorization, `Bearer ${SERVICE}`);
      if (options.rpcError) return json(options.rpcError, options.rpcStatus ?? 400);
      return json(options.commitPayload ?? { import_id: IMPORT, row_count: data.p_rows.length, new_count: data.p_rows.length, open_count: 0, settled_count: 0, ...(path.includes('/commit_payables_forecast_import') ? { mode:'forecast' } : path.includes('/commit_payables_paid_import') ? { mode:'payments' } : {}), ...(path.includes('_v2_') ? { reconciliation_version:'043', request_id:data.p_request_id } : {}) });
    }
    throw new Error('Unexpected upstream path');
  };
  const settings = { ALLOWED_ORIGINS: ORIGIN, SUPABASE_URL: BASE, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, ...options.env };
  const handle = createPayablesGateway({ env: name => settings[name], fetch: fetcher, loadWorkbook: async value => { workbookCalls++; return loader(value); }, log: message => logs.push(message), now: options.now ?? (() => new Date('2026-10-27T15:00:00Z')) });
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
  assert.deepEqual(app.calls.map(call => call.path), ['/auth/v1/user', '/rest/v1/rpc/current_access', '/rest/v1/rpc/payables_import_capabilities', '/rest/v1/rpc/preview_payables_import']);
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
  const stream = new ReadableStream({ pull(controller) { emitted++; if (emitted > 28) return controller.close(); controller.enqueue(new Uint8Array(512 * 1024).fill(32)); }, cancel() { canceled = true; } });
  const response = await app.handle(new Request(`${BASE}/functions/v1/payables-import`, { method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': '1' }, body: stream, duplex: 'half' }));
  assert.equal(response.status, 400); assert.equal(canceled, true); assert.equal(app.calls.length, 2);
});

test('043 full and incremental forecasts forward only canonical source rows and individual decisions', async () => {
  for (const full_report of [false, true]) {
    const app = setup(), resolution_choices = full_report ? { [`title:${IMPORT}`]: { action:'WRITE_OFF', reason:'Baixa sintética confirmada individualmente.' } } : {};
    const response = await app.send(body('preview', { mode:'forecast', reconciliation_version:'043', full_report, resolution_choices }));
    assert.equal(response.status, 200);
    const call = app.calls.at(-1);
    assert.equal(call.path, '/rest/v1/rpc/preview_payables_forecast_import_v2');
    assert.equal(call.data.p_scope, 'grupo-consolidado'); assert.equal(call.data.p_full_report, full_report);
    assert.deepEqual(call.data.p_resolution_choices, resolution_choices);
    assert.equal(call.data.p_rows[0].amount_cents, 123456);
    assert.equal((await response.json()).preview.reconciliation_version, '043');
  }
});

test('043 is activation gated and never falls back to the old forecast or paid writer', async () => {
  for (const mode of ['forecast','payments']) {
    const app = setup({ capabilities:{ forecast_incremental:true, paid_import:true, cheque_number:true } });
    const response = await app.send(body('preview', { mode, reconciliation_version:'043', ...(mode === 'forecast' ? { full_report:true } : { file_base64:encode(PAID_CSV) }) }));
    assert.equal(response.status,409); assert.equal((await response.json()).code,'P0043');
    assert(!app.calls.some(call => /preview_payables_/.test(call.path)));
  }
  const missing = setup({ rpcError:{ code:'PGRST202', message:'private SQL diagnostic' }, rpcStatus:404 });
  const response = await missing.send(body('preview', { mode:'forecast', reconciliation_version:'043', full_report:true }));
  assert.equal(response.status,409); const payload = await response.json();
  assert.equal(payload.code,'P0043'); assert.equal(payload.activation_required,true); assert(!JSON.stringify(payload).includes('private'));
});

test('043 rejects undeclared file kinds, spoofed decisions, real cash of one cent, and import-only access before RPC', async () => {
  const base = { mode:'forecast', reconciliation_version:'043', full_report:true };
  for (const changes of [{ full_report:undefined }, { full_report:'true' }, { reconciliation_version:'044' }, { resolution_choices:{ 'row:0':{ action:'WRITE_OFF',reason:'Confirmação.' } } }, { resolution_choices:{ 'row:2':{ action:'WRITE_OFF',reason:'Confirmação.' } } }, { resolution_choices:{ [`title:${IMPORT}`]:{ action:'PAID',reason:'Confirmação.',paid_on:'2026-10-19',amount_paid_cents:0,bank_account_id:BANK } } }, { resolution_choices:{ 'row:1':{ action:'WRITE_OFF',reason:'Confirmação.',amount_paid_cents:1 } } }]) {
    const app = setup(), response = await app.send(body('preview', { ...base, ...changes }));
    assert.equal(response.status,400); assert(!app.calls.some(call => /preview_payables_/.test(call.path)));
  }
  const app = setup({ permissions:[{ resource:'contas_pagar',action:'import' }] });
  assert.equal((await app.send(body('preview',base))).status,403);
  assert.equal(app.calls.length,2);
});

test('043 commit forwards a stable protocol and financial revision without deriving payment facts from the forecast', async () => {
  const app = setup(), request_id = '70000000-0000-4000-8000-000000000001';
  const resolution_choices = { [`title:${IMPORT}`]:{ action:'PAID',reason:'Pagamento sintético confirmado.',paid_on:'2026-10-19',amount_paid_cents:10000,bank_account_id:BANK } };
  const data = body('commit',{ mode:'forecast',reconciliation_version:'043',full_report:true,resolution_choices,request_id,previous_financial_revision:'17' });
  assert.equal((await app.send(data)).status,200);
  const call = app.calls.at(-1);
  assert.equal(call.path,'/rest/v1/rpc/commit_payables_forecast_import_v2_from_gateway');
  assert.equal(call.data.p_user_id,USER); assert.equal(call.data.p_session_id,SESSION);
  assert.equal(call.data.p_request_id,request_id); assert.equal(call.data.p_previous_financial_revision,'17');
  assert.deepEqual(call.data.p_resolution_choices,resolution_choices);
  for (const changes of [{ request_id:undefined },{ request_id:'invalid' },{ previous_financial_revision:undefined }]) {
    const denied = setup(); assert.equal((await denied.send({ ...data,...changes })).status,400);
    assert(!denied.calls.some(entry=>entry.path.includes('commit_')));
  }
});

test('043 paid reports preserve administrative cent rows without accepting a real cent payment', async () => {
  const cent = { key:'row:1',kind:'CENT',line:1,title_id:IMPORT,branch:'2 - TESTE',entry_number:'ABC-1',description:'Título sintético',due_date:'2026-10-10',amount_cents:123456,source_amount_cents:1,allowed_actions:['WRITE_OFF'],selected_action:'WRITE_OFF',requires_resolution:true,problem:null };
  const app = setup({ reconciliationItems:[cent],paidOutcome:'WRITE_OFF' });
  const resolution_choices = { 'row:1':{ action:'WRITE_OFF',reason:'Baixa sintética sem pagamento confirmada.' } };
  const data = body('preview',{ mode:'payments',reconciliation_version:'043',file_base64:encode(PAID_CSV.replace('1.234,56','0,01')),resolution_choices });
  assert.equal((await app.send(data)).status,200);
  assert.equal(app.calls.at(-1).path,'/rest/v1/rpc/preview_payables_paid_import_v2');
  assert.equal(app.calls.at(-1).data.p_rows[0].amount_paid_cents,1);
  assert.deepEqual(app.calls.at(-1).data.p_resolution_choices,resolution_choices);
  const invalid = setup({ reconciliationItems:[cent] });
  assert.equal((await invalid.send(data)).status,503);
  const absentDecision = setup({ paidOutcome:'WRITE_OFF' });
  assert.equal((await absentDecision.send(data)).status,503);
});

test('043 rejects an inconsistent preview and an unconfirmed commit response without forwarding internal diagnostics', async () => {
  const data = body('preview',{ mode:'forecast',reconciliation_version:'043',full_report:true });
  const app = setup({ previewPayload:{ mode:'forecast',row_count:1,new_count:1,open_count:0,settled_count:0,can_commit:true } });
  const response = await app.send(data); assert.equal(response.status,503);
  const request_id = '70000000-0000-4000-8000-000000000001';
  for (const changes of [{ request_id:IMPORT },{ reconciliation_version:'021' }]) {
    const unknown = setup({ commitPayload:{ mode:'forecast',import_id:IMPORT,row_count:1,settled_count:0,reconciliation_version:'043',request_id,...changes } });
    const result = await unknown.send(body('commit',{ ...data,action:'commit',request_id,previous_financial_revision:'17' }));
    assert.equal(result.status,503); assert(!JSON.stringify(await result.json()).includes('synthetic-server-only-key'));
  }
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

const explicitPaidCsv = (paidOn = '27/10/2026 08:45', dueOn = '30/11/2026 23:59') =>
  'Lançamento;Filial;Emissão: valor do lançamento;Plano cc - Conta: nome;Vencimento: data;Quitação: data do pagamento;Situação\r\n'
  + `PAGO-SINTETICO;Filial sintética;108,98;Banco sintético;${dueOn};${paidOn};PAGO\r\n`;

test('paid import uses the explicit payment date despite a future original due date and preserves source bytes', async () => {
  const source = explicitPaidCsv(), app = setup();
  const previewResponse = await app.send(body('preview', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: encode(source) }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.payment_date_version, PAYMENT_DATE_VERSION);
  assert.equal(preview.rows[0].paid_on, '2026-10-27');
  assert.equal(preview.rows[0].amount_paid_cents, 10898);
  assert.equal(preview.file_sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(app.calls.at(-1).data.p_rows[0].paid_on, '2026-10-27');
  const request = body('commit', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: encode(source) });
  const committed = await app.send(request);
  assert.equal(committed.status, 200);
  assert.equal((await committed.json()).payment_date_version, PAYMENT_DATE_VERSION);
  const forwarded = app.calls.at(-1).data;
  assert.equal(forwarded.p_rows[0].paid_on, '2026-10-27');
  assert.equal(forwarded.p_rows[0].amount_paid_cents, 10898);
  assert.equal(forwarded.p_file_base64, request.file_base64);
  assert.equal(forwarded.p_file_sha256, createHash('sha256').update(source).digest('hex'));
});

test('an explicit future payment date blocks preview and commit before capabilities or financial writes', async () => {
  for (const action of ['preview', 'commit']) {
    const app = setup(), response = await app.send(body(action, { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: encode(explicitPaidCsv('30/10/2026', '16/10/2026')) }));
    assert.equal(response.status, 422);
    const payload = await response.json();
    assert.equal(payload.code, 'SOURCE_VALIDATION_FAILED');
    assert.deepEqual(payload.errors.map(row => [row.line, row.column, row.problem]), [[2, 'Quitação: data do pagamento', 'A data do pagamento é futura.']]);
    assert.match(payload.errors[0].correction, /data efetiva/);
    assert.equal(app.calls.length, 2); assert(!app.calls.some(call => call.path.includes('commit_')));
  }
});

test('a declared payment column cannot fall back to due date when its source cell is missing or invalid', async () => {
  for (const paidOn of ['', '31/02/2026', '27/10/2026 24:00', '=1+1']) {
    const app = setup(), response = await app.send(body('commit', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: encode(explicitPaidCsv(paidOn, '16/10/2026')) }));
    assert.equal(response.status, 422, paidOn);
    const payload = await response.json();
    assert.equal(payload.code, 'SOURCE_VALIDATION_FAILED');
    assert(payload.errors.some(row => row.line === 2 && row.column === 'Quitação: data do pagamento'));
    assert.equal(app.calls.length, 2);
  }
});

test('the payment cutoff follows the service day in São Paulo rather than UTC or browser-supplied dates', async () => {
  const source = encode(explicitPaidCsv('28/10/2026', '16/10/2026'));
  for (const [instant, expected] of [['2026-10-28T01:30:00Z', 422], ['2026-10-28T03:00:00Z', 200]]) {
    const app = setup({ now: () => new Date(instant) });
    const response = await app.send(body('preview', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: source }));
    assert.equal(response.status, expected, instant);
    if (expected === 422) { assert.equal((await response.json()).errors[0].problem, 'A data do pagamento é futura.'); assert.equal(app.calls.length, 2); }
    else assert.equal((await response.json()).rows[0].paid_on, '2026-10-28');
  }
  for (const extra of [{ today: '2099-12-31' }, { current_date: '2099-12-31' }, { paid_on: '2026-10-27' }]) {
    const app = setup(), response = await app.send(body('preview', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: source, ...extra }));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
});

test('legacy paid reports still use their declared due-date payment field but reject genuinely future payments', async () => {
  const input = PAID_CSV.replace('17/10/2026 23:59', '30/10/2026 23:59');
  const app = setup(), response = await app.send(body('preview', { mode: 'payments', file_base64: encode(input) }));
  assert.equal(response.status, 422); const payload = await response.json();
  assert.equal(payload.code, 'SOURCE_VALIDATION_FAILED');
  assert.equal(payload.errors[0].problem, 'A data do pagamento é futura.');
  assert.equal(app.calls.length, 2);
  const forecast = setup({ now: () => { throw new Error('Clock must not affect forecasts'); } });
  const futureForecast = CSV.replace('16/10/2026', '30/11/2026');
  const preview = await forecast.send(body('preview', { mode: 'forecast', file_base64: encode(futureForecast) }));
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).rows[0].due_date, '2026-11-30');
});

test('source-validation failures stay typed and do not expose raw workbook errors or receive unsupported date overrides', async () => {
  const source = await xlsx();
  const app = setup({ loadWorkbook: () => { throw new Error('private database, account and token detail'); } });
  const response = await app.send(body('preview', { mode: 'payments', file_name: 'source.xlsx', file_base64: encode(source) }));
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.code, 'SOURCE_VALIDATION_FAILED'); assert(!JSON.stringify(payload).includes('private'));
  assert.equal(app.calls.length, 2);
});

test('XLSX dates preserve explicit payment precedence and report a real future date at its physical source row', async () => {
  for (const [sourceRow, paidOn, expected] of [[2, '2026-10-27T08:45:00Z', 200], [379, '2026-10-30T08:45:00Z', 422]]) {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Pagamentos');
    sheet.addRow(['Lançamento', 'Filial', 'Emissão: valor do lançamento', 'Plano cc - Conta: nome', 'Vencimento: data', 'Quitação: data do pagamento', 'Situação']);
    sheet.getRow(sourceRow).values = ['PAGO-SINTETICO', 'Filial sintética', 108.98, 'Banco sintético', new Date('2026-11-30T00:00:00Z'), new Date(paidOn), 'PAGO'];
    for (const column of [5, 6]) sheet.getRow(sourceRow).getCell(column).numFmt = 'dd/mm/yyyy hh:mm';
    const source = await workbook.xlsx.writeBuffer(), app = setup();
    const response = await app.send(body('preview', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_name: 'pagamentos.xlsx', file_base64: encode(source) }));
    assert.equal(response.status, expected);
    const payload = await response.json();
    if (expected === 200) {
      assert.equal(payload.rows[0].paid_on, '2026-10-27'); assert.equal(payload.rows[0].amount_paid_cents, 10898);
      assert.equal(payload.file_sha256, createHash('sha256').update(source).digest('hex'));
    } else {
      assert.deepEqual(payload.errors.map(row => [row.line, row.column, row.problem]), [[379, 'Quitação: data do pagamento', 'A data do pagamento é futura.']]);
      assert.equal(payload.code, 'SOURCE_VALIDATION_FAILED'); assert.equal(app.calls.length, 2);
    }
  }
});

test('payment date protocol accepts only the known paid-only version before parsing the source', async () => {
  for (const extra of [
    { mode: 'forecast', payment_date_version: PAYMENT_DATE_VERSION },
    { payment_date_version: PAYMENT_DATE_VERSION },
    { mode: 'payments', payment_date_version: 'old' },
    { mode: 'payments', payment_date_version: null },
    { mode: 'payments', payment_date_version: true },
    { mode: 'payments', payment_date_version: {} },
  ]) {
    const app = setup(), response = await app.send(body('preview', extra));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2); assert.equal(app.workbookCalls(), 0);
  }
});

test('old frozen paid confirmations preserve the due-date-derived payment even when an explicit source date differs', async () => {
  const source = explicitPaidCsv('20/10/2026 08:45', '17/10/2026 23:59'), app = setup();
  const previewResponse = await app.send(body('preview', { mode: 'payments', file_base64: encode(source) }));
  assert.equal(previewResponse.status, 200); const preview = await previewResponse.json();
  assert.equal(preview.rows[0].paid_on, '2026-10-17');
  assert.equal(Object.hasOwn(preview, 'payment_date_version'), false);
  const frozen = body('commit', { mode: 'payments', file_base64: encode(source), confirm_corrections: true });
  const response = await app.send(frozen);
  assert.equal(response.status, 200); assert.equal(Object.hasOwn(await response.json(), 'payment_date_version'), false);
  const first = app.calls.at(-1).data;
  assert.equal(first.p_rows[0].paid_on, '2026-10-17');
  const replay = await app.send(frozen);
  assert.equal(replay.status, 200); assert.deepEqual(app.calls.at(-1).data, first);
  const modern = setup(), newResponse = await modern.send(body('preview', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: encode(source) }));
  assert.equal(newResponse.status, 200); const current = await newResponse.json();
  assert.equal(current.payment_date_version, PAYMENT_DATE_VERSION); assert.equal(current.rows[0].paid_on, '2026-10-20');
});

test('an idempotent same-source result never claims that newly interpreted payment dates were corrected', async () => {
  const source = explicitPaidCsv('20/10/2026', '17/10/2026');
  for (const [version, correction, status] of [[PAYMENT_DATE_VERSION, true, 409], [PAYMENT_DATE_VERSION, false, 200], [undefined, true, 200]]) {
    const app = setup({ commitPayload: { import_id: IMPORT, row_count: 1, mode: 'payments', new_count: 0, open_count: 0, settled_count: 0, idempotent: true },
      historyRows: [{ source_row: { branch: 'Filial sintética', entry_number: 'PAGO-SINTETICO', paid_on: '2026-10-17', line: 1 } }] });
    const response = await app.send(body('commit', { mode: 'payments', file_base64: encode(source), confirm_corrections: correction, ...(version ? { payment_date_version: version } : {}) }));
    assert.equal(response.status, status); const payload = await response.json();
    if (status === 409) {
      assert.equal(payload.code, 'PAYMENT_DATE_REVIEW_REQUIRED'); assert.equal(payload.payment_date_version, PAYMENT_DATE_VERSION);
      assert.match(payload.error, /datas não foram corrigidas/); assert.equal(Object.hasOwn(payload, 'import_id'), false);
    } else {
      assert.equal(payload.idempotent, true); assert.equal(payload.payment_date_version, version);
    }
    assert.equal(app.calls.filter(call => call.path.includes('/commit_')).length, 1);
  }
});

test('a lost successful correction is confirmed from immutable imported dates without consulting a fresh preview or active bank', async () => {
  const source = explicitPaidCsv('20/10/2026', '17/10/2026'), requestId = SESSION;
  const app = setup({
    // A fresh preview would now fail (for example after disabling the bank).
    previewPayload: { private: 'unavailable live bank' },
    commitPayload: { import_id: IMPORT, row_count: 1, mode: 'payments', settled_count: 0, correction_count: 1, idempotent: true, reconciliation_version: '043', request_id: requestId },
    historyRows: [{ source_row: { branch: 'Filial sintética', entry_number: 'PAGO-SINTETICO', paid_on: '2026-10-20', line: 1 } }],
  });
  const frozen = body('commit', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: encode(source), confirm_corrections: true,
    reconciliation_version: '043', full_report: false, resolution_choices: {}, request_id: requestId });
  let forwarded;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.send(frozen);
    assert.equal(response.status, 200); const payload = await response.json();
    assert.equal(payload.idempotent, true); assert.equal(payload.request_id, requestId); assert.equal(payload.payment_date_version, PAYMENT_DATE_VERSION);
    const current = app.calls.findLast(call => call.path.includes('/commit_')).data;
    if (forwarded) assert.deepEqual(current, forwarded); else forwarded = current;
    assert.equal(current.p_rows[0].paid_on, '2026-10-20');
  }
  assert(!app.calls.some(call => call.path.includes('/preview_') || call.path.includes('bank_accounts')));
  assert.equal(app.calls.filter(call => call.path === '/rest/v1/payable_paid_import_rows').length, 2);
});

test('inaccessible, missing or malformed immutable payment history preserves an unknown result without another financial write', async () => {
  const source = explicitPaidCsv('20/10/2026', '17/10/2026');
  const valid = { source_row: { branch: 'Filial sintética', entry_number: 'PAGO-SINTETICO', paid_on: '2026-10-20', line: 1 } };
  for (const history of [
    { historyFailure: 403 }, { historyFailure: 500 }, { historyPayload: { message: 'private history source' } }, { historyRows: [] },
    { historyRows: [valid, valid] }, { historyRows: [{ source_row: null }] },
    { historyRows: [{ source_row: { ...valid.source_row, paid_on: '2026-99-99' } }] },
    { historyRows: [{ source_row: { ...valid.source_row, line: 0 } }] },
    { historyRows: [{ source_row: { ...valid.source_row, branch: 'Another source' } }] },
  ]) {
    const app = setup({ ...history, commitPayload: { import_id: IMPORT, row_count: 1, mode: 'payments', settled_count: 0, idempotent: true } });
    const response = await app.send(body('commit', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: encode(source), confirm_corrections: true }));
    assert.equal(response.status, 503); const payload = await response.json();
    assert.equal(Object.hasOwn(payload, 'code'), false); assert(!JSON.stringify(payload).includes('private'));
    assert.equal(app.calls.filter(call => call.path.includes('/commit_')).length, 1);
    assert(!app.calls.some(call => call.path.includes('/preview_')));
  }
});

test('immutable replay proof reads complete bounded pages and excludes individually confirmed one-cent writeoffs', async () => {
  for (const count of [500, 501]) {
    const source = 'Lançamento;Filial;Emissão: valor do lançamento;Plano cc - Conta: nome;Vencimento: data;Quitação: data do pagamento;Situação\r\n'
      + Array.from({ length: count }, (_, index) => `SYN-${index};Filial sintética;1,00;Banco sintético;17/10/2026;20/10/2026;PAGO\r\n`).join('')
      + 'CENT-SYN;Filial sintética;0,01;Banco sintético;17/10/2026;20/10/2026;PAGO\r\n';
    const historyRows = Array.from({ length: count }, (_, index) => ({ source_row: { branch: 'Filial sintética', entry_number: 'SYN-' + index, paid_on: '2026-10-20', line: index + 1 } }));
    const app = setup({ historyRows, commitPayload: { import_id: IMPORT, row_count: count + 1, mode: 'payments', settled_count: 0, idempotent: true } });
    const response = await app.send(body('commit', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, file_base64: encode(source), confirm_corrections: true }));
    assert.equal(response.status, 200); assert.equal((await response.json()).idempotent, true);
    const reads = app.calls.filter(call => call.path === '/rest/v1/payable_paid_import_rows');
    assert.deepEqual(reads.map(call => Number(new URLSearchParams(call.search).get('offset'))), [0, 500]);
    assert(reads.every(call => Number(new URLSearchParams(call.search).get('offset')) <= count));
    assert(reads.every(call => call.init.headers.apikey === ANON && call.init.headers.Authorization === `Bearer ${TOKEN}`));
  }
});

const bankRuleCapabilities = { cheque_number: true, forecast_incremental: true, paid_import: true, import_reconciliation: true, reconciliation_version: '043', paid_bank_rules_version: '050', internal_cash_writeoff: true };
const bankRuleRequest = extra => ({ mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, bank_rules_version: '050', reconciliation_version: '043', ...extra });
const cashCsv = (date = '') => explicitPaidCsv(date).replace('Banco sintético', 'CAIXA INTERNO');
const cashPreview = (changes = {}) => ({
  mode: 'payments', previous_import_id: null, financial_revision: '17', row_count: 1,
  new_payment_count: 0, matched_payment_count: 0, correction_count: 0, conflict_count: 0,
  errors: [], unmapped_banks: [], bank_options: [], unclassified_plans: [], can_commit: true,
  reconciliation_version: '043', full_report: false, resolution_errors: [], bank_accounts: [],
  rows: [{ branch: 'Filial sintética', entry_number: 'PAGO-SINTETICO', source_status: 'PAGO', paid_on: null, amount_paid_cents: 10898, paid_bank: 'CAIXA INTERNO',
    line: 1, title_id: IMPORT, outcome: 'WRITE_OFF', forecast_due_date: '2026-10-10', bank_mapping_key: '["FILIAL SINTÉTICA","CAIXA INTERNO"]', bank_account_id: null,
    payment_ids: [], title_amount_cents: 12345, amount_changed: false, updated_amount_cents: 12345, problem: '' }],
  reconciliation_items: [{ key: 'row:1', kind: 'INTERNAL_CASH', line: 1, title_id: IMPORT, branch: 'Filial sintética', entry_number: 'PAGO-SINTETICO',
    description: 'Título sintético', due_date: '2026-10-10', amount_cents: 12345, source_amount_cents: 10898,
    allowed_actions: ['WRITE_OFF'], selected_action: 'WRITE_OFF', requires_resolution: true, problem: null }],
  ...changes,
});
const cashChoice = { 'row:1': { action: 'WRITE_OFF', reason: 'Baixa de Caixa Interno conferida individualmente.' } };

test('bank rules require the exact paid-only date and reconciliation contracts before decoding', async () => {
  for (const extra of [
    { mode: 'payments', bank_rules_version: '050' },
    { mode: 'payments', bank_rules_version: '050', payment_date_version: PAYMENT_DATE_VERSION },
    { mode: 'payments', bank_rules_version: '050', reconciliation_version: '043' },
    { mode: 'forecast', bank_rules_version: '050', reconciliation_version: '043', full_report: true },
    bankRuleRequest({ bank_rules_version: '049' }), bankRuleRequest({ bank_rules_version: null }), bankRuleRequest({ bank_rules_version: true }),
  ]) {
    const app = setup(), response = await app.send(body('preview', extra));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2); assert.equal(app.workbookCalls(), 0);
  }
});

test('050 activation gates the new import without falling back to old preview or commit writers', async () => {
  const data = bankRuleRequest({ file_base64: encode(cashCsv('30/10/2026')), resolution_choices: cashChoice });
  for (const capabilities of [undefined, { ...bankRuleCapabilities, paid_bank_rules_version: '049' }, { ...bankRuleCapabilities, internal_cash_writeoff: false }]) {
    const app = setup({ ...(capabilities ? { capabilities } : {}) }), response = await app.send(body('preview', data));
    assert.equal(response.status, 409); const payload = await response.json();
    assert.equal(payload.code, 'P0050'); assert.equal(payload.activation_required, true);
    assert(!app.calls.some(call => /preview_payables_|commit_payables_/.test(call.path)));
  }
  const missing = setup({ capabilityError: { code: 'PGRST202', message: 'private SQL' }, capabilityStatus: 404 });
  assert.equal((await (await missing.send(body('preview', data))).json()).code, 'P0050');
  const oldRpc = setup({ capabilities: bankRuleCapabilities, rpcError: { code: 'PGRST202', message: 'private SQL' }, rpcStatus: 404 });
  const response = await oldRpc.send(body('preview', data));
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'P0050');
  assert.equal(oldRpc.calls.filter(call => call.path.includes('/preview_')).length, 1);
});

test('cash source rows retain their raw bank and nominal amount but never become financial payments', async () => {
  for (const date of ['', '30/10/2026']) {
    const input = cashCsv(date), app = setup({ capabilities: bankRuleCapabilities, previewPayload: cashPreview() });
    const preview = await app.send(body('preview', bankRuleRequest({ file_base64: encode(input), resolution_choices: cashChoice })));
    assert.equal(preview.status, 200); const payload = await preview.json();
    assert.equal(payload.bank_rules_version, '050'); assert.equal(payload.payment_date_version, PAYMENT_DATE_VERSION);
    assert.equal(payload.rows[0].paid_on, null); assert.equal(payload.rows[0].amount_paid_cents, 10898); assert.equal(payload.rows[0].paid_bank, 'CAIXA INTERNO');
    assert.equal(payload.rows[0].bank_account_id, null); assert.deepEqual(payload.rows[0].payment_ids, []);
    assert.equal(payload.file_sha256, createHash('sha256').update(input).digest('hex'));
    const call = app.calls.at(-1); assert.equal(call.data.p_rows[0].paid_on, null); assert.equal(call.data.p_rows[0].amount_paid_cents, 10898);
    assert.deepEqual(call.data.p_resolution_choices, cashChoice);
    const request = body('commit', bankRuleRequest({ file_base64: encode(input), resolution_choices: cashChoice, request_id: SESSION, previous_financial_revision: '17' }));
    const committed = await app.send(request);
    assert.equal(committed.status, 200); assert.equal((await committed.json()).bank_rules_version, '050');
    assert.equal(app.calls.at(-1).data.p_file_base64, request.file_base64); assert.equal(app.calls.at(-1).data.p_rows[0].paid_on, null);
  }
});

test('cash administrative previews cannot invent a payment, bank, date or source value', async () => {
  const valid = cashPreview();
  for (const change of [
    { outcome: 'NEW_PAYMENT' }, { outcome: 'MATCHED' }, { outcome: 'CORRECTION' }, { paid_on: '2026-10-27' },
    { bank_account_id: BANK }, { amount_paid_cents: 1 }, { payment_ids: [SESSION] },
  ]) {
    const payload = cashPreview({ rows: [{ ...valid.rows[0], ...change }] });
    const app = setup({ capabilities: bankRuleCapabilities, previewPayload: payload });
    const response = await app.send(body('preview', bankRuleRequest({ file_base64: encode(cashCsv()), resolution_choices: cashChoice })));
    assert.equal(response.status, 503, JSON.stringify(change));
    assert(!app.calls.some(call => call.path.includes('/commit_')));
  }
  const regularSource = explicitPaidCsv('20/10/2026', '17/10/2026');
  const regular = setup({ capabilities: bankRuleCapabilities, previewPayload: cashPreview() });
  assert.equal((await regular.send(body('preview', bankRuleRequest({ file_base64: encode(regularSource), resolution_choices: cashChoice })))).status, 503);
});

test('each cash row needs its own source-matched reconciliation item and individual confirmation', async () => {
  const valid = cashPreview();
  for (const changes of [
    { reconciliation_items: [] },
    { reconciliation_items: [{ ...valid.reconciliation_items[0], kind: 'CENT' }] },
    { reconciliation_items: [{ ...valid.reconciliation_items[0], source_amount_cents: 1 }] },
    { reconciliation_items: [{ ...valid.reconciliation_items[0], allowed_actions: ['PAID'], selected_action: 'PAID' }] },
    { reconciliation_items: [{ ...valid.reconciliation_items[0], requires_resolution: false, selected_action: null }] },
  ]) {
    const app = setup({ capabilities: bankRuleCapabilities, previewPayload: cashPreview(changes) });
    const response = await app.send(body('preview', bankRuleRequest({ file_base64: encode(cashCsv()), resolution_choices: cashChoice })));
    assert.equal(response.status, 503);
  }
  const pending = setup({ capabilities: bankRuleCapabilities, previewPayload: cashPreview({ can_commit: false,
    reconciliation_items: [{ ...valid.reconciliation_items[0], selected_action: null, problem: 'Confirme esta baixa individualmente.' }],
    rows: [{ ...valid.rows[0], outcome: 'WRITE_OFF_PENDING', problem: 'Confirme esta baixa individualmente.' }], resolution_errors: [{ line: 1, problem: 'Confirmação pendente.' }] }) });
  const response = await pending.send(body('preview', bankRuleRequest({ file_base64: encode(cashCsv()) })));
  assert.equal(response.status, 200); assert.equal((await response.json()).preview.can_commit, false);
});

test('legacy cash confirmations preserve their historical canonical dates without opting into bank rules', async () => {
  const input = cashCsv('20/10/2026').replace('30/11/2026 23:59', '17/10/2026');
  for (const version of [undefined, PAYMENT_DATE_VERSION]) {
    const app = setup(), data = body('commit', { mode: 'payments', file_base64: encode(input), ...(version ? { payment_date_version: version } : {}) });
    const response = await app.send(data);
    assert.equal(response.status, 200); assert.equal(Object.hasOwn(await response.json(), 'bank_rules_version'), false);
    assert.equal(app.calls.at(-1).data.p_rows[0].paid_on, version ? '2026-10-20' : '2026-10-17');
    assert.equal(app.calls.at(-1).data.p_rows[0].paid_bank, 'CAIXA INTERNO');
  }
  const incompatible = setup({ previewPayload: cashPreview({ rows: [{ ...cashPreview().rows[0], paid_on: '2026-10-20' }] }) });
  const response = await incompatible.send(body('preview', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, reconciliation_version: '043', file_base64: encode(input), resolution_choices: cashChoice }));
  assert.equal(response.status, 503);
});

test('new immutable replay proof excludes cash administrative rows while legacy proof still requires recorded cash payments', async () => {
  const source = 'Lançamento;Filial;Emissão: valor do lançamento;Plano cc - Conta: nome;Vencimento: data;Quitação: data do pagamento;Situação\r\n'
    + 'CASH-SYN;Filial sintética;108,98;CAIXA INTERNO;17/10/2026;20/10/2026;PAGO\r\n'
    + 'PAY-SYN;Filial sintética;100,00;Banco sintético;17/10/2026;20/10/2026;PAGO\r\n'
    + 'CENT-SYN;Filial sintética;0,01;Banco sintético;17/10/2026;20/10/2026;PAGO\r\n';
  const recorded = entry_number => ({ source_row: { branch: 'Filial sintética', entry_number, paid_on: '2026-10-20' } });
  const result = { import_id: IMPORT, row_count: 3, mode: 'payments', settled_count: 0, idempotent: true, reconciliation_version: '043', request_id: SESSION };
  const choices = { 'row:1': { action: 'WRITE_OFF', reason: 'Baixa de Caixa Interno confirmada.' }, 'row:3': { action: 'WRITE_OFF', reason: 'Baixa de centavo confirmada.' } };
  const modern = setup({ capabilities: bankRuleCapabilities, commitPayload: result, historyRows: [recorded('PAY-SYN')] });
  const response = await modern.send(body('commit', bankRuleRequest({ file_base64: encode(source), request_id: SESSION, previous_financial_revision: '17', confirm_corrections: true, resolution_choices: choices })));
  assert.equal(response.status, 200); assert.equal((await response.json()).bank_rules_version, '050');
  for (const [historyRows, expected] of [[[recorded('CASH-SYN'), recorded('PAY-SYN')], 200], [[recorded('PAY-SYN')], 503]]) {
    const legacy = setup({ commitPayload: result, historyRows });
    const oldResponse = await legacy.send(body('commit', { mode: 'payments', payment_date_version: PAYMENT_DATE_VERSION, reconciliation_version: '043', request_id: SESSION,
      previous_financial_revision: '17', file_base64: encode(source), confirm_corrections: true, resolution_choices: { 'row:3': choices['row:3'] } }));
    assert.equal(oldResponse.status, expected);
  }
});

const columnCapabilities = { ...bankRuleCapabilities, column_rules_version: '059' };
const columnRequest = extra => bankRuleRequest({ column_rules_version: '059', ...extra });
const numberedCashCsv = date => cashCsv(date).trimEnd().split('\r\n').map((line, index) => line + (index ? ';000123' : ';Cheque: número')).join('\r\n') + '\r\n';
const columnChequePreview = () => {
  const result = cashPreview({ column_rules_version: '059', cheque_payment_bank_id: BANK,
    reconciliation_items: [], new_payment_count: 1, bank_options: [{ id: BANK, display_name: 'BRADESCO F2G', account_type: 'BANK' }] });
  result.rows = [{ ...result.rows[0], outcome: 'NEW_PAYMENT', payment_bank_rule: 'CHEQUE_F2G', paid_on: '2026-10-20', bank_account_id: BANK, cheque_number: '000123' }];
  return result;
};
test('059 capability is mandatory for the new paid-only column contract and never falls back', async () => {
  for (const column_rules_version of [undefined, '058', null]) {
    const app = setup({ capabilities: { ...bankRuleCapabilities, column_rules_version } });
    const response = await app.send(body('preview', columnRequest({ file_base64: encode(cashCsv()) })));
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'P0059');
    assert(!app.calls.some(call => /preview_payables_|commit_payables_/.test(call.path)));
  }
  for (const changes of [{ column_rules_version: '058' }, { mode: 'forecast' }, { bank_rules_version: undefined }, { reconciliation_version: undefined }]) {
    const app = setup(), response = await app.send(body('preview', columnRequest(changes)));
    assert.equal(response.status, 400); assert.equal(app.calls.length, 2);
  }
});
test('059 numbered cash cheques are real payments in the unique official F2G bank and preserve original source bytes', async () => {
  const source = numberedCashCsv('20/10/2026'), app = setup({ capabilities: columnCapabilities, previewPayload: columnChequePreview(),
    commitPayload: { import_id: IMPORT, row_count: 1, mode: 'payments', settled_count: 0, idempotent: false, reconciliation_version: '043', request_id: SESSION, column_rules_version: '059' } });
  const response = await app.send(body('preview', columnRequest({ file_base64: encode(source) })));
  assert.equal(response.status, 200); const value = await response.json();
  assert.equal(value.rows[0].paid_bank, 'CAIXA INTERNO'); assert.equal(value.rows[0].bank_account_id, BANK);
  assert.equal(value.rows[0].payment_bank_rule, 'CHEQUE_F2G');
  assert.equal(app.calls.at(-1).data.p_rows[0].paid_on, '2026-10-20');
  assert.equal(value.file_sha256, createHash('sha256').update(source).digest('hex'));
  const committed = await app.send(body('commit', columnRequest({ file_base64: encode(source), request_id: SESSION, previous_financial_revision: '17' })));
  assert.equal(committed.status, 200); assert.equal(app.calls.at(-1).data.p_rows[0].paid_bank, 'CAIXA INTERNO');
  assert.equal(app.calls.at(-1).data.p_rows[0].cheque_number, '000123');
});
test('059 payment-bank proof rejects missing flags, wrong bank types, conflicting canonical accounts and administrative cheque claims', async () => {
  const valid = columnChequePreview();
  for (const change of [
    { column_rules_version: undefined }, { cheque_payment_bank_id: null },
    { rows: [{ ...valid.rows[0], payment_bank_rule: 'SOURCE_BANK' }] },
    { rows: [{ ...valid.rows[0], bank_account_id: SESSION }] },
    { bank_options: [{ id: BANK, display_name: 'BANCO QUALQUER', account_type: 'BANK' }] },
    { bank_options: [{ id: BANK, display_name: 'BRADESCO F2G', account_type: 'CASH' }] },
    { bank_options: [...valid.bank_options, { id: SESSION, display_name: 'BRADESCO F2G', account_type: 'BANK' }] },
    { rows: [{ ...valid.rows[0], outcome: 'WRITE_OFF' }] },
  ]) {
    const app = setup({ capabilities: columnCapabilities, previewPayload: { ...valid, ...change } });
    const response = await app.send(body('preview', columnRequest({ file_base64: encode(numberedCashCsv('20/10/2026')) })));
    assert.equal(response.status, 503, JSON.stringify(change)); assert(!app.calls.some(call => call.path.includes('/commit_')));
  }
});
test('059 cash date survives parsing when the cheque number is omitted and SQL resolves the existing cheque', async () => {
  const app = setup({ capabilities: columnCapabilities, previewPayload: columnChequePreview() });
  const response = await app.send(body('preview', columnRequest({ file_base64: encode(cashCsv('20/10/2026')) })));
  assert.equal(response.status, 200); assert.equal(app.calls.at(-1).data.p_rows[0].paid_on, '2026-10-20');
  assert.equal(Object.hasOwn(app.calls.at(-1).data.p_rows[0], 'cheque_number'), false);
});

test('059 lost mixed correction replay proves financial count and immutable dates without requiring an administrative cash history row', async () => {
  const ordinary = explicitPaidCsv('20/10/2026', '17/10/2026').trimEnd();
  const cash = ordinary.split('\r\n')[1].replace('PAGO-SINTETICO', 'CASH-SINTETICO').replace('Banco sintético', 'CAIXA INTERNO');
  const source = ordinary + '\r\n' + cash + '\r\n';
  const financial = { source_row: { branch: 'Filial sintética', entry_number: 'PAGO-SINTETICO', paid_on: '2026-10-20', line: 1 } };
  const cashFinancial = { source_row: { branch: 'Filial sintética', entry_number: 'CASH-SINTETICO', paid_on: '2026-10-20', line: 2 } };
  const frozen = body('commit', columnRequest({ file_base64: encode(source), request_id: SESSION, previous_financial_revision: '17', confirm_corrections: true, resolution_choices: {} }));
  for (const [writeoff_count, historyRows] of [[1, [financial]], [0, [financial, cashFinancial]]]) {
    const app = setup({ capabilities: columnCapabilities, historyRows,
      commitPayload: { import_id: IMPORT, row_count: 2, mode: 'payments', settled_count: 0, correction_count: 1, idempotent: true,
        reconciliation_version: '043', request_id: SESSION, writeoff_count, column_rules_version: '059' } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.send(frozen); assert.equal(response.status, 200); assert.equal((await response.json()).idempotent, true);
      assert.equal(app.calls.findLast(call => call.path.includes('/commit_')).data.p_rows[1].paid_on, '2026-10-20');
    }
    assert(!app.calls.some(call => call.path.includes('/preview_') || call.path.includes('bank_accounts')));
  }
  for (const [historyRows, writeoff_count, status] of [
    [[cashFinancial], 1, 503], [[], 1, 503], [[financial, cashFinancial], 1, 503],
    [[financial, { source_row: { ...cashFinancial.source_row, paid_on: '2026-10-17' } }], 0, 409],
  ]) {
    const app = setup({ capabilities: columnCapabilities, historyRows,
      commitPayload: { import_id: IMPORT, row_count: 2, mode: 'payments', settled_count: 0, correction_count: 1, idempotent: true,
        reconciliation_version: '043', request_id: SESSION, writeoff_count, column_rules_version: '059' } });
    const response = await app.send(frozen); assert.equal(response.status, status);
    if (status === 409) assert.equal((await response.json()).code, 'PAYMENT_DATE_REVIEW_REQUIRED');
    assert.equal(app.calls.filter(call => call.path.includes('/commit_')).length, 1);
  }
});
test('059 fresh paid commits require column-rule proof while an old completed exact protocol remains replayable', async () => {
  const source = numberedCashCsv('20/10/2026');
  for (const idempotent of [false, undefined]) {
    const app = setup({ capabilities: columnCapabilities, commitPayload: { import_id: IMPORT, row_count: 1, mode: 'payments', settled_count: 0, idempotent, reconciliation_version: '043', request_id: SESSION } });
    const response = await app.send(body('commit', columnRequest({ file_base64: encode(source), request_id: SESSION, previous_financial_revision: '17' })));
    assert.equal(response.status, 503);
  }
  const replay = setup({ capabilities: columnCapabilities, commitPayload: { import_id: IMPORT, row_count: 1, mode: 'payments', settled_count: 0, idempotent: true, reconciliation_version: '043', request_id: SESSION } });
  assert.equal((await replay.send(body('commit', columnRequest({ file_base64: encode(source), request_id: SESSION, previous_financial_revision: '17' })))).status, 200);
});


test('060 activation retires every old HTTP import writer including unversioned forecasts without a cheque column', async () => {
  for (const action of ['preview', 'commit']) for (const extra of [{}, { mode: 'forecast' }, { mode: 'payments', file_base64: encode(PAID_CSV) }]) {
    const app = setup({ capabilities: { unified_daily_report: true, daily_report_version: '060' } });
    const response = await app.send(body(action, extra));
    assert.equal(response.status, 409); const result = await response.json();
    assert.equal(result.code, 'P0060'); assert.equal(result.activation_required, false);
    assert.equal(app.calls.at(-1).path, '/rest/v1/rpc/payables_import_capabilities');
    assert(!app.calls.some(call => /\/(?:preview_|commit_)/.test(call.path)));
  }
});
