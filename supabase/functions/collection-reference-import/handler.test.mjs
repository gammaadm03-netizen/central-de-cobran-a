import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCollectionReferenceGateway, COLLECTION_REFERENCE_GATEWAY_SCHEMA, REFERENCE_REQUEST_BUDGET_MS } from './handler.mjs';

const USER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const SESSION = '20000000-0000-4000-8000-000000000001';
const JOB = '30000000-0000-4000-8000-000000000001';
const REQUEST = '40000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://central.example.invalid';
const BASE = 'https://project.example.invalid';
const ANON = 'synthetic-public-key';
const SERVICE = 'synthetic-server-only-key';
const ORIGINAL = Buffer.from('Original synthetic bytes: preserved but never parsed as XLSX in the Edge runtime.');
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(value).toString('base64');
const token = claims => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: USER, session_id: SESSION, ...claims })).toString('base64url')}.verified-only-by-auth`;
const TOKEN = token({});
const CONTACT_HEADER = 'source_line;Entidade: nome;Endereço: email;T. 1: ddd;T. 1: número\r\n';
const CONTACTS = CONTACT_HEADER + '12;Órgão Sintético;contato@example.invalid;31;999999999\r\n';
const DESCRIPTION_HEADER = 'source_line;CLIENTE;CONTRATO;NOTA FISCAL;DESCRIÇÃO;FILIAL\r\n';
const DESCRIPTIONS = DESCRIPTION_HEADER + '21;Órgão Sintético;Contrato A;0000123;Materiais de limpeza;4\r\n';
const permissions = [
  ...['read', 'write', 'import'].map(action => ({ resource: 'contas_receber', action })),
  { resource: 'importar_bases', action: 'read' },
];
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const job = changes => ({ job_id: JOB, bucket: 'collection-reference-files', storage_path: `${USER}/${JOB}/original`, mode: 'CONTACTS', status: 'VERIFIED', source_name: 'referencia.xlsx', source_size: ORIGINAL.length, source_sha256: hash(ORIGINAL), original_verified: true, manifest_sha256: null, staged_rows: 0, staged_chunks: 0, ...changes });
const begin = changes => ({ action: 'begin', mode: 'contacts', file_name: 'referencia.xlsx', file_size: ORIGINAL.length, file_sha256: hash(ORIGINAL), ...changes });
const stage = (csv = CONTACTS, changes = {}) => ({ action: 'stage', job_id: JOB, chunk_index: 0, chunk_sha256: hash(csv), chunk_base64: encode(csv), ...changes });
const publish = changes => ({ action: 'publish', job_id: JOB, previous_financial_revision: 'revision-17', request_id: REQUEST, ...changes });

function setup(options = {}) {
  const calls = [], logs = []; let parseCalls = 0;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const data = init.body === undefined ? null : JSON.parse(init.body);
    calls.push({ path, data, init });
    assert(init.signal instanceof AbortSignal);
    assert.equal(init.redirect, 'error');
    if (options.networkFailure) throw new Error(`private upstream query ${SERVICE} ${TOKEN}`);
    if (path === '/auth/v1/user') {
      assert.equal(init.method, 'GET'); assert.equal(init.headers.apikey, ANON); assert.notEqual(init.headers.Authorization, `Bearer ${SERVICE}`);
      return json(options.auth ?? { id: USER }, options.authStatus ?? 200);
    }
    if (path === '/rest/v1/rpc/current_access') {
      assert.equal(init.headers.apikey, ANON);
      if (options.accessError) return json(options.accessError, 403);
      return json({ profile: { id: USER, enabled: options.enabled ?? true, role_key: options.role ?? 'contas_receber' }, permissions: options.permissions ?? permissions });
    }
    assert.equal(init.headers.apikey, SERVICE); assert.equal(init.headers.Authorization, `Bearer ${SERVICE}`);
    if (path.startsWith('/storage/v1/')) {
      assert.equal(path, `/storage/v1/object/authenticated/collection-reference-files/${USER}/${JOB}/original`);
      assert.equal(init.method, 'GET');
      return typeof options.storage === 'function' ? options.storage(init) : new Response(options.original ?? ORIGINAL, { status: options.storageStatus ?? 200, headers: options.storageHeaders });
    }
    assert.equal(data.p_user_id, USER); assert.equal(data.p_session_id, SESSION);
    const rpc = path.split('/').at(-1);
    const override = await options.rpcHandler?.(rpc, data);
    if (override) return override;
    if (options.rpcError && (!options.errorAt || rpc === options.errorAt)) return json(options.rpcError, options.rpcStatus ?? 400);
    if (rpc === 'get_collection_reference_job_from_gateway') return json(options.job ?? job());
    if (rpc === 'begin_collection_reference_import_from_gateway') return json(options.beginResult ?? job({ original_verified: false, status: 'UPLOADING' }));
    if (rpc === 'list_collection_reference_imports_from_gateway') return json(options.historyResult ?? { count: 1, rows: [job()] });
    if (rpc === 'verify_collection_reference_original_from_gateway') return json(job());
    if (rpc === 'stage_collection_reference_chunk_from_gateway') return json({ job_id: JOB, chunk_index: data.p_chunk_index, row_count: data.p_rows.length, duplicate: options.duplicate ?? false, staged_rows: data.p_rows.length, staged_chunks: 1 });
    if (rpc === 'finish_collection_reference_prepare_from_gateway') return json(job({ status: 'PREPARED', staged_rows: 1, staged_chunks: 1, manifest_sha256: 'a'.repeat(64) }));
    if (rpc === 'preview_collection_reference_import_from_gateway') return json({ job_id: JOB, mode: 'CONTACTS', status: 'PREPARED', financial_revision: 'revision-17', context_revision: 'context-5', row_count: 1, eligible_count: 1, quarantine_count: 0, can_publish: true, requires_quarantine_confirmation: false, examples: [] });
    if (rpc === 'publish_collection_reference_import_from_gateway') return json({ job_id: JOB, status: 'PUBLISHED', done: true, processed_rows: 1, published_rows: 1, skipped_manual_rows: 0, quarantined_rows: 0, remaining_rows: 0 });
    throw new Error(`Unexpected private path ${path}`);
  };
  const settings = { ALLOWED_ORIGINS: ORIGIN, SUPABASE_URL: BASE, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, ...options.env };
  const parseCsv = options.parseCsv ? (...args) => { parseCalls++; return options.parseCsv(...args); } : undefined;
  const handle = createCollectionReferenceGateway({ env: name => settings[name], fetch: fetcher, ...(parseCsv ? { parseCsv } : {}), log: event => logs.push(event) });
  const request = (data, changes = {}) => new Request(`${BASE}/functions/v1/collection-reference-import`, {
    method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...changes.headers },
    body: JSON.stringify(data), ...(changes.signal ? { signal: changes.signal } : {}),
  });
  return { calls, logs, handle, request, send: (data = begin(), changes = {}) => handle(request(data, changes)), parseCalls: () => parseCalls };
}

test('begin uses verified actor and protected original metadata without parsing or uploading the source', async () => {
  const app = setup(); const response = await app.send();
  assert.equal(response.status, 200); const payload = await response.json();
  assert.equal(payload.storage_path, `${USER}/${JOB}/original`);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(app.calls.at(-1).data, { p_user_id: USER, p_session_id: SESSION, p_mode: 'CONTACTS', p_file_name: 'referencia.xlsx', p_file_size: ORIGINAL.length, p_file_sha256: hash(ORIGINAL) });
  assert.deepEqual(app.calls.map(call => call.path), ['/auth/v1/user', '/rest/v1/rpc/current_access', '/rest/v1/rpc/begin_collection_reference_import_from_gateway']);
});

test('idempotent begin returns the original job and recovery status/history remain own-actor reads', async () => {
  const app = setup({ beginResult: job({ reused: true }) });
  assert.equal((await (await app.send()).json()).reused, true);
  assert.equal((await (await app.send({ action: 'status', job_id: JOB })).json()).job_id, JOB);
  assert.equal((await (await app.send({ action: 'history', offset: 25, limit: 10 })).json()).count, 1);
  assert.deepEqual(app.calls.at(-1).data, { p_user_id: USER, p_session_id: SESSION, p_offset: 25, p_limit: 10 });
  assert(!app.calls.some(call => call.path.startsWith('/storage/')));
});

test('director, collector, wrong resource, disabled and incomplete permissions fail before reading content or looking up a job', async () => {
  for (const options of [
    { role: 'diretor' }, { role: 'cobradora_1' }, { role: 'contas_pagar' }, { enabled: false },
    { permissions: permissions.filter(permission => permission.action !== 'write') },
    { permissions: permissions.filter(permission => permission.resource !== 'importar_bases') },
    { permissions: permissions.filter(permission => permission.action !== 'import') },
    { accessError: { code: '42501', message: SERVICE } },
  ]) {
    const app = setup({ ...options, parseCsv: () => { throw new Error('must not parse'); } });
    assert.equal((await app.send(stage(CONTACTS, { chunk_base64: 'invalid' }))).status, 403);
    assert.equal(app.calls.length, 2); assert.equal(app.parseCalls(), 0);
  }
  const manager = setup({ role: 'gerente_geral' }); assert.equal((await manager.send()).status, 200);
});

test('JWT identity and approved application session cannot be supplied by body or unverified claims', async () => {
  const missing = setup(); assert.equal((await missing.send(begin(), { headers: { Authorization: '' } })).status, 401); assert.equal(missing.calls.length, 0);
  const rejected = setup({ authStatus: 401, auth: { message: SERVICE } }); assert.equal((await rejected.send()).status, 401); assert.equal(rejected.calls.length, 1);
  for (const jwt of [token({ sub: OTHER }), token({ session_id: 'invalid' }), 'not-a-jwt']) {
    const app = setup(); assert.equal((await app.send(begin(), { headers: { Authorization: `Bearer ${jwt}` } })).status, 401); assert.equal(app.calls.length, 1);
  }
  for (const extra of [{ user_id: OTHER }, { session_id: SESSION }, { role: 'gerente_geral' }, { rows: [] }, { scope: 'other' }, { storage_path: `${OTHER}/${JOB}/original` }]) {
    const app = setup(); assert.equal((await app.send(begin(extra))).status, 400); assert.equal(app.calls.length, 2);
  }
});

test('source limits, filenames, mode, canonical hashes and exact action keys are validated before SQL', async () => {
  for (const extra of [
    { file_size: 16 * 1024 * 1024 + 1 }, { file_size: 0 }, { file_size: 1.5 }, { file_name: '../source.xlsx' }, { file_name: 'source\\x.xlsx' },
    { file_name: ' source.xlsx' }, { file_name: 'source\u0000.xlsx' }, { file_name: 'source.xls' }, { file_name: 'source.exe' },
    { file_sha256: 'a'.repeat(63) }, { file_sha256: 'A'.repeat(64) }, { mode: 'received' }, { mode: 'CONTACTS' }, { action: '__proto__' },
  ]) {
    const app = setup(); assert.equal((await app.send(begin(extra))).status, 400); assert.equal(app.calls.length, 2);
  }
  const maximum = setup({ beginResult: job({ source_size: 16 * 1024 * 1024 }) }); assert.equal((await maximum.send(begin({ file_size: 16 * 1024 * 1024 }))).status, 200);
});

test('original verification obtains a protected job first, downloads only its exact private path and hashes actual bytes', async () => {
  const app = setup({ job: job({ original_verified: false, status: 'UPLOADING' }) });
  const response = await app.send({ action: 'verify_original', job_id: JOB }); assert.equal(response.status, 200);
  assert.equal(app.calls[2].path, '/rest/v1/rpc/get_collection_reference_job_from_gateway');
  assert.equal(app.calls[3].path, `/storage/v1/object/authenticated/collection-reference-files/${USER}/${JOB}/original`);
  assert.deepEqual(app.calls.at(-1).data, { p_user_id: USER, p_session_id: SESSION, p_job_id: JOB, p_verified_sha256: hash(ORIGINAL), p_verified_size: ORIGINAL.length });
});

test('wrong owner/path/bucket/job metadata never reaches Storage with service credentials', async () => {
  for (const changes of [
    { storage_path: `${OTHER}/${JOB}/original` }, { storage_path: 'https://attacker.example.invalid/file' }, { bucket: 'public' },
    { job_id: OTHER }, { source_size: 16 * 1024 * 1024 + 1 }, { source_sha256: 'untrusted' }, { mode: 'RECEIVED' },
  ]) {
    const app = setup({ job: job(changes) }); const response = await app.send({ action: 'verify_original', job_id: JOB });
    assert.equal(response.status, 503); assert.equal(app.calls.length, 3); assert(!JSON.stringify(await response.json()).includes(OTHER));
  }
  const app = setup({ historyResult: { count: 1, rows: [job({ storage_path: `${OTHER}/${JOB}/original` })] } });
  assert.equal((await app.send({ action: 'history' })).status, 503);
});

test('job authorization revoked after initial access is rechecked by the service RPC before downloads or decoding', async () => {
  for (const action of [{ action: 'verify_original', job_id: JOB }, stage(CONTACTS, { chunk_base64: 'invalid' }), publish()]) {
    const app = setup({ rpcError: { code: '42501', message: `other owner ${OTHER} ${SERVICE}` }, errorAt: 'get_collection_reference_job_from_gateway', parseCsv: () => { throw new Error('must not parse'); } });
    const response = await app.send(action); assert.equal(response.status, 403);
    assert.equal(app.calls.length, 3); assert.equal(app.parseCalls(), 0);
    const serialized = JSON.stringify(await response.json()); assert(!serialized.includes(OTHER)); assert(!serialized.includes(SERVICE));
  }
});

test('original content hash and actual size must match the expected source before a verified flag can be written', async () => {
  for (const original of [Buffer.alloc(ORIGINAL.length, 42), ORIGINAL.subarray(0, 5)]) {
    const app = setup({ original }); const response = await app.send({ action: 'verify_original', job_id: JOB });
    assert.equal(response.status, 409); assert.equal(app.calls.length, 4);
    assert(!app.calls.some(call => call.path.includes('/verify_collection_reference_original_')));
  }
});

test('actual original streaming is bounded and canceled even when Content-Length lies or is absent', async () => {
  for (const contentLength of [null, '1']) {
    let canceled = false, emitted = 0;
    const app = setup({ storage: () => new Response(new ReadableStream({
      pull(controller) { emitted++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { canceled = true; },
    }), { headers: contentLength ? { 'Content-Length': contentLength } : {} }) });
    assert.equal((await app.send({ action: 'verify_original', job_id: JOB })).status, 413);
    assert.equal(canceled, true); assert(emitted <= 19); assert.equal(app.calls.length, 4);
  }
  let canceled = false;
  const declared = setup({ storage: () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Length': String(16 * 1024 * 1024 + 1) } }) });
  assert.equal((await declared.send({ action: 'verify_original', job_id: JOB })).status, 413); assert.equal(canceled, true);
});

test('missing original and private Storage failures never stage or leak provider responses', async () => {
  for (const [storageStatus, expected] of [[404, 409], [403, 503], [500, 503]]) {
    const app = setup({ storageStatus, original: SERVICE }); const response = await app.send({ action: 'verify_original', job_id: JOB });
    assert.equal(response.status, expected); assert.equal(app.calls.length, 4); assert(!JSON.stringify(await response.json()).includes(SERVICE));
  }
});

test('CSV stage derives canonical contacts from bytes and archives the same bytes/hash in one service transaction', async () => {
  const app = setup(); const request = stage(); const response = await app.send(request);
  assert.equal(response.status, 200); const call = app.calls.at(-1);
  assert.equal(call.path, '/rest/v1/rpc/stage_collection_reference_chunk_from_gateway');
  assert.equal(call.data.p_chunk_base64, encode(CONTACTS)); assert.equal(call.data.p_chunk_sha256, hash(CONTACTS));
  assert.equal(call.data.p_rows.length, 1);
  assert.equal(call.data.p_rows[0].source_line, 12); assert.equal(call.data.p_rows[0].client_name, 'Órgão Sintético');
  assert.deepEqual(call.data.p_rows[0].emails, ['contato@example.invalid']); assert.equal(call.data.p_rows[0].client_document, null);
  assert(Array.isArray(call.data.p_rows[0].phones)); assert.equal(call.data.p_rows[0].phones.length, 1);
  assert.deepEqual(call.data.p_problems, []);
  assert.equal(app.calls.filter(item => item.path.includes('stage_collection')).length, 1);
  assert(!app.calls.some(item => item.path.startsWith('/storage/')));
});

test('description identifiers and literal formula-looking text are preserved without execution or external requests', async () => {
  const description = '=HYPERLINK("https://example.invalid/private";"texto")';
  const csv = DESCRIPTION_HEADER + `21;Órgão Sintético;Contrato A;0000123;"${description.replaceAll('"', '""')}";4\r\n`;
  const app = setup({ job: job({ mode: 'DESCRIPTIONS' }) }); assert.equal((await app.send(stage(csv))).status, 200);
  const row = app.calls.at(-1).data.p_rows[0];
  assert.equal(row.document, '0000123'); assert.equal(row.description, description); assert.equal(row.branch, '4');
  assert.deepEqual(app.calls.at(-1).data.p_problems, []);
  assert(app.calls.every(call => !call.path.includes('example.invalid')));
});

