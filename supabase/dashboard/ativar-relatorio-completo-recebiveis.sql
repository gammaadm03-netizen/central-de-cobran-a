-- CENTRAL FINANCEIRA — sincronização do relatório completo de Contas a Receber.
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Não cole SQL na Edge Function. Não importa planilhas nem retira títulos durante a instalação.
-- Depois publique o arquivo receivables-import.ts na Edge Function receivables-import.
-- Veja docs/recebiveis-relatorio-completo.md para conferir os pré-requisitos e o fluxo.

-- Relatório completo de abertos: ausência retira da operação, nunca confirma recebimento.
BEGIN;
DO $cf047guard$ BEGIN
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['023_receivable_sync','024_receivable_received_import','029_collection_workflow','030_receivable_import_collectors','034_commissions','041_receivable_import_performance']) v
 WHERE NOT EXISTS(SELECT 1 FROM public.central_schema_migrations m WHERE m.version=v)) THEN
  RAISE EXCEPTION 'Ative sincronização, recebimentos, carteiras, Cobrança e Comissões antes do relatório completo de CR.' USING ERRCODE='22023';
 END IF;
 EXECUTE $cf047ddl$
ALTER TABLE public.receivable_titles ADD COLUMN retired_from_report boolean NOT NULL DEFAULT false;
CREATE INDEX receivable_titles_operational ON public.receivable_titles(scope,status,due_date,id) WHERE NOT retired_from_report;
CREATE TABLE cf_private.receivable_open_report_requests(
 request_id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES public.profiles(id),payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),
 source_import_id uuid NOT NULL REFERENCES public.receivable_imports(id),full_report boolean NOT NULL,reference_date date NOT NULL,
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.receivable_report_retirement_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL REFERENCES cf_private.receivable_open_report_requests(request_id) DEFERRABLE INITIALLY DEFERRED,
 title_id uuid NOT NULL REFERENCES public.receivable_titles(id),source_import_id uuid NOT NULL REFERENCES public.receivable_imports(id),
 action text NOT NULL CHECK(action IN('RETIRED_WORKED','RETIRED_UNWORKED','REAPPEARED')),
 worked boolean NOT NULL,collector_id uuid REFERENCES public.collection_agents(id),title_revision bigint NOT NULL,event_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 title_snapshot jsonb NOT NULL CHECK(jsonb_typeof(title_snapshot)='object'),reference_date date NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_id,title_id),CHECK(action<>'RETIRED_WORKED' OR worked),CHECK(action<>'RETIRED_UNWORKED' OR NOT worked)
);
CREATE INDEX receivable_report_events_title ON public.receivable_report_retirement_events(title_id,created_at DESC,id DESC);
CREATE INDEX receivable_report_events_pending ON public.receivable_report_retirement_events(collector_id,created_at DESC,id DESC) WHERE action='RETIRED_WORKED';
ALTER TABLE cf_private.receivable_open_report_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_report_retirement_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.receivable_open_report_requests,public.receivable_report_retirement_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.receivable_report_retirement_events TO authenticated;
CREATE POLICY receivable_report_events_read ON public.receivable_report_retirement_events FOR SELECT TO authenticated USING(
 cf_private.has_permission('contas_receber','read') OR(cf_private.has_permission('cobranca','read') AND collector_id=cf_private.current_collector_id() AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=title_id AND t.collector_id=cf_private.current_collector_id() AND t.due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date)));
CREATE TRIGGER receivable_report_request_immutable BEFORE UPDATE OR DELETE ON cf_private.receivable_open_report_requests FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER receivable_report_event_immutable BEFORE UPDATE OR DELETE ON public.receivable_report_retirement_events FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER receivable_report_event_revision AFTER INSERT ON public.receivable_report_retirement_events FOR EACH ROW EXECUTE FUNCTION cf_private.bump_receivables_sync_revision();
-- START muda a evidência de trabalho mesmo sem alterar o título: invalida também a análise financeira.
CREATE TRIGGER receivable_work_evidence_revision AFTER INSERT OR UPDATE OR DELETE ON public.collection_work_sessions FOR EACH ROW EXECUTE FUNCTION cf_private.bump_receivables_sync_revision();
ALTER TABLE public.collection_work_sessions DROP CONSTRAINT collection_work_sessions_end_reason_check;
ALTER TABLE public.collection_work_sessions ADD CONSTRAINT collection_work_sessions_end_reason_check CHECK(end_reason IN('PAUSE','FINISH','TITLE_SETTLED','REPORT_RETIRED'));

CREATE FUNCTION cf_private.receivable_report_title_worked(p_title_id uuid,p_as_of timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT coalesce((SELECT t.reported_in_collection OR EXISTS(SELECT 1 FROM public.collection_work_sessions s WHERE s.title_id=t.id AND s.started_at<=p_as_of)
 OR EXISTS(SELECT 1 FROM public.receivable_collection_events e WHERE e.title_id=t.id AND e.created_at<=p_as_of AND e.action IN('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','OTHER','NOT_LOCATED_CONTACT'))
 FROM public.receivable_titles t WHERE t.id=p_title_id),false)
$fn$;
CREATE FUNCTION cf_private.guard_receivable_report_retirement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$ BEGIN
 IF (TG_OP='INSERT' AND NEW.retired_from_report) OR(TG_OP='UPDATE' AND NEW.retired_from_report IS DISTINCT FROM OLD.retired_from_report AND NOT EXISTS(
 SELECT 1 FROM public.receivable_report_retirement_events e WHERE e.title_id=OLD.id AND e.title_revision=OLD.revision
 AND((NEW.retired_from_report AND e.action IN('RETIRED_WORKED','RETIRED_UNWORKED')) OR(NOT NEW.retired_from_report AND e.action='REAPPEARED')))) THEN
 RAISE EXCEPTION 'A retirada ou reativação exige conciliação auditada do relatório de abertos.' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER guard_receivable_report_retirement BEFORE INSERT OR UPDATE OF retired_from_report ON public.receivable_titles FOR EACH ROW EXECUTE FUNCTION cf_private.guard_receivable_report_retirement();
CREATE FUNCTION cf_private.record_receivable_report_event(p_title_id uuid,p_action text,p_source_import_id uuid,p_request_id uuid,p_reference_date date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE t public.receivable_titles%ROWTYPE;v_id uuid;v_worked boolean;v_retire boolean;BEGIN
 PERFORM cf_private.require_receivable_finance('write');
 IF NOT cf_private.has_permission('contas_receber','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT * INTO t FROM public.receivable_titles WHERE id=p_title_id FOR UPDATE;
 IF t.id IS NULL OR p_request_id IS NULL OR p_reference_date IS NULL OR p_action NOT IN('RETIRED_WORKED','RETIRED_UNWORKED','REAPPEARED')
 OR NOT EXISTS(SELECT 1 FROM public.receivable_imports WHERE id=p_source_import_id AND scope=t.scope AND import_mode='OPEN') THEN
 RAISE EXCEPTION 'Conciliação de relatório inválida.' USING ERRCODE='22023';END IF;
 v_retire:=p_action<>'REAPPEARED';v_worked:=cf_private.receivable_report_title_worked(t.id,clock_timestamp());
 IF (v_retire AND(t.retired_from_report OR t.status='VALIDATED' OR EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=t.id)))
 OR(NOT v_retire AND NOT t.retired_from_report) OR(p_action='RETIRED_WORKED' AND NOT v_worked) OR(p_action='RETIRED_UNWORKED' AND v_worked) THEN
 RAISE EXCEPTION 'O título mudou. Gere nova análise do relatório de abertos.' USING ERRCODE='40001';END IF;
 INSERT INTO public.receivable_report_retirement_events(request_id,title_id,source_import_id,action,worked,collector_id,title_revision,title_snapshot,reference_date,actor_id)
 VALUES(p_request_id,t.id,p_source_import_id,p_action,v_worked,t.collector_id,t.revision,to_jsonb(t),p_reference_date,auth.uid()) RETURNING id INTO v_id;
 UPDATE public.receivable_titles SET retired_from_report=v_retire,in_latest_report=NOT v_retire WHERE id=t.id;
 IF v_retire THEN UPDATE public.collection_work_sessions SET ended_at=greatest(clock_timestamp(),started_at),end_reason='REPORT_RETIRED' WHERE title_id=t.id AND ended_at IS NULL;END IF;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 SELECT id,username,role_key,'contas_receber','receivable_report_retirement_events',v_id::text,'AUTO_RECONCILE',to_jsonb(t),
 jsonb_build_object('action',p_action,'source_import_id',p_source_import_id,'request_id',p_request_id,'reference_date',p_reference_date,'worked',v_worked,'financial_receipt_created',false)
 FROM public.profiles WHERE id=auth.uid();RETURN v_id;
END $fn$;

CREATE FUNCTION public.preview_receivables_open_report(p_scope text,p_rows jsonb,p_full_report boolean,p_reference_date date,
 p_title_mappings jsonb DEFAULT '{}'::jsonb,p_collector_mappings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_preview jsonb;v_items jsonb;v_worked integer;v_count integer;v_reappeared integer;v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;BEGIN
 IF p_full_report IS NULL OR p_reference_date IS NULL OR p_reference_date NOT BETWEEN DATE '1900-01-01' AND v_today THEN
 RAISE EXCEPTION 'Informe a data de referência e confirme se o relatório é completo ou incremental.' USING ERRCODE='22023';END IF;
 v_preview:=public.preview_receivables_open_import_with_collectors(p_scope,p_rows,p_title_mappings,p_collector_mappings);
 SELECT coalesce(jsonb_agg(jsonb_build_object('title_id',t.id,'client_name',t.client_name,'document',t.document,'branch',t.branch,'due_date',t.due_date,
 'amount_cents',t.amount_cents,'collector_id',t.collector_id,'worked',cf_private.receivable_report_title_worked(t.id,statement_timestamp())) ORDER BY t.due_date,t.id),'[]'::jsonb)
 INTO v_items FROM public.receivable_titles t WHERE p_full_report AND t.scope=p_scope AND NOT t.retired_from_report AND t.status<>'VALIDATED'
 AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview->'rows') r WHERE (r->>'title_id')::uuid=t.id);
 v_count:=jsonb_array_length(v_items);IF v_count>5000 THEN RAISE EXCEPTION 'O relatório retiraria mais de 5.000 títulos. Nenhum dado foi alterado; confira a base completa.' USING ERRCODE='54000';END IF;SELECT count(*)::integer INTO v_worked FROM jsonb_array_elements(v_items)i WHERE(i->>'worked')::boolean;
 SELECT count(*)::integer INTO v_reappeared FROM public.receivable_titles t WHERE t.scope=p_scope AND t.retired_from_report AND t.status<>'VALIDATED'
 AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview->'rows')r WHERE(r->>'title_id')::uuid=t.id);
 RETURN v_preview||jsonb_build_object('format_version','receivables-open-report-v1','full_report',p_full_report,'reference_date',p_reference_date,
 'retired_count',v_count,'retired_worked_count',v_worked,'retired_unworked_count',v_count-v_worked,'reappeared_count',v_reappeared,'retirement_items',v_items);
END $fn$;

