-- CENTRAL FINANCEIRA — Comissões, Faturamento, Margens e RH / DP.
-- Arquivo SQL: executar inteiro no SQL Editor do projeto existente.
-- Uma transação, repetível por versão; não apaga nem importa bases históricas.
-- Inclui a restrição de consulta da Diretoria (031), caso ainda não instalada.
-- 035 reconhece o modelo de RH com Salário Base, Salário e Ajuda de Custo.
-- 036 separa Salário Folha e Salário recebido e calcula o Total dos cinco campos.
-- 037 apresenta a remuneração dos sócios separadamente como Pró-labore.
-- 038 importa e confere o rodapé; o Total geral vem da coluna TOTAL do relatório.
-- A função business-import é publicada separadamente; não colar TypeScript aqui.
BEGIN;
DO $cf_module_base$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('central-financeira:remaining-modules',0));
  IF pg_catalog.to_regclass('public.central_schema_migrations') IS NULL
    OR pg_catalog.to_regclass('cf_private.approved_sessions') IS NULL
    OR pg_catalog.to_regclass('public.receivable_receipts') IS NULL THEN
    RAISE EXCEPTION 'Ative primeiro a base da Central e de Contas a Receber. Nenhuma alteração aplicada.' USING ERRCODE='22023';
  END IF;
END;
$cf_module_base$;

-- SOURCE: 031_director_readonly.sql
DO $cf_module_apply_c17c02e6ed92edd2_0$
BEGIN
  IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='031_director_readonly') THEN
    RAISE NOTICE 'Atualização 031_director_readonly já instalada; histórico preservado.';
  ELSE
    EXECUTE $cf_module_source_ea63b15a16bb5c82_0$
-- Diretoria: consulta em todos os módulos, sem Importar Bases ou alterações.
-- Não cria contas de autenticação, perfis, senhas ou dados financeiros.
-- Repetível após a identidade com sessões aprovadas e a base financeira 007.

DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL
  OR to_regclass('public.profiles') IS NULL OR to_regclass('public.role_permissions') IS NULL
  OR to_regclass('cf_private.approved_sessions') IS NULL OR to_regclass('cf_private.revoked_sessions') IS NULL
  OR to_regprocedure('cf_private.session_allowed()') IS NULL THEN
  RAISE EXCEPTION 'Ative a identidade, o gateway de autenticação 003 e a base financeira antes do acesso da Diretoria.' USING ERRCODE='22023';
 END IF;
END $$;
SELECT pg_advisory_xact_lock(2045812301);

-- Limpa permissões antigas de envio/alteração e qualquer acesso à importação.
DO $$ DECLARE v_action text;v_resources text[];BEGIN
 IF EXISTS(SELECT 1 FROM public.role_permissions WHERE role_key='diretor'
  AND (resource='importar_bases' OR action NOT IN ('read','export'))) THEN
  DELETE FROM public.role_permissions WHERE role_key='diretor'
   AND (resource='importar_bases' OR action NOT IN ('read','export'));
 END IF;
 FOREACH v_action IN ARRAY ARRAY['read','export'] LOOP
  v_resources:=CASE WHEN v_action='read' THEN ARRAY['painel','caixa','contas_pagar','contas_receber','cobranca','comissoes',
   'faturamento','margens','rh_dp','resumo_diretoria','mensagens_cp','usuarios','configuracoes','auditoria']
   ELSE ARRAY['painel','caixa','contas_pagar','contas_receber','cobranca','comissoes','faturamento','margens','rh_dp','resumo_diretoria'] END;
  -- Evita até UPDATE de contadores de autorização por comandos sem novas linhas.
  IF EXISTS(SELECT 1 FROM unnest(v_resources) m(resource) WHERE NOT EXISTS(
   SELECT 1 FROM public.role_permissions p WHERE p.role_key='diretor' AND p.resource=m.resource AND p.action=v_action)) THEN
   INSERT INTO public.role_permissions(role_key,resource,action)
    SELECT 'diretor',resource,v_action FROM unnest(v_resources) m(resource)
    ON CONFLICT(role_key,resource,action) DO NOTHING;
  END IF;
 END LOOP;
END $$;