test('invalid contact channels are server-derived warnings/quarantine, not a reason to discard original raw rows', async () => {
  const csv = CONTACT_HEADER + '12;Órgão Sintético;invalid email;31;999999999\r\n13;;also-invalid;;\r\n';
  const app = setup(); assert.equal((await app.send(stage(csv))).status, 200);
  const data = app.calls.at(-1).data;
  assert.equal(data.p_rows.length, 2); assert(data.p_problems.length >= 2);
  assert(data.p_problems.some(problem => problem.source_line === 12 && problem.code === 'WARN_INVALID_EMAIL'));
  assert.equal(data.p_chunk_base64, encode(csv));
  const serialized = JSON.stringify(await (await setup().send(stage(csv))).json());
  assert(!serialized.includes('invalid email')); assert(!serialized.includes('Órgão Sintético'));
});

test('browser cannot supply canonical rows, issues, a verification flag or a storage path for staging', async () => {
  for (const extra of [{ rows: [] }, { p_rows: [] }, { problems: [] }, { original_verified: true }, { mode: 'contacts' }, { storage_path: 'arbitrary' }, { user_id: OTHER }]) {
    const app = setup(); assert.equal((await app.send(stage(CONTACTS, extra))).status, 400); assert.equal(app.calls.length, 2);
  }
  const app = setup({ job: job({ original_verified: false }), parseCsv: () => { throw new Error('not allowed'); } });
  assert.equal((await app.send(stage())).status, 409); assert.equal(app.parseCalls(), 0); assert.equal(app.calls.length, 3);
});

