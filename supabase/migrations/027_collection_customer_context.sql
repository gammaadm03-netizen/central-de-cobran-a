-- Contatos revisáveis e referências por cliente/documento, somente na Cobrança.
-- Não altera títulos, quitações, responsáveis ou regras de comissão.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.collection_cases') IS NULL OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='026_collection_workbench') THEN
  RAISE EXCEPTION 'Ative a atualização 026 antes dos contatos de Cobrança.' USING ERRCODE='22023';END IF;
END $$;
CREATE TABLE public.collection_customer_contacts(
 customer_key text PRIMARY KEY,client_name text NOT NULL,client_document text,
 emails jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(emails)='array'),phones jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(phones)='array'),notes text CHECK(length(notes)<=5000),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),manually_edited boolean NOT NULL DEFAULT false,
 reviewed_at timestamptz,reviewed_by uuid REFERENCES public.profiles(id),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by uuid NOT NULL REFERENCES public.profiles(id),source_job_id uuid,
 CHECK(customer_key=cf_private.receivable_customer_key(client_name,client_document)),CHECK(client_document IS NULL OR client_document~'^[0-9]{14}$'),
 CHECK((reviewed_at IS NULL)=(reviewed_by IS NULL))
);
CREATE TABLE public.collection_contact_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_key text NOT NULL REFERENCES public.collection_customer_contacts(customer_key),
 before_value jsonb,after_value jsonb NOT NULL,action text NOT NULL DEFAULT 'MANUAL_SAVE' CHECK(action='MANUAL_SAVE'),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX collection_contact_events_date ON public.collection_contact_events(customer_key,created_at DESC,id DESC);
CREATE TABLE public.collection_description_references(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),context_key text NOT NULL,customer_key text NOT NULL,branch text NOT NULL,document text NOT NULL,
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 12000),contract text CHECK(length(contract)<=300),
 content_sha256 text NOT NULL CHECK(content_sha256~'^[a-f0-9]{64}$'),source_job_id uuid NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(context_key,content_sha256)
);
CREATE INDEX collection_description_context ON public.collection_description_references(context_key,imported_at,id);
CREATE TABLE cf_private.collection_contact_requests(
 actor_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL,payload jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE cf_private.collection_context_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 0);
INSERT INTO cf_private.collection_context_state(singleton) VALUES(true);
ALTER TABLE cf_private.collection_contact_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.collection_context_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.collection_contact_requests,cf_private.collection_context_state FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION cf_private.collection_reference_key(p_branch text,p_document text,p_customer_key text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT jsonb_build_array(upper(cf_private.normalize_receivable_text(p_branch)),upper(cf_private.normalize_receivable_text(p_document)),p_customer_key)::text;
$$;
CREATE FUNCTION cf_private.collection_context_customer_visible(p_customer_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND p.role_key IN ('gerente_geral','diretor','contas_receber','cobradora_1','cobradora_2'))
 AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.customer_key=p_customer_key AND t.status<>'VALIDATED' AND cf_private.collection_workbench_visible(t));
$$;
CREATE FUNCTION cf_private.collection_context_reference_visible(p_context_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND p.role_key IN ('gerente_geral','diretor','contas_receber','cobradora_1','cobradora_2'))
 AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.status<>'VALIDATED' AND cf_private.collection_workbench_visible(t)
  AND cf_private.collection_reference_key(t.branch,t.document,t.customer_key)=p_context_key);
$$;
CREATE FUNCTION cf_private.collection_context_bump() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN UPDATE cf_private.collection_context_state SET revision=revision+1 WHERE singleton;RETURN NULL;END $$;
CREATE TRIGGER collection_contact_context_revision AFTER INSERT OR UPDATE ON public.collection_customer_contacts FOR EACH STATEMENT EXECUTE FUNCTION cf_private.collection_context_bump();
CREATE TRIGGER collection_description_context_revision AFTER INSERT ON public.collection_description_references FOR EACH STATEMENT EXECUTE FUNCTION cf_private.collection_context_bump();
CREATE TRIGGER collection_title_context_revision AFTER INSERT OR UPDATE OR DELETE ON public.receivable_titles FOR EACH STATEMENT EXECUTE FUNCTION cf_private.collection_context_bump();
CREATE TRIGGER collection_binding_context_revision AFTER INSERT OR UPDATE OR DELETE ON public.collector_bindings FOR EACH STATEMENT EXECUTE FUNCTION cf_private.collection_context_bump();
CREATE TRIGGER collection_profile_context_revision AFTER INSERT OR UPDATE OR DELETE ON public.profiles FOR EACH STATEMENT EXECUTE FUNCTION cf_private.collection_context_bump();
CREATE TRIGGER collection_permission_context_revision AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions FOR EACH STATEMENT EXECUTE FUNCTION cf_private.collection_context_bump();
CREATE FUNCTION cf_private.audit_collection_contact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_actor public.profiles%ROWTYPE;BEGIN
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'cobranca',TG_TABLE_NAME,NEW.customer_key,
  CASE WHEN TG_OP='INSERT' THEN 'CREATE' ELSE 'UPDATE' END,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) END,to_jsonb(NEW));RETURN NEW;
