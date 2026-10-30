-- Semântica das colunas do ERP: previsão atualizada e banco efetivo independente.
-- A instalação preserva todos os títulos, arquivos e pagamentos existentes.
BEGIN;
DO $apply_059$
DECLARE v_patch record;v_definition text;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='058_payable_daily_reports') THEN
  RAISE EXCEPTION 'Ative a atualização 058 antes das regras das colunas de Contas a Pagar.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='059_payable_column_rules') THEN RETURN;END IF;
 EXECUTE $helpers_059$
CREATE FUNCTION cf_private.payable_cheque_payment_bank() RETURNS uuid
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT CASE WHEN count(*)=1 THEN (array_agg(id ORDER BY id))[1] END
 FROM public.bank_accounts WHERE enabled AND account_type='BANK'
  AND cf_private.payable_paid_bank_text_key(display_name)='BRADESCO F2G';
$$;
-- Coluna ausente conserva o cheque já cadastrado. Uma coluna expressamente
-- vazia pode retirar o número, como nas atualizações de origem desde a 019.
CREATE FUNCTION cf_private.payable_paid_effective_cheque(p_row jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_id uuid;v_key text;v_total integer;v_active integer;v_number text;
BEGIN
 IF p_row ? 'cheque_number' THEN RETURN length(btrim(coalesce(p_row->>'cheque_number','')))>0;END IF;
 IF coalesce(p_row->>'title_id','')~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
  v_id:=(p_row->>'title_id')::uuid;
 ELSE
  v_key:=coalesce(p_row->>'business_key',cf_private.payable_business_key(p_row->>'branch',p_row->>'entry_number'));
  SELECT title_id INTO v_id FROM cf_private.payable_identity_registry WHERE scope='grupo-consolidado' AND business_key=v_key;
  IF v_id IS NULL THEN
   SELECT count(*),count(*) FILTER(WHERE status<>'SETTLED_IMPORT') INTO v_total,v_active
    FROM public.payable_titles WHERE scope='grupo-consolidado' AND cf_private.payable_business_key(branch,entry_number)=v_key;
   IF v_active=1 THEN SELECT id INTO v_id FROM public.payable_titles WHERE scope='grupo-consolidado'
    AND cf_private.payable_business_key(branch,entry_number)=v_key AND status<>'SETTLED_IMPORT';
   ELSIF v_total=1 THEN SELECT id INTO v_id FROM public.payable_titles WHERE scope='grupo-consolidado'
    AND cf_private.payable_business_key(branch,entry_number)=v_key;END IF;
  END IF;
 END IF;
 SELECT cheque_number INTO v_number FROM public.payable_titles WHERE id=v_id;
 RETURN length(btrim(coalesce(v_number,'')))>0;
END $$;
CREATE OR REPLACE FUNCTION cf_private.payable_paid_is_administrative(p_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce((p_row->>'amount_paid_cents')::numeric=1,false)
  OR (cf_private.payable_paid_bank_text_key(p_row->>'paid_bank')='CAIXA INTERNO' AND NOT cf_private.payable_paid_effective_cheque(p_row));
$$;
REVOKE ALL ON FUNCTION cf_private.payable_cheque_payment_bank(),cf_private.payable_paid_effective_cheque(jsonb),cf_private.payable_paid_is_administrative(jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
 $helpers_059$;
 -- Alterações limitadas a trechos únicos do contrato já instalado. Mantêm OID,
 -- proprietário, privilégios, opções de execução e todas as verificações prévias.
 FOR v_patch IN SELECT * FROM (VALUES
 ('public.get_payables_revision()',
  $old$'financial_revision',v_revision);$old$,
  $new$'financial_revision','059:'||v_revision); /* payable_columns_059_policy_revision */$new$),
 ('public.preview_payables_daily_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean)',
  $old$SELECT count(*) FILTER(WHERE p_report_kind='NORMAL' AND cf_private.payable_daily_is_cheque(r->>'source_status',r->>'cheque_number')),
  coalesce(jsonb_agg(r ORDER BY n) FILTER(WHERE p_report_kind='CHEQUES' OR NOT cf_private.payable_daily_is_cheque(r->>'source_status',r->>'cheque_number')),'[]')$old$,
  $new$SELECT 0,coalesce(jsonb_agg(r ORDER BY n),'[]') /* payable_columns_059_all_source_rows */$new$),
 ('public.preview_payables_daily_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean)',
  $old$v_bank:=cf_private.payable_daily_bank(v_snapshot->>'branch',v_snapshot->>'bank_account',p_bank_mappings);$old$,
  $new$v_bank:=CASE WHEN length(btrim(coalesce(v_snapshot->>'cheque_number','')))>0 THEN cf_private.payable_cheque_payment_bank()
    ELSE cf_private.payable_daily_bank(v_snapshot->>'branch',v_snapshot->>'bank_account',p_bank_mappings) END;$new$),
 ('public.preview_payables_daily_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean)',
  $old$IF (v_snapshot->>'amount_cents')::bigint<>1 AND length(btrim(coalesce(v_snapshot->>'bank_account','')))>0 THEN$old$,
  $new$IF (v_snapshot->>'amount_cents')::bigint<>1 AND length(btrim(coalesce(v_snapshot->>'bank_account','')))>0
    AND length(btrim(coalesce(v_snapshot->>'cheque_number','')))=0 THEN$new$),
 ('public.preview_payables_daily_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean)',
  $old$IF v_bank IS NULL THEN v_problem:='Vincule a descrição bancária a uma conta oficial ou informe o banco real deste pagamento.';END IF;$old$,
  $new$IF length(btrim(coalesce(v_snapshot->>'cheque_number','')))>0 THEN
     IF cf_private.payable_cheque_payment_bank() IS NULL THEN v_problem:='Cadastre uma única conta bancária oficial ativa BRADESCO F2G para os cheques.';
     ELSIF v_bank IS DISTINCT FROM cf_private.payable_cheque_payment_bank() THEN v_problem:='Títulos com número de cheque devem ser pagos pelo BRADESCO F2G.';END IF;
    ELSIF v_bank IS NULL THEN v_problem:='Vincule a descrição bancária a uma conta oficial ou informe o banco real deste pagamento.';END IF;$new$),
 ('public.preview_payables_daily_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean)',
  $old$'daily_report_version','058'$old$,$new$'daily_report_version','059','column_rules_version','059'$new$),
 ('public.commit_payables_daily_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,uuid,text,date,uuid,boolean)',
  $old$IF p_bank_mappings ? (v_item->>'bank_mapping_key') AND length(btrim(coalesce(v_item->>'source_bank','')))>0 AND cf_private.payable_paid_bank_alias_name(v_item->>'source_bank') IS NULL THEN$old$,
  $new$IF p_bank_mappings ? (v_item->>'bank_mapping_key') AND length(btrim(coalesce(v_item->>'source_bank','')))>0
    AND length(btrim(coalesce(v_item->>'cheque_number','')))=0 AND cf_private.payable_paid_bank_alias_name(v_item->>'source_bank') IS NULL THEN$new$),
 ('public.commit_payables_daily_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,uuid,text,date,uuid,boolean)',
  $old$'daily_report_version','058'$old$,$new$'daily_report_version','059','column_rules_version','059'$new$),
 ('cf_private.normalize_payable_paid_rows(text,jsonb)',
  $old$v_internal:=cf_private.payable_paid_bank_text_key(v_row->>'paid_bank')='CAIXA INTERNO';$old$,
  $new$v_internal:=cf_private.payable_paid_bank_text_key(v_row->>'paid_bank')='CAIXA INTERNO'
   AND (v_row->'amount_paid_cents'='1'::jsonb OR NOT cf_private.payable_paid_effective_cheque(v_row));$new$),
 ('cf_private.normalize_payable_paid_mappings(jsonb,jsonb)',
  $old$IF cf_private.payable_paid_bank_text_key(v_row->>'paid_bank')='CAIXA INTERNO' THEN$old$,
  $new$IF cf_private.payable_paid_effective_cheque(v_row) THEN CONTINUE;END IF;
  IF cf_private.payable_paid_bank_text_key(v_row->>'paid_bank')='CAIXA INTERNO' THEN$new$),
 ('cf_private.preview_payable_paid_rows(jsonb,jsonb,jsonb)',
  $old$IF cf_private.payable_paid_bank_text_key(v_row->>'paid_bank')='CAIXA INTERNO' THEN v_bank:=NULL;$old$,
  $new$IF cf_private.payable_paid_effective_cheque(v_row) THEN v_bank:=cf_private.payable_cheque_payment_bank();
  ELSIF cf_private.payable_paid_bank_text_key(v_row->>'paid_bank')='CAIXA INTERNO' THEN v_bank:=NULL;$new$),
 ('cf_private.preview_payable_paid_rows(jsonb,jsonb,jsonb)',
  $old$'amount_changed',v_id IS NOT NULL AND v_title.amount_cents<>(v_row->>'amount_paid_cents')::bigint,'bank_account_id',v_bank$old$,
  $new$'amount_changed',v_id IS NOT NULL AND v_title.amount_cents<>(v_row->>'amount_paid_cents')::bigint,
   'payment_bank_rule',CASE WHEN cf_private.payable_paid_effective_cheque(v_row) THEN 'CHEQUE_F2G' ELSE 'SOURCE_BANK' END,'bank_account_id',v_bank$new$),
 ('cf_private.preview_payable_paid_rows(jsonb,jsonb,jsonb)',
  $old$v_outcome:='UNMAPPED_BANK';v_column:='Banco do pagamento';v_problem:='Vincule explicitamente esta filial/banco a uma conta oficial ativa.';$old$,
  $new$v_outcome:='UNMAPPED_BANK';v_column:='Banco do pagamento';
    v_problem:=CASE WHEN cf_private.payable_paid_effective_cheque(v_row) THEN 'Cadastre uma única conta bancária oficial ativa BRADESCO F2G para os cheques.'
     ELSE 'Vincule explicitamente esta filial/banco a uma conta oficial ativa.' END;$new$),
 ('cf_private.preview_payable_paid_rows_v2(text,jsonb,jsonb,jsonb,jsonb)',
  $old$RETURN v_base||jsonb_build_object('rows',v_out_rows,$old$,
  $new$RETURN v_base||jsonb_build_object('column_rules_version','059','cheque_payment_bank_id',cf_private.payable_cheque_payment_bank(),'rows',v_out_rows,$new$),
 ('public.commit_payables_paid_import_v2_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text,jsonb,uuid)',
  $old$WHERE r->>'outcome'<>'WRITE_OFF' AND r->>'bank_mapping_key'=v_mapping.key LIMIT 1;$old$,
  $new$WHERE r->>'outcome'<>'WRITE_OFF' AND r->>'payment_bank_rule'<>'CHEQUE_F2G' AND r->>'bank_mapping_key'=v_mapping.key LIMIT 1;$new$),
 ('public.commit_payables_paid_import_v2_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text,jsonb,uuid)',
  $old$IF (v_banks ? (v_row->>'bank_mapping_key') AND v_banks->>(v_row->>'bank_mapping_key') IS DISTINCT FROM v_source->>'bank_account_id')$old$,
  $new$IF (cf_private.payable_paid_effective_cheque(v_row) AND (cf_private.payable_cheque_payment_bank() IS NULL
       OR v_source->>'bank_account_id' IS DISTINCT FROM cf_private.payable_cheque_payment_bank()::text))
      OR (v_banks ? (v_row->>'bank_mapping_key') AND v_banks->>(v_row->>'bank_mapping_key') IS DISTINCT FROM v_source->>'bank_account_id')$new$),
 ('public.commit_payables_paid_import_v2_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text,jsonb,uuid)',
  $old$issued_on=CASE WHEN v_row ? 'issued_on' THEN (v_row->>'issued_on')::date ELSE issued_on END,bank_account=v_row->>'paid_bank',$old$,
  $new$issued_on=CASE WHEN v_row ? 'issued_on' THEN (v_row->>'issued_on')::date ELSE issued_on END,
   -- O banco previsto pertence à origem; o banco efetivo fica no pagamento.
   bank_account=bank_account,$new$),
 ('public.commit_payables_paid_import_v2_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text,jsonb,uuid)',
  $old$'paid_bank_rules_version','050');$old$,$new$'paid_bank_rules_version','050','column_rules_version','059');$new$),
 ('public.register_payable_payment(uuid,bigint,date,uuid,text,uuid,uuid,uuid)',
  $old$IF v_bank.id IS NULL THEN RAISE EXCEPTION 'Selecione uma conta oficial ativa.' USING ERRCODE='22023'; END IF;$old$,
  $new$IF v_bank.id IS NULL THEN RAISE EXCEPTION 'Selecione uma conta oficial ativa.' USING ERRCODE='22023'; END IF;
  -- Depois da repetição idempotente: pagamentos históricos não são reescritos.
  IF length(btrim(coalesce(v_title.cheque_number,'')))>0 AND
   (cf_private.payable_cheque_payment_bank() IS NULL OR v_bank.id IS DISTINCT FROM cf_private.payable_cheque_payment_bank()) THEN
   RAISE EXCEPTION 'Títulos com número de cheque exigem uma única conta oficial ativa BRADESCO F2G.' USING ERRCODE='22023';END IF;$new$),
 ('public.payables_import_capabilities()',
  $old$'daily_report_version','058'$old$,$new$'daily_report_version','059','column_rules_version','059'$new$)
 ) AS changes(signature,old_text,new_text) LOOP
  IF to_regprocedure(v_patch.signature) IS NULL THEN RAISE EXCEPTION 'Contrato ausente: %.',v_patch.signature USING ERRCODE='22023';END IF;
  v_definition:=pg_get_functiondef(v_patch.signature::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_patch.old_text,'')))/length(v_patch.old_text)<>1 THEN
   RAISE EXCEPTION 'O contrato % não corresponde à atualização esperada. Nenhum dado foi alterado.',v_patch.signature USING ERRCODE='22023';END IF;
  EXECUTE replace(v_definition,v_patch.old_text,v_patch.new_text);
 END LOOP;
 INSERT INTO public.central_schema_migrations(version) VALUES('059_payable_column_rules');
 NOTIFY pgrst,'reload schema';
END $apply_059$;
COMMIT;
