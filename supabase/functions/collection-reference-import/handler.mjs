import { parseReferenceCsv } from '../../../src/lib/collection-reference-parser.mjs';

// This gateway deliberately does not load an XLSX library. The original is
// preserved privately; only bounded CSV conversion artifacts are parsed here.
export const COLLECTION_REFERENCE_GATEWAY_SCHEMA = 'collection-reference-import/2026-10-27.1';
export const REFERENCE_REQUEST_BUDGET_MS = 50000;
const MAX_ORIGINAL_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 768 * 1024;
const MAX_CHUNK_ROWS = 500;
const MAX_CHUNKS = 1024;
const BUCKET = 'collection-reference-files';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const FAILURE = 'Não foi possível confirmar a operação. Confira o histórico da preparação antes de tentar novamente.';
const INVALID = 'Solicitação inválida. Selecione novamente o arquivo de referência.';
const ACTION_KEYS = {
  begin: ['action', 'mode', 'file_name', 'file_size', 'file_sha256'],
  status: ['action', 'job_id'],
  history: ['action', 'offset', 'limit'],
  verify_original: ['action', 'job_id'],
  stage: ['action', 'job_id', 'chunk_index', 'chunk_sha256', 'chunk_base64'],
  finish_prepare: ['action', 'job_id', 'expected_chunks'],
  preview: ['action', 'job_id'],
  publish: ['action', 'job_id', 'previous_financial_revision', 'confirm_quarantine', 'request_id'],
};
const RPC_NAMES = {
  begin: 'begin_collection_reference_import_from_gateway',
  get: 'get_collection_reference_job_from_gateway',
  history: 'list_collection_reference_imports_from_gateway',
  verify: 'verify_collection_reference_original_from_gateway',
  stage: 'stage_collection_reference_chunk_from_gateway',
  finish: 'finish_collection_reference_prepare_from_gateway',
  preview: 'preview_collection_reference_import_from_gateway',
  publish: 'publish_collection_reference_import_from_gateway',
};

function originsFrom(raw) {
  const values = String(raw || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!values.length) throw new Error('missing_origins');
  return new Set(values.map(value => {
    const url = new URL(value);
    if (url.origin !== value || !['https:', 'http:'].includes(url.protocol)
      || (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('invalid_origin');
    return value;
  }));
}

async function readBytes(response, maximum, signal) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    try { await response.body?.cancel(); } catch { /* Stop a rejected upload/download. */ }
    throw new Error('oversize');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty_body');
  const chunks = []; let length = 0, finished = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('request_timeout');
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      length += value.byteLength;
      if (length > maximum) throw new Error('oversize');
      chunks.push(value);
    }
    if (signal?.aborted) throw new Error('request_timeout');
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!finished) { try { await reader.cancel(); } catch { /* No upstream data is exposed. */ } }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readBody(request, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new Error('invalid_body');
  const bytes = await readBytes(request, MAX_BODY_BYTES, signal);
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_body');
  return body;
}

function decodeChunk(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3)
    || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error('invalid_base64');
  const binary = atob(encoded);
  if (!binary.length || binary.length > MAX_CHUNK_BYTES || btoa(binary) !== encoded) throw new Error('invalid_base64');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function sessionFromVerifiedToken(token, userId) {
  // Supabase Auth must validate the exact token before its claims are read.
  const part = token.split('.')[1];
  if (!part) throw new Error('invalid_session');
  const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  if (claims.sub !== userId || typeof claims.session_id !== 'string' || !UUID.test(claims.session_id)) throw new Error('invalid_session');
  return claims.session_id;
}

const hashBytes = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
const validRevision = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim();
function validBody(body) {
  const keys = typeof body.action === 'string' && Object.hasOwn(ACTION_KEYS, body.action) ? ACTION_KEYS[body.action] : null;
  if (!keys || Object.keys(body).some(key => !keys.includes(key))) return false;
  if (body.action === 'history') return (!Object.hasOwn(body, 'offset') || (Number.isSafeInteger(body.offset) && body.offset >= 0 && body.offset <= 1000000))
    && (!Object.hasOwn(body, 'limit') || (Number.isSafeInteger(body.limit) && body.limit > 0 && body.limit <= 100));
  if (body.action === 'begin') return ['contacts', 'descriptions'].includes(body.mode)
    && typeof body.file_name === 'string' && body.file_name.length > 0 && body.file_name.length <= 250
    && body.file_name === body.file_name.trim() && !/[/\\\u0000-\u001f\u007f]/.test(body.file_name)
    && /\.(xlsx|xlsm|csv)$/i.test(body.file_name)
    && Number.isSafeInteger(body.file_size) && body.file_size > 0 && body.file_size <= MAX_ORIGINAL_BYTES
    && typeof body.file_sha256 === 'string' && SHA256.test(body.file_sha256);
  if (typeof body.job_id !== 'string' || !UUID.test(body.job_id)) return false;
  if (body.action === 'stage') return Number.isSafeInteger(body.chunk_index) && body.chunk_index >= 0 && body.chunk_index < MAX_CHUNKS
    && typeof body.chunk_sha256 === 'string' && SHA256.test(body.chunk_sha256) && typeof body.chunk_base64 === 'string';
  if (body.action === 'finish_prepare') return Number.isSafeInteger(body.expected_chunks) && body.expected_chunks > 0 && body.expected_chunks <= MAX_CHUNKS;
  if (body.action === 'publish') return validRevision(body.previous_financial_revision) && typeof body.request_id === 'string' && UUID.test(body.request_id)
    && (!Object.hasOwn(body, 'confirm_quarantine') || typeof body.confirm_quarantine === 'boolean');
  return true;
}

