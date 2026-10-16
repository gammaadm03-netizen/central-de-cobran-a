-- Resumo da Diretoria: complementos oficiais diários e fórmula sem M49.
-- Aplicar uma única vez após 012. Não altera posições financeiras ou históricos.
BEGIN;

-- A versão anterior incluiu os cinco caixas e a décima segunda conta bancária.
-- Não permitir um relatório aparentemente completo ainda limitado às onze contas.
DO $$
BEGIN
  IF to_regclass('public.central_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Aplique a atualização 012 das contas e caixas antes do Resumo da Diretoria.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='012_treasury_accounts') THEN
    RAISE EXCEPTION 'Aplique a atualização 012 das contas e caixas antes do Resumo da Diretoria.' USING ERRCODE='22023';
  END IF;
END;
$$;

CREATE FUNCTION cf_private.normalize_director_inputs(p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_key text; v_value numeric; v_result jsonb := '{}'::jsonb; v_count integer := 0;
  v_keys text[] := ARRAY['turnover_month_cents','turnover_comlurb_cents','orders_cents',
    'blocked_orders_cents','pending_orders_cents','overdue_comlurb_cents',
    'installments_cents','previous_month_taxes_cents'];
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' OR octet_length(p_values::text)>4096 THEN
    RAISE EXCEPTION 'Informe os indicadores oficiais em centavos.' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_values) k WHERE NOT(k=ANY(v_keys))) THEN
    RAISE EXCEPTION 'Existe um indicador não autorizado.' USING ERRCODE='22023';
  END IF;
  FOREACH v_key IN ARRAY v_keys LOOP
    IF p_values->v_key IS NULL OR jsonb_typeof(p_values->v_key)='null' THEN
      v_result := v_result || jsonb_build_object(v_key,NULL);
    ELSE
      IF jsonb_typeof(p_values->v_key)<>'number' THEN
        RAISE EXCEPTION 'Indicador %: informe um inteiro não negativo em centavos.',v_key USING ERRCODE='22023';
      END IF;
      v_value := (p_values->>v_key)::numeric;
      IF v_value<>trunc(v_value) OR v_value NOT BETWEEN 0 AND 9007199254740991 THEN
        RAISE EXCEPTION 'Indicador %: valor fora do limite de precisão.',v_key USING ERRCODE='22023';
      END IF;
      v_result := v_result || jsonb_build_object(v_key,v_value::bigint);
      v_count := v_count+1;
    END IF;
  END LOOP;
  IF v_count=0 THEN
    RAISE EXCEPTION 'Informe ao menos um indicador; campo vazio permanece desconhecido.' USING ERRCODE='22023';
  END IF;
  IF (v_result->>'turnover_month_cents')::numeric+(v_result->>'turnover_comlurb_cents')::numeric>9007199254740991 THEN
    RAISE EXCEPTION 'O faturamento geral excede o limite de precisão.' USING ERRCODE='22003';
  END IF;
  RETURN v_result;
END;
$$;

CREATE TABLE public.director_report_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_date date NOT NULL CHECK (reference_date>=DATE '1900-01-01'),
  values jsonb NOT NULL CHECK (values=cf_private.normalize_director_inputs(values)),
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT
);
CREATE INDEX director_report_inputs_latest
  ON public.director_report_inputs(reference_date DESC,created_at DESC,id DESC);
ALTER TABLE public.director_report_inputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.director_report_inputs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.director_report_inputs TO authenticated;
CREATE POLICY director_report_inputs_read ON public.director_report_inputs FOR SELECT TO authenticated
  USING(cf_private.has_permission('resumo_diretoria','read'));

CREATE FUNCTION cf_private.block_director_history_changes() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'O histórico da Diretoria é imutável. Registre uma nova posição.' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER director_report_inputs_append_only BEFORE UPDATE OR DELETE ON public.director_report_inputs
  FOR EACH ROW EXECUTE FUNCTION cf_private.block_director_history_changes();
CREATE TRIGGER director_positions_append_only BEFORE UPDATE OR DELETE ON public.director_positions
  FOR EACH ROW EXECUTE FUNCTION cf_private.block_director_history_changes();

