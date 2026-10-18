-- Contas a Pagar: oito semanas sábado/sexta e previsões fixas sem duplicidade.
-- Incremental: requer 005 e o registro de versões instalado em 007; não requer 013.
-- Não cria lançamentos, não modifica importações e não recalcula posições salvas.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.central_schema_migrations') IS NULL OR to_regclass('public.payable_titles') IS NULL THEN
    RAISE EXCEPTION 'Ative Contas a Pagar (005 a 007) antes desta atualização.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='005_payables') THEN
    RAISE EXCEPTION 'Ative Contas a Pagar (005 a 007) antes desta atualização.' USING ERRCODE='22023';
  END IF;
END $$;

CREATE TABLE public.payable_forecast_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL CHECK(rule_key IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS')),
  label text NOT NULL,
  macro text NOT NULL REFERENCES public.payable_macros(name),
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 0 AND 9007199254740991),
  day_of_month integer NOT NULL CHECK(day_of_month BETWEEN 1 AND 28),
  effective_from date NOT NULL CHECK(effective_from>=DATE '1900-01-01'),
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  CHECK(macro=CASE WHEN rule_key IN ('SALARIOS','SALARIOS_SOCIOS') THEN 'SALÁRIOS' ELSE 'ADIANTAMENTO' END)
);
CREATE INDEX payable_forecast_rules_latest ON public.payable_forecast_rules(rule_key,effective_from DESC,created_at DESC,id DESC);
-- Valores e dias recuperados da versão anterior. Vigência inicia hoje, sem histórico inventado.
INSERT INTO public.payable_forecast_rules(rule_key,label,macro,amount_cents,day_of_month,effective_from,observation) VALUES
 ('SALARIOS','Salários','SALÁRIOS',4600000,5,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'Configuração inicial preservada da Central V75.'),
 ('SALARIOS_SOCIOS','Salários Sócios','SALÁRIOS',3300000,5,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'Configuração inicial preservada da Central V75.'),
 ('ADIANTAMENTO','Adiantamento','ADIANTAMENTO',2300000,20,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'Configuração inicial preservada da Central V75.'),
 ('ADIANTAMENTO_SOCIOS','Adiantamento Sócios','ADIANTAMENTO',3300000,20,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'Configuração inicial preservada da Central V75.');

CREATE TABLE public.payable_forecast_plan_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan text NOT NULL REFERENCES public.payable_plan_mappings(plan) ON DELETE RESTRICT,
  rule_key text CHECK(rule_key IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS')),
  effective_from date NOT NULL CHECK(effective_from>=DATE '1900-01-01'),
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT
);
CREATE INDEX payable_forecast_bindings_latest ON public.payable_forecast_plan_bindings(plan,effective_from DESC,created_at DESC,id DESC);
CREATE TABLE public.payable_forecast_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL CHECK(rule_key IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS')),
  month date NOT NULL CHECK(month=date_trunc('month',month)::date),
  done boolean NOT NULL,
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT
);
CREATE INDEX payable_forecast_completions_latest ON public.payable_forecast_completions(rule_key,month,created_at DESC,id DESC);

CREATE FUNCTION cf_private.block_payable_forecast_history() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
  RAISE EXCEPTION 'O histórico das previsões é imutável. Registre uma nova revisão.' USING ERRCODE='42501';
