-- Central Financeira 0.3.0: apply ONCE after 001/003/004.
-- All three migrations below form ONE transaction. No passwords or financial seed balances.
BEGIN;

-- SOURCE: 005_payables.sql
-- Central Financeira: importação integral e auditável de Contas a Pagar.
-- Incremental: requer 001, 003 e 004. Não altera usuários, senhas ou bases legadas.
-- O relatório original fica privado; novas publicações não recriam estas tabelas.

CREATE TABLE public.payable_macros (
  name text PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 100)
);
INSERT INTO public.payable_macros(name) VALUES
 ('FIXO'),('IMPOSTO'),('SALÁRIOS'),('ADIANTAMENTO'),('VALE TRANSPORTE'),
 ('VARIÁVEL'),('BÔNUS / COMISSÕES'),('FRETE'),('OUTROS IMPOSTOS'),('CONSÓRCIOS'),
 ('REEMBOLSO - GABRIEL'),('FREELANCER - COMERCIAL'),('PREJUÍZOS'),('COMPRA DE MERCADORIA');

CREATE FUNCTION cf_private.normalize_payable_plan(p_plan text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT upper(btrim(regexp_replace(p_plan,'[[:space:]]+',' ','g')));
$$;
CREATE TABLE public.payable_plan_mappings (
  plan text PRIMARY KEY CHECK (length(plan) BETWEEN 1 AND 300 AND plan=cf_private.normalize_payable_plan(plan)),
  macro text NOT NULL REFERENCES public.payable_macros(name) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Somente associações expressamente determinadas pelo usuário; nenhuma inferência.
INSERT INTO public.payable_plan_mappings(plan,macro) VALUES
 ('HOSPEDAGEM - COMERCIAL','VARIÁVEL'),('INVESTIMENTOS','VARIÁVEL'),('FRACIONAMENTO DE PACOTES','VARIÁVEL');

CREATE TABLE public.payable_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope='grupo-consolidado'),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 250),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 5000),
  new_count integer NOT NULL CHECK (new_count >= 0),
  open_count integer NOT NULL CHECK (open_count >= 0),
  settled_count integer NOT NULL CHECK (settled_count >= 0),
  UNIQUE (scope,file_sha256),
  CHECK (new_count+open_count=row_count)
);
CREATE INDEX payable_imports_scope_date ON public.payable_imports(scope,created_at DESC,id DESC);
CREATE TABLE cf_private.payable_import_files (
  import_id uuid PRIMARY KEY REFERENCES public.payable_imports(id) ON DELETE RESTRICT,
  file_bytes bytea NOT NULL CHECK (octet_length(file_bytes) BETWEEN 1 AND 2097152)
);
CREATE TABLE public.payable_titles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope='grupo-consolidado'),
  source_key text NOT NULL,
  entry_number text NOT NULL,
  description text NOT NULL,
  due_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 9007199254740991),
  source_status text,
  plan text NOT NULL REFERENCES public.payable_plan_mappings(plan) ON DELETE RESTRICT,
  bank_account text,
  branch text NOT NULL,
  issued_on date,
  macro text NOT NULL REFERENCES public.payable_macros(name) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('NEW','OPEN','SETTLED_IMPORT')),
  first_import_id uuid NOT NULL REFERENCES public.payable_imports(id) ON DELETE RESTRICT,
  last_import_id uuid NOT NULL REFERENCES public.payable_imports(id) ON DELETE RESTRICT,
  settled_at timestamptz,
  UNIQUE (scope,source_key),
  CHECK ((status='SETTLED_IMPORT')=(settled_at IS NOT NULL))
);
CREATE INDEX payable_titles_scope_status_due ON public.payable_titles(scope,status,due_date);
CREATE INDEX payable_titles_macro_due ON public.payable_titles(macro,due_date);

ALTER TABLE public.payable_macros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_plan_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_titles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.payable_import_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY payable_macros_read ON public.payable_macros FOR SELECT TO authenticated
 USING (cf_private.has_permission('contas_pagar','read') OR cf_private.has_permission('contas_pagar','import'));
CREATE POLICY payable_mappings_read ON public.payable_plan_mappings FOR SELECT TO authenticated
 USING (cf_private.has_permission('contas_pagar','read') OR cf_private.has_permission('contas_pagar','import'));
CREATE POLICY payable_imports_read ON public.payable_imports FOR SELECT TO authenticated
 USING (cf_private.has_permission('contas_pagar','read') OR cf_private.has_permission('contas_pagar','import'));
