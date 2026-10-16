-- Central Financeira: relatório completo de Contas a Receber, sem baixa financeira automática.
-- Incremental após 001, 003, 004, 005, 006 e 007. Não contém dados financeiros reais.
BEGIN;

CREATE FUNCTION cf_private.normalize_receivable_text(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  -- Mesma lista de espaços de ECMAScript (/\s/), inclusive NBSP/BOM de planilhas.
  SELECT btrim(regexp_replace(p_value,U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g'));
$$;
CREATE FUNCTION cf_private.receivable_customer_key(p_name text,p_document text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_document IS NOT NULL THEN 'cnpj:'||p_document
    ELSE 'name:'||upper(cf_private.normalize_receivable_text(p_name)) END;
$$;
CREATE TABLE public.receivable_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope='grupo-consolidado'),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 250),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 5000),
  new_count integer NOT NULL CHECK (new_count>=0),
  open_count integer NOT NULL CHECK (open_count>=0),
  pending_count integer NOT NULL CHECK (pending_count>=0),
  validated_in_source_count integer NOT NULL CHECK (validated_in_source_count>=0),
  UNIQUE(scope,file_sha256),
  CHECK(new_count+open_count+validated_in_source_count=row_count)
);
CREATE INDEX receivable_imports_scope_date ON public.receivable_imports(scope,created_at DESC,id DESC);
CREATE TABLE cf_private.receivable_import_files (
  import_id uuid PRIMARY KEY REFERENCES public.receivable_imports(id) ON DELETE RESTRICT,
  file_bytes bytea NOT NULL CHECK(octet_length(file_bytes) BETWEEN 1 AND 2097152)
);
CREATE TABLE public.receivable_titles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK(scope='grupo-consolidado'),
  source_key text NOT NULL,
  document text NOT NULL CHECK(length(document) BETWEEN 1 AND 150),
  client_name text NOT NULL CHECK(length(client_name) BETWEEN 1 AND 1500),
  client_document text CHECK(client_document ~ '^[0-9]{14}$'),
  customer_key text NOT NULL,
  branch text NOT NULL CHECK(length(branch) BETWEEN 1 AND 150),
  issued_on date,
  due_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 0 AND 9007199254740991),
  collector_id uuid REFERENCES public.collection_agents(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK(status IN ('NEW','OPEN','PENDING_VALIDATION','NOT_LOCATED','VALIDATED')),
  validation_status text NOT NULL DEFAULT 'NONE' CHECK(validation_status IN ('NONE','PENDING','VALIDATED')),
  payment_source text CHECK(payment_source IN ('IMPORTACAO_DIARIA','COBRANCA')),
  payment_reported_date date,
  payment_date date,
  reported_in_collection boolean NOT NULL DEFAULT false,
  collector_locked boolean NOT NULL DEFAULT false,
  in_latest_report boolean NOT NULL DEFAULT true,
  first_import_id uuid NOT NULL REFERENCES public.receivable_imports(id) ON DELETE RESTRICT,
  last_import_id uuid NOT NULL REFERENCES public.receivable_imports(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
  UNIQUE(scope,source_key),
  CHECK((status='VALIDATED')=(validation_status='VALIDATED')),
  CHECK(status<>'VALIDATED' OR payment_date IS NOT NULL),
  CHECK(customer_key=cf_private.receivable_customer_key(client_name,client_document))
);
CREATE INDEX receivable_titles_status_due ON public.receivable_titles(status,due_date,id);
CREATE INDEX receivable_titles_collector_status ON public.receivable_titles(collector_id,status,due_date,id);
CREATE INDEX receivable_titles_customer_active ON public.receivable_titles(customer_key) WHERE status<>'VALIDATED';
CREATE INDEX receivable_titles_identity_lookup ON public.receivable_titles(scope,branch,document,due_date,amount_cents)
 WHERE status<>'VALIDATED' OR in_latest_report;

ALTER TABLE public.receivable_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_titles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.receivable_import_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY receivable_imports_read ON public.receivable_imports FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read'));
CREATE POLICY receivable_titles_read ON public.receivable_titles FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read') OR
   (cf_private.has_permission('cobranca','read') AND collector_id=cf_private.current_collector_id()));
-- Diretoria pode identificar responsáveis sem ganhar acesso a contas de usuários.
DROP POLICY agents_read ON public.collection_agents;
CREATE POLICY agents_read ON public.collection_agents FOR SELECT TO authenticated
 USING(cf_private.is_manager() OR cf_private.has_permission('contas_receber','read')
   OR id=cf_private.current_collector_id());

