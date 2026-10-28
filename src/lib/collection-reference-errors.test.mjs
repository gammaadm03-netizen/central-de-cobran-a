import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCollectionReferenceFailure, collectionReferenceFailureReference, collectionReferenceFailureMessage } from './collection-reference-errors.mjs';
const requestId='10000000-0000-4000-8000-000000000001';
test('reference failures preserve only bounded safe gateway diagnostics and the failing action',()=>{
 const error=makeCollectionReferenceFailure({action:'preview',status:503,payload:{code:'57014',schema_version:'collection-reference-import/2026-10-27.1',diagnostic:{request_id:requestId,phase:'preview'},error:'private SQL and source rows',path:'secret',token:'secret'}});
 assert.equal(collectionReferenceFailureReference(error),`CONFERÊNCIA · HTTP503 · 57014 · collection-reference-import/2026-10-27.1 · ETAPA preview · ID ${requestId}`);
 assert.doesNotMatch(JSON.stringify(error),/private|secret|rows|SQL/);
});
test('unknown codes, diagnostic phases, request IDs and schema versions never become support text',()=>{
 const error=makeCollectionReferenceFailure({action:'history',status:503,payload:{code:'PRIVATE_TOKEN',schema_version:'private-token',diagnostic:{request_id:'secret',phase:'private SQL'}}});
 assert.deepEqual(error,{action:'history',code:'REF_SERVICE_UNAVAILABLE',activation_required:false,status:503});
 assert.equal(collectionReferenceFailureReference(error),'HISTÓRICO · HTTP503 · REF_SERVICE_UNAVAILABLE · SERVIÇO SEM DIAGNÓSTICO');
});
test('contact refresh diagnostics distinguish database activation from the new source layout without exposing contacts',()=>{
 const error=makeCollectionReferenceFailure({action:'preview',status:409,payload:{code:'P0052',activation_required:true,schema_version:'collection-reference-import/2026-10-28.1',diagnostic:{request_id:requestId,phase:'preview'},error:'private contact rows'}});
 assert.equal(error.code,'P0052');assert.equal(error.schema_version,'collection-reference-import/2026-10-28.1');
 assert.match(collectionReferenceFailureMessage(error,'fallback'),/atualização 052/);
 assert.doesNotMatch(JSON.stringify(error),/private|contact rows/);
 const incompatible=makeCollectionReferenceFailure({action:'stage',status:422,payload:{code:'REFERENCE_CSV_INVALID'}});
 assert.match(collectionReferenceFailureMessage(incompatible,'fallback'),/atualize a função collection-reference-import/);
});
test('legacy HTTP failures retain actionable safe categories without reading provider error strings',()=>{
 for(const [status,code] of [[401,'PGRST301'],[403,'42501'],[404,'REF_FUNCTION_NOT_FOUND'],[408,'REF_UPSTREAM_TIMEOUT'],[429,'REF_RATE_LIMITED'],[500,'REF_SERVICE_UNAVAILABLE'],[504,'REF_UPSTREAM_TIMEOUT'],[422,'REF_REQUEST_INVALID']])assert.equal(makeCollectionReferenceFailure({action:'preview',status,payload:{error:'private database content'}}).code,code);
 for(const code of ['57014','55P03','P0028','PGRST202'])assert.equal(makeCollectionReferenceFailure({action:'preview',status:503,payload:{code}}).code,code);
});
test('prepared-job read failures direct a safe resume without claiming that publication finished',()=>{
 for(const code of ['57014','55P03','REF_UPSTREAM_TIMEOUT','REF_REQUEST_TIMEOUT','REF_NETWORK_ERROR','REF_INVALID_PREVIEW','REF_SERVICE_UNAVAILABLE']){
  const message=collectionReferenceFailureMessage({action:'preview',code},'fallback');
  assert.match(message,/etapas já recebidas permanecem preservadas/);
  assert.match(message,/Reanalisar arquivo preparado/);
  assert.doesNotMatch(message,/Importação concluída|Nenhum dado foi alterado/);
 }
});
test('uncertain publication keeps the same confirmation action distinct from a read-only resume',()=>{
 const message=collectionReferenceFailureMessage({action:'publish',code:'REF_REQUEST_TIMEOUT'},'fallback');
 assert.match(message,/Conferir confirmação pendente/);assert.doesNotMatch(message,/não é necessário enviá-lo novamente|Nenhum dado|concluída/);
});
test('local parser guidance can retain its controlled message while invalid status and action do not leak',()=>{
 assert.equal(collectionReferenceFailureMessage({code:'SOURCE_MISMATCH'},'controlled parser guidance'),'controlled parser guidance');
 assert.equal(collectionReferenceFailureReference({action:'private',status:'503',code:{secret:1},request_id:'private'},'preview'),'CONFERÊNCIA · SEM RESPOSTA HTTP · REF_UNEXPECTED_ERROR · SERVIÇO SEM DIAGNÓSTICO');
});
