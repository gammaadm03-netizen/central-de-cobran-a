-- Importação de previsões incrementais e confirmação explícita de pagamentos.
-- Previsão não baixa ausências. Pagamento exige dados reais e quitação integral.
-- Incremental após 019; preserva títulos, arquivos e posições já registrados.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN RAISE EXCEPTION 'Ative as atualizações anteriores de Contas a Pagar.' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='019_payable_cheques') THEN RAISE EXCEPTION 'Ative a atualização 019 antes dos novos modos de importação.' USING ERRCODE='22023';END IF;
END $$;
-- O mesmo arquivo pode ter significado distinto por modo declarado. Não repetir
-- pagamentos no mesmo modo; conservar o contexto LEGACY dos arquivos anteriores.
ALTER TABLE public.payable_imports ADD COLUMN import_mode text NOT NULL DEFAULT 'LEGACY' CHECK(import_mode IN ('LEGACY','FORECAST','PAYMENTS'));
ALTER TABLE public.payable_imports DROP CONSTRAINT payable_imports_scope_file_sha256_key;
ALTER TABLE public.payable_imports ADD CONSTRAINT payable_imports_scope_hash_mode UNIQUE(scope,file_sha256,import_mode);
CREATE TABLE public.payable_import_modes(
 import_id uuid PRIMARY KEY REFERENCES public.payable_imports(id),mode text NOT NULL CHECK(mode IN ('FORECAST','PAYMENTS')),
 result jsonb NOT NULL,created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.payable_paid_import_rows(
 import_id uuid NOT NULL REFERENCES public.payable_imports(id),title_id uuid NOT NULL REFERENCES public.payable_titles(id),
 outcome text NOT NULL CHECK(outcome IN ('CREATED','MATCHED','CORRECTED')),payment_ids uuid[] NOT NULL,review_id uuid NOT NULL REFERENCES public.payable_title_reviews(id),
 source_row jsonb NOT NULL,PRIMARY KEY(import_id,title_id)
);
CREATE TABLE public.payable_paid_bank_mappings(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),mapping_key text NOT NULL,branch text NOT NULL,paid_bank text NOT NULL,
 bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id),created_by uuid NOT NULL REFERENCES public.profiles(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_paid_bank_mappings_latest ON public.payable_paid_bank_mappings(mapping_key,created_at DESC,id DESC);
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['payable_import_modes','payable_paid_import_rows','payable_paid_bank_mappings'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated',v_table);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING(cf_private.has_permission(''contas_pagar'',''read'') OR cf_private.has_permission(''contas_pagar'',''import''))',v_table||'_read',v_table);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_closing_history()',v_table||'_immutable',v_table);
 END LOOP;
END $$;
CREATE FUNCTION cf_private.audit_payable_import_mode() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;BEGIN
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
  VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar',TG_TABLE_NAME,coalesce(to_jsonb(NEW)->>'id',to_jsonb(NEW)->>'import_id'),'IMPORT',to_jsonb(NEW));RETURN NEW;
END $$;
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['payable_import_modes','payable_paid_import_rows','payable_paid_bank_mappings'] LOOP
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_import_mode()',v_table||'_audit',v_table);
 END LOOP;
END $$;

CREATE FUNCTION public.preview_payables_forecast_import(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_previous uuid;v_new integer;v_open integer;v_changed integer;BEGIN
 IF NOT cf_private.has_permission('contas_pagar','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 v_rows:=cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,p_rows));
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE upper(btrim(coalesce(r->>'source_status',''))) IN ('PAGO','PAGA','PAGOS','QUITADO','QUITADA','CANCELADO','CANCELADA','ESTORNADO','ESTORNADA')) THEN RAISE EXCEPTION 'Use o modo de pagamentos para títulos pagos; previsão aceita somente obrigações em aberto e cheques.' USING ERRCODE='22023';END IF;
 SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL),count(*) FILTER(WHERE r->>'title_id' IS NOT NULL),count(*) FILTER(WHERE coalesce((r->>'changed')::boolean,false))
  INTO v_new,v_open,v_changed FROM jsonb_array_elements(v_rows) r;
 RETURN jsonb_build_object('mode','forecast','previous_import_id',v_previous,'row_count',jsonb_array_length(v_rows),'new_count',v_new,'open_count',v_open,'changed_count',v_changed,'settled_count',0);
END $$;

CREATE FUNCTION cf_private.commit_payables_forecast_import(
 p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_mappings jsonb,
 p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rows jsonb; v_previous uuid; v_id uuid:=gen_random_uuid(); v_new integer; v_open integer; v_settled integer;
  v_changed integer; v_file bytea; v_mappings jsonb:='{}'::jsonb; v_mapping record; v_plan text;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  v_rows:=cf_private.validate_payable_identity_rows(p_scope,p_rows);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE upper(btrim(coalesce(r->>'source_status',''))) IN ('PAGO','PAGA','PAGOS','QUITADO','QUITADA','CANCELADO','CANCELADA','ESTORNADO','ESTORNADA')) THEN RAISE EXCEPTION 'Use o modo de pagamentos para títulos pagos; previsão aceita somente obrigações em aberto e cheques.' USING ERRCODE='22023';END IF;
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
  IF EXISTS(SELECT 1 FROM public.payable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256 AND import_mode='FORECAST') THEN
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
  -- O mesmo lock usado pelos pagamentos serializa a importação e a conciliação.
  -- As linhas financeiras permanecem vinculadas ao UUID; a fonte não as reescreve.
  PERFORM 1 FROM public.payable_titles t WHERE t.scope=p_scope AND
    (t.status<>'SETTLED_IMPORT' OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r
      WHERE r->>'source_key'=cf_private.payable_business_key(t.branch,t.entry_number)))
    ORDER BY t.id FOR UPDATE;
  v_rows:=cf_private.resolve_payable_identity_rows(p_scope,v_rows);
  SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL),count(*) FILTER(WHERE r->>'title_id' IS NOT NULL),
    count(*) FILTER(WHERE coalesce((r->>'changed')::boolean,false)) INTO v_new,v_open,v_changed
    FROM jsonb_array_elements(v_rows) r;
  v_settled:=0;
  INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode)
    VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),v_new,v_open,v_settled,'FORECAST');
  INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
  INSERT INTO public.payable_plan_mappings(plan,macro)
    SELECT key,value#>>'{}' FROM jsonb_each(v_mappings)
    ON CONFLICT(plan) DO UPDATE SET macro=EXCLUDED.macro,updated_at=clock_timestamp()
      WHERE payable_plan_mappings.macro IS DISTINCT FROM EXCLUDED.macro;
  -- Atualiza a identidade existente, inclusive vencimento/valor/conta de origem.
  -- first_import_id e UUID não mudam; o trigger anterior guarda antes/depois.
  UPDATE public.payable_titles t SET
      source_key=r.source_key,entry_number=r.entry_number,description=r.description,due_date=r.due_date,
      amount_cents=r.amount_cents,source_status=r.source_status,plan=r.plan,
      bank_account=r.bank_account,branch=r.branch,issued_on=r.issued_on,macro=m.macro,
      status='OPEN',last_import_id=v_id,settled_at=NULL,cheque_number=CASE WHEN r.cheque_present THEN r.cheque_number ELSE t.cheque_number END
    FROM jsonb_to_recordset((SELECT jsonb_agg(item||jsonb_build_object('cheque_present',item ? 'cheque_number')) FROM jsonb_array_elements(v_rows) item)) AS r(title_id uuid,source_key text,entry_number text,description text,due_date date,
      amount_cents bigint,source_status text,plan text,bank_account text,branch text,issued_on date,cheque_number text,cheque_present boolean)
    JOIN public.payable_plan_mappings m ON m.plan=r.plan WHERE t.id=r.title_id AND t.scope=p_scope;
  INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,source_status,
    plan,bank_account,branch,issued_on,macro,status,first_import_id,last_import_id,settled_at,cheque_number)
    SELECT p_scope,r.source_key,r.entry_number,r.description,r.due_date,r.amount_cents,r.source_status,
      r.plan,r.bank_account,r.branch,r.issued_on,m.macro,'NEW',v_id,v_id,NULL,r.cheque_number
    FROM jsonb_to_recordset(v_rows) AS r(title_id uuid,source_key text,entry_number text,description text,due_date date,
      amount_cents bigint,source_status text,plan text,bank_account text,branch text,issued_on date,cheque_number text)
    JOIN public.payable_plan_mappings m ON m.plan=r.plan WHERE r.title_id IS NULL;
  INSERT INTO cf_private.payable_identity_registry(scope,business_key,title_id,created_by)
    SELECT p_scope,r->>'source_key',t.id,auth.uid() FROM jsonb_array_elements(v_rows) r
    JOIN public.payable_titles t ON t.scope=p_scope AND t.source_key=r->>'source_key'
    WHERE NOT EXISTS(SELECT 1 FROM cf_private.payable_identity_registry i
      WHERE i.scope=p_scope AND i.business_key=r->>'source_key');
  RETURN jsonb_build_object('mode','forecast','import_id',v_id,'new_count',v_new,'open_count',v_open,
    'settled_count',v_settled,'changed_count',v_changed,'row_count',jsonb_array_length(v_rows));
