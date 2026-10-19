-- Fechamentos de Faturamento e Margens: versões mensais integrais, sem dados históricos embutidos.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('cf_private.session_allowed()') IS NULL OR to_regclass('public.central_schema_migrations') IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='031_director_readonly') THEN
  RAISE EXCEPTION 'Ative a base e o acesso de consulta 031 antes do fechamento comercial.' USING ERRCODE='22023';END IF;
END $$;
CREATE TABLE public.commercial_imports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),month date NOT NULL CHECK(extract(day FROM month)=1),
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 250),file_sha256 text NOT NULL CHECK(file_sha256 ~ '^[a-f0-9]{64}$'),
 rows_sha256 text NOT NULL CHECK(rows_sha256 ~ '^[a-f0-9]{64}$'),row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 5000),created_by uuid NOT NULL REFERENCES public.profiles(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(month,file_sha256)
);
CREATE TABLE cf_private.commercial_import_files(import_id uuid PRIMARY KEY REFERENCES public.commercial_imports(id),file_bytes bytea NOT NULL CHECK(octet_length(file_bytes) BETWEEN 1 AND 2097152));
CREATE TABLE public.commercial_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),import_id uuid NOT NULL REFERENCES public.commercial_imports(id),
 line_number integer NOT NULL CHECK(line_number BETWEEN 2 AND 5001),code text NOT NULL,product text NOT NULL,client text NOT NULL,
 employee text NOT NULL,invoice text NOT NULL,cost_center text NOT NULL,branch text NOT NULL,issued_on date NOT NULL,
 quantity numeric(18,6),sale_cents bigint NOT NULL CHECK(abs(sale_cents)<=9007199254740991),
 freight_cents bigint CHECK(abs(freight_cents)<=9007199254740991),tax_cents bigint CHECK(abs(tax_cents)<=9007199254740991),
 cost_cents bigint CHECK(abs(cost_cents)<=9007199254740991),commission_cents bigint CHECK(abs(commission_cents)<=9007199254740991),
 margin_cents bigint CHECK(abs(margin_cents)<=9007199254740991),
 margin_source text NOT NULL CHECK(margin_source IN ('PROVIDED','CALCULATED','UNAVAILABLE')),
 UNIQUE(import_id,line_number),CHECK((margin_source='UNAVAILABLE')=(margin_cents IS NULL))
);
CREATE INDEX commercial_items_import ON public.commercial_items(import_id,line_number);
CREATE INDEX commercial_imports_month ON public.commercial_imports(month,created_at DESC,id DESC);
ALTER TABLE public.commercial_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.commercial_import_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_imports,public.commercial_items,cf_private.commercial_import_files FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER commercial_imports_immutable BEFORE UPDATE OR DELETE ON public.commercial_imports FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER commercial_items_immutable BEFORE UPDATE OR DELETE ON public.commercial_items FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER commercial_files_immutable BEFORE UPDATE OR DELETE ON cf_private.commercial_import_files FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();

CREATE VIEW public.commercial_current_imports WITH(security_invoker=true,security_barrier=true) AS
 SELECT DISTINCT ON(month) * FROM public.commercial_imports ORDER BY month,created_at DESC,id DESC;
REVOKE ALL ON public.commercial_current_imports FROM PUBLIC,anon,authenticated,service_role;
CREATE VIEW cf_private.commission_sales_source AS
 SELECT i.id::text AS id,i.import_id::text AS source_revision,i.issued_on AS emission_date,i.employee,i.client AS client_name,
 i.cost_center,i.branch,i.invoice,i.product,i.sale_cents,i.cost_cents AS cmv_cents,i.freight_cents,i.tax_cents
 FROM public.commercial_items i JOIN public.commercial_current_imports s ON s.id=i.import_id;