END $$;
CREATE FUNCTION cf_private.audit_payable_forecast_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;v_before jsonb;v_action text;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  IF TG_TABLE_NAME='payable_forecast_rules' THEN
    SELECT to_jsonb(r) INTO v_before FROM public.payable_forecast_rules r WHERE r.rule_key=NEW.rule_key AND r.id<>NEW.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
  ELSIF TG_TABLE_NAME='payable_forecast_plan_bindings' THEN
    SELECT to_jsonb(r) INTO v_before FROM public.payable_forecast_plan_bindings r WHERE r.plan=NEW.plan AND r.id<>NEW.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
  ELSE
    SELECT to_jsonb(r) INTO v_before FROM public.payable_forecast_completions r WHERE r.rule_key=NEW.rule_key AND r.month=NEW.month AND r.id<>NEW.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
  END IF;
  IF TG_TABLE_NAME='payable_forecast_completions' THEN v_action:=CASE WHEN NEW.done THEN 'VALIDATE' ELSE 'REOPEN' END;
  ELSE v_action:=CASE WHEN v_before IS NULL THEN 'CREATE' ELSE 'UPDATE' END; END IF;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar',TG_TABLE_NAME,NEW.id::text,v_action,v_before,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER payable_forecast_rule_immutable BEFORE UPDATE OR DELETE ON public.payable_forecast_rules
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_forecast_history();
CREATE TRIGGER payable_forecast_binding_immutable BEFORE UPDATE OR DELETE ON public.payable_forecast_plan_bindings
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_forecast_history();
CREATE TRIGGER payable_forecast_completion_immutable BEFORE UPDATE OR DELETE ON public.payable_forecast_completions
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_forecast_history();
CREATE TRIGGER payable_forecast_rule_audit AFTER INSERT ON public.payable_forecast_rules
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_forecast_revision();
CREATE TRIGGER payable_forecast_binding_audit AFTER INSERT ON public.payable_forecast_plan_bindings
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_forecast_revision();
CREATE TRIGGER payable_forecast_completion_audit AFTER INSERT ON public.payable_forecast_completions
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_forecast_revision();
ALTER TABLE public.payable_forecast_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_forecast_plan_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_forecast_completions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payable_forecast_rules,public.payable_forecast_plan_bindings,public.payable_forecast_completions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_forecast_rules,public.payable_forecast_plan_bindings,public.payable_forecast_completions TO authenticated;
CREATE POLICY payable_forecast_rules_read ON public.payable_forecast_rules FOR SELECT TO authenticated USING(cf_private.has_permission('contas_pagar','read'));
CREATE POLICY payable_forecast_bindings_read ON public.payable_forecast_plan_bindings FOR SELECT TO authenticated USING(cf_private.has_permission('contas_pagar','read'));
CREATE POLICY payable_forecast_completions_read ON public.payable_forecast_completions FOR SELECT TO authenticated USING(cf_private.has_permission('contas_pagar','read'));

