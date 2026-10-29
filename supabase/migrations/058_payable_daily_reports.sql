-- Relatórios diários completos, com posições independentes de títulos e cheques.
-- A instalação não baixa títulos nem altera pagamentos anteriores.
BEGIN;
DO $apply_058$
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='050_paid_bank_rules') THEN
  RAISE EXCEPTION 'Ative a atualização 050 antes dos relatórios diários de Contas a Pagar.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='058_payable_daily_reports') THEN RETURN;END IF;
 EXECUTE $source_058$
CREATE TABLE cf_private.payable_daily_reports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),report_kind text NOT NULL CHECK(report_kind IN('NORMAL','CHEQUES')),
 file_sha256 text NOT NULL CHECK(file_sha256~'^[a-f0-9]{64}$'),report_date date NOT NULL,
 source_import_id uuid NOT NULL REFERENCES public.payable_imports(id),previous_report_id uuid REFERENCES cf_private.payable_daily_reports(id),
 rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array'),position jsonb NOT NULL CHECK(jsonb_typeof(position)='array'),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_daily_reports_latest ON cf_private.payable_daily_reports(report_kind,created_at DESC,id DESC);
CREATE UNIQUE INDEX payable_daily_reports_nonempty_file ON cf_private.payable_daily_reports(report_kind,file_sha256) WHERE jsonb_array_length(rows)>0;
CREATE TABLE cf_private.payable_daily_requests(
 actor_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 report_id uuid NOT NULL REFERENCES cf_private.payable_daily_reports(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE cf_private.payable_daily_actions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),report_id uuid NOT NULL REFERENCES cf_private.payable_daily_reports(id),
 title_id uuid NOT NULL REFERENCES public.payable_titles(id),payment_id uuid UNIQUE REFERENCES public.payable_payments(id),
 writeoff_id uuid REFERENCES public.payable_administrative_writeoffs(id),effective_on date NOT NULL,
 rule_kind text NOT NULL CHECK(rule_kind IN('DUE_DATE','IMPORT_DATE','CENT')),
 title_snapshot jsonb NOT NULL CHECK(jsonb_typeof(title_snapshot)='object'),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((payment_id IS NOT NULL)::integer+(writeoff_id IS NOT NULL)::integer=1),UNIQUE(report_id,title_id)
);
CREATE INDEX payable_daily_actions_title ON cf_private.payable_daily_actions(title_id,created_at DESC,id DESC);
DO $$ DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['payable_daily_reports','payable_daily_requests','payable_daily_actions'] LOOP
 EXECUTE format('ALTER TABLE cf_private.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('REVOKE ALL ON TABLE cf_private.%I FROM PUBLIC,anon,authenticated,service_role',n);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON cf_private.%I FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_closing_history()',n||'_immutable',n);
END LOOP;END $$;
-- Uma posição vazia não cria um título artificial. Somente o fluxo CHEQUES com
-- declaração expressa e prova durável pode registrar um arquivo com zero linhas.
ALTER TABLE public.payable_imports DROP CONSTRAINT payable_imports_row_count_check;
ALTER TABLE public.payable_imports ADD CONSTRAINT payable_imports_row_count_check CHECK(row_count BETWEEN 0 AND 5000 AND (row_count>0 OR import_mode='FORECAST'));
CREATE FUNCTION cf_private.guard_payable_empty_cheques_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NEW.row_count=0 AND NOT EXISTS(SELECT 1 FROM cf_private.payable_daily_reports d
  JOIN cf_private.payable_daily_requests r ON r.report_id=d.id
  JOIN cf_private.payable_import_files f ON f.import_id=NEW.id
  WHERE d.source_import_id=NEW.id AND d.report_kind='CHEQUES' AND d.rows='[]'::jsonb AND d.position='[]'::jsonb
   AND d.file_sha256=NEW.file_sha256 AND encode(sha256(f.file_bytes),'hex')=NEW.file_sha256
   AND r.payload->>'file_sha256'=NEW.file_sha256 AND r.payload->>'report_kind'='CHEQUES'
   AND r.payload->'rows'='[]'::jsonb AND r.payload->'empty_cheques_confirmed'='true'::jsonb
   AND r.result->>'report_kind'='CHEQUES' AND r.result->>'empty_cheques_confirmed'='true'
   AND r.result->>'report_id'=d.id::text AND r.result->>'import_id'=NEW.id::text AND r.result->'row_count'='0'::jsonb) THEN
  RAISE EXCEPTION 'Uma posição sem títulos exige relatório de cheques vazio e confirmação expressa da importação diária.' USING ERRCODE='22023';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER payable_empty_cheques_import_guard AFTER INSERT OR UPDATE ON public.payable_imports
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.row_count=0) EXECUTE FUNCTION cf_private.guard_payable_empty_cheques_import();