test('chunk hash, canonical base64 and byte limits are checked before parsing or staging', async () => {
  const parsed = () => { throw new Error('must not parse'); };
  for (const extra of [
    { chunk_sha256: '0'.repeat(64) }, { chunk_base64: 'Zh==' }, { chunk_base64: '' }, { chunk_base64: 'Zg=' },
    { chunk_base64: encode(Buffer.alloc(256 * 1024 + 1)) }, { chunk_base64: encode(CONTACTS) + '\n' },
  ]) {
    const app = setup({ parseCsv: parsed }); const response = await app.send(stage(CONTACTS, extra));
    assert([400, 409].includes(response.status)); assert.equal(app.parseCalls(), 0); assert.equal(app.calls.length, 3);
  }
  for (const extra of [{ chunk_index: -1 }, { chunk_index: 1024 }, { chunk_index: 0.5 }]) {
    const app = setup(); assert.equal((await app.send(stage(CONTACTS, extra))).status, 400); assert.equal(app.calls.length, 2);
  }
});

test('malformed CSV, invalid UTF8, wrong headers and more than 500 rows cannot be archived or staged', async () => {
  const tooMany = CONTACT_HEADER + Array.from({ length: 501 }, (_, index) => `${index + 2};Cliente Sintético;contato@example.invalid;;`).join('\r\n');
  for (const csv of ['"unclosed', CONTACTS.replace('Entidade: nome', 'Other header'), Buffer.from([0xff, 0xfe, 0x80]), tooMany]) {
    const app = setup(); const response = await app.send(stage(csv)); assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'REFERENCE_CSV_INVALID'); assert.equal(app.calls.length, 3);
  }
});

