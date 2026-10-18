-- Fontes privadas e preparação limitada; publicação oficial única e transacional.
-- CSV efetivo é artefato derivado, distinto do arquivo original preservado.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='027_collection_customer_context') OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='023_receivable_sync') THEN
  RAISE EXCEPTION 'Ative as atualizações 023 e 027 antes das referências de Cobrança.' USING ERRCODE='22023';END IF;
 IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
  RAISE EXCEPTION 'O armazenamento privado do Supabase precisa estar disponível.' USING ERRCODE='22023';END IF;
END $$;

CREATE TABLE cf_private.collection_reference_jobs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 mode text NOT NULL CHECK(mode IN ('CONTACTS','DESCRIPTIONS')),source_name text NOT NULL,source_size bigint NOT NULL CHECK(source_size BETWEEN 1 AND 16777216),
 source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),storage_path text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'UPLOADING' CHECK(status IN ('UPLOADING','VERIFIED','STAGING','PREPARED','PUBLISHING','PUBLISHED')),
 original_verified boolean NOT NULL DEFAULT false,verified_at timestamptz,manifest_sha256 text,
 staged_rows integer NOT NULL DEFAULT 0,staged_chunks integer NOT NULL DEFAULT 0,staged_input_rows integer NOT NULL DEFAULT 0,staged_bytes bigint NOT NULL DEFAULT 0,
 analysis_financial_revision text,analysis_at timestamptz,last_result jsonb,published_at timestamptz,
 UNIQUE(created_by,mode,source_sha256)
);
CREATE TABLE cf_private.collection_reference_chunks(
 job_id uuid NOT NULL REFERENCES cf_private.collection_reference_jobs(id),chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 1023),
 sha256 text NOT NULL,rows_sha256 text NOT NULL,artifact bytea NOT NULL CHECK(octet_length(artifact) BETWEEN 1 AND 262144),row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 500),
 problems jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(job_id,chunk_index)
);
CREATE TABLE cf_private.collection_reference_rows(
 job_id uuid NOT NULL REFERENCES cf_private.collection_reference_jobs(id),row_hash text NOT NULL,source_line integer NOT NULL,
 canonical jsonb NOT NULL,problems jsonb NOT NULL,customer_key text,context_key text,invalid boolean NOT NULL,
 outcome text NOT NULL DEFAULT 'UNMATCHED',analysis_problem text,matched_title_count integer NOT NULL DEFAULT 0,applied boolean NOT NULL DEFAULT false,
 PRIMARY KEY(job_id,row_hash)
);
CREATE INDEX collection_reference_row_customer ON cf_private.collection_reference_rows(job_id,customer_key);
CREATE INDEX collection_reference_row_context ON cf_private.collection_reference_rows(job_id,context_key);
CREATE TABLE cf_private.collection_reference_publish_requests(
 actor_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES cf_private.collection_reference_jobs(id),
 payload jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id)
);
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['collection_reference_jobs','collection_reference_chunks','collection_reference_rows','collection_reference_publish_requests'] LOOP
  EXECUTE format('ALTER TABLE cf_private.%I ENABLE ROW LEVEL SECURITY',v_table);
  EXECUTE format('REVOKE ALL ON TABLE cf_private.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
 END LOOP;
END $$;
ALTER TABLE public.collection_customer_contacts ADD CONSTRAINT collection_contact_source_job FOREIGN KEY(source_job_id) REFERENCES cf_private.collection_reference_jobs(id);
ALTER TABLE public.collection_description_references ADD CONSTRAINT collection_description_source_job FOREIGN KEY(source_job_id) REFERENCES cf_private.collection_reference_jobs(id);
CREATE TRIGGER collection_reference_chunk_immutable BEFORE UPDATE OR DELETE ON cf_private.collection_reference_chunks FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER collection_reference_publish_immutable BEFORE UPDATE OR DELETE ON cf_private.collection_reference_publish_requests FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE FUNCTION cf_private.collection_reference_job_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.created_by,NEW.created_at,NEW.mode,NEW.source_name,NEW.source_size,NEW.source_sha256,NEW.storage_path)
  IS DISTINCT FROM ROW(OLD.id,OLD.created_by,OLD.created_at,OLD.mode,OLD.source_name,OLD.source_size,OLD.source_sha256,OLD.storage_path)
  OR OLD.original_verified AND NOT NEW.original_verified OR OLD.manifest_sha256 IS NOT NULL AND NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256 THEN
  RAISE EXCEPTION 'A fonte e o manifesto preparados são imutáveis.' USING ERRCODE='42501';END IF;RETURN NEW;
