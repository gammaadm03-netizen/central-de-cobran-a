-- CENTRAL FINANCEIRA — variação diária da inadimplência (051).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Reaplica com segurança. Requer a atualização 047 já ativada.
-- Somente consulta: não importa planilhas, altera títulos ou confirma recebimentos.
-- O histórico usa os registros da base atual e respeita a data oficial de São Paulo.

-- Variação diária da inadimplência: posições reais registradas, sem alterar a carteira.
BEGIN;
DO $cf051$ BEGIN
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='051_receivables_daily_delinquency') THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN
  RAISE EXCEPTION 'Ative a atualização 047 de Contas a Receber antes da variação diária.' USING ERRCODE='22023';
 END IF;
 EXECUTE $ddl$
-- O histórico financeiro existente é imutável. O índice limita cada consulta
-- aos eventos do título, sem varrer auditorias de outros módulos.
CREATE INDEX receivable_title_audit_daily ON public.audit_events(record_id,occurred_at DESC)
 WHERE module='contas_receber' AND entity='receivable_titles';

CREATE FUNCTION cf_private.receivables_delinquency_position(p_day date,p_today date,p_first_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_cutoff timestamptz:=((p_day+1)::timestamp AT TIME ZONE 'America/Sao_Paulo');
 v_available boolean:=p_first_date IS NOT NULL AND p_day>=p_first_date;
 v_bands jsonb;v_total numeric;v_count numeric;v_missing bigint;
BEGIN
 IF v_available AND p_day<p_today THEN
  -- IDs da base atual excluem auditorias preservadas após zerar uma base de
  -- testes. A maior revisão vence mesmo quando dois eventos têm a mesma hora.
  SELECT count(*) FILTER(WHERE h.after_value IS NULL OR jsonb_typeof(h.after_value)<>'object'
    OR h.after_value->>'id' IS DISTINCT FROM t.id::text
    OR h.after_value->>'scope' IS DISTINCT FROM 'grupo-consolidado'
    OR h.after_value->>'status' NOT IN('NEW','OPEN','PENDING_VALIDATION','NOT_LOCATED','VALIDATED')
    OR h.after_value->>'status' IS NULL OR h.after_value->>'due_date' IS NULL OR h.after_value->>'amount_cents' IS NULL)
   INTO v_missing FROM public.receivable_titles t
   LEFT JOIN LATERAL(SELECT a.after_value FROM public.audit_events a
    WHERE a.module='contas_receber' AND a.entity='receivable_titles' AND a.record_id=t.id::text AND a.occurred_at<v_cutoff
    ORDER BY CASE WHEN a.after_value->>'revision' ~ '^[0-9]{1,20}$' THEN(a.after_value->>'revision')::numeric END DESC NULLS LAST,a.occurred_at DESC,a.id DESC LIMIT 1)h ON true
   WHERE t.scope='grupo-consolidado' AND t.created_at<v_cutoff;
  v_available:=v_missing=0;
 END IF;
 IF v_available THEN
  WITH states AS MATERIALIZED(
   SELECT t.amount_cents,t.due_date,t.status,t.retired_from_report
   FROM public.receivable_titles t WHERE p_day=p_today AND t.scope='grupo-consolidado'
   UNION ALL
   SELECT s.amount_cents,s.due_date,s.status,coalesce(s.retired_from_report,false)
   FROM public.receivable_titles t
   CROSS JOIN LATERAL(SELECT a.after_value FROM public.audit_events a
    WHERE a.module='contas_receber' AND a.entity='receivable_titles' AND a.record_id=t.id::text AND a.occurred_at<v_cutoff
    ORDER BY CASE WHEN a.after_value->>'revision' ~ '^[0-9]{1,20}$' THEN(a.after_value->>'revision')::numeric END DESC NULLS LAST,a.occurred_at DESC,a.id DESC LIMIT 1)h
   CROSS JOIN LATERAL jsonb_populate_record(NULL::public.receivable_titles,h.after_value)s
   WHERE p_day<p_today AND t.scope='grupo-consolidado' AND t.created_at<v_cutoff
  ),active AS MATERIALIZED(
   SELECT amount_cents,p_day-due_date AS delay_days FROM states
   WHERE status<>'VALIDATED' AND NOT retired_from_report AND due_date<p_day
  ),bands(key,min_days,max_days,ord) AS(VALUES
   ('1_30',1,30,1),('31_60',31,60,2),('61_90',61,90,3),
   ('91_180',91,180,4),('181_365',181,365,5),('ACIMA_365',366,NULL,6)
  ),amounts AS(
   SELECT b.key,b.ord,coalesce(sum(a.amount_cents),0) amount_cents,count(a.delay_days) title_count
   FROM bands b LEFT JOIN active a ON a.delay_days>=b.min_days AND(b.max_days IS NULL OR a.delay_days<=b.max_days)
   GROUP BY b.key,b.ord
  ) SELECT jsonb_agg(jsonb_build_object('key',key,'amount_cents',amount_cents,'title_count',title_count) ORDER BY ord),
    sum(amount_cents),sum(title_count) INTO v_bands,v_total,v_count FROM amounts;
  IF greatest(v_total,v_count)>9007199254740991 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_bands)b
    WHERE greatest((b->>'amount_cents')::numeric,(b->>'title_count')::numeric)>9007199254740991) THEN
   RAISE EXCEPTION 'O consolidado excede o limite de precisão.' USING ERRCODE='22003';
  END IF;
 ELSE
  SELECT jsonb_agg(jsonb_build_object('key',key,'amount_cents',NULL,'title_count',NULL) ORDER BY ord)
   INTO v_bands FROM(VALUES('1_30',1),('31_60',2),('61_90',3),('91_180',4),('181_365',5),('ACIMA_365',6))b(key,ord);
 END IF;
 RETURN jsonb_build_object('date',p_day,'available',v_available,'partial',p_day=p_today,
  'total_cents',v_total,'title_count',v_count,'bands',v_bands);
