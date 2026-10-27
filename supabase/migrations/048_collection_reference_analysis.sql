-- Referências da Cobrança: análise limitada e reuso seguro de preparações já recebidas.
-- Preserva arquivos, lotes, dados financeiros, contatos manuais, permissões e carteiras.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $cf048$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative o banco da Central Financeira antes desta atualização.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='048_collection_reference_analysis') THEN RETURN;END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['028_collection_reference_imports','047_receivables_complete_report'])v
  WHERE NOT EXISTS(SELECT 1 FROM public.central_schema_migrations m WHERE m.version=v))
  OR to_regprocedure('cf_private.analyze_collection_reference_job(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Ative as referências 028 e o relatório completo 047 antes desta atualização.' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(2045812308);
 EXECUTE $cf048ddl$
ALTER TABLE cf_private.collection_reference_jobs ADD COLUMN IF NOT EXISTS analysis_context_revision text;

CREATE OR REPLACE FUNCTION cf_private.analyze_collection_reference_job(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_financial text;v_context text;BEGIN
 SELECT * INTO v_job FROM cf_private.collection_reference_jobs WHERE id=p_job_id;
 IF NOT FOUND OR NOT v_job.original_verified OR v_job.manifest_sha256 IS NULL OR v_job.status NOT IN ('PREPARED','PUBLISHING','PUBLISHED') THEN
  RAISE EXCEPTION 'Conclua a preparação verificada antes da análise.' USING ERRCODE='22023';END IF;
 v_financial:=cf_private.receivables_sync_revision_value();
 SELECT revision::text INTO v_context FROM cf_private.collection_context_state WHERE singleton;
 IF v_financial IS NULL OR v_context IS NULL THEN RAISE EXCEPTION 'A revisão da carteira ou dos contatos não está disponível.' USING ERRCODE='22023';END IF;
 -- Fonte e linhas são imutáveis após PREPARED. Reutilizar só quando AMBAS as revisões conferem.
 IF v_job.analysis_at IS NOT NULL AND v_job.analysis_financial_revision=v_financial AND v_job.analysis_context_revision=v_context THEN
  IF v_financial IS DISTINCT FROM cf_private.receivables_sync_revision_value() OR v_context IS DISTINCT FROM(SELECT revision::text FROM cf_private.collection_context_state WHERE singleton) THEN
   RAISE EXCEPTION 'A carteira ou os contatos mudaram durante a análise. Confira novamente o mesmo arquivo preparado.' USING ERRCODE='40001';END IF;
  RETURN;
 END IF;
 WITH titles AS MATERIALIZED(
  SELECT t.customer_key,t.status,t.retired_from_report,cf_private.collection_reference_key(t.branch,t.document,t.customer_key) AS context_key,
   cf_private.receivable_customer_key(t.client_name,NULL) AS name_key,t.client_document,
   cf_private.collection_reference_key(t.branch,t.document,cf_private.receivable_customer_key(t.client_name,NULL)) AS name_context
  FROM public.receivable_titles t WHERE t.scope='grupo-consolidado'
 ),customers AS MATERIALIZED(
  SELECT customer_key,count(*) FILTER(WHERE status<>'VALIDATED' AND NOT retired_from_report)::integer AS active_count,count(*) FILTER(WHERE status='VALIDATED') AS paid_count FROM titles GROUP BY customer_key
 ),contexts AS MATERIALIZED(
  SELECT context_key,count(*) FILTER(WHERE status<>'VALIDATED' AND NOT retired_from_report)::integer AS active_count,count(*) FILTER(WHERE status='VALIDATED') AS paid_count FROM titles GROUP BY context_key
 ),names AS MATERIALIZED(SELECT name_key,count(*) AS count FROM titles WHERE client_document IS NOT NULL GROUP BY name_key),
 name_contexts AS MATERIALIZED(SELECT name_context,count(*) AS count FROM titles WHERE client_document IS NOT NULL GROUP BY name_context),
 classified AS MATERIALIZED(
  SELECT r.row_hash,r.customer_key,CASE WHEN v_job.mode='CONTACTS' THEN r.canonical END AS canonical,CASE WHEN r.invalid THEN 'INVALID'
   WHEN v_job.mode='CONTACTS' THEN CASE
    WHEN r.customer_key LIKE 'name:%' AND coalesce(n.count,0)>0 THEN 'AMBIGUOUS'
    WHEN coalesce(c.active_count,0)+coalesce(c.paid_count,0)>0 THEN CASE WHEN card.manually_edited THEN 'MANUAL_PRESERVED' ELSE 'MATCHED' END
    WHEN r.customer_key LIKE 'name:%' THEN CASE WHEN card.manually_edited THEN 'MANUAL_PRESERVED' ELSE 'MATCHED' END
    ELSE 'UNMATCHED' END
   WHEN coalesce(k.active_count,0)>0 THEN 'MATCHED'
   WHEN coalesce(k.paid_count,0)>0 THEN 'PAID_ONLY'
   WHEN r.customer_key LIKE 'name:%' AND coalesce(nk.count,0)>0 THEN 'AMBIGUOUS'
   ELSE 'UNMATCHED' END AS outcome,
   CASE WHEN v_job.mode='CONTACTS' THEN coalesce(c.active_count,0) ELSE coalesce(k.active_count,0) END AS title_count
  FROM cf_private.collection_reference_rows r LEFT JOIN customers c USING(customer_key) LEFT JOIN contexts k USING(context_key)
   LEFT JOIN public.collection_customer_contacts card USING(customer_key)
   LEFT JOIN names n ON n.name_key=r.customer_key
   LEFT JOIN name_contexts nk ON nk.name_context=r.context_key
  WHERE r.job_id=p_job_id
 ),clients AS MATERIALIZED(SELECT DISTINCT customer_key FROM classified WHERE v_job.mode='CONTACTS' AND outcome='MATCHED'),
 methods AS(
  SELECT c.customer_key,'email' AS kind,e#>>'{}' AS value FROM classified c
   CROSS JOIN LATERAL jsonb_array_elements(c.canonical->'emails')e WHERE v_job.mode='CONTACTS' AND c.outcome='MATCHED'
  UNION SELECT c.customer_key,'phone',p#>>'{}' FROM classified c
   CROSS JOIN LATERAL jsonb_array_elements(c.canonical->'phones')p WHERE v_job.mode='CONTACTS' AND c.outcome='MATCHED'
  UNION SELECT c.customer_key,'email',e#>>'{}' FROM public.collection_customer_contacts c JOIN clients s USING(customer_key) CROSS JOIN LATERAL jsonb_array_elements(c.emails)e
  UNION SELECT c.customer_key,'phone',p#>>'{}' FROM public.collection_customer_contacts c JOIN clients s USING(customer_key) CROSS JOIN LATERAL jsonb_array_elements(c.phones)p
 ),overflow AS MATERIALIZED(SELECT DISTINCT customer_key FROM methods GROUP BY customer_key,kind HAVING count(DISTINCT value)>50),
 resolved AS(
  SELECT c.row_hash,c.title_count,CASE WHEN o.customer_key IS NOT NULL THEN 'INVALID' ELSE c.outcome END AS outcome,
   CASE WHEN o.customer_key IS NOT NULL THEN 'LIMIT_METHODS: o cliente excederia 50 e-mails ou telefones; nenhum canal foi truncado.' END AS problem
  FROM classified c LEFT JOIN overflow o USING(customer_key)
 ) UPDATE cf_private.collection_reference_rows r SET outcome=c.outcome,analysis_problem=c.problem,matched_title_count=c.title_count
  FROM resolved c WHERE r.job_id=p_job_id AND r.row_hash=c.row_hash
   AND ROW(r.outcome,r.matched_title_count,r.analysis_problem) IS DISTINCT FROM ROW(c.outcome,c.title_count,c.problem);
 IF v_financial IS DISTINCT FROM cf_private.receivables_sync_revision_value() OR v_context IS DISTINCT FROM(SELECT revision::text FROM cf_private.collection_context_state WHERE singleton) THEN
  RAISE EXCEPTION 'A carteira ou os contatos mudaram durante a análise. Confira novamente o mesmo arquivo preparado.' USING ERRCODE='40001';END IF;
 UPDATE cf_private.collection_reference_jobs SET analysis_financial_revision=v_financial,analysis_context_revision=v_context,analysis_at=clock_timestamp() WHERE id=p_job_id;
END $$;


ALTER FUNCTION public.preview_collection_reference_import_from_gateway(uuid,text,uuid) SET lock_timeout='5s';
ALTER FUNCTION public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid) SET lock_timeout='5s';
REVOKE ALL ON FUNCTION cf_private.analyze_collection_reference_job(uuid) FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.central_schema_migrations(version) VALUES('048_collection_reference_analysis') ON CONFLICT(version) DO NOTHING;
$cf048ddl$;
END $cf048$;
COMMIT;
