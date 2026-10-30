-- Um único relatório completo para títulos comuns e cheques.
-- Instalar não limpa a base nem presume pagamentos; a limpeza administrativa é separada.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $apply_060$
DECLARE v_definition text;v_patch record;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='059_payable_column_rules') THEN
  RAISE EXCEPTION 'Ative a atualização 059 antes do relatório único de Contas a Pagar.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='060_payable_unified_report') THEN RETURN;END IF;
 -- Uma posição ALL começa no primeiro arquivo desta rotina. Posições antigas
 -- permanecem no histórico e nunca são adotadas silenciosamente como referência.
 ALTER TABLE cf_private.payable_daily_reports DROP CONSTRAINT payable_daily_reports_report_kind_check;
 ALTER TABLE cf_private.payable_daily_reports ADD CONSTRAINT payable_daily_reports_report_kind_check CHECK(report_kind IN('NORMAL','CHEQUES','ALL'));
 DROP INDEX cf_private.payable_daily_reports_nonempty_file;
 CREATE UNIQUE INDEX payable_daily_reports_nonempty_file ON cf_private.payable_daily_reports(report_kind,file_sha256)
  WHERE jsonb_array_length(rows)>0 AND report_kind<>'ALL';
 EXECUTE $same_source_060$
CREATE FUNCTION cf_private.payable_unified_current_source_matches(p_scope text,p_rows jsonb,p_mappings jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $fn$
 SELECT coalesce(bool_and(t.id IS NOT NULL AND
  (((r->>'amount_cents')::bigint=1 AND t.administrative_writeoff_id IS NOT NULL) OR
   (t.administrative_writeoff_id IS NULL AND ROW(t.entry_number,t.description,t.due_date,t.amount_cents,t.source_status,t.plan,t.bank_account,t.branch,t.issued_on)
    IS NOT DISTINCT FROM ROW(r->>'entry_number',r->>'description',(r->>'due_date')::date,(r->>'amount_cents')::bigint,r->>'source_status',r->>'plan',r->>'bank_account',r->>'branch',(r->>'issued_on')::date)
    AND (NOT r ? 'cheque_number' OR t.cheque_number IS NOT DISTINCT FROM r->>'cheque_number')
    AND t.macro IS NOT DISTINCT FROM coalesce(p_mappings->>(r->>'plan'),m.macro)))),false)
 FROM jsonb_array_elements(cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,p_rows))) r
 LEFT JOIN public.payable_financial_titles t ON t.id=(r->>'title_id')::uuid
 LEFT JOIN public.payable_plan_mappings m ON m.plan=r->>'plan';