END $$;
CREATE TRIGGER collection_reference_job_immutable BEFORE UPDATE OR DELETE ON cf_private.collection_reference_jobs FOR EACH ROW EXECUTE FUNCTION cf_private.collection_reference_job_guard();
CREATE FUNCTION cf_private.collection_reference_row_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.row_hash,NEW.source_line,NEW.canonical,NEW.problems,NEW.customer_key,NEW.context_key,NEW.invalid)
  IS DISTINCT FROM ROW(OLD.job_id,OLD.row_hash,OLD.source_line,OLD.canonical,OLD.problems,OLD.customer_key,OLD.context_key,OLD.invalid)
  OR OLD.applied AND NOT NEW.applied THEN RAISE EXCEPTION 'O artefato preparado é imutável.' USING ERRCODE='42501';END IF;RETURN NEW;
END $$;
CREATE TRIGGER collection_reference_rows_immutable BEFORE UPDATE OR DELETE ON cf_private.collection_reference_rows FOR EACH ROW EXECUTE FUNCTION cf_private.collection_reference_row_guard();

CREATE FUNCTION cf_private.require_collection_reference_import() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM cf_private.require_receivable_finance('read');PERFORM cf_private.require_receivable_finance('write');PERFORM cf_private.require_receivable_finance('import');
 IF NOT cf_private.has_permission('importar_bases','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION cf_private.collection_reference_actor(p_user_id uuid,p_session_id text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM cf_private.set_receivable_sync_actor(p_user_id,p_session_id);PERFORM cf_private.require_collection_reference_import();
END $$;
CREATE FUNCTION cf_private.collection_reference_owned_job(p_job_id uuid) RETURNS cf_private.collection_reference_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;BEGIN
 PERFORM cf_private.require_collection_reference_import();SELECT * INTO v_job FROM cf_private.collection_reference_jobs WHERE id=p_job_id AND created_by=auth.uid();
 IF NOT FOUND THEN RAISE EXCEPTION 'Importação indisponível.' USING ERRCODE='42501';END IF;RETURN v_job;
END $$;
CREATE FUNCTION cf_private.collection_reference_job_json(p_job cf_private.collection_reference_jobs) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('job_id',p_job.id,'mode',p_job.mode,'status',p_job.status,'bucket','collection-reference-files','storage_path',p_job.storage_path,
  'source_name',p_job.source_name,'source_size',p_job.source_size,'source_sha256',p_job.source_sha256,'original_verified',p_job.original_verified,
  'manifest_sha256',p_job.manifest_sha256,'staged_rows',p_job.staged_rows,'staged_chunks',p_job.staged_chunks,'created_at',p_job.created_at,'published_at',p_job.published_at);
$$;
CREATE FUNCTION cf_private.collection_reference_storage_allowed(p_name text,p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT current_setting('role',true)<>'anon' AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND p.role_key IN ('gerente_geral','contas_receber'))
  AND cf_private.has_permission('contas_receber','read') AND cf_private.has_permission('contas_receber','write') AND cf_private.has_permission('contas_receber','import')
  AND cf_private.has_permission('importar_bases','read') AND EXISTS(SELECT 1 FROM cf_private.collection_reference_jobs j WHERE j.created_by=auth.uid()
   AND j.storage_path=p_name AND (NOT p_write OR j.status='UPLOADING' AND NOT j.original_verified));
$$;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('collection-reference-files','collection-reference-files',false,16777216,NULL)
 ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=16777216;
CREATE POLICY collection_reference_upload ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='collection-reference-files' AND cf_private.collection_reference_storage_allowed(name,true));
CREATE POLICY collection_reference_download ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='collection-reference-files' AND cf_private.collection_reference_storage_allowed(name,false));
CREATE POLICY collection_reference_insert_guard ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated
 WITH CHECK(bucket_id<>'collection-reference-files' OR cf_private.collection_reference_storage_allowed(name,true));