CREATE FUNCTION cf_private.payable_daily_is_cheque(p_status text,p_number text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT upper(btrim(coalesce(p_status,'')))='CHEQUE' OR length(btrim(coalesce(p_number,'')))>0 $$;
CREATE FUNCTION cf_private.payable_daily_bank_key(p_branch text,p_bank text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT jsonb_build_array(p_branch,p_bank)::text $$;
CREATE FUNCTION cf_private.payable_daily_bank(p_branch text,p_bank text,p_mappings jsonb) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_id uuid;v_key text:=cf_private.payable_daily_bank_key(p_branch,p_bank);v_alias text;v_official uuid;BEGIN
 v_alias:=cf_private.payable_paid_bank_alias_name(p_bank);v_official:=cf_private.payable_paid_alias_account(p_bank);
 IF p_mappings ? v_key THEN
  IF jsonb_typeof(p_mappings->v_key)<>'string' OR coalesce(p_mappings->>v_key,'')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
   RAISE EXCEPTION 'Selecione uma conta oficial para a descrição bancária.' USING ERRCODE='22023';END IF;
  SELECT id INTO v_id FROM public.bank_accounts WHERE id=(p_mappings->>v_key)::uuid AND enabled;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Selecione uma conta oficial ativa.' USING ERRCODE='22023';END IF;
  IF v_alias IS NOT NULL AND v_id IS DISTINCT FROM v_official THEN RAISE EXCEPTION 'O vínculo diverge da correspondência bancária oficial. Confira o pagamento individual.' USING ERRCODE='22023';END IF;RETURN v_id;
 END IF;
 IF v_alias IS NOT NULL THEN RETURN v_official;END IF;
 SELECT bank_account_id INTO v_id FROM public.payable_paid_bank_mappings WHERE mapping_key=cf_private.payable_paid_bank_key(p_branch,p_bank) ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=v_id AND enabled) THEN RETURN v_id;END IF;
 SELECT CASE WHEN count(*)=1 THEN (array_agg(id ORDER BY id))[1] END INTO v_id FROM public.bank_accounts
  WHERE enabled AND cf_private.payable_paid_bank_text_key(display_name)=cf_private.payable_paid_bank_text_key(p_bank);
 RETURN v_id;
END $$;
CREATE FUNCTION cf_private.payable_daily_revision() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT (public.get_payables_revision()->>'financial_revision')||':'||encode(sha256(convert_to(jsonb_build_object(
  'banks',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM public.bank_accounts a),
  'aliases',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.source_key),'[]') FROM cf_private.payable_paid_bank_aliases a),
  'bank_mappings',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM public.payable_paid_bank_mappings a),
  'plans',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.plan),'[]') FROM public.payable_plan_mappings a),
  'macros',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.name),'[]') FROM public.payable_macros a),
  'daily_heads',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.report_kind),'[]') FROM
   (SELECT DISTINCT ON(report_kind) report_kind,id FROM cf_private.payable_daily_reports ORDER BY report_kind,created_at DESC,id DESC) h))::text,'UTF8')),'hex');
$$;

