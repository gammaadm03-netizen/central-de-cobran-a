-- Central Financeira — Fase 1 / baseline do schema. Não repetir em banco já configurado.
-- Rodar uma única vez pelo SQL Editor como proprietário, após revisar e fazer backup.
-- Não cria contas Auth, senhas, dados financeiros ou associação presumida de cobradoras.
BEGIN;

CREATE SCHEMA IF NOT EXISTS cf_private;
REVOKE ALL ON SCHEMA cf_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA cf_private TO authenticated;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  username text NOT NULL CHECK (username = btrim(username) AND username ~ '^[A-Za-z0-9._-]{3,64}$'),
  username_normalized text GENERATED ALWAYS AS (lower(btrim(username))) STORED UNIQUE,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 150),
  role_key text NOT NULL CHECK (role_key IN ('diretor','gerente_geral','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2')),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.role_permissions (
  role_key text NOT NULL CHECK (role_key IN ('diretor','gerente_geral','contas_receber','contas_pagar','rh_dp','cobradora_1','cobradora_2')),
  resource text NOT NULL,
  action text NOT NULL CHECK (action IN ('read','write','import','validate','admin','export')),
  PRIMARY KEY (role_key, resource, action)
);
CREATE TABLE public.collection_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 150),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.collector_bindings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL UNIQUE REFERENCES public.collection_agents(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.management_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_name text NOT NULL,
  author_role text NOT NULL CHECK (author_role IN ('diretor','gerente_geral')),
  priority text NOT NULL CHECK (priority IN ('normal','atencao','urgente')),
  reference text CHECK (length(reference) <= 300),
  message text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','concluida')),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_by uuid REFERENCES public.profiles(id),
  completed_at timestamptz,
  reopened_by uuid REFERENCES public.profiles(id),
  reopened_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX management_messages_status_date ON public.management_messages(status, created_at DESC);
CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id uuid,
  username text,
  role_key text,
  module text NOT NULL,
  entity text NOT NULL,
  record_id text,
  action text NOT NULL CHECK (action IN ('CREATE','UPDATE','DELETE','IMPORT','VALIDATE','REOPEN','LOGIN','LOGOUT','PASSWORD_CHANGE','ROLE_CHANGE','ASSIGNMENT','AUTO_RECONCILE')),
  before_value jsonb,
  after_value jsonb,
  ip inet,
  user_agent text
);
CREATE INDEX audit_events_date ON public.audit_events(occurred_at DESC);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collector_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.management_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION cf_private.is_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.enabled);
$$;
CREATE FUNCTION cf_private.is_manager() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.enabled AND p.role_key = 'gerente_geral');
$$;
CREATE FUNCTION cf_private.has_permission(p_resource text, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.role_permissions rp ON rp.role_key = p.role_key
    WHERE p.id = auth.uid() AND p.enabled AND rp.resource = p_resource AND rp.action = p_action
  );
$$;
CREATE FUNCTION cf_private.current_collector_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id FROM public.profiles p
  JOIN public.collector_bindings b ON b.user_id = p.id
  JOIN public.collection_agents a ON a.id = b.agent_id
  WHERE p.id = auth.uid() AND p.enabled AND p.role_key IN ('cobradora_1','cobradora_2') AND a.enabled;
$$;