CREATE POLICY collection_reference_read_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO anon,authenticated
 USING(bucket_id<>'collection-reference-files' OR cf_private.collection_reference_storage_allowed(name,false));
CREATE POLICY collection_reference_no_overwrite ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated
 USING(bucket_id<>'collection-reference-files') WITH CHECK(bucket_id<>'collection-reference-files');
CREATE POLICY collection_reference_no_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated USING(bucket_id<>'collection-reference-files');

CREATE FUNCTION public.begin_collection_reference_import_from_gateway(p_user_id uuid,p_session_id text,p_mode text,p_file_name text,p_file_size bigint,p_file_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_id uuid:=gen_random_uuid();BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);
 IF p_mode IS NULL OR p_mode NOT IN ('CONTACTS','DESCRIPTIONS') OR p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 250
  OR p_file_name~'[/\\[:cntrl:]]' OR p_file_size IS NULL OR p_file_size NOT BETWEEN 1 AND 16777216 OR p_file_sha256 IS NULL OR p_file_sha256!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Confira modo, nome, tamanho e integridade da fonte.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_job FROM cf_private.collection_reference_jobs WHERE created_by=auth.uid() AND mode=p_mode AND source_sha256=p_file_sha256;
 IF FOUND THEN IF v_job.source_size<>p_file_size THEN RAISE EXCEPTION 'A fonte não corresponde à importação já criada.' USING ERRCODE='22023';END IF;
  RETURN cf_private.collection_reference_job_json(v_job)||jsonb_build_object('reused',true);END IF;
 INSERT INTO cf_private.collection_reference_jobs(id,created_by,mode,source_name,source_size,source_sha256,storage_path)
 VALUES(v_id,auth.uid(),p_mode,btrim(p_file_name),p_file_size,p_file_sha256,auth.uid()::text||'/'||v_id::text||'/original') RETURNING * INTO v_job;
 RETURN cf_private.collection_reference_job_json(v_job)||jsonb_build_object('reused',false);
END $$;
CREATE FUNCTION public.get_collection_reference_job_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);
 RETURN cf_private.collection_reference_job_json(cf_private.collection_reference_owned_job(p_job_id));END $$;
CREATE FUNCTION public.list_collection_reference_imports_from_gateway(p_user_id uuid,p_session_id text,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_rows jsonb;v_count bigint;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);
 IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Paginação inválida.' USING ERRCODE='22023';END IF;
 SELECT count(*) INTO v_count FROM cf_private.collection_reference_jobs WHERE created_by=auth.uid();
 SELECT coalesce(jsonb_agg(cf_private.collection_reference_job_json(j) ORDER BY j.created_at DESC,j.id DESC),'[]'::jsonb) INTO v_rows
  FROM(SELECT * FROM cf_private.collection_reference_jobs WHERE created_by=auth.uid() ORDER BY created_at DESC,id DESC OFFSET p_offset LIMIT p_limit)j;
 RETURN jsonb_build_object('count',v_count,'rows',v_rows);
END $$;
CREATE FUNCTION public.verify_collection_reference_original_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_verified_sha256 text,p_verified_size bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF p_verified_sha256 IS DISTINCT FROM v_job.source_sha256 OR p_verified_size IS DISTINCT FROM v_job.source_size OR NOT EXISTS(
  SELECT 1 FROM storage.objects WHERE bucket_id='collection-reference-files' AND name=v_job.storage_path) THEN
  RAISE EXCEPTION 'O original privado não teve sua integridade confirmada.' USING ERRCODE='22023';END IF;
 IF NOT v_job.original_verified THEN UPDATE cf_private.collection_reference_jobs SET original_verified=true,verified_at=clock_timestamp(),status='VERIFIED'
  WHERE id=p_job_id RETURNING * INTO v_job;END IF;RETURN cf_private.collection_reference_job_json(v_job);
END $$;

