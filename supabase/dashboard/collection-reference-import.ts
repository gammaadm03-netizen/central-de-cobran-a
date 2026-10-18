// src/lib/collection-reference-parser.mjs
var REFERENCE_LIMITS = Object.freeze({ fileBytes: 16 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024, sharedStringBytes: 14 * 1024 * 1024, rows: 3e5, chunkRows: 500, chunkBytes: 256 * 1024, entries: 256, cellBytes: 128 * 1024 });
var REFERENCE_HEADERS = Object.freeze({ contacts: ["Entidade: nome", "Endere\xE7o: email", "T. 1: ddd", "T. 1: n\xFAmero"], descriptions: ["CLIENTE", "CONTRATO", "NOTA FISCAL", "DESCRI\xC7\xC3O", "FILIAL"] });
var utf8 = new TextEncoder();
var fail = (message) => {
  throw new Error(message);
};
var modeHeaders = (mode) => REFERENCE_HEADERS[mode] ?? fail("Tipo de refer\xEAncia inv\xE1lido.");
var headerMatches = (value, expected) => value === expected || expected === "T. 1: ddd" && value === "T.1: ddd" || expected === "T. 1: n\xFAmero" && value === "T.1: n\xFAmero";
var clean = (value) => String(value ?? "").trim();
var clientText = (value) => clean(value).replace(/\s+/gu, " ");
function csvMatrix(text) {
  const rows = [];
  let row = [], value = "", quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else value += char;
      continue;
    }
    if (afterQuote && char !== ";" && char !== "\r" && char !== "\n") fail("CSV inv\xE1lido: texto ap\xF3s aspas.");
    if (char === '"') {
      if (value || afterQuote) fail("CSV inv\xE1lido: aspas fora do in\xEDcio do campo.");
      quoted = true;
    } else if (char === ";") {
      row.push(value);
      value = "";
      afterQuote = false;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      afterQuote = false;
    } else value += char;
    if (rows.length > REFERENCE_LIMITS.chunkRows + 1) fail("O trecho CSV ultrapassa 500 linhas.");
  }
  if (quoted) fail("CSV inv\xE1lido: aspas n\xE3o finalizadas.");
  if (value || row.length || afterQuote) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}