-- Central matrix: collectors receive no unscoped financial access.
INSERT INTO public.role_permissions(role_key,resource,action)
SELECT r.role_key, m.resource, 'read'
FROM (VALUES ('diretor'),('gerente_geral')) r(role_key)
CROSS JOIN (VALUES ('painel'),('caixa'),('contas_pagar'),('contas_receber'),('cobranca'),('comissoes'),('faturamento'),('margens'),('rh_dp'),('importar_bases'),('resumo_diretoria')) m(resource);
INSERT INTO public.role_permissions(role_key,resource,action)
SELECT 'gerente_geral', m.resource, 'write'
FROM (VALUES ('painel'),('caixa'),('contas_pagar'),('contas_receber'),('cobranca'),('comissoes'),('faturamento'),('margens'),('rh_dp'),('resumo_diretoria')) m(resource);
INSERT INTO public.role_permissions(role_key,resource,action) VALUES
 ('gerente_geral','usuarios','admin'),('gerente_geral','configuracoes','admin'),
 ('gerente_geral','auditoria','read'),('gerente_geral','backup','export'),
 ('gerente_geral','contas_receber','validate'),
 ('contas_receber','painel','read'),('contas_receber','caixa','read'),
 ('contas_receber','contas_receber','read'),('contas_receber','contas_receber','write'),
 ('contas_receber','contas_receber','validate'),('contas_receber','cobranca','read'),
 ('contas_receber','cobranca','write'),('contas_receber','importar_bases','read'),
 ('contas_pagar','painel','read'),('contas_pagar','caixa','read'),
 ('contas_pagar','contas_pagar','read'),('contas_pagar','contas_pagar','write'),('contas_pagar','importar_bases','read'),
 ('rh_dp','rh_dp','read'),('rh_dp','rh_dp','write'),('rh_dp','faturamento','read'),
 ('rh_dp','faturamento','write'),('rh_dp','importar_bases','read'),
 ('cobradora_1','cobranca','read'),('cobradora_1','cobranca','write'),
 ('cobradora_2','cobranca','read'),('cobradora_2','cobranca','write'),
 ('diretor','mensagens_cp','read'),('diretor','mensagens_cp','write'),
 ('gerente_geral','mensagens_cp','read'),('gerente_geral','mensagens_cp','write'),
 ('contas_pagar','mensagens_cp','read');
INSERT INTO public.role_permissions(role_key,resource,action)
SELECT 'gerente_geral',m.resource,'import' FROM (VALUES ('contas_pagar'),('contas_receber'),('fechamento'),('rh_dp'),('custos'),('caixa')) m(resource);
INSERT INTO public.role_permissions(role_key,resource,action) VALUES
 ('contas_receber','contas_receber','import'),('contas_pagar','contas_pagar','import'),
 ('rh_dp','rh_dp','import'),('rh_dp','fechamento','import');
-- Export remains restricted to the same readable resource and, for collectors,
-- must also apply the per-agent row scope in the future financial module.
INSERT INTO public.role_permissions(role_key,resource,action)
SELECT role_key,resource,'export' FROM public.role_permissions
WHERE action='read' AND resource IN ('painel','caixa','contas_pagar','contas_receber','cobranca','comissoes','faturamento','margens','rh_dp','resumo_diretoria');

CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated
 USING (cf_private.is_manager() OR (id = auth.uid() AND cf_private.is_active()));
CREATE POLICY permissions_read ON public.role_permissions FOR SELECT TO authenticated
 USING (cf_private.is_manager() OR (cf_private.is_active() AND role_key = (SELECT p.role_key FROM public.profiles p WHERE p.id = auth.uid())));
CREATE POLICY agents_read ON public.collection_agents FOR SELECT TO authenticated
 USING (cf_private.is_manager() OR cf_private.has_permission('contas_receber','write') OR id = cf_private.current_collector_id());
CREATE POLICY bindings_read ON public.collector_bindings FOR SELECT TO authenticated
 USING (cf_private.is_manager() OR cf_private.has_permission('contas_receber','write') OR (user_id = auth.uid() AND cf_private.current_collector_id() = agent_id));
CREATE POLICY messages_read ON public.management_messages FOR SELECT TO authenticated
 USING (cf_private.has_permission('mensagens_cp','read'));
CREATE POLICY audit_read ON public.audit_events FOR SELECT TO authenticated
 USING (cf_private.is_manager());

