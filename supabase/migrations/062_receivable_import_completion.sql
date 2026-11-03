-- Confirmação de importação CR: uma análise sob lock e consulta de resultado sem lock.
-- Preserva arquivos, carteiras, recebimentos reais, aprovação de retorno e auditoria.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $apply062$
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM pg_advisory_xact_lock(2045812308);
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='057_receivable_return_approval') THEN
  RAISE EXCEPTION 'Ative a aprovação de retorno 057 antes da confirmação otimizada.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='062_receivable_import_completion') THEN RETURN;END IF;
 EXECUTE $source062$
CREATE FUNCTION cf_private.set_receivable_completion_actor(p_user_id uuid,p_session_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_session_id!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 PERFORM cf_private.require_receivable_finance('read');PERFORM cf_private.require_receivable_finance('write');PERFORM cf_private.require_receivable_finance('import');
 IF NOT cf_private.has_permission('importar_bases','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
END $$;

CREATE OR REPLACE FUNCTION cf_private.receivable_import_collector_plan(p_preview jsonb,p_collector_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_group record;v_keys jsonb;v_requires boolean;v_resolved uuid;v_missing integer:=0;v_needed boolean:=false;v_assignments jsonb[]:='{}';BEGIN
 IF p_collector_mappings IS NULL OR jsonb_typeof(p_collector_mappings)<>'object' OR octet_length(p_collector_mappings::text)>1048576
  OR (SELECT count(*) FROM jsonb_object_keys(p_collector_mappings))>5000 THEN
  RAISE EXCEPTION 'Informe as responsáveis usando as chaves oficiais dos clientes.' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_object_agg(r->>'customer_key',true),'{}') INTO v_keys FROM jsonb_array_elements(p_preview->'rows') r;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_collector_mappings) m WHERE length(m.key)>1505 OR m.key~'[[:cntrl:]]'
  OR NOT(m.key LIKE 'name:%' OR m.key~'^cnpj:[0-9]{14}$') OR jsonb_typeof(m.value)<>'string'
  OR m.value#>>'{}'!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR NOT v_keys ? m.key) THEN
  RAISE EXCEPTION 'A seleção contém cliente desconhecido ou responsável inválida. Gere nova análise.' USING ERRCODE='22023';END IF;
 -- Compute presence and active owners once. A per-customer JSON presence scan was quadratic.
 FOR v_group IN
  WITH incoming AS MATERIALIZED(SELECT r FROM jsonb_array_elements(p_preview->'rows') r),
  present AS MATERIALIZED(SELECT DISTINCT(r->>'title_id')::uuid id FROM incoming WHERE r->>'title_id' IS NOT NULL),
  active AS MATERIALIZED(SELECT t.* FROM public.receivable_titles t WHERE t.scope='grupo-consolidado' AND t.status<>'VALIDATED'
   AND(NOT t.retired_from_report OR EXISTS(SELECT 1 FROM present p WHERE p.id=t.id))
   AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id)),
  owners AS(SELECT customer_key,count(DISTINCT collector_id)::integer owners,min(collector_id::text)::uuid owner,
   bool_or(collector_locked) locked,bool_or(collector_id IS NULL AND collector_locked) locked_null,bool_or(collector_id IS NULL) has_unassigned
   FROM active GROUP BY customer_key),
  groups AS(SELECT r->>'customer_key' customer_key,min(r->>'client_name') client_name,min(r->>'client_document') client_document,count(*)::integer row_count,
   bool_or(t.id IS NULL OR(t.status<>'VALIDATED' AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id))) eligible,
   bool_or(t.id IS NULL AND r->>'outcome'='NEW') new_rows FROM incoming LEFT JOIN public.receivable_titles t ON t.id=(r->>'title_id')::uuid GROUP BY r->>'customer_key'),
  planned AS(SELECT g.*,coalesce(o.owners,0) owners,o.owner,coalesce(o.locked,false) locked,coalesce(o.locked_null,false) locked_null,
   coalesce(o.has_unassigned,false) has_unassigned,(p_collector_mappings->>g.customer_key)::uuid selected FROM groups g LEFT JOIN owners o USING(customer_key))
  SELECT p.*,coalesce(a.enabled,false) selected_enabled,coalesce(b.enabled,false) owner_enabled,c.display_name resolved_name
  FROM planned p LEFT JOIN public.collection_agents a ON a.id=p.selected LEFT JOIN public.collection_agents b ON b.id=p.owner
   LEFT JOIN public.collection_agents c ON c.id=CASE WHEN p.eligible THEN coalesce(p.owner,p.selected) END ORDER BY p.customer_key
 LOOP
  IF v_group.selected IS NOT NULL AND NOT v_group.selected_enabled THEN RAISE EXCEPTION 'Selecione uma responsável ativa. Nenhuma carteira foi alterada.' USING ERRCODE='23514';END IF;
  IF v_group.eligible AND(v_group.owners>1 OR v_group.locked_null) THEN RAISE EXCEPTION 'Cliente com carteira conflitante ou vínculo bloqueado sem responsável. Confira a carteira antes de importar.' USING ERRCODE='23514';END IF;
  IF v_group.eligible AND v_group.owner IS NOT NULL AND NOT v_group.owner_enabled THEN RAISE EXCEPTION 'A responsável existente está inativa. A carteira foi preservada; confira o cadastro antes de importar.' USING ERRCODE='23514';END IF;
  IF v_group.selected IS NOT NULL AND(NOT v_group.eligible OR v_group.owner IS NOT NULL AND v_group.selected<>v_group.owner) THEN RAISE EXCEPTION 'A importação não redistribui carteiras nem altera responsáveis de títulos quitados.' USING ERRCODE='23514';END IF;
  v_requires:=v_group.eligible AND v_group.owner IS NULL;v_resolved:=CASE WHEN v_group.eligible THEN coalesce(v_group.owner,v_group.selected) END;
  IF v_requires AND v_resolved IS NULL THEN v_missing:=v_missing+1;END IF;
  v_needed:=v_needed OR(v_group.eligible AND(v_group.new_rows OR v_group.has_unassigned));
  v_assignments:=array_append(v_assignments,jsonb_build_object('customer_key',v_group.customer_key,'client_name',v_group.client_name,'client_document',v_group.client_document,
   'collector_id',v_resolved,'collector_name',v_group.resolved_name,'row_count',v_group.row_count,'requires_selection',v_requires,'locked',v_group.locked,'eligible',v_group.eligible));
 END LOOP;
 RETURN jsonb_build_object('assignments',to_jsonb(v_assignments),'missing_count',v_missing,'assignment_needed',v_needed);
