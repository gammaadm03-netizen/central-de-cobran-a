-- Cobrança: o tempo total do mesmo título é igual para todos os perfis autorizados.
-- O tempo pessoal e a sessão em andamento continuam pertencendo ao usuário conectado.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $apply067$
DECLARE
 v_definition text;
 v_old text:=$old$((v_visible AND cf_private.has_permission('contas_receber','read') AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid()
    AND role_key IN ('gerente_geral','diretor','contas_receber'))) OR actor_id=auth.uid())$old$;
 v_new text:=$new$(coalesce(v_visible,false) OR actor_id=auth.uid())$new$;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM pg_advisory_xact_lock(2045812308);
 IF to_regclass('public.central_schema_migrations') IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='029_collection_workflow')
  OR to_regprocedure('cf_private.collection_workbench_timer(uuid,timestamp with time zone)') IS NULL THEN
  RAISE EXCEPTION 'Ative o atendimento da Cobrança029 antes de atualizar o tempo dos títulos.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='067_collection_title_time') THEN RETURN;END IF;

 -- Preserve the installed function's ownership, grants, actor-only recovery and
 -- workflow checks. Only the aggregate of a visible title includes every actor.
 -- Hidden titles still expose only the current actor's own recovery interval.
 v_definition:=pg_get_functiondef('cf_private.collection_workbench_timer(uuid,timestamp with time zone)'::regprocedure);
 IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 THEN
  RAISE EXCEPTION 'O contrato do tempo de atendimento divergiu. A atualização foi interrompida sem alterar os intervalos.' USING ERRCODE='22023';END IF;
 EXECUTE replace(v_definition,v_old,v_new);
 INSERT INTO public.central_schema_migrations(version) VALUES('067_collection_title_time');
 NOTIFY pgrst,'reload schema';
END $apply067$;
COMMIT;
