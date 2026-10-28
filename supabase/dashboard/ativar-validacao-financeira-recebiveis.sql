-- CENTRAL FINANCEIRA — validação financeira de Contas a Receber (053).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 047. Pode ser executado novamente com segurança.
-- Preserva os dados existentes. Não confirma recebimentos automaticamente.
-- Não há atualização de Edge Function nesta mudança.

-- Validação financeira: valor líquido, desconto/retenção e protocolo idempotente.
-- Não confirma títulos retirados do relatório completo e não reescreve históricos.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $cf053$ BEGIN
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='053_receivable_financial_validation') THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN
  RAISE EXCEPTION 'Ative o SQL 047 de Contas a Receber antes da validação financeira.' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(2045812308);
 EXECUTE $cf053ddl$
ALTER TABLE public.receivable_receipts
 ADD COLUMN manual_nominal_amount_cents bigint,
 ADD COLUMN manual_original_due_date date,
 ADD COLUMN manual_adjustment_cents bigint,
 ADD COLUMN manual_adjustment_reason text,
 ADD CONSTRAINT receivable_manual_validation_amounts CHECK(
  (manual_nominal_amount_cents IS NULL AND manual_original_due_date IS NULL AND manual_adjustment_cents IS NULL AND manual_adjustment_reason IS NULL)
  OR (manual_nominal_amount_cents IS NOT NULL AND manual_adjustment_cents IS NOT NULL
   AND manual_nominal_amount_cents BETWEEN 0 AND 9007199254740991 AND manual_original_due_date IS NOT NULL
   AND manual_adjustment_cents BETWEEN 0 AND 9007199254740991
   AND amount_cents+manual_adjustment_cents=manual_nominal_amount_cents
   AND ((manual_adjustment_cents=0 AND manual_adjustment_reason IS NULL)
    OR(manual_adjustment_cents>0 AND manual_adjustment_reason IS NOT NULL AND length(cf_private.normalize_receivable_text(manual_adjustment_reason)) BETWEEN 1 AND 5000))));

