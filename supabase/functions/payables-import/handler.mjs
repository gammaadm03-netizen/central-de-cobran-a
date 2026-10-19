import {
  MAX_FILE_BYTES, MAX_ROWS, parseCsv, validateWorkbookExpandedSize, validatePayableRows, validatePayablePaidRows,
} from '../../../src/lib/payables-parser.mjs';
import { validReconciliationPreview, validResolutionChoices } from './reconciliation.mjs';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_FILE_BYTES / 3);
const UUID = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
const SERVICE_FAILURE = 'Não foi possível confirmar a operação. Atualize o histórico antes de tentar novamente.';
const INVALID_REQUEST = 'Solicitação inválida. Selecione novamente o relatório completo.';
const PARSE_FAILURE = 'Não foi possível analisar o arquivo. Salve uma cópia somente com valores e confira os cabeçalhos.';
const CORRECTION = 'Confira o formato e os cabeçalhos, salve uma cópia somente com valores e tente novamente.';
const SAFE_MESSAGES = new Set([
  'Arquivo vazio.', 'Cabeçalho inválido.', 'Coluna duplicada ou ambígua.', 'Coluna obrigatória ausente.',
  'Mais de 5.000 linhas.', 'Há valores fora das colunas do cabeçalho.', 'Chave de título duplicada na mesma base.',
  'Total do relatório excede o limite de precisão.', 'Não há títulos no relatório.',
  'Fórmula não permitida. Salve uma cópia apenas com valores.',
  'Conteúdo interpretável como fórmula. Salve somente valores.',
  'Célula com conteúdo não suportado. Use somente valores.', 'Campo obrigatório vazio.',
  'Data Excel inválida.', 'Horário inválido. Use hh:mm ou hh:mm:ss, entre 00:00:00 e 23:59:59.',
  'Data inválida.', 'A data contém horário. Informe somente a data civil.', 'Data Excel inválida ou contém horário.',
  'Use dd/mm/aaaa ou aaaa-mm-dd; datas abreviadas são ambíguas.', 'Ano fora do intervalo de 1900 a 2199.', 'Data inexistente.',
  'Informe um valor numérico positivo.', 'O valor deve ter no máximo duas casas decimais.', 'Valor obrigatório.',
  'Use valor brasileiro, por exemplo 1.234,56, com até duas casas decimais.', 'Valor excede o limite seguro.',
  'CSV contém bytes inválidos. Salve uma cópia em UTF-8.', 'A base excede o limite de 5.000 linhas.',
  'Aspas inválidas no CSV. Exporte novamente em UTF-8.', 'Texto após aspas de fechamento no CSV.', 'CSV contém aspas sem fechamento.',
  'O arquivo não é uma planilha XLSX/XLSM válida.', 'Estrutura da planilha inválida.',
  'Planilha multipartes, ZIP64 ou com quantidade excessiva de arquivos.', 'Diretório da planilha inválido.',
  'Planilhas criptografadas ou ZIP64 não são aceitas.', 'Conteúdo ZIP inconsistente.',
  'Conteúdo expandido excede 20 MiB. Divida a base por uma origem completa autorizada.',
  'Planilha truncada.', 'Diretório ZIP inconsistente.',
  'Conteúdo expandido excede o tamanho seguro declarado ou 20 MiB.',
  'Tamanho expandido da planilha é inconsistente ou excede 20 MiB.',
  'A cópia para importação deve conter uma única aba com dados.', 'Planilha excede 5.000 linhas ou 100 colunas.',
  'Número de cheque inválido. Use texto ou número inteiro não negativo, sem notação científica.',
  'Formato da célula do cheque não suportado. No Excel, formate o número do cheque como Texto ou use somente zeros, como 000000.',
  'O valor pago deve ser maior que zero.',
  'O relatório de pagamentos contém situação incompatível com pagamento confirmado.',
  'Lançamento repetido no relatório de pagamentos.',
]);
const safeMessage = message => SAFE_MESSAGES.has(message) || /^Limite de (?:150|300|1500) caracteres excedido\.$/.test(message) ? message : PARSE_FAILURE;

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

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new Error('invalid_body');
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error('invalid_body');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_body');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('invalid_body'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body');
  return value;
}

