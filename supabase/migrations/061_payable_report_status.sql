-- Relatório diário de CP: ausência altera somente o estado operacional para Pago.
-- Não cria pagamento, data de pagamento, movimentação bancária ou comissão.
-- Instalação cumulativa sem limpeza e sem alteração de dados financeiros existentes.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $apply_061$
DECLARE v_definition text;v_fields text;v_sql text;v_patch record;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='060_payable_unified_report') THEN
  RAISE EXCEPTION 'Ative a atualização 060 antes do estado Pago pelo relatório.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='061_payable_report_status') THEN RETURN;END IF;
 EXECUTE $source_061$
CREATE TABLE public.payable_report_status_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title_id uuid NOT NULL REFERENCES public.payable_titles(id),
 report_id uuid NOT NULL REFERENCES cf_private.payable_daily_reports(id),source_import_id uuid NOT NULL REFERENCES public.payable_imports(id),
 event_type text NOT NULL CHECK(event_type IN('PAID','REOPEN')),prior_event_id uuid REFERENCES public.payable_report_status_events(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),title_snapshot jsonb NOT NULL CHECK(jsonb_typeof(title_snapshot)='object'),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((event_type='REOPEN')=(prior_event_id IS NOT NULL)),UNIQUE(report_id,title_id,event_type),UNIQUE(prior_event_id)
);
CREATE INDEX payable_report_status_title ON public.payable_report_status_events(title_id,created_at DESC,id DESC);
ALTER TABLE public.payable_report_status_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payable_report_status_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_report_status_events TO authenticated;
CREATE POLICY payable_report_status_read ON public.payable_report_status_events FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_pagar','read'));
CREATE TRIGGER payable_report_status_immutable BEFORE UPDATE OR DELETE ON public.payable_report_status_events
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_closing_history();
CREATE VIEW cf_private.active_payable_report_status WITH(security_invoker=true) AS
 SELECT e.* FROM public.payable_report_status_events e WHERE e.event_type='PAID'
 AND NOT EXISTS(SELECT 1 FROM public.payable_report_status_events r WHERE r.prior_event_id=e.id AND r.event_type='REOPEN');
REVOKE ALL ON TABLE cf_private.active_payable_report_status FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION cf_private.guard_payable_report_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_previous public.payable_report_status_events%ROWTYPE;BEGIN
 IF NOT EXISTS(SELECT 1 FROM cf_private.payable_daily_reports d WHERE d.id=NEW.report_id AND d.report_kind='ALL'
  AND d.source_import_id=NEW.source_import_id AND d.created_by=NEW.created_by) OR NEW.created_by IS DISTINCT FROM auth.uid()
  OR NOT EXISTS(SELECT 1 FROM public.payable_titles WHERE id=NEW.title_id AND scope='grupo-consolidado') THEN
  RAISE EXCEPTION 'Prova do estado pelo relatório inválida.' USING ERRCODE='22023';END IF;
 IF NEW.event_type='PAID' THEN
  IF EXISTS(SELECT 1 FROM cf_private.active_payable_report_status WHERE title_id=NEW.title_id)
   OR EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=NEW.title_id)
   OR EXISTS(SELECT 1 FROM cf_private.payable_daily_reports d,jsonb_array_elements(d.position) p WHERE d.id=NEW.report_id AND p->>'title_id'=NEW.title_id::text)
   OR NOT EXISTS(SELECT 1 FROM cf_private.payable_daily_reports d JOIN cf_private.payable_daily_reports prior ON prior.id=d.previous_report_id,
    jsonb_array_elements(prior.position) p WHERE d.id=NEW.report_id AND p->>'title_id'=NEW.title_id::text) THEN
   RAISE EXCEPTION 'O título não está ausente ou já possui encerramento ativo.' USING ERRCODE='22023';END IF;
 ELSE
  SELECT * INTO v_previous FROM cf_private.active_payable_report_status WHERE id=NEW.prior_event_id AND title_id=NEW.title_id;
  IF v_previous.id IS NULL OR NOT EXISTS(SELECT 1 FROM cf_private.payable_daily_reports d,jsonb_array_elements(d.position) p WHERE d.id=NEW.report_id AND p->>'title_id'=NEW.title_id::text) THEN
   RAISE EXCEPTION 'O retorno não corresponde a um título do relatório atual.' USING ERRCODE='22023';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER payable_report_status_guard BEFORE INSERT ON public.payable_report_status_events
 FOR EACH ROW EXECUTE FUNCTION cf_private.guard_payable_report_status();
CREATE FUNCTION cf_private.payable_report_status_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM cf_private.invalidate_payable_review(NEW.title_id,'Estado operacional atualizado pelo relatório diário, sem registrar pagamento.');RETURN NEW;
END $$;
CREATE TRIGGER payable_report_status_change AFTER INSERT ON public.payable_report_status_events
 FOR EACH ROW EXECUTE FUNCTION cf_private.payable_report_status_change();
INSERT INTO public.payable_macros(name) VALUES('NÃO CLASSIFICADO') ON CONFLICT(name) DO NOTHING;