CREATE FUNCTION public.preview_payables_daily_report(p_scope text,p_rows jsonb,p_report_kind text,p_mappings jsonb DEFAULT '{}',p_bank_mappings jsonb DEFAULT '{}',p_resolution_choices jsonb DEFAULT '{}',p_empty_cheques_confirmed boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_all_rows jsonb;v_clean jsonb;v_row jsonb;v_item jsonb;v_choice jsonb;v_title public.payable_financial_titles%ROWTYPE;
 v_last cf_private.payable_daily_reports%ROWTYPE;v_previous uuid;v_date date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_auto jsonb[]:=ARRAY[]::jsonb[];v_exceptions jsonb[]:=ARRAY[]::jsonb[];v_errors jsonb[]:=ARRAY[]::jsonb[];v_seen jsonb:='{}';v_bank_seen jsonb:='{}';
 v_new integer;v_changed integer;v_ignored integer;v_missing integer:=0;v_line integer;v_count integer;v_total numeric:=0;v_combined numeric:=0;
 v_bank uuid;v_paid_on date;v_key text;v_problem text;v_rule text;v_written boolean;v_map record;v_plans jsonb;v_macros jsonb;v_snapshot jsonb;
BEGIN
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write') AND cf_private.has_permission('contas_pagar','import') AND cf_private.has_permission('importar_bases','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_report_kind IS NULL OR p_report_kind NOT IN('NORMAL','CHEQUES') THEN RAISE EXCEPTION 'Escolha títulos comuns ou cheques.' USING ERRCODE='22023';END IF;
 IF p_scope IS DISTINCT FROM 'grupo-consolidado' OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR p_empty_cheques_confirmed IS NULL
  OR (p_empty_cheques_confirmed AND (p_report_kind<>'CHEQUES' OR p_rows<>'[]'::jsonb)) THEN
  RAISE EXCEPTION 'Declare uma posição sem cheques somente para o relatório vazio de cheques.' USING ERRCODE='22023';END IF;
 IF p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'object' OR octet_length(p_mappings::text)>2000000 OR p_bank_mappings IS NULL OR jsonb_typeof(p_bank_mappings)<>'object' OR octet_length(p_bank_mappings::text)>2000000 THEN
  RAISE EXCEPTION 'Informe classificações e contas válidas.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.validate_payable_import_resolution_choices(p_resolution_choices);
 v_rows:=CASE WHEN p_empty_cheques_confirmed THEN '[]'::jsonb ELSE cf_private.validate_payable_identity_rows(p_scope,p_rows) END;
 v_all_rows:=v_rows;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE upper(btrim(coalesce(r->>'source_status',''))) IN('PAGO','PAGA','PAGOS','QUITADO','QUITADA','CANCELADO','CANCELADA','ESTORNADO','ESTORNADA')) THEN
  RAISE EXCEPTION 'O relatório diário deve conter somente títulos em aberto.' USING ERRCODE='22023';END IF;
 IF p_report_kind='CHEQUES' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE NOT cf_private.payable_daily_is_cheque(r->>'source_status',r->>'cheque_number')) THEN
  RAISE EXCEPTION 'O relatório de cheques contém títulos comuns. Selecione a base completa somente de cheques.' USING ERRCODE='22023';END IF;
 SELECT count(*) FILTER(WHERE p_report_kind='NORMAL' AND cf_private.payable_daily_is_cheque(r->>'source_status',r->>'cheque_number')),
  coalesce(jsonb_agg(r ORDER BY n) FILTER(WHERE p_report_kind='CHEQUES' OR NOT cf_private.payable_daily_is_cheque(r->>'source_status',r->>'cheque_number')),'[]')
  INTO v_ignored,v_clean FROM jsonb_array_elements(p_rows) WITH ORDINALITY a(r,n);
 IF jsonb_array_length(v_clean)=0 AND NOT p_empty_cheques_confirmed THEN RAISE EXCEPTION 'Não há títulos do tipo selecionado no relatório. Nenhuma baixa será presumida.' USING ERRCODE='22023';END IF;
 v_rows:=CASE WHEN p_empty_cheques_confirmed THEN '[]'::jsonb ELSE cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,v_clean)) END;
 SELECT * INTO v_last FROM cf_private.payable_daily_reports WHERE report_kind=p_report_kind ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL),count(*) FILTER(WHERE coalesce((r->>'changed')::boolean,false)) INTO v_new,v_changed FROM jsonb_array_elements(v_rows) r;
 v_rule:=CASE WHEN p_report_kind='NORMAL' THEN 'DUE_DATE' ELSE 'IMPORT_DATE' END;
 -- Classificações novas são as únicas que exigem escolha; as anteriores são reaproveitadas.
 FOR v_map IN SELECT key,value FROM jsonb_each(p_mappings) LOOP
  IF jsonb_typeof(v_map.value)<>'string' OR NOT EXISTS(SELECT 1 FROM public.payable_macros WHERE name=v_map.value#>>'{}') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'plan'=cf_private.normalize_payable_plan(v_map.key)) THEN
   RAISE EXCEPTION 'Classificação de plano inválida para este relatório.' USING ERRCODE='22023';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('plan',plan,'count',n,'total_cents',cents) ORDER BY plan),'[]') INTO v_plans FROM(
  SELECT r->>'plan' plan,count(*) n,sum((r->>'amount_cents')::numeric) cents FROM jsonb_array_elements(v_rows) r LEFT JOIN public.payable_plan_mappings m ON m.plan=r->>'plan'
  WHERE m.plan IS NULL AND NOT p_mappings ? (r->>'plan') GROUP BY r->>'plan') q;
 SELECT coalesce(jsonb_agg(name ORDER BY name),'[]') INTO v_macros FROM public.payable_macros;
 IF jsonb_array_length(v_plans)>0 THEN v_errors:=array_append(v_errors,jsonb_build_object('line',0,'column','Classificação','problem','Classifique os novos planos antes de concluir.','correction','Escolha o centro de custo macro de cada plano novo.'));END IF;
 FOR v_row,v_line IN SELECT value,ordinality::integer FROM jsonb_array_elements(v_rows) WITH ORDINALITY LOOP
  v_title:=NULL;v_written:=false;
  IF v_row->>'title_id' IS NOT NULL THEN SELECT * INTO v_title FROM public.payable_financial_titles WHERE id=(v_row->>'title_id')::uuid;v_written:=v_title.administrative_writeoff_id IS NOT NULL;END IF;
  IF (v_row->>'amount_cents')::bigint=1 OR v_written OR (coalesce(v_title.paid_cents,0)>0 AND
   (v_title.payment_remaining_cents<=0 OR (v_row->>'amount_cents')::bigint<>v_title.amount_cents OR (v_row->>'due_date')::date<>v_title.due_date)) THEN
   v_key:=CASE WHEN (v_row->>'amount_cents')::bigint=1 THEN 'row:'||v_line ELSE 'title:'||v_title.id END;
   v_choice:=p_resolution_choices->v_key;v_problem:=NULL;
   v_item:=jsonb_build_object('key',v_key,'kind',CASE WHEN (v_row->>'amount_cents')::bigint=1 THEN 'CENT' ELSE 'REAPPEARED' END,'line',v_line,'title_id',v_title.id,
    'branch',v_row->>'branch','entry_number',v_row->>'entry_number','description',v_row->>'description','due_date',v_row->>'due_date',
    'amount_cents',CASE WHEN (v_row->>'amount_cents')::bigint=1 THEN coalesce(v_title.amount_cents,1) ELSE (v_row->>'amount_cents')::bigint END,
    'source_amount_cents',(v_row->>'amount_cents')::bigint,'payment_remaining_cents',coalesce(v_title.payment_remaining_cents,(v_row->>'amount_cents')::bigint),
    'allowed_actions',CASE WHEN coalesce(v_title.paid_cents,0)>0 THEN '[]'::jsonb WHEN (v_row->>'amount_cents')::bigint=1 THEN '["WRITE_OFF"]'::jsonb ELSE '["REOPEN"]'::jsonb END,
    'requires_resolution',true,'already_written_off',v_written,'paid_on',NULL,'bank_account_id',NULL,'bank_label',NULL,'bank_mapping_key',NULL,
    'cheque_number',v_row->>'cheque_number','rule',v_rule,'payment_revision',v_title.payment_revision,'last_import_id',v_title.last_import_id);
   IF coalesce(v_title.paid_cents,0)>0 THEN v_problem:='Este título já possui pagamento. Confira o histórico e estorne explicitamente o pagamento incorreto antes de retornar o título.';
   ELSIF v_choice IS NULL THEN v_problem:=CASE WHEN v_written AND (v_row->>'amount_cents')::bigint<>1 THEN 'Confirme a reabertura do título que voltou ao relatório.' ELSE 'Confirme individualmente a baixa de R$ 0,01 sem pagamento.' END;
   ELSIF NOT (v_item->'allowed_actions') ? (v_choice->>'action') THEN v_problem:='A ação escolhida não é permitida para este título.';END IF;
   v_seen:=v_seen||jsonb_build_object(v_key,true);v_item:=v_item||jsonb_build_object('problem',v_problem,'selected_action',v_choice->>'action');v_exceptions:=array_append(v_exceptions,v_item);
  END IF;
 END LOOP;
 -- Materializa uma única vez a posição anterior e as chaves atuais. O relatório
 -- comum não alcança cheques; o primeiro relatório de cheques só cria a posição.
 IF p_report_kind='NORMAL' OR v_last.id IS NOT NULL THEN
  FOR v_snapshot IN
   WITH incoming AS MATERIALIZED(SELECT r->>'source_key' k FROM jsonb_array_elements(v_all_rows) r),
    prior AS MATERIALIZED(SELECT (r->>'title_id')::uuid id FROM jsonb_array_elements(coalesce(v_last.position,'[]')) r),
    candidates AS MATERIALIZED(SELECT t.id FROM public.payable_titles t
     WHERE t.scope=p_scope AND cf_private.payable_daily_is_cheque(t.source_status,t.cheque_number)=(p_report_kind='CHEQUES')
      AND (v_last.id IS NULL OR t.id IN(SELECT id FROM prior))
      AND NOT EXISTS(SELECT 1 FROM incoming i WHERE i.k=cf_private.payable_business_key(t.branch,t.entry_number)))
   SELECT to_jsonb(f) FROM candidates c JOIN public.payable_financial_titles f ON f.id=c.id
    WHERE f.payment_remaining_cents>0 AND f.administrative_writeoff_id IS NULL AND cf_private.payable_closing_exclusion(f.id) IS NULL ORDER BY f.branch,f.entry_number,f.id
  LOOP
   v_missing:=v_missing+1;IF v_missing>5000 THEN RAISE EXCEPTION 'Mais de 5.000 títulos ausentes. Confira a abrangência do relatório.' USING ERRCODE='22023';END IF;
   v_key:='title:'||(v_snapshot->>'id');v_choice:=p_resolution_choices->v_key;v_seen:=v_seen||jsonb_build_object(v_key,true);
   v_paid_on:=CASE WHEN p_report_kind='NORMAL' THEN (v_snapshot->>'due_date')::date ELSE v_date END;
   v_bank:=cf_private.payable_daily_bank(v_snapshot->>'branch',v_snapshot->>'bank_account',p_bank_mappings);
   IF (v_snapshot->>'amount_cents')::bigint<>1 AND length(btrim(coalesce(v_snapshot->>'bank_account','')))>0 THEN
    v_bank_seen:=v_bank_seen||jsonb_build_object(cf_private.payable_daily_bank_key(v_snapshot->>'branch',v_snapshot->>'bank_account'),true);
   END IF;
   v_problem:=NULL;
   v_item:=jsonb_build_object('key',v_key,'kind','MISSING','line',NULL,'title_id',v_snapshot->>'id','branch',v_snapshot->>'branch','entry_number',v_snapshot->>'entry_number',
    'description',v_snapshot->>'description','due_date',v_snapshot->>'due_date','amount_cents',(v_snapshot->>'amount_cents')::bigint,'payment_remaining_cents',(v_snapshot->>'payment_remaining_cents')::bigint,
    'allowed_actions',CASE WHEN (v_snapshot->>'amount_cents')::bigint=1 THEN '["WRITE_OFF"]'::jsonb ELSE '["PAID"]'::jsonb END,
    'requires_resolution',false,'already_written_off',false,'paid_on',v_paid_on,'bank_account_id',v_bank,
    'bank_label',(SELECT display_name FROM public.bank_accounts WHERE id=v_bank),'source_bank',v_snapshot->>'bank_account','bank_mapping_key',cf_private.payable_daily_bank_key(v_snapshot->>'branch',v_snapshot->>'bank_account'),
    'cheque_number',v_snapshot->>'cheque_number','rule',v_rule,'payment_revision',v_snapshot->>'payment_revision','last_import_id',v_snapshot->>'last_import_id');
   IF (v_snapshot->>'amount_cents')::bigint=1 THEN
    IF v_choice IS NULL THEN v_problem:='Confirme individualmente a baixa de R$ 0,01 sem pagamento.';
    ELSIF v_choice->>'action'<>'WRITE_OFF' THEN v_problem:='Um centavo exige baixa sem pagamento.';END IF;
   ELSE
    IF v_choice IS NOT NULL THEN
     IF v_choice->>'action'<>'PAID' OR (v_choice->>'amount_paid_cents')::numeric<>(v_snapshot->>'payment_remaining_cents')::numeric THEN v_problem:='Confirme o pagamento integral exato deste título.';
     ELSE v_paid_on:=(v_choice->>'paid_on')::date;v_bank:=(v_choice->>'bank_account_id')::uuid;v_item:=v_item||jsonb_build_object('paid_on',v_paid_on,'bank_account_id',v_bank,'bank_label',(SELECT display_name FROM public.bank_accounts WHERE id=v_bank));END IF;
    END IF;
    IF v_paid_on>v_date THEN v_problem:='O vencimento ainda é futuro. Informe a data real do pagamento para concluir.';END IF;
    IF v_bank IS NULL THEN v_problem:='Vincule a descrição bancária a uma conta oficial ou informe o banco real deste pagamento.';END IF;
   END IF;
   IF (v_snapshot->>'amount_cents')::bigint=1 OR v_choice IS NOT NULL OR v_problem IS NOT NULL THEN
    v_item:=v_item||jsonb_build_object('requires_resolution',true,'selected_action',v_choice->>'action','problem',v_problem);v_exceptions:=array_append(v_exceptions,v_item);
   ELSE
    v_item:=v_item||jsonb_build_object('selected_action','PAID','problem',NULL);v_auto:=array_append(v_auto,v_item);v_total:=v_total+(v_snapshot->>'payment_remaining_cents')::numeric;
   END IF;
  END LOOP;
 END IF;
 IF v_total>9007199254740991 THEN RAISE EXCEPTION 'O realizado excede o limite seguro.' USING ERRCODE='22003';END IF;
 SELECT v_total+coalesce(sum((r->>'payment_remaining_cents')::numeric) FILTER(WHERE r->>'selected_action'='PAID' AND r->>'problem' IS NULL),0)
  INTO v_combined FROM jsonb_array_elements(to_jsonb(v_exceptions)) r;
 IF v_combined>9007199254740991 THEN RAISE EXCEPTION 'O total dos pagamentos automáticos e conferidos excede o limite seguro.' USING ERRCODE='22003';END IF;
 FOREACH v_item IN ARRAY v_exceptions LOOP IF v_item->>'problem' IS NOT NULL THEN v_errors:=array_append(v_errors,jsonb_build_object('line',coalesce((v_item->>'line')::integer,0),'column','Conciliação diária','problem',v_item->>'problem','correction','Confira somente a exceção indicada e atualize a análise.'));END IF;END LOOP;
 FOR v_key IN SELECT jsonb_object_keys(p_resolution_choices) LOOP IF NOT v_seen ? v_key THEN v_errors:=array_append(v_errors,jsonb_build_object('line',0,'column','Conciliação diária','problem','Uma escolha não pertence aos títulos desta análise.','correction','Atualize a análise antes de confirmar.'));END IF;END LOOP;
 FOR v_key IN SELECT jsonb_object_keys(p_bank_mappings) LOOP IF NOT v_bank_seen ? v_key THEN RAISE EXCEPTION 'Uma conta escolhida não pertence aos títulos ausentes desta análise.' USING ERRCODE='22023';END IF;END LOOP;
 RETURN jsonb_build_object('daily_report_version','058','mode','daily','report_kind',p_report_kind,'empty_cheques_confirmed',p_empty_cheques_confirmed,'report_date',v_date,'previous_import_id',v_previous,
  'financial_revision',cf_private.payable_daily_revision(),'rows',v_clean,'source_row_count',jsonb_array_length(p_rows),'ignored_cheque_count',v_ignored,
  'row_count',jsonb_array_length(v_rows),'new_count',v_new,'open_count',jsonb_array_length(v_rows)-v_new,'changed_count',v_changed,
  'baseline_only',p_report_kind='CHEQUES' AND v_last.id IS NULL,'baseline_origin',CASE WHEN v_last.id IS NOT NULL THEN 'PREVIOUS_REPORT' WHEN p_report_kind='NORMAL' THEN 'EXISTING_BASE' ELSE 'FIRST_REPORT' END,
  'previous_report_id',v_last.id,'missing_count',v_missing,'auto_payment_count',cardinality(v_auto),'auto_payment_cents',v_total,
  'automatic_actions',to_jsonb(v_auto),'exceptions',to_jsonb(v_exceptions),'reconciliation_items',to_jsonb(v_exceptions),'errors',to_jsonb(v_errors),'can_commit',cardinality(v_errors)=0,
  'bank_options',cf_private.payable_import_resolution_bank_options(),'unclassified_plans',v_plans,'macros',v_macros);