CREATE FUNCTION cf_private.validate_receivable_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
 v_row jsonb; v_normalized jsonb; v_items jsonb[]:=ARRAY[]::jsonb[]; v_result jsonb;
 v_line integer:=0; v_field text; v_text text; v_due date; v_issued date;
 v_cents numeric; v_total numeric:=0; v_document text; v_customer text; v_key text;
BEGIN
 IF p_scope IS DISTINCT FROM 'grupo-consolidado' THEN
  RAISE EXCEPTION 'Importe somente o relatório completo do grupo consolidado.' USING ERRCODE='22023';
 END IF;
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' THEN
  RAISE EXCEPTION 'Informe as linhas do relatório completo.' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'O relatório deve conter de 1 a 5.000 linhas.' USING ERRCODE='22023';
 END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  v_line:=v_line+1;
  IF jsonb_typeof(v_row)<>'object' THEN
   RAISE EXCEPTION 'Linha %: estrutura inválida.',v_line USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN
    ('document','client_name','client_document','branch','issued_on','due_date','amount_cents')) THEN
   RAISE EXCEPTION 'Linha %: estrutura inválida.',v_line USING ERRCODE='22023';
  END IF;
  FOREACH v_field IN ARRAY ARRAY['document','client_name','branch','due_date'] LOOP
   IF jsonb_typeof(v_row->v_field) IS DISTINCT FROM 'string'
      OR length(cf_private.normalize_receivable_text(v_row->>v_field))=0 THEN
    RAISE EXCEPTION 'Linha %: coluna % obrigatória.',v_line,v_field USING ERRCODE='22023';
   END IF;
  END LOOP;
  FOREACH v_field IN ARRAY ARRAY['client_document','issued_on'] LOOP
   IF v_row ? v_field AND jsonb_typeof(v_row->v_field) NOT IN ('string','null') THEN
    RAISE EXCEPTION 'Linha %: coluna % inválida.',v_line,v_field USING ERRCODE='22023';
   END IF;
  END LOOP;
  IF length(v_row->>'document')>150 OR length(v_row->>'branch')>150 OR length(v_row->>'client_name')>1500 THEN
   RAISE EXCEPTION 'Linha %: conteúdo excede o tamanho permitido.',v_line USING ERRCODE='22023';
  END IF;
  v_document:=nullif(v_row->>'client_document','');
  IF v_document IS NOT NULL AND v_document !~ '^[0-9]{14}$' THEN
   RAISE EXCEPTION 'Linha %: CNPJ deve conter 14 dígitos ou estar vazio.',v_line USING ERRCODE='22023';
  END IF;
  v_text:=v_row->>'due_date';
  IF v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR left(v_text,4)='0000' THEN
   RAISE EXCEPTION 'Linha %: vencimento deve usar AAAA-MM-DD.',v_line USING ERRCODE='22023';
  END IF;
  BEGIN v_due:=v_text::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION 'Linha %: vencimento inválido.',v_line USING ERRCODE='22023';
  END;
  v_issued:=NULL;
  IF coalesce(v_row->>'issued_on','')<>'' THEN
   v_text:=v_row->>'issued_on';
   IF v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR left(v_text,4)='0000' THEN
    RAISE EXCEPTION 'Linha %: emissão deve usar AAAA-MM-DD.',v_line USING ERRCODE='22023';
   END IF;
   BEGIN v_issued:=v_text::date;
   EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Linha %: emissão inválida.',v_line USING ERRCODE='22023';
   END;
  END IF;
  IF jsonb_typeof(v_row->'amount_cents') IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'Linha %: valor deve ser informado em centavos inteiros.',v_line USING ERRCODE='22023';
  END IF;
  v_cents:=(v_row->>'amount_cents')::numeric;
  IF v_cents<>trunc(v_cents) OR v_cents<0 OR v_cents>9007199254740991 THEN
   RAISE EXCEPTION 'Linha %: valor em centavos inválido.',v_line USING ERRCODE='22023';
  END IF;
  v_total:=v_total+v_cents;
  IF v_total>9007199254740991 THEN
   RAISE EXCEPTION 'O total do relatório excede o limite de precisão.' USING ERRCODE='22023';
  END IF;
  v_customer:=cf_private.receivable_customer_key(v_row->>'client_name',v_document);
  v_normalized:=jsonb_build_object('document',cf_private.normalize_receivable_text(v_row->>'document'),
    'client_name',cf_private.normalize_receivable_text(v_row->>'client_name'),'client_document',v_document,
    'customer_key',v_customer,'branch',cf_private.normalize_receivable_text(v_row->>'branch'),
    'issued_on',v_issued,'due_date',v_due,'amount_cents',v_cents::bigint);
  v_key:=jsonb_build_array(v_normalized->>'branch',v_normalized->>'document',v_customer,v_due,v_cents::bigint)::text;
  v_items:=array_append(v_items,v_normalized||jsonb_build_object('source_key',v_key));
 END LOOP;
 v_result:=to_jsonb(v_items);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_result) r GROUP BY r->>'source_key' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'O relatório contém chaves duplicadas. Revise filial, documento, cliente, vencimento e valor.' USING ERRCODE='23505';
 END IF;
 RETURN v_result;