END $$;

CREATE FUNCTION cf_private.apply_receivables_open_preview_062(p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_preview jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_file bytea;v_existing uuid;v_result jsonb;v_id uuid:=gen_random_uuid();v_row jsonb;v_rows jsonb;v_title_id uuid;v_collector uuid;
 v_customer jsonb;v_count integer;v_total integer:=0;v_clients integer:=0;BEGIN
 -- Private owner-only core. Its only caller checked the exact preview under both locks.
 v_file:=cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 IF NOT coalesce((p_preview->>'can_commit')::boolean,false) THEN RAISE EXCEPTION 'Análise incompleta.' USING ERRCODE='P0047';END IF;
 SELECT i.id,s.result INTO v_existing,v_result FROM public.receivable_imports i JOIN public.receivable_sync_imports s ON s.import_id=i.id
  WHERE i.scope=p_scope AND i.file_sha256=p_file_sha256 AND i.import_mode='OPEN';
 IF v_existing IS NULL THEN
  v_rows:=p_preview->'rows';
  INSERT INTO public.receivable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode)
   VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),(p_preview->>'new_count')::integer,
    (p_preview->>'open_count')::integer,0,(p_preview->>'validated_in_source_count')::integer,'OPEN');
  INSERT INTO cf_private.receivable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
  -- Keep each title's touch/audit/financial-revision triggers, while invalidating
  -- the global context/workbench once for this statement instead of once per row.
  PERFORM t.id FROM public.receivable_titles t JOIN jsonb_array_elements(v_rows) r ON t.id=(r->>'title_id')::uuid ORDER BY t.id FOR UPDATE OF t;
  UPDATE public.receivable_titles t SET document=r->>'document',client_name=r->>'client_name',client_document=r->>'client_document',customer_key=r->>'customer_key',branch=r->>'branch',
   issued_on=(r->>'issued_on')::date,due_date=(r->>'due_date')::date,amount_cents=(r->>'amount_cents')::bigint,
   status=CASE WHEN t.status='NEW' THEN 'OPEN' ELSE t.status END,in_latest_report=true,last_import_id=v_id
   FROM jsonb_array_elements(v_rows) r WHERE t.id=(r->>'title_id')::uuid;
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
   v_title_id:=(v_row->>'title_id')::uuid;
   IF v_title_id IS NULL THEN
    SELECT t.collector_id INTO v_collector FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=v_row->>'customer_key'
     AND t.status<>'VALIDATED' AND NOT t.retired_from_report AND t.collector_id IS NOT NULL LIMIT 1;
    INSERT INTO public.receivable_titles(scope,source_key,document,client_name,client_document,customer_key,branch,issued_on,due_date,amount_cents,collector_id,status,first_import_id,last_import_id)
    VALUES(p_scope,v_row->>'source_key',v_row->>'document',v_row->>'client_name',v_row->>'client_document',v_row->>'customer_key',v_row->>'branch',
     (v_row->>'issued_on')::date,(v_row->>'due_date')::date,(v_row->>'amount_cents')::bigint,v_collector,'NEW',v_id,v_id) RETURNING id INTO v_title_id;
   END IF;
   PERFORM cf_private.bind_receivable_parcel_alias(p_scope,v_row->>'source_key',v_title_id);
  END LOOP;
  v_result:=(p_preview-'rows'-'errors'-'can_commit'-'financial_revision'-'return_items'-'retirement_items'-'customer_collector_assignments')||jsonb_build_object('import_id',v_id,'mode','open');
  INSERT INTO public.receivable_sync_imports(import_id,mode,result,created_by) VALUES(v_id,'OPEN',v_result,auth.uid());
 ELSE v_result:=v_result||jsonb_build_object('idempotent',true);END IF;
 FOR v_customer IN SELECT value FROM jsonb_array_elements(p_preview->'customer_collector_assignments') WHERE value->>'collector_id' IS NOT NULL LOOP
  v_collector:=(v_customer->>'collector_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=v_collector AND enabled) THEN RAISE EXCEPTION 'A responsável não está disponível. Nenhuma alteração será mantida.' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key' AND t.status<>'VALIDATED' AND NOT t.retired_from_report
   AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id)
   AND((t.collector_id IS NOT NULL AND t.collector_id<>v_collector) OR(t.collector_id IS NULL AND t.collector_locked))) THEN
   RAISE EXCEPTION 'A carteira mudou ou possui vínculo bloqueado. A responsável existente foi preservada.' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key' AND t.status<>'VALIDATED' AND NOT t.retired_from_report
   AND t.collector_id IS NULL AND NOT t.collector_locked AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id)) THEN CONTINUE;END IF;
  UPDATE public.receivable_titles t SET collector_id=v_collector WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key' AND t.status<>'VALIDATED' AND NOT t.retired_from_report
   AND t.collector_id IS NULL AND NOT t.collector_locked AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN v_total:=v_total+v_count;v_clients:=v_clients+1;
   INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
   SELECT id,username,role_key,'contas_receber','customer_assignment',v_customer->>'customer_key','ASSIGNMENT',
    jsonb_build_object('collector_id',v_collector,'assigned_count',v_count,'import_id',v_result->>'import_id','origin','OPEN_IMPORT_030') FROM public.profiles WHERE id=auth.uid();END IF;
 END LOOP;
 RETURN v_result||jsonb_build_object('collector_assignment_version','030','assigned_title_count',v_total,'assigned_customer_count',v_clients);
