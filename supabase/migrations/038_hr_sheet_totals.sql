-- RH/DP: os totais da própria planilha são preservados e conferidos com as linhas.
-- Revisão 4 guarda o rodapé separadamente; não altera posições nem arquivos anteriores.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='037_hr_prolabore') THEN
  RAISE EXCEPTION 'Ative a atualização 037 de RH/DP antes dos totais da planilha.' USING ERRCODE='22023';END IF;
END $$;

CREATE OR REPLACE FUNCTION cf_private.hr_sheet_totals(p_rows jsonb,p_totals jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_key text;v_number numeric;v_sum numeric;v_missing bigint;v_last_row integer;BEGIN
 IF p_totals IS NULL THEN RETURN NULL;END IF;
 IF jsonb_typeof(p_totals)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_totals))<>7
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_totals)k WHERE k NOT IN('source_row','salary_base_cents','payroll_salary_cents','transport_cents','advance_cents','cost_allowance_cents','total_cents')) THEN
  RAISE EXCEPTION 'O rodapé de RH/DP contém campos ausentes ou não autorizados.' USING ERRCODE='22023';END IF;
 SELECT max((r->>'source_row')::integer) INTO v_last_row FROM jsonb_array_elements(p_rows)r;
 IF jsonb_typeof(p_totals->'source_row')<>'number' OR (p_totals->>'source_row')::numeric<>trunc((p_totals->>'source_row')::numeric)
  OR (p_totals->>'source_row')::numeric NOT BETWEEN 2 AND 5021 OR v_last_row IS NULL OR (p_totals->>'source_row')::numeric<=v_last_row THEN
  RAISE EXCEPTION 'O rodapé deve estar após a última pessoa, sem ser contado como colaborador.' USING ERRCODE='22023';END IF;
 FOREACH v_key IN ARRAY ARRAY['salary_base_cents','payroll_salary_cents','transport_cents','advance_cents','cost_allowance_cents','total_cents'] LOOP
  IF jsonb_typeof(p_totals->v_key)<>'null' THEN
   IF jsonb_typeof(p_totals->v_key)<>'number' THEN RAISE EXCEPTION 'O rodapé deve conter centavos inteiros ou valor desconhecido.' USING ERRCODE='22023';END IF;
   v_number:=(p_totals->>v_key)::numeric;
   IF v_number<>trunc(v_number) OR abs(v_number)>9007199254740991 THEN
    RAISE EXCEPTION 'Valor do rodapé inválido ou fora do limite de precisão.' USING ERRCODE='22023';END IF;
   SELECT count(*) FILTER(WHERE r->>v_key IS NULL),coalesce(sum((r->>v_key)::numeric),0) INTO v_missing,v_sum FROM jsonb_array_elements(p_rows)r;
   IF v_missing>0 THEN RAISE EXCEPTION 'Não foi possível conferir o rodapé da coluna %. Preencha os valores das pessoas nessa coluna e importe novamente.',v_key USING ERRCODE='22023';END IF;
   IF v_number<>v_sum THEN RAISE EXCEPTION 'O rodapé da coluna % difere da soma das pessoas. Confira o relatório e importe novamente.',v_key USING ERRCODE='22023';END IF;
  END IF;
 END LOOP;
 RETURN p_totals;
END $$;

ALTER TABLE cf_private.hr_imports ADD COLUMN IF NOT EXISTS report_totals jsonb;
ALTER TABLE cf_private.hr_imports DROP CONSTRAINT hr_imports_format_version_check;
ALTER TABLE cf_private.hr_imports ADD CONSTRAINT hr_imports_format_version_check CHECK(format_version IN(1,2,3,4));
ALTER TABLE cf_private.hr_imports DROP CONSTRAINT hr_imports_format_rows_check;
ALTER TABLE cf_private.hr_imports ADD CONSTRAINT hr_imports_format_rows_check CHECK(
 (format_version=1 AND rows=cf_private.hr_rows(rows)) OR (format_version IN(2,3,4) AND rows=cf_private.hr_report_rows(rows)));
