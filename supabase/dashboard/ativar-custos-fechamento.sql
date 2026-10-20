-- CENTRAL FINANCEIRA — Custos oficiais e recálculo explícito versionado de fechamentos.
-- Executar no SQL Editor da base existente após032. Repetível e atômico.
-- Preserva originais, usuários, permissões, fechamentos e apurações salvas.
-- Importar custos não aplica valores a fechamentos: a aplicação exige outra confirmação.
-- Publicar a atualização business-import separadamente; este SQL não publica funções.
BEGIN;
-- SOURCE: 044_product_costs.sql
-- Catálogo oficial de custos: fontes e versões imutáveis, sem alterar fechamentos existentes.
DO $cf_apply_044$
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative a base financeira antes desta atualização.' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='032_commercial') THEN
  RAISE EXCEPTION 'Ative primeiro a atualização 032_commercial.' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='044_product_costs') THEN
  RAISE NOTICE 'Atualização 044_product_costs já instalada; histórico preservado.';RETURN;
 END IF;
 EXECUTE $cf_source_044$

CREATE TABLE public.product_cost_imports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reference_date date NOT NULL CHECK(reference_date BETWEEN DATE '1900-01-01' AND DATE '2199-12-31'),
 format_version text NOT NULL DEFAULT 'costs-v1' CHECK(format_version='costs-v1'),
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 250),file_sha256 text NOT NULL CHECK(file_sha256 ~ '^[a-f0-9]{64}$'),
 rows_sha256 text NOT NULL CHECK(rows_sha256 ~ '^[a-f0-9]{64}$'),resolutions_sha256 text NOT NULL CHECK(resolutions_sha256 ~ '^[a-f0-9]{64}$'),
 row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 5000),item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND row_count),
 resolutions jsonb NOT NULL CHECK(jsonb_typeof(resolutions)='object'),quality jsonb NOT NULL CHECK(jsonb_typeof(quality)='object'),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(reference_date,file_sha256,resolutions_sha256,format_version)
);
CREATE INDEX product_cost_imports_reference ON public.product_cost_imports(reference_date DESC,created_at DESC,id DESC);
CREATE INDEX product_cost_imports_created ON public.product_cost_imports(created_at DESC,id DESC);
CREATE TABLE cf_private.product_cost_import_files(import_id uuid PRIMARY KEY REFERENCES public.product_cost_imports(id),file_bytes bytea NOT NULL CHECK(octet_length(file_bytes) BETWEEN 1 AND 2097152));
CREATE TABLE cf_private.product_cost_import_rows(
 import_id uuid NOT NULL REFERENCES public.product_cost_imports(id),line_number integer NOT NULL CHECK(line_number BETWEEN 2 AND 5001),
 code text NOT NULL,product text NOT NULL,weight_kg numeric(18,6) CHECK(weight_kg>=0),unit_cost numeric(18,6) CHECK(unit_cost>=0),
 PRIMARY KEY(import_id,line_number)
);
CREATE TABLE public.product_cost_items(
 import_id uuid NOT NULL REFERENCES public.product_cost_imports(id),code text NOT NULL,product text NOT NULL,
 line_number integer NOT NULL,weight_kg numeric(18,6) CHECK(weight_kg>=0),unit_cost numeric(18,6) CHECK(unit_cost>=0),
 source_lines integer[] NOT NULL CHECK(cardinality(source_lines) BETWEEN 1 AND 5000),
 selected_line_number integer,weight_conflict boolean NOT NULL,cost_conflict boolean NOT NULL,
 PRIMARY KEY(import_id,code),FOREIGN KEY(import_id,line_number) REFERENCES cf_private.product_cost_import_rows(import_id,line_number)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['public.product_cost_imports','cf_private.product_cost_import_files','cf_private.product_cost_import_rows','public.product_cost_items'] LOOP
  EXECUTE 'ALTER TABLE '||t||' ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON TABLE '||t||' FROM PUBLIC,anon,authenticated,service_role';
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes()',replace(t,'.','_')||'_immutable',t);
 END LOOP;
END $$;
CREATE FUNCTION cf_private.require_product_cost_access(p_write boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.session_allowed() OR NOT cf_private.has_permission('margens','read')
  OR (p_write AND(NOT cf_private.has_permission('importar_bases','read') OR NOT cf_private.has_permission('custos','import'))) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION cf_private.normalize_product_cost_rows(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE r jsonb;k text;v_line integer;v_seen integer[]:='{}';v_result jsonb:='[]';v_value text;
BEGIN
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Informe de1 a5.000 linhas da base de custos.' USING ERRCODE='22023';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(r)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>5
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) keys(key_name) WHERE keys.key_name NOT IN('line_number','code','product','weight_kg','unit_cost')) THEN
   RAISE EXCEPTION 'Estrutura de custos inválida.' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(r->'line_number') IS DISTINCT FROM 'number' OR (r->>'line_number') !~ '^\d+$' OR (r->>'line_number')::numeric NOT BETWEEN 2 AND 5001 THEN
   RAISE EXCEPTION 'Linha de origem inválida.' USING ERRCODE='22023';END IF;
  v_line:=(r->>'line_number')::integer;
  IF v_line=ANY(v_seen) THEN RAISE EXCEPTION 'Linha de origem repetida.' USING ERRCODE='22023';END IF;v_seen:=array_append(v_seen,v_line);
  FOREACH k IN ARRAY ARRAY['code','product'] LOOP
   IF jsonb_typeof(r->k) IS DISTINCT FROM 'string' OR length(r->>k) NOT BETWEEN 1 AND (CASE WHEN k='code' THEN 150 ELSE 1500 END)
    OR (r->>k)<>btrim(r->>k) OR (r->>k) ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Código ou produto inválido.' USING ERRCODE='22023';END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['weight_kg','unit_cost'] LOOP
   IF r->k IS DISTINCT FROM 'null'::jsonb THEN
    v_value:=r->>k;
    IF jsonb_typeof(r->k) IS DISTINCT FROM 'string' OR v_value !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' THEN
     RAISE EXCEPTION 'Peso e custo devem ser decimais não negativos com até seis casas.' USING ERRCODE='22023';END IF;
    r:=jsonb_set(r,ARRAY[k],to_jsonb(trim_scale(v_value::numeric)::text));
   END IF;
  END LOOP;
 END LOOP;
 RETURN (SELECT jsonb_agg(x.value||jsonb_build_object('unit_cost',trim_scale((x.value->>'unit_cost')::numeric)::text,'weight_kg',trim_scale((x.value->>'weight_kg')::numeric)::text) ORDER BY (x.value->>'line_number')::integer) FROM jsonb_array_elements(p_rows) x(value));
END $$;
CREATE FUNCTION cf_private.resolve_product_cost_rows(p_rows jsonb,p_resolutions jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_rows jsonb:=cf_private.normalize_product_cost_rows(p_rows);v_items jsonb;v_conflicts jsonb;v_unresolved integer;
BEGIN
 IF p_resolutions IS NULL OR jsonb_typeof(p_resolutions)<>'object' OR octet_length(p_resolutions::text)>200000 THEN
  RAISE EXCEPTION 'Confira as escolhas de custos divergentes.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_resolutions) r WHERE jsonb_typeof(r.value)<>'number' OR (r.value#>>'{}') !~ '^\d+$'
  OR (r.value#>>'{}')::numeric NOT BETWEEN 2 AND 5001 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) x WHERE x->>'code'=r.key AND x->>'line_number'=(r.value#>>'{}'))) THEN
  RAISE EXCEPTION 'Uma escolha não corresponde a uma linha deste produto.' USING ERRCODE='22023';END IF;
 WITH raw AS MATERIALIZED(SELECT r->>'code' AS code,r FROM jsonb_array_elements(v_rows) r), groups AS(
  SELECT code,count(DISTINCT coalesce(r->>'unit_cost','<NULL>'))>1 OR count(DISTINCT r->>'product')>1 AS conflict
  FROM raw GROUP BY code)
 SELECT count(*)::integer INTO v_unresolved FROM jsonb_object_keys(p_resolutions) choices(code) JOIN groups USING(code) WHERE NOT groups.conflict;
 IF v_unresolved>0 THEN RAISE EXCEPTION 'A escolha deve corresponder a um produto divergente.' USING ERRCODE='22023';END IF;
 -- Agrupamento em lote: não reler milhares de linhas para cada código.
 WITH raw AS MATERIALIZED(SELECT r,r->>'code' AS code,(r->>'line_number')::integer AS line_number FROM jsonb_array_elements(v_rows) r),
 groups AS MATERIALIZED(
  SELECT code,count(*) AS n,min(line_number) AS first_line,(array_agg(r->>'product' ORDER BY line_number))[1] AS first_product,
   count(DISTINCT coalesce(r->>'unit_cost','<NULL>'))>1 OR count(DISTINCT r->>'product')>1 AS conflict,
   count(DISTINCT coalesce(r->>'weight_kg','<NULL>'))>1 AS weight_conflict,
   jsonb_agg(line_number ORDER BY line_number) AS source_lines,
   jsonb_agg(jsonb_build_object('line_number',line_number,'unit_cost',r->'unit_cost','weight_kg',r->'weight_kg') ORDER BY line_number) AS options
  FROM raw GROUP BY code),
 resolved AS(
  SELECT g.*,c.value::integer AS choice,selected.r FROM groups g LEFT JOIN jsonb_each_text(p_resolutions) c ON c.key=g.code
   JOIN raw selected ON selected.code=g.code AND selected.line_number=coalesce(c.value::integer,g.first_line))
 SELECT coalesce(jsonb_agg(jsonb_build_object('line_number',(r->>'line_number')::integer,'code',code,'product',r->>'product',
  'unit_cost',CASE WHEN conflict AND choice IS NULL THEN 'null'::jsonb ELSE r->'unit_cost' END,
  'weight_kg',CASE WHEN (conflict OR weight_conflict) AND choice IS NULL THEN 'null'::jsonb ELSE r->'weight_kg' END,
  'source_lines',source_lines,'duplicate_count',n-1,'cost_conflict',conflict,'weight_conflict',weight_conflict,'resolved',NOT conflict OR choice IS NOT NULL,'selected_line_number',choice) ORDER BY first_line),'[]'),
 coalesce(jsonb_agg(jsonb_build_object('code',code,'product',first_product,'options',options,'selected_line_number',choice) ORDER BY first_line) FILTER(WHERE conflict),'[]'),
 count(*) FILTER(WHERE conflict AND choice IS NULL)::integer INTO v_items,v_conflicts,v_unresolved FROM resolved;
 RETURN jsonb_build_object('rows',v_items,'conflicts',v_conflicts,'unresolved_count',v_unresolved,'can_commit',v_unresolved=0,
  'row_count',jsonb_array_length(v_rows),'item_count',jsonb_array_length(v_items),'duplicate_row_count',jsonb_array_length(v_rows)-jsonb_array_length(v_items),
  'exact_duplicate_count',jsonb_array_length(v_rows)-(SELECT count(DISTINCT r-'line_number') FROM jsonb_array_elements(v_rows) r),
  'duplicate_code_count',(SELECT count(*) FROM jsonb_array_elements(v_items) r WHERE (r->>'duplicate_count')::integer>0),
  'conflicting_cost_code_count',jsonb_array_length(v_conflicts),
  'zero_cost_count',(SELECT count(*) FROM jsonb_array_elements(v_items) r WHERE r->>'unit_cost'='0'),
  'missing_cost_count',(SELECT count(*) FROM jsonb_array_elements(v_items) r WHERE r->>'unit_cost' IS NULL),
  'missing_weight_count',(SELECT count(*) FROM jsonb_array_elements(v_items) r WHERE r->>'weight_kg' IS NULL));
END $$;
CREATE FUNCTION public.preview_product_cost_import(p_rows jsonb,p_reference_date date,p_resolutions jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_result jsonb;v_previous uuid;v_comparison uuid;v_counts jsonb;BEGIN
 PERFORM cf_private.require_product_cost_access(true);
 IF p_reference_date IS NULL OR p_reference_date NOT BETWEEN DATE '1900-01-01' AND DATE '2199-12-31' THEN
  RAISE EXCEPTION 'Informe uma data de referência válida.' USING ERRCODE='22023';END IF;
 v_result:=cf_private.resolve_product_cost_rows(p_rows,p_resolutions);
 SELECT id INTO v_previous FROM public.product_cost_imports ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT id INTO v_comparison FROM public.product_cost_imports WHERE reference_date<=p_reference_date ORDER BY reference_date DESC,created_at DESC,id DESC LIMIT 1;
 WITH fresh AS(SELECT * FROM jsonb_to_recordset(v_result->'rows') AS x(code text,product text,weight_kg text,unit_cost text)), old AS(SELECT * FROM public.product_cost_items WHERE import_id=v_comparison)
 SELECT jsonb_build_object('new_count',count(*) FILTER(WHERE o.code IS NULL AND n.code IS NOT NULL),
  'removed_count',count(*) FILTER(WHERE n.code IS NULL),
  'changed_count',count(*) FILTER(WHERE n.code IS NOT NULL AND o.code IS NOT NULL AND ROW(n.product,n.weight_kg::numeric,n.unit_cost::numeric) IS DISTINCT FROM ROW(o.product,o.weight_kg,o.unit_cost)),
  'unchanged_count',count(*) FILTER(WHERE n.code IS NOT NULL AND o.code IS NOT NULL AND ROW(n.product,n.weight_kg::numeric,n.unit_cost::numeric) IS NOT DISTINCT FROM ROW(o.product,o.weight_kg,o.unit_cost)))
  INTO v_counts FROM fresh n FULL JOIN old o USING(code);
 RETURN v_result||v_counts||jsonb_build_object('format_version','costs-v1','reference_date',p_reference_date,'previous_import_id',v_previous,'comparison_import_id',v_comparison);
END $$;
CREATE FUNCTION public.commit_product_cost_import_from_gateway(p_user_id uuid,p_session_id text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_reference_date date,p_previous_import_id uuid,p_resolutions jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_result jsonb;v_file bytea;v_id uuid;v_previous uuid;v_rows_hash text;v_choices_hash text;v_profile public.profiles%ROWTYPE;v_at timestamptz;
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_session_id !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM cf_private.require_product_cost_access(true);
 v_file:=cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 v_rows:=cf_private.normalize_product_cost_rows(p_rows);
 v_result:=public.preview_product_cost_import(v_rows,p_reference_date,p_resolutions);
 IF NOT (v_result->>'can_commit')::boolean THEN RAISE EXCEPTION 'Escolha explicitamente o custo oficial de cada produto divergente.' USING ERRCODE='23514';END IF;
 v_rows_hash:=encode(sha256(convert_to(v_rows::text,'UTF8')),'hex');v_choices_hash:=encode(sha256(convert_to(p_resolutions::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(2045812344);
 SELECT id INTO v_id FROM public.product_cost_imports WHERE reference_date=p_reference_date AND file_sha256=p_file_sha256 AND resolutions_sha256=v_choices_hash AND format_version='costs-v1';
 IF v_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.product_cost_imports WHERE id=v_id AND rows_sha256=v_rows_hash) THEN RAISE EXCEPTION 'O mesmo arquivo produziu linhas divergentes.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('format_version','costs-v1','import_id',v_id,'reference_date',p_reference_date,'row_count',jsonb_array_length(v_rows),'item_count',(SELECT item_count FROM public.product_cost_imports WHERE id=v_id),'idempotent',true);
 END IF;
 SELECT id INTO v_previous FROM public.product_cost_imports ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN RAISE EXCEPTION 'A base de custos mudou. Analise novamente.' USING ERRCODE='40001';END IF;
 SELECT greatest(clock_timestamp(),coalesce(max(created_at),'1900-01-01'::timestamptz)+interval '1 microsecond') INTO v_at FROM public.product_cost_imports;
 INSERT INTO public.product_cost_imports(reference_date,file_name,file_sha256,rows_sha256,resolutions_sha256,row_count,item_count,resolutions,quality,created_by,created_at)
  VALUES(p_reference_date,p_file_name,p_file_sha256,v_rows_hash,v_choices_hash,jsonb_array_length(v_rows),(v_result->>'item_count')::integer,p_resolutions,
   v_result-ARRAY['rows','conflicts','previous_import_id','comparison_import_id','reference_date','format_version'],p_user_id,v_at) RETURNING id INTO v_id;
 INSERT INTO cf_private.product_cost_import_files(import_id,file_bytes) VALUES(v_id,v_file);
 INSERT INTO cf_private.product_cost_import_rows(import_id,line_number,code,product,weight_kg,unit_cost)
  SELECT v_id,r.line_number,r.code,r.product,r.weight_kg::numeric,r.unit_cost::numeric FROM jsonb_to_recordset(v_rows) AS r(line_number integer,code text,product text,weight_kg text,unit_cost text);
 INSERT INTO public.product_cost_items(import_id,code,product,line_number,weight_kg,unit_cost,source_lines,selected_line_number,weight_conflict,cost_conflict)
  SELECT v_id,r.code,r.product,r.line_number,r.weight_kg::numeric,r.unit_cost::numeric,r.source_lines,r.selected_line_number,r.weight_conflict,r.cost_conflict
  FROM jsonb_to_recordset(v_result->'rows') AS r(code text,product text,line_number integer,weight_kg text,unit_cost text,source_lines integer[],selected_line_number integer,weight_conflict boolean,cost_conflict boolean);
 SELECT * INTO v_profile FROM public.profiles WHERE id=p_user_id;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
  VALUES(p_user_id,v_profile.username,v_profile.role_key,'custos','product_cost_imports',v_id::text,'IMPORT',jsonb_build_object('reference_date',p_reference_date,'file_sha256',p_file_sha256,'row_count',jsonb_array_length(v_rows),'item_count',v_result->'item_count','resolutions',p_resolutions,'previous_import_id',v_previous));
 RETURN jsonb_build_object('format_version','costs-v1','import_id',v_id,'reference_date',p_reference_date,'row_count',jsonb_array_length(v_rows),'item_count',(v_result->>'item_count')::integer,'idempotent',false);
END $$;
CREATE FUNCTION public.list_product_costs(p_reference_date date DEFAULT NULL,p_search text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,p_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_import public.product_cost_imports%ROWTYPE;v_rows jsonb;v_count bigint;v_dates jsonb;
BEGIN
 PERFORM cf_private.require_product_cost_access();
 IF p_search IS NULL OR length(p_search)>500 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
  OR (p_reference_date IS NOT NULL AND p_reference_date NOT BETWEEN DATE '1900-01-01' AND DATE '2199-12-31') THEN RAISE EXCEPTION 'Filtros de custos inválidos.' USING ERRCODE='22023';END IF;
 IF p_import_id IS NOT NULL THEN
  SELECT * INTO v_import FROM public.product_cost_imports WHERE id=p_import_id;
  IF v_import.id IS NULL OR(p_reference_date IS NOT NULL AND v_import.reference_date<>p_reference_date) THEN RAISE EXCEPTION 'Versão de custos não encontrada para esta data.' USING ERRCODE='22023';END IF;
 ELSE
  SELECT * INTO v_import FROM public.product_cost_imports WHERE p_reference_date IS NULL OR reference_date<=p_reference_date ORDER BY reference_date DESC,created_at DESC,id DESC LIMIT 1;
 END IF;
 SELECT count(*) INTO v_count FROM public.product_cost_items WHERE import_id=v_import.id AND(p_search='' OR strpos(lower(code||' '||product),lower(p_search))>0);
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.code),'[]') INTO v_rows FROM(
  SELECT code,product,line_number,trim_scale(weight_kg)::text AS weight_kg,trim_scale(unit_cost)::text AS unit_cost,source_lines,
   cardinality(source_lines)-1 AS duplicate_count,selected_line_number,weight_conflict,cost_conflict,true AS resolved
  FROM public.product_cost_items WHERE import_id=v_import.id AND(p_search='' OR strpos(lower(code||' '||product),lower(p_search))>0)
  ORDER BY code LIMIT p_limit OFFSET p_offset) r;
 SELECT coalesce(jsonb_agg(d ORDER BY d DESC),'[]') INTO v_dates FROM(SELECT DISTINCT reference_date d FROM public.product_cost_imports) dates;
 RETURN jsonb_build_object('format_version','costs-v1','rows',v_rows,'count',v_count,'revision',coalesce(v_import.id::text,'empty'),
  'source',CASE WHEN v_import.id IS NOT NULL THEN jsonb_build_object('import_id',v_import.id,'reference_date',v_import.reference_date,'file_name',v_import.file_name,'created_at',v_import.created_at) END,
  'quality',coalesce(v_import.quality,'{}'::jsonb),'options',jsonb_build_object('reference_dates',v_dates));
END $$;
CREATE FUNCTION public.list_product_cost_imports(p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_rows jsonb;v_count bigint;v_revision uuid;BEGIN
 PERFORM cf_private.require_product_cost_access();
 IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Paginação inválida.' USING ERRCODE='22023';END IF;
 SELECT count(*) INTO v_count FROM public.product_cost_imports;
 SELECT id INTO v_revision FROM public.product_cost_imports ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC,r.id DESC),'[]') INTO v_rows FROM(
  SELECT id,reference_date,file_name,row_count,item_count,quality,created_by,created_at FROM public.product_cost_imports ORDER BY created_at DESC,id DESC LIMIT p_limit OFFSET p_offset) r;
 RETURN jsonb_build_object('format_version','costs-v1','rows',v_rows,'count',v_count,'revision',coalesce(v_revision::text,'empty'));
END $$;
REVOKE ALL ON FUNCTION cf_private.require_product_cost_access(boolean),cf_private.normalize_product_cost_rows(jsonb),cf_private.resolve_product_cost_rows(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.preview_product_cost_import(jsonb,date,jsonb),public.commit_product_cost_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid,jsonb),public.list_product_costs(date,text,integer,integer,uuid),public.list_product_cost_imports(integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_product_cost_import(jsonb,date,jsonb),public.list_product_costs(date,text,integer,integer,uuid),public.list_product_cost_imports(integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_product_cost_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid,jsonb) TO service_role;
COMMENT ON TABLE public.product_cost_imports IS 'Snapshot integral de custos por data. NULL é desconhecido, zero é informado. Não aplica valores a fechamentos automaticamente.';
COMMENT ON COLUMN public.product_cost_items.weight_kg IS 'Peso informado na fonte. O cabeçalho não declara unidade; não aplicar conversão ou inferir classificação.';

INSERT INTO public.central_schema_migrations(version) VALUES('044_product_costs');
NOTIFY pgrst,'reload schema';
 $cf_source_044$;
END $cf_apply_044$;

-- SOURCE: 045_product_cost_recalculation.sql
-- Catálogo oficial de custos: fontes e versões imutáveis, sem alterar fechamentos existentes.
DO $cf_apply_045$
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative a base financeira antes desta atualização.' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='044_product_costs') THEN
  RAISE EXCEPTION 'Ative primeiro a atualização 044_product_costs.' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='045_product_cost_recalculation') THEN
  RAISE NOTICE 'Atualização 045_product_cost_recalculation já instalada; histórico preservado.';RETURN;
 END IF;
 EXECUTE $cf_source_045$

CREATE TABLE public.product_cost_recalculations(
 request_id uuid PRIMARY KEY,cost_import_id uuid NOT NULL REFERENCES public.product_cost_imports(id),
 source_import_id uuid NOT NULL REFERENCES public.commercial_imports(id),import_id uuid NOT NULL UNIQUE REFERENCES public.commercial_imports(id),
 month date NOT NULL CHECK(extract(day FROM month)=1),rule_version text NOT NULL CHECK(rule_version='unit-cost-quantity-half-away-from-zero-cent-v1'),
 row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 5000),revision text NOT NULL,totals jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(source_import_id,cost_import_id)
);
CREATE TABLE public.product_cost_recalculation_items(
 request_id uuid NOT NULL REFERENCES public.product_cost_recalculations(request_id),
 source_item_id uuid NOT NULL REFERENCES public.commercial_items(id),item_id uuid NOT NULL UNIQUE REFERENCES public.commercial_items(id),
 unit_cost numeric(18,6) NOT NULL CHECK(unit_cost>0),quantity numeric(18,6) NOT NULL CHECK(quantity<>0),
 unrounded_cost_cents numeric NOT NULL,cost_cents bigint NOT NULL,rounding_delta_cents numeric NOT NULL,
 previous_cost_cents bigint,previous_margin_cents bigint,PRIMARY KEY(request_id,source_item_id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['public.product_cost_recalculations','public.product_cost_recalculation_items'] LOOP
 EXECUTE 'ALTER TABLE '||t||' ENABLE ROW LEVEL SECURITY';
 EXECUTE 'REVOKE ALL ON TABLE '||t||' FROM PUBLIC,anon,authenticated,service_role';
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes()',replace(t,'.','_')||'_immutable',t);
END LOOP;END $$;
CREATE FUNCTION cf_private.require_product_cost_recalculation() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM cf_private.require_product_cost_access(true);
 IF NOT cf_private.has_permission('fechamento','import') OR NOT cf_private.has_permission('faturamento','read') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION cf_private.product_cost_recalculation_data(p_cost_import_id uuid,p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_cost public.product_cost_imports%ROWTYPE;v_source public.commercial_imports%ROWTYPE;i public.commercial_items%ROWTYPE;
 c public.product_cost_items%ROWTYPE;v_rows jsonb:='[]';v_derived jsonb:='[]';v_errors jsonb;v_new_cost numeric;v_new_margin numeric;
 v_count integer:=0;v_matched integer:=0;v_missing_code integer:=0;v_missing_qty integer:=0;v_invalid_qty integer:=0;
 v_missing_cost integer:=0;v_zero_cost integer:=0;v_missing_components integer:=0;v_bad integer:=0;
 v_old_cost_total numeric:=0;v_new_cost_total numeric:=0;v_old_margin_total numeric:=0;v_new_margin_total numeric:=0;
 v_old_cost_unknown boolean:=false;v_old_margin_unknown boolean:=false;v_new_cost_unknown boolean:=false;v_new_margin_unknown boolean:=false;v_abs_new_cost numeric:=0;v_abs_new_margin numeric:=0;
 v_already boolean:=false;v_totals jsonb;v_revision text;
BEGIN
 PERFORM cf_private.require_product_cost_recalculation();
 IF p_cost_import_id IS NULL OR p_month IS NULL OR p_month NOT BETWEEN DATE '1900-01-01' AND DATE '2199-12-01' OR extract(day FROM p_month)<>1 THEN
  RAISE EXCEPTION 'Selecione a versão dos custos e o mês do fechamento.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_cost FROM public.product_cost_imports WHERE id=p_cost_import_id;
 IF v_cost.id IS NULL THEN RAISE EXCEPTION 'Versão de custos não encontrada.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_source FROM public.commercial_current_imports WHERE month=p_month;
 IF v_source.id IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM public.product_cost_recalculations WHERE import_id=v_source.id AND cost_import_id=p_cost_import_id) INTO v_already;
 END IF;
 FOR i IN SELECT * FROM public.commercial_items WHERE import_id=v_source.id ORDER BY line_number LOOP
  v_count:=v_count+1;v_errors:='[]';v_new_cost:=NULL;v_new_margin:=NULL;
  SELECT * INTO c FROM public.product_cost_items WHERE import_id=p_cost_import_id AND code=i.code;
  IF c.code IS NULL THEN v_missing_code:=v_missing_code+1;v_errors:=v_errors||jsonb_build_array('MISSING_CODE');
  ELSE
   v_matched:=v_matched+1;
   IF c.unit_cost IS NULL THEN v_missing_cost:=v_missing_cost+1;v_errors:=v_errors||jsonb_build_array('MISSING_COST');
   ELSIF c.unit_cost=0 THEN v_zero_cost:=v_zero_cost+1;v_errors:=v_errors||jsonb_build_array('ZERO_COST');END IF;
  END IF;
  IF i.quantity IS NULL THEN v_missing_qty:=v_missing_qty+1;v_errors:=v_errors||jsonb_build_array('MISSING_QUANTITY');
  ELSIF i.quantity=0 THEN v_invalid_qty:=v_invalid_qty+1;v_errors:=v_errors||jsonb_build_array('INVALID_QUANTITY');END IF;
  IF i.freight_cents IS NULL OR i.tax_cents IS NULL OR i.commission_cents IS NULL THEN
   v_missing_components:=v_missing_components+1;v_errors:=v_errors||jsonb_build_array('MISSING_COMPONENTS');END IF;
  IF c.unit_cost>0 AND i.quantity IS NOT NULL AND i.quantity<>0 THEN
   v_new_cost:=round(c.unit_cost*i.quantity*100);
   IF abs(v_new_cost)>9007199254740991 THEN v_new_cost:=NULL;v_errors:=v_errors||jsonb_build_array('AMOUNT_OUT_OF_RANGE');END IF;
  END IF;
  IF v_new_cost IS NOT NULL AND i.freight_cents IS NOT NULL AND i.tax_cents IS NOT NULL AND i.commission_cents IS NOT NULL THEN
   v_new_margin:=i.sale_cents::numeric-v_new_cost-i.freight_cents-i.tax_cents-i.commission_cents;
   IF abs(v_new_margin)>9007199254740991 THEN v_new_margin:=NULL;v_errors:=v_errors||jsonb_build_array('AMOUNT_OUT_OF_RANGE');END IF;
  END IF;
  IF i.cost_cents IS NULL THEN v_old_cost_unknown:=true;ELSE v_old_cost_total:=v_old_cost_total+i.cost_cents;END IF;
  IF i.margin_cents IS NULL THEN v_old_margin_unknown:=true;ELSE v_old_margin_total:=v_old_margin_total+i.margin_cents;END IF;
  IF v_new_cost IS NULL THEN v_new_cost_unknown:=true;END IF;
  IF v_new_margin IS NULL THEN v_new_margin_unknown:=true;END IF;
  v_new_cost_total:=v_new_cost_total+coalesce(v_new_cost,0);v_new_margin_total:=v_new_margin_total+coalesce(v_new_margin,0);
  v_abs_new_cost:=v_abs_new_cost+abs(coalesce(v_new_cost,0));v_abs_new_margin:=v_abs_new_margin+abs(coalesce(v_new_margin,0));
  IF jsonb_array_length(v_errors)>0 THEN v_bad:=v_bad+1;END IF;
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('id',i.id,'line_number',i.line_number,'code',i.code,'product',i.product,'invoice',i.invoice,'branch',i.branch,
   'quantity',trim_scale(i.quantity)::text,'unit_cost',trim_scale(c.unit_cost)::text,'previous_cost_cents',i.cost_cents,'new_cost_cents',v_new_cost,
   'previous_margin_cents',i.margin_cents,'new_margin_cents',v_new_margin,'error_codes',v_errors));
  v_derived:=v_derived||jsonb_build_array(jsonb_build_object('line_number',i.line_number,'code',i.code,'product',i.product,'client',i.client,'employee',i.employee,
   'invoice',i.invoice,'cost_center',i.cost_center,'branch',i.branch,'issued_on',i.issued_on,'quantity',i.quantity,'sale_cents',i.sale_cents,
   'freight_cents',i.freight_cents,'tax_cents',i.tax_cents,'cost_cents',v_new_cost,'commission_cents',i.commission_cents,'margin_cents',v_new_margin,'margin_source','CALCULATED'));
 END LOOP;
 IF greatest(abs(v_old_cost_total),abs(v_old_margin_total),v_abs_new_cost,v_abs_new_margin)>9007199254740991 THEN
  RAISE EXCEPTION 'O consolidado do recálculo excede o limite de precisão.' USING ERRCODE='22003';END IF;
 IF v_source.id IS NOT NULL AND v_count<>v_source.row_count THEN RAISE EXCEPTION 'A integridade do fechamento não foi confirmada.' USING ERRCODE='22023';END IF;
 v_totals:=jsonb_build_object('previous_cost_cents',CASE WHEN v_old_cost_unknown THEN NULL ELSE v_old_cost_total END,
  'new_cost_cents',CASE WHEN v_new_cost_unknown THEN NULL ELSE v_new_cost_total END,
  'previous_margin_cents',CASE WHEN v_old_margin_unknown THEN NULL ELSE v_old_margin_total END,
  'new_margin_cents',CASE WHEN v_new_margin_unknown THEN NULL ELSE v_new_margin_total END);
 v_revision:=encode(sha256(convert_to(jsonb_build_object('cost_import_id',p_cost_import_id,'source_import_id',v_source.id,'rule','unit-cost-quantity-half-away-from-zero-cent-v1','rows',v_derived)::text,'UTF8')),'hex');
 RETURN jsonb_build_object('format_version','costs-recalculation-v1','month',p_month,'cost_import_id',p_cost_import_id,'previous_import_id',v_source.id,
  'source',CASE WHEN v_source.id IS NOT NULL THEN jsonb_build_object('import_id',v_source.id,'month',v_source.month,'file_name',v_source.file_name) END,
  'cost_source',jsonb_build_object('import_id',v_cost.id,'reference_date',v_cost.reference_date,'file_name',v_cost.file_name,'created_at',v_cost.created_at),
  'can_apply',v_count>0 AND v_bad=0 AND NOT v_already,'already_applied',v_already,'row_count',v_count,'matched_count',v_matched,'missing_code_count',v_missing_code,
  'missing_quantity_count',v_missing_qty,'invalid_quantity_count',v_invalid_qty,'missing_cost_count',v_missing_cost,'zero_cost_count',v_zero_cost,'missing_components_count',v_missing_components,
  'totals',v_totals,'rows',v_rows,'revision',v_revision,'rule_version','unit-cost-quantity-half-away-from-zero-cent-v1','derived_rows',v_derived);
END $$;
CREATE FUNCTION public.preview_product_cost_recalculation(p_cost_import_id uuid,p_month date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT cf_private.product_cost_recalculation_data(p_cost_import_id,p_month)-'derived_rows' $$;
CREATE FUNCTION public.commit_product_cost_recalculation_from_gateway(p_user_id uuid,p_session_id text,p_cost_import_id uuid,p_month date,p_previous_import_id uuid,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_existing public.product_cost_recalculations%ROWTYPE;v_preview jsonb;v_rows jsonb;v_id uuid;v_descriptor bytea;v_rows_hash text;v_file_hash text;
 v_cost public.product_cost_imports%ROWTYPE;v_source public.commercial_imports%ROWTYPE;v_profile public.profiles%ROWTYPE;
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_session_id !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM cf_private.require_product_cost_recalculation();
 IF p_cost_import_id IS NULL OR p_month IS NULL OR p_previous_import_id IS NULL OR p_request_id IS NULL THEN
  RAISE EXCEPTION 'Confira a versão dos custos, o fechamento e a confirmação individual.' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(2045812344);PERFORM pg_advisory_xact_lock(2045812332);
 SELECT * INTO v_existing FROM public.product_cost_recalculations WHERE request_id=p_request_id;
 IF v_existing.request_id IS NOT NULL THEN
  IF v_existing.created_by IS DISTINCT FROM p_user_id OR v_existing.cost_import_id IS DISTINCT FROM p_cost_import_id
   OR v_existing.month IS DISTINCT FROM p_month OR v_existing.source_import_id IS DISTINCT FROM p_previous_import_id THEN
   RAISE EXCEPTION 'A identificação desta confirmação já foi usada com outros dados.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('format_version','costs-recalculation-v1','request_id',p_request_id,'import_id',v_existing.import_id,'source_import_id',v_existing.source_import_id,'cost_import_id',p_cost_import_id,'month',p_month,'row_count',v_existing.row_count,'idempotent',true);
 END IF;
 v_preview:=cf_private.product_cost_recalculation_data(p_cost_import_id,p_month);
 IF (v_preview->>'previous_import_id')::uuid IS DISTINCT FROM p_previous_import_id THEN
  RAISE EXCEPTION 'O fechamento mudou. Analise novamente os custos e as margens antes de aplicar.' USING ERRCODE='40001';END IF;
 IF NOT (v_preview->>'can_apply')::boolean THEN RAISE EXCEPTION 'Resolva os itens sem código, quantidade, custo positivo ou componentes da margem antes de aplicar.' USING ERRCODE='23514';END IF;
 v_rows:=cf_private.normalize_commercial_rows(v_preview->'derived_rows',p_month);
 v_rows_hash:=encode(sha256(convert_to(v_rows::text,'UTF8')),'hex');
 SELECT * INTO v_cost FROM public.product_cost_imports WHERE id=p_cost_import_id;
 SELECT * INTO v_source FROM public.commercial_imports WHERE id=p_previous_import_id;
 v_descriptor:=convert_to(jsonb_build_object('format_version','costs-recalculation-v1','source_import_id',p_previous_import_id,'source_file_sha256',v_source.file_sha256,
  'cost_import_id',p_cost_import_id,'cost_reference_date',v_cost.reference_date,'rows_sha256',v_rows_hash,'rule_version','unit-cost-quantity-half-away-from-zero-cent-v1',
  'commission_policy','PRESERVE_SOURCE_COMMISSION','row_count',v_preview->'row_count')::text,'UTF8');
 v_file_hash:=encode(sha256(v_descriptor),'hex');
 INSERT INTO public.commercial_imports(month,file_name,file_sha256,rows_sha256,row_count,created_by,created_at)
  VALUES(p_month,'Recalculo_Custos_'||to_char(p_month,'YYYY-MM')||'_ref'||v_cost.reference_date::text||'_'||left(p_cost_import_id::text,8)||'.json',v_file_hash,v_rows_hash,(v_preview->>'row_count')::integer,p_user_id,greatest(clock_timestamp(),v_source.created_at+interval '1 microsecond')) RETURNING id INTO v_id;
 INSERT INTO cf_private.commercial_import_files(import_id,file_bytes) VALUES(v_id,v_descriptor);
 INSERT INTO public.commercial_items(import_id,line_number,code,product,client,employee,invoice,cost_center,branch,issued_on,quantity,sale_cents,freight_cents,tax_cents,cost_cents,commission_cents,margin_cents,margin_source)
  SELECT v_id,x.line_number,x.code,x.product,x.client,x.employee,x.invoice,x.cost_center,x.branch,x.issued_on,x.quantity,x.sale_cents,x.freight_cents,x.tax_cents,x.cost_cents,x.commission_cents,x.margin_cents,x.margin_source
  FROM jsonb_to_recordset(v_rows) AS x(line_number integer,code text,product text,client text,employee text,invoice text,cost_center text,branch text,issued_on date,quantity numeric,sale_cents bigint,freight_cents bigint,tax_cents bigint,cost_cents bigint,commission_cents bigint,margin_cents bigint,margin_source text);
 INSERT INTO public.product_cost_recalculations(request_id,cost_import_id,source_import_id,import_id,month,rule_version,row_count,revision,totals,created_by)
  VALUES(p_request_id,p_cost_import_id,p_previous_import_id,v_id,p_month,'unit-cost-quantity-half-away-from-zero-cent-v1',(v_preview->>'row_count')::integer,v_preview->>'revision',v_preview->'totals',p_user_id);
 INSERT INTO public.product_cost_recalculation_items(request_id,source_item_id,item_id,unit_cost,quantity,unrounded_cost_cents,cost_cents,rounding_delta_cents,previous_cost_cents,previous_margin_cents)
  SELECT p_request_id,s.id,n.id,c.unit_cost,s.quantity,c.unit_cost*s.quantity*100,n.cost_cents,n.cost_cents-c.unit_cost*s.quantity*100,s.cost_cents,s.margin_cents
  FROM public.commercial_items s JOIN public.commercial_items n ON n.import_id=v_id AND n.line_number=s.line_number
   JOIN public.product_cost_items c ON c.import_id=p_cost_import_id AND c.code=s.code WHERE s.import_id=p_previous_import_id;
 SELECT * INTO v_profile FROM public.profiles WHERE id=p_user_id;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
  VALUES(p_user_id,v_profile.username,v_profile.role_key,'margens','product_cost_recalculations',p_request_id::text,'UPDATE',
   jsonb_build_object('source_import_id',p_previous_import_id,'previous_cost_cents',v_preview->'totals'->'previous_cost_cents','previous_margin_cents',v_preview->'totals'->'previous_margin_cents'),
   jsonb_build_object('import_id',v_id,'cost_import_id',p_cost_import_id,'month',p_month,'rule_version','unit-cost-quantity-half-away-from-zero-cent-v1','commission_policy','PRESERVE_SOURCE_COMMISSION','totals',v_preview->'totals'));
 RETURN jsonb_build_object('format_version','costs-recalculation-v1','request_id',p_request_id,'import_id',v_id,'source_import_id',p_previous_import_id,'cost_import_id',p_cost_import_id,'month',p_month,'row_count',(v_preview->>'row_count')::integer,'idempotent',false);
END $$;
CREATE FUNCTION public.list_product_cost_recalculations(p_month date DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_rows jsonb;v_count bigint;BEGIN
 PERFORM cf_private.require_product_cost_access();
 IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
  OR(p_month IS NOT NULL AND(extract(day FROM p_month)<>1 OR p_month NOT BETWEEN DATE '1900-01-01' AND DATE '2199-12-01')) THEN RAISE EXCEPTION 'Filtros inválidos.' USING ERRCODE='22023';END IF;
 SELECT count(*) INTO v_count FROM public.product_cost_recalculations WHERE p_month IS NULL OR month=p_month;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC,r.request_id DESC),'[]') INTO v_rows FROM(
  SELECT * FROM public.product_cost_recalculations WHERE p_month IS NULL OR month=p_month ORDER BY created_at DESC,request_id DESC LIMIT p_limit OFFSET p_offset) r;
 RETURN jsonb_build_object('rows',v_rows,'count',v_count);
END $$;
REVOKE ALL ON FUNCTION cf_private.require_product_cost_recalculation(),cf_private.product_cost_recalculation_data(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.preview_product_cost_recalculation(uuid,date),public.commit_product_cost_recalculation_from_gateway(uuid,text,uuid,date,uuid,uuid),public.list_product_cost_recalculations(date,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_product_cost_recalculation(uuid,date),public.list_product_cost_recalculations(date,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_product_cost_recalculation_from_gateway(uuid,text,uuid,date,uuid,uuid) TO service_role;
COMMENT ON TABLE public.product_cost_recalculations IS 'Reprecificação explícita versionada. Preserva comissão, frete, imposto, quantidade e origem. Cria nova versão comercial oficial e não reescreve apurações ou fechamentos anteriores.';

INSERT INTO public.central_schema_migrations(version) VALUES('045_product_cost_recalculation');
NOTIFY pgrst,'reload schema';
 $cf_source_045$;
END $cf_apply_045$;
COMMIT;