CREATE FUNCTION public.commit_receivables_open_report_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,
 p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_title_mappings jsonb DEFAULT '{}'::jsonb,p_previous_import_id uuid DEFAULT NULL,
 p_previous_financial_revision text DEFAULT NULL,p_collector_mappings jsonb DEFAULT '{}'::jsonb,p_full_report boolean DEFAULT NULL,
 p_reference_date date DEFAULT NULL,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_preview jsonb;v_result jsonb;v_hash text;v_saved cf_private.receivable_open_report_requests%ROWTYPE;v_row jsonb;v_item jsonb;
 v_title_id uuid;v_import uuid;v_collector uuid;v_retired boolean;v_extra_assigned integer:=0;v_changed integer;v_assignment_customers text[];BEGIN
 PERFORM cf_private.set_receivable_sync_actor(p_user_id,p_session_id);PERFORM cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 PERFORM pg_advisory_xact_lock(2045812308);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Confirme a análise usando um identificador de solicitação.' USING ERRCODE='22023';END IF;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('scope',p_scope,'file_name',p_file_name,'hash',p_file_sha256,'rows',p_rows,'titles',p_title_mappings,
 'collectors',p_collector_mappings,'previous_import_id',p_previous_import_id,'revision',p_previous_financial_revision,'full_report',p_full_report,'reference_date',p_reference_date)::text,'UTF8')),'hex');
 SELECT * INTO v_saved FROM cf_private.receivable_open_report_requests WHERE request_id=p_request_id;
 IF v_saved.request_id IS NOT NULL THEN
  IF v_saved.actor_id<>auth.uid() OR v_saved.payload_hash<>v_hash THEN RAISE EXCEPTION 'A solicitação já foi usada com outra análise. Gere nova análise.' USING ERRCODE='23505';END IF;
  RETURN v_saved.result||jsonb_build_object('idempotent',true);
 END IF;
 v_preview:=public.preview_receivables_open_report(p_scope,p_rows,p_full_report,p_reference_date,p_title_mappings,p_collector_mappings);
 IF p_previous_import_id IS DISTINCT FROM(v_preview->>'previous_import_id')::uuid OR p_previous_financial_revision IS NULL
 OR p_previous_financial_revision IS DISTINCT FROM v_preview->>'financial_revision' THEN
 RAISE EXCEPTION 'A base, a carteira ou os atendimentos mudaram. Gere nova análise antes de confirmar.' USING ERRCODE='40001';END IF;
 IF NOT(v_preview->>'can_commit')::boolean THEN RAISE EXCEPTION 'Confirme as parcelas e responsáveis antes de concluir o relatório.' USING ERRCODE='P0047';END IF;
 SELECT coalesce(array_agg(DISTINCT candidates.customer_key),ARRAY[]::text[]) INTO v_assignment_customers FROM(
 SELECT t.customer_key FROM public.receivable_titles t WHERE t.scope=p_scope AND t.collector_id IS NULL AND NOT t.collector_locked AND t.status<>'VALIDATED'
 AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)
 AND(NOT t.retired_from_report OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview->'rows')r WHERE(r->>'title_id')::uuid=t.id))
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview->'customer_collector_assignments')a WHERE a->>'customer_key'=t.customer_key AND a->>'collector_id' IS NOT NULL)
 UNION SELECT r->>'customer_key' FROM jsonb_array_elements(v_preview->'rows')r WHERE r->>'title_id' IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=r->>'customer_key' AND NOT t.retired_from_report AND t.status<>'VALIDATED' AND t.collector_id IS NOT NULL)
 )candidates;
 -- O original é reaproveitado quando o mesmo arquivo já foi importado; a conciliação tem request próprio.
 v_result:=public.commit_receivables_open_import_with_collectors_from_gateway(p_user_id,p_session_id,p_scope,p_file_name,p_file_sha256,p_file_base64,p_rows,p_title_mappings,
 p_previous_import_id,p_previous_financial_revision,p_collector_mappings);
 v_import:=(v_result->>'import_id')::uuid;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_preview->'rows') LOOP
  SELECT a.title_id INTO v_title_id FROM cf_private.receivable_parcel_aliases a WHERE a.scope=p_scope AND a.source_key=v_row->>'source_key';
  IF v_title_id IS NULL THEN RAISE EXCEPTION 'Não foi possível confirmar a identidade de uma parcela. Nenhum dado foi alterado.' USING ERRCODE='P0047';END IF;
  SELECT retired_from_report INTO v_retired FROM public.receivable_titles WHERE id=v_title_id FOR UPDATE;
  IF v_retired AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=v_title_id AND t.status<>'VALIDATED'
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)) THEN
   PERFORM cf_private.record_receivable_report_event(v_title_id,'REAPPEARED',v_import,p_request_id,p_reference_date);
  END IF;
  -- Replays do arquivo financeiro não reaplicam linhas; esta conciliação nova precisa restaurar a posição presente.
  UPDATE public.receivable_titles t SET document=v_row->>'document',client_name=v_row->>'client_name',client_document=v_row->>'client_document',
  customer_key=v_row->>'customer_key',branch=v_row->>'branch',issued_on=(v_row->>'issued_on')::date,due_date=(v_row->>'due_date')::date,
  amount_cents=(v_row->>'amount_cents')::bigint,status=CASE WHEN t.status='NEW' THEN 'OPEN' ELSE t.status END,
  in_latest_report=CASE WHEN t.status='VALIDATED' THEN t.in_latest_report ELSE true END,last_import_id=v_import
  WHERE t.id=v_title_id AND(t.document IS DISTINCT FROM v_row->>'document' OR t.client_name IS DISTINCT FROM v_row->>'client_name'
  OR t.client_document IS DISTINCT FROM v_row->>'client_document' OR t.customer_key IS DISTINCT FROM v_row->>'customer_key' OR t.branch IS DISTINCT FROM v_row->>'branch'
  OR t.issued_on IS DISTINCT FROM(v_row->>'issued_on')::date OR t.due_date IS DISTINCT FROM(v_row->>'due_date')::date OR t.amount_cents IS DISTINCT FROM(v_row->>'amount_cents')::bigint
  OR(t.status<>'VALIDATED' AND NOT t.in_latest_report) OR t.last_import_id IS DISTINCT FROM v_import);
  SELECT(a->>'collector_id')::uuid INTO v_collector FROM jsonb_array_elements(v_preview->'customer_collector_assignments')a WHERE a->>'customer_key'=v_row->>'customer_key';
  UPDATE public.receivable_titles t SET collector_id=v_collector WHERE t.id=v_title_id AND t.collector_id IS NULL AND NOT t.collector_locked
  AND t.status<>'VALIDATED' AND NOT t.retired_from_report AND v_collector IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id);
  GET DIAGNOSTICS v_changed=ROW_COUNT;v_extra_assigned:=v_extra_assigned+v_changed;
  IF v_changed>0 THEN INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
   SELECT id,username,role_key,'contas_receber','customer_assignment',v_row->>'customer_key','ASSIGNMENT',jsonb_build_object('collector_id',v_collector,'assigned_count',v_changed,'title_id',v_title_id,'import_id',v_import,'request_id',p_request_id,'origin','OPEN_REPORT_047') FROM public.profiles WHERE id=auth.uid();END IF;
 END LOOP;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_preview->'retirement_items') LOOP
  PERFORM cf_private.record_receivable_report_event((v_item->>'title_id')::uuid,CASE WHEN(v_item->>'worked')::boolean THEN 'RETIRED_WORKED' ELSE 'RETIRED_UNWORKED' END,v_import,p_request_id,p_reference_date);
 END LOOP;
 v_result:=v_result||jsonb_build_object('format_version','receivables-open-report-v1','request_id',p_request_id,'full_report',p_full_report,'reference_date',p_reference_date,
 'retired_count',(v_preview->>'retired_count')::integer,'retired_worked_count',(v_preview->>'retired_worked_count')::integer,
 'retired_unworked_count',(v_preview->>'retired_unworked_count')::integer,'reappeared_count',(v_preview->>'reappeared_count')::integer,'idempotent',false,
 'assigned_title_count',(v_result->>'assigned_title_count')::integer+v_extra_assigned,'assigned_customer_count',cardinality(v_assignment_customers));
 INSERT INTO cf_private.receivable_open_report_requests(request_id,actor_id,payload_hash,source_import_id,full_report,reference_date,result)
 VALUES(p_request_id,auth.uid(),v_hash,v_import,p_full_report,p_reference_date,v_result);
 RETURN v_result;
END $fn$;