$fn$;
REVOKE ALL ON FUNCTION cf_private.payable_unified_current_source_matches(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION cf_private.payable_unified_latest_report_at(p_fallback timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path='' AS $fn$
 SELECT coalesce((SELECT created_at FROM cf_private.payable_daily_reports WHERE report_kind='ALL' ORDER BY created_at DESC,id DESC LIMIT 1),p_fallback);
$fn$;
REVOKE ALL ON FUNCTION cf_private.payable_unified_latest_report_at(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
 $same_source_060$;

 v_definition:=pg_get_functiondef('public.preview_payables_daily_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean)'::regprocedure);
 IF position('payable_columns_059_all_source_rows' IN v_definition)=0 THEN RAISE EXCEPTION 'A conferência 059 não corresponde ao contrato esperado.' USING ERRCODE='22023';END IF;
 v_definition:=replace(v_definition,'FUNCTION public.preview_payables_daily_report(','FUNCTION public.preview_payables_unified_report(');
 v_definition:=replace(v_definition,'p_empty_cheques_confirmed','p_empty_report_confirmed');
 v_definition:=replace(v_definition,'''empty_cheques_confirmed''','''empty_report_confirmed''');
 FOR v_patch IN SELECT * FROM (VALUES
  ($old$IF p_report_kind IS NULL OR p_report_kind NOT IN('NORMAL','CHEQUES') THEN RAISE EXCEPTION 'Escolha títulos comuns ou cheques.' USING ERRCODE='22023';END IF;$old$,
   $new$IF p_report_kind IS DISTINCT FROM 'ALL' THEN RAISE EXCEPTION 'Use o relatório completo único de Contas a Pagar.' USING ERRCODE='22023';END IF;$new$),
  ($old$(p_empty_report_confirmed AND (p_report_kind<>'CHEQUES' OR p_rows<>'[]'::jsonb))$old$,
   $new$(p_empty_report_confirmed AND (p_report_kind<>'ALL' OR p_rows<>'[]'::jsonb))$new$),
  ($old$RAISE EXCEPTION 'Declare uma posição sem cheques somente para o relatório vazio de cheques.'$old$,
   $new$RAISE EXCEPTION 'Confirme uma posição sem títulos somente para o relatório completo vazio.'$new$),
  ($old$IF p_report_kind='CHEQUES' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE NOT cf_private.payable_daily_is_cheque(r->>'source_status',r->>'cheque_number')) THEN
  RAISE EXCEPTION 'O relatório de cheques contém títulos comuns. Selecione a base completa somente de cheques.' USING ERRCODE='22023';END IF;$old$,
   $new$-- O arquivo único contém títulos comuns e cheques, sem partição da fonte.$new$),
  ($old$FOR v_row,v_line IN SELECT value,ordinality::integer FROM jsonb_array_elements(v_rows) WITH ORDINALITY LOOP$old$,
   $new$FOR v_row,v_line IN SELECT value,ordinality::integer FROM jsonb_array_elements(v_rows) WITH ORDINALITY LOOP
  v_rule:=CASE WHEN cf_private.payable_daily_is_cheque(v_row->>'source_status',v_row->>'cheque_number') THEN 'IMPORT_DATE' ELSE 'DUE_DATE' END;$new$),
  ($old$'cheque_number',v_row->>'cheque_number','rule',v_rule$old$,
   $new$'cheque_number',v_row->>'cheque_number','is_cheque',cf_private.payable_daily_is_cheque(v_row->>'source_status',v_row->>'cheque_number'),'rule',v_rule$new$),
  ($old$IF p_report_kind='NORMAL' OR v_last.id IS NOT NULL THEN$old$,
   $new$IF v_last.id IS NOT NULL THEN$new$),
  ($old$WHERE t.scope=p_scope AND cf_private.payable_daily_is_cheque(t.source_status,t.cheque_number)=(p_report_kind='CHEQUES')
      AND (v_last.id IS NULL OR t.id IN(SELECT id FROM prior))$old$,
   $new$WHERE t.scope=p_scope AND t.id IN(SELECT id FROM prior)$new$),
  ($old$v_paid_on:=CASE WHEN p_report_kind='NORMAL' THEN (v_snapshot->>'due_date')::date ELSE v_date END;$old$,
   $new$v_rule:=CASE WHEN cf_private.payable_daily_is_cheque(v_snapshot->>'source_status',v_snapshot->>'cheque_number') THEN 'IMPORT_DATE' ELSE 'DUE_DATE' END;
   v_paid_on:=CASE WHEN v_rule='DUE_DATE' THEN (v_snapshot->>'due_date')::date ELSE v_date END;$new$),
  ($old$'cheque_number',v_snapshot->>'cheque_number','rule',v_rule$old$,
   $new$'cheque_number',v_snapshot->>'cheque_number','is_cheque',cf_private.payable_daily_is_cheque(v_snapshot->>'source_status',v_snapshot->>'cheque_number'),'rule',v_rule$new$),
  ($old$'daily_report_version','059','column_rules_version','059'$old$,
   $new$'daily_report_version','060','column_rules_version','059','unified_daily_report',true$new$),
  ($old$'baseline_only',p_report_kind='CHEQUES' AND v_last.id IS NULL,'baseline_origin',CASE WHEN v_last.id IS NOT NULL THEN 'PREVIOUS_REPORT' WHEN p_report_kind='NORMAL' THEN 'EXISTING_BASE' ELSE 'FIRST_REPORT' END$old$,
   $new$'baseline_only',v_last.id IS NULL,'baseline_origin',CASE WHEN v_last.id IS NOT NULL THEN 'PREVIOUS_REPORT' ELSE 'FIRST_REPORT' END$new$)
 ) changes(old_text,new_text) LOOP
  IF (length(v_definition)-length(replace(v_definition,v_patch.old_text,'')))/length(v_patch.old_text)<>1 THEN
   RAISE EXCEPTION 'Contrato da prévia única divergente. Nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
  v_definition:=replace(v_definition,v_patch.old_text,v_patch.new_text);
 END LOOP;
 EXECUTE v_definition;

 v_definition:=pg_get_functiondef('public.commit_payables_daily_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,uuid,text,date,uuid,boolean)'::regprocedure);
 v_definition:=replace(v_definition,'FUNCTION public.commit_payables_daily_report_from_gateway(','FUNCTION public.commit_payables_unified_report_from_gateway(');
 v_definition:=replace(v_definition,'p_empty_cheques_confirmed','p_empty_report_confirmed');
 v_definition:=replace(v_definition,'''empty_cheques_confirmed''','''empty_report_confirmed''');
 FOR v_patch IN SELECT * FROM (VALUES
  ($old$v_cents numeric:=0;v_key text;$old$,$new$v_cents numeric:=0;v_key text;v_reuse_head boolean:=false;$new$),
  ($old$v_preview:=public.preview_payables_daily_report($old$,$new$v_preview:=public.preview_payables_unified_report($new$),
  ($old$IF v_existing.id IS NOT NULL AND NOT coalesce(p_empty_report_confirmed,false) THEN
  RAISE EXCEPTION 'Este arquivo já foi importado. Exporte o relatório atual da origem; nenhuma baixa foi repetida.' USING ERRCODE='23505';
 END IF;$old$,
   $new$IF v_existing.id IS NOT NULL AND NOT coalesce(p_empty_report_confirmed,false) THEN
  IF v_previous.id IS NULL OR v_previous.file_sha256 IS DISTINCT FROM p_file_sha256 THEN
   RAISE EXCEPTION 'Um arquivo antigo não pode substituir a posição mais recente. Exporte o relatório atual.' USING ERRCODE='23505';END IF;
  v_reuse_head:=true;
 END IF;$new$),
  ($old$RAISE EXCEPTION 'Confira as exceções antes de concluir a importação diária.' USING ERRCODE='P0058';$old$,
   $new$RAISE EXCEPTION 'Confira as exceções antes de concluir o relatório completo único.' USING ERRCODE='P0060';$new$),
  ($old$CASE WHEN p_report_kind='NORMAL' THEN v_title.due_date ELSE p_expected_report_date END$old$,
   $new$CASE WHEN v_item->>'rule'='DUE_DATE' THEN v_title.due_date ELSE p_expected_report_date END$new$),
  ($old$'daily_report_version','059','column_rules_version','059'$old$,
   $new$'daily_report_version','060','column_rules_version','059','unified_daily_report',true$new$),
  ($old$O arquivo já registrado não corresponde à posição vazia de cheques.$old$,
   $new$O arquivo já registrado não corresponde ao relatório completo vazio.$new$),
  ($old$v_rows:=v_preview->'rows';$old$,
   $new$v_rows:=v_preview->'rows';
 IF v_reuse_head THEN
  IF v_rows IS DISTINCT FROM v_previous.rows OR (v_preview->>'missing_count')::integer<>0
   OR NOT cf_private.payable_unified_current_source_matches(p_scope,v_rows,p_mappings) THEN
   RAISE EXCEPTION 'A base atual diverge deste arquivo já importado. Confira o título ou envie o relatório atualizado.' USING ERRCODE='23505';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('title_id',r->>'title_id','source_key',r->>'source_key') ORDER BY n),'[]') INTO v_position
   FROM jsonb_array_elements(cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,v_rows))) WITH ORDINALITY a(r,n);
  IF v_position IS DISTINCT FROM v_previous.position THEN RAISE EXCEPTION 'A identidade da posição atual mudou. Analise o relatório atualizado.' USING ERRCODE='23505';END IF;
 END IF;$new$),
  ($old$ELSE
  v_core:=cf_private.commit_payables_forecast_import_v1_core(p_scope,p_file_name,p_file_sha256,p_file_base64,v_rows,p_mappings,p_previous_import_id);v_import:=(v_core->>'import_id')::uuid;$old$,
   $new$ELSIF v_reuse_head THEN
  v_import:=v_previous.source_import_id;
  IF NOT EXISTS(SELECT 1 FROM cf_private.payable_import_files f WHERE f.import_id=v_import AND f.file_bytes=decode(p_file_base64,'base64')) THEN
   RAISE EXCEPTION 'A cópia preservada não corresponde ao arquivo atual.' USING ERRCODE='22023';END IF;
  v_core:=jsonb_build_object('mode','forecast','import_id',v_import,'new_count',0,'open_count',jsonb_array_length(v_rows),'changed_count',0,'settled_count',0,'row_count',jsonb_array_length(v_rows));
 ELSE
  v_core:=cf_private.commit_payables_forecast_import_v1_core(p_scope,p_file_name,p_file_sha256,p_file_base64,v_rows,p_mappings,p_previous_import_id);v_import:=(v_core->>'import_id')::uuid;$new$)
 ) changes(old_text,new_text) LOOP
  IF (length(v_definition)-length(replace(v_definition,v_patch.old_text,'')))/length(v_patch.old_text)<>1 THEN
   RAISE EXCEPTION 'Contrato da confirmação única divergente. Nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
  v_definition:=replace(v_definition,v_patch.old_text,v_patch.new_text);
 END LOOP;
 EXECUTE v_definition;
 REVOKE ALL ON FUNCTION public.preview_payables_unified_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean),
  public.commit_payables_unified_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,uuid,text,date,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
 GRANT EXECUTE ON FUNCTION public.preview_payables_unified_report(text,jsonb,text,jsonb,jsonb,jsonb,boolean) TO authenticated;
 GRANT EXECUTE ON FUNCTION public.commit_payables_unified_report_from_gateway(uuid,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,uuid,text,date,uuid,boolean) TO service_role;
 -- Fechar as entradas antigas impede que uma função Edge ainda desatualizada
 -- escreva na base reiniciada. O núcleo privado e o histórico são preservados.
 FOR v_patch IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'commit_payables%'
   AND p.proname<>'commit_payables_unified_report_from_gateway'
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_patch.signature);END LOOP;

 -- Conserva a prova vazia antiga e exige uma prova ALL/060 independente para
 -- o arquivo único sem pendências. Nem arquivo órfão nem linha artificial.
 IF position('d.report_kind=''CHEQUES''' IN pg_get_functiondef('cf_private.guard_payable_empty_cheques_import()'::regprocedure))=0 THEN
  RAISE EXCEPTION 'A proteção dos arquivos vazios diverge do contrato esperado.' USING ERRCODE='22023';END IF;
 EXECUTE $empty_guard_060$