CREATE POLICY payable_titles_read ON public.payable_titles FOR SELECT TO authenticated
 USING (cf_private.has_permission('contas_pagar','read') OR cf_private.has_permission('contas_pagar','import'));

-- A mesma validação é executada na prévia e na gravação, sem confiar no navegador.
CREATE FUNCTION cf_private.validate_payable_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_row jsonb; v_normalized jsonb; v_items jsonb[] := ARRAY[]::jsonb[]; v_result jsonb;
  v_line integer := 0; v_field text; v_text text; v_due date; v_issued date;
  v_cents numeric; v_total numeric := 0; v_key text;
BEGIN
  IF p_scope IS DISTINCT FROM 'grupo-consolidado' THEN
    RAISE EXCEPTION 'Importe somente o relatório completo do grupo consolidado.' USING ERRCODE='22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' THEN
    RAISE EXCEPTION 'Informe as linhas do relatório completo.' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'O relatório deve conter de 1 a 5.000 linhas.' USING ERRCODE='22023';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_line := v_line+1;
    IF jsonb_typeof(v_row)<>'object' OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN
       ('entry_number','description','due_date','amount_cents','source_status','plan','bank_account','branch','issued_on')) THEN
      RAISE EXCEPTION 'Linha %: estrutura inválida.',v_line USING ERRCODE='22023';
    END IF;
    FOREACH v_field IN ARRAY ARRAY['entry_number','description','due_date','plan','branch'] LOOP
      IF jsonb_typeof(v_row->v_field) IS DISTINCT FROM 'string'
         OR length(btrim(regexp_replace(v_row->>v_field,'[[:space:]]+',' ','g')))=0 THEN
        RAISE EXCEPTION 'Linha %: coluna % obrigatória.',v_line,v_field USING ERRCODE='22023';
      END IF;
    END LOOP;
    FOREACH v_field IN ARRAY ARRAY['source_status','bank_account','issued_on'] LOOP
      IF v_row ? v_field AND jsonb_typeof(v_row->v_field) NOT IN ('string','null') THEN
        RAISE EXCEPTION 'Linha %: coluna % inválida.',v_line,v_field USING ERRCODE='22023';
      END IF;
    END LOOP;
    IF length(v_row->>'entry_number')>150 OR length(v_row->>'branch')>150
       OR length(v_row->>'plan')>300 OR length(v_row->>'description')>1500
       OR length(coalesce(v_row->>'bank_account',''))>300 OR length(coalesce(v_row->>'source_status',''))>150 THEN
      RAISE EXCEPTION 'Linha %: conteúdo excede o tamanho permitido.',v_line USING ERRCODE='22023';
    END IF;
    v_text := v_row->>'due_date';
    IF v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR left(v_text,4)='0000' THEN
      RAISE EXCEPTION 'Linha %: vencimento deve usar AAAA-MM-DD.',v_line USING ERRCODE='22023';
    END IF;
    BEGIN
      v_due := v_text::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Linha %: vencimento inválido.',v_line USING ERRCODE='22023';
    END;
    v_issued := NULL;
    IF coalesce(v_row->>'issued_on','')<>'' THEN
      v_text := v_row->>'issued_on';
      IF v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR left(v_text,4)='0000' THEN
        RAISE EXCEPTION 'Linha %: emissão deve usar AAAA-MM-DD.',v_line USING ERRCODE='22023';
      END IF;
      BEGIN
        v_issued := v_text::date;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'Linha %: emissão inválida.',v_line USING ERRCODE='22023';
      END;
    END IF;
    IF jsonb_typeof(v_row->'amount_cents') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Linha %: valor deve ser informado em centavos inteiros.',v_line USING ERRCODE='22023';
    END IF;
    v_cents := (v_row->>'amount_cents')::numeric;
    IF v_cents<>trunc(v_cents) OR v_cents<0 OR v_cents>9007199254740991 THEN
      RAISE EXCEPTION 'Linha %: valor em centavos inválido.',v_line USING ERRCODE='22023';
    END IF;
    v_total := v_total+v_cents;
    IF v_total>9007199254740991 THEN
      RAISE EXCEPTION 'O total do relatório excede o limite de precisão.' USING ERRCODE='22023';
    END IF;
    v_normalized := jsonb_build_object(
      'entry_number',btrim(regexp_replace(v_row->>'entry_number','[[:space:]]+',' ','g')),
      'description',btrim(v_row->>'description'),'due_date',v_due,'amount_cents',v_cents::bigint,
      'source_status',nullif(btrim(v_row->>'source_status'),''),
      'plan',cf_private.normalize_payable_plan(v_row->>'plan'),
      'bank_account',nullif(btrim(v_row->>'bank_account'),''),
      'branch',btrim(regexp_replace(v_row->>'branch','[[:space:]]+',' ','g')),'issued_on',v_issued);
    v_key := jsonb_build_array(v_normalized->>'branch',v_normalized->>'entry_number',v_due,v_cents::bigint)::text;
    -- Expanded PostgreSQL arrays avoid repeatedly copying a growing JSON report.
    v_items := array_append(v_items,v_normalized || jsonb_build_object('source_key',v_key));
  END LOOP;
  v_result := to_jsonb(v_items);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_result) r GROUP BY r->>'source_key' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'O relatório contém chaves de títulos duplicadas. Revise filial, lançamento, vencimento e valor.' USING ERRCODE='23505';
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION cf_private.audit_payable_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor public.profiles%ROWTYPE; v_before jsonb; v_after jsonb; v_action text;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  IF TG_OP<>'INSERT' THEN v_before:=to_jsonb(OLD); END IF;
  v_after:=to_jsonb(NEW);
  v_action:=CASE WHEN TG_OP='INSERT' THEN 'CREATE' ELSE 'UPDATE' END;
  IF TG_TABLE_NAME='payable_titles' AND TG_OP='UPDATE' THEN
    IF NEW.status='SETTLED_IMPORT' AND OLD.status<>'SETTLED_IMPORT' THEN v_action:='AUTO_RECONCILE';
    ELSIF OLD.status='SETTLED_IMPORT' AND NEW.status<>'SETTLED_IMPORT' THEN v_action:='REOPEN'; END IF;
  ELSIF TG_TABLE_NAME IN ('payable_imports','payable_plan_mappings') AND TG_OP='INSERT' THEN v_action:='IMPORT';
  END IF;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar',TG_TABLE_NAME,
      coalesce(v_after->>'id',v_after->>'plan'),v_action,v_before,v_after);
  RETURN NEW;
