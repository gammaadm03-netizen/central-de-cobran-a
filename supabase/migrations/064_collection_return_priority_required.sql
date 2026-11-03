-- Cobrança: retornos com data até hoje devem ser atendidos antes de novos títulos.
-- Preserva atendimentos já iniciados, carteiras, recebimentos, intervalos e históricos.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $apply064$
DECLARE
 v_row text;v_start text;v_metadata text;
 v_row_next text;v_start_next text;v_metadata_next text;
 v_row_count integer;v_start_count integer;
 v_row_gate text:=$row_gate$  WHEN NOT v_return AND NOT EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL AND title_id=p_title.id)
   AND (cf_private.collection_workflow_priority(p_title.collector_id)->>'due_count')::bigint>0 THEN 'RETURN_PRIORITY'
$row_gate$;
 v_start_gate text:=$start_gate$   IF NOT coalesce(v_title.next_action_date<=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,false)
    AND (cf_private.collection_workflow_priority(v_title.collector_id)->>'due_count')::bigint>0 THEN
    RAISE EXCEPTION 'Atenda primeiro os retornos devidos desta carteira.' USING ERRCODE='P0029';END IF;
$start_gate$;
 v_row_anchor text:=$row_anchor$  WHEN EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL AND title_id<>p_title.id) THEN 'ALREADY_RUNNING'
  ELSE NULL END;$row_anchor$;
 v_start_anchor text:=$start_anchor$   IF p_expected_revision IS NULL OR p_expected_revision<>v_title.revision THEN RAISE EXCEPTION 'O título mudou. Atualize a tela.' USING ERRCODE='40001';END IF;
   INSERT INTO public.collection_work_sessions(title_id,actor_id,collector_id,document_snapshot,client_name_snapshot,branch_snapshot,collector_name_snapshot)$start_anchor$;
 v_metadata_legacy text:=$metadata_legacy$'returns_priority',true)$metadata_legacy$;
 v_metadata_relaxed text:=$metadata_relaxed$'returns_priority',true,'returns_block_new',false)$metadata_relaxed$;
 v_metadata_required text:=$metadata_required$'returns_priority',true,'returns_block_new',true)$metadata_required$;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM pg_advisory_xact_lock(2045812308);
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative o relatório completo047 e o atendimento da Cobrança antes desta atualização.' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN
  RAISE EXCEPTION 'Ative o relatório completo047 e o atendimento da Cobrança antes desta atualização.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='064_collection_return_priority_required') THEN RETURN;END IF;

 -- Work from the installed definitions so receipt/reversal, retirement, role,
 -- wallet, revision, one-timer and replay protections remain exactly as installed.
 v_row:=pg_get_functiondef('cf_private.collection_workbench_row(public.receivable_titles,timestamp with time zone)'::regprocedure);
 v_start:=pg_get_functiondef('public.collection_work_action(uuid,text,bigint,uuid)'::regprocedure);
 v_metadata:=pg_get_functiondef('cf_private.collection_workflow_metadata(uuid)'::regprocedure);
 v_row_count:=(length(v_row)-length(replace(v_row,v_row_gate,'')))/length(v_row_gate);
 v_start_count:=(length(v_start)-length(replace(v_start,v_start_gate,'')))/length(v_start_gate);

 IF v_row_count=0 AND v_start_count=0
  AND (length(v_metadata)-length(replace(v_metadata,v_metadata_relaxed,'')))/length(v_metadata_relaxed)=1
  AND (length(v_row)-length(replace(v_row,v_row_anchor,'')))/length(v_row_anchor)=1
  AND (length(v_start)-length(replace(v_start,v_start_anchor,'')))/length(v_start_anchor)=1 THEN
  -- Published063: restore only its two removed scheduling gates.
  v_row_next:=replace(v_row,v_row_anchor,
   replace(v_row_anchor,'  ELSE NULL END;',v_row_gate||'  ELSE NULL END;'));
  v_start_next:=replace(v_start,v_start_anchor,
   replace(v_start_anchor,'   INSERT INTO public.collection_work_sessions',v_start_gate||'   INSERT INTO public.collection_work_sessions'));
  v_metadata_next:=replace(v_metadata,v_metadata_relaxed,v_metadata_required);
 ELSIF v_row_count=1 AND v_start_count=1
  AND position('returns_block_new' IN v_metadata)=0
  AND (length(v_metadata)-length(replace(v_metadata,v_metadata_legacy,'')))/length(v_metadata_legacy)=1 THEN
  -- The original047 rule already enforces priority. Expose it to the interface.
  v_row_next:=v_row;v_start_next:=v_start;
  v_metadata_next:=replace(v_metadata,v_metadata_legacy,v_metadata_required);
 ELSE
  RAISE EXCEPTION 'O contrato do atendimento divergiu. A atualização foi interrompida sem alterar dados ou regras.' USING ERRCODE='22023';
 END IF;

 -- Validate every replacement before changing any of the three functions.
 IF (length(v_row_next)-length(replace(v_row_next,v_row_gate,'')))/length(v_row_gate)<>1
  OR (length(v_start_next)-length(replace(v_start_next,v_start_gate,'')))/length(v_start_gate)<>1
  OR (length(v_metadata_next)-length(replace(v_metadata_next,v_metadata_required,'')))/length(v_metadata_required)<>1 THEN
  RAISE EXCEPTION 'Não foi possível confirmar a regra de retornos. Nenhum dado ou regra foi alterado.' USING ERRCODE='22023';END IF;
 IF v_row_next IS DISTINCT FROM v_row THEN EXECUTE v_row_next;END IF;
 IF v_start_next IS DISTINCT FROM v_start THEN EXECUTE v_start_next;END IF;
 EXECUTE v_metadata_next;
 INSERT INTO public.central_schema_migrations(version) VALUES('064_collection_return_priority_required');
 NOTIFY pgrst,'reload schema';
END $apply064$;
COMMIT;
