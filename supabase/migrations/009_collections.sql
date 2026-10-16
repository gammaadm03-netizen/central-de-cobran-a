-- Central Financeira: carteira individual, contato e validação financeira.
-- Aplicar após 008. Não cria dados financeiros nem presume vínculos de cobradoras.
BEGIN;

ALTER TABLE public.receivable_titles ADD COLUMN last_action text;
ALTER TABLE public.receivable_titles ADD COLUMN next_action text;
ALTER TABLE public.receivable_titles ADD COLUMN next_action_date date;

CREATE TABLE public.receivable_collection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id uuid NOT NULL REFERENCES public.receivable_titles(id) ON DELETE RESTRICT,
  collector_id uuid REFERENCES public.collection_agents(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','NOT_LOCATED_CONTACT','OTHER','PAYMENT_DATE','VALIDATE','PAYMENT_NOT_LOCATED')),
  contact_date date,
  next_action text CHECK(next_action IN ('CONTACT','NO_RESPONSE','PROMISE','RETRY','OTHER')),
  next_date date,
  observation text CHECK(length(observation)<=5000),
  return_note text CHECK(length(return_note)<=5000),
  payment_date date,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX collection_events_title_date ON public.receivable_collection_events(title_id,created_at DESC,id);
CREATE INDEX collection_events_collector_date ON public.receivable_collection_events(collector_id,created_at DESC,id);
CREATE TABLE public.receivable_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id uuid NOT NULL UNIQUE REFERENCES public.receivable_titles(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 0 AND 9007199254740991),
  payment_date date NOT NULL,
  delay_days integer NOT NULL CHECK(delay_days>=0),
  delay_band text NOT NULL CHECK(delay_band IN ('ATE_30','31_60','61_90','91_180','181_365','ACIMA_365')),
  collector_id uuid REFERENCES public.collection_agents(id) ON DELETE RESTRICT,
  payment_source text NOT NULL CHECK(payment_source IN ('IMPORTACAO_DIARIA','COBRANCA')),
  reported_in_collection boolean NOT NULL,
  validation text NOT NULL DEFAULT 'VALIDADO' CHECK(validation='VALIDADO'),
  validated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  validated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX receivable_receipts_payment ON public.receivable_receipts(payment_date,payment_source);
CREATE INDEX receivable_receipts_collector ON public.receivable_receipts(collector_id,payment_date);
ALTER TABLE public.receivable_collection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY collection_events_read ON public.receivable_collection_events FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read') OR (
   cf_private.has_permission('cobranca','read') AND collector_id=cf_private.current_collector_id()
   AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=title_id AND t.collector_id=cf_private.current_collector_id())));
CREATE POLICY receivable_receipts_read ON public.receivable_receipts FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read') OR (
   cf_private.has_permission('cobranca','read') AND collector_id=cf_private.current_collector_id()
   AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=title_id AND t.collector_id=cf_private.current_collector_id())));
CREATE TRIGGER collection_events_immutable BEFORE UPDATE OR DELETE ON public.receivable_collection_events
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER receivable_receipts_immutable BEFORE UPDATE OR DELETE ON public.receivable_receipts
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();

CREATE FUNCTION cf_private.require_receivable_finance(p_action text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT cf_private.has_permission('contas_receber',p_action) OR NOT EXISTS(
    SELECT 1 FROM public.profiles WHERE id=auth.uid() AND enabled AND role_key IN ('gerente_geral','contas_receber')) THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
END;
$$;
CREATE FUNCTION cf_private.require_collection_title(p_title public.receivable_titles) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT cf_private.has_permission('cobranca','write') OR NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND (
      p.role_key IN ('gerente_geral','contas_receber') OR
      (p.role_key IN ('cobradora_1','cobradora_2') AND p_title.collector_id IS NOT NULL
       AND p_title.collector_id=cf_private.current_collector_id()))) THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
END;
$$;

