-- Comissões: regras com vigência, cálculo exato e apurações imutáveis.
-- Não gera pagamentos de comissão, não importa bases históricas nem vincula nomes a usuários.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='031_director_readonly')
 OR to_regclass('cf_private.commission_sales_source') IS NULL THEN
  RAISE EXCEPTION 'Ative primeiro o acesso 031 e o fechamento comercial 032.' USING ERRCODE='22023';END IF;
END $$;
CREATE TABLE public.commission_rule_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN ('COLLECTOR','SELLER')),
 subject text NOT NULL DEFAULT '' CHECK(length(subject)<=500),effective_from date NOT NULL CHECK(effective_from BETWEEN DATE '1900-01-01' AND DATE '2199-12-31'),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='COLLECTOR' AND subject='') OR (kind='SELLER' AND length(subject)>0))
);
CREATE INDEX commission_rules_effective ON public.commission_rule_versions(kind,subject,effective_from DESC,created_at DESC,id DESC);
CREATE TABLE public.commission_assessments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN ('COLLECTOR','SELLER')),
 period_start date NOT NULL,period_end date NOT NULL,subject text,band text,revision text NOT NULL,
 report jsonb NOT NULL CHECK(jsonb_typeof(report)='object'),created_by uuid NOT NULL REFERENCES public.profiles(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(kind,revision),CHECK(period_end>=period_start)
);
DO $$ DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['commission_rule_versions','commission_assessments'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',n);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes()',n||'_immutable',n);
END LOOP;END $$;
CREATE FUNCTION cf_private.require_commissions(p_write boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('comissoes',CASE WHEN p_write THEN 'write' ELSE 'read' END)
 OR (p_write AND NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND enabled AND role_key='gerente_geral')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION cf_private.commission_collector_bands() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT '[
 {"band":"ATE_30","label":"1–30 dias","reference_cents":0,"commission_reference_cents":0},
 {"band":"31_60","label":"31–60 dias","reference_cents":20000000,"commission_reference_cents":10000},
 {"band":"61_90","label":"61–90 dias","reference_cents":10000000,"commission_reference_cents":30000},
 {"band":"91_180","label":"91–180 dias","reference_cents":10000000,"commission_reference_cents":60000},
 {"band":"181_365","label":"181–365 dias","reference_cents":8000000,"commission_reference_cents":100000},
 {"band":"ACIMA_365","label":">365 dias","reference_cents":3500000,"commission_reference_cents":150000}]'::jsonb $$;