function emailValid(value) {
  if (value.length > 320 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)) return false;
  const [local, domain] = value.split("@");
  return local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") && domain.split(".").every((part) => part.length > 0 && part.length <= 63 && !part.startsWith("-") && !part.endsWith("-"));
}
var absent = (value) => /^(?:\s*|[-–—.]+|n[ãa]o\s+(?:tem|possui|informado)|sem\s+(?:e-?mail|telefone|contato)|n\/?a|null|undefined)$/iu.test(value);
function parseReferenceCsv(input, mode) {
  const headers = modeHeaders(mode);
  const bytes = typeof input === "string" ? utf8.encode(input) : input;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > REFERENCE_LIMITS.chunkBytes) fail("Trecho CSV inv\xE1lido ou maior que 256 KiB.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    fail("CSV deve usar UTF-8 v\xE1lido.");
  }
  const matrix = csvMatrix(text);
  if (matrix.length < 2 || matrix.length > REFERENCE_LIMITS.chunkRows + 1) fail("O trecho CSV deve conter de 1 a 500 linhas.");
  const expected = ["source_line", ...headers];
  if (matrix[0].length !== expected.length || matrix[0].some((value, index) => !headerMatches(value, expected[index]))) fail("Cabe\xE7alho CSV de refer\xEAncia inv\xE1lido.");
  const rows = [], problems = [], sourceLines = /* @__PURE__ */ new Set();
  for (const cells of matrix.slice(1)) {
    if (cells.length !== expected.length) fail("CSV cont\xE9m quantidade inesperada de colunas.");
    if (!/^[1-9]\d{0,6}$/.test(cells[0]) || Number(cells[0]) > 1e6 || sourceLines.has(Number(cells[0]))) fail("Linha de origem inv\xE1lida ou repetida no trecho CSV.");
    const source_line = Number(cells[0]);
    sourceLines.add(source_line);
    const issue = (code, field, message) => problems.push({ source_line, code, field, message });
    const bounded = (value, length, field) => {
      if (value.length <= length && !/[\u0000\u000B\u000C]/u.test(value)) return value;
      issue("FIELD_TOO_LONG", field, "O campo excede o limite ou cont\xE9m caracteres de controle.");
      return "";
    };
    const client_name = bounded(clientText(cells[1]), 1500, "client_name");
    if (!client_name) issue("MISSING_CLIENT", "client_name", "Nome do cliente ausente.");
    if (mode === "contacts") {
      const emailSource = clean(cells[2]);
      let emails = [];
      if (!absent(emailSource)) {
        const tokens = emailSource.split(/[;,\s]+/u).filter(Boolean);
        let invalid = false;
        for (let token of tokens) {
          token = token.replace(/^<|>$/g, "").toLowerCase();
          if (emailValid(token)) emails.push(token);
          else invalid = true;
        }
        if (invalid) issue("WARN_INVALID_EMAIL", "emails", "H\xE1 e-mails n\xE3o reconhecidos; apenas endere\xE7os com formato v\xE1lido ser\xE3o considerados.");
      }
      emails = [...new Set(emails)];
      const dddRaw = clean(cells[3]), phoneRaw = clean(cells[4]);
      let phones = [];
      if (!absent(dddRaw) || !absent(phoneRaw)) {
        const ddd = dddRaw.replace(/[()\s]/g, "");
        let invalid = !/^[1-9]\d$/.test(ddd);
        const tokens = phoneRaw.split(/[;,/\n]+/u).filter((value) => clean(value));
        if (!tokens.length) invalid = true;
        for (const token of tokens) {
          const digits = token.replace(/[()\s.\-]/g, "");
          if (/^[1-9]\d$/.test(ddd) && /^\d{8,9}$/.test(digits)) phones.push(ddd + digits);
          else invalid = true;
        }
        if (invalid) issue("WARN_INVALID_PHONE", "phones", "H\xE1 telefones sem DDD e n\xFAmero v\xE1lidos; nenhum canal WhatsApp \xE9 presumido.");
      }
      phones = [...new Set(phones)];
      if (emails.length > 50 || phones.length > 50) {
        issue("LIMIT_METHODS", "contacts", "O cliente excede o limite de canais por linha.");
        emails = emails.slice(0, 50);
        phones = phones.slice(0, 50);
      }
      if (!emails.length && !phones.length) issue("MISSING_CONTACT", "contacts", "A linha n\xE3o possui e-mail ou telefone com formato v\xE1lido.");
      rows.push({ source_line, client_name, client_document: null, emails, phones, notes: null });
    } else {
      const contract = bounded(clean(cells[2]), 300, "contract") || null;
      const document = bounded(clean(cells[3]), 150, "document");
      const description = bounded(clean(cells[4]).replace(/\r\n?/g, "\n"), 12e3, "description");
      const branch = bounded(clean(cells[5]), 150, "branch");
      if (!document) issue("MISSING_DOCUMENT", "document", "N\xFAmero do documento ausente.");
      if (!description) issue("MISSING_DESCRIPTION", "description", "Descri\xE7\xE3o ausente.");
      if (!/^\d+$/u.test(branch) || !/[1-9]/.test(branch)) issue("INVALID_BRANCH", "branch", "A filial deve ser um c\xF3digo inteiro positivo.");
      rows.push({ source_line, document, branch, client_name, client_document: null, description, contract });
    }
  }
  const quarantined = new Set(problems.filter((problem) => !problem.code.startsWith("WARN_")).map((problem) => problem.source_line));
  return { rows, problems, stats: { rows: rows.length, problem_count: problems.length, warning_count: problems.filter((problem) => problem.code.startsWith("WARN_")).length, quarantined_rows: quarantined.size } };
}
var crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
  crcTable[i] = value >>> 0;
}