CREATE FUNCTION public.pending_collection_commissions(p_search text DEFAULT '',p_collector_id uuid DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_role text;v_collector uuid:=p_collector_id;v_rows jsonb;v_count bigint;v_options jsonb;BEGIN
 PERFORM cf_private.require_commissions(false);SELECT role_key INTO v_role FROM public.profiles WHERE id=auth.uid() AND enabled;
 IF v_role IN('cobradora_1','cobradora_2') THEN
 IF cf_private.current_collector_id() IS NULL OR(p_collector_id IS NOT NULL AND p_collector_id<>cf_private.current_collector_id()) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 v_collector:=cf_private.current_collector_id();END IF;
 IF p_search IS NULL OR length(p_search)>500 OR p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
 RAISE EXCEPTION 'Filtros inválidos para as pendências de comissão.' USING ERRCODE='22023';END IF;
 WITH pending AS(SELECT e.*,t.document,t.client_name,t.branch,t.due_date,t.amount_cents,a.display_name FROM public.receivable_report_retirement_events e
 JOIN public.receivable_titles t ON t.id=e.title_id LEFT JOIN public.collection_agents a ON a.id=e.collector_id
 WHERE e.action='RETIRED_WORKED' AND t.retired_from_report AND t.status<>'VALIDATED' AND(v_collector IS NULL OR e.collector_id=v_collector)
 AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.title_id=t.id)
 AND(v_role NOT IN('cobradora_1','cobradora_2') OR t.collector_id=v_collector)
 AND NOT EXISTS(SELECT 1 FROM public.receivable_report_retirement_events newer WHERE newer.title_id=e.title_id AND newer.event_sequence>e.event_sequence)
 AND(p_search='' OR concat_ws(' ',t.document,t.client_name,t.branch,a.display_name) ILIKE '%'||replace(replace(replace(p_search,'\','\\'),'%','\%'),'_','\_')||'%' ESCAPE '\'))
 SELECT(SELECT count(*) FROM pending),coalesce((SELECT jsonb_agg(jsonb_build_object('event_id',id,'title_id',title_id,'document',document,'client_name',client_name,'branch',branch,'due_date',due_date,
 'nominal_reference_cents',amount_cents,'collector_id',collector_id,'collector_name',display_name,'retired_at',created_at,'reference_date',reference_date,'source_import_id',source_import_id,
 'status','AWAITING_RECEIVED_REPORT','payment_date',NULL,'commission_cents',NULL) ORDER BY created_at DESC,id DESC) FROM(SELECT * FROM pending ORDER BY created_at DESC,id DESC OFFSET p_offset LIMIT p_limit)s),'[]'::jsonb)
 INTO v_count,v_rows;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'display_name',display_name) ORDER BY display_name,id),'[]'::jsonb) INTO v_options FROM public.collection_agents
 WHERE v_role NOT IN('cobradora_1','cobradora_2') OR id=v_collector;
 RETURN jsonb_build_object('format_version','pending-collection-commissions-v1','count',v_count,'revision',cf_private.receivables_sync_revision_value(),'rows',v_rows,'options',jsonb_build_object('collectors',v_options));
END $fn$;
CREATE OR REPLACE FUNCTION public.receivables_import_capabilities() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$ BEGIN
 IF NOT cf_private.has_permission('contas_receber','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('schema_version','047_receivables_complete_report','open_sync',true,'received_import',true,'open_report_sync',true,'open_report_version','047');END $fn$;
REVOKE ALL ON FUNCTION cf_private.receivable_report_title_worked(uuid,timestamptz),cf_private.guard_receivable_report_retirement(),cf_private.record_receivable_report_event(uuid,text,uuid,uuid,date),
 public.preview_receivables_open_report(text,jsonb,boolean,date,jsonb,jsonb),public.commit_receivables_open_report_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb,boolean,date,uuid),
 public.pending_collection_commissions(text,uuid,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_receivables_open_report(text,jsonb,boolean,date,jsonb,jsonb),public.pending_collection_commissions(text,uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_receivables_open_report_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb,boolean,date,uuid) TO service_role;

-- A view mantém as colunas existentes na mesma ordem e acrescenta a sinalização no final.
DO $view$ DECLARE cols text;BEGIN
 SELECT string_agg(format('t.%I',attname),',' ORDER BY attnum) INTO cols FROM pg_attribute WHERE attrelid='public.collection_overdue_titles'::regclass AND attnum>0 AND NOT attisdropped AND attname<>'collection_as_of_date';
 EXECUTE 'CREATE OR REPLACE VIEW public.collection_overdue_titles WITH(security_invoker=true,security_barrier=true) AS SELECT '||cols||',(statement_timestamp() AT TIME ZONE ''America/Sao_Paulo'')::date AS collection_as_of_date,t.retired_from_report FROM public.receivable_titles t WHERE t.due_date<(statement_timestamp() AT TIME ZONE ''America/Sao_Paulo'')::date';
END $view$;

CREATE OR REPLACE FUNCTION cf_private.resolve_receivable_sync_rows(p_scope text,p_rows jsonb,
 p_title_mappings jsonb DEFAULT '{}'::jsonb,p_mode text DEFAULT 'open') RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_result jsonb[]:=ARRAY[]::jsonb[];v_mapping jsonb;v_title public.receivable_titles%ROWTYPE;
 v_alias uuid;v_id uuid;v_outcome text;v_problem text;v_candidates jsonb;v_exact integer;v_group_count integer;v_changed boolean;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('open','received') OR p_scope IS DISTINCT FROM 'grupo-consolidado'
  OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000
  OR p_title_mappings IS NULL OR jsonb_typeof(p_title_mappings)<>'object' OR octet_length(p_title_mappings::text)>500000 THEN
  RAISE EXCEPTION 'Informe as parcelas e os vínculos da análise.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_title_mappings) m WHERE m.key !~ '^[1-9][0-9]{0,3}$'
  OR (m.key::integer)>jsonb_array_length(p_rows) OR jsonb_typeof(m.value)<>'string'
  OR (m.value#>>'{}'<>'NEW' AND m.value#>>'{}' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')) THEN
  RAISE EXCEPTION 'Vínculo de parcela inválido. Use o número da linha e um título existente ou NEW.' USING ERRCODE='22023';END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  v_id:=NULL;v_alias:=NULL;v_problem:=NULL;v_outcome:='NEW';v_changed:=false;v_title:=NULL;
  SELECT title_id INTO v_alias FROM cf_private.receivable_parcel_aliases WHERE scope=p_scope AND source_key=v_row->>'source_key';
  SELECT count(*),count(*) FILTER(WHERE t.due_date=(v_row->>'due_date')::date) INTO v_group_count,v_exact
  FROM public.receivable_titles t WHERE t.scope=p_scope
   AND upper(cf_private.normalize_receivable_text(t.branch))=upper(v_row->>'branch')
   AND upper(cf_private.normalize_receivable_text(t.document))=upper(v_row->>'document')
   AND t.customer_key=v_row->>'customer_key'
   AND cf_private.receivable_sync_group_key(t.branch,t.document,t.customer_key)=v_row->>'group_key';
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'due_date',t.due_date,'amount_cents',t.amount_cents,
   'status',t.status,'collector_id',t.collector_id) ORDER BY t.due_date,t.id),'[]'::jsonb) INTO v_candidates
  FROM (SELECT t.* FROM public.receivable_titles t WHERE t.scope=p_scope
   AND upper(cf_private.normalize_receivable_text(t.branch))=upper(v_row->>'branch')
   AND upper(cf_private.normalize_receivable_text(t.document))=upper(v_row->>'document')
   AND t.customer_key=v_row->>'customer_key'
   AND cf_private.receivable_sync_group_key(t.branch,t.document,t.customer_key)=v_row->>'group_key'
   ORDER BY t.due_date,t.id LIMIT 100) t;
  v_mapping:=p_title_mappings->(v_row->>'line');
  IF v_mapping IS NOT NULL THEN
   IF v_mapping#>>'{}'='NEW' THEN
    IF v_alias IS NOT NULL OR v_exact>0 THEN
     v_problem:='Já existe uma parcela com esse vencimento. Selecione o título existente; não crie a dívida novamente.';
    END IF;
   ELSE
    v_id:=(v_mapping#>>'{}')::uuid;
    SELECT * INTO v_title FROM public.receivable_titles WHERE id=v_id AND scope=p_scope
     AND cf_private.receivable_sync_group_key(branch,document,customer_key)=v_row->>'group_key';
    IF NOT FOUND OR (v_alias IS NOT NULL AND v_alias<>v_id) THEN
     v_id:=NULL;v_problem:='O título escolhido não pertence a esta parcela ou o vínculo já está estabelecido.';
    END IF;
   END IF;
  ELSIF v_alias IS NOT NULL THEN v_id:=v_alias;
  ELSIF v_exact=1 THEN
   SELECT id INTO v_id FROM public.receivable_titles t WHERE t.scope=p_scope AND t.due_date=(v_row->>'due_date')::date
    AND upper(cf_private.normalize_receivable_text(t.branch))=upper(v_row->>'branch')
   AND upper(cf_private.normalize_receivable_text(t.document))=upper(v_row->>'document')
   AND t.customer_key=v_row->>'customer_key'
   AND cf_private.receivable_sync_group_key(t.branch,t.document,t.customer_key)=v_row->>'group_key';
  ELSIF v_group_count>0 THEN
   v_outcome:='AMBIGUOUS';v_problem:='Confirme se esta linha é uma nova parcela ou uma alteração de vencimento de um título existente.';
  END IF;
  IF v_id IS NOT NULL AND v_problem IS NULL THEN
   SELECT * INTO v_title FROM public.receivable_titles WHERE id=v_id AND scope=p_scope;
   IF NOT FOUND THEN v_problem:='Vínculo de parcela indisponível. Gere nova análise.';v_id:=NULL;
   ELSE
    v_changed:=ROW(v_title.document,v_title.client_name,v_title.client_document,v_title.branch,v_title.issued_on,v_title.due_date,v_title.amount_cents)
     IS DISTINCT FROM ROW(v_row->>'document',v_row->>'client_name',v_row->>'client_document',v_row->>'branch',
      (v_row->>'issued_on')::date,(v_row->>'due_date')::date,(v_row->>'amount_cents')::bigint);
    v_outcome:=CASE WHEN v_changed THEN 'UPDATE' ELSE 'MATCHED' END;
    IF p_mode='open' AND (v_title.status='VALIDATED' OR EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=v_id))
     AND ROW(v_title.amount_cents,v_title.due_date) IS DISTINCT FROM ROW((v_row->>'amount_cents')::bigint,(v_row->>'due_date')::date) THEN
     v_problem:='Este título já possui recebimento validado. Use a importação de recebidos e a confirmação de correção; o histórico foi preservado.';
    END IF;
   END IF;
  END IF;
  IF v_id IS NULL AND v_problem IS NULL AND (SELECT count(DISTINCT collector_id) FROM public.receivable_titles
   WHERE scope=p_scope AND customer_key=v_row->>'customer_key' AND status<>'VALIDATED' AND NOT retired_from_report AND collector_id IS NOT NULL)>1 THEN
   v_problem:='Cliente com mais de uma cobradora ativa. Corrija a carteira antes de criar parcelas.';
  END IF;
  IF v_problem IS NOT NULL AND v_outcome<>'AMBIGUOUS' THEN v_outcome:='CONFLICT';END IF;
  v_result:=array_append(v_result,v_row||jsonb_build_object('title_id',v_id,'outcome',v_outcome,'changed',v_changed,
   'candidates',v_candidates,'problem',v_problem));
 END LOOP;
 -- Duas linhas do mesmo arquivo nunca podem atualizar o mesmo UUID.
 SELECT array_agg(CASE WHEN r->>'title_id' IN (SELECT s->>'title_id' FROM unnest(v_result) s
   WHERE s->>'title_id' IS NOT NULL GROUP BY s->>'title_id' HAVING count(*)>1)
  THEN r||jsonb_build_object('outcome','CONFLICT','problem','Duas linhas foram vinculadas ao mesmo título. Diferencie as parcelas antes de importar.') ELSE r END ORDER BY n)
 INTO v_result FROM unnest(v_result) WITH ORDINALITY x(r,n);
 RETURN to_jsonb(v_result);
END $$;

CREATE OR REPLACE FUNCTION public.commit_receivables_open_import_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,
 p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_title_mappings jsonb DEFAULT '{}'::jsonb,
 p_previous_import_id uuid DEFAULT NULL,p_previous_financial_revision text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_file bytea;v_rows jsonb;v_preview jsonb;v_previous uuid;v_existing uuid;v_result jsonb;v_id uuid:=gen_random_uuid();
 v_row jsonb;v_title_id uuid;v_collector uuid;BEGIN
 PERFORM cf_private.set_receivable_sync_actor(p_user_id,p_session_id);
 v_file:=cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 v_rows:=cf_private.normalize_receivable_sync_rows(p_scope,p_rows);
 PERFORM pg_advisory_xact_lock(2045812308);
 SELECT i.id,s.result INTO v_existing,v_result FROM public.receivable_imports i JOIN public.receivable_sync_imports s ON s.import_id=i.id
  WHERE i.scope=p_scope AND i.file_sha256=p_file_sha256 AND i.import_mode='OPEN';
 IF v_existing IS NOT NULL THEN RETURN v_result||jsonb_build_object('idempotent',true);END IF;
 SELECT id INTO v_previous FROM public.receivable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_previous IS DISTINCT FROM p_previous_import_id OR p_previous_financial_revision IS NULL
  OR length(p_previous_financial_revision)>256 OR p_previous_financial_revision IS DISTINCT FROM cf_private.receivables_sync_revision_value() THEN
  RAISE EXCEPTION 'A base ou os dados financeiros mudaram. Gere nova análise antes de confirmar.' USING ERRCODE='40001';END IF;
 v_preview:=public.preview_receivables_open_import(p_scope,p_rows,p_title_mappings);
 IF NOT (v_preview->>'can_commit')::boolean THEN
  RAISE EXCEPTION 'Há parcelas sem vínculo confirmado. Nenhum dado foi alterado.' USING ERRCODE='P0023',DETAIL=(v_preview->'errors')::text;END IF;
 v_rows:=v_preview->'rows';
 INSERT INTO public.receivable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode)
 VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),(v_preview->>'new_count')::integer,
  (v_preview->>'open_count')::integer,0,(v_preview->>'validated_in_source_count')::integer,'OPEN');
 INSERT INTO cf_private.receivable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
  v_title_id:=(v_row->>'title_id')::uuid;
  IF v_title_id IS NULL THEN
   SELECT t.collector_id INTO v_collector FROM public.receivable_titles t WHERE t.scope=p_scope
    AND t.customer_key=v_row->>'customer_key' AND t.status<>'VALIDATED' AND NOT t.retired_from_report AND t.collector_id IS NOT NULL LIMIT 1;
   INSERT INTO public.receivable_titles(scope,source_key,document,client_name,client_document,customer_key,branch,
    issued_on,due_date,amount_cents,collector_id,status,first_import_id,last_import_id)
   VALUES(p_scope,v_row->>'source_key',v_row->>'document',v_row->>'client_name',v_row->>'client_document',v_row->>'customer_key',v_row->>'branch',
    (v_row->>'issued_on')::date,(v_row->>'due_date')::date,(v_row->>'amount_cents')::bigint,v_collector,'NEW',v_id,v_id)
   RETURNING id INTO v_title_id;
  ELSE
   PERFORM id FROM public.receivable_titles WHERE id=v_title_id FOR UPDATE;
   UPDATE public.receivable_titles SET document=v_row->>'document',client_name=v_row->>'client_name',
    client_document=v_row->>'client_document',customer_key=v_row->>'customer_key',branch=v_row->>'branch',
    issued_on=(v_row->>'issued_on')::date,due_date=(v_row->>'due_date')::date,amount_cents=(v_row->>'amount_cents')::bigint,
    status=CASE WHEN status='NEW' THEN 'OPEN' ELSE status END,in_latest_report=true,last_import_id=v_id WHERE id=v_title_id;
  END IF;
  PERFORM cf_private.bind_receivable_parcel_alias(p_scope,v_row->>'source_key',v_title_id);
 END LOOP;
 v_result:=(v_preview-'rows'-'errors'-'can_commit'-'financial_revision')||jsonb_build_object('import_id',v_id,'mode','open');
 INSERT INTO public.receivable_sync_imports(import_id,mode,result,created_by) VALUES(v_id,'OPEN',v_result,auth.uid());
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION cf_private.receivable_import_collector_plan(p_preview jsonb,p_collector_mappings jsonb) RETURNS jsonb
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
   count(*)::integer AS row_count,bool_or(t.id IS NULL OR (t.status<>'VALIDATED' AND (NOT t.retired_from_report OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_preview->'rows') present WHERE(present->>'title_id')::uuid=t.id)) AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id))) AS eligible,
   bool_or(t.id IS NULL AND r->>'outcome'='NEW') AS new_rows
  FROM jsonb_array_elements(p_preview->'rows')r LEFT JOIN public.receivable_titles t ON t.id=(r->>'title_id')::uuid
  GROUP BY r->>'customer_key' ORDER BY r->>'customer_key'
 LOOP
  v_owner:=NULL;v_selected:=NULL;v_resolved:=NULL;v_name:=NULL;v_locked:=false;v_locked_null:=false;
  SELECT count(DISTINCT t.collector_id)::integer,min(t.collector_id::text)::uuid,
   coalesce(bool_or(t.collector_locked),false),coalesce(bool_or(t.collector_id IS NULL AND t.collector_locked),false)
  INTO v_owners,v_owner,v_locked,v_locked_null FROM public.receivable_titles t
  WHERE t.scope='grupo-consolidado' AND t.customer_key=v_group.customer_key AND t.status<>'VALIDATED' AND (NOT t.retired_from_report OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_preview->'rows') present WHERE(present->>'title_id')::uuid=t.id))
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
    AND t.customer_key=v_group.customer_key AND t.status<>'VALIDATED' AND (NOT t.retired_from_report OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_preview->'rows') present WHERE(present->>'title_id')::uuid=t.id)) AND t.collector_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id))) THEN v_needed:=true;END IF;
  v_assignments:=v_assignments||jsonb_build_array(jsonb_build_object('customer_key',v_group.customer_key,'client_name',v_group.client_name,
   'client_document',v_group.client_document,'collector_id',v_resolved,'collector_name',v_name,'row_count',v_group.row_count,
   'requires_selection',v_requires,'locked',v_locked,'eligible',v_group.eligible));
 END LOOP;
 RETURN jsonb_build_object('assignments',v_assignments,'missing_count',v_missing,'assignment_needed',v_needed);
END $$;

CREATE OR REPLACE FUNCTION public.commit_receivables_open_import_with_collectors_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,
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
  IF EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key' AND t.status<>'VALIDATED' AND NOT t.retired_from_report
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)
   AND ((t.collector_id IS NOT NULL AND t.collector_id<>v_collector) OR (t.collector_id IS NULL AND t.collector_locked))) THEN
   RAISE EXCEPTION 'A carteira mudou ou possui vínculo bloqueado. A responsável existente foi preservada.' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key'
   AND t.status<>'VALIDATED' AND NOT t.retired_from_report AND t.collector_id IS NULL AND NOT t.collector_locked
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)) THEN CONTINUE;END IF;
  UPDATE public.receivable_titles t SET collector_id=v_collector WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key'
   AND t.status<>'VALIDATED' AND NOT t.retired_from_report AND t.collector_id IS NULL AND NOT t.collector_locked
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