CREATE OR REPLACE FUNCTION cf_private.guard_payable_empty_cheques_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$ BEGIN
 IF NEW.row_count=0 AND NOT EXISTS(SELECT 1 FROM cf_private.payable_daily_reports d
  JOIN cf_private.payable_daily_requests r ON r.report_id=d.id
  JOIN cf_private.payable_import_files f ON f.import_id=NEW.id
  WHERE d.source_import_id=NEW.id AND d.rows='[]'::jsonb AND d.position='[]'::jsonb
   AND d.file_sha256=NEW.file_sha256 AND encode(sha256(f.file_bytes),'hex')=NEW.file_sha256
   AND r.payload->>'file_sha256'=NEW.file_sha256 AND r.payload->'rows'='[]'::jsonb
   AND r.result->>'report_id'=d.id::text AND r.result->>'import_id'=NEW.id::text AND r.result->'row_count'='0'::jsonb
   AND ((d.report_kind='CHEQUES' AND r.payload->>'report_kind'='CHEQUES' AND r.result->>'report_kind'='CHEQUES'
     AND r.payload->'empty_cheques_confirmed'='true'::jsonb AND r.result->>'empty_cheques_confirmed'='true')
    OR (d.report_kind='ALL' AND r.payload->>'report_kind'='ALL' AND r.result->>'report_kind'='ALL'
     AND r.payload->'empty_report_confirmed'='true'::jsonb AND r.result->>'empty_report_confirmed'='true'
     AND r.result->>'daily_report_version'='060' AND r.result->'unified_daily_report'='true'::jsonb))) THEN
  RAISE EXCEPTION 'Um relatório sem títulos exige confirmação expressa e a prova íntegra da importação diária.' USING ERRCODE='22023';END IF;
 RETURN NEW;
