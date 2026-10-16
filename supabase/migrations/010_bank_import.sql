-- Central Financeira: entrada centralizada de posições e extratos de apoio.
-- Aplicar uma única vez após 007. Não recria contas nem altera posições existentes.
-- Extratos são arquivos de APOIO: não são interpretados nem conciliados automaticamente.
BEGIN;

CREATE FUNCTION public.save_bank_position(
  p_balance_date date, p_positions jsonb, p_observation text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row jsonb; v_account_id uuid; v_amount bigint; v_expected timestamptz;
  v_count integer; v_total numeric; v_actor public.profiles%ROWTYPE;
BEGIN
  -- Mesmo bloqueio de set_bank_balance e da administração de perfis.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('caixa','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_balance_date IS NULL OR p_balance_date < DATE '1900-01-01'
    OR p_balance_date > (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000
    OR p_positions IS NULL OR jsonb_typeof(p_positions) <> 'array' THEN
    RAISE EXCEPTION 'Informe data válida, todas as contas e uma observação de até 1.000 caracteres.' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM public.bank_accounts WHERE enabled ORDER BY id FOR UPDATE;
  SELECT count(*)::integer INTO v_count FROM public.bank_accounts WHERE enabled;
  IF v_count=0 OR jsonb_array_length(p_positions)<>v_count THEN
    RAISE EXCEPTION 'Informe um saldo explícito para cada conta ativa, sem repetir contas.' USING ERRCODE='23514';
  END IF;
  -- Valida o lote inteiro antes de chamar a rotina existente, inclusive precisão.
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_positions) LOOP
    IF jsonb_typeof(v_row)<>'object' THEN
      RAISE EXCEPTION 'Cada conta deve ser um registro com identificador, valor e versão anterior.' USING ERRCODE='23514';
    END IF;
    IF NOT (v_row ?& ARRAY['account_id','amount_cents','expected_updated_at'])
      OR (SELECT count(*) FROM jsonb_object_keys(v_row))<>3
      OR jsonb_typeof(v_row->'account_id')<>'string'
      OR jsonb_typeof(v_row->'amount_cents')<>'number'
      OR (v_row->>'amount_cents') !~ '^-?[0-9]+$'
      OR jsonb_typeof(v_row->'expected_updated_at') NOT IN ('null','string') THEN
      RAISE EXCEPTION 'Cada conta deve informar somente identificador, centavos inteiros e versão anterior.' USING ERRCODE='23514';
    END IF;
    IF (v_row->>'amount_cents')::numeric NOT BETWEEN -9007199254740991 AND 9007199254740991 THEN
      RAISE EXCEPTION 'O saldo de uma conta excede o limite seguro de representação.' USING ERRCODE='22003';
    END IF;
    BEGIN
      v_account_id := (v_row->>'account_id')::uuid;
      IF jsonb_typeof(v_row->'expected_updated_at')='string' THEN
        IF (v_row->>'expected_updated_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
          RAISE invalid_datetime_format;
        END IF;
        v_expected := (v_row->>'expected_updated_at')::timestamptz;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Identificador ou versão da conta inválidos. Atualize a tela.' USING ERRCODE='23514';
    END;
    IF NOT EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=v_account_id AND enabled) THEN
      RAISE EXCEPTION 'Uma das contas está indisponível. Atualize a tela.' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (value->>'account_id')::uuid) FROM jsonb_array_elements(p_positions))<>v_count THEN
    RAISE EXCEPTION 'Há contas repetidas ou ausentes na posição.' USING ERRCODE='23514';
  END IF;
  SELECT sum((value->>'amount_cents')::numeric) INTO v_total FROM jsonb_array_elements(p_positions);
  IF abs(v_total)>9007199254740991 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_positions) r
    JOIN public.bank_accounts a ON a.id=(r.value->>'account_id')::uuid
    GROUP BY a.company HAVING abs(sum((r.value->>'amount_cents')::numeric))>9007199254740991
  ) THEN
    RAISE EXCEPTION 'O total ou subtotal de uma empresa excede o limite seguro de representação.' USING ERRCODE='22003';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_positions) LOOP
    v_expected := CASE WHEN jsonb_typeof(v_row->'expected_updated_at')='null' THEN NULL
      ELSE (v_row->>'expected_updated_at')::timestamptz END;
    PERFORM public.set_bank_balance((v_row->>'account_id')::uuid,p_balance_date,
      (v_row->>'amount_cents')::bigint,btrim(p_observation),v_expected);
  END LOOP;
  -- Uma divergência de versão em qualquer conta reverte todo o lote e a auditoria.
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'caixa','bank_position',p_balance_date::text,'IMPORT',
      jsonb_build_object('position_date',p_balance_date,'total_cents',v_total,'account_count',v_count,
        'observation',btrim(p_observation),'source','MANUAL'));
  RETURN jsonb_build_object('position_date',p_balance_date,'total_cents',v_total,'account_count',v_count);
END;
$$;

