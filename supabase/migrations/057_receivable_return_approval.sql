-- Retorno à carteira exige aprovação individual da Gerência na importação.
-- Aprovar não altera saldos: estorno e retorno ocorrem na confirmação do arquivo.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $cf057$ BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='057_receivable_return_approval') THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='056_receivable_receipt_reversal') THEN
  RAISE EXCEPTION 'Ative o SQL 056 antes da aprovação de retorno de recebíveis.' USING ERRCODE='22023';END IF;
 EXECUTE $cf057ddl$
CREATE TABLE cf_private.receivable_return_approvals(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL,
 payload_sha256 text NOT NULL CHECK(payload_sha256~'^[a-f0-9]{64}$'),title_id uuid NOT NULL REFERENCES public.receivable_titles(id),
 title_revision bigint NOT NULL,retired_from_report boolean NOT NULL,receipt_id uuid REFERENCES public.receivable_receipts(id),
 receipt_fingerprint text NOT NULL CHECK(receipt_fingerprint~'^[a-f0-9]{64}$'),source_row jsonb NOT NULL CHECK(jsonb_typeof(source_row)='object'),
 source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 5000),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,request_id)
);
CREATE INDEX receivable_return_approval_title ON cf_private.receivable_return_approvals(title_id,title_revision,actor_id);
CREATE TABLE cf_private.receivable_return_consumptions(
 approval_id uuid PRIMARY KEY REFERENCES cf_private.receivable_return_approvals(id),
 request_id uuid NOT NULL REFERENCES cf_private.receivable_open_report_requests(request_id) DEFERRABLE INITIALLY DEFERRED,
 source_import_id uuid NOT NULL REFERENCES public.receivable_imports(id),file_sha256 text NOT NULL CHECK(file_sha256~'^[a-f0-9]{64}$'),
 consumed_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE cf_private.receivable_return_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.receivable_return_consumptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.receivable_return_approvals,cf_private.receivable_return_consumptions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER receivable_return_approval_immutable BEFORE UPDATE OR DELETE ON cf_private.receivable_return_approvals
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER receivable_return_consumption_immutable BEFORE UPDATE OR DELETE ON cf_private.receivable_return_consumptions
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER receivable_return_approval_revision AFTER INSERT ON cf_private.receivable_return_approvals
 FOR EACH ROW EXECUTE FUNCTION cf_private.bump_receivables_sync_revision();

CREATE FUNCTION cf_private.receivable_return_source(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $fn$
DECLARE v_row jsonb;BEGIN
 v_row:=cf_private.validate_receivable_rows('grupo-consolidado',jsonb_build_array(p_row))->0;
 RETURN jsonb_build_object('document',v_row->'document','client_name',v_row->'client_name','client_document',v_row->'client_document',
  'branch',v_row->'branch','issued_on',v_row->'issued_on','due_date',v_row->'due_date','amount_cents',v_row->'amount_cents');
END $fn$;
CREATE FUNCTION cf_private.receivable_return_fingerprint(p_value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $fn$
 SELECT encode(sha256(convert_to(coalesce(p_value,'null'::jsonb)::text,'UTF8')),'hex')
$fn$;
CREATE FUNCTION public.approve_receivable_report_return(p_title_id uuid,p_expected_revision bigint,p_expected_receipt_id uuid,p_expected_receipt_fingerprint text,
 p_source_row jsonb,p_reason text,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_title public.receivable_titles%ROWTYPE;v_receipt public.effective_receivable_receipts%ROWTYPE;
 v_row jsonb;v_fingerprint text;v_receipt_fingerprint text;v_payload text;v_saved cf_private.receivable_return_approvals%ROWTYPE;
 v_id uuid:=gen_random_uuid();v_now timestamptz:=clock_timestamp();v_result jsonb;v_reason text:=btrim(p_reason);BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);
 PERFORM cf_private.require_receivable_finance('import');
 IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('contas_receber','validate') THEN
  RAISE EXCEPTION 'Somente a Gerência pode aprovar um retorno à carteira.' USING ERRCODE='42501';END IF;
 IF p_title_id IS NULL OR p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1
  OR p_expected_receipt_fingerprint IS NULL OR p_expected_receipt_fingerprint!~'^[a-f0-9]{64}$'
  OR length(coalesce(p_reason,''))>5000 OR nullif(cf_private.normalize_receivable_text(p_reason),'') IS NULL THEN
  RAISE EXCEPTION 'Informe o título, a revisão e a justificativa do retorno.' USING ERRCODE='22023';END IF;
 v_row:=cf_private.receivable_return_source(p_source_row);v_fingerprint:=cf_private.receivable_return_fingerprint(v_row);
 v_payload:=cf_private.receivable_return_fingerprint(jsonb_build_object('title_id',p_title_id,'revision',p_expected_revision,
  'receipt_id',p_expected_receipt_id,'receipt_fingerprint',p_expected_receipt_fingerprint,'source_row',v_row,'reason',v_reason));
 SELECT * INTO v_saved FROM cf_private.receivable_return_approvals WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN
  IF v_saved.payload_sha256<>v_payload THEN RAISE EXCEPTION 'Protocolo de aprovação usado com outra decisão.' USING ERRCODE='22023';END IF;
  RETURN v_saved.result;
 END IF;
 SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id AND scope='grupo-consolidado' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='P0002';END IF;
 SELECT * INTO v_receipt FROM public.effective_receivable_receipts WHERE title_id=p_title_id;
 IF v_title.revision<>p_expected_revision OR v_receipt.id IS DISTINCT FROM p_expected_receipt_id THEN
  RAISE EXCEPTION 'O título ou o recebimento mudou. Analise o arquivo novamente.' USING ERRCODE='40001';END IF;
 IF NOT v_title.retired_from_report AND v_receipt.id IS NULL AND v_title.status<>'VALIDATED' THEN
  RAISE EXCEPTION 'Este título já está ativo e não exige retorno.' USING ERRCODE='P0057';END IF;
 IF v_title.status='VALIDATED' AND v_receipt.id IS NULL THEN
  RAISE EXCEPTION 'Quitação sem recebimento ativo correspondente. Confira o histórico financeiro.' USING ERRCODE='P0057';END IF;
 IF cf_private.receivable_sync_group_key(v_title.branch,v_title.document,v_title.customer_key) IS DISTINCT FROM
  cf_private.receivable_sync_group_key(v_row->>'branch',v_row->>'document',cf_private.receivable_customer_key(v_row->>'client_name',v_row->>'client_document')) THEN
  RAISE EXCEPTION 'A linha escolhida não pertence ao título.' USING ERRCODE='23514';END IF;
 IF v_receipt.id IS NOT NULL AND (v_title.amount_cents<>(v_row->>'amount_cents')::bigint OR v_title.due_date<>(v_row->>'due_date')::date) THEN
  RAISE EXCEPTION 'Confira a parcela, o valor e o vencimento antes de aprovar o retorno.' USING ERRCODE='23514';END IF;
 v_receipt_fingerprint:=cf_private.receivable_return_fingerprint(CASE WHEN v_receipt.id IS NOT NULL THEN to_jsonb(v_receipt) END);
 IF v_receipt_fingerprint<>p_expected_receipt_fingerprint THEN
  RAISE EXCEPTION 'O valor ou a data do recebimento mudou. Analise e confira o retorno novamente.' USING ERRCODE='40001';END IF;
 v_result:=jsonb_build_object('format_version','057','request_id',p_request_id,'approval_id',v_id,'title_id',p_title_id,
  'title_revision',v_title.revision,'receipt_id',v_receipt.id,'receipt_fingerprint',v_receipt_fingerprint,'source_fingerprint',v_fingerprint,'approved_by',auth.uid(),'approved_at',v_now);
 INSERT INTO cf_private.receivable_return_approvals(id,actor_id,request_id,payload_sha256,title_id,title_revision,retired_from_report,receipt_id,
  receipt_fingerprint,source_row,source_fingerprint,reason,result,created_at)
 VALUES(v_id,auth.uid(),p_request_id,v_payload,p_title_id,v_title.revision,v_title.retired_from_report,v_receipt.id,
  v_receipt_fingerprint,v_row,v_fingerprint,v_reason,v_result,v_now);
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 SELECT id,username,role_key,'contas_receber','receivable_return_approvals',v_id::text,'CREATE',to_jsonb(v_title),
  v_result||jsonb_build_object('operation','APPROVE_RETURN','source_row',v_row,'reason',v_reason,'receipt',CASE WHEN v_receipt.id IS NOT NULL THEN to_jsonb(v_receipt) END)
 FROM public.profiles WHERE id=auth.uid();
 RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION cf_private.receivable_return_source(jsonb),cf_private.receivable_return_fingerprint(jsonb),
 public.approve_receivable_report_return(uuid,bigint,uuid,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.approve_receivable_report_return(uuid,bigint,uuid,text,jsonb,text,uuid) TO authenticated;

ALTER FUNCTION public.preview_receivables_open_report(text,jsonb,boolean,date,jsonb,jsonb) SET SCHEMA cf_private;
ALTER FUNCTION cf_private.preview_receivables_open_report(text,jsonb,boolean,date,jsonb,jsonb) RENAME TO preview_receivables_open_report_047_base;
REVOKE ALL ON FUNCTION cf_private.preview_receivables_open_report_047_base(text,jsonb,boolean,date,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.preview_receivables_open_report(p_scope text,p_rows jsonb,p_full_report boolean,p_reference_date date,
 p_title_mappings jsonb DEFAULT '{}'::jsonb,p_collector_mappings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_preview jsonb;v_source jsonb;v_rows jsonb;v_item jsonb;v_items jsonb:='[]'::jsonb;v_errors jsonb;
 v_title public.receivable_titles%ROWTYPE;v_receipt public.effective_receivable_receipts%ROWTYPE;v_approval cf_private.receivable_return_approvals%ROWTYPE;
 v_fingerprint text;v_receipt_fingerprint text;v_unapproved integer:=0;v_count integer:=0;v_can_approve boolean;BEGIN
 v_preview:=cf_private.preview_receivables_open_report_047_base(p_scope,p_rows,p_full_report,p_reference_date,p_title_mappings,p_collector_mappings);
 v_errors:=coalesce(v_preview->'errors','[]'::jsonb);
 v_can_approve:=cf_private.is_manager() AND cf_private.has_permission('contas_receber','validate');
 FOR v_item IN
  WITH incoming AS MATERIALIZED(SELECT value FROM jsonb_array_elements(v_preview->'rows'))
  SELECT i.value FROM incoming i JOIN public.receivable_titles t ON t.id=(i.value->>'title_id')::uuid
  WHERE t.retired_from_report OR t.status='VALIDATED' OR EXISTS(SELECT 1 FROM public.active_receivable_receipts r WHERE r.title_id=t.id)
 LOOP
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=(v_item->>'title_id')::uuid;
  SELECT * INTO v_receipt FROM public.effective_receivable_receipts WHERE title_id=v_title.id;
  IF NOT v_title.retired_from_report AND v_title.status<>'VALIDATED' AND v_receipt.id IS NULL THEN CONTINUE;END IF;
  v_source:=jsonb_build_object('document',v_item->'document','client_name',v_item->'client_name','client_document',v_item->'client_document',
   'branch',v_item->'branch','issued_on',v_item->'issued_on','due_date',v_item->'due_date','amount_cents',v_item->'amount_cents');
  v_fingerprint:=cf_private.receivable_return_fingerprint(v_source);
  v_receipt_fingerprint:=cf_private.receivable_return_fingerprint(CASE WHEN v_receipt.id IS NOT NULL THEN to_jsonb(v_receipt) END);
  SELECT a.* INTO v_approval FROM cf_private.receivable_return_approvals a
   WHERE a.title_id=v_title.id AND a.title_revision=v_title.revision AND a.retired_from_report=v_title.retired_from_report
    AND a.actor_id=auth.uid() AND v_can_approve AND a.receipt_id IS NOT DISTINCT FROM v_receipt.id
    AND a.receipt_fingerprint=v_receipt_fingerprint AND a.source_fingerprint=v_fingerprint
    AND NOT EXISTS(SELECT 1 FROM cf_private.receivable_return_consumptions c WHERE c.approval_id=a.id)
   ORDER BY a.created_at DESC,a.id DESC LIMIT 1;
  v_count:=v_count+1;
  IF v_approval.id IS NULL THEN
   v_unapproved:=v_unapproved+1;
   v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',(v_item->>'line')::integer,'column','Retorno à carteira',
    'problem','Título quitado ou retirado exige aprovação individual da Gerência para retornar.',
    'correction','Confira a entrada bancária e a parcela, informe a justificativa e aprove o retorno antes de analisar novamente.'));
  END IF;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('line',(v_item->>'line')::integer,'title_id',v_title.id,
   'document',v_item->'document','client_name',v_item->'client_name','branch',v_item->'branch','due_date',v_item->'due_date','amount_cents',v_item->'amount_cents',
   'reason_kind',CASE WHEN v_receipt.id IS NOT NULL OR v_title.status='VALIDATED' THEN 'VALIDATED' ELSE 'RETIRED' END,
   'expected_revision',v_title.revision,'retired_from_report',v_title.retired_from_report,'receipt_id',v_receipt.id,
   'collector_id',v_title.collector_id,'requires_collector_assignment',v_title.collector_id IS NULL,
   'received_amount_cents',v_receipt.amount_cents,'payment_date',v_receipt.payment_date,'receipt_fingerprint',v_receipt_fingerprint,'source_row',v_source,'source_fingerprint',v_fingerprint,
   'approval_id',v_approval.id,'approved_by',v_approval.actor_id,'approved_at',v_approval.created_at,
   'can_approve',v_can_approve AND v_item->>'outcome' NOT IN('AMBIGUOUS','CONFLICT') AND (v_title.status<>'VALIDATED' OR v_receipt.id IS NOT NULL)));
 END LOOP;
 RETURN v_preview||jsonb_build_object('return_approval_version','057','return_count',v_count,'return_unapproved_count',v_unapproved,
  'return_items',v_items,'can_commit',(v_preview->>'can_commit')::boolean AND v_unapproved=0,
  'conflict_count',(v_preview->>'conflict_count')::integer+v_unapproved,'errors',v_errors);
END $fn$;
REVOKE ALL ON FUNCTION public.preview_receivables_open_report(text,jsonb,boolean,date,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_receivables_open_report(text,jsonb,boolean,date,jsonb,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.commit_receivables_open_report_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,
 p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_title_mappings jsonb DEFAULT '{}'::jsonb,p_previous_import_id uuid DEFAULT NULL,
 p_previous_financial_revision text DEFAULT NULL,p_collector_mappings jsonb DEFAULT '{}'::jsonb,p_full_report boolean DEFAULT NULL,
 p_reference_date date DEFAULT NULL,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_preview jsonb;v_result jsonb;v_hash text;v_saved cf_private.receivable_open_report_requests%ROWTYPE;v_row jsonb;v_item jsonb;
 v_title_id uuid;v_import uuid;v_collector uuid;v_retired boolean;v_extra_assigned integer:=0;v_changed integer;v_assignment_customers text[];v_return jsonb;v_approval cf_private.receivable_return_approvals%ROWTYPE;v_receipt public.effective_receivable_receipts%ROWTYPE;v_current_revision bigint;v_return_count integer:=0;BEGIN
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
 v_result:=public.commit_receivables_open_import_with_collectors_from_gateway(p_user_id,p_session_id,p_scope,p_file_name,p_file_sha256,p_file_base64,p_rows,p_title_mappings,
 p_previous_import_id,p_previous_financial_revision,p_collector_mappings);
 v_import:=(v_result->>'import_id')::uuid;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_preview->'rows') LOOP
  SELECT a.title_id INTO v_title_id FROM cf_private.receivable_parcel_aliases a WHERE a.scope=p_scope AND a.source_key=v_row->>'source_key';
  IF v_title_id IS NULL THEN RAISE EXCEPTION 'Não foi possível confirmar a identidade de uma parcela. Nenhum dado foi alterado.' USING ERRCODE='P0047';END IF;
  SELECT value INTO v_return FROM jsonb_array_elements(v_preview->'return_items') x WHERE (x->>'title_id')::uuid=v_title_id;
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
  SELECT retired_from_report INTO v_retired FROM public.receivable_titles WHERE id=v_title_id FOR UPDATE;
  IF v_retired AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=v_title_id AND t.status<>'VALIDATED'
   AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id)) THEN
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
  AND t.status<>'VALIDATED' AND NOT t.retired_from_report AND v_collector IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.active_receivable_receipts q WHERE q.title_id=t.id);
  GET DIAGNOSTICS v_changed=ROW_COUNT;v_extra_assigned:=v_extra_assigned+v_changed;
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
 'return_approval_version','057','returned_count',v_return_count,
 'assigned_title_count',(v_result->>'assigned_title_count')::integer+v_extra_assigned,'assigned_customer_count',cardinality(v_assignment_customers));
 INSERT INTO cf_private.receivable_open_report_requests(request_id,actor_id,payload_hash,source_import_id,full_report,reference_date,result)
 VALUES(p_request_id,auth.uid(),v_hash,v_import,p_full_report,p_reference_date,v_result);
 RETURN v_result;
END $fn$;

COMMENT ON FUNCTION public.approve_receivable_report_return(uuid,bigint,uuid,text,jsonb,text,uuid) IS
 'Aprovação individual e imutável da Gerência. Não altera recebimentos nem a carteira; o retorno e eventual estorno só ocorrem na confirmação atômica do relatório.';
INSERT INTO public.central_schema_migrations(version) VALUES('057_receivable_return_approval');
$cf057ddl$;
END $cf057$;
NOTIFY pgrst,'reload schema';
COMMIT;