test('safe chunk replay returns the atomic SQL duplicate result; conflicting retry fails closed', async () => {
  const app = setup({ duplicate: true }); const first = await app.send(stage()); const second = await app.send(stage());
  assert.equal(first.status, 200); assert.equal((await second.json()).duplicate, true);
  const stages = app.calls.filter(call => call.path.includes('/stage_collection_reference_'));
  assert.equal(stages.length, 2); assert.deepEqual(stages[0].data, stages[1].data);
  const conflict = setup({ rpcError: { code: '23505', message: 'Different immutable bytes, private SQL data' }, errorAt: 'stage_collection_reference_chunk_from_gateway' });
  assert.equal((await conflict.send(stage())).status, 409);
  assert.equal(conflict.calls.filter(call => call.path.includes('/stage_collection_reference_')).length, 1);
});

test('finish and preview do not publish, while publish forwards explicit revision, quarantine confirmation and replay UUID only', async () => {
  const app = setup({ job: job({ status: 'PREPARED' }) });
  assert.equal((await app.send({ action: 'finish_prepare', job_id: JOB, expected_chunks: 1 })).status, 200);
  assert.equal(app.calls.at(-1).path, '/rest/v1/rpc/finish_collection_reference_prepare_from_gateway');
  assert.equal(app.calls.at(-1).data.p_expected_chunks, 1);
  assert.equal((await app.send({ action: 'preview', job_id: JOB })).status, 200);
  assert(!app.calls.some(call => call.path.includes('/publish_collection_reference_')));
  const response = await app.send(publish({ confirm_quarantine: true })); assert.equal(response.status, 200); assert.equal((await response.json()).done, true);
  assert.deepEqual(app.calls.at(-1).data, { p_user_id: USER, p_session_id: SESSION, p_job_id: JOB, p_previous_financial_revision: 'revision-17', p_confirm_quarantine: true, p_request_id: REQUEST });
});