ALTER TABLE cf_private.hr_imports DROP CONSTRAINT IF EXISTS hr_imports_report_totals_check;
ALTER TABLE cf_private.hr_imports ADD CONSTRAINT hr_imports_report_totals_check CHECK(
 (format_version<4 AND report_totals IS NULL) OR (format_version=4 AND (report_totals IS NULL OR report_totals=cf_private.hr_sheet_totals(rows,report_totals))));

CREATE OR REPLACE FUNCTION cf_private.hr_statistics(p_rows jsonb,p_month date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_rows jsonb;v_summary jsonb;v_quality jsonb;v_by_branch jsonb;v_by_sector jsonb;v_birthdays jsonb;v_anniversaries jsonb;
 v_formula_version constant text:='rh-reported-total-v1';
 v_compensation_version constant text:='rh-compensation-groups-v1';
 v_formula_caption constant text:='Total informado na coluna TOTAL do relatório';
BEGIN
 SELECT coalesce(jsonb_agg(r||jsonb_build_object('is_partner',cf_private.hr_normalize(r->>'sector')='SOCIO',
  'compensation_kind',CASE WHEN cf_private.hr_normalize(r->>'sector')='SOCIO' THEN 'prolabore' ELSE 'salary' END,
  'cost_allowance_cents',coalesce(r->'cost_allowance_cents','null'::jsonb),
  'reported_total_cents',coalesce(r->'total_cents','null'::jsonb),
  'total_cents',coalesce(r->'total_cents','null'::jsonb),
  'basket_eligible',cf_private.hr_normalize(r->>'employee') NOT IN('GABRIEL PEDROSA MARQUES FERREIRA','GUSTAVO MARQUES FERREIRA'),
  'basket_cost_cents',CASE WHEN cf_private.hr_normalize(r->>'employee') IN('GABRIEL PEDROSA MARQUES FERREIRA','GUSTAVO MARQUES FERREIRA') THEN 0 ELSE 11280 END) ORDER BY (r->>'source_row')::integer),'[]'::jsonb)
  INTO v_rows FROM jsonb_array_elements(p_rows)r;
 -- The source TOTAL remains exact integer cents; gross and net are never added here.
 -- Absolute aggregates prevent large positive and negative rows from hiding overflow.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows)r WHERE abs((r->>'total_cents')::numeric)>9007199254740991)
  OR (SELECT coalesce(sum(abs((r->>'total_cents')::numeric)),0) FROM jsonb_array_elements(v_rows)r)>9007199254740991 THEN
  RAISE EXCEPTION 'O total informado de RH/DP excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT jsonb_build_object('employees',count(*) FILTER(WHERE NOT (r->>'is_partner')::boolean),'partners',count(*) FILTER(WHERE (r->>'is_partner')::boolean),
  'admissions',count(*) FILTER(WHERE date_trunc('month',(r->>'admitted_on')::date)=p_month),'birthdays',count(*) FILTER(WHERE extract(month FROM (r->>'birthday_on')::date)=extract(month FROM p_month)),
  'basket_eligible',count(*) FILTER(WHERE (r->>'basket_eligible')::boolean),'basket_excluded',count(*) FILTER(WHERE NOT (r->>'basket_eligible')::boolean),
  'basket_unit_cents',11280,'basket_monthly_cents',coalesce(sum((r->>'basket_cost_cents')::bigint),0),'basket_annual_cents',coalesce(sum((r->>'basket_cost_cents')::bigint),0)*12,
  'salary_base_cents',CASE WHEN count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean AND r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint) FILTER(WHERE NOT(r->>'is_partner')::boolean),0) END,
  'salary_base_all_cents',CASE WHEN count(*) FILTER(WHERE r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint),0) END,
  'payroll_salary_employees_cents',CASE WHEN count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean AND r->>'payroll_salary_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'payroll_salary_cents')::bigint) FILTER(WHERE NOT(r->>'is_partner')::boolean),0) END,
  'prolabore_base_cents',CASE WHEN count(*) FILTER(WHERE (r->>'is_partner')::boolean AND r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint) FILTER(WHERE (r->>'is_partner')::boolean),0) END,
  'prolabore_received_cents',CASE WHEN count(*) FILTER(WHERE (r->>'is_partner')::boolean AND r->>'payroll_salary_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'payroll_salary_cents')::bigint) FILTER(WHERE (r->>'is_partner')::boolean),0) END,
  'employee_total_cents',CASE WHEN count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean AND r->>'total_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'total_cents')::bigint) FILTER(WHERE NOT(r->>'is_partner')::boolean),0) END,
  'partner_total_cents',CASE WHEN count(*) FILTER(WHERE (r->>'is_partner')::boolean AND r->>'total_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'total_cents')::bigint) FILTER(WHERE (r->>'is_partner')::boolean),0) END,
  'payroll_salary_cents',CASE WHEN count(*) FILTER(WHERE r->>'payroll_salary_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'payroll_salary_cents')::bigint),0) END,
  'cost_allowance_cents',CASE WHEN count(*) FILTER(WHERE r->>'cost_allowance_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'cost_allowance_cents')::bigint),0) END,
  'transport_cents',CASE WHEN count(*) FILTER(WHERE r->>'transport_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'transport_cents')::bigint),0) END,
  'advance_cents',CASE WHEN count(*) FILTER(WHERE r->>'advance_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'advance_cents')::bigint),0) END,
  'reported_total_cents',CASE WHEN count(*) FILTER(WHERE r->>'reported_total_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'reported_total_cents')::bigint),0) END,
  'total_cents',CASE WHEN count(*) FILTER(WHERE r->>'total_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'total_cents')::bigint),0) END,
  'compensation_groups_version',v_compensation_version,'total_formula_version',v_formula_version,'total_formula_caption',v_formula_caption),
  jsonb_build_object('missing_admission',count(*) FILTER(WHERE r->>'admitted_on' IS NULL),'missing_birthday',count(*) FILTER(WHERE r->>'birthday_on' IS NULL),
  'missing_branch',count(*) FILTER(WHERE r->>'branch'=''),'missing_sector',count(*) FILTER(WHERE r->>'sector'=''),
  'missing_salary_base',count(*) FILTER(WHERE r->>'salary_base_cents' IS NULL),'missing_payroll_salary',count(*) FILTER(WHERE r->>'payroll_salary_cents' IS NULL),
  'missing_cost_allowance',count(*) FILTER(WHERE r->>'cost_allowance_cents' IS NULL),
  'missing_transport',count(*) FILTER(WHERE r->>'transport_cents' IS NULL),'missing_advance',count(*) FILTER(WHERE r->>'advance_cents' IS NULL),'missing_total',count(*) FILTER(WHERE r->>'total_cents' IS NULL))
 INTO v_summary,v_quality FROM jsonb_array_elements(v_rows)r;
 SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.count DESC,g.label),'[]') INTO v_by_branch FROM(
  SELECT coalesce(nullif(r->>'branch',''),'NÃO INFORMADO') AS label,count(*) AS count,
   count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean) AS employee_count,count(*) FILTER(WHERE (r->>'is_partner')::boolean) AS partner_count,
   CASE WHEN count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean AND r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint) FILTER(WHERE NOT(r->>'is_partner')::boolean),0) END AS salary_base_cents,
   CASE WHEN count(*) FILTER(WHERE (r->>'is_partner')::boolean AND r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint) FILTER(WHERE (r->>'is_partner')::boolean),0) END AS prolabore_base_cents
  FROM jsonb_array_elements(v_rows)r GROUP BY 1)g;
 SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.count DESC,g.label),'[]') INTO v_by_sector FROM(
  SELECT coalesce(nullif(r->>'sector',''),'NÃO INFORMADO') AS label,count(*) AS count,
   count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean) AS employee_count,count(*) FILTER(WHERE (r->>'is_partner')::boolean) AS partner_count,
   CASE WHEN count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean AND r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint) FILTER(WHERE NOT(r->>'is_partner')::boolean),0) END AS salary_base_cents,
   CASE WHEN count(*) FILTER(WHERE (r->>'is_partner')::boolean AND r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint) FILTER(WHERE (r->>'is_partner')::boolean),0) END AS prolabore_base_cents
  FROM jsonb_array_elements(v_rows)r GROUP BY 1)g;
 SELECT coalesce(jsonb_agg(r||jsonb_build_object('day',extract(day FROM (r->>'birthday_on')::date)::integer)
  ORDER BY extract(day FROM (r->>'birthday_on')::date),r->>'employee'),'[]') INTO v_birthdays FROM jsonb_array_elements(v_rows)r
  WHERE extract(month FROM (r->>'birthday_on')::date)=extract(month FROM p_month);
 SELECT coalesce(jsonb_agg(r||jsonb_build_object('day',extract(day FROM (r->>'admitted_on')::date)::integer,'years',extract(year FROM p_month)::integer-extract(year FROM (r->>'admitted_on')::date)::integer)
  ORDER BY extract(day FROM (r->>'admitted_on')::date),r->>'employee'),'[]') INTO v_anniversaries FROM jsonb_array_elements(v_rows)r
  WHERE extract(month FROM (r->>'admitted_on')::date)=extract(month FROM p_month) AND extract(year FROM p_month)>extract(year FROM (r->>'admitted_on')::date);
 RETURN jsonb_build_object('compensation_groups_version',v_compensation_version,'total_formula_version',v_formula_version,'total_formula_caption',v_formula_caption,'calendar_month',p_month,'summary',v_summary,'quality',v_quality,'by_branch',v_by_branch,'by_sector',v_by_sector,'birthdays',v_birthdays,'work_anniversaries',v_anniversaries,'rows',v_rows);
