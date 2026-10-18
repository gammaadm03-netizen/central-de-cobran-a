-- Sincronização incremental de parcelas sem inferir recebimento por ausência.
-- A identidade não contém valor. Mudança de vencimento exige vínculo explícito.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.receivable_receipts') IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='009_collections') THEN
  RAISE EXCEPTION 'Ative as atualizações 008 e 009 antes da sincronização de recebíveis.' USING ERRCODE='22023';
 END IF;
END $$;

ALTER TABLE public.receivable_imports ADD COLUMN import_mode text NOT NULL DEFAULT 'LEGACY'
 CHECK(import_mode IN ('LEGACY','OPEN','RECEIVED'));
ALTER TABLE public.receivable_imports DROP CONSTRAINT receivable_imports_scope_file_sha256_key;
ALTER TABLE public.receivable_imports ADD CONSTRAINT receivable_imports_scope_hash_mode UNIQUE(scope,file_sha256,import_mode);
CREATE TABLE cf_private.receivable_parcel_aliases(
 scope text NOT NULL CHECK(scope='grupo-consolidado'),source_key text NOT NULL,
 title_id uuid NOT NULL REFERENCES public.receivable_titles(id) ON DELETE RESTRICT,
 created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope,source_key)
);
CREATE INDEX receivable_parcel_alias_title ON cf_private.receivable_parcel_aliases(title_id);
CREATE INDEX receivable_sync_identity_lookup ON public.receivable_titles
 (scope,upper(cf_private.normalize_receivable_text(branch)),upper(cf_private.normalize_receivable_text(document)),customer_key,due_date);
