-- Conteúdo explícito de CP: abertos completos ou títulos baixados, sem pagamentos presumidos.
-- A instalação preserva os relatórios, arquivos, títulos e históricos existentes.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $apply065$
DECLARE v_definition text;v_guard text;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='061_payable_report_status') THEN
  RAISE EXCEPTION 'Ative o estado de títulos pelo relatório061 antes dos tipos de relatório.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='065_payable_report_contents') THEN RETURN;END IF;
 EXECUTE $source065$
CREATE FUNCTION cf_private.payable_report_contents_revision() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT '065:'||cf_private.payable_open_status_revision();
$$;

CREATE FUNCTION public.preview_payables_status_contents_report(p_scope text,p_rows jsonb,p_report_kind text,p_report_contents text,
 p_mappings jsonb DEFAULT '{}',p_resolution_choices jsonb DEFAULT '{}',p_empty_report_confirmed boolean DEFAULT false,
 p_rounding_adjustments jsonb DEFAULT '[]',p_confirm_large_reduction boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_rows jsonb;v_resolved jsonb;v_last cf_private.payable_daily_reports%ROWTYPE;v_previous uuid;
 v_row jsonb;v_title public.payable_financial_titles%ROWTYPE;v_line integer;v_key text;v_choice jsonb;v_problem text;v_written boolean;v_member boolean;
 v_actions jsonb:='[]';v_exceptions jsonb:='[]';v_errors jsonb:='[]';v_seen jsonb:='{}';v_closed jsonb:='[]';v_unknown jsonb:='[]';v_macros jsonb;
 v_prior_count integer:=0;v_removed integer:=0;v_position_count integer:=0;v_required boolean:=false;v_large_problem text;
 v_new integer:=0;v_marked integer:=0;v_marked_cents numeric:=0;
BEGIN
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write') AND cf_private.has_permission('contas_pagar','import') AND cf_private.has_permission('importar_bases','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_scope IS DISTINCT FROM 'grupo-consolidado' OR p_report_kind IS DISTINCT FROM 'ALL' OR p_report_contents IS NULL
  OR p_report_contents NOT IN('FULL_OPEN','PAID_STATUS') OR p_confirm_large_reduction IS NULL OR p_empty_report_confirmed IS NULL
  OR(p_report_contents='PAID_STATUS' AND(p_confirm_large_reduction OR p_empty_report_confirmed OR p_mappings IS DISTINCT FROM '{}'::jsonb)) THEN
  RAISE EXCEPTION 'Escolha explicitamente abertos completos ou títulos baixados.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_last FROM cf_private.payable_daily_reports WHERE report_kind='ALL' ORDER BY created_at DESC,id DESC LIMIT 1;
 v_prior_count:=coalesce(jsonb_array_length(v_last.position),0);
 IF p_report_contents='FULL_OPEN' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE upper(btrim(coalesce(r->>'source_status',''))) IN('PAGO','PAGA','PAGOS','PAGAS','QUITADO','QUITADA','QUITADOS','QUITADAS','BAIXADO','BAIXADA','BAIXADOS','BAIXADAS',
    'LIQUIDADO','LIQUIDADA','LIQUIDADOS','LIQUIDADAS','COMPENSADO','COMPENSADA','COMPENSADOS','COMPENSADAS',
    'CANCELADO','CANCELADA','CANCELADOS','CANCELADAS','ESTORNADO','ESTORNADA','ESTORNADOS','ESTORNADAS')) THEN
   RAISE EXCEPTION 'O relatório completo deve conter somente títulos em aberto.' USING ERRCODE='22023';END IF;
  v_base:=public.preview_payables_open_status_report(p_scope,p_rows,p_report_kind,p_mappings,p_resolution_choices,p_empty_report_confirmed,p_rounding_adjustments);
  v_resolved:=CASE WHEN p_empty_report_confirmed THEN '[]'::jsonb ELSE cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,p_rows)) END;
  SELECT count(*)::integer INTO v_removed FROM jsonb_array_elements(coalesce(v_last.position,'[]')) p
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_resolved) r WHERE r->>'title_id'=p->>'title_id');
  v_required:=v_prior_count>=20 AND v_removed::bigint*2>v_prior_count;
  IF v_required AND NOT p_confirm_large_reduction THEN
   v_large_problem:='Este relatório retiraria mais da metade da posição anterior. Confirme que contém todos os títulos ainda em aberto, incluindo os cheques.';
   v_errors:=jsonb_build_array(jsonb_build_object('line',0,'column','Abrangência do relatório','code','LARGE_REDUCTION_CONFIRMATION',
    'problem',v_large_problem,'correction','Confira o relatório global e confirme a redução antes de importar.'));
  END IF;
  v_errors:=v_errors||coalesce(v_base->'errors','[]');
  SELECT coalesce(jsonb_agg(e ORDER BY n),'[]') INTO v_errors FROM jsonb_array_elements(v_errors) WITH ORDINALITY a(e,n) WHERE n<=100;
  RETURN v_base||jsonb_build_object('status_report_version','065','report_contents',p_report_contents,'financial_revision',cf_private.payable_report_contents_revision(),
   'position_count',jsonb_array_length(p_rows),'previous_position_count',v_prior_count,'removed_from_position_count',v_removed,
   'requires_large_reduction_confirmation',v_required,'large_reduction_confirmed',p_confirm_large_reduction,'large_reduction_problem',v_large_problem,
   'paid_already_closed_count',0,'paid_already_closed_keys','[]'::jsonb,'paid_unknown_keys','[]'::jsonb,
   'errors',v_errors,'can_commit',(v_base->>'can_commit')::boolean AND(NOT v_required OR p_confirm_large_reduction));
 END IF;
 -- A paid-status file identifies only the listed existing titles. It cannot
 -- update source amounts/maturities, create forecasts or infer a bank payment.
 v_rows:=cf_private.validate_payable_identity_rows(p_scope,p_rows);
 v_resolved:=cf_private.resolve_payable_identity_rows(p_scope,v_rows);
 PERFORM cf_private.validate_payable_import_resolution_choices(p_resolution_choices);
 IF EXISTS(SELECT 1 FROM jsonb_each(p_resolution_choices) c WHERE c.value->>'action'<>'WRITE_OFF') THEN
  RAISE EXCEPTION 'Somente marcadores de um centavo admitem decisão individual.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.validate_payable_rounding_adjustments(v_rows,p_rounding_adjustments);
 IF v_last.id IS NULL THEN
  v_errors:=jsonb_build_array(jsonb_build_object('line',0,'column','Base de Contas a Pagar','problem','Importe primeiro o relatório completo de títulos em aberto.',
   'correction','A primeira posição precisa conter todos os títulos em aberto.'));
 END IF;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(name ORDER BY name),'[]') INTO v_macros FROM public.payable_macros;
 FOR v_row,v_line IN SELECT value,ordinality::integer FROM jsonb_array_elements(v_resolved) WITH ORDINALITY LOOP
  v_title:=NULL;v_problem:=NULL;
  IF v_row->>'title_id' IS NULL THEN
   v_new:=v_new+1;v_unknown:=v_unknown||jsonb_build_array(v_row->>'source_key');
   v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',v_line,'column','Lançamento / filial',
    'problem','Este título não existe na base de previsões. Nenhuma previsão será criada pelo relatório de baixados.',
    'correction','Confira a filial e o lançamento; inclua novos títulos pelo relatório completo de abertos.'));CONTINUE;
  END IF;
  SELECT * INTO v_title FROM public.payable_financial_titles WHERE id=(v_row->>'title_id')::uuid;
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_last.position,'[]')) p WHERE p->>'title_id'=v_title.id::text) INTO v_member;
  IF(v_row->>'amount_cents')::bigint=1 OR v_title.amount_cents=1 THEN
   IF(v_row->>'amount_cents')::bigint<>v_title.amount_cents THEN
    v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',v_line,'column','Valor','problem','O marcador de um centavo diverge do valor atual do título.',
     'correction','Atualize o valor pelo relatório completo de abertos antes de confirmar esta baixa.'));CONTINUE;
   END IF;
   v_key:='row:'||v_line;v_choice:=p_resolution_choices->v_key;v_seen:=v_seen||jsonb_build_object(v_key,true);
   v_written:=v_title.administrative_writeoff_id IS NOT NULL;
   IF v_title.paid_cents>0 THEN v_problem:='O marcador possui pagamento real; confira o histórico financeiro antes da baixa administrativa.';
   ELSIF NOT v_written AND NOT v_member THEN v_problem:='O marcador não pertence à posição atual de títulos em aberto.';
   ELSIF NOT v_written AND v_choice IS NULL THEN v_problem:='Confirme individualmente a baixa de R$ 0,01 sem pagamento.';
   ELSIF v_written AND v_choice IS NOT NULL THEN v_problem:='Esta baixa já foi confirmada; remova a escolha anterior.';END IF;
   v_exceptions:=v_exceptions||jsonb_build_array(jsonb_build_object('key',v_key,'kind','CENT','line',v_line,'title_id',v_title.id,
    'branch',v_row->>'branch','entry_number',v_row->>'entry_number','description',v_title.description,'due_date',v_title.due_date,
    'amount_cents',1,'source_amount_cents',1,'payment_remaining_cents',0,'allowed_actions',CASE WHEN NOT v_written AND v_title.paid_cents=0 AND v_member THEN '["WRITE_OFF"]'::jsonb ELSE '[]'::jsonb END,
    'requires_resolution',NOT v_written,'already_written_off',v_written,'selected_action',v_choice->>'action','problem',v_problem,
    'paid_on',NULL,'bank_account_id',NULL,'bank_label',NULL,'bank_mapping_key',NULL,'cheque_number',v_title.cheque_number,'rule','CENT',
    'payment_revision',v_title.payment_revision,'last_import_id',v_title.last_import_id));
   IF v_problem IS NOT NULL THEN v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',v_line,'column','Baixa sem pagamento','problem',v_problem,
    'correction','Confirme somente o marcador de um centavo indicado.'));END IF;
  ELSIF v_title.report_paid OR v_title.administrative_writeoff_id IS NOT NULL
   OR(NOT v_member AND(v_title.status='SETTLED_IMPORT' OR v_title.financial_status='PAID')) THEN
   v_closed:=v_closed||jsonb_build_array(v_row->>'source_key');
  ELSIF NOT v_member OR cf_private.payable_closing_exclusion(v_title.id) IS NOT NULL THEN
   v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',v_line,'column','Lançamento / filial','problem','O título não pertence à posição atual de títulos em aberto.',
    'correction','Confira o relatório completo e a identidade do título antes de importar sua baixa.'));
  ELSIF v_last.id IS NOT NULL THEN
   v_actions:=v_actions||jsonb_build_array(jsonb_build_object('kind','PAID','title_id',v_title.id,'source_key',v_row->>'source_key',
    'amount_cents',v_title.amount_cents,'source_amount_cents',(v_row->>'amount_cents')::bigint));
   v_marked:=v_marked+1;v_marked_cents:=v_marked_cents+v_title.amount_cents;
  END IF;
 END LOOP;
 FOR v_key IN SELECT jsonb_object_keys(p_resolution_choices) LOOP IF NOT v_seen ? v_key THEN
  v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',0,'column','Baixa sem pagamento','problem','Uma escolha não pertence a este relatório.',
   'correction','Atualize a conferência.'));END IF;END LOOP;
 SELECT count(*)::integer INTO v_removed FROM jsonb_array_elements(coalesce(v_last.position,'[]')) p
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_resolved) r WHERE r->>'title_id'=p->>'title_id');
 v_position_count:=v_prior_count-v_removed;
 IF v_marked_cents>9007199254740991 THEN RAISE EXCEPTION 'O total nominal excede o limite seguro.' USING ERRCODE='22003';END IF;
 SELECT coalesce(jsonb_agg(e ORDER BY n),'[]') INTO v_errors FROM jsonb_array_elements(v_errors) WITH ORDINALITY a(e,n) WHERE n<=100;
 RETURN jsonb_build_object('status_report_version','065','report_contents','PAID_STATUS','status_only',true,'mode','open_status','report_kind','ALL',
  'report_date',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'empty_report_confirmed',false,'previous_import_id',v_previous,
  'previous_report_id',v_last.id,'financial_revision',cf_private.payable_report_contents_revision(),'rows',p_rows,'source_row_count',jsonb_array_length(v_rows),
  'row_count',jsonb_array_length(v_rows),'new_count',v_new,'open_count',jsonb_array_length(v_rows)-v_new,'changed_count',0,'marked_paid_count',v_marked,
  'marked_paid_cents',v_marked_cents,'reopened_count',0,'baseline_only',v_last.id IS NULL,'baseline_origin',CASE WHEN v_last.id IS NULL THEN 'FIRST_REPORT' ELSE 'PREVIOUS_REPORT' END,
  'status_actions',v_actions,'exceptions',v_exceptions,'errors',v_errors,'can_commit',jsonb_array_length(v_errors)=0,
  'position_count',v_position_count,'previous_position_count',v_prior_count,'removed_from_position_count',v_removed,
  'requires_large_reduction_confirmation',false,'large_reduction_confirmed',false,'large_reduction_problem',NULL,
  'paid_already_closed_count',jsonb_array_length(v_closed),'paid_already_closed_keys',v_closed,'paid_unknown_keys',v_unknown,
  'unmapped_plans','[]'::jsonb,'macro_options',v_macros,'bank_options','[]'::jsonb,'auto_payment_count',0,'auto_payment_cents',0,'rounding_adjustments',p_rounding_adjustments);