CREATE OR REPLACE FUNCTION cf_private.preview_receivable_received_rows(p_scope text,p_rows jsonb,p_title_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_row jsonb;v_result jsonb[]:='{}';v_title public.receivable_titles%ROWTYPE;
 v_receipt public.effective_receivable_receipts%ROWTYPE;v_outcome text;v_problem text;v_owner uuid;v_owners integer;
 v_new integer;v_received integer;v_matched integer;v_corrected integer;v_conflicts integer;v_errors jsonb;v_previous uuid;
BEGIN
 v_rows:=cf_private.resolve_receivable_sync_rows(p_scope,cf_private.normalize_receivable_received_rows(p_scope,p_rows),p_title_mappings,'received');
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
  v_title:=NULL;v_receipt:=NULL;v_owner:=NULL;v_problem:=v_row->>'problem';v_outcome:=v_row->>'outcome';
  IF v_outcome NOT IN ('AMBIGUOUS','CONFLICT') THEN
   IF v_row->>'title_id' IS NULL THEN
    SELECT count(DISTINCT collector_id),min(collector_id::text)::uuid INTO v_owners,v_owner
     FROM public.receivable_titles WHERE scope=p_scope AND customer_key=v_row->>'customer_key'
      AND status<>'VALIDATED' AND NOT retired_from_report AND collector_id IS NOT NULL;
    IF v_owners>1 THEN
     v_outcome:='CONFLICT';v_problem:='O cliente possui dívida ativa em carteiras diferentes. Confira a responsável antes de importar.';
    ELSE v_outcome:='HISTORICAL';END IF;
   ELSE
    SELECT * INTO v_title FROM public.receivable_titles WHERE id=(v_row->>'title_id')::uuid;
    v_owner:=v_title.collector_id;
    SELECT * INTO v_receipt FROM public.effective_receivable_receipts WHERE title_id=v_title.id;
    IF v_receipt.id IS NULL THEN v_outcome:='NEW_RECEIPT';
    ELSIF v_receipt.source_kind='MANUAL_VALIDATION' AND (
      v_receipt.amount_cents<>(v_row->>'received_amount_cents')::bigint
      OR v_receipt.payment_date<>(v_row->>'received_on')::date
      OR v_title.amount_cents<>(v_row->>'amount_cents')::bigint OR v_title.due_date<>(v_row->>'due_date')::date) THEN
     v_outcome:='CONFLICT';v_problem:='O recebimento validado manualmente difere da quitação importada. O registro manual foi preservado.';
    ELSIF v_receipt.amount_cents<>(v_row->>'received_amount_cents')::bigint
      OR v_receipt.payment_date<>(v_row->>'received_on')::date
      OR v_receipt.nominal_amount_cents<>(v_row->>'amount_cents')::bigint
      OR coalesce(v_receipt.original_due_date,v_title.due_date)<>(v_row->>'due_date')::date THEN v_outcome:='CORRECTION';
    ELSE v_outcome:='MATCHED';END IF;
   END IF;
  END IF;
  v_result:=array_append(v_result,v_row||jsonb_build_object('identity_outcome',v_row->>'outcome','outcome',v_outcome,
   'problem',v_problem,'receipt_id',v_receipt.id,'receipt_revision',v_receipt.receipt_revision,'collector_id',v_owner,
   'nominal_amount_cents',(v_row->>'amount_cents')::bigint));
 END LOOP;
 v_rows:=to_jsonb(v_result);
 SELECT count(*) FILTER(WHERE r->>'outcome'='HISTORICAL'),
  count(*) FILTER(WHERE r->>'outcome' IN ('NEW_RECEIPT','HISTORICAL')),
  count(*) FILTER(WHERE r->>'outcome'='MATCHED'),count(*) FILTER(WHERE r->>'outcome'='CORRECTION'),
  count(*) FILTER(WHERE r->>'outcome' IN ('AMBIGUOUS','CONFLICT'))
  INTO v_new,v_received,v_matched,v_corrected,v_conflicts FROM jsonb_array_elements(v_rows) r;
 SELECT coalesce(jsonb_agg(jsonb_build_object('line',(r->>'line')::integer,'column','Título / quitação',
  'problem',r->>'problem','correction',CASE WHEN r->>'outcome'='AMBIGUOUS'
   THEN 'Escolha a parcela existente ou confirme uma nova parcela e analise novamente.'
   ELSE 'Confira a divergência na origem ou com o financeiro antes de importar.' END) ORDER BY (r->>'line')::integer),'[]'::jsonb)
  INTO v_errors FROM jsonb_array_elements(v_rows) r WHERE r->>'outcome' IN ('AMBIGUOUS','CONFLICT');
 SELECT id INTO v_previous FROM public.receivable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN jsonb_build_object('mode','received','previous_import_id',v_previous,'financial_revision',cf_private.receivables_sync_revision_value(),
  'row_count',jsonb_array_length(v_rows),'new_count',v_new,'received_count',v_received,'matched_count',v_matched,
  'correction_count',v_corrected,'historical_count',v_new,'conflict_count',v_conflicts,'can_commit',v_conflicts=0,'errors',v_errors,'rows',v_rows);
END $$;

-- Consultas operacionais e guards de escrita; o histórico continua acessível.
-- 047: leitura ativa exclui retirados sem apagar histórico ou criar recebimentos.
-- CREATE OR REPLACE preserva os grants existentes e os filtros de carteira/RLS.

CREATE OR REPLACE FUNCTION public.assign_receivable_collector(p_customer_key text,p_collector_id uuid,p_observation text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  PERFORM cf_private.require_receivable_finance('write');
  IF p_customer_key IS NULL OR length(p_customer_key) NOT BETWEEN 1 AND 1505
     OR length(btrim(coalesce(p_observation,''))) NOT BETWEEN 1 AND 5000
     OR NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=p_collector_id AND enabled) THEN
    RAISE EXCEPTION 'Informe cliente, cobradora ativa e justificativa.' USING ERRCODE='23514';
  END IF;
  -- Não redistribui carteiras existentes. Um cliente ativo tem uma única responsável.
  PERFORM id FROM public.receivable_titles WHERE customer_key=p_customer_key AND status<>'VALIDATED' AND NOT retired_from_report FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente sem dívida ativa para atribuir.' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.receivable_titles WHERE customer_key=p_customer_key AND status<>'VALIDATED' AND NOT retired_from_report
      AND ((collector_id IS NOT NULL AND collector_id<>p_collector_id) OR (collector_id IS NULL AND collector_locked))) THEN
    RAISE EXCEPTION 'Este cliente já possui carteira ou vínculo bloqueado. A responsável foi preservada.' USING ERRCODE='23514';
  END IF;
  UPDATE public.receivable_titles SET collector_id=p_collector_id
    WHERE customer_key=p_customer_key AND status<>'VALIDATED' AND NOT retired_from_report AND collector_id IS NULL AND NOT collector_locked;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    SELECT id,username,role_key,'contas_receber','customer_assignment',p_customer_key,'ASSIGNMENT',
      jsonb_build_object('collector_id',p_collector_id,'assigned_count',v_count,'observation',btrim(p_observation))
    FROM public.profiles WHERE id=auth.uid();
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION cf_private.require_collection_title(p_title public.receivable_titles) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_title.retired_from_report OR p_title.due_date IS NULL
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