test('invalid publish fence, replay ID and preparation counts are blocked before any write RPC', async () => {
  for (const extra of [{ previous_financial_revision: '' }, { previous_financial_revision: ' x ' }, { previous_financial_revision: 'x'.repeat(257) }, { request_id: undefined }, { request_id: 'invalid' }, { confirm_quarantine: 'true' }, { done: true }]) {
    const app = setup(); assert.equal((await app.send(publish(extra))).status, 400); assert.equal(app.calls.length, 2);
  }
  for (const expected_chunks of [0, -1, 1025, 1.5]) {
    const app = setup(); assert.equal((await app.send({ action: 'finish_prepare', job_id: JOB, expected_chunks })).status, 400); assert.equal(app.calls.length, 2);
  }
});

test('a lost publish response can be retried with the exact same server-bound replay identity', async () => {
  let first = true;
  const app = setup({ rpcHandler: (rpc) => {
    if (rpc === 'publish_collection_reference_import_from_gateway' && first) {
      first = false; throw new Error('private transport lost after database commit');
    }
  } });
  assert.equal((await app.send(publish())).status, 503);
  assert.equal((await app.send(publish())).status, 200);
  const calls = app.calls.filter(call => call.path.includes('/publish_collection_reference_'));
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].data, calls[1].data); assert.equal(calls[1].data.p_request_id, REQUEST);
  assert.deepEqual(app.logs, ['request_unavailable']);
});

