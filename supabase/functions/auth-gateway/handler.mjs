/** Username login broker. It never accepts roles, user IDs or email mappings from a browser. */
const MAX_BODY_BYTES = 8192;
const AUTH_FAILURE = 'Usuário ou senha inválidos.';
const SERVICE_FAILURE = 'Não foi possível entrar agora. Tente novamente em instantes.';
const RECOVERY_ACCEPTED = 'Se o acesso estiver ativo, enviaremos as instruções de redefinição ao e-mail cadastrado.';
const PASSWORD_FAILURE = 'Não foi possível redefinir a senha agora. Tente novamente em instantes.';
const PASSWORD_UNCERTAIN = 'A senha pode ter sido alterada, mas não foi possível confirmar o encerramento seguro. Solicite um novo link antes de tentar novamente.';

function allowedOrigins(raw) {
  const values = String(raw || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new Error('missing_origins');
  return new Set(values.map((value) => {
    const parsed = new URL(value);
    if (parsed.origin !== value || !['https:', 'http:'].includes(parsed.protocol)
      || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))) {
      throw new Error('invalid_origin');
    }
    return value;
  }));
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    throw new Error('invalid_body');
  }
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new Error('invalid_body');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_body');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('invalid_body');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_body');
  return body;
}

async function sha256(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sessionPayload(payload) {
  if (typeof payload?.access_token !== 'string' || typeof payload?.refresh_token !== 'string'
    || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) throw new Error('invalid_session');
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: payload.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + payload.expires_in,
    token_type: 'bearer',
  };
}

function verifiedSessionId(token, userId) {
  // This parser does not authenticate JWTs. Call it only after /auth/v1/user has
  // validated this exact Bearer token with Supabase Auth.
  const encoded = token.split('.')[1];
  if (!encoded) throw new Error('invalid_session');
  const payload = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.sub !== userId || typeof payload.session_id !== 'string'
    || !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(payload.session_id)) {
    throw new Error('invalid_session');
  }
  return payload.session_id;
}