CREATE TABLE cf_private.receivables_sync_state(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO cf_private.receivables_sync_state(singleton) VALUES(true);
CREATE TABLE public.receivable_sync_imports(
 import_id uuid PRIMARY KEY REFERENCES public.receivable_imports(id) ON DELETE RESTRICT,
 mode text NOT NULL CHECK(mode IN ('OPEN','RECEIVED')),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE cf_private.receivable_parcel_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.receivables_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_sync_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.receivable_parcel_aliases,cf_private.receivables_sync_state,public.receivable_sync_imports
 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.receivable_sync_imports TO authenticated;
CREATE POLICY receivable_sync_imports_read ON public.receivable_sync_imports FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read'));
CREATE TRIGGER receivable_parcel_aliases_immutable BEFORE UPDATE OR DELETE ON cf_private.receivable_parcel_aliases
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER receivable_sync_imports_immutable BEFORE UPDATE OR DELETE ON public.receivable_sync_imports
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();

CREATE FUNCTION cf_private.bump_receivables_sync_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 UPDATE cf_private.receivables_sync_state SET revision=revision+1 WHERE singleton;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER receivable_titles_sync_revision AFTER INSERT OR UPDATE OR DELETE ON public.receivable_titles
 FOR EACH ROW EXECUTE FUNCTION cf_private.bump_receivables_sync_revision();
CREATE TRIGGER receivable_receipts_sync_revision AFTER INSERT OR UPDATE OR DELETE ON public.receivable_receipts
 FOR EACH ROW EXECUTE FUNCTION cf_private.bump_receivables_sync_revision();
CREATE TRIGGER receivable_alias_sync_revision AFTER INSERT ON cf_private.receivable_parcel_aliases
 FOR EACH ROW EXECUTE FUNCTION cf_private.bump_receivables_sync_revision();
CREATE TRIGGER receivable_provenance_sync_revision AFTER INSERT ON public.receivable_sync_imports
 FOR EACH ROW EXECUTE FUNCTION cf_private.bump_receivables_sync_revision();
CREATE FUNCTION cf_private.receivables_sync_revision_value() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT revision::text FROM cf_private.receivables_sync_state WHERE singleton;
$$;
CREATE FUNCTION cf_private.audit_receivable_sync_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_actor public.profiles%ROWTYPE;BEGIN
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_receber',TG_TABLE_NAME,
  coalesce(to_jsonb(NEW)->>'import_id',to_jsonb(NEW)->>'title_id'),'IMPORT',to_jsonb(NEW));RETURN NEW;
END $$;
CREATE TRIGGER receivable_alias_audit AFTER INSERT ON cf_private.receivable_parcel_aliases
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_receivable_sync_change();
CREATE TRIGGER receivable_sync_import_audit AFTER INSERT ON public.receivable_sync_imports
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_receivable_sync_change();

CREATE FUNCTION public.get_receivables_sync_revision() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_id uuid;BEGIN
 IF NOT cf_private.has_permission('contas_receber','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT id INTO v_id FROM public.receivable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN jsonb_build_object('import_id',v_id,'financial_revision',cf_private.receivables_sync_revision_value());
END $$;
CREATE FUNCTION public.receivables_import_capabilities() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM cf_private.require_receivable_finance('import');
 RETURN jsonb_build_object('schema_version','023_receivable_sync','open_sync',true,'received_import',false);
END $$;

CREATE FUNCTION cf_private.receivable_sync_group_key(p_branch text,p_document text,p_customer_key text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT jsonb_build_array(upper(cf_private.normalize_receivable_text(p_branch)),upper(cf_private.normalize_receivable_text(p_document)),p_customer_key)::text;
$$;
CREATE FUNCTION cf_private.receivable_sync_parcel_key(p_branch text,p_document text,p_customer_key text,p_due_date date) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT jsonb_build_array(upper(cf_private.normalize_receivable_text(p_branch)),upper(cf_private.normalize_receivable_text(p_document)),p_customer_key,p_due_date)::text;
$$;
CREATE FUNCTION cf_private.normalize_receivable_sync_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_rows jsonb;v_result jsonb;BEGIN
 v_rows:=cf_private.validate_receivable_rows(p_scope,p_rows);
 -- CNPJ não é inferido a partir do nome, mesmo quando o valor mudou no ERP.
 PERFORM cf_private.check_receivable_identity(p_scope,v_rows);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r JOIN public.receivable_titles t
  ON t.scope=p_scope AND upper(cf_private.normalize_receivable_text(t.branch))=upper(r->>'branch')
   AND upper(cf_private.normalize_receivable_text(t.document))=upper(r->>'document')
   AND cf_private.receivable_customer_key(t.client_name,NULL)=cf_private.receivable_customer_key(r->>'client_name',NULL)
   AND t.customer_key<>r->>'customer_key'
  WHERE t.client_document IS NULL OR r->>'client_document' IS NULL OR t.due_date=(r->>'due_date')::date) THEN
  RAISE EXCEPTION 'Identificação do cliente mudou. Confira o CNPJ antes de vincular ou criar parcelas.' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r
  GROUP BY upper(r->>'branch'),upper(r->>'document'),cf_private.receivable_customer_key(r->>'client_name',NULL)
  HAVING count(DISTINCT r->>'customer_key')>1 AND count(*) FILTER(WHERE r->>'client_document' IS NULL)>0) THEN
  RAISE EXCEPTION 'Cliente identificado de formas incompatíveis no mesmo arquivo. Confira o CNPJ.' USING ERRCODE='23514';
 END IF;
 SELECT jsonb_agg(r||jsonb_build_object('line',n,'legacy_source_key',r->>'source_key',
  'group_key',cf_private.receivable_sync_group_key(r->>'branch',r->>'document',r->>'customer_key'),
  'source_key',cf_private.receivable_sync_parcel_key(r->>'branch',r->>'document',r->>'customer_key',(r->>'due_date')::date)) ORDER BY n)
 INTO v_result FROM jsonb_array_elements(v_rows) WITH ORDINALITY x(r,n);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_result) r GROUP BY r->>'source_key' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Há parcelas com a mesma filial, cliente, documento e vencimento. Não é possível diferenciá-las com segurança.' USING ERRCODE='23505';
 END IF;
 RETURN v_result;
END $$;

