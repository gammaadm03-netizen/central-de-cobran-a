-- Additive; apply once after 001 and 003. No passwords, Auth user edits or data reset.
BEGIN;

CREATE TABLE cf_private.password_change_buckets (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_id uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL
);
CREATE TABLE cf_private.password_change_attempts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome text NOT NULL DEFAULT 'requested' CHECK(outcome IN ('requested','changed','failed','uncertain')),
  user_agent text
);
ALTER TABLE cf_private.password_change_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.password_change_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.password_change_buckets,cf_private.password_change_attempts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.finish_password_recovery(p_ticket uuid,p_accepted boolean,p_user_agent text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_attempt cf_private.login_attempts%ROWTYPE; v_profile public.profiles%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812302);
  SELECT * INTO v_attempt FROM cf_private.login_attempts WHERE id=p_ticket FOR UPDATE;
  IF NOT FOUND OR v_attempt.completed_at IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id=v_attempt.actor_id;
  UPDATE cf_private.login_attempts SET completed_at=clock_timestamp() WHERE id=p_ticket;
  -- Releasing the lease must not reset the shared username/network counters.
  UPDATE cf_private.login_buckets SET lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE bucket_key=v_attempt.login_bucket AND lease_id=p_ticket;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,action,after_value,user_agent)
    VALUES(v_profile.id,v_profile.username,v_profile.role_key,'autenticacao','password','PASSWORD_CHANGE',
      jsonb_build_object('stage','recovery_requested','accepted',coalesce(p_accepted,false)),left(p_user_agent,300));
  RETURN true;
END;
$$;

CREATE FUNCTION public.begin_password_change(p_user_id uuid,p_session_id text,p_user_agent text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_profile public.profiles%ROWTYPE;
  v_bucket cf_private.password_change_buckets%ROWTYPE;
  v_ticket uuid;
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL
    OR p_session_id !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
    RAISE EXCEPTION 'Invalid gateway input.' USING ERRCODE='22023';
  END IF;
  -- This RPC is service-only. The gateway must first verify this exact Auth
  -- JWT via /auth/v1/user; the browser cannot submit an identity to this RPC.
  PERFORM pg_advisory_xact_lock(2045812302);
  PERFORM pg_advisory_xact_lock(hashtextextended('password_change:'||p_user_id::text,0));
  SELECT p.* INTO v_profile FROM public.profiles p JOIN auth.users u ON u.id=p.id
    WHERE p.id=p_user_id AND p.enabled AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until<=v_now) FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','inactive'); END IF;
  IF EXISTS(SELECT 1 FROM cf_private.revoked_sessions WHERE session_id=p_session_id) THEN
    RETURN jsonb_build_object('allowed',false,'reason','inactive');
  END IF;
  INSERT INTO cf_private.password_change_buckets(user_id,window_started_at,updated_at)
    VALUES(p_user_id,v_now,v_now) ON CONFLICT(user_id) DO NOTHING;
  UPDATE cf_private.password_change_buckets SET attempts=0,window_started_at=v_now,updated_at=v_now
    WHERE user_id=p_user_id AND window_started_at<=v_now-interval '15 minutes';
  SELECT * INTO v_bucket FROM cf_private.password_change_buckets WHERE user_id=p_user_id FOR UPDATE;
  IF v_bucket.attempts>=3 THEN
    RETURN jsonb_build_object('allowed',false,'retry_after',greatest(1,ceil(extract(epoch FROM v_bucket.window_started_at+interval '15 minutes'-v_now))::integer));
  END IF;
  IF v_bucket.lease_until>v_now THEN
    RETURN jsonb_build_object('allowed',false,'retry_after',greatest(1,ceil(extract(epoch FROM v_bucket.lease_until-v_now))::integer));
  END IF;
  v_ticket := gen_random_uuid();
  UPDATE cf_private.password_change_buckets SET attempts=attempts+1,lease_id=v_ticket,
    lease_until=v_now+interval '30 seconds',updated_at=v_now WHERE user_id=p_user_id;
  INSERT INTO cf_private.password_change_attempts(id,user_id,session_id,expires_at,user_agent)
    VALUES(v_ticket,p_user_id,p_session_id,v_now+interval '30 seconds',left(p_user_agent,300));
  -- Recovery JWTs never become approved sessions. Revoke existing application
  -- approvals before the Auth write, in the same transaction as the audit.
  INSERT INTO cf_private.revoked_sessions(session_id,user_id)
    SELECT s.session_id,s.user_id FROM cf_private.approved_sessions s WHERE s.user_id=p_user_id
    ON CONFLICT(session_id) DO NOTHING;
  UPDATE cf_private.approved_sessions SET expires_at=least(expires_at,v_now) WHERE user_id=p_user_id;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,action,after_value,user_agent)
    VALUES(v_profile.id,v_profile.username,v_profile.role_key,'autenticacao','password','PASSWORD_CHANGE',
      jsonb_build_object('stage','requested'),left(p_user_agent,300));
  RETURN jsonb_build_object('allowed',true,'ticket',v_ticket);
END;
$$;