-- A barreira continua válida se uma permissão antiga for reinserida no futuro.
-- Perfil e sessão oficiais permanecem a fonte de autorização, nunca metadata.
CREATE OR REPLACE FUNCTION cf_private.has_permission(p_resource text,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT cf_private.session_allowed() AND EXISTS(
  SELECT 1 FROM public.profiles p JOIN public.role_permissions rp ON rp.role_key=p.role_key
  WHERE p.id=auth.uid() AND p.enabled AND rp.resource=p_resource AND rp.action=p_action
   AND (p.role_key<>'diretor' OR (p_action IN ('read','export') AND p_resource<>'importar_bases')));
$$;
CREATE OR REPLACE FUNCTION public.current_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile public.profiles%ROWTYPE;v_permissions jsonb;BEGIN
 IF NOT cf_private.session_allowed() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid() AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('resource',resource,'action',action) ORDER BY resource,action),'[]'::jsonb)
 INTO v_permissions FROM public.role_permissions WHERE role_key=v_profile.role_key AND cf_private.has_permission(resource,action);
 RETURN jsonb_build_object('profile',to_jsonb(v_profile),'permissions',v_permissions,'collector_id',cf_private.current_collector_id());
END $$;

-- Helper sem argumentos de usuário: somente a própria identidade oficial pode
-- abrir a leitura administrativa. SECURITY DEFINER evita recursão da RLS de profiles.
CREATE OR REPLACE FUNCTION cf_private.director_read_allowed(p_resource text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT cf_private.has_permission(p_resource,'read') AND EXISTS(
  SELECT 1 FROM public.profiles WHERE id=auth.uid() AND enabled AND role_key='diretor');
$$;
REVOKE ALL ON FUNCTION cf_private.director_read_allowed(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cf_private.director_read_allowed(text) TO authenticated;

-- Políticas somente SELECT; as escritas continuam exclusivamente nos RPCs da Gerência.
DROP POLICY IF EXISTS profiles_director_read ON public.profiles;
CREATE POLICY profiles_director_read ON public.profiles FOR SELECT TO authenticated
 USING(cf_private.director_read_allowed('usuarios'));
DROP POLICY IF EXISTS agents_director_read ON public.collection_agents;
CREATE POLICY agents_director_read ON public.collection_agents FOR SELECT TO authenticated
 USING(cf_private.director_read_allowed('configuracoes'));
DROP POLICY IF EXISTS bindings_director_read ON public.collector_bindings;
CREATE POLICY bindings_director_read ON public.collector_bindings FOR SELECT TO authenticated
 USING(cf_private.director_read_allowed('configuracoes'));
DROP POLICY IF EXISTS audit_director_read ON public.audit_events;
CREATE POLICY audit_director_read ON public.audit_events FOR SELECT TO authenticated
 USING(cf_private.director_read_allowed('auditoria'));

COMMENT ON FUNCTION cf_private.director_read_allowed(text) IS 'Leitura administrativa da própria Diretoria ativa com sessão aprovada; não concede escrita, validação, importação ou administração.';
INSERT INTO public.central_schema_migrations(version) VALUES('031_director_readonly') ON CONFLICT(version) DO NOTHING;
$cf_module_source_ea63b15a16bb5c82_0$;
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='031_director_readonly') THEN
      RAISE EXCEPTION 'A atualização 031_director_readonly não registrou sua versão.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_module_apply_c17c02e6ed92edd2_0$;

-- SOURCE: 032_commercial.sql
DO $cf_module_apply_d4e6fe1bec785b33_0$
BEGIN
  IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='032_commercial') THEN
    RAISE NOTICE 'Atualização 032_commercial já instalada; histórico preservado.';
  ELSE
    EXECUTE $cf_module_source_49a17842835cc375_0$
-- Fechamentos de Faturamento e Margens: versões mensais integrais, sem dados históricos embutidos.

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
$cf_module_source_49a17842835cc375_0$;
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='032_commercial') THEN
      RAISE EXCEPTION 'A atualização 032_commercial não registrou sua versão.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_module_apply_d4e6fe1bec785b33_0$;

-- SOURCE: 033_hr.sql
DO $cf_module_apply_03f539ed26492ee4_0$
BEGIN
  IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='033_hr') THEN
    RAISE NOTICE 'Atualização 033_hr já instalada; histórico preservado.';
  ELSE
    EXECUTE $cf_module_source_59692f83ce17e404_0$