CREATE FUNCTION public.save_payable_forecast_rule(p_rule_key text,p_amount_cents bigint,p_day_of_month integer,
 p_effective_from date,p_observation text,p_expected_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.payable_forecast_rules%ROWTYPE;v_cycle public.payable_forecast_rules%ROWTYPE;v_id uuid;v_month date;
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('contas_pagar','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_rule_key IS NULL OR p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 0 AND 9007199254740991
    OR p_day_of_month IS NULL OR p_day_of_month NOT BETWEEN 1 AND 28 OR p_effective_from IS NULL
    OR p_effective_from<v_today OR p_effective_from>v_today+366 OR p_observation IS NULL
    OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe valor em centavos, dia de 1 a 28, vigência a partir de hoje e observação.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812308);
  SELECT * INTO v_previous FROM public.payable_forecast_rules WHERE rule_key=p_rule_key ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous.id IS NULL THEN RAISE EXCEPTION 'Previsão inexistente.' USING ERRCODE='22023'; END IF;
  IF v_previous.id IS DISTINCT FROM p_expected_id THEN RAISE EXCEPTION 'A regra mudou. Atualize antes de salvar.' USING ERRCODE='40001'; END IF;
  IF p_effective_from<v_previous.effective_from THEN
    RAISE EXCEPTION 'A vigência não pode anteceder a última revisão. Corrija a partir dessa data ou de um mês posterior.' USING ERRCODE='22023'; END IF;
  v_month:=date_trunc('month',p_effective_from)::date;
  SELECT * INTO v_cycle FROM public.payable_forecast_rules r WHERE r.rule_key=p_rule_key
    AND r.effective_from<=v_month+(r.day_of_month-1) ORDER BY r.effective_from DESC,r.created_at DESC,r.id DESC LIMIT 1;
  -- Mesmo na ativação inicial, o dia histórico do ciclo não pode reaparecer
  -- mais tarde no mesmo mês por alteração de regra. Escolha o próximo mês.
  IF v_cycle.id IS NULL THEN v_cycle:=v_previous; END IF;
  IF p_effective_from>v_month+(v_cycle.day_of_month-1) THEN
    RAISE EXCEPTION 'O dia previsto desse ciclo já passou na data de vigência. Escolha o primeiro dia do mês seguinte para preservar o ciclo.' USING ERRCODE='22023'; END IF;
  INSERT INTO public.payable_forecast_rules(rule_key,label,macro,amount_cents,day_of_month,effective_from,observation,created_by,created_at)
    VALUES(p_rule_key,v_previous.label,v_previous.macro,p_amount_cents,p_day_of_month,p_effective_from,btrim(p_observation),auth.uid(),
      greatest(clock_timestamp(),v_previous.created_at+interval '1 microsecond')) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.map_payable_forecast_plan(p_plan text,p_rule_key text,p_effective_from date,
 p_observation text,p_expected_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_plan text;v_macro text;v_previous public.payable_forecast_plan_bindings%ROWTYPE;v_id uuid;
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.has_permission('contas_pagar','write') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  v_plan:=cf_private.normalize_payable_plan(p_plan);
  SELECT macro INTO v_macro FROM public.payable_plan_mappings WHERE plan=v_plan;
  IF v_macro IS NULL OR (p_rule_key IS NOT NULL AND (p_rule_key NOT IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS')
    OR v_macro IS DISTINCT FROM CASE WHEN p_rule_key IN ('SALARIOS','SALARIOS_SOCIOS') THEN 'SALÁRIOS' ELSE 'ADIANTAMENTO' END))
    OR p_effective_from IS NULL OR p_effective_from<v_today OR p_effective_from>v_today+366
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Escolha um plano conhecido, uma previsão do mesmo macro (ou nenhuma), vigência e observação.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812308);
  SELECT * INTO v_previous FROM public.payable_forecast_plan_bindings WHERE plan=v_plan ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous.id IS DISTINCT FROM p_expected_id THEN RAISE EXCEPTION 'O vínculo mudou. Atualize antes de salvar.' USING ERRCODE='40001'; END IF;
  INSERT INTO public.payable_forecast_plan_bindings(plan,rule_key,effective_from,observation,created_by,created_at)
    VALUES(v_plan,p_rule_key,p_effective_from,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),v_previous.created_at+interval '1 microsecond'))
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.set_payable_forecast_completion(p_rule_key text,p_month date,p_done boolean,
 p_observation text,p_expected_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.payable_forecast_completions%ROWTYPE;v_id uuid;
 v_month date:=date_trunc('month',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date)::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.has_permission('contas_pagar','write') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_rule_key IS NULL OR p_rule_key NOT IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS') OR p_month IS NULL
    OR p_month<>date_trunc('month',p_month)::date OR p_month<v_month OR p_month>(v_month+interval '1 year')::date
    OR p_done IS NULL OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe a previsão, um mês atual ou futuro e o motivo da conclusão/reabertura.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812308);
  SELECT * INTO v_previous FROM public.payable_forecast_completions WHERE rule_key=p_rule_key AND month=p_month ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous.id IS DISTINCT FROM p_expected_id THEN RAISE EXCEPTION 'A conclusão mudou. Atualize antes de salvar.' USING ERRCODE='40001'; END IF;
  INSERT INTO public.payable_forecast_completions(rule_key,month,done,observation,created_by,created_at)
    VALUES(p_rule_key,p_month,p_done,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),v_previous.created_at+interval '1 microsecond'))
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Cálculo interno: não é uma rota de leitura alternativa às permissões do RPC.
CREATE FUNCTION cf_private.payable_forecast_provision(p_rule_key text,p_month date,p_imported boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_rule public.payable_forecast_rules%ROWTYPE;v_done public.payable_forecast_completions%ROWTYPE;
 v_due date;v_actual numeric:=0;v_remaining numeric;v_issues jsonb:='[]'::jsonb;
BEGIN
  SELECT * INTO v_rule FROM public.payable_forecast_rules r WHERE r.rule_key=p_rule_key
    AND r.effective_from<=p_month+(r.day_of_month-1)
    ORDER BY r.effective_from DESC,r.created_at DESC,r.id DESC LIMIT 1;
  IF v_rule.id IS NULL THEN RETURN NULL; END IF;
  v_due:=p_month+(v_rule.day_of_month-1);
  SELECT * INTO v_done FROM public.payable_forecast_completions WHERE rule_key=p_rule_key AND month=p_month ORDER BY created_at DESC,id DESC LIMIT 1;
  IF NOT p_imported THEN v_issues:=v_issues||jsonb_build_array('Importe o relatório completo de Contas a Pagar.'); END IF;
  -- Um plano de salários/adiantamento não vinculado deixa as duas previsões desse
  -- macro pendentes; não adivinhamos quais títulos pertencem aos sócios.
  IF EXISTS(SELECT 1 FROM public.payable_titles t LEFT JOIN LATERAL(
      SELECT b.id FROM public.payable_forecast_plan_bindings b WHERE b.plan=t.plan AND b.effective_from<=v_due
        ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON true
    WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.macro=v_rule.macro AND b.id IS NULL) THEN
    v_issues:=v_issues||jsonb_build_array('Vincule os planos deste macro à previsão correta ou a nenhuma previsão.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.payable_titles t JOIN LATERAL(
      SELECT b.rule_key FROM public.payable_forecast_plan_bindings b WHERE b.plan=t.plan AND b.effective_from<=v_due
        ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON b.rule_key=p_rule_key
    WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.macro<>v_rule.macro) THEN
    v_issues:=v_issues||jsonb_build_array('O macro do título mudou; revise o vínculo da previsão.');
  END IF;
  -- Inclui quitados para não ressuscitar a previsão depois da baixa por importação.
  SELECT coalesce(sum(t.amount_cents),0) INTO v_actual FROM public.payable_titles t JOIN LATERAL(
    SELECT b.rule_key FROM public.payable_forecast_plan_bindings b WHERE b.plan=t.plan AND b.effective_from<=v_due
      ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON b.rule_key=p_rule_key
    WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.macro=v_rule.macro;
  IF v_actual>9007199254740991 THEN RAISE EXCEPTION 'O realizado mensal excede o limite de precisão.' USING ERRCODE='22003'; END IF;
  IF EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date
      AND EXISTS(SELECT 1 FROM public.payable_titles selected JOIN LATERAL(
        SELECT b.rule_key FROM public.payable_forecast_plan_bindings b WHERE b.plan=selected.plan AND b.effective_from<=v_due
          ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON b.rule_key=p_rule_key
        WHERE selected.branch=t.branch AND selected.entry_number=t.entry_number
          AND selected.due_date>=p_month AND selected.due_date<(p_month+interval '1 month')::date)
      GROUP BY t.branch,t.entry_number HAVING count(DISTINCT t.source_key)>1) THEN
    v_issues:=v_issues||jsonb_build_array('Há versões ou parcelas do mesmo lançamento no mês. Confira e conclua o ciclo quando não houver previsão restante.');
  END IF;
  IF p_imported THEN
    IF coalesce(v_done.done,false) THEN v_remaining:=0;
    ELSIF jsonb_array_length(v_issues)=0 THEN v_remaining:=greatest(v_rule.amount_cents::numeric-v_actual,0); END IF;
  END IF;
  RETURN jsonb_build_object('rule_key',p_rule_key,'rule_id',v_rule.id,'label',v_rule.label,'macro',v_rule.macro,
    'month',p_month,'due_date',v_due,'expected_cents',v_rule.amount_cents,'actual_cents',CASE WHEN p_imported AND jsonb_array_length(v_issues)=0 THEN v_actual ELSE NULL END,
    'remaining_cents',v_remaining,'completion_id',v_done.id,'done',coalesce(v_done.done,false),'issues',v_issues);
END $$;

CREATE FUNCTION public.payables_forecast(p_start date DEFAULT NULL) RETURNS jsonb
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
    SELECT coalesce(sum(amount_cents),0),count(*)::integer,coalesce(sum(amount_cents) FILTER(WHERE upper(btrim(source_status))='CHEQUE'),0),
      (count(*) FILTER(WHERE upper(btrim(source_status))='CHEQUE'))::integer INTO v_real,v_count,v_cheques,v_cheque_count
      FROM public.payable_titles WHERE scope='grupo-consolidado' AND status IN ('NEW','OPEN') AND due_date BETWEEN v_week AND v_end;
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
      LEFT JOIN(SELECT macro,sum(amount_cents) real_cents FROM public.payable_titles WHERE scope='grupo-consolidado' AND status IN ('NEW','OPEN')
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

REVOKE ALL ON FUNCTION cf_private.block_payable_forecast_history(),cf_private.audit_payable_forecast_revision(),
 cf_private.payable_forecast_provision(text,date,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.save_payable_forecast_rule(text,bigint,integer,date,text,uuid),
 public.map_payable_forecast_plan(text,text,date,text,uuid),public.set_payable_forecast_completion(text,date,boolean,text,uuid),
 public.payables_forecast(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_payable_forecast_rule(text,bigint,integer,date,text,uuid),
 public.map_payable_forecast_plan(text,text,date,text,uuid),public.set_payable_forecast_completion(text,date,boolean,text,uuid),
 public.payables_forecast(date) TO authenticated;
COMMENT ON FUNCTION public.payables_forecast(date) IS 'Oito semanas sábado/sexta. Previsões reduzem pelo realizado mensal vinculado, inclusive quitados; planos sem vínculo e chaves ambíguas exigem conferência. Cheques integram os reais, sem soma em duplicidade.';
COMMENT ON COLUMN public.payable_forecast_plan_bindings.rule_key IS 'NULL com revisão existente significa decisão explícita: este plano não reduz nenhuma previsão. Ausência de vínculo não significa NULL configurado.';
INSERT INTO public.central_schema_migrations(version) VALUES('014_payables_forecast');
COMMIT;