END;
$$;

CREATE FUNCTION public.commit_payables_forecast_import_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,
 p_file_base64 text,p_rows jsonb,p_mappings jsonb,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_result jsonb;BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_session_id !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT cf_private.has_permission('contas_pagar','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 v_result:=cf_private.commit_payables_forecast_import(p_scope,p_file_name,p_file_sha256,p_file_base64,p_rows,p_mappings,p_previous_import_id);
 INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES((v_result->>'import_id')::uuid,'FORECAST',v_result,auth.uid());RETURN v_result;
END $$;

CREATE FUNCTION cf_private.payable_paid_bank_key(p_branch text,p_paid_bank text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT jsonb_build_array(upper(btrim(regexp_replace(p_branch,'[[:space:]]+',' ','g'))),upper(btrim(regexp_replace(p_paid_bank,'[[:space:]]+',' ','g'))))::text;
$$;
CREATE FUNCTION cf_private.normalize_payable_paid_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_rows jsonb[]:=ARRAY[]::jsonb[];v_line integer:=0;v_date date;v_amount numeric;v_total numeric:=0;v_field text;
BEGIN
 IF p_scope IS DISTINCT FROM 'grupo-consolidado' OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Informe de 1 a 5.000 títulos explicitamente pagos do grupo consolidado.' USING ERRCODE='22023';END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  v_line:=v_line+1;
  IF jsonb_typeof(v_row)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN('branch','entry_number','source_status','paid_on','amount_paid_cents','paid_bank','cheque_number','description','plan','issued_on')) THEN
   RAISE EXCEPTION 'Linha %: estrutura inválida para confirmação de pagamentos.',v_line USING ERRCODE='22023';END IF;
  FOREACH v_field IN ARRAY ARRAY['branch','entry_number','paid_bank','paid_on','source_status'] LOOP
   IF jsonb_typeof(v_row->v_field) IS DISTINCT FROM 'string' OR length(btrim(v_row->>v_field))=0 OR v_row->>v_field ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Linha %: % deve ser informado explicitamente.',v_line,v_field USING ERRCODE='22023';END IF;
  END LOOP;
  IF length(v_row->>'branch')>150 OR length(v_row->>'entry_number')>150 OR length(v_row->>'paid_bank')>300 OR upper(btrim(v_row->>'source_status'))<>'PAGO' THEN
   RAISE EXCEPTION 'Linha %: confirme que o título está pago e confira os limites de identificação/banco.',v_line USING ERRCODE='22023';END IF;
  IF jsonb_typeof(v_row->'amount_paid_cents') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Linha %: informe o valor real pago em centavos inteiros.',v_line USING ERRCODE='22023';END IF;
  v_amount:=(v_row->>'amount_paid_cents')::numeric;
  IF v_amount<>trunc(v_amount) OR v_amount NOT BETWEEN 1 AND 9007199254740991 THEN RAISE EXCEPTION 'Linha %: valor real pago inválido.',v_line USING ERRCODE='22023';END IF;
  v_total:=v_total+v_amount;IF v_total>9007199254740991 THEN RAISE EXCEPTION 'O valor pago do relatório excede o limite de precisão.' USING ERRCODE='22003';END IF;
  IF v_row->>'paid_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Linha %: informe a data real do pagamento em AAAA-MM-DD.',v_line USING ERRCODE='22023';END IF;
  BEGIN v_date:=(v_row->>'paid_on')::date;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Linha %: data real do pagamento inválida.',v_line USING ERRCODE='22023';END;
  IF v_date<DATE '1900-01-01' OR v_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN RAISE EXCEPTION 'Linha %: informe uma data real de pagamento até hoje.',v_line USING ERRCODE='22023';END IF;
  IF v_row ? 'cheque_number' AND (jsonb_typeof(v_row->'cheque_number') NOT IN('string','null') OR length(coalesce(v_row->>'cheque_number',''))>150 OR coalesce(v_row->>'cheque_number','') ~ '[[:cntrl:]]') THEN
   RAISE EXCEPTION 'Linha %: número de cheque inválido.',v_line USING ERRCODE='22023';END IF;
  IF v_row ? 'description' AND (jsonb_typeof(v_row->'description') IS DISTINCT FROM 'string' OR length(btrim(v_row->>'description')) NOT BETWEEN 1 AND 1500) THEN RAISE EXCEPTION 'Linha %: favorecido/histórico inválido.',v_line USING ERRCODE='22023';END IF;
  IF v_row ? 'plan' AND (jsonb_typeof(v_row->'plan') IS DISTINCT FROM 'string' OR length(btrim(v_row->>'plan')) NOT BETWEEN 1 AND 300) THEN RAISE EXCEPTION 'Linha %: plano de contas inválido.',v_line USING ERRCODE='22023';END IF;
  IF v_row ? 'issued_on' AND jsonb_typeof(v_row->'issued_on') NOT IN ('string','null') THEN RAISE EXCEPTION 'Linha %: emissão inválida.',v_line USING ERRCODE='22023';END IF;
  IF coalesce(v_row->>'issued_on','')<>'' THEN
   IF v_row->>'issued_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Linha %: emissão deve usar AAAA-MM-DD.',v_line USING ERRCODE='22023';END IF;
   BEGIN PERFORM (v_row->>'issued_on')::date;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Linha %: emissão inválida.',v_line USING ERRCODE='22023';END;
  END IF;
  v_row:=jsonb_build_object('line',v_line,'branch',btrim(regexp_replace(v_row->>'branch','[[:space:]]+',' ','g')),
   'entry_number',btrim(regexp_replace(v_row->>'entry_number','[[:space:]]+',' ','g')),'source_status','PAGO','paid_on',v_date,
   'amount_paid_cents',v_amount::bigint,'paid_bank',btrim(regexp_replace(v_row->>'paid_bank','[[:space:]]+',' ','g')))
   ||CASE WHEN v_row ? 'cheque_number' THEN jsonb_build_object('cheque_number',nullif(btrim(v_row->>'cheque_number'),'')) ELSE '{}'::jsonb END
   ||CASE WHEN v_row ? 'description' THEN jsonb_build_object('description',btrim(v_row->>'description')) ELSE '{}'::jsonb END
   ||CASE WHEN v_row ? 'plan' THEN jsonb_build_object('plan',cf_private.normalize_payable_plan(v_row->>'plan')) ELSE '{}'::jsonb END
   ||CASE WHEN v_row ? 'issued_on' THEN jsonb_build_object('issued_on',nullif(v_row->>'issued_on','')::date) ELSE '{}'::jsonb END;
  v_row:=v_row||jsonb_build_object('business_key',cf_private.payable_business_key(v_row->>'branch',v_row->>'entry_number'),
   'bank_mapping_key',cf_private.payable_paid_bank_key(v_row->>'branch',v_row->>'paid_bank'));
  v_rows:=array_append(v_rows,v_row);
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(to_jsonb(v_rows)) r GROUP BY r->>'business_key' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Há mais de uma linha paga para a mesma filial e lançamento. Confira o relatório; nenhuma baixa foi registrada.' USING ERRCODE='P0016';END IF;
 RETURN to_jsonb(v_rows);
END $$;
CREATE FUNCTION cf_private.normalize_payable_paid_mappings(p_rows jsonb,p_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_mapping record;v_id uuid;BEGIN
 IF p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'object' OR octet_length(p_mappings::text)>2000000 THEN RAISE EXCEPTION 'Informe os vínculos explícitos de bancos.' USING ERRCODE='22023';END IF;
 FOR v_mapping IN SELECT key,value FROM jsonb_each(p_mappings) LOOP
  IF jsonb_typeof(v_mapping.value)<>'string' OR v_mapping.value#>>'{}' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE r->>'bank_mapping_key'=v_mapping.key) THEN
   RAISE EXCEPTION 'O vínculo deve corresponder a uma filial/banco deste relatório e a uma conta oficial.' USING ERRCODE='22023';END IF;
  v_id:=(v_mapping.value#>>'{}')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=v_id AND enabled) THEN RAISE EXCEPTION 'Selecione uma conta oficial ativa para o pagamento.' USING ERRCODE='22023';END IF;
 END LOOP;RETURN p_mappings;
END $$;
CREATE FUNCTION cf_private.normalize_payable_paid_plans(p_rows jsonb,p_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_mapping record;v_plan text;v_result jsonb:='{}'::jsonb;BEGIN
 IF p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'object' OR octet_length(p_mappings::text)>2000000 THEN RAISE EXCEPTION 'Informe as classificações dos planos de contas.' USING ERRCODE='22023';END IF;
 FOR v_mapping IN SELECT key,value FROM jsonb_each(p_mappings) LOOP
  v_plan:=cf_private.normalize_payable_plan(v_mapping.key);
  IF length(v_mapping.key)>300 OR length(v_plan) NOT BETWEEN 1 AND 300 OR jsonb_typeof(v_mapping.value)<>'string'
   OR NOT EXISTS(SELECT 1 FROM public.payable_macros WHERE name=v_mapping.value#>>'{}')
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE r->>'plan'=v_plan) OR v_result ? v_plan THEN
   RAISE EXCEPTION 'Classifique somente planos encontrados neste relatório com um macro oficial.' USING ERRCODE='22023';END IF;
  v_result:=v_result||jsonb_build_object(v_plan,v_mapping.value#>>'{}');
 END LOOP;RETURN v_result;
END $$;
CREATE FUNCTION cf_private.preview_payable_paid_rows(p_rows jsonb,p_mappings jsonb,p_plan_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_title public.payable_review_titles%ROWTYPE;v_id uuid;v_bank uuid;v_registered uuid;v_bank_count integer;v_total integer;v_active integer;
 v_paid numeric;v_dates boolean;v_banks boolean;v_macro boolean;v_owned boolean;v_cheque boolean;v_ids uuid[];v_problem text;v_outcome text;v_column text;
 v_rows jsonb[]:=ARRAY[]::jsonb[];v_errors jsonb[]:=ARRAY[]::jsonb[];v_unmapped jsonb;v_options jsonb;v_plans jsonb;v_macros jsonb;v_target_macro text;v_override public.payable_title_macro_overrides%ROWTYPE;v_new integer:=0;v_matched integer:=0;v_correct integer:=0;
BEGIN
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  v_id:=NULL;v_bank:=NULL;v_registered:=NULL;v_problem:='';v_outcome:='';v_column:='Lançamento';v_ids:=ARRAY[]::uuid[];v_target_macro:=NULL;
  IF p_mappings ? (v_row->>'bank_mapping_key') THEN v_bank:=(p_mappings->>(v_row->>'bank_mapping_key'))::uuid;
  ELSE
   SELECT m.bank_account_id INTO v_bank FROM public.payable_paid_bank_mappings m WHERE m.mapping_key=v_row->>'bank_mapping_key' ORDER BY created_at DESC,id DESC LIMIT 1;
   IF FOUND THEN IF NOT EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=v_bank AND enabled) THEN v_bank:=NULL;END IF;
   ELSE
    SELECT count(*)::integer,(array_agg(id ORDER BY id))[1] INTO v_bank_count,v_bank FROM public.bank_accounts
     WHERE enabled AND upper(btrim(regexp_replace(display_name,'[[:space:]]+',' ','g')))=upper(v_row->>'paid_bank');
    IF v_bank_count<>1 THEN v_bank:=NULL;END IF;
   END IF;
  END IF;
  SELECT title_id INTO v_registered FROM cf_private.payable_identity_registry WHERE scope='grupo-consolidado' AND business_key=v_row->>'business_key';
  SELECT count(*)::integer,count(*) FILTER(WHERE status<>'SETTLED_IMPORT')::integer INTO v_total,v_active FROM public.payable_titles
   WHERE scope='grupo-consolidado' AND cf_private.payable_business_key(branch,entry_number)=v_row->>'business_key';
  IF v_registered IS NOT NULL THEN v_id:=v_registered;
  ELSIF v_active=1 THEN SELECT id INTO v_id FROM public.payable_titles WHERE scope='grupo-consolidado' AND status<>'SETTLED_IMPORT' AND cf_private.payable_business_key(branch,entry_number)=v_row->>'business_key';
  ELSIF v_total=1 THEN SELECT id INTO v_id FROM public.payable_titles WHERE scope='grupo-consolidado' AND cf_private.payable_business_key(branch,entry_number)=v_row->>'business_key';END IF;
  IF v_id IS NULL THEN
   v_outcome:=CASE WHEN v_total=0 THEN 'UNKNOWN_TITLE' ELSE 'CONFLICT' END;
   v_problem:=CASE WHEN v_total=0 THEN 'Título não encontrado. Importe ou corrija primeiro a base de previsões.' ELSE 'Há versões históricas ambíguas da mesma filial e lançamento. Confira a identidade antes de confirmar.' END;
  ELSE
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_id;
   v_target_macro:=v_title.macro;
   IF v_row ? 'plan' THEN
    v_target_macro:=p_plan_mappings->>(v_row->>'plan');
    IF v_target_macro IS NULL THEN SELECT macro INTO v_target_macro FROM public.payable_plan_mappings WHERE plan=v_row->>'plan';END IF;
    IF v_row->>'plan'=v_title.plan AND v_target_macro IS NOT NULL THEN
     SELECT * INTO v_override FROM public.payable_title_macro_overrides WHERE title_id=v_id ORDER BY created_at DESC,id DESC LIMIT 1;
     IF v_override.active AND v_override.plan=v_title.plan THEN v_target_macro:=v_override.macro;END IF;
    END IF;
   END IF;
   IF NOT v_title.closing_eligible OR v_active>1 OR EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.id<>v_id AND t.scope='grupo-consolidado'
    AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'business_key' AND (t.status<>'SETTLED_IMPORT' OR EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=t.id
     AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)))) THEN
    v_outcome:='CONFLICT';v_problem:='A identidade possui outra versão ativa ou pagamentos em outro título. Nenhum registro será mesclado.';
   ELSIF v_target_macro IS NULL THEN v_outcome:='UNCLASSIFIED_PLAN';v_column:='Plano de Contas';v_problem:='Plano NÃO CLASSIFICADO. Escolha explicitamente o macro antes de confirmar.';
   ELSIF v_bank IS NULL THEN
    v_outcome:='UNMAPPED_BANK';v_column:='Banco do pagamento';v_problem:='Vincule explicitamente esta filial/banco a uma conta oficial ativa.';
   ELSE
    SELECT coalesce(sum(p.amount_cents),0),coalesce(bool_and(p.paid_on=(v_row->>'paid_on')::date),false),coalesce(bool_and(p.bank_account_id=v_bank),false),
     coalesce(bool_and(p.effective_macro=v_target_macro),false),coalesce(array_agg(p.id ORDER BY p.event_revision),'{}'::uuid[]),
     coalesce(bool_and(CASE WHEN v_row ? 'cheque_number' THEN p.cheque_number IS NOT DISTINCT FROM v_row->>'cheque_number' ELSE true END),true),
     coalesce(bool_and(EXISTS(SELECT 1 FROM public.payable_paid_import_rows own WHERE own.outcome IN ('CREATED','CORRECTED') AND p.id=ANY(own.payment_ids))),false)
     INTO v_paid,v_dates,v_banks,v_macro,v_ids,v_cheque,v_owned FROM public.payable_effective_payments p WHERE p.title_id=v_id
      AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id);
    IF v_paid=0 THEN v_outcome:='NEW_PAYMENT';v_new:=v_new+1;
    ELSIF NOT v_macro AND NOT v_owned THEN v_outcome:='CONFLICT';v_column:='Centro de Custo Macro';v_problem:='O macro dos pagamentos manuais diverge do plano atual. Confira e reclassifique explicitamente antes de importar.';
    ELSIF v_paid=(v_row->>'amount_paid_cents')::bigint AND v_dates AND v_banks AND v_macro AND v_cheque THEN v_outcome:='MATCHED';v_matched:=v_matched+1;
    ELSIF v_owned THEN v_outcome:='CORRECTION';v_correct:=v_correct+1;
    ELSE v_outcome:='CONFLICT';v_problem:='Já existem pagamentos manuais com valor, data, banco ou cheque diferentes. Confira o histórico e corrija explicitamente; a importação não os substituirá.';END IF;
   END IF;
  END IF;
  v_row:=v_row||jsonb_build_object('title_id',v_id,'title_amount_cents',CASE WHEN v_id IS NULL THEN NULL ELSE v_title.amount_cents END,
   'forecast_due_date',CASE WHEN v_id IS NULL THEN NULL ELSE v_title.due_date END,'target_macro',v_target_macro,
   'previous_amount_cents',CASE WHEN v_id IS NULL THEN NULL ELSE v_title.amount_cents END,'updated_amount_cents',(v_row->>'amount_paid_cents')::bigint,
   'amount_changed',v_id IS NOT NULL AND v_title.amount_cents<>(v_row->>'amount_paid_cents')::bigint,'bank_account_id',v_bank,'outcome',v_outcome,'payment_ids',to_jsonb(v_ids),'problem',v_problem);
  v_rows:=array_append(v_rows,v_row);
  IF v_problem<>'' THEN v_errors:=array_append(v_errors,jsonb_build_object('line',(v_row->>'line')::integer,'column',v_column,'problem',v_problem,'correction',
   CASE WHEN v_outcome='UNMAPPED_BANK' THEN 'Selecione a conta oficial e gere uma nova análise.' ELSE 'Corrija os dados ou o histórico do título e gere uma nova análise.' END));END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'branch',branch,'paid_bank',paid_bank,'count',n) ORDER BY key),'[]'::jsonb) INTO v_unmapped FROM(
  SELECT r->>'bank_mapping_key' key,min(r->>'branch') branch,min(r->>'paid_bank') paid_bank,count(*) n FROM jsonb_array_elements(to_jsonb(v_rows)) r WHERE r->>'bank_account_id' IS NULL GROUP BY r->>'bank_mapping_key') x;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'company',company,'bank',bank,'display_name',display_name,'account_type',account_type) ORDER BY display_name,id),'[]'::jsonb) INTO v_options FROM public.bank_accounts WHERE enabled;
 SELECT coalesce(jsonb_agg(jsonb_build_object('plan',plan,'count',n,'total_cents',total_cents) ORDER BY plan),'[]'::jsonb) INTO v_plans FROM(
  SELECT r->>'plan' plan,count(*) n,sum((r->>'amount_paid_cents')::numeric) total_cents FROM jsonb_array_elements(to_jsonb(v_rows)) r WHERE r->>'outcome'='UNCLASSIFIED_PLAN' GROUP BY r->>'plan') x;
 SELECT jsonb_agg(name ORDER BY name) INTO v_macros FROM public.payable_macros;
 RETURN jsonb_build_object('mode','payments','rows',to_jsonb(v_rows),'row_count',jsonb_array_length(p_rows),'new_payment_count',v_new,'matched_payment_count',v_matched,
  'correction_count',v_correct,'conflict_count',cardinality(v_errors),'errors',to_jsonb(v_errors),'unmapped_banks',v_unmapped,'bank_options',v_options,
  'can_commit',cardinality(v_errors)=0,'unclassified_plans',v_plans,'macros',v_macros);