function decodeFile(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > MAX_BASE64_LENGTH
    || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error('invalid_base64');
  const binary = atob(encoded);
  if (!binary.length || binary.length > MAX_FILE_BYTES || btoa(binary) !== encoded) throw new Error('invalid_base64');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function verifiedSessionId(token, userId) {
  // Supabase Auth must first validate this exact token. Decoding claims alone
  // never grants identity, permissions, or an approved application session.
  const part = token.split('.')[1];
  if (!part) throw new Error('invalid_session');
  const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.sub !== userId || typeof payload.session_id !== 'string' || !UUID.test(payload.session_id)) throw new Error('invalid_session');
  return payload.session_id;
}

function problemsFor(errors) {
  return errors.slice(0, 100).map(error => ({
    line: Number.isSafeInteger(error.line) && error.line >= 0 && error.line <= MAX_ROWS + 2 ? error.line : 0,
    column: typeof error.column === 'string' ? error.column.slice(0, 80) : 'Arquivo',
    problem: safeMessage(typeof error.problem === 'string' ? error.problem : ''),
    correction: typeof error.correction === 'string' ? error.correction.slice(0, 300) : CORRECTION,
  }));
}

/** Parse the preserved bytes on the server; no financial rows or identities are accepted from a browser. */
export function createPayablesGateway({ env, fetch: fetcher = globalThis.fetch, loadWorkbook, log = () => {} }) {
  return async function handle(request) {
    let origins;
    try { origins = originsFrom(env('ALLOWED_ORIGINS')); }
    catch { return new Response(JSON.stringify({ error: SERVICE_FAILURE }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
    const origin = request.headers.get('origin');
    if (!origin || !origins.has(origin)) return new Response(JSON.stringify({ error: 'Origem não autorizada.' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' } });
    const headers = {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
    };
    const respond = (status, payload, extra = {}) => new Response(JSON.stringify(payload), { status, headers: { ...headers, ...extra } });
    if (request.method === 'OPTIONS') {
      const requested = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(name => name.trim()).filter(Boolean);
      if (request.headers.get('access-control-request-method') !== 'POST'
        || requested.some(name => !['authorization', 'content-type', 'apikey', 'x-client-info'].includes(name))) return respond(403, { error: 'Solicitação não permitida.' });
      return new Response(null, { status: 204, headers: { ...headers,
        'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
        'Access-Control-Max-Age': '600',
      } });
    }
    if (request.method !== 'POST') return respond(405, { error: 'Método não permitido.' }, { Allow: 'POST, OPTIONS' });
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/i)?.[1];
    if (!token) return respond(401, { error: 'Sua sessão expirou. Entre novamente.' });

    let base, serviceKey, anonKey;
    try {
      serviceKey = env('SUPABASE_SERVICE_ROLE_KEY'); anonKey = env('SUPABASE_ANON_KEY');
      const url = new URL(env('SUPABASE_URL'));
      if (!serviceKey || !anonKey || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_environment');
      base = url.origin;
    } catch { return respond(503, { error: SERVICE_FAILURE }); }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(50000)]);
    async function call(path, { service = false, method = 'POST', data } = {}) {
      const result = await fetcher(`${base}${path}`, {
        method, headers: { apikey: service ? serviceKey : anonKey, Authorization: `Bearer ${service ? serviceKey : token}`, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data), signal,
      });
      let payload = null;
      try { payload = await result.json(); } catch { /* Never forward raw upstream responses. */ }
      return { ok: result.ok, status: result.status, payload };
    }
    function upstreamFailure(result) {
      const code = result.payload?.code;
      if (code === '42501') return respond(403, { code, error: 'Seu perfil não tem permissão para esta operação.' });
      if (code === '40001') return respond(409, { code, error: 'A base mudou desde a análise. Analise o arquivo novamente antes de concluir.' });
      if (code === '23505') return respond(409, { code, error: 'Este arquivo já foi importado para esta origem. Nenhum dado foi alterado.' });
      if (code === 'P0016') return respond(409, { code, error: 'Há lançamentos repetidos ou versões históricas ambíguas para a mesma filial e número. Confira parcelas e o histórico. Nenhum dado foi alterado.' });
      if (code === 'P0019') return respond(409, { code, error: 'Ative a atualização dos números de cheque no banco de dados antes de importar esta coluna. Nenhum dado foi alterado.' });
      if (code === 'P0021') return respond(409, { code, error: 'Ative a atualização de previsões e pagamentos no banco de dados antes de usar este modo. Nenhum dado foi alterado.' });
      if (code === 'P0042') return respond(409, { code, error: 'Confira a baixa sem pagamento e os dados atuais do título antes de confirmar.' });
      if (code === 'P0043') return respond(409, { code, error: 'Confira as escolhas da conciliação e atualize o banco e a função de importação quando solicitado.' });
      if (code === '22023' || code === '23514') return respond(400, { code, error: 'A importação foi recusada. Confira as linhas, a origem completa e a classificação de todos os planos.' });
      if (result.status === 401) return respond(401, { error: 'Sua sessão expirou. Entre novamente.' });
      log('upstream_unavailable');
      return respond(503, { error: SERVICE_FAILURE });
    }
    try {
      // Deny unauthorized/expired/recovery-only sessions before decoding the
      // base64, inflating XLSX, or parsing any user-supplied financial content.
      const auth = await call('/auth/v1/user', { method: 'GET' });
      if (!auth.ok) return auth.status === 401 || auth.status === 403
        ? respond(401, { error: 'Sua sessão expirou. Entre novamente.' }) : upstreamFailure(auth);
      if (typeof auth.payload?.id !== 'string' || !UUID.test(auth.payload.id)) throw new Error('invalid_identity');
      let sessionId;
      try { sessionId = verifiedSessionId(token, auth.payload.id); }
      catch { return respond(401, { error: 'Sua sessão expirou. Entre novamente.' }); }
      const access = await call('/rest/v1/rpc/current_access', { data: {} });
      if (!access.ok) return upstreamFailure(access);
      if (access.payload?.profile?.id !== auth.payload.id || access.payload.profile.enabled !== true
        || !Array.isArray(access.payload.permissions)
        || !access.payload.permissions.some(permission => permission?.resource === 'contas_pagar' && permission.action === 'import')) {
        return respond(403, { code: '42501', error: 'Seu perfil não tem permissão para esta operação.' });
      }
      let body;
      try { body = await readBody(request); }
      catch { return respond(400, { error: INVALID_REQUEST }); }
      const reconciled = body.reconciliation_version === '043';
      if (Object.keys(body).some(key => !['action', 'file_name', 'file_base64', 'mappings', 'complete', 'previous_import_id', 'mode', 'bank_mappings', 'confirm_corrections', 'previous_financial_revision', 'reconciliation_version', 'full_report', 'resolution_choices', 'request_id'].includes(key))
        || !['preview', 'commit'].includes(body.action)
        || (Object.hasOwn(body, 'mode') && !['forecast', 'payments'].includes(body.mode))
        || (Object.hasOwn(body, 'reconciliation_version') && !reconciled)
        || (Object.hasOwn(body, 'request_id') && (typeof body.request_id !== 'string' || !UUID.test(body.request_id)))
        || (!reconciled && ['full_report', 'resolution_choices', 'request_id'].some(key => Object.hasOwn(body, key)))
        || (reconciled && (!['forecast', 'payments'].includes(body.mode) || !validResolutionChoices(body.resolution_choices ?? {})
          || body.mode === 'forecast' && typeof body.full_report !== 'boolean'
          || body.mode === 'payments' && Object.hasOwn(body, 'full_report') && body.full_report !== false))
        || (body.mode !== 'payments' && (Object.hasOwn(body, 'bank_mappings') || Object.hasOwn(body, 'confirm_corrections') || !reconciled && Object.hasOwn(body, 'previous_financial_revision')))
        || typeof body.file_name !== 'string' || body.file_name.length < 1 || body.file_name.length > 250
        || body.file_name !== body.file_name.trim() || /[/\\\u0000-\u001f\u007f]/.test(body.file_name)) return respond(400, { error: INVALID_REQUEST });
      const validPlanMappings = mappings => mappings && typeof mappings === 'object' && !Array.isArray(mappings)
        && Object.keys(mappings).length <= MAX_ROWS
        && !Object.entries(mappings).some(([key, value]) => !key.trim() || key.length > 300 || typeof value !== 'string' || !value.trim() || value.length > 100);
      if ((Object.hasOwn(body, 'mappings') && !validPlanMappings(body.mappings))
        || (body.mode === 'payments' && Object.hasOwn(body, 'bank_mappings') && (!body.bank_mappings || typeof body.bank_mappings !== 'object' || Array.isArray(body.bank_mappings)
          || Object.keys(body.bank_mappings).length > MAX_ROWS
          || Object.entries(body.bank_mappings).some(([key, value]) => !key.trim() || key.length > 1000 || typeof value !== 'string' || !UUID.test(value))))
        || (Object.hasOwn(body, 'confirm_corrections') && typeof body.confirm_corrections !== 'boolean')
        || (Object.hasOwn(body, 'previous_financial_revision') && body.previous_financial_revision !== null
          && (typeof body.previous_financial_revision !== 'string' || !body.previous_financial_revision || body.previous_financial_revision !== body.previous_financial_revision.trim() || body.previous_financial_revision.length > 256))) return respond(400, { error: INVALID_REQUEST });
      if ((body.mode === 'payments' || reconciled) && !['read', 'write'].every(action => access.payload.permissions.some(permission => permission?.resource === 'contas_pagar' && permission.action === action))) {
        return respond(403, { code: '42501', error: 'Seu perfil não tem permissão para esta operação.' });
      }
      if (/\.xls$/i.test(body.file_name)) return respond(400, { error: 'O formato .xls antigo ainda não é aceito. No Excel, salve uma cópia como .xlsx.' });
      if (!/\.(xlsx|xlsm|csv)$/i.test(body.file_name)) return respond(400, { error: 'Selecione um arquivo .xlsx, .xlsm ou .csv.' });
      if (body.action === 'commit' && (body.complete !== true
        || (body.mode !== 'payments' && !validPlanMappings(body.mappings))
        || ((body.mode === 'payments' || reconciled) && (typeof body.previous_financial_revision !== 'string' || !body.previous_financial_revision))
        || (reconciled && (typeof body.request_id !== 'string' || !UUID.test(body.request_id)))
        || !(body.previous_import_id === null || (typeof body.previous_import_id === 'string' && UUID.test(body.previous_import_id))))) return respond(400, { error: INVALID_REQUEST });
      let bytes;
      try { bytes = decodeFile(body.file_base64); }
      catch { return respond(400, { error: 'O arquivo está vazio, inválido ou excede 2 MiB. Selecione novamente uma cópia do relatório completo.' }); }
      let parsed;
      try {
        let matrix, excel1904 = false;
        if (/\.csv$/i.test(body.file_name)) matrix = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        else {
          const buffer = bytes.buffer;
          await validateWorkbookExpandedSize(buffer);
          if (typeof loadWorkbook !== 'function') throw new Error('workbook_loader_unavailable');
          const loaded = await loadWorkbook(buffer);
          matrix = loaded.matrix; excel1904 = loaded.excel1904 === true;
        }
        if (!Array.isArray(matrix) || matrix.length > MAX_ROWS + 1 || matrix.some(row => !Array.isArray(row) || row.length > 100)) {
          throw new Error('Planilha excede 5.000 linhas ou 100 colunas.');
        }
        parsed = body.mode === 'payments' ? validatePayablePaidRows(matrix, { excel1904 }) : validatePayableRows(matrix, { excel1904 });
      } catch (error) {
        return respond(422, { error: 'Importação bloqueada. Nenhum dado foi alterado.', errors: [{ line: 0, column: 'Arquivo', problem: safeMessage(error instanceof Error ? error.message : ''), correction: CORRECTION }] });
      }
      if (parsed.errors.length) return respond(422, { error: 'Importação bloqueada. Nenhum dado foi alterado.', errors: problemsFor(parsed.errors) });
      if (reconciled && !validResolutionChoices(body.resolution_choices ?? {}, parsed.rows.length)) return respond(400, { error: INVALID_REQUEST });
      // Older clients without an explicit mode retain their reviewed import
      // contract. New modes must never fall back to disappearance settlement.
      const hasCheque = parsed.rows.some(row => Object.hasOwn(row, 'cheque_number'));
      if (body.mode || hasCheque) {
        const capabilities = await call('/rest/v1/rpc/payables_import_capabilities', { data: {} });
        const required = body.mode === 'forecast' ? 'forecast_incremental' : body.mode === 'payments' ? 'paid_import' : 'cheque_number';
        const missingSchema = !capabilities.ok && ['PGRST202', '42883'].includes(capabilities.payload?.code);
        if (reconciled && (missingSchema || capabilities.ok && (capabilities.payload?.reconciliation_version !== '043' || capabilities.payload?.import_reconciliation !== true))) {
          return respond(409, { code: 'P0043', activation_required: true, error: 'Ative a conciliação na importação no banco e atualize a função payables-import antes de confirmar.' });
        }
        if (missingSchema || (capabilities.ok && capabilities.payload?.[required] !== true)) {
          const code = body.mode ? 'P0021' : 'P0019';
          return upstreamFailure({ status: 409, payload: { code } });
        }
        if (!capabilities.ok) return upstreamFailure(capabilities);
        if (hasCheque && capabilities.payload?.cheque_number !== true) return upstreamFailure({ status: 409, payload: { code: 'P0019' } });
      }
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (signal.aborted) throw new Error('request_timed_out');
      if (body.action === 'preview') {
        const path = body.mode === 'payments' ? reconciled ? 'preview_payables_paid_import_v2' : 'preview_payables_paid_import' : body.mode === 'forecast' ? reconciled ? 'preview_payables_forecast_import_v2' : 'preview_payables_forecast_import' : 'preview_payables_import';
        const preview = await call(`/rest/v1/rpc/${path}`, { data: {
          p_scope: 'grupo-consolidado', p_rows: parsed.rows,
          ...(body.mode === 'payments' ? { p_bank_mappings: body.bank_mappings ?? {}, p_mappings: body.mappings ?? {} } : {}),
          ...(reconciled ? { p_resolution_choices: body.resolution_choices ?? {}, ...(body.mode === 'forecast' ? { p_full_report: body.full_report } : {}) } : {}),
        } });
        if (!preview.ok && reconciled && ['PGRST202', '42883', '42P01'].includes(preview.payload?.code)) return respond(409, { code: 'P0043', activation_required: true, error: 'Atualize a estrutura de conciliação na importação antes de analisar novamente.' });
        if (!preview.ok) return upstreamFailure(preview);
        if (!preview.payload || preview.payload.row_count !== parsed.rows.length) throw new Error('invalid_preview');
        if (reconciled && !validReconciliationPreview(preview.payload, { rowCount: parsed.rows.length, mode: body.mode, fullReport: body.full_report, sourceRows: parsed.rows, resolutionChoices: body.resolution_choices ?? {} })) throw new Error('invalid_preview');
        if (body.mode === 'payments') {
          if (preview.payload.mode !== 'payments' || !['new_payment_count', 'matched_payment_count', 'correction_count', 'conflict_count'].every(key => Number.isSafeInteger(preview.payload[key]) && preview.payload[key] >= 0)
            || typeof preview.payload.financial_revision !== 'string' || !preview.payload.financial_revision || preview.payload.financial_revision !== preview.payload.financial_revision.trim() || preview.payload.financial_revision.length > 256
            || typeof preview.payload.can_commit !== 'boolean' || !Array.isArray(preview.payload.rows) || !Array.isArray(preview.payload.errors)
            || preview.payload.rows.length !== parsed.rows.length
            || preview.payload.rows.some((row, index) => !row || typeof row !== 'object' || Array.isArray(row)
              || row.line !== index + 1
              || !['NEW_PAYMENT', 'MATCHED', 'CORRECTION', 'UNKNOWN_TITLE', 'CONFLICT', 'UNCLASSIFIED_PLAN', 'UNMAPPED_BANK', ...(reconciled ? ['WRITE_OFF', 'WRITE_OFF_PENDING', 'ADMIN_WRITEOFF'] : [])].includes(row.outcome)
              || (reconciled && row.amount_paid_cents === 1 && !['WRITE_OFF', 'WRITE_OFF_PENDING', 'UNKNOWN_TITLE', 'CONFLICT'].includes(row.outcome))
              || (reconciled && row.outcome === 'WRITE_OFF' && row.amount_paid_cents !== 1)
              || (reconciled && preview.payload.can_commit && !['NEW_PAYMENT', 'MATCHED', 'CORRECTION', 'WRITE_OFF'].includes(row.outcome))
              || !(row.title_id === null || (typeof row.title_id === 'string' && UUID.test(row.title_id)))
              || !(row.forecast_due_date === null || (typeof row.forecast_due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.forecast_due_date)))
              || typeof row.bank_mapping_key !== 'string' || !row.bank_mapping_key || row.bank_mapping_key.length > 1000
              || ['branch', 'entry_number', 'paid_on', 'amount_paid_cents', 'paid_bank'].some(key => row[key] !== parsed.rows[index][key]))
            || !Array.isArray(preview.payload.unmapped_banks) || !Array.isArray(preview.payload.bank_options) || !Array.isArray(preview.payload.unclassified_plans)) throw new Error('invalid_preview');
        } else if (!Number.isSafeInteger(preview.payload.new_count) || !Number.isSafeInteger(preview.payload.open_count) || !Number.isSafeInteger(preview.payload.settled_count)
          || (body.mode === 'forecast' && (preview.payload.mode !== 'forecast' || preview.payload.settled_count !== 0))) throw new Error('invalid_preview');
        return respond(200, { rows: body.mode === 'payments' ? preview.payload.rows : parsed.rows, preview: preview.payload, file_sha256: hash });
      }
      const path = body.mode === 'payments' ? reconciled ? 'commit_payables_paid_import_v2_from_gateway' : 'commit_payables_paid_import_from_gateway' : body.mode === 'forecast' ? reconciled ? 'commit_payables_forecast_import_v2_from_gateway' : 'commit_payables_forecast_import_from_gateway' : 'commit_payables_import_from_gateway';
      const committed = await call(`/rest/v1/rpc/${path}`, { service: true, data: {
        p_user_id: auth.payload.id, p_session_id: sessionId, p_scope: 'grupo-consolidado',
        p_file_name: body.file_name, p_file_sha256: hash, p_file_base64: body.file_base64,
        p_rows: parsed.rows, p_mappings: body.mappings ?? {}, p_previous_import_id: body.previous_import_id,
        ...(body.mode === 'payments' ? { p_bank_mappings: body.bank_mappings ?? {}, p_confirm_corrections: body.confirm_corrections ?? false, p_previous_financial_revision: body.previous_financial_revision ?? null } : body.mode === 'forecast' ? {} : { p_complete: true }),
        ...(reconciled ? { p_resolution_choices: body.resolution_choices ?? {}, p_request_id: body.request_id,
          ...(body.mode === 'forecast' ? { p_full_report: body.full_report, p_previous_financial_revision: body.previous_financial_revision } : {}) } : {}),
      } });
      if (!committed.ok && reconciled && ['PGRST202', '42883', '42P01'].includes(committed.payload?.code)) return respond(409, { code: 'P0043', activation_required: true, error: 'Atualize a estrutura de conciliação na importação antes de confirmar novamente.' });
      if (!committed.ok) return upstreamFailure(committed);
      if (!committed.payload || committed.payload.row_count !== parsed.rows.length || typeof committed.payload.import_id !== 'string'
        || !UUID.test(committed.payload.import_id)
        || (reconciled && (committed.payload.reconciliation_version !== '043' || committed.payload.request_id !== body.request_id))
        || (body.mode && (committed.payload.mode !== body.mode || committed.payload.settled_count !== 0))) throw new Error('invalid_commit_response');
      return respond(200, committed.payload);
    } catch {
      // Fixed identifiers only. Never log a file, token, credentials, financial
      // row, environment variable, raw exception, or upstream response.
      log('request_unavailable');
      return respond(503, { error: SERVICE_FAILURE });
    }
  };
}
