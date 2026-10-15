-- After 005 and 006. Snapshots preserve incomplete sources explicitly.
BEGIN;

CREATE TABLE public.director_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  indicators jsonb NOT NULL,
  schema_version text NOT NULL DEFAULT '0.3.0'
);
CREATE INDEX director_positions_created ON public.director_positions(created_at DESC);
ALTER TABLE public.director_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.director_positions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.director_positions TO authenticated;
CREATE POLICY director_positions_read ON public.director_positions FOR SELECT TO authenticated
  USING (cf_private.has_permission('resumo_diretoria','read'));

CREATE FUNCTION public.save_director_position(p_start date,p_end date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cash jsonb; v_payables jsonb; v_stock jsonb; v_data jsonb;
  v_id uuid; v_profile public.profiles%ROWTYPE;
BEGIN
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('resumo_diretoria','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>366 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  -- Consistent read of all implemented sources; values are computed on the
  -- server rather than accepting a financial position from the browser.
  PERFORM pg_advisory_xact_lock(2045812307);
  SELECT public.cash_position((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date),
         public.payables_summary(p_start,p_end), public.current_stock()
    INTO v_cash,v_payables,v_stock;
  v_data := jsonb_build_object(
    'cash_cents',v_cash->'total_cents',
    'cash_reported_accounts',v_cash->'reported_accounts',
    'cash_expected_accounts',v_cash->'expected_accounts',
    'cash_as_of_date',(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    'payable_open_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'open_cents' END,
    'payable_period_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'period_cents' END,
    'payable_overdue_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'overdue_cents' END,
    'payable_import_at',v_payables->'latest_import_at',
    'stock_cents',v_stock->'value_cents',
    'stock_reference_date',v_stock->'reference_date',
    'stock_source',v_stock->'source',
    'receivable_cents',NULL,'turnover_cents',NULL,'projected_cash_cents',NULL,
    'current_assets_millions',NULL,'complete',false,
    'missing_sources',jsonb_build_array('contas_receber','fechamento','parametros_financeiros')
  );
  INSERT INTO public.director_positions(created_by,period_start,period_end,indicators)
    VALUES(auth.uid(),p_start,p_end,v_data) RETURNING id INTO v_id;
  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_profile.id,v_profile.username,v_profile.role_key,'resumo_diretoria','director_positions',v_id::text,'CREATE',
      jsonb_build_object('period_start',p_start,'period_end',p_end,'indicators',v_data));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_director_position(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_director_position(date,date) TO authenticated;

-- Deployment records are independent from the website's code version.
CREATE TABLE public.central_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.central_schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_schema_migrations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.central_schema_migrations TO authenticated;
CREATE POLICY central_schema_migrations_read ON public.central_schema_migrations FOR SELECT TO authenticated
  USING (cf_private.is_manager());
INSERT INTO public.central_schema_migrations(version) VALUES ('005_payables'),('006_treasury'),('007_director_positions');
COMMIT;