CREATE FUNCTION public.assign_receivable_collector(p_customer_key text,p_collector_id uuid,p_observation text) RETURNS integer
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
  PERFORM id FROM public.receivable_titles WHERE customer_key=p_customer_key AND status<>'VALIDATED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente sem dívida ativa para atribuir.' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.receivable_titles WHERE customer_key=p_customer_key AND status<>'VALIDATED'
      AND ((collector_id IS NOT NULL AND collector_id<>p_collector_id) OR (collector_id IS NULL AND collector_locked))) THEN
    RAISE EXCEPTION 'Este cliente já possui carteira ou vínculo bloqueado. A responsável foi preservada.' USING ERRCODE='23514';
  END IF;
  UPDATE public.receivable_titles SET collector_id=p_collector_id
    WHERE customer_key=p_customer_key AND status<>'VALIDATED' AND collector_id IS NULL AND NOT collector_locked;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    SELECT id,username,role_key,'contas_receber','customer_assignment',p_customer_key,'ASSIGNMENT',
      jsonb_build_object('collector_id',p_collector_id,'assigned_count',v_count,'observation',btrim(p_observation))
    FROM public.profiles WHERE id=auth.uid();
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.record_collection_action(
 p_title_id uuid,p_action text,p_contact_date date,p_next_action text,p_next_date date,p_observation text,
 p_return_note text,p_payment_date date,p_expected_revision bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE; v_id uuid; v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id FOR UPDATE;
  -- Missing IDs and somebody else's IDs have the same response.
  IF NOT FOUND THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  PERFORM cf_private.require_collection_title(v_title);
  IF p_expected_revision IS NULL OR v_title.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'O título mudou. Atualize a tela antes de registrar a ação.' USING ERRCODE='40001';
  END IF;
  IF v_title.status='VALIDATED' THEN RAISE EXCEPTION 'Este título já foi validado.' USING ERRCODE='23514'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','NOT_LOCATED_CONTACT','OTHER')
    OR p_contact_date IS NULL OR p_contact_date<DATE '1900-01-01' OR p_contact_date>v_today
    OR (p_next_action IS NOT NULL AND p_next_action NOT IN ('CONTACT','NO_RESPONSE','PROMISE','RETRY','OTHER'))
    OR (p_next_date IS NOT NULL AND (p_next_date<DATE '1900-01-01' OR p_next_action IS NULL))
    OR length(coalesce(p_observation,''))>5000 OR length(coalesce(p_return_note,''))>5000
    OR (p_action='OTHER' AND length(btrim(coalesce(p_observation,'')))=0)
    OR (p_action<>'PAID' AND p_payment_date IS NOT NULL) THEN
    RAISE EXCEPTION 'Revise ação, datas e observações.' USING ERRCODE='23514';
  END IF;
  IF p_action='PAID' THEN
    IF p_payment_date IS NULL OR p_payment_date<DATE '1900-01-01' OR p_payment_date>v_today THEN
      RAISE EXCEPTION 'Informe a data real do pagamento, até hoje.' USING ERRCODE='23514';
    END IF;
    IF v_title.validation_status='PENDING' OR v_title.status='PENDING_VALIDATION' THEN
      RAISE EXCEPTION 'O pagamento já está aguardando validação financeira.' USING ERRCODE='23514';
    END IF;
    UPDATE public.receivable_titles SET status='PENDING_VALIDATION',validation_status='PENDING',payment_source='COBRANCA',
      payment_reported_date=p_payment_date,payment_date=NULL,reported_in_collection=true,last_action=p_action,
      next_action=p_next_action,next_action_date=p_next_date WHERE id=p_title_id;
  ELSE
    -- Contatos nunca retiram um pagamento da fila nem trocam sua origem.
    UPDATE public.receivable_titles SET last_action=p_action,next_action=p_next_action,next_action_date=p_next_date WHERE id=p_title_id;
  END IF;
  INSERT INTO public.receivable_collection_events(title_id,collector_id,action,contact_date,next_action,next_date,
    observation,return_note,payment_date,created_by)
    VALUES(p_title_id,v_title.collector_id,p_action,p_contact_date,p_next_action,p_next_date,
      nullif(btrim(p_observation),''),nullif(btrim(p_return_note),''),p_payment_date,auth.uid()) RETURNING id INTO v_id;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    SELECT id,username,role_key,'cobranca','receivable_collection_events',v_id::text,'CREATE',
      jsonb_build_object('title_id',p_title_id,'collector_id',v_title.collector_id,'action',p_action)
    FROM public.profiles WHERE id=auth.uid();
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.set_receivable_payment_date(p_title_id uuid,p_payment_date date,p_expected_revision bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE; v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  PERFORM cf_private.require_receivable_finance('write');
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='P0002'; END IF;
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

CREATE FUNCTION public.validate_receivable_payment(
 p_title_id uuid,p_decision text,p_payment_date date,p_observation text,p_expected_revision bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE; v_id uuid; v_delay integer; v_band text;
 v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  PERFORM cf_private.require_receivable_finance('validate');
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='P0002'; END IF;
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
      last_action='PAYMENT_NOT_LOCATED',next_action='RETRY',next_action_date=NULL WHERE id=p_title_id;
  END IF;
  INSERT INTO public.receivable_collection_events(title_id,collector_id,action,next_action,observation,payment_date,created_by)
    VALUES(p_title_id,v_title.collector_id,CASE WHEN p_decision='CONFIRM' THEN 'VALIDATE' ELSE 'PAYMENT_NOT_LOCATED' END,
      CASE WHEN p_decision='NOT_LOCATED' THEN 'RETRY' ELSE NULL END,nullif(btrim(p_observation),''),p_payment_date,auth.uid());
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    SELECT id,username,role_key,'contas_receber','receivable_validation',p_title_id::text,'VALIDATE',to_jsonb(v_title),
      jsonb_build_object('decision',p_decision,'receipt_id',v_id,'payment_date',p_payment_date,'observation',nullif(btrim(p_observation),''))
    FROM public.profiles WHERE id=auth.uid();
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.receivables_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_open numeric;v_overdue numeric;v_period numeric;v_count bigint;v_pending bigint;v_unassigned bigint;
 v_received numeric;v_latest timestamptz;v_bps numeric;
BEGIN
  IF NOT(cf_private.has_permission('contas_receber','read') OR cf_private.has_permission('painel','read')) THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>3660 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(sum(amount_cents),0),
    coalesce(sum(amount_cents) FILTER(WHERE due_date<(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date),0),
    coalesce(sum(amount_cents) FILTER(WHERE due_date BETWEEN p_start AND p_end),0),count(*),
    count(*) FILTER(WHERE validation_status='PENDING'),count(*) FILTER(WHERE collector_id IS NULL)
    INTO v_open,v_overdue,v_period,v_count,v_pending,v_unassigned FROM public.receivable_titles WHERE status<>'VALIDATED';
  SELECT coalesce(sum(amount_cents),0) INTO v_received FROM public.receivable_receipts
    WHERE validation='VALIDADO' AND payment_source='IMPORTACAO_DIARIA' AND payment_date BETWEEN p_start AND p_end;
  IF greatest(v_open,v_overdue,v_period,v_count,v_pending,v_unassigned,v_received)>9007199254740991 THEN
    RAISE EXCEPTION 'O consolidado excede o limite de precisão.' USING ERRCODE='22003';
  END IF;
  SELECT max(created_at) INTO v_latest FROM public.receivable_imports;
  v_bps:=CASE WHEN v_open=0 THEN NULL ELSE round(v_overdue*10000/v_open) END;
  RETURN jsonb_build_object('open_cents',v_open,'overdue_cents',v_overdue,'period_cents',v_period,
    'active_count',v_count,'pending_count',v_pending,'unassigned_count',v_unassigned,
    'received_period_cents',v_received,'latest_import_at',v_latest,'overdue_bps',v_bps,'overdue_comlurb_cents',NULL);
END;
$$;

REVOKE ALL ON TABLE public.receivable_collection_events,public.receivable_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.receivable_collection_events,public.receivable_receipts TO authenticated;
REVOKE ALL ON FUNCTION cf_private.require_receivable_finance(text),cf_private.require_collection_title(public.receivable_titles)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assign_receivable_collector(text,uuid,text),
 public.record_collection_action(uuid,text,date,text,date,text,text,date,bigint),
 public.set_receivable_payment_date(uuid,date,bigint),public.validate_receivable_payment(uuid,text,date,text,bigint),
 public.receivables_summary(date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assign_receivable_collector(text,uuid,text),
 public.record_collection_action(uuid,text,date,text,date,text,text,date,bigint),
 public.set_receivable_payment_date(uuid,date,bigint),public.validate_receivable_payment(uuid,text,date,text,bigint),
 public.receivables_summary(date,date) TO authenticated;
COMMENT ON TABLE public.receivable_receipts IS 'Recebimentos efetivamente validados. Valor e faixa na data real preservados; comissão futura somente quando reported_in_collection e VALIDADO.';
COMMENT ON TABLE public.receivable_collection_events IS 'Histórico imutável. Cobradora lê somente sua carteira e seus próprios eventos.';
INSERT INTO public.central_schema_migrations(version) VALUES('009_collections');
COMMIT;