test('stale finance, quarantine, permission and missing migration failures expose only safe codes and no private state', async () => {
  for (const [code, expected] of [['40001', 409], ['P0027', 409], ['P0028', 409], ['42501', 403], ['23514', 400], ['22023', 400], ['P0002', 404], ['PGRST202', 409], ['42883', 409]]) {
    const app = setup({ rpcError: { code, message: `private SQL ${SERVICE}`, details: TOKEN }, errorAt: 'publish_collection_reference_import_from_gateway' });
    const response = await app.send(publish()); assert.equal(response.status, expected);
    const serialized = JSON.stringify({ payload: await response.json(), logs: app.logs });
    assert(!serialized.includes(SERVICE)); assert(!serialized.includes(TOKEN)); assert(!serialized.includes('private SQL'));
  }
});

test('network, parser internals and provider exceptions do not expose private content or secrets', async () => {
  for (const options of [
    { networkFailure: true },
    { rpcError: { code: 'XX000', message: SERVICE, details: TOKEN }, errorAt: 'publish_collection_reference_import_from_gateway' },
  ]) {
    const app = setup(options); const response = await app.send(publish()); assert.equal(response.status, 503);
    const serialized = JSON.stringify({ payload: await response.json(), logs: app.logs }); assert(!serialized.includes(SERVICE)); assert(!serialized.includes(TOKEN));
    assert(app.logs.every(event => ['upstream_unavailable', 'request_unavailable'].includes(event)));
  }
  const app = setup({ parseCsv: () => { throw new Error(`${SERVICE} private name`); } });
  const response = await app.send(stage()); assert.equal(response.status, 422); assert(!JSON.stringify(await response.json()).includes(SERVICE)); assert.deepEqual(app.logs, []);
});

