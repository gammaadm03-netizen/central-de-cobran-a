-- Contas a Pagar: correspondências oficiais de bancos e baixa individual de Caixa Interno.
-- A instalação preserva cadastros, saldos, pagamentos, previsões e históricos.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $cf050$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN RAISE EXCEPTION 'Ative o banco da Central Financeira antes desta atualização.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='050_paid_bank_rules') THEN RETURN;END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['012_treasury_accounts','042_payable_administrative_writeoff','043_payable_import_reconciliation']) v WHERE NOT EXISTS(SELECT 1 FROM public.central_schema_migrations m WHERE m.version=v)) THEN
  RAISE EXCEPTION 'Ative as atualizações 012, 042 e 043 antes das regras de bancos.' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(2045812301);
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 PERFORM pg_advisory_xact_lock(2045812309);
 EXECUTE $cf050ddl$
CREATE OR REPLACE FUNCTION cf_private.payable_paid_bank_text_key(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT btrim(regexp_replace(replace(regexp_replace(pg_catalog.normalize(upper(coalesce(p_text,'')),'NFD'),U&'[\0300-\036f]','','g'),chr(160),' '),'[[:space:]]+',' ','g'));
$$;
CREATE TABLE cf_private.payable_paid_bank_aliases(
 source_key text PRIMARY KEY CHECK(length(source_key) BETWEEN 1 AND 300 AND source_key=cf_private.payable_paid_bank_text_key(source_key)),
 official_bank_name text NOT NULL CHECK(length(btrim(official_bank_name)) BETWEEN 1 AND 200)
);
ALTER TABLE cf_private.payable_paid_bank_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.payable_paid_bank_aliases FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION cf_private.payable_paid_bank_alias_name(p_bank text) RETURNS text
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT official_bank_name FROM cf_private.payable_paid_bank_aliases WHERE source_key=cf_private.payable_paid_bank_text_key(p_bank);
$$;
CREATE OR REPLACE FUNCTION cf_private.payable_paid_alias_account(p_bank text) RETURNS uuid
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT CASE WHEN count(*)=1 THEN (array_agg(id ORDER BY id))[1] END
 FROM public.bank_accounts WHERE enabled AND account_type='BANK'
  AND cf_private.payable_paid_bank_text_key(display_name)=cf_private.payable_paid_bank_text_key(cf_private.payable_paid_bank_alias_name(p_bank));
$$;
CREATE OR REPLACE FUNCTION cf_private.payable_paid_is_administrative(p_row jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce((p_row->>'amount_paid_cents')::numeric=1,false) OR cf_private.payable_paid_bank_text_key(p_row->>'paid_bank')='CAIXA INTERNO';
$$;


CREATE OR REPLACE FUNCTION cf_private.normalize_payable_paid_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_rows jsonb[]:=ARRAY[]::jsonb[];v_line integer:=0;v_date date;v_amount numeric;v_total numeric:=0;v_field text;v_internal boolean;
BEGIN
 IF p_scope IS DISTINCT FROM 'grupo-consolidado' OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Informe de 1 a 5.000 títulos explicitamente pagos do grupo consolidado.' USING ERRCODE='22023';END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  v_line:=v_line+1;
  IF jsonb_typeof(v_row)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN('branch','entry_number','source_status','paid_on','amount_paid_cents','paid_bank','cheque_number','description','plan','issued_on')) THEN
   RAISE EXCEPTION 'Linha %: estrutura inválida para confirmação de pagamentos.',v_line USING ERRCODE='22023';END IF;
  v_internal:=cf_private.payable_paid_bank_text_key(v_row->>'paid_bank')='CAIXA INTERNO';
  FOREACH v_field IN ARRAY ARRAY['branch','entry_number','paid_bank','source_status'] LOOP
   IF jsonb_typeof(v_row->v_field) IS DISTINCT FROM 'string' OR length(btrim(v_row->>v_field))=0 OR v_row->>v_field ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Linha %: % deve ser informado explicitamente.',v_line,v_field USING ERRCODE='22023';END IF;
  END LOOP;
  IF length(v_row->>'branch')>150 OR length(v_row->>'entry_number')>150 OR length(v_row->>'paid_bank')>300 OR upper(btrim(v_row->>'source_status'))<>'PAGO' THEN
   RAISE EXCEPTION 'Linha %: confirme que o título está pago e confira os limites de identificação/banco.',v_line USING ERRCODE='22023';END IF;
  IF jsonb_typeof(v_row->'amount_paid_cents') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Linha %: informe o valor real pago em centavos inteiros.',v_line USING ERRCODE='22023';END IF;
  v_amount:=(v_row->>'amount_paid_cents')::numeric;
  IF v_amount<>trunc(v_amount) OR v_amount NOT BETWEEN 1 AND 9007199254740991 THEN RAISE EXCEPTION 'Linha %: valor real pago inválido.',v_line USING ERRCODE='22023';END IF;
  v_total:=v_total+v_amount;IF v_total>9007199254740991 THEN RAISE EXCEPTION 'O valor pago do relatório excede o limite de precisão.' USING ERRCODE='22003';END IF;
  v_date:=NULL;
  IF NOT v_internal OR coalesce(jsonb_typeof(v_row->'paid_on'),'null')<>'null' THEN
   IF jsonb_typeof(v_row->'paid_on') IS DISTINCT FROM 'string' OR v_row->>'paid_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Linha %: informe a data real do pagamento em AAAA-MM-DD.',v_line USING ERRCODE='22023';END IF;
   BEGIN v_date:=(v_row->>'paid_on')::date;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Linha %: data real do pagamento inválida.',v_line USING ERRCODE='22023';END;
   IF v_date<DATE '1900-01-01' OR NOT v_internal AND v_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN RAISE EXCEPTION 'Linha %: informe uma data real de pagamento até hoje.',v_line USING ERRCODE='22023';END IF;
  END IF;
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

CREATE OR REPLACE FUNCTION cf_private.normalize_payable_paid_mappings(p_rows jsonb,p_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_mapping record;v_id uuid;v_row jsonb;v_alias text;v_result jsonb:=p_mappings;BEGIN
 IF p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'object' OR octet_length(p_mappings::text)>2000000 THEN RAISE EXCEPTION 'Informe os vínculos explícitos de bancos.' USING ERRCODE='22023';END IF;
 FOR v_mapping IN SELECT key,value FROM jsonb_each(p_mappings) LOOP
  IF jsonb_typeof(v_mapping.value)<>'string' OR v_mapping.value#>>'{}' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE r->>'bank_mapping_key'=v_mapping.key) THEN
   RAISE EXCEPTION 'O vínculo deve corresponder a uma filial/banco deste relatório e a uma conta oficial.' USING ERRCODE='22023';END IF;
  v_id:=(v_mapping.value#>>'{}')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=v_id AND enabled) THEN RAISE EXCEPTION 'Selecione uma conta oficial ativa para o pagamento.' USING ERRCODE='22023';END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF cf_private.payable_paid_bank_text_key(v_row->>'paid_bank')='CAIXA INTERNO' THEN
   IF p_mappings ? (v_row->>'bank_mapping_key') THEN RAISE EXCEPTION 'Caixa Interno exige baixa sem pagamento; não selecione uma conta bancária.' USING ERRCODE='22023';END IF;
   CONTINUE;
  END IF;
  IF cf_private.payable_paid_is_administrative(v_row) THEN CONTINUE;END IF;
  v_alias:=cf_private.payable_paid_bank_alias_name(v_row->>'paid_bank');
  IF v_alias IS NULL THEN CONTINUE;END IF;
  v_id:=cf_private.payable_paid_alias_account(v_row->>'paid_bank');
  IF p_mappings ? (v_row->>'bank_mapping_key') AND (v_id IS NULL OR (p_mappings->>(v_row->>'bank_mapping_key'))::uuid<>v_id) THEN
   RAISE EXCEPTION 'O banco selecionado diverge da correspondência oficial deste relatório.' USING ERRCODE='22023';END IF;
  IF v_id IS NOT NULL THEN v_result:=v_result||jsonb_build_object(v_row->>'bank_mapping_key',v_id);END IF;
 END LOOP;RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION cf_private.preview_payable_paid_rows(p_rows jsonb,p_mappings jsonb,p_plan_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_title public.payable_review_titles%ROWTYPE;v_id uuid;v_bank uuid;v_registered uuid;v_bank_count integer;v_total integer;v_active integer;
 v_paid numeric;v_dates boolean;v_banks boolean;v_macro boolean;v_owned boolean;v_cheque boolean;v_ids uuid[];v_problem text;v_outcome text;v_column text;
 v_rows jsonb[]:=ARRAY[]::jsonb[];v_errors jsonb[]:=ARRAY[]::jsonb[];v_unmapped jsonb;v_options jsonb;v_plans jsonb;v_macros jsonb;v_target_macro text;v_override public.payable_title_macro_overrides%ROWTYPE;v_new integer:=0;v_matched integer:=0;v_correct integer:=0;
BEGIN
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  v_id:=NULL;v_bank:=NULL;v_registered:=NULL;v_problem:='';v_outcome:='';v_column:='Lançamento';v_ids:=ARRAY[]::uuid[];v_target_macro:=NULL;
  IF cf_private.payable_paid_bank_text_key(v_row->>'paid_bank')='CAIXA INTERNO' THEN v_bank:=NULL;
  ELSIF cf_private.payable_paid_bank_alias_name(v_row->>'paid_bank') IS NOT NULL THEN v_bank:=cf_private.payable_paid_alias_account(v_row->>'paid_bank');
  ELSIF p_mappings ? (v_row->>'bank_mapping_key') THEN v_bank:=(p_mappings->>(v_row->>'bank_mapping_key'))::uuid;
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

CREATE OR REPLACE FUNCTION cf_private.preview_payable_paid_rows_v2(p_scope text,p_rows jsonb,p_bank_mappings jsonb,p_mappings jsonb,p_resolution_choices jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_rows jsonb;v_banks jsonb;v_plans jsonb;v_choices jsonb;v_base jsonb;v_row jsonb;v_choice jsonb;v_title public.payable_review_titles%ROWTYPE;
 v_out_rows jsonb:='[]';v_errors jsonb:='[]';v_resolution_errors jsonb:='[]';v_items jsonb:='[]';v_item jsonb;v_problem text;v_key text;v_outcome text;v_active_writeoff uuid;
 v_new integer:=0;v_matched integer:=0;v_correct integer:=0;v_writeoff integer:=0;v_new_writeoff integer:=0;v_matched_writeoff integer:=0;v_mapping record;v_unmapped jsonb;v_unclassified jsonb;v_previous uuid;
BEGIN
 v_rows:=cf_private.normalize_payable_paid_rows(p_scope,p_rows);
 v_banks:=cf_private.normalize_payable_paid_mappings(v_rows,p_bank_mappings);
 v_plans:=cf_private.normalize_payable_paid_plans(v_rows,p_mappings);
 v_choices:=cf_private.validate_payable_import_resolution_choices(p_resolution_choices);
 v_base:=cf_private.preview_payable_paid_rows(v_rows,v_banks,v_plans);
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_base->'rows') LOOP
  v_problem:='';v_key:='row:'||(v_row->>'line');v_choice:=v_choices->v_key;v_active_writeoff:=NULL;
  IF cf_private.payable_paid_is_administrative(v_row) AND v_row->>'title_id' IS NOT NULL THEN
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_row->>'title_id')::uuid;
   SELECT id INTO v_active_writeoff FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=v_title.id;
   -- A sentinela não autoriza mesclar versões da identidade nem apagar pagamentos.
   IF EXISTS(SELECT 1 FROM public.payable_titles other WHERE other.id<>v_title.id AND other.scope=p_scope
      AND cf_private.payable_business_key(other.branch,other.entry_number)=v_row->>'business_key'
      AND(other.status<>'SETTLED_IMPORT' OR EXISTS(SELECT 1 FROM public.payable_payments pay WHERE pay.title_id=other.id
       AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals rev WHERE rev.payment_id=pay.id)))) THEN
    v_problem:='Há versões ativas da mesma filial e lançamento. Confira a identidade antes da baixa sem pagamento.';
   ELSIF EXISTS(SELECT 1 FROM public.payable_payments pay WHERE pay.title_id=v_title.id AND NOT EXISTS(
       SELECT 1 FROM public.payable_payment_reversals rev WHERE rev.payment_id=pay.id)) THEN
    v_problem:='Este título já possui pagamento efetivo. Confira e corrija o histórico antes de confirmar uma baixa sem pagamento.';
   ELSIF NOT v_title.closing_eligible AND v_active_writeoff IS NULL THEN
    v_problem:='Esta versão é somente histórica. Confira o título canônico antes da baixa sem pagamento.';
   ELSIF v_choice IS NULL THEN
    v_problem:='Confirme individualmente a baixa sem pagamento deste título.';
   ELSIF v_choice->>'action'<>'WRITE_OFF' THEN
    v_problem:='Este título deve ser baixado sem pagamento, com confirmação individual.';
   END IF;
   v_outcome:=CASE WHEN v_problem='' THEN 'WRITE_OFF' ELSE 'WRITE_OFF_PENDING' END;
   v_item:=jsonb_build_object('key',v_key,'kind',CASE WHEN (v_row->>'amount_paid_cents')::bigint=1 THEN 'CENT' ELSE 'INTERNAL_CASH' END,'line',(v_row->>'line')::integer,'title_id',v_title.id,
    'branch',v_title.branch,'entry_number',v_title.entry_number,'description',v_title.description,'due_date',v_title.due_date,
    'amount_cents',v_title.amount_cents,'source_amount_cents',(v_row->>'amount_paid_cents')::bigint,'payment_revision',v_title.payment_revision,
    'already_written_off',v_active_writeoff IS NOT NULL,'allowed_actions',jsonb_build_array('WRITE_OFF'),
    'selected_action',v_choice->>'action','requires_resolution',true,'problem',nullif(v_problem,''));
   v_items:=v_items||jsonb_build_array(v_item);
   v_row:=v_row||jsonb_build_object('outcome',v_outcome,'problem',v_problem,'bank_account_id',NULL,'payment_ids','[]'::jsonb,
    'amount_changed',false,'updated_amount_cents',v_title.amount_cents,'resolution_key',v_key,'administrative_writeoff_id',v_active_writeoff);
   v_writeoff:=v_writeoff+1;IF v_active_writeoff IS NULL THEN v_new_writeoff:=v_new_writeoff+1;ELSE v_matched_writeoff:=v_matched_writeoff+1;END IF;
   IF v_problem<>'' THEN v_resolution_errors:=v_resolution_errors||jsonb_build_array(jsonb_build_object('line',(v_row->>'line')::integer,'column','Baixa sem pagamento',
    'problem',v_problem,'correction','Confira este título e confirme expressamente a baixa sem pagamento, informando o motivo.'));
   END IF;
  ELSE
   IF cf_private.payable_paid_is_administrative(v_row) AND v_row->>'title_id' IS NULL THEN
    v_items:=v_items||jsonb_build_array(jsonb_build_object('key',v_key,'kind',CASE WHEN (v_row->>'amount_paid_cents')::bigint=1 THEN 'CENT' ELSE 'INTERNAL_CASH' END,'line',(v_row->>'line')::integer,
     'title_id',NULL,'branch',v_row->>'branch','entry_number',v_row->>'entry_number','description',coalesce(v_row->>'description',''),
     'due_date',NULL,'amount_cents',NULL,'source_amount_cents',(v_row->>'amount_paid_cents')::bigint,'allowed_actions','[]'::jsonb,'selected_action',NULL,
     'requires_resolution',false,'problem','Título para baixa sem pagamento não encontrado. Importe primeiro a previsão para preservar o vencimento e o valor original.'));
   END IF;
   -- Uma baixa anterior nunca é reaberta por um relatório de pagamentos.
   IF v_row->>'title_id' IS NOT NULL AND EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=(v_row->>'title_id')::uuid) THEN
    v_row:=v_row||jsonb_build_object('outcome','CONFLICT','problem','Este título foi baixado sem pagamento. Reabra-o expressamente na importação de previsões antes de registrar um pagamento.');
    v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',(v_row->>'line')::integer,'column','Baixa sem pagamento',
     'problem',v_row->>'problem','correction','Importe o título na previsão e confirme a reabertura antes de importar este pagamento.'));
   ELSE
    v_errors:=v_errors||coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(v_base->'errors') e WHERE e->>'line'=v_row->>'line'),'[]'::jsonb);
   END IF;
   CASE v_row->>'outcome' WHEN 'NEW_PAYMENT' THEN v_new:=v_new+1;WHEN 'MATCHED' THEN v_matched:=v_matched+1;WHEN 'CORRECTION' THEN v_correct:=v_correct+1;ELSE NULL;END CASE;
  END IF;
  v_out_rows:=v_out_rows||jsonb_build_array(v_row);
 END LOOP;
 FOR v_mapping IN SELECT key,value FROM jsonb_each(v_choices) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_items) i WHERE i->>'key'=v_mapping.key AND i->>'title_id' IS NOT NULL) THEN
   RAISE EXCEPTION 'A escolha de baixa deve corresponder a uma linha administrativa conhecida deste relatório.' USING ERRCODE='22023';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'branch',branch,'paid_bank',paid_bank,'count',n,'official_bank_name',cf_private.payable_paid_bank_alias_name(paid_bank)) ORDER BY key),'[]'::jsonb) INTO v_unmapped FROM(
  SELECT r->>'bank_mapping_key' key,min(r->>'branch') branch,min(r->>'paid_bank') paid_bank,count(*) n FROM jsonb_array_elements(v_out_rows) r
   WHERE NOT cf_private.payable_paid_is_administrative(r) AND r->>'bank_account_id' IS NULL GROUP BY r->>'bank_mapping_key') x;
 SELECT coalesce(jsonb_agg(jsonb_build_object('plan',plan,'count',n,'total_cents',total_cents) ORDER BY plan),'[]'::jsonb) INTO v_unclassified FROM(
  SELECT r->>'plan' plan,count(*) n,sum((r->>'amount_paid_cents')::numeric) total_cents FROM jsonb_array_elements(v_out_rows) r
   WHERE r->>'outcome'='UNCLASSIFIED_PLAN' GROUP BY r->>'plan') x;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN v_base||jsonb_build_object('rows',v_out_rows,'new_payment_count',v_new,'matched_payment_count',v_matched,'correction_count',v_correct,
  'writeoff_count',v_writeoff,'new_writeoff_count',v_new_writeoff,'matched_writeoff_count',v_matched_writeoff,'conflict_count',jsonb_array_length(v_errors)+jsonb_array_length(v_resolution_errors),'errors',v_errors||v_resolution_errors,
  'unmapped_banks',v_unmapped,'unclassified_plans',v_unclassified,'can_commit',jsonb_array_length(v_errors)=0 AND jsonb_array_length(v_resolution_errors)=0,
  'reconciliation_version','043','full_report',false,'reconciliation_items',v_items,'resolution_errors',v_resolution_errors,
  'previous_import_id',v_previous,'financial_revision',public.get_payables_revision()->>'financial_revision',
  'bank_accounts',cf_private.payable_import_resolution_bank_options(),'bank_options',cf_private.payable_import_resolution_bank_options());