END;
$$;

-- Um CNPJ opcional não pode mudar silenciosamente a identidade de uma dívida.
-- Somente evidência exata é comparada; nenhuma união ou atribuição é inferida.
CREATE FUNCTION cf_private.check_receivable_identity(p_scope text,p_rows jsonb) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
 IF EXISTS(
  SELECT 1 FROM jsonb_array_elements(p_rows) r
  WHERE NOT EXISTS(SELECT 1 FROM public.receivable_titles known
    WHERE known.scope=p_scope AND known.source_key=r->>'source_key')
  AND EXISTS(SELECT 1 FROM public.receivable_titles previous
    WHERE previous.scope=p_scope AND (previous.in_latest_report OR previous.status<>'VALIDATED')
      AND previous.branch=r->>'branch' AND previous.document=r->>'document'
      AND previous.due_date=(r->>'due_date')::date AND previous.amount_cents=(r->>'amount_cents')::bigint
      AND cf_private.receivable_customer_key(previous.client_name,NULL)=cf_private.receivable_customer_key(r->>'client_name',NULL)
      AND previous.customer_key<>r->>'customer_key'))
 OR EXISTS(
  -- Duas linhas com a mesma evidência, uma com CNPJ e outra somente por nome,
  -- são ambíguas até correção administrativa. CNPJs distintos e explícitos são
  -- identidades distintas; chaves já estabelecidas também são preservadas.
  SELECT 1 FROM jsonb_array_elements(p_rows) r
  GROUP BY r->>'branch',r->>'document',r->>'due_date',r->>'amount_cents',
    cf_private.receivable_customer_key(r->>'client_name',NULL)
  HAVING count(DISTINCT r->>'customer_key')>1
    AND count(*) FILTER(WHERE r->>'client_document' IS NULL)>0
 ) THEN
  RAISE EXCEPTION 'Possível alteração de identificação do cliente. CNPJ incluído, removido ou alterado pode duplicar a dívida. Solicite correção administrativa antes de importar.' USING ERRCODE='23514';
 END IF;
END;
$$;

CREATE FUNCTION cf_private.touch_receivable_title() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
 NEW.revision:=OLD.revision+1;
 NEW.updated_at:=clock_timestamp();
 RETURN NEW;
END;
$$;
CREATE FUNCTION cf_private.audit_receivable_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor public.profiles%ROWTYPE; v_before jsonb; v_after jsonb; v_action text;
BEGIN
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 IF TG_OP='UPDATE' THEN v_before:=to_jsonb(OLD); END IF;
 v_after:=to_jsonb(NEW);
 v_action:=CASE WHEN TG_OP='INSERT' THEN 'CREATE' ELSE 'UPDATE' END;
 IF TG_TABLE_NAME='receivable_imports' THEN v_action:='IMPORT';
 ELSIF TG_OP='UPDATE' THEN
  IF NEW.status='VALIDATED' AND OLD.status<>'VALIDATED' THEN v_action:='VALIDATE';
  ELSIF NEW.collector_id IS DISTINCT FROM OLD.collector_id THEN v_action:='ASSIGNMENT';
  ELSIF NEW.status='PENDING_VALIDATION' AND OLD.status<>'PENDING_VALIDATION' AND NOT NEW.in_latest_report THEN v_action:='AUTO_RECONCILE';
  END IF;
 END IF;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_receber',TG_TABLE_NAME,NEW.id::text,v_action,v_before,v_after);
 RETURN NEW;
END;
$$;
CREATE TRIGGER receivable_title_touch BEFORE UPDATE ON public.receivable_titles
 FOR EACH ROW EXECUTE FUNCTION cf_private.touch_receivable_title();
CREATE TRIGGER receivable_title_audit AFTER INSERT OR UPDATE ON public.receivable_titles
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_receivable_change();
CREATE TRIGGER receivable_import_audit AFTER INSERT ON public.receivable_imports
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_receivable_change();

