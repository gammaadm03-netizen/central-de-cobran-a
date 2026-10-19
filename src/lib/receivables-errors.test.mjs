import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReceivableFailure, receivableFailureReference, receivableImportFailureMessage } from './receivables-errors.mjs';

test('support reference preserves only fixed codes, HTTP status and validated gateway diagnostics', () => {
  const failure = makeReceivableFailure({ phase: 'preview', status: 503, payload: { code: 'CR_SERVICE_UNAVAILABLE', request_id: '10000000-0000-4000-8000-000000000001', stage: 'preview', schema_version: 'receivables-import/2026-10-19.1', error: 'private SQL with secret-token', stack: 'private stack' } });
  assert.equal(receivableFailureReference(failure), 'ANÁLISE · HTTP503 · CR_SERVICE_UNAVAILABLE · receivables-import/2026-10-19.1 · ETAPA preview · ID 10000000-0000-4000-8000-000000000001');
  assert.doesNotMatch(JSON.stringify(failure), /private|secret|stack/);
});
test('unknown or malicious diagnostic fields are discarded, including codes that merely look uppercase', () => {
  const failure = makeReceivableFailure({ phase: 'preview', status: 503, payload: { code: 'PRIVATE_SECRET_TOKEN', request_id: 'secret-token', stage: 'private SQL', schema_version: 'private-token', errors: [{ problem: 'not exposed' }] } });
  assert.deepEqual(failure, { phase: 'preview', code: 'CR_SERVICE_UNAVAILABLE', status: 503, activation_required: false, errors: [] });
  assert.match(receivableFailureReference(failure), /SERVIÇO SEM DIAGNÓSTICO$/);
  assert.doesNotMatch(receivableFailureReference(failure), /PRIVATE|secret|SQL/);
});
test('legacy HTTP failures keep actionable safe codes without echoing response messages', () => {
  for (const [status, code] of [[401,'PGRST301'],[403,'42501'],[404,'CR_FUNCTION_NOT_FOUND'],[413,'CR_FILE_TOO_LARGE'],[429,'CR_RATE_LIMITED'],[504,'CR_REQUEST_TIMEOUT'],[502,'CR_SERVICE_UNAVAILABLE']]) {
    assert.equal(makeReceivableFailure({ phase: 'commit', status, payload: { error: 'private body' } }).code, code);
  }
  for (const code of ['57014','55P03','PGRST202','42883']) assert.equal(makeReceivableFailure({ phase: 'preview', status: 503, payload: { code } }).code, code);
});
test('only structured physical file errors from HTTP422 survive with bounded fields', () => {
  const payload = { errors: [{ line: 33, column: 'Documento / NF', problem: 'Correção sintética', correction: 'Confira o vínculo.' }, { line: -1, column: 'x', problem: 'x', correction: 'x' }, { line: 5002, column: 'x', problem: 'x', correction: 'x' }, { line: 2, column: 'x'.repeat(400), problem: 'x'.repeat(600), correction: 'x'.repeat(600), stack: 'private' }] };
  const errors = makeReceivableFailure({ phase: 'preview', status: 422, payload }).errors;
  assert.equal(errors.length, 2); assert.equal(errors[0].line, 33); assert.equal(errors[1].column.length, 300); assert.equal(errors[1].problem.length, 500); assert.equal(errors[1].correction.length, 500);
  assert.equal(makeReceivableFailure({ phase: 'preview', status: 503, payload }).errors.length, 0);
});
test('preview timeout explains safe reanalysis while commit failure keeps confirmation uncertain', () => {
  for (const code of ['CR_REQUEST_TIMEOUT','CR_NETWORK_ERROR','CR_INVALID_RESPONSE','CR_SERVICE_UNAVAILABLE','57014','55P03']) {
    const preview = receivableImportFailureMessage({ code }, 'preview'), commit = receivableImportFailureMessage({ code }, 'commit');
    assert.match(preview, /arquivo e as escolhas foram preservados/); assert.match(preview, /Nenhuma baixa foi feita por esta análise/);
    assert.match(commit, /Mantenha o mesmo arquivo/); assert.doesNotMatch(commit, /Nenhum|Nenhuma|nada foi|não foi alterado/i);
  }
  assert.notEqual(receivableImportFailureMessage({ code: '57014' }), receivableImportFailureMessage({ code: 'CR_REQUEST_TIMEOUT' }));
});
test('reference rejects invalid status, phase and nested raw data', () => {
  const text = receivableFailureReference({ status: '503', phase: 'private', code: { token: 'private' }, request_id: 'private', stage: 'private' }, 'commit');
  assert.equal(text, 'CONFIRMAÇÃO · SEM RESPOSTA HTTP · CR_UNEXPECTED_ERROR · SERVIÇO SEM DIAGNÓSTICO');
});
