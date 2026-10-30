-- CENTRAL FINANCEIRA: reinício autorizado SOMENTE de Contas a Pagar, em 30/10/2026.
-- Executar apenas no SQL Editor do projeto sjimddcqgrsauzvffcol, como postgres.
-- Não é migration, função Edge ou tarefa de publicação. Não executa pelo aplicativo.
-- Guarda uma cópia privada das 21 tabelas operacionais de CP, incluindo arquivos e históricos.
-- Preserva Contas a Receber, Cobrança, Comissões, Caixa/Bancos, usuários e configurações.
-- A operação cp-restart-2026-10-30-v1 só limpa UMA vez. Reexecutar não apaga a nova base.
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
DROP TABLE IF EXISTS pg_temp._cf_payable_reset_result;
CREATE TEMP TABLE _cf_payable_reset_result(status text,operation_key text,backup_schema text,tables_reset integer,removed_rows bigint,remaining_rows bigint);
DO $reset$
DECLARE
 v_operation constant text := 'cp-restart-2026-10-30-v1';
 v_targets text[] := ARRAY[
  'public.payable_imports',
  'public.payable_titles',
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
  'public.payable_administrative_writeoffs',
  'cf_private.payable_import_files',
  'cf_private.payable_identity_registry',
  'cf_private.payable_import_resolution_requests',
  'cf_private.payable_daily_reports',
  'cf_private.payable_daily_requests',
  'cf_private.payable_daily_actions'
 ];
 v_preserved text[] := ARRAY[
  'public.payable_macros',
  'public.payable_plan_mappings',
  'public.payable_forecast_rules',
  'public.payable_forecast_plan_bindings',
  'public.payable_paid_bank_mappings',
  'cf_private.payable_paid_bank_aliases',
  'cf_private.payable_payment_state',
  'cf_private.payable_control_state'
 ];
 v_states text[] := ARRAY[
  'cf_private.payable_payment_state',
  'cf_private.payable_control_state'
 ];
 v_name text;v_backup text;v_existing cf_operations.base_resets%ROWTYPE;v_record record;v_parent record;
 v_all text;v_unknown text;v_count bigint;v_copy bigint;v_total bigint:=0;v_remaining bigint:=0;
 v_order integer:=0;v_columns text;v_signature jsonb;v_triggers jsonb;v_counts jsonb:='{}';v_hash text;v_copy_hash text;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(2045812301);
 PERFORM pg_catalog.pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 PERFORM pg_catalog.pg_advisory_xact_lock(2045812309);
 SELECT * INTO v_existing FROM cf_operations.base_resets WHERE operation_key=v_operation;
 IF FOUND THEN
  IF v_existing.format_version<>'payable-reset-v1' OR v_existing.backup_schema!~'^cf_payable_backup_[0-9a-f]{32}$' THEN
   RAISE EXCEPTION 'O registro do reinício de Contas a Pagar não corresponde a esta operação.' USING ERRCODE='22023';END IF;
  FOR v_record IN EXECUTE format('SELECT relation_name FROM %I._tables ORDER BY restore_order',v_existing.backup_schema) LOOP
   IF to_regclass(v_record.relation_name) IS NULL THEN RAISE EXCEPTION 'Uma tabela do registro da operação não está mais disponível.' USING ERRCODE='22023';END IF;
   EXECUTE format('SELECT count(*) FROM %s',v_record.relation_name::regclass) INTO v_count;v_remaining:=v_remaining+v_count;
  END LOOP;
  INSERT INTO _cf_payable_reset_result VALUES(CASE WHEN v_existing.restored_at IS NULL THEN 'JA_EXECUTADO' ELSE 'JA_RESTAURADO' END,v_operation,v_existing.backup_schema,0,0,v_remaining);
  RETURN;
 END IF;
 IF to_regclass('public.profiles') IS NULL OR to_regclass('public.audit_events') IS NULL OR to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'A estrutura da Central Financeira não foi identificada. Nenhum dado foi limpo.' USING ERRCODE='22023';
 END IF;
 -- Recusa novas tabelas de CP não classificadas; outras áreas ficam fora desta limpeza.
 SELECT string_agg(format('%I.%I',n.nspname,c.relname),', ' ORDER BY n.nspname,c.relname) INTO v_unknown
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','cf_private') AND c.relkind IN('r','p')
 AND c.relname~'^payables?_'
 AND NOT(format('%I.%I',n.nspname,c.relname)=ANY(v_targets||v_preserved))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e');
 IF v_unknown IS NOT NULL THEN RAISE EXCEPTION 'Existem tabelas não classificadas para esta limpeza: %. Nenhum dado foi limpo.',v_unknown USING ERRCODE='22023';END IF;
 CREATE TEMP TABLE _cf_payable_reset_scope(relation_name text PRIMARY KEY,relation_oid oid UNIQUE NOT NULL,restore_order integer,backup_table name) ON COMMIT DROP;
 FOREACH v_name IN ARRAY v_targets LOOP
  IF to_regclass(v_name) IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=to_regclass(v_name) AND relkind='r') THEN
    RAISE EXCEPTION 'A origem % não é uma tabela comum suportada.',v_name USING ERRCODE='22023';END IF;
   INSERT INTO _cf_payable_reset_scope VALUES(v_name,to_regclass(v_name),NULL,NULL);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM _cf_payable_reset_scope WHERE relation_name='public.payable_titles') OR NOT EXISTS(SELECT 1 FROM _cf_payable_reset_scope WHERE relation_name='public.payable_imports') THEN
  RAISE EXCEPTION 'As bases de títulos e importações de Contas a Pagar não foram identificadas. Nenhum dado foi limpo.' USING ERRCODE='22023';END IF;
 SELECT string_agg(relation_oid::regclass::text,', ' ORDER BY relation_name) INTO v_all FROM _cf_payable_reset_scope;
 EXECUTE 'LOCK TABLE '||v_all||' IN ACCESS EXCLUSIVE MODE';
 -- Nenhum CASCADE: uma dependência fora da lista interrompe a operação inteira.
 SELECT string_agg(conrelid::regclass::text,', ') INTO v_unknown FROM pg_catalog.pg_constraint
 WHERE contype='f' AND confrelid IN(SELECT relation_oid FROM _cf_payable_reset_scope) AND conrelid NOT IN(SELECT relation_oid FROM _cf_payable_reset_scope);
 IF v_unknown IS NOT NULL THEN RAISE EXCEPTION 'Dependências fora do escopo da limpeza: %. Nenhum dado foi limpo.',v_unknown USING ERRCODE='22023';END IF;
 -- Ordem de restauração por FKs; referências a si mesmas são validadas por INSERT de tabela completa.
 WHILE EXISTS(SELECT 1 FROM _cf_payable_reset_scope WHERE restore_order IS NULL) LOOP
  SELECT s.* INTO v_record FROM _cf_payable_reset_scope s WHERE s.restore_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_catalog.pg_constraint f JOIN _cf_payable_reset_scope p ON p.relation_oid=f.confrelid
   WHERE f.contype='f' AND f.conrelid=s.relation_oid AND f.confrelid<>f.conrelid AND NOT f.condeferrable AND p.restore_order IS NULL)
  ORDER BY s.relation_name LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Foi encontrada uma dependência circular sem restauração segura. Nenhum dado foi limpo.' USING ERRCODE='22023';END IF;
  v_order:=v_order+1;UPDATE _cf_payable_reset_scope SET restore_order=v_order,backup_table=('b_'||lpad(v_order::text,4,'0'))::name WHERE relation_oid=v_record.relation_oid;
 END LOOP;
 v_backup:='cf_payable_backup_'||replace(gen_random_uuid()::text,'-','');
 EXECUTE format('CREATE SCHEMA %I',v_backup);
 EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',v_backup);
 EXECUTE format('CREATE TABLE %I._tables(relation_name text PRIMARY KEY,relation_oid oid NOT NULL,backup_table name NOT NULL UNIQUE,row_count bigint NOT NULL,restore_order integer NOT NULL UNIQUE,column_list text NOT NULL,column_signature jsonb NOT NULL,trigger_states jsonb NOT NULL,content_sha256 text NOT NULL CHECK(content_sha256~''^[0-9a-f]{64}$''))',v_backup);
 EXECUTE format('CREATE TABLE %I._states(relation_name text PRIMARY KEY,previous_rows jsonb NOT NULL,content_sha256 text NOT NULL CHECK(content_sha256~''^[0-9a-f]{64}$''))',v_backup);
 FOR v_record IN SELECT * FROM _cf_payable_reset_scope ORDER BY restore_order LOOP
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
   EXECUTE format('INSERT INTO %I._states SELECT $1,rows,encode(sha256(convert_to(rows::text,''UTF8'')),''hex'') FROM(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY to_jsonb(s)::text),''[]'') rows FROM %s s)q',v_backup,v_name::regclass) USING v_name;
  END IF;
 END LOOP;
 EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',v_backup);
 EXECUTE 'TRUNCATE TABLE '||v_all||' CONTINUE IDENTITY RESTRICT';
 FOREACH v_name IN ARRAY v_states LOOP
  IF to_regclass(v_name) IS NOT NULL THEN EXECUTE format('UPDATE %s SET revision=revision+1',v_name::regclass);END IF;
 END LOOP;
 FOR v_record IN SELECT * FROM _cf_payable_reset_scope LOOP
  EXECUTE format('SELECT count(*) FROM %s',v_record.relation_oid::regclass) INTO v_count;v_remaining:=v_remaining+v_count;
 END LOOP;
 IF v_remaining<>0 THEN RAISE EXCEPTION 'A conferência final da limpeza falhou. A operação será desfeita.';END IF;
 INSERT INTO cf_operations.base_resets(operation_key,backup_schema,format_version,completed_at,removed_rows,counts,actor_sql_role)
 VALUES(v_operation,v_backup,'payable-reset-v1',clock_timestamp(),v_total,v_counts,current_user);
 INSERT INTO public.audit_events(username,module,entity,record_id,action,before_value,after_value)
 VALUES(current_user,'contas_pagar','payable_base_reset',v_operation,'DELETE',jsonb_build_object('counts',v_counts),
  jsonb_build_object('backup_schema',v_backup,'removed_rows',v_total,'remaining_rows',0,'tables_reset',v_order,'sql_owner',current_user));
 INSERT INTO _cf_payable_reset_result VALUES('CONTAS_PAGAR_ZERADO',v_operation,v_backup,v_order,v_total,0);
END $reset$;
COMMIT;
SELECT * FROM pg_temp._cf_payable_reset_result;
