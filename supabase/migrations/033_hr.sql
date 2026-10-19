-- RH/DP: snapshots privados da folha, preservando os dois campos SALÁRIO.
-- Somente configuração da política V75; não inclui pessoas ou valores históricos.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='031_director_readonly') THEN
  RAISE EXCEPTION 'Ative a atualização 031 de acesso antes do RH/DP.' USING ERRCODE='22023';END IF;
END $$;

CREATE FUNCTION cf_private.hr_normalize(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT regexp_replace(translate(upper(btrim(coalesce(p_text,''))),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC'),'\s+',' ','g');
$$;
CREATE FUNCTION cf_private.hr_rows(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_key text;v_number numeric;v_total numeric;v_date date;v_seen integer[]:='{}';BEGIN
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 OR octet_length(p_rows::text)>4194304 THEN
  RAISE EXCEPTION 'Informe de 1 a 5.000 registros válidos de RH/DP.' USING ERRCODE='22023';END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(v_row)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v_row))<>12
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_row)k WHERE k NOT IN('source_row','branch','employee','sector','admitted_on','birthday_on','salary_base_cents','payroll_salary_cents','transport_cents','advance_cents','total_cents','count_label')) THEN
   RAISE EXCEPTION 'Registro de RH/DP contém campos ausentes ou não autorizados.' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(v_row->'source_row')<>'number' OR (v_row->>'source_row')::numeric<>trunc((v_row->>'source_row')::numeric)
   OR (v_row->>'source_row')::numeric NOT BETWEEN 2 AND 5020 OR (v_row->>'source_row')::integer=ANY(v_seen) THEN
   RAISE EXCEPTION 'Número da linha inválido ou repetido.' USING ERRCODE='22023';END IF;
  v_seen:=array_append(v_seen,(v_row->>'source_row')::integer);
  FOREACH v_key IN ARRAY ARRAY['branch','employee','sector'] LOOP
   IF jsonb_typeof(v_row->v_key)<>'string' OR length(v_row->>v_key)>(CASE WHEN v_key='employee' THEN 300 ELSE 150 END)
    OR v_row->>v_key<>btrim(v_row->>v_key) OR v_row->>v_key~'[[:cntrl:]]' OR (v_key='employee' AND length(v_row->>v_key)=0) THEN
    RAISE EXCEPTION 'Nome, filial ou setor inválido.' USING ERRCODE='22023';END IF;
  END LOOP;
  IF jsonb_typeof(v_row->'count_label') NOT IN('null','string') OR length(v_row->>'count_label')>150 OR v_row->>'count_label'~'[[:cntrl:]]' THEN
   RAISE EXCEPTION 'Contagem inválida.' USING ERRCODE='22023';END IF;
  FOREACH v_key IN ARRAY ARRAY['admitted_on','birthday_on'] LOOP
   IF jsonb_typeof(v_row->v_key)<>'null' THEN
    IF jsonb_typeof(v_row->v_key)<>'string' OR v_row->>v_key!~'^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Data civil de RH/DP inválida.' USING ERRCODE='22023';END IF;
    BEGIN v_date:=(v_row->>v_key)::date;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Data civil de RH/DP inexistente.' USING ERRCODE='22023';END;
    IF v_date NOT BETWEEN DATE '1900-01-01' AND DATE '2199-12-31' THEN RAISE EXCEPTION 'Data fora do intervalo permitido.' USING ERRCODE='22023';END IF;
   END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['salary_base_cents','payroll_salary_cents','transport_cents','advance_cents','total_cents'] LOOP
   IF jsonb_typeof(v_row->v_key)<>'null' THEN
    IF jsonb_typeof(v_row->v_key)<>'number' THEN RAISE EXCEPTION 'Informe centavos inteiros ou deixe o valor desconhecido.' USING ERRCODE='22023';END IF;
    v_number:=(v_row->>v_key)::numeric;
    IF v_number<>trunc(v_number) OR abs(v_number)>9007199254740991 OR v_key='salary_base_cents' AND v_number<0 THEN
     RAISE EXCEPTION 'Valor monetário inválido ou fora do limite de precisão.' USING ERRCODE='22023';END IF;
   END IF;
  END LOOP;
 END LOOP;
 FOREACH v_key IN ARRAY ARRAY['salary_base_cents','payroll_salary_cents','transport_cents','advance_cents','total_cents'] LOOP
  SELECT sum(abs((r->>v_key)::numeric)) INTO v_total FROM jsonb_array_elements(p_rows)r;
  IF v_total>9007199254740991 THEN RAISE EXCEPTION 'Total da coluna excede o limite de precisão.' USING ERRCODE='22003';END IF;
 END LOOP;
 RETURN p_rows;