CREATE FUNCTION public.preview_receivables_import(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows jsonb; v_previous uuid; v_new integer; v_open integer; v_pending integer; v_validated integer;
BEGIN
 IF NOT cf_private.has_permission('contas_receber','import') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 v_rows:=cf_private.validate_receivable_rows(p_scope,p_rows);
 PERFORM cf_private.check_receivable_identity(p_scope,v_rows);
 SELECT id INTO v_previous FROM public.receivable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 -- Contagens disjuntas: novos + existentes não validados + validados presentes = linhas.
 SELECT count(*) FILTER(WHERE t.id IS NULL),count(*) FILTER(WHERE t.id IS NOT NULL AND t.status<>'VALIDATED'),
   count(*) FILTER(WHERE t.status='VALIDATED') INTO v_new,v_open,v_validated
 FROM jsonb_array_elements(v_rows) r LEFT JOIN public.receivable_titles t ON t.scope=p_scope AND t.source_key=r->>'source_key';
 SELECT count(*) INTO v_pending FROM public.receivable_titles t WHERE t.scope=p_scope AND t.status<>'VALIDATED' AND t.in_latest_report
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'source_key'=t.source_key);
 RETURN jsonb_build_object('previous_import_id',v_previous,'new_count',v_new,'open_count',v_open,
  'pending_count',v_pending,'validated_in_source_count',v_validated,'row_count',jsonb_array_length(v_rows));
END;
$$;

