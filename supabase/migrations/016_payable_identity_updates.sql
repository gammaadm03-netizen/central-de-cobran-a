-- Contas a Pagar: identidade estável nas atualizações diárias de valor, data e banco.
-- Incremental após 015. A ativação não modifica títulos, saldos, pagamentos,
-- arquivos, históricos ou classificações existentes. Nenhuma versão é mesclada.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.central_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Ative as atualizações anteriores de Contas a Pagar.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='015_payable_payments') THEN
    RAISE EXCEPTION 'Ative a atualização 015 antes da identidade estável de Contas a Pagar.' USING ERRCODE='22023';
  END IF;
END $$;

-- Não remove pontuação nem zeros do número de lançamento: não presume parcelas.
CREATE FUNCTION cf_private.payable_business_key(p_branch text,p_entry_number text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
  SELECT jsonb_build_array(upper(btrim(regexp_replace(p_branch,'[[:space:]]+',' ','g'))),
    upper(btrim(regexp_replace(p_entry_number,'[[:space:]]+',' ','g'))))::text;
$$;
CREATE INDEX payable_titles_business_identity ON public.payable_titles(scope,
  cf_private.payable_business_key(branch,entry_number));

-- Registro canônico privado: preenchido somente pela importação aprovada.
-- Os registros antigos não escolhidos permanecem intactos e consultáveis.
CREATE TABLE cf_private.payable_identity_registry (
  scope text NOT NULL CHECK(scope='grupo-consolidado'),
  business_key text NOT NULL,
  title_id uuid NOT NULL UNIQUE REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  PRIMARY KEY(scope,business_key)
);
ALTER TABLE cf_private.payable_identity_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.payable_identity_registry FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION cf_private.guard_payable_identity_registry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'A identidade canônica possui histórico imutável.' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.id=NEW.title_id AND t.scope=NEW.scope
    AND cf_private.payable_business_key(t.branch,t.entry_number)=NEW.business_key) THEN
    RAISE EXCEPTION 'A identidade não corresponde ao título.' USING ERRCODE='23514'; END IF;
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar','payable_identity_registry',NEW.title_id::text,
      'ASSIGNMENT',NULL,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER payable_identity_registry_guard BEFORE INSERT OR UPDATE OR DELETE ON cf_private.payable_identity_registry
 FOR EACH ROW EXECUTE FUNCTION cf_private.guard_payable_identity_registry();

-- Reutiliza todas as validações originais (nove campos, tipos, datas e limites).
-- Valor, vencimento e banco pertencem à versão; filial+número identificam o título.
CREATE FUNCTION cf_private.validate_payable_identity_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_rows jsonb;v_result jsonb;
BEGIN
  BEGIN
    v_rows:=cf_private.validate_payable_rows(p_scope,p_rows);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Há linhas repetidas para a mesma filial e número de lançamento. Confira parcelas e a identificação do relatório; nenhum dado foi alterado.' USING ERRCODE='P0016';
  END;
  SELECT jsonb_agg(r||jsonb_build_object('legacy_source_key',r->>'source_key',
    'source_key',cf_private.payable_business_key(r->>'branch',r->>'entry_number')) ORDER BY n)
    INTO v_result FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(r,n);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_result) r GROUP BY r->>'source_key' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Há mais de uma linha para a mesma filial e número de lançamento. Confira parcelas e a identificação do relatório; nenhum dado foi alterado.' USING ERRCODE='P0016';
  END IF;
  RETURN v_result;
END $$;

-- Resolver sem escrita: a prévia nunca elege nem grava uma identidade.
-- Mais de um título ativo ou histórico indistinguível exige conferência.
CREATE FUNCTION cf_private.resolve_payable_identity_rows(p_scope text,p_rows jsonb) RETURNS jsonb
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
    END IF;
    v_items:=array_append(v_items,v_row||jsonb_build_object('title_id',v_id,'changed',v_changed));
  END LOOP;
  RETURN to_jsonb(v_items);
END $$;

CREATE OR REPLACE FUNCTION public.preview_payables_import(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_previous uuid;v_new integer;v_open integer;v_settled integer;v_changed integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  -- Capture o token antes da análise: uma importação concorrente exige nova prévia.
  SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
  v_rows:=cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,p_rows));
  SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL),count(*) FILTER(WHERE r->>'title_id' IS NOT NULL),
    count(*) FILTER(WHERE coalesce((r->>'changed')::boolean,false)) INTO v_new,v_open,v_changed FROM jsonb_array_elements(v_rows) r;
  SELECT count(*) INTO v_settled FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'title_id')::uuid=t.id);
  RETURN jsonb_build_object('previous_import_id',v_previous,'new_count',v_new,'open_count',v_open,
    'settled_count',v_settled,'changed_count',v_changed,'row_count',jsonb_array_length(v_rows));
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
      status='OPEN',last_import_id=v_id,settled_at=NULL
    FROM jsonb_to_recordset(v_rows) AS r(title_id uuid,source_key text,entry_number text,description text,due_date date,
      amount_cents bigint,source_status text,plan text,bank_account text,branch text,issued_on date)
    JOIN public.payable_plan_mappings m ON m.plan=r.plan WHERE t.id=r.title_id AND t.scope=p_scope;
  INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,source_status,
    plan,bank_account,branch,issued_on,macro,status,first_import_id,last_import_id,settled_at)
    SELECT p_scope,r.source_key,r.entry_number,r.description,r.due_date,r.amount_cents,r.source_status,
      r.plan,r.bank_account,r.branch,r.issued_on,m.macro,'NEW',v_id,v_id,NULL
    FROM jsonb_to_recordset(v_rows) AS r(title_id uuid,source_key text,entry_number text,description text,due_date date,
      amount_cents bigint,source_status text,plan text,bank_account text,branch text,issued_on date)
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

REVOKE ALL ON FUNCTION cf_private.payable_business_key(text,text),cf_private.guard_payable_identity_registry(),
 cf_private.validate_payable_identity_rows(text,jsonb),cf_private.resolve_payable_identity_rows(text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
-- Substituições mantêm a API e o envelope originais; escrita continua exclusiva do gateway.
REVOKE ALL ON FUNCTION public.preview_payables_import(text,jsonb),
 public.commit_payables_import(text,text,text,text,jsonb,jsonb,boolean,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_payables_import(text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_payables_import(text,text,text,text,jsonb,jsonb,boolean,uuid) TO service_role;
COMMENT ON FUNCTION public.preview_payables_import(text,jsonb) IS 'Prévia sem escrita: filial+número normalizados identificam o título; changed_count integra open_count e não aumenta a quantidade de títulos.';
COMMENT ON FUNCTION public.commit_payables_import(text,text,text,text,jsonb,jsonb,boolean,uuid) IS 'Somente gateway: atualiza o mesmo UUID quando valor/vencimento/banco mudam. Preserva pagamentos, primeira importação e histórico; rejeita identidades ambíguas.';
INSERT INTO public.central_schema_migrations(version) VALUES('016_payable_identity_updates');
COMMIT;