END;
$$;
CREATE TRIGGER payable_title_audit AFTER INSERT OR UPDATE ON public.payable_titles
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_change();
CREATE TRIGGER payable_mapping_audit AFTER INSERT OR UPDATE ON public.payable_plan_mappings
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_change();
CREATE TRIGGER payable_import_audit AFTER INSERT ON public.payable_imports
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_change();

CREATE FUNCTION public.preview_payables_import(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows jsonb; v_previous uuid; v_new integer; v_open integer; v_settled integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  v_rows:=cf_private.validate_payable_rows(p_scope,p_rows);
  SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
  SELECT count(*) FILTER (WHERE t.id IS NULL),count(*) FILTER (WHERE t.id IS NOT NULL) INTO v_new,v_open
    FROM jsonb_array_elements(v_rows) r LEFT JOIN public.payable_titles t ON t.scope=p_scope AND t.source_key=r->>'source_key';
  SELECT count(*) INTO v_settled FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'source_key'=t.source_key);
  RETURN jsonb_build_object('previous_import_id',v_previous,'new_count',v_new,'open_count',v_open,
    'settled_count',v_settled,'row_count',jsonb_array_length(v_rows));
END;
$$;

CREATE FUNCTION public.commit_payables_import(
 p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_mappings jsonb,
 p_complete boolean,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rows jsonb; v_previous uuid; v_id uuid:=gen_random_uuid(); v_new integer; v_open integer; v_settled integer;
  v_file bytea; v_mappings jsonb:='{}'::jsonb; v_mapping record; v_plan text;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_complete IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Confirme que o arquivo contém o relatório completo.' USING ERRCODE='22023';
  END IF;
  v_rows:=cf_private.validate_payable_rows(p_scope,p_rows);
  IF p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 250
     OR p_file_name ~ '[/\\[:cntrl:]]' OR p_file_sha256 IS NULL OR p_file_sha256 !~ '^[a-f0-9]{64}$'
     OR p_file_base64 IS NULL OR length(p_file_base64) NOT BETWEEN 1 AND 2796204 THEN
    RAISE EXCEPTION 'Metadados do arquivo inválidos.' USING ERRCODE='22023';
  END IF;
  BEGIN
    v_file:=decode(p_file_base64,'base64');
  EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'O arquivo original está inválido.' USING ERRCODE='22023';
  END;
  IF octet_length(v_file) NOT BETWEEN 1 AND 2097152 OR encode(sha256(v_file),'hex')<>p_file_sha256 THEN
    RAISE EXCEPTION 'A integridade do arquivo original não foi confirmada.' USING ERRCODE='22023';
  END IF;
  IF p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'object' OR octet_length(p_mappings::text)>2000000 THEN
    RAISE EXCEPTION 'Informe as classificações dos planos.' USING ERRCODE='22023';
  END IF;
  FOR v_mapping IN SELECT key,value FROM jsonb_each(p_mappings) LOOP
    v_plan:=cf_private.normalize_payable_plan(v_mapping.key);
    IF length(v_plan) NOT BETWEEN 1 AND 300 OR length(v_mapping.key)>300
       OR jsonb_typeof(v_mapping.value)<>'string' OR NOT EXISTS(
         SELECT 1 FROM public.payable_macros WHERE name=v_mapping.value#>>'{}') THEN
      RAISE EXCEPTION 'Classificação de plano inválida.' USING ERRCODE='22023';
    END IF;
    IF v_mappings ? v_plan THEN
      RAISE EXCEPTION 'O mesmo plano possui classificações duplicadas.' USING ERRCODE='22023';
    END IF;
    v_mappings:=v_mappings||jsonb_build_object(v_plan,v_mapping.value#>>'{}');
  END LOOP;
  -- Um lock serializa cada relatório integral. O token de prévia impede baixa
  -- sobre uma posição diferente da que o operador revisou.
  PERFORM pg_advisory_xact_lock(2045812305,hashtext(p_scope));
  SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous IS DISTINCT FROM p_previous_import_id THEN
    RAISE EXCEPTION 'A base foi atualizada por outra importação. Gere uma nova prévia.' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM public.payable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256) THEN
    RAISE EXCEPTION 'Este arquivo já foi importado neste escopo.' USING ERRCODE='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r
    LEFT JOIN public.payable_plan_mappings m ON m.plan=r->>'plan'
    WHERE NOT (v_mappings ? (r->>'plan')) AND m.plan IS NULL) THEN
    RAISE EXCEPTION 'Existem planos NÃO CLASSIFICADOS. Classifique todos antes de concluir.' USING ERRCODE='23514';
  END IF;
  -- Não permite usar uma importação para alterar silenciosamente planos ausentes.
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_mappings) k
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'plan'=k)) THEN
    RAISE EXCEPTION 'A classificação deve pertencer a um plano deste relatório.' USING ERRCODE='22023';
  END IF;
  SELECT count(*) FILTER(WHERE t.id IS NULL),count(*) FILTER(WHERE t.id IS NOT NULL) INTO v_new,v_open
    FROM jsonb_array_elements(v_rows) r LEFT JOIN public.payable_titles t ON t.scope=p_scope AND t.source_key=r->>'source_key';
  SELECT count(*) INTO v_settled FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'source_key'=t.source_key);
  INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count)
    VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),v_new,v_open,v_settled);
  INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
  INSERT INTO public.payable_plan_mappings(plan,macro)
    SELECT key,value#>>'{}' FROM jsonb_each(v_mappings)
    ON CONFLICT(plan) DO UPDATE SET macro=EXCLUDED.macro,updated_at=clock_timestamp()
      WHERE payable_plan_mappings.macro IS DISTINCT FROM EXCLUDED.macro;
  UPDATE public.payable_titles t SET status='SETTLED_IMPORT',settled_at=clock_timestamp(),last_import_id=v_id
    WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'source_key'=t.source_key);
  INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,source_status,
    plan,bank_account,branch,issued_on,macro,status,first_import_id,last_import_id,settled_at)
    SELECT p_scope,r.source_key,r.entry_number,r.description,r.due_date,r.amount_cents,r.source_status,
      r.plan,r.bank_account,r.branch,r.issued_on,m.macro,'NEW',v_id,v_id,NULL
    FROM jsonb_to_recordset(v_rows) AS r(source_key text,entry_number text,description text,due_date date,
      amount_cents bigint,source_status text,plan text,bank_account text,branch text,issued_on date)
    JOIN public.payable_plan_mappings m ON m.plan=r.plan
    ON CONFLICT(scope,source_key) DO UPDATE SET
      entry_number=EXCLUDED.entry_number,description=EXCLUDED.description,due_date=EXCLUDED.due_date,
      amount_cents=EXCLUDED.amount_cents,source_status=EXCLUDED.source_status,plan=EXCLUDED.plan,
      bank_account=EXCLUDED.bank_account,branch=EXCLUDED.branch,issued_on=EXCLUDED.issued_on,
      macro=EXCLUDED.macro,status='OPEN',last_import_id=v_id,settled_at=NULL;
  RETURN jsonb_build_object('import_id',v_id,'new_count',v_new,'open_count',v_open,
    'settled_count',v_settled,'row_count',jsonb_array_length(v_rows));
