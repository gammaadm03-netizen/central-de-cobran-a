-- Central Financeira 0.4.0. Apply ONCE after 001/003/004/005/006/007.
-- Preserves existing payables, users, balances, messages and historical positions.
BEGIN;

-- SOURCE: 008_receivables.sql
-- Central Financeira: relatório completo de Contas a Receber, sem baixa financeira automática.
-- Incremental após 001, 003, 004, 005, 006 e 007. Não contém dados financeiros reais.

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

-- SOURCE: 009_collections.sql
-- Central Financeira: carteira individual, contato e validação financeira.
-- Aplicar após 008. Não cria dados financeiros nem presume vínculos de cobradoras.

ALTER TABLE public.receivable_titles ADD COLUMN last_action text;
ALTER TABLE public.receivable_titles ADD COLUMN next_action text;
ALTER TABLE public.receivable_titles ADD COLUMN next_action_date date;

CREATE TABLE public.receivable_collection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id uuid NOT NULL REFERENCES public.receivable_titles(id) ON DELETE RESTRICT,
  collector_id uuid REFERENCES public.collection_agents(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','NOT_LOCATED_CONTACT','OTHER','PAYMENT_DATE','VALIDATE','PAYMENT_NOT_LOCATED')),
  contact_date date,
  next_action text CHECK(next_action IN ('CONTACT','NO_RESPONSE','PROMISE','RETRY','OTHER')),
  next_date date,
  observation text CHECK(length(observation)<=5000),
  return_note text CHECK(length(return_note)<=5000),
  payment_date date,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX collection_events_title_date ON public.receivable_collection_events(title_id,created_at DESC,id);
CREATE INDEX collection_events_collector_date ON public.receivable_collection_events(collector_id,created_at DESC,id);
CREATE TABLE public.receivable_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id uuid NOT NULL UNIQUE REFERENCES public.receivable_titles(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 0 AND 9007199254740991),
  payment_date date NOT NULL,
  delay_days integer NOT NULL CHECK(delay_days>=0),
  delay_band text NOT NULL CHECK(delay_band IN ('ATE_30','31_60','61_90','91_180','181_365','ACIMA_365')),
  collector_id uuid REFERENCES public.collection_agents(id) ON DELETE RESTRICT,
  payment_source text NOT NULL CHECK(payment_source IN ('IMPORTACAO_DIARIA','COBRANCA')),
  reported_in_collection boolean NOT NULL,
  validation text NOT NULL DEFAULT 'VALIDADO' CHECK(validation='VALIDADO'),
  validated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  validated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX receivable_receipts_payment ON public.receivable_receipts(payment_date,payment_source);
CREATE INDEX receivable_receipts_collector ON public.receivable_receipts(collector_id,payment_date);
ALTER TABLE public.receivable_collection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY collection_events_read ON public.receivable_collection_events FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read') OR (
   cf_private.has_permission('cobranca','read') AND collector_id=cf_private.current_collector_id()
   AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=title_id AND t.collector_id=cf_private.current_collector_id())));
CREATE POLICY receivable_receipts_read ON public.receivable_receipts FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read') OR (
   cf_private.has_permission('cobranca','read') AND collector_id=cf_private.current_collector_id()
   AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=title_id AND t.collector_id=cf_private.current_collector_id())));
CREATE TRIGGER collection_events_immutable BEFORE UPDATE OR DELETE ON public.receivable_collection_events
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER receivable_receipts_immutable BEFORE UPDATE OR DELETE ON public.receivable_receipts
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();

CREATE FUNCTION cf_private.require_receivable_finance(p_action text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT cf_private.has_permission('contas_receber',p_action) OR NOT EXISTS(
    SELECT 1 FROM public.profiles WHERE id=auth.uid() AND enabled AND role_key IN ('gerente_geral','contas_receber')) THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
END;
$$;
CREATE FUNCTION cf_private.require_collection_title(p_title public.receivable_titles) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT cf_private.has_permission('cobranca','write') OR NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND (
      p.role_key IN ('gerente_geral','contas_receber') OR
      (p.role_key IN ('cobradora_1','cobradora_2') AND p_title.collector_id IS NOT NULL
       AND p_title.collector_id=cf_private.current_collector_id()))) THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
