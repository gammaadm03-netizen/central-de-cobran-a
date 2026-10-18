-- Visão gerencial de Contas a Pagar. Somente leitura; não altera títulos nem caixa.
-- Aplicar uma única vez após 019. Futuro não possui limite de oito semanas.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative as atualizações anteriores de Contas a Pagar.' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='019_payable_cheques') THEN
  RAISE EXCEPTION 'Ative a atualização 019 antes da visão gerencial de Contas a Pagar.' USING ERRCODE='22023';END IF;
END $$;

CREATE FUNCTION public.payables_management_summary(p_week date DEFAULT NULL,p_month date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_start date;v_end date;v_month date;v_month_end date;v_import public.payable_imports%ROWTYPE;
 v_totals jsonb;v_macros jsonb;
BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_week IS NOT NULL AND (p_week<DATE '1900-01-01' OR p_week>DATE '2199-12-31') THEN
  RAISE EXCEPTION 'Informe uma data válida para a semana financeira.' USING ERRCODE='22023';END IF;
 IF p_month IS NOT NULL AND (p_month<DATE '1900-01-01' OR p_month>DATE '2199-12-01'
  OR p_month<>date_trunc('month',p_month)::date) THEN
  RAISE EXCEPTION 'Informe o primeiro dia de um mês válido para consultar os pagamentos.' USING ERRCODE='22023';END IF;
 v_start:=coalesce(p_week,v_today);
 v_start:=v_start-((extract(dow FROM v_start)::integer+1)%7);v_end:=v_start+6;
 v_month:=coalesce(p_month,date_trunc('month',v_today)::date);
 v_month_end:=(v_month+interval '1 month - 1 day')::date;
 SELECT * INTO v_import FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;

 -- Somente versões comprovadamente históricas deixam de compor a obrigação.
 -- Uma ausência na importação não é transformada em pagamento: seu restante
 -- continua acompanhado e a quantidade pendente é apresentada separadamente.
 WITH eligible AS MATERIALIZED(
  SELECT id,macro,due_date,amount_cents,payment_remaining_cents,source_status,status,paid_cents
   FROM public.payable_review_titles WHERE scope='grupo-consolidado' AND closing_eligible
 ),payments AS MATERIALIZED(
  SELECT p.effective_macro,p.amount_cents,p.paid_on FROM public.payable_effective_payments p
   JOIN eligible t ON t.id=p.title_id
   WHERE (p.paid_on BETWEEN v_start AND v_end OR p.paid_on BETWEEN v_month AND v_month_end)
    AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)
 ),title_totals AS(
  SELECT coalesce(sum(amount_cents) FILTER(WHERE due_date BETWEEN v_start AND v_end),0) planned,
   coalesce(sum(payment_remaining_cents) FILTER(WHERE due_date BETWEEN v_start AND v_end),0) open_week,
   coalesce(sum(payment_remaining_cents) FILTER(WHERE due_date>=v_today),0) future,
   coalesce(sum(payment_remaining_cents) FILTER(WHERE due_date<v_today),0) overdue,
   count(*) FILTER(WHERE due_date BETWEEN v_start AND v_end) week_count,
   count(*) FILTER(WHERE due_date>=v_today AND payment_remaining_cents>0) future_count,
   coalesce(sum(payment_remaining_cents) FILTER(WHERE due_date BETWEEN v_start AND v_end AND upper(btrim(source_status))='CHEQUE'),0) cheques,
   count(*) FILTER(WHERE due_date BETWEEN v_start AND v_end AND payment_remaining_cents>0 AND upper(btrim(source_status))='CHEQUE') cheque_count,
   count(*) FILTER(WHERE status='SETTLED_IMPORT' AND paid_cents=0) pending_count FROM eligible
 ),payment_totals AS(SELECT coalesce(sum(amount_cents) FILTER(WHERE paid_on BETWEEN v_start AND v_end),0) paid,
   coalesce(sum(amount_cents) FILTER(WHERE paid_on BETWEEN v_month AND v_month_end),0) monthly_paid,
   count(*) FILTER(WHERE paid_on BETWEEN v_month AND v_month_end) monthly_count FROM payments),title_macros AS(
  SELECT macro,coalesce(sum(amount_cents) FILTER(WHERE due_date BETWEEN v_start AND v_end),0) planned,
   coalesce(sum(payment_remaining_cents) FILTER(WHERE due_date BETWEEN v_start AND v_end),0) open_week,
   coalesce(sum(payment_remaining_cents) FILTER(WHERE due_date>=v_today),0) future,
   coalesce(sum(payment_remaining_cents) FILTER(WHERE due_date<v_today),0) overdue,
   count(*) FILTER(WHERE due_date BETWEEN v_start AND v_end) week_count,
   count(*) FILTER(WHERE due_date>=v_today AND payment_remaining_cents>0) future_count
   FROM eligible GROUP BY macro
 ),payment_macros AS(SELECT effective_macro,sum(amount_cents) paid FROM payments
  WHERE paid_on BETWEEN v_start AND v_end GROUP BY effective_macro)
 SELECT jsonb_build_object('planned_week_cents',t.planned,'paid_week_cents',p.paid,'difference_week_cents',t.planned-p.paid,
   'open_week_cents',t.open_week,'future_cents',t.future,'overdue_cents',t.overdue,
   'week_title_count',t.week_count,'future_title_count',t.future_count,'cheques_week_cents',t.cheques,
   'cheques_week_count',t.cheque_count,'pending_reconciliation_count',t.pending_count,
   'monthly_paid_cents',p.monthly_paid,'monthly_paid_count',p.monthly_count),
  (SELECT jsonb_agg(jsonb_build_object('macro',m.name,'planned_cents',coalesce(mt.planned,0),'paid_cents',coalesce(mp.paid,0),
    'difference_cents',coalesce(mt.planned,0)-coalesce(mp.paid,0),'open_week_cents',coalesce(mt.open_week,0),
    'future_cents',coalesce(mt.future,0),'overdue_cents',coalesce(mt.overdue,0),
    'week_title_count',coalesce(mt.week_count,0),'future_title_count',coalesce(mt.future_count,0)) ORDER BY m.name)
   FROM public.payable_macros m LEFT JOIN title_macros mt ON mt.macro=m.name LEFT JOIN payment_macros mp ON mp.effective_macro=m.name)
 INTO v_totals,v_macros FROM title_totals t CROSS JOIN payment_totals p;

 -- Todos os valores retornados ao navegador, inclusive diferenças negativas e
 -- contagens, devem ser inteiros seguros; nunca arredondar um consolidado.
 IF EXISTS(SELECT 1 FROM jsonb_each(v_totals) e WHERE abs((e.value#>>'{}')::numeric)>9007199254740991)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_macros) m CROSS JOIN LATERAL jsonb_each(m-'macro') e
   WHERE abs((e.value#>>'{}')::numeric)>9007199254740991) THEN
  RAISE EXCEPTION 'O consolidado excede o limite de precisão. Confira os valores preservados na base.' USING ERRCODE='22003';END IF;
 IF v_import.id IS NULL THEN
  SELECT jsonb_object_agg(key,'null'::jsonb) INTO v_totals FROM jsonb_each(v_totals);
  SELECT jsonb_agg((SELECT jsonb_object_agg(key,CASE WHEN key='macro' THEN value ELSE 'null'::jsonb END) FROM jsonb_each(m)) ORDER BY m->>'macro')
   INTO v_macros FROM jsonb_array_elements(v_macros) m;
 END IF;
 RETURN jsonb_build_object('as_of_date',v_today,'week_start',v_start,'week_end',v_end,'month_start',v_month,'month_end',v_month_end,
  'latest_import_id',v_import.id,'latest_import_at',v_import.created_at,'by_macro',v_macros,
  'missing_sources',CASE WHEN v_import.id IS NULL THEN jsonb_build_array('Relatório completo de Contas a Pagar aguardando importação.') ELSE '[]'::jsonb END)||v_totals;
END $$;
REVOKE ALL ON FUNCTION public.payables_management_summary(date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.payables_management_summary(date,date) TO authenticated;
COMMENT ON FUNCTION public.payables_management_summary(date,date) IS 'Somente leitura CP. Planejado: valores nominais atuais por vencimento, inclusive pagos; realizado semanal/mensal: pagamentos ativos por data real e macro efetivo. Mês selecionado começa no primeiro dia e independe da semana; padrão é mês atual SP. Restante usa payment_remaining_cents, inclui ausências ainda não conciliadas e exclui somente versões históricas comprovadas. Futuro >= hoje SP sem limite de oito semanas; cheques são subtotal já incluído no restante.';
INSERT INTO public.central_schema_migrations(version) VALUES('020_payables_management');
COMMIT;
