const codes = new Set(['42501','40001','23505','23514','22023','57014','55P03','P0023','P0024','P0030','PGRST202','PGRST205','PGRST301','PGRST303','42P01','42883',
  'CR_SERVICE_UNAVAILABLE','CR_REQUEST_TIMEOUT','CR_UPSTREAM_TIMEOUT','CR_INVALID_PREVIEW','CR_INVALID_RESPONSE','CR_REQUEST_INVALID','CR_RATE_LIMITED','CR_NETWORK_ERROR','CR_AUTH_UNAVAILABLE',
  'CR_FUNCTION_NOT_FOUND','CR_FILE_TOO_LARGE','CR_FILE_FORMAT_INVALID','CR_FILE_INVALID','CR_FILE_EMPTY','CR_FILE_READ_FAILED','CR_FILE_ANALYSIS_FAILED','CR_FILE_ANALYSIS_TIMEOUT','CR_HTTP_ERROR','CR_UNEXPECTED_ERROR']);
const stages = new Set(['configuration','cors','request','authenticate','authorize','parse','capabilities','preview','preview_validation','commit','commit_validation']);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const gatewayVersion = 'receivables-import/2026-10-19.1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const statusOf = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const phaseOf = value => value === 'commit' ? 'commit' : 'preview';
function httpCode(status) {
  if (status === 401) return 'PGRST301';
  if (status === 403) return '42501';
  if (status === 404) return 'CR_FUNCTION_NOT_FOUND';
  if (status === 408 || status === 504) return 'CR_REQUEST_TIMEOUT';
  if (status === 413) return 'CR_FILE_TOO_LARGE';
  if (status === 415) return 'CR_FILE_FORMAT_INVALID';
  if (status === 422) return 'CR_FILE_INVALID';
  if (status === 429) return 'CR_RATE_LIMITED';
  if (status >= 500) return 'CR_SERVICE_UNAVAILABLE';
  if (status >= 400) return 'CR_HTTP_ERROR';
  return 'CR_UNEXPECTED_ERROR';
}
export function makeReceivableFailure({ phase, status, code, payload } = {}) {
  const source = object(payload) ? payload : {}, http = statusOf(status);
  const safeCode = codes.has(code) ? code : codes.has(source.code) ? source.code : httpCode(http);
  const result = { phase: phaseOf(phase), code: safeCode, activation_required: source.activation_required === true, errors: [] };
  if (http !== null) result.status = http;
  if (typeof source.request_id === 'string' && uuid.test(source.request_id)) result.request_id = source.request_id;
  if (stages.has(source.stage)) result.stage = source.stage;
  if (source.schema_version === gatewayVersion) result.schema_version = gatewayVersion;
  if (http === 422 && Array.isArray(source.errors)) result.errors = source.errors.slice(0,100).filter(item => object(item)
    && Number.isSafeInteger(item.line) && item.line >= 0 && item.line <= 5001 && typeof item.column === 'string' && typeof item.problem === 'string' && typeof item.correction === 'string')
    .map(item => ({ line: item.line, column: item.column.slice(0,300), problem: item.problem.slice(0,500), correction: item.correction.slice(0,500) }));
  return result;
}
export function receivableFailureReference(error, phase = 'preview') {
  const source = object(error) ? error : {}, safe = makeReceivableFailure({ phase, status: source.status, code: source.code, payload: source });
  return [safe.phase === 'commit' ? 'CONFIRMAÇÃO' : 'ANÁLISE', safe.status ? `HTTP${safe.status}` : 'SEM RESPOSTA HTTP', safe.code,
    safe.schema_version ?? 'SERVIÇO SEM DIAGNÓSTICO', ...(safe.stage ? [`ETAPA ${safe.stage}`] : []), ...(safe.request_id ? [`ID ${safe.request_id}`] : [])].join(' · ');
}
export function receivableImportFailureMessage(error, phase = 'preview') {
  const source = object(error) ? error : {}, code = codes.has(source.code) ? source.code : 'CR_UNEXPECTED_ERROR';
  const problem = code === '57014' ? 'O banco interrompeu a consulta.'
    : code === '55P03' ? 'A base está ocupada por outra operação.'
    : ['CR_REQUEST_TIMEOUT','CR_UPSTREAM_TIMEOUT'].includes(code) ? 'O serviço de importação excedeu o tempo de resposta.'
    : code === 'CR_NETWORK_ERROR' ? 'A conexão com o serviço de importação foi interrompida.'
    : code === 'CR_AUTH_UNAVAILABLE' ? 'Não foi possível consultar sua sessão de acesso.'
    : code === 'CR_FUNCTION_NOT_FOUND' ? 'A função receivables-import não foi encontrada. Atualize ou publique essa função no Supabase.'
    : ['CR_INVALID_RESPONSE','CR_INVALID_PREVIEW'].includes(code) ? 'A função receivables-import retornou uma resposta inválida. Atualize a função e tente novamente.'
    : code === 'CR_RATE_LIMITED' ? 'O serviço recebeu muitas solicitações. Aguarde um pouco antes de tentar novamente.'
    : code === 'CR_REQUEST_INVALID' ? 'A função de importação não aceitou a solicitação. Atualize a página e a função receivables-import.'
    : code === 'CR_FILE_INVALID' ? 'O relatório foi recusado na conferência. Confira as colunas e os dados do arquivo.'
    : code === 'CR_FILE_TOO_LARGE' ? 'O arquivo excede o limite de 2 MiB.'
    : code === 'CR_FILE_EMPTY' ? 'O arquivo selecionado está vazio.'
    : code === 'CR_FILE_FORMAT_INVALID' ? 'Selecione um arquivo .xlsx, .xlsm ou .csv. Para .xls antigo, salve uma cópia como .xlsx.'
    : code === 'CR_FILE_READ_FAILED' ? 'Não foi possível ler o arquivo selecionado. Selecione novamente a cópia do relatório.'
    : code === 'CR_FILE_ANALYSIS_TIMEOUT' ? 'A leitura da planilha excedeu o tempo disponível. Salve uma cópia somente com valores e tente novamente.'
    : code === 'CR_FILE_ANALYSIS_FAILED' ? 'Não foi possível analisar a cópia da planilha. Confira o formato e tente novamente.'
    : ['PGRST202','PGRST205','42P01','42883'].includes(code) ? 'Atualize o banco e a função receivables-import antes de usar esta importação.'
    : code === 'CR_SERVICE_UNAVAILABLE' ? 'O serviço de importação está temporariamente indisponível.'
    : 'Não foi possível concluir esta etapa da importação.';
  return phaseOf(phase) === 'commit'
    ? `${problem} Não foi possível confirmar o resultado do envio. Mantenha o mesmo arquivo e confira novamente antes de repetir a importação.`
    : `${problem} O arquivo e as escolhas foram preservados; analise novamente. Nenhuma baixa foi feita por esta análise.`;
}