CREATE FUNCTION cf_private.resolve_receivable_sync_rows(p_scope text,p_rows jsonb,
 p_title_mappings jsonb DEFAULT '{}'::jsonb,p_mode text DEFAULT 'open') RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_result jsonb[]:=ARRAY[]::jsonb[];v_mapping jsonb;v_title public.receivable_titles%ROWTYPE;
 v_alias uuid;v_id uuid;v_outcome text;v_problem text;v_candidates jsonb;v_exact integer;v_group_count integer;v_changed boolean;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('open','received') OR p_scope IS DISTINCT FROM 'grupo-consolidado'
  OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000
  OR p_title_mappings IS NULL OR jsonb_typeof(p_title_mappings)<>'object' OR octet_length(p_title_mappings::text)>500000 THEN
  RAISE EXCEPTION 'Informe as parcelas e os vínculos da análise.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_title_mappings) m WHERE m.key !~ '^[1-9][0-9]{0,3}$'
  OR (m.key::integer)>jsonb_array_length(p_rows) OR jsonb_typeof(m.value)<>'string'
  OR (m.value#>>'{}'<>'NEW' AND m.value#>>'{}' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')) THEN
  RAISE EXCEPTION 'Vínculo de parcela inválido. Use o número da linha e um título existente ou NEW.' USING ERRCODE='22023';END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  v_id:=NULL;v_alias:=NULL;v_problem:=NULL;v_outcome:='NEW';v_changed:=false;v_title:=NULL;
  SELECT title_id INTO v_alias FROM cf_private.receivable_parcel_aliases WHERE scope=p_scope AND source_key=v_row->>'source_key';
  SELECT count(*),count(*) FILTER(WHERE t.due_date=(v_row->>'due_date')::date) INTO v_group_count,v_exact
  FROM public.receivable_titles t WHERE t.scope=p_scope
   AND cf_private.receivable_sync_group_key(t.branch,t.document,t.customer_key)=v_row->>'group_key';
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'due_date',t.due_date,'amount_cents',t.amount_cents,
   'status',t.status,'collector_id',t.collector_id) ORDER BY t.due_date,t.id),'[]'::jsonb) INTO v_candidates
  FROM (SELECT t.* FROM public.receivable_titles t WHERE t.scope=p_scope
   AND cf_private.receivable_sync_group_key(t.branch,t.document,t.customer_key)=v_row->>'group_key'
   ORDER BY t.due_date,t.id LIMIT 100) t;
  v_mapping:=p_title_mappings->(v_row->>'line');
  IF v_mapping IS NOT NULL THEN
   IF v_mapping#>>'{}'='NEW' THEN
    IF v_alias IS NOT NULL OR v_exact>0 THEN
     v_problem:='Já existe uma parcela com esse vencimento. Selecione o título existente; não crie a dívida novamente.';
    END IF;
   ELSE
    v_id:=(v_mapping#>>'{}')::uuid;
    SELECT * INTO v_title FROM public.receivable_titles WHERE id=v_id AND scope=p_scope
     AND cf_private.receivable_sync_group_key(branch,document,customer_key)=v_row->>'group_key';
    IF NOT FOUND OR (v_alias IS NOT NULL AND v_alias<>v_id) THEN
     v_id:=NULL;v_problem:='O título escolhido não pertence a esta parcela ou o vínculo já está estabelecido.';
    END IF;
   END IF;
  ELSIF v_alias IS NOT NULL THEN v_id:=v_alias;
  ELSIF v_exact=1 THEN
   SELECT id INTO v_id FROM public.receivable_titles t WHERE t.scope=p_scope AND t.due_date=(v_row->>'due_date')::date
    AND cf_private.receivable_sync_group_key(t.branch,t.document,t.customer_key)=v_row->>'group_key';
  ELSIF v_group_count>0 THEN
   v_outcome:='AMBIGUOUS';v_problem:='Confirme se esta linha é uma nova parcela ou uma alteração de vencimento de um título existente.';
  END IF;
  IF v_id IS NOT NULL AND v_problem IS NULL THEN
   SELECT * INTO v_title FROM public.receivable_titles WHERE id=v_id AND scope=p_scope;
   IF NOT FOUND THEN v_problem:='Vínculo de parcela indisponível. Gere nova análise.';v_id:=NULL;
   ELSE
    v_changed:=ROW(v_title.document,v_title.client_name,v_title.client_document,v_title.branch,v_title.issued_on,v_title.due_date,v_title.amount_cents)
     IS DISTINCT FROM ROW(v_row->>'document',v_row->>'client_name',v_row->>'client_document',v_row->>'branch',
      (v_row->>'issued_on')::date,(v_row->>'due_date')::date,(v_row->>'amount_cents')::bigint);
    v_outcome:=CASE WHEN v_changed THEN 'UPDATE' ELSE 'MATCHED' END;
    IF p_mode='open' AND (v_title.status='VALIDATED' OR EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=v_id))
     AND ROW(v_title.amount_cents,v_title.due_date) IS DISTINCT FROM ROW((v_row->>'amount_cents')::bigint,(v_row->>'due_date')::date) THEN
     v_problem:='Este título já possui recebimento validado. Use a importação de recebidos e a confirmação de correção; o histórico foi preservado.';
    END IF;
   END IF;
  END IF;
  IF v_id IS NULL AND v_problem IS NULL AND (SELECT count(DISTINCT collector_id) FROM public.receivable_titles
   WHERE scope=p_scope AND customer_key=v_row->>'customer_key' AND status<>'VALIDATED' AND collector_id IS NOT NULL)>1 THEN
   v_problem:='Cliente com mais de uma cobradora ativa. Corrija a carteira antes de criar parcelas.';
  END IF;
  IF v_problem IS NOT NULL AND v_outcome<>'AMBIGUOUS' THEN v_outcome:='CONFLICT';END IF;
  v_result:=array_append(v_result,v_row||jsonb_build_object('title_id',v_id,'outcome',v_outcome,'changed',v_changed,
   'candidates',v_candidates,'problem',v_problem));
 END LOOP;
 -- Duas linhas do mesmo arquivo nunca podem atualizar o mesmo UUID.
 SELECT array_agg(CASE WHEN r->>'title_id' IN (SELECT s->>'title_id' FROM unnest(v_result) s
   WHERE s->>'title_id' IS NOT NULL GROUP BY s->>'title_id' HAVING count(*)>1)
  THEN r||jsonb_build_object('outcome','CONFLICT','problem','Duas linhas foram vinculadas ao mesmo título. Diferencie as parcelas antes de importar.') ELSE r END ORDER BY n)
 INTO v_result FROM unnest(v_result) WITH ORDINALITY x(r,n);
 RETURN to_jsonb(v_result);