-- RH/DP: snapshots privados da folha, preservando os dois campos SALÁRIO.
-- Somente configuração da política V75; não inclui pessoas ou valores históricos.

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
$cf_module_source_59692f83ce17e404_0$;
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='033_hr') THEN
      RAISE EXCEPTION 'A atualização 033_hr não registrou sua versão.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_module_apply_03f539ed26492ee4_0$;

-- SOURCE: 034_commissions.sql
DO $cf_module_apply_a68d1579df3b4b89_0$
BEGIN
  IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='034_commissions') THEN
    RAISE NOTICE 'Atualização 034_commissions já instalada; histórico preservado.';
  ELSE
    EXECUTE $cf_module_source_dd7adce3f8c7e7c2_0$
-- Comissões: regras com vigência, cálculo exato e apurações imutáveis.
-- Não gera pagamentos de comissão, não importa bases históricas nem vincula nomes a usuários.

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
$cf_module_source_dd7adce3f8c7e7c2_0$;
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='034_commissions') THEN
      RAISE EXCEPTION 'A atualização 034_commissions não registrou sua versão.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_module_apply_a68d1579df3b4b89_0$;

-- SOURCE: 035_hr_report_model.sql
DO $cf_module_apply_b1fb9f880bdb0ec6_0$
BEGIN
  IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='035_hr_report_model') THEN
    RAISE NOTICE 'Atualização 035_hr_report_model já instalada; histórico preservado.';
  ELSE
    EXECUTE $cf_module_source_7b404d7d9f7b451b_0$
-- Modelo real de RH/DP: Salário Base, Salário e Ajuda de Custo são distintos.
-- Revisão 2 cria novas posições; históricos e arquivos originais não são alterados.

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='033_hr') THEN
  RAISE EXCEPTION 'Ative a atualização 033 de RH/DP antes desta correção.' USING ERRCODE='22023';END IF;
END $$;

CREATE FUNCTION cf_private.hr_report_rows(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_number numeric;v_total numeric;v_legacy_rows jsonb;BEGIN
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 OR octet_length(p_rows::text)>4194304 THEN
  RAISE EXCEPTION 'Informe de 1 a 5.000 registros válidos de RH/DP.' USING ERRCODE='22023';END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(v_row)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v_row))<>13 OR NOT(v_row ? 'cost_allowance_cents') THEN
   RAISE EXCEPTION 'O modelo de RH/DP requer o campo de ajuda de custo separado dos salários.' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(v_row->'cost_allowance_cents')<>'null' THEN
   IF jsonb_typeof(v_row->'cost_allowance_cents')<>'number' THEN RAISE EXCEPTION 'Ajuda de custo deve conter centavos inteiros ou permanecer desconhecida.' USING ERRCODE='22023';END IF;
   v_number:=(v_row->>'cost_allowance_cents')::numeric;
   IF v_number<>trunc(v_number) OR abs(v_number)>9007199254740991 THEN
    RAISE EXCEPTION 'Ajuda de custo inválida ou fora do limite de precisão.' USING ERRCODE='22023';END IF;
  END IF;
 END LOOP;
 SELECT sum(abs((r->>'cost_allowance_cents')::numeric)),jsonb_agg(r-'cost_allowance_cents') INTO v_total,v_legacy_rows FROM jsonb_array_elements(p_rows)r;
 IF v_total>9007199254740991 THEN RAISE EXCEPTION 'Total da ajuda de custo excede o limite de precisão.' USING ERRCODE='22003';END IF;
 PERFORM cf_private.hr_rows(v_legacy_rows);
 RETURN p_rows;
END $$;

ALTER TABLE cf_private.hr_imports ADD COLUMN format_version smallint NOT NULL DEFAULT 1 CHECK(format_version IN(1,2));
ALTER TABLE cf_private.hr_imports DROP CONSTRAINT hr_imports_reference_date_file_sha256_key;
ALTER TABLE cf_private.hr_imports ADD CONSTRAINT hr_imports_reference_file_format_key UNIQUE(reference_date,file_sha256,format_version);
ALTER TABLE cf_private.hr_imports DROP CONSTRAINT hr_imports_rows_check;
ALTER TABLE cf_private.hr_imports ADD CONSTRAINT hr_imports_format_rows_check CHECK(
 (format_version=1 AND rows=cf_private.hr_rows(rows)) OR (format_version=2 AND rows=cf_private.hr_report_rows(rows)));