END;
$$;

CREATE FUNCTION public.assign_receivable_collector(p_customer_key text,p_collector_id uuid,p_observation text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  PERFORM cf_private.require_receivable_finance('write');
  IF p_customer_key IS NULL OR length(p_customer_key) NOT BETWEEN 1 AND 1505
     OR length(btrim(coalesce(p_observation,''))) NOT BETWEEN 1 AND 5000
     OR NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=p_collector_id AND enabled) THEN
    RAISE EXCEPTION 'Informe cliente, cobradora ativa e justificativa.' USING ERRCODE='23514';
  END IF;
  -- Não redistribui carteiras existentes. Um cliente ativo tem uma única responsável.
  PERFORM id FROM public.receivable_titles WHERE customer_key=p_customer_key AND status<>'VALIDATED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente sem dívida ativa para atribuir.' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.receivable_titles WHERE customer_key=p_customer_key AND status<>'VALIDATED'
      AND ((collector_id IS NOT NULL AND collector_id<>p_collector_id) OR (collector_id IS NULL AND collector_locked))) THEN
    RAISE EXCEPTION 'Este cliente já possui carteira ou vínculo bloqueado. A responsável foi preservada.' USING ERRCODE='23514';
  END IF;
  UPDATE public.receivable_titles SET collector_id=p_collector_id
    WHERE customer_key=p_customer_key AND status<>'VALIDATED' AND collector_id IS NULL AND NOT collector_locked;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    SELECT id,username,role_key,'contas_receber','customer_assignment',p_customer_key,'ASSIGNMENT',
      jsonb_build_object('collector_id',p_collector_id,'assigned_count',v_count,'observation',btrim(p_observation))
    FROM public.profiles WHERE id=auth.uid();
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.record_collection_action(
 p_title_id uuid,p_action text,p_contact_date date,p_next_action text,p_next_date date,p_observation text,
 p_return_note text,p_payment_date date,p_expected_revision bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE; v_id uuid; v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id FOR UPDATE;
  -- Missing IDs and somebody else's IDs have the same response.
  IF NOT FOUND THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  PERFORM cf_private.require_collection_title(v_title);
  IF p_expected_revision IS NULL OR v_title.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'O título mudou. Atualize a tela antes de registrar a ação.' USING ERRCODE='40001';
  END IF;
  IF v_title.status='VALIDATED' THEN RAISE EXCEPTION 'Este título já foi validado.' USING ERRCODE='23514'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','NOT_LOCATED_CONTACT','OTHER')
    OR p_contact_date IS NULL OR p_contact_date<DATE '1900-01-01' OR p_contact_date>v_today
    OR (p_next_action IS NOT NULL AND p_next_action NOT IN ('CONTACT','NO_RESPONSE','PROMISE','RETRY','OTHER'))
    OR (p_next_date IS NOT NULL AND (p_next_date<DATE '1900-01-01' OR p_next_action IS NULL))
    OR length(coalesce(p_observation,''))>5000 OR length(coalesce(p_return_note,''))>5000
    OR (p_action='OTHER' AND length(btrim(coalesce(p_observation,'')))=0)
    OR (p_action<>'PAID' AND p_payment_date IS NOT NULL) THEN
    RAISE EXCEPTION 'Revise ação, datas e observações.' USING ERRCODE='23514';
  END IF;
  IF p_action='PAID' THEN
    IF p_payment_date IS NULL OR p_payment_date<DATE '1900-01-01' OR p_payment_date>v_today THEN
      RAISE EXCEPTION 'Informe a data real do pagamento, até hoje.' USING ERRCODE='23514';
    END IF;
    IF v_title.validation_status='PENDING' OR v_title.status='PENDING_VALIDATION' THEN
      RAISE EXCEPTION 'O pagamento já está aguardando validação financeira.' USING ERRCODE='23514';
    END IF;
    UPDATE public.receivable_titles SET status='PENDING_VALIDATION',validation_status='PENDING',payment_source='COBRANCA',
      payment_reported_date=p_payment_date,payment_date=NULL,reported_in_collection=true,last_action=p_action,
      next_action=p_next_action,next_action_date=p_next_date WHERE id=p_title_id;
  ELSE
    -- Contatos nunca retiram um pagamento da fila nem trocam sua origem.
    UPDATE public.receivable_titles SET last_action=p_action,next_action=p_next_action,next_action_date=p_next_date WHERE id=p_title_id;
  END IF;
  INSERT INTO public.receivable_collection_events(title_id,collector_id,action,contact_date,next_action,next_date,
    observation,return_note,payment_date,created_by)
    VALUES(p_title_id,v_title.collector_id,p_action,p_contact_date,p_next_action,p_next_date,
      nullif(btrim(p_observation),''),nullif(btrim(p_return_note),''),p_payment_date,auth.uid()) RETURNING id INTO v_id;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    SELECT id,username,role_key,'cobranca','receivable_collection_events',v_id::text,'CREATE',
      jsonb_build_object('title_id',p_title_id,'collector_id',v_title.collector_id,'action',p_action)
    FROM public.profiles WHERE id=auth.uid();
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.set_receivable_payment_date(p_title_id uuid,p_payment_date date,p_expected_revision bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE; v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  PERFORM cf_private.require_receivable_finance('write');
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='P0002'; END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<>v_title.revision THEN
    RAISE EXCEPTION 'O título mudou. Atualize a tela antes de informar a data.' USING ERRCODE='40001';
  END IF;
  IF v_title.status<>'PENDING_VALIDATION' OR v_title.validation_status<>'PENDING' OR v_title.payment_source IS DISTINCT FROM 'IMPORTACAO_DIARIA'
    OR p_payment_date IS NULL OR p_payment_date<DATE '1900-01-01' OR p_payment_date>v_today THEN
    RAISE EXCEPTION 'Informe uma data real válida para o pagamento pendente da importação.' USING ERRCODE='23514';
  END IF;
  UPDATE public.receivable_titles SET payment_reported_date=p_payment_date WHERE id=p_title_id;
  INSERT INTO public.receivable_collection_events(title_id,collector_id,action,payment_date,created_by)
    VALUES(p_title_id,v_title.collector_id,'PAYMENT_DATE',p_payment_date,auth.uid());
END;
$$;

CREATE FUNCTION public.validate_receivable_payment(
 p_title_id uuid,p_decision text,p_payment_date date,p_observation text,p_expected_revision bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE; v_id uuid; v_delay integer; v_band text;
 v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812308);
  PERFORM cf_private.require_receivable_finance('validate');
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='P0002'; END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<>v_title.revision THEN
    RAISE EXCEPTION 'O título mudou. Atualize a tela antes de validar.' USING ERRCODE='40001';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('CONFIRM','NOT_LOCATED') OR length(coalesce(p_observation,''))>5000
    OR v_title.status<>'PENDING_VALIDATION' OR v_title.validation_status<>'PENDING'
    OR v_title.payment_source IS NULL THEN
    RAISE EXCEPTION 'O título precisa estar na fila de validação financeira.' USING ERRCODE='23514';
  END IF;
  IF p_decision='CONFIRM' THEN
    IF p_payment_date IS NULL OR p_payment_date<DATE '1900-01-01' OR p_payment_date>v_today THEN
      RAISE EXCEPTION 'Informe a data real do pagamento, até hoje.' USING ERRCODE='23514';
    END IF;
    v_delay:=greatest(0,p_payment_date-v_title.due_date);
    v_band:=CASE WHEN v_delay<=30 THEN 'ATE_30' WHEN v_delay<=60 THEN '31_60' WHEN v_delay<=90 THEN '61_90'
      WHEN v_delay<=180 THEN '91_180' WHEN v_delay<=365 THEN '181_365' ELSE 'ACIMA_365' END;
    INSERT INTO public.receivable_receipts(title_id,amount_cents,payment_date,delay_days,delay_band,collector_id,
      payment_source,reported_in_collection,validated_by)
      VALUES(p_title_id,v_title.amount_cents,p_payment_date,v_delay,v_band,v_title.collector_id,
        v_title.payment_source,v_title.reported_in_collection,auth.uid()) RETURNING id INTO v_id;
    UPDATE public.receivable_titles SET status='VALIDATED',validation_status='VALIDATED',payment_date=p_payment_date,
      next_action=NULL,next_action_date=NULL WHERE id=p_title_id;
  ELSE
    IF v_title.collector_id IS NULL THEN
      RAISE EXCEPTION 'Atribua uma cobradora antes de devolver o título para cobrança.' USING ERRCODE='23514';
    END IF;
    IF length(btrim(coalesce(p_observation,'')))=0 OR p_payment_date IS NOT NULL THEN
      RAISE EXCEPTION 'Informe o motivo e mantenha a data vazia para pagamento não localizado.' USING ERRCODE='23514';
    END IF;
    UPDATE public.receivable_titles SET status='NOT_LOCATED',validation_status='NONE',payment_source=NULL,
      payment_reported_date=NULL,payment_date=NULL,reported_in_collection=false,collector_locked=true,
      last_action='PAYMENT_NOT_LOCATED',next_action='RETRY',next_action_date=NULL WHERE id=p_title_id;
  END IF;
  INSERT INTO public.receivable_collection_events(title_id,collector_id,action,next_action,observation,payment_date,created_by)
    VALUES(p_title_id,v_title.collector_id,CASE WHEN p_decision='CONFIRM' THEN 'VALIDATE' ELSE 'PAYMENT_NOT_LOCATED' END,
      CASE WHEN p_decision='NOT_LOCATED' THEN 'RETRY' ELSE NULL END,nullif(btrim(p_observation),''),p_payment_date,auth.uid());
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    SELECT id,username,role_key,'contas_receber','receivable_validation',p_title_id::text,'VALIDATE',to_jsonb(v_title),
      jsonb_build_object('decision',p_decision,'receipt_id',v_id,'payment_date',p_payment_date,'observation',nullif(btrim(p_observation),''))
    FROM public.profiles WHERE id=auth.uid();
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.receivables_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_open numeric;v_overdue numeric;v_period numeric;v_count bigint;v_pending bigint;v_unassigned bigint;
 v_received numeric;v_latest timestamptz;v_bps numeric;
BEGIN
  IF NOT(cf_private.has_permission('contas_receber','read') OR cf_private.has_permission('painel','read')) THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>3660 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(sum(amount_cents),0),
    coalesce(sum(amount_cents) FILTER(WHERE due_date<(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date),0),
    coalesce(sum(amount_cents) FILTER(WHERE due_date BETWEEN p_start AND p_end),0),count(*),
    count(*) FILTER(WHERE validation_status='PENDING'),count(*) FILTER(WHERE collector_id IS NULL)
    INTO v_open,v_overdue,v_period,v_count,v_pending,v_unassigned FROM public.receivable_titles WHERE status<>'VALIDATED';
  SELECT coalesce(sum(amount_cents),0) INTO v_received FROM public.receivable_receipts
    WHERE validation='VALIDADO' AND payment_source='IMPORTACAO_DIARIA' AND payment_date BETWEEN p_start AND p_end;
  IF greatest(v_open,v_overdue,v_period,v_count,v_pending,v_unassigned,v_received)>9007199254740991 THEN
    RAISE EXCEPTION 'O consolidado excede o limite de precisão.' USING ERRCODE='22003';
  END IF;
  SELECT max(created_at) INTO v_latest FROM public.receivable_imports;
  v_bps:=CASE WHEN v_open=0 THEN NULL ELSE round(v_overdue*10000/v_open) END;
  RETURN jsonb_build_object('open_cents',v_open,'overdue_cents',v_overdue,'period_cents',v_period,
    'active_count',v_count,'pending_count',v_pending,'unassigned_count',v_unassigned,
    'received_period_cents',v_received,'latest_import_at',v_latest,'overdue_bps',v_bps,'overdue_comlurb_cents',NULL);
END;
$$;

REVOKE ALL ON TABLE public.receivable_collection_events,public.receivable_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.receivable_collection_events,public.receivable_receipts TO authenticated;
REVOKE ALL ON FUNCTION cf_private.require_receivable_finance(text),cf_private.require_collection_title(public.receivable_titles)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assign_receivable_collector(text,uuid,text),
 public.record_collection_action(uuid,text,date,text,date,text,text,date,bigint),
 public.set_receivable_payment_date(uuid,date,bigint),public.validate_receivable_payment(uuid,text,date,text,bigint),
 public.receivables_summary(date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assign_receivable_collector(text,uuid,text),
 public.record_collection_action(uuid,text,date,text,date,text,text,date,bigint),
 public.set_receivable_payment_date(uuid,date,bigint),public.validate_receivable_payment(uuid,text,date,text,bigint),
 public.receivables_summary(date,date) TO authenticated;
COMMENT ON TABLE public.receivable_receipts IS 'Recebimentos efetivamente validados. Valor e faixa na data real preservados; comissão futura somente quando reported_in_collection e VALIDADO.';
COMMENT ON TABLE public.receivable_collection_events IS 'Histórico imutável. Cobradora lê somente sua carteira e seus próprios eventos.';
INSERT INTO public.central_schema_migrations(version) VALUES('009_collections');

-- SOURCE: 010_bank_import.sql
-- Central Financeira: entrada centralizada de posições e extratos de apoio.
-- Aplicar uma única vez após 007. Não recria contas nem altera posições existentes.
-- Extratos são arquivos de APOIO: não são interpretados nem conciliados automaticamente.

CREATE FUNCTION public.save_bank_position(
  p_balance_date date, p_positions jsonb, p_observation text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row jsonb; v_account_id uuid; v_amount bigint; v_expected timestamptz;
  v_count integer; v_total numeric; v_actor public.profiles%ROWTYPE;
BEGIN
  -- Mesmo bloqueio de set_bank_balance e da administração de perfis.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('caixa','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_balance_date IS NULL OR p_balance_date < DATE '1900-01-01'
    OR p_balance_date > (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000
    OR p_positions IS NULL OR jsonb_typeof(p_positions) <> 'array' THEN
    RAISE EXCEPTION 'Informe data válida, todas as contas e uma observação de até 1.000 caracteres.' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM public.bank_accounts WHERE enabled ORDER BY id FOR UPDATE;
  SELECT count(*)::integer INTO v_count FROM public.bank_accounts WHERE enabled;
  IF v_count=0 OR jsonb_array_length(p_positions)<>v_count THEN
    RAISE EXCEPTION 'Informe um saldo explícito para cada conta ativa, sem repetir contas.' USING ERRCODE='23514';
  END IF;
  -- Valida o lote inteiro antes de chamar a rotina existente, inclusive precisão.
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_positions) LOOP
    IF jsonb_typeof(v_row)<>'object' THEN
      RAISE EXCEPTION 'Cada conta deve ser um registro com identificador, valor e versão anterior.' USING ERRCODE='23514';
    END IF;
    IF NOT (v_row ?& ARRAY['account_id','amount_cents','expected_updated_at'])
      OR (SELECT count(*) FROM jsonb_object_keys(v_row))<>3
      OR jsonb_typeof(v_row->'account_id')<>'string'
      OR jsonb_typeof(v_row->'amount_cents')<>'number'
      OR (v_row->>'amount_cents') !~ '^-?[0-9]+$'
      OR jsonb_typeof(v_row->'expected_updated_at') NOT IN ('null','string') THEN
      RAISE EXCEPTION 'Cada conta deve informar somente identificador, centavos inteiros e versão anterior.' USING ERRCODE='23514';
    END IF;
    IF (v_row->>'amount_cents')::numeric NOT BETWEEN -9007199254740991 AND 9007199254740991 THEN
      RAISE EXCEPTION 'O saldo de uma conta excede o limite seguro de representação.' USING ERRCODE='22003';
    END IF;
    BEGIN
      v_account_id := (v_row->>'account_id')::uuid;
      IF jsonb_typeof(v_row->'expected_updated_at')='string' THEN
        IF (v_row->>'expected_updated_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
          RAISE invalid_datetime_format;
        END IF;
        v_expected := (v_row->>'expected_updated_at')::timestamptz;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Identificador ou versão da conta inválidos. Atualize a tela.' USING ERRCODE='23514';
    END;
    IF NOT EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=v_account_id AND enabled) THEN
      RAISE EXCEPTION 'Uma das contas está indisponível. Atualize a tela.' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (value->>'account_id')::uuid) FROM jsonb_array_elements(p_positions))<>v_count THEN
    RAISE EXCEPTION 'Há contas repetidas ou ausentes na posição.' USING ERRCODE='23514';
  END IF;
  SELECT sum((value->>'amount_cents')::numeric) INTO v_total FROM jsonb_array_elements(p_positions);
  IF abs(v_total)>9007199254740991 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_positions) r
    JOIN public.bank_accounts a ON a.id=(r.value->>'account_id')::uuid
    GROUP BY a.company HAVING abs(sum((r.value->>'amount_cents')::numeric))>9007199254740991
  ) THEN
    RAISE EXCEPTION 'O total ou subtotal de uma empresa excede o limite seguro de representação.' USING ERRCODE='22003';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_positions) LOOP
    v_expected := CASE WHEN jsonb_typeof(v_row->'expected_updated_at')='null' THEN NULL
      ELSE (v_row->>'expected_updated_at')::timestamptz END;
    PERFORM public.set_bank_balance((v_row->>'account_id')::uuid,p_balance_date,
      (v_row->>'amount_cents')::bigint,btrim(p_observation),v_expected);
  END LOOP;
  -- Uma divergência de versão em qualquer conta reverte todo o lote e a auditoria.
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'caixa','bank_position',p_balance_date::text,'IMPORT',
      jsonb_build_object('position_date',p_balance_date,'total_cents',v_total,'account_count',v_count,
        'observation',btrim(p_observation),'source','MANUAL'));
  RETURN jsonb_build_object('position_date',p_balance_date,'total_cents',v_total,'account_count',v_count);