END $$;

CREATE FUNCTION cf_private.bind_receivable_parcel_alias(p_scope text,p_source_key text,p_title_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$ DECLARE v_id uuid;BEGIN
 SELECT title_id INTO v_id FROM cf_private.receivable_parcel_aliases WHERE scope=p_scope AND source_key=p_source_key;
 IF v_id IS NOT NULL AND v_id<>p_title_id THEN RAISE EXCEPTION 'O vínculo da parcela mudou. Nenhum título foi reassociado.' USING ERRCODE='P0023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.receivable_titles WHERE id=p_title_id AND scope=p_scope) THEN
  RAISE EXCEPTION 'Título indisponível para vincular.' USING ERRCODE='P0023';END IF;
 INSERT INTO cf_private.receivable_parcel_aliases(scope,source_key,title_id,created_by)
 VALUES(p_scope,p_source_key,p_title_id,auth.uid()) ON CONFLICT(scope,source_key) DO NOTHING;
END $$;
CREATE FUNCTION cf_private.validate_receivable_sync_file(p_file_name text,p_file_sha256 text,p_file_base64 text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$ DECLARE v_file bytea;BEGIN
 IF p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 250 OR p_file_name ~ '[/\\[:cntrl:]]'
  OR p_file_sha256 IS NULL OR p_file_sha256 !~ '^[a-f0-9]{64}$' OR p_file_base64 IS NULL OR length(p_file_base64) NOT BETWEEN 1 AND 2796204 THEN
  RAISE EXCEPTION 'Metadados do arquivo inválidos.' USING ERRCODE='22023';END IF;
 BEGIN v_file:=decode(p_file_base64,'base64');EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
  RAISE EXCEPTION 'Arquivo original inválido.' USING ERRCODE='22023';END;
 IF octet_length(v_file) NOT BETWEEN 1 AND 2097152 OR encode(sha256(v_file),'hex')<>p_file_sha256 THEN
  RAISE EXCEPTION 'A integridade do arquivo original não foi confirmada.' USING ERRCODE='22023';END IF;RETURN v_file;
END $$;
CREATE FUNCTION cf_private.set_receivable_sync_actor(p_user_id uuid,p_session_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_session_id !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 PERFORM pg_advisory_xact_lock(2045812301);
 PERFORM cf_private.require_receivable_finance('read');PERFORM cf_private.require_receivable_finance('write');PERFORM cf_private.require_receivable_finance('import');
END $$;

CREATE FUNCTION public.preview_receivables_open_import(p_scope text,p_rows jsonb,p_title_mappings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_previous uuid;v_new integer;v_open integer;v_validated integer;v_changed integer;v_conflicts integer;v_errors jsonb;BEGIN
 PERFORM cf_private.require_receivable_finance('read');PERFORM cf_private.require_receivable_finance('write');PERFORM cf_private.require_receivable_finance('import');
 v_rows:=cf_private.resolve_receivable_sync_rows(p_scope,cf_private.normalize_receivable_sync_rows(p_scope,p_rows),p_title_mappings,'open');
 SELECT id INTO v_previous FROM public.receivable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL AND r->>'outcome'='NEW'),
  count(*) FILTER(WHERE t.id IS NOT NULL AND t.status<>'VALIDATED'),count(*) FILTER(WHERE t.status='VALIDATED'),
  count(*) FILTER(WHERE r->>'outcome'='UPDATE'),count(*) FILTER(WHERE r->>'outcome' IN ('AMBIGUOUS','CONFLICT'))
 INTO v_new,v_open,v_validated,v_changed,v_conflicts FROM jsonb_array_elements(v_rows) r
 LEFT JOIN public.receivable_titles t ON t.id=(r->>'title_id')::uuid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('line',(r->>'line')::integer,'column','Parcela / vencimento','problem',r->>'problem',
  'correction','Selecione uma parcela existente ou confirme explicitamente NOVA parcela.')),'[]'::jsonb) INTO v_errors
 FROM jsonb_array_elements(v_rows) r WHERE r->>'outcome' IN ('AMBIGUOUS','CONFLICT');
 RETURN jsonb_build_object('mode','open','previous_import_id',v_previous,'financial_revision',cf_private.receivables_sync_revision_value(),
  'row_count',jsonb_array_length(v_rows),'new_count',v_new,'open_count',v_open,'changed_count',v_changed,'pending_count',0,
  'validated_in_source_count',v_validated,'conflict_count',v_conflicts,'can_commit',v_conflicts=0,'errors',v_errors,'rows',v_rows);
END $$;

CREATE FUNCTION public.commit_receivables_open_import_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,
 p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_title_mappings jsonb DEFAULT '{}'::jsonb,
 p_previous_import_id uuid DEFAULT NULL,p_previous_financial_revision text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_file bytea;v_rows jsonb;v_preview jsonb;v_previous uuid;v_existing uuid;v_result jsonb;v_id uuid:=gen_random_uuid();
 v_row jsonb;v_title_id uuid;v_collector uuid;BEGIN
 PERFORM cf_private.set_receivable_sync_actor(p_user_id,p_session_id);
 v_file:=cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 v_rows:=cf_private.normalize_receivable_sync_rows(p_scope,p_rows);
 PERFORM pg_advisory_xact_lock(2045812308);
 SELECT i.id,s.result INTO v_existing,v_result FROM public.receivable_imports i JOIN public.receivable_sync_imports s ON s.import_id=i.id
  WHERE i.scope=p_scope AND i.file_sha256=p_file_sha256 AND i.import_mode='OPEN';
 IF v_existing IS NOT NULL THEN RETURN v_result||jsonb_build_object('idempotent',true);END IF;
 SELECT id INTO v_previous FROM public.receivable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_previous IS DISTINCT FROM p_previous_import_id OR p_previous_financial_revision IS NULL
  OR length(p_previous_financial_revision)>256 OR p_previous_financial_revision IS DISTINCT FROM cf_private.receivables_sync_revision_value() THEN
  RAISE EXCEPTION 'A base ou os dados financeiros mudaram. Gere nova análise antes de confirmar.' USING ERRCODE='40001';END IF;
 v_preview:=public.preview_receivables_open_import(p_scope,p_rows,p_title_mappings);
 IF NOT (v_preview->>'can_commit')::boolean THEN
  RAISE EXCEPTION 'Há parcelas sem vínculo confirmado. Nenhum dado foi alterado.' USING ERRCODE='P0023',DETAIL=(v_preview->'errors')::text;END IF;
 v_rows:=v_preview->'rows';
 INSERT INTO public.receivable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode)
 VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),(v_preview->>'new_count')::integer,
  (v_preview->>'open_count')::integer,0,(v_preview->>'validated_in_source_count')::integer,'OPEN');
 INSERT INTO cf_private.receivable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
  v_title_id:=(v_row->>'title_id')::uuid;
  IF v_title_id IS NULL THEN
   SELECT t.collector_id INTO v_collector FROM public.receivable_titles t WHERE t.scope=p_scope
    AND t.customer_key=v_row->>'customer_key' AND t.status<>'VALIDATED' AND t.collector_id IS NOT NULL LIMIT 1;
   INSERT INTO public.receivable_titles(scope,source_key,document,client_name,client_document,customer_key,branch,
    issued_on,due_date,amount_cents,collector_id,status,first_import_id,last_import_id)
   VALUES(p_scope,v_row->>'source_key',v_row->>'document',v_row->>'client_name',v_row->>'client_document',v_row->>'customer_key',v_row->>'branch',
    (v_row->>'issued_on')::date,(v_row->>'due_date')::date,(v_row->>'amount_cents')::bigint,v_collector,'NEW',v_id,v_id)
   RETURNING id INTO v_title_id;
  ELSE
   PERFORM id FROM public.receivable_titles WHERE id=v_title_id FOR UPDATE;
   UPDATE public.receivable_titles SET document=v_row->>'document',client_name=v_row->>'client_name',
    client_document=v_row->>'client_document',customer_key=v_row->>'customer_key',branch=v_row->>'branch',
    issued_on=(v_row->>'issued_on')::date,due_date=(v_row->>'due_date')::date,amount_cents=(v_row->>'amount_cents')::bigint,
    status=CASE WHEN status='NEW' THEN 'OPEN' ELSE status END,in_latest_report=true,last_import_id=v_id WHERE id=v_title_id;
  END IF;
  PERFORM cf_private.bind_receivable_parcel_alias(p_scope,v_row->>'source_key',v_title_id);
 END LOOP;
 v_result:=(v_preview-'rows'-'errors'-'can_commit'-'financial_revision')||jsonb_build_object('import_id',v_id,'mode','open');
 INSERT INTO public.receivable_sync_imports(import_id,mode,result,created_by) VALUES(v_id,'OPEN',v_result,auth.uid());
 RETURN v_result;