CREATE FUNCTION cf_private.audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor public.profiles%ROWTYPE; v_before jsonb; v_after jsonb; v_action text; v_id text;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = auth.uid();
  IF TG_OP <> 'INSERT' THEN v_before := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_after := to_jsonb(NEW); END IF;
  -- Self-administration must retain the identity that authorized the change.
  IF TG_TABLE_NAME = 'profiles' AND TG_OP IN ('UPDATE','DELETE') AND v_before ->> 'id' = auth.uid()::text THEN
    v_actor.id := (v_before ->> 'id')::uuid;
    v_actor.username := v_before ->> 'username';
    v_actor.role_key := v_before ->> 'role_key';
  END IF;
  v_action := CASE TG_OP WHEN 'INSERT' THEN 'CREATE' WHEN 'DELETE' THEN 'DELETE' ELSE 'UPDATE' END;
  IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE' AND (v_before ->> 'role_key') IS DISTINCT FROM (v_after ->> 'role_key') THEN v_action := 'ROLE_CHANGE'; END IF;
  IF TG_TABLE_NAME = 'collector_bindings' THEN v_action := 'ASSIGNMENT'; END IF;
  IF TG_TABLE_NAME = 'management_messages' AND TG_OP = 'UPDATE' AND v_before ->> 'status' = 'concluida' AND v_after ->> 'status' = 'pendente' THEN v_action := 'REOPEN'; END IF;
  v_id := coalesce(v_after ->> 'id',v_before ->> 'id',v_after ->> 'user_id',v_before ->> 'user_id');
  IF TG_TABLE_NAME = 'role_permissions' THEN
    v_id := concat_ws('/',coalesce(v_after ->> 'role_key',v_before ->> 'role_key'),coalesce(v_after ->> 'resource',v_before ->> 'resource'),coalesce(v_after ->> 'action',v_before ->> 'action'));
  END IF;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
  VALUES (v_actor.id,v_actor.username,v_actor.role_key,CASE WHEN TG_TABLE_NAME = 'management_messages' THEN 'contas_pagar' ELSE 'administracao' END,TG_TABLE_NAME,v_id,v_action,v_before,v_after);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION cf_private.block_audit_changes() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'O histórico de auditoria é imutável.' USING ERRCODE = '42501'; END;
$$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER profile_audit AFTER INSERT OR UPDATE OR DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION cf_private.audit_row();
CREATE TRIGGER permission_audit AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions FOR EACH ROW EXECUTE FUNCTION cf_private.audit_row();
CREATE TRIGGER agent_audit AFTER INSERT OR UPDATE OR DELETE ON public.collection_agents FOR EACH ROW EXECUTE FUNCTION cf_private.audit_row();
CREATE TRIGGER binding_audit AFTER INSERT OR UPDATE OR DELETE ON public.collector_bindings FOR EACH ROW EXECUTE FUNCTION cf_private.audit_row();
CREATE TRIGGER message_audit AFTER INSERT OR UPDATE OR DELETE ON public.management_messages FOR EACH ROW EXECUTE FUNCTION cf_private.audit_row();

CREATE FUNCTION public.current_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile public.profiles%ROWTYPE; v_permissions jsonb;
BEGIN
  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid() AND enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('resource',resource,'action',action) ORDER BY resource,action),'[]'::jsonb)
    INTO v_permissions FROM public.role_permissions WHERE role_key = v_profile.role_key;
  RETURN jsonb_build_object('profile',to_jsonb(v_profile),'permissions',v_permissions,'collector_id',cf_private.current_collector_id());
END;
$$;

CREATE FUNCTION public.manage_profile(p_user_id uuid,p_username text,p_display_name text,p_role_key text,p_enabled boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_previous public.profiles%ROWTYPE;
BEGIN
  -- Serializes role changes so two managers cannot disable one another concurrently.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_previous FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_previous.role_key = 'gerente_geral' AND v_previous.enabled AND (p_role_key <> 'gerente_geral' OR NOT p_enabled)
     AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id <> p_user_id AND enabled AND role_key = 'gerente_geral') THEN
    RAISE EXCEPTION 'Mantenha ao menos uma Gerência Geral ativa.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.collector_bindings WHERE user_id = p_user_id)
     AND p_role_key NOT IN ('cobradora_1','cobradora_2') THEN
    RAISE EXCEPTION 'Remova o vínculo de cobradora antes de alterar o perfil.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.profiles(id,username,display_name,role_key,enabled)
  VALUES(p_user_id,p_username,p_display_name,p_role_key,p_enabled)
  ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username,display_name = EXCLUDED.display_name,
    role_key = EXCLUDED.role_key,enabled = EXCLUDED.enabled,updated_at = now();
  RETURN p_user_id;
END;
$$;

