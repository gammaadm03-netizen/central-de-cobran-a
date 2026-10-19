-- Diretoria: consulta em todos os módulos, sem Importar Bases ou alterações.
-- Não cria contas de autenticação, perfis, senhas ou dados financeiros.
-- Repetível após a identidade com sessões aprovadas e a base financeira 007.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL
  OR to_regclass('public.profiles') IS NULL OR to_regclass('public.role_permissions') IS NULL
  OR to_regclass('cf_private.approved_sessions') IS NULL OR to_regclass('cf_private.revoked_sessions') IS NULL
  OR to_regprocedure('cf_private.session_allowed()') IS NULL THEN
  RAISE EXCEPTION 'Ative a identidade, o gateway de autenticação 003 e a base financeira antes do acesso da Diretoria.' USING ERRCODE='22023';
 END IF;
END $$;
SELECT pg_advisory_xact_lock(2045812301);

-- Limpa permissões antigas de envio/alteração e qualquer acesso à importação.
DO $$ DECLARE v_action text;v_resources text[];BEGIN
 IF EXISTS(SELECT 1 FROM public.role_permissions WHERE role_key='diretor'
  AND (resource='importar_bases' OR action NOT IN ('read','export'))) THEN
  DELETE FROM public.role_permissions WHERE role_key='diretor'
   AND (resource='importar_bases' OR action NOT IN ('read','export'));
 END IF;
 FOREACH v_action IN ARRAY ARRAY['read','export'] LOOP
  v_resources:=CASE WHEN v_action='read' THEN ARRAY['painel','caixa','contas_pagar','contas_receber','cobranca','comissoes',
   'faturamento','margens','rh_dp','resumo_diretoria','mensagens_cp','usuarios','configuracoes','auditoria']
   ELSE ARRAY['painel','caixa','contas_pagar','contas_receber','cobranca','comissoes','faturamento','margens','rh_dp','resumo_diretoria'] END;
  -- Evita até UPDATE de contadores de autorização por comandos sem novas linhas.
  IF EXISTS(SELECT 1 FROM unnest(v_resources) m(resource) WHERE NOT EXISTS(
   SELECT 1 FROM public.role_permissions p WHERE p.role_key='diretor' AND p.resource=m.resource AND p.action=v_action)) THEN
   INSERT INTO public.role_permissions(role_key,resource,action)
    SELECT 'diretor',resource,v_action FROM unnest(v_resources) m(resource)
    ON CONFLICT(role_key,resource,action) DO NOTHING;
  END IF;
 END LOOP;
END $$;

-- A barreira continua válida se uma permissão antiga for reinserida no futuro.
-- Perfil e sessão oficiais permanecem a fonte de autorização, nunca metadata.
CREATE OR REPLACE FUNCTION cf_private.has_permission(p_resource text,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT cf_private.session_allowed() AND EXISTS(
  SELECT 1 FROM public.profiles p JOIN public.role_permissions rp ON rp.role_key=p.role_key
  WHERE p.id=auth.uid() AND p.enabled AND rp.resource=p_resource AND rp.action=p_action
   AND (p.role_key<>'diretor' OR (p_action IN ('read','export') AND p_resource<>'importar_bases')));
$$;
CREATE OR REPLACE FUNCTION public.current_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile public.profiles%ROWTYPE;v_permissions jsonb;BEGIN
 IF NOT cf_private.session_allowed() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid() AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('resource',resource,'action',action) ORDER BY resource,action),'[]'::jsonb)
 INTO v_permissions FROM public.role_permissions WHERE role_key=v_profile.role_key AND cf_private.has_permission(resource,action);
 RETURN jsonb_build_object('profile',to_jsonb(v_profile),'permissions',v_permissions,'collector_id',cf_private.current_collector_id());
END $$;

-- Helper sem argumentos de usuário: somente a própria identidade oficial pode
-- abrir a leitura administrativa. SECURITY DEFINER evita recursão da RLS de profiles.
CREATE OR REPLACE FUNCTION cf_private.director_read_allowed(p_resource text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT cf_private.has_permission(p_resource,'read') AND EXISTS(
  SELECT 1 FROM public.profiles WHERE id=auth.uid() AND enabled AND role_key='diretor');
$$;
REVOKE ALL ON FUNCTION cf_private.director_read_allowed(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cf_private.director_read_allowed(text) TO authenticated;

-- Políticas somente SELECT; as escritas continuam exclusivamente nos RPCs da Gerência.
DROP POLICY IF EXISTS profiles_director_read ON public.profiles;
CREATE POLICY profiles_director_read ON public.profiles FOR SELECT TO authenticated
 USING(cf_private.director_read_allowed('usuarios'));
DROP POLICY IF EXISTS agents_director_read ON public.collection_agents;
CREATE POLICY agents_director_read ON public.collection_agents FOR SELECT TO authenticated
 USING(cf_private.director_read_allowed('configuracoes'));
DROP POLICY IF EXISTS bindings_director_read ON public.collector_bindings;
CREATE POLICY bindings_director_read ON public.collector_bindings FOR SELECT TO authenticated
 USING(cf_private.director_read_allowed('configuracoes'));
DROP POLICY IF EXISTS audit_director_read ON public.audit_events;
CREATE POLICY audit_director_read ON public.audit_events FOR SELECT TO authenticated
 USING(cf_private.director_read_allowed('auditoria'));

COMMENT ON FUNCTION cf_private.director_read_allowed(text) IS 'Leitura administrativa da própria Diretoria ativa com sessão aprovada; não concede escrita, validação, importação ou administração.';
INSERT INTO public.central_schema_migrations(version) VALUES('031_director_readonly') ON CONFLICT(version) DO NOTHING;
COMMIT;
