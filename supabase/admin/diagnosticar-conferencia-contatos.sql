-- CENTRAL FINANCEIRA — diagnóstico somente de leitura da conferência de contatos.
-- Cole o arquivo completo no Supabase > SQL Editor > New query > Run.
-- Não altera dados, permissões, limites, funções ou importações.
-- O resultado contém configurações e contagens, sem nomes, contatos, tokens ou arquivos.
WITH settings AS (
 SELECT r.rolname, v.setting
 FROM pg_catalog.pg_roles r
 CROSS JOIN LATERAL unnest(coalesce(r.rolconfig,ARRAY[]::text[])) v(setting)
 WHERE r.rolname IN ('service_role','authenticator','authenticated','anon')
  AND v.setting ~ '^(statement_timeout|lock_timeout|transaction_timeout)='
 UNION
 SELECT coalesce(r.rolname,'todos os perfis')||' / '||coalesce(d.datname,'todos os bancos'),v.setting
 FROM pg_catalog.pg_db_role_setting s
 LEFT JOIN pg_catalog.pg_roles r ON r.oid=s.setrole
 LEFT JOIN pg_catalog.pg_database d ON d.oid=s.setdatabase
 CROSS JOIN LATERAL unnest(s.setconfig) v(setting)
 WHERE (s.setrole=0 OR r.rolname IN ('service_role','authenticator','authenticated','anon'))
  AND (s.setdatabase=0 OR d.datname=current_database())
  AND v.setting ~ '^(statement_timeout|lock_timeout|transaction_timeout)='
), held AS (
 SELECT l.objid,l.granted,a.state,a.wait_event_type,a.wait_event,
  greatest(0,extract(epoch FROM clock_timestamp()-coalesce(a.xact_start,a.query_start)))::integer AS age_seconds
 FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid=l.pid
 WHERE l.locktype='advisory' AND l.classid=0 AND l.objsubid=1
  AND l.objid IN (2045812301::oid,2045812308::oid)
), checks AS (
 SELECT 1 AS order_key,'Atualização 048 registrada' AS verificacao,
  CASE WHEN EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='048_collection_reference_analysis') THEN 'SIM' ELSE 'NÃO' END AS resultado
 UNION ALL
 SELECT 2,'Função com reaproveitamento de análise',
  CASE WHEN coalesce(position('analysis_context_revision' IN pg_catalog.pg_get_functiondef(to_regprocedure('cf_private.analyze_collection_reference_job(uuid)'))),0)>0 THEN 'SIM' ELSE 'NÃO' END
 UNION ALL
 SELECT 3,'Limites configurados nos perfis',coalesce((SELECT string_agg(rolname||': '||setting,'; ' ORDER BY rolname,setting) FROM settings),'Nenhum limite explícito nesses perfis; pode existir um limite global ou por requisição.')
 UNION ALL
 SELECT 4,'Limites da função de conferência',coalesce((SELECT string_agg(v.setting,'; ' ORDER BY v.setting) FROM pg_catalog.pg_proc p CROSS JOIN LATERAL unnest(p.proconfig)v(setting)
  WHERE p.oid=to_regprocedure('public.preview_collection_reference_import_from_gateway(uuid,text,uuid)') AND v.setting ~ '^(statement_timeout|lock_timeout)='),'Sem limite próprio configurado.')
 UNION ALL
 SELECT 5,'Títulos na carteira',jsonb_build_object('total',count(*),'ativos',count(*) FILTER(WHERE status<>'VALIDATED' AND NOT retired_from_report))::text FROM public.receivable_titles WHERE scope='grupo-consolidado'
 UNION ALL
 SELECT 6,'Contatos cadastrados',count(*)::text FROM public.collection_customer_contacts
 UNION ALL
 SELECT 7,'Linhas de apoio preparadas, em todos os arquivos',count(*)::text FROM cf_private.collection_reference_rows
 UNION ALL
 SELECT 8,'Últimas preparações de contatos',coalesce((SELECT jsonb_agg(jsonb_build_object('situacao',j.status,'linhas',j.staged_rows,'criado_em',j.created_at,'analise_concluida',j.analysis_at IS NOT NULL,
  'revisao_financeira_confere',j.analysis_financial_revision=cf_private.receivables_sync_revision_value(),
  'revisao_contatos_confere',to_jsonb(j)->>'analysis_context_revision'=(SELECT revision::text FROM cf_private.collection_context_state WHERE singleton)) ORDER BY j.created_at DESC)::text
  FROM(SELECT * FROM cf_private.collection_reference_jobs WHERE mode='CONTACTS' ORDER BY created_at DESC LIMIT 3)j),'[]')
 UNION ALL
 SELECT 9,'Bloqueios de operações financeiras (2301)',jsonb_build_object('operacoes_com_bloqueio',count(*) FILTER(WHERE granted),'operacoes_aguardando',count(*) FILTER(WHERE NOT granted),'maior_duracao_segundos',coalesce(max(age_seconds),0))::text FROM held WHERE objid=2045812301::oid
 UNION ALL
 SELECT 10,'Bloqueios de contatos e descrições (2308)',jsonb_build_object('operacoes_com_bloqueio',count(*) FILTER(WHERE granted),'operacoes_aguardando',count(*) FILTER(WHERE NOT granted),'maior_duracao_segundos',coalesce(max(age_seconds),0))::text FROM held WHERE objid=2045812308::oid
 UNION ALL
 SELECT 11,'Estatísticas das tabelas de apoio',coalesce((SELECT jsonb_agg(jsonb_build_object('tabela',schemaname||'.'||relname,'estimativa_linhas',n_live_tup,'linhas_obsoletas',n_dead_tup,'ultima_analise',coalesce(last_analyze,last_autoanalyze)) ORDER BY schemaname,relname)::text FROM pg_catalog.pg_stat_all_tables
  WHERE(schemaname='cf_private' AND relname='collection_reference_rows') OR(schemaname='public' AND relname IN ('receivable_titles','collection_customer_contacts'))),'[]')
 UNION ALL
 SELECT 12,'Compilação e planejamento de consultas',jsonb_build_object('jit',current_setting('jit',true),'jit_above_cost',current_setting('jit_above_cost',true),'jit_inline_above_cost',current_setting('jit_inline_above_cost',true),'jit_optimize_above_cost',current_setting('jit_optimize_above_cost',true),'jit_disponivel',pg_catalog.pg_jit_available(),'plan_cache_mode',current_setting('plan_cache_mode',true))::text
)
SELECT verificacao AS "Verificação",resultado AS "Resultado" FROM checks ORDER BY order_key;
