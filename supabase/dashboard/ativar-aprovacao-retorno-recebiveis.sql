-- CENTRAL FINANCEIRA — aprovação individual de retorno na importação (057).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 047 e inclui as atualizações 053, 055 e 056, quando necessárias.
-- Aprovar apenas registra a decisão. Retorno e eventual estorno só ocorrem na confirmação do arquivo.
-- Nenhum título real é alterado por esta instalação. Não há atualização de Edge Function.

-- CENTRAL FINANCEIRA — estorno auditado de validação financeira (056).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 047. Inclui os SQLs 053 e 055 quando ainda não ativados.
-- Preserva os recebimentos originais e não estorna nenhum título automaticamente.
-- Somente a Gerência Geral pode confirmar um estorno na Central, com justificativa.
-- Não é necessária atualização de Edge Function.

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

-- Estorno auditado de validação financeira incorreta, preservando o recebimento original.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $cf056$ BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='056_receivable_receipt_reversal') THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='055_receivable_validation_commissions') THEN
  RAISE EXCEPTION 'Ative o SQL 055 antes do estorno de validação financeira.' USING ERRCODE='22023';END IF;
 EXECUTE $cf056ddl$
CREATE TABLE public.receivable_receipt_reversals(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 receipt_id uuid NOT NULL UNIQUE REFERENCES public.receivable_receipts(id) ON DELETE RESTRICT,
 title_id uuid NOT NULL REFERENCES public.receivable_titles(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 5000),
 expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 1 AND 9007199254740991),
 payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 original_receipt jsonb NOT NULL CHECK(jsonb_typeof(original_receipt)='object'),
 effective_receipt jsonb NOT NULL CHECK(jsonb_typeof(effective_receipt)='object'),
 original_title jsonb NOT NULL CHECK(jsonb_typeof(original_title)='object'),
 created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(created_by,request_id));
ALTER TABLE public.receivable_receipt_reversals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.receivable_receipt_reversals FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.receivable_receipt_reversals TO authenticated;
CREATE POLICY receivable_receipt_reversals_read ON public.receivable_receipt_reversals FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.id=receipt_id));
CREATE INDEX receivable_receipt_reversals_title ON public.receivable_receipt_reversals(title_id,created_at DESC,id DESC);
CREATE TRIGGER receivable_receipt_reversal_immutable BEFORE UPDATE OR DELETE ON public.receivable_receipt_reversals
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();

-- O vínculo exclusivo dos recebimentos vigentes substitui a unicidade histórica.
-- Assim, o registro estornado permanece imutável e um recebimento correto futuro
-- pode usar o mesmo título sem criar uma nova dívida ou reescrever o anterior.
CREATE TABLE cf_private.receivable_active_receipts(
 title_id uuid PRIMARY KEY REFERENCES public.receivable_titles(id) ON DELETE RESTRICT,
 receipt_id uuid NOT NULL UNIQUE REFERENCES public.receivable_receipts(id) ON DELETE RESTRICT);
ALTER TABLE cf_private.receivable_active_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.receivable_active_receipts FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO cf_private.receivable_active_receipts(title_id,receipt_id) SELECT title_id,id FROM public.receivable_receipts;
ALTER TABLE public.receivable_receipts DROP CONSTRAINT receivable_receipts_title_id_key;
CREATE INDEX receivable_receipts_title_history ON public.receivable_receipts(title_id,validated_at DESC,id);

CREATE FUNCTION cf_private.track_active_receivable_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$ BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);
 PERFORM id FROM public.receivable_titles WHERE id=NEW.title_id FOR UPDATE;
 INSERT INTO cf_private.receivable_active_receipts(title_id,receipt_id) VALUES(NEW.title_id,NEW.id);
 RETURN NEW;
END $fn$;
CREATE TRIGGER track_active_receivable_receipt AFTER INSERT ON public.receivable_receipts
 FOR EACH ROW EXECUTE FUNCTION cf_private.track_active_receivable_receipt();
CREATE FUNCTION cf_private.release_reversed_receivable_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$ DECLARE v_count integer;BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);
 IF NOT EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.id=NEW.receipt_id AND r.title_id=NEW.title_id) THEN
  RAISE EXCEPTION 'O recebimento não pertence ao título informado.' USING ERRCODE='23514';END IF;
 DELETE FROM cf_private.receivable_active_receipts WHERE title_id=NEW.title_id AND receipt_id=NEW.receipt_id;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>1 THEN RAISE EXCEPTION 'O recebimento já não está vigente.' USING ERRCODE='RV001';END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER release_reversed_receivable_receipt AFTER INSERT ON public.receivable_receipt_reversals
 FOR EACH ROW EXECUTE FUNCTION cf_private.release_reversed_receivable_receipt();