END $fn$;
 $empty_guard_060$;

 -- Invalidar uma prévia anterior à mudança da política não modifica o livro
 -- financeiro. Reenvios de protocolos concluídos continuam antes da comparação.
 FOR v_patch IN SELECT * FROM (VALUES
  ('public.get_payables_revision()',$old$'financial_revision','059:'||v_revision);$old$,$new$'financial_revision','060:'||v_revision);$new$),
  ('public.payables_import_capabilities()',$old$'daily_report_version','059','column_rules_version','059'$old$,
   $new$'daily_report_version','060','column_rules_version','059','unified_daily_report',true$new$),
  ('public.payables_summary(date,date)',$old$'latest_import_at',v_latest)$old$,
   $new$'latest_import_at',cf_private.payable_unified_latest_report_at(v_latest))$new$),
  ('public.payables_management_summary(date,date)',$old$'latest_import_at',v_import.created_at$old$,
   $new$'latest_import_at',cf_private.payable_unified_latest_report_at(v_import.created_at)$new$),
  ('public.payables_forecast(date)',$old$'latest_import_at',v_latest.created_at$old$,
   $new$'latest_import_at',cf_private.payable_unified_latest_report_at(v_latest.created_at)$new$)
 ) changes(signature,old_text,new_text) LOOP
  v_definition:=pg_get_functiondef(v_patch.signature::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_patch.old_text,'')))/length(v_patch.old_text)<>1 THEN
   RAISE EXCEPTION 'Contrato de revisão/ativação divergente. Nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
  EXECUTE replace(v_definition,v_patch.old_text,v_patch.new_text);
 END LOOP;
 INSERT INTO public.central_schema_migrations(version) VALUES('060_payable_unified_report');
 NOTIFY pgrst,'reload schema';
END $apply_060$;
COMMIT;