END $$;

CREATE OR REPLACE FUNCTION public.commit_payables_paid_import_v2_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,
 p_file_base64 text,p_rows jsonb,p_bank_mappings jsonb,p_previous_import_id uuid DEFAULT NULL,p_confirm_corrections boolean DEFAULT false,
 p_mappings jsonb DEFAULT '{}'::jsonb,p_previous_financial_revision text DEFAULT NULL,p_resolution_choices jsonb DEFAULT '{}'::jsonb,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_banks jsonb;v_plans jsonb;v_choices jsonb;v_preview jsonb;v_row jsonb;v_file bytea;v_previous uuid;v_id uuid:=gen_random_uuid();v_existing uuid;v_existing_mode text;
 v_payload jsonb;v_replay jsonb;v_result jsonb;v_title public.payable_review_titles%ROWTYPE;v_payment uuid;v_payments uuid[];v_review uuid;v_mapping record;v_current_mapping uuid;
 v_new integer:=0;v_matched integer:=0;v_correct integer:=0;v_writeoff integer:=0;v_new_writeoff integer:=0;v_matched_writeoff integer:=0;
 v_observation text;v_source jsonb;v_outcome text;v_choice jsonb;v_writeoff_id uuid;v_writeoff_rows jsonb:='[]';
BEGIN
 PERFORM cf_private.require_payable_import_reconciliation_actor(p_user_id,p_session_id);
 IF p_confirm_corrections IS NULL OR p_request_id IS NULL THEN RAISE EXCEPTION 'Confirme os dados e identifique esta solicitação de importação.' USING ERRCODE='22023';END IF;
 v_file:=cf_private.validate_payable_reconciliation_file(p_file_name,p_file_sha256,p_file_base64);
 v_payload:=jsonb_build_object('scope',p_scope,'mode','payments','file_name',p_file_name,'file_sha256',p_file_sha256,'rows',p_rows,'bank_mappings',p_bank_mappings,
  'mappings',p_mappings,'previous_import_id',p_previous_import_id,'confirm_corrections',p_confirm_corrections,
  'previous_financial_revision',p_previous_financial_revision,'resolution_choices',p_resolution_choices,'reconciliation_version','043');
 v_replay:=cf_private.payable_import_resolution_replay(p_request_id,v_payload);IF v_replay IS NOT NULL THEN RETURN v_replay;END IF;
 -- O reconhecimento durável do mesmo protocolo não depende de um banco ainda ativo hoje.
 v_rows:=cf_private.normalize_payable_paid_rows(p_scope,p_rows);
 v_banks:=cf_private.normalize_payable_paid_mappings(v_rows,p_bank_mappings);v_plans:=cf_private.normalize_payable_paid_plans(v_rows,p_mappings);
 v_choices:=cf_private.validate_payable_import_resolution_choices(p_resolution_choices);
 SELECT i.id,m.mode,m.result INTO v_existing,v_existing_mode,v_result FROM public.payable_imports i LEFT JOIN public.payable_import_modes m ON m.import_id=i.id
  WHERE i.scope=p_scope AND i.file_sha256=p_file_sha256 AND i.import_mode='PAYMENTS';
 IF v_existing IS NOT NULL THEN
  IF v_existing_mode='PAYMENTS' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE cf_private.payable_paid_is_administrative(r))
      AND coalesce(v_result->>'reconciliation_version','')<>'043' THEN
    RAISE EXCEPTION 'Este relatório já foi registrado pela versão anterior com baixas administrativas. Confira os pagamentos históricos antes de corrigir as baixas; nenhum pagamento será apagado automaticamente.' USING ERRCODE='P0042';
   END IF;
   -- Uma retransmissão do mesmo protocolo já retornou acima. Um protocolo novo
   -- ainda exige a confirmação individual, mesmo quando o arquivo não gera novos eventos.
   FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) WHERE cf_private.payable_paid_is_administrative(value) LOOP
    IF coalesce(v_choices->('row:'||(v_row->>'line'))->>'action','')<>'WRITE_OFF' THEN
     RAISE EXCEPTION 'Confirme individualmente cada baixa sem pagamento antes de repetir esta importação.' USING ERRCODE='P0042';END IF;
    IF EXISTS(SELECT 1 FROM public.payable_paid_import_rows own WHERE own.import_id=v_existing AND own.source_row->>'business_key'=v_row->>'business_key') THEN
     RAISE EXCEPTION 'Este título já foi registrado com pagamento neste arquivo. Confira o histórico antes de confirmar uma baixa sem pagamento.' USING ERRCODE='P0042';END IF;
   END LOOP;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_choices) k WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE 'row:'||(r->>'line')=k AND cf_private.payable_paid_is_administrative(r))) THEN
    RAISE EXCEPTION 'A escolha deve corresponder a uma linha administrativa deste relatório.' USING ERRCODE='22023';END IF;
   FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) WHERE NOT cf_private.payable_paid_is_administrative(value) LOOP
    SELECT source_row INTO v_source FROM public.payable_paid_import_rows WHERE import_id=v_existing
      AND source_row->>'business_key'=v_row->>'business_key';
    IF v_source IS NULL THEN
     RAISE EXCEPTION 'Confira o histórico deste arquivo antes de repetir a importação.' USING ERRCODE='P0042';END IF;
    IF (v_banks ? (v_row->>'bank_mapping_key') AND v_banks->>(v_row->>'bank_mapping_key') IS DISTINCT FROM v_source->>'bank_account_id')
      OR (v_row ? 'plan' AND v_plans ? (v_row->>'plan') AND v_plans->>(v_row->>'plan') IS DISTINCT FROM v_source->>'target_macro') THEN
     RAISE EXCEPTION 'Este arquivo já foi conciliado com outro banco ou classificação. Confira o histórico e corrija expressamente; a repetição do arquivo não altera decisões já registradas.' USING ERRCODE='P0042';END IF;
   END LOOP;
   RETURN cf_private.record_payable_import_resolution(p_request_id,v_payload,v_result||jsonb_build_object('idempotent',true,'request_id',p_request_id,'reconciliation_version','043',
    'reconciled_at',coalesce(v_result->>'reconciled_at',clock_timestamp()::text),
    'writeoff_count',coalesce((v_result->>'writeoff_count')::integer,0),
    'new_writeoff_count',coalesce((v_result->>'new_writeoff_count')::integer,0),
    'matched_writeoff_count',coalesce((v_result->>'matched_writeoff_count')::integer,0)));
  END IF;
  RAISE EXCEPTION 'Este arquivo já foi registrado em outro modo de importação.' USING ERRCODE='23505';END IF;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN RAISE EXCEPTION 'A base mudou. Gere nova análise antes de confirmar os pagamentos.' USING ERRCODE='40001';END IF;
 IF p_previous_financial_revision IS NULL OR p_previous_financial_revision IS DISTINCT FROM public.get_payables_revision()->>'financial_revision' THEN
  RAISE EXCEPTION 'Os dados financeiros mudaram. Gere nova análise antes de confirmar os pagamentos.' USING ERRCODE='40001';END IF;
 -- O mesmo lock do lançamento de pagamentos e das baixas protege toda a análise e aplicação.
 PERFORM 1 FROM public.payable_titles t WHERE t.scope=p_scope AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r
  WHERE r->>'business_key'=cf_private.payable_business_key(t.branch,t.entry_number)) ORDER BY t.id FOR UPDATE;
 v_preview:=cf_private.preview_payable_paid_rows_v2(p_scope,p_rows,p_bank_mappings,p_mappings,p_resolution_choices);
 IF NOT coalesce((v_preview->>'can_commit')::boolean,false) THEN
  RAISE EXCEPTION 'A importação possui pendências. Confirme cada baixa sem pagamento e confira os pagamentos; nenhum dado foi alterado.' USING ERRCODE='P0042',DETAIL=(v_preview->'errors')::text;END IF;
 IF (v_preview->>'correction_count')::integer>0 AND NOT p_confirm_corrections THEN
  RAISE EXCEPTION 'Confirme expressamente os estornos e a substituição dos pagamentos originados em importações anteriores.' USING ERRCODE='P0042';END IF;
 INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode)
  VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),0,jsonb_array_length(v_rows),0,'PAYMENTS');
 INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
 -- Classificações financeiras só são aplicadas quando utilizadas por linhas com pagamento real.
 INSERT INTO public.payable_plan_mappings(plan,macro) SELECT key,value#>>'{}' FROM jsonb_each(v_plans) mapping
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview->'rows') r WHERE r->>'outcome'<>'WRITE_OFF' AND r->>'plan'=mapping.key)
  ON CONFLICT(plan) DO UPDATE SET macro=EXCLUDED.macro,updated_at=clock_timestamp() WHERE payable_plan_mappings.macro IS DISTINCT FROM EXCLUDED.macro;
 FOR v_mapping IN SELECT key,value FROM jsonb_each(v_banks) LOOP
  SELECT r INTO v_source FROM jsonb_array_elements(v_preview->'rows') r WHERE r->>'outcome'<>'WRITE_OFF' AND r->>'bank_mapping_key'=v_mapping.key LIMIT 1;
  IF NOT FOUND THEN CONTINUE;END IF;
  SELECT bank_account_id INTO v_current_mapping FROM public.payable_paid_bank_mappings WHERE mapping_key=v_mapping.key ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_current_mapping IS DISTINCT FROM (v_mapping.value#>>'{}')::uuid THEN
   INSERT INTO public.payable_paid_bank_mappings(mapping_key,branch,paid_bank,bank_account_id,created_by,created_at)
    SELECT v_mapping.key,v_source->>'branch',v_source->>'paid_bank',(v_mapping.value#>>'{}')::uuid,auth.uid(),
     greatest(clock_timestamp(),coalesce(max(created_at),'1900-01-01'::timestamptz)+interval '1 microsecond') FROM public.payable_paid_bank_mappings WHERE mapping_key=v_mapping.key;
  END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_preview->'rows') LOOP
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_row->>'title_id')::uuid;
  v_outcome:=v_row->>'outcome';v_payments:=ARRAY[]::uuid[];
  IF v_outcome='WRITE_OFF' THEN
   v_choice:=v_choices->('row:'||(v_row->>'line'));
   SELECT id INTO v_writeoff_id FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=v_title.id;
   IF v_writeoff_id IS NULL THEN
    v_source:=cf_private.record_payable_administrative_writeoff(v_title.id,v_id,v_choice->>'reason',v_title.payment_revision);
    v_writeoff_id:=(v_source->>'writeoff_id')::uuid;v_new_writeoff:=v_new_writeoff+1;
   ELSE v_matched_writeoff:=v_matched_writeoff+1;END IF;
   v_writeoff:=v_writeoff+1;
   v_writeoff_rows:=v_writeoff_rows||jsonb_build_array(jsonb_build_object('line',(v_row->>'line')::integer,'title_id',v_title.id,'writeoff_id',v_writeoff_id,'amount_cents',v_title.amount_cents));
   CONTINUE;
  END IF;
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
  IF v_outcome IN('NEW_PAYMENT','CORRECTION') THEN
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
   v_observation:='Pagamento integral informado em relatório de títulos pagos. Importação '||v_id::text;
   v_payment:=public.register_payable_payment(v_title.id,(v_row->>'amount_paid_cents')::bigint,(v_row->>'paid_on')::date,
    (v_row->>'bank_account_id')::uuid,v_observation,v_title.payment_revision,gen_random_uuid(),v_title.last_import_id);
   v_payments:=ARRAY[v_payment];IF v_outcome='CORRECTION' THEN v_correct:=v_correct+1;ELSE v_new:=v_new+1;END IF;
  ELSE SELECT coalesce(array_agg(value::uuid),'{}'::uuid[]) INTO v_payments FROM jsonb_array_elements_text(v_row->'payment_ids');v_matched:=v_matched+1;END IF;
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
  v_review:=public.review_payable_title(v_title.id,'Conciliação automática por relatório explícito de títulos pagos. Importação '||v_id::text,v_title.review_fingerprint);
  INSERT INTO public.payable_paid_import_rows(import_id,title_id,outcome,payment_ids,review_id,source_row)
   VALUES(v_id,v_title.id,CASE WHEN v_outcome='NEW_PAYMENT' THEN 'CREATED' WHEN v_outcome='CORRECTION' THEN 'CORRECTED' ELSE 'MATCHED' END,v_payments,v_review,v_row);
 END LOOP;
 v_result:=jsonb_build_object('mode','payments','import_id',v_id,'row_count',jsonb_array_length(v_rows),'new_payment_count',v_new,'matched_payment_count',v_matched,
  'correction_count',v_correct,'reviewed_count',v_new+v_matched+v_correct,'settled_count',0,'writeoff_count',v_writeoff,
  'new_writeoff_count',v_new_writeoff,'matched_writeoff_count',v_matched_writeoff,'writeoff_rows',v_writeoff_rows,'reconciliation_version','043','request_id',p_request_id,'reconciled_at',clock_timestamp(),'idempotent',false,'paid_bank_rules_version','050');
 INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES(v_id,'PAYMENTS',v_result,auth.uid());
 RETURN cf_private.record_payable_import_resolution(p_request_id,v_payload,v_result);
END $$;

CREATE OR REPLACE FUNCTION public.payables_import_capabilities() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('contas_pagar','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('schema_version','043_payable_import_reconciliation','cheque_number',true,'forecast_incremental',true,'paid_import',true,
  'import_reconciliation',true,'reconciliation_version','043','paid_bank_rules_version','050','internal_cash_writeoff',true);
END $$;
REVOKE ALL ON FUNCTION cf_private.payable_paid_bank_text_key(text),cf_private.payable_paid_bank_alias_name(text),cf_private.payable_paid_alias_account(text),cf_private.payable_paid_is_administrative(jsonb) FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.central_schema_migrations(version) VALUES('050_paid_bank_rules');
NOTIFY pgrst,'reload schema';
$cf050ddl$;
END $cf050$;
COMMIT;