END $$;

CREATE TABLE cf_private.hr_imports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reference_date date NOT NULL CHECK(reference_date>=DATE '1900-01-01'),
 file_name text NOT NULL,file_sha256 text NOT NULL CHECK(file_sha256~'^[a-f0-9]{64}$'),original_bytes bytea NOT NULL,
 rows jsonb NOT NULL CHECK(rows=cf_private.hr_rows(rows)),row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 5000),
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_by uuid NOT NULL REFERENCES public.profiles(id),
 UNIQUE(reference_date,file_sha256),CHECK(row_count=jsonb_array_length(rows))
);
REVOKE ALL ON cf_private.hr_imports FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE cf_private.hr_imports ENABLE ROW LEVEL SECURITY;
CREATE INDEX hr_imports_latest ON cf_private.hr_imports(reference_date DESC,imported_at DESC,id DESC);
CREATE FUNCTION cf_private.hr_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 RAISE EXCEPTION 'O histórico de RH/DP é imutável. Importe uma nova posição para corrigir a base.' USING ERRCODE='42501';
END $$;
CREATE TRIGGER hr_imports_append_only BEFORE UPDATE OR DELETE ON cf_private.hr_imports
 FOR EACH ROW EXECUTE FUNCTION cf_private.hr_history_immutable();