END $fn$;
REVOKE ALL ON FUNCTION cf_private.receivables_delinquency_position(date,date,date) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.receivables_daily_delinquency(p_previous date DEFAULT NULL,p_current date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_current date;v_previous date;v_first_date date;
BEGIN
 IF NOT(cf_private.has_permission('painel','read') OR cf_private.has_permission('contas_receber','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 v_current:=coalesce(p_current,v_today);v_previous:=coalesce(p_previous,v_current-1);
 IF v_previous<DATE '1900-01-01' OR v_current<DATE '1900-01-01' OR v_previous>=v_current OR v_current>v_today THEN
  RAISE EXCEPTION 'Escolha duas datas em ordem crescente, até hoje em São Paulo.' USING ERRCODE='22023';END IF;
 SELECT(min(created_at) AT TIME ZONE 'America/Sao_Paulo')::date INTO v_first_date
 FROM public.receivable_imports WHERE scope='grupo-consolidado';
 RETURN jsonb_build_object('as_of_date',v_today,'timezone','America/Sao_Paulo','first_available_date',v_first_date,
  'previous',cf_private.receivables_delinquency_position(v_previous,v_today,v_first_date),
  'current',cf_private.receivables_delinquency_position(v_current,v_today,v_first_date));
END $fn$;
REVOKE ALL ON FUNCTION public.receivables_daily_delinquency(date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.receivables_daily_delinquency(date,date) TO authenticated;
COMMENT ON FUNCTION public.receivables_daily_delinquency(date,date) IS
 'Posições da carteira registradas até o fim de cada dia em São Paulo; hoje é parcial. Histórico sem base ou sem auditoria completa permanece indisponível. Não presume recebimento por redução ou migração entre faixas, nem aplica recebimentos retroativamente ao passado. Somente consolidados por faixa; nenhum título ou evento privado é exposto.';
$ddl$;
 INSERT INTO public.central_schema_migrations(version) VALUES('051_receivables_daily_delinquency');
END $cf051$;
NOTIFY pgrst,'reload schema';
COMMIT;
