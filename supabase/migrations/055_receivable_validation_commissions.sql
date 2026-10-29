-- Confirmação financeira de títulos trabalhados retirados do relatório completo.
-- Preserva valores originais, histórico, retirada e regras vigentes de comissão.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $cf055$ BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='055_receivable_validation_commissions') THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='053_receivable_financial_validation') THEN
  RAISE EXCEPTION 'Ative o SQL 053 de validação financeira antes da confirmação de títulos retirados.' USING ERRCODE='22023';END IF;
 EXECUTE $cf055ddl$
CREATE OR REPLACE FUNCTION public.validate_receivable_payment_v2(
 p_title_id uuid,p_decision text,p_payment_date date,p_received_cents bigint,p_adjustment_reason text,
 p_observation text,p_expected_revision bigint,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_title public.receivable_titles%ROWTYPE;v_request cf_private.receivable_financial_validation_requests%ROWTYPE;
 v_id uuid;v_delay integer;v_band text;v_adjustment bigint;v_worked boolean;v_source text;v_reported boolean;
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
 IF EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=p_title_id) THEN
  RAISE EXCEPTION 'Já existe recebimento validado para este título.' USING ERRCODE='PV003';END IF;
 IF v_title.revision<>p_expected_revision THEN
  RAISE EXCEPTION 'O título mudou. Atualize a fila antes de validar.' USING ERRCODE='40001';END IF;
 IF v_title.retired_from_report THEN
  -- A ausência mantém o título pendente: somente a decisão financeira explícita
  -- com valor e data reais confirma o recebimento. O trabalho já deve existir.
  v_worked:=cf_private.receivable_report_title_worked(p_title_id,clock_timestamp());
  IF p_decision<>'CONFIRM' OR NOT v_worked THEN
   RAISE EXCEPTION 'A validação de título retirado exige trabalho de cobrança e confirmação explícita do recebimento.' USING ERRCODE='PV001';END IF;
  IF v_title.status NOT IN('NEW','OPEN','NOT_LOCATED','PENDING_VALIDATION') OR v_title.validation_status NOT IN('NONE','PENDING') THEN
   RAISE EXCEPTION 'O título não está pendente de confirmação do recebimento.' USING ERRCODE='PV002';END IF;
  v_source:=coalesce(v_title.payment_source,'COBRANCA');v_reported:=true;
 ELSE
  IF v_title.status<>'PENDING_VALIDATION' OR v_title.validation_status<>'PENDING'
   OR v_title.payment_source IS NULL OR v_title.payment_source NOT IN('COBRANCA','IMPORTACAO_DIARIA') THEN
   RAISE EXCEPTION 'O título não está pendente de validação financeira.' USING ERRCODE='PV002';END IF;
  v_source:=v_title.payment_source;v_reported:=v_title.reported_in_collection;
 END IF;
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
  VALUES(p_title_id,p_received_cents,p_payment_date,v_delay,v_band,v_title.collector_id,v_source,
   v_reported,auth.uid(),v_title.amount_cents,v_title.due_date,v_adjustment,v_reason) RETURNING id INTO v_id;
  UPDATE public.receivable_titles SET status='VALIDATED',validation_status='VALIDATED',payment_date=p_payment_date,
   payment_source=v_source,reported_in_collection=v_reported,next_action=NULL,next_action_date=NULL WHERE id=p_title_id RETURNING revision INTO v_revision;
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
 v_result:=jsonb_build_object('format_version','055','request_id',p_request_id,'title_id',p_title_id,'decision',p_decision,
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
 'Valida valor líquido e desconto/retenção separados do nominal, em uma data real. Protocolo imutável evita duplicidade em repetição de confirmação. Títulos retirados trabalhados podem ser confirmados financeiramente com valor e data efetivos, preservando a retirada e o histórico.';

-- Consulta financeira exclusiva dos títulos trabalhados retirados do relatório.
-- A permissão de leitura admite Diretoria; a gravação continua exigindo validate.
CREATE FUNCTION public.receivable_retired_validation_queue(p_search text DEFAULT '',p_collector_id uuid DEFAULT NULL,
 p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_rows jsonb;v_count bigint;BEGIN
 IF NOT cf_private.has_permission('contas_receber','read') OR NOT EXISTS(
  SELECT 1 FROM public.profiles WHERE id=auth.uid() AND enabled AND role_key IN('gerente_geral','contas_receber','diretor')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_search IS NULL OR length(p_search)>500 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'Filtros inválidos para a confirmação financeira.' USING ERRCODE='22023';END IF;
 WITH pending AS MATERIALIZED(
  SELECT t.id,t.scope,t.document,t.client_name,t.branch,t.due_date,t.amount_cents,t.collector_id,
   t.payment_source,t.payment_reported_date,t.revision,t.status,t.validation_status,t.retired_from_report,true AS collection_worked
  FROM public.receivable_titles t
  WHERE t.scope='grupo-consolidado' AND t.retired_from_report
   AND t.status IN('NEW','OPEN','NOT_LOCATED','PENDING_VALIDATION') AND t.validation_status IN('NONE','PENDING')
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.title_id=t.id)
   AND (p_collector_id IS NULL OR t.collector_id=p_collector_id)
   AND (p_search='' OR position(lower(btrim(p_search)) IN lower(concat_ws(' ',t.document,t.client_name,t.branch)))>0)
   AND cf_private.receivable_report_title_worked(t.id,statement_timestamp())
 ) SELECT (SELECT count(*) FROM pending),coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.due_date,p.id)
  FROM(SELECT * FROM pending ORDER BY due_date,id OFFSET p_offset LIMIT p_limit)p),'[]'::jsonb)
 INTO v_count,v_rows;
 RETURN jsonb_build_object('format_version','055','count',v_count,'rows',v_rows);
END $fn$;
REVOKE ALL ON FUNCTION public.receivable_retired_validation_queue(text,uuid,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.receivable_retired_validation_queue(text,uuid,integer,integer) TO authenticated;
COMMENT ON FUNCTION public.receivable_retired_validation_queue(text,uuid,integer,integer) IS
 'Títulos retirados, com movimento de cobrança anterior e sem recebimento validado. Consulta não confirma pagamento; a decisão exige validate_receivable_payment_v2.';
INSERT INTO public.central_schema_migrations(version) VALUES('055_receivable_validation_commissions');
$cf055ddl$;
END $cf055$;
NOTIFY pgrst,'reload schema';
COMMIT;
