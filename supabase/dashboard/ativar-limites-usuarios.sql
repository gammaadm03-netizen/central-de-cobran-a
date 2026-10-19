-- Teto individual de recursos para acessos de Contas a Pagar.
-- Repetível e sem usuários/configurações reais. Nunca concede permissão nova.
-- Requer identidade 001, gateway 003, base 007 e acesso da Diretoria 031.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL
  OR to_regclass('public.profiles') IS NULL OR to_regclass('public.role_permissions') IS NULL
  OR to_regclass('cf_private.approved_sessions') IS NULL OR to_regclass('cf_private.revoked_sessions') IS NULL
  OR to_regprocedure('cf_private.session_allowed()') IS NULL
  OR to_regprocedure('cf_private.audit_row()') IS NULL THEN
  RAISE EXCEPTION 'Ative a identidade 001, o gateway 003 e a base financeira antes dos limites individuais.' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='031_director_readonly') THEN
  RAISE EXCEPTION 'Ative primeiro a atualização de acesso da Diretoria 031 e depois execute os limites individuais 039.' USING ERRCODE='22023';
 END IF;
END $$;
SELECT pg_advisory_xact_lock(2045812301);

CREATE TABLE IF NOT EXISTS cf_private.user_access_limits (
 user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
 allowed_resources text[] NOT NULL CHECK (
  cardinality(allowed_resources) BETWEEN 0 AND 20
  AND (cardinality(allowed_resources)=0 OR array_ndims(allowed_resources)=1)
  AND array_position(allowed_resources,NULL) IS NULL
  AND allowed_resources <@ ARRAY[
   'painel','caixa','contas_pagar','contas_receber','cobranca','comissoes',
   'faturamento','margens','rh_dp','importar_bases','resumo_diretoria','mensagens_cp',
   'usuarios','configuracoes','auditoria','backup','fechamento','custos','estoque'
  ]::text[]
 ),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE cf_private.user_access_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.user_access_limits FROM PUBLIC,anon,authenticated,service_role;

-- Somente o operador SQL proprietário configura limites. A primeira versão é
-- deliberadamente restrita a CP; outras rotinas por perfil não são ampliadas.
CREATE OR REPLACE FUNCTION cf_private.guard_user_access_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_role text;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 SELECT role_key INTO v_role FROM public.profiles WHERE id=NEW.user_id FOR UPDATE;
 IF v_role IS DISTINCT FROM 'contas_pagar' THEN
  RAISE EXCEPTION 'Nesta versão, limites individuais são permitidos somente para Contas a Pagar.' USING ERRCODE='23514';
 END IF;
 -- Validação anterior à normalização para não aceitar NULL, arrays aninhados ou
 -- entradas repetidas excessivas que desapareceriam após a canonicalização.
 IF NEW.allowed_resources IS NULL OR cardinality(NEW.allowed_resources)>20
  OR (cardinality(NEW.allowed_resources)>0 AND array_ndims(NEW.allowed_resources)<>1)
  OR array_position(NEW.allowed_resources,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'Informe uma lista simples de até 20 recursos válidos.' USING ERRCODE='23514';
 END IF;
 NEW.allowed_resources:=ARRAY(SELECT DISTINCT resource FROM unnest(NEW.allowed_resources) resource ORDER BY resource);
 NEW.reason:=btrim(NEW.reason);
 NEW.updated_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION cf_private.guard_limited_profile_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NEW.role_key IS DISTINCT FROM OLD.role_key
  AND EXISTS(SELECT 1 FROM cf_private.user_access_limits WHERE user_id=OLD.id) THEN
  RAISE EXCEPTION 'Remova o limite individual antes de alterar o perfil deste acesso.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cf_private.guard_user_access_limit(),cf_private.guard_limited_profile_role() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE TRIGGER user_access_limit_guard BEFORE INSERT OR UPDATE ON cf_private.user_access_limits
 FOR EACH ROW EXECUTE FUNCTION cf_private.guard_user_access_limit();
CREATE OR REPLACE TRIGGER limited_profile_role_guard BEFORE UPDATE OF role_key ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION cf_private.guard_limited_profile_role();
CREATE OR REPLACE TRIGGER user_access_limit_audit AFTER INSERT OR UPDATE OR DELETE ON cf_private.user_access_limits
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_row();

-- A sessão aprovada, o perfil oficial e a matriz RBAC continuam obrigatórios.
-- O teto é uma interseção: incluir um recurso sem concessão na role não o libera.
-- Preserva também a barreira de somente leitura da Diretoria introduzida em031.
CREATE OR REPLACE FUNCTION cf_private.has_permission(p_resource text,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT cf_private.session_allowed() AND EXISTS(
  SELECT 1 FROM public.profiles p JOIN public.role_permissions rp ON rp.role_key=p.role_key
  WHERE p.id=auth.uid() AND p.enabled AND rp.resource=p_resource AND rp.action=p_action
   AND (p.role_key<>'diretor' OR (p_action IN ('read','export') AND p_resource<>'importar_bases'))
   AND NOT EXISTS(SELECT 1 FROM cf_private.user_access_limits lim
    WHERE lim.user_id=p.id AND NOT(p_resource=ANY(lim.allowed_resources))));
$$;
CREATE OR REPLACE FUNCTION public.current_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile public.profiles%ROWTYPE;v_permissions jsonb;
BEGIN
 IF NOT cf_private.session_allowed() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid() AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('resource',resource,'action',action) ORDER BY resource,action),'[]'::jsonb)
 INTO v_permissions FROM public.role_permissions WHERE role_key=v_profile.role_key AND cf_private.has_permission(resource,action);
 RETURN jsonb_build_object('profile',to_jsonb(v_profile),'permissions',v_permissions,'collector_id',cf_private.current_collector_id());
END $$;
REVOKE ALL ON FUNCTION cf_private.has_permission(text,text),public.current_access() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cf_private.has_permission(text,text),public.current_access() TO authenticated;

COMMENT ON TABLE cf_private.user_access_limits IS 'Teto individual somente para perfis de Contas a Pagar nesta versão. Sem linha herda a role; lista vazia nega recursos. Não concede permissões. Configuração exclusiva do proprietário SQL, sempre auditada.';
COMMENT ON FUNCTION cf_private.guard_limited_profile_role() IS 'Remove-se explicitamente o teto antes de qualquer troca de perfil; evita ignorar limites em rotinas administrativas por role.';

-- Atalho privado para o SQL Editor: não é uma RPC pública nem um provisionador.
-- Não altera Auth, perfil, role ou permissões globais. O UUID é fornecido pelo
-- operador somente no projeto correto; nenhuma identidade real fica no código.
CREATE OR REPLACE FUNCTION cf_private.restrict_payables_user(p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_resources text[];
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 PERFORM 1 FROM public.profiles WHERE id=p_user_id AND role_key='contas_pagar' FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Vincule primeiro este UID ao perfil Contas a Pagar em Administração de Usuários.' USING ERRCODE='22023';
 END IF;
 INSERT INTO cf_private.user_access_limits(user_id,allowed_resources,reason)
 VALUES(p_user_id,ARRAY['painel','contas_pagar','importar_bases','mensagens_cp'],
  'Acesso limitado a Painel Gerencial, Contas a Pagar e Importar Bases')
 ON CONFLICT(user_id) DO UPDATE SET allowed_resources=EXCLUDED.allowed_resources,reason=EXCLUDED.reason
 WHERE user_access_limits.allowed_resources IS DISTINCT FROM EXCLUDED.allowed_resources
  OR user_access_limits.reason IS DISTINCT FROM EXCLUDED.reason;
 SELECT allowed_resources INTO v_resources FROM cf_private.user_access_limits WHERE user_id=p_user_id;
 RETURN jsonb_build_object('user_id',p_user_id,'allowed_resources',v_resources);
END $$;
REVOKE ALL ON FUNCTION cf_private.restrict_payables_user(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION cf_private.restrict_payables_user(uuid) IS 'Somente operador SQL proprietário. Teto padronizado de CP sem modificar a role, sem conceder acesso e sem auditoria duplicada ao repetir a mesma configuração.';
INSERT INTO public.central_schema_migrations(version) VALUES('039_user_access_limits') ON CONFLICT(version) DO NOTHING;
COMMIT;
