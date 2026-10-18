-- Número de cheque: campo textual explícito, sem inferência pelo lançamento.
-- Incremental após 018; conserva pagamentos e posições históricas anteriores.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative as atualizações anteriores de Contas a Pagar.' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='018_payable_full_payment') THEN
  RAISE EXCEPTION 'Ative a atualização 018 antes dos números de cheque.' USING ERRCODE='22023';END IF;
END $$;
ALTER TABLE public.payable_titles ADD COLUMN cheque_number text CHECK(cheque_number IS NULL OR (length(cheque_number) BETWEEN 1 AND 150 AND cheque_number=btrim(cheque_number) AND cheque_number !~ '[[:cntrl:]]'));
ALTER TABLE public.payable_payments ADD COLUMN cheque_number text CHECK(cheque_number IS NULL OR (length(cheque_number) BETWEEN 1 AND 150 AND cheque_number=btrim(cheque_number) AND cheque_number !~ '[[:cntrl:]]'));

-- As três views possuem expansão congelada de *. Acrescentar somente no final
-- preserva todos os nomes, tipos, posições de colunas e dependências existentes.
DO $$ DECLARE v_sql text;v_fields text;BEGIN
 SELECT string_agg('f.'||quote_ident(attname),',' ORDER BY attnum) INTO v_fields FROM pg_attribute
  WHERE attrelid='public.payable_financial_titles'::regclass AND attnum>0 AND NOT attisdropped;
 v_sql:=regexp_replace(pg_get_viewdef('public.payable_financial_titles'::regclass,true),';[[:space:]]*$','');
 EXECUTE 'CREATE OR REPLACE VIEW public.payable_financial_titles WITH(security_invoker=true) AS SELECT original.*,source.cheque_number FROM ('||v_sql||') original JOIN public.payable_titles source ON source.id=original.id';
 v_sql:=regexp_replace(pg_get_viewdef('public.payable_effective_payments'::regclass,true),';[[:space:]]*$','');
 EXECUTE 'CREATE OR REPLACE VIEW public.payable_effective_payments WITH(security_invoker=true) AS SELECT original.*,source.cheque_number FROM ('||v_sql||') original JOIN public.payable_payments source ON source.id=original.id';
 EXECUTE 'CREATE OR REPLACE VIEW public.payable_review_titles WITH(security_invoker=true) AS SELECT '||v_fields||$definition$,
  CASE WHEN r.reviewed AND r.fingerprint=h.fingerprint AND f.financial_status='PAID' AND f.amount_cents>0 THEN 'CONCILIADO' ELSE 'A_CONCILIAR' END AS review_status,
  r.id AS review_id,r.created_at AS reviewed_at,r.created_by AS reviewed_by,h.fingerprint AS review_fingerprint,
  exclusion.reason IS NULL AS closing_eligible,exclusion.reason AS closing_exclusion_reason,f.cheque_number
 FROM public.payable_financial_titles f LEFT JOIN public.payable_title_control_revisions c ON c.title_id=f.id
 CROSS JOIN LATERAL(SELECT encode(sha256(convert_to(jsonb_build_object(
  'title',(to_jsonb(f)-ARRAY['last_import_id','first_import_id','source_key','settled_at','status','cheque_number'])
   ||CASE WHEN f.cheque_number IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cheque_number',f.cheque_number) END,
  'source_active',f.status<>'SETTLED_IMPORT','control_revision',coalesce(c.revision,0))::text,'UTF8')),'hex') AS fingerprint) h
 CROSS JOIN LATERAL(SELECT cf_private.payable_closing_exclusion(f.id) AS reason) exclusion
 LEFT JOIN LATERAL(SELECT r.* FROM public.payable_title_reviews r WHERE r.title_id=f.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true
$definition$;
END $$;

CREATE OR REPLACE FUNCTION cf_private.validate_payable_rows(p_scope text,p_rows jsonb) RETURNS jsonb
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
       ('entry_number','description','due_date','amount_cents','source_status','plan','bank_account','branch','issued_on','cheque_number')) THEN
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
    IF v_row ? 'cheque_number' AND (jsonb_typeof(v_row->'cheque_number') NOT IN ('string','null')
      OR length(coalesce(v_row->>'cheque_number',''))>150 OR coalesce(v_row->>'cheque_number','') ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION 'Linha %: número do cheque deve ser texto de até 150 caracteres, sem caracteres de controle.',v_line USING ERRCODE='22023';
    END IF;
    v_normalized := jsonb_build_object(
      'entry_number',btrim(regexp_replace(v_row->>'entry_number','[[:space:]]+',' ','g')),
      'description',btrim(v_row->>'description'),'due_date',v_due,'amount_cents',v_cents::bigint,
      'source_status',nullif(btrim(v_row->>'source_status'),''),
      'plan',cf_private.normalize_payable_plan(v_row->>'plan'),
      'bank_account',nullif(btrim(v_row->>'bank_account'),''),
      'branch',btrim(regexp_replace(v_row->>'branch','[[:space:]]+',' ','g')),'issued_on',v_issued);
    IF v_row ? 'cheque_number' THEN v_normalized:=v_normalized||jsonb_build_object('cheque_number',nullif(btrim(v_row->>'cheque_number'),''));END IF;
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

CREATE OR REPLACE FUNCTION cf_private.resolve_payable_identity_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_item public.payable_titles%ROWTYPE;v_id uuid;v_registered uuid;
 v_count integer;v_active integer;v_total integer;v_changed boolean;v_items jsonb[]:=ARRAY[]::jsonb[];
BEGIN
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_id:=NULL;v_registered:=NULL;
    SELECT i.title_id INTO v_registered FROM cf_private.payable_identity_registry i
      WHERE i.scope=p_scope AND i.business_key=v_row->>'source_key';
    SELECT count(*)::integer,count(*) FILTER(WHERE t.status<>'SETTLED_IMPORT')::integer
      INTO v_total,v_active FROM public.payable_titles t WHERE t.scope=p_scope
      AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key';
    IF v_active>1 THEN
      RAISE EXCEPTION 'Há mais de um título ativo para a mesma filial e número de lançamento. Confira as versões no histórico; nenhum dado foi alterado.' USING ERRCODE='P0016'; END IF;
    IF v_registered IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.id=v_registered AND t.scope=p_scope
        AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key')
        OR EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
          AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key' AND t.id<>v_registered) THEN
        RAISE EXCEPTION 'A identidade registrada diverge dos títulos existentes. Confira o histórico; nenhum dado foi alterado.' USING ERRCODE='P0016'; END IF;
      v_id:=v_registered;
    ELSIF v_active=1 THEN
      SELECT t.id INTO v_id FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
        AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key';
    ELSIF v_total=1 THEN
      SELECT t.id INTO v_id FROM public.payable_titles t WHERE t.scope=p_scope
        AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key';
    ELSIF v_total>1 THEN
      SELECT count(*)::integer INTO v_count FROM public.payable_titles t WHERE t.scope=p_scope
        AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key'
        AND t.source_key=v_row->>'legacy_source_key';
      IF v_count<>1 THEN
        RAISE EXCEPTION 'Há várias versões históricas e a identidade não pode ser determinada com segurança. Confira parcelas e o histórico; nenhum dado foi alterado.' USING ERRCODE='P0016'; END IF;
      SELECT t.id INTO v_id FROM public.payable_titles t WHERE t.scope=p_scope AND t.source_key=v_row->>'legacy_source_key';
    END IF;
    -- Uma versão histórica com pagamento efetivo pode representar o mesmo título
    -- da versão escolhida. Não canoniza outra versão nem transfere o ledger por
    -- inferência; a origem precisa ser conferida antes de atualizar essa identidade.
    IF EXISTS(SELECT 1 FROM public.payable_titles historical
      JOIN public.payable_payments payment ON payment.title_id=historical.id
      WHERE historical.scope=p_scope AND historical.id IS DISTINCT FROM v_id
        AND cf_private.payable_business_key(historical.branch,historical.entry_number)=v_row->>'source_key'
        AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals reversal WHERE reversal.payment_id=payment.id)) THEN
      RAISE EXCEPTION 'Outra versão desta filial e número possui pagamentos financeiros ativos. Confira o histórico antes de escolher a identidade; nenhum pagamento será transferido nem duplicado.' USING ERRCODE='P0016';
    END IF;
    v_changed:=false;
    IF v_id IS NOT NULL THEN
      SELECT * INTO v_item FROM public.payable_titles WHERE id=v_id;
      v_changed:=ROW(v_item.entry_number,v_item.description,v_item.due_date,v_item.amount_cents,
        v_item.source_status,v_item.plan,v_item.bank_account,v_item.branch,v_item.issued_on)
        IS DISTINCT FROM ROW(v_row->>'entry_number',v_row->>'description',(v_row->>'due_date')::date,
          (v_row->>'amount_cents')::bigint,v_row->>'source_status',v_row->>'plan',v_row->>'bank_account',
          v_row->>'branch',(v_row->>'issued_on')::date);
      v_changed:=v_changed OR (v_row ? 'cheque_number' AND v_item.cheque_number IS DISTINCT FROM v_row->>'cheque_number');
    END IF;
    v_items:=array_append(v_items,v_row||jsonb_build_object('title_id',v_id,'changed',v_changed));
  END LOOP;
  RETURN to_jsonb(v_items);
