import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthGateway } from './handler.mjs';

const ORIGIN = 'https://central.example.test';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const TICKET = '33333333-3333-4333-8333-333333333333';
const jwt = (sub = USER, session_id = SESSION) => `header.${Buffer.from(JSON.stringify({ sub, session_id })).toString('base64url')}.signature`;
const ACCESS = { profile: { id: USER, username: 'ExampleUser', role_key: 'gerente_geral', enabled: true }, permissions: [{ resource: 'usuarios', action: 'admin' }], collector_id: null };
const ENV = { ALLOWED_ORIGINS: ORIGIN, SUPABASE_URL: 'https://project.example.test', SUPABASE_ANON_KEY: 'test-public-key', SUPABASE_SERVICE_ROLE_KEY: 'test-server-key' };
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }); }
function request(body = { action: 'sign_in', username: 'ExampleUser', password: 'test-password' }, options = {}) {
  return new Request('https://project.example.test/functions/v1/auth-gateway', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...options.headers },
    body: JSON.stringify(body), ...options,
  });
}
function harness(overrides = {}, env = ENV) {
  const calls = [];
  const logs = [];
  const handler = createAuthGateway({ env: (key) => env[key], log: (event) => logs.push(event), fetch: async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    const data = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, init, data });
    if (Object.hasOwn(overrides, path)) {
      const value = overrides[path];
      if (typeof value === 'function') return value(data, init);
      return value;
    }
    if (path.endsWith('/resolve_login')) return json({ allowed: true, ticket: TICKET, user_id: USER, email: 'private@example.test' });
    if (path.endsWith('/finish_login')) return json(data.p_success);
    if (path.endsWith('/current_access')) return json(ACCESS);
    if (path === '/auth/v1/token?grant_type=password') return json({ access_token: jwt(), refresh_token: 'refresh-example', expires_in: 3600, user: { id: USER, email: 'private@example.test' } });
    if (path === '/auth/v1/user') return json({ id: USER, email: 'private@example.test' });
    if (path.endsWith('/revoke_application_session')) return new Response(null, { status: 204 });
    if (path === '/auth/v1/logout?scope=local') return new Response(null, { status: 204 });
    throw new Error(`Unexpected test path: ${path}`);
  } });
  return { handler, calls, logs };
}

test('sign in resolves the username only server-side and returns official access and session', async () => {
  const h = harness();
  const result = await h.handler(request());
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.access, ACCESS);
  assert.equal(body.session.access_token, jwt());
  assert.equal(body.session.refresh_token, 'refresh-example');
  assert.equal(JSON.stringify(body).includes('private@example.test'), false);
  assert.equal(JSON.stringify(body).includes('test-server-key'), false);
  assert.equal(JSON.stringify(body).includes('test-password'), false);
  assert.equal(h.calls[0].data.p_username, 'ExampleUser');
  assert.match(h.calls[0].data.p_client_key, /^[a-f0-9]{64}$/);
  assert.equal(h.calls[0].init.headers.apikey, 'test-server-key');
  assert.deepEqual(h.calls[1].data, { email: 'private@example.test', password: 'test-password' });
  assert.equal(h.calls.find((call) => call.path.endsWith('/finish_login')).data.p_success, true);
  assert.equal(h.calls.find((call) => call.path.endsWith('/finish_login')).data.p_session_id, SESSION);
  assert.equal(h.calls.findIndex((call) => call.path.endsWith('/finish_login')) < h.calls.findIndex((call) => call.path.endsWith('/current_access')), true);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(h.logs, []);
});

test('bad passwords and unknown or disabled profiles have the same generic error', async () => {
  const invalid = harness({ '/auth/v1/token?grant_type=password': json({ error: 'invalid_grant', internal: 'do not expose' }, 400) });
  const absent = harness({ '/rest/v1/rpc/resolve_login': json({ allowed: true, ticket: TICKET, email: null, user_id: null }) });
  const a = await invalid.handler(request());
  const b = await absent.handler(request());
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
  assert.equal(absent.calls.some((call) => call.path.startsWith('/auth/')), false);
  for (const h of [invalid, absent]) assert.equal(h.calls.at(-1).data.p_success, false);
});

test('rate limits fail closed and never attempt password authentication', async () => {
  const h = harness({ '/rest/v1/rpc/resolve_login': json({ allowed: false, retry_after: 120 }) });
  const result = await h.handler(request());
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('retry-after'), '120');
  assert.equal(h.calls.length, 1);
});

test('database or audit outage does not return a session', async () => {
  const unavailable = harness({ '/rest/v1/rpc/resolve_login': json({ details: 'internal-db-secret' }, 500) });
  const beforeAuth = await unavailable.handler(request());
  assert.equal(beforeAuth.status, 503);
  assert.equal(unavailable.calls.length, 1);
  assert.equal(JSON.stringify(await beforeAuth.json()).includes('internal-db-secret'), false);
  const audit = harness({ '/rest/v1/rpc/finish_login': json({ error: 'audit-write-failed' }, 500) });
  const afterAuth = await audit.handler(request());
  assert.equal(afterAuth.status, 503);
  assert.equal(audit.calls.some((call) => call.path.startsWith('/auth/v1/logout')), true);
  assert.equal(JSON.stringify(await afterAuth.json()).includes('refresh-example'), false);
  assert.deepEqual(audit.logs, ['sign_in_unavailable']);
});