CREATE FUNCTION cf_private.payable_open_status_revision() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT '061:'||(public.get_payables_revision()->>'financial_revision')||':'||encode(sha256(convert_to(jsonb_build_object(
  'plans',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.plan),'[]') FROM public.payable_plan_mappings m),
  'macros',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.name),'[]') FROM public.payable_macros m),
  'head',(SELECT id FROM cf_private.payable_daily_reports WHERE report_kind='ALL' ORDER BY created_at DESC,id DESC LIMIT 1))::text,'UTF8')),'hex');
$$;
CREATE FUNCTION cf_private.payable_open_status_mappings(p_rows jsonb,p_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_result jsonb:='{}';v_map record;v_plan text;BEGIN
 IF p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'object' OR octet_length(p_mappings::text)>2000000 THEN
  RAISE EXCEPTION 'Classificações inválidas.' USING ERRCODE='22023';END IF;
 FOR v_map IN SELECT key,value FROM jsonb_each(p_mappings) LOOP
  v_plan:=cf_private.normalize_payable_plan(v_map.key);
  IF length(v_plan) NOT BETWEEN 1 AND 300 OR length(v_map.key)>300 OR jsonb_typeof(v_map.value)<>'string'
   OR NOT EXISTS(SELECT 1 FROM public.payable_macros WHERE name=v_map.value#>>'{}')
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE cf_private.normalize_payable_plan(r->>'plan')=v_plan) OR v_result ? v_plan THEN
   RAISE EXCEPTION 'A classificação deve corresponder a um plano deste arquivo.' USING ERRCODE='22023';END IF;
  v_result:=v_result||jsonb_build_object(v_plan,v_map.value#>>'{}');
 END LOOP;
 SELECT v_result||coalesce(jsonb_object_agg(plan,'NÃO CLASSIFICADO'),'{}') INTO v_result FROM(
  SELECT DISTINCT cf_private.normalize_payable_plan(r->>'plan') plan FROM jsonb_array_elements(p_rows) r
   LEFT JOIN public.payable_plan_mappings m ON m.plan=cf_private.normalize_payable_plan(r->>'plan')
  WHERE m.plan IS NULL AND NOT v_result ? cf_private.normalize_payable_plan(r->>'plan')) q;
 RETURN v_result;
END $$;
CREATE FUNCTION cf_private.validate_payable_rounding_adjustments(p_rows jsonb,p_adjustments jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$ DECLARE v_item jsonb;v_line integer;v_seen integer[]:='{}';v_original text;v_amount numeric;BEGIN
 IF p_adjustments IS NULL OR jsonb_typeof(p_adjustments)<>'array' OR jsonb_array_length(p_adjustments)>5000 OR octet_length(p_adjustments::text)>2000000 THEN
  RAISE EXCEPTION 'Ajustes de centavos inválidos.' USING ERRCODE='22023';END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_adjustments) LOOP
  IF jsonb_typeof(v_item)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN('line','original_amount','amount_cents'))
   OR jsonb_typeof(v_item->'line') IS DISTINCT FROM 'number' OR coalesce(v_item->>'line','')!~'^[1-9][0-9]{0,6}$'
   OR jsonb_typeof(v_item->'original_amount') IS DISTINCT FROM 'string' OR length(v_item->>'original_amount') NOT BETWEEN 1 AND 300
   OR v_item->>'original_amount'~'[[:cntrl:]]'
   OR jsonb_typeof(v_item->'amount_cents') IS DISTINCT FROM 'number' OR coalesce(v_item->>'amount_cents','')!~'^[0-9]+$' THEN
   RAISE EXCEPTION 'Ajuste de centavos sem origem verificável.' USING ERRCODE='22023';END IF;
  v_line:=(v_item->>'line')::integer;v_original:=btrim(v_item->>'original_amount');
  IF position(',' IN v_original)>0 OR v_original LIKE 'R$%' THEN
   v_original:=regexp_replace(v_original,'^R\$[[:space:]]*','');
   IF v_original!~'^([0-9]+|[0-9]{1,3}([.][0-9]{3})+)(,[0-9]+)?$' THEN
    RAISE EXCEPTION 'Valor original brasileiro inválido.' USING ERRCODE='22023';END IF;
   v_original:=replace(replace(v_original,'.',''),',','.');
  ELSIF v_original!~'^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]{1,3})?$' THEN
   RAISE EXCEPTION 'Valor original numérico inválido.' USING ERRCODE='22023';END IF;
  v_amount:=v_original::numeric;
  -- line é a linha física do Excel (inclui cabeçalho e lacunas). A função Edge
  -- analisa os bytes preservados e confere a lista integral antes deste RPC.
  IF v_line NOT BETWEEN 2 AND 5001 OR v_line=ANY(v_seen)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE (r->>'amount_cents')::numeric=(v_item->>'amount_cents')::numeric)
   OR round(v_amount*100)<>(v_item->>'amount_cents')::numeric OR v_amount*100=trunc(v_amount*100) THEN
   RAISE EXCEPTION 'O ajuste não corresponde à linha importada.' USING ERRCODE='22023';END IF;
  v_seen:=array_append(v_seen,v_line);
 END LOOP;RETURN p_adjustments;