CREATE OR REPLACE FUNCTION cf_private.hr_statistics(p_rows jsonb,p_month date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_rows jsonb;v_summary jsonb;v_quality jsonb;v_by_branch jsonb;v_by_sector jsonb;v_birthdays jsonb;v_anniversaries jsonb;BEGIN
 SELECT coalesce(jsonb_agg(r||jsonb_build_object('is_partner',cf_private.hr_normalize(r->>'sector')='SOCIO',
  'cost_allowance_cents',coalesce(r->'cost_allowance_cents','null'::jsonb),
  'basket_eligible',cf_private.hr_normalize(r->>'employee') NOT IN('GABRIEL PEDROSA MARQUES FERREIRA','GUSTAVO MARQUES FERREIRA'),
  'basket_cost_cents',CASE WHEN cf_private.hr_normalize(r->>'employee') IN('GABRIEL PEDROSA MARQUES FERREIRA','GUSTAVO MARQUES FERREIRA') THEN 0 ELSE 11280 END) ORDER BY (r->>'source_row')::integer),'[]'::jsonb)
  INTO v_rows FROM jsonb_array_elements(p_rows)r;
 SELECT jsonb_build_object('employees',count(*) FILTER(WHERE NOT (r->>'is_partner')::boolean),'partners',count(*) FILTER(WHERE (r->>'is_partner')::boolean),
  'admissions',count(*) FILTER(WHERE date_trunc('month',(r->>'admitted_on')::date)=p_month),'birthdays',count(*) FILTER(WHERE extract(month FROM (r->>'birthday_on')::date)=extract(month FROM p_month)),
  'basket_eligible',count(*) FILTER(WHERE (r->>'basket_eligible')::boolean),'basket_excluded',count(*) FILTER(WHERE NOT (r->>'basket_eligible')::boolean),
  'basket_unit_cents',11280,'basket_monthly_cents',coalesce(sum((r->>'basket_cost_cents')::bigint),0),'basket_annual_cents',coalesce(sum((r->>'basket_cost_cents')::bigint),0)*12,
  'salary_base_cents',CASE WHEN count(*) FILTER(WHERE NOT(r->>'is_partner')::boolean AND r->>'salary_base_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'salary_base_cents')::bigint) FILTER(WHERE NOT(r->>'is_partner')::boolean),0) END,
  'payroll_salary_cents',CASE WHEN count(*) FILTER(WHERE r->>'payroll_salary_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'payroll_salary_cents')::bigint),0) END,
  'cost_allowance_cents',CASE WHEN count(*) FILTER(WHERE r->>'cost_allowance_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'cost_allowance_cents')::bigint),0) END,
  'transport_cents',CASE WHEN count(*) FILTER(WHERE r->>'transport_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'transport_cents')::bigint),0) END,
  'advance_cents',CASE WHEN count(*) FILTER(WHERE r->>'advance_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'advance_cents')::bigint),0) END,
  'total_cents',CASE WHEN count(*) FILTER(WHERE r->>'total_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((r->>'total_cents')::bigint),0) END),
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
 RETURN jsonb_build_object('calendar_month',p_month,'summary',v_summary,'quality',v_quality,'by_branch',v_by_branch,'by_sector',v_by_sector,'birthdays',v_birthdays,'work_anniversaries',v_anniversaries,'rows',v_rows);
END $$;

CREATE OR REPLACE FUNCTION public.hr_report(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_import cf_private.hr_imports%ROWTYPE;v_report jsonb;BEGIN
 IF NOT cf_private.has_permission('rh_dp','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_month IS NULL OR p_month NOT BETWEEN DATE '1900-01-01' AND DATE '2199-12-01' OR extract(day FROM p_month)<>1 THEN RAISE EXCEPTION 'Selecione o mês de referência.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_import FROM cf_private.hr_imports ORDER BY reference_date DESC,imported_at DESC,id DESC LIMIT 1;
 v_report:=cf_private.hr_statistics(coalesce(v_import.rows,'[]'::jsonb),p_month);
 RETURN v_report||jsonb_build_object('snapshot',CASE WHEN v_import.id IS NULL THEN NULL ELSE jsonb_build_object('id',v_import.id,'reference_date',v_import.reference_date,
  'format_version',v_import.format_version,'file_name',v_import.file_name,'sha256',v_import.file_sha256,'imported_at',v_import.imported_at,'row_count',v_import.row_count) END);
END $$;
CREATE FUNCTION public.preview_hr_report_import(p_rows jsonb,p_reference_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_previous uuid;v_result jsonb;BEGIN
 PERFORM cf_private.require_hr_import();
 IF p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01' OR p_reference_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
  RAISE EXCEPTION 'Informe a data da posição até hoje em São Paulo.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.hr_report_rows(p_rows);
 SELECT id INTO v_previous FROM cf_private.hr_imports ORDER BY reference_date DESC,imported_at DESC,id DESC LIMIT 1;
 v_result:=cf_private.hr_statistics(p_rows,date_trunc('month',p_reference_date)::date);
 RETURN jsonb_build_object('row_count',jsonb_array_length(p_rows),'previous_import_id',v_previous,'summary',v_result->'summary','quality',v_result->'quality');
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
 IF EXISTS(SELECT 1 FROM cf_private.hr_imports WHERE format_version=2) THEN
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
CREATE FUNCTION public.commit_hr_report_import_from_gateway(p_user_id uuid,p_session_id text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_reference_date date,p_previous_import_id uuid) RETURNS jsonb
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

REVOKE ALL ON FUNCTION cf_private.hr_report_rows(jsonb),public.preview_hr_report_import(jsonb,date),
 public.commit_hr_report_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_hr_report_import(jsonb,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_hr_report_import_from_gateway(uuid,text,text,text,text,jsonb,date,uuid) TO service_role;
INSERT INTO public.central_schema_migrations(version) VALUES('035_hr_report_model') ON CONFLICT(version) DO NOTHING;
$cf_module_source_7b404d7d9f7b451b_0$;
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='035_hr_report_model') THEN
      RAISE EXCEPTION 'A atualização 035_hr_report_model não registrou sua versão.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_module_apply_b1fb9f880bdb0ec6_0$;

-- SOURCE: 036_hr_total.sql
DO $cf_module_apply_6291bfd8c34ae1d4_0$
BEGIN
  IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='036_hr_total') THEN
    RAISE NOTICE 'Atualização 036_hr_total já instalada; histórico preservado.';
  ELSE
    EXECUTE $cf_module_source_b294295d9a433b3f_0$
-- RH/DP: total explícito dos cinco valores definidos pela operação.
-- Projeta os totais na leitura e na prévia; arquivos, posições e auditorias são preservados.
-- Revisão 3 corrige os aliases de Salário Folha (bruto) e Salário recebido (líquido).

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
$cf_module_source_b294295d9a433b3f_0$;
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='036_hr_total') THEN
      RAISE EXCEPTION 'A atualização 036_hr_total não registrou sua versão.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_module_apply_6291bfd8c34ae1d4_0$;

-- SOURCE: 037_hr_prolabore.sql
DO $cf_module_apply_ce628697cccef0db_0$
BEGIN
  IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='037_hr_prolabore') THEN
    RAISE NOTICE 'Atualização 037_hr_prolabore já instalada; histórico preservado.';
  ELSE
    EXECUTE $cf_module_source_f153c39e5aec9181_0$
-- RH/DP: salários de colaboradores e pró-labores de sócios separados na leitura.
-- A classificação deriva do setor SÓCIO existente. Não altera originais, posições ou a fórmula numérica do Total.

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
$cf_module_source_f153c39e5aec9181_0$;
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='037_hr_prolabore') THEN
      RAISE EXCEPTION 'A atualização 037_hr_prolabore não registrou sua versão.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_module_apply_ce628697cccef0db_0$;

-- SOURCE: 038_hr_sheet_totals.sql
DO $cf_module_apply_ef9407830a01040c_0$
BEGIN
  IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='038_hr_sheet_totals') THEN
    RAISE NOTICE 'Atualização 038_hr_sheet_totals já instalada; histórico preservado.';
  ELSE
    EXECUTE $cf_module_source_39162885c0209f47_0$
-- RH/DP: os totais da própria planilha são preservados e conferidos com as linhas.
-- Revisão 4 guarda o rodapé separadamente; não altera posições nem arquivos anteriores.

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
$cf_module_source_39162885c0209f47_0$;
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='038_hr_sheet_totals') THEN
      RAISE EXCEPTION 'A atualização 038_hr_sheet_totals não registrou sua versão.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_module_apply_ef9407830a01040c_0$;

NOTIFY pgrst, 'reload schema';
COMMIT;