END $$;
CREATE TRIGGER collection_contact_audit AFTER INSERT OR UPDATE ON public.collection_customer_contacts FOR EACH ROW EXECUTE FUNCTION cf_private.audit_collection_contact();
CREATE TRIGGER collection_contact_event_immutable BEFORE UPDATE OR DELETE ON public.collection_contact_events FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER collection_description_immutable BEFORE UPDATE OR DELETE ON public.collection_description_references FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER collection_contact_no_delete BEFORE DELETE ON public.collection_customer_contacts FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER collection_contact_request_immutable BEFORE UPDATE OR DELETE ON cf_private.collection_contact_requests FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['collection_customer_contacts','collection_contact_events','collection_description_references'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated',v_table);
  IF v_table='collection_description_references' THEN
   EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING(cf_private.collection_context_reference_visible(context_key))',v_table||'_read',v_table);
  ELSE
   EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING(cf_private.collection_context_customer_visible(customer_key))',v_table||'_read',v_table);
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION cf_private.normalize_collection_contact_methods(p_values jsonb,p_kind text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$ DECLARE v_item jsonb;v_text text;v_result jsonb:='[]';v_digits text;BEGIN
 IF p_values IS NULL OR jsonb_typeof(p_values)<>'array' OR jsonb_array_length(p_values)>50 OR p_kind NOT IN ('emails','phones') THEN
  RAISE EXCEPTION 'Informe até 50 e-mails ou telefones em uma lista.' USING ERRCODE='22023';END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_values) LOOP
  IF jsonb_typeof(v_item)<>'string' THEN RAISE EXCEPTION 'Contato inválido.' USING ERRCODE='22023';END IF;
  v_text:=cf_private.normalize_receivable_text(v_item#>>'{}');
  IF v_item#>>'{}' ~ '[[:cntrl:]]' OR length(v_text)=0 THEN RAISE EXCEPTION 'Informe um contato por linha, sem campos vazios.' USING ERRCODE='22023';END IF;
  IF p_kind='emails' THEN
   v_text:=lower(v_text);IF length(v_text)>320 OR v_text !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Confira o formato do e-mail.' USING ERRCODE='22023';END IF;
  ELSE
   v_digits:=regexp_replace(v_text,'[^0-9]','','g');IF length(v_text)>80 OR length(v_digits) NOT BETWEEN 3 AND 30 THEN
    RAISE EXCEPTION 'Confira o telefone e o DDD informado.' USING ERRCODE='22023';END IF;
  END IF;
  IF NOT v_result @> jsonb_build_array(v_text) THEN v_result:=v_result||jsonb_build_array(v_text);END IF;
 END LOOP;RETURN v_result;
END $$;
CREATE FUNCTION cf_private.collection_contact_token(p_customer_key text,p_revision bigint) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT encode(sha256(convert_to(jsonb_build_array(p_customer_key,p_revision)::text,'UTF8')),'hex');$$;
CREATE FUNCTION public.collection_customer_context(p_title_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE;v_contact public.collection_customer_contacts%ROWTYPE;v_contact_json jsonb;
 v_variants jsonb;v_count integer;v_reviewed_name text;v_updated_name text;v_write boolean;BEGIN
 v_title:=cf_private.collection_workbench_title(p_title_id);
 IF v_title.status='VALIDATED' THEN RAISE EXCEPTION 'Referências disponíveis somente para títulos ativos na Cobrança.' USING ERRCODE='42501';END IF;
 SELECT * INTO v_contact FROM public.collection_customer_contacts WHERE customer_key=v_title.customer_key;
 SELECT display_name INTO v_reviewed_name FROM public.profiles WHERE id=v_contact.reviewed_by;
 SELECT display_name INTO v_updated_name FROM public.profiles WHERE id=v_contact.updated_by;
 v_contact_json:=jsonb_build_object('emails',coalesce(v_contact.emails,'[]'::jsonb),'phones',coalesce(v_contact.phones,'[]'::jsonb),'notes',v_contact.notes,
  'revision',cf_private.collection_contact_token(v_title.customer_key,coalesce(v_contact.revision,0)),'record_revision',coalesce(v_contact.revision,0),
  'manually_edited',coalesce(v_contact.manually_edited,false),'reviewed_at',v_contact.reviewed_at,'reviewed_by',v_contact.reviewed_by,
  'reviewed_by_name',v_reviewed_name,'updated_at',v_contact.updated_at,'updated_by',v_contact.updated_by,'updated_by_name',v_updated_name);
 SELECT count(*) INTO v_count FROM public.collection_description_references WHERE context_key=cf_private.collection_reference_key(v_title.branch,v_title.document,v_title.customer_key);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'description',r.description,'contract',r.contract,'source_import_id',r.source_job_id,
  'imported_at',r.imported_at) ORDER BY r.imported_at,r.id),'[]'::jsonb) INTO v_variants FROM(
  SELECT * FROM public.collection_description_references WHERE context_key=cf_private.collection_reference_key(v_title.branch,v_title.document,v_title.customer_key)
   ORDER BY imported_at,id LIMIT 100)r;
 v_write:=cf_private.has_permission('cobranca','write') AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role_key IN ('gerente_geral','contas_receber','cobradora_1','cobradora_2'));
 RETURN jsonb_build_object('title_id',p_title_id,'customer_key',v_title.customer_key,'client_name',v_title.client_name,'client_document',v_title.client_document,
  'contact',v_contact_json,'descriptions',jsonb_build_object('state',CASE WHEN v_count=0 THEN 'MISSING' WHEN v_count=1 THEN 'AVAILABLE' ELSE 'PENDING_VARIANTS' END,
   'count',v_count,'variants',v_variants,'truncated',v_count>100),'can_edit',v_write,'can_review',v_write,
  'as_of_date',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'server_now',statement_timestamp());
