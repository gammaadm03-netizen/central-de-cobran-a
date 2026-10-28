-- Atualização dos contatos importados: substitui dados da fonte e preserva fichas manuais.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $cf052$ BEGIN
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='052_collection_contact_refresh') THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='049_collection_reference_preview_work')
  OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN
  RAISE EXCEPTION 'Ative o relatório completo 047 e a conferência de referências 049 antes da atualização de contatos.' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(2045812308);
 EXECUTE $cf052ddl$
CREATE OR REPLACE FUNCTION public.stage_collection_reference_chunk_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_chunk_index integer,p_chunk_sha256 text,
 p_chunk_base64 text,p_rows jsonb,p_problems jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_chunk cf_private.collection_reference_chunks%ROWTYPE;v_bytes bytea;v_row jsonb;v_canonical jsonb;
 v_problem jsonb;v_customer text;v_context text;v_invalid boolean;v_hash text;v_inserted integer:=0;v_count integer;v_field text;v_value jsonb;v_dummy jsonb;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF NOT v_job.original_verified OR p_chunk_index IS NULL OR p_chunk_index NOT BETWEEN 0 AND 1023 OR p_chunk_sha256 IS NULL OR p_chunk_sha256!~'^[a-f0-9]{64}$'
  OR p_chunk_base64 IS NULL OR length(p_chunk_base64) NOT BETWEEN 1 AND 349528 OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500
  OR p_problems IS NULL OR jsonb_typeof(p_problems)<>'array' OR jsonb_array_length(p_problems)>10000 OR octet_length(p_problems::text)>1048576 THEN
  RAISE EXCEPTION 'Lote inválido ou original ainda não verificado.' USING ERRCODE='22023';END IF;
 BEGIN v_bytes:=decode(p_chunk_base64,'base64');EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN RAISE EXCEPTION 'CSV derivado inválido.' USING ERRCODE='22023';END;
 IF octet_length(v_bytes) NOT BETWEEN 1 AND 262144 OR encode(sha256(v_bytes),'hex')<>p_chunk_sha256 THEN RAISE EXCEPTION 'A integridade do CSV derivado não foi confirmada.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_chunk FROM cf_private.collection_reference_chunks WHERE job_id=p_job_id AND chunk_index=p_chunk_index;
 IF FOUND THEN IF v_chunk.sha256<>p_chunk_sha256 OR v_chunk.rows_sha256<>encode(sha256(convert_to(p_rows::text,'UTF8')),'hex') OR v_chunk.row_count<>jsonb_array_length(p_rows) OR v_chunk.problems<>p_problems THEN
  RAISE EXCEPTION 'O lote já existe com outro conteúdo.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('job_id',p_job_id,'chunk_index',p_chunk_index,'row_count',v_chunk.row_count,'duplicate',true,'staged_rows',v_job.staged_rows,'staged_chunks',v_job.staged_chunks);END IF;
 IF v_job.status NOT IN ('VERIFIED','STAGING') OR v_job.staged_input_rows+jsonb_array_length(p_rows)>300000 OR v_job.staged_bytes+octet_length(v_bytes)>134217728 THEN
  RAISE EXCEPTION 'A preparação está encerrada ou excedeu o limite permitido.' USING ERRCODE='22023';END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(v_row)<>'object' OR jsonb_typeof(v_row->'source_line')<>'number' OR (v_row->>'source_line')::numeric<>trunc((v_row->>'source_line')::numeric)
   OR (v_row->>'source_line')::numeric NOT BETWEEN 1 AND 1000000 OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN
    ('source_line','client_name','client_document','emails','phones','notes','document','branch','description','contract')) THEN RAISE EXCEPTION 'Estrutura de linha inválida.' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(v_row->'client_name') IS DISTINCT FROM 'string' OR length(v_row->>'client_name')>1500
   OR (v_row->'client_document' IS NOT NULL AND jsonb_typeof(v_row->'client_document') NOT IN ('string','null')) THEN RAISE EXCEPTION 'Identificação do cliente inválida.' USING ERRCODE='22023';END IF;
  v_canonical:=v_row-'source_line';v_canonical:=v_canonical||jsonb_build_object('client_name',cf_private.normalize_receivable_text(v_row->>'client_name'),'client_document',nullif(v_row->>'client_document',''));
  v_invalid:=length(v_canonical->>'client_name')=0 OR (v_canonical->>'client_document' IS NOT NULL AND v_canonical->>'client_document'!~'^[0-9]{14}$');
  SELECT coalesce(jsonb_agg(p),'[]'::jsonb) INTO v_problem FROM jsonb_array_elements(p_problems)p WHERE p->>'source_line'=v_row->>'source_line';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_problem)p WHERE coalesce(p->>'code','') NOT LIKE 'WARN\_%' ESCAPE '\') THEN v_invalid:=true;END IF;
  IF v_job.mode='CONTACTS' THEN
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_canonical) k WHERE k NOT IN ('client_name','client_document','emails','phones','notes')) OR
    jsonb_typeof(v_canonical->'emails') IS DISTINCT FROM 'array' OR jsonb_typeof(v_canonical->'phones') IS DISTINCT FROM 'array' OR
    jsonb_array_length(v_canonical->'emails')>50 OR jsonb_array_length(v_canonical->'phones')>50 OR length(coalesce(v_canonical->>'notes',''))>5000 THEN
    RAISE EXCEPTION 'Canais de contato inválidos.' USING ERRCODE='22023';END IF;
   BEGIN
    v_dummy:=cf_private.normalize_collection_contact_methods(v_canonical->'emails','emails');v_canonical:=v_canonical||jsonb_build_object('emails',v_dummy);
    v_dummy:=cf_private.normalize_collection_contact_methods(v_canonical->'phones','phones');v_canonical:=v_canonical||jsonb_build_object('phones',v_dummy);
   EXCEPTION WHEN invalid_parameter_value THEN v_invalid:=true;END;
   IF jsonb_array_length(v_canonical->'emails')=0 AND jsonb_array_length(v_canonical->'phones')=0 THEN v_invalid:=true;END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_canonical) k WHERE k NOT IN ('client_name','client_document','document','branch','description','contract')) THEN RAISE EXCEPTION 'Referência de documento inválida.' USING ERRCODE='22023';END IF;
   FOREACH v_field IN ARRAY ARRAY['document','branch','description'] LOOP
    IF jsonb_typeof(v_canonical->v_field) IS DISTINCT FROM 'string' OR length(v_canonical->>v_field)>(CASE WHEN v_field='description' THEN 12000 ELSE 150 END) THEN
     RAISE EXCEPTION 'Campo de descrição inválido ou muito longo.' USING ERRCODE='22023';END IF;
    IF length(cf_private.normalize_receivable_text(v_canonical->>v_field))=0 THEN v_invalid:=true;END IF;
   END LOOP;
   IF v_canonical->'contract' IS NOT NULL AND jsonb_typeof(v_canonical->'contract') NOT IN ('string','null') OR length(coalesce(v_canonical->>'contract',''))>300 THEN
    RAISE EXCEPTION 'Contrato inválido.' USING ERRCODE='22023';END IF;
   v_canonical:=v_canonical||jsonb_build_object('document',cf_private.normalize_receivable_text(v_canonical->>'document'),
    'branch',cf_private.normalize_receivable_text(v_canonical->>'branch'),'description',btrim(v_canonical->>'description'),'contract',nullif(btrim(v_canonical->>'contract'),''));
  END IF;
  v_customer:=CASE WHEN length(v_canonical->>'client_name')>0 THEN cf_private.receivable_customer_key(v_canonical->>'client_name',v_canonical->>'client_document') END;
  v_context:=CASE WHEN v_job.mode='DESCRIPTIONS' AND v_customer IS NOT NULL THEN cf_private.collection_reference_key(v_canonical->>'branch',v_canonical->>'document',v_customer) END;
  -- O hash válido e rows_sha256 continuam iguais aos do protocolo legado.
  -- Só a derivação de linha inválida de contatos recebe domínio separado,
  -- para que uma truncagem inválida não desapareça atrás de linha válida.
  v_hash:=encode(sha256(convert_to(CASE WHEN v_job.mode='CONTACTS' AND v_invalid
   THEN jsonb_build_array(v_canonical,'INVALID')::text ELSE v_canonical::text END,'UTF8')),'hex');
  INSERT INTO cf_private.collection_reference_rows(job_id,row_hash,source_line,canonical,problems,customer_key,context_key,invalid,outcome)
   VALUES(p_job_id,v_hash,(v_row->>'source_line')::integer,v_canonical,v_problem,v_customer,v_context,v_invalid,CASE WHEN v_invalid THEN 'INVALID' ELSE 'UNMATCHED' END) ON CONFLICT(job_id,row_hash) DO NOTHING;
  GET DIAGNOSTICS v_count=ROW_COUNT;v_inserted:=v_inserted+v_count;
 END LOOP;
 INSERT INTO cf_private.collection_reference_chunks(job_id,chunk_index,sha256,rows_sha256,artifact,row_count,problems)
  VALUES(p_job_id,p_chunk_index,p_chunk_sha256,encode(sha256(convert_to(p_rows::text,'UTF8')),'hex'),v_bytes,jsonb_array_length(p_rows),p_problems);
 UPDATE cf_private.collection_reference_jobs SET status='STAGING',staged_rows=staged_rows+v_inserted,staged_chunks=staged_chunks+1,
  staged_input_rows=staged_input_rows+jsonb_array_length(p_rows),staged_bytes=staged_bytes+octet_length(v_bytes) WHERE id=p_job_id RETURNING * INTO v_job;
 RETURN jsonb_build_object('job_id',p_job_id,'chunk_index',p_chunk_index,'row_count',jsonb_array_length(p_rows),'duplicate',false,'staged_rows',v_job.staged_rows,'staged_chunks',v_job.staged_chunks);
