-- Responsável oficial na importação de abertos; nenhuma redistribuição implícita.
-- O arquivo financeiro continua sob as regras e a identidade da atualização 023.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.collection_agents') IS NULL OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='023_receivable_sync') THEN
  RAISE EXCEPTION 'Ative Contas a Receber e a sincronização 023 antes das responsáveis na importação.' USING ERRCODE='22023';END IF;
END $$;

CREATE FUNCTION cf_private.receivable_import_collector_plan(p_preview jsonb,p_collector_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_group record;v_owner uuid;v_selected uuid;v_resolved uuid;v_name text;v_owners integer;v_locked boolean;v_locked_null boolean;
 v_requires boolean;v_assignments jsonb:='[]';v_missing integer:=0;v_needed boolean:=false;v_mapping jsonb;
BEGIN
 IF p_collector_mappings IS NULL OR jsonb_typeof(p_collector_mappings)<>'object' OR octet_length(p_collector_mappings::text)>1048576
  OR (SELECT count(*) FROM jsonb_object_keys(p_collector_mappings))>5000 THEN
  RAISE EXCEPTION 'Informe as responsáveis usando as chaves oficiais dos clientes.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_collector_mappings)m WHERE length(m.key)>1505 OR m.key~'[[:cntrl:]]'
  OR NOT(m.key LIKE 'name:%' OR m.key~'^cnpj:[0-9]{14}$') OR jsonb_typeof(m.value)<>'string'
  OR m.value#>>'{}' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_preview->'rows')r WHERE r->>'customer_key'=m.key)) THEN
  RAISE EXCEPTION 'A seleção contém cliente desconhecido ou responsável inválida. Gere nova análise.' USING ERRCODE='22023';END IF;
 FOR v_group IN
  SELECT r->>'customer_key' AS customer_key,min(r->>'client_name') AS client_name,min(r->>'client_document') AS client_document,
   count(*)::integer AS row_count,bool_or(t.id IS NULL OR (t.status<>'VALIDATED' AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id))) AS eligible,
   bool_or(t.id IS NULL AND r->>'outcome'='NEW') AS new_rows
  FROM jsonb_array_elements(p_preview->'rows')r LEFT JOIN public.receivable_titles t ON t.id=(r->>'title_id')::uuid
  GROUP BY r->>'customer_key' ORDER BY r->>'customer_key'
 LOOP
  v_owner:=NULL;v_selected:=NULL;v_resolved:=NULL;v_name:=NULL;v_locked:=false;v_locked_null:=false;
  SELECT count(DISTINCT t.collector_id)::integer,min(t.collector_id::text)::uuid,
   coalesce(bool_or(t.collector_locked),false),coalesce(bool_or(t.collector_id IS NULL AND t.collector_locked),false)
  INTO v_owners,v_owner,v_locked,v_locked_null FROM public.receivable_titles t
  WHERE t.scope='grupo-consolidado' AND t.customer_key=v_group.customer_key AND t.status<>'VALIDATED'
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id);
  v_mapping:=p_collector_mappings->v_group.customer_key;
  IF v_mapping IS NOT NULL THEN
   v_selected:=(v_mapping#>>'{}')::uuid;
   IF NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=v_selected AND enabled) THEN
    RAISE EXCEPTION 'Selecione uma responsável ativa. Nenhuma carteira foi alterada.' USING ERRCODE='23514';END IF;
  END IF;
  IF v_group.eligible AND (v_owners>1 OR v_locked_null) THEN
   RAISE EXCEPTION 'Cliente com carteira conflitante ou vínculo bloqueado sem responsável. Confira a carteira antes de importar.' USING ERRCODE='23514';END IF;
  IF v_group.eligible AND v_owner IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=v_owner AND enabled) THEN
   RAISE EXCEPTION 'A responsável existente está inativa. A carteira foi preservada; confira o cadastro antes de importar.' USING ERRCODE='23514';END IF;
  IF v_selected IS NOT NULL AND (NOT v_group.eligible OR v_owner IS NOT NULL AND v_selected<>v_owner) THEN
   RAISE EXCEPTION 'A importação não redistribui carteiras nem altera responsáveis de títulos quitados.' USING ERRCODE='23514';END IF;
  v_requires:=v_group.eligible AND v_owner IS NULL;v_resolved:=CASE WHEN v_group.eligible THEN coalesce(v_owner,v_selected) END;
  IF v_requires AND v_resolved IS NULL THEN v_missing:=v_missing+1;END IF;
  SELECT display_name INTO v_name FROM public.collection_agents WHERE id=v_resolved;
  IF v_group.eligible AND (v_group.new_rows OR EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope='grupo-consolidado'
    AND t.customer_key=v_group.customer_key AND t.status<>'VALIDATED' AND t.collector_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id))) THEN v_needed:=true;END IF;
  v_assignments:=v_assignments||jsonb_build_array(jsonb_build_object('customer_key',v_group.customer_key,'client_name',v_group.client_name,
   'client_document',v_group.client_document,'collector_id',v_resolved,'collector_name',v_name,'row_count',v_group.row_count,
   'requires_selection',v_requires,'locked',v_locked,'eligible',v_group.eligible));
 END LOOP;
 RETURN jsonb_build_object('assignments',v_assignments,'missing_count',v_missing,'assignment_needed',v_needed);