CREATE TRIGGER receivable_receipt_reversal_revision AFTER INSERT ON public.receivable_receipt_reversals
 FOR EACH STATEMENT EXECUTE FUNCTION cf_private.bump_receivables_sync_revision();
REVOKE ALL ON FUNCTION cf_private.track_active_receivable_receipt(),cf_private.release_reversed_receivable_receipt()
 FROM PUBLIC,anon,authenticated,service_role;

CREATE VIEW public.active_receivable_receipts WITH(security_invoker=true,security_barrier=true) AS
 SELECT r.* FROM public.receivable_receipts r
 WHERE NOT EXISTS(SELECT 1 FROM public.receivable_receipt_reversals v WHERE v.receipt_id=r.id);
REVOKE ALL ON TABLE public.active_receivable_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.active_receivable_receipts TO authenticated;
COMMENT ON VIEW public.active_receivable_receipts IS 'Recebimentos vigentes. Originais estornados continuam preservados em receivable_receipts e receivable_receipt_reversals.';

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
 FROM public.active_receivable_receipts r
 LEFT JOIN public.receivable_receipt_import_provenance p ON p.receipt_id=r.id
 LEFT JOIN LATERAL(SELECT x.* FROM public.receivable_receipt_adjustments x WHERE x.receipt_id=r.id ORDER BY x.revision DESC LIMIT 1)a ON true;

ALTER TABLE public.receivable_collection_events DROP CONSTRAINT receivable_collection_events_action_check;
ALTER TABLE public.receivable_collection_events ADD CONSTRAINT receivable_collection_events_action_check
 CHECK(action IN('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','NOT_LOCATED_CONTACT','OTHER','PAYMENT_DATE','VALIDATE','PAYMENT_NOT_LOCATED','RECEIPT_REVERSAL'));