END $$;

CREATE FUNCTION public.commit_payables_status_contents_report_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,
 p_rows jsonb,p_report_kind text,p_report_contents text,p_mappings jsonb,p_resolution_choices jsonb,p_previous_import_id uuid,p_previous_financial_revision text,p_expected_report_date date,
 p_request_id uuid,p_empty_report_confirmed boolean DEFAULT false,p_rounding_adjustments jsonb DEFAULT '[]',p_confirm_large_reduction boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='5s' AS $$
DECLARE v_payload jsonb;v_saved cf_private.payable_daily_requests%ROWTYPE;v_previous cf_private.payable_daily_reports%ROWTYPE;v_existing public.payable_imports%ROWTYPE;
 v_preview jsonb;v_core jsonb;v_result jsonb;v_rows jsonb;v_resolved jsonb;v_position jsonb;v_item jsonb;v_map jsonb;v_import uuid;v_report uuid:=gen_random_uuid();
 v_title public.payable_review_titles%ROWTYPE;v_event uuid;v_writeoff jsonb;v_written integer:=0;v_reuse boolean:=false;v_row jsonb;v_head_contents text;
BEGIN
 PERFORM cf_private.require_payable_import_reconciliation_actor(p_user_id,p_session_id);
 PERFORM cf_private.validate_payable_reconciliation_file(p_file_name,p_file_sha256,p_file_base64);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Informe o protocolo da importação.' USING ERRCODE='22023';END IF;
 v_payload:=jsonb_build_object('status_report_version','065','status_only',true,'report_contents',p_report_contents,'confirm_large_reduction',p_confirm_large_reduction,'scope',p_scope,'file_name',p_file_name,'file_sha256',p_file_sha256,'rows',p_rows,'report_kind',p_report_kind,
  'mappings',p_mappings,'resolution_choices',p_resolution_choices,'previous_import_id',p_previous_import_id,'previous_financial_revision',p_previous_financial_revision,
  'expected_report_date',p_expected_report_date,'empty_report_confirmed',p_empty_report_confirmed,'rounding_adjustments',p_rounding_adjustments);
 SELECT * INTO v_saved FROM cf_private.payable_daily_requests WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN IF v_saved.payload IS DISTINCT FROM v_payload THEN RAISE EXCEPTION 'Protocolo já usado com outros dados.' USING ERRCODE='22023';END IF;RETURN v_saved.result||jsonb_build_object('idempotent',true);END IF;
 IF EXISTS(SELECT 1 FROM cf_private.payable_import_resolution_requests WHERE actor_id=auth.uid() AND request_id=p_request_id) THEN RAISE EXCEPTION 'Protocolo já usado por outra importação.' USING ERRCODE='22023';END IF;
 IF p_expected_report_date IS NULL OR p_expected_report_date<>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
  RAISE EXCEPTION 'O dia da importação mudou. Atualize o arquivo.' USING ERRCODE='40001';END IF;
 LOCK TABLE public.payable_plan_mappings,public.payable_macros IN SHARE ROW EXCLUSIVE MODE;
 IF p_previous_import_id IS DISTINCT FROM (public.get_payables_revision()->>'import_id')::uuid OR p_previous_financial_revision IS NULL
  OR p_previous_financial_revision IS DISTINCT FROM cf_private.payable_report_contents_revision() THEN RAISE EXCEPTION 'A base mudou. Atualize a importação.' USING ERRCODE='40001';END IF;
 SELECT * INTO v_previous FROM cf_private.payable_daily_reports WHERE report_kind='ALL' ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT * INTO v_existing FROM public.payable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256 AND import_mode='FORECAST';
 v_preview:=public.preview_payables_status_contents_report(p_scope,p_rows,p_report_kind,p_report_contents,p_mappings,p_resolution_choices,p_empty_report_confirmed,p_rounding_adjustments,p_confirm_large_reduction);
 IF NOT coalesce((v_preview->>'can_commit')::boolean,false) THEN RAISE EXCEPTION 'Confira o conteúdo do relatório e as pendências indicadas antes de importar.' USING ERRCODE='P0065';END IF;
 v_rows:=v_preview->'rows';v_map:=CASE WHEN p_report_contents='FULL_OPEN' THEN cf_private.payable_open_status_mappings(v_rows,p_mappings) ELSE '{}'::jsonb END;
 IF v_existing.id IS NOT NULL AND NOT p_empty_report_confirmed THEN
  SELECT coalesce((SELECT q.payload->>'report_contents' FROM cf_private.payable_daily_requests q
   WHERE q.report_id=v_previous.id AND q.payload->>'status_report_version'='065' ORDER BY q.created_at DESC LIMIT 1),'FULL_OPEN') INTO v_head_contents;
  IF v_previous.id IS NULL OR v_previous.file_sha256 IS DISTINCT FROM p_file_sha256 OR v_previous.source_import_id IS DISTINCT FROM v_existing.id
   OR v_previous.rows IS DISTINCT FROM v_rows OR v_head_contents IS DISTINCT FROM p_report_contents
   OR (v_preview->>'marked_paid_count')::integer<>0 OR (v_preview->>'reopened_count')::integer<>0
   OR(p_report_contents='FULL_OPEN' AND NOT cf_private.payable_unified_current_source_matches(p_scope,v_rows,v_map)) THEN
   RAISE EXCEPTION 'Um arquivo antigo ou de outro conteúdo não pode substituir a posição atual. Exporte o relatório atualizado.' USING ERRCODE='23505';END IF;
  v_reuse:=true;
 END IF;
 v_resolved:=CASE WHEN p_empty_report_confirmed THEN '[]'::jsonb ELSE cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,v_rows)) END;
 -- A fonte atualiza os dados do mesmo UUID; reabre somente a baixa administrativa.
 -- Nenhum recebimento/pagamento verdadeiro é estornado ou reclassificado.
 IF p_report_contents='FULL_OPEN' THEN
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_resolved) WHERE (value->>'amount_cents')::bigint<>1 AND value->>'title_id' IS NOT NULL LOOP
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_row->>'title_id')::uuid;
  IF v_title.administrative_writeoff_id IS NOT NULL THEN PERFORM cf_private.reverse_payable_administrative_writeoff(v_title.id,'Retornou ao relatório completo de títulos em aberto.',v_title.payment_revision);END IF;
 END LOOP;
 END IF;
 IF p_empty_report_confirmed THEN
  IF v_existing.id IS NOT NULL THEN
   IF v_existing.row_count<>0 OR NOT EXISTS(SELECT 1 FROM cf_private.payable_import_files WHERE import_id=v_existing.id AND file_bytes=decode(p_file_base64,'base64')) THEN
    RAISE EXCEPTION 'A cópia preservada não corresponde ao relatório vazio.' USING ERRCODE='22023';END IF;v_import:=v_existing.id;
  ELSE
   v_import:=gen_random_uuid();INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode)
    VALUES(v_import,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),0,0,0,0,'FORECAST');
   INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_import,decode(p_file_base64,'base64'));
  END IF;
  v_core:=jsonb_build_object('import_id',v_import,'new_count',0,'open_count',0,'changed_count',0,'row_count',0);v_position:='[]';
 ELSIF v_reuse THEN
  v_import:=v_existing.id;
  IF NOT EXISTS(SELECT 1 FROM cf_private.payable_import_files WHERE import_id=v_import AND file_bytes=decode(p_file_base64,'base64')) THEN
   RAISE EXCEPTION 'A cópia preservada não corresponde ao arquivo.' USING ERRCODE='22023';END IF;
  v_core:=jsonb_build_object('import_id',v_import,'new_count',0,'open_count',jsonb_array_length(v_rows),'changed_count',0,'row_count',jsonb_array_length(v_rows));
 ELSIF p_report_contents='PAID_STATUS' THEN
  v_import:=gen_random_uuid();
  INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode)
   VALUES(v_import,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),0,jsonb_array_length(v_rows),
    (v_preview->>'marked_paid_count')::integer,'FORECAST');
  INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_import,decode(p_file_base64,'base64'));
  v_core:=jsonb_build_object('import_id',v_import,'new_count',0,'open_count',jsonb_array_length(v_rows),'changed_count',0,'row_count',jsonb_array_length(v_rows));
 ELSE
  v_core:=cf_private.commit_payables_forecast_import_v1_core(p_scope,p_file_name,p_file_sha256,p_file_base64,v_rows,v_map,p_previous_import_id);v_import:=(v_core->>'import_id')::uuid;
 END IF;
 INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES(v_import,'FORECAST',v_core,auth.uid()) ON CONFLICT(import_id) DO NOTHING;
 IF p_report_contents='FULL_OPEN' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('title_id',i.title_id,'source_key',r->>'source_key') ORDER BY n),'[]') INTO v_position
   FROM jsonb_array_elements(CASE WHEN p_empty_report_confirmed THEN '[]'::jsonb ELSE cf_private.validate_payable_identity_rows(p_scope,v_rows) END) WITH ORDINALITY a(r,n)
   JOIN cf_private.payable_identity_registry i ON i.scope=p_scope AND i.business_key=r->>'source_key';
 ELSE
  SELECT coalesce(jsonb_agg(p ORDER BY n),'[]') INTO v_position FROM jsonb_array_elements(v_previous.position) WITH ORDINALITY a(p,n)
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_resolved) r WHERE r->>'title_id'=p->>'title_id');
 END IF;
 IF jsonb_array_length(v_position)<>(v_preview->>'position_count')::integer
  OR(p_report_contents='FULL_OPEN' AND jsonb_array_length(v_position)<>jsonb_array_length(v_rows))
  OR(v_reuse AND v_position IS DISTINCT FROM v_previous.position) THEN
  RAISE EXCEPTION 'A posição não corresponde ao conteúdo confirmado do relatório.' USING ERRCODE='40001';END IF;
 INSERT INTO cf_private.payable_daily_reports(id,report_kind,file_sha256,report_date,source_import_id,previous_report_id,rows,position,created_by)
  VALUES(v_report,'ALL',p_file_sha256,p_expected_report_date,v_import,v_previous.id,v_rows,v_position,auth.uid());
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_preview->'status_actions') LOOP
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_item->>'title_id')::uuid;
  IF v_item->>'kind'='REOPEN' THEN
   SELECT id INTO v_event FROM cf_private.active_payable_report_status WHERE title_id=v_title.id;
   INSERT INTO public.payable_report_status_events(title_id,report_id,source_import_id,event_type,prior_event_id,reason,title_snapshot,created_by)
    VALUES(v_title.id,v_report,v_import,'REOPEN',v_event,'Título retornou ao relatório completo de abertos.',to_jsonb(v_title),auth.uid());
  ELSE
   UPDATE public.payable_titles SET status='SETTLED_IMPORT',settled_at=clock_timestamp(),last_import_id=v_import WHERE id=v_title.id;
   INSERT INTO public.payable_report_status_events(title_id,report_id,source_import_id,event_type,reason,title_snapshot,created_by)
    VALUES(v_title.id,v_report,v_import,'PAID',CASE WHEN p_report_contents='PAID_STATUS' THEN 'Título listado no relatório de baixados: estado Pago sem registrar pagamento.' ELSE 'Título ausente do relatório completo seguinte: estado Pago sem registrar pagamento.' END,to_jsonb(v_title),auth.uid());
  END IF;
 END LOOP;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_preview->'exceptions') WHERE value->>'kind'='CENT' AND (value->>'requires_resolution')::boolean LOOP
  IF v_item->>'title_id' IS NULL THEN
   SELECT f.* INTO v_title FROM public.payable_review_titles f JOIN cf_private.payable_identity_registry i ON i.title_id=f.id
    WHERE i.scope=p_scope AND i.business_key=cf_private.payable_business_key(v_item->>'branch',v_item->>'entry_number');
  ELSE SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_item->>'title_id')::uuid;END IF;
  IF v_title.id IS NULL THEN RAISE EXCEPTION 'Marcador não encontrado.' USING ERRCODE='40001';END IF;
  IF v_title.report_paid THEN
   SELECT id INTO v_event FROM cf_private.active_payable_report_status WHERE title_id=v_title.id;
   INSERT INTO public.payable_report_status_events(title_id,report_id,source_import_id,event_type,prior_event_id,reason,title_snapshot,created_by)
    VALUES(v_title.id,v_report,v_import,'REOPEN',v_event,'Título retornou como marcador de um centavo, com baixa administrativa confirmada.',to_jsonb(v_title),auth.uid());
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
  END IF;
  IF v_title.administrative_writeoff_id IS NULL THEN
   v_writeoff:=cf_private.record_payable_administrative_writeoff(v_title.id,v_import,p_resolution_choices->(v_item->>'key')->>'reason',v_title.payment_revision);
   INSERT INTO cf_private.payable_daily_actions(report_id,title_id,writeoff_id,effective_on,rule_kind,title_snapshot,created_by)
    VALUES(v_report,v_title.id,(v_writeoff->>'writeoff_id')::uuid,p_expected_report_date,'CENT',to_jsonb(v_title),auth.uid());v_written:=v_written+1;
  END IF;
 END LOOP;
 v_result:=v_core||jsonb_build_object('status_report_version','065','status_only',true,'report_contents',p_report_contents,'confirm_large_reduction',p_confirm_large_reduction,'mode','open_status','report_kind','ALL','empty_report_confirmed',p_empty_report_confirmed,
  'report_date',p_expected_report_date,'request_id',p_request_id,'report_id',v_report,'import_id',v_import,'new_count',(v_preview->>'new_count')::integer,'open_count',(v_preview->>'open_count')::integer,
  'changed_count',(v_preview->>'changed_count')::integer,'updated_count',(v_preview->>'changed_count')::integer,'marked_paid_count',(v_preview->>'marked_paid_count')::integer,
  'marked_paid_cents',(v_preview->>'marked_paid_cents')::numeric,'reopened_count',(v_preview->>'reopened_count')::integer,
  'paid_count',0,'payment_cents',0,'payments_created',0,'written_off_count',v_written,'baseline_only',(v_preview->>'baseline_only')::boolean,
  'position_count',jsonb_array_length(v_position),'previous_position_count',(v_preview->>'previous_position_count')::integer,
  'removed_from_position_count',(v_preview->>'removed_from_position_count')::integer,'requires_large_reduction_confirmation',(v_preview->>'requires_large_reduction_confirmation')::boolean,
  'large_reduction_confirmed',p_confirm_large_reduction,'large_reduction_problem',NULL,'source_row_count',jsonb_array_length(v_rows),'paid_already_closed_count',(v_preview->>'paid_already_closed_count')::integer,
  'paid_already_closed_keys',v_preview->'paid_already_closed_keys','paid_unknown_keys',v_preview->'paid_unknown_keys',
  'rounding_adjustments',p_rounding_adjustments,'unmapped_plans',v_preview->'unmapped_plans','completed_revision',public.get_payables_revision(),'idempotent',false);
 INSERT INTO cf_private.payable_daily_requests(actor_id,request_id,payload,result,report_id) VALUES(auth.uid(),p_request_id,v_payload,v_result,v_report);
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
  SELECT id,username,role_key,'contas_pagar','PAYABLE_REPORT_CONTENTS_IMPORT',v_report::text,'IMPORT',v_result FROM public.profiles WHERE id=auth.uid();
 RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION cf_private.payable_report_contents_revision(),
 public.preview_payables_status_contents_report(text,jsonb,text,text,jsonb,jsonb,boolean,jsonb,boolean),
 public.commit_payables_status_contents_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,text,jsonb,jsonb,uuid,text,date,uuid,boolean,jsonb,boolean)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_payables_status_contents_report(text,jsonb,text,text,jsonb,jsonb,boolean,jsonb,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_payables_status_contents_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,text,jsonb,jsonb,uuid,text,date,uuid,boolean,jsonb,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.commit_payables_open_status_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,uuid,text,date,uuid,boolean,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
 $source065$;
 v_definition:=pg_get_functiondef('cf_private.guard_payable_empty_cheques_import()'::regprocedure);
 v_guard:=$oldguard$(r.result->>'status_report_version'='061' AND r.result->'status_only'='true'::jsonb AND r.payload->>'status_report_version'='061' AND r.payload->'status_only'='true'::jsonb)$oldguard$;
 IF (length(v_definition)-length(replace(v_definition,v_guard,'')))/length(v_guard)<>1 THEN
  RAISE EXCEPTION 'Contrato da confirmação de relatório vazio divergente.' USING ERRCODE='22023';END IF;
 EXECUTE replace(v_definition,v_guard,'('||v_guard||$newguard$ OR (r.result->>'status_report_version'='065' AND r.result->'status_only'='true'::jsonb
  AND r.payload->>'status_report_version'='065' AND r.payload->'status_only'='true'::jsonb
  AND r.result->>'report_contents'='FULL_OPEN' AND r.payload->>'report_contents'='FULL_OPEN' AND r.result->'position_count'='0'::jsonb))$newguard$);
 v_definition:=pg_get_functiondef('public.payables_import_capabilities()'::regprocedure);
 IF position('''status_report_version'',''061''' IN v_definition)=0 THEN RAISE EXCEPTION 'Contrato das capacidades de CP divergente.' USING ERRCODE='22023';END IF;
 EXECUTE replace(v_definition,'''status_report_version'',''061''','''status_report_version'',''065'',''report_contents_version'',''065'',''report_contents'',jsonb_build_array(''FULL_OPEN'',''PAID_STATUS'')');
 INSERT INTO public.central_schema_migrations(version) VALUES('065_payable_report_contents');
 NOTIFY pgrst,'reload schema';
END $apply065$;
COMMIT;
