-- RH/DP: salários de colaboradores e pró-labores de sócios separados na leitura.
-- A classificação deriva do setor SÓCIO existente. Não altera originais, posições ou a fórmula numérica do Total.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='036_hr_total') THEN
  RAISE EXCEPTION 'Ative a atualização 036 de RH/DP antes da separação dos pró-labores.' USING ERRCODE='22023';END IF;
END $$;

CREATE OR REPLACE FUNCTION cf_private.hr_statistics(p_rows jsonb,p_month date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_rows jsonb;v_summary jsonb;v_quality jsonb;v_by_branch jsonb;v_by_sector jsonb;v_birthdays jsonb;v_anniversaries jsonb;
 v_formula_version constant text:='rh-five-fields-v1';
 v_compensation_version constant text:='rh-compensation-groups-v1';
 v_formula_caption constant text:='Total = remuneração sem descontos + VT total + remuneração recebida + Adiantamento + Ajuda de Custo';
BEGIN
 SELECT coalesce(jsonb_agg(r||jsonb_build_object('is_partner',cf_private.hr_normalize(r->>'sector')='SOCIO',
  'compensation_kind',CASE WHEN cf_private.hr_normalize(r->>'sector')='SOCIO' THEN 'prolabore' ELSE 'salary' END,
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

-- CREATE OR REPLACE preserva os privilégios privados, sem publicar remunerações nem criar RPCs.
INSERT INTO public.central_schema_migrations(version) VALUES('037_hr_prolabore') ON CONFLICT(version) DO NOTHING;
COMMIT;
