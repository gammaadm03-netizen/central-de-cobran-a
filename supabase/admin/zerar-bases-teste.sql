-- CENTRAL FINANCEIRA: limpeza administrativa autorizada antes da base oficial.
-- Executar apenas no SQL Editor do projeto sjimddcqgrsauzvffcol, como postgres.
-- Não é migration, função Edge ou tarefa de publicação. Não executa pelo aplicativo.
-- Guarda uma cópia privada de todas as linhas e arquivos antes de limpar.
-- A mesma operação só limpa UMA vez. Reexecutar não apaga importações oficiais novas.
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
END $owner$;
CREATE SCHEMA IF NOT EXISTS cf_operations;
REVOKE ALL ON SCHEMA cf_operations FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE IF NOT EXISTS cf_operations.base_resets(
 operation_key text PRIMARY KEY,backup_schema text UNIQUE NOT NULL,format_version text NOT NULL DEFAULT 'base-reset-v1',
 completed_at timestamptz NOT NULL,restored_at timestamptz,removed_rows bigint NOT NULL,counts jsonb NOT NULL,
 actor_sql_role text NOT NULL
);
ALTER TABLE cf_operations.base_resets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_operations.base_resets FROM PUBLIC,anon,authenticated,service_role;
DROP TABLE IF EXISTS pg_temp._cf_base_reset_result;
CREATE TEMP TABLE _cf_base_reset_result(status text,operation_key text,backup_schema text,tables_reset integer,removed_rows bigint,remaining_rows bigint);
DO $reset$
DECLARE
 v_operation constant text := 'preparacao-base-oficial-2026-10-22-v1';
 v_targets text[] := ARRAY[
  'public.payable_imports',
  'public.payable_titles',
  'public.bank_balance_positions',
  'public.stock_positions',
  'public.director_positions',
  'public.receivable_imports',
  'public.receivable_titles',
  'public.receivable_collection_events',
  'public.receivable_receipts',
  'public.bank_support_files',
  'public.director_report_inputs',
  'public.payable_forecast_completions',
  'public.payable_payments',
  'public.payable_payment_reversals',
  'public.payable_title_control_revisions',
  'public.payable_title_reviews',
  'public.payable_title_corrections',
  'public.payable_title_macro_overrides',
  'public.payable_payment_reclassifications',
  'public.payable_month_closures',
  'public.payable_month_events',
  'public.payable_import_modes',
  'public.payable_paid_import_rows',
  'public.receivable_sync_imports',
  'public.receivable_receipt_import_provenance',
  'public.receivable_receipt_adjustments',
  'public.receivable_received_import_rows',
  'public.collection_cases',
  'public.collection_case_events',
  'public.collection_work_sessions',
  'public.collection_work_requests',
  'public.collection_customer_contacts',
  'public.collection_contact_events',
  'public.collection_description_references',
  'public.commercial_imports',
  'public.commercial_items',
  'public.commission_assessments',
  'public.payable_administrative_writeoffs',
  'public.product_cost_imports',
  'public.product_cost_items',
  'public.product_cost_recalculations',
  'public.product_cost_recalculation_items',
  'public.receivable_report_retirement_events',
  'cf_private.payable_import_files',
  'cf_private.receivable_import_files',
  'cf_private.bank_support_bytes',
  'cf_private.payable_identity_registry',
  'cf_private.receivable_parcel_aliases',
  'cf_private.collection_contact_requests',
  'cf_private.collection_reference_jobs',
  'cf_private.collection_reference_chunks',
  'cf_private.collection_reference_rows',
  'cf_private.collection_reference_publish_requests',
  'cf_private.commercial_import_files',
  'cf_private.hr_imports',
  'cf_private.payable_import_resolution_requests',
  'cf_private.product_cost_import_files',
  'cf_private.product_cost_import_rows',
  'cf_private.receivable_open_report_requests',
  'cf_private.receivable_financial_validation_requests',
  'public.receivable_receipt_reversals',
  'cf_private.receivable_active_receipts',
  'cf_private.receivable_return_approvals',
  'cf_private.receivable_return_consumptions',
  'cf_private.payable_daily_reports',
  'cf_private.payable_daily_requests',
  'cf_private.payable_daily_actions'
 ];
 v_preserved text[] := ARRAY[
  'public.profiles',
  'public.role_permissions',
  'public.collection_agents',
  'public.collector_bindings',
  'public.management_messages',
  'public.audit_events',
  'public.payable_macros',
  'public.payable_plan_mappings',
  'public.bank_accounts',
  'public.central_schema_migrations',
  'public.payable_forecast_rules',
  'public.payable_forecast_plan_bindings',
  'public.payable_paid_bank_mappings',
  'public.commission_rule_versions',
  'cf_private.payable_paid_bank_aliases',
  'cf_private.login_buckets',
  'cf_private.login_attempts',
  'cf_private.revoked_sessions',
  'cf_private.approved_sessions',
  'cf_private.password_change_buckets',
  'cf_private.password_change_attempts',
  'cf_private.user_access_limits',
  'cf_private.user_import_access',
  'cf_private.payable_payment_state',
  'cf_private.payable_control_state',
  'cf_private.receivables_sync_state',
  'cf_private.collection_workbench_state',
  'cf_private.collection_context_state'
 ];
 v_states text[] := ARRAY[
  'cf_private.payable_payment_state',
  'cf_private.payable_control_state',
  'cf_private.receivables_sync_state',
  'cf_private.collection_workbench_state',
  'cf_private.collection_context_state'
 ];
 v_name text;v_backup text;v_existing cf_operations.base_resets%ROWTYPE;v_record record;v_parent record;
 v_all text;v_unknown text;v_count bigint;v_copy bigint;v_total bigint:=0;v_remaining bigint:=0;
 v_order integer:=0;v_columns text;v_signature jsonb;v_triggers jsonb;v_counts jsonb:='{}';v_hash text;v_copy_hash text;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(2045812301);
 SELECT * INTO v_existing FROM cf_operations.base_resets WHERE operation_key=v_operation;
 IF FOUND THEN
  FOR v_record IN EXECUTE format('SELECT relation_name FROM %I._tables ORDER BY restore_order',v_existing.backup_schema) LOOP
   IF to_regclass(v_record.relation_name) IS NULL THEN RAISE EXCEPTION 'Uma tabela do registro da operação não está mais disponível.' USING ERRCODE='22023';END IF;
   EXECUTE format('SELECT count(*) FROM %s',v_record.relation_name::regclass) INTO v_count;v_remaining:=v_remaining+v_count;
  END LOOP;
  INSERT INTO _cf_base_reset_result VALUES(CASE WHEN v_existing.restored_at IS NULL THEN 'JA_EXECUTADO' ELSE 'JA_RESTAURADO' END,v_operation,v_existing.backup_schema,0,0,v_remaining);
  RETURN;
 END IF;
 IF to_regclass('public.profiles') IS NULL OR to_regclass('public.audit_events') IS NULL OR to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'A estrutura da Central Financeira não foi identificada. Nenhum dado foi limpo.' USING ERRCODE='22023';
 END IF;
 -- Recusa novas tabelas não classificadas em vez de deixá-las fora da limpeza silenciosamente.
 SELECT string_agg(format('%I.%I',n.nspname,c.relname),', ' ORDER BY n.nspname,c.relname) INTO v_unknown
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','cf_private') AND c.relkind IN('r','p')
 AND NOT(format('%I.%I',n.nspname,c.relname)=ANY(v_targets||v_preserved))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e');
 IF v_unknown IS NOT NULL THEN RAISE EXCEPTION 'Existem tabelas não classificadas para esta limpeza: %. Nenhum dado foi limpo.',v_unknown USING ERRCODE='22023';END IF;
 CREATE TEMP TABLE _cf_reset_scope(relation_name text PRIMARY KEY,relation_oid oid UNIQUE NOT NULL,restore_order integer,backup_table name) ON COMMIT DROP;
 FOREACH v_name IN ARRAY v_targets LOOP
  IF to_regclass(v_name) IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=to_regclass(v_name) AND relkind='r') THEN
    RAISE EXCEPTION 'A origem % não é uma tabela comum suportada.',v_name USING ERRCODE='22023';END IF;
   INSERT INTO _cf_reset_scope VALUES(v_name,to_regclass(v_name),NULL,NULL);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM _cf_reset_scope WHERE relation_name='public.payable_titles') OR NOT EXISTS(SELECT 1 FROM _cf_reset_scope WHERE relation_name='public.receivable_titles') THEN
  RAISE EXCEPTION 'As bases de CP e CR não foram identificadas. Nenhum dado foi limpo.' USING ERRCODE='22023';END IF;
 SELECT string_agg(relation_oid::regclass::text,', ' ORDER BY relation_name) INTO v_all FROM _cf_reset_scope;
 EXECUTE 'LOCK TABLE '||v_all||' IN ACCESS EXCLUSIVE MODE';
 -- Nenhum CASCADE: uma dependência fora da lista interrompe a operação inteira.
 SELECT string_agg(conrelid::regclass::text,', ') INTO v_unknown FROM pg_catalog.pg_constraint
 WHERE contype='f' AND confrelid IN(SELECT relation_oid FROM _cf_reset_scope) AND conrelid NOT IN(SELECT relation_oid FROM _cf_reset_scope);
 IF v_unknown IS NOT NULL THEN RAISE EXCEPTION 'Dependências fora do escopo da limpeza: %. Nenhum dado foi limpo.',v_unknown USING ERRCODE='22023';END IF;
 -- Ordem de restauração por FKs; referências a si mesmas são validadas por INSERT de tabela completa.
 WHILE EXISTS(SELECT 1 FROM _cf_reset_scope WHERE restore_order IS NULL) LOOP
  SELECT s.* INTO v_record FROM _cf_reset_scope s WHERE s.restore_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_catalog.pg_constraint f JOIN _cf_reset_scope p ON p.relation_oid=f.confrelid
   WHERE f.contype='f' AND f.conrelid=s.relation_oid AND f.confrelid<>f.conrelid AND NOT f.condeferrable AND p.restore_order IS NULL)
  ORDER BY s.relation_name LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Foi encontrada uma dependência circular sem restauração segura. Nenhum dado foi limpo.' USING ERRCODE='22023';END IF;
  v_order:=v_order+1;UPDATE _cf_reset_scope SET restore_order=v_order,backup_table=('b_'||lpad(v_order::text,4,'0'))::name WHERE relation_oid=v_record.relation_oid;
 END LOOP;
 v_backup:='cf_base_backup_'||replace(gen_random_uuid()::text,'-','');
 EXECUTE format('CREATE SCHEMA %I',v_backup);
 EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',v_backup);
 EXECUTE format('CREATE TABLE %I._tables(relation_name text PRIMARY KEY,relation_oid oid NOT NULL,backup_table name NOT NULL UNIQUE,row_count bigint NOT NULL,restore_order integer NOT NULL UNIQUE,column_list text NOT NULL,column_signature jsonb NOT NULL,trigger_states jsonb NOT NULL,content_sha256 text NOT NULL CHECK(content_sha256~''^[0-9a-f]{64}$''))',v_backup);
 EXECUTE format('CREATE TABLE %I._states(relation_name text PRIMARY KEY,previous_rows jsonb NOT NULL)',v_backup);
 FOR v_record IN SELECT * FROM _cf_reset_scope ORDER BY restore_order LOOP
  SELECT string_agg(format('%I',attname),', ' ORDER BY attnum) FILTER(WHERE attgenerated=''),
   jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attnotnull,attgenerated,attidentity) ORDER BY attnum)
  INTO v_columns,v_signature FROM pg_catalog.pg_attribute WHERE attrelid=v_record.relation_oid AND attnum>0 AND NOT attisdropped;
  SELECT coalesce(jsonb_object_agg(tgname,tgenabled),'{}'::jsonb) INTO v_triggers FROM pg_catalog.pg_trigger WHERE tgrelid=v_record.relation_oid AND NOT tgisinternal;
  EXECUTE format('CREATE TABLE %I.%I AS TABLE %s',v_backup,v_record.backup_table,v_record.relation_oid::regclass);
  EXECUTE format('SELECT count(*) FROM %s',v_record.relation_oid::regclass) INTO v_count;
  EXECUTE format('SELECT count(*) FROM %I.%I',v_backup,v_record.backup_table) INTO v_copy;
  IF v_copy<>v_count THEN RAISE EXCEPTION 'A cópia de % não foi conferida. Nenhum dado foi limpo.',v_record.relation_name;END IF;
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(string_agg(h,'''' ORDER BY h),''''),''UTF8'')),''hex'') FROM(SELECT encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex'') h FROM %s t)s',v_record.relation_oid::regclass) INTO v_hash;
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(string_agg(h,'''' ORDER BY h),''''),''UTF8'')),''hex'') FROM(SELECT encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex'') h FROM %I.%I t)s',v_backup,v_record.backup_table) INTO v_copy_hash;
  IF v_hash IS DISTINCT FROM v_copy_hash THEN RAISE EXCEPTION 'O conteúdo da cópia de % não foi conferido. Nenhum dado foi limpo.',v_record.relation_name;END IF;
  EXECUTE format('INSERT INTO %I._tables VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',v_backup)
   USING v_record.relation_name,v_record.relation_oid,v_record.backup_table,v_count,v_record.restore_order,v_columns,v_signature,v_triggers,v_hash;
  v_total:=v_total+v_count;v_counts:=v_counts||jsonb_build_object(v_record.relation_name,v_count);
 END LOOP;
 FOREACH v_name IN ARRAY v_states LOOP
  IF to_regclass(v_name) IS NOT NULL THEN
   EXECUTE format('INSERT INTO %I._states SELECT $1,coalesce(jsonb_agg(to_jsonb(s)),''[]'') FROM %s s',v_backup,v_name::regclass) USING v_name;
  END IF;
 END LOOP;
 EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',v_backup);
 EXECUTE 'TRUNCATE TABLE '||v_all||' CONTINUE IDENTITY RESTRICT';
 FOREACH v_name IN ARRAY v_states LOOP
  IF to_regclass(v_name) IS NOT NULL THEN EXECUTE format('UPDATE %s SET revision=revision+1',v_name::regclass);END IF;
 END LOOP;
 FOR v_record IN SELECT * FROM _cf_reset_scope LOOP
  EXECUTE format('SELECT count(*) FROM %s',v_record.relation_oid::regclass) INTO v_count;v_remaining:=v_remaining+v_count;
 END LOOP;
 IF v_remaining<>0 THEN RAISE EXCEPTION 'A conferência final da limpeza falhou. A operação será desfeita.';END IF;
 INSERT INTO cf_operations.base_resets(operation_key,backup_schema,completed_at,removed_rows,counts,actor_sql_role)
 VALUES(v_operation,v_backup,clock_timestamp(),v_total,v_counts,current_user);
 INSERT INTO public.audit_events(username,module,entity,record_id,action,before_value,after_value)
 VALUES(current_user,'administracao','base_reset',v_operation,'DELETE',jsonb_build_object('counts',v_counts),
  jsonb_build_object('backup_schema',v_backup,'removed_rows',v_total,'remaining_rows',0,'tables_reset',v_order,'sql_owner',current_user));
 INSERT INTO _cf_base_reset_result VALUES('BASES_LIMPAS',v_operation,v_backup,v_order,v_total,0);
END $reset$;
COMMIT;
SELECT * FROM pg_temp._cf_base_reset_result;