END $$;

CREATE FUNCTION public.commit_payables_daily_report_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,
 p_rows jsonb,p_report_kind text,p_mappings jsonb,p_bank_mappings jsonb,p_resolution_choices jsonb,p_previous_import_id uuid,p_previous_financial_revision text,p_expected_report_date date,p_request_id uuid,p_empty_cheques_confirmed boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payload jsonb;v_saved cf_private.payable_daily_requests%ROWTYPE;v_previous cf_private.payable_daily_reports%ROWTYPE;v_existing cf_private.payable_daily_reports%ROWTYPE;
 v_preview jsonb;v_result jsonb;v_core jsonb;v_rows jsonb;v_position jsonb;v_item jsonb;v_choice jsonb;v_import uuid;v_report uuid:=gen_random_uuid();
 v_title public.payable_review_titles%ROWTYPE;v_zero public.payable_imports%ROWTYPE;v_payment uuid;v_writeoff jsonb;v_paid integer:=0;v_written integer:=0;v_cents numeric:=0;v_key text;
BEGIN
 PERFORM cf_private.require_payable_import_reconciliation_actor(p_user_id,p_session_id);
 PERFORM cf_private.validate_payable_reconciliation_file(p_file_name,p_file_sha256,p_file_base64);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Informe o protocolo da importação.' USING ERRCODE='22023';END IF;
 v_payload:=jsonb_build_object('scope',p_scope,'file_name',p_file_name,'file_sha256',p_file_sha256,'rows',p_rows,'report_kind',p_report_kind,'mappings',p_mappings,
  'bank_mappings',p_bank_mappings,'resolution_choices',p_resolution_choices,'previous_import_id',p_previous_import_id,'previous_financial_revision',p_previous_financial_revision,'expected_report_date',p_expected_report_date,'empty_cheques_confirmed',p_empty_cheques_confirmed);
 SELECT * INTO v_saved FROM cf_private.payable_daily_requests WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN IF v_saved.payload IS DISTINCT FROM v_payload THEN RAISE EXCEPTION 'Protocolo já usado com outros dados.' USING ERRCODE='22023';END IF;RETURN v_saved.result||jsonb_build_object('idempotent',true);END IF;
 IF EXISTS(SELECT 1 FROM cf_private.payable_import_resolution_requests WHERE actor_id=auth.uid() AND request_id=p_request_id) THEN RAISE EXCEPTION 'Protocolo já utilizado por outra importação.' USING ERRCODE='22023';END IF;
 IF p_expected_report_date IS NULL OR p_expected_report_date<>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN RAISE EXCEPTION 'O dia da importação mudou. Analise novamente.' USING ERRCODE='40001';END IF;
 LOCK TABLE public.bank_accounts,cf_private.payable_paid_bank_aliases,public.payable_paid_bank_mappings,public.payable_plan_mappings,public.payable_macros IN SHARE MODE;
 IF p_previous_import_id IS DISTINCT FROM (public.get_payables_revision()->>'import_id')::uuid OR p_previous_financial_revision IS NULL OR p_previous_financial_revision IS DISTINCT FROM cf_private.payable_daily_revision() THEN
  RAISE EXCEPTION 'A base mudou. Analise novamente.' USING ERRCODE='40001';END IF;
 SELECT * INTO v_previous FROM cf_private.payable_daily_reports WHERE report_kind=p_report_kind ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT * INTO v_existing FROM cf_private.payable_daily_reports WHERE report_kind=p_report_kind AND file_sha256=p_file_sha256;
 IF v_existing.id IS NOT NULL AND NOT coalesce(p_empty_cheques_confirmed,false) THEN
  RAISE EXCEPTION 'Este arquivo já foi importado. Exporte o relatório atual da origem; nenhuma baixa foi repetida.' USING ERRCODE='23505';
 END IF;
 v_preview:=public.preview_payables_daily_report(p_scope,p_rows,p_report_kind,p_mappings,p_bank_mappings,p_resolution_choices,p_empty_cheques_confirmed);
 IF NOT coalesce((v_preview->>'can_commit')::boolean,false) THEN RAISE EXCEPTION 'Confira as exceções antes de concluir a importação diária.' USING ERRCODE='P0058';END IF;
 IF (SELECT coalesce(sum((r->>'payment_remaining_cents')::numeric),0) FROM jsonb_array_elements((v_preview->'automatic_actions')||(v_preview->'exceptions')) r WHERE r->>'selected_action'='PAID')>9007199254740991 THEN
  RAISE EXCEPTION 'O realizado excede o limite seguro.' USING ERRCODE='22003';END IF;
 v_rows:=v_preview->'rows';
 -- Reaberturas administrativas são expressas; pagamento existente jamais é apagado.
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_preview->'exceptions') WHERE value->>'kind'='REAPPEARED' LOOP
  v_choice:=p_resolution_choices->(v_item->>'key');PERFORM cf_private.reverse_payable_administrative_writeoff((v_item->>'title_id')::uuid,v_choice->>'reason',(v_item->>'payment_revision')::uuid);
 END LOOP;
 IF p_empty_cheques_confirmed THEN
  SELECT * INTO v_zero FROM public.payable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256 AND import_mode='FORECAST';
  IF v_zero.id IS NOT NULL THEN
   IF v_zero.row_count<>0 OR NOT EXISTS(SELECT 1 FROM cf_private.payable_import_files f WHERE f.import_id=v_zero.id AND f.file_bytes=decode(p_file_base64,'base64')) THEN
    RAISE EXCEPTION 'O arquivo já registrado não corresponde à posição vazia de cheques.' USING ERRCODE='22023';END IF;v_import:=v_zero.id;
  ELSE
   v_import:=gen_random_uuid();
   INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode)
    VALUES(v_import,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),0,0,0,0,'FORECAST');
   INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_import,decode(p_file_base64,'base64'));
  END IF;
  v_core:=jsonb_build_object('mode','forecast','import_id',v_import,'new_count',0,'open_count',0,'changed_count',0,'settled_count',0,'row_count',0);v_position:='[]'::jsonb;
  INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES(v_import,'FORECAST',v_core,auth.uid()) ON CONFLICT(import_id) DO NOTHING;
 ELSE
  v_core:=cf_private.commit_payables_forecast_import_v1_core(p_scope,p_file_name,p_file_sha256,p_file_base64,v_rows,p_mappings,p_previous_import_id);v_import:=(v_core->>'import_id')::uuid;
  INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES(v_import,'FORECAST',v_core,auth.uid());
  SELECT coalesce(jsonb_agg(jsonb_build_object('title_id',i.title_id,'source_key',r->>'source_key') ORDER BY n),'[]') INTO v_position
   FROM jsonb_array_elements(cf_private.validate_payable_identity_rows(p_scope,v_rows)) WITH ORDINALITY a(r,n)
   JOIN cf_private.payable_identity_registry i ON i.scope=p_scope AND i.business_key=r->>'source_key';
 END IF;
 IF jsonb_array_length(v_position)<>jsonb_array_length(v_rows) THEN RAISE EXCEPTION 'A posição importada não corresponde a todos os títulos.' USING ERRCODE='40001';END IF;
 INSERT INTO cf_private.payable_daily_reports(id,report_kind,file_sha256,report_date,source_import_id,previous_report_id,rows,position,created_by)
  VALUES(v_report,p_report_kind,p_file_sha256,p_expected_report_date,v_import,v_previous.id,v_rows,v_position,auth.uid());
 FOR v_item IN SELECT value FROM jsonb_array_elements((v_preview->'automatic_actions')||(v_preview->'exceptions')) LOOP
  IF v_item->>'kind'='REAPPEARED' THEN CONTINUE;END IF;
  v_choice:=p_resolution_choices->(v_item->>'key');
  IF v_item->>'title_id' IS NULL THEN
   SELECT f.* INTO v_title FROM public.payable_review_titles f JOIN cf_private.payable_identity_registry i ON i.title_id=f.id
    WHERE i.scope=p_scope AND i.business_key=cf_private.payable_business_key(v_item->>'branch',v_item->>'entry_number');
  ELSE SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_item->>'title_id')::uuid;END IF;
  IF v_title.id IS NULL THEN RAISE EXCEPTION 'Título da conciliação não encontrado.' USING ERRCODE='40001';END IF;
  IF v_item->>'kind'='CENT' OR (v_item->>'amount_cents')::bigint=1 THEN
   IF v_title.administrative_writeoff_id IS NULL THEN
    v_writeoff:=cf_private.record_payable_administrative_writeoff(v_title.id,v_import,v_choice->>'reason',v_title.payment_revision);
    INSERT INTO cf_private.payable_daily_actions(report_id,title_id,writeoff_id,effective_on,rule_kind,title_snapshot,created_by)
     VALUES(v_report,v_title.id,(v_writeoff->>'writeoff_id')::uuid,coalesce((v_item->>'paid_on')::date,CASE WHEN p_report_kind='NORMAL' THEN v_title.due_date ELSE p_expected_report_date END),'CENT',to_jsonb(v_title),auth.uid());
   END IF;v_written:=v_written+1;
  ELSE
   IF p_bank_mappings ? (v_item->>'bank_mapping_key') AND length(btrim(coalesce(v_item->>'source_bank','')))>0 AND cf_private.payable_paid_bank_alias_name(v_item->>'source_bank') IS NULL THEN
    v_key:=cf_private.payable_paid_bank_key(v_title.branch,v_item->>'source_bank');
    IF (SELECT bank_account_id FROM public.payable_paid_bank_mappings WHERE mapping_key=v_key ORDER BY created_at DESC,id DESC LIMIT 1) IS DISTINCT FROM (p_bank_mappings->>(v_item->>'bank_mapping_key'))::uuid THEN
     INSERT INTO public.payable_paid_bank_mappings(mapping_key,branch,paid_bank,bank_account_id,created_by,created_at)
      SELECT v_key,v_title.branch,v_item->>'source_bank',(p_bank_mappings->>(v_item->>'bank_mapping_key'))::uuid,auth.uid(),greatest(clock_timestamp(),coalesce(max(created_at),'1900-01-01'::timestamptz)+interval '1 microsecond')
       FROM public.payable_paid_bank_mappings WHERE mapping_key=v_key;
    END IF;
   END IF;
   v_payment:=public.register_payable_payment(v_title.id,v_title.payment_remaining_cents,(v_item->>'paid_on')::date,(v_item->>'bank_account_id')::uuid,
    CASE WHEN v_choice IS NOT NULL THEN v_choice->>'reason' ELSE 'Conciliação pelo relatório diário completo: título ausente; regra '||(v_item->>'rule')||'; arquivo '||p_file_name END,
    v_title.payment_revision,gen_random_uuid(),v_title.last_import_id);
   INSERT INTO cf_private.payable_daily_actions(report_id,title_id,payment_id,effective_on,rule_kind,title_snapshot,created_by)
    VALUES(v_report,v_title.id,v_payment,(v_item->>'paid_on')::date,v_item->>'rule',to_jsonb(v_title),auth.uid());
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
   PERFORM public.review_payable_title(v_title.id,'Conciliação do relatório diário completo.',v_title.review_fingerprint);
   v_paid:=v_paid+1;v_cents:=v_cents+(v_item->>'payment_remaining_cents')::numeric;
  END IF;
 END LOOP;
 v_result:=v_core||jsonb_build_object('daily_report_version','058','mode','daily','report_kind',p_report_kind,'empty_cheques_confirmed',p_empty_cheques_confirmed,'report_date',p_expected_report_date,
  'request_id',p_request_id,'report_id',v_report,'import_id',v_import,'paid_count',v_paid,'written_off_count',v_written,
  'automatic_paid_count',(v_preview->>'auto_payment_count')::integer,'payment_cents',v_cents,'baseline_only',(v_preview->>'baseline_only')::boolean,'ignored_cheque_count',(v_preview->>'ignored_cheque_count')::integer,'completed_revision',public.get_payables_revision(),'idempotent',false);
 INSERT INTO cf_private.payable_daily_requests(actor_id,request_id,payload,result,report_id) VALUES(auth.uid(),p_request_id,v_payload,v_result,v_report);
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
  SELECT id,username,role_key,'contas_pagar','payable_daily_report',v_report::text,'IMPORT',v_result FROM public.profiles WHERE id=auth.uid();
 RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION cf_private.payable_daily_is_cheque(text,text),cf_private.payable_daily_bank_key(text,text),cf_private.payable_daily_bank(text,text,jsonb),cf_private.payable_daily_revision(),cf_private.guard_payable_empty_cheques_import(),
 public.preview_payables_daily_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean),
 public.commit_payables_daily_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,uuid,text,date,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_payables_daily_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_payables_daily_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,uuid,text,date,uuid,boolean) TO service_role;