CREATE OR REPLACE FUNCTION public.set_receivable_payment_date(p_title_id uuid,p_payment_date date,p_expected_revision bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE; v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  PERFORM cf_private.require_receivable_finance('write');
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='P0002'; END IF;
  IF v_title.retired_from_report THEN
    RAISE EXCEPTION 'Título retirado pelo relatório completo. Importe os títulos quitados para confirmar valor e data do recebimento.' USING ERRCODE='23514';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<>v_title.revision THEN
    RAISE EXCEPTION 'O título mudou. Atualize a tela antes de informar a data.' USING ERRCODE='40001';
  END IF;
  IF v_title.status<>'PENDING_VALIDATION' OR v_title.validation_status<>'PENDING' OR v_title.payment_source IS DISTINCT FROM 'IMPORTACAO_DIARIA'
    OR p_payment_date IS NULL OR p_payment_date<DATE '1900-01-01' OR p_payment_date>v_today THEN
    RAISE EXCEPTION 'Informe uma data real válida para o pagamento pendente da importação.' USING ERRCODE='23514';
  END IF;
  UPDATE public.receivable_titles SET payment_reported_date=p_payment_date WHERE id=p_title_id;
  INSERT INTO public.receivable_collection_events(title_id,collector_id,action,payment_date,created_by)
    VALUES(p_title_id,v_title.collector_id,'PAYMENT_DATE',p_payment_date,auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_receivable_payment(
 p_title_id uuid,p_decision text,p_payment_date date,p_observation text,p_expected_revision bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE; v_id uuid; v_delay integer; v_band text;
 v_case public.collection_cases%ROWTYPE;v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  PERFORM cf_private.require_receivable_finance('validate');
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='P0002'; END IF;
  IF v_title.retired_from_report THEN
    RAISE EXCEPTION 'Título retirado pelo relatório completo. Importe os títulos quitados para confirmar valor e data do recebimento.' USING ERRCODE='23514';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<>v_title.revision THEN
    RAISE EXCEPTION 'O título mudou. Atualize a tela antes de validar.' USING ERRCODE='40001';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('CONFIRM','NOT_LOCATED') OR length(coalesce(p_observation,''))>5000
    OR v_title.status<>'PENDING_VALIDATION' OR v_title.validation_status<>'PENDING'
    OR v_title.payment_source IS NULL THEN
    RAISE EXCEPTION 'O título precisa estar na fila de validação financeira.' USING ERRCODE='23514';
  END IF;
  IF p_decision='CONFIRM' THEN
    IF p_payment_date IS NULL OR p_payment_date<DATE '1900-01-01' OR p_payment_date>v_today THEN
      RAISE EXCEPTION 'Informe a data real do pagamento, até hoje.' USING ERRCODE='23514';
    END IF;
    v_delay:=greatest(0,p_payment_date-v_title.due_date);
    v_band:=CASE WHEN v_delay<=30 THEN 'ATE_30' WHEN v_delay<=60 THEN '31_60' WHEN v_delay<=90 THEN '61_90'
      WHEN v_delay<=180 THEN '91_180' WHEN v_delay<=365 THEN '181_365' ELSE 'ACIMA_365' END;
    INSERT INTO public.receivable_receipts(title_id,amount_cents,payment_date,delay_days,delay_band,collector_id,
      payment_source,reported_in_collection,validated_by)
      VALUES(p_title_id,v_title.amount_cents,p_payment_date,v_delay,v_band,v_title.collector_id,
        v_title.payment_source,v_title.reported_in_collection,auth.uid()) RETURNING id INTO v_id;
    UPDATE public.receivable_titles SET status='VALIDATED',validation_status='VALIDATED',payment_date=p_payment_date,
      next_action=NULL,next_action_date=NULL WHERE id=p_title_id;
  ELSE
    IF v_title.collector_id IS NULL THEN
      RAISE EXCEPTION 'Atribua uma cobradora antes de devolver o título para cobrança.' USING ERRCODE='23514';
    END IF;
    IF length(btrim(coalesce(p_observation,'')))=0 OR p_payment_date IS NOT NULL THEN
      RAISE EXCEPTION 'Informe o motivo e mantenha a data vazia para pagamento não localizado.' USING ERRCODE='23514';
    END IF;
    UPDATE public.receivable_titles SET status='NOT_LOCATED',validation_status='NONE',payment_source=NULL,
      payment_reported_date=NULL,payment_date=NULL,reported_in_collection=false,collector_locked=true,
      last_action='PAYMENT_NOT_LOCATED',next_action='RETRY',next_action_date=v_today WHERE id=p_title_id;
    -- A recusa financeira reabre o mesmo atendimento/carteira e mantém toda
    -- observação anterior nos eventos imutáveis. Não existe recebimento aqui.
    INSERT INTO public.collection_cases(title_id,status,observation,next_action,next_date,payment_date,revision,finalized_at,updated_by)
    VALUES(p_title_id,'NOVO TÍTULO - COBRAR',btrim(p_observation),'Retomar cobrança',v_today,NULL,1,NULL,auth.uid())
    ON CONFLICT(title_id) DO UPDATE SET status=EXCLUDED.status,observation=EXCLUDED.observation,next_action=EXCLUDED.next_action,
      next_date=EXCLUDED.next_date,payment_date=NULL,revision=collection_cases.revision+1,finalized_at=NULL,updated_by=auth.uid(),updated_at=clock_timestamp()
    RETURNING * INTO v_case;
    INSERT INTO public.collection_case_events(title_id,case_revision,status,observation,next_action,next_date,payment_date,finalized,created_by)
    VALUES(p_title_id,v_case.revision,v_case.status,v_case.observation,v_case.next_action,v_today,NULL,false,auth.uid());
  END IF;
  INSERT INTO public.receivable_collection_events(title_id,collector_id,action,next_action,next_date,observation,payment_date,created_by)
    VALUES(p_title_id,v_title.collector_id,CASE WHEN p_decision='CONFIRM' THEN 'VALIDATE' ELSE 'PAYMENT_NOT_LOCATED' END,
      CASE WHEN p_decision='NOT_LOCATED' THEN 'RETRY' ELSE NULL END,CASE WHEN p_decision='NOT_LOCATED' THEN v_today END,nullif(btrim(p_observation),''),p_payment_date,auth.uid());
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    SELECT id,username,role_key,'contas_receber','receivable_validation',p_title_id::text,'VALIDATE',to_jsonb(v_title),
      jsonb_build_object('decision',p_decision,'receipt_id',v_id,'payment_date',p_payment_date,'observation',nullif(btrim(p_observation),''))
    FROM public.profiles WHERE id=auth.uid();
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.receivables_management_summary(p_day date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_day date:=coalesce(p_day,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date);
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_latest public.receivable_imports%ROWTYPE;v_open numeric;v_overdue numeric;v_day_received numeric;v_month_received numeric;v_count bigint;
BEGIN
 IF NOT(cf_private.has_permission('painel','read') OR cf_private.has_permission('contas_receber','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF v_day<DATE '1900-01-01' OR v_day>v_today THEN
  RAISE EXCEPTION 'Informe uma data válida até hoje.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_latest FROM public.receivable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_latest.id IS NOT NULL THEN
  SELECT coalesce(sum(amount_cents),0),coalesce(sum(amount_cents) FILTER(WHERE due_date<v_today),0),count(*)
   INTO v_open,v_overdue,v_count FROM public.receivable_titles WHERE scope='grupo-consolidado' AND status<>'VALIDATED' AND NOT retired_from_report;
  SELECT coalesce(sum(amount_cents) FILTER(WHERE payment_date=v_day),0),coalesce(sum(amount_cents),0)
   INTO v_day_received,v_month_received FROM public.effective_receivable_receipts
   WHERE validation='VALIDADO' AND payment_date>=date_trunc('month',v_day)::date
    AND payment_date<(date_trunc('month',v_day)+interval '1 month')::date;
  IF greatest(v_open,v_overdue,v_count,v_day_received,v_month_received)>9007199254740991 THEN
   RAISE EXCEPTION 'O consolidado excede o limite de precisão.' USING ERRCODE='22003';END IF;
 END IF;
 RETURN jsonb_build_object('as_of_date',v_today,'received_date',v_day,'open_cents',v_open,'overdue_cents',v_overdue,
  'received_day_cents',v_day_received,'received_month_cents',v_month_received,'active_count',v_count,
  'latest_import_at',v_latest.created_at,'latest_import_id',v_latest.id);
END $$;

CREATE OR REPLACE FUNCTION public.receivables_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_open numeric;v_overdue numeric;v_period numeric;v_count bigint;v_pending bigint;v_unassigned bigint;
 v_received numeric;v_latest timestamptz;v_bps numeric;
BEGIN
 IF NOT(cf_private.has_permission('contas_receber','read') OR cf_private.has_permission('painel','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>3660 THEN
  RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';END IF;
 SELECT coalesce(sum(amount_cents),0),
  coalesce(sum(amount_cents) FILTER(WHERE due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date),0),
  coalesce(sum(amount_cents) FILTER(WHERE due_date BETWEEN p_start AND p_end),0),count(*),
  count(*) FILTER(WHERE validation_status='PENDING'),count(*) FILTER(WHERE collector_id IS NULL)
  INTO v_open,v_overdue,v_period,v_count,v_pending,v_unassigned FROM public.receivable_titles WHERE status<>'VALIDATED' AND NOT retired_from_report;
 SELECT coalesce(sum(amount_cents),0) INTO v_received FROM public.effective_receivable_receipts
  WHERE validation='VALIDADO' AND payment_source='IMPORTACAO_DIARIA' AND payment_date BETWEEN p_start AND p_end;
 IF greatest(v_open,v_overdue,v_period,v_count,v_pending,v_unassigned,v_received)>9007199254740991 THEN
  RAISE EXCEPTION 'O consolidado excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT max(created_at) INTO v_latest FROM public.receivable_imports;
 v_bps:=CASE WHEN v_open=0 THEN NULL ELSE round(v_overdue*10000/v_open) END;
 RETURN jsonb_build_object('open_cents',v_open,'overdue_cents',v_overdue,'period_cents',v_period,'active_count',v_count,
  'pending_count',v_pending,'unassigned_count',v_unassigned,'received_period_cents',v_received,
  'latest_import_at',v_latest,'overdue_bps',v_bps,'overdue_comlurb_cents',NULL);
END $$;

DO $cr047_optional$ BEGIN
 IF to_regprocedure('public.collections_overdue_summary()') IS NOT NULL THEN
  EXECUTE $cr047_read_model$
CREATE OR REPLACE FUNCTION public.collections_overdue_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_full_wallet boolean;v_totals jsonb;v_bands jsonb;v_statuses jsonb;v_actions jsonb;v_owners jsonb;
BEGIN
 IF NOT cf_private.has_permission('cobranca','read') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 v_full_wallet:=cf_private.has_permission('contas_receber','read');
 -- A view e as tabelas continuam com a RLS do chamador: cobradora vê apenas
 -- sua carteira vinculada. Nenhum total nasce da página limitada do navegador.
 WITH active AS MATERIALIZED(
  SELECT t.*,(v_today-t.due_date)::integer AS delay_days
  FROM public.collection_overdue_titles t
  WHERE t.scope='grupo-consolidado' AND t.status<>'VALIDATED' AND NOT t.retired_from_report
 ),bands(key,label,min_days,max_days,sort_order) AS(VALUES
  ('1_30','1–30 dias',1,30,1),('31_60','31–60 dias',31,60,2),
  ('61_90','61–90 dias',61,90,3),('91_180','91–180 dias',91,180,4),
  ('181_365','181–365 dias',181,365,5),('ACIMA_365','Acima de 365 dias',366,NULL,6)
 ),statuses(status,sort_order) AS(VALUES('NEW',1),('OPEN',2),('PENDING_VALIDATION',3),('NOT_LOCATED',4)),
 actions(action,sort_order) AS(VALUES('NONE',1),('CONTACT',2),('NO_RESPONSE',3),('PROMISE',4),('RETRY',5),('OTHER',6))
 SELECT jsonb_build_object(
  'overdue_cents',coalesce(sum(amount_cents),0),'overdue_count',count(*),
  'client_count',count(DISTINCT customer_key),
  'average_delay_days',coalesce(round(avg(delay_days),1),0),
  'worked_count',count(*) FILTER(WHERE last_action IS NOT NULL),
  'no_action_count',count(*) FILTER(WHERE last_action IS NULL),
  'pending_validation_count',count(*) FILTER(WHERE status='PENDING_VALIDATION'),
  'pending_validation_cents',coalesce(sum(amount_cents) FILTER(WHERE status='PENDING_VALIDATION'),0),
  'over_180_count',count(*) FILTER(WHERE delay_days>180),
  'returns_today_count',count(*) FILTER(WHERE next_action IS NOT NULL AND next_action_date=v_today),
  'returns_overdue_count',count(*) FILTER(WHERE next_action IS NOT NULL AND next_action_date<v_today),
  'unassigned_count',CASE WHEN v_full_wallet THEN count(*) FILTER(WHERE collector_id IS NULL) END,
  'unassigned_cents',CASE WHEN v_full_wallet THEN coalesce(sum(amount_cents) FILTER(WHERE collector_id IS NULL),0) END),
  (SELECT jsonb_agg(jsonb_build_object('key',b.key,'label',b.label,'min_days',b.min_days,'max_days',b.max_days,
    'title_count',(SELECT count(*) FROM active t WHERE t.delay_days>=b.min_days AND (b.max_days IS NULL OR t.delay_days<=b.max_days)),
    'amount_cents',(SELECT coalesce(sum(t.amount_cents),0) FROM active t WHERE t.delay_days>=b.min_days AND (b.max_days IS NULL OR t.delay_days<=b.max_days))) ORDER BY b.sort_order) FROM bands b),
  (SELECT jsonb_agg(jsonb_build_object('status',s.status,
    'title_count',(SELECT count(*) FROM active t WHERE t.status=s.status),
    'amount_cents',(SELECT coalesce(sum(t.amount_cents),0) FROM active t WHERE t.status=s.status)) ORDER BY s.sort_order) FROM statuses s),
  (SELECT jsonb_agg(jsonb_build_object('action',a.action,
    'title_count',(SELECT count(*) FROM active t WHERE coalesce(t.next_action,'NONE')=a.action),
    'amount_cents',(SELECT coalesce(sum(t.amount_cents),0) FROM active t WHERE coalesce(t.next_action,'NONE')=a.action)) ORDER BY a.sort_order) FROM actions a),
  (SELECT coalesce(jsonb_agg(jsonb_build_object('collector_id',o.collector_id,'display_name',o.display_name,
    'title_count',o.title_count,'amount_cents',o.amount_cents) ORDER BY o.collector_id NULLS LAST),'[]'::jsonb)
   FROM(SELECT t.collector_id,
    CASE WHEN t.collector_id IS NULL THEN 'Sem cobradora definida' ELSE coalesce(max(a.display_name),'Cobradora atribuída') END AS display_name,
    count(*) AS title_count,sum(t.amount_cents) AS amount_cents
    FROM active t LEFT JOIN public.collection_agents a ON a.id=t.collector_id GROUP BY t.collector_id)o)
 INTO v_totals,v_bands,v_statuses,v_actions,v_owners FROM active;

 -- Recusar perda de precisão em centavos e contagens; jamais arredondar dinheiro.
 IF EXISTS(SELECT 1 FROM jsonb_each(v_totals) e
    WHERE e.value<>'null'::jsonb AND abs((e.value#>>'{}')::numeric)>9007199254740991)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_bands||v_statuses||v_actions||v_owners) a
   CROSS JOIN LATERAL jsonb_each(a) e WHERE e.key IN('amount_cents','title_count')
    AND abs((e.value#>>'{}')::numeric)>9007199254740991) THEN
  RAISE EXCEPTION 'O resumo excede o limite de precisão. Solicite a conferência da base.' USING ERRCODE='22003';
 END IF;
 RETURN jsonb_build_object('as_of_date',v_today,'by_delay_bands',v_bands,'by_status',v_statuses,
  'by_next_action',v_actions,'by_collector',v_owners)||v_totals;
END $$;
$cr047_read_model$;
 END IF;
END $cr047_optional$;

CREATE OR REPLACE FUNCTION cf_private.collection_context_customer_visible(p_customer_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND p.role_key IN ('gerente_geral','diretor','contas_receber','cobradora_1','cobradora_2'))
 AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.customer_key=p_customer_key AND t.status<>'VALIDATED' AND NOT t.retired_from_report AND cf_private.collection_workbench_visible(t));
$$;

CREATE OR REPLACE FUNCTION cf_private.collection_context_reference_visible(p_context_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND p.role_key IN ('gerente_geral','diretor','contas_receber','cobradora_1','cobradora_2'))
 AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.status<>'VALIDATED' AND NOT t.retired_from_report AND cf_private.collection_workbench_visible(t)
  AND cf_private.collection_reference_key(t.branch,t.document,t.customer_key)=p_context_key);
$$;

CREATE OR REPLACE FUNCTION public.collection_customer_contact_report(p_search text DEFAULT '',p_collector_id uuid DEFAULT NULL,p_coverage text DEFAULT 'ALL',
 p_changed_start date DEFAULT NULL,p_changed_end date DEFAULT NULL,p_changed_by uuid DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,
 p_view text DEFAULT 'coverage',p_expected_revision text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_revision text;v_count bigint;v_scope bigint;v_with bigint;v_reviewed bigint;v_rows jsonb;BEGIN
 PERFORM cf_private.require_collection_workbench_read();
 IF p_search IS NULL OR length(p_search)>1500 OR p_coverage IS NULL OR p_coverage NOT IN ('ALL','WITH_CONTACT','MISSING_CONTACT','MISSING_EMAIL','MISSING_PHONE','REVIEWED','NOT_REVIEWED')
  OR p_view IS NULL OR p_view NOT IN ('coverage','changes') OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
  OR (p_changed_start IS NOT NULL AND p_changed_end IS NOT NULL AND p_changed_start>p_changed_end) THEN RAISE EXCEPTION 'Filtros de contatos inválidos.' USING ERRCODE='22023';END IF;
 SELECT revision::text INTO v_revision FROM cf_private.collection_context_state WHERE singleton;
 IF p_expected_revision IS NOT NULL AND p_expected_revision<>v_revision THEN RAISE EXCEPTION 'A carteira ou os contatos mudaram. Atualize o relatório.' USING ERRCODE='40001';END IF;
 WITH wallets AS MATERIALIZED(
  SELECT t.customer_key,min(t.client_name) AS client_name,min(t.client_document) AS client_document,count(*) AS title_count,sum(t.amount_cents) AS overdue_cents,
   array_agg(DISTINCT t.collector_id) FILTER(WHERE t.collector_id IS NOT NULL) AS collector_ids
  FROM public.receivable_titles t WHERE t.status<>'VALIDATED' AND NOT t.retired_from_report AND cf_private.collection_workbench_visible(t)
   AND (p_collector_id IS NULL OR t.collector_id=p_collector_id)
   AND (p_search='' OR position(lower(btrim(p_search)) IN lower(t.client_name||' '||coalesce(t.client_document,'')))>0) GROUP BY t.customer_key
 ),cards AS MATERIALIZED(
  SELECT w.*,coalesce(c.emails,'[]'::jsonb) AS emails,coalesce(c.phones,'[]'::jsonb) AS phones,c.notes,coalesce(c.revision,0) AS record_revision,
   coalesce(c.manually_edited,false) AS manually_edited,c.reviewed_at,c.reviewed_by,r.display_name AS reviewed_by_name,c.updated_at,c.updated_by,u.display_name AS updated_by_name
  FROM wallets w LEFT JOIN public.collection_customer_contacts c USING(customer_key) LEFT JOIN public.profiles r ON r.id=c.reviewed_by LEFT JOIN public.profiles u ON u.id=c.updated_by
 ),filtered AS MATERIALIZED(
  SELECT c.* FROM cards c WHERE
   (p_coverage='ALL' OR p_coverage='WITH_CONTACT' AND (jsonb_array_length(c.emails)>0 OR jsonb_array_length(c.phones)>0)
    OR p_coverage='MISSING_CONTACT' AND jsonb_array_length(c.emails)=0 AND jsonb_array_length(c.phones)=0
    OR p_coverage='MISSING_EMAIL' AND jsonb_array_length(c.emails)=0 OR p_coverage='MISSING_PHONE' AND jsonb_array_length(c.phones)=0
    OR p_coverage='REVIEWED' AND c.reviewed_at IS NOT NULL OR p_coverage='NOT_REVIEWED' AND c.reviewed_at IS NULL)
   AND (p_changed_start IS NULL OR (c.updated_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_changed_start)
   AND (p_changed_end IS NULL OR (c.updated_at AT TIME ZONE 'America/Sao_Paulo')::date<=p_changed_end) AND (p_changed_by IS NULL OR c.updated_by=p_changed_by)
 ),changes AS MATERIALIZED(
  SELECT e.id AS event_id,e.customer_key,w.client_name,w.client_document,e.created_at,e.created_by,p.display_name AS created_by_name,
   e.before_value AS before,e.after_value AS after,e.action
  FROM public.collection_contact_events e JOIN wallets w USING(customer_key) LEFT JOIN public.profiles p ON p.id=e.created_by
  WHERE (p_changed_start IS NULL OR (e.created_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_changed_start)
   AND (p_changed_end IS NULL OR (e.created_at AT TIME ZONE 'America/Sao_Paulo')::date<=p_changed_end) AND (p_changed_by IS NULL OR e.created_by=p_changed_by)
 ) SELECT (SELECT count(*) FROM cards),(SELECT count(*) FROM cards WHERE jsonb_array_length(emails)>0 OR jsonb_array_length(phones)>0),
  (SELECT count(*) FROM cards WHERE reviewed_at IS NOT NULL),CASE WHEN p_view='coverage' THEN (SELECT count(*) FROM filtered) ELSE (SELECT count(*) FROM changes) END,
  CASE WHEN p_view='coverage' THEN (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY lower(client_name),customer_key),'[]'::jsonb) FROM
   (SELECT * FROM filtered ORDER BY lower(client_name),customer_key OFFSET p_offset LIMIT p_limit)r)
  ELSE (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY created_at DESC,event_id DESC),'[]'::jsonb) FROM
   (SELECT * FROM changes ORDER BY created_at DESC,event_id DESC OFFSET p_offset LIMIT p_limit)r) END
 INTO v_scope,v_with,v_reviewed,v_count,v_rows;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE abs(coalesce((r->>'overdue_cents')::numeric,0))>9007199254740991) THEN RAISE EXCEPTION 'O total excede o limite de precisão.' USING ERRCODE='22003';END IF;
 RETURN jsonb_build_object('as_of_date',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'server_now',statement_timestamp(),
  'snapshot_revision',v_revision,'count',v_count,'scope_count',v_scope,'with_contact_count',v_with,'reviewed_count',v_reviewed,'rows',v_rows);
END $$;

CREATE OR REPLACE FUNCTION public.collection_customer_context(p_title_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE;v_contact public.collection_customer_contacts%ROWTYPE;v_contact_json jsonb;
 v_variants jsonb;v_count integer;v_reviewed_name text;v_updated_name text;v_write boolean;BEGIN
 v_title:=cf_private.collection_workbench_title(p_title_id);
 IF v_title.retired_from_report OR v_title.status='VALIDATED' THEN RAISE EXCEPTION 'Referências disponíveis somente para títulos ativos na Cobrança.' USING ERRCODE='42501';END IF;
 SELECT * INTO v_contact FROM public.collection_customer_contacts WHERE customer_key=v_title.customer_key;
 SELECT display_name INTO v_reviewed_name FROM public.profiles WHERE id=v_contact.reviewed_by;
 SELECT display_name INTO v_updated_name FROM public.profiles WHERE id=v_contact.updated_by;
 v_contact_json:=jsonb_build_object('emails',coalesce(v_contact.emails,'[]'::jsonb),'phones',coalesce(v_contact.phones,'[]'::jsonb),'notes',v_contact.notes,
  'revision',cf_private.collection_contact_token(v_title.customer_key,coalesce(v_contact.revision,0)),'record_revision',coalesce(v_contact.revision,0),
  'manually_edited',coalesce(v_contact.manually_edited,false),'reviewed_at',v_contact.reviewed_at,'reviewed_by',v_contact.reviewed_by,
  'reviewed_by_name',v_reviewed_name,'updated_at',v_contact.updated_at,'updated_by',v_contact.updated_by,'updated_by_name',v_updated_name);
 SELECT count(*) INTO v_count FROM public.collection_description_references WHERE context_key=cf_private.collection_reference_key(v_title.branch,v_title.document,v_title.customer_key);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'description',r.description,'contract',r.contract,'source_import_id',r.source_job_id,
  'imported_at',r.imported_at) ORDER BY r.imported_at,r.id),'[]'::jsonb) INTO v_variants FROM(
  SELECT * FROM public.collection_description_references WHERE context_key=cf_private.collection_reference_key(v_title.branch,v_title.document,v_title.customer_key)
   ORDER BY imported_at,id LIMIT 100)r;
 v_write:=cf_private.has_permission('cobranca','write') AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role_key IN ('gerente_geral','contas_receber','cobradora_1','cobradora_2'));
 RETURN jsonb_build_object('title_id',p_title_id,'customer_key',v_title.customer_key,'client_name',v_title.client_name,'client_document',v_title.client_document,
  'contact',v_contact_json,'descriptions',jsonb_build_object('state',CASE WHEN v_count=0 THEN 'MISSING' WHEN v_count=1 THEN 'AVAILABLE' ELSE 'PENDING_VARIANTS' END,
   'count',v_count,'variants',v_variants,'truncated',v_count>100),'can_edit',v_write,'can_review',v_write,
  'as_of_date',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'server_now',statement_timestamp());
END $$;

CREATE OR REPLACE FUNCTION cf_private.analyze_collection_reference_job(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;BEGIN
 SELECT * INTO v_job FROM cf_private.collection_reference_jobs WHERE id=p_job_id;
 WITH titles AS MATERIALIZED(
  SELECT t.customer_key,t.status,t.retired_from_report,cf_private.collection_reference_key(t.branch,t.document,t.customer_key) AS context_key,
   cf_private.receivable_customer_key(t.client_name,NULL) AS name_key,t.client_document,
   cf_private.collection_reference_key(t.branch,t.document,cf_private.receivable_customer_key(t.client_name,NULL)) AS name_context
  FROM public.receivable_titles t WHERE t.scope='grupo-consolidado'
 ),customers AS MATERIALIZED(
  SELECT customer_key,count(*) FILTER(WHERE status<>'VALIDATED' AND NOT retired_from_report)::integer AS active_count,count(*) FILTER(WHERE status='VALIDATED') AS paid_count FROM titles GROUP BY customer_key
 ),contexts AS MATERIALIZED(
  SELECT context_key,count(*) FILTER(WHERE status<>'VALIDATED' AND NOT retired_from_report)::integer AS active_count,count(*) FILTER(WHERE status='VALIDATED') AS paid_count FROM titles GROUP BY context_key
 ),names AS MATERIALIZED(SELECT name_key,count(*) AS count FROM titles WHERE client_document IS NOT NULL GROUP BY name_key),
 name_contexts AS MATERIALIZED(SELECT name_context,count(*) AS count FROM titles WHERE client_document IS NOT NULL GROUP BY name_context),
 classified AS MATERIALIZED(
  SELECT r.row_hash,r.customer_key,CASE WHEN r.invalid THEN 'INVALID'
   WHEN v_job.mode='CONTACTS' THEN CASE
    WHEN r.canonical->>'client_document' IS NULL AND coalesce(n.count,0)>0 THEN 'AMBIGUOUS'
    WHEN coalesce(c.active_count,0)+coalesce(c.paid_count,0)>0 THEN CASE WHEN card.manually_edited THEN 'MANUAL_PRESERVED' ELSE 'MATCHED' END
    WHEN r.customer_key LIKE 'name:%' THEN CASE WHEN card.manually_edited THEN 'MANUAL_PRESERVED' ELSE 'MATCHED' END
    ELSE 'UNMATCHED' END
   WHEN coalesce(k.active_count,0)>0 THEN 'MATCHED'
   WHEN coalesce(k.paid_count,0)>0 THEN 'PAID_ONLY'
   WHEN r.canonical->>'client_document' IS NULL AND coalesce(nk.count,0)>0 THEN 'AMBIGUOUS'
   ELSE 'UNMATCHED' END AS outcome,
   CASE WHEN v_job.mode='CONTACTS' THEN coalesce(c.active_count,0) ELSE coalesce(k.active_count,0) END AS title_count
  FROM cf_private.collection_reference_rows r LEFT JOIN customers c USING(customer_key) LEFT JOIN contexts k USING(context_key)
   LEFT JOIN public.collection_customer_contacts card USING(customer_key)
   LEFT JOIN names n ON n.name_key=cf_private.receivable_customer_key(r.canonical->>'client_name',NULL)
   LEFT JOIN name_contexts nk ON nk.name_context=cf_private.collection_reference_key(r.canonical->>'branch',r.canonical->>'document',cf_private.receivable_customer_key(r.canonical->>'client_name',NULL))
  WHERE r.job_id=p_job_id
 ),clients AS MATERIALIZED(SELECT DISTINCT customer_key FROM classified WHERE v_job.mode='CONTACTS' AND outcome='MATCHED'),
 methods AS(
  SELECT r.customer_key,'email' AS kind,e#>>'{}' AS value FROM cf_private.collection_reference_rows r JOIN clients c USING(customer_key)
   JOIN classified s ON s.row_hash=r.row_hash AND s.outcome='MATCHED'
   CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'emails')e WHERE r.job_id=p_job_id
  UNION SELECT r.customer_key,'phone',p#>>'{}' FROM cf_private.collection_reference_rows r JOIN clients c USING(customer_key)
   JOIN classified s ON s.row_hash=r.row_hash AND s.outcome='MATCHED'
   CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'phones')p WHERE r.job_id=p_job_id
  UNION SELECT c.customer_key,'email',e#>>'{}' FROM public.collection_customer_contacts c JOIN clients s USING(customer_key) CROSS JOIN LATERAL jsonb_array_elements(c.emails)e
  UNION SELECT c.customer_key,'phone',p#>>'{}' FROM public.collection_customer_contacts c JOIN clients s USING(customer_key) CROSS JOIN LATERAL jsonb_array_elements(c.phones)p
 ),overflow AS MATERIALIZED(SELECT DISTINCT customer_key FROM methods GROUP BY customer_key,kind HAVING count(DISTINCT value)>50),
 resolved AS(
  SELECT c.row_hash,c.title_count,CASE WHEN o.customer_key IS NOT NULL THEN 'INVALID' ELSE c.outcome END AS outcome,
   CASE WHEN o.customer_key IS NOT NULL THEN 'LIMIT_METHODS: o cliente excederia 50 e-mails ou telefones; nenhum canal foi truncado.' END AS problem
  FROM classified c LEFT JOIN overflow o USING(customer_key)
 ) UPDATE cf_private.collection_reference_rows r SET outcome=c.outcome,analysis_problem=c.problem,matched_title_count=c.title_count
  FROM resolved c WHERE r.job_id=p_job_id AND r.row_hash=c.row_hash
   AND ROW(r.outcome,r.matched_title_count,r.analysis_problem) IS DISTINCT FROM ROW(c.outcome,c.title_count,c.problem);
 UPDATE cf_private.collection_reference_jobs SET analysis_financial_revision=cf_private.receivables_sync_revision_value(),analysis_at=clock_timestamp() WHERE id=p_job_id;
END $$;

CREATE OR REPLACE FUNCTION public.preview_collection_reference_import_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_result jsonb;v_variants integer:=0;v_warnings integer;v_examples jsonb;v_context_revision text;v_matched_titles bigint;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF NOT v_job.original_verified OR v_job.manifest_sha256 IS NULL OR v_job.status NOT IN ('PREPARED','PUBLISHING','PUBLISHED') THEN
  RAISE EXCEPTION 'Conclua a preparação verificada antes da análise.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.analyze_collection_reference_job(p_job_id);
 SELECT jsonb_build_object('row_count',count(*),'deduplicated_count',v_job.staged_input_rows-count(*),
  'eligible_count',count(*) FILTER(WHERE outcome='MATCHED' AND NOT applied),'matched_title_count',coalesce(sum(matched_title_count),0),
  'unmatched_count',count(*) FILTER(WHERE outcome='UNMATCHED'),'paid_only_count',count(*) FILTER(WHERE outcome='PAID_ONLY'),
  'ambiguous_count',count(*) FILTER(WHERE outcome='AMBIGUOUS'),'invalid_count',count(*) FILTER(WHERE outcome='INVALID'),
  'manual_preserved_count',count(*) FILTER(WHERE outcome='MANUAL_PRESERVED'),
  'quarantine_count',count(*) FILTER(WHERE outcome IN ('UNMATCHED','PAID_ONLY','AMBIGUOUS','INVALID')),
  'processed_rows',count(*) FILTER(WHERE applied),'published_rows',count(*) FILTER(WHERE applied),'remaining_rows',count(*) FILTER(WHERE outcome='MATCHED' AND NOT applied)) INTO v_result
 FROM cf_private.collection_reference_rows WHERE job_id=p_job_id;
 WITH active_titles AS MATERIALIZED(SELECT id,customer_key,cf_private.collection_reference_key(branch,document,customer_key) AS context_key
  FROM public.receivable_titles WHERE scope='grupo-consolidado' AND status<>'VALIDATED' AND NOT retired_from_report),
 matched_keys AS MATERIALIZED(SELECT DISTINCT CASE WHEN v_job.mode='CONTACTS' THEN customer_key ELSE context_key END AS key
  FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome IN ('MATCHED','MANUAL_PRESERVED'))
 SELECT count(DISTINCT t.id) INTO v_matched_titles FROM active_titles t JOIN matched_keys r
  ON r.key=CASE WHEN v_job.mode='CONTACTS' THEN t.customer_key ELSE t.context_key END;
 v_result:=v_result||jsonb_build_object('matched_title_count',v_matched_titles);
 IF v_job.mode='DESCRIPTIONS' THEN
  WITH incoming AS MATERIALIZED(SELECT DISTINCT context_key,encode(sha256(convert_to(jsonb_build_array(canonical->>'description',canonical->>'contract')::text,'UTF8')),'hex') AS hash
   FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome='MATCHED'),
  variants AS(SELECT context_key,hash FROM incoming UNION SELECT r.context_key,r.content_sha256 FROM public.collection_description_references r
   WHERE EXISTS(SELECT 1 FROM incoming i WHERE i.context_key=r.context_key))
  SELECT count(*) INTO v_variants FROM(SELECT context_key FROM variants GROUP BY context_key HAVING count(*)>1)x;
 END IF;
 SELECT count(*) INTO v_warnings FROM cf_private.collection_reference_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.problems)p
  WHERE c.job_id=p_job_id AND coalesce(p->>'code','') LIKE 'WARN\_%' ESCAPE '\';
 SELECT coalesce(jsonb_agg(jsonb_build_object('source_line',r.source_line,'outcome',r.outcome,'client_name',r.canonical->>'client_name',
  'document',r.canonical->>'document','branch',r.canonical->>'branch','problem',coalesce(r.analysis_problem,CASE r.outcome WHEN 'UNMATCHED' THEN 'Sem título ativo correspondente.'
   WHEN 'PAID_ONLY' THEN 'Somente títulos validados: referência mantida fora da exibição.' WHEN 'AMBIGUOUS' THEN 'Nome sem CNPJ não confirma o vínculo com este cadastro.'
   WHEN 'INVALID' THEN 'Linha com informação inválida ou incompleta; consulte a fonte privada.' WHEN 'MANUAL_PRESERVED' THEN 'Ficha já editada manualmente; preservada integralmente.' END))
  ORDER BY r.source_line,r.row_hash),'[]'::jsonb) INTO v_examples FROM(
   SELECT * FROM cf_private.collection_reference_rows WHERE job_id=p_job_id ORDER BY CASE WHEN outcome<>'MATCHED' THEN 0 ELSE 1 END,source_line,row_hash LIMIT 100)r;
 SELECT revision::text INTO v_context_revision FROM cf_private.collection_context_state WHERE singleton;
 RETURN v_result||jsonb_build_object('job_id',p_job_id,'mode',v_job.mode,'status',v_job.status,'financial_revision',cf_private.receivables_sync_revision_value(),
  'context_revision',v_context_revision,'manifest_sha256',v_job.manifest_sha256,'source',jsonb_build_object('name',v_job.source_name,'size',v_job.source_size,'sha256',v_job.source_sha256,'verified',true),
  'warning_count',v_warnings,'variant_count',v_variants,'can_publish',true,'requires_quarantine_confirmation',(v_result->>'quarantine_count')::integer>0,'examples',v_examples);
END $$;

CREATE OR REPLACE FUNCTION cf_private.collection_workflow_collectible(p_title public.receivable_titles) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT p_title.retired_from_report AND p_title.status IN ('NEW','OPEN','NOT_LOCATED') AND p_title.due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
  AND EXISTS(SELECT 1 FROM public.collection_agents WHERE id=p_title.collector_id AND enabled)
  AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=p_title.id);
$$;

CREATE OR REPLACE FUNCTION cf_private.collection_workbench_row(p_title public.receivable_titles,p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_case public.collection_cases%ROWTYPE;v_timer jsonb;v_name text;v_old_observation text;v_return boolean;v_reason text;BEGIN
 SELECT * INTO v_case FROM public.collection_cases WHERE title_id=p_title.id;
 SELECT display_name INTO v_name FROM public.collection_agents WHERE id=p_title.collector_id;
 v_timer:=cf_private.collection_workbench_timer(p_title.id,p_now);
 v_return:=coalesce(cf_private.collection_workflow_collectible(p_title) AND p_title.next_action_date<=(p_now AT TIME ZONE 'America/Sao_Paulo')::date,false);
 v_reason:=CASE WHEN NOT cf_private.collection_workflow_write_allowed() THEN 'READ_ONLY'
  WHEN p_title.retired_from_report THEN 'REPORT_RETIRED'
  WHEN p_title.status='PENDING_VALIDATION' THEN 'PENDING_VALIDATION'
  WHEN p_title.status='VALIDATED' OR EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=p_title.id) THEN 'SETTLED'
  WHEN p_title.collector_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=p_title.collector_id AND enabled) THEN 'UNASSIGNED'
  WHEN EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL AND title_id<>p_title.id) THEN 'ALREADY_RUNNING'
  WHEN NOT v_return AND NOT EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL AND title_id=p_title.id)
   AND (cf_private.collection_workflow_priority(p_title.collector_id)->>'due_count')::bigint>0 THEN 'RETURN_PRIORITY'
  ELSE NULL END;
 SELECT observation INTO v_old_observation FROM public.receivable_collection_events WHERE title_id=p_title.id AND observation IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN to_jsonb(p_title)||jsonb_build_object('operational_status',coalesce(v_case.status,cf_private.collection_workbench_legacy_status(p_title.last_action)),
  'operational_label',CASE WHEN v_case.title_id IS NULL AND p_title.last_action IS NOT NULL AND p_title.last_action NOT IN ('PAID','NO_RESPONSE','PROMISE') THEN 'Sem status operacional' ELSE coalesce(v_case.status,cf_private.collection_workbench_legacy_status(p_title.last_action)) END,
  'legacy_worked',v_case.title_id IS NULL AND p_title.last_action IS NOT NULL,'case_revision',coalesce(v_case.revision,0),
  'observation',CASE WHEN v_case.title_id IS NULL THEN v_old_observation ELSE v_case.observation END,'next_action_text',v_case.next_action,
  'next_date',CASE WHEN v_case.title_id IS NULL THEN p_title.next_action_date ELSE v_case.next_date END,'delay_days',(p_now AT TIME ZONE 'America/Sao_Paulo')::date-p_title.due_date,
  'collector_name',v_name,'total_work_seconds',v_timer->'total_seconds','current_timer',v_timer,
  'return_due',v_return,'return_due_date',CASE WHEN v_return THEN p_title.next_action_date END,'can_start',v_reason IS NULL,'start_block_reason',v_reason);