END $$;

CREATE FUNCTION public.preview_payables_open_status_report(p_scope text,p_rows jsonb,p_report_kind text,p_mappings jsonb DEFAULT '{}',
 p_resolution_choices jsonb DEFAULT '{}',p_empty_report_confirmed boolean DEFAULT false,p_rounding_adjustments jsonb DEFAULT '[]') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_resolved jsonb;v_row jsonb;v_item jsonb;v_choice jsonb;v_key text;v_problem text;v_line integer;
 v_last cf_private.payable_daily_reports%ROWTYPE;v_previous uuid;v_title public.payable_financial_titles%ROWTYPE;v_mappings jsonb;v_seen jsonb:='{}';
 v_exceptions jsonb:='[]';v_actions jsonb:='[]';v_errors jsonb:='[]';v_plans jsonb;v_macros jsonb;v_new integer;v_changed integer;
 v_missing integer:=0;v_missing_cents numeric:=0;v_reopened integer:=0;v_required boolean;v_written boolean;
BEGIN
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write') AND cf_private.has_permission('contas_pagar','import') AND cf_private.has_permission('importar_bases','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_scope IS DISTINCT FROM 'grupo-consolidado' OR p_report_kind IS DISTINCT FROM 'ALL' OR p_empty_report_confirmed IS NULL
  OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR (p_empty_report_confirmed AND p_rows<>'[]'::jsonb)
  OR (p_rows='[]'::jsonb AND NOT p_empty_report_confirmed) THEN
  RAISE EXCEPTION 'Use o relatório completo; uma posição vazia exige confirmação expressa.' USING ERRCODE='22023';END IF;
 v_rows:=CASE WHEN p_empty_report_confirmed THEN '[]'::jsonb ELSE cf_private.validate_payable_identity_rows(p_scope,p_rows) END;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE upper(btrim(coalesce(r->>'source_status',''))) IN('PAGO','PAGA','PAGOS','QUITADO','QUITADA','CANCELADO','CANCELADA','ESTORNADO','ESTORNADA')) THEN
  RAISE EXCEPTION 'O relatório deve conter somente os títulos em aberto.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.validate_payable_import_resolution_choices(p_resolution_choices);
 IF EXISTS(SELECT 1 FROM jsonb_each(p_resolution_choices) c WHERE c.value->>'action'<>'WRITE_OFF') THEN
  RAISE EXCEPTION 'Somente marcadores de um centavo admitem decisão individual nesta rotina.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.validate_payable_rounding_adjustments(v_rows,p_rounding_adjustments);
 v_mappings:=cf_private.payable_open_status_mappings(v_rows,p_mappings);
 v_resolved:=CASE WHEN p_empty_report_confirmed THEN '[]'::jsonb ELSE cf_private.resolve_payable_identity_rows(p_scope,v_rows) END;
 SELECT * INTO v_last FROM cf_private.payable_daily_reports WHERE report_kind='ALL' ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL),count(*) FILTER(WHERE coalesce((r->>'changed')::boolean,false)) INTO v_new,v_changed FROM jsonb_array_elements(v_resolved) r;
 SELECT coalesce(jsonb_agg(jsonb_build_object('plan',plan,'count',n,'total_cents',cents,'macro','NÃO CLASSIFICADO') ORDER BY plan),'[]') INTO v_plans FROM(
  SELECT r->>'plan' plan,count(*) n,sum((r->>'amount_cents')::numeric) cents FROM jsonb_array_elements(v_rows) r LEFT JOIN public.payable_plan_mappings m ON m.plan=r->>'plan'
  WHERE m.plan IS NULL AND NOT p_mappings ? (r->>'plan') GROUP BY r->>'plan') q;
 SELECT coalesce(jsonb_agg(name ORDER BY name),'[]') INTO v_macros FROM public.payable_macros;
 FOR v_row,v_line IN SELECT value,ordinality::integer FROM jsonb_array_elements(v_resolved) WITH ORDINALITY LOOP
  v_title:=NULL;IF v_row->>'title_id' IS NOT NULL THEN SELECT * INTO v_title FROM public.payable_financial_titles WHERE id=(v_row->>'title_id')::uuid;END IF;
  IF (v_row->>'amount_cents')::bigint<>1 AND v_title.report_paid THEN
   v_actions:=v_actions||jsonb_build_array(jsonb_build_object('kind','REOPEN','title_id',v_title.id,'source_key',v_row->>'source_key','amount_cents',(v_row->>'amount_cents')::bigint));v_reopened:=v_reopened+1;
  END IF;
  IF (v_row->>'amount_cents')::bigint=1 THEN
   v_key:='row:'||v_line;v_choice:=p_resolution_choices->v_key;v_seen:=v_seen||jsonb_build_object(v_key,true);
   v_written:=v_title.administrative_writeoff_id IS NOT NULL;v_required:=NOT v_written;v_problem:=NULL;
   IF coalesce(v_title.paid_cents,0)>0 THEN v_problem:='O marcador possui pagamento real; confira o histórico financeiro antes da baixa administrativa.';
   ELSIF v_required AND v_choice IS NULL THEN v_problem:='Confirme individualmente a baixa de R$ 0,01 sem pagamento.';
   ELSIF NOT v_required AND v_choice IS NOT NULL THEN v_problem:='Esta baixa já foi confirmada; remova a escolha anterior.';END IF;
   v_item:=jsonb_build_object('key',v_key,'kind','CENT','line',v_line,'title_id',v_title.id,'branch',v_row->>'branch','entry_number',v_row->>'entry_number',
    'description',v_row->>'description','due_date',v_row->>'due_date','amount_cents',1,'source_amount_cents',1,
    'payment_remaining_cents',0,'allowed_actions',CASE WHEN v_required AND coalesce(v_title.paid_cents,0)=0 THEN '["WRITE_OFF"]'::jsonb ELSE '[]'::jsonb END,
    'requires_resolution',v_required,'already_written_off',v_written,'selected_action',v_choice->>'action','problem',v_problem,
    'paid_on',NULL,'bank_account_id',NULL,'bank_label',NULL,'bank_mapping_key',NULL,'cheque_number',v_row->>'cheque_number','rule','CENT',
    'payment_revision',v_title.payment_revision,'last_import_id',v_title.last_import_id);
   v_exceptions:=v_exceptions||jsonb_build_array(v_item);
  END IF;
 END LOOP;
 IF v_last.id IS NOT NULL THEN
  FOR v_title IN SELECT f.* FROM public.payable_financial_titles f
   WHERE f.scope=p_scope AND f.id IN(SELECT (p->>'title_id')::uuid FROM jsonb_array_elements(v_last.position) p)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'source_key'=cf_private.payable_business_key(f.branch,f.entry_number))
    AND NOT f.report_paid AND f.administrative_writeoff_id IS NULL AND cf_private.payable_closing_exclusion(f.id) IS NULL
   ORDER BY f.branch,f.entry_number,f.id LOOP
   IF v_title.amount_cents=1 THEN
    v_key:='title:'||v_title.id;v_choice:=p_resolution_choices->v_key;v_seen:=v_seen||jsonb_build_object(v_key,true);
    v_problem:=CASE WHEN v_title.paid_cents>0 THEN 'O marcador possui pagamento real; confira o histórico financeiro.' WHEN v_choice IS NULL THEN 'Confirme individualmente a baixa de R$ 0,01 sem pagamento.' ELSE NULL END;
    v_exceptions:=v_exceptions||jsonb_build_array(jsonb_build_object('key',v_key,'kind','CENT','line',NULL,'title_id',v_title.id,'branch',v_title.branch,'entry_number',v_title.entry_number,
     'description',v_title.description,'due_date',v_title.due_date,'amount_cents',1,'source_amount_cents',1,'payment_remaining_cents',0,
     'allowed_actions',CASE WHEN v_title.paid_cents=0 THEN '["WRITE_OFF"]'::jsonb ELSE '[]'::jsonb END,'requires_resolution',true,'already_written_off',false,
     'selected_action',v_choice->>'action','problem',v_problem,'paid_on',NULL,'bank_account_id',NULL,'bank_label',NULL,'bank_mapping_key',NULL,
     'cheque_number',v_title.cheque_number,'rule','CENT','payment_revision',v_title.payment_revision,'last_import_id',v_title.last_import_id));
   ELSE
    v_actions:=v_actions||jsonb_build_array(jsonb_build_object('kind','PAID','title_id',v_title.id,'source_key',cf_private.payable_business_key(v_title.branch,v_title.entry_number),'amount_cents',v_title.amount_cents));
    v_missing:=v_missing+1;v_missing_cents:=v_missing_cents+v_title.amount_cents;
   END IF;
  END LOOP;
 END IF;
 IF v_missing_cents>9007199254740991 THEN RAISE EXCEPTION 'O total nominal excede o limite seguro.' USING ERRCODE='22003';END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_exceptions) WHERE value->>'problem' IS NOT NULL LOOP
  v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',coalesce((v_item->>'line')::integer,0),'column','Baixa sem pagamento','problem',v_item->>'problem','correction','Confirme somente o marcador de um centavo indicado.'));
 END LOOP;
 FOR v_key IN SELECT jsonb_object_keys(p_resolution_choices) LOOP IF NOT v_seen ? v_key THEN
  v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',0,'column','Baixa sem pagamento','problem','Uma escolha não pertence a este relatório.','correction','Atualize a conferência.'));END IF;END LOOP;
 SELECT coalesce(jsonb_agg(e ORDER BY n),'[]') INTO v_errors FROM jsonb_array_elements(v_errors) WITH ORDINALITY a(e,n) WHERE n<=100;
 RETURN jsonb_build_object('status_report_version','061','status_only',true,'mode','open_status','report_kind','ALL','empty_report_confirmed',p_empty_report_confirmed,
  'report_date',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'previous_import_id',v_previous,'financial_revision',cf_private.payable_open_status_revision(),
  'previous_report_id',v_last.id,'rows',p_rows,'source_row_count',jsonb_array_length(v_rows),'row_count',jsonb_array_length(v_rows),
  'new_count',v_new,'open_count',jsonb_array_length(v_rows)-v_new,'changed_count',v_changed,'baseline_only',v_last.id IS NULL,
  'baseline_origin',CASE WHEN v_last.id IS NULL THEN 'FIRST_REPORT' ELSE 'PREVIOUS_REPORT' END,'marked_paid_count',v_missing,'marked_paid_cents',v_missing_cents,'reopened_count',v_reopened,
  'status_actions',v_actions,'exceptions',v_exceptions,'errors',v_errors,'can_commit',jsonb_array_length(v_errors)=0,
  'unmapped_plans',v_plans,'macro_options',v_macros,'bank_options','[]'::jsonb,'auto_payment_count',0,'auto_payment_cents',0,'rounding_adjustments',p_rounding_adjustments);
