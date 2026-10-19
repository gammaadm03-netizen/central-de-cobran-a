import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/lib/collection-email.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'collection-email-transport-fixture', setup(builder) {
    builder.onResolve({ filter: /^\.\/supabase$/ }, () => ({ path: 'fixture', namespace: 'collection-email-fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'collection-email-fixture' }, () => ({ contents: 'export const supabase = globalThis.__collectionEmailTestClient;' }));
  } }] });
let sequence = 0;
async function moduleWith(client) {
  globalThis.__collectionEmailTestClient = client;
  try { return await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}#${++sequence}`); }
  finally { delete globalThis.__collectionEmailTestClient; }
}
const completion = { requestId: '11111111-1111-4111-8111-111111111111', titleId: '22222222-2222-4222-8222-222222222222' };
function draft() {
  return { request_id: completion.requestId, title_id: completion.titleId, customer_key: 'modelo', client_name: 'Órgão Modelo', as_of_date: '2026-10-19', emails: ['financeiro@example.org'],
    rows: [{ title_id: completion.titleId, document: '101', branch: '1', due_date: '2026-10-18', amount_cents: 10001, category: 'OVERDUE' }],
    overdue_count: 1, upcoming_count: 0, total_count: 1, overdue_cents: 10001, upcoming_cents: 0, total_cents: 10001, revision: 'revision-modelo' };
}
function transport(result) {
  const calls = [];
  const query = { retry(value) { calls.push(['retry', value]); return this; }, abortSignal(signal) { calls.push(['signal', signal]); return this; }, then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); } };
  return { calls, rpc(name, args) { calls.push(['rpc', name, args]); return query; } };
}

test('draft RPC binds only the successful finish request and forwards AbortSignal with retries disabled', async () => {
  const value = draft(), client = transport({ data: value, error: null }), api = await moduleWith(client), controller = new AbortController();
  assert.equal(await api.readCollectionEmailDraft(completion, controller.signal), value);
  assert.deepEqual(client.calls, [['rpc', 'prepare_collection_customer_email', { p_finish_request_id: completion.requestId }], ['retry', false], ['signal', controller.signal]]);
});

test('draft read refuses unrelated or inconsistent financial data returned by transport', async () => {
  for (const mutate of [value => { value.title_id = '33333333-3333-4333-8333-333333333333'; }, value => { value.total_cents++; }]) {
    const value = draft(); mutate(value);
    const api = await moduleWith(transport({ data: value, error: null }));
    await assert.rejects(api.readCollectionEmailDraft(completion), /invalid_collection_email_draft/);
  }
});

test('draft read preserves server errors and rejects malformed completion before making an RPC', async () => {
  const error = { code: '42501', message: 'Not authorized' }, client = transport({ data: null, error }), api = await moduleWith(client);
  await assert.rejects(api.readCollectionEmailDraft(completion), failure => failure === error);
  client.calls.length = 0;
  await assert.rejects(api.readCollectionEmailDraft({ ...completion, requestId: 'invalid' }), /invalid_collection_email_completion/);
  assert.deepEqual(client.calls, []);
  const unavailable = await moduleWith(null);
  await assert.rejects(unavailable.readCollectionEmailDraft(completion), failure => failure.code === 'PGRST301');
});