END $$;

CREATE OR REPLACE FUNCTION public.collection_workbench(p_search text DEFAULT '',p_collector_id uuid DEFAULT NULL,p_unassigned boolean DEFAULT false,
 p_band text DEFAULT NULL,p_sort text DEFAULT 'delay_desc',p_status text DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,
 p_queue text DEFAULT 'active',p_due_start date DEFAULT NULL,p_due_end date DEFAULT NULL,p_next_action text DEFAULT NULL,p_financial_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;v_now timestamptz:=statement_timestamp();
 v_count bigint;v_total numeric;v_rows jsonb;v_revision text;v_active_id uuid;v_active_timer jsonb;BEGIN
 PERFORM cf_private.require_collection_workbench_read();
 IF p_search IS NULL OR length(p_search)>1500 OR p_unassigned IS NULL OR p_sort IS NULL
  OR p_sort NOT IN ('delay_desc','delay_asc','due_asc','due_desc','amount_desc','amount_asc','client_asc','next_date_asc')
  OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
  OR p_queue IS NULL OR p_queue NOT IN ('active','history','all','returns')
  OR (p_band IS NOT NULL AND p_band NOT IN ('1_30','31_60','61_90','91_180','181_365','ACIMA_365'))
  OR (p_status IS NOT NULL AND p_status NOT IN ('NOVO TÍTULO - COBRAR','SEM SUCESSO','AGUARDANDO RETORNO','COBRANCA VIA EMAIL','COBRANCA POR WHATSAPP',
   'AGUARDANDO LIQUIDACAO','SEM PRAZO','SEM PREVISAO DE PG','PAGAMENTO PROGRAMADO','TÍTULO PAGO'))
  OR (p_financial_status IS NOT NULL AND p_financial_status NOT IN ('ACTIVE','NEW','OPEN','PENDING_VALIDATION','NOT_LOCATED','VALIDATED','RETIRED_FROM_REPORT'))
  OR (p_next_action IS NOT NULL AND p_next_action NOT IN ('NONE','CONTACT','NO_RESPONSE','PROMISE','RETRY','OTHER'))
  OR (p_due_start IS NOT NULL AND p_due_end IS NOT NULL AND p_due_start>p_due_end) OR (p_unassigned AND p_collector_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Filtros de cobrança inválidos.' USING ERRCODE='22023';END IF;
 WITH filtered AS MATERIALIZED(
  SELECT t.*,coalesce(c.status,cf_private.collection_workbench_legacy_status(t.last_action)) AS case_status,coalesce(c.next_date,t.next_action_date) AS case_next_date
  FROM public.receivable_titles t LEFT JOIN public.collection_cases c ON c.title_id=t.id
  WHERE cf_private.collection_workbench_visible(t) AND t.scope='grupo-consolidado'
   AND (p_queue='all' OR (p_queue='active' AND NOT t.retired_from_report AND t.status IN ('NEW','OPEN','NOT_LOCATED') AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.title_id=t.id))
    OR (p_queue='returns' AND cf_private.collection_workflow_collectible(t) AND t.next_action_date<=v_today) OR (p_queue='history' AND (t.status='VALIDATED' OR t.retired_from_report)))
   AND (p_collector_id IS NULL OR t.collector_id=p_collector_id) AND (NOT p_unassigned OR t.collector_id IS NULL)
   AND (p_due_start IS NULL OR t.due_date>=p_due_start) AND (p_due_end IS NULL OR t.due_date<=p_due_end)
   AND (p_status IS NULL OR coalesce(c.status,cf_private.collection_workbench_legacy_status(t.last_action))=p_status)
   AND (p_financial_status IS NULL OR t.status=p_financial_status OR (p_financial_status='ACTIVE' AND t.status<>'VALIDATED' AND NOT t.retired_from_report)
    OR (p_financial_status='RETIRED_FROM_REPORT' AND t.retired_from_report))
   AND (p_next_action IS NULL OR coalesce(t.next_action,'NONE')=p_next_action)
   AND (p_search='' OR position(lower(btrim(p_search)) IN lower(t.document||' '||t.client_name||' '||coalesce(t.client_document,'')||' '||t.branch||' '||
    coalesce(c.status,cf_private.collection_workbench_legacy_status(t.last_action))||' '||coalesce(c.observation,'')))>0
    OR (c.title_id IS NULL AND EXISTS(SELECT 1 FROM public.receivable_collection_events e WHERE e.title_id=t.id
     AND position(lower(btrim(p_search)) IN lower(coalesce(e.observation,'')))>0)))
   AND (p_band IS NULL OR CASE p_band WHEN '1_30' THEN v_today-t.due_date BETWEEN 1 AND 30 WHEN '31_60' THEN v_today-t.due_date BETWEEN 31 AND 60
    WHEN '61_90' THEN v_today-t.due_date BETWEEN 61 AND 90 WHEN '91_180' THEN v_today-t.due_date BETWEEN 91 AND 180
    WHEN '181_365' THEN v_today-t.due_date BETWEEN 181 AND 365 ELSE v_today-t.due_date>365 END)
 ),page AS(
  SELECT f.id,row_number() OVER(ORDER BY
   CASE WHEN p_queue='returns' THEN f.next_action_date END ASC,CASE WHEN p_queue='returns' THEN f.due_date END ASC,CASE WHEN p_queue='returns' THEN f.id END ASC,
   CASE WHEN p_sort IN ('delay_desc','due_asc') THEN f.due_date END ASC,
   CASE WHEN p_sort IN ('delay_asc','due_desc') THEN f.due_date END DESC,
   CASE WHEN p_sort='amount_desc' THEN f.amount_cents END DESC,CASE WHEN p_sort='amount_asc' THEN f.amount_cents END ASC,
   CASE WHEN p_sort='client_asc' THEN lower(f.client_name) END ASC,
   CASE WHEN p_sort='next_date_asc' THEN f.case_next_date END ASC NULLS LAST,f.id ASC) AS ord FROM filtered f ORDER BY ord OFFSET p_offset LIMIT p_limit
 ) SELECT (SELECT count(*) FROM filtered),(SELECT coalesce(sum(amount_cents),0) FROM filtered),
  coalesce((SELECT jsonb_agg(cf_private.collection_workbench_row(t,v_now) ORDER BY ord) FROM
   (SELECT p.id,p.ord FROM page p)x JOIN public.receivable_titles t ON t.id=x.id),'[]'::jsonb)
 INTO v_count,v_total,v_rows;
 IF v_total>9007199254740991 OR v_count>9007199254740991 THEN RAISE EXCEPTION 'O total excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT revision::text INTO v_revision FROM cf_private.collection_workbench_state WHERE singleton;
 -- Recuperação após recarregar: o intervalo pertence ao ator, mesmo quando o
 -- título saiu do filtro, foi reagendado ou deixou sua carteira. Somente IDs e
 -- tempo do próprio ator são retornados; não expõe fatos do título oculto.
 SELECT title_id INTO v_active_id FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL;
 IF v_active_id IS NOT NULL THEN
  v_active_timer:=cf_private.collection_workbench_timer(v_active_id,v_now);
  v_active_timer:=v_active_timer||jsonb_build_object('total_seconds',v_active_timer->'actor_total_seconds');
 END IF;
 RETURN jsonb_build_object('as_of_date',v_today,'server_now',v_now,'snapshot_revision',v_revision,'count',v_count,'total_cents',v_total,'rows',v_rows,'active_timer',v_active_timer,
  'workflow',cf_private.collection_workflow_metadata(),'priority',cf_private.collection_workflow_priority(p_collector_id));
END $$;

CREATE OR REPLACE FUNCTION public.collection_case_detail(p_title_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE;v_case jsonb;v_history jsonb;v_report_history jsonb;v_sessions jsonb;v_events jsonb;v_old_observation text;v_now timestamptz:=statement_timestamp();BEGIN
 v_title:=cf_private.collection_workbench_title(p_title_id);
 SELECT to_jsonb(c)-'title_id' INTO v_case FROM public.collection_cases c WHERE title_id=p_title_id;
 IF v_case IS NULL THEN
  SELECT observation INTO v_old_observation FROM public.receivable_collection_events WHERE title_id=p_title_id AND observation IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1;
  v_case:=jsonb_build_object('status',cf_private.collection_workbench_legacy_status(v_title.last_action),
  'observation',v_old_observation,'next_action',CASE v_title.next_action WHEN 'CONTACT' THEN 'Contato' WHEN 'NO_RESPONSE' THEN 'Sem resposta'
   WHEN 'PROMISE' THEN 'Acompanhar promessa' WHEN 'RETRY' THEN 'Nova tentativa' END,
  'next_date',v_title.next_action_date,'payment_date',v_title.payment_reported_date,'revision',0,'finalized_at',NULL,'updated_at',NULL,'updated_by',NULL);END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO v_history
  FROM(SELECT * FROM public.receivable_collection_events WHERE title_id=p_title_id ORDER BY created_at DESC,id DESC LIMIT 100)e;
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO v_events
  FROM(SELECT * FROM public.collection_case_events WHERE title_id=p_title_id ORDER BY created_at DESC,id DESC LIMIT 100)e;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY started_at DESC,id DESC),'[]'::jsonb) INTO v_sessions
  FROM(SELECT * FROM public.collection_work_sessions WHERE title_id=p_title_id AND
   ((cf_private.has_permission('contas_receber','read') AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role_key IN ('gerente_geral','diretor','contas_receber')))
    OR (actor_id=auth.uid() AND collector_id=cf_private.current_collector_id())) ORDER BY started_at DESC,id DESC LIMIT 50)s;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'worked',e.worked,'reference_date',e.reference_date,'created_at',e.created_at) ORDER BY e.event_sequence DESC),'[]'::jsonb) INTO v_report_history
  FROM(SELECT id,action,worked,reference_date,created_at,event_sequence FROM public.receivable_report_retirement_events WHERE title_id=p_title_id ORDER BY event_sequence DESC LIMIT 100)e;
 RETURN jsonb_build_object('title',cf_private.collection_workbench_row(v_title,v_now),'case',v_case,'timer',cf_private.collection_workbench_timer(p_title_id,v_now),
  'history',v_history,'report_history',v_report_history,'case_history',v_events,'work_sessions',v_sessions,
  'workflow',cf_private.collection_workflow_metadata(p_title_id),'priority',cf_private.collection_workflow_priority(v_title.collector_id));