CREATE FUNCTION public.configure_collection_agent(p_agent_id uuid,p_display_name text,p_enabled boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501'; END IF;
  v_id := coalesce(p_agent_id,gen_random_uuid());
  INSERT INTO public.collection_agents(id,display_name,enabled) VALUES(v_id,p_display_name,p_enabled)
  ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name,enabled=EXCLUDED.enabled,updated_at=now();
  RETURN v_id;
END;
$$;
CREATE FUNCTION public.bind_collector(p_user_id uuid,p_agent_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Share the same lock as profile changes to preserve the collector-role invariant.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_user_id AND role_key IN ('cobradora_1','cobradora_2')) THEN
    RAISE EXCEPTION 'O usuário precisa ter perfil de cobradora.' USING ERRCODE = '23514';
  END IF;
  IF p_agent_id IS NULL THEN
    DELETE FROM public.collector_bindings WHERE user_id = p_user_id;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.collection_agents WHERE id=p_agent_id AND enabled) THEN
      RAISE EXCEPTION 'Cobradora não disponível.' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.collector_bindings(user_id,agent_id,updated_by) VALUES(p_user_id,p_agent_id,auth.uid())
    ON CONFLICT(user_id) DO UPDATE SET agent_id=EXCLUDED.agent_id,updated_by=EXCLUDED.updated_by,updated_at=now();
  END IF;
END;
$$;

CREATE FUNCTION public.create_management_message(p_priority text,p_reference text,p_message text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor public.profiles%ROWTYPE; v_id uuid;
BEGIN
  IF NOT cf_private.has_permission('mensagens_cp','write') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_actor FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.management_messages(author_name,author_role,priority,reference,message,created_by)
  VALUES(v_actor.display_name,v_actor.role_key,p_priority,p_reference,p_message,v_actor.id) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
CREATE FUNCTION public.set_management_message_status(p_message_id uuid,p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_message public.management_messages%ROWTYPE;
BEGIN
  IF NOT cf_private.has_permission('mensagens_cp','write') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('pendente','concluida') OR p_status IS NULL THEN RAISE EXCEPTION 'Status inválido.' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_message FROM public.management_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mensagem não encontrada.' USING ERRCODE = 'P0002'; END IF;
  IF v_message.status = p_status THEN RETURN; END IF;
  IF p_status = 'concluida' THEN
    UPDATE public.management_messages SET status=p_status,completed_by=auth.uid(),completed_at=now(),updated_at=now() WHERE id=p_message_id;
  ELSE
    UPDATE public.management_messages SET status=p_status,reopened_by=auth.uid(),reopened_at=now(),updated_at=now() WHERE id=p_message_id;
  END IF;
END;
$$;

-- No default PUBLIC function execution; expose only authenticated RPCs and RLS helpers.
REVOKE ALL ON FUNCTION cf_private.is_active(),cf_private.is_manager(),cf_private.has_permission(text,text),cf_private.current_collector_id(),cf_private.audit_row(),cf_private.block_audit_changes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cf_private.is_active(),cf_private.is_manager(),cf_private.has_permission(text,text),cf_private.current_collector_id() TO authenticated;
REVOKE ALL ON FUNCTION public.current_access(),public.manage_profile(uuid,text,text,text,boolean),public.configure_collection_agent(uuid,text,boolean),public.bind_collector(uuid,uuid),public.create_management_message(text,text,text),public.set_management_message_status(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_access(),public.manage_profile(uuid,text,text,text,boolean),public.configure_collection_agent(uuid,text,boolean),public.bind_collector(uuid,uuid),public.create_management_message(text,text,text),public.set_management_message_status(uuid,text) TO authenticated;
REVOKE ALL ON TABLE public.profiles,public.role_permissions,public.collection_agents,public.collector_bindings,public.management_messages,public.audit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.profiles,public.role_permissions,public.collection_agents,public.collector_bindings,public.management_messages,public.audit_events TO authenticated;

COMMENT ON SCHEMA cf_private IS 'Helpers de RLS; manter fora dos schemas expostos na Data API.';
COMMENT ON TABLE public.profiles IS 'Perfil oficial. Criado somente após provisionamento separado em Supabase Auth. Nunca confiar em user_metadata.role.';
COMMENT ON TABLE public.collector_bindings IS 'Sem vínculo = nenhuma carteira. Não atribuir Crislayne/Emanuelle automaticamente.';
COMMENT ON TABLE public.role_permissions IS 'Matriz inicial. Futuras permissões específicas exigem migration/RPC autorizada e auditada.';
COMMIT;