END;
$$;

-- Exclusivo do servidor: o gateway valida JWT no Auth e analisa o arquivo
-- original antes de fornecer linhas/SHA. O navegador não escolhe identidade,
-- sessão nem linhas para gravação. As permissões oficiais são rechecadas aqui.
CREATE FUNCTION public.commit_payables_import_from_gateway(
 p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,
 p_rows jsonb,p_mappings jsonb,p_complete boolean,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL
     OR p_session_id !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
  IF NOT cf_private.has_permission('contas_pagar','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  RETURN public.commit_payables_import(p_scope,p_file_name,p_file_sha256,p_file_base64,
    p_rows,p_mappings,p_complete,p_previous_import_id);
END;
$$;

-- Painel recebe exclusivamente agregados; perfis CR não leem títulos de CP.
CREATE FUNCTION public.payables_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_open numeric; v_overdue numeric; v_period numeric; v_count bigint; v_latest timestamptz;
BEGIN
  IF NOT (cf_private.has_permission('contas_pagar','read') OR cf_private.has_permission('painel','read')) THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>3660 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(sum(amount_cents),0),
    coalesce(sum(amount_cents) FILTER(WHERE due_date<(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date),0),
    coalesce(sum(amount_cents) FILTER(WHERE due_date BETWEEN p_start AND p_end),0),count(*)
    INTO v_open,v_overdue,v_period,v_count
    FROM public.payable_titles WHERE status<>'SETTLED_IMPORT';
  IF greatest(v_open,v_overdue,v_period,v_count)>9007199254740991 THEN
    RAISE EXCEPTION 'O consolidado excede o limite de precisão. Revise os valores importados.' USING ERRCODE='22003';
  END IF;
  SELECT max(created_at) INTO v_latest FROM public.payable_imports;
  RETURN jsonb_build_object('open_cents',v_open,'overdue_cents',v_overdue,'period_cents',v_period,
    'active_count',v_count,'latest_import_at',v_latest);
END;
$$;

REVOKE ALL ON TABLE public.payable_macros,public.payable_plan_mappings,public.payable_imports,public.payable_titles
 FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.payable_macros,public.payable_plan_mappings,public.payable_imports,public.payable_titles TO authenticated;
REVOKE ALL ON TABLE cf_private.payable_import_files FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION cf_private.normalize_payable_plan(text),cf_private.validate_payable_rows(text,jsonb),cf_private.audit_payable_change()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.preview_payables_import(text,jsonb),
 public.commit_payables_import(text,text,text,text,jsonb,jsonb,boolean,uuid),
 public.commit_payables_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,boolean,uuid),public.payables_summary(date,date)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_payables_import(text,jsonb),
 public.payables_summary(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_payables_import(text,text,text,text,jsonb,jsonb,boolean,uuid),
 public.commit_payables_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,boolean,uuid) TO service_role;
COMMENT ON TABLE public.payable_titles IS 'Títulos conservados após baixa por relatório integral; ausência nunca exclui histórico.';
COMMENT ON TABLE cf_private.payable_import_files IS 'Cópias originais privadas; nenhuma leitura direta pelo navegador. Limite de 2 MiB por importação.';
COMMENT ON FUNCTION public.commit_payables_import(text,text,text,text,jsonb,jsonb,boolean,uuid) IS 'Servidor somente. Importação integral atômica, classificação obrigatória, prévia concorrente e auditoria. Somente grupo-consolidado para impedir somas duplicadas entre escopos.';
COMMENT ON FUNCTION public.commit_payables_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,boolean,uuid) IS 'Gateway com chave de serviço: verifica JWT pelo Auth e deriva linhas e SHA do arquivo antes de chamar. Banco revalida sessão aprovada e perfil oficial.';