REVOKE ALL ON cf_private.commission_sales_source FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION cf_private.require_commercial_import() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('importar_bases','read') OR NOT cf_private.has_permission('fechamento','import')
  OR NOT cf_private.has_permission('faturamento','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION cf_private.normalize_commercial_rows(p_rows jsonb,p_month date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$ DECLARE r jsonb;k text;v bigint;v_total numeric;v_day date;v_line integer;v_seen integer[]:='{}';BEGIN
 IF p_month IS NULL OR p_month<DATE '1900-01-01' OR p_month>DATE '2199-12-01' OR extract(day FROM p_month)<>1
  OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Fechamento mensal inválido.' USING ERRCODE='22023';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(r)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) keys(key_name) WHERE keys.key_name NOT IN('line_number','code','product','client','employee','invoice','cost_center','branch','issued_on','quantity','sale_cents','freight_cents','tax_cents','cost_cents','commission_cents','margin_cents','margin_source')) THEN
   RAISE EXCEPTION 'Linha de fechamento inválida.' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(r->'line_number') IS DISTINCT FROM 'number' OR (r->>'line_number') !~ '^\d+$' THEN RAISE EXCEPTION 'Linha inválida.' USING ERRCODE='22023';END IF;
  v_line:=(r->>'line_number')::integer;
  IF v_line NOT BETWEEN 2 AND 5001 OR v_line=ANY(v_seen) THEN RAISE EXCEPTION 'Linha repetida ou inválida.' USING ERRCODE='22023';END IF;v_seen:=array_append(v_seen,v_line);
  FOREACH k IN ARRAY ARRAY['code','product','client','employee','invoice','cost_center','branch'] LOOP
   IF jsonb_typeof(r->k) IS DISTINCT FROM 'string' OR length(r->>k)>500 OR (r->>k)<>btrim(r->>k)
    OR (r->>k) ~ '[[:cntrl:]]' OR (k IN('product','client','branch') AND (r->>k)='') THEN
    RAISE EXCEPTION 'Texto de fechamento inválido.' USING ERRCODE='22023';END IF;
  END LOOP;
  IF jsonb_typeof(r->'issued_on') IS DISTINCT FROM 'string' OR (r->>'issued_on') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Emissão inválida.' USING ERRCODE='22023';END IF;
  v_day:=(r->>'issued_on')::date;
  IF date_trunc('month',v_day)::date<>p_month THEN RAISE EXCEPTION 'A emissão pertence a outro mês.' USING ERRCODE='22023';END IF;
  FOREACH k IN ARRAY ARRAY['sale_cents','freight_cents','tax_cents','cost_cents','commission_cents','margin_cents'] LOOP
   IF r->k IS NULL OR (r->k='null'::jsonb AND k='sale_cents') THEN RAISE EXCEPTION 'Valor obrigatório ausente.' USING ERRCODE='22023';END IF;
   IF r->k<>'null'::jsonb THEN
    IF jsonb_typeof(r->k)<>'number' OR (r->>k) !~ '^-?\d+$' OR abs((r->>k)::numeric)>9007199254740991 THEN RAISE EXCEPTION 'Valor monetário inválido.' USING ERRCODE='22023';END IF;
   END IF;
  END LOOP;
  IF r->'quantity' IS NULL OR (r->'quantity'<>'null'::jsonb AND(jsonb_typeof(r->'quantity')<>'number' OR abs((r->>'quantity')::numeric)>1000000000 OR (r->>'quantity') !~ '^-?\d+(\.\d{1,6})?$')) THEN RAISE EXCEPTION 'Quantidade inválida.' USING ERRCODE='22023';END IF;
  IF (r->>'margin_source') IS NULL OR (r->>'margin_source') NOT IN('PROVIDED','CALCULATED','UNAVAILABLE')
   OR ((r->>'margin_source')='UNAVAILABLE') IS DISTINCT FROM (r->'margin_cents'='null'::jsonb) THEN RAISE EXCEPTION 'Origem da margem inválida.' USING ERRCODE='22023';END IF;
  IF r->>'margin_source'='CALCULATED' AND((r->>'cost_cents') IS NULL OR (r->>'tax_cents') IS NULL OR (r->>'freight_cents') IS NULL OR (r->>'commission_cents') IS NULL
   OR (r->>'margin_cents')::numeric<>(r->>'sale_cents')::numeric-(r->>'cost_cents')::numeric-(r->>'tax_cents')::numeric-(r->>'freight_cents')::numeric-(r->>'commission_cents')::numeric) THEN RAISE EXCEPTION 'Cálculo de margem inválido.' USING ERRCODE='22023';END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['sale_cents','freight_cents','tax_cents','cost_cents','commission_cents','margin_cents'] LOOP
  SELECT sum(abs((value->>k)::numeric)) INTO v_total FROM jsonb_array_elements(p_rows);
  IF v_total>9007199254740991 THEN RAISE EXCEPTION 'Total excede o limite de precisão.' USING ERRCODE='22023';END IF;
 END LOOP;
 RETURN p_rows;
END $$;
CREATE FUNCTION public.preview_commercial_import(p_rows jsonb,p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_rows jsonb;v_previous uuid;v_sale numeric;v_margin numeric;v_missing integer;BEGIN
 PERFORM cf_private.require_commercial_import();v_rows:=cf_private.normalize_commercial_rows(p_rows,p_month);
 SELECT id INTO v_previous FROM public.commercial_current_imports WHERE month=p_month;
 SELECT sum((r->>'sale_cents')::numeric),CASE WHEN count(*) FILTER(WHERE r->>'margin_cents' IS NULL)=0 THEN sum((r->>'margin_cents')::numeric) END,
 count(*) FILTER(WHERE r->>'margin_cents' IS NULL) INTO v_sale,v_margin,v_missing FROM jsonb_array_elements(v_rows) r;
 RETURN jsonb_build_object('row_count',jsonb_array_length(v_rows),'previous_import_id',v_previous,'month',p_month,'sale_cents',v_sale,'margin_cents',v_margin,'margin_missing_count',v_missing);
END $$;
CREATE FUNCTION public.commit_commercial_import_from_gateway(p_user_id uuid,p_session_id text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_month date,p_previous_import_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_rows jsonb;v_file bytea;v_previous uuid;v_id uuid;v_profile public.profiles%ROWTYPE;BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_session_id !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM cf_private.require_commercial_import();
 v_file:=cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 v_rows:=cf_private.normalize_commercial_rows(p_rows,p_month);PERFORM pg_advisory_xact_lock(2045812332);
 SELECT id INTO v_id FROM public.commercial_imports WHERE month=p_month AND file_sha256=p_file_sha256;
 IF v_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.commercial_imports WHERE id=v_id AND rows_sha256=encode(sha256(convert_to(v_rows::text,'UTF8')),'hex')) THEN RAISE EXCEPTION 'O mesmo arquivo produziu linhas divergentes.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('import_id',v_id,'row_count',(SELECT row_count FROM public.commercial_imports WHERE id=v_id),'month',p_month,'idempotent',true);END IF;
 SELECT id INTO v_previous FROM public.commercial_current_imports WHERE month=p_month;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN RAISE EXCEPTION 'Fechamento alterado. Analise novamente.' USING ERRCODE='40001';END IF;
 INSERT INTO public.commercial_imports(month,file_name,file_sha256,rows_sha256,row_count,created_by) VALUES(p_month,p_file_name,p_file_sha256,encode(sha256(convert_to(v_rows::text,'UTF8')),'hex'),jsonb_array_length(v_rows),p_user_id) RETURNING id INTO v_id;
 INSERT INTO cf_private.commercial_import_files(import_id,file_bytes) VALUES(v_id,v_file);
 INSERT INTO public.commercial_items(import_id,line_number,code,product,client,employee,invoice,cost_center,branch,issued_on,quantity,sale_cents,freight_cents,tax_cents,cost_cents,commission_cents,margin_cents,margin_source)
 SELECT v_id,x.line_number,x.code,x.product,x.client,x.employee,x.invoice,x.cost_center,x.branch,x.issued_on,x.quantity,x.sale_cents,x.freight_cents,x.tax_cents,x.cost_cents,x.commission_cents,x.margin_cents,x.margin_source
 FROM jsonb_to_recordset(v_rows) AS x(line_number integer,code text,product text,client text,employee text,invoice text,cost_center text,branch text,issued_on date,quantity numeric,sale_cents bigint,freight_cents bigint,tax_cents bigint,cost_cents bigint,commission_cents bigint,margin_cents bigint,margin_source text);
 SELECT * INTO v_profile FROM public.profiles WHERE id=p_user_id;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
 VALUES(p_user_id,v_profile.username,v_profile.role_key,'faturamento','commercial_imports',v_id::text,'IMPORT',jsonb_build_object('month',p_month,'file_name',p_file_name,'file_sha256',p_file_sha256,'row_count',jsonb_array_length(v_rows),'previous_import_id',v_previous));
 RETURN jsonb_build_object('import_id',v_id,'row_count',jsonb_array_length(v_rows),'month',p_month,'idempotent',false);
END $$;

CREATE FUNCTION public.list_commercial_items(p_month date DEFAULT NULL,p_search text DEFAULT '',p_branch text DEFAULT '',p_centre text DEFAULT '',p_employee text DEFAULT '',p_margin_band text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_month date;v_import public.commercial_imports%ROWTYPE;v_margin_allowed boolean;v_rows jsonb;v_summary jsonb;v_options jsonb;v_count bigint;BEGIN
 IF NOT(cf_private.has_permission('faturamento','read') OR cf_private.has_permission('margens','read')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 v_margin_allowed:=cf_private.has_permission('margens','read');
 IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
  OR p_search IS NULL OR length(p_search)>500 OR p_branch IS NULL OR length(p_branch)>500 OR p_centre IS NULL OR length(p_centre)>500 OR p_employee IS NULL OR length(p_employee)>500
  OR p_margin_band IS NULL OR p_margin_band NOT IN('','lt10','10_15','15_20','20_25','25_30','30_35','gt35','unknown') THEN RAISE EXCEPTION 'Filtros inválidos.' USING ERRCODE='22023';END IF;
 IF p_margin_band<>'' AND NOT v_margin_allowed THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 v_month:=coalesce(p_month,(SELECT max(month) FROM public.commercial_current_imports),date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date);
 IF v_month<DATE '1900-01-01' OR v_month>DATE '2199-12-01' OR extract(day FROM v_month)<>1 THEN RAISE EXCEPTION 'Mês inválido.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_import FROM public.commercial_current_imports WHERE month=v_month;
 WITH all_rows AS(SELECT i.*,CASE WHEN sale_cents<>0 THEN margin_cents::numeric*100/sale_cents END AS margin_percent FROM public.commercial_items i WHERE import_id=v_import.id),
 filtered AS(SELECT * FROM all_rows WHERE (p_search='' OR strpos(lower(code||' '||product||' '||client||' '||invoice||' '||employee),lower(p_search))>0)
  AND(p_branch='' OR branch=p_branch) AND(p_centre='' OR cost_center=p_centre) AND(p_employee='' OR employee=p_employee)
  AND CASE p_margin_band WHEN '' THEN true WHEN 'lt10' THEN margin_percent<10 WHEN '10_15' THEN margin_percent BETWEEN 10 AND 15 WHEN '15_20' THEN margin_percent>15 AND margin_percent<=20 WHEN '20_25' THEN margin_percent>20 AND margin_percent<=25 WHEN '25_30' THEN margin_percent>25 AND margin_percent<=30 WHEN '30_35' THEN margin_percent>30 AND margin_percent<=35 WHEN 'gt35' THEN margin_percent>35 WHEN 'unknown' THEN margin_percent IS NULL ELSE false END),
 totals AS(SELECT coalesce(sum(sale_cents),0) AS sale,CASE WHEN count(*) FILTER(WHERE margin_cents IS NULL)=0 THEN coalesce(sum(margin_cents),0) END AS margin,count(*) AS n,count(*) FILTER(WHERE margin_cents IS NULL) AS missing FROM all_rows),
 ftotals AS(SELECT coalesce(sum(sale_cents),0) AS sale,CASE WHEN count(*) FILTER(WHERE margin_cents IS NULL)=0 THEN coalesce(sum(margin_cents),0) END AS margin,count(*) AS n,count(*) FILTER(WHERE margin_cents IS NULL) AS missing FROM filtered),
 page AS(SELECT * FROM filtered ORDER BY issued_on,invoice,line_number LIMIT p_limit OFFSET p_offset)
 SELECT (SELECT n FROM ftotals),
  coalesce((SELECT jsonb_agg(CASE WHEN v_margin_allowed THEN to_jsonb(p) ELSE (to_jsonb(p)-ARRAY['cost_cents','freight_cents','tax_cents','commission_cents','margin_cents','margin_percent','margin_source'])||jsonb_build_object('cost_cents',NULL,'freight_cents',NULL,'tax_cents',NULL,'commission_cents',NULL,'margin_cents',NULL,'margin_percent',NULL,'margin_source','UNAVAILABLE') END ORDER BY issued_on,invoice,line_number) FROM page p),'[]'),
  (SELECT jsonb_build_object('sale_cents',t.sale,'margin_cents',CASE WHEN v_margin_allowed THEN t.margin END,'margin_percent',CASE WHEN v_margin_allowed AND t.sale<>0 THEN t.margin*100/t.sale END,'row_count',t.n,'margin_missing_count',CASE WHEN v_margin_allowed THEN t.missing END,
   'filtered_sale_cents',f.sale,'filtered_margin_cents',CASE WHEN v_margin_allowed THEN f.margin END,'filtered_margin_percent',CASE WHEN v_margin_allowed AND f.sale<>0 THEN f.margin*100/f.sale END,'filtered_count',f.n,'filtered_margin_missing_count',CASE WHEN v_margin_allowed THEN f.missing END) FROM totals t CROSS JOIN ftotals f)
 INTO v_count,v_rows,v_summary;
 SELECT jsonb_build_object('months',(SELECT coalesce(jsonb_agg(month ORDER BY month DESC),'[]') FROM public.commercial_current_imports),
 'branches',(SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') FROM(SELECT DISTINCT branch AS v FROM public.commercial_items WHERE import_id=v_import.id AND branch<>'')s),
 'centres',(SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') FROM(SELECT DISTINCT cost_center AS v FROM public.commercial_items WHERE import_id=v_import.id AND cost_center<>'')s),
 'employees',(SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') FROM(SELECT DISTINCT employee AS v FROM public.commercial_items WHERE import_id=v_import.id AND employee<>'')s)) INTO v_options;
 RETURN jsonb_build_object('month',v_month,'rows',v_rows,'count',v_count,'summary',v_summary,'options',v_options,'revision',coalesce(v_import.id::text,'empty:'||v_month::text),
 'source',CASE WHEN v_import.id IS NOT NULL THEN jsonb_build_object('import_id',v_import.id,'file_name',v_import.file_name,'updated_at',v_import.created_at,'month',v_import.month) END);
END $$;
CREATE FUNCTION public.commercial_director_metrics(p_month date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_month date:=coalesce(p_month,date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date);v_import public.commercial_imports%ROWTYPE;v_result jsonb;BEGIN
 IF NOT(cf_private.has_permission('painel','read') OR cf_private.has_permission('resumo_diretoria','read')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF extract(day FROM v_month)<>1 OR v_month<DATE '1900-01-01' OR v_month>DATE '2199-12-01' THEN RAISE EXCEPTION 'Mês inválido.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_import FROM public.commercial_current_imports WHERE month=v_month;
 IF v_import.id IS NULL THEN RETURN jsonb_build_object('month',v_month,'import_id',NULL,'sale_cents',NULL,'comlurb_cents',NULL,'other_sale_cents',NULL,'margin_cents',NULL,'margin_missing_count',NULL,'updated_at',NULL);END IF;
 SELECT jsonb_build_object('month',v_month,'import_id',v_import.id,'sale_cents',sum(sale_cents),'comlurb_cents',coalesce(sum(sale_cents) FILTER(WHERE upper(client) LIKE '%COMLURB%'),0),
 'other_sale_cents',coalesce(sum(sale_cents) FILTER(WHERE upper(client) NOT LIKE '%COMLURB%'),0),'margin_cents',CASE WHEN count(*) FILTER(WHERE margin_cents IS NULL)=0 THEN sum(margin_cents) END,
 'margin_missing_count',count(*) FILTER(WHERE margin_cents IS NULL),'updated_at',v_import.created_at) INTO v_result FROM public.commercial_items WHERE import_id=v_import.id;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION cf_private.require_commercial_import(),cf_private.normalize_commercial_rows(jsonb,date),public.preview_commercial_import(jsonb,date),public.commit_commercial_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid),public.list_commercial_items(date,text,text,text,text,text,integer,integer),public.commercial_director_metrics(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_commercial_import(jsonb,date),public.list_commercial_items(date,text,text,text,text,text,integer,integer),public.commercial_director_metrics(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_commercial_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid) TO service_role;
INSERT INTO public.central_schema_migrations(version) VALUES('032_commercial');
COMMIT;