CREATE FUNCTION public.reverse_receivable_receipt(p_receipt_id uuid,p_reason text,p_expected_revision bigint,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_receipt public.receivable_receipts%ROWTYPE;v_title public.receivable_titles%ROWTYPE;
 v_effective public.effective_receivable_receipts%ROWTYPE;
 v_existing public.receivable_receipt_reversals%ROWTYPE;v_case public.collection_cases%ROWTYPE;
 v_id uuid:=gen_random_uuid();v_result jsonb;v_revision bigint;v_hash text;v_retry boolean;
 v_reason text:=btrim(coalesce(p_reason,''));v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);
 PERFORM cf_private.require_receivable_finance('validate');
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND enabled AND role_key='gerente_geral') THEN
  RAISE EXCEPTION 'Somente a Gerência Geral pode estornar uma validação financeira.' USING ERRCODE='42501';END IF;
 IF p_receipt_id IS NULL OR p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 1 AND 9007199254740991
  OR length(v_reason) NOT BETWEEN 1 AND 5000 OR nullif(cf_private.normalize_receivable_text(v_reason),'') IS NULL THEN
  RAISE EXCEPTION 'Informe o recebimento, a revisão atual, o motivo e o protocolo do estorno.' USING ERRCODE='22023';END IF;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('receipt_id',p_receipt_id,'reason',v_reason,'expected_revision',p_expected_revision)::text,'UTF8')),'hex');
 SELECT * INTO v_existing FROM public.receivable_receipt_reversals WHERE created_by=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN
  IF v_existing.payload_hash<>v_hash THEN RAISE EXCEPTION 'O protocolo já foi utilizado com outros dados.' USING ERRCODE='22023';END IF;
  RETURN v_existing.result;
 END IF;
 SELECT * INTO v_receipt FROM public.receivable_receipts WHERE id=p_receipt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Recebimento não encontrado.' USING ERRCODE='P0002';END IF;
 SELECT * INTO v_title FROM public.receivable_titles WHERE id=v_receipt.title_id AND scope='grupo-consolidado' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='P0002';END IF;
 IF NOT EXISTS(SELECT 1 FROM cf_private.receivable_active_receipts WHERE receipt_id=p_receipt_id AND title_id=v_title.id)
  OR EXISTS(SELECT 1 FROM public.receivable_receipt_reversals WHERE receipt_id=p_receipt_id) THEN
  RAISE EXCEPTION 'Este recebimento já foi estornado.' USING ERRCODE='RV001';END IF;
 IF v_title.revision<>p_expected_revision THEN RAISE EXCEPTION 'O título mudou. Atualize antes de estornar.' USING ERRCODE='40001';END IF;
 IF v_title.status<>'VALIDATED' OR v_title.validation_status<>'VALIDATED' THEN
  RAISE EXCEPTION 'Confira a situação financeira antes de estornar.' USING ERRCODE='23514';END IF;
 SELECT * INTO v_effective FROM public.effective_receivable_receipts WHERE id=p_receipt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'O recebimento já não está vigente.' USING ERRCODE='RV001';END IF;
 v_retry:=NOT v_title.retired_from_report AND v_title.due_date<v_today AND v_title.collector_id IS NOT NULL;
 UPDATE public.receivable_titles SET status='OPEN',validation_status='NONE',payment_date=NULL,payment_reported_date=NULL,payment_source=NULL,
  collector_locked=CASE WHEN collector_id IS NULL THEN false ELSE collector_locked END,
  last_action='RECEIPT_REVERSAL',next_action=CASE WHEN v_retry THEN 'RETRY' END,next_action_date=CASE WHEN v_retry THEN v_today END
  WHERE id=v_title.id RETURNING revision INTO v_revision;
 INSERT INTO public.collection_cases(title_id,status,observation,next_action,next_date,payment_date,revision,finalized_at,updated_by)
 VALUES(v_title.id,'AGUARDANDO RETORNO',v_reason,CASE WHEN v_retry THEN 'Conferir cobrança após estorno da validação' END,
  CASE WHEN v_retry THEN v_today END,NULL,1,NULL,auth.uid())
 ON CONFLICT(title_id) DO UPDATE SET status=EXCLUDED.status,observation=EXCLUDED.observation,next_action=EXCLUDED.next_action,
  next_date=EXCLUDED.next_date,payment_date=NULL,revision=collection_cases.revision+1,finalized_at=NULL,updated_by=auth.uid(),updated_at=clock_timestamp()
 RETURNING * INTO v_case;
 INSERT INTO public.collection_case_events(title_id,case_revision,status,observation,next_action,next_date,payment_date,finalized,created_by)
 VALUES(v_title.id,v_case.revision,v_case.status,v_reason,v_case.next_action,v_case.next_date,NULL,false,auth.uid());
 INSERT INTO public.receivable_collection_events(title_id,collector_id,action,next_action,next_date,observation,return_note,created_by)
 VALUES(v_title.id,v_title.collector_id,'RECEIPT_REVERSAL',CASE WHEN v_retry THEN 'RETRY' END,CASE WHEN v_retry THEN v_today END,
  v_reason,'Validação financeira estornada; recebimento original preservado no histórico.',auth.uid());
 v_result:=jsonb_build_object('format_version','056','request_id',p_request_id,'reversal_id',v_id,'receipt_id',p_receipt_id,
  'title_id',v_title.id,'title_revision',v_revision,'receipt_amount_cents',v_effective.amount_cents,'payment_date',v_effective.payment_date,
  'nominal_cents',v_title.amount_cents,'due_date',v_title.due_date,'retired_from_report',v_title.retired_from_report,'restored_status','OPEN');
 INSERT INTO public.receivable_receipt_reversals(id,receipt_id,title_id,request_id,reason,expected_revision,payload_hash,result,original_receipt,effective_receipt,original_title,created_by)
 VALUES(v_id,p_receipt_id,v_title.id,p_request_id,v_reason,p_expected_revision,v_hash,v_result,to_jsonb(v_receipt),to_jsonb(v_effective),to_jsonb(v_title),auth.uid());
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 SELECT id,username,role_key,'contas_receber','receivable_receipt_reversals',v_id::text,'REOPEN',
  jsonb_build_object('title',to_jsonb(v_title),'receipt',to_jsonb(v_receipt),'effective_receipt',to_jsonb(v_effective)),v_result||jsonb_build_object('reason',v_reason)
 FROM public.profiles WHERE id=auth.uid();
 RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION public.reverse_receivable_receipt(uuid,text,bigint,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.reverse_receivable_receipt(uuid,text,bigint,uuid) TO authenticated;
COMMENT ON TABLE public.receivable_receipt_reversals IS 'Estornos imutáveis de validações financeiras incorretas. Preservam recibo original, posição efetiva, título, responsável, motivo, autor, horário e protocolo.';

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

INSERT INTO public.central_schema_migrations(version) VALUES('056_receivable_receipt_reversal');
$cf056ddl$;
END $cf056$;
NOTIFY pgrst,'reload schema';
COMMIT;

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
