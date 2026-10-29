-- BEGIN ACTIVE RECEIPT CONSUMERS 056
-- Preserva o livro imutável como destino de INSERT e origem dos históricos.
-- Somente consultas operacionais dos contratos conhecidos passam à visão ativa.
DO $cf056_consumers$
DECLARE
 v_signature text;v_oid regprocedure;v_definition text;v_replacement text;
 v_before jsonb;v_after jsonb;
 v_pattern constant text:='(\mFROM|\mJOIN)([[:space:]]+)public[.]receivable_receipts\M';
BEGIN
 FOREACH v_signature IN ARRAY ARRAY[
  'cf_private.close_settled_collection_work()',
  'cf_private.collection_workbench_row(public.receivable_titles,timestamp with time zone)',
  'cf_private.collection_workflow_collectible(public.receivable_titles)',
  'cf_private.receivable_import_collector_plan(jsonb,jsonb)',
  'cf_private.record_receivable_report_event(uuid,text,uuid,uuid,date)',
  'cf_private.resolve_receivable_sync_rows(text,jsonb,jsonb,text)',
  'public.collection_workbench(text,uuid,boolean,text,text,text,integer,integer,text,date,date,text,text)',
  'public.commit_receivables_open_import_with_collectors_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb)',
  'public.commit_receivables_open_report_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb,boolean,date,uuid)',
  'public.pending_collection_commissions(text,uuid,integer,integer)',
  'public.prepare_collection_customer_email(uuid)',
  'public.preview_receivables_open_report(text,jsonb,boolean,date,jsonb,jsonb)',
  'public.receivable_retired_validation_queue(text,uuid,integer,integer)',
  'public.save_collection_case(uuid,text,text,text,date,bigint,bigint,date,boolean,uuid)',
  'public.validate_receivable_payment_v2(uuid,text,date,bigint,text,text,bigint,uuid)'
 ] LOOP
  v_oid:=to_regprocedure(v_signature);
  IF v_oid IS NULL THEN
   IF v_signature='public.prepare_collection_customer_email(uuid)' THEN CONTINUE;END IF;
   RAISE EXCEPTION 'Contrato operacional ausente para a atualização 056: %.',v_signature USING ERRCODE='22023';
  END IF;
  SELECT pg_get_functiondef(p.oid),
   jsonb_build_object('owner',p.proowner,'acl',p.proacl,'security_definer',p.prosecdef,'configuration',p.proconfig,
    'strict',p.proisstrict,'volatility',p.provolatile,'parallel',p.proparallel,
    'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid))
   INTO v_definition,v_before FROM pg_proc p WHERE p.oid=v_oid;
  IF v_definition !~* v_pattern THEN
   IF position('public.active_receivable_receipts' IN v_definition)>0 THEN CONTINUE;END IF;
   RAISE EXCEPTION 'O contrato % não corresponde à consulta esperada; nenhuma alteração será mantida.',v_signature USING ERRCODE='22023';
  END IF;
  -- A expressão não alcança INSERT INTO, LOCK TABLE ou os tipos de registro.
  v_replacement:=regexp_replace(v_definition,v_pattern,'\1\2public.active_receivable_receipts','gi');
  IF v_replacement=v_definition OR v_replacement ~* v_pattern THEN
   RAISE EXCEPTION 'Não foi possível atualizar a consulta operacional %.',v_signature USING ERRCODE='22023';
  END IF;
  EXECUTE v_replacement;
  SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'security_definer',p.prosecdef,'configuration',p.proconfig,
   'strict',p.proisstrict,'volatility',p.provolatile,'parallel',p.proparallel,
   'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid))
   INTO v_after FROM pg_proc p WHERE p.oid=v_oid;
  IF v_before IS DISTINCT FROM v_after THEN
   RAISE EXCEPTION 'Os limites de acesso do contrato % mudaram; nenhuma alteração será mantida.',v_signature USING ERRCODE='22023';
  END IF;
 END LOOP;
END $cf056_consumers$;

-- A apuração copia uma posição coerente com confirmações e estornos.
DO $cf056_assessment$
DECLARE v_oid regprocedure:=to_regprocedure('public.save_commission_assessment(text,date,date,text,text,text)');
 v_definition text;v_replacement text;v_before jsonb;v_after jsonb;
BEGIN
 IF v_oid IS NULL THEN RAISE EXCEPTION 'Ative as comissões antes da atualização 056.' USING ERRCODE='22023';END IF;
 SELECT pg_get_functiondef(p.oid),
  jsonb_build_object('owner',p.proowner,'acl',p.proacl,'security_definer',p.prosecdef,'configuration',p.proconfig,
   'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid))
  INTO v_definition,v_before FROM pg_proc p WHERE p.oid=v_oid;
 IF position('public.receivable_receipt_reversals' IN v_definition)>0
  AND position('cf_private.receivable_active_receipts' IN v_definition)>0
  AND position('pg_advisory_xact_lock(2045812308)' IN v_definition)>0 THEN RETURN;END IF;
 IF position('LOCK TABLE public.receivable_titles' IN v_definition)=0
  OR position('public.receivable_receipts,public.receivable_receipt_adjustments' IN v_definition)=0 THEN
  RAISE EXCEPTION 'A apuração não corresponde ao contrato esperado; nenhuma alteração será mantida.' USING ERRCODE='22023';
 END IF;
 v_replacement:=replace(v_definition,'LOCK TABLE public.receivable_titles',
  'PERFORM pg_advisory_xact_lock(2045812308);'||E'\n LOCK TABLE public.receivable_titles');
 v_replacement:=replace(v_replacement,'public.receivable_receipts,public.receivable_receipt_adjustments',
  'public.receivable_receipts,public.receivable_receipt_reversals,cf_private.receivable_active_receipts,public.receivable_receipt_adjustments');
 EXECUTE v_replacement;
 SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'security_definer',p.prosecdef,'configuration',p.proconfig,
  'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid))
  INTO v_after FROM pg_proc p WHERE p.oid=v_oid;
 IF v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'Os limites de acesso da apuração mudaram; nenhuma alteração será mantida.' USING ERRCODE='22023';
 END IF;
END $cf056_assessment$;

-- Um arquivo de Quitados já importado não pode reafirmar uma quitação estornada.
-- O cache só permanece compatível quando um recebimento vigente equivalente já
-- foi registrado explicitamente; esta verificação nunca cria recebimento.
DO $cf056_received_cache$
DECLARE
 v_oid regprocedure:=to_regprocedure('public.commit_receivables_received_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean)');
 v_definition text;v_before jsonb;v_after jsonb;
 v_old constant text:='IF v_existing IS NOT NULL THEN RETURN v_result||jsonb_build_object(''idempotent'',true);END IF;';
 v_new constant text:=$cf056_cached_branch$
 IF v_existing IS NOT NULL THEN
  IF EXISTS(
   SELECT 1 FROM public.receivable_received_import_rows imported
   JOIN public.receivable_titles title ON title.id=imported.title_id
   JOIN public.receivable_receipt_reversals reversal ON reversal.receipt_id=imported.receipt_id
   LEFT JOIN public.effective_receivable_receipts current_receipt ON current_receipt.title_id=imported.title_id
   WHERE imported.import_id=v_existing AND(
    current_receipt.id IS NULL
    OR current_receipt.amount_cents IS DISTINCT FROM (imported.source_row->>'received_amount_cents')::bigint
    OR current_receipt.payment_date IS DISTINCT FROM (imported.source_row->>'received_on')::date
    OR current_receipt.nominal_amount_cents IS DISTINCT FROM (imported.source_row->>'amount_cents')::bigint
    OR coalesce(current_receipt.original_due_date,title.due_date) IS DISTINCT FROM (imported.source_row->>'due_date')::date)
  ) THEN
   RAISE EXCEPTION 'Este arquivo inclui recebimento estornado. Confira a origem e gere um relatório atualizado; o arquivo antigo não confirma novo recebimento.' USING ERRCODE='P0024';
  END IF;
  RETURN v_result||jsonb_build_object('idempotent',true);
 END IF;
 $cf056_cached_branch$;
BEGIN
 IF v_oid IS NULL THEN RAISE EXCEPTION 'Ative a importação de Quitados antes da atualização 056.' USING ERRCODE='22023';END IF;
 SELECT pg_get_functiondef(p.oid),
  jsonb_build_object('owner',p.proowner,'acl',p.proacl,'security_definer',p.prosecdef,'configuration',p.proconfig,
   'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid))
  INTO v_definition,v_before FROM pg_proc p WHERE p.oid=v_oid;
 IF position('Este arquivo inclui recebimento estornado.' IN v_definition)>0 THEN RETURN;END IF;
 IF position(v_old IN v_definition)=0 THEN
  RAISE EXCEPTION 'O cache de Quitados não corresponde ao contrato esperado; nenhuma alteração será mantida.' USING ERRCODE='22023';
 END IF;
 EXECUTE replace(v_definition,v_old,v_new);
 SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'security_definer',p.prosecdef,'configuration',p.proconfig,
  'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid))
  INTO v_after FROM pg_proc p WHERE p.oid=v_oid;
 IF v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'Os limites de acesso da importação de Quitados mudaram; nenhuma alteração será mantida.' USING ERRCODE='22023';
 END IF;
END $cf056_received_cache$;
-- END ACTIVE RECEIPT CONSUMERS 056