CREATE TABLE cf_private.receivable_financial_validation_requests(
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,payload_sha256 text NOT NULL CHECK(payload_sha256~'^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id));
ALTER TABLE cf_private.receivable_financial_validation_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.receivable_financial_validation_requests FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER receivable_financial_validation_request_immutable BEFORE UPDATE OR DELETE
 ON cf_private.receivable_financial_validation_requests FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();

CREATE OR REPLACE VIEW public.effective_receivable_receipts WITH(security_invoker=true,security_barrier=true) AS
 SELECT r.id,r.title_id,coalesce(a.amount_cents,r.amount_cents) AS amount_cents,
  coalesce(a.payment_date,r.payment_date) AS payment_date,
  coalesce(a.delay_days,r.delay_days) AS delay_days,coalesce(a.delay_band,r.delay_band) AS delay_band,
  CASE WHEN a.id IS NOT NULL THEN a.collector_id ELSE r.collector_id END AS collector_id,
  r.payment_source,r.reported_in_collection,r.validation,
  coalesce(a.created_by,r.validated_by) AS validated_by,coalesce(a.created_at,r.validated_at) AS validated_at,
  coalesce(a.nominal_amount_cents,p.nominal_amount_cents,r.manual_nominal_amount_cents,r.amount_cents) AS nominal_amount_cents,
  coalesce(a.original_due_date,p.original_due_date,r.manual_original_due_date) AS original_due_date,
  p.first_import_id,coalesce(a.import_id,p.first_import_id) AS latest_import_id,
  CASE WHEN p.receipt_id IS NULL THEN 'MANUAL_VALIDATION' ELSE 'ERP_RECEIVED' END AS source_kind,
  coalesce(a.revision,0::bigint) AS receipt_revision,
  r.amount_cents AS original_received_amount_cents,r.payment_date AS original_payment_date
 FROM public.receivable_receipts r
 LEFT JOIN public.receivable_receipt_import_provenance p ON p.receipt_id=r.id
 LEFT JOIN LATERAL(SELECT x.* FROM public.receivable_receipt_adjustments x WHERE x.receipt_id=r.id ORDER BY x.revision DESC LIMIT 1)a ON true;

CREATE FUNCTION public.validate_receivable_payment_v2(
 p_title_id uuid,p_decision text,p_payment_date date,p_received_cents bigint,p_adjustment_reason text,
 p_observation text,p_expected_revision bigint,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_title public.receivable_titles%ROWTYPE;v_request cf_private.receivable_financial_validation_requests%ROWTYPE;
 v_id uuid;v_delay integer;v_band text;v_adjustment bigint;
 v_reason text:=CASE WHEN nullif(cf_private.normalize_receivable_text(p_adjustment_reason),'') IS NOT NULL THEN btrim(p_adjustment_reason) END;
 v_observation text:=CASE WHEN nullif(cf_private.normalize_receivable_text(p_observation),'') IS NOT NULL THEN btrim(p_observation) END;
 v_payload text;v_result jsonb;v_revision bigint;
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);
 PERFORM cf_private.require_receivable_finance('validate');
 IF p_title_id IS NULL OR p_request_id IS NULL OR p_decision IS NULL OR p_decision NOT IN('CONFIRM','NOT_LOCATED')
  OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 1 AND 9007199254740991
  OR length(coalesce(p_observation,''))>5000 OR length(coalesce(p_adjustment_reason,''))>5000 THEN
  RAISE EXCEPTION 'Confira a solicitação e os campos da validação.' USING ERRCODE='22023';END IF;
 v_payload:=encode(sha256(convert_to(jsonb_build_object('title_id',p_title_id,'decision',p_decision,
  'payment_date',p_payment_date,'received_cents',p_received_cents,'adjustment_reason',v_reason,
  'observation',v_observation,'expected_revision',p_expected_revision)::text,'UTF8')),'hex');
 SELECT * INTO v_request FROM cf_private.receivable_financial_validation_requests
  WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN
  IF v_request.payload_sha256<>v_payload THEN
   RAISE EXCEPTION 'O protocolo já foi utilizado com outra conferência.' USING ERRCODE='22023';END IF;
  RETURN v_request.result;
 END IF;
 SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id AND scope='grupo-consolidado' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='P0002';END IF;
 IF v_title.retired_from_report THEN
  RAISE EXCEPTION 'Título retirado pelo relatório completo. Confirme pelo relatório de títulos quitados.' USING ERRCODE='PV001';END IF;
 IF EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=p_title_id) THEN
  RAISE EXCEPTION 'Já existe recebimento validado para este título.' USING ERRCODE='PV003';END IF;
 IF v_title.revision<>p_expected_revision THEN
  RAISE EXCEPTION 'O título mudou. Atualize a fila antes de validar.' USING ERRCODE='40001';END IF;
 IF v_title.status<>'PENDING_VALIDATION' OR v_title.validation_status<>'PENDING'
  OR v_title.payment_source IS NULL OR v_title.payment_source NOT IN('COBRANCA','IMPORTACAO_DIARIA') THEN
  RAISE EXCEPTION 'O título não está pendente de validação financeira.' USING ERRCODE='PV002';END IF;
 IF p_decision='CONFIRM' THEN
  IF p_payment_date IS NULL OR p_payment_date<DATE '1900-01-01' OR p_payment_date>v_today THEN
   RAISE EXCEPTION 'Informe a data real do recebimento, até hoje.' USING ERRCODE='PV004';END IF;
  IF p_received_cents IS NULL OR p_received_cents<0 OR p_received_cents>9007199254740991
   OR p_received_cents>v_title.amount_cents OR(v_title.amount_cents>0 AND p_received_cents=0) THEN
   RAISE EXCEPTION 'Informe o valor líquido recebido em centavos, até o valor original.' USING ERRCODE='PV005';END IF;
  v_adjustment:=v_title.amount_cents-p_received_cents;
  IF(v_adjustment>0 AND v_reason IS NULL) OR(v_adjustment=0 AND v_reason IS NOT NULL) THEN
   RAISE EXCEPTION 'Justifique o desconto ou a retenção correspondente à diferença.' USING ERRCODE='PV006';END IF;
  v_delay:=greatest(0,p_payment_date-v_title.due_date);
  v_band:=CASE WHEN v_delay<=30 THEN 'ATE_30' WHEN v_delay<=60 THEN '31_60' WHEN v_delay<=90 THEN '61_90'
   WHEN v_delay<=180 THEN '91_180' WHEN v_delay<=365 THEN '181_365' ELSE 'ACIMA_365' END;
  INSERT INTO public.receivable_receipts(title_id,amount_cents,payment_date,delay_days,delay_band,collector_id,
   payment_source,reported_in_collection,validated_by,manual_nominal_amount_cents,manual_original_due_date,manual_adjustment_cents,manual_adjustment_reason)
  VALUES(p_title_id,p_received_cents,p_payment_date,v_delay,v_band,v_title.collector_id,v_title.payment_source,
   v_title.reported_in_collection,auth.uid(),v_title.amount_cents,v_title.due_date,v_adjustment,v_reason) RETURNING id INTO v_id;
  UPDATE public.receivable_titles SET status='VALIDATED',validation_status='VALIDATED',payment_date=p_payment_date,
   next_action=NULL,next_action_date=NULL WHERE id=p_title_id RETURNING revision INTO v_revision;
  INSERT INTO public.receivable_collection_events(title_id,collector_id,action,observation,payment_date,created_by)
   VALUES(p_title_id,v_title.collector_id,'VALIDATE',v_observation,p_payment_date,auth.uid());
 ELSE
  IF p_payment_date IS NOT NULL OR p_received_cents IS NOT NULL OR v_reason IS NOT NULL THEN
   RAISE EXCEPTION 'Pagamento não localizado não aceita valor recebido, retenção ou data.' USING ERRCODE='22023';END IF;
  IF v_title.collector_id IS NULL OR v_observation IS NULL THEN
   RAISE EXCEPTION 'A devolução exige cobradora atribuída e justificativa.' USING ERRCODE='PV006';END IF;
  PERFORM public.validate_receivable_payment(p_title_id,p_decision,NULL,v_observation,p_expected_revision);
  SELECT revision INTO v_revision FROM public.receivable_titles WHERE id=p_title_id;
 END IF;
 v_result:=jsonb_build_object('format_version','053','request_id',p_request_id,'title_id',p_title_id,'decision',p_decision,
  'receipt_id',v_id,'payment_date',p_payment_date,'nominal_cents',v_title.amount_cents,'received_cents',p_received_cents,
  'adjustment_cents',v_adjustment,'adjustment_reason',v_reason,'title_revision',v_revision);
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 SELECT id,username,role_key,'contas_receber','receivable_financial_validation',p_title_id::text,'VALIDATE',to_jsonb(v_title),
  v_result||jsonb_build_object('original_due_date',v_title.due_date,'observation',v_observation)
 FROM public.profiles WHERE id=auth.uid();
 INSERT INTO cf_private.receivable_financial_validation_requests(actor_id,request_id,payload_sha256,result)
 VALUES(auth.uid(),p_request_id,v_payload,v_result);
 RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION public.validate_receivable_payment_v2(uuid,text,date,bigint,text,text,bigint,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.validate_receivable_payment_v2(uuid,text,date,bigint,text,text,bigint,uuid) TO authenticated;
COMMENT ON FUNCTION public.validate_receivable_payment_v2(uuid,text,date,bigint,text,text,bigint,uuid) IS
 'Valida valor líquido e desconto/retenção separados do nominal, em uma data real. Protocolo imutável evita duplicidade em repetição de confirmação. Títulos retirados exigem relatório de quitados.';
INSERT INTO public.central_schema_migrations(version) VALUES('053_receivable_financial_validation');
$cf053ddl$;
END $cf053$;
NOTIFY pgrst,'reload schema';
COMMIT;
