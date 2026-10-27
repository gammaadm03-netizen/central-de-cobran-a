-- CENTRAL FINANCEIRA — estatísticas e processamento da conferência de contatos (049).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 048. Não precisa republicar a Edge Function já atualizada.
-- Preserva os arquivos preparados e os dados existentes; não conclui importações.
-- Orientações: docs/conferencia-contatos-descricoes.md.

-- Referências da Cobrança: atualiza a estimativa dos novos arquivos antes da primeira análise.
-- Preserva dados e limites de tempo; contatos dispensam o cálculo de chaves de descrições.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $cf049$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative o banco da Central Financeira antes desta atualização.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='049_collection_reference_preview_work') THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='048_collection_reference_analysis')
  OR to_regprocedure('cf_private.analyze_collection_reference_job(uuid)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='cf_private' AND table_name='collection_reference_jobs' AND column_name='analysis_context_revision') THEN
  RAISE EXCEPTION 'Ative a conferência de referências 048 antes desta atualização.' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(2045812308);
 EXECUTE $cf049ddl$
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
 -- Um arquivo novo pode não existir nas estatísticas do arquivo anterior.
 -- A estimativa incorreta de uma única linha gerava uma varredura por vínculo.
 -- Amostrar só job_id evita ler os textos das descrições para montar estatísticas.
 -- Revisões posteriores reutilizam as estatísticas: o arquivo preparado não cresce.
 IF v_job.analysis_at IS NULL OR v_job.analysis_context_revision IS NULL THEN
  ANALYZE cf_private.collection_reference_rows(job_id);
 END IF;
 WITH titles AS MATERIALIZED(
  SELECT t.customer_key,t.status,t.retired_from_report,CASE WHEN v_job.mode='DESCRIPTIONS' THEN cf_private.collection_reference_key(t.branch,t.document,t.customer_key) END AS context_key,
   CASE WHEN t.client_document IS NOT NULL THEN cf_private.receivable_customer_key(t.client_name,NULL) END AS name_key,t.client_document,
   CASE WHEN v_job.mode='DESCRIPTIONS' AND t.client_document IS NOT NULL THEN cf_private.collection_reference_key(t.branch,t.document,cf_private.receivable_customer_key(t.client_name,NULL)) END AS name_context
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


CREATE OR REPLACE FUNCTION public.preview_collection_reference_import_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_result jsonb;v_variants integer:=0;v_warnings integer;v_examples jsonb;v_context_revision text;v_matched_titles bigint;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF NOT v_job.original_verified OR v_job.manifest_sha256 IS NULL OR v_job.status NOT IN ('PREPARED','PUBLISHING','PUBLISHED') THEN
  RAISE EXCEPTION 'Conclua a preparação verificada antes da análise.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.analyze_collection_reference_job(p_job_id);
 SELECT jsonb_build_object('row_count',count(*),'deduplicated_count',v_job.staged_input_rows-count(*),
  'eligible_count',count(*) FILTER(WHERE outcome='MATCHED' AND NOT applied),'matched_title_count',coalesce(sum(matched_title_count),0),
  'unmatched_count',count(*) FILTER(WHERE outcome='UNMATCHED'),'paid_only_count',count(*) FILTER(WHERE outcome='PAID_ONLY'),
  'ambiguous_count',count(*) FILTER(WHERE outcome='AMBIGUOUS'),'invalid_count',count(*) FILTER(WHERE outcome='INVALID'),
  'manual_preserved_count',count(*) FILTER(WHERE outcome='MANUAL_PRESERVED'),
  'quarantine_count',count(*) FILTER(WHERE outcome IN ('UNMATCHED','PAID_ONLY','AMBIGUOUS','INVALID')),
  'processed_rows',count(*) FILTER(WHERE applied),'published_rows',count(*) FILTER(WHERE applied),'remaining_rows',count(*) FILTER(WHERE outcome='MATCHED' AND NOT applied)) INTO v_result
 FROM cf_private.collection_reference_rows WHERE job_id=p_job_id;
 WITH active_titles AS MATERIALIZED(SELECT id,customer_key,CASE WHEN v_job.mode='DESCRIPTIONS' THEN cf_private.collection_reference_key(branch,document,customer_key) END AS context_key
  FROM public.receivable_titles WHERE scope='grupo-consolidado' AND status<>'VALIDATED' AND NOT retired_from_report),
 matched_keys AS MATERIALIZED(SELECT DISTINCT CASE WHEN v_job.mode='CONTACTS' THEN customer_key ELSE context_key END AS key
  FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome IN ('MATCHED','MANUAL_PRESERVED'))
 SELECT count(DISTINCT t.id) INTO v_matched_titles FROM active_titles t JOIN matched_keys r
  ON r.key=CASE WHEN v_job.mode='CONTACTS' THEN t.customer_key ELSE t.context_key END;
 v_result:=v_result||jsonb_build_object('matched_title_count',v_matched_titles);
 IF v_job.mode='DESCRIPTIONS' THEN
  WITH incoming AS MATERIALIZED(SELECT DISTINCT context_key,encode(sha256(convert_to(jsonb_build_array(canonical->>'description',canonical->>'contract')::text,'UTF8')),'hex') AS hash
   FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome='MATCHED'),
  variants AS(SELECT context_key,hash FROM incoming UNION SELECT r.context_key,r.content_sha256 FROM public.collection_description_references r
   WHERE EXISTS(SELECT 1 FROM incoming i WHERE i.context_key=r.context_key))
  SELECT count(*) INTO v_variants FROM(SELECT context_key FROM variants GROUP BY context_key HAVING count(*)>1)x;
 END IF;
 SELECT count(*) INTO v_warnings FROM cf_private.collection_reference_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.problems)p
  WHERE c.job_id=p_job_id AND coalesce(p->>'code','') LIKE 'WARN\_%' ESCAPE '\';
 SELECT coalesce(jsonb_agg(jsonb_build_object('source_line',r.source_line,'outcome',r.outcome,'client_name',r.canonical->>'client_name',
  'document',r.canonical->>'document','branch',r.canonical->>'branch','problem',coalesce(r.analysis_problem,CASE r.outcome WHEN 'UNMATCHED' THEN 'Sem título ativo correspondente.'
   WHEN 'PAID_ONLY' THEN 'Somente títulos validados: referência mantida fora da exibição.' WHEN 'AMBIGUOUS' THEN 'Nome sem CNPJ não confirma o vínculo com este cadastro.'
   WHEN 'INVALID' THEN 'Linha com informação inválida ou incompleta; consulte a fonte privada.' WHEN 'MANUAL_PRESERVED' THEN 'Ficha já editada manualmente; preservada integralmente.' END))
  ORDER BY r.source_line,r.row_hash),'[]'::jsonb) INTO v_examples FROM(
   SELECT * FROM cf_private.collection_reference_rows WHERE job_id=p_job_id ORDER BY CASE WHEN outcome<>'MATCHED' THEN 0 ELSE 1 END,source_line,row_hash LIMIT 100)r;
 SELECT revision::text INTO v_context_revision FROM cf_private.collection_context_state WHERE singleton;
 RETURN v_result||jsonb_build_object('job_id',p_job_id,'mode',v_job.mode,'status',v_job.status,'financial_revision',cf_private.receivables_sync_revision_value(),
  'context_revision',v_context_revision,'manifest_sha256',v_job.manifest_sha256,'source',jsonb_build_object('name',v_job.source_name,'size',v_job.source_size,'sha256',v_job.source_sha256,'verified',true),
  'warning_count',v_warnings,'variant_count',v_variants,'can_publish',true,'requires_quarantine_confirmation',(v_result->>'quarantine_count')::integer>0,'examples',v_examples);
END $$;

ALTER FUNCTION public.preview_collection_reference_import_from_gateway(uuid,text,uuid) SET lock_timeout='5s';
ALTER FUNCTION public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid) SET lock_timeout='5s';
REVOKE ALL ON FUNCTION cf_private.analyze_collection_reference_job(uuid) FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.central_schema_migrations(version) VALUES('049_collection_reference_preview_work') ON CONFLICT(version) DO NOTHING;
$cf049ddl$;
END $cf049$;
COMMIT;