END $$;
CREATE FUNCTION public.preview_payables_paid_import(p_scope text,p_rows jsonb,p_bank_mappings jsonb DEFAULT '{}'::jsonb,p_mappings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_rows jsonb;v_mappings jsonb;v_plans jsonb;v_previous uuid;v_result jsonb;BEGIN
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','import') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 v_rows:=cf_private.normalize_payable_paid_rows(p_scope,p_rows);v_mappings:=cf_private.normalize_payable_paid_mappings(v_rows,p_bank_mappings);v_plans:=cf_private.normalize_payable_paid_plans(v_rows,p_mappings);
 v_result:=cf_private.preview_payable_paid_rows(v_rows,v_mappings,v_plans);RETURN v_result||jsonb_build_object('previous_import_id',v_previous,'financial_revision',public.get_payables_revision()->>'financial_revision');
END $$;
CREATE FUNCTION public.commit_payables_paid_import_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,
 p_file_base64 text,p_rows jsonb,p_bank_mappings jsonb,p_previous_import_id uuid DEFAULT NULL,p_confirm_corrections boolean DEFAULT false,p_mappings jsonb DEFAULT '{}'::jsonb,p_previous_financial_revision text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_mappings jsonb;v_plans jsonb;v_preview jsonb;v_row jsonb;v_file bytea;v_previous uuid;v_id uuid:=gen_random_uuid();v_existing uuid;v_existing_mode text;
 v_result jsonb;v_title public.payable_review_titles%ROWTYPE;v_payment uuid;v_payments uuid[];v_review uuid;v_mapping record;v_current_mapping uuid;
 v_new integer:=0;v_matched integer:=0;v_correct integer:=0;v_observation text;v_source jsonb;v_outcome text;
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_session_id !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','import') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_confirm_corrections IS NULL OR p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 250 OR p_file_name ~ '[/\\[:cntrl:]]'
  OR p_file_sha256 IS NULL OR p_file_sha256 !~ '^[a-f0-9]{64}$' OR p_file_base64 IS NULL OR length(p_file_base64) NOT BETWEEN 1 AND 2796204 THEN
  RAISE EXCEPTION 'Metadados do relatório de pagamentos inválidos.' USING ERRCODE='22023';END IF;
 BEGIN v_file:=decode(p_file_base64,'base64');EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN RAISE EXCEPTION 'Arquivo original inválido.' USING ERRCODE='22023';END;
 IF octet_length(v_file) NOT BETWEEN 1 AND 2097152 OR encode(sha256(v_file),'hex')<>p_file_sha256 THEN RAISE EXCEPTION 'A integridade do arquivo original não foi confirmada.' USING ERRCODE='22023';END IF;
 v_rows:=cf_private.normalize_payable_paid_rows(p_scope,p_rows);
 PERFORM pg_advisory_xact_lock(2045812305,hashtext(p_scope));
 SELECT i.id,m.mode,m.result INTO v_existing,v_existing_mode,v_result FROM public.payable_imports i LEFT JOIN public.payable_import_modes m ON m.import_id=i.id
  WHERE i.scope=p_scope AND i.file_sha256=p_file_sha256 AND i.import_mode='PAYMENTS';
 IF v_existing IS NOT NULL THEN
  IF v_existing_mode='PAYMENTS' THEN RETURN v_result||jsonb_build_object('idempotent',true);END IF;
  RAISE EXCEPTION 'Este arquivo já foi registrado em outro modo de importação.' USING ERRCODE='23505';END IF;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN RAISE EXCEPTION 'A base mudou. Gere nova análise antes de confirmar os pagamentos.' USING ERRCODE='40001';END IF;
 v_mappings:=cf_private.normalize_payable_paid_mappings(v_rows,p_bank_mappings);v_plans:=cf_private.normalize_payable_paid_plans(v_rows,p_mappings);
 IF p_previous_financial_revision IS NULL OR p_previous_financial_revision IS DISTINCT FROM public.get_payables_revision()->>'financial_revision' THEN RAISE EXCEPTION 'Os dados financeiros mudaram. Gere nova análise antes de confirmar os pagamentos.' USING ERRCODE='40001';END IF;
 v_preview:=cf_private.preview_payable_paid_rows(v_rows,v_mappings,v_plans);
 IF NOT coalesce((v_preview->>'can_commit')::boolean,false) THEN
  RAISE EXCEPTION 'A importação de pagamentos possui pendências. Confira valores, datas, identidades e vínculos bancários; nenhum dado foi alterado.' USING ERRCODE='P0021',DETAIL=(v_preview->'errors')::text;END IF;
 IF (v_preview->>'correction_count')::integer>0 AND NOT p_confirm_corrections THEN
  RAISE EXCEPTION 'Confirme expressamente os estornos e a substituição dos pagamentos originados em importações anteriores.' USING ERRCODE='P0021';END IF;
 INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode)
  VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),0,jsonb_array_length(v_rows),0,'PAYMENTS');
 INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
 INSERT INTO public.payable_plan_mappings(plan,macro) SELECT key,value#>>'{}' FROM jsonb_each(v_plans)
  ON CONFLICT(plan) DO UPDATE SET macro=EXCLUDED.macro,updated_at=clock_timestamp() WHERE payable_plan_mappings.macro IS DISTINCT FROM EXCLUDED.macro;
 FOR v_mapping IN SELECT key,value FROM jsonb_each(v_mappings) LOOP
  SELECT bank_account_id INTO v_current_mapping FROM public.payable_paid_bank_mappings WHERE mapping_key=v_mapping.key ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_current_mapping IS DISTINCT FROM (v_mapping.value#>>'{}')::uuid THEN
   SELECT r INTO v_source FROM jsonb_array_elements(v_rows) r WHERE r->>'bank_mapping_key'=v_mapping.key LIMIT 1;
   INSERT INTO public.payable_paid_bank_mappings(mapping_key,branch,paid_bank,bank_account_id,created_by,created_at)
    SELECT v_mapping.key,v_source->>'branch',v_source->>'paid_bank',(v_mapping.value#>>'{}')::uuid,auth.uid(),
     greatest(clock_timestamp(),coalesce(max(created_at),'1900-01-01'::timestamptz)+interval '1 microsecond') FROM public.payable_paid_bank_mappings WHERE mapping_key=v_mapping.key;
  END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_preview->'rows') LOOP
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_row->>'title_id')::uuid;
  v_outcome:=v_row->>'outcome';v_payments:=ARRAY[]::uuid[];
  UPDATE public.payable_titles SET amount_cents=(v_row->>'amount_paid_cents')::bigint,description=CASE WHEN v_row ? 'description' THEN v_row->>'description' ELSE description END,
   plan=CASE WHEN v_row ? 'plan' THEN v_row->>'plan' ELSE plan END,macro=v_row->>'target_macro',
   issued_on=CASE WHEN v_row ? 'issued_on' THEN (v_row->>'issued_on')::date ELSE issued_on END,bank_account=v_row->>'paid_bank',
   cheque_number=CASE WHEN v_row ? 'cheque_number' THEN v_row->>'cheque_number' ELSE cheque_number END,last_import_id=v_id WHERE id=v_title.id;
  IF v_outcome='CORRECTION' THEN
   FOR v_payment IN SELECT value::uuid FROM jsonb_array_elements_text(v_row->'payment_ids') LOOP
    SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
    PERFORM public.cancel_payable_payment(v_payment,'Correção expressamente confirmada por relatório de pagamentos. Importação '||v_id::text,v_title.payment_revision);
   END LOOP;
  END IF;
  IF v_outcome IN ('NEW_PAYMENT','CORRECTION') THEN
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
   v_observation:='Pagamento integral informado em relatório de títulos pagos. Importação '||v_id::text;
   v_payment:=public.register_payable_payment(v_title.id,(v_row->>'amount_paid_cents')::bigint,(v_row->>'paid_on')::date,
    (v_row->>'bank_account_id')::uuid,v_observation,v_title.payment_revision,gen_random_uuid(),v_title.last_import_id);
   v_payments:=ARRAY[v_payment];
   IF v_outcome='CORRECTION' THEN v_correct:=v_correct+1;ELSE v_new:=v_new+1;END IF;
  ELSE SELECT coalesce(array_agg(value::uuid),'{}'::uuid[]) INTO v_payments FROM jsonb_array_elements_text(v_row->'payment_ids');v_matched:=v_matched+1;END IF;
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
  v_review:=public.review_payable_title(v_title.id,'Conciliação automática por relatório explícito de títulos pagos. Importação '||v_id::text,v_title.review_fingerprint);
  INSERT INTO public.payable_paid_import_rows(import_id,title_id,outcome,payment_ids,review_id,source_row)
   VALUES(v_id,v_title.id,CASE WHEN v_outcome='NEW_PAYMENT' THEN 'CREATED' WHEN v_outcome='CORRECTION' THEN 'CORRECTED' ELSE 'MATCHED' END,v_payments,v_review,v_row);
 END LOOP;
 v_result:=jsonb_build_object('mode','payments','import_id',v_id,'row_count',jsonb_array_length(v_rows),'new_payment_count',v_new,'matched_payment_count',v_matched,
  'correction_count',v_correct,'reviewed_count',jsonb_array_length(v_rows),'settled_count',0,'idempotent',false);
 INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES(v_id,'PAYMENTS',v_result,auth.uid());RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.payables_import_capabilities() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('contas_pagar','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('schema_version','021_payable_paid_import','cheque_number',true,'forecast_incremental',true,'paid_import',true);
END $$;
-- Compatibilidade segura: clientes antigos também deixam de baixar ausências.
-- A declaração antiga de relatório completo permanece exigida, mas não cria baixa.
CREATE OR REPLACE FUNCTION public.preview_payables_import(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 RETURN public.preview_payables_forecast_import(p_scope,p_rows);
END $$;
CREATE OR REPLACE FUNCTION public.commit_payables_import(p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_mappings jsonb,
 p_complete boolean,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_result jsonb;BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT cf_private.has_permission('contas_pagar','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_complete IS DISTINCT FROM true THEN RAISE EXCEPTION 'Confirme o relatório antes de concluir a importação.' USING ERRCODE='22023';END IF;
 v_result:=cf_private.commit_payables_forecast_import(p_scope,p_file_name,p_file_sha256,p_file_base64,p_rows,p_mappings,p_previous_import_id);
 INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES((v_result->>'import_id')::uuid,'FORECAST',v_result,auth.uid());RETURN v_result;
END $$;
CREATE OR REPLACE FUNCTION public.commit_payables_import_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,
 p_rows jsonb,p_mappings jsonb,p_complete boolean,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF p_complete IS DISTINCT FROM true THEN RAISE EXCEPTION 'Confirme o relatório antes de concluir a importação.' USING ERRCODE='22023';END IF;
 RETURN public.commit_payables_forecast_import_from_gateway(p_user_id,p_session_id,p_scope,p_file_name,p_file_sha256,p_file_base64,p_rows,p_mappings,p_previous_import_id);
END $$;
REVOKE ALL ON FUNCTION cf_private.audit_payable_import_mode(),cf_private.commit_payables_forecast_import(text,text,text,text,jsonb,jsonb,uuid),
 cf_private.payable_paid_bank_key(text,text),cf_private.normalize_payable_paid_rows(text,jsonb),cf_private.normalize_payable_paid_mappings(jsonb,jsonb),cf_private.normalize_payable_paid_plans(jsonb,jsonb),
 cf_private.preview_payable_paid_rows(jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.preview_payables_forecast_import(text,jsonb),public.preview_payables_paid_import(text,jsonb,jsonb,jsonb),
 public.commit_payables_forecast_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid),
 public.commit_payables_paid_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_payables_forecast_import(text,jsonb),public.preview_payables_paid_import(text,jsonb,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_payables_forecast_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid),
 public.commit_payables_paid_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text) TO service_role;
COMMENT ON TABLE public.payable_import_modes IS 'Proveniência imutável: FORECAST adiciona/atualiza obrigações sem baixar ausências; PAYMENTS atualiza o valor integral nominal declarado e confirma valor/data/banco reais, preservando vencimento original e histórico anterior.';
COMMENT ON TABLE public.payable_paid_import_rows IS 'Vínculo auditável entre relatório original, identidade estável, pagamentos efetivos e conciliação. MATCHED não transfere origem de pagamento manual para importado.';
COMMENT ON TABLE public.payable_paid_bank_mappings IS 'Vínculo bancário explícito por filial e texto do banco efetivo. Revisões preservadas; não deduz conta apenas pelo nome do banco ou pela previsão.';
INSERT INTO public.central_schema_migrations(version) VALUES('021_payable_paid_import');
COMMIT;