CREATE FUNCTION public.finish_password_change(p_ticket uuid,p_success boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_attempt cf_private.password_change_attempts%ROWTYPE; v_profile public.profiles%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812302);
  SELECT * INTO v_attempt FROM cf_private.password_change_attempts WHERE id=p_ticket FOR UPDATE;
  IF NOT FOUND OR v_attempt.completed_at IS NOT NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('password_change:'||v_attempt.user_id::text,0));
  SELECT * INTO v_profile FROM public.profiles WHERE id=v_attempt.user_id;
  UPDATE cf_private.password_change_attempts SET completed_at=clock_timestamp(),
    outcome=CASE WHEN p_success THEN 'changed' WHEN p_success IS NULL THEN 'uncertain' ELSE 'failed' END WHERE id=p_ticket;
  UPDATE cf_private.password_change_buckets SET lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE user_id=v_attempt.user_id AND lease_id=p_ticket;
  IF p_success IS DISTINCT FROM false THEN
    -- A newly completed recovery resolves older abandoned changes without
    -- declaring that their remote Auth writes failed. Audit the uncertainty.
    INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value,user_agent)
      SELECT v_profile.id,v_profile.username,v_profile.role_key,'autenticacao','password',c.id::text,'PASSWORD_CHANGE',
        jsonb_build_object('stage','uncertain','reason','superseded_recovery'),c.user_agent
      FROM cf_private.password_change_attempts c WHERE c.user_id=v_attempt.user_id
        AND c.id<>p_ticket AND c.completed_at IS NULL AND c.created_at<=v_attempt.created_at;
    UPDATE cf_private.password_change_attempts SET completed_at=clock_timestamp(),outcome='uncertain'
      WHERE user_id=v_attempt.user_id AND id<>p_ticket AND completed_at IS NULL AND created_at<=v_attempt.created_at;
    -- Password authentication admitted before the Auth write might complete
    -- while that HTTP request is in flight. Revoke those approvals too and
    -- close every pre-existing login ticket so it cannot approve an old JWT.
    INSERT INTO cf_private.revoked_sessions(session_id,user_id)
      SELECT s.session_id,s.user_id FROM cf_private.approved_sessions s WHERE s.user_id=v_attempt.user_id
      ON CONFLICT(session_id) DO NOTHING;
    INSERT INTO cf_private.revoked_sessions(session_id,user_id) VALUES(v_attempt.session_id,v_attempt.user_id)
      ON CONFLICT(session_id) DO NOTHING;
    UPDATE cf_private.approved_sessions SET expires_at=least(expires_at,clock_timestamp()) WHERE user_id=v_attempt.user_id;
    UPDATE cf_private.login_buckets b SET lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE EXISTS(SELECT 1 FROM cf_private.login_attempts a WHERE a.actor_id=v_attempt.user_id AND a.id=b.lease_id);
    UPDATE cf_private.login_attempts SET completed_at=clock_timestamp() WHERE actor_id=v_attempt.user_id AND completed_at IS NULL;
  END IF;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,action,after_value,user_agent)
    VALUES(v_profile.id,v_profile.username,v_profile.role_key,'autenticacao','password','PASSWORD_CHANGE',
      jsonb_build_object('stage',CASE WHEN p_success THEN 'changed' WHEN p_success IS NULL THEN 'uncertain' ELSE 'failed' END),v_attempt.user_agent);
  RETURN true;
END;
$$;

-- Keep the 003 login contract. Any unresolved Auth write blocks application
-- login approval, even after the short request lease expires. A subsequent
-- completed recovery resolves older abandoned requests; no reset/drop needed.
CREATE OR REPLACE FUNCTION public.finish_login(p_ticket uuid,p_success boolean,p_session_id text,p_user_agent text)
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
     AND NOT EXISTS(SELECT 1 FROM cf_private.revoked_sessions s WHERE s.session_id=p_session_id)
     AND NOT EXISTS(SELECT 1 FROM cf_private.password_change_attempts c
       WHERE c.user_id=v_attempt.actor_id AND
         (c.completed_at IS NULL OR
          (c.outcome IN ('changed','uncertain') AND c.completed_at>=v_attempt.expires_at-interval '30 seconds'))) THEN
    SELECT * INTO v_profile FROM public.profiles WHERE id=v_attempt.actor_id AND enabled;
    v_valid := FOUND;
  END IF;
  IF v_valid THEN
    INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES(p_session_id,v_profile.id);
  END IF;
  UPDATE cf_private.login_attempts SET completed_at=clock_timestamp() WHERE id=p_ticket;
  UPDATE cf_private.login_buckets SET lease_id=NULL,lease_until=NULL,
    attempts=CASE WHEN v_valid THEN 0 ELSE attempts END,updated_at=clock_timestamp()
    WHERE bucket_key=v_attempt.login_bucket AND lease_id=p_ticket;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,action,after_value,user_agent)
    VALUES(CASE WHEN v_valid THEN v_profile.id END,CASE WHEN v_valid THEN v_profile.username END,
      CASE WHEN v_valid THEN v_profile.role_key END,'autenticacao','session','LOGIN',
      jsonb_build_object('outcome',CASE WHEN v_valid THEN 'success' ELSE 'denied' END),left(p_user_agent,300));
  RETURN v_valid;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_password_recovery(uuid,boolean,text),public.begin_password_change(uuid,text,text),public.finish_password_change(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_password_recovery(uuid,boolean,text),public.begin_password_change(uuid,text,text),public.finish_password_change(uuid,boolean) TO service_role;
COMMENT ON TABLE cf_private.password_change_attempts IS 'Password-change audit tickets only; never store passwords, hashes, emails or JWTs.';
COMMENT ON FUNCTION public.begin_password_change(uuid,text,text) IS 'Gateway only, after Auth JWT verification. Active profile, 3 changes per 15m, audited app-session revocation. Recovery grants no application access.';
COMMIT;
