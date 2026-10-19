-- RH/DP: total explícito dos cinco valores definidos pela operação.
-- Projeta os totais na leitura e na prévia; arquivos, posições e auditorias são preservados.
-- Revisão 3 corrige os aliases de Salário Folha (bruto) e Salário recebido (líquido).
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='035_hr_report_model') THEN
  RAISE EXCEPTION 'Ative a atualização 035 de RH/DP antes desta correção.' USING ERRCODE='22023';END IF;
END $$;

ALTER TABLE cf_private.hr_imports DROP CONSTRAINT hr_imports_format_version_check;
ALTER TABLE cf_private.hr_imports ADD CONSTRAINT hr_imports_format_version_check CHECK(format_version IN(1,2,3));
ALTER TABLE cf_private.hr_imports DROP CONSTRAINT hr_imports_format_rows_check;
ALTER TABLE cf_private.hr_imports ADD CONSTRAINT hr_imports_format_rows_check CHECK(
 (format_version=1 AND rows=cf_private.hr_rows(rows)) OR (format_version IN(2,3) AND rows=cf_private.hr_report_rows(rows)));

CREATE OR REPLACE FUNCTION cf_private.hr_statistics(p_rows jsonb,p_month date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_rows jsonb;v_summary jsonb;v_quality jsonb;v_by_branch jsonb;v_by_sector jsonb;v_birthdays jsonb;v_anniversaries jsonb;
 v_formula_version constant text:='rh-five-fields-v1';
 v_formula_caption constant text:='Total = Salário Base + VT total + Salário recebido + Adiantamento + Ajuda de Custo';
BEGIN
 SELECT coalesce(jsonb_agg(r||jsonb_build_object('is_partner',cf_private.hr_normalize(r->>'sector')='SOCIO',
  'cost_allowance_cents',coalesce(r->'cost_allowance_cents','null'::jsonb),
  'reported_total_cents',coalesce(r->'total_cents','null'::jsonb),
  'total_cents',CASE WHEN r->>'salary_base_cents' IS NULL OR r->>'payroll_salary_cents' IS NULL OR r->>'transport_cents' IS NULL
   OR r->>'advance_cents' IS NULL OR r->>'cost_allowance_cents' IS NULL THEN NULL
   ELSE (r->>'salary_base_cents')::numeric+(r->>'payroll_salary_cents')::numeric+(r->>'transport_cents')::numeric
    +(r->>'advance_cents')::numeric+(r->>'cost_allowance_cents')::numeric END,
  'basket_eligible',cf_private.hr_normalize(r->>'employee') NOT IN('GABRIEL PEDROSA MARQUES FERREIRA','GUSTAVO MARQUES FERREIRA'),
  'basket_cost_cents',CASE WHEN cf_private.hr_normalize(r->>'employee') IN('GABRIEL PEDROSA MARQUES FERREIRA','GUSTAVO MARQUES FERREIRA') THEN 0 ELSE 11280 END) ORDER BY (r->>'source_row')::integer),'[]'::jsonb)
  INTO v_rows FROM jsonb_array_elements(p_rows)r;
 -- Numeric addition preserves exact integer cents before enforcing the browser's limit.
 -- Absolute aggregates also prevent large positive and negative rows from hiding overflow.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows)r WHERE abs((r->>'total_cents')::numeric)>9007199254740991)
  OR (SELECT coalesce(sum(abs((r->>'total_cents')::numeric)),0) FROM jsonb_array_elements(v_rows)r)>9007199254740991 THEN
  RAISE EXCEPTION 'O total calculado de RH/DP excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT jsonb_build_object('employees',count(*) FILTER(WHERE NOT (r->>'is_partner')::boolean),'partners',count(*) FILTER(WHERE (r->>'is_partner')::boolean),
  'admissions',count(*) FILTER(WHERE date_trunc('month',(r->>'admitted_on')::date)=p_month),'birthdays',count(*) FILTER(WHERE extract(month FROM (r->>'birthday_on')::date)=extract(month FROM p_month)),
  'basket_eligible',count(*) FILTER(WHERE (r->>'basket_eligible')::boolean),'basket_excluded',count(*) FILTER(WHERE NOT (r->>'basket_eligible')::boolean),
  'basket_unit_cents',11280,'basket_monthly_cents',coalesce(sum((r->>'basket_cost_cents')::bigint),0),'basket_annual_cents',coalesce(sum((r->>'basket_cost_cents')::bigint),0)*12,
  'salary_base_cents',CASE WHEN count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean AND r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint) FILTER(WHERE NOT(r->>'is_partner')::boolean),0) END,
  'salary_base_all_cents',CASE WHEN count(*) FILTER(WHERE r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint),0) END,
  'payroll_salary_employees_cents',CASE WHEN count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean AND r->>'payroll_salary_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'payroll_salary_cents')::bigint) FILTER(WHERE NOT(r->>'is_partner')::boolean),0) END,
  'payroll_salary_cents',CASE WHEN count(*) FILTER(WHERE r->>'payroll_salary_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'payroll_salary_cents')::bigint),0) END,
  'cost_allowance_cents',CASE WHEN count(*) FILTER(WHERE r->>'cost_allowance_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'cost_allowance_cents')::bigint),0) END,
  'transport_cents',CASE WHEN count(*) FILTER(WHERE r->>'transport_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'transport_cents')::bigint),0) END,
  'advance_cents',CASE WHEN count(*) FILTER(WHERE r->>'advance_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'advance_cents')::bigint),0) END,
  'reported_total_cents',CASE WHEN count(*) FILTER(WHERE r->>'reported_total_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'reported_total_cents')::bigint),0) END,
  'total_cents',CASE WHEN count(*) FILTER(WHERE r->>'total_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'total_cents')::bigint),0) END,
  'total_formula_version',v_formula_version,'total_formula_caption',v_formula_caption),
  jsonb_build_object('missing_admission',count(*) FILTER(WHERE r->>'admitted_on' IS NULL),'missing_birthday',count(*) FILTER(WHERE r->>'birthday_on' IS NULL),
  'missing_branch',count(*) FILTER(WHERE r->>'branch'=''),'missing_sector',count(*) FILTER(WHERE r->>'sector'=''),
  'missing_salary_base',count(*) FILTER(WHERE r->>'salary_base_cents' IS NULL),'missing_payroll_salary',count(*) FILTER(WHERE r->>'payroll_salary_cents' IS NULL),
  'missing_cost_allowance',count(*) FILTER(WHERE r->>'cost_allowance_cents' IS NULL),
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
 RETURN jsonb_build_object('total_formula_version',v_formula_version,'total_formula_caption',v_formula_caption,'calendar_month',p_month,'summary',v_summary,'quality',v_quality,'by_branch',v_by_branch,'by_sector',v_by_sector,'birthdays',v_birthdays,'work_anniversaries',v_anniversaries,'rows',v_rows);
END $$;

CREATE FUNCTION public.preview_hr_total_import(p_rows jsonb,p_reference_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_previous uuid;v_result jsonb;BEGIN
 PERFORM cf_private.require_hr_import();
 IF p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01' OR p_reference_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
  RAISE EXCEPTION 'Informe a data da posição até hoje em São Paulo.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.hr_report_rows(p_rows);
 SELECT id INTO v_previous FROM cf_private.hr_imports ORDER BY reference_date DESC,imported_at DESC,id DESC LIMIT 1;
 v_result:=cf_private.hr_statistics(p_rows,date_trunc('month',p_reference_date)::date);
 RETURN jsonb_build_object('row_count',jsonb_array_length(p_rows),'previous_import_id',v_previous,'summary',v_result->'summary','quality',v_result->'quality','rows',v_result->'rows');
END $$;

CREATE OR REPLACE FUNCTION public.commit_hr_import_from_gateway(p_user_id uuid,p_session_id text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_reference_date date,p_previous_import_id uuid) RETURNS jsonb
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
 SELECT * INTO v_import FROM cf_private.hr_imports WHERE reference_date=p_reference_date AND file_sha256=p_file_sha256 AND format_version=1;
 IF FOUND THEN
  IF v_import.rows<>p_rows THEN RAISE EXCEPTION 'O mesmo original não corresponde aos registros preparados.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('import_id',v_import.id,'row_count',v_import.row_count,'idempotent',true);END IF;
 IF EXISTS(SELECT 1 FROM cf_private.hr_imports WHERE format_version IN(2,3)) THEN
  RAISE EXCEPTION 'O modelo de RH/DP foi atualizado. Atualize a função de importação e analise o arquivo novamente.' USING ERRCODE='40001';END IF;
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

CREATE OR REPLACE FUNCTION public.commit_hr_report_import_from_gateway(p_user_id uuid,p_session_id text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_reference_date date,p_previous_import_id uuid) RETURNS jsonb
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
 v_preview:=public.preview_hr_report_import(p_rows,p_reference_date);
 SELECT * INTO v_import FROM cf_private.hr_imports WHERE reference_date=p_reference_date AND file_sha256=p_file_sha256 AND format_version=2;
 IF FOUND THEN
  IF v_import.rows<>p_rows THEN RAISE EXCEPTION 'O mesmo original não corresponde aos registros preparados.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('import_id',v_import.id,'row_count',v_import.row_count,'idempotent',true);END IF;
 IF EXISTS(SELECT 1 FROM cf_private.hr_imports WHERE format_version=3) THEN
  RAISE EXCEPTION 'O modelo de RH/DP foi atualizado. Atualize a função de importação e analise o arquivo novamente.' USING ERRCODE='40001';END IF;
 v_previous:=(v_preview->>'previous_import_id')::uuid;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN RAISE EXCEPTION 'A base de RH/DP mudou. Analise novamente antes de importar.' USING ERRCODE='40001';END IF;
 INSERT INTO cf_private.hr_imports(reference_date,file_name,file_sha256,original_bytes,rows,row_count,created_by,format_version)
 VALUES(p_reference_date,p_file_name,p_file_sha256,v_bytes,p_rows,jsonb_array_length(p_rows),p_user_id,2) RETURNING * INTO v_import;
 SELECT * INTO v_actor FROM public.profiles WHERE id=p_user_id;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'rh_dp','hr_imports',v_import.id::text,'IMPORT',CASE WHEN v_previous IS NULL THEN NULL ELSE jsonb_build_object('import_id',v_previous) END,
  jsonb_build_object('reference_date',p_reference_date,'file_name',p_file_name,'file_sha256',p_file_sha256,'row_count',v_import.row_count,'summary',v_preview->'summary','policy_version','v75-rh-cesta-11280','format_version',2));
 RETURN jsonb_build_object('import_id',v_import.id,'row_count',v_import.row_count,'idempotent',false);
END $$;

CREATE FUNCTION public.commit_hr_total_import_from_gateway(p_user_id uuid,p_session_id text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_reference_date date,p_previous_import_id uuid) RETURNS jsonb
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
 v_preview:=public.preview_hr_total_import(p_rows,p_reference_date);
 SELECT * INTO v_import FROM cf_private.hr_imports WHERE reference_date=p_reference_date AND file_sha256=p_file_sha256 AND format_version=3;
 IF FOUND THEN
  IF v_import.rows<>p_rows THEN RAISE EXCEPTION 'O mesmo original não corresponde aos registros preparados.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('import_id',v_import.id,'row_count',v_import.row_count,'idempotent',true);END IF;
 v_previous:=(v_preview->>'previous_import_id')::uuid;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN RAISE EXCEPTION 'A base de RH/DP mudou. Analise novamente antes de importar.' USING ERRCODE='40001';END IF;
 INSERT INTO cf_private.hr_imports(reference_date,file_name,file_sha256,original_bytes,rows,row_count,created_by,format_version)
 VALUES(p_reference_date,p_file_name,p_file_sha256,v_bytes,p_rows,jsonb_array_length(p_rows),p_user_id,3) RETURNING * INTO v_import;
 SELECT * INTO v_actor FROM public.profiles WHERE id=p_user_id;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'rh_dp','hr_imports',v_import.id::text,'IMPORT',CASE WHEN v_previous IS NULL THEN NULL ELSE jsonb_build_object('import_id',v_previous) END,
  jsonb_build_object('reference_date',p_reference_date,'file_name',p_file_name,'file_sha256',p_file_sha256,'row_count',v_import.row_count,'summary',v_preview->'summary','policy_version','v75-rh-cesta-11280','format_version',3));
 RETURN jsonb_build_object('import_id',v_import.id,'row_count',v_import.row_count,'idempotent',false);
END $$;

REVOKE ALL ON FUNCTION public.preview_hr_total_import(jsonb,date),
 public.commit_hr_total_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_hr_total_import(jsonb,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_hr_total_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid) TO service_role;

-- CREATE OR REPLACE mantém os privilégios privados de hr_statistics, sem expor dados da folha.
INSERT INTO public.central_schema_migrations(version) VALUES('036_hr_total') ON CONFLICT(version) DO NOTHING;
COMMIT;
