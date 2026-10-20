-- Acesso individual às nove bases de importação, sem promoção administrativa.
-- Repetível e sem contas reais. Requer013 e039; módulos ainda não ativados
-- continuam exigindo suas próprias atualizações para processar os arquivos.
BEGIN;
DO $cf_apply_046$
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL THEN RAISE EXCEPTION 'Ative a base financeira antes do acesso de importações.' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='039_user_access_limits')
  OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='013_director_report') THEN
  RAISE EXCEPTION 'Ative primeiro o Resumo013 e os limites individuais039.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='046_user_import_access') THEN RAISE NOTICE 'Acesso de importações046 já instalado; configurações preservadas.';RETURN;END IF;
 EXECUTE $cf_source_046$

CREATE TABLE cf_private.user_import_access(
 user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
 enabled boolean NOT NULL DEFAULT true,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE cf_private.user_import_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.user_import_access FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION cf_private.guard_user_import_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 PERFORM 1 FROM public.profiles WHERE id=NEW.user_id AND role_key='contas_receber' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'O acesso individual de importações exige um perfil existente de Contas a Receber.' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER user_import_access_guard BEFORE INSERT OR UPDATE ON cf_private.user_import_access FOR EACH ROW EXECUTE FUNCTION cf_private.guard_user_import_access();
CREATE TRIGGER user_import_access_audit AFTER INSERT OR UPDATE OR DELETE ON cf_private.user_import_access FOR EACH ROW EXECUTE FUNCTION cf_private.audit_row();
CREATE FUNCTION cf_private.set_user_import_access(p_username text,p_enabled boolean DEFAULT true,p_reason text DEFAULT 'Acesso individual às bases de importação') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE v_user public.profiles%ROWTYPE;v_count integer;BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF p_username IS NULL OR length(btrim(p_username)) NOT BETWEEN 3 AND 64 OR p_enabled IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Informe o usuário existente, a ativação e um motivo de até1.000 caracteres.' USING ERRCODE='22023';END IF;
 SELECT count(*)::integer INTO v_count FROM public.profiles WHERE username_normalized=lower(btrim(p_username));
 IF v_count<>1 THEN RAISE EXCEPTION 'Confirme o nome de usuário existente. Nenhum acesso foi alterado.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_user FROM public.profiles WHERE username_normalized=lower(btrim(p_username)) FOR UPDATE;
 IF v_user.role_key<>'contas_receber' THEN RAISE EXCEPTION 'Este usuário precisa manter o perfil Contas a Receber.' USING ERRCODE='22023';END IF;
 IF p_enabled AND NOT v_user.enabled THEN RAISE EXCEPTION 'Ative primeiro o usuário existente antes de liberar as importações.' USING ERRCODE='22023';END IF;
 INSERT INTO cf_private.user_import_access(user_id,enabled,reason) VALUES(v_user.id,p_enabled,btrim(p_reason))
  ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,reason=EXCLUDED.reason,updated_at=clock_timestamp()
  WHERE user_import_access.enabled IS DISTINCT FROM EXCLUDED.enabled OR user_import_access.reason IS DISTINCT FROM EXCLUDED.reason;
 RETURN jsonb_build_object('user_id',v_user.id,'username',v_user.username,'enabled',p_enabled,'role_key',v_user.role_key);
END $$;
CREATE FUNCTION cf_private.is_import_operator() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT cf_private.session_allowed() AND EXISTS(SELECT 1 FROM public.profiles p JOIN cf_private.user_import_access a ON a.user_id=p.id
  WHERE p.id=auth.uid() AND p.enabled AND p.role_key='contas_receber' AND a.enabled);
$$;
CREATE FUNCTION cf_private.user_import_permission_pairs() RETURNS TABLE(resource text,action text)
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 VALUES('importar_bases','read'),('contas_pagar','read'),('contas_pagar','write'),('contas_pagar','import'),
 ('contas_receber','read'),('contas_receber','write'),('contas_receber','import'),
 ('caixa','read'),('caixa','write'),('caixa','import'),('resumo_diretoria','read'),('resumo_diretoria','write'),
 ('fechamento','import'),('faturamento','read'),('margens','read'),('rh_dp','read'),('rh_dp','write'),('rh_dp','import'),('custos','import');
$$;
CREATE OR REPLACE FUNCTION cf_private.has_permission(p_resource text,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT cf_private.session_allowed() AND EXISTS(SELECT 1 FROM public.profiles p
  WHERE p.id=auth.uid() AND p.enabled
   AND (EXISTS(SELECT 1 FROM public.role_permissions rp WHERE rp.role_key=p.role_key AND rp.resource=p_resource AND rp.action=p_action)
    OR(cf_private.is_import_operator() AND EXISTS(SELECT 1 FROM cf_private.user_import_permission_pairs() g WHERE g.resource=p_resource AND g.action=p_action)))
   AND(p.role_key<>'diretor' OR(p_action IN('read','export') AND p_resource<>'importar_bases'))
   AND NOT EXISTS(SELECT 1 FROM cf_private.user_access_limits lim WHERE lim.user_id=p.id AND NOT(p_resource=ANY(lim.allowed_resources))));
$$;
CREATE OR REPLACE FUNCTION public.current_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile public.profiles%ROWTYPE;v_permissions jsonb;v_import boolean;
BEGIN
 IF NOT cf_private.session_allowed() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid() AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 v_import:=cf_private.is_import_operator();
 SELECT coalesce(jsonb_agg(jsonb_build_object('resource',resource,'action',action) ORDER BY resource,action),'[]') INTO v_permissions
  FROM(SELECT resource,action FROM public.role_permissions WHERE role_key=v_profile.role_key
   UNION SELECT resource,action FROM cf_private.user_import_permission_pairs() WHERE v_import) candidates
  WHERE cf_private.has_permission(resource,action);
 RETURN jsonb_build_object('profile',to_jsonb(v_profile),'permissions',v_permissions,'collector_id',cf_private.current_collector_id(),'full_import_access',v_import);
END $$;

CREATE OR REPLACE FUNCTION public.save_manual_stock(p_value_cents bigint, p_reference_date date, p_observation text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT(cf_private.is_manager() OR cf_private.is_import_operator()) OR NOT cf_private.has_permission('caixa','write') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501'; END IF;
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

CREATE FUNCTION cf_private.set_import_bank_balance(
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
  IF NOT(cf_private.is_manager() OR cf_private.is_import_operator()) OR NOT cf_private.has_permission('caixa','write') OR NOT cf_private.has_permission('caixa','import') THEN
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

CREATE OR REPLACE FUNCTION public.save_bank_position(
  p_balance_date date, p_positions jsonb, p_observation text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row jsonb; v_account_id uuid; v_amount bigint; v_expected timestamptz;
  v_count integer; v_total numeric; v_actor public.profiles%ROWTYPE;
BEGIN
  -- Mesmo bloqueio de set_bank_balance e da administração de perfis.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT(cf_private.is_manager() OR cf_private.is_import_operator()) OR NOT cf_private.has_permission('caixa','import') OR NOT cf_private.has_permission('caixa','write') THEN
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
  IF (SELECT coalesce(sum(-(value->>'amount_cents')::numeric) FILTER (
    WHERE (value->>'amount_cents')::numeric < 0),0) FROM jsonb_array_elements(p_positions)) > 9007199254740991 THEN
    RAISE EXCEPTION 'A cobertura dos saldos negativos excede o limite seguro de representação.' USING ERRCODE='22003';
  END IF;
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
    PERFORM cf_private.set_import_bank_balance((v_row->>'account_id')::uuid,p_balance_date,
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

CREATE OR REPLACE FUNCTION public.register_bank_support(
  p_file_name text,p_file_sha256 text,p_file_base64 text,p_account_id uuid,
  p_reference_date date,p_description text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_bytes bytea; v_id uuid; v_actor public.profiles%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT(cf_private.is_manager() OR cf_private.is_import_operator()) OR NOT cf_private.has_permission('caixa','import') THEN
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

CREATE OR REPLACE FUNCTION public.save_director_inputs(
  p_reference_date date,p_values jsonb,p_observation text,p_expected_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.director_report_inputs%ROWTYPE;v_new public.director_report_inputs%ROWTYPE;
  v_values jsonb;v_actor public.profiles%ROWTYPE;
BEGIN
  -- Ordem igual à administração de perfis e à gravação das posições oficiais.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT(cf_private.is_manager() OR cf_private.is_import_operator()) OR NOT cf_private.has_permission('resumo_diretoria','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01'
    OR p_reference_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe uma data até hoje e uma observação de até 1.000 caracteres.' USING ERRCODE='22023';
  END IF;
  v_values := cf_private.normalize_director_inputs(p_values);
  PERFORM pg_advisory_xact_lock(2045812307);
  SELECT * INTO v_previous FROM public.director_report_inputs WHERE reference_date=p_reference_date
    ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous.id IS DISTINCT FROM p_expected_id THEN
    RAISE EXCEPTION 'Os indicadores foram atualizados. Recarregue antes de salvar.' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.director_report_inputs(reference_date,values,observation,created_by,created_at)
    VALUES(p_reference_date,v_values,btrim(p_observation),auth.uid(),
      greatest(clock_timestamp(),v_previous.created_at+interval '1 microsecond')) RETURNING * INTO v_new;
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'resumo_diretoria','director_report_inputs',v_new.id::text,
      CASE WHEN v_previous.id IS NULL THEN 'CREATE' ELSE 'UPDATE' END,
      CASE WHEN v_previous.id IS NULL THEN NULL ELSE to_jsonb(v_previous) END,to_jsonb(v_new));
  RETURN v_new.id;
END;
$$;

REVOKE ALL ON FUNCTION cf_private.guard_user_import_access(),cf_private.set_user_import_access(text,boolean,text),cf_private.user_import_permission_pairs(),cf_private.set_import_bank_balance(uuid,date,bigint,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION cf_private.is_import_operator(),cf_private.has_permission(text,text),public.current_access() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cf_private.is_import_operator(),cf_private.has_permission(text,text),public.current_access() TO authenticated;
COMMENT ON TABLE cf_private.user_import_access IS 'Opt-in individual de Contas a Receber para as bases operacionais de importação. Não altera Auth, perfis ou a matriz RBAC global; configuração exclusiva do proprietário SQL e sempre auditada.';
COMMENT ON FUNCTION cf_private.set_user_import_access(text,boolean,text) IS 'Somente SQL proprietário. Usuário exato sem distinção de maiúsculas; nenhum nome real embutido; repetições sem mudança não duplicam auditoria.';
INSERT INTO public.central_schema_migrations(version) VALUES('046_user_import_access');
NOTIFY pgrst,'reload schema';

 $cf_source_046$;
END $cf_apply_046$;
COMMIT;
