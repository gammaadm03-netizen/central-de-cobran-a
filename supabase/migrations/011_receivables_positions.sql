-- Add current receivables to new snapshots; historical positions are immutable.
BEGIN;
ALTER TABLE public.director_positions ALTER COLUMN schema_version SET DEFAULT '0.4.0';

CREATE OR REPLACE FUNCTION public.save_director_position(p_start date,p_end date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cash jsonb; v_payables jsonb; v_stock jsonb; v_receivables jsonb; v_data jsonb;
  v_id uuid; v_profile public.profiles%ROWTYPE; v_projected numeric;
  v_missing jsonb := '["fechamento","parametros_financeiros","classificacao_comlurb"]'::jsonb;
BEGIN
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('resumo_diretoria','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>366 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(2045812307);
  SELECT public.cash_position((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date),
         public.payables_summary(p_start,p_end),public.current_stock(),public.receivables_summary(p_start,p_end)
    INTO v_cash,v_payables,v_stock,v_receivables;
  IF v_cash->>'total_cents' IS NULL THEN v_missing:=v_missing||'["saldos_bancarios"]'::jsonb; END IF;
  IF v_stock->>'value_cents' IS NULL THEN v_missing:=v_missing||'["estoque"]'::jsonb; END IF;
  IF v_payables->>'latest_import_at' IS NULL THEN v_missing:=v_missing||'["contas_pagar"]'::jsonb; END IF;
  IF v_receivables->>'latest_import_at' IS NULL THEN v_missing:=v_missing||'["contas_receber"]'::jsonb; END IF;
  IF v_cash->>'total_cents' IS NOT NULL AND v_payables->>'latest_import_at' IS NOT NULL
      AND v_receivables->>'latest_import_at' IS NOT NULL THEN
    v_projected:=(v_cash->>'total_cents')::numeric+(v_receivables->>'period_cents')::numeric-(v_payables->>'period_cents')::numeric;
    IF abs(v_projected)>9007199254740991 THEN
      RAISE EXCEPTION 'A projeção excede o limite de precisão.' USING ERRCODE='22003';
    END IF;
  END IF;
  v_data:=jsonb_build_object(
    'cash_cents',v_cash->'total_cents','cash_reported_accounts',v_cash->'reported_accounts',
    'cash_expected_accounts',v_cash->'expected_accounts',
    'cash_as_of_date',(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    'payable_open_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'open_cents' END,
    'payable_period_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'period_cents' END,
    'payable_overdue_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'overdue_cents' END,
    'payable_import_at',v_payables->'latest_import_at',
    'stock_cents',v_stock->'value_cents','stock_reference_date',v_stock->'reference_date','stock_source',v_stock->'source',
    'receivable_cents',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'open_cents' END,
    'receivable_period_cents',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'period_cents' END,
    'receivable_overdue_cents',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'overdue_cents' END,
    'receivable_overdue_bps',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'overdue_bps' END,
    'receivable_received_period_cents',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'received_period_cents' END,
    'receivable_import_at',v_receivables->'latest_import_at',
    'turnover_cents',NULL,'projected_cash_cents',v_projected,'current_assets_millions',NULL,
    'complete',false,'missing_sources',v_missing);
  INSERT INTO public.director_positions(created_by,period_start,period_end,indicators,schema_version)
    VALUES(auth.uid(),p_start,p_end,v_data,'0.4.0') RETURNING id INTO v_id;
  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_profile.id,v_profile.username,v_profile.role_key,'resumo_diretoria','director_positions',v_id::text,'CREATE',
      jsonb_build_object('period_start',p_start,'period_end',p_end,'indicators',v_data,'schema_version','0.4.0'));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_director_position(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_director_position(date,date) TO authenticated;
INSERT INTO public.central_schema_migrations(version) VALUES('011_receivables_positions');
COMMIT;