-- A fonte explícita de pagamentos pode corrigir somente pagamentos que já
-- pertencem a importações: ERP anterior ou baixa inferida pelo relatório 058.
-- Pagamentos manuais continuam sujeitos à conferência e ao estorno explícitos.
DO $cf_daily_paid_consumers_058$
DECLARE
 v_signature text := 'cf_private.preview_payable_paid_rows(jsonb,jsonb,jsonb)';
 v_definition text;
 v_original text := $owned$coalesce(bool_and(EXISTS(SELECT 1 FROM public.payable_paid_import_rows own WHERE own.outcome IN ('CREATED','CORRECTED') AND p.id=ANY(own.payment_ids))),false)$owned$;
 v_replacement text := $owned$coalesce(bool_and((EXISTS(SELECT 1 FROM public.payable_paid_import_rows own WHERE own.outcome IN ('CREATED','CORRECTED') AND p.id=ANY(own.payment_ids)) OR EXISTS(SELECT 1 FROM cf_private.payable_daily_actions daily_058 WHERE daily_058.payment_id=p.id AND daily_058.title_id=p.title_id))),false) /* payable_daily_058_owned */$owned$;
BEGIN
 IF to_regprocedure(v_signature) IS NULL
  OR to_regclass('cf_private.payable_daily_actions') IS NULL THEN
  RAISE EXCEPTION 'Ative as regras de pagamentos 050 e o histórico dos relatórios diários 058 antes da compatibilidade.' USING ERRCODE='22023';
 END IF;
 v_definition := pg_get_functiondef(v_signature::regprocedure);
 IF position('payable_daily_058_owned' IN v_definition)>0 THEN
  IF (length(v_definition)-length(replace(v_definition,'payable_daily_058_owned','')))/length('payable_daily_058_owned')<>1
   OR (length(v_definition)-length(replace(v_definition,v_replacement,'')))/length(v_replacement)<>1 THEN
   RAISE EXCEPTION 'O contrato de propriedade dos pagamentos diários foi alterado. Confira a atualização 058.' USING ERRCODE='22023';
  END IF;
  RETURN;
 END IF;
 IF (length(v_definition)-length(replace(v_definition,v_original,'')))/length(v_original)<>1 THEN
  RAISE EXCEPTION 'O contrato de pagamentos 050 não corresponde à compatibilidade esperada da atualização 058.' USING ERRCODE='22023';
 END IF;
 -- CREATE OR REPLACE preserva OID, proprietário, privilégios e configurações.
 -- Nenhuma linha, pagamento, revisão ou confirmação é alterada na instalação.
 EXECUTE replace(v_definition,v_original,v_replacement);