CREATE FUNCTION public.stage_collection_reference_chunk_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_chunk_index integer,p_chunk_sha256 text,
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
  v_hash:=encode(sha256(convert_to(v_canonical::text,'UTF8')),'hex');
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
CREATE FUNCTION public.finish_collection_reference_prepare_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_expected_chunks integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_manifest text;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF NOT v_job.original_verified OR p_expected_chunks IS NULL OR p_expected_chunks NOT BETWEEN 1 AND 1024 OR v_job.staged_chunks<>p_expected_chunks OR EXISTS(
  SELECT 1 FROM generate_series(0,p_expected_chunks-1)i WHERE NOT EXISTS(SELECT 1 FROM cf_private.collection_reference_chunks WHERE job_id=p_job_id AND chunk_index=i)) THEN
  RAISE EXCEPTION 'A preparação ainda não contém todos os lotes do arquivo.' USING ERRCODE='22023';END IF;
 SELECT encode(sha256(convert_to(string_agg(chunk_index::text||':'||sha256||':'||row_count::text,E'\n' ORDER BY chunk_index),'UTF8')),'hex') INTO v_manifest
  FROM cf_private.collection_reference_chunks WHERE job_id=p_job_id;
 IF v_job.manifest_sha256 IS NULL THEN UPDATE cf_private.collection_reference_jobs SET manifest_sha256=v_manifest,status='PREPARED' WHERE id=p_job_id RETURNING * INTO v_job;
 ELSIF v_job.manifest_sha256<>v_manifest THEN RAISE EXCEPTION 'O manifesto da preparação mudou.' USING ERRCODE='22023';END IF;
 RETURN cf_private.collection_reference_job_json(v_job);
END $$;

-- Materializar as chaves dos títulos uma única vez evita varrer a carteira
-- para cada uma das dezenas de milhares de referências privadas.
CREATE FUNCTION cf_private.analyze_collection_reference_job(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;BEGIN
 SELECT * INTO v_job FROM cf_private.collection_reference_jobs WHERE id=p_job_id;
 WITH titles AS MATERIALIZED(
  SELECT t.customer_key,t.status,cf_private.collection_reference_key(t.branch,t.document,t.customer_key) AS context_key,
   cf_private.receivable_customer_key(t.client_name,NULL) AS name_key,t.client_document,
   cf_private.collection_reference_key(t.branch,t.document,cf_private.receivable_customer_key(t.client_name,NULL)) AS name_context
  FROM public.receivable_titles t WHERE t.scope='grupo-consolidado'
 ),customers AS MATERIALIZED(
  SELECT customer_key,count(*) FILTER(WHERE status<>'VALIDATED')::integer AS active_count,count(*) FILTER(WHERE status='VALIDATED') AS paid_count FROM titles GROUP BY customer_key
 ),contexts AS MATERIALIZED(
  SELECT context_key,count(*) FILTER(WHERE status<>'VALIDATED')::integer AS active_count,count(*) FILTER(WHERE status='VALIDATED') AS paid_count FROM titles GROUP BY context_key
 ),names AS MATERIALIZED(SELECT name_key,count(*) AS count FROM titles WHERE client_document IS NOT NULL GROUP BY name_key),
 name_contexts AS MATERIALIZED(SELECT name_context,count(*) AS count FROM titles WHERE client_document IS NOT NULL GROUP BY name_context),
 classified AS MATERIALIZED(
  SELECT r.row_hash,r.customer_key,CASE WHEN r.invalid THEN 'INVALID'
   WHEN v_job.mode='CONTACTS' THEN CASE
    WHEN r.canonical->>'client_document' IS NULL AND coalesce(n.count,0)>0 THEN 'AMBIGUOUS'
    WHEN coalesce(c.active_count,0)+coalesce(c.paid_count,0)>0 THEN CASE WHEN card.manually_edited THEN 'MANUAL_PRESERVED' ELSE 'MATCHED' END
    WHEN r.customer_key LIKE 'name:%' THEN CASE WHEN card.manually_edited THEN 'MANUAL_PRESERVED' ELSE 'MATCHED' END
    ELSE 'UNMATCHED' END
   WHEN coalesce(k.active_count,0)>0 THEN 'MATCHED'
   WHEN coalesce(k.paid_count,0)>0 THEN 'PAID_ONLY'
   WHEN r.canonical->>'client_document' IS NULL AND coalesce(nk.count,0)>0 THEN 'AMBIGUOUS'
   ELSE 'UNMATCHED' END AS outcome,
   CASE WHEN v_job.mode='CONTACTS' THEN coalesce(c.active_count,0) ELSE coalesce(k.active_count,0) END AS title_count
  FROM cf_private.collection_reference_rows r LEFT JOIN customers c USING(customer_key) LEFT JOIN contexts k USING(context_key)
   LEFT JOIN public.collection_customer_contacts card USING(customer_key)
   LEFT JOIN names n ON n.name_key=cf_private.receivable_customer_key(r.canonical->>'client_name',NULL)
   LEFT JOIN name_contexts nk ON nk.name_context=cf_private.collection_reference_key(r.canonical->>'branch',r.canonical->>'document',cf_private.receivable_customer_key(r.canonical->>'client_name',NULL))
  WHERE r.job_id=p_job_id
 ),clients AS MATERIALIZED(SELECT DISTINCT customer_key FROM classified WHERE v_job.mode='CONTACTS' AND outcome='MATCHED'),
 methods AS(
  SELECT r.customer_key,'email' AS kind,e#>>'{}' AS value FROM cf_private.collection_reference_rows r JOIN clients c USING(customer_key)
   JOIN classified s ON s.row_hash=r.row_hash AND s.outcome='MATCHED'
   CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'emails')e WHERE r.job_id=p_job_id
  UNION SELECT r.customer_key,'phone',p#>>'{}' FROM cf_private.collection_reference_rows r JOIN clients c USING(customer_key)
   JOIN classified s ON s.row_hash=r.row_hash AND s.outcome='MATCHED'
   CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'phones')p WHERE r.job_id=p_job_id
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
 UPDATE cf_private.collection_reference_jobs SET analysis_financial_revision=cf_private.receivables_sync_revision_value(),analysis_at=clock_timestamp() WHERE id=p_job_id;