CREATE FUNCTION public.read_director_inputs(p_reference_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.director_report_inputs%ROWTYPE;
BEGIN
  IF NOT cf_private.has_permission('resumo_diretoria','read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01'
    OR p_reference_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'Informe uma data até hoje em São Paulo.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_row FROM public.director_report_inputs WHERE reference_date=p_reference_date
    ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_row.id IS NULL THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE FUNCTION public.save_director_inputs(
  p_reference_date date,p_values jsonb,p_observation text,p_expected_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.director_report_inputs%ROWTYPE;v_new public.director_report_inputs%ROWTYPE;
  v_values jsonb;v_actor public.profiles%ROWTYPE;
BEGIN
  -- Ordem igual à administração de perfis e à gravação das posições oficiais.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('resumo_diretoria','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01'
    OR p_reference_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe uma data até hoje e uma observação de até 1.000 caracteres.' USING ERRCODE='22023';
  END IF;
  v_values := cf_private.normalize_director_inputs(p_values);
  PERFORM pg_advisory_xact_lock(2045812307);
  SELECT * INTO v_previous FROM public.director_report_inputs WHERE reference_date=p_reference_date
    ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous.id IS DISTINCT FROM p_expected_id THEN
    RAISE EXCEPTION 'Os indicadores foram atualizados. Recarregue antes de salvar.' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.director_report_inputs(reference_date,values,observation,created_by,created_at)
    VALUES(p_reference_date,v_values,btrim(p_observation),auth.uid(),
      greatest(clock_timestamp(),v_previous.created_at+interval '1 microsecond')) RETURNING * INTO v_new;
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'resumo_diretoria','director_report_inputs',v_new.id::text,
      CASE WHEN v_previous.id IS NULL THEN 'CREATE' ELSE 'UPDATE' END,
      CASE WHEN v_previous.id IS NULL THEN NULL ELSE to_jsonb(v_previous) END,to_jsonb(v_new));
  RETURN v_new.id;
END;
$$;

CREATE FUNCTION public.director_report(p_start date,p_end date) RETURNS jsonb
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
    SELECT coalesce(sum(amount_cents),0) INTO v_merchandise FROM public.payable_titles
      WHERE scope='grupo-consolidado' AND status IN ('NEW','OPEN') AND macro='COMPRA DE MERCADORIA';
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

ALTER TABLE public.director_positions ALTER COLUMN schema_version SET DEFAULT '0.6.0';
CREATE OR REPLACE FUNCTION public.save_director_position(p_start date,p_end date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_report jsonb;v_data jsonb;v_id uuid;v_actor public.profiles%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('resumo_diretoria','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(2045812307);
  v_report := public.director_report(p_start,p_end);
  v_data := (v_report->'indicators')||jsonb_build_object(
    'cash_accounts',v_report->'cash'->'accounts','report_inputs',v_report->'inputs');
  INSERT INTO public.director_positions(created_by,period_start,period_end,indicators,schema_version)
    VALUES(auth.uid(),p_start,p_end,v_data,'0.6.0') RETURNING id INTO v_id;
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'resumo_diretoria','director_positions',v_id::text,'CREATE',
      jsonb_build_object('period_start',p_start,'period_end',p_end,'indicators',v_data,'schema_version','0.6.0'));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION cf_private.normalize_director_inputs(jsonb),cf_private.block_director_history_changes()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.read_director_inputs(date),public.save_director_inputs(date,jsonb,text,uuid),
  public.director_report(date,date),public.save_director_position(date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_director_inputs(date),public.save_director_inputs(date,jsonb,text,uuid),
  public.director_report(date,date),public.save_director_position(date,date) TO authenticated;
COMMENT ON TABLE public.director_report_inputs IS 'Complementos oficiais manuais da Diretoria por data; revisões imutáveis e auditadas, sem carregar valores antigos para hoje.';
COMMENT ON FUNCTION public.director_report(date,date) IS 'Fórmula oficial sem M49: (caixa + CR + estoque - impostos do mês passado - faturamento geral * 0,14 - mercadoria - parcelamentos) / 1.000.000. Valores ausentes permanecem null.';
INSERT INTO public.central_schema_migrations(version) VALUES('013_director_report');
COMMIT;
