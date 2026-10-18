-- Contas a Pagar: pagamentos financeiros com data, valor efetivo e conta oficial.
-- Incremental após 013 e 014. Preserva títulos, importações e posições bancárias.
-- A ausência em um relatório completo continua distinta de pagamento confirmado.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.central_schema_migrations') IS NULL OR to_regclass('public.bank_accounts') IS NULL THEN
    RAISE EXCEPTION 'Ative Caixa/Bancos e Contas a Pagar antes desta atualização.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='013_director_report')
    OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='014_payables_forecast') THEN
    RAISE EXCEPTION 'Ative as atualizações 013 e 014 antes dos pagamentos de Contas a Pagar.' USING ERRCODE='22023';
  END IF;
END $$;

CREATE TABLE cf_private.payable_payment_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO cf_private.payable_payment_state(singleton) VALUES(true);
REVOKE ALL ON TABLE cf_private.payable_payment_state FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.payable_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id uuid NOT NULL REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL UNIQUE,
  event_revision bigint NOT NULL UNIQUE CHECK(event_revision>0),
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  paid_on date NOT NULL CHECK(paid_on>=DATE '1900-01-01'),
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  bank_label text NOT NULL,
  bank_company text NOT NULL,
  bank_name text NOT NULL,
  account_type text NOT NULL CHECK(account_type IN ('BANK','CASH')),
  macro_snapshot text NOT NULL REFERENCES public.payable_macros(name) ON DELETE RESTRICT,
  entry_number text NOT NULL,
  description text NOT NULL,
  branch text NOT NULL,
  plan_snapshot text NOT NULL,
  due_date date NOT NULL,
  title_amount_cents bigint NOT NULL CHECK(title_amount_cents BETWEEN 0 AND 9007199254740991),
  expected_revision uuid,
  expected_import_id uuid NOT NULL,
  observation text NOT NULL CHECK(length(btrim(observation))<=1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_payments_title ON public.payable_payments(title_id,event_revision DESC);
CREATE INDEX payable_payments_date_macro ON public.payable_payments(paid_on,macro_snapshot,id);
CREATE INDEX payable_payments_bank_date ON public.payable_payments(bank_account_id,paid_on,id);
CREATE TABLE public.payable_payment_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES public.payable_payments(id) ON DELETE RESTRICT,
  event_revision bigint NOT NULL UNIQUE CHECK(event_revision>0),
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.payable_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_payment_reversals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payable_payments,public.payable_payment_reversals FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_payments,public.payable_payment_reversals TO authenticated;
CREATE POLICY payable_payments_read ON public.payable_payments FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_pagar','read'));
CREATE POLICY payable_payment_reversals_read ON public.payable_payment_reversals FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_pagar','read'));

CREATE FUNCTION cf_private.block_payable_payment_history() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
  RAISE EXCEPTION 'O histórico dos pagamentos é imutável. Registre um estorno com motivo.' USING ERRCODE='42501';
END $$;
CREATE FUNCTION cf_private.audit_payable_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;v_before jsonb;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  IF TG_TABLE_NAME='payable_payment_reversals' THEN
    SELECT to_jsonb(p) INTO v_before FROM public.payable_payments p WHERE p.id=NEW.payment_id;
  END IF;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar',TG_TABLE_NAME,NEW.id::text,
      CASE WHEN TG_TABLE_NAME='payable_payments' THEN 'VALIDATE' ELSE 'REOPEN' END,v_before,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER payable_payment_immutable BEFORE UPDATE OR DELETE ON public.payable_payments
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_payment_history();
CREATE TRIGGER payable_payment_reversal_immutable BEFORE UPDATE OR DELETE ON public.payable_payment_reversals
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_payment_history();
CREATE TRIGGER payable_payment_audit AFTER INSERT ON public.payable_payments
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_payment();
CREATE TRIGGER payable_payment_reversal_audit AFTER INSERT ON public.payable_payment_reversals
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_payment();

-- security_invoker mantém as políticas de cada tabela e a sessão aprovada.
CREATE VIEW public.payable_financial_titles WITH(security_invoker=true) AS
 SELECT t.*,
   coalesce(p.paid_cents,0)::bigint AS paid_cents,
   (CASE WHEN t.status IN ('NEW','OPEN') OR coalesce(p.paid_cents,0)>0
     THEN greatest(t.amount_cents-coalesce(p.paid_cents,0),0) ELSE 0 END)::bigint AS outstanding_cents,
   greatest(coalesce(p.paid_cents,0)-t.amount_cents,0)::bigint AS overpaid_cents,
   greatest(t.amount_cents-coalesce(p.paid_cents,0),0)::bigint AS payment_remaining_cents,
   CASE WHEN coalesce(p.paid_cents,0)>t.amount_cents THEN 'OVERPAID'
     WHEN coalesce(p.paid_cents,0)=t.amount_cents AND coalesce(p.paid_cents,0)>0 THEN 'PAID'
     WHEN coalesce(p.paid_cents,0)>0 THEN 'PARTIAL'
     WHEN t.status='SETTLED_IMPORT' THEN 'PENDING_RECONCILIATION' ELSE 'OPEN' END AS financial_status,
   p.last_payment_date,last_bank.bank_label AS last_payment_bank,revision.id AS payment_revision
 FROM public.payable_titles t
 LEFT JOIN LATERAL(SELECT sum(p.amount_cents) paid_cents,max(p.paid_on) last_payment_date
   FROM public.payable_payments p WHERE p.title_id=t.id
     AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) p ON true
 LEFT JOIN LATERAL(SELECT p.bank_label FROM public.payable_payments p WHERE p.title_id=t.id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)
   ORDER BY p.paid_on DESC,p.event_revision DESC LIMIT 1) last_bank ON true
 LEFT JOIN LATERAL(SELECT e.id FROM (
   SELECT p.id,p.event_revision FROM public.payable_payments p WHERE p.title_id=t.id
   UNION ALL SELECT r.id,r.event_revision FROM public.payable_payment_reversals r
     JOIN public.payable_payments p ON p.id=r.payment_id WHERE p.title_id=t.id
 ) e ORDER BY e.event_revision DESC LIMIT 1) revision ON true;
