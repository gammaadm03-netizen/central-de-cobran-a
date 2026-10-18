-- Cobrança acompanha somente títulos vencidos; CR mantém a carteira completa.
-- Aplicar uma única vez após 009_collections. Não depende das migrations de CP.
-- Nenhum título, vínculo, recebimento ou histórico é excluído ou reclassificado.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative Contas a Receber e Cobrança antes desta atualização.' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='009_collections') THEN
  RAISE EXCEPTION 'Ative a atualização 009 de Cobrança antes desta atualização.' USING ERRCODE='22023';
 END IF;
END $$;

-- Mesmo uma consulta direta à tabela não expõe títulos a vencer à cobradora.
-- A leitura financeira e a leitura da Diretoria permanecem completas.
DROP POLICY receivable_titles_read ON public.receivable_titles;
CREATE POLICY receivable_titles_read ON public.receivable_titles FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read') OR (
   cf_private.has_permission('cobranca','read')
   AND collector_id=cf_private.current_collector_id()
   AND due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date));

-- A tela de Cobrança usa esta visão para todos os perfis, inclusive CR e Diretoria.
-- security_invoker conserva as permissões e a RLS da tabela de origem.
CREATE VIEW public.collection_overdue_titles WITH (security_invoker=true,security_barrier=true) AS
 SELECT t.*,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS collection_as_of_date
 FROM public.receivable_titles t
 WHERE t.due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
REVOKE ALL ON TABLE public.collection_overdue_titles FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.collection_overdue_titles TO authenticated;
COMMENT ON VIEW public.collection_overdue_titles IS
 'Cobrança: somente vencimento anterior ao dia oficial de São Paulo. Inclui histórico validado quando solicitado; a carteira ativa filtra status diferente de VALIDATED. Não altera a carteira completa de CR.';

-- Protege também chamadas manuais à API por Gerência, CR ou cobradoras.
-- A validação financeira em CR permanece independente do vencimento.
CREATE OR REPLACE FUNCTION cf_private.require_collection_title(p_title public.receivable_titles) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_title.due_date IS NULL
   OR p_title.due_date>=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
   OR NOT cf_private.has_permission('cobranca','write') OR NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND (
     p.role_key IN ('gerente_geral','contas_receber') OR
     (p.role_key IN ('cobradora_1','cobradora_2') AND p_title.collector_id IS NOT NULL
      AND p_title.collector_id=cf_private.current_collector_id()))) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION cf_private.require_collection_title(public.receivable_titles)
 FROM PUBLIC,anon,authenticated,service_role;

INSERT INTO public.central_schema_migrations(version) VALUES('022_collections_overdue_only');
COMMIT;
