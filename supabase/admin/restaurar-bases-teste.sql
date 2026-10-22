-- CENTRAL FINANCEIRA: recuperar a cópia da limpeza inicial, ANTES de novas importações.
-- Executar só se a limpeza tiver sido indevida e as bases operacionais ainda estiverem vazias.
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
 IF to_regclass('cf_operations.base_resets') IS NULL THEN RAISE EXCEPTION 'Não existe uma cópia registrada da limpeza inicial.' USING ERRCODE='22023';END IF;
END $owner$;
DROP TABLE IF EXISTS pg_temp._cf_base_restore_result;
CREATE TEMP TABLE _cf_base_restore_result(status text,operation_key text,backup_schema text,tables_restored integer,restored_rows bigint);
DO $restore$
DECLARE
 v_operation constant text:='preparacao-base-oficial-2026-10-22-v1';
 v_run cf_operations.base_resets%ROWTYPE;v_record record;v_trigger record;v_state record;
 v_all text;v_count bigint;v_total bigint:=0;v_tables integer:=0;v_columns text;v_signature jsonb;v_triggers jsonb;v_command text;v_hash text;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(2045812301);
 SELECT * INTO v_run FROM cf_operations.base_resets WHERE operation_key=v_operation FOR UPDATE;
 IF NOT FOUND OR v_run.format_version<>'base-reset-v1' THEN RAISE EXCEPTION 'A cópia desta operação não foi identificada.' USING ERRCODE='22023';END IF;
 IF v_run.restored_at IS NOT NULL THEN
  INSERT INTO _cf_base_restore_result VALUES('JA_RESTAURADO',v_operation,v_run.backup_schema,0,0);RETURN;
 END IF;
 IF v_run.backup_schema !~ '^cf_base_backup_[0-9a-f]{32}$' OR to_regnamespace(v_run.backup_schema) IS NULL THEN
  RAISE EXCEPTION 'O arquivo privado da cópia não está disponível.' USING ERRCODE='22023';END IF;
 EXECUTE format('SELECT string_agg(relation_oid::regclass::text,'', '' ORDER BY relation_name) FROM %I._tables',v_run.backup_schema) INTO v_all;
 IF v_all IS NULL THEN RAISE EXCEPTION 'A cópia não contém um manifesto de tabelas válido.' USING ERRCODE='22023';END IF;
 EXECUTE 'LOCK TABLE '||v_all||' IN ACCESS EXCLUSIVE MODE';
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
 VALUES(current_user,'administracao','base_reset',v_operation,'REOPEN',jsonb_build_object('backup_schema',v_run.backup_schema,'restored_rows',v_total,'tables_restored',v_tables,'sql_owner',current_user));
 INSERT INTO _cf_base_restore_result VALUES('BASES_RESTAURADAS',v_operation,v_run.backup_schema,v_tables,v_total);
END $restore$;
COMMIT;
SELECT * FROM pg_temp._cf_base_restore_result;