REVOKE ALL ON TABLE public.payable_financial_titles FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_financial_titles TO authenticated;

CREATE FUNCTION public.get_payables_revision() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_import uuid;v_revision bigint;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  SELECT id INTO v_import FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
  SELECT revision INTO v_revision FROM cf_private.payable_payment_state WHERE singleton;
  RETURN jsonb_build_object('import_id',v_import,'financial_revision',v_revision::text);
END $$;
CREATE FUNCTION public.get_payable_payment_accounts() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  RETURN(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'company',a.company,'bank',a.bank,
    'account_label',a.account_label,'account_type',a.account_type,'display_name',a.display_name) ORDER BY a.display_name,a.id),'[]'::jsonb)
    FROM public.bank_accounts a WHERE a.enabled);
END $$;

CREATE FUNCTION public.register_payable_payment(p_title_id uuid,p_amount_cents bigint,p_paid_on date,
 p_bank_account_id uuid,p_observation text,p_expected_revision uuid,p_request_id uuid,p_expected_import_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.payable_titles%ROWTYPE;v_bank public.bank_accounts%ROWTYPE;v_existing public.payable_payments%ROWTYPE;
 v_paid numeric;v_revision uuid;v_counter bigint;v_id uuid;v_observation text:=btrim(coalesce(p_observation,''));
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.has_permission('contas_pagar','read') OR NOT cf_private.has_permission('contas_pagar','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_title_id IS NULL OR p_request_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 1 AND 9007199254740991
    OR p_paid_on IS NULL OR p_paid_on<DATE '1900-01-01'
    OR p_paid_on>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_bank_account_id IS NULL OR length(v_observation) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe título, valor positivo em centavos, data real até hoje e banco/caixa oficial.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
  PERFORM pg_advisory_xact_lock(2045812309);
  SELECT * INTO v_existing FROM public.payable_payments WHERE request_id=p_request_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.created_by=auth.uid() AND v_existing.title_id=p_title_id AND v_existing.amount_cents=p_amount_cents
      AND v_existing.paid_on=p_paid_on AND v_existing.bank_account_id=p_bank_account_id
      AND v_existing.observation=v_observation AND v_existing.expected_revision IS NOT DISTINCT FROM p_expected_revision
      AND v_existing.expected_import_id IS NOT DISTINCT FROM p_expected_import_id THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'A identificação desta solicitação já foi usada com outros dados.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_title FROM public.payable_titles WHERE id=p_title_id AND scope='grupo-consolidado' FOR UPDATE;
  IF v_title.id IS NULL THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='22023'; END IF;
  IF v_title.last_import_id IS DISTINCT FROM p_expected_import_id THEN
    RAISE EXCEPTION 'O título foi atualizado por importação. Confira o valor e vencimento antes de registrar.' USING ERRCODE='40001'; END IF;
  SELECT payment_revision,paid_cents INTO v_revision,v_paid FROM public.payable_financial_titles WHERE id=p_title_id;
  IF v_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'O título recebeu outra conciliação. Atualize antes de registrar.' USING ERRCODE='40001'; END IF;
  IF p_amount_cents::numeric>v_title.amount_cents::numeric-v_paid THEN
    RAISE EXCEPTION 'O valor pago excede o saldo do título. Confira pagamentos anteriores e diferenças antes de continuar.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_bank FROM public.bank_accounts WHERE id=p_bank_account_id AND enabled FOR SHARE;
  IF v_bank.id IS NULL THEN RAISE EXCEPTION 'Selecione uma conta oficial ativa.' USING ERRCODE='22023'; END IF;
  IF (SELECT coalesce(sum(p.amount_cents),0) FROM public.payable_payments p
      WHERE NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id))+p_amount_cents::numeric>9007199254740991 THEN
    RAISE EXCEPTION 'O realizado excede o limite de precisão.' USING ERRCODE='22003'; END IF;
  UPDATE cf_private.payable_payment_state SET revision=revision+1 WHERE singleton RETURNING revision INTO v_counter;
  INSERT INTO public.payable_payments(title_id,request_id,event_revision,amount_cents,paid_on,bank_account_id,
    bank_label,bank_company,bank_name,account_type,macro_snapshot,entry_number,description,branch,plan_snapshot,due_date,
    title_amount_cents,expected_revision,expected_import_id,observation,created_by)
    VALUES(v_title.id,p_request_id,v_counter,p_amount_cents,p_paid_on,v_bank.id,v_bank.display_name,v_bank.company,v_bank.bank,
      v_bank.account_type,v_title.macro,v_title.entry_number,v_title.description,v_title.branch,v_title.plan,v_title.due_date,
      v_title.amount_cents,p_expected_revision,p_expected_import_id,v_observation,auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.cancel_payable_payment(p_payment_id uuid,p_observation text,p_expected_revision uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payment public.payable_payments%ROWTYPE;v_revision uuid;v_existing public.payable_payment_reversals%ROWTYPE;
 v_counter bigint;v_id uuid;v_observation text:=btrim(coalesce(p_observation,''));
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.has_permission('contas_pagar','read') OR NOT cf_private.has_permission('contas_pagar','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_payment_id IS NULL OR length(v_observation) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe o pagamento e o motivo do estorno.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
  PERFORM pg_advisory_xact_lock(2045812309);
  SELECT * INTO v_payment FROM public.payable_payments WHERE id=p_payment_id;
  IF v_payment.id IS NULL THEN RAISE EXCEPTION 'Pagamento não encontrado.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_existing FROM public.payable_payment_reversals WHERE payment_id=p_payment_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.created_by=auth.uid() AND v_existing.observation=v_observation THEN RETURN v_existing.id; END IF;
    RAISE EXCEPTION 'Este pagamento já foi estornado.' USING ERRCODE='22023'; END IF;
  SELECT payment_revision INTO v_revision FROM public.payable_financial_titles WHERE id=v_payment.title_id;
  IF v_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'O título recebeu outra conciliação. Atualize antes de estornar.' USING ERRCODE='40001'; END IF;
  UPDATE cf_private.payable_payment_state SET revision=revision+1 WHERE singleton RETURNING revision INTO v_counter;
  INSERT INTO public.payable_payment_reversals(payment_id,event_revision,observation,created_by)
    VALUES(p_payment_id,v_counter,v_observation,auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.payable_payment_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total numeric;v_count integer;v_macros jsonb;v_pending integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end<p_start OR p_end-p_start>3660 THEN
    RAISE EXCEPTION 'Informe o período real de pagamento.' USING ERRCODE='22023'; END IF;
  SELECT coalesce(sum(p.amount_cents),0),count(*)::integer INTO v_total,v_count FROM public.payable_payments p
    WHERE p.paid_on BETWEEN p_start AND p_end AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id);
  IF v_total>9007199254740991 THEN RAISE EXCEPTION 'O realizado excede o limite de precisão.' USING ERRCODE='22003'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('macro',m.name,'amount_cents',coalesce(p.amount_cents,0),'count',coalesce(p.n,0)) ORDER BY m.name),'[]'::jsonb)
    INTO v_macros FROM public.payable_macros m LEFT JOIN(SELECT p.macro_snapshot,sum(p.amount_cents) amount_cents,count(*) n
      FROM public.payable_payments p WHERE p.paid_on BETWEEN p_start AND p_end
      AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id) GROUP BY p.macro_snapshot) p ON p.macro_snapshot=m.name;
  SELECT count(*)::integer INTO v_pending FROM public.payable_financial_titles WHERE financial_status='PENDING_RECONCILIATION';
  RETURN jsonb_build_object('start_date',p_start,'end_date',p_end,'total_paid_cents',v_total,'payment_count',v_count,
    'by_macro',v_macros,'pending_reconciliation_count',v_pending,'revision',public.get_payables_revision());
END $$;

CREATE FUNCTION public.list_payable_payments(p_start date,p_end date,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,
 p_title_id uuid DEFAULT NULL,p_macro text DEFAULT NULL,p_bank_account_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_count integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF (p_title_id IS NULL AND (p_start IS NULL OR p_end IS NULL))
    OR (p_start IS NOT NULL AND p_start<DATE '1900-01-01')
    OR (p_start IS NOT NULL AND p_end IS NOT NULL AND (p_end<p_start OR (p_title_id IS NULL AND p_end-p_start>3660)))
    OR p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Informe um período e paginação válidos.' USING ERRCODE='22023'; END IF;
  SELECT count(*)::integer INTO v_count FROM public.payable_payments p
    LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id
    WHERE (p_start IS NULL OR p.paid_on>=p_start) AND (p_end IS NULL OR p.paid_on<=p_end) AND (p_title_id IS NULL OR p.title_id=p_title_id)
      AND (p_title_id IS NOT NULL OR r.id IS NULL) AND (p_macro IS NULL OR p.macro_snapshot=p_macro)
      AND (p_bank_account_id IS NULL OR p.bank_account_id=p_bank_account_id);
  SELECT coalesce(jsonb_agg(x.row ORDER BY x.paid_on DESC,x.event_revision DESC),'[]'::jsonb) INTO v_rows FROM(
    SELECT p.paid_on,p.event_revision,to_jsonb(p)||jsonb_build_object('cancelled_at',r.created_at,'cancelled_by',r.created_by,
      'cancellation_id',r.id,'cancellation_observation',r.observation,'status',CASE WHEN r.id IS NULL THEN 'ACTIVE' ELSE 'CANCELLED' END,
      'created_by_name',creator.display_name,'created_by_username',creator.username,'cancelled_by_name',canceller.display_name,
      'title_status',financial.status,'financial_status',financial.financial_status) row
    FROM public.payable_payments p LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id
      LEFT JOIN public.profiles creator ON creator.id=p.created_by LEFT JOIN public.profiles canceller ON canceller.id=r.created_by
      JOIN public.payable_financial_titles financial ON financial.id=p.title_id
    WHERE (p_start IS NULL OR p.paid_on>=p_start) AND (p_end IS NULL OR p.paid_on<=p_end) AND (p_title_id IS NULL OR p.title_id=p_title_id)
      AND (p_title_id IS NOT NULL OR r.id IS NULL) AND (p_macro IS NULL OR p.macro_snapshot=p_macro)
      AND (p_bank_account_id IS NULL OR p.bank_account_id=p_bank_account_id)
    ORDER BY p.paid_on DESC,p.event_revision DESC OFFSET p_offset LIMIT p_limit) x;
  RETURN jsonb_build_object('rows',v_rows,'count',v_count,'revision',public.get_payables_revision());
END $$;

-- Agregados usam o saldo financeiro; a fonte importada permanece intacta.
CREATE OR REPLACE FUNCTION public.payables_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_open numeric;v_overdue numeric;v_period numeric;v_count bigint;v_latest timestamptz;
BEGIN
  IF NOT(cf_private.has_permission('contas_pagar','read') OR cf_private.has_permission('painel','read')) THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>3660 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023'; END IF;
  SELECT coalesce(sum(outstanding_cents),0),
    coalesce(sum(outstanding_cents) FILTER(WHERE due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date),0),
    coalesce(sum(outstanding_cents) FILTER(WHERE due_date BETWEEN p_start AND p_end),0),count(*)
    INTO v_open,v_overdue,v_period,v_count FROM public.payable_financial_titles WHERE outstanding_cents>0;
  IF greatest(v_open,v_overdue,v_period,v_count)>9007199254740991 THEN
    RAISE EXCEPTION 'O consolidado excede o limite de precisão. Revise os valores importados.' USING ERRCODE='22003'; END IF;
  SELECT max(created_at) INTO v_latest FROM public.payable_imports;
  RETURN jsonb_build_object('open_cents',v_open,'overdue_cents',v_overdue,'period_cents',v_period,
    'active_count',v_count,'latest_import_at',v_latest);
END $$;

-- Previsões reduzem apenas as obrigações reais pelo saldo financeiro.
-- O abatimento mensal das estimativas continua nominal, inclusive os quitados.
CREATE OR REPLACE FUNCTION public.payables_forecast(p_start date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_current date;v_start date;v_week date;v_end date;v_month date;v_key text;v_provision jsonb;
 v_latest public.payable_imports%ROWTYPE;v_rules jsonb;v_plans jsonb;v_weeks jsonb:='[]'::jsonb;v_provisions jsonb;v_macros jsonb;
 v_real numeric;v_estimate numeric;v_known numeric;v_total numeric;v_cheques numeric;v_count integer;v_cheque_count integer;
 v_missing jsonb:='[]'::jsonb;v_window numeric:=0;v_i integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  v_current:=v_today-((extract(dow FROM v_today)::integer+1)%7);v_start:=coalesce(p_start,v_current);
  IF v_start<v_current OR v_start>v_current+366 OR extract(dow FROM v_start)<>6 THEN
    RAISE EXCEPTION 'Escolha um sábado da semana atual até um ano à frente.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_latest FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_latest.id IS NULL THEN v_missing:=jsonb_build_array('Importe o relatório completo de Contas a Pagar.'); END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.day_of_month,r.rule_key),'[]'::jsonb) INTO v_rules
    FROM(SELECT DISTINCT ON(rule_key) * FROM public.payable_forecast_rules ORDER BY rule_key,created_at DESC,id DESC) r;
  SELECT coalesce(jsonb_agg(jsonb_build_object('plan',m.plan,'macro',m.macro,'rule_key',b.rule_key,
    'mapping_id',b.id,'configured',b.id IS NOT NULL,'effective_from',b.effective_from) ORDER BY m.plan),'[]'::jsonb) INTO v_plans
    FROM public.payable_plan_mappings m LEFT JOIN LATERAL(
      SELECT * FROM public.payable_forecast_plan_bindings b WHERE b.plan=m.plan ORDER BY created_at DESC,id DESC LIMIT 1) b ON true
    WHERE m.macro IN ('SALÁRIOS','ADIANTAMENTO') OR b.id IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.plan=m.plan AND t.macro IN ('SALÁRIOS','ADIANTAMENTO')
        AND t.due_date>=date_trunc('month',v_start)::date
        AND t.due_date<(date_trunc('month',v_start+55)+interval '1 month')::date);
  FOR v_i IN 0..7 LOOP
    v_week:=v_start+v_i*7;v_end:=v_week+6;v_provisions:='[]'::jsonb;
    FOR v_month IN SELECT d::date FROM generate_series(date_trunc('month',v_week),date_trunc('month',v_end),interval '1 month') d LOOP
      FOREACH v_key IN ARRAY ARRAY['SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS'] LOOP
        v_provision:=cf_private.payable_forecast_provision(v_key,v_month,v_latest.id IS NOT NULL);
        IF v_provision IS NOT NULL AND (v_provision->>'due_date')::date BETWEEN v_week AND v_end THEN
          v_provisions:=v_provisions||jsonb_build_array(v_provision);
          IF v_provision->>'remaining_cents' IS NULL THEN v_missing:=v_missing||(v_provision->'issues'); END IF;
        END IF;
      END LOOP;
    END LOOP;
    SELECT coalesce(sum(outstanding_cents),0),count(*)::integer,coalesce(sum(outstanding_cents) FILTER(WHERE upper(btrim(source_status))='CHEQUE'),0),
      (count(*) FILTER(WHERE upper(btrim(source_status))='CHEQUE'))::integer INTO v_real,v_count,v_cheques,v_cheque_count
      FROM public.payable_financial_titles WHERE scope='grupo-consolidado' AND outstanding_cents>0 AND due_date BETWEEN v_week AND v_end;
    SELECT coalesce(sum((p->>'remaining_cents')::numeric),0),
      CASE WHEN count(*) FILTER(WHERE p->>'remaining_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((p->>'remaining_cents')::numeric),0) END
      INTO v_known,v_estimate FROM jsonb_array_elements(v_provisions) p;
    IF v_latest.id IS NULL THEN v_real:=NULL;v_estimate:=NULL;v_cheques:=NULL; END IF;
    v_total:=v_real+v_estimate;v_window:=v_window+coalesce(v_real,0)+v_known;
    IF greatest(coalesce(v_real,0),v_known,coalesce(v_total,0),coalesce(v_cheques,0),v_window)>9007199254740991 THEN
      RAISE EXCEPTION 'A previsão excede o limite de precisão.' USING ERRCODE='22003'; END IF;
    SELECT jsonb_agg(jsonb_build_object('macro',m.name,'real_cents',CASE WHEN v_latest.id IS NOT NULL THEN coalesce(t.real_cents,0) ELSE NULL END,
      'estimated_cents',CASE WHEN v_latest.id IS NULL OR coalesce(p.pending,false) THEN NULL ELSE coalesce(p.estimated_cents,0) END,
      'total_cents',CASE WHEN v_latest.id IS NULL OR coalesce(p.pending,false) THEN NULL ELSE coalesce(t.real_cents,0)+coalesce(p.estimated_cents,0) END) ORDER BY m.name)
      INTO v_macros FROM public.payable_macros m
      LEFT JOIN(SELECT macro,sum(outstanding_cents) real_cents FROM public.payable_financial_titles WHERE scope='grupo-consolidado' AND outstanding_cents>0
        AND due_date BETWEEN v_week AND v_end GROUP BY macro) t ON t.macro=m.name
      LEFT JOIN(SELECT p->>'macro' macro,sum((p->>'remaining_cents')::numeric) estimated_cents,bool_or(p->>'remaining_cents' IS NULL) pending
        FROM jsonb_array_elements(v_provisions) p GROUP BY p->>'macro') p ON p.macro=m.name;
    v_weeks:=v_weeks||jsonb_build_array(jsonb_build_object('start',v_week,'end',v_end,'real_cents',v_real,'estimated_cents',v_estimate,
      'known_estimated_cents',v_known,'total_cents',v_total,'cheques_cents',v_cheques,'cheque_count',v_cheque_count,'title_count',v_count,
      'macros',v_macros,'provisions',v_provisions));
  END LOOP;
  SELECT coalesce(jsonb_agg(issue ORDER BY issue),'[]'::jsonb) INTO v_missing FROM(SELECT DISTINCT value issue FROM jsonb_array_elements(v_missing)) x;
  RETURN jsonb_build_object('as_of_date',v_today,'start_date',v_start,'end_date',v_start+55,
    'latest_import_id',v_latest.id,'latest_import_at',v_latest.created_at,'weeks',v_weeks,'rules',v_rules,'plans',v_plans,'missing_sources',v_missing);
END $$;


-- A posição atual de mercadoria usa o mesmo saldo restante dos demais módulos.
CREATE OR REPLACE FUNCTION public.director_report(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_date date := (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_inputs jsonb;v_values jsonb;v_cash jsonb;v_stock jsonb;v_cp jsonb;v_cr jsonb;v_data jsonb;
  v_turnover numeric;v_merchandise numeric;v_projected numeric;v_assets numeric;v_comlurb numeric;
  v_missing jsonb := '[]'::jsonb;v_field text;v_label text;
BEGIN
  IF NOT cf_private.has_permission('resumo_diretoria','read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end<p_start OR p_end-p_start>366 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  -- A posição gerencial é a de hoje, mesmo quando o fluxo selecionado é histórico.
  -- Complementos de uma data anterior NÃO são promovidos silenciosamente para hoje.
  v_inputs := public.read_director_inputs(v_date);
  v_values := v_inputs->'values';
  v_cash := public.cash_position(v_date);
  v_stock := public.current_stock();
  v_cp := public.payables_summary(p_start,p_end);
  v_cr := public.receivables_summary(p_start,p_end);
  v_turnover := (v_values->>'turnover_month_cents')::numeric+(v_values->>'turnover_comlurb_cents')::numeric;
  IF v_cp->>'latest_import_at' IS NOT NULL THEN
    SELECT coalesce(sum(outstanding_cents),0) INTO v_merchandise FROM public.payable_financial_titles
      WHERE scope='grupo-consolidado' AND outstanding_cents>0 AND macro='COMPRA DE MERCADORIA';
    IF v_merchandise>9007199254740991 THEN
      RAISE EXCEPTION 'O pagamento de mercadoria excede o limite de precisão.' USING ERRCODE='22003';
    END IF;
  END IF;
  IF v_cash->>'total_cents' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Caixa: informe todas as contas.'); END IF;
  IF v_stock->>'value_cents' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Estoque aguardando atualização.'); END IF;
  IF v_cp->>'latest_import_at' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Contas a Pagar: importe o relatório completo.'); END IF;
  IF v_cr->>'latest_import_at' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Contas a Receber: importe o relatório completo.'); END IF;
  FOR v_field,v_label IN SELECT * FROM (VALUES
    ('turnover_month_cents','Faturamento mês'),('turnover_comlurb_cents','Faturamento COMLURB'),
    ('orders_cents','Valor de pedido em sistema'),('blocked_orders_cents','Valor de pedidos bloqueados'),
    ('pending_orders_cents','Valor total pendência'),('overdue_comlurb_cents','Atrasado COMLURB'),
    ('installments_cents','Parcelamentos'),('previous_month_taxes_cents','Impostos do mês passado')
  ) AS fields(field,label) LOOP
    IF v_values->>v_field IS NULL THEN
      v_missing:=v_missing||jsonb_build_array(v_label||': informe a posição de hoje.');
    END IF;
  END LOOP;
  v_comlurb := (v_values->>'overdue_comlurb_cents')::numeric;
  IF v_comlurb IS NOT NULL AND v_cr->>'latest_import_at' IS NOT NULL AND v_comlurb>(v_cr->>'overdue_cents')::numeric THEN
    v_comlurb := NULL;
    v_missing:=v_missing||jsonb_build_array('Atrasado COMLURB excede o total atrasado; revise o complemento.');
  ELSIF v_cr->>'latest_import_at' IS NULL THEN
    v_comlurb := NULL;
  END IF;
  IF v_cash->>'total_cents' IS NOT NULL AND v_cp->>'latest_import_at' IS NOT NULL
    AND v_cr->>'latest_import_at' IS NOT NULL THEN
    v_projected:=(v_cash->>'total_cents')::numeric+(v_cr->>'period_cents')::numeric-(v_cp->>'period_cents')::numeric;
    IF abs(v_projected)>9007199254740991 THEN
      RAISE EXCEPTION 'A projeção excede o limite de precisão.' USING ERRCODE='22003';
    END IF;
  END IF;
  -- Centavos / 100.000.000 = milhões de reais. O fator 14/100 é numeric
  -- exato e pode produzir fração de centavo; não arredondar etapas da fórmula.
  IF v_cr->>'latest_import_at' IS NOT NULL THEN
    v_assets := ((v_cash->>'total_cents')::numeric+(v_cr->>'open_cents')::numeric+(v_stock->>'value_cents')::numeric
      -(v_values->>'previous_month_taxes_cents')::numeric-v_turnover*14/100
      -v_merchandise-(v_values->>'installments_cents')::numeric)/100000000;
  END IF;
  v_data:=jsonb_build_object(
    'turnover_month_cents',v_values->'turnover_month_cents','turnover_comlurb_cents',v_values->'turnover_comlurb_cents',
    'turnover_cents',v_turnover,'orders_cents',v_values->'orders_cents',
    'blocked_orders_cents',v_values->'blocked_orders_cents','pending_orders_cents',v_values->'pending_orders_cents',
    'cash_cents',v_cash->'total_cents','cash_reported_accounts',v_cash->'reported_accounts',
    'cash_expected_accounts',v_cash->'expected_accounts','cash_as_of_date',v_date,
    'payable_open_cents',CASE WHEN v_cp->>'latest_import_at' IS NULL THEN NULL ELSE v_cp->'open_cents' END,
    'payable_period_cents',CASE WHEN v_cp->>'latest_import_at' IS NULL THEN NULL ELSE v_cp->'period_cents' END,
    'payable_overdue_cents',CASE WHEN v_cp->>'latest_import_at' IS NULL THEN NULL ELSE v_cp->'overdue_cents' END,
    'payable_import_at',v_cp->'latest_import_at',
    'stock_cents',v_stock->'value_cents','stock_reference_date',v_stock->'reference_date','stock_source',v_stock->'source',
    'receivable_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'open_cents' END,
    'receivable_period_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'period_cents' END,
    'receivable_overdue_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'overdue_cents' END,
    'receivable_overdue_bps',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'overdue_bps' END,
    'receivable_overdue_comlurb_cents',v_comlurb,
    'receivable_received_period_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'received_period_cents' END,
    'receivable_import_at',v_cr->'latest_import_at',
    'merchandise_cents',v_merchandise,'installments_cents',v_values->'installments_cents',
    'previous_month_taxes_cents',v_values->'previous_month_taxes_cents',
    'projected_cash_cents',v_projected,'current_assets_millions',trim_scale(v_assets)::text,
    'formula_version','2026-10-sem-m49','complete',jsonb_array_length(v_missing)=0,'missing_sources',v_missing,
    'report_input_id',v_inputs->'id','report_input_reference_date',v_inputs->'reference_date',
    'previous_taxes_month',to_char(v_date-interval '1 month','YYYY-MM'));
  RETURN jsonb_build_object('as_of_date',v_date,'inputs',v_inputs,'indicators',v_data,
    'cash',v_cash,'stock',v_stock,'missing_sources',v_missing,'complete',jsonb_array_length(v_missing)=0,
    'formula_version','2026-10-sem-m49');
END;
$$;

REVOKE ALL ON FUNCTION cf_private.block_payable_payment_history(),cf_private.audit_payable_payment()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_payables_revision(),public.get_payable_payment_accounts(),
 public.register_payable_payment(uuid,bigint,date,uuid,text,uuid,uuid,uuid),
 public.cancel_payable_payment(uuid,text,uuid),public.payable_payment_summary(date,date),
 public.list_payable_payments(date,date,integer,integer,uuid,text,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_payables_revision(),public.get_payable_payment_accounts(),
 public.register_payable_payment(uuid,bigint,date,uuid,text,uuid,uuid,uuid),
 public.cancel_payable_payment(uuid,text,uuid),public.payable_payment_summary(date,date),
 public.list_payable_payments(date,date,integer,integer,uuid,text,uuid) TO authenticated;
COMMENT ON TABLE public.payable_payments IS 'Pagamentos financeiros efetivos; data real e centavos informados. Macro, título e banco são preservados como eram no registro. Não altera saldos bancários.';
COMMENT ON TABLE public.payable_payment_reversals IS 'Estorno imutável do pagamento com motivo, autor e horário. Preserva o pagamento original e retira seu efeito dos realizados.';
COMMENT ON VIEW public.payable_financial_titles IS 'Fonte importada preservada. Pagamento parcial mantém saldo restante; ausência sem pagamento fica pendente de conciliação e não produz realizado. Valor reimportado menor que pagamentos gera OVERPAID.';
INSERT INTO public.central_schema_migrations(version) VALUES('015_payable_payments');
COMMIT;