-- Única entrada de gravação para importação: o serviço valida JWT e deriva as
-- linhas do arquivo original; o banco revalida sessão, perfil e integridade.
CREATE FUNCTION public.commit_receivables_import_from_gateway(
 p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,
 p_rows jsonb,p_complete boolean,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows jsonb; v_previous uuid; v_id uuid:=gen_random_uuid(); v_file bytea;
 v_new integer; v_open integer; v_pending integer; v_validated integer;
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL
   OR p_session_id !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 IF NOT cf_private.has_permission('contas_receber','import') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 IF p_complete IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Confirme que o arquivo contém o relatório completo.' USING ERRCODE='22023';
 END IF;
 v_rows:=cf_private.validate_receivable_rows(p_scope,p_rows);
 IF p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 250 OR p_file_name ~ '[/\\[:cntrl:]]'
   OR p_file_sha256 IS NULL OR p_file_sha256 !~ '^[a-f0-9]{64}$'
   OR p_file_base64 IS NULL OR length(p_file_base64) NOT BETWEEN 1 AND 2796204 THEN
  RAISE EXCEPTION 'Metadados do arquivo inválidos.' USING ERRCODE='22023';
 END IF;
 BEGIN v_file:=decode(p_file_base64,'base64');
 EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
  RAISE EXCEPTION 'O arquivo original está inválido.' USING ERRCODE='22023';
 END;
 IF octet_length(v_file) NOT BETWEEN 1 AND 2097152 OR encode(sha256(v_file),'hex')<>p_file_sha256 THEN
  RAISE EXCEPTION 'A integridade do arquivo original não foi confirmada.' USING ERRCODE='22023';
 END IF;
 -- Compartilhado por importação, atribuição, contato e validação financeira.
 PERFORM pg_advisory_xact_lock(2045812308);
 PERFORM cf_private.check_receivable_identity(p_scope,v_rows);
 SELECT id INTO v_previous FROM public.receivable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN
  RAISE EXCEPTION 'A base foi atualizada por outra importação. Gere uma nova prévia.' USING ERRCODE='40001';
 END IF;
 IF EXISTS(SELECT 1 FROM public.receivable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256) THEN
  RAISE EXCEPTION 'Este arquivo já foi importado neste escopo.' USING ERRCODE='23505';
 END IF;
 -- Não se decide uma carteira ambígua por ordem de linha, nome de login ou acaso.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r
   WHERE NOT EXISTS(SELECT 1 FROM public.receivable_titles e WHERE e.scope=p_scope AND e.source_key=r->>'source_key')
   AND (SELECT count(DISTINCT t.collector_id) FROM public.receivable_titles t
     WHERE t.scope=p_scope AND t.customer_key=r->>'customer_key' AND t.status<>'VALIDATED' AND t.collector_id IS NOT NULL)>1) THEN
  RAISE EXCEPTION 'Cliente com dívida ativa atribuída a mais de uma cobradora. Corrija a carteira antes de importar.' USING ERRCODE='23514';
 END IF;
 -- Contagens disjuntas: novos + existentes não validados + validados presentes = linhas.
 SELECT count(*) FILTER(WHERE t.id IS NULL),count(*) FILTER(WHERE t.id IS NOT NULL AND t.status<>'VALIDATED'),count(*) FILTER(WHERE t.status='VALIDATED')
 INTO v_new,v_open,v_validated FROM jsonb_array_elements(v_rows) r
 LEFT JOIN public.receivable_titles t ON t.scope=p_scope AND t.source_key=r->>'source_key';
 SELECT count(*) INTO v_pending FROM public.receivable_titles t WHERE t.scope=p_scope AND t.status<>'VALIDATED' AND t.in_latest_report
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'source_key'=t.source_key);
 INSERT INTO public.receivable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count)
 VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),v_new,v_open,v_pending,v_validated);
 INSERT INTO cf_private.receivable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
 -- Ausência inicia conferência, nunca transforma título em recebimento validado.
 UPDATE public.receivable_titles t SET
  status=CASE WHEN t.status<>'VALIDATED' THEN 'PENDING_VALIDATION' ELSE t.status END,
  validation_status=CASE WHEN t.status<>'VALIDATED' THEN 'PENDING' ELSE t.validation_status END,
  payment_source=CASE WHEN t.status<>'VALIDATED' THEN 'IMPORTACAO_DIARIA' ELSE t.payment_source END,
  collector_locked=CASE WHEN t.status<>'VALIDATED' AND t.collector_id IS NOT NULL THEN true ELSE t.collector_locked END,
  in_latest_report=false,last_import_id=v_id
 WHERE t.scope=p_scope AND t.in_latest_report
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'source_key'=t.source_key);
 INSERT INTO public.receivable_titles(scope,source_key,document,client_name,client_document,customer_key,branch,
  issued_on,due_date,amount_cents,collector_id,status,first_import_id,last_import_id)
 SELECT p_scope,r.source_key,r.document,r.client_name,r.client_document,r.customer_key,r.branch,
   r.issued_on,r.due_date,r.amount_cents,
   (SELECT t.collector_id FROM public.receivable_titles t WHERE t.scope=p_scope
    AND t.customer_key=r.customer_key AND t.status<>'VALIDATED' AND t.collector_id IS NOT NULL LIMIT 1),
   'NEW',v_id,v_id
 FROM jsonb_to_recordset(v_rows) AS r(source_key text,document text,client_name text,client_document text,
   customer_key text,branch text,issued_on date,due_date date,amount_cents bigint)
 ON CONFLICT(scope,source_key) DO UPDATE SET document=EXCLUDED.document,client_name=EXCLUDED.client_name,
   client_document=EXCLUDED.client_document,customer_key=EXCLUDED.customer_key,branch=EXCLUDED.branch,
   issued_on=EXCLUDED.issued_on,due_date=EXCLUDED.due_date,amount_cents=EXCLUDED.amount_cents,
   status=CASE WHEN receivable_titles.status='NEW' THEN 'OPEN' ELSE receivable_titles.status END,
   in_latest_report=true,last_import_id=v_id;
 RETURN jsonb_build_object('import_id',v_id,'previous_import_id',v_previous,'new_count',v_new,'open_count',v_open,
  'pending_count',v_pending,'validated_in_source_count',v_validated,'row_count',jsonb_array_length(v_rows));
END;
$$;

REVOKE ALL ON TABLE public.receivable_imports,public.receivable_titles FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.receivable_imports,public.receivable_titles TO authenticated;
REVOKE ALL ON TABLE cf_private.receivable_import_files FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION cf_private.normalize_receivable_text(text),cf_private.receivable_customer_key(text,text),
 cf_private.validate_receivable_rows(text,jsonb),cf_private.check_receivable_identity(text,jsonb),cf_private.touch_receivable_title(),cf_private.audit_receivable_change()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.preview_receivables_import(text,jsonb),
 public.commit_receivables_import_from_gateway(uuid,text,text,text,text,text,jsonb,boolean,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_receivables_import(text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_receivables_import_from_gateway(uuid,text,text,text,text,text,jsonb,boolean,uuid) TO service_role;
COMMENT ON TABLE public.receivable_titles IS 'Histórico persistente; ausência no relatório completo apenas solicita validação financeira. Carteira e pagamento preservados.';
COMMENT ON TABLE cf_private.receivable_import_files IS 'Arquivos originais privados, limite 2 MiB. Nunca conceder leitura de tabela ao navegador.';
INSERT INTO public.central_schema_migrations(version) VALUES('008_receivables');
COMMIT;