END $$;

CREATE OR REPLACE FUNCTION public.commit_payables_import(
 p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_mappings jsonb,
 p_complete boolean,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rows jsonb; v_previous uuid; v_id uuid:=gen_random_uuid(); v_new integer; v_open integer; v_settled integer;
  v_changed integer; v_file bytea; v_mappings jsonb:='{}'::jsonb; v_mapping record; v_plan text;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_complete IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Confirme que o arquivo contém o relatório completo.' USING ERRCODE='22023';
  END IF;
  v_rows:=cf_private.validate_payable_identity_rows(p_scope,p_rows);
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
  SELECT count(*) INTO v_settled FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'title_id')::uuid=t.id);
  INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count)
    VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),v_new,v_open,v_settled);
  INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
  INSERT INTO public.payable_plan_mappings(plan,macro)
    SELECT key,value#>>'{}' FROM jsonb_each(v_mappings)
    ON CONFLICT(plan) DO UPDATE SET macro=EXCLUDED.macro,updated_at=clock_timestamp()
      WHERE payable_plan_mappings.macro IS DISTINCT FROM EXCLUDED.macro;
  UPDATE public.payable_titles t SET status='SETTLED_IMPORT',settled_at=clock_timestamp(),last_import_id=v_id
    WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'title_id')::uuid=t.id);
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
  RETURN jsonb_build_object('import_id',v_id,'new_count',v_new,'open_count',v_open,
    'settled_count',v_settled,'changed_count',v_changed,'row_count',jsonb_array_length(v_rows));