-- SOURCE: 006_treasury.sql
-- Central Financeira: posições bancárias e estoque manual de contingência.
-- Aplicar uma única vez após 001, 003 e 004. Não altera saldos ou dados existentes.
-- Cadastra somente as onze contas oficiais; ausência de posição nunca significa zero.

CREATE TABLE public.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (length(btrim(company)) BETWEEN 1 AND 100),
  bank text NOT NULL CHECK (length(btrim(bank)) BETWEEN 1 AND 100),
  account_label text NOT NULL CHECK (length(btrim(account_label)) BETWEEN 1 AND 150),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company, bank, account_label)
);
INSERT INTO public.bank_accounts(company, bank, account_label) VALUES
  ('F2G', 'Bradesco', 'Bradesco'),
  ('EASY CLEAN', 'Bradesco', 'Bradesco'),
  ('EASY CLEAN', 'Banco do Brasil', 'Banco do Brasil'),
  ('FAST CLEAN', 'Bradesco', 'Bradesco'),
  ('FAST CLEAN', 'Banco do Brasil', 'Banco do Brasil'),
  ('ECOPLAST', 'Bradesco', 'Bradesco'),
  ('ECOPLAST', 'Banco do Brasil', 'Banco do Brasil'),
  ('GAMMA', 'Bradesco', 'Bradesco'),
  ('LIMPE FÁCIL', 'Bradesco', 'Bradesco'),
  ('LIMPE FÁCIL', 'Cora', 'Cora'),
  ('MY CLEAN', 'Cora', 'Cora');

