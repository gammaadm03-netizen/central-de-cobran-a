-- Diagnóstico somente de leitura: Compra de Mercadoria e Resumo da Diretoria.
-- Execute TODO o conteúdo em Supabase > SQL Editor > New query > Run, como postgres.
-- Requer os relatórios diários de CP058/060. Não altera fórmulas, títulos ou pagamentos.
-- Valores são agrupados; não retorna clientes, fornecedores, contas ou dados de usuários.
WITH
versions AS MATERIALIZED (
 SELECT coalesce(jsonb_agg(version ORDER BY version),'[]'::jsonb) AS value
 FROM public.central_schema_migrations
 WHERE version ~ '^0(15|42|43|50|58|59|60|61|65|66)_'
),
report_code AS MATERIALIZED (
 SELECT pg_get_functiondef('public.director_report(date,date)'::regprocedure) AS definition
),
report_criterion AS MATERIALIZED (
 SELECT definition,position('normalize_payable_plan(plan)' IN definition)>0 AS uses_plan
 FROM report_code
),
head AS MATERIALIZED (
 SELECT d.*,coalesce(q.result->>'report_contents','FULL_OPEN') AS report_contents
 FROM cf_private.payable_daily_reports d
 LEFT JOIN LATERAL (
  SELECT r.result FROM cf_private.payable_daily_requests r WHERE r.report_id=d.id
  ORDER BY r.created_at DESC,r.request_id DESC LIMIT 1
 ) q ON true
 WHERE d.report_kind='ALL' ORDER BY d.created_at DESC,d.id DESC LIMIT 1
),
source AS MATERIALIZED (
 SELECT r AS item,cf_private.normalize_payable_plan(r->>'plan') AS source_plan,
  (r->>'amount_cents')::numeric AS source_cents,
  i.title_id,f.macro,f.status,f.financial_status,f.amount_cents,f.paid_cents,f.outstanding_cents,
  coalesce((to_jsonb(f)->>'report_paid')::boolean,false) AS report_paid,
  to_jsonb(f)->>'administrative_writeoff_id' IS NOT NULL AS administrative_writeoff,
  m.macro AS configured_macro
 FROM head h CROSS JOIN LATERAL jsonb_array_elements(h.rows) r
 LEFT JOIN cf_private.payable_identity_registry i ON i.scope='grupo-consolidado'
  AND i.business_key=cf_private.payable_business_key(r->>'branch',r->>'entry_number')
 LEFT JOIN public.payable_financial_titles f ON f.id=i.title_id
 LEFT JOIN public.payable_plan_mappings m ON m.plan=cf_private.normalize_payable_plan(r->>'plan')
),
merchandise_source AS MATERIALIZED (
 SELECT * FROM source WHERE source_plan='COMPRA DE MERCADORIA'
),
current_merchandise AS MATERIALIZED (
 SELECT f.* FROM public.payable_financial_titles f CROSS JOIN report_criterion c
 WHERE f.scope='grupo-consolidado' AND f.outstanding_cents>0
  AND CASE WHEN c.uses_plan THEN cf_private.normalize_payable_plan(f.plan)='COMPRA DE MERCADORIA'
   ELSE f.macro='COMPRA DE MERCADORIA' END
),
operational_position AS MATERIALIZED (
 SELECT (p->>'title_id')::uuid AS position_title_id,f.*
 FROM head h CROSS JOIN LATERAL jsonb_array_elements(h.position) p
 LEFT JOIN public.payable_financial_titles f ON f.id=(p->>'title_id')::uuid
),
source_groups AS MATERIALIZED (
 SELECT source_plan,configured_macro,macro,status,financial_status,report_paid,administrative_writeoff,
  count(*) AS titles,coalesce(sum(source_cents),0) AS source_cents,
  coalesce(sum(amount_cents),0) AS nominal_cents,coalesce(sum(paid_cents),0) AS paid_cents,
  coalesce(sum(outstanding_cents),0) AS outstanding_cents
 FROM merchandise_source GROUP BY 1,2,3,4,5,6,7
),
active_source_payments AS MATERIALIZED (
 SELECT p.id,p.title_id,p.amount_cents,p.paid_on,
  CASE
   WHEN EXISTS (
    SELECT 1 FROM cf_private.payable_daily_actions a
    JOIN cf_private.payable_daily_requests q ON q.report_id=a.report_id
    WHERE a.payment_id=p.id AND q.result->>'daily_report_version'='060'
     AND q.result->'unified_daily_report'='true'::jsonb
   ) THEN 'RELATORIO_COMPLETO_060'
   WHEN EXISTS (SELECT 1 FROM cf_private.payable_daily_actions a WHERE a.payment_id=p.id)
    THEN 'OUTRO_RELATORIO_DIARIO'
   WHEN EXISTS (SELECT 1 FROM public.payable_paid_import_rows r WHERE p.id=ANY(r.payment_ids))
    THEN 'RELATORIO_DE_PAGOS'
   ELSE 'OUTRO_REGISTRO_FINANCEIRO'
  END AS origin
 FROM public.payable_payments p
 WHERE p.title_id IN(SELECT title_id FROM merchandise_source)
  AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)
),
payment_groups AS MATERIALIZED (
 SELECT origin,count(*) AS payments,count(DISTINCT title_id) AS titles,
  sum(amount_cents) AS paid_cents,min(paid_on) AS first_date,max(paid_on) AS last_date
 FROM active_source_payments GROUP BY origin
),
results AS (
 SELECT 1 AS position,'Versões de Contas a Pagar' AS check_name,value AS result FROM versions
 UNION ALL
 SELECT 2,'Cálculo instalado da Diretoria',jsonb_build_object(
  'usa_titulos_financeiros',position('public.payable_financial_titles' IN definition)>0,
  'soma_saldo_em_aberto',position('sum(outstanding_cents)' IN definition)>0,
  'criterio_mercadoria',CASE WHEN uses_plan THEN 'PLANO_CP' ELSE 'MACRO' END,
  'codigo_sha256',encode(sha256(convert_to(definition,'UTF8')),'hex')) FROM report_criterion
 UNION ALL
 SELECT 3,'Último arquivo e posição operacional confirmados',coalesce((
  SELECT jsonb_build_object('encontrado',true,'arquivo',i.file_name,'arquivo_sha256',h.file_sha256,
   'posicao',h.report_date,'confirmado_em',h.created_at,'conteudo',h.report_contents,
   'titulos_no_arquivo',jsonb_array_length(h.rows),'titulos_na_posicao_operacional',jsonb_array_length(h.position))
  FROM head h JOIN public.payable_imports i ON i.id=h.source_import_id
 ),jsonb_build_object('encontrado',false))
 UNION ALL
 SELECT 4,'Mercadoria no arquivo confirmado',jsonb_build_object(
  'plano_origem','COMPRA DE MERCADORIA','titulos',count(*),
  'valor_arquivo_reais',coalesce(sum(source_cents),0)/100.0,
  'valor_nominal_atual_reais',coalesce(sum(amount_cents),0)/100.0,
  'pagamentos_vigentes_reais',coalesce(sum(paid_cents),0)/100.0,
  'saldo_atual_reais',coalesce(sum(outstanding_cents),0)/100.0,
  'saldo_dentro_macro_mercadoria_reais',coalesce(sum(outstanding_cents) FILTER(WHERE macro='COMPRA DE MERCADORIA'),0)/100.0,
  'titulos_sem_identidade',count(*) FILTER(WHERE title_id IS NULL),
  'titulos_em_outro_macro',count(*) FILTER(WHERE macro IS DISTINCT FROM 'COMPRA DE MERCADORIA'),
  'titulos_com_nominal_divergente',count(*) FILTER(WHERE amount_cents IS DISTINCT FROM source_cents))
 FROM merchandise_source
 UNION ALL
 SELECT 5,'Mercadoria na posição operacional pelo Plano cp',jsonb_build_object(
  'titulos',count(*),'plano_origem','COMPRA DE MERCADORIA',
  'valor_nominal_reais',coalesce(sum(amount_cents),0)/100.0,
  'pagamentos_vigentes_reais',coalesce(sum(paid_cents),0)/100.0,
  'saldo_atual_reais',coalesce(sum(outstanding_cents),0)/100.0)
 FROM operational_position WHERE cf_private.normalize_payable_plan(plan)='COMPRA DE MERCADORIA'
 UNION ALL
 SELECT 6,'Resumo atual equivalente ao indicador da Diretoria',jsonb_build_object(
  'titulos_com_saldo',count(*),'valor_reais',coalesce(sum(outstanding_cents),0)/100.0,
  'saldo_fora_da_ultima_posicao_reais',coalesce(sum(outstanding_cents) FILTER(
   WHERE id NOT IN(SELECT position_title_id FROM operational_position)),0)/100.0)
 FROM current_merchandise
 UNION ALL
 SELECT 7,'Conferência do arquivo por classificação e situação',coalesce(jsonb_agg(jsonb_build_object(
  'plano_origem',source_plan,'macro_do_plano',configured_macro,'macro_do_titulo',macro,
  'situacao',status,'situacao_financeira',financial_status,'pago_por_relatorio',report_paid,
  'baixa_administrativa',administrative_writeoff,'titulos',titles,
  'valor_arquivo_reais',source_cents/100.0,'nominal_atual_reais',nominal_cents/100.0,
  'pagamentos_vigentes_reais',paid_cents/100.0,'saldo_atual_reais',outstanding_cents/100.0)
  ORDER BY source_plan,configured_macro,macro,status,financial_status,report_paid,administrative_writeoff),'[]'::jsonb)
 FROM source_groups
 UNION ALL
 SELECT 8,'Origem dos pagamentos vigentes dos títulos do arquivo',coalesce(jsonb_agg(jsonb_build_object(
  'origem',origin,'pagamentos',payments,'titulos',titles,'valor_pago_reais',paid_cents/100.0,
  'primeira_data',first_date,'ultima_data',last_date) ORDER BY origin),'[]'::jsonb)
 FROM payment_groups
)
SELECT check_name AS "Verificação",result AS "Resultado" FROM results ORDER BY position;