END $$;

CREATE FUNCTION public.commit_payables_open_status_report_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,
 p_rows jsonb,p_report_kind text,p_mappings jsonb,p_resolution_choices jsonb,p_previous_import_id uuid,p_previous_financial_revision text,p_expected_report_date date,
 p_request_id uuid,p_empty_report_confirmed boolean DEFAULT false,p_rounding_adjustments jsonb DEFAULT '[]') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payload jsonb;v_saved cf_private.payable_daily_requests%ROWTYPE;v_previous cf_private.payable_daily_reports%ROWTYPE;v_existing public.payable_imports%ROWTYPE;
 v_preview jsonb;v_core jsonb;v_result jsonb;v_rows jsonb;v_resolved jsonb;v_position jsonb;v_item jsonb;v_map jsonb;v_import uuid;v_report uuid:=gen_random_uuid();
 v_title public.payable_review_titles%ROWTYPE;v_event uuid;v_writeoff jsonb;v_written integer:=0;v_reuse boolean:=false;v_row jsonb;
BEGIN
 PERFORM cf_private.require_payable_import_reconciliation_actor(p_user_id,p_session_id);
 PERFORM cf_private.validate_payable_reconciliation_file(p_file_name,p_file_sha256,p_file_base64);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Informe o protocolo da importação.' USING ERRCODE='22023';END IF;
 v_payload:=jsonb_build_object('status_report_version','061','status_only',true,'scope',p_scope,'file_name',p_file_name,'file_sha256',p_file_sha256,'rows',p_rows,'report_kind',p_report_kind,
  'mappings',p_mappings,'resolution_choices',p_resolution_choices,'previous_import_id',p_previous_import_id,'previous_financial_revision',p_previous_financial_revision,
  'expected_report_date',p_expected_report_date,'empty_report_confirmed',p_empty_report_confirmed,'rounding_adjustments',p_rounding_adjustments);
 SELECT * INTO v_saved FROM cf_private.payable_daily_requests WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN IF v_saved.payload IS DISTINCT FROM v_payload THEN RAISE EXCEPTION 'Protocolo já usado com outros dados.' USING ERRCODE='22023';END IF;RETURN v_saved.result||jsonb_build_object('idempotent',true);END IF;
 IF EXISTS(SELECT 1 FROM cf_private.payable_import_resolution_requests WHERE actor_id=auth.uid() AND request_id=p_request_id) THEN RAISE EXCEPTION 'Protocolo já usado por outra importação.' USING ERRCODE='22023';END IF;
 IF p_expected_report_date IS NULL OR p_expected_report_date<>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
  RAISE EXCEPTION 'O dia da importação mudou. Atualize o arquivo.' USING ERRCODE='40001';END IF;
 LOCK TABLE public.payable_plan_mappings,public.payable_macros IN SHARE ROW EXCLUSIVE MODE;
 IF p_previous_import_id IS DISTINCT FROM (public.get_payables_revision()->>'import_id')::uuid OR p_previous_financial_revision IS NULL
  OR p_previous_financial_revision IS DISTINCT FROM cf_private.payable_open_status_revision() THEN RAISE EXCEPTION 'A base mudou. Atualize a importação.' USING ERRCODE='40001';END IF;
 SELECT * INTO v_previous FROM cf_private.payable_daily_reports WHERE report_kind='ALL' ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT * INTO v_existing FROM public.payable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256 AND import_mode='FORECAST';
 v_preview:=public.preview_payables_open_status_report(p_scope,p_rows,p_report_kind,p_mappings,p_resolution_choices,p_empty_report_confirmed,p_rounding_adjustments);
 IF NOT coalesce((v_preview->>'can_commit')::boolean,false) THEN RAISE EXCEPTION 'Confirme individualmente os marcadores de um centavo.' USING ERRCODE='P0061';END IF;
 v_rows:=v_preview->'rows';v_map:=cf_private.payable_open_status_mappings(v_rows,p_mappings);
 IF v_existing.id IS NOT NULL AND NOT p_empty_report_confirmed THEN
  IF v_previous.id IS NULL OR v_previous.file_sha256 IS DISTINCT FROM p_file_sha256 OR v_previous.source_import_id IS DISTINCT FROM v_existing.id
   OR v_previous.rows IS DISTINCT FROM v_rows OR (v_preview->>'marked_paid_count')::integer<>0 OR (v_preview->>'reopened_count')::integer<>0
   OR NOT cf_private.payable_unified_current_source_matches(p_scope,v_rows,v_map) THEN
   RAISE EXCEPTION 'Um arquivo antigo ou divergente não pode substituir a posição atual. Exporte o relatório atualizado.' USING ERRCODE='23505';END IF;
  v_reuse:=true;
 END IF;
 v_resolved:=CASE WHEN p_empty_report_confirmed THEN '[]'::jsonb ELSE cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,v_rows)) END;
 -- A fonte atualiza os dados do mesmo UUID; reabre somente a baixa administrativa.
 -- Nenhum recebimento/pagamento verdadeiro é estornado ou reclassificado.
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_resolved) WHERE (value->>'amount_cents')::bigint<>1 AND value->>'title_id' IS NOT NULL LOOP
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_row->>'title_id')::uuid;
  IF v_title.administrative_writeoff_id IS NOT NULL THEN PERFORM cf_private.reverse_payable_administrative_writeoff(v_title.id,'Retornou ao relatório completo de títulos em aberto.',v_title.payment_revision);END IF;
 END LOOP;
 IF p_empty_report_confirmed THEN
  IF v_existing.id IS NOT NULL THEN
   IF v_existing.row_count<>0 OR NOT EXISTS(SELECT 1 FROM cf_private.payable_import_files WHERE import_id=v_existing.id AND file_bytes=decode(p_file_base64,'base64')) THEN
    RAISE EXCEPTION 'A cópia preservada não corresponde ao relatório vazio.' USING ERRCODE='22023';END IF;v_import:=v_existing.id;
  ELSE
   v_import:=gen_random_uuid();INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode)
    VALUES(v_import,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),0,0,0,0,'FORECAST');
   INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_import,decode(p_file_base64,'base64'));
  END IF;
  v_core:=jsonb_build_object('import_id',v_import,'new_count',0,'open_count',0,'changed_count',0,'row_count',0);v_position:='[]';
 ELSIF v_reuse THEN
  v_import:=v_existing.id;
  IF NOT EXISTS(SELECT 1 FROM cf_private.payable_import_files WHERE import_id=v_import AND file_bytes=decode(p_file_base64,'base64')) THEN
   RAISE EXCEPTION 'A cópia preservada não corresponde ao arquivo.' USING ERRCODE='22023';END IF;
  v_core:=jsonb_build_object('import_id',v_import,'new_count',0,'open_count',jsonb_array_length(v_rows),'changed_count',0,'row_count',jsonb_array_length(v_rows));
 ELSE
  v_core:=cf_private.commit_payables_forecast_import_v1_core(p_scope,p_file_name,p_file_sha256,p_file_base64,v_rows,v_map,p_previous_import_id);v_import:=(v_core->>'import_id')::uuid;
 END IF;
 INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES(v_import,'FORECAST',v_core,auth.uid()) ON CONFLICT(import_id) DO NOTHING;
 SELECT coalesce(jsonb_agg(jsonb_build_object('title_id',i.title_id,'source_key',r->>'source_key') ORDER BY n),'[]') INTO v_position
  FROM jsonb_array_elements(CASE WHEN p_empty_report_confirmed THEN '[]'::jsonb ELSE cf_private.validate_payable_identity_rows(p_scope,v_rows) END) WITH ORDINALITY a(r,n) JOIN cf_private.payable_identity_registry i ON i.scope=p_scope AND i.business_key=r->>'source_key';
 IF jsonb_array_length(v_position)<>jsonb_array_length(v_rows) OR (v_reuse AND v_position IS DISTINCT FROM v_previous.position) THEN
  RAISE EXCEPTION 'A posição não corresponde a todos os títulos do arquivo.' USING ERRCODE='40001';END IF;
 INSERT INTO cf_private.payable_daily_reports(id,report_kind,file_sha256,report_date,source_import_id,previous_report_id,rows,position,created_by)
  VALUES(v_report,'ALL',p_file_sha256,p_expected_report_date,v_import,v_previous.id,v_rows,v_position,auth.uid());
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_preview->'status_actions') LOOP
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_item->>'title_id')::uuid;
  IF v_item->>'kind'='REOPEN' THEN
   SELECT id INTO v_event FROM cf_private.active_payable_report_status WHERE title_id=v_title.id;
   INSERT INTO public.payable_report_status_events(title_id,report_id,source_import_id,event_type,prior_event_id,reason,title_snapshot,created_by)
    VALUES(v_title.id,v_report,v_import,'REOPEN',v_event,'Título retornou ao relatório completo de abertos.',to_jsonb(v_title),auth.uid());
  ELSE
   UPDATE public.payable_titles SET status='SETTLED_IMPORT',settled_at=clock_timestamp(),last_import_id=v_import WHERE id=v_title.id;
   INSERT INTO public.payable_report_status_events(title_id,report_id,source_import_id,event_type,reason,title_snapshot,created_by)
    VALUES(v_title.id,v_report,v_import,'PAID','Título ausente do relatório completo seguinte: estado Pago sem registrar pagamento.',to_jsonb(v_title),auth.uid());
  END IF;
 END LOOP;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_preview->'exceptions') WHERE value->>'kind'='CENT' AND (value->>'requires_resolution')::boolean LOOP
  IF v_item->>'title_id' IS NULL THEN
   SELECT f.* INTO v_title FROM public.payable_review_titles f JOIN cf_private.payable_identity_registry i ON i.title_id=f.id
    WHERE i.scope=p_scope AND i.business_key=cf_private.payable_business_key(v_item->>'branch',v_item->>'entry_number');
  ELSE SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_item->>'title_id')::uuid;END IF;
  IF v_title.id IS NULL THEN RAISE EXCEPTION 'Marcador não encontrado.' USING ERRCODE='40001';END IF;
  IF v_title.report_paid THEN
   SELECT id INTO v_event FROM cf_private.active_payable_report_status WHERE title_id=v_title.id;
   INSERT INTO public.payable_report_status_events(title_id,report_id,source_import_id,event_type,prior_event_id,reason,title_snapshot,created_by)
    VALUES(v_title.id,v_report,v_import,'REOPEN',v_event,'Título retornou como marcador de um centavo, com baixa administrativa confirmada.',to_jsonb(v_title),auth.uid());
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
  END IF;
  IF v_title.administrative_writeoff_id IS NULL THEN
   v_writeoff:=cf_private.record_payable_administrative_writeoff(v_title.id,v_import,p_resolution_choices->(v_item->>'key')->>'reason',v_title.payment_revision);
   INSERT INTO cf_private.payable_daily_actions(report_id,title_id,writeoff_id,effective_on,rule_kind,title_snapshot,created_by)
    VALUES(v_report,v_title.id,(v_writeoff->>'writeoff_id')::uuid,p_expected_report_date,'CENT',to_jsonb(v_title),auth.uid());v_written:=v_written+1;
  END IF;
 END LOOP;
 v_result:=v_core||jsonb_build_object('status_report_version','061','status_only',true,'mode','open_status','report_kind','ALL','empty_report_confirmed',p_empty_report_confirmed,
  'report_date',p_expected_report_date,'request_id',p_request_id,'report_id',v_report,'import_id',v_import,'new_count',(v_preview->>'new_count')::integer,'open_count',(v_preview->>'open_count')::integer,
  'changed_count',(v_preview->>'changed_count')::integer,'updated_count',(v_preview->>'changed_count')::integer,'marked_paid_count',(v_preview->>'marked_paid_count')::integer,
  'marked_paid_cents',(v_preview->>'marked_paid_cents')::numeric,'reopened_count',(v_preview->>'reopened_count')::integer,
  'paid_count',0,'payment_cents',0,'payments_created',0,'written_off_count',v_written,'baseline_only',(v_preview->>'baseline_only')::boolean,
  'rounding_adjustments',p_rounding_adjustments,'unmapped_plans',v_preview->'unmapped_plans','completed_revision',public.get_payables_revision(),'idempotent',false);
 INSERT INTO cf_private.payable_daily_requests(actor_id,request_id,payload,result,report_id) VALUES(auth.uid(),p_request_id,v_payload,v_result,v_report);
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
  SELECT id,username,role_key,'contas_pagar','PAYABLE_REPORT_STATUS_IMPORT',v_report::text,'IMPORT',v_result FROM public.profiles WHERE id=auth.uid();
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION cf_private.guard_payable_report_status(),cf_private.payable_report_status_change(),cf_private.payable_open_status_revision(),
 cf_private.payable_open_status_mappings(jsonb,jsonb),cf_private.validate_payable_rounding_adjustments(jsonb,jsonb),
 public.preview_payables_open_status_report(text,jsonb,text,jsonb,jsonb,boolean,jsonb),
 public.commit_payables_open_status_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,uuid,text,date,uuid,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_payables_open_status_report(text,jsonb,text,jsonb,jsonb,boolean,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_payables_open_status_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,uuid,text,date,uuid,boolean,jsonb) TO service_role;
 $source_061$;

 -- Preserva OIDs, permissões, nomes, tipos e ordem das colunas existentes.
 v_sql:=regexp_replace(pg_get_viewdef('public.payable_financial_titles'::regclass,true),';[[:space:]]*$','');
 SELECT string_agg(CASE WHEN attname IN('outstanding_cents','payment_remaining_cents') THEN
  'CASE WHEN s.id IS NOT NULL THEN 0::bigint ELSE original.'||quote_ident(attname)||' END AS '||quote_ident(attname)
  WHEN attname='financial_status' THEN 'CASE WHEN s.id IS NOT NULL AND original.paid_cents=0 THEN ''REPORT_PAID''::text ELSE original.financial_status END AS financial_status'
  ELSE 'original.'||quote_ident(attname) END,',' ORDER BY attnum) INTO v_fields FROM pg_attribute WHERE attrelid='public.payable_financial_titles'::regclass AND attnum>0 AND NOT attisdropped;
 EXECUTE 'CREATE OR REPLACE VIEW public.payable_financial_titles WITH(security_invoker=true) AS SELECT '||v_fields||',s.id IS NOT NULL AS report_paid,s.id AS report_paid_event_id,s.created_at AS report_paid_at,s.source_import_id AS report_paid_import_id,s.reason AS report_paid_reason FROM ('||v_sql||') original LEFT JOIN LATERAL(SELECT s.* FROM public.payable_report_status_events s WHERE s.title_id=original.id AND s.event_type=''PAID'' AND NOT EXISTS(SELECT 1 FROM public.payable_report_status_events r WHERE r.prior_event_id=s.id AND r.event_type=''REOPEN'')) s ON true';
 v_sql:=regexp_replace(pg_get_viewdef('public.payable_review_titles'::regclass,true),';[[:space:]]*$','');
 IF position('to_jsonb(f.*)' IN v_sql)=0 THEN RAISE EXCEPTION 'Contrato da visão financeira divergente.' USING ERRCODE='22023';END IF;
 v_sql:=replace(v_sql,'to_jsonb(f.*)','(to_jsonb(f.*)-ARRAY[''report_paid'',''report_paid_event_id'',''report_paid_at'',''report_paid_import_id'',''report_paid_reason'']::text[])');
 SELECT string_agg(CASE WHEN attname='review_status' THEN 'CASE WHEN s.id IS NOT NULL THEN ''PAGO_POR_RELATORIO''::text ELSE original.review_status END AS review_status'
  ELSE 'original.'||quote_ident(attname) END,',' ORDER BY attnum) INTO v_fields FROM pg_attribute WHERE attrelid='public.payable_review_titles'::regclass AND attnum>0 AND NOT attisdropped;
 EXECUTE 'CREATE OR REPLACE VIEW public.payable_review_titles WITH(security_invoker=true) AS SELECT '||v_fields||',s.id IS NOT NULL AS report_paid,s.id AS report_paid_event_id,s.created_at AS report_paid_at,s.source_import_id AS report_paid_import_id,s.reason AS report_paid_reason FROM ('||v_sql||') original LEFT JOIN LATERAL(SELECT s.* FROM public.payable_report_status_events s WHERE s.title_id=original.id AND s.event_type=''PAID'' AND NOT EXISTS(SELECT 1 FROM public.payable_report_status_events r WHERE r.prior_event_id=s.id AND r.event_type=''REOPEN'')) s ON true';

 FOR v_patch IN SELECT * FROM (VALUES
  ('public.get_payables_revision()',$old$'financial_revision','060:'||v_revision);$old$,$new$'financial_revision','061:'||v_revision);$new$),
  ('public.payables_import_capabilities()',$old$'daily_report_version','060','column_rules_version','059','unified_daily_report',true$old$,$new$'daily_report_version','060','column_rules_version','059','unified_daily_report',true,'status_report_version','061','status_only',true,'status_from_report',true$new$),
  ('public.payables_management_summary(date,date)',$old$status,paid_cents,cheque_number$old$,$new$status,paid_cents,cheque_number,report_paid$new$),
  ('public.payables_management_summary(date,date)',$old$status='SETTLED_IMPORT' AND paid_cents=0$old$,$new$status='SETTLED_IMPORT' AND paid_cents=0 AND NOT report_paid$new$),
  ('public.payables_month_status(date)',$old$review_status='CONCILIADO'$old$,$new$review_status IN('CONCILIADO','PAGO_POR_RELATORIO')$new$),
  ('public.payables_month_status(date)',$old$Todos os títulos devem estar totalmente pagos e marcados como CONCILIADO.$old$,$new$Todos os títulos devem estar conciliados financeiramente ou encerrados pelo relatório diário.$new$)
 ) changes(signature,old_text,new_text) LOOP
  v_definition:=pg_get_functiondef(v_patch.signature::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_patch.old_text,'')))/length(v_patch.old_text)<>1 THEN
   RAISE EXCEPTION 'Contrato do consumidor % divergente. Nenhum dado foi alterado.',v_patch.signature USING ERRCODE='22023';END IF;
  EXECUTE replace(v_definition,v_patch.old_text,v_patch.new_text);
 END LOOP;
 v_definition:=pg_get_functiondef('cf_private.guard_payable_empty_cheques_import()'::regprocedure);
 v_sql:=$old$r.result->>'daily_report_version'='060' AND r.result->'unified_daily_report'='true'::jsonb$old$;
 IF (length(v_definition)-length(replace(v_definition,v_sql,'')))/length(v_sql)<>1 THEN RAISE EXCEPTION 'Prova de relatório vazio divergente.' USING ERRCODE='22023';END IF;
 EXECUTE replace(v_definition,v_sql,$new$((r.result->>'daily_report_version'='060' AND r.result->'unified_daily_report'='true'::jsonb) OR (r.result->>'status_report_version'='061' AND r.result->'status_only'='true'::jsonb AND r.payload->>'status_report_version'='061' AND r.payload->'status_only'='true'::jsonb))$new$);
 -- Uma função Edge antiga não pode continuar criando pagamentos presumidos.
 FOR v_patch IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'commit_payables%' AND p.proname<>'commit_payables_open_status_report_from_gateway'
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_patch.signature);END LOOP;
 INSERT INTO public.central_schema_migrations(version) VALUES('061_payable_report_status');
 NOTIFY pgrst,'reload schema';
END $apply_061$;
COMMIT;