END;
$$;

CREATE OR REPLACE FUNCTION cf_private.payable_title_review_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM cf_private.invalidate_payable_review(NEW.id,'Novo título na base após o fechamento.');
 ELSIF ROW(OLD.entry_number,OLD.description,OLD.due_date,OLD.amount_cents,OLD.source_status,OLD.plan,OLD.bank_account,OLD.branch,OLD.issued_on,OLD.macro,OLD.status='SETTLED_IMPORT',OLD.cheque_number)
  IS DISTINCT FROM ROW(NEW.entry_number,NEW.description,NEW.due_date,NEW.amount_cents,NEW.source_status,NEW.plan,NEW.bank_account,NEW.branch,NEW.issued_on,NEW.macro,NEW.status='SETTLED_IMPORT',NEW.cheque_number) THEN
  PERFORM cf_private.invalidate_payable_review(NEW.id,'Dados do título alterados; confira e concilie novamente.',OLD.due_date);
 END IF;RETURN NEW;
END $$;
DROP FUNCTION public.correct_payable_title(uuid,date,bigint,text,text,date,text,text,text,boolean);
CREATE FUNCTION public.correct_payable_title(p_title_id uuid,p_due_date date,p_amount_cents bigint,p_bank_account text,
 p_description text,p_issued_on date,p_macro text,p_observation text,p_expected_fingerprint text,p_reclassify_payments boolean,p_cheque_number text DEFAULT NULL,p_change_cheque boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.payable_review_titles%ROWTYPE;v_before jsonb;v_after jsonb;v_id uuid;v_has_payments boolean;v_do_reclass boolean;v_cheque text;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 IF p_change_cheque IS NULL OR (p_change_cheque AND (length(coalesce(p_cheque_number,''))>150 OR coalesce(p_cheque_number,'') ~ '[[:cntrl:]]')) THEN
  RAISE EXCEPTION 'Informe um número de cheque de até 150 caracteres, sem caracteres de controle.' USING ERRCODE='22023';END IF;
 IF p_due_date IS NULL OR p_due_date<DATE '1900-01-01' OR p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 1 AND 9007199254740991
  OR p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 1500 OR length(coalesce(p_bank_account,''))>300
  OR (p_issued_on IS NOT NULL AND p_issued_on<DATE '1900-01-01') OR NOT EXISTS(SELECT 1 FROM public.payable_macros WHERE name=p_macro)
  OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Confira valor positivo em centavos, datas, favorecido, banco, macro e motivo da correção.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_title FROM public.payable_review_titles WHERE id=p_title_id;
 IF v_title.id IS NULL THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='22023';END IF;
 IF v_title.review_fingerprint IS DISTINCT FROM p_expected_fingerprint THEN RAISE EXCEPTION 'O título mudou. Confira os dados antes de corrigir.' USING ERRCODE='40001';END IF;
 IF NOT v_title.closing_eligible THEN RAISE EXCEPTION 'Esta versão anterior é somente histórica. Corrija o título canônico.' USING ERRCODE='22023';END IF;
 v_cheque:=CASE WHEN p_change_cheque THEN nullif(btrim(p_cheque_number),'') ELSE v_title.cheque_number END;
 SELECT p_reclassify_payments IS TRUE AND EXISTS(SELECT 1 FROM public.payable_effective_payments p WHERE p.title_id=p_title_id
  AND p.effective_macro<>p_macro AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) INTO v_do_reclass;
 IF ROW(v_title.due_date,v_title.amount_cents,v_title.bank_account,v_title.description,v_title.issued_on,v_title.macro,v_title.cheque_number)
  IS NOT DISTINCT FROM ROW(p_due_date,p_amount_cents,nullif(btrim(p_bank_account),''),btrim(p_description),p_issued_on,p_macro,v_cheque) AND NOT v_do_reclass THEN
  RAISE EXCEPTION 'Nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
 SELECT EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=p_title_id AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) INTO v_has_payments;
 IF p_macro<>v_title.macro AND v_has_payments AND p_reclassify_payments IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Confirme expressamente a reclassificação dos pagamentos deste título para o novo macro.' USING ERRCODE='22023';END IF;
 SELECT to_jsonb(t) INTO v_before FROM public.payable_titles t WHERE id=p_title_id;
 v_after:=v_before||jsonb_build_object('due_date',p_due_date,'amount_cents',p_amount_cents,'bank_account',nullif(btrim(p_bank_account),''),
  'description',btrim(p_description),'issued_on',p_issued_on,'macro',p_macro,'cheque_number',v_cheque);
 INSERT INTO public.payable_title_corrections(title_id,before_value,after_value,observation,created_by)
  VALUES(p_title_id,v_before,v_after,btrim(p_observation),auth.uid()) RETURNING id INTO v_id;
 IF p_macro<>v_title.macro OR v_do_reclass THEN
  INSERT INTO public.payable_title_macro_overrides(title_id,plan,macro,active,correction_id,observation,created_by,created_at)
   SELECT p_title_id,v_title.plan,p_macro,true,v_id,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),coalesce(max(created_at),'1900-01-01'::timestamptz)+interval '1 microsecond')
   FROM public.payable_title_macro_overrides WHERE title_id=p_title_id;
 END IF;
 UPDATE public.payable_titles SET due_date=p_due_date,amount_cents=p_amount_cents,bank_account=nullif(btrim(p_bank_account),''),
  description=btrim(p_description),issued_on=p_issued_on,macro=p_macro,cheque_number=v_cheque WHERE id=p_title_id;
 IF v_do_reclass THEN
  INSERT INTO public.payable_payment_reclassifications(payment_id,correction_id,macro,previous_macro,created_by,created_at)
   SELECT p.id,v_id,p_macro,p.effective_macro,auth.uid(),greatest(clock_timestamp(),coalesce(old.created_at,'1900-01-01'::timestamptz)+interval '1 microsecond')
   FROM public.payable_effective_payments p LEFT JOIN LATERAL(SELECT r.created_at FROM public.payable_payment_reclassifications r WHERE r.payment_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1) old ON true
   WHERE p.title_id=p_title_id AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id) AND p.effective_macro<>p_macro;
 END IF;RETURN v_id;