END $$;

DO $cr047_optional$ BEGIN
 IF to_regprocedure('public.prepare_collection_customer_email(uuid)') IS NOT NULL THEN
  EXECUTE $cr047_read_model$
CREATE OR REPLACE FUNCTION public.prepare_collection_customer_email(p_finish_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_request public.collection_work_requests%ROWTYPE;
 v_anchor public.receivable_titles%ROWTYPE;
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_emails jsonb:='[]'::jsonb;v_rows jsonb;v_email text;
 v_count bigint;v_overdue_count bigint;v_upcoming_count bigint;
 v_total numeric;v_overdue numeric;v_upcoming numeric;v_absolute numeric;v_result jsonb;
BEGIN
 PERFORM cf_private.require_collection_workbench_read();
 IF NOT cf_private.collection_workflow_write_allowed() THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 -- UUIDs de finalização são referências, nunca credenciais. O ator, os dados e
 -- ambos os resultados devem corresponder ao registro imutável do servidor.
 SELECT * INTO v_request FROM public.collection_work_requests
  WHERE actor_id=auth.uid() AND request_id=p_finish_request_id;
 IF NOT FOUND OR v_request.payload->>'kind' IS DISTINCT FROM 'case'
  OR v_request.payload->'finish' IS DISTINCT FROM 'true'::jsonb
  OR v_request.result->'finished' IS DISTINCT FROM 'true'::jsonb
  OR v_request.payload->>'title_id' IS DISTINCT FROM v_request.title_id::text
  OR v_request.result->>'title_id' IS DISTINCT FROM v_request.title_id::text THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 -- A âncora pode ter ido para validação ou sido quitada após o atendimento.
 -- Isso não reabre a dívida. Somente os demais títulos realmente pendentes
 -- serão relacionados. A visibilidade e a carteira são reavaliadas agora.
 v_anchor:=cf_private.collection_workbench_title(v_request.title_id);
 PERFORM cf_private.require_collection_title(v_anchor);
 IF v_anchor.collector_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.collection_agents WHERE id=v_anchor.collector_id AND enabled) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;

 SELECT cf_private.normalize_collection_contact_methods(c.emails,'emails') INTO v_emails
  FROM public.collection_customer_contacts c WHERE c.customer_key=v_anchor.customer_key;
 v_emails:=coalesce(v_emails,'[]'::jsonb);
 -- Não aceitar listas de destinatários ou metadados de cabeçalho disfarçados
 -- de endereço único em registros legados. O frontend ainda codifica cada URI.
 FOR v_email IN SELECT value FROM jsonb_array_elements_text(v_emails) LOOP
  IF length(v_email)>254 OR length(split_part(v_email,'@',1))>64
   OR v_email ~ '[,;<>:"\\]' OR v_email ~ '[[:cntrl:]]'
   OR split_part(v_email,'@',1) ~ '^\.|\.$|\.\.'
   OR split_part(v_email,'@',2) !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' THEN
   RAISE EXCEPTION 'Revise os e-mails cadastrados para este cliente antes de preparar o rascunho.' USING ERRCODE='22023';
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO v_emails FROM jsonb_array_elements(v_emails);

 -- O recorte adicional para títulos futuros pertence exclusivamente a esta
 -- leitura autorizada. Não amplia workbench, RLS ou carteira de outra pessoa.
 -- O limite 5001 serve apenas para detectar excesso; nunca retorna truncado.
 WITH eligible AS MATERIALIZED(
  SELECT t.id,t.document,t.branch,t.due_date,t.amount_cents
  FROM public.receivable_titles t
  WHERE t.scope=v_anchor.scope AND t.customer_key=v_anchor.customer_key
   AND t.collector_id=v_anchor.collector_id
   AND NOT t.retired_from_report AND t.status IN ('NEW','OPEN','NOT_LOCATED') AND t.validation_status='NONE'
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.title_id=t.id)
  ORDER BY t.due_date,t.document,t.branch,t.id LIMIT 5001
 ) SELECT count(*),count(*) FILTER(WHERE due_date<v_today),count(*) FILTER(WHERE due_date>=v_today),
  coalesce(sum(amount_cents),0),coalesce(sum(amount_cents) FILTER(WHERE due_date<v_today),0),
  coalesce(sum(amount_cents) FILTER(WHERE due_date>=v_today),0),coalesce(sum(abs(amount_cents::numeric)),0),
  coalesce(jsonb_agg(jsonb_build_object('title_id',id,'document',document,'branch',branch,
   'due_date',due_date,'amount_cents',amount_cents,'category',CASE WHEN due_date<v_today THEN 'OVERDUE' ELSE 'UPCOMING' END)
   ORDER BY due_date,document,branch,id),'[]'::jsonb)
 INTO v_count,v_overdue_count,v_upcoming_count,v_total,v_overdue,v_upcoming,v_absolute,v_rows FROM eligible;
 IF v_count>5000 THEN
  RAISE EXCEPTION 'Este cliente possui mais de 5.000 títulos pendentes nesta carteira. O rascunho não foi preparado; nenhum título foi omitido silenciosamente.' USING ERRCODE='54000';
 END IF;
 IF greatest(abs(v_total),abs(v_overdue),abs(v_upcoming),v_absolute)>9007199254740991 THEN
  RAISE EXCEPTION 'O total dos títulos excede o limite seguro de precisão. O rascunho não foi preparado.' USING ERRCODE='22003';
 END IF;
 v_result:=jsonb_build_object('request_id',v_request.request_id,'title_id',v_anchor.id,
  'customer_key',v_anchor.customer_key,'client_name',v_anchor.client_name,'as_of_date',v_today,
  'emails',v_emails,'rows',v_rows,'overdue_count',v_overdue_count,'upcoming_count',v_upcoming_count,
  'total_count',v_count,'overdue_cents',v_overdue,'upcoming_cents',v_upcoming,'total_cents',v_total);
 RETURN v_result||jsonb_build_object('revision',encode(sha256(convert_to(v_result::text,'UTF8')),'hex'));
END $$;
$cr047_read_model$;
 END IF;
END $cr047_optional$;


INSERT INTO public.central_schema_migrations(version) VALUES('047_receivables_complete_report');
NOTIFY pgrst,'reload schema';
$cf047ddl$;
END $cf047guard$;
COMMIT;