CREATE FUNCTION public.configure_commission_rule(p_kind text,p_effective_from date,p_subject text,p_config jsonb,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;v_config jsonb;v_ids jsonb;v_min integer;v_policy text;v_subject text:=btrim(coalesce(p_subject,''));BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM cf_private.require_commissions(true);PERFORM pg_advisory_xact_lock(2045812334);
 IF p_kind IS NULL OR p_kind NOT IN ('COLLECTOR','SELLER') OR p_effective_from IS NULL OR p_effective_from NOT BETWEEN DATE '1900-01-01' AND DATE '2199-12-31'
 OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 2000 OR jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Informe regra, vigência e justificativa válidas.' USING ERRCODE='22023';END IF;
 IF p_kind='COLLECTOR' THEN
  IF v_subject<>'' OR jsonb_typeof(p_config->'eligible_collector_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p_config->'eligible_collector_ids')>1000
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_config->'eligible_collector_ids') x WHERE jsonb_typeof(x)<>'string' OR x#>>'{}' !~ '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_config) k WHERE k<>'eligible_collector_ids') THEN
   RAISE EXCEPTION 'Selecione as cobradoras que participam da apuração.' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_config->'eligible_collector_ids') x WHERE NOT EXISTS(SELECT 1 FROM public.collection_agents a WHERE a.id=x::uuid AND a.enabled)) THEN
   RAISE EXCEPTION 'Cobradora não encontrada ou inativa.' USING ERRCODE='22023';END IF;
  SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO v_ids FROM(SELECT DISTINCT x::uuid AS id FROM jsonb_array_elements_text(p_config->'eligible_collector_ids') x) s;
  v_config:=jsonb_build_object('eligible_collector_ids',v_ids,'bands',cf_private.commission_collector_bands(),'rounding','HALF_UP_PER_RECEIPT');
 ELSE
  v_policy:=p_config->>'policy';
  IF length(v_subject) NOT BETWEEN 1 AND 500 OR v_policy IS NULL OR v_policy NOT IN ('COMMERCIAL','LARGE_ACCOUNTS','MATEUS','KEVYN','FRANCISCO','NONE')
   OR NOT coalesce(p_config->>'minimum_margin_bps' ~ '^\d{1,5}$',false) OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_config) k WHERE k NOT IN ('policy','minimum_margin_bps')) THEN
   RAISE EXCEPTION 'Selecione funcionário, política e margem mínima em pontos-base.' USING ERRCODE='22023';END IF;
  v_min:=(p_config->>'minimum_margin_bps')::integer;
  IF v_min NOT BETWEEN 0 AND 10000 OR (v_policy IN ('COMMERCIAL','LARGE_ACCOUNTS','FRANCISCO') AND v_min<>1000)
   OR NOT EXISTS(SELECT 1 FROM cf_private.commission_sales_source WHERE employee=v_subject) THEN
   RAISE EXCEPTION 'Funcionário ou margem mínima inválidos para a política.' USING ERRCODE='22023';END IF;
  v_config:=jsonb_build_object('policy',v_policy,'minimum_margin_bps',v_min,'catalog_version','V75_WITH_CONFIRMED_MINIMUM','rounding','HALF_UP_PER_ITEM');
 END IF;
 INSERT INTO public.commission_rule_versions(kind,subject,effective_from,config,reason,created_by)
 VALUES(p_kind,v_subject,p_effective_from,v_config,btrim(p_reason),auth.uid()) RETURNING id INTO v_id;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
 SELECT id,username,role_key,'comissoes','commission_rule_versions',v_id::text,'CREATE',jsonb_build_object('kind',p_kind,'subject',v_subject,'effective_from',p_effective_from,'config',v_config,'reason',btrim(p_reason))
 FROM public.profiles WHERE id=auth.uid();RETURN v_id;