END $$;
CREATE FUNCTION public.save_collection_customer_contacts(p_title_id uuid,p_emails jsonb,p_phones jsonb,p_notes text,p_expected_revision text,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE;v_old public.collection_customer_contacts%ROWTYPE;v_new public.collection_customer_contacts%ROWTYPE;
 v_payload jsonb;v_prior cf_private.collection_contact_requests%ROWTYPE;v_result jsonb;v_emails jsonb;v_phones jsonb;BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);v_title:=cf_private.collection_workbench_title(p_title_id);PERFORM cf_private.require_collection_title(v_title);
 IF v_title.status='VALIDATED' THEN RAISE EXCEPTION 'Contatos disponíveis somente para títulos ativos da Cobrança.' USING ERRCODE='42501';END IF;
 IF p_request_id IS NULL OR p_notes IS NOT NULL AND length(p_notes)>5000 THEN RAISE EXCEPTION 'Revise a observação e o identificador da operação.' USING ERRCODE='22023';END IF;
 v_payload:=jsonb_build_object('title_id',p_title_id,'customer_key',v_title.customer_key,'emails',p_emails,'phones',p_phones,'notes',p_notes,'expected_revision',p_expected_revision);
 SELECT * INTO v_prior FROM cf_private.collection_contact_requests WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN IF v_prior.payload<>v_payload THEN RAISE EXCEPTION 'Identificador já usado para outra alteração.' USING ERRCODE='22023';END IF;RETURN v_prior.result;END IF;
 v_emails:=cf_private.normalize_collection_contact_methods(p_emails,'emails');v_phones:=cf_private.normalize_collection_contact_methods(p_phones,'phones');
 SELECT * INTO v_old FROM public.collection_customer_contacts WHERE customer_key=v_title.customer_key FOR UPDATE;
 IF p_expected_revision IS DISTINCT FROM cf_private.collection_contact_token(v_title.customer_key,coalesce(v_old.revision,0)) THEN
  RAISE EXCEPTION 'Os contatos mudaram. Atualize a ficha antes de salvar.' USING ERRCODE='40001';END IF;
 INSERT INTO public.collection_customer_contacts(customer_key,client_name,client_document,emails,phones,notes,manually_edited,reviewed_at,reviewed_by,updated_by)
 VALUES(v_title.customer_key,v_title.client_name,v_title.client_document,v_emails,v_phones,nullif(btrim(p_notes),''),true,clock_timestamp(),auth.uid(),auth.uid())
 ON CONFLICT(customer_key) DO UPDATE SET emails=EXCLUDED.emails,phones=EXCLUDED.phones,notes=EXCLUDED.notes,revision=collection_customer_contacts.revision+1,
  manually_edited=true,reviewed_at=EXCLUDED.reviewed_at,reviewed_by=EXCLUDED.reviewed_by,updated_at=clock_timestamp(),updated_by=EXCLUDED.updated_by RETURNING * INTO v_new;
 INSERT INTO public.collection_contact_events(customer_key,before_value,after_value,created_by)
 VALUES(v_title.customer_key,CASE WHEN v_old.customer_key IS NOT NULL THEN to_jsonb(v_old) END,to_jsonb(v_new),auth.uid());
 v_result:=public.collection_customer_context(p_title_id);
 INSERT INTO cf_private.collection_contact_requests(actor_id,request_id,payload,result) VALUES(auth.uid(),p_request_id,v_payload,v_result);RETURN v_result;
