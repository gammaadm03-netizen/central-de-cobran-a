-- Cobrança: retornos continuam prioritários na agenda sem bloquear outros títulos.
-- Preserva a carteira autorizada, um intervalo por pessoa e a finalização iniciada.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $apply063$
DECLARE
 v_row text;v_start text;v_metadata text;
 v_row_gate text:=$row_gate$  WHEN NOT v_return AND NOT EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL AND title_id=p_title.id)
   AND (cf_private.collection_workflow_priority(p_title.collector_id)->>'due_count')::bigint>0 THEN 'RETURN_PRIORITY'
$row_gate$;
 v_start_gate text:=$start_gate$   IF NOT coalesce(v_title.next_action_date<=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,false)
    AND (cf_private.collection_workflow_priority(v_title.collector_id)->>'due_count')::bigint>0 THEN
    RAISE EXCEPTION 'Atenda primeiro os retornos devidos desta carteira.' USING ERRCODE='P0029';END IF;
$start_gate$;
 v_metadata_gate text:=$metadata_gate$'returns_priority',true)$metadata_gate$;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM pg_advisory_xact_lock(2045812308);
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative o relatório completo047 e o atendimento da Cobrança antes desta atualização.' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN
  RAISE EXCEPTION 'Ative o relatório completo047 e o atendimento da Cobrança antes desta atualização.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='063_collection_start_priority') THEN RETURN;END IF;

 -- Apply only the known scheduling gates. Keep all current receipt/reversal,
 -- retirement, role, ownership, concurrency, revision and replay protections.
 v_row:=pg_get_functiondef('cf_private.collection_workbench_row(public.receivable_titles,timestamp with time zone)'::regprocedure);
 v_start:=pg_get_functiondef('public.collection_work_action(uuid,text,bigint,uuid)'::regprocedure);
 v_metadata:=pg_get_functiondef('cf_private.collection_workflow_metadata(uuid)'::regprocedure);
 IF (length(v_row)-length(replace(v_row,v_row_gate,'')))/length(v_row_gate)<>1
  OR (length(v_start)-length(replace(v_start,v_start_gate,'')))/length(v_start_gate)<>1
  OR (length(v_metadata)-length(replace(v_metadata,v_metadata_gate,'')))/length(v_metadata_gate)<>1 THEN
  RAISE EXCEPTION 'O contrato do atendimento divergiu. A atualização foi interrompida sem alterar dados ou regras.' USING ERRCODE='22023';END IF;
 EXECUTE replace(v_row,v_row_gate,'');
 EXECUTE replace(v_start,v_start_gate,'');
 EXECUTE replace(v_metadata,v_metadata_gate,$metadata_new$'returns_priority',true,'returns_block_new',false)$metadata_new$);
 INSERT INTO public.central_schema_migrations(version) VALUES('063_collection_start_priority');
 NOTIFY pgrst,'reload schema';
END $apply063$;
COMMIT;