END $$;
-- Vínculo explícito do funcionário importado às regras confirmadas em 19/10/2026.
-- Repetir a recuperação preserva configurações já existentes nas mesmas vigências.
CREATE FUNCTION public.restore_seller_commission_policy(p_subject text,p_policy text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_subject text:=btrim(coalesce(p_subject,''));v_effective date;v_min integer;v_id uuid;v_ids jsonb:='[]'::jsonb;v_created integer:=0;BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM cf_private.require_commissions(true);PERFORM pg_advisory_xact_lock(2045812334);
 IF p_policy IS NULL OR p_policy NOT IN ('COMMERCIAL','LARGE_ACCOUNTS','MATEUS','KEVYN','FRANCISCO','NONE')
 OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 2000 OR NOT EXISTS(SELECT 1 FROM cf_private.commission_sales_source WHERE employee=v_subject) THEN
  RAISE EXCEPTION 'Selecione funcionário importado, política e justificativa.' USING ERRCODE='22023';END IF;
 FOR v_effective IN SELECT unnest(CASE WHEN p_policy IN ('MATEUS','KEVYN') THEN ARRAY[DATE '2026-09-01',DATE '2026-10-01'] ELSE ARRAY[DATE '2026-09-01'] END) LOOP
  SELECT id INTO v_id FROM public.commission_rule_versions WHERE kind='SELLER' AND subject=v_subject AND effective_from=v_effective ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_id IS NULL THEN
   v_min:=CASE WHEN p_policy='NONE' THEN 0 WHEN p_policy IN ('MATEUS','KEVYN') AND v_effective>=DATE '2026-10-01' THEN 1400 ELSE 1000 END;
   v_id:=public.configure_commission_rule('SELLER',v_effective,v_subject,jsonb_build_object('policy',p_policy,'minimum_margin_bps',v_min),btrim(p_reason));v_created:=v_created+1;
  END IF;
  v_ids:=v_ids||jsonb_build_array(v_id);
 END LOOP;
 RETURN jsonb_build_object('rule_ids',v_ids,'created_count',v_created,'subject',v_subject);
END $$;
CREATE FUNCTION cf_private.collector_commission_rows(p_start date,p_end date,p_subject text) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('id',r.id,'source_revision',r.receipt_revision::text,'title_id',t.id,'date',r.payment_date,
 'document',t.document,'client_name',t.client_name,'branch',t.branch,'due_date',coalesce(r.original_due_date,t.due_date),
 'subject',r.collector_id,'subject_name',coalesce(a.display_name,'Responsável pendente'),'amount_cents',r.amount_cents,
 'nominal_amount_cents',r.nominal_amount_cents,'delay_days',r.delay_days,'band',r.delay_band,'rule_id',v.id,'rule_effective_from',v.effective_from,'rule_config',v.config,
 'eligibility',CASE WHEN r.collector_id IS NULL THEN 'PENDING_OWNER' WHEN v.id IS NULL THEN 'PENDING_RULE'
  WHEN NOT (v.config->'eligible_collector_ids' @> jsonb_build_array(r.collector_id)) THEN 'NOT_ELIGIBLE'
  WHEN r.delay_days<=30 THEN 'NO_COMMISSION' ELSE 'ASSESSED' END,
 'commission_cents',CASE WHEN r.collector_id IS NULL OR v.id IS NULL THEN NULL
  WHEN NOT (v.config->'eligible_collector_ids' @> jsonb_build_array(r.collector_id)) OR r.delay_days<=30 THEN 0
  ELSE round(r.amount_cents::numeric*(b->>'commission_reference_cents')::numeric/nullif((b->>'reference_cents')::numeric,0)) END,
 'rate_numerator',coalesce((b->>'commission_reference_cents')::bigint,0),'rate_denominator',coalesce((b->>'reference_cents')::bigint,0),
 'payment_source',r.payment_source)
 FROM public.effective_receivable_receipts r JOIN public.receivable_titles t ON t.id=r.title_id
 LEFT JOIN public.collection_agents a ON a.id=r.collector_id
 LEFT JOIN LATERAL(SELECT * FROM public.commission_rule_versions WHERE kind='COLLECTOR' AND subject='' AND effective_from<=r.payment_date ORDER BY effective_from DESC,created_at DESC,id DESC LIMIT 1) v ON true
 LEFT JOIN LATERAL(SELECT x AS b FROM jsonb_array_elements(v.config->'bands') x WHERE x->>'band'=r.delay_band) bands ON true
 WHERE r.validation='VALIDADO' AND t.status='VALIDATED' AND r.payment_date BETWEEN p_start AND p_end
 AND (p_subject IS NULL OR r.collector_id::text=p_subject)
 AND (r.reported_in_collection OR EXISTS(SELECT 1 FROM public.collection_work_sessions w WHERE w.title_id=t.id AND w.started_at<=r.validated_at)
  OR EXISTS(SELECT 1 FROM public.receivable_collection_events e WHERE e.title_id=t.id AND e.created_at<=r.validated_at AND e.action IN ('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','OTHER','NOT_LOCATED_CONTACT')))
$$;
-- A faixa do vendedor usa a margem depois da própria comissão, como na V75.
-- Quando nenhuma taxa resolve a faixa de modo consistente, a linha fica pendente.
CREATE FUNCTION cf_private.seller_commission_calculation(p_sale bigint,p_cost bigint,p_freight bigint,p_tax bigint,p_policy text,p_min integer,p_client text,p_center text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_base numeric:=p_sale::numeric-p_cost-p_freight-p_tax;v_policy text:=p_policy;v_rate integer;v_expected integer;v_comm numeric;v_margin numeric;v_bps numeric;v_candidate integer;v_found boolean:=false;v_fixed boolean:=false;v_center text:=lower(coalesce(p_center,''));v_client text:=lower(coalesce(p_client,''));BEGIN
 IF p_cost IS NULL OR p_freight IS NULL OR p_tax IS NULL THEN RETURN jsonb_build_object('eligibility','MISSING_COSTS','commission_cents',NULL,'margin_cents',NULL,'margin_bps',NULL,'rate_bps',NULL);END IF;
 IF p_sale IS NULL OR p_sale<=0 THEN RETURN jsonb_build_object('eligibility','INVALID_SALE','commission_cents',NULL,'margin_cents',NULL,'margin_bps',NULL,'rate_bps',NULL);END IF;
 IF v_policy='FRANCISCO' THEN
  IF v_center LIKE '%grandes contas%francisco%' OR v_center LIKE '%grandes contas%wellington%' THEN v_policy:='LARGE_ACCOUNTS';
  ELSIF v_center LIKE '%privado%' THEN v_policy:='COMMERCIAL';ELSE v_policy:='NONE';END IF;
 END IF;
 IF v_policy='MATEUS' AND (v_client LIKE '%comlurb%' OR v_client LIKE '%companhia municipal de limpeza urbana%') THEN v_rate:=30;v_fixed:=true;v_found:=true;
 ELSIF v_policy='NONE' THEN v_rate:=0;v_fixed:=true;v_found:=true;
 END IF;
 IF NOT v_fixed THEN
  FOREACH v_candidate IN ARRAY CASE WHEN v_policy='COMMERCIAL' THEN ARRAY[0,50,100,150,200,250] WHEN v_policy IN ('LARGE_ACCOUNTS','MATEUS') THEN ARRAY[0,40,60,80,100] WHEN v_policy='KEVYN' THEN ARRAY[0,40] ELSE ARRAY[]::integer[] END LOOP
   v_comm:=round(p_sale::numeric*v_candidate/10000);v_bps:=(v_base-v_comm)*10000/p_sale;
   IF v_policy='COMMERCIAL' THEN v_expected:=CASE WHEN v_bps<1000 THEN 0 WHEN v_bps<=1500 THEN 50 WHEN v_bps<=2000 THEN 100 WHEN v_bps<=2500 THEN 150 WHEN v_bps<=3000 THEN 200 ELSE 250 END;
   ELSIF v_policy IN ('LARGE_ACCOUNTS','MATEUS') THEN v_expected:=CASE WHEN v_bps<p_min THEN 0 WHEN v_bps<1700 THEN 40 WHEN v_bps<=3000 THEN 60 WHEN v_bps<=3500 THEN 80 ELSE 100 END;
   ELSE v_expected:=CASE WHEN v_bps>=p_min THEN 40 ELSE 0 END;END IF;
   IF v_expected=v_candidate THEN v_rate:=v_candidate;v_found:=true;EXIT;END IF;
  END LOOP;
 END IF;
 IF NOT v_found THEN RETURN jsonb_build_object('eligibility','RATE_BOUNDARY','commission_cents',NULL,'margin_cents',NULL,'margin_bps',NULL,'rate_bps',NULL);END IF;
 v_comm:=round(p_sale::numeric*v_rate/10000);v_margin:=v_base-v_comm;
 IF greatest(abs(v_comm),abs(v_margin))>9007199254740991 THEN RAISE EXCEPTION 'Comissão ou margem excede o limite de precisão.' USING ERRCODE='22003';END IF;
 RETURN jsonb_build_object('eligibility',CASE WHEN v_rate=0 THEN 'NO_COMMISSION' ELSE 'ASSESSED' END,'commission_cents',v_comm,'margin_cents',v_margin,'margin_bps',round(v_margin*10000/p_sale,4),'rate_bps',v_rate);
END $$;
CREATE FUNCTION cf_private.seller_commission_rows(p_start date,p_end date,p_subject text) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('id',s.id,'source_revision',s.source_revision,'date',s.emission_date,'document',s.invoice,'client_name',s.client_name,'branch',s.branch,
 'product',s.product,'cost_center',s.cost_center,'subject',s.employee,'subject_name',s.employee,'amount_cents',s.sale_cents,'rule_id',v.id,'rule_effective_from',v.effective_from,'rule_config',v.config,
 'policy',v.config->>'policy','cost_cents',s.cmv_cents,'freight_cents',s.freight_cents,'tax_cents',s.tax_cents,
 'eligibility',CASE WHEN v.id IS NULL THEN 'PENDING_RULE' ELSE c->>'eligibility' END,
 'band',CASE WHEN c->>'margin_bps' IS NULL THEN NULL WHEN (c->>'margin_bps')::numeric<1000 THEN 'LT10' WHEN (c->>'margin_bps')::numeric<=1500 THEN '10_15'
  WHEN (c->>'margin_bps')::numeric<=2000 THEN '15_20' WHEN (c->>'margin_bps')::numeric<=2500 THEN '20_25' WHEN (c->>'margin_bps')::numeric<=3000 THEN '25_30'
  WHEN (c->>'margin_bps')::numeric<=3500 THEN '30_35' ELSE 'GT35' END)
 || CASE WHEN v.id IS NULL THEN jsonb_build_object('commission_cents',NULL,'margin_cents',NULL,'margin_bps',NULL,'rate_bps',NULL) ELSE c END
 FROM cf_private.commission_sales_source s
 LEFT JOIN LATERAL(SELECT * FROM public.commission_rule_versions WHERE kind='SELLER' AND subject=s.employee AND effective_from<=s.emission_date ORDER BY effective_from DESC,created_at DESC,id DESC LIMIT 1) v ON true
 LEFT JOIN LATERAL(SELECT cf_private.seller_commission_calculation(s.sale_cents,s.cmv_cents,s.freight_cents,s.tax_cents,v.config->>'policy',(v.config->>'minimum_margin_bps')::integer,s.client_name,s.cost_center) AS c WHERE v.id IS NOT NULL) calc ON true
 WHERE s.emission_date BETWEEN p_start AND p_end AND (p_subject IS NULL OR s.employee=p_subject)
$$;
CREATE FUNCTION public.commissions_report(p_kind text,p_start date,p_end date,p_subject text DEFAULT NULL,p_band text DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_role text;v_subject text:=nullif(btrim(p_subject),'');v_rows jsonb;v_page jsonb;v_count bigint;v_total numeric;v_comm numeric;v_eligible numeric;v_pending bigint;v_margin numeric;v_assessed bigint;v_avg numeric;v_summaries jsonb;v_bands jsonb;v_options jsonb;v_versions jsonb;v_snapshots jsonb;v_revision text;BEGIN
 PERFORM cf_private.require_commissions(false);
 IF p_kind IS NULL OR p_kind NOT IN ('COLLECTOR','SELLER') OR p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end>DATE '2199-12-31' OR p_end<p_start OR p_end-p_start>3660
 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 OR length(coalesce(p_subject,''))>500
 OR (p_band IS NOT NULL AND p_band NOT IN ('ATE_30','31_60','61_90','91_180','181_365','ACIMA_365','LT10','10_15','15_20','20_25','25_30','30_35','GT35')) THEN
  RAISE EXCEPTION 'Informe tipo, período e filtros válidos.' USING ERRCODE='22023';END IF;
 SELECT role_key INTO v_role FROM public.profiles WHERE id=auth.uid() AND enabled;
 IF v_role IN ('cobradora_1','cobradora_2') THEN
  IF p_kind<>'COLLECTOR' OR cf_private.current_collector_id() IS NULL OR (v_subject IS NOT NULL AND v_subject<>cf_private.current_collector_id()::text) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
  v_subject:=cf_private.current_collector_id()::text;
 END IF;
 IF p_kind='COLLECTOR' THEN
  IF v_subject IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id::text=v_subject) THEN RAISE EXCEPTION 'Cobradora inválida.' USING ERRCODE='22023';END IF;
  SELECT coalesce(jsonb_agg(r ORDER BY r->>'date' DESC,r->>'id'),'[]'::jsonb) INTO v_rows FROM cf_private.collector_commission_rows(p_start,p_end,v_subject) r WHERE p_band IS NULL OR r->>'band'=p_band;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',display_name,'enabled',enabled) ORDER BY display_name,id),'[]'::jsonb) INTO v_options FROM public.collection_agents WHERE v_role NOT IN ('cobradora_1','cobradora_2') OR id::text=v_subject;
 ELSE
  SELECT coalesce(jsonb_agg(r ORDER BY r->>'date' DESC,r->>'id'),'[]'::jsonb) INTO v_rows FROM cf_private.seller_commission_rows(p_start,p_end,v_subject) r WHERE p_band IS NULL OR r->>'band'=p_band;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',employee,'name',employee,'enabled',true) ORDER BY employee),'[]'::jsonb) INTO v_options FROM(SELECT DISTINCT employee FROM cf_private.commission_sales_source WHERE employee<>'') s;
 END IF;
 SELECT count(*),coalesce(sum((r->>'amount_cents')::numeric),0),coalesce(sum((r->>'commission_cents')::numeric),0),
 coalesce(sum((r->>'amount_cents')::numeric) FILTER(WHERE r->>'eligibility' IN ('ASSESSED','NO_COMMISSION')),0),
 count(*) FILTER(WHERE r->>'commission_cents' IS NULL),coalesce(sum((r->>'margin_cents')::numeric),0),
 count(*) FILTER(WHERE r->>'eligibility'='ASSESSED'),coalesce(round(avg((r->>'delay_days')::numeric),1),0)
 INTO v_count,v_total,v_comm,v_eligible,v_pending,v_margin,v_assessed,v_avg FROM jsonb_array_elements(v_rows) r;
 IF greatest(abs(v_total),abs(v_comm),abs(v_eligible),abs(v_margin))>9007199254740991 THEN RAISE EXCEPTION 'O consolidado excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO v_page FROM(SELECT r FROM jsonb_array_elements(v_rows) WITH ORDINALITY s(r,ord) ORDER BY ord OFFSET p_offset LIMIT p_limit) p;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY subject_name,subject),'[]'::jsonb) INTO v_summaries FROM(
 SELECT r->>'subject' AS subject,r->>'subject_name' AS subject_name,count(*) AS count,sum((r->>'amount_cents')::numeric) AS amount_cents,
 sum((r->>'commission_cents')::numeric) AS commission_cents,sum((r->>'margin_cents')::numeric) AS margin_cents,
 count(*) FILTER(WHERE r->>'commission_cents' IS NULL) AS pending_count FROM jsonb_array_elements(v_rows) r GROUP BY r->>'subject',r->>'subject_name') s;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY band),'[]'::jsonb) INTO v_bands FROM(
 SELECT r->>'band' AS band,count(*) AS count,sum((r->>'amount_cents')::numeric) AS amount_cents,sum((r->>'commission_cents')::numeric) AS commission_cents,
 count(*) FILTER(WHERE r->>'commission_cents' IS NULL) AS pending_count FROM jsonb_array_elements(v_rows) r GROUP BY r->>'band') s;
 SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY effective_from DESC,created_at DESC,id DESC),'[]'::jsonb) INTO v_versions FROM(
 SELECT id,kind,subject,effective_from,config,reason,created_at FROM public.commission_rule_versions WHERE kind=p_kind AND (p_kind='COLLECTOR' OR v_subject IS NULL OR subject=v_subject) ORDER BY effective_from DESC,created_at DESC,id DESC LIMIT 1000) v;
 v_revision:=md5(jsonb_build_object('kind',p_kind,'start',p_start,'end',p_end,'subject',v_subject,'band',p_band,'rows',v_rows)::text);
 SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO v_snapshots FROM(
 SELECT id,kind,period_start,period_end,subject,band,revision,created_at FROM public.commission_assessments WHERE kind=p_kind
 AND (v_role NOT IN ('cobradora_1','cobradora_2') OR subject=v_subject) ORDER BY created_at DESC,id DESC LIMIT 50) a;
 RETURN jsonb_build_object('kind',p_kind,'start',p_start,'end',p_end,'subject',v_subject,'band',p_band,'rows',v_page,'count',v_count,
 'total_amount_cents',v_total,'eligible_amount_cents',v_eligible,'commission_cents',v_comm,'margin_cents',v_margin,'pending_count',v_pending,
 'assessed_count',v_assessed,'average_delay_days',v_avg,'summaries',v_summaries,'bands',v_bands,'options',v_options,'rule_versions',v_versions,
 'collector_bands',cf_private.commission_collector_bands(),'revision',v_revision,'assessments',v_snapshots,'complete',v_pending=0);