function validJob(job, userId, jobId) {
  return job && typeof job === 'object' && job.job_id === jobId && UUID.test(jobId)
    && job.bucket === BUCKET && job.storage_path === `${userId.toLowerCase()}/${jobId.toLowerCase()}/original`
    && ['CONTACTS', 'DESCRIPTIONS'].includes(job.mode) && typeof job.original_verified === 'boolean'
    && typeof job.source_sha256 === 'string' && SHA256.test(job.source_sha256)
    && Number.isSafeInteger(job.source_size) && job.source_size > 0 && job.source_size <= MAX_ORIGINAL_BYTES;
}

export function createCollectionReferenceGateway({ env, fetch: fetcher = globalThis.fetch, parseCsv = parseReferenceCsv, log = () => {} }) {
  return async function handle(request) {
    const requestId = crypto.randomUUID();
    let phase = 'configuration';
    const diagnostic = payload => ({ ...payload, schema_version: COLLECTION_REFERENCE_GATEWAY_SCHEMA, diagnostic: { request_id: requestId, phase } });
    let origins;
    try { origins = originsFrom(env('ALLOWED_ORIGINS')); }
    catch { return new Response(JSON.stringify(diagnostic({ code: 'REF_SERVICE_UNAVAILABLE', error: FAILURE })), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
    const origin = request.headers.get('origin');
    if (!origin || !origins.has(origin)) return new Response(JSON.stringify({ error: 'Origem não autorizada.' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' } });
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    const respond = (status, payload, extra = {}) => new Response(JSON.stringify(status >= 400 ? diagnostic({ ...payload, code: payload.code ?? (status === 401 ? 'PGRST301' : status === 403 ? '42501' : status === 400 ? 'REF_REQUEST_INVALID' : 'REF_SERVICE_UNAVAILABLE') }) : payload), { status, headers: { ...headers, ...extra } });
    if (request.method === 'OPTIONS') {
      const requested = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (request.headers.get('access-control-request-method') !== 'POST' || requested.some(value => !['authorization', 'content-type', 'apikey', 'x-client-info'].includes(value))) return respond(403, { error: 'Solicitação não permitida.' });
      return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Max-Age': '600' } });
    }
    if (request.method !== 'POST') return respond(405, { error: 'Método não permitido.' }, { Allow: 'POST, OPTIONS' });
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/i)?.[1];
    if (!token) return respond(401, { error: 'Sua sessão expirou. Entre novamente.' });
    let base, serviceKey, anonKey;
    try {
      const url = new URL(env('SUPABASE_URL'));
      serviceKey = env('SUPABASE_SERVICE_ROLE_KEY'); anonKey = env('SUPABASE_ANON_KEY');
      if (!serviceKey || !anonKey || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_environment');
      base = url.origin;
    } catch { return respond(503, { error: FAILURE }); }
    const deadline = AbortSignal.timeout(REFERENCE_REQUEST_BUDGET_MS);
    const signal = AbortSignal.any([request.signal, deadline]);
    async function call(path, { service = false, method = 'POST', data } = {}) {
      const result = await fetcher(`${base}${path}`, { method, redirect: 'error', headers: { apikey: service ? serviceKey : anonKey, Authorization: `Bearer ${service ? serviceKey : token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal });
      let payload = null;
      try { payload = await result.json(); } catch { /* Never return raw provider responses. */ }
      if (result.ok && (!payload || typeof payload !== 'object' || Array.isArray(payload))) throw new Error('invalid_response');
      return { ok: result.ok, status: result.status, payload };
    }
    function failure(result) {
      const code = result.payload?.code;
      if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return respond(409, { code: 'P0028', activation_required: true, error: 'Ative a importação de referências da cobrança no banco de dados antes de continuar.' });
      if (code === '57014') return respond(504, { code, error: 'O banco interrompeu a conferência por limite de tempo. A preparação foi preservada.' });
      if (code === '55P03') return respond(409, { code, error: 'Outra operação está utilizando a base. Confira novamente a mesma preparação em instantes.' });
      if (result.status === 408 || result.status === 504) return respond(504, { code: 'REF_UPSTREAM_TIMEOUT', error: 'O serviço de dados excedeu o tempo de resposta. A preparação foi preservada.' });
      if (result.status === 429) return respond(429, { code: 'REF_RATE_LIMITED', error: 'O serviço recebeu muitas solicitações. Aguarde um pouco e confira a mesma preparação.' });
      if (code === '42501') return respond(403, { code, error: 'Seu perfil não tem permissão para esta operação.' });
      if (code === 'P0002') return respond(404, { code, error: 'Preparação não disponível. Selecione novamente o arquivo.' });
      if (['40001', '23505', 'P0027', 'P0028'].includes(code)) return respond(409, { code, error: 'A preparação precisa ser conferida. Atualize a análise antes de confirmar.' });
      if (['22023', '23514', '54000'].includes(code)) return respond(400, { code, error: 'A referência foi recusada. Confira o arquivo, os lotes e a análise antes de continuar.' });
      if (result.status === 401) return respond(401, { error: 'Sua sessão expirou. Entre novamente.' });
      log('upstream_unavailable'); return respond(503, { code: 'REF_SERVICE_UNAVAILABLE', error: FAILURE });
    }
    try {
      // Authenticate and authorize before reading bodies, downloading originals,
      // decoding chunks, or parsing any personally identifiable reference data.
      phase = 'auth';
      const auth = await call('/auth/v1/user', { method: 'GET' });
      if (!auth.ok) return [401, 403].includes(auth.status) ? respond(401, { error: 'Sua sessão expirou. Entre novamente.' }) : failure(auth);
      if (typeof auth.payload?.id !== 'string' || !UUID.test(auth.payload.id)) throw new Error('invalid_identity');
      let sessionId;
      try { sessionId = sessionFromVerifiedToken(token, auth.payload.id); }
      catch { return respond(401, { error: 'Sua sessão expirou. Entre novamente.' }); }
      phase = 'access';
      const access = await call('/rest/v1/rpc/current_access', { data: {} });
      if (!access.ok) return failure(access);
      const allowed = (resource, action) => access.payload?.permissions?.some(permission => permission?.resource === resource && permission.action === action);
      if (access.payload?.profile?.id !== auth.payload.id || access.payload.profile.enabled !== true
        || !['gerente_geral', 'contas_receber'].includes(access.payload.profile.role_key) || !Array.isArray(access.payload.permissions)
        || !['read', 'write', 'import'].every(action => allowed('contas_receber', action)) || !allowed('importar_bases', 'read')) return respond(403, { code: '42501', error: 'Seu perfil não tem permissão para esta operação.' });
      phase = 'body';
      let body;
      try { body = await readBody(request, signal); }
      catch { return respond(signal.aborted ? 504 : 400, { code: signal.aborted ? 'REF_REQUEST_TIMEOUT' : 'REF_REQUEST_INVALID', error: signal.aborted ? FAILURE : INVALID }); }
      if (!validBody(body)) return respond(400, { error: INVALID });
      const actor = { p_user_id: auth.payload.id, p_session_id: sessionId };
      const rpc = (name, data) => call(`/rest/v1/rpc/${RPC_NAMES[name]}`, { service: true, data: { ...actor, ...data } });
      if (body.action === 'history') {
        phase = 'history';
        const result = await rpc('history', { p_offset: body.offset ?? 0, p_limit: body.limit ?? 25 });
        if (!result.ok) return failure(result);
        if (!result.payload || !Array.isArray(result.payload.rows) || result.payload.rows.length > (body.limit ?? 25)
          || !Number.isSafeInteger(result.payload.count) || result.payload.count < 0
          || result.payload.rows.some(job => !validJob(job, auth.payload.id, job?.job_id))) throw new Error('invalid_job_response');
        return respond(200, result.payload);
      }
      if (body.action === 'begin') {
        phase = 'begin';
        const result = await rpc('begin', { p_mode: body.mode.toUpperCase(), p_file_name: body.file_name, p_file_size: body.file_size, p_file_sha256: body.file_sha256 });
        if (!result.ok) return failure(result);
        if (!validJob(result.payload, auth.payload.id, result.payload?.job_id) || result.payload.mode !== body.mode.toUpperCase()
          || result.payload.source_sha256 !== body.file_sha256 || result.payload.source_size !== body.file_size) throw new Error('invalid_job_response');
        return respond(200, result.payload);
      }
      // SQL checks actor, approved session, permission and job ownership on every
      // call. Never let request-supplied storage paths reach service credentials.
      phase = 'job';
      const jobResult = await rpc('get', { p_job_id: body.job_id });
      if (!jobResult.ok) return failure(jobResult);
      const job = jobResult.payload;
      if (!validJob(job, auth.payload.id, body.job_id)) throw new Error('invalid_job_response');
      if (body.action === 'status') return respond(200, job);
      if (body.action === 'verify_original') {
        phase = 'storage';
        const original = await fetcher(`${base}/storage/v1/object/authenticated/${BUCKET}/${job.storage_path}`, { method: 'GET', redirect: 'error', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal });
        if (!original.ok) return respond(original.status === 404 ? 409 : 503, { ...(original.status === 404 ? { code: 'ORIGINAL_MISSING' } : {}), error: original.status === 404 ? 'Envie o arquivo original antes de verificar a preparação.' : FAILURE });
        let bytes;
        try { bytes = await readBytes(original, MAX_ORIGINAL_BYTES, signal); }
        catch { return respond(signal.aborted ? 504 : 413, { code: signal.aborted ? 'REF_REQUEST_TIMEOUT' : 'REF_REQUEST_INVALID', error: signal.aborted ? FAILURE : 'O arquivo original excede 16 MiB ou não pôde ser lido por completo.' }); }
        if (bytes.length !== job.source_size) return respond(409, { error: 'O tamanho do original enviado não confere. Selecione novamente o arquivo.' });
        const hash = await hashBytes(bytes);
        if (hash !== job.source_sha256) return respond(409, { error: 'O original enviado não corresponde ao arquivo selecionado. Selecione novamente o arquivo.' });
        if (signal.aborted) throw new Error('request_timeout');
        const result = await rpc('verify', { p_job_id: body.job_id, p_verified_sha256: hash, p_verified_size: bytes.length });
        return result.ok ? respond(200, result.payload) : failure(result);
      }
      if (job.original_verified !== true) return respond(409, { error: 'Envie e verifique o arquivo original antes de preparar os lotes.' });
      if (body.action === 'stage') {
        phase = 'stage';
        let bytes;
        try { bytes = decodeChunk(body.chunk_base64); }
        catch { return respond(400, { error: 'Lote CSV vazio, inválido ou maior que 256 KiB.' }); }
        const hash = await hashBytes(bytes);
        if (hash !== body.chunk_sha256) return respond(409, { error: 'O conteúdo do lote não confere. Prepare novamente o arquivo.' });
        let parsed;
        try { parsed = parseCsv(bytes, job.mode.toLowerCase()); }
        catch { return respond(422, { code: 'REFERENCE_CSV_INVALID', error: 'Lote CSV inválido. Confira os cabeçalhos e prepare novamente o arquivo.' }); }
        if (!parsed || !Array.isArray(parsed.rows) || parsed.rows.length < 1 || parsed.rows.length > MAX_CHUNK_ROWS || !Array.isArray(parsed.problems)) throw new Error('invalid_parser_result');
        if (signal.aborted) throw new Error('request_timeout');
        const result = await rpc('stage', { p_job_id: body.job_id, p_chunk_index: body.chunk_index, p_chunk_sha256: hash, p_chunk_base64: body.chunk_base64, p_rows: parsed.rows, p_problems: parsed.problems });
        // The database atomically archives bytes + hash + derived rows, and
        // accepts a repeated ordinal only when its immutable artifact matches.
        return result.ok ? respond(200, result.payload) : failure(result);
      }
      const name = body.action === 'finish_prepare' ? 'finish' : body.action;
      phase = name;
      const data = { p_job_id: body.job_id,
        ...(body.action === 'finish_prepare' ? { p_expected_chunks: body.expected_chunks } : {}),
        ...(body.action === 'publish' ? { p_previous_financial_revision: body.previous_financial_revision, p_confirm_quarantine: body.confirm_quarantine ?? false, p_request_id: body.request_id } : {}),
      };
      const result = await rpc(name, data);
      return result.ok ? respond(200, result.payload) : failure(result);
    } catch (error) {
      log(signal.aborted ? 'request_timeout' : 'request_unavailable');
      if (signal.aborted) return respond(504, { code: 'REF_REQUEST_TIMEOUT', error: 'O tempo de resposta foi excedido. Confira a mesma preparação, sem reenviar o arquivo.' });
      const invalid = error instanceof Error && /^invalid_(?:identity|job_response|parser_result|response)$/.test(error.message);
      return respond(503, { code: invalid ? 'REF_INVALID_RESPONSE' : 'REF_SERVICE_UNAVAILABLE', error: FAILURE });
    }
  };
}
