-- Visão gerencial da cobrança vencida. Somente leitura; preserva títulos e históricos.
-- Aplicar uma única vez após 022; não depende das importações 023/024.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='022_collections_overdue_only') THEN
  RAISE EXCEPTION 'Ative a atualização 022 de Cobrança antes deste resumo.' USING ERRCODE='22023';
 END IF;
END $$;

CREATE FUNCTION public.collections_overdue_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_full_wallet boolean;v_totals jsonb;v_bands jsonb;v_statuses jsonb;v_actions jsonb;v_owners jsonb;
BEGIN
 IF NOT cf_private.has_permission('cobranca','read') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 v_full_wallet:=cf_private.has_permission('contas_receber','read');
 -- A view e as tabelas continuam com a RLS do chamador: cobradora vê apenas
 -- sua carteira vinculada. Nenhum total nasce da página limitada do navegador.
 WITH active AS MATERIALIZED(
  SELECT t.*,(v_today-t.due_date)::integer AS delay_days
  FROM public.collection_overdue_titles t
  WHERE t.scope='grupo-consolidado' AND t.status<>'VALIDATED'
 ),bands(key,label,min_days,max_days,sort_order) AS(VALUES
  ('1_30','1–30 dias',1,30,1),('31_60','31–60 dias',31,60,2),
  ('61_90','61–90 dias',61,90,3),('91_180','91–180 dias',91,180,4),
  ('181_365','181–365 dias',181,365,5),('ACIMA_365','Acima de 365 dias',366,NULL,6)
 ),statuses(status,sort_order) AS(VALUES('NEW',1),('OPEN',2),('PENDING_VALIDATION',3),('NOT_LOCATED',4)),
 actions(action,sort_order) AS(VALUES('NONE',1),('CONTACT',2),('NO_RESPONSE',3),('PROMISE',4),('RETRY',5),('OTHER',6))
 SELECT jsonb_build_object(
  'overdue_cents',coalesce(sum(amount_cents),0),'overdue_count',count(*),
  'client_count',count(DISTINCT customer_key),
  'average_delay_days',coalesce(round(avg(delay_days),1),0),
  'worked_count',count(*) FILTER(WHERE last_action IS NOT NULL),
  'no_action_count',count(*) FILTER(WHERE last_action IS NULL),
  'pending_validation_count',count(*) FILTER(WHERE status='PENDING_VALIDATION'),
  'pending_validation_cents',coalesce(sum(amount_cents) FILTER(WHERE status='PENDING_VALIDATION'),0),
  'over_180_count',count(*) FILTER(WHERE delay_days>180),
  'returns_today_count',count(*) FILTER(WHERE next_action IS NOT NULL AND next_action_date=v_today),
  'returns_overdue_count',count(*) FILTER(WHERE next_action IS NOT NULL AND next_action_date<v_today),
  'unassigned_count',CASE WHEN v_full_wallet THEN count(*) FILTER(WHERE collector_id IS NULL) END,
  'unassigned_cents',CASE WHEN v_full_wallet THEN coalesce(sum(amount_cents) FILTER(WHERE collector_id IS NULL),0) END),
  (SELECT jsonb_agg(jsonb_build_object('key',b.key,'label',b.label,'min_days',b.min_days,'max_days',b.max_days,
    'title_count',(SELECT count(*) FROM active t WHERE t.delay_days>=b.min_days AND (b.max_days IS NULL OR t.delay_days<=b.max_days)),
    'amount_cents',(SELECT coalesce(sum(t.amount_cents),0) FROM active t WHERE t.delay_days>=b.min_days AND (b.max_days IS NULL OR t.delay_days<=b.max_days))) ORDER BY b.sort_order) FROM bands b),
  (SELECT jsonb_agg(jsonb_build_object('status',s.status,
    'title_count',(SELECT count(*) FROM active t WHERE t.status=s.status),
    'amount_cents',(SELECT coalesce(sum(t.amount_cents),0) FROM active t WHERE t.status=s.status)) ORDER BY s.sort_order) FROM statuses s),
  (SELECT jsonb_agg(jsonb_build_object('action',a.action,
    'title_count',(SELECT count(*) FROM active t WHERE coalesce(t.next_action,'NONE')=a.action),
    'amount_cents',(SELECT coalesce(sum(t.amount_cents),0) FROM active t WHERE coalesce(t.next_action,'NONE')=a.action)) ORDER BY a.sort_order) FROM actions a),
  (SELECT coalesce(jsonb_agg(jsonb_build_object('collector_id',o.collector_id,'display_name',o.display_name,
    'title_count',o.title_count,'amount_cents',o.amount_cents) ORDER BY o.collector_id NULLS LAST),'[]'::jsonb)
   FROM(SELECT t.collector_id,
    CASE WHEN t.collector_id IS NULL THEN 'Sem cobradora definida' ELSE coalesce(max(a.display_name),'Cobradora atribuída') END AS display_name,
    count(*) AS title_count,sum(t.amount_cents) AS amount_cents
    FROM active t LEFT JOIN public.collection_agents a ON a.id=t.collector_id GROUP BY t.collector_id)o)
 INTO v_totals,v_bands,v_statuses,v_actions,v_owners FROM active;

 -- Recusar perda de precisão em centavos e contagens; jamais arredondar dinheiro.
 IF EXISTS(SELECT 1 FROM jsonb_each(v_totals) e
    WHERE e.value<>'null'::jsonb AND abs((e.value#>>'{}')::numeric)>9007199254740991)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_bands||v_statuses||v_actions||v_owners) a
   CROSS JOIN LATERAL jsonb_each(a) e WHERE e.key IN('amount_cents','title_count')
    AND abs((e.value#>>'{}')::numeric)>9007199254740991) THEN
  RAISE EXCEPTION 'O resumo excede o limite de precisão. Solicite a conferência da base.' USING ERRCODE='22003';
 END IF;
 RETURN jsonb_build_object('as_of_date',v_today,'by_delay_bands',v_bands,'by_status',v_statuses,
  'by_next_action',v_actions,'by_collector',v_owners)||v_totals;
END $$;
REVOKE ALL ON FUNCTION public.collections_overdue_summary() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.collections_overdue_summary() TO authenticated;
COMMENT ON FUNCTION public.collections_overdue_summary() IS
 'Somente leitura. Carteira ativa vencida pela data oficial de São Paulo, íntegra e sujeita à RLS do chamador. Pendentes permanecem até validação; validados não compõem totais. Faixas são de atraso atual, sem regras ou percentuais de comissão. Sem títulos visíveis retorna contagens e valores zero; não representa saldo bancário ou recebimento.';
INSERT INTO public.central_schema_migrations(version) VALUES('025_collections_management');
COMMIT;