END $$;
CREATE OR REPLACE FUNCTION cf_private.analyze_collection_reference_job(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_financial text;v_context text;v_unresolved_invalid boolean:=false;BEGIN
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
 IF v_job.mode='CONTACTS' THEN
  -- Preparações do serviço antigo podem ter perdido uma linha inválida por
  -- deduplicação canônica. A fonte/linha imutável não será reescrita: sem
  -- provar a qual cliente pertence o erro, preservar todas as fichas.
  WITH represented AS MATERIALIZED(
   SELECT source_line::text AS source_line FROM cf_private.collection_reference_rows WHERE job_id=p_job_id
  ),fatal_lines AS MATERIALIZED(
   SELECT DISTINCT p->>'source_line' AS source_line FROM cf_private.collection_reference_chunks c
   CROSS JOIN LATERAL jsonb_array_elements(c.problems)p WHERE c.job_id=p_job_id
    AND coalesce(p->>'code','') NOT LIKE 'WARN\_%' ESCAPE '\'
  ) SELECT EXISTS(SELECT 1 FROM fatal_lines f LEFT JOIN represented r USING(source_line) WHERE r.source_line IS NULL)
   INTO v_unresolved_invalid;
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
 incoming_keys AS MATERIALIZED(SELECT DISTINCT customer_key FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND v_job.mode='CONTACTS'),
 invalid_customers AS MATERIALIZED(SELECT DISTINCT customer_key FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND v_job.mode='CONTACTS' AND invalid),
 newer_sources AS MATERIALIZED(
  -- Arquivos mais novos já confirmados são um marco mesmo quando seus canais
  -- eram idênticos e não houve alteração da ficha ou de sua revisão.
  SELECT DISTINCT r.customer_key FROM cf_private.collection_reference_jobs j
  JOIN cf_private.collection_reference_rows r ON r.job_id=j.id
  JOIN incoming_keys k USING(customer_key)
  WHERE v_job.mode='CONTACTS' AND j.mode='CONTACTS' AND j.status='PUBLISHED' AND r.applied
   AND ROW(j.created_at,j.id)>ROW(v_job.created_at,v_job.id)
 ),classified AS MATERIALIZED(
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
 ),methods AS(
  SELECT c.customer_key,'email' AS kind,e#>>'{}' AS value FROM classified c
   CROSS JOIN LATERAL jsonb_array_elements(c.canonical->'emails')e WHERE v_job.mode='CONTACTS' AND c.outcome='MATCHED'
  UNION SELECT c.customer_key,'phone',p#>>'{}' FROM classified c
   CROSS JOIN LATERAL jsonb_array_elements(c.canonical->'phones')p WHERE v_job.mode='CONTACTS' AND c.outcome='MATCHED'
 ),overflow AS MATERIALIZED(SELECT DISTINCT customer_key FROM methods GROUP BY customer_key,kind HAVING count(DISTINCT value)>50),
 note_overflow AS MATERIALIZED(
  SELECT customer_key FROM classified WHERE v_job.mode='CONTACTS' AND outcome='MATCHED'
  GROUP BY customer_key HAVING length(string_agg(DISTINCT nullif(canonical->>'notes',''),E'\n' ORDER BY nullif(canonical->>'notes','')))>5000
 ),resolved AS(
  SELECT c.row_hash,c.title_count,CASE
   WHEN v_unresolved_invalid AND c.outcome='MATCHED' THEN 'INVALID'
   WHEN c.outcome IN('MATCHED','INVALID') AND bad.customer_key IS NOT NULL THEN 'INVALID'
   WHEN c.outcome='MATCHED' AND newer.customer_key IS NOT NULL THEN 'INVALID'
   WHEN o.customer_key IS NOT NULL OR n.customer_key IS NOT NULL THEN 'INVALID' ELSE c.outcome END AS outcome,
   CASE WHEN v_unresolved_invalid AND c.outcome='MATCHED'
     THEN 'SOURCE_INVALID_ROWS_UNRESOLVED: a preparação contém linha inválida sem identificação preservada; corrija as linhas inválidas na fonte e envie novamente o arquivo. As fichas atuais serão preservadas.'
    WHEN c.outcome IN('MATCHED','INVALID') AND bad.customer_key IS NOT NULL
     THEN 'INVALID_CUSTOMER_ROWS: há linha inválida deste cliente no arquivo; a ficha inteira será preservada até a correção da fonte.'
    WHEN c.outcome='MATCHED' AND newer.customer_key IS NOT NULL
     THEN 'SOURCE_OLDER: este arquivo foi preparado antes de uma importação de contatos já concluída para o cliente; a ficha mais recente será preservada.'
    WHEN o.customer_key IS NOT NULL THEN 'LIMIT_METHODS: o novo relatório excederia 50 e-mails ou telefones para o cliente; nenhum canal foi truncado.'
    WHEN n.customer_key IS NOT NULL THEN 'LIMIT_NOTES: as observações deste cliente excedem 5000 caracteres; a ficha inteira será preservada.' END AS problem
  FROM classified c LEFT JOIN overflow o USING(customer_key) LEFT JOIN note_overflow n USING(customer_key)
   LEFT JOIN invalid_customers bad USING(customer_key) LEFT JOIN newer_sources newer USING(customer_key)
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
 RETURN v_result||CASE WHEN v_job.mode='CONTACTS' THEN jsonb_build_object('contact_refresh_version','052') ELSE '{}'::jsonb END||jsonb_build_object('job_id',p_job_id,'mode',v_job.mode,'status',v_job.status,'financial_revision',cf_private.receivables_sync_revision_value(),
  'context_revision',v_context_revision,'manifest_sha256',v_job.manifest_sha256,'source',jsonb_build_object('name',v_job.source_name,'size',v_job.source_size,'sha256',v_job.source_sha256,'verified',true),
  'warning_count',v_warnings,'variant_count',v_variants,'can_publish',true,'requires_quarantine_confirmation',(v_result->>'quarantine_count')::integer>0,'examples',v_examples);
END $$;

CREATE OR REPLACE FUNCTION public.publish_collection_reference_import_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_previous_financial_revision text,
 p_confirm_quarantine boolean DEFAULT false,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_request cf_private.collection_reference_publish_requests%ROWTYPE;v_payload jsonb;v_preview jsonb;v_result jsonb;
 v_quarantine integer;v_applied integer;v_manual integer;v_actor public.profiles%ROWTYPE;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF p_request_id IS NULL OR p_confirm_quarantine IS NULL THEN RAISE EXCEPTION 'Confirme a operação e seu identificador seguro.' USING ERRCODE='22023';END IF;
 v_payload:=jsonb_build_object('job_id',p_job_id,'previous_financial_revision',p_previous_financial_revision,'confirm_quarantine',p_confirm_quarantine);
 SELECT * INTO v_request FROM cf_private.collection_reference_publish_requests WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN IF v_request.job_id<>p_job_id OR v_request.payload<>v_payload THEN RAISE EXCEPTION 'Identificador usado para outra publicação.' USING ERRCODE='22023';END IF;RETURN v_request.result;END IF;
 IF NOT v_job.original_verified OR v_job.manifest_sha256 IS NULL OR v_job.status NOT IN ('PREPARED','PUBLISHING','PUBLISHED') OR p_previous_financial_revision IS NULL
  OR p_previous_financial_revision IS DISTINCT FROM v_job.analysis_financial_revision OR p_previous_financial_revision IS DISTINCT FROM cf_private.receivables_sync_revision_value() THEN
  RAISE EXCEPTION 'A carteira mudou ou a análise não está atual. Analise novamente antes de publicar.' USING ERRCODE='40001';END IF;
 v_preview:=public.preview_collection_reference_import_from_gateway(p_user_id,p_session_id,p_job_id);
 v_quarantine:=(v_preview->>'quarantine_count')::integer;v_manual:=(v_preview->>'manual_preserved_count')::integer;
 IF v_quarantine>0 AND NOT p_confirm_quarantine THEN RAISE EXCEPTION 'Confirme as referências sem vínculo, inválidas ou já quitadas; elas ficarão privadas fora da exibição.' USING ERRCODE='P0028';END IF;
 IF v_job.mode='CONTACTS' THEN
  WITH customers AS MATERIALIZED(
   SELECT customer_key,min(canonical->>'client_name') AS client_name,min(canonical->>'client_document') AS client_document,
    string_agg(DISTINCT nullif(canonical->>'notes',''),E'\n' ORDER BY nullif(canonical->>'notes','')) AS notes FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome='MATCHED' AND NOT applied GROUP BY customer_key
  ),incoming AS(
   SELECT c.*,(SELECT coalesce(jsonb_agg(DISTINCT e ORDER BY e),'[]'::jsonb) FROM cf_private.collection_reference_rows r
    CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'emails')e WHERE r.job_id=p_job_id AND r.customer_key=c.customer_key AND r.outcome='MATCHED') AS emails,
   (SELECT coalesce(jsonb_agg(DISTINCT p ORDER BY p),'[]'::jsonb) FROM cf_private.collection_reference_rows r
    CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'phones')p WHERE r.job_id=p_job_id AND r.customer_key=c.customer_key AND r.outcome='MATCHED') AS phones FROM customers c
  ) INSERT INTO public.collection_customer_contacts(customer_key,client_name,client_document,emails,phones,notes,updated_by,source_job_id)
   SELECT customer_key,client_name,client_document,emails,phones,notes,auth.uid(),p_job_id FROM incoming
  ON CONFLICT(customer_key) DO UPDATE SET
   client_name=EXCLUDED.client_name,client_document=EXCLUDED.client_document,
   emails=EXCLUDED.emails,phones=EXCLUDED.phones,notes=EXCLUDED.notes,
   revision=collection_customer_contacts.revision+1,updated_at=clock_timestamp(),updated_by=EXCLUDED.updated_by,source_job_id=p_job_id
  WHERE NOT collection_customer_contacts.manually_edited AND
   ROW(collection_customer_contacts.client_name,collection_customer_contacts.client_document,collection_customer_contacts.emails,collection_customer_contacts.phones,collection_customer_contacts.notes)
    IS DISTINCT FROM ROW(EXCLUDED.client_name,EXCLUDED.client_document,EXCLUDED.emails,EXCLUDED.phones,EXCLUDED.notes);
 ELSE
  INSERT INTO public.collection_description_references(context_key,customer_key,branch,document,description,contract,content_sha256,source_job_id)
  SELECT context_key,customer_key,canonical->>'branch',canonical->>'document',canonical->>'description',canonical->>'contract',
   encode(sha256(convert_to(jsonb_build_array(canonical->>'description',canonical->>'contract')::text,'UTF8')),'hex'),p_job_id
  FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome='MATCHED' AND NOT applied ON CONFLICT(context_key,content_sha256) DO NOTHING;
 END IF;
 UPDATE cf_private.collection_reference_rows SET applied=true WHERE job_id=p_job_id AND outcome='MATCHED' AND NOT applied;
 SELECT count(*) INTO v_applied FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND applied;
 v_result:=CASE WHEN v_job.mode='CONTACTS' THEN jsonb_build_object('contact_refresh_version','052') ELSE '{}'::jsonb END||jsonb_build_object('job_id',p_job_id,'status','PUBLISHED','done',true,'processed_rows',v_job.staged_rows,'published_rows',v_applied,
  'skipped_manual_rows',v_manual,'quarantined_rows',v_quarantine,'remaining_rows',0,'manifest_sha256',v_job.manifest_sha256,'source_sha256',v_job.source_sha256);
 UPDATE cf_private.collection_reference_jobs SET status='PUBLISHED',last_result=v_result,published_at=clock_timestamp() WHERE id=p_job_id;
 IF v_job.mode='CONTACTS' AND v_applied>0 THEN
  -- A publicação de uma fonte idêntica também estabelece ordem de atualização.
  -- Não depender de uma alteração na ficha para invalidar o cálculo temporal.
  UPDATE cf_private.collection_reference_jobs SET analysis_context_revision=NULL
   WHERE mode='CONTACTS' AND status IN('PREPARED','PUBLISHING') AND id<>p_job_id
    AND ROW(created_at,id)<ROW(v_job.created_at,v_job.id) AND analysis_context_revision IS NOT NULL;
 END IF;
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'cobranca','collection_reference_publication',p_job_id::text,'IMPORT',v_job.last_result,v_result);
 INSERT INTO cf_private.collection_reference_publish_requests(actor_id,request_id,job_id,payload,result) VALUES(auth.uid(),p_request_id,p_job_id,v_payload,v_result);RETURN v_result;
END $$;

ALTER FUNCTION public.preview_collection_reference_import_from_gateway(uuid,text,uuid) SET lock_timeout='5s';
ALTER FUNCTION public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid) SET lock_timeout='5s';
REVOKE ALL ON FUNCTION cf_private.analyze_collection_reference_job(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.preview_collection_reference_import_from_gateway(uuid,text,uuid),public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preview_collection_reference_import_from_gateway(uuid,text,uuid),public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid) TO service_role;
-- PREPARED é imutável quanto à fonte. Apenas seu resultado derivado é invalidado.
-- Fontes já publicadas e flags applied nunca são reaplicadas por esta atualização.
UPDATE cf_private.collection_reference_jobs SET analysis_context_revision=NULL
 WHERE mode='CONTACTS' AND status<>'PUBLISHED' AND analysis_context_revision IS NOT NULL;
INSERT INTO public.central_schema_migrations(version) VALUES('052_collection_contact_refresh');
$cf052ddl$;
END $cf052$;
NOTIFY pgrst,'reload schema';
COMMIT;