END $$;
CREATE FUNCTION public.save_commission_assessment(p_kind text,p_start date,p_end date,p_subject text,p_band text,p_expected_revision text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_report jsonb;v_id uuid;BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);PERFORM cf_private.require_commissions(true);PERFORM pg_advisory_xact_lock(2045812334);
 -- Fence imports/receipts and their revisions while persisting the assessed basis.
 LOCK TABLE public.receivable_titles,public.collection_agents,public.receivable_collection_events,public.collection_work_sessions,public.receivable_receipts,public.receivable_receipt_adjustments,public.commission_rule_versions,public.commercial_imports,public.commercial_items IN SHARE MODE;
 v_report:=public.commissions_report(p_kind,p_start,p_end,p_subject,p_band,0,5000);
 IF p_expected_revision IS NULL OR v_report->>'revision'<>p_expected_revision THEN RAISE EXCEPTION 'A base ou a regra mudou. Atualize antes de salvar a apuração.' USING ERRCODE='40001';END IF;
 IF (v_report->>'count')::bigint=0 OR (v_report->>'count')::bigint>5000 OR NOT (v_report->>'complete')::boolean THEN
  RAISE EXCEPTION 'Resolva as regras pendentes e escolha um período com até 5.000 itens antes de salvar.' USING ERRCODE='22023';END IF;
 SELECT id INTO v_id FROM public.commission_assessments WHERE kind=p_kind AND revision=p_expected_revision;
 IF v_id IS NOT NULL THEN RETURN v_id;END IF;
 INSERT INTO public.commission_assessments(kind,period_start,period_end,subject,band,revision,report,created_by)
 VALUES(p_kind,p_start,p_end,nullif(btrim(p_subject),''),p_band,p_expected_revision,v_report-'assessments',auth.uid()) RETURNING id INTO v_id;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
 SELECT id,username,role_key,'comissoes','commission_assessments',v_id::text,'CREATE',jsonb_build_object('kind',p_kind,'start',p_start,'end',p_end,'revision',p_expected_revision,'commission_cents',v_report->'commission_cents') FROM public.profiles WHERE id=auth.uid();RETURN v_id;