END $$;

CREATE OR REPLACE FUNCTION cf_private.hr_sheet_statistics(p_rows jsonb,p_month date,p_report_totals jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$ DECLARE v_report jsonb;v_summary jsonb;v_footer jsonb;BEGIN
 v_footer:=cf_private.hr_sheet_totals(p_rows,p_report_totals);
 v_report:=cf_private.hr_statistics(p_rows,p_month);
 v_summary:=(v_report->'summary')||jsonb_build_object('report_totals',v_footer);
 RETURN v_report||jsonb_build_object('report_totals',v_footer,'summary',v_summary);
END $$;

CREATE OR REPLACE FUNCTION public.hr_report(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_import cf_private.hr_imports%ROWTYPE;v_report jsonb;BEGIN
 IF NOT cf_private.has_permission('rh_dp','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_month IS NULL OR p_month NOT BETWEEN DATE '1900-01-01' AND DATE '2199-12-01' OR extract(day FROM p_month)<>1 THEN RAISE EXCEPTION 'Selecione o mês de referência.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_import FROM cf_private.hr_imports ORDER BY reference_date DESC,imported_at DESC,id DESC LIMIT 1;
 v_report:=cf_private.hr_sheet_statistics(coalesce(v_import.rows,'[]'::jsonb),p_month,v_import.report_totals);
 RETURN v_report||jsonb_build_object('snapshot',CASE WHEN v_import.id IS NULL THEN NULL ELSE jsonb_build_object('id',v_import.id,'reference_date',v_import.reference_date,
  'format_version',v_import.format_version,'file_name',v_import.file_name,'sha256',v_import.file_sha256,'imported_at',v_import.imported_at,'row_count',v_import.row_count) END);
END $$;

CREATE OR REPLACE FUNCTION public.preview_hr_sheet_import(p_rows jsonb,p_reference_date date,p_report_totals jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_previous uuid;v_result jsonb;BEGIN
 PERFORM cf_private.require_hr_import();
 IF p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01' OR p_reference_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
  RAISE EXCEPTION 'Informe a data da posição até hoje em São Paulo.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.hr_report_rows(p_rows);
 SELECT id INTO v_previous FROM cf_private.hr_imports ORDER BY reference_date DESC,imported_at DESC,id DESC LIMIT 1;
 v_result:=cf_private.hr_sheet_statistics(p_rows,date_trunc('month',p_reference_date)::date,p_report_totals);
 RETURN jsonb_build_object('row_count',jsonb_array_length(p_rows),'previous_import_id',v_previous,'summary',v_result->'summary','quality',v_result->'quality','rows',v_result->'rows','report_totals',v_result->'report_totals');
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
 IF EXISTS(SELECT 1 FROM cf_private.hr_imports WHERE format_version IN(2,3,4)) THEN
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
 IF EXISTS(SELECT 1 FROM cf_private.hr_imports WHERE format_version IN(3,4)) THEN
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

CREATE OR REPLACE FUNCTION public.commit_hr_total_import_from_gateway(p_user_id uuid,p_session_id text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_reference_date date,p_previous_import_id uuid) RETURNS jsonb
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
 IF EXISTS(SELECT 1 FROM cf_private.hr_imports WHERE format_version=4) THEN
  RAISE EXCEPTION 'O modelo de RH/DP foi atualizado. Atualize a função de importação e analise o arquivo novamente.' USING ERRCODE='40001';END IF;
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

CREATE OR REPLACE FUNCTION public.commit_hr_sheet_import_from_gateway(p_user_id uuid,p_session_id text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_reference_date date,p_previous_import_id uuid,p_report_totals jsonb DEFAULT NULL) RETURNS jsonb
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
 v_preview:=public.preview_hr_sheet_import(p_rows,p_reference_date,p_report_totals);
 SELECT * INTO v_import FROM cf_private.hr_imports WHERE reference_date=p_reference_date AND file_sha256=p_file_sha256 AND format_version=4;
 IF FOUND THEN
  IF v_import.rows<>p_rows OR v_import.report_totals IS DISTINCT FROM p_report_totals THEN RAISE EXCEPTION 'O mesmo original não corresponde aos registros preparados.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('import_id',v_import.id,'row_count',v_import.row_count,'idempotent',true);END IF;
 v_previous:=(v_preview->>'previous_import_id')::uuid;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN RAISE EXCEPTION 'A base de RH/DP mudou. Analise novamente antes de importar.' USING ERRCODE='40001';END IF;
 INSERT INTO cf_private.hr_imports(reference_date,file_name,file_sha256,original_bytes,rows,row_count,created_by,format_version,report_totals)
 VALUES(p_reference_date,p_file_name,p_file_sha256,v_bytes,p_rows,jsonb_array_length(p_rows),p_user_id,4,p_report_totals) RETURNING * INTO v_import;
 SELECT * INTO v_actor FROM public.profiles WHERE id=p_user_id;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'rh_dp','hr_imports',v_import.id::text,'IMPORT',CASE WHEN v_previous IS NULL THEN NULL ELSE jsonb_build_object('import_id',v_previous) END,
  jsonb_build_object('reference_date',p_reference_date,'file_name',p_file_name,'file_sha256',p_file_sha256,'row_count',v_import.row_count,'summary',v_preview->'summary','policy_version','v75-rh-cesta-11280','format_version',4,'report_totals',p_report_totals));
 RETURN jsonb_build_object('import_id',v_import.id,'row_count',v_import.row_count,'idempotent',false);
END $$;

REVOKE ALL ON FUNCTION cf_private.hr_sheet_totals(jsonb,jsonb),cf_private.hr_sheet_statistics(jsonb,date,jsonb),
 public.preview_hr_sheet_import(jsonb,date,jsonb),public.commit_hr_sheet_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_hr_sheet_import(jsonb,date,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_hr_sheet_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid,jsonb) TO service_role;

INSERT INTO public.central_schema_migrations(version) VALUES('038_hr_sheet_totals') ON CONFLICT(version) DO NOTHING;
COMMIT;