END $$;

CREATE OR REPLACE FUNCTION public.commit_receivables_open_report_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,
 p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_title_mappings jsonb DEFAULT '{}'::jsonb,p_previous_import_id uuid DEFAULT NULL,
 p_previous_financial_revision text DEFAULT NULL,p_collector_mappings jsonb DEFAULT '{}'::jsonb,p_full_report boolean DEFAULT NULL,
 p_reference_date date DEFAULT NULL,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='5s' AS $fn$
DECLARE v_preview jsonb;v_result jsonb;v_hash text;v_saved cf_private.receivable_open_report_requests%ROWTYPE;v_row jsonb;v_item jsonb;
 v_title_id uuid;v_import uuid;v_collector uuid;v_retired boolean;v_extra_assigned integer:=0;v_changed integer;v_assignment_customers text[];v_return jsonb;v_approval cf_private.receivable_return_approvals%ROWTYPE;v_receipt public.effective_receivable_receipts%ROWTYPE;v_current_revision bigint;v_return_count integer:=0;v_current_title public.receivable_titles%ROWTYPE;v_collector_lookup jsonb;v_return_lookup jsonb;BEGIN
 PERFORM cf_private.set_receivable_completion_actor(p_user_id,p_session_id);PERFORM cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Confirme a análise usando um identificador de solicitação.' USING ERRCODE='22023';END IF;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('scope',p_scope,'file_name',p_file_name,'hash',p_file_sha256,'rows',p_rows,'titles',p_title_mappings,
 'collectors',p_collector_mappings,'previous_import_id',p_previous_import_id,'revision',p_previous_financial_revision,'full_report',p_full_report,'reference_date',p_reference_date)::text,'UTF8')),'hex');
 SELECT * INTO v_saved FROM cf_private.receivable_open_report_requests WHERE request_id=p_request_id;
 IF v_saved.request_id IS NOT NULL THEN
  IF v_saved.actor_id<>auth.uid() OR v_saved.payload_hash<>v_hash THEN RAISE EXCEPTION 'A solicitação já foi usada com outra análise. Gere nova análise.' USING ERRCODE='23505';END IF;
  RETURN v_saved.result||jsonb_build_object('idempotent',true);
 END IF;
 -- A completed frozen request can be recovered without waiting for other imports.
 -- A missing row remains uncertain; serialize and recheck before any mutation.
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM pg_advisory_xact_lock(2045812308);
 -- Permissions/session may have changed while waiting for the operation lock.
 PERFORM cf_private.set_receivable_completion_actor(p_user_id,p_session_id);
 SELECT * INTO v_saved FROM cf_private.receivable_open_report_requests WHERE request_id=p_request_id;
 IF v_saved.request_id IS NOT NULL THEN
  IF v_saved.actor_id<>auth.uid() OR v_saved.payload_hash<>v_hash THEN RAISE EXCEPTION 'A solicitação já foi usada com outra análise. Gere nova análise.' USING ERRCODE='23505';END IF;
  RETURN v_saved.result||jsonb_build_object('idempotent',true);
 END IF;
 v_preview:=public.preview_receivables_open_report(p_scope,p_rows,p_full_report,p_reference_date,p_title_mappings,p_collector_mappings);
 IF p_previous_import_id IS DISTINCT FROM(v_preview->>'previous_import_id')::uuid OR p_previous_financial_revision IS NULL
 OR p_previous_financial_revision IS DISTINCT FROM v_preview->>'financial_revision' THEN
 RAISE EXCEPTION 'A base, a carteira ou os atendimentos mudaram. Gere nova análise antes de confirmar.' USING ERRCODE='40001';END IF;
 IF NOT(v_preview->>'can_commit')::boolean THEN
  IF coalesce((v_preview->>'return_unapproved_count')::integer,0)>0 THEN
   RAISE EXCEPTION 'O retorno dos títulos exige aprovação individual da Gerência e nova análise.' USING ERRCODE='P0047';END IF;
  RAISE EXCEPTION 'Confirme as parcelas e responsáveis antes de concluir o relatório.' USING ERRCODE='P0047';END IF;
 -- Todas as decisões são conferidas antes de arquivar/aplicar o relatório.
 FOR v_return IN SELECT value FROM jsonb_array_elements(v_preview->'return_items') LOOP
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('contas_receber','validate') THEN
   RAISE EXCEPTION 'Somente a Gerência que aprovou pode concluir um relatório com retornos.' USING ERRCODE='42501';END IF;
  SELECT * INTO v_approval FROM cf_private.receivable_return_approvals WHERE id=(v_return->>'approval_id')::uuid;
  IF NOT FOUND OR v_approval.actor_id<>auth.uid() OR EXISTS(SELECT 1 FROM cf_private.receivable_return_consumptions WHERE approval_id=v_approval.id) THEN
   RAISE EXCEPTION 'A aprovação mudou. Analise e confira o retorno novamente.' USING ERRCODE='40001';END IF;
 END LOOP;
 SELECT coalesce(array_agg(DISTINCT candidates.customer_key),ARRAY[]::text[]) INTO v_assignment_customers FROM(
 SELECT t.customer_key FROM public.receivable_titles t WHERE t.scope=p_scope AND t.collector_id IS NULL AND NOT t.collector_locked AND t.status<>'VALIDATED'
 AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id)
 AND(NOT t.retired_from_report OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview->'rows')r WHERE(r->>'title_id')::uuid=t.id))
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview->'customer_collector_assignments')a WHERE a->>'customer_key'=t.customer_key AND a->>'collector_id' IS NOT NULL)
 UNION SELECT r->>'customer_key' FROM jsonb_array_elements(v_preview->'rows')r WHERE r->>'title_id' IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=r->>'customer_key' AND NOT t.retired_from_report AND t.status<>'VALIDATED' AND t.collector_id IS NOT NULL)
 )candidates;
 -- O original é reaproveitado quando o mesmo arquivo já foi importado; a conciliação tem request próprio.
 v_result:=cf_private.apply_receivables_open_preview_062(p_scope,p_file_name,p_file_sha256,p_file_base64,v_preview);
 SELECT coalesce(jsonb_object_agg(a->>'customer_key',a->'collector_id'),'{}') INTO v_collector_lookup FROM jsonb_array_elements(v_preview->'customer_collector_assignments') a;
 SELECT coalesce(jsonb_object_agg(a->>'title_id',a),'{}') INTO v_return_lookup FROM jsonb_array_elements(v_preview->'return_items') a;
 v_import:=(v_result->>'import_id')::uuid;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_preview->'rows') LOOP
  SELECT a.title_id INTO v_title_id FROM cf_private.receivable_parcel_aliases a WHERE a.scope=p_scope AND a.source_key=v_row->>'source_key';
  IF v_title_id IS NULL THEN RAISE EXCEPTION 'Não foi possível confirmar a identidade de uma parcela. Nenhum dado foi alterado.' USING ERRCODE='P0047';END IF;
  v_return:=v_return_lookup->v_title_id::text;
  IF v_return IS NOT NULL THEN
   SELECT * INTO v_approval FROM cf_private.receivable_return_approvals WHERE id=(v_return->>'approval_id')::uuid;
   IF v_approval.receipt_id IS NOT NULL THEN
    -- O inner commit só atualizou campos da fonte; valor/vencimento pagos são protegidos.
    SELECT revision INTO v_current_revision FROM public.receivable_titles WHERE id=v_title_id FOR UPDATE;
    PERFORM public.reverse_receivable_receipt(v_approval.receipt_id,v_approval.reason,v_current_revision,v_approval.id);
   END IF;
   INSERT INTO cf_private.receivable_return_consumptions(approval_id,request_id,source_import_id,file_sha256,consumed_by)
    VALUES(v_approval.id,p_request_id,v_import,p_file_sha256,auth.uid());
   INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    SELECT id,username,role_key,'contas_receber','receivable_return_approvals',v_approval.id::text,'REOPEN',
     jsonb_build_object('operation','APPLY_RETURN','title_id',v_title_id,'approval_id',v_approval.id,'request_id',p_request_id,'import_id',v_import,'file_sha256',p_file_sha256,'reason',v_approval.reason)
    FROM public.profiles WHERE id=auth.uid();
   v_return_count:=v_return_count+1;
  END IF;
  SELECT * INTO v_current_title FROM public.receivable_titles WHERE id=v_title_id FOR UPDATE;v_retired:=v_current_title.retired_from_report;
  IF v_retired AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=v_title_id AND t.status<>'VALIDATED'
   AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id)) THEN
   PERFORM cf_private.record_receivable_report_event(v_title_id,'REAPPEARED',v_import,p_request_id,p_reference_date);
  END IF;
  -- Replays do arquivo financeiro não reaplicam linhas; esta conciliação nova precisa restaurar a posição presente.
  IF v_current_title.document IS DISTINCT FROM v_row->>'document' OR v_current_title.client_name IS DISTINCT FROM v_row->>'client_name'
  OR v_current_title.client_document IS DISTINCT FROM v_row->>'client_document' OR v_current_title.customer_key IS DISTINCT FROM v_row->>'customer_key' OR v_current_title.branch IS DISTINCT FROM v_row->>'branch'
  OR v_current_title.issued_on IS DISTINCT FROM(v_row->>'issued_on')::date OR v_current_title.due_date IS DISTINCT FROM(v_row->>'due_date')::date OR v_current_title.amount_cents IS DISTINCT FROM(v_row->>'amount_cents')::bigint
  OR(v_current_title.status<>'VALIDATED' AND NOT v_current_title.in_latest_report) OR v_current_title.last_import_id IS DISTINCT FROM v_import THEN
  UPDATE public.receivable_titles t SET document=v_row->>'document',client_name=v_row->>'client_name',client_document=v_row->>'client_document',
  customer_key=v_row->>'customer_key',branch=v_row->>'branch',issued_on=(v_row->>'issued_on')::date,due_date=(v_row->>'due_date')::date,
  amount_cents=(v_row->>'amount_cents')::bigint,status=CASE WHEN t.status='NEW' THEN 'OPEN' ELSE t.status END,
  in_latest_report=CASE WHEN t.status='VALIDATED' THEN t.in_latest_report ELSE true END,last_import_id=v_import
  WHERE t.id=v_title_id AND(t.document IS DISTINCT FROM v_row->>'document' OR t.client_name IS DISTINCT FROM v_row->>'client_name'
  OR t.client_document IS DISTINCT FROM v_row->>'client_document' OR t.customer_key IS DISTINCT FROM v_row->>'customer_key' OR t.branch IS DISTINCT FROM v_row->>'branch'
  OR t.issued_on IS DISTINCT FROM(v_row->>'issued_on')::date OR t.due_date IS DISTINCT FROM(v_row->>'due_date')::date OR t.amount_cents IS DISTINCT FROM(v_row->>'amount_cents')::bigint
  OR(t.status<>'VALIDATED' AND NOT t.in_latest_report) OR t.last_import_id IS DISTINCT FROM v_import);
  END IF;
  v_collector:=(v_collector_lookup->>(v_row->>'customer_key'))::uuid;
  v_changed:=0;
  IF v_collector IS NOT NULL AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=v_title_id AND t.collector_id IS NULL AND NOT t.collector_locked
   AND t.status<>'VALIDATED' AND NOT t.retired_from_report AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id)) THEN
  UPDATE public.receivable_titles t SET collector_id=v_collector WHERE t.id=v_title_id AND t.collector_id IS NULL AND NOT t.collector_locked
  AND t.status<>'VALIDATED' AND NOT t.retired_from_report AND v_collector IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id);
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  END IF;
  v_extra_assigned:=v_extra_assigned+v_changed;
  IF v_changed>0 THEN INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
   SELECT id,username,role_key,'contas_receber','customer_assignment',v_row->>'customer_key','ASSIGNMENT',jsonb_build_object('collector_id',v_collector,'assigned_count',v_changed,'title_id',v_title_id,'import_id',v_import,'request_id',p_request_id,'origin','OPEN_REPORT_047') FROM public.profiles WHERE id=auth.uid();END IF;
  -- Retorno aprovado também encerra a informação de pagamento ainda não validada.
  -- A devolução já existente preserva o relato PAID e registra um novo encaminhamento.
  IF v_return IS NOT NULL AND v_approval.receipt_id IS NULL AND EXISTS(
   SELECT 1 FROM public.receivable_titles t WHERE t.id=v_title_id AND t.status='PENDING_VALIDATION' AND t.validation_status='PENDING') THEN
   SELECT revision INTO v_current_revision FROM public.receivable_titles WHERE id=v_title_id FOR UPDATE;
   PERFORM public.validate_receivable_payment(v_title_id,'NOT_LOCATED',NULL,v_approval.reason,v_current_revision);
  END IF;
 END LOOP;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_preview->'retirement_items') LOOP
  PERFORM cf_private.record_receivable_report_event((v_item->>'title_id')::uuid,CASE WHEN(v_item->>'worked')::boolean THEN 'RETIRED_WORKED' ELSE 'RETIRED_UNWORKED' END,v_import,p_request_id,p_reference_date);
 END LOOP;
 v_result:=v_result||jsonb_build_object('format_version','receivables-open-report-v1','request_id',p_request_id,'full_report',p_full_report,'reference_date',p_reference_date,
 'row_count',(v_preview->>'row_count')::integer,'new_count',(v_preview->>'new_count')::integer,
 'open_count',(v_preview->>'open_count')::integer,'changed_count',(v_preview->>'changed_count')::integer,
 'pending_count',(v_preview->>'pending_count')::integer,'validated_in_source_count',(v_preview->>'validated_in_source_count')::integer,
 'retired_count',(v_preview->>'retired_count')::integer,'retired_worked_count',(v_preview->>'retired_worked_count')::integer,
 'retired_unworked_count',(v_preview->>'retired_unworked_count')::integer,'reappeared_count',(v_preview->>'reappeared_count')::integer,'idempotent',false,
 'return_approval_version','057','completion_version','062','returned_count',v_return_count,
 'assigned_title_count',(v_result->>'assigned_title_count')::integer+v_extra_assigned,'assigned_customer_count',cardinality(v_assignment_customers));
 INSERT INTO cf_private.receivable_open_report_requests(request_id,actor_id,payload_hash,source_import_id,full_report,reference_date,result)
 VALUES(p_request_id,auth.uid(),v_hash,v_import,p_full_report,p_reference_date,v_result);
 RETURN v_result;