END;
$$;

CREATE TABLE public.bank_support_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 200),
  file_sha256 text NOT NULL UNIQUE CHECK(file_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 2097152),
  account_id uuid REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  reference_date date NOT NULL,
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX bank_support_files_reference ON public.bank_support_files(reference_date DESC,created_at DESC,id DESC);
CREATE TABLE cf_private.bank_support_bytes (
  file_id uuid PRIMARY KEY REFERENCES public.bank_support_files(id) ON DELETE RESTRICT,
  file_bytes bytea NOT NULL CHECK(octet_length(file_bytes) BETWEEN 1 AND 2097152)
);
ALTER TABLE public.bank_support_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_private.bank_support_bytes ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_support_files_read ON public.bank_support_files FOR SELECT TO authenticated
  USING(cf_private.has_permission('caixa','read'));

CREATE FUNCTION cf_private.protect_bank_support() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Arquivos de apoio e seus registros são imutáveis.' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER bank_support_metadata_immutable BEFORE UPDATE OR DELETE ON public.bank_support_files
  FOR EACH ROW EXECUTE FUNCTION cf_private.protect_bank_support();
CREATE TRIGGER bank_support_content_immutable BEFORE UPDATE OR DELETE ON cf_private.bank_support_bytes
  FOR EACH ROW EXECUTE FUNCTION cf_private.protect_bank_support();

