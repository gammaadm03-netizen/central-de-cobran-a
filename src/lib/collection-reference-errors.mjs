const actions = new Set(['begin','status','history','verify_original','stage','finish_prepare','preview','publish']);
const phases = new Set(['configuration','auth','access','body','begin','job','storage','stage','finish','preview','publish','history']);
const codes = new Set(['42501','40001','23505','23514','22023','54000','57014','55P03','P0002','P0027','P0028','PGRST202','PGRST205','PGRST301','PGRST303','42P01','42883','ORIGINAL_MISSING','SOURCE_MISMATCH',
  'REF_UPSTREAM_TIMEOUT','REF_SERVICE_UNAVAILABLE','REF_INVALID_RESPONSE','REF_RATE_LIMITED','REF_REQUEST_TIMEOUT','REF_REQUEST_INVALID','REF_INVALID_PREVIEW','REF_NETWORK_ERROR','REF_AUTH_UNAVAILABLE','REF_FUNCTION_NOT_FOUND','REF_UNEXPECTED_ERROR']);
const schema = 'collection-reference-import/2026-10-27.1';
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const actionOf = action => actions.has(action) ? action : 'preview';
function fromStatus(status) {
  if (status === 401) return 'PGRST301';
  if (status === 403) return '42501';
  if (status === 404) return 'REF_FUNCTION_NOT_FOUND';
  if (status === 408 || status === 504) return 'REF_UPSTREAM_TIMEOUT';
  if (status === 429) return 'REF_RATE_LIMITED';
  if (status >= 500) return 'REF_SERVICE_UNAVAILABLE';
  if (status >= 400) return 'REF_REQUEST_INVALID';
  return 'REF_UNEXPECTED_ERROR';
}
/** Keep only support metadata; never expose SQL, paths, tokens or source rows. */
export function makeCollectionReferenceFailure({ action, status, code, payload } = {}) {
  const source = object(payload) ? payload : {}, diagnostic = object(source.diagnostic) ? source.diagnostic : {};
  const http = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const result = { action: actionOf(action), code: codes.has(code) ? code : codes.has(source.code) ? source.code : fromStatus(http), activation_required: source.activation_required === true };
  if (http !== null) result.status = http;
  if (source.schema_version === schema) result.schema_version = schema;
  if (typeof diagnostic.request_id === 'string' && uuid.test(diagnostic.request_id)) result.request_id = diagnostic.request_id;
  if (phases.has(diagnostic.phase)) result.phase = diagnostic.phase;
  return result;
}
export function collectionReferenceFailureReference(error, action = 'preview') {
  const source = object(error) ? error : {}, diagnostic = object(source.diagnostic) ? source.diagnostic : {};
  const failure = makeCollectionReferenceFailure({ action: actions.has(source.action) ? source.action : action, status: source.status, code: source.code,
    payload: { ...source, diagnostic: { request_id: source.request_id ?? diagnostic.request_id, phase: source.phase ?? diagnostic.phase } } });
  const label = failure.action === 'publish' ? 'CONCLUSÃO' : failure.action === 'history' ? 'HISTÓRICO' : ['status','preview'].includes(failure.action) ? 'CONFERÊNCIA' : 'PREPARAÇÃO';
  return [label, failure.status ? `HTTP${failure.status}` : 'SEM RESPOSTA HTTP', failure.code, failure.schema_version ?? 'SERVIÇO SEM DIAGNÓSTICO',
    ...(failure.phase ? [`ETAPA ${failure.phase}`] : []), ...(failure.request_id ? [`ID ${failure.request_id}`] : [])].join(' · ');
}
export function collectionReferenceFailureMessage(error, fallback) {
  const source = object(error) ? error : {}, code = codes.has(source.code) ? source.code : 'REF_UNEXPECTED_ERROR';
  const problem = code === '57014' ? 'O banco interrompeu a conferência antes de concluí-la.'
    : code === '55P03' ? 'A preparação está ocupada por outra operação.'
    : ['REF_REQUEST_TIMEOUT','REF_UPSTREAM_TIMEOUT'].includes(code) ? 'A conferência excedeu o tempo de resposta do serviço.'
    : code === 'REF_NETWORK_ERROR' ? 'A conexão com o serviço de importação foi interrompida.'
    : code === 'REF_AUTH_UNAVAILABLE' ? 'Não foi possível consultar sua sessão de acesso.'
    : code === 'REF_FUNCTION_NOT_FOUND' ? 'A função collection-reference-import não foi encontrada. Solicite a publicação da função à administração.'
    : ['REF_INVALID_RESPONSE','REF_INVALID_PREVIEW'].includes(code) ? 'O serviço retornou uma conferência incompleta ou incompatível. Solicite a atualização da importação de contatos e descrições.'
    : code === 'REF_RATE_LIMITED' ? 'O serviço recebeu muitas solicitações. Aguarde um pouco antes de conferir novamente.'
    : code === 'REF_SERVICE_UNAVAILABLE' ? 'O serviço de importação está temporariamente indisponível.'
    : code === 'REF_REQUEST_INVALID' ? 'O serviço não aceitou esta solicitação. Atualize a página antes de conferir novamente.'
    : null;
  if (!problem) return fallback;
  return source.action === 'publish'
    ? `${problem} O resultado da conclusão ainda precisa ser confirmado. Use Conferir confirmação pendente para verificar o mesmo envio.`
    : `${problem} As etapas já recebidas permanecem preservadas. Se o arquivo está pronto no histórico, use Conferir ou Reanalisar arquivo preparado; não é necessário enviá-lo novamente.`;
}