END $$;

CREATE FUNCTION cf_private.capture_payable_payment_cheque() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 SELECT cheque_number INTO NEW.cheque_number FROM public.payable_titles WHERE id=NEW.title_id;RETURN NEW;
END $$;
CREATE TRIGGER payable_payment_cheque_snapshot BEFORE INSERT ON public.payable_payments FOR EACH ROW EXECUTE FUNCTION cf_private.capture_payable_payment_cheque();

CREATE FUNCTION public.payables_import_capabilities() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('contas_pagar','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('schema_version','019_payable_cheques','cheque_number',true);
END $$;
REVOKE ALL ON FUNCTION public.correct_payable_title(uuid,date,bigint,text,text,date,text,text,text,boolean,text,boolean),public.payables_import_capabilities() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.correct_payable_title(uuid,date,bigint,text,text,date,text,text,text,boolean,text,boolean),public.payables_import_capabilities() TO authenticated;
REVOKE ALL ON FUNCTION cf_private.capture_payable_payment_cheque() FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON COLUMN public.payable_titles.cheque_number IS 'Número explícito do cheque como texto, preservando zeros. Campo ausente no relatório conserva o número atual; vazio/null explícito limpa. Não faz parte da identidade do título.';
COMMENT ON COLUMN public.payable_payments.cheque_number IS 'Número do cheque da fonte oficial no momento deste pagamento. Histórico anterior permanece sem número quando não foi informado; nenhuma busca retroativa.';
INSERT INTO public.central_schema_migrations(version) VALUES('019_payable_cheques');
COMMIT;