CREATE TABLE public.bank_support_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 200),
  file_sha256 text NOT NULL UNIQUE CHECK(file_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 2097152),
  account_id uuid REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  reference_date date NOT NULL,
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX bank_support_files_reference ON public.bank_support_files(reference_date DESC,created_at DESC,id DESC);
CREATE TABLE cf_private.bank_support_bytes (
  file_id uuid PRIMARY KEY REFERENCES public.bank_support_files(id) ON DELETE RESTRICT,
  file_bytes bytea NOT NULL CHECK(octet_length(file_bytes) BETWEEN 1 AND 2097152)
);
ALTER TABLE public.bank_support_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.bank_support_bytes ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_support_files_read ON public.bank_support_files FOR SELECT TO authenticated
  USING(cf_private.has_permission('caixa','read'));

CREATE FUNCTION cf_private.protect_bank_support() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Arquivos de apoio e seus registros são imutáveis.' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER bank_support_metadata_immutable BEFORE UPDATE OR DELETE ON public.bank_support_files
  FOR EACH ROW EXECUTE FUNCTION cf_private.protect_bank_support();
CREATE TRIGGER bank_support_content_immutable BEFORE UPDATE OR DELETE ON cf_private.bank_support_bytes
  FOR EACH ROW EXECUTE FUNCTION cf_private.protect_bank_support();

CREATE FUNCTION public.register_bank_support(
  p_file_name text,p_file_sha256 text,p_file_base64 text,p_account_id uuid,
  p_reference_date date,p_description text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_bytes bytea; v_id uuid; v_actor public.profiles%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('caixa','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 200
    OR p_file_name ~ '[/\\[:cntrl:]]' OR btrim(p_file_name) !~* '^.+\.(xlsx|xlsm|xls|csv|ofx|pdf)$'
    OR p_file_sha256 IS NULL OR p_file_sha256 !~ '^[a-f0-9]{64}$'
    OR p_file_base64 IS NULL OR length(p_file_base64) NOT BETWEEN 4 AND 2796204
    OR p_file_base64 !~ '^[A-Za-z0-9+/]+={0,2}$'
    OR p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01'
    OR p_reference_date>(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe arquivo de apoio válido de até 2 MiB, data e descrição de até 1.000 caracteres.' USING ERRCODE='23514';
  END IF;
  BEGIN
    v_bytes := decode(p_file_base64,'base64');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'O arquivo de apoio não pôde ser lido. Nenhum dado foi alterado.' USING ERRCODE='23514';
  END;
  IF octet_length(v_bytes) NOT BETWEEN 1 AND 2097152
    OR replace(encode(v_bytes,'base64'),E'\n','')<>p_file_base64
    OR encode(sha256(v_bytes),'hex')<>p_file_sha256 THEN
    RAISE EXCEPTION 'O tamanho ou a integridade do arquivo de apoio é inválido.' USING ERRCODE='23514';
  END IF;
  IF p_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=p_account_id AND enabled) THEN
    RAISE EXCEPTION 'Conta bancária indisponível.' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.bank_support_files WHERE file_sha256=p_file_sha256) THEN
    RAISE EXCEPTION 'Este arquivo de apoio já foi registrado.' USING ERRCODE='23505';
  END IF;
  INSERT INTO public.bank_support_files(file_name,file_sha256,size_bytes,account_id,reference_date,description,created_by)
    VALUES(btrim(p_file_name),p_file_sha256,octet_length(v_bytes),p_account_id,p_reference_date,btrim(p_description),auth.uid())
    RETURNING id INTO v_id;
  INSERT INTO cf_private.bank_support_bytes(file_id,file_bytes) VALUES(v_id,v_bytes);
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'caixa','bank_support_files',v_id::text,'IMPORT',
      jsonb_build_object('file_name',btrim(p_file_name),'file_sha256',p_file_sha256,'size_bytes',octet_length(v_bytes),
        'account_id',p_account_id,'reference_date',p_reference_date,'description',btrim(p_description),'purpose','SUPPORT_ONLY'));
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.download_bank_support(p_file_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT cf_private.has_permission('caixa','read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object('file_name',f.file_name,'file_base64',replace(encode(b.file_bytes,'base64'),E'\n',''))
    INTO v_result FROM public.bank_support_files f JOIN cf_private.bank_support_bytes b ON b.file_id=f.id
    WHERE f.id=p_file_id;
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Arquivo de apoio indisponível.' USING ERRCODE='P0002';
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON TABLE public.bank_support_files,cf_private.bank_support_bytes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.bank_support_files TO authenticated;
REVOKE ALL ON FUNCTION cf_private.protect_bank_support() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.save_bank_position(date,jsonb,text),
  public.register_bank_support(text,text,text,uuid,date,text),public.download_bank_support(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_bank_position(date,jsonb,text),
  public.register_bank_support(text,text,text,uuid,date,text),public.download_bank_support(uuid) TO authenticated;
COMMENT ON TABLE public.bank_support_files IS 'Arquivo original privado de apoio. Registrar não altera saldos, não importa movimentos e não concilia pagamentos.';
COMMENT ON TABLE cf_private.bank_support_bytes IS 'Arquivo original imutável. Sem acesso direto; download autenticado exige caixa.read e sessão aprovada.';
COMMENT ON FUNCTION public.save_bank_position(date,jsonb,text) IS 'Salva todas as contas ativas de uma data em uma única transação. Zero deve ser explícito; versões da mesma data são obrigatórias.';
INSERT INTO public.central_schema_migrations(version) VALUES('010_bank_import');
COMMIT;