END $cf_daily_paid_consumers_058$;
-- A classificação de cheque é a mesma da importação diária: situação CHEQUE
-- ou número explícito informado. O subtotal continua incluído na obrigação;
-- não altera vencimento, nominal, pagamentos, estimativas ou posições salvas.
DO $cf_daily_cheque_consumers_058$
DECLARE
 v_signature text;
 v_definition text;
 v_old text := $predicate$upper(btrim(source_status))='CHEQUE'$predicate$;
 v_new text := $predicate$cf_private.payable_daily_is_cheque(source_status,cheque_number) /* payable_daily_058_cheque */$predicate$;
 v_old_projection text := 'SELECT id,macro,due_date,amount_cents,payment_remaining_cents,source_status,status,paid_cents';
 v_new_projection text := 'SELECT id,macro,due_date,amount_cents,payment_remaining_cents,source_status,status,paid_cents,cheque_number';
BEGIN
 IF to_regprocedure('cf_private.payable_daily_is_cheque(text,text)') IS NULL THEN
  RAISE EXCEPTION 'Ative a classificação de cheques da atualização 058 antes dos seus resumos.' USING ERRCODE='22023';
 END IF;
 FOREACH v_signature IN ARRAY ARRAY['public.payables_management_summary(date,date)','public.payables_forecast(date)'] LOOP
  IF to_regprocedure(v_signature) IS NULL THEN
   RAISE EXCEPTION 'O resumo % não corresponde ao contrato de cheques esperado da atualização 058.',v_signature USING ERRCODE='22023';
  END IF;
  v_definition := pg_get_functiondef(v_signature::regprocedure);
  IF position('payable_daily_058_cheque' IN v_definition)>0 THEN
   IF (length(v_definition)-length(replace(v_definition,v_new,'')))/length(v_new)<>2
    OR (length(v_definition)-length(replace(v_definition,'payable_daily_058_cheque','')))/length('payable_daily_058_cheque')<>2
    OR position(v_old IN v_definition)>0
    OR (v_signature='public.payables_management_summary(date,date)' AND position(v_new_projection IN v_definition)=0) THEN
    RAISE EXCEPTION 'A classificação de cheques do resumo % foi alterada. Confira a atualização 058.',v_signature USING ERRCODE='22023';
   END IF;
   CONTINUE;
  END IF;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>2 THEN
   RAISE EXCEPTION 'O subtotal de cheques do resumo % não corresponde ao contrato esperado.',v_signature USING ERRCODE='22023';
  END IF;
  IF v_signature='public.payables_management_summary(date,date)' THEN
   IF (length(v_definition)-length(replace(v_definition,v_old_projection,'')))/length(v_old_projection)<>1
    OR position(v_new_projection IN v_definition)>0 THEN
    RAISE EXCEPTION 'A origem dos campos do resumo gerencial foi alterada. Confira a atualização 058.' USING ERRCODE='22023';
   END IF;
   v_definition := replace(v_definition,v_old_projection,v_new_projection);
  END IF;
  EXECUTE replace(v_definition,v_old,v_new);
 END LOOP;
END $cf_daily_cheque_consumers_058$;
DO $$ DECLARE s text;BEGIN
 s:=pg_get_functiondef('public.payables_import_capabilities()'::regprocedure);
 IF position('daily_report_version' IN s)=0 THEN s:=replace(s,'''schema_version'',''043_payable_import_reconciliation''','''daily_report_version'',''058'',''daily_reports'',true,''schema_version'',''043_payable_import_reconciliation''');EXECUTE s;END IF;
END $$;
INSERT INTO public.central_schema_migrations(version) VALUES('058_payable_daily_reports');
 $source_058$;
END $apply_058$;
COMMIT;