END $fn$;

CREATE OR REPLACE FUNCTION public.receivables_import_capabilities() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('contas_receber','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('schema_version','047_receivables_complete_report','open_sync',true,'received_import',true,'open_report_sync',true,'open_report_version','047','completion_version','062');
END $$;

CREATE FUNCTION public.receivable_open_report_request_status(p_request_id uuid,p_scope text,p_file_sha256 text,p_full_report boolean,p_reference_date date,p_expected_row_count integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET lock_timeout='5s' AS $$
DECLARE v_saved cf_private.receivable_open_report_requests%ROWTYPE;v_import public.receivable_imports%ROWTYPE;v_result jsonb;BEGIN
 PERFORM cf_private.require_receivable_finance('read');PERFORM cf_private.require_receivable_finance('write');PERFORM cf_private.require_receivable_finance('import');
 IF NOT cf_private.has_permission('importar_bases','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_request_id IS NULL OR p_scope IS DISTINCT FROM 'grupo-consolidado' OR p_file_sha256 IS NULL OR p_file_sha256!~'^[a-f0-9]{64}$'
  OR p_full_report IS NULL OR p_reference_date IS NULL OR p_reference_date NOT BETWEEN DATE '1900-01-01' AND(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
  OR p_expected_row_count IS NULL OR p_expected_row_count NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'Prova de confirmação inválida.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_saved FROM cf_private.receivable_open_report_requests WHERE request_id=p_request_id AND actor_id=auth.uid();
 IF FOUND THEN
  SELECT * INTO v_import FROM public.receivable_imports WHERE id=v_saved.source_import_id;
  IF v_import.scope IS DISTINCT FROM p_scope OR v_import.file_sha256 IS DISTINCT FROM p_file_sha256 OR v_saved.full_report IS DISTINCT FROM p_full_report
   OR v_saved.reference_date IS DISTINCT FROM p_reference_date OR(v_saved.result->>'row_count')::integer IS DISTINCT FROM p_expected_row_count THEN
   RAISE EXCEPTION 'O protocolo não corresponde a este arquivo e análise.' USING ERRCODE='22023';END IF;
  v_result:=v_saved.result||jsonb_build_object('idempotent',true);
 END IF;
 RETURN jsonb_build_object('format_version','receivables-open-report-status-v1','status',CASE WHEN v_result IS NULL THEN 'UNCONFIRMED' ELSE 'COMPLETED' END,
  'request_id',p_request_id,'source_sha256',p_file_sha256,'full_report',p_full_report,'reference_date',p_reference_date,'row_count',p_expected_row_count,'result',v_result);
END $$;
REVOKE ALL ON FUNCTION cf_private.set_receivable_completion_actor(uuid,text),cf_private.apply_receivables_open_preview_062(text,text,text,text,jsonb),
 public.receivable_open_report_request_status(uuid,text,text,boolean,date,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.receivable_open_report_request_status(uuid,text,text,boolean,date,integer) TO authenticated;
 $source062$;
 INSERT INTO public.central_schema_migrations(version) VALUES('062_receivable_import_completion');
 NOTIFY pgrst,'reload schema';
END $apply062$;
COMMIT;