END $$;
CREATE FUNCTION public.preview_collection_reference_import_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid) RETURNS jsonb
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
 WITH active_titles AS MATERIALIZED(SELECT id,customer_key,cf_private.collection_reference_key(branch,document,customer_key) AS context_key
  FROM public.receivable_titles WHERE scope='grupo-consolidado' AND status<>'VALIDATED'),
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
CREATE FUNCTION public.publish_collection_reference_import_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_previous_financial_revision text,
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
    min(nullif(canonical->>'notes','')) AS notes FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome='MATCHED' AND NOT applied GROUP BY customer_key
  ),incoming AS(
   SELECT c.*,(SELECT coalesce(jsonb_agg(DISTINCT e ORDER BY e),'[]'::jsonb) FROM cf_private.collection_reference_rows r
    CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'emails')e WHERE r.job_id=p_job_id AND r.customer_key=c.customer_key AND r.outcome='MATCHED') AS emails,
   (SELECT coalesce(jsonb_agg(DISTINCT p ORDER BY p),'[]'::jsonb) FROM cf_private.collection_reference_rows r
    CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'phones')p WHERE r.job_id=p_job_id AND r.customer_key=c.customer_key AND r.outcome='MATCHED') AS phones FROM customers c
  ) INSERT INTO public.collection_customer_contacts(customer_key,client_name,client_document,emails,phones,notes,updated_by,source_job_id)
   SELECT customer_key,client_name,client_document,emails,phones,notes,auth.uid(),p_job_id FROM incoming
  ON CONFLICT(customer_key) DO UPDATE SET
   emails=(SELECT coalesce(jsonb_agg(DISTINCT x ORDER BY x),'[]'::jsonb) FROM jsonb_array_elements(collection_customer_contacts.emails||EXCLUDED.emails)x),
   phones=(SELECT coalesce(jsonb_agg(DISTINCT x ORDER BY x),'[]'::jsonb) FROM jsonb_array_elements(collection_customer_contacts.phones||EXCLUDED.phones)x),
   notes=coalesce(collection_customer_contacts.notes,EXCLUDED.notes),revision=collection_customer_contacts.revision+1,updated_at=clock_timestamp(),updated_by=EXCLUDED.updated_by,source_job_id=p_job_id
  WHERE NOT collection_customer_contacts.manually_edited AND (NOT collection_customer_contacts.emails @> EXCLUDED.emails OR NOT collection_customer_contacts.phones @> EXCLUDED.phones
   OR collection_customer_contacts.notes IS NULL AND EXCLUDED.notes IS NOT NULL);
 ELSE
  INSERT INTO public.collection_description_references(context_key,customer_key,branch,document,description,contract,content_sha256,source_job_id)
  SELECT context_key,customer_key,canonical->>'branch',canonical->>'document',canonical->>'description',canonical->>'contract',
   encode(sha256(convert_to(jsonb_build_array(canonical->>'description',canonical->>'contract')::text,'UTF8')),'hex'),p_job_id
  FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome='MATCHED' AND NOT applied ON CONFLICT(context_key,content_sha256) DO NOTHING;
 END IF;
 UPDATE cf_private.collection_reference_rows SET applied=true WHERE job_id=p_job_id AND outcome='MATCHED' AND NOT applied;
 SELECT count(*) INTO v_applied FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND applied;
 v_result:=jsonb_build_object('job_id',p_job_id,'status','PUBLISHED','done',true,'processed_rows',v_job.staged_rows,'published_rows',v_applied,
  'skipped_manual_rows',v_manual,'quarantined_rows',v_quarantine,'remaining_rows',0,'manifest_sha256',v_job.manifest_sha256,'source_sha256',v_job.source_sha256);
 UPDATE cf_private.collection_reference_jobs SET status='PUBLISHED',last_result=v_result,published_at=clock_timestamp() WHERE id=p_job_id;
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'cobranca','collection_reference_publication',p_job_id::text,'IMPORT',v_job.last_result,v_result);
 INSERT INTO cf_private.collection_reference_publish_requests(actor_id,request_id,job_id,payload,result) VALUES(auth.uid(),p_request_id,p_job_id,v_payload,v_result);RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION cf_private.collection_reference_job_guard(),cf_private.collection_reference_row_guard(),cf_private.require_collection_reference_import(),
 cf_private.collection_reference_actor(uuid,text),cf_private.collection_reference_owned_job(uuid),cf_private.collection_reference_job_json(cf_private.collection_reference_jobs),
 cf_private.collection_reference_storage_allowed(text,boolean),cf_private.analyze_collection_reference_job(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cf_private.collection_reference_storage_allowed(text,boolean) TO anon,authenticated;
REVOKE ALL ON FUNCTION public.begin_collection_reference_import_from_gateway(uuid,text,text,text,bigint,text),public.get_collection_reference_job_from_gateway(uuid,text,uuid),
 public.list_collection_reference_imports_from_gateway(uuid,text,integer,integer),public.verify_collection_reference_original_from_gateway(uuid,text,uuid,text,bigint),
 public.stage_collection_reference_chunk_from_gateway(uuid,text,uuid,integer,text,text,jsonb,jsonb),public.finish_collection_reference_prepare_from_gateway(uuid,text,uuid,integer),
 public.preview_collection_reference_import_from_gateway(uuid,text,uuid),public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_collection_reference_import_from_gateway(uuid,text,text,text,bigint,text),public.get_collection_reference_job_from_gateway(uuid,text,uuid),
 public.list_collection_reference_imports_from_gateway(uuid,text,integer,integer),public.verify_collection_reference_original_from_gateway(uuid,text,uuid,text,bigint),
 public.stage_collection_reference_chunk_from_gateway(uuid,text,uuid,integer,text,text,jsonb,jsonb),public.finish_collection_reference_prepare_from_gateway(uuid,text,uuid,integer),
 public.preview_collection_reference_import_from_gateway(uuid,text,uuid),public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid) TO service_role;
COMMENT ON TABLE cf_private.collection_reference_chunks IS 'CSV derivado efetivo, bytes e SHA privados; não é prova de que a transformação do navegador reconstitui semanticamente o arquivo original.';
COMMENT ON TABLE public.collection_description_references IS 'Variantes imutáveis por NF, filial e cliente. Sem data da fonte não existe escolha automática da última; RLS somente Cobrança ativa estritamente vencida.';
INSERT INTO public.central_schema_migrations(version) VALUES('028_collection_reference_imports');
COMMIT;