test('actual JSON streaming is bounded even with false Content-Length and no chunk is processed', async () => {
  const app = setup(); let canceled = false, emitted = 0;
  const request = new Request(`${BASE}/functions/v1/collection-reference-import`, { method: 'POST', duplex: 'half',
    headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': '1' },
    body: new ReadableStream({ pull(controller) { emitted++; controller.enqueue(new Uint8Array(256 * 1024)); }, cancel() { canceled = true; } }),
  });
  assert.equal((await app.handle(request)).status, 400); assert.equal(canceled, true); assert(emitted <= 6); assert.equal(app.calls.length, 2);
});

test('request cancellation aborts a pending original stream without verifying or staging', async () => {
  const controller = new AbortController(); let canceled = false;
  const app = setup({ storage: () => {
    queueMicrotask(() => controller.abort());
    return new Response(new ReadableStream({ cancel() { canceled = true; } }));
  } });
  assert.equal((await app.send({ action: 'verify_original', job_id: JOB }, { signal: controller.signal })).status, 504);
  assert.equal(canceled, true); assert.equal(app.calls.length, 4);
});

test('CORS and HTTP methods are exact and fail before authentication or content handling', async () => {
  for (const origin of ['', 'https://attacker.example.invalid', `${ORIGIN}.attacker.example.invalid`]) {
    const app = setup(); assert.equal((await app.send(begin(), { headers: { Origin: origin } })).status, 403); assert.equal(app.calls.length, 0);
  }
  const app = setup();
  const valid = await app.handle(new Request(BASE, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, apikey, x-client-info' } }));
  assert.equal(valid.status, 204); assert.equal(app.calls.length, 0);
  const rejected = await app.handle(new Request(BASE, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-session-id' } }));
  assert.equal(rejected.status, 403);
  assert.equal((await app.handle(new Request(BASE, { headers: { Origin: ORIGIN } }))).status, 405);
  const bad = setup({ env: { ALLOWED_ORIGINS: 'https://example.invalid/path' } }); assert.equal((await bad.send()).status, 503); assert.equal(bad.calls.length, 0);
});

test('preview preserves bounded SQL timeout, lock and upstream error diagnostics without exposing provider data', async () => {
  const cases = [
    [{ code: '57014', message: `private SQL ${SERVICE}` }, 500, 504, '57014'],
    [{ code: '55P03', detail: `private lock ${TOKEN}` }, 500, 409, '55P03'],
    [{ error: `private proxy ${SERVICE}` }, 504, 504, 'REF_UPSTREAM_TIMEOUT'],
    [{ error: `private throttling ${TOKEN}` }, 429, 429, 'REF_RATE_LIMITED'],
  ];
  for (const [rpcError, rpcStatus, expectedStatus, code] of cases) {
    const app = setup({ rpcError, rpcStatus, errorAt: 'preview_collection_reference_import_from_gateway' });
    const response = await app.send({ action: 'preview', job_id: JOB }), payload = await response.json();
    assert.equal(response.status, expectedStatus); assert.equal(payload.code, code);
    assert.equal(payload.schema_version, COLLECTION_REFERENCE_GATEWAY_SCHEMA);
    assert.equal(payload.diagnostic.phase, 'preview'); assert.match(payload.diagnostic.request_id, /^[0-9a-f-]{36}$/i);
    assert(!JSON.stringify(payload).includes(SERVICE)); assert(!JSON.stringify(payload).includes(TOKEN)); assert(!JSON.stringify(payload).includes('private'));
    assert(!app.calls.some(call => call.path.includes('publish_collection_reference')));
  }
});

test('a timed out prepared-job preview uses its exact bounded phase and never retries or publishes', async t => {
  const deadline = new AbortController(), budgets = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { budgets.push(milliseconds); return deadline.signal; });
  const app = setup({ rpcHandler: async rpc => {
    if (rpc === 'preview_collection_reference_import_from_gateway') { deadline.abort(); throw new Error(`private cancellation ${SERVICE}`); }
  } });
  const response = await app.send({ action: 'preview', job_id: JOB }), payload = await response.json();
  assert.equal(response.status, 504); assert.equal(payload.code, 'REF_REQUEST_TIMEOUT');
  assert.equal(payload.diagnostic.phase, 'preview'); assert.deepEqual(budgets, [REFERENCE_REQUEST_BUDGET_MS]); assert.equal(budgets[0], 50000);
  assert.equal(app.calls.filter(call => call.path.endsWith('preview_collection_reference_import_from_gateway')).length, 1);
  assert(!app.calls.some(call => call.path.includes('publish_collection_reference')));
});

test('malformed successful RPC data receives a safe response error with a reference instead of private provider content', async () => {
  const app = setup({ rpcHandler: async rpc => rpc === 'get_collection_reference_job_from_gateway' ? new Response(`private HTML ${SERVICE}`, { status: 200 }) : null });
  const response = await app.send({ action: 'status', job_id: JOB }), payload = await response.json();
  assert.equal(response.status, 503); assert.equal(payload.code, 'REF_INVALID_RESPONSE'); assert.equal(payload.diagnostic.phase, 'job');
  assert(!JSON.stringify(payload).includes('private')); assert(!JSON.stringify(payload).includes(SERVICE));
});