END $$;

CREATE FUNCTION public.collection_customer_contact_report(p_search text DEFAULT '',p_collector_id uuid DEFAULT NULL,p_coverage text DEFAULT 'ALL',
 p_changed_start date DEFAULT NULL,p_changed_end date DEFAULT NULL,p_changed_by uuid DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,
 p_view text DEFAULT 'coverage',p_expected_revision text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_revision text;v_count bigint;v_scope bigint;v_with bigint;v_reviewed bigint;v_rows jsonb;BEGIN
 PERFORM cf_private.require_collection_workbench_read();
 IF p_search IS NULL OR length(p_search)>1500 OR p_coverage IS NULL OR p_coverage NOT IN ('ALL','WITH_CONTACT','MISSING_CONTACT','MISSING_EMAIL','MISSING_PHONE','REVIEWED','NOT_REVIEWED')
  OR p_view IS NULL OR p_view NOT IN ('coverage','changes') OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
  OR (p_changed_start IS NOT NULL AND p_changed_end IS NOT NULL AND p_changed_start>p_changed_end) THEN RAISE EXCEPTION 'Filtros de contatos inválidos.' USING ERRCODE='22023';END IF;
 SELECT revision::text INTO v_revision FROM cf_private.collection_context_state WHERE singleton;
 IF p_expected_revision IS NOT NULL AND p_expected_revision<>v_revision THEN RAISE EXCEPTION 'A carteira ou os contatos mudaram. Atualize o relatório.' USING ERRCODE='40001';END IF;
 WITH wallets AS MATERIALIZED(
  SELECT t.customer_key,min(t.client_name) AS client_name,min(t.client_document) AS client_document,count(*) AS title_count,sum(t.amount_cents) AS overdue_cents,
   array_agg(DISTINCT t.collector_id) FILTER(WHERE t.collector_id IS NOT NULL) AS collector_ids
  FROM public.receivable_titles t WHERE t.status<>'VALIDATED' AND cf_private.collection_workbench_visible(t)
   AND (p_collector_id IS NULL OR t.collector_id=p_collector_id)
   AND (p_search='' OR position(lower(btrim(p_search)) IN lower(t.client_name||' '||coalesce(t.client_document,'')))>0) GROUP BY t.customer_key
 ),cards AS MATERIALIZED(
  SELECT w.*,coalesce(c.emails,'[]'::jsonb) AS emails,coalesce(c.phones,'[]'::jsonb) AS phones,c.notes,coalesce(c.revision,0) AS record_revision,
   coalesce(c.manually_edited,false) AS manually_edited,c.reviewed_at,c.reviewed_by,r.display_name AS reviewed_by_name,c.updated_at,c.updated_by,u.display_name AS updated_by_name
  FROM wallets w LEFT JOIN public.collection_customer_contacts c USING(customer_key) LEFT JOIN public.profiles r ON r.id=c.reviewed_by LEFT JOIN public.profiles u ON u.id=c.updated_by
 ),filtered AS MATERIALIZED(
  SELECT c.* FROM cards c WHERE
   (p_coverage='ALL' OR p_coverage='WITH_CONTACT' AND (jsonb_array_length(c.emails)>0 OR jsonb_array_length(c.phones)>0)
    OR p_coverage='MISSING_CONTACT' AND jsonb_array_length(c.emails)=0 AND jsonb_array_length(c.phones)=0
    OR p_coverage='MISSING_EMAIL' AND jsonb_array_length(c.emails)=0 OR p_coverage='MISSING_PHONE' AND jsonb_array_length(c.phones)=0
    OR p_coverage='REVIEWED' AND c.reviewed_at IS NOT NULL OR p_coverage='NOT_REVIEWED' AND c.reviewed_at IS NULL)
   AND (p_changed_start IS NULL OR (c.updated_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_changed_start)
   AND (p_changed_end IS NULL OR (c.updated_at AT TIME ZONE 'America/Sao_Paulo')::date<=p_changed_end) AND (p_changed_by IS NULL OR c.updated_by=p_changed_by)
 ),changes AS MATERIALIZED(
  SELECT e.id AS event_id,e.customer_key,w.client_name,w.client_document,e.created_at,e.created_by,p.display_name AS created_by_name,
   e.before_value AS before,e.after_value AS after,e.action
  FROM public.collection_contact_events e JOIN wallets w USING(customer_key) LEFT JOIN public.profiles p ON p.id=e.created_by
  WHERE (p_changed_start IS NULL OR (e.created_at AT TIME ZONE 'America/Sao_Paulo')::date>=p_changed_start)
   AND (p_changed_end IS NULL OR (e.created_at AT TIME ZONE 'America/Sao_Paulo')::date<=p_changed_end) AND (p_changed_by IS NULL OR e.created_by=p_changed_by)
 ) SELECT (SELECT count(*) FROM cards),(SELECT count(*) FROM cards WHERE jsonb_array_length(emails)>0 OR jsonb_array_length(phones)>0),
  (SELECT count(*) FROM cards WHERE reviewed_at IS NOT NULL),CASE WHEN p_view='coverage' THEN (SELECT count(*) FROM filtered) ELSE (SELECT count(*) FROM changes) END,
  CASE WHEN p_view='coverage' THEN (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY lower(client_name),customer_key),'[]'::jsonb) FROM
   (SELECT * FROM filtered ORDER BY lower(client_name),customer_key OFFSET p_offset LIMIT p_limit)r)
  ELSE (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY created_at DESC,event_id DESC),'[]'::jsonb) FROM
   (SELECT * FROM changes ORDER BY created_at DESC,event_id DESC OFFSET p_offset LIMIT p_limit)r) END
 INTO v_scope,v_with,v_reviewed,v_count,v_rows;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE abs(coalesce((r->>'overdue_cents')::numeric,0))>9007199254740991) THEN RAISE EXCEPTION 'O total excede o limite de precisão.' USING ERRCODE='22003';END IF;
 RETURN jsonb_build_object('as_of_date',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'server_now',statement_timestamp(),
  'snapshot_revision',v_revision,'count',v_count,'scope_count',v_scope,'with_contact_count',v_with,'reviewed_count',v_reviewed,'rows',v_rows);
END $$;
REVOKE ALL ON FUNCTION cf_private.collection_reference_key(text,text,text),cf_private.collection_context_customer_visible(text),cf_private.collection_context_reference_visible(text),cf_private.collection_context_bump(),
 cf_private.audit_collection_contact(),cf_private.normalize_collection_contact_methods(jsonb,text),cf_private.collection_contact_token(text,bigint)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cf_private.collection_context_customer_visible(text),cf_private.collection_context_reference_visible(text) TO authenticated;
REVOKE ALL ON FUNCTION public.collection_customer_context(uuid),public.save_collection_customer_contacts(uuid,jsonb,jsonb,text,text,uuid),
 public.collection_customer_contact_report(text,uuid,text,date,date,uuid,integer,integer,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.collection_customer_context(uuid),public.save_collection_customer_contacts(uuid,jsonb,jsonb,text,text,uuid),
 public.collection_customer_contact_report(text,uuid,text,date,date,uuid,integer,integer,text,text) TO authenticated;
INSERT INTO public.central_schema_migrations(version) VALUES('027_collection_customer_context');
COMMIT;