test('profile disabled during authentication is denied and issued session is revoked', async () => {
  const h = harness({ '/rest/v1/rpc/current_access': json({ message: 'not allowed' }, 403) });
  const result = await h.handler(request());
  assert.equal(result.status, 401);
  assert.equal(h.calls.find((call) => call.path.endsWith('/finish_login')).data.p_success, true);
  assert.equal(h.calls.some((call) => call.path.endsWith('/revoke_application_session')), true);
  assert.equal(h.calls.at(-1).path, '/auth/v1/logout?scope=local');
});

test('unknown Origin and requests without Origin cannot reach Auth or SQL', async () => {
  for (const origin of [undefined, 'https://unapproved.example.test', `${ORIGIN}.evil.test`]) {
    const h = harness();
    const headers = { 'Content-Type': 'application/json' };
    if (origin) headers.Origin = origin;
    const result = await h.handler(new Request('https://api.example.test', { method: 'POST', headers, body: '{}' }));
    assert.equal(result.status, 403);
    assert.equal(result.headers.has('access-control-allow-origin'), false);
    assert.equal(h.calls.length, 0);
  }
});

test('CORS allows only explicit configured origins and required request headers', async () => {
  const h = harness();
  const result = await h.handler(new Request('https://api.example.test', { method: 'OPTIONS', headers: {
    Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, apikey',
  } }));
  assert.equal(result.status, 204);
  assert.equal(result.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(h.calls.length, 0);
  const invalid = await h.handler(new Request('https://api.example.test', { method: 'OPTIONS', headers: {
    Origin: ORIGIN, 'Access-Control-Request-Method': 'DELETE',
  } }));
  assert.equal(invalid.status, 403);
});

test('missing origin configuration, wildcard config, or server secrets fail closed', async () => {
  for (const env of [{ ...ENV, ALLOWED_ORIGINS: '' }, { ...ENV, ALLOWED_ORIGINS: '*' }, { ...ENV, SUPABASE_SERVICE_ROLE_KEY: undefined }]) {
    const h = harness({}, env);
    assert.equal((await h.handler(request())).status, 503);
    assert.equal(h.calls.length, 0);
  }
});

test('malformed input, browser-supplied role, and oversized input are rejected without database calls', async () => {
  const inputs = [
    { action: 'sign_in', username: 'ExampleUser', password: 'pw', role: 'admin' },
    { action: 'sign_in', username: 'u@example.test', password: 'pw' },
    { action: 'sign_in', username: 'ExampleUser', password: '' },
    { action: 'sign_in', username: 'ExampleUser', password: 'x'.repeat(9000) },
    { action: 'sign_out', userId: USER },
    ['sign_in'],
  ];
  for (const input of inputs) {
    const h = harness();
    assert.equal((await h.handler(request(input))).status, 400);
    assert.equal(h.calls.length, 0);
  }
});

test('invalid methods and content types are rejected', async () => {
  const h = harness();
  assert.equal((await h.handler(new Request('https://api.example.test', { headers: { Origin: ORIGIN } }))).status, 405);
  assert.equal((await h.handler(new Request('https://api.example.test', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: '{}' }))).status, 400);
  assert.equal(h.calls.length, 0);
});

test('sign out validates the JWT with Auth, revokes application session and audits before Auth logout', async () => {
  const h = harness();
  const result = await h.handler(request({ action: 'sign_out' }, { headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${jwt()}` } }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { signed_out: true });
  assert.deepEqual(h.calls.map((call) => call.path), ['/auth/v1/user', '/rest/v1/rpc/revoke_application_session', '/auth/v1/logout?scope=local']);
  assert.equal(h.calls[1].data.p_user_id, USER);
  assert.equal(h.calls[1].data.p_session_id, SESSION);
});

test('sign out rejects invalid or expired credentials before writing audit or revocation', async () => {
  const h = harness({ '/auth/v1/user': json({ error: 'JWT expired' }, 401) });
  const result = await h.handler(request({ action: 'sign_out' }, { headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${jwt()}` } }));
  assert.equal(result.status, 401);
  assert.equal(h.calls.length, 1);
  const missing = harness();
  assert.equal((await missing.handler(request({ action: 'sign_out' }))).status, 401);
  assert.equal(missing.calls.length, 0);
});

test('sign out cannot substitute a different user in a JWT payload or omit the session ID', async () => {
  for (const token of [jwt('different-user'), jwt(USER, null)]) {
    const h = harness();
    const result = await h.handler(request({ action: 'sign_out' }, { headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }));
    assert.equal(result.status, 401);
    assert.equal(h.calls.length, 1);
  }
});

test('revocation database failures do not claim successful logout', async () => {
  const h = harness({ '/rest/v1/rpc/revoke_application_session': json({ error: 'storage-down' }, 500) });
  const result = await h.handler(request({ action: 'sign_out' }, { headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${jwt()}` } }));
  assert.equal(result.status, 503);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.logs, ['sign_out_revoke_unavailable']);
});