END $$;
CREATE FUNCTION public.commission_assessment(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_saved public.commission_assessments%ROWTYPE;v_role text;BEGIN
 PERFORM cf_private.require_commissions(false);SELECT role_key INTO v_role FROM public.profiles WHERE id=auth.uid() AND enabled;
 SELECT * INTO v_saved FROM public.commission_assessments WHERE id=p_id;
 IF v_saved.id IS NULL OR (v_role IN ('cobradora_1','cobradora_2') AND (v_saved.kind<>'COLLECTOR' OR v_saved.subject IS DISTINCT FROM cf_private.current_collector_id()::text)) THEN
  RAISE EXCEPTION 'Apuração não encontrada ou acesso não autorizado.' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('id',v_saved.id,'created_at',v_saved.created_at,'report',v_saved.report);
END $$;
REVOKE ALL ON FUNCTION cf_private.require_commissions(boolean),cf_private.commission_collector_bands(),cf_private.collector_commission_rows(date,date,text),
 cf_private.seller_commission_calculation(bigint,bigint,bigint,bigint,text,integer,text,text),cf_private.seller_commission_rows(date,date,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.configure_commission_rule(text,date,text,jsonb,text),public.restore_seller_commission_policy(text,text,text),public.commissions_report(text,date,date,text,text,integer,integer),public.save_commission_assessment(text,date,date,text,text,text),public.commission_assessment(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.configure_commission_rule(text,date,text,jsonb,text),public.restore_seller_commission_policy(text,text,text),public.commissions_report(text,date,date,text,text,integer,integer),public.save_commission_assessment(text,date,date,text,text,text),public.commission_assessment(uuid) TO authenticated;
INSERT INTO public.central_schema_migrations(version) VALUES('034_commissions');
COMMIT;