END $$;

-- Clientes antigos usam a mesma sincronização segura: ausência nunca é baixa.
CREATE OR REPLACE FUNCTION public.preview_receivables_import(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.preview_receivables_open_import(p_scope,p_rows,'{}'::jsonb);
$$;
CREATE OR REPLACE FUNCTION public.commit_receivables_import_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,
 p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_complete boolean,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM cf_private.set_receivable_sync_actor(p_user_id,p_session_id);
 IF p_complete IS DISTINCT FROM true THEN RAISE EXCEPTION 'Confirme a importação do relatório consolidado.' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(2045812308);
 RETURN public.commit_receivables_open_import_from_gateway(p_user_id,p_session_id,p_scope,p_file_name,p_file_sha256,p_file_base64,
  p_rows,'{}'::jsonb,p_previous_import_id,cf_private.receivables_sync_revision_value());
END $$;

REVOKE ALL ON FUNCTION cf_private.bump_receivables_sync_revision(),cf_private.receivables_sync_revision_value(),
 cf_private.audit_receivable_sync_change(),cf_private.receivable_sync_group_key(text,text,text),
 cf_private.receivable_sync_parcel_key(text,text,text,date),cf_private.normalize_receivable_sync_rows(text,jsonb),
 cf_private.resolve_receivable_sync_rows(text,jsonb,jsonb,text),cf_private.bind_receivable_parcel_alias(text,text,uuid),
 cf_private.validate_receivable_sync_file(text,text,text),cf_private.set_receivable_sync_actor(uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_receivables_sync_revision(),public.receivables_import_capabilities(),
 public.preview_receivables_open_import(text,jsonb,jsonb),
 public.commit_receivables_open_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text),
 public.preview_receivables_import(text,jsonb),public.commit_receivables_import_from_gateway(uuid,text,text,text,text,text,jsonb,boolean,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_receivables_sync_revision(),public.receivables_import_capabilities(),
 public.preview_receivables_open_import(text,jsonb,jsonb),public.preview_receivables_import(text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_receivables_open_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text),
 public.commit_receivables_import_from_gateway(uuid,text,text,text,text,text,jsonb,boolean,uuid) TO service_role;
COMMENT ON TABLE public.receivable_titles IS 'Histórico persistente por parcela. Importações de abertos incrementais preservam carteira, validação e títulos ausentes; ausência não comprova recebimento.';
COMMENT ON TABLE cf_private.receivable_parcel_aliases IS 'Vínculos imutáveis de filial, documento, cliente e vencimento a UUID; valor não compõe a identidade.';
INSERT INTO public.central_schema_migrations(version) VALUES('023_receivable_sync');
COMMIT;
