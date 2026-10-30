-- CENTRAL FINANCEIRA: recuperar SOMENTE Contas a Pagar do reinício de 30/10/2026.
-- Executar só se o reinício tiver sido indevido e CP ainda estiver vazio, sem novas operações.
-- Não altera bases ou configurações de outras áreas.
-- Não sobrepõe a base oficial. Não recupera dados alterados depois da cópia.
-- SQL Editor do projeto sjimddcqgrsauzvffcol, como postgres. Não é migration.
BEGIN;
SET LOCAL search_path = pg_catalog,pg_temp,public;
SET LOCAL timezone = 'UTC';
SET LOCAL bytea_output = 'hex';
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
DO $owner$ BEGIN
 IF current_user NOT IN ('postgres','supabase_admin') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'Execute este SQL pelo SQL Editor como proprietário do banco.' USING ERRCODE='42501';
 END IF;
 IF to_regclass('cf_operations.base_resets') IS NULL THEN RAISE EXCEPTION 'Não existe uma cópia registrada do reinício de Contas a Pagar.' USING ERRCODE='22023';END IF;
END $owner$;
DROP TABLE IF EXISTS pg_temp._cf_payable_restore_result;
CREATE TEMP TABLE _cf_payable_restore_result(status text,operation_key text,backup_schema text,tables_restored integer,restored_rows bigint);
DO $restore$
DECLARE
 v_operation constant text:='cp-restart-2026-10-30-v1';
 v_targets text[]:=ARRAY[
  'public.payable_imports','public.payable_titles','public.payable_forecast_completions',
  'public.payable_payments','public.payable_payment_reversals','public.payable_title_control_revisions',
  'public.payable_title_reviews','public.payable_title_corrections','public.payable_title_macro_overrides',
  'public.payable_payment_reclassifications','public.payable_month_closures','public.payable_month_events',
  'public.payable_import_modes','public.payable_paid_import_rows','public.payable_administrative_writeoffs',
  'cf_private.payable_import_files','cf_private.payable_identity_registry','cf_private.payable_import_resolution_requests',
  'cf_private.payable_daily_reports','cf_private.payable_daily_requests','cf_private.payable_daily_actions'
 ];
 v_configs text[]:=ARRAY['public.payable_macros','public.payable_plan_mappings','public.payable_forecast_rules',
  'public.payable_forecast_plan_bindings','public.payable_paid_bank_mappings','cf_private.payable_paid_bank_aliases',
  'cf_private.payable_payment_state','cf_private.payable_control_state'];
 v_run cf_operations.base_resets%ROWTYPE;v_record record;v_trigger record;v_state record;
 v_all text;v_unknown text;v_count bigint;v_total bigint:=0;v_tables integer:=0;v_columns text;v_signature jsonb;v_triggers jsonb;v_command text;v_hash text;
 v_current_state jsonb;v_expected_state jsonb;
 v_manifest text[];v_scope_oids oid[];v_name text;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(2045812301);
 PERFORM pg_catalog.pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 PERFORM pg_catalog.pg_advisory_xact_lock(2045812309);
 SELECT * INTO v_run FROM cf_operations.base_resets WHERE operation_key=v_operation FOR UPDATE;
 IF NOT FOUND OR v_run.format_version<>'payable-reset-v1' THEN RAISE EXCEPTION 'A cópia desta operação não foi identificada.' USING ERRCODE='22023';END IF;
 IF v_run.restored_at IS NOT NULL THEN
  INSERT INTO _cf_payable_restore_result VALUES('JA_RESTAURADO',v_operation,v_run.backup_schema,0,0);RETURN;
 END IF;
 IF v_run.backup_schema !~ '^cf_payable_backup_[0-9a-f]{32}$' OR to_regnamespace(v_run.backup_schema) IS NULL THEN
  RAISE EXCEPTION 'O arquivo privado da cópia não está disponível.' USING ERRCODE='22023';END IF;
 SELECT string_agg(format('%I.%I',n.nspname,c.relname),', ' ORDER BY n.nspname,c.relname) INTO v_unknown
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','cf_private') AND c.relkind IN('r','p') AND c.relname~'^payables?_'
  AND NOT(format('%I.%I',n.nspname,c.relname)=ANY(v_targets||v_configs))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e');
 IF v_unknown IS NOT NULL THEN RAISE EXCEPTION 'Existem novas tabelas de CP fora da recuperação: %.',v_unknown USING ERRCODE='22023';END IF;
 FOR v_record IN EXECUTE format('SELECT relation_name FROM %I._tables',v_run.backup_schema) LOOP
  IF NOT v_record.relation_name=ANY(v_targets) THEN RAISE EXCEPTION 'A cópia contém uma tabela fora de Contas a Pagar.' USING ERRCODE='22023';END IF;
 END LOOP;
 EXECUTE format('SELECT array_agg(relation_name),array_agg(relation_oid) FROM %I._tables',v_run.backup_schema) INTO v_manifest,v_scope_oids;
 FOREACH v_name IN ARRAY v_targets LOOP
  IF to_regclass(v_name) IS NOT NULL AND NOT v_name=ANY(v_manifest) THEN
   RAISE EXCEPTION 'A estrutura de CP mudou depois da cópia: %. A recuperação foi interrompida.',v_name USING ERRCODE='22023';END IF;
 END LOOP;
 EXECUTE format('SELECT string_agg(relation_oid::regclass::text,'', '' ORDER BY relation_name) FROM %I._tables',v_run.backup_schema) INTO v_all;
 IF v_all IS NULL THEN RAISE EXCEPTION 'A cópia não contém um manifesto de tabelas válido.' USING ERRCODE='22023';END IF;
 EXECUTE 'LOCK TABLE '||v_all||' IN ACCESS EXCLUSIVE MODE';
 SELECT string_agg(conrelid::regclass::text,', ') INTO v_unknown FROM pg_catalog.pg_constraint
 WHERE contype='f' AND confrelid=ANY(v_scope_oids) AND NOT conrelid=ANY(v_scope_oids);
 IF v_unknown IS NOT NULL THEN RAISE EXCEPTION 'Existem novas dependências fora de CP: %. A recuperação foi interrompida.',v_unknown USING ERRCODE='22023';END IF;
 -- Valida tudo antes de modificar qualquer linha ou trigger da operação.
 FOR v_record IN EXECUTE format('SELECT * FROM %I._tables ORDER BY restore_order',v_run.backup_schema) LOOP
  IF to_regclass(v_record.relation_name) IS DISTINCT FROM v_record.relation_oid THEN
   RAISE EXCEPTION 'A tabela % foi removida ou recriada. A recuperação foi interrompida.',v_record.relation_name USING ERRCODE='22023';END IF;
  SELECT string_agg(format('%I',attname),', ' ORDER BY attnum) FILTER(WHERE attgenerated=''),
   jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attnotnull,attgenerated,attidentity) ORDER BY attnum)
  INTO v_columns,v_signature FROM pg_catalog.pg_attribute WHERE attrelid=v_record.relation_oid AND attnum>0 AND NOT attisdropped;
  SELECT coalesce(jsonb_object_agg(tgname,tgenabled),'{}'::jsonb) INTO v_triggers FROM pg_catalog.pg_trigger WHERE tgrelid=v_record.relation_oid AND NOT tgisinternal;
  IF v_signature IS DISTINCT FROM v_record.column_signature OR v_columns IS DISTINCT FROM v_record.column_list OR v_triggers IS DISTINCT FROM v_record.trigger_states THEN
   RAISE EXCEPTION 'A estrutura ou os controles de % mudaram. A recuperação foi interrompida.',v_record.relation_name USING ERRCODE='22023';END IF;
  EXECUTE format('SELECT count(*) FROM %s',v_record.relation_oid::regclass) INTO v_count;
  IF v_count<>0 THEN RAISE EXCEPTION 'A base % já contém dados. A recuperação não sobrepõe importações oficiais.',v_record.relation_name USING ERRCODE='23514';END IF;
  EXECUTE format('SELECT count(*) FROM %I.%I',v_run.backup_schema,v_record.backup_table) INTO v_count;
  IF v_count<>v_record.row_count OR (v_run.counts->>v_record.relation_name)::bigint IS DISTINCT FROM v_record.row_count THEN
   RAISE EXCEPTION 'A conferência da cópia de % falhou.',v_record.relation_name USING ERRCODE='23514';END IF;
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(string_agg(h,'''' ORDER BY h),''''),''UTF8'')),''hex'') FROM(SELECT encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex'') h FROM %I.%I t)s',v_run.backup_schema,v_record.backup_table) INTO v_hash;
  IF v_hash IS DISTINCT FROM v_record.content_sha256 THEN RAISE EXCEPTION 'O conteúdo da cópia de % foi alterado. A recuperação foi interrompida.',v_record.relation_name USING ERRCODE='23514';END IF;
  v_total:=v_total+v_count;v_tables:=v_tables+1;
 END LOOP;
 IF v_total<>v_run.removed_rows OR v_tables<>(SELECT count(*) FROM jsonb_object_keys(v_run.counts)) THEN RAISE EXCEPTION 'A conferência do total da cópia falhou.' USING ERRCODE='23514';END IF;
 -- Qualquer operação financeira de CP após o reinício invalida a recuperação,
 -- mesmo se alguém tiver removido suas linhas depois. Outras áreas não interferem.
 FOR v_state IN EXECUTE format('SELECT * FROM %I._states',v_run.backup_schema) LOOP
  IF v_state.relation_name NOT IN('cf_private.payable_payment_state','cf_private.payable_control_state')
   OR encode(sha256(convert_to(v_state.previous_rows::text,'UTF8')),'hex') IS DISTINCT FROM v_state.content_sha256 THEN
   RAISE EXCEPTION 'A cópia das revisões de CP não foi conferida.' USING ERRCODE='23514';END IF;
  EXECUTE format('SELECT revision FROM %s FOR UPDATE',v_state.relation_name::regclass);
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY to_jsonb(s)::text),''[]'') FROM %s s',v_state.relation_name::regclass) INTO v_current_state;
  SELECT coalesce(jsonb_agg((r-'revision')||jsonb_build_object('revision',(r->>'revision')::numeric+1)
   ORDER BY ((r-'revision')||jsonb_build_object('revision',(r->>'revision')::numeric+1))::text),'[]')
   INTO v_expected_state FROM jsonb_array_elements(v_state.previous_rows)r;
  IF v_current_state IS DISTINCT FROM v_expected_state THEN
   RAISE EXCEPTION 'Contas a Pagar teve novas operações após o reinício. A recuperação não sobrepõe a nova base.' USING ERRCODE='23514';END IF;
 END LOOP;
 SET CONSTRAINTS ALL DEFERRED;
 -- Somente triggers de usuário são suspensos, nesta transação; FKs e demais constraints seguem ativas.
 FOR v_record IN EXECUTE format('SELECT * FROM %I._tables ORDER BY restore_order',v_run.backup_schema) LOOP
  EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER',v_record.relation_oid::regclass);
 END LOOP;
 FOR v_record IN EXECUTE format('SELECT * FROM %I._tables ORDER BY restore_order',v_run.backup_schema) LOOP
  EXECUTE format('INSERT INTO %s (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM %I.%I',v_record.relation_oid::regclass,v_record.column_list,v_record.column_list,v_run.backup_schema,v_record.backup_table);
  EXECUTE format('SELECT count(*) FROM %s',v_record.relation_oid::regclass) INTO v_count;
  IF v_count<>v_record.row_count THEN RAISE EXCEPTION 'A recuperação de % não foi conferida.',v_record.relation_name;END IF;
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(string_agg(h,'''' ORDER BY h),''''),''UTF8'')),''hex'') FROM(SELECT encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex'') h FROM %s t)s',v_record.relation_oid::regclass) INTO v_hash;
  IF v_hash IS DISTINCT FROM v_record.content_sha256 THEN RAISE EXCEPTION 'O conteúdo recuperado de % não foi conferido.',v_record.relation_name;END IF;
 END LOOP;
 SET CONSTRAINTS ALL IMMEDIATE;
 FOR v_record IN EXECUTE format('SELECT * FROM %I._tables ORDER BY restore_order',v_run.backup_schema) LOOP
  FOR v_trigger IN SELECT * FROM jsonb_each_text(v_record.trigger_states) LOOP
   v_command:=CASE v_trigger.value WHEN 'O' THEN 'ENABLE' WHEN 'D' THEN 'DISABLE' WHEN 'R' THEN 'ENABLE REPLICA' WHEN 'A' THEN 'ENABLE ALWAYS' ELSE NULL END;
   IF v_command IS NULL THEN RAISE EXCEPTION 'Estado de trigger não reconhecido.';END IF;
   EXECUTE format('ALTER TABLE %s %s TRIGGER %I',v_record.relation_oid::regclass,v_command,v_trigger.key);
  END LOOP;
 END LOOP;
 FOR v_state IN EXECUTE format('SELECT relation_name FROM %I._states',v_run.backup_schema) LOOP
  EXECUTE format('UPDATE %s SET revision=revision+1',v_state.relation_name::regclass);
 END LOOP;
 UPDATE cf_operations.base_resets SET restored_at=clock_timestamp() WHERE operation_key=v_operation;
 INSERT INTO public.audit_events(username,module,entity,record_id,action,after_value)
 VALUES(current_user,'contas_pagar','payable_base_reset',v_operation,'REOPEN',jsonb_build_object('backup_schema',v_run.backup_schema,'restored_rows',v_total,'tables_restored',v_tables,'sql_owner',current_user));
 INSERT INTO _cf_payable_restore_result VALUES('CONTAS_PAGAR_RESTAURADO',v_operation,v_run.backup_schema,v_tables,v_total);
END $restore$;
COMMIT;
SELECT * FROM pg_temp._cf_payable_restore_result;