CREATE TABLE public.bank_balance_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  balance_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN -9007199254740991 AND 9007199254740991),
  observation text NOT NULL CHECK (length(btrim(observation)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, balance_date)
);
CREATE INDEX bank_positions_lookup ON public.bank_balance_positions(account_id, balance_date DESC);

CREATE TABLE public.stock_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  value_cents bigint NOT NULL CHECK (value_cents BETWEEN 0 AND 9007199254740991),
  reference_date date NOT NULL,
  observation text NOT NULL CHECK (length(btrim(observation)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX stock_positions_latest ON public.stock_positions(reference_date DESC, created_at DESC, id DESC);

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_balance_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_accounts_read ON public.bank_accounts FOR SELECT TO authenticated
  USING (cf_private.has_permission('caixa', 'read'));
CREATE POLICY bank_positions_read ON public.bank_balance_positions FOR SELECT TO authenticated
  USING (cf_private.has_permission('caixa', 'read'));
CREATE POLICY stock_positions_read ON public.stock_positions FOR SELECT TO authenticated
  USING (cf_private.has_permission('painel', 'read') OR cf_private.has_permission('resumo_diretoria', 'read'));

CREATE FUNCTION cf_private.audit_treasury() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor public.profiles%ROWTYPE; v_before jsonb; v_after jsonb;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = auth.uid();
  IF TG_OP <> 'INSERT' THEN v_before := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_after := to_jsonb(NEW); END IF;
  INSERT INTO public.audit_events(user_id, username, role_key, module, entity, record_id, action, before_value, after_value)
  VALUES (v_actor.id, v_actor.username, v_actor.role_key,
    CASE WHEN TG_TABLE_NAME = 'stock_positions' THEN 'estoque' ELSE 'caixa' END,
    TG_TABLE_NAME, coalesce(v_after->>'id', v_before->>'id'),
    CASE TG_OP WHEN 'INSERT' THEN 'CREATE' WHEN 'UPDATE' THEN 'UPDATE' ELSE 'DELETE' END,
    v_before, v_after);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_position_audit AFTER INSERT OR UPDATE OR DELETE ON public.bank_balance_positions
  FOR EACH ROW EXECUTE FUNCTION cf_private.audit_treasury();
CREATE TRIGGER stock_position_audit AFTER INSERT OR UPDATE OR DELETE ON public.stock_positions
  FOR EACH ROW EXECUTE FUNCTION cf_private.audit_treasury();

CREATE FUNCTION public.set_bank_balance(
  p_account_id uuid,
  p_balance_date date,
  p_amount_cents bigint,
  p_observation text,
  p_expected_updated_at timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_previous public.bank_balance_positions%ROWTYPE; v_id uuid;
BEGIN
  -- Compartilha o bloqueio da administração de perfis antes de verificar o perfil oficial.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('caixa', 'write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NULL OR p_balance_date IS NULL OR p_amount_cents IS NULL
    OR p_amount_cents NOT BETWEEN -9007199254740991 AND 9007199254740991
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe conta, data, valor em centavos e uma observação de até 1.000 caracteres.' USING ERRCODE = '23514';
  END IF;
  IF p_balance_date < DATE '1900-01-01' OR p_balance_date > (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'A data do saldo deve ser uma data passada ou a data de hoje em São Paulo.' USING ERRCODE = '23514';
  END IF;
  -- A conta serializa inclusive a primeira posição de uma data, evitando sobrescrita concorrente.
  PERFORM 1 FROM public.bank_accounts WHERE id = p_account_id AND enabled FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conta bancária indisponível.' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_previous FROM public.bank_balance_positions
    WHERE account_id = p_account_id AND balance_date = p_balance_date FOR UPDATE;
  IF FOUND THEN
    IF p_expected_updated_at IS NULL OR p_expected_updated_at IS DISTINCT FROM v_previous.updated_at THEN
      RAISE EXCEPTION 'O saldo foi alterado. Atualize a tela antes de salvar novamente.' USING ERRCODE = '40001';
    END IF;
    UPDATE public.bank_balance_positions
      SET amount_cents = p_amount_cents, observation = btrim(p_observation),
          updated_at = greatest(clock_timestamp(), v_previous.updated_at + interval '1 microsecond')
      WHERE id = v_previous.id RETURNING id INTO v_id;
  ELSE
    IF p_expected_updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'A posição informada não está mais disponível. Atualize a tela.' USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.bank_balance_positions(account_id, balance_date, amount_cents, observation, created_by)
      VALUES (p_account_id, p_balance_date, p_amount_cents, btrim(p_observation), auth.uid())
      RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.cash_position(p_as_of date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_details boolean; v_accounts jsonb; v_total numeric; v_reported integer; v_expected integer; v_latest date;
BEGIN
  v_details := cf_private.has_permission('caixa', 'read');
  IF NOT v_details AND NOT cf_private.has_permission('painel', 'read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
  END IF;
  IF p_as_of IS NULL OR p_as_of < DATE '1900-01-01' THEN
    RAISE EXCEPTION 'Informe uma data de referência válida.' USING ERRCODE = '23514';
  END IF;
  SELECT
    coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'company', a.company, 'bank', a.bank,
      'account_label', a.account_label, 'balance_date', p.balance_date,
      'amount_cents', p.amount_cents, 'updated_at', p.updated_at)
      ORDER BY a.company, a.bank, a.account_label, a.id), '[]'::jsonb),
    sum(p.amount_cents), count(p.id)::integer, count(a.id)::integer, max(p.balance_date)
  INTO v_accounts, v_total, v_reported, v_expected, v_latest
  FROM public.bank_accounts a
  LEFT JOIN LATERAL (
    SELECT b.id, b.balance_date, b.amount_cents, b.updated_at FROM public.bank_balance_positions b
    WHERE b.account_id = a.id AND b.balance_date <= p_as_of
    ORDER BY b.balance_date DESC LIMIT 1
  ) p ON true
  WHERE a.enabled;
  -- Um total seguro pode ocultar subtotais de empresas que se cancelam entre si.
  IF EXISTS (
    SELECT 1 FROM public.bank_accounts a
    JOIN LATERAL (
      SELECT b.amount_cents FROM public.bank_balance_positions b
      WHERE b.account_id = a.id AND b.balance_date <= p_as_of
      ORDER BY b.balance_date DESC LIMIT 1
    ) p ON true
    WHERE a.enabled GROUP BY a.company
    HAVING abs(sum(p.amount_cents)) > 9007199254740991
  ) THEN
    RAISE EXCEPTION 'O subtotal de uma empresa excede o limite seguro de representação.' USING ERRCODE = '22003';
  END IF;
  IF v_reported <> v_expected OR v_expected = 0 THEN v_total := NULL; END IF;
  IF v_total IS NOT NULL AND abs(v_total) > 9007199254740991 THEN
    RAISE EXCEPTION 'O saldo consolidado excede o limite seguro de representação.' USING ERRCODE = '22003';
  END IF;
  RETURN jsonb_build_object('accounts', CASE WHEN v_details THEN v_accounts ELSE '[]'::jsonb END,
    'total_cents', v_total, 'reported_accounts', v_reported, 'expected_accounts', v_expected,
    'latest_position_date', v_latest);
END;
$$;

CREATE FUNCTION public.save_manual_stock(p_value_cents bigint, p_reference_date date, p_observation text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501'; END IF;
  IF p_value_cents IS NULL OR p_value_cents NOT BETWEEN 0 AND 9007199254740991
    OR p_reference_date IS NULL OR p_reference_date < DATE '1900-01-01'
    OR p_reference_date > (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe valor não negativo em centavos, data de referência e uma observação de até 1.000 caracteres.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.stock_positions(value_cents, reference_date, observation, created_by)
    VALUES (p_value_cents, p_reference_date, btrim(p_observation), auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.current_stock() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_position public.stock_positions%ROWTYPE;
BEGIN
  IF NOT cf_private.has_permission('painel', 'read') AND NOT cf_private.has_permission('resumo_diretoria', 'read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_position FROM public.stock_positions
    WHERE reference_date <= (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    ORDER BY reference_date DESC, created_at DESC, id DESC LIMIT 1;
  RETURN jsonb_build_object('value_cents', v_position.value_cents,
    'reference_date', v_position.reference_date, 'source', CASE WHEN v_position.id IS NOT NULL THEN 'MANUAL' ELSE NULL END);
END;
$$;

REVOKE ALL ON TABLE public.bank_accounts, public.bank_balance_positions, public.stock_positions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.bank_accounts, public.bank_balance_positions, public.stock_positions TO authenticated;
REVOKE ALL ON FUNCTION cf_private.audit_treasury() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_bank_balance(uuid,date,bigint,text,timestamptz), public.cash_position(date),
  public.save_manual_stock(bigint,date,text), public.current_stock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_bank_balance(uuid,date,bigint,text,timestamptz), public.cash_position(date),
  public.save_manual_stock(bigint,date,text), public.current_stock() TO authenticated;

COMMENT ON TABLE public.bank_accounts IS 'Somente cadastro das contas oficiais. Saldo ausente deve permanecer desconhecido.';
COMMENT ON TABLE public.bank_balance_positions IS 'Posição manual por conta e data, em centavos inteiros. Alterações preservadas na auditoria imutável.';
COMMENT ON TABLE public.stock_positions IS 'Histórico manual de contingência; não existe integração automática ativa nesta versão.';
COMMENT ON FUNCTION public.cash_position(date) IS 'Consolidado somente com todas as contas ativas informadas. Detalhes exigem caixa.read; painel.read permite apenas o agregado.';

-- SOURCE: 007_director_positions.sql
-- After 005 and 006. Snapshots preserve incomplete sources explicitly.

CREATE TABLE public.director_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  indicators jsonb NOT NULL,
  schema_version text NOT NULL DEFAULT '0.3.0'
);
CREATE INDEX director_positions_created ON public.director_positions(created_at DESC);
ALTER TABLE public.director_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.director_positions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.director_positions TO authenticated;
CREATE POLICY director_positions_read ON public.director_positions FOR SELECT TO authenticated
  USING (cf_private.has_permission('resumo_diretoria','read'));

CREATE FUNCTION public.save_director_position(p_start date,p_end date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cash jsonb; v_payables jsonb; v_stock jsonb; v_data jsonb;
  v_id uuid; v_profile public.profiles%ROWTYPE;
BEGIN
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('resumo_diretoria','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>366 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  -- Consistent read of all implemented sources; values are computed on the
  -- server rather than accepting a financial position from the browser.
  PERFORM pg_advisory_xact_lock(2045812307);
  SELECT public.cash_position((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date),
         public.payables_summary(p_start,p_end), public.current_stock()
    INTO v_cash,v_payables,v_stock;
  v_data := jsonb_build_object(
    'cash_cents',v_cash->'total_cents',
    'cash_reported_accounts',v_cash->'reported_accounts',
    'cash_expected_accounts',v_cash->'expected_accounts',
    'cash_as_of_date',(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    'payable_open_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'open_cents' END,
    'payable_period_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'period_cents' END,
    'payable_overdue_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'overdue_cents' END,
    'payable_import_at',v_payables->'latest_import_at',
    'stock_cents',v_stock->'value_cents',
    'stock_reference_date',v_stock->'reference_date',
    'stock_source',v_stock->'source',
    'receivable_cents',NULL,'turnover_cents',NULL,'projected_cash_cents',NULL,
    'current_assets_millions',NULL,'complete',false,
    'missing_sources',jsonb_build_array('contas_receber','fechamento','parametros_financeiros')
  );
  INSERT INTO public.director_positions(created_by,period_start,period_end,indicators)
    VALUES(auth.uid(),p_start,p_end,v_data) RETURNING id INTO v_id;
  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_profile.id,v_profile.username,v_profile.role_key,'resumo_diretoria','director_positions',v_id::text,'CREATE',
      jsonb_build_object('period_start',p_start,'period_end',p_end,'indicators',v_data));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_director_position(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_director_position(date,date) TO authenticated;

-- Deployment records are independent from the website's code version.
CREATE TABLE public.central_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.central_schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_schema_migrations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.central_schema_migrations TO authenticated;
CREATE POLICY central_schema_migrations_read ON public.central_schema_migrations FOR SELECT TO authenticated
  USING (cf_private.is_manager());
INSERT INTO public.central_schema_migrations(version) VALUES ('005_payables'),('006_treasury'),('007_director_positions');

COMMIT;