/** Dependencies are injectable for tests; runtime secrets stay in Supabase's server environment. */
export function createAuthGateway({ env, fetch: fetcher = globalThis.fetch, log = () => {} }) {
  return async function handle(request) {
    let origins;
    try { origins = allowedOrigins(env('ALLOWED_ORIGINS')); }
    catch { return new Response(JSON.stringify({ error: SERVICE_FAILURE }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }

    const origin = request.headers.get('origin');
    if (!origin || !origins.has(origin)) {
      return new Response(JSON.stringify({ error: 'Origem não autorizada.' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' } });
    }
    const responseHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    };
    const respond = (status, payload, extra = {}) => new Response(
      JSON.stringify(payload), { status, headers: { ...responseHeaders, ...extra } },
    );
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('access-control-request-method');
      const headers = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map((name) => name.trim()).filter(Boolean);
      if (method !== 'POST' || headers.some((name) => !['authorization', 'content-type', 'apikey', 'x-client-info'].includes(name))) {
        return respond(403, { error: 'Solicitação não permitida.' });
      }
      return new Response(null, { status: 204, headers: { ...responseHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
        'Access-Control-Max-Age': '600',
      } });
    }
    if (request.method !== 'POST') return respond(405, { error: 'Método não permitido.' }, { Allow: 'POST, OPTIONS' });

    let body;
    try { body = await readBody(request); }
    catch { return respond(400, { error: 'Solicitação inválida.' }); }
    if (!['sign_in', 'sign_out', 'request_password_reset', 'change_password'].includes(body.action)) return respond(400, { error: 'Solicitação inválida.' });
    if (body.action === 'sign_in' && (
      Object.keys(body).some((key) => !['action', 'username', 'password'].includes(key))
      || typeof body.username !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(body.username.trim())
      || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 1024
    )) return respond(400, { error: 'Informe um usuário e uma senha válidos.' });
    if (body.action === 'sign_out' && Object.keys(body).some((key) => key !== 'action')) return respond(400, { error: 'Solicitação inválida.' });
    if (body.action === 'request_password_reset' && (
      Object.keys(body).some((key) => !['action', 'username'].includes(key))
      || typeof body.username !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(body.username.trim())
    )) return respond(400, { error: 'Informe um usuário válido.' });
    if (body.action === 'change_password' && (
      Object.keys(body).some((key) => !['action', 'password'].includes(key))
      || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 1024
    )) return respond(400, { error: 'Use uma senha com pelo menos 12 e no máximo 1.024 caracteres.' });

    const serverUrl = env('SUPABASE_URL');
    const serverKey = env('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = env('SUPABASE_ANON_KEY');
    if (!serverUrl || !serverKey || !anonKey) return respond(503, { error: SERVICE_FAILURE });
    let base;
    try {
      const url = new URL(serverUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid_url');
      base = url.origin;
    } catch { return respond(503, { error: SERVICE_FAILURE }); }

    async function call(path, { token = serverKey, key = serverKey, method = 'POST', data } = {}) {
      const result = await fetcher(`${base}${path}`, {
        method,
        headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(10000),
      });
      let payload = null;
      if (result.status !== 204) {
        try { payload = await result.json(); } catch { /* No upstream details reach clients or logs. */ }
      }
      return { ok: result.ok, status: result.status, payload };
    }
    const userAgent = (request.headers.get('user-agent') || '').slice(0, 300);
    async function revoke(token) {
      const result = await call('/auth/v1/logout?scope=local', { token, key: anonKey });
      // An already invalid JWT is also signed out. Network/upstream errors are not success.
      return result.ok || result.status === 401 || result.status === 403;
    }

    if (body.action === 'request_password_reset') {
      let recoveryTicket;
      let accepted = false;
      try {
        const network = (request.headers.get('x-forwarded-for') || 'unavailable').slice(0, 256);
        const resolved = await call('/rest/v1/rpc/resolve_login', {
          data: { p_username: body.username.trim(), p_client_key: await sha256(network) },
        });
        if (!resolved.ok || typeof resolved.payload?.allowed !== 'boolean') throw new Error('rate_store_unavailable');
        if (!resolved.payload.allowed) {
          const retry = Math.max(1, Math.min(900, Math.ceil(Number(resolved.payload.retry_after) || 30)));
          return respond(429, { error: 'Muitas tentativas. Aguarde e tente novamente.' }, { 'Retry-After': String(retry) });
        }
        recoveryTicket = resolved.payload.ticket;
        if (typeof recoveryTicket !== 'string') throw new Error('invalid_ticket');
        if (typeof resolved.payload.email === 'string' && typeof resolved.payload.user_id === 'string') {
          try {
            const recovery = await call(`/auth/v1/recover?redirect_to=${encodeURIComponent(`${origin}/?password-reset=1`)}`, {
              key: anonKey, token: anonKey, data: { email: resolved.payload.email },
            });
            accepted = recovery.ok;
            if (!accepted) log('password_recovery_email_unavailable');
          } catch { log('password_recovery_email_unavailable'); }
        }
        const finished = await call('/rest/v1/rpc/finish_password_recovery', {
          data: { p_ticket: recoveryTicket, p_accepted: accepted, p_user_agent: userAgent },
        });
        recoveryTicket = undefined;
        if (!finished.ok || finished.payload !== true) throw new Error('audit_unavailable');
        // Never reveal whether a username, active account, or email exists, nor
        // whether the Auth mail provider accepted the request.
        return respond(202, { message: RECOVERY_ACCEPTED });
      } catch {
        if (recoveryTicket) {
          try { await call('/rest/v1/rpc/finish_password_recovery', {
            data: { p_ticket: recoveryTicket, p_accepted: accepted, p_user_agent: userAgent },
          }); } catch { /* The lease remains until timeout; never reset throttle. */ }
        }
        log('password_recovery_unavailable');
        return respond(503, { error: PASSWORD_FAILURE });
      }
    }

    if (body.action === 'change_password') {
      const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~-]+)$/i)?.[1];
      if (!token) return respond(401, { error: 'Link de redefinição inválido ou expirado. Solicite outro link.' });
      let changeTicket;
      let passwordChanged = false;
      let passwordChangeAttempted = false;
      let authChangeResultKnown = false;
      try {
        // Recovery Auth JWTs deliberately have no approved application session.
        // Verify Auth identity first, then check the official active profile in
        // a service-only transaction; do not grant app access to this JWT.
        const user = await call('/auth/v1/user', { method: 'GET', token, key: anonKey });
        if (!user.ok || typeof user.payload?.id !== 'string') return respond(401, { error: 'Link de redefinição inválido ou expirado. Solicite outro link.' });
        let sessionId;
        try { sessionId = verifiedSessionId(token, user.payload.id); }
        catch { return respond(401, { error: 'Link de redefinição inválido ou expirado. Solicite outro link.' }); }
        const admitted = await call('/rest/v1/rpc/begin_password_change', {
          data: { p_user_id: user.payload.id, p_session_id: sessionId, p_user_agent: userAgent },
        });
        if (!admitted.ok || typeof admitted.payload?.allowed !== 'boolean') throw new Error('admission_unavailable');
        if (!admitted.payload.allowed) {
          if (admitted.payload.reason === 'inactive') return respond(401, { error: 'Acesso indisponível. Procure a Gerência Geral.' });
          const retry = Math.max(1, Math.min(900, Math.ceil(Number(admitted.payload.retry_after) || 30)));
          return respond(429, { error: 'Muitas tentativas. Aguarde e tente novamente.' }, { 'Retry-After': String(retry) });
        }
        changeTicket = admitted.payload.ticket;
        if (typeof changeTicket !== 'string') throw new Error('invalid_ticket');
        passwordChangeAttempted = true;
        const changed = await call('/auth/v1/user', { method: 'PUT', token, key: anonKey, data: { password: body.password } });
        // An upstream timeout/server error can follow a committed password
        // write. Only success or an explicit client rejection is conclusive.
        authChangeResultKnown = changed.ok || (changed.status >= 400 && changed.status < 500 && changed.status !== 408);
        if (!authChangeResultKnown) throw new Error('auth_change_outcome_unknown');
        passwordChanged = changed.ok;
        const completed = await call('/rest/v1/rpc/finish_password_change', {
          data: { p_ticket: changeTicket, p_success: passwordChanged },
        });
        changeTicket = undefined;
        if (!completed.ok || completed.payload !== true) throw new Error('audit_unavailable');
        if (!passwordChanged) return respond(400, { error: 'Não foi possível aceitar essa senha. Use uma senha diferente ou solicite um novo link.' });
        if (!await revoke(token)) throw new Error('revocation_unavailable');
        return respond(200, { password_changed: true, signed_out: true });
      } catch {
        const uncertain = passwordChanged || (passwordChangeAttempted && !authChangeResultKnown);
        if (changeTicket) {
          try { await call('/rest/v1/rpc/finish_password_change', { data: { p_ticket: changeTicket, p_success: authChangeResultKnown ? passwordChanged : (passwordChangeAttempted ? null : false) } }); }
          catch { /* Never claim an unaudited password change succeeded. */ }
        }
        if (uncertain) { try { await revoke(token); } catch { /* App sessions were already revoked before Auth change. */ } }
        log(uncertain ? 'password_change_completion_unavailable' : 'password_change_unavailable');
        return respond(503, { error: uncertain ? PASSWORD_UNCERTAIN : PASSWORD_FAILURE });
      }
    }

    if (body.action === 'sign_out') {
      const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~-]+)$/i)?.[1];
      if (!token) return respond(401, { error: 'Sessão inválida.' });
      try {
        const user = await call('/auth/v1/user', { method: 'GET', token, key: anonKey });
        if (!user.ok || typeof user.payload?.id !== 'string') return respond(401, { error: 'Sessão inválida.' });
        let sessionId;
        try { sessionId = verifiedSessionId(token, user.payload.id); }
        catch { return respond(401, { error: 'Sessão inválida.' }); }
        // Revoke application access first: every existing RLS helper checks this
        // session ID, so access JWTs are denied even before their natural expiry.
        const audit = await call('/rest/v1/rpc/revoke_application_session', {
          data: { p_user_id: user.payload.id, p_session_id: sessionId, p_user_agent: userAgent },
        });
        if (!audit.ok) { log('sign_out_revoke_unavailable'); return respond(503, { error: 'Não foi possível encerrar a sessão. Tente novamente.' }); }
        if (!await revoke(token)) return respond(503, { error: 'Não foi possível encerrar a sessão. Tente novamente.' });
        return respond(200, { signed_out: true });
      } catch { log('sign_out_unavailable'); return respond(503, { error: 'Não foi possível encerrar a sessão. Tente novamente.' }); }
    }

    let ticket;
    let issuedToken;
    let issuedUserId;
    let issuedSessionId;
    async function revokeIssuedSession() {
      if (issuedUserId && issuedSessionId) {
        const appRevoked = await call('/rest/v1/rpc/revoke_application_session', {
          data: { p_user_id: issuedUserId, p_session_id: issuedSessionId, p_user_agent: userAgent },
        });
        if (!appRevoked.ok) log('failed_application_session_revoke_unavailable');
      }
      if (issuedToken && !await revoke(issuedToken)) log('failed_session_revoke_unavailable');
    }
    try {
      // Network headers are advisory and can be absent/spoofed. The independent,
      // atomic account bucket is mandatory and cannot be bypassed by changing IP.
      const network = (request.headers.get('x-forwarded-for') || 'unavailable').slice(0, 256);
      const clientKey = await sha256(network);
      const resolved = await call('/rest/v1/rpc/resolve_login', { data: { p_username: body.username.trim(), p_client_key: clientKey } });
      if (!resolved.ok || typeof resolved.payload?.allowed !== 'boolean') throw new Error('rate_store_unavailable');
      if (!resolved.payload.allowed) {
        const retry = Math.max(1, Math.min(900, Math.ceil(Number(resolved.payload.retry_after) || 30)));
        return respond(429, { error: 'Muitas tentativas. Aguarde e tente novamente.' }, { 'Retry-After': String(retry) });
      }
      ticket = resolved.payload.ticket;
      if (typeof ticket !== 'string') throw new Error('invalid_ticket');
      let authenticated;
      if (typeof resolved.payload.email === 'string' && typeof resolved.payload.user_id === 'string') {
        authenticated = await call('/auth/v1/token?grant_type=password', {
          key: anonKey, token: anonKey, data: { email: resolved.payload.email, password: body.password },
        });
      }
      if (!authenticated?.ok || typeof authenticated.payload?.access_token !== 'string'
        || authenticated.payload?.user?.id !== resolved.payload.user_id) {
        const finished = await call('/rest/v1/rpc/finish_login', { data: { p_ticket: ticket, p_success: false, p_session_id: null, p_user_agent: userAgent } });
        ticket = undefined;
        if (!finished.ok) throw new Error('audit_unavailable');
        return respond(401, { error: AUTH_FAILURE });
      }
      const session = sessionPayload(authenticated.payload);
      issuedToken = session.access_token;
      issuedUserId = resolved.payload.user_id;
      issuedSessionId = verifiedSessionId(issuedToken, issuedUserId);
      // Approve this Auth session only after limits and the official active
      // profile check; a direct email/password Auth JWT has no app access.
      const finished = await call('/rest/v1/rpc/finish_login', {
        data: { p_ticket: ticket, p_success: true, p_session_id: issuedSessionId, p_user_agent: userAgent },
      });
      ticket = undefined;
      if (!finished.ok) throw new Error('audit_unavailable');
      if (finished.payload !== true) {
        await revokeIssuedSession();
        issuedToken = undefined;
        return respond(401, { error: AUTH_FAILURE });
      }
      const access = await call('/rest/v1/rpc/current_access', { key: anonKey, token: issuedToken, data: {} });
      const active = access.ok && access.payload?.profile?.id === resolved.payload.user_id && access.payload.profile.enabled === true;
      if (!active) {
        await revokeIssuedSession();
        issuedToken = undefined;
        return respond(401, { error: AUTH_FAILURE });
      }
      return respond(200, { session, access: access.payload });
    } catch {
      if (issuedToken) { try { await revokeIssuedSession(); } catch { log('failed_session_revoke_unavailable'); } }
      if (ticket) {
        try { await call('/rest/v1/rpc/finish_login', { data: { p_ticket: ticket, p_success: false, p_session_id: null, p_user_agent: userAgent } }); }
        catch { /* Account lease remains until timeout; never fail open. */ }
      }
      log('sign_in_unavailable');
      return respond(503, { error: SERVICE_FAILURE });
    }
  };
}
