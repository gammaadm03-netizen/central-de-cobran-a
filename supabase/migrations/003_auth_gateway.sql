-- Incremental: requires 001_identidade_rbac.sql and an existing Auth administrator.
-- Does not provision accounts, passwords, usernames or financial data.
BEGIN;

CREATE TABLE cf_private.login_buckets (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL
);
CREATE TABLE cf_private.login_attempts (
  id uuid PRIMARY KEY,
  login_bucket text NOT NULL,
  actor_id uuid,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE TABLE cf_private.revoked_sessions (
  session_id text PRIMARY KEY CHECK (session_id ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cf_private.approved_sessions (
  session_id text PRIMARY KEY CHECK (session_id ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '12 hours'
);
ALTER TABLE cf_private.login_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.revoked_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.approved_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.login_buckets,cf_private.login_attempts,cf_private.revoked_sessions,cf_private.approved_sessions FROM PUBLIC,anon,authenticated;

-- Supabase Auth invalidates refresh tokens on logout; already-issued JWTs may
-- otherwise remain valid until expiry. These helpers immediately deny such JWTs
-- in every existing application RPC and RLS policy. No session ID = no access.
CREATE FUNCTION cf_private.session_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL
    AND coalesce(auth.jwt()->>'session_id','') ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
    AND EXISTS(SELECT 1 FROM cf_private.approved_sessions s
      WHERE s.session_id=auth.jwt()->>'session_id' AND s.user_id=auth.uid() AND s.expires_at>now())
    AND NOT EXISTS(SELECT 1 FROM cf_private.revoked_sessions s WHERE s.session_id=auth.jwt()->>'session_id');
$$;
CREATE OR REPLACE FUNCTION cf_private.is_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT cf_private.session_allowed() AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled);
$$;
CREATE OR REPLACE FUNCTION cf_private.is_manager() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT cf_private.session_allowed() AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND p.role_key='gerente_geral');
$$;
CREATE OR REPLACE FUNCTION cf_private.has_permission(p_resource text,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT cf_private.session_allowed() AND EXISTS(
    SELECT 1 FROM public.profiles p JOIN public.role_permissions rp ON rp.role_key=p.role_key
    WHERE p.id=auth.uid() AND p.enabled AND rp.resource=p_resource AND rp.action=p_action);
$$;
CREATE OR REPLACE FUNCTION cf_private.current_collector_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id FROM public.profiles p JOIN public.collector_bindings b ON b.user_id=p.id
    JOIN public.collection_agents a ON a.id=b.agent_id
    WHERE p.id=auth.uid() AND p.enabled AND p.role_key IN ('cobradora_1','cobradora_2') AND a.enabled AND cf_private.session_allowed();
$$;
CREATE OR REPLACE FUNCTION public.current_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile public.profiles%ROWTYPE; v_permissions jsonb;
BEGIN
  IF NOT cf_private.session_allowed() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid() AND enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('resource',resource,'action',action) ORDER BY resource,action),'[]'::jsonb)
    INTO v_permissions FROM public.role_permissions WHERE role_key=v_profile.role_key;
  RETURN jsonb_build_object('profile',to_jsonb(v_profile),'permissions',v_permissions,'collector_id',cf_private.current_collector_id());
END;
$$;
REVOKE ALL ON FUNCTION cf_private.session_allowed() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION cf_private.session_allowed() TO authenticated;

CREATE FUNCTION public.resolve_login(p_username text,p_client_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_login_key text;
  v_network_key text;
  v_account cf_private.login_buckets%ROWTYPE;
  v_network cf_private.login_buckets%ROWTYPE;
  v_ticket uuid;
  v_actor uuid;
  v_email text;
  v_retry integer;
BEGIN
  IF p_username IS NULL OR p_username !~ '^[A-Za-z0-9._-]{3,64}$'
     OR p_client_key IS NULL OR p_client_key !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid gateway input.' USING ERRCODE = '22023';
  END IF;
  -- A single short transaction lock serializes both buckets. It never spans HTTP
  -- calls; the account lease below prevents concurrent password verifications.
  PERFORM pg_advisory_xact_lock(2045812302);
  v_login_key := 'account:' || md5(lower(p_username));
  v_network_key := 'network:' || p_client_key;
  DELETE FROM cf_private.login_attempts WHERE expires_at < v_now - interval '1 day';
  DELETE FROM cf_private.login_buckets WHERE updated_at < v_now - interval '1 day';
  INSERT INTO cf_private.login_buckets(bucket_key,window_started_at,updated_at)
    VALUES(v_login_key,v_now,v_now),(v_network_key,v_now,v_now)
    ON CONFLICT (bucket_key) DO NOTHING;
  UPDATE cf_private.login_buckets SET attempts=0,window_started_at=v_now,updated_at=v_now
    WHERE bucket_key IN (v_login_key,v_network_key)
      AND window_started_at <= v_now - interval '15 minutes';
  SELECT * INTO v_account FROM cf_private.login_buckets WHERE bucket_key=v_login_key FOR UPDATE;
  SELECT * INTO v_network FROM cf_private.login_buckets WHERE bucket_key=v_network_key FOR UPDATE;
  IF v_account.attempts >= 6 OR v_network.attempts >= 30 THEN
    v_retry := greatest(1,ceil(extract(epoch FROM
      greatest(CASE WHEN v_account.attempts>=6 THEN v_account.window_started_at + interval '15 minutes' ELSE v_now END,
               CASE WHEN v_network.attempts>=30 THEN v_network.window_started_at + interval '15 minutes' ELSE v_now END) - v_now))::integer);
    RETURN jsonb_build_object('allowed',false,'retry_after',v_retry);
  END IF;
  IF v_account.lease_until > v_now THEN
    RETURN jsonb_build_object('allowed',false,'retry_after',greatest(1,ceil(extract(epoch FROM v_account.lease_until-v_now))::integer));
  END IF;
  v_ticket := gen_random_uuid();
  UPDATE cf_private.login_buckets SET attempts=attempts+1,updated_at=v_now WHERE bucket_key IN (v_login_key,v_network_key);
  UPDATE cf_private.login_buckets SET lease_id=v_ticket,lease_until=v_now+interval '30 seconds' WHERE bucket_key=v_login_key;
  SELECT p.id,u.email INTO v_actor,v_email FROM public.profiles p
    JOIN auth.users u ON u.id=p.id
    WHERE p.username_normalized=lower(p_username) AND p.enabled AND u.email IS NOT NULL;
  INSERT INTO cf_private.login_attempts(id,login_bucket,actor_id,expires_at)
    VALUES(v_ticket,v_login_key,v_actor,v_now+interval '30 seconds');
  -- The mapping is server-only. An absent/disabled profile produces no Auth call.
  RETURN jsonb_build_object('allowed',true,'ticket',v_ticket,'user_id',v_actor,'email',v_email);
END;
$$;

CREATE FUNCTION public.finish_login(p_ticket uuid,p_success boolean,p_session_id text,p_user_agent text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_attempt cf_private.login_attempts%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_valid boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812302);
  SELECT * INTO v_attempt FROM cf_private.login_attempts WHERE id=p_ticket FOR UPDATE;
  IF NOT FOUND OR v_attempt.completed_at IS NOT NULL THEN RETURN false; END IF;
  IF p_success AND v_attempt.expires_at > clock_timestamp()
     AND p_session_id ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
     AND NOT EXISTS(SELECT 1 FROM cf_private.revoked_sessions s WHERE s.session_id=p_session_id) THEN
    SELECT * INTO v_profile FROM public.profiles WHERE id=v_attempt.actor_id AND enabled;
    v_valid := FOUND;
  END IF;
  IF v_valid THEN
    -- A browser can obtain an Auth JWT by email directly. Only this server-side
    -- completion grants application access after account limits and audit.
    INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES(p_session_id,v_profile.id);
  END IF;
  UPDATE cf_private.login_attempts SET completed_at=clock_timestamp() WHERE id=p_ticket;
  UPDATE cf_private.login_buckets SET lease_id=NULL,lease_until=NULL,
    attempts=CASE WHEN v_valid THEN 0 ELSE attempts END,updated_at=clock_timestamp()
    WHERE bucket_key=v_attempt.login_bucket AND lease_id=p_ticket;
  -- Failed attempts never record an untrusted submitted username or an email.
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,action,after_value,user_agent)
    VALUES(CASE WHEN v_valid THEN v_profile.id END,
      CASE WHEN v_valid THEN v_profile.username END,
      CASE WHEN v_valid THEN v_profile.role_key END,
      'autenticacao','session','LOGIN',
      jsonb_build_object('outcome',CASE WHEN v_valid THEN 'success' ELSE 'denied' END),left(p_user_agent,300));
  RETURN v_valid;
END;
$$;

CREATE FUNCTION public.revoke_application_session(p_user_id uuid,p_session_id text,p_user_agent text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_profile FROM public.profiles WHERE id=p_user_id;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES(p_session_id,p_user_id)
    ON CONFLICT(session_id) DO NOTHING;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,action,user_agent)
    VALUES(v_profile.id,v_profile.username,v_profile.role_key,'autenticacao','session','LOGOUT',left(p_user_agent,300));
END;
$$;

-- Grant only the gateway server key. Anonymous and authenticated browsers cannot
-- resolve email mappings, release throttles, invent LOGIN events or append logs.
REVOKE ALL ON FUNCTION public.resolve_login(text,text),public.finish_login(uuid,boolean,text,text),public.revoke_application_session(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_login(text,text),public.finish_login(uuid,boolean,text,text),public.revoke_application_session(uuid,text,text) TO service_role;
COMMENT ON FUNCTION public.resolve_login(text,text) IS 'Edge gateway only. Atomic account/network limits and a single in-flight attempt per account; no public email lookup.';
COMMENT ON TABLE cf_private.login_attempts IS 'Ephemeral login tickets; no passwords, tokens or raw submitted usernames.';
COMMIT;