CREATE FUNCTION public.register_bank_support(
  p_file_name text,p_file_sha256 text,p_file_base64 text,p_account_id uuid,
  p_reference_date date,p_description text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_bytes bytea; v_id uuid; v_actor public.profiles%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('caixa','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 200
    OR p_file_name ~ '[/\\[:cntrl:]]' OR btrim(p_file_name) !~* '^.+\.(xlsx|xlsm|xls|csv|ofx|pdf)$'
    OR p_file_sha256 IS NULL OR p_file_sha256 !~ '^[a-f0-9]{64}$'
    OR p_file_base64 IS NULL OR length(p_file_base64) NOT BETWEEN 4 AND 2796204
    OR p_file_base64 !~ '^[A-Za-z0-9+/]+={0,2}$'
    OR p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01'
    OR p_reference_date>(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe arquivo de apoio válido de até 2 MiB, data e descrição de até 1.000 caracteres.' USING ERRCODE='23514';
  END IF;
  BEGIN
    v_bytes := decode(p_file_base64,'base64');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'O arquivo de apoio não pôde ser lido. Nenhum dado foi alterado.' USING ERRCODE='23514';
  END;
  IF octet_length(v_bytes) NOT BETWEEN 1 AND 2097152
    OR replace(encode(v_bytes,'base64'),E'\n','')<>p_file_base64
    OR encode(sha256(v_bytes),'hex')<>p_file_sha256 THEN
    RAISE EXCEPTION 'O tamanho ou a integridade do arquivo de apoio é inválido.' USING ERRCODE='23514';
  END IF;
  IF p_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=p_account_id AND enabled) THEN
    RAISE EXCEPTION 'Conta bancária indisponível.' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.bank_support_files WHERE file_sha256=p_file_sha256) THEN
    RAISE EXCEPTION 'Este arquivo de apoio já foi registrado.' USING ERRCODE='23505';
  END IF;
  INSERT INTO public.bank_support_files(file_name,file_sha256,size_bytes,account_id,reference_date,description,created_by)
    VALUES(btrim(p_file_name),p_file_sha256,octet_length(v_bytes),p_account_id,p_reference_date,btrim(p_description),auth.uid())
    RETURNING id INTO v_id;
  INSERT INTO cf_private.bank_support_bytes(file_id,file_bytes) VALUES(v_id,v_bytes);
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'caixa','bank_support_files',v_id::text,'IMPORT',
      jsonb_build_object('file_name',btrim(p_file_name),'file_sha256',p_file_sha256,'size_bytes',octet_length(v_bytes),
        'account_id',p_account_id,'reference_date',p_reference_date,'description',btrim(p_description),'purpose','SUPPORT_ONLY'));
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.download_bank_support(p_file_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT cf_private.has_permission('caixa','read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object('file_name',f.file_name,'file_base64',replace(encode(b.file_bytes,'base64'),E'\n',''))
    INTO v_result FROM public.bank_support_files f JOIN cf_private.bank_support_bytes b ON b.file_id=f.id
    WHERE f.id=p_file_id;
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Arquivo de apoio indisponível.' USING ERRCODE='P0002';
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON TABLE public.bank_support_files,cf_private.bank_support_bytes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.bank_support_files TO authenticated;
REVOKE ALL ON FUNCTION cf_private.protect_bank_support() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.save_bank_position(date,jsonb,text),
  public.register_bank_support(text,text,text,uuid,date,text),public.download_bank_support(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_bank_position(date,jsonb,text),
  public.register_bank_support(text,text,text,uuid,date,text),public.download_bank_support(uuid) TO authenticated;
COMMENT ON TABLE public.bank_support_files IS 'Arquivo original privado de apoio. Registrar não altera saldos, não importa movimentos e não concilia pagamentos.';
COMMENT ON TABLE cf_private.bank_support_bytes IS 'Arquivo original imutável. Sem acesso direto; download autenticado exige caixa.read e sessão aprovada.';
COMMENT ON FUNCTION public.save_bank_position(date,jsonb,text) IS 'Salva todas as contas ativas de uma data em uma única transação. Zero deve ser explícito; versões da mesma data são obrigatórias.';
INSERT INTO public.central_schema_migrations(version) VALUES('010_bank_import');

-- SOURCE: 011_receivables_positions.sql
-- Add current receivables to new snapshots; historical positions are immutable.

ALTER TABLE public.director_positions ALTER COLUMN schema_version SET DEFAULT '0.4.0';

CREATE OR REPLACE FUNCTION public.save_director_position(p_start date,p_end date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cash jsonb; v_payables jsonb; v_stock jsonb; v_receivables jsonb; v_data jsonb;
  v_id uuid; v_profile public.profiles%ROWTYPE; v_projected numeric;
  v_missing jsonb := '["fechamento","parametros_financeiros","classificacao_comlurb"]'::jsonb;
BEGIN
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('resumo_diretoria','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>366 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(2045812307);
  SELECT public.cash_position((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date),
         public.payables_summary(p_start,p_end),public.current_stock(),public.receivables_summary(p_start,p_end)
    INTO v_cash,v_payables,v_stock,v_receivables;
  IF v_cash->>'total_cents' IS NULL THEN v_missing:=v_missing||'["saldos_bancarios"]'::jsonb; END IF;
  IF v_stock->>'value_cents' IS NULL THEN v_missing:=v_missing||'["estoque"]'::jsonb; END IF;
  IF v_payables->>'latest_import_at' IS NULL THEN v_missing:=v_missing||'["contas_pagar"]'::jsonb; END IF;
  IF v_receivables->>'latest_import_at' IS NULL THEN v_missing:=v_missing||'["contas_receber"]'::jsonb; END IF;
  IF v_cash->>'total_cents' IS NOT NULL AND v_payables->>'latest_import_at' IS NOT NULL
      AND v_receivables->>'latest_import_at' IS NOT NULL THEN
    v_projected:=(v_cash->>'total_cents')::numeric+(v_receivables->>'period_cents')::numeric-(v_payables->>'period_cents')::numeric;
    IF abs(v_projected)>9007199254740991 THEN
      RAISE EXCEPTION 'A projeção excede o limite de precisão.' USING ERRCODE='22003';
    END IF;
  END IF;
  v_data:=jsonb_build_object(
    'cash_cents',v_cash->'total_cents','cash_reported_accounts',v_cash->'reported_accounts',
    'cash_expected_accounts',v_cash->'expected_accounts',
    'cash_as_of_date',(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    'payable_open_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'open_cents' END,
    'payable_period_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'period_cents' END,
    'payable_overdue_cents',CASE WHEN v_payables->>'latest_import_at' IS NULL THEN NULL ELSE v_payables->'overdue_cents' END,
    'payable_import_at',v_payables->'latest_import_at',
    'stock_cents',v_stock->'value_cents','stock_reference_date',v_stock->'reference_date','stock_source',v_stock->'source',
    'receivable_cents',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'open_cents' END,
    'receivable_period_cents',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'period_cents' END,
    'receivable_overdue_cents',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'overdue_cents' END,
    'receivable_overdue_bps',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'overdue_bps' END,
    'receivable_received_period_cents',CASE WHEN v_receivables->>'latest_import_at' IS NULL THEN NULL ELSE v_receivables->'received_period_cents' END,
    'receivable_import_at',v_receivables->'latest_import_at',
    'turnover_cents',NULL,'projected_cash_cents',v_projected,'current_assets_millions',NULL,
    'complete',false,'missing_sources',v_missing);
  INSERT INTO public.director_positions(created_by,period_start,period_end,indicators,schema_version)
    VALUES(auth.uid(),p_start,p_end,v_data,'0.4.0') RETURNING id INTO v_id;
  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_profile.id,v_profile.username,v_profile.role_key,'resumo_diretoria','director_positions',v_id::text,'CREATE',
      jsonb_build_object('period_start',p_start,'period_end',p_end,'indicators',v_data,'schema_version','0.4.0'));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_director_position(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_director_position(date,date) TO authenticated;
INSERT INTO public.central_schema_migrations(version) VALUES('011_receivables_positions');

COMMIT;
