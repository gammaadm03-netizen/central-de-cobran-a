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