// supabase/functions/collection-reference-import/handler.mjs
var MAX_ORIGINAL_BYTES = 16 * 1024 * 1024;
var MAX_CHUNK_BYTES = 256 * 1024;
var MAX_BODY_BYTES = 768 * 1024;
var MAX_CHUNK_ROWS = 500;
var MAX_CHUNKS = 1024;
var BUCKET = "collection-reference-files";
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var SHA256 = /^[a-f0-9]{64}$/;
var FAILURE = "N\xE3o foi poss\xEDvel confirmar a opera\xE7\xE3o. Confira o hist\xF3rico da prepara\xE7\xE3o antes de tentar novamente.";
var INVALID = "Solicita\xE7\xE3o inv\xE1lida. Selecione novamente o arquivo de refer\xEAncia.";
var ACTION_KEYS = {
  begin: ["action", "mode", "file_name", "file_size", "file_sha256"],
  status: ["action", "job_id"],
  history: ["action", "offset", "limit"],
  verify_original: ["action", "job_id"],
  stage: ["action", "job_id", "chunk_index", "chunk_sha256", "chunk_base64"],
  finish_prepare: ["action", "job_id", "expected_chunks"],
  preview: ["action", "job_id"],
  publish: ["action", "job_id", "previous_financial_revision", "confirm_quarantine", "request_id"]
};
var RPC_NAMES = {
  begin: "begin_collection_reference_import_from_gateway",
  get: "get_collection_reference_job_from_gateway",
  history: "list_collection_reference_imports_from_gateway",
  verify: "verify_collection_reference_original_from_gateway",
  stage: "stage_collection_reference_chunk_from_gateway",
  finish: "finish_collection_reference_prepare_from_gateway",
  preview: "preview_collection_reference_import_from_gateway",
  publish: "publish_collection_reference_import_from_gateway"
};
function originsFrom(raw) {
  const values = String(raw || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new Error("missing_origins");
  return new Set(values.map((value) => {
    const url = new URL(value);
    if (url.origin !== value || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("invalid_origin");
    return value;
  }));
}
async function readBytes(response, maximum, signal) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    try {
      await response.body?.cancel();
    } catch {
    }
    throw new Error("oversize");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks = [];
  let length = 0, finished = false;
  const abort = () => {
    void reader.cancel().catch(() => {
    });
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (; ; ) {
      if (signal?.aborted) throw new Error("request_timeout");
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      length += value.byteLength;
      if (length > maximum) throw new Error("oversize");
      chunks.push(value);
    }
    if (signal?.aborted) throw new Error("request_timeout");
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
      }
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function readBody(request, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new Error("invalid_body");
  const bytes = await readBytes(request, MAX_BODY_BYTES, signal);
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_body");
  return body;
}
function decodeChunk(encoded) {
  if (typeof encoded !== "string" || !encoded.length || encoded.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3) || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error("invalid_base64");
  const binary = atob(encoded);
  if (!binary.length || binary.length > MAX_CHUNK_BYTES || btoa(binary) !== encoded) throw new Error("invalid_base64");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function sessionFromVerifiedToken(token, userId) {
  const part = token.split(".")[1];
  if (!part) throw new Error("invalid_session");
  const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  if (claims.sub !== userId || typeof claims.session_id !== "string" || !UUID.test(claims.session_id)) throw new Error("invalid_session");
  return claims.session_id;
}
var hashBytes = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
var validRevision = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();
function validBody(body) {
  const keys = typeof body.action === "string" && Object.hasOwn(ACTION_KEYS, body.action) ? ACTION_KEYS[body.action] : null;
  if (!keys || Object.keys(body).some((key) => !keys.includes(key))) return false;
  if (body.action === "history") return (!Object.hasOwn(body, "offset") || Number.isSafeInteger(body.offset) && body.offset >= 0 && body.offset <= 1e6) && (!Object.hasOwn(body, "limit") || Number.isSafeInteger(body.limit) && body.limit > 0 && body.limit <= 100);
  if (body.action === "begin") return ["contacts", "descriptions"].includes(body.mode) && typeof body.file_name === "string" && body.file_name.length > 0 && body.file_name.length <= 250 && body.file_name === body.file_name.trim() && !/[/\\\u0000-\u001f\u007f]/.test(body.file_name) && /\.(xlsx|xlsm|csv)$/i.test(body.file_name) && Number.isSafeInteger(body.file_size) && body.file_size > 0 && body.file_size <= MAX_ORIGINAL_BYTES && typeof body.file_sha256 === "string" && SHA256.test(body.file_sha256);
  if (typeof body.job_id !== "string" || !UUID.test(body.job_id)) return false;
  if (body.action === "stage") return Number.isSafeInteger(body.chunk_index) && body.chunk_index >= 0 && body.chunk_index < MAX_CHUNKS && typeof body.chunk_sha256 === "string" && SHA256.test(body.chunk_sha256) && typeof body.chunk_base64 === "string";
  if (body.action === "finish_prepare") return Number.isSafeInteger(body.expected_chunks) && body.expected_chunks > 0 && body.expected_chunks <= MAX_CHUNKS;
  if (body.action === "publish") return validRevision(body.previous_financial_revision) && typeof body.request_id === "string" && UUID.test(body.request_id) && (!Object.hasOwn(body, "confirm_quarantine") || typeof body.confirm_quarantine === "boolean");
  return true;
}
function validJob(job, userId, jobId) {
  return job && typeof job === "object" && job.job_id === jobId && UUID.test(jobId) && job.bucket === BUCKET && job.storage_path === `${userId.toLowerCase()}/${jobId.toLowerCase()}/original` && ["CONTACTS", "DESCRIPTIONS"].includes(job.mode) && typeof job.original_verified === "boolean" && typeof job.source_sha256 === "string" && SHA256.test(job.source_sha256) && Number.isSafeInteger(job.source_size) && job.source_size > 0 && job.source_size <= MAX_ORIGINAL_BYTES;
}
function createCollectionReferenceGateway({ env, fetch: fetcher = globalThis.fetch, parseCsv = parseReferenceCsv, log = () => {
} }) {
  return async function handle(request) {
    let origins;
    try {
      origins = originsFrom(env("ALLOWED_ORIGINS"));
    } catch {
      return new Response(JSON.stringify({ error: FAILURE }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    const origin = request.headers.get("origin");
    if (!origin || !origins.has(origin)) return new Response(JSON.stringify({ error: "Origem n\xE3o autorizada." }), { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" } });
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    const respond = (status, payload, extra = {}) => new Response(JSON.stringify(payload), { status, headers: { ...headers, ...extra } });
    if (request.method === "OPTIONS") {
      const requested = (request.headers.get("access-control-request-headers") || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
      if (request.headers.get("access-control-request-method") !== "POST" || requested.some((value) => !["authorization", "content-type", "apikey", "x-client-info"].includes(value))) return respond(403, { error: "Solicita\xE7\xE3o n\xE3o permitida." });
      return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Max-Age": "600" } });
    }
    if (request.method !== "POST") return respond(405, { error: "M\xE9todo n\xE3o permitido." }, { Allow: "POST, OPTIONS" });
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/i)?.[1];
    if (!token) return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
    let base, serviceKey, anonKey;
    try {
      const url = new URL(env("SUPABASE_URL"));
      serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
      anonKey = env("SUPABASE_ANON_KEY");
      if (!serviceKey || !anonKey || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid_environment");
      base = url.origin;
    } catch {
      return respond(503, { error: FAILURE });
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3e4)]);
    async function call(path, { service = false, method = "POST", data } = {}) {
      const result = await fetcher(`${base}${path}`, { method, redirect: "error", headers: { apikey: service ? serviceKey : anonKey, Authorization: `Bearer ${service ? serviceKey : token}`, "Content-Type": "application/json" }, body: data === void 0 ? void 0 : JSON.stringify(data), signal });
      let payload = null;
      try {
        payload = await result.json();
      } catch {
      }
      return { ok: result.ok, status: result.status, payload };
    }
    function failure(result) {
      const code = result.payload?.code;
      if (["PGRST202", "42883"].includes(code)) return respond(409, { code: "P0028", activation_required: true, error: "Ative a importa\xE7\xE3o de refer\xEAncias da cobran\xE7a no banco de dados antes de continuar." });
      if (code === "42501") return respond(403, { code, error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      if (code === "P0002") return respond(404, { code, error: "Prepara\xE7\xE3o n\xE3o dispon\xEDvel. Selecione novamente o arquivo." });
      if (["40001", "23505", "P0027", "P0028"].includes(code)) return respond(409, { code, error: "A prepara\xE7\xE3o precisa ser conferida. Atualize a an\xE1lise antes de confirmar." });
      if (["22023", "23514", "54000"].includes(code)) return respond(400, { code, error: "A refer\xEAncia foi recusada. Confira o arquivo, os lotes e a an\xE1lise antes de continuar." });
      if (result.status === 401) return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
      log("upstream_unavailable");
      return respond(503, { error: FAILURE });
    }
    try {
      const auth = await call("/auth/v1/user", { method: "GET" });
      if (!auth.ok) return [401, 403].includes(auth.status) ? respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." }) : failure(auth);
      if (typeof auth.payload?.id !== "string" || !UUID.test(auth.payload.id)) throw new Error("invalid_identity");
      let sessionId;
      try {
        sessionId = sessionFromVerifiedToken(token, auth.payload.id);
      } catch {
        return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
      }
      const access = await call("/rest/v1/rpc/current_access", { data: {} });
      if (!access.ok) return failure(access);
      const allowed = (resource, action) => access.payload?.permissions?.some((permission) => permission?.resource === resource && permission.action === action);
      if (access.payload?.profile?.id !== auth.payload.id || access.payload.profile.enabled !== true || !["gerente_geral", "contas_receber"].includes(access.payload.profile.role_key) || !Array.isArray(access.payload.permissions) || !["read", "write", "import"].every((action) => allowed("contas_receber", action)) || !allowed("importar_bases", "read")) return respond(403, { code: "42501", error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      let body;
      try {
        body = await readBody(request, signal);
      } catch {
        return respond(signal.aborted ? 503 : 400, { error: signal.aborted ? FAILURE : INVALID });
      }
      if (!validBody(body)) return respond(400, { error: INVALID });
      const actor = { p_user_id: auth.payload.id, p_session_id: sessionId };
      const rpc = (name2, data2) => call(`/rest/v1/rpc/${RPC_NAMES[name2]}`, { service: true, data: { ...actor, ...data2 } });
      if (body.action === "history") {
        const result2 = await rpc("history", { p_offset: body.offset ?? 0, p_limit: body.limit ?? 25 });
        if (!result2.ok) return failure(result2);
        if (!result2.payload || !Array.isArray(result2.payload.rows) || result2.payload.rows.length > (body.limit ?? 25) || !Number.isSafeInteger(result2.payload.count) || result2.payload.count < 0 || result2.payload.rows.some((job2) => !validJob(job2, auth.payload.id, job2?.job_id))) throw new Error("invalid_job_response");
        return respond(200, result2.payload);
      }
      if (body.action === "begin") {
        const result2 = await rpc("begin", { p_mode: body.mode.toUpperCase(), p_file_name: body.file_name, p_file_size: body.file_size, p_file_sha256: body.file_sha256 });
        if (!result2.ok) return failure(result2);
        if (!validJob(result2.payload, auth.payload.id, result2.payload?.job_id) || result2.payload.mode !== body.mode.toUpperCase() || result2.payload.source_sha256 !== body.file_sha256 || result2.payload.source_size !== body.file_size) throw new Error("invalid_job_response");
        return respond(200, result2.payload);
      }
      const jobResult = await rpc("get", { p_job_id: body.job_id });
      if (!jobResult.ok) return failure(jobResult);
      const job = jobResult.payload;
      if (!validJob(job, auth.payload.id, body.job_id)) throw new Error("invalid_job_response");
      if (body.action === "status") return respond(200, job);
      if (body.action === "verify_original") {
        const original = await fetcher(`${base}/storage/v1/object/authenticated/${BUCKET}/${job.storage_path}`, { method: "GET", redirect: "error", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal });
        if (!original.ok) return respond(original.status === 404 ? 409 : 503, { ...original.status === 404 ? { code: "ORIGINAL_MISSING" } : {}, error: original.status === 404 ? "Envie o arquivo original antes de verificar a prepara\xE7\xE3o." : FAILURE });
        let bytes;
        try {
          bytes = await readBytes(original, MAX_ORIGINAL_BYTES, signal);
        } catch {
          return respond(signal.aborted ? 503 : 413, { error: signal.aborted ? FAILURE : "O arquivo original excede 16 MiB ou n\xE3o p\xF4de ser lido por completo." });
        }
        if (bytes.length !== job.source_size) return respond(409, { error: "O tamanho do original enviado n\xE3o confere. Selecione novamente o arquivo." });
        const hash = await hashBytes(bytes);
        if (hash !== job.source_sha256) return respond(409, { error: "O original enviado n\xE3o corresponde ao arquivo selecionado. Selecione novamente o arquivo." });
        if (signal.aborted) throw new Error("request_timeout");
        const result2 = await rpc("verify", { p_job_id: body.job_id, p_verified_sha256: hash, p_verified_size: bytes.length });
        return result2.ok ? respond(200, result2.payload) : failure(result2);
      }
      if (job.original_verified !== true) return respond(409, { error: "Envie e verifique o arquivo original antes de preparar os lotes." });
      if (body.action === "stage") {
        let bytes;
        try {
          bytes = decodeChunk(body.chunk_base64);
        } catch {
          return respond(400, { error: "Lote CSV vazio, inv\xE1lido ou maior que 256 KiB." });
        }
        const hash = await hashBytes(bytes);
        if (hash !== body.chunk_sha256) return respond(409, { error: "O conte\xFAdo do lote n\xE3o confere. Prepare novamente o arquivo." });
        let parsed;
        try {
          parsed = parseCsv(bytes, job.mode.toLowerCase());
        } catch {
          return respond(422, { code: "REFERENCE_CSV_INVALID", error: "Lote CSV inv\xE1lido. Confira os cabe\xE7alhos e prepare novamente o arquivo." });
        }
        if (!parsed || !Array.isArray(parsed.rows) || parsed.rows.length < 1 || parsed.rows.length > MAX_CHUNK_ROWS || !Array.isArray(parsed.problems)) throw new Error("invalid_parser_result");
        if (signal.aborted) throw new Error("request_timeout");
        const result2 = await rpc("stage", { p_job_id: body.job_id, p_chunk_index: body.chunk_index, p_chunk_sha256: hash, p_chunk_base64: body.chunk_base64, p_rows: parsed.rows, p_problems: parsed.problems });
        return result2.ok ? respond(200, result2.payload) : failure(result2);
      }
      const name = body.action === "finish_prepare" ? "finish" : body.action;
      const data = {
        p_job_id: body.job_id,
        ...body.action === "finish_prepare" ? { p_expected_chunks: body.expected_chunks } : {},
        ...body.action === "publish" ? { p_previous_financial_revision: body.previous_financial_revision, p_confirm_quarantine: body.confirm_quarantine ?? false, p_request_id: body.request_id } : {}
      };
      const result = await rpc(name, data);
      return result.ok ? respond(200, result.payload) : failure(result);
    } catch {
      log("request_unavailable");
      return respond(503, { error: FAILURE });
    }
  };
}

// supabase/functions/collection-reference-import/index.ts
Deno.serve(createCollectionReferenceGateway({
  env: (name) => Deno.env.get(name),
  log: (event) => console.warn(`collection-reference-import:${event}`)
}));