CREATE FUNCTION cf_private.require_hr_import() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('rh_dp','read') OR NOT cf_private.has_permission('rh_dp','write')
  OR NOT cf_private.has_permission('rh_dp','import') OR NOT cf_private.has_permission('importar_bases','read') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION cf_private.hr_statistics(p_rows jsonb,p_month date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_rows jsonb;v_summary jsonb;v_quality jsonb;v_by_branch jsonb;v_by_sector jsonb;v_birthdays jsonb;v_anniversaries jsonb;BEGIN
 SELECT coalesce(jsonb_agg(r||jsonb_build_object('is_partner',cf_private.hr_normalize(r->>'sector')='SOCIO',
  'basket_eligible',cf_private.hr_normalize(r->>'employee') NOT IN('GABRIEL PEDROSA MARQUES FERREIRA','GUSTAVO MARQUES FERREIRA'),
  'basket_cost_cents',CASE WHEN cf_private.hr_normalize(r->>'employee') IN('GABRIEL PEDROSA MARQUES FERREIRA','GUSTAVO MARQUES FERREIRA') THEN 0 ELSE 11280 END) ORDER BY (r->>'source_row')::integer),'[]'::jsonb)
  INTO v_rows FROM jsonb_array_elements(p_rows)r;
 SELECT jsonb_build_object('employees',count(*) FILTER(WHERE NOT (r->>'is_partner')::boolean),'partners',count(*) FILTER(WHERE (r->>'is_partner')::boolean),
  'admissions',count(*) FILTER(WHERE date_trunc('month',(r->>'admitted_on')::date)=p_month),'birthdays',count(*) FILTER(WHERE extract(month FROM (r->>'birthday_on')::date)=extract(month FROM p_month)),
  'basket_eligible',count(*) FILTER(WHERE (r->>'basket_eligible')::boolean),'basket_excluded',count(*) FILTER(WHERE NOT (r->>'basket_eligible')::boolean),
  'basket_unit_cents',11280,'basket_monthly_cents',coalesce(sum((r->>'basket_cost_cents')::bigint),0),'basket_annual_cents',coalesce(sum((r->>'basket_cost_cents')::bigint),0)*12,
  'salary_base_cents',CASE WHEN count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean AND r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint) FILTER(WHERE NOT(r->>'is_partner')::boolean),0) END,
  'transport_cents',CASE WHEN count(*) FILTER(WHERE r->>'transport_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'transport_cents')::bigint),0) END,
  'advance_cents',CASE WHEN count(*) FILTER(WHERE r->>'advance_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'advance_cents')::bigint),0) END,
  'total_cents',CASE WHEN count(*) FILTER(WHERE r->>'total_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'total_cents')::bigint),0) END),
  jsonb_build_object('missing_admission',count(*) FILTER(WHERE r->>'admitted_on' IS NULL),'missing_birthday',count(*) FILTER(WHERE r->>'birthday_on' IS NULL),
  'missing_branch',count(*) FILTER(WHERE r->>'branch'=''),'missing_sector',count(*) FILTER(WHERE r->>'sector'=''),
  'missing_salary_base',count(*) FILTER(WHERE r->>'salary_base_cents' IS NULL),'missing_payroll_salary',count(*) FILTER(WHERE r->>'payroll_salary_cents' IS NULL),
  'missing_transport',count(*) FILTER(WHERE r->>'transport_cents' IS NULL),'missing_advance',count(*) FILTER(WHERE r->>'advance_cents' IS NULL),'missing_total',count(*) FILTER(WHERE r->>'total_cents' IS NULL))
 INTO v_summary,v_quality FROM jsonb_array_elements(v_rows)r;
 SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.count DESC,g.label),'[]') INTO v_by_branch FROM(
  SELECT coalesce(nullif(r->>'branch',''),'NÃO INFORMADO') AS label,count(*) AS count,
   CASE WHEN count(*) FILTER(WHERE r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE sum((r->>'salary_base_cents')::bigint) END AS salary_base_cents
  FROM jsonb_array_elements(v_rows)r GROUP BY 1)g;
 SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.count DESC,g.label),'[]') INTO v_by_sector FROM(
  SELECT coalesce(nullif(r->>'sector',''),'NÃO INFORMADO') AS label,count(*) AS count,
   CASE WHEN count(*) FILTER(WHERE r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE sum((r->>'salary_base_cents')::bigint) END AS salary_base_cents
  FROM jsonb_array_elements(v_rows)r GROUP BY 1)g;
 SELECT coalesce(jsonb_agg(r||jsonb_build_object('day',extract(day FROM (r->>'birthday_on')::date)::integer)
  ORDER BY extract(day FROM (r->>'birthday_on')::date),r->>'employee'),'[]') INTO v_birthdays FROM jsonb_array_elements(v_rows)r
  WHERE extract(month FROM (r->>'birthday_on')::date)=extract(month FROM p_month);
 SELECT coalesce(jsonb_agg(r||jsonb_build_object('day',extract(day FROM (r->>'admitted_on')::date)::integer,'years',extract(year FROM p_month)::integer-extract(year FROM (r->>'admitted_on')::date)::integer)
  ORDER BY extract(day FROM (r->>'admitted_on')::date),r->>'employee'),'[]') INTO v_anniversaries FROM jsonb_array_elements(v_rows)r
  WHERE extract(month FROM (r->>'admitted_on')::date)=extract(month FROM p_month) AND extract(year FROM p_month)>extract(year FROM (r->>'admitted_on')::date);
 RETURN jsonb_build_object('calendar_month',p_month,'summary',v_summary,'quality',v_quality,'by_branch',v_by_branch,'by_sector',v_by_sector,'birthdays',v_birthdays,'work_anniversaries',v_anniversaries,'rows',v_rows);
END $$;

CREATE FUNCTION public.hr_report(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_import cf_private.hr_imports%ROWTYPE;v_report jsonb;BEGIN
 IF NOT cf_private.has_permission('rh_dp','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_month IS NULL OR p_month NOT BETWEEN DATE '1900-01-01' AND DATE '2199-12-01' OR extract(day FROM p_month)<>1 THEN RAISE EXCEPTION 'Selecione o mês de referência.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_import FROM cf_private.hr_imports ORDER BY reference_date DESC,imported_at DESC,id DESC LIMIT 1;
 v_report:=cf_private.hr_statistics(coalesce(v_import.rows,'[]'::jsonb),p_month);
 RETURN v_report||jsonb_build_object('snapshot',CASE WHEN v_import.id IS NULL THEN NULL ELSE jsonb_build_object('id',v_import.id,'reference_date',v_import.reference_date,
  'file_name',v_import.file_name,'sha256',v_import.file_sha256,'imported_at',v_import.imported_at,'row_count',v_import.row_count) END);
END $$;
CREATE FUNCTION public.preview_hr_import(p_rows jsonb,p_reference_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_previous uuid;v_result jsonb;BEGIN
 PERFORM cf_private.require_hr_import();
 IF p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01' OR p_reference_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
  RAISE EXCEPTION 'Informe a data da posição até hoje em São Paulo.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.hr_rows(p_rows);
 SELECT id INTO v_previous FROM cf_private.hr_imports ORDER BY reference_date DESC,imported_at DESC,id DESC LIMIT 1;
 v_result:=cf_private.hr_statistics(p_rows,date_trunc('month',p_reference_date)::date);
 RETURN jsonb_build_object('row_count',jsonb_array_length(p_rows),'previous_import_id',v_previous,'summary',v_result->'summary','quality',v_result->'quality');
END $$;
CREATE FUNCTION public.commit_hr_import_from_gateway(p_user_id uuid,p_session_id text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_reference_date date,p_previous_import_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_bytes bytea;v_previous uuid;v_import cf_private.hr_imports%ROWTYPE;v_actor public.profiles%ROWTYPE;v_preview jsonb;BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_session_id!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM cf_private.require_hr_import();
 IF p_file_name IS NULL OR length(p_file_name) NOT BETWEEN 1 AND 250 OR p_file_name<>btrim(p_file_name) OR p_file_name~'[/\\[:cntrl:]]' OR p_file_name!~*'\.(xlsx|xlsm|csv)$'
  OR p_file_sha256 IS NULL OR p_file_sha256!~'^[a-f0-9]{64}$' OR p_file_base64 IS NULL OR length(p_file_base64) NOT BETWEEN 1 AND 2796204 THEN
  RAISE EXCEPTION 'Metadados do arquivo de RH/DP inválidos.' USING ERRCODE='22023';END IF;
 BEGIN v_bytes:=decode(p_file_base64,'base64');EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN RAISE EXCEPTION 'Arquivo original inválido.' USING ERRCODE='22023';END;
 IF octet_length(v_bytes) NOT BETWEEN 1 AND 2097152 OR encode(sha256(v_bytes),'hex')<>p_file_sha256 THEN RAISE EXCEPTION 'Integridade do arquivo original não confirmada.' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(2045812333);
 v_preview:=public.preview_hr_import(p_rows,p_reference_date);
 SELECT * INTO v_import FROM cf_private.hr_imports WHERE reference_date=p_reference_date AND file_sha256=p_file_sha256;
 IF FOUND THEN
  IF v_import.rows<>p_rows THEN RAISE EXCEPTION 'O mesmo original não corresponde aos registros preparados.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('import_id',v_import.id,'row_count',v_import.row_count,'idempotent',true);END IF;
 v_previous:=(v_preview->>'previous_import_id')::uuid;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN RAISE EXCEPTION 'A base de RH/DP mudou. Analise novamente antes de importar.' USING ERRCODE='40001';END IF;
 INSERT INTO cf_private.hr_imports(reference_date,file_name,file_sha256,original_bytes,rows,row_count,created_by)
 VALUES(p_reference_date,p_file_name,p_file_sha256,v_bytes,p_rows,jsonb_array_length(p_rows),p_user_id) RETURNING * INTO v_import;
 SELECT * INTO v_actor FROM public.profiles WHERE id=p_user_id;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'rh_dp','hr_imports',v_import.id::text,'IMPORT',CASE WHEN v_previous IS NULL THEN NULL ELSE jsonb_build_object('import_id',v_previous) END,
  jsonb_build_object('reference_date',p_reference_date,'file_name',p_file_name,'file_sha256',p_file_sha256,'row_count',v_import.row_count,'summary',v_preview->'summary','policy_version','v75-rh-cesta-11280'));
 RETURN jsonb_build_object('import_id',v_import.id,'row_count',v_import.row_count,'idempotent',false);
END $$;

REVOKE ALL ON FUNCTION cf_private.hr_normalize(text),cf_private.hr_rows(jsonb),cf_private.hr_history_immutable(),cf_private.require_hr_import(),cf_private.hr_statistics(jsonb,date),
 public.hr_report(date),public.preview_hr_import(jsonb,date),public.commit_hr_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hr_report(date),public.preview_hr_import(jsonb,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_hr_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid) TO service_role;
INSERT INTO public.central_schema_migrations(version) VALUES('033_hr') ON CONFLICT(version) DO NOTHING;
COMMIT;