END $$;

CREATE FUNCTION public.preview_receivables_open_import_with_collectors(p_scope text,p_rows jsonb,
 p_title_mappings jsonb DEFAULT '{}'::jsonb,p_collector_mappings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_preview jsonb;v_plan jsonb;v_assignments jsonb;BEGIN
 v_preview:=public.preview_receivables_open_import(p_scope,p_rows,p_title_mappings);
 v_plan:=cf_private.receivable_import_collector_plan(v_preview,p_collector_mappings);
 SELECT coalesce(jsonb_agg(a-'eligible' ORDER BY a->>'customer_key'),'[]'::jsonb) INTO v_assignments FROM jsonb_array_elements(v_plan->'assignments')a;
 RETURN v_preview||jsonb_build_object('collector_assignment_version','030','customer_collector_assignments',v_assignments,
  'missing_collector_count',(v_plan->>'missing_count')::integer,'can_commit',(v_preview->>'can_commit')::boolean AND (v_plan->>'missing_count')::integer=0);
END $$;

CREATE FUNCTION public.commit_receivables_open_import_with_collectors_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,
 p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_title_mappings jsonb DEFAULT '{}'::jsonb,
 p_previous_import_id uuid DEFAULT NULL,p_previous_financial_revision text DEFAULT NULL,p_collector_mappings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_preview jsonb;v_plan jsonb;v_result jsonb;v_customer jsonb;v_collector uuid;v_count integer;v_total integer:=0;v_clients integer:=0;v_existing uuid;
BEGIN
 PERFORM cf_private.set_receivable_sync_actor(p_user_id,p_session_id);
 PERFORM cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 PERFORM pg_advisory_xact_lock(2045812308);
 v_preview:=public.preview_receivables_open_import(p_scope,p_rows,p_title_mappings);
 v_plan:=cf_private.receivable_import_collector_plan(v_preview,p_collector_mappings);
 IF NOT (v_preview->>'can_commit')::boolean OR (v_plan->>'missing_count')::integer>0 THEN
  RAISE EXCEPTION 'Confirme as parcelas e informe a responsável de cada cliente sem carteira antes de importar.' USING ERRCODE='P0030';END IF;
 SELECT id INTO v_existing FROM public.receivable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256 AND import_mode='OPEN';
 -- O replay financeiro não autoriza uma nova atribuição com análise obsoleta.
 IF v_existing IS NOT NULL AND (v_plan->>'assignment_needed')::boolean AND (p_previous_import_id IS DISTINCT FROM (v_preview->>'previous_import_id')::uuid
  OR p_previous_financial_revision IS NULL OR p_previous_financial_revision IS DISTINCT FROM v_preview->>'financial_revision') THEN
  RAISE EXCEPTION 'A carteira mudou. Gere nova análise antes de preencher as responsáveis.' USING ERRCODE='40001';END IF;
 v_result:=public.commit_receivables_open_import_from_gateway(p_user_id,p_session_id,p_scope,p_file_name,p_file_sha256,p_file_base64,p_rows,p_title_mappings,
  p_previous_import_id,p_previous_financial_revision);
 FOR v_customer IN SELECT value FROM jsonb_array_elements(v_plan->'assignments') WHERE (value->>'eligible')::boolean LOOP
  v_collector:=(v_customer->>'collector_id')::uuid;
  IF v_collector IS NULL OR NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=v_collector AND enabled) THEN
   RAISE EXCEPTION 'A responsável não está disponível. Nenhuma alteração será mantida.' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key' AND t.status<>'VALIDATED'
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)
   AND ((t.collector_id IS NOT NULL AND t.collector_id<>v_collector) OR (t.collector_id IS NULL AND t.collector_locked))) THEN
   RAISE EXCEPTION 'A carteira mudou ou possui vínculo bloqueado. A responsável existente foi preservada.' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key'
   AND t.status<>'VALIDATED' AND t.collector_id IS NULL AND NOT t.collector_locked
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)) THEN CONTINUE;END IF;
  UPDATE public.receivable_titles t SET collector_id=v_collector WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key'
   AND t.status<>'VALIDATED' AND t.collector_id IS NULL AND NOT t.collector_locked
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN
   v_total:=v_total+v_count;v_clients:=v_clients+1;
   INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    SELECT id,username,role_key,'contas_receber','customer_assignment',v_customer->>'customer_key','ASSIGNMENT',
     jsonb_build_object('collector_id',v_collector,'assigned_count',v_count,'import_id',v_result->>'import_id','origin','OPEN_IMPORT_030')
    FROM public.profiles WHERE id=auth.uid();
  END IF;
 END LOOP;
 RETURN v_result||jsonb_build_object('collector_assignment_version','030','assigned_title_count',v_total,'assigned_customer_count',v_clients);
END $$;

REVOKE ALL ON FUNCTION cf_private.receivable_import_collector_plan(jsonb,jsonb),
 public.preview_receivables_open_import_with_collectors(text,jsonb,jsonb,jsonb),
 public.commit_receivables_open_import_with_collectors_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_receivables_open_import_with_collectors(text,jsonb,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_receivables_open_import_with_collectors_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb) TO service_role;
INSERT INTO public.central_schema_migrations(version) VALUES('030_receivable_import_collectors');
COMMIT;
