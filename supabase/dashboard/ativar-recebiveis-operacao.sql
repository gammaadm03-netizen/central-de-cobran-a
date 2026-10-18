-- CENTRAL FINANCEIRA — ativação da operação de Contas a Receber e Cobrança (022 a 026).
-- Copie o arquivo inteiro no SQL Editor. Uma transação: falha desfaz toda a ativação.
-- Pode ser executado novamente: pula versões já registradas, sem refazer dados.
-- Preserva usuários, títulos, responsáveis, recebimentos, saldos, arquivos e históricos.
-- Exige a base de Contas a Receber e Cobrança até 009; não depende de CP 010 a 021.
-- Não executa importação de planilhas nem deploy de funções.
BEGIN;

DO $cf_receivables_activation_base$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('central-financeira:receivables-activation',0));
  IF pg_catalog.to_regclass('public.central_schema_migrations') IS NULL
    OR pg_catalog.to_regclass('public.profiles') IS NULL
    OR pg_catalog.to_regclass('public.audit_events') IS NULL
    OR pg_catalog.to_regclass('cf_private.approved_sessions') IS NULL
    OR pg_catalog.to_regclass('public.receivable_imports') IS NULL
    OR pg_catalog.to_regclass('public.receivable_titles') IS NULL
    OR pg_catalog.to_regclass('public.receivable_receipts') IS NULL
    OR pg_catalog.to_regclass('public.receivable_collection_events') IS NULL
    OR pg_catalog.to_regclass('public.collection_agents') IS NULL
    OR pg_catalog.to_regclass('public.collector_bindings') IS NULL
    OR pg_catalog.to_regclass('cf_private.receivable_import_files') IS NULL
    OR pg_catalog.to_regprocedure('cf_private.has_permission(text,text)') IS NULL
    OR pg_catalog.to_regprocedure('cf_private.require_receivable_finance(text)') IS NULL THEN
    RAISE EXCEPTION 'A base de Contas a Receber e Cobrança está incompleta. Ative a base até a atualização 009 antes desta operação; nenhum dado foi alterado.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='009_collections') THEN
    RAISE EXCEPTION 'A atualização 009_collections não está registrada. Confira a base de Cobrança antes desta operação; nenhum dado foi alterado.' USING ERRCODE='22023';
  END IF;
END;
$cf_receivables_activation_base$;

-- SOURCE: 022_collections_overdue_only.sql
DO $cf_cr_apply_022_ee5e229a7c191f2f_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='022_collections_overdue_only') THEN
    RAISE NOTICE 'Atualização 022_collections_overdue_only já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_cr_source_022_ec56cacd099a6cee_0$
-- SOURCE BODY: 022_collections_overdue_only.sql
-- Cobrança acompanha somente títulos vencidos; CR mantém a carteira completa.
-- Aplicar uma única vez após 009_collections. Não depende das migrations de CP.
-- Nenhum título, vínculo, recebimento ou histórico é excluído ou reclassificado.


DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative Contas a Receber e Cobrança antes desta atualização.' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='009_collections') THEN
  RAISE EXCEPTION 'Ative a atualização 009 de Cobrança antes desta atualização.' USING ERRCODE='22023';
 END IF;
END $$;

-- Mesmo uma consulta direta à tabela não expõe títulos a vencer à cobradora.
-- A leitura financeira e a leitura da Diretoria permanecem completas.
DROP POLICY receivable_titles_read ON public.receivable_titles;
CREATE POLICY receivable_titles_read ON public.receivable_titles FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read') OR (
   cf_private.has_permission('cobranca','read')
   AND collector_id=cf_private.current_collector_id()
   AND due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date));

-- A tela de Cobrança usa esta visão para todos os perfis, inclusive CR e Diretoria.
-- security_invoker conserva as permissões e a RLS da tabela de origem.
CREATE VIEW public.collection_overdue_titles WITH (security_invoker=true,security_barrier=true) AS
 SELECT t.*,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS collection_as_of_date
 FROM public.receivable_titles t
 WHERE t.due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
REVOKE ALL ON TABLE public.collection_overdue_titles FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.collection_overdue_titles TO authenticated;
COMMENT ON VIEW public.collection_overdue_titles IS
 'Cobrança: somente vencimento anterior ao dia oficial de São Paulo. Inclui histórico validado quando solicitado; a carteira ativa filtra status diferente de VALIDATED. Não altera a carteira completa de CR.';

-- Protege também chamadas manuais à API por Gerência, CR ou cobradoras.
-- A validação financeira em CR permanece independente do vencimento.
CREATE OR REPLACE FUNCTION cf_private.require_collection_title(p_title public.receivable_titles) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_title.due_date IS NULL
   OR p_title.due_date>=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
   OR NOT cf_private.has_permission('cobranca','write') OR NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND (
     p.role_key IN ('gerente_geral','contas_receber') OR
     (p.role_key IN ('cobradora_1','cobradora_2') AND p_title.collector_id IS NOT NULL
      AND p_title.collector_id=cf_private.current_collector_id()))) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION cf_private.require_collection_title(public.receivable_titles)
 FROM PUBLIC,anon,authenticated,service_role;

INSERT INTO public.central_schema_migrations(version) VALUES('022_collections_overdue_only');
-- END SOURCE BODY: 022_collections_overdue_only.sql
$cf_cr_source_022_ec56cacd099a6cee_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='022_collections_overdue_only') THEN
      RAISE EXCEPTION 'A atualização 022_collections_overdue_only não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_cr_apply_022_ee5e229a7c191f2f_0$;

-- SOURCE: 023_receivable_sync.sql
DO $cf_cr_apply_023_1687486642ac7f8f_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='023_receivable_sync') THEN
    RAISE NOTICE 'Atualização 023_receivable_sync já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_cr_source_023_b27e5c0bb14786c1_0$
-- SOURCE BODY: 023_receivable_sync.sql
-- Sincronização incremental de parcelas sem inferir recebimento por ausência.
-- A identidade não contém valor. Mudança de vencimento exige vínculo explícito.

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
-- END SOURCE BODY: 023_receivable_sync.sql
$cf_cr_source_023_b27e5c0bb14786c1_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='023_receivable_sync') THEN
      RAISE EXCEPTION 'A atualização 023_receivable_sync não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_cr_apply_023_1687486642ac7f8f_0$;

-- SOURCE: 024_receivable_received_import.sql
DO $cf_cr_apply_024_a0ca990efcd8ab0d_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='024_receivable_received_import') THEN
    RAISE NOTICE 'Atualização 024_receivable_received_import já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_cr_source_024_bbb69bd619d336f6_0$
-- SOURCE BODY: 024_receivable_received_import.sql
-- Quitações do ERP: nominal e efetivamente recebido são valores independentes.
-- A declaração de quitação encerra o título, inclusive antecipações e diferenças.
-- Preserva recebimentos originais; correções de importação acrescentam versões.

DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative Contas a Receber antes desta atualização.' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='023_receivable_sync') THEN
  RAISE EXCEPTION 'Ative a atualização 023 antes da importação de quitações.' USING ERRCODE='22023';
 END IF;
END $$;

CREATE TABLE public.receivable_receipt_import_provenance(
 receipt_id uuid PRIMARY KEY REFERENCES public.receivable_receipts(id) ON DELETE RESTRICT,
 first_import_id uuid NOT NULL REFERENCES public.receivable_imports(id) ON DELETE RESTRICT,
 nominal_amount_cents bigint NOT NULL CHECK(nominal_amount_cents BETWEEN 0 AND 9007199254740991),
 original_due_date date NOT NULL,
 created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.receivable_receipt_adjustments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 receipt_id uuid NOT NULL REFERENCES public.receivable_receipt_import_provenance(receipt_id) ON DELETE RESTRICT,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
 nominal_amount_cents bigint NOT NULL CHECK(nominal_amount_cents BETWEEN 0 AND 9007199254740991),
 original_due_date date NOT NULL,payment_date date NOT NULL,
 delay_days integer NOT NULL CHECK(delay_days>=0),
 delay_band text NOT NULL CHECK(delay_band IN ('ATE_30','31_60','61_90','91_180','181_365','ACIMA_365')),
 collector_id uuid REFERENCES public.collection_agents(id) ON DELETE RESTRICT,
 import_id uuid NOT NULL REFERENCES public.receivable_imports(id) ON DELETE RESTRICT,
 created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(receipt_id,revision)
);
CREATE TABLE public.receivable_received_import_rows(
 import_id uuid NOT NULL REFERENCES public.receivable_imports(id) ON DELETE RESTRICT,
 title_id uuid NOT NULL REFERENCES public.receivable_titles(id) ON DELETE RESTRICT,
 receipt_id uuid NOT NULL REFERENCES public.receivable_receipts(id) ON DELETE RESTRICT,
 outcome text NOT NULL CHECK(outcome IN ('NEW_RECEIPT','MATCHED','CORRECTION','HISTORICAL')),
 receipt_revision bigint NOT NULL CHECK(receipt_revision BETWEEN 0 AND 9007199254740991),
 source_row jsonb NOT NULL,
 PRIMARY KEY(import_id,title_id)
);
CREATE INDEX receivable_adjustments_latest ON public.receivable_receipt_adjustments(receipt_id,revision DESC);
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['receivable_receipt_import_provenance','receivable_receipt_adjustments','receivable_received_import_rows'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated',v_table);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes()',v_table||'_immutable',v_table);
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION cf_private.bump_receivables_sync_revision()',v_table||'_revision',v_table);
 END LOOP;
END $$;
CREATE POLICY receipt_import_provenance_read ON public.receivable_receipt_import_provenance FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read') OR EXISTS(
  SELECT 1 FROM public.receivable_receipts r WHERE r.id=receipt_id));
CREATE POLICY receipt_adjustments_read ON public.receivable_receipt_adjustments FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read') OR EXISTS(
  SELECT 1 FROM public.receivable_receipts r WHERE r.id=receipt_id));
CREATE POLICY received_import_rows_read ON public.receivable_received_import_rows FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_receber','read'));
CREATE FUNCTION cf_private.audit_receivable_received_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;BEGIN
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
  VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_receber',TG_TABLE_NAME,
   coalesce(to_jsonb(NEW)->>'id',to_jsonb(NEW)->>'receipt_id'),'IMPORT',to_jsonb(NEW));
 RETURN NEW;
END $$;
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['receivable_receipt_import_provenance','receivable_receipt_adjustments','receivable_received_import_rows'] LOOP
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION cf_private.audit_receivable_received_import()',v_table||'_audit',v_table);
 END LOOP;
END $$;

CREATE VIEW public.effective_receivable_receipts WITH(security_invoker=true,security_barrier=true) AS
 SELECT r.id,r.title_id,coalesce(a.amount_cents,r.amount_cents) AS amount_cents,
  coalesce(a.payment_date,r.payment_date) AS payment_date,
  coalesce(a.delay_days,r.delay_days) AS delay_days,coalesce(a.delay_band,r.delay_band) AS delay_band,
  CASE WHEN a.id IS NOT NULL THEN a.collector_id ELSE r.collector_id END AS collector_id,
  r.payment_source,r.reported_in_collection,r.validation,
  coalesce(a.created_by,r.validated_by) AS validated_by,coalesce(a.created_at,r.validated_at) AS validated_at,
  coalesce(a.nominal_amount_cents,p.nominal_amount_cents,r.amount_cents) AS nominal_amount_cents,
  coalesce(a.original_due_date,p.original_due_date) AS original_due_date,
  p.first_import_id,coalesce(a.import_id,p.first_import_id) AS latest_import_id,
  CASE WHEN p.receipt_id IS NULL THEN 'MANUAL_VALIDATION' ELSE 'ERP_RECEIVED' END AS source_kind,
  coalesce(a.revision,0::bigint) AS receipt_revision,
  r.amount_cents AS original_received_amount_cents,r.payment_date AS original_payment_date
 FROM public.receivable_receipts r
 LEFT JOIN public.receivable_receipt_import_provenance p ON p.receipt_id=r.id
 LEFT JOIN LATERAL(SELECT x.* FROM public.receivable_receipt_adjustments x WHERE x.receipt_id=r.id ORDER BY x.revision DESC LIMIT 1) a ON true;
REVOKE ALL ON TABLE public.effective_receivable_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.effective_receivable_receipts TO authenticated;
COMMENT ON VIEW public.effective_receivable_receipts IS
 'Recebimentos validados efetivos. amount_cents é o valor realmente recebido; nominal_amount_cents permanece separado. Revisões de ERP são acrescentadas sem alterar o recebimento original.';

CREATE FUNCTION cf_private.require_receivable_received_import() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM cf_private.require_receivable_finance('validate');
 IF NOT cf_private.has_permission('contas_receber','read')
  OR NOT cf_private.has_permission('contas_receber','write')
  OR NOT cf_private.has_permission('contas_receber','import') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION public.receivables_management_summary(p_day date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_day date:=coalesce(p_day,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date);
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_latest public.receivable_imports%ROWTYPE;v_open numeric;v_overdue numeric;v_day_received numeric;v_month_received numeric;v_count bigint;
BEGIN
 IF NOT(cf_private.has_permission('painel','read') OR cf_private.has_permission('contas_receber','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF v_day<DATE '1900-01-01' OR v_day>v_today THEN
  RAISE EXCEPTION 'Informe uma data válida até hoje.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_latest FROM public.receivable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_latest.id IS NOT NULL THEN
  SELECT coalesce(sum(amount_cents),0),coalesce(sum(amount_cents) FILTER(WHERE due_date<v_today),0),count(*)
   INTO v_open,v_overdue,v_count FROM public.receivable_titles WHERE scope='grupo-consolidado' AND status<>'VALIDATED';
  SELECT coalesce(sum(amount_cents) FILTER(WHERE payment_date=v_day),0),coalesce(sum(amount_cents),0)
   INTO v_day_received,v_month_received FROM public.effective_receivable_receipts
   WHERE validation='VALIDADO' AND payment_date>=date_trunc('month',v_day)::date
    AND payment_date<(date_trunc('month',v_day)+interval '1 month')::date;
  IF greatest(v_open,v_overdue,v_count,v_day_received,v_month_received)>9007199254740991 THEN
   RAISE EXCEPTION 'O consolidado excede o limite de precisão.' USING ERRCODE='22003';END IF;
 END IF;
 RETURN jsonb_build_object('as_of_date',v_today,'received_date',v_day,'open_cents',v_open,'overdue_cents',v_overdue,
  'received_day_cents',v_day_received,'received_month_cents',v_month_received,'active_count',v_count,
  'latest_import_at',v_latest.created_at,'latest_import_id',v_latest.id);
END $$;

CREATE FUNCTION public.receivable_commission_base(p_start date,p_end date,p_collector_id uuid DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_collector uuid;v_role text;v_rows jsonb;v_collectors jsonb;v_total numeric;v_eligible numeric;v_count bigint;v_unassigned bigint;
BEGIN
 IF NOT cf_private.has_permission('comissoes','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end>DATE '2199-12-31'
  OR p_end<p_start OR p_end-p_start>3660 OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Período ou paginação inválida.' USING ERRCODE='22023';END IF;
 SELECT role_key INTO v_role FROM public.profiles WHERE id=auth.uid() AND enabled;
 IF v_role IN ('cobradora_1','cobradora_2') THEN
  v_collector:=cf_private.current_collector_id();
  IF v_collector IS NULL OR (p_collector_id IS NOT NULL AND p_collector_id<>v_collector) THEN
   RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 ELSE v_collector:=p_collector_id;
 END IF;
 IF p_collector_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=p_collector_id) THEN
  RAISE EXCEPTION 'Cobradora inválida.' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'display_name',display_name) ORDER BY display_name,id),'[]'::jsonb)
  INTO v_collectors FROM(SELECT id,display_name FROM public.collection_agents
   WHERE v_role NOT IN ('cobradora_1','cobradora_2') OR id=v_collector ORDER BY display_name,id LIMIT 1000) c;
 SELECT count(*),coalesce(sum(r.amount_cents),0),count(*) FILTER(WHERE r.collector_id IS NULL),
  coalesce(sum(r.amount_cents) FILTER(WHERE r.collector_id IS NOT NULL AND r.delay_days>0),0)
  INTO v_count,v_total,v_unassigned,v_eligible FROM public.effective_receivable_receipts r
  JOIN public.receivable_titles t ON t.id=r.title_id
  WHERE r.validation='VALIDADO' AND t.status='VALIDATED' AND r.payment_date BETWEEN p_start AND p_end
   AND (v_collector IS NULL OR r.collector_id=v_collector);
 IF greatest(v_count,v_total,v_unassigned,v_eligible)>9007199254740991 THEN
  RAISE EXCEPTION 'A base de recebimentos excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT coalesce(jsonb_agg(item ORDER BY payment_date DESC,receipt_id),'[]'::jsonb) INTO v_rows FROM(
  SELECT r.payment_date,r.id AS receipt_id,jsonb_build_object('receipt_id',r.id,'title_id',t.id,'document',t.document,
   'client_name',t.client_name,'branch',t.branch,'due_date',coalesce(r.original_due_date,t.due_date),'payment_date',r.payment_date,
   'amount_cents',r.amount_cents,'nominal_amount_cents',r.nominal_amount_cents,'collector_id',r.collector_id,
   'collector_name',c.display_name,'delay_days',r.delay_days,'delay_band',r.delay_band,'payment_source',r.payment_source,
   'base_cents',r.amount_cents,'eligibility',CASE WHEN r.collector_id IS NULL THEN 'PENDENTE_RESPONSAVEL'
    WHEN r.delay_days=0 THEN 'RECEBIDO_EM_DIA' ELSE 'BASE_DISPONIVEL' END) AS item
  FROM public.effective_receivable_receipts r JOIN public.receivable_titles t ON t.id=r.title_id
  LEFT JOIN public.collection_agents c ON c.id=r.collector_id
  WHERE r.validation='VALIDADO' AND t.status='VALIDATED' AND r.payment_date BETWEEN p_start AND p_end
   AND (v_collector IS NULL OR r.collector_id=v_collector)
  ORDER BY r.payment_date DESC,r.id OFFSET p_offset LIMIT p_limit
 ) page;
 RETURN jsonb_build_object('rows',v_rows,'count',v_count,'total_received_cents',v_total,'unassigned_count',v_unassigned,
  'eligible_base_cents',v_eligible,'rule_status','AGUARDANDO_REGRAS','collectors',v_collectors);
END $$;

CREATE FUNCTION cf_private.normalize_receivable_received_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_bases jsonb:='[]'::jsonb;v_normalized jsonb;v_date date;v_amount numeric;v_total numeric:=0;v_result jsonb;
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Informe de 1 a 5.000 quitações.' USING ERRCODE='22023';END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(v_row)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_row) k
   WHERE k NOT IN ('document','client_name','client_document','branch','issued_on','due_date','amount_cents','received_on','received_amount_cents')) THEN
   RAISE EXCEPTION 'Estrutura de quitação inválida.' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(v_row->'received_on') IS DISTINCT FROM 'string' OR v_row->>'received_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
   RAISE EXCEPTION 'Informe a data real do recebimento.' USING ERRCODE='22023';END IF;
  BEGIN v_date:=(v_row->>'received_on')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION 'Data real do recebimento inválida.' USING ERRCODE='22023';END;
  IF v_date<DATE '1900-01-01' OR v_date>v_today THEN
   RAISE EXCEPTION 'O recebimento precisa ter data real até hoje.' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(v_row->'received_amount_cents') IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'Informe o valor realmente recebido em centavos.' USING ERRCODE='22023';END IF;
  v_amount:=(v_row->>'received_amount_cents')::numeric;
  IF v_amount<>trunc(v_amount) OR v_amount<=0 OR v_amount>9007199254740991 THEN
   RAISE EXCEPTION 'O valor recebido deve ser positivo e exato.' USING ERRCODE='22023';END IF;
  v_total:=v_total+v_amount;
  IF v_total>9007199254740991 THEN RAISE EXCEPTION 'O total recebido excede o limite de precisão.' USING ERRCODE='22003';END IF;
  v_bases:=v_bases||jsonb_build_array(v_row-'received_on'-'received_amount_cents');
 END LOOP;
 v_normalized:=cf_private.normalize_receivable_sync_rows(p_scope,v_bases);
 SELECT jsonb_agg(n.value||jsonb_build_object('received_on',p_rows->(n.ordinality::integer-1)->>'received_on',
  'received_amount_cents',(p_rows->(n.ordinality::integer-1)->>'received_amount_cents')::bigint) ORDER BY n.ordinality)
  INTO v_result FROM jsonb_array_elements(v_normalized) WITH ORDINALITY n(value,ordinality);
 RETURN v_result;
END $$;

CREATE FUNCTION cf_private.preview_receivable_received_rows(p_scope text,p_rows jsonb,p_title_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_row jsonb;v_result jsonb[]:='{}';v_title public.receivable_titles%ROWTYPE;
 v_receipt public.effective_receivable_receipts%ROWTYPE;v_outcome text;v_problem text;v_owner uuid;v_owners integer;
 v_new integer;v_received integer;v_matched integer;v_corrected integer;v_conflicts integer;v_errors jsonb;v_previous uuid;
BEGIN
 v_rows:=cf_private.resolve_receivable_sync_rows(p_scope,cf_private.normalize_receivable_received_rows(p_scope,p_rows),p_title_mappings,'received');
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
  v_title:=NULL;v_receipt:=NULL;v_owner:=NULL;v_problem:=v_row->>'problem';v_outcome:=v_row->>'outcome';
  IF v_outcome NOT IN ('AMBIGUOUS','CONFLICT') THEN
   IF v_row->>'title_id' IS NULL THEN
    SELECT count(DISTINCT collector_id),min(collector_id::text)::uuid INTO v_owners,v_owner
     FROM public.receivable_titles WHERE scope=p_scope AND customer_key=v_row->>'customer_key'
      AND status<>'VALIDATED' AND collector_id IS NOT NULL;
    IF v_owners>1 THEN
     v_outcome:='CONFLICT';v_problem:='O cliente possui dívida ativa em carteiras diferentes. Confira a responsável antes de importar.';
    ELSE v_outcome:='HISTORICAL';END IF;
   ELSE
    SELECT * INTO v_title FROM public.receivable_titles WHERE id=(v_row->>'title_id')::uuid;
    v_owner:=v_title.collector_id;
    SELECT * INTO v_receipt FROM public.effective_receivable_receipts WHERE title_id=v_title.id;
    IF v_receipt.id IS NULL THEN v_outcome:='NEW_RECEIPT';
    ELSIF v_receipt.source_kind='MANUAL_VALIDATION' AND (
      v_receipt.amount_cents<>(v_row->>'received_amount_cents')::bigint
      OR v_receipt.payment_date<>(v_row->>'received_on')::date
      OR v_title.amount_cents<>(v_row->>'amount_cents')::bigint OR v_title.due_date<>(v_row->>'due_date')::date) THEN
     v_outcome:='CONFLICT';v_problem:='O recebimento validado manualmente difere da quitação importada. O registro manual foi preservado.';
    ELSIF v_receipt.amount_cents<>(v_row->>'received_amount_cents')::bigint
      OR v_receipt.payment_date<>(v_row->>'received_on')::date
      OR v_receipt.nominal_amount_cents<>(v_row->>'amount_cents')::bigint
      OR coalesce(v_receipt.original_due_date,v_title.due_date)<>(v_row->>'due_date')::date THEN v_outcome:='CORRECTION';
    ELSE v_outcome:='MATCHED';END IF;
   END IF;
  END IF;
  v_result:=array_append(v_result,v_row||jsonb_build_object('identity_outcome',v_row->>'outcome','outcome',v_outcome,
   'problem',v_problem,'receipt_id',v_receipt.id,'receipt_revision',v_receipt.receipt_revision,'collector_id',v_owner,
   'nominal_amount_cents',(v_row->>'amount_cents')::bigint));
 END LOOP;
 v_rows:=to_jsonb(v_result);
 SELECT count(*) FILTER(WHERE r->>'outcome'='HISTORICAL'),
  count(*) FILTER(WHERE r->>'outcome' IN ('NEW_RECEIPT','HISTORICAL')),
  count(*) FILTER(WHERE r->>'outcome'='MATCHED'),count(*) FILTER(WHERE r->>'outcome'='CORRECTION'),
  count(*) FILTER(WHERE r->>'outcome' IN ('AMBIGUOUS','CONFLICT'))
  INTO v_new,v_received,v_matched,v_corrected,v_conflicts FROM jsonb_array_elements(v_rows) r;
 SELECT coalesce(jsonb_agg(jsonb_build_object('line',(r->>'line')::integer,'column','Título / quitação',
  'problem',r->>'problem','correction',CASE WHEN r->>'outcome'='AMBIGUOUS'
   THEN 'Escolha a parcela existente ou confirme uma nova parcela e analise novamente.'
   ELSE 'Confira a divergência na origem ou com o financeiro antes de importar.' END) ORDER BY (r->>'line')::integer),'[]'::jsonb)
  INTO v_errors FROM jsonb_array_elements(v_rows) r WHERE r->>'outcome' IN ('AMBIGUOUS','CONFLICT');
 SELECT id INTO v_previous FROM public.receivable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN jsonb_build_object('mode','received','previous_import_id',v_previous,'financial_revision',cf_private.receivables_sync_revision_value(),
  'row_count',jsonb_array_length(v_rows),'new_count',v_new,'received_count',v_received,'matched_count',v_matched,
  'correction_count',v_corrected,'historical_count',v_new,'conflict_count',v_conflicts,'can_commit',v_conflicts=0,'errors',v_errors,'rows',v_rows);
END $$;
CREATE FUNCTION public.preview_receivables_received_import(p_scope text,p_rows jsonb,p_title_mappings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM cf_private.require_receivable_received_import();
 RETURN cf_private.preview_receivable_received_rows(p_scope,p_rows,p_title_mappings);
END $$;

CREATE FUNCTION public.commit_receivables_received_import_from_gateway(
 p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_title_mappings jsonb,
 p_previous_import_id uuid DEFAULT NULL,p_previous_financial_revision text DEFAULT NULL,p_confirm_corrections boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_file bytea;v_preview jsonb;v_previous uuid;v_import uuid:=gen_random_uuid();v_existing uuid;v_result jsonb;
 v_row jsonb;v_title public.receivable_titles%ROWTYPE;v_receipt public.effective_receivable_receipts%ROWTYPE;
 v_id uuid;v_receipt_id uuid;v_revision bigint;v_delay integer;v_band text;v_source text;v_reported boolean;
 v_new integer;v_open integer;v_validated integer;
BEGIN
 PERFORM cf_private.set_receivable_sync_actor(p_user_id,p_session_id);
 PERFORM cf_private.require_receivable_received_import();
 v_file:=cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 PERFORM pg_advisory_xact_lock(2045812308);
 SELECT i.id,s.result INTO v_existing,v_result FROM public.receivable_imports i JOIN public.receivable_sync_imports s ON s.import_id=i.id
  WHERE i.scope=p_scope AND i.file_sha256=p_file_sha256 AND i.import_mode='RECEIVED' AND s.mode='RECEIVED';
 IF v_existing IS NOT NULL THEN RETURN v_result||jsonb_build_object('idempotent',true);END IF;
 SELECT id INTO v_previous FROM public.receivable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_previous IS DISTINCT FROM p_previous_import_id OR p_previous_financial_revision IS NULL
  OR length(p_previous_financial_revision)>256 OR p_previous_financial_revision IS DISTINCT FROM cf_private.receivables_sync_revision_value() THEN
  RAISE EXCEPTION 'A base financeira mudou. Analise novamente antes de confirmar as quitações.' USING ERRCODE='40001';END IF;
 v_preview:=cf_private.preview_receivable_received_rows(p_scope,p_rows,p_title_mappings);
 IF (v_preview->>'can_commit')::boolean IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Resolva as divergências de títulos e quitações antes de importar.' USING ERRCODE='P0024';END IF;
 IF (v_preview->>'correction_count')::integer>0 AND p_confirm_corrections IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Confirme a revisão das quitações importadas antes de concluir.' USING ERRCODE='P0024';END IF;
 SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL),count(*) FILTER(WHERE r->>'title_id' IS NOT NULL AND t.status<>'VALIDATED'),
  count(*) FILTER(WHERE t.status='VALIDATED') INTO v_new,v_open,v_validated
  FROM jsonb_array_elements(v_preview->'rows') r LEFT JOIN public.receivable_titles t ON t.id=(r->>'title_id')::uuid;
 INSERT INTO public.receivable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,pending_count,validated_in_source_count,import_mode)
  VALUES(v_import,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),(v_preview->>'row_count')::integer,v_new,v_open,0,v_validated,'RECEIVED');
 INSERT INTO cf_private.receivable_import_files(import_id,file_bytes) VALUES(v_import,v_file);
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_preview->'rows') LOOP
  v_title:=NULL;v_receipt:=NULL;v_id:=(v_row->>'title_id')::uuid;v_revision:=0;
  IF v_id IS NULL THEN
   INSERT INTO public.receivable_titles(scope,source_key,document,client_name,client_document,customer_key,branch,issued_on,due_date,
    amount_cents,collector_id,status,validation_status,payment_source,payment_reported_date,payment_date,reported_in_collection,
    in_latest_report,first_import_id,last_import_id,last_action)
   VALUES(p_scope,v_row->>'source_key',v_row->>'document',v_row->>'client_name',v_row->>'client_document',v_row->>'customer_key',v_row->>'branch',
    (v_row->>'issued_on')::date,(v_row->>'due_date')::date,(v_row->>'amount_cents')::bigint,(v_row->>'collector_id')::uuid,
    'VALIDATED','VALIDATED','IMPORTACAO_DIARIA',(v_row->>'received_on')::date,(v_row->>'received_on')::date,false,false,v_import,v_import,'VALIDATE')
    RETURNING * INTO v_title;
   v_id:=v_title.id;
  ELSE
   SELECT * INTO v_title FROM public.receivable_titles WHERE id=v_id FOR UPDATE;
   SELECT * INTO v_receipt FROM public.effective_receivable_receipts WHERE title_id=v_id;
  END IF;
  v_delay:=greatest(0,(v_row->>'received_on')::date-(v_row->>'due_date')::date);
  v_band:=CASE WHEN v_delay<=30 THEN 'ATE_30' WHEN v_delay<=60 THEN '31_60' WHEN v_delay<=90 THEN '61_90'
   WHEN v_delay<=180 THEN '91_180' WHEN v_delay<=365 THEN '181_365' ELSE 'ACIMA_365' END;
  v_receipt_id:=v_receipt.id;v_source:=coalesce(v_receipt.payment_source,'IMPORTACAO_DIARIA');
  v_reported:=coalesce(v_receipt.reported_in_collection,v_title.reported_in_collection,false);
  IF v_row->>'outcome' IN ('NEW_RECEIPT','HISTORICAL') THEN
   INSERT INTO public.receivable_receipts(title_id,amount_cents,payment_date,delay_days,delay_band,collector_id,payment_source,reported_in_collection,validated_by)
    VALUES(v_id,(v_row->>'received_amount_cents')::bigint,(v_row->>'received_on')::date,v_delay,v_band,v_title.collector_id,
     'IMPORTACAO_DIARIA',v_reported,auth.uid()) RETURNING id INTO v_receipt_id;
   INSERT INTO public.receivable_receipt_import_provenance(receipt_id,first_import_id,nominal_amount_cents,original_due_date,created_by)
    VALUES(v_receipt_id,v_import,(v_row->>'amount_cents')::bigint,(v_row->>'due_date')::date,auth.uid());
  ELSIF v_row->>'outcome'='CORRECTION' THEN
   v_revision:=v_receipt.receipt_revision+1;
   INSERT INTO public.receivable_receipt_adjustments(receipt_id,revision,amount_cents,nominal_amount_cents,original_due_date,payment_date,
    delay_days,delay_band,collector_id,import_id,created_by)
    VALUES(v_receipt_id,v_revision,(v_row->>'received_amount_cents')::bigint,(v_row->>'amount_cents')::bigint,(v_row->>'due_date')::date,
     (v_row->>'received_on')::date,v_delay,v_band,v_receipt.collector_id,v_import,auth.uid());
  ELSE v_revision:=v_receipt.receipt_revision;
  END IF;
  IF v_row->>'title_id' IS NOT NULL THEN
   UPDATE public.receivable_titles SET document=v_row->>'document',client_name=v_row->>'client_name',client_document=v_row->>'client_document',
    customer_key=v_row->>'customer_key',branch=v_row->>'branch',issued_on=(v_row->>'issued_on')::date,due_date=(v_row->>'due_date')::date,
    amount_cents=(v_row->>'amount_cents')::bigint,status='VALIDATED',validation_status='VALIDATED',payment_source=v_source,
    payment_reported_date=(v_row->>'received_on')::date,payment_date=(v_row->>'received_on')::date,reported_in_collection=v_reported,
    in_latest_report=false,last_import_id=v_import,last_action='VALIDATE',next_action=NULL,next_action_date=NULL WHERE id=v_id;
  END IF;
  PERFORM cf_private.bind_receivable_parcel_alias(p_scope,v_row->>'source_key',v_id);
  INSERT INTO public.receivable_received_import_rows(import_id,title_id,receipt_id,outcome,receipt_revision,source_row)
   VALUES(v_import,v_id,v_receipt_id,v_row->>'outcome',v_revision,v_row);
  IF v_row->>'outcome'<>'MATCHED' THEN
   INSERT INTO public.receivable_collection_events(title_id,collector_id,action,observation,payment_date,created_by)
    VALUES(v_id,v_title.collector_id,'VALIDATE','Quitação confirmada pelo relatório importado do ERP.',(v_row->>'received_on')::date,auth.uid());
  END IF;
 END LOOP;
 v_result:=jsonb_build_object('mode','received','import_id',v_import,'row_count',(v_preview->>'row_count')::integer,
  'new_count',(v_preview->>'new_count')::integer,'received_count',(v_preview->>'received_count')::integer,
  'matched_count',(v_preview->>'matched_count')::integer,'correction_count',(v_preview->>'correction_count')::integer,
  'historical_count',(v_preview->>'historical_count')::integer,'validated_count',(v_preview->>'row_count')::integer,'idempotent',false);
 INSERT INTO public.receivable_sync_imports(import_id,mode,result,created_by) VALUES(v_import,'RECEIVED',v_result,auth.uid());
 RETURN v_result;
END $$;

-- Preserva o contrato e o recorte de origem legado, agora usando valores efetivos.
CREATE OR REPLACE FUNCTION public.receivables_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_open numeric;v_overdue numeric;v_period numeric;v_count bigint;v_pending bigint;v_unassigned bigint;
 v_received numeric;v_latest timestamptz;v_bps numeric;
BEGIN
 IF NOT(cf_private.has_permission('contas_receber','read') OR cf_private.has_permission('painel','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>3660 THEN
  RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';END IF;
 SELECT coalesce(sum(amount_cents),0),
  coalesce(sum(amount_cents) FILTER(WHERE due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date),0),
  coalesce(sum(amount_cents) FILTER(WHERE due_date BETWEEN p_start AND p_end),0),count(*),
  count(*) FILTER(WHERE validation_status='PENDING'),count(*) FILTER(WHERE collector_id IS NULL)
  INTO v_open,v_overdue,v_period,v_count,v_pending,v_unassigned FROM public.receivable_titles WHERE status<>'VALIDATED';
 SELECT coalesce(sum(amount_cents),0) INTO v_received FROM public.effective_receivable_receipts
  WHERE validation='VALIDADO' AND payment_source='IMPORTACAO_DIARIA' AND payment_date BETWEEN p_start AND p_end;
 IF greatest(v_open,v_overdue,v_period,v_count,v_pending,v_unassigned,v_received)>9007199254740991 THEN
  RAISE EXCEPTION 'O consolidado excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT max(created_at) INTO v_latest FROM public.receivable_imports;
 v_bps:=CASE WHEN v_open=0 THEN NULL ELSE round(v_overdue*10000/v_open) END;
 RETURN jsonb_build_object('open_cents',v_open,'overdue_cents',v_overdue,'period_cents',v_period,'active_count',v_count,
  'pending_count',v_pending,'unassigned_count',v_unassigned,'received_period_cents',v_received,
  'latest_import_at',v_latest,'overdue_bps',v_bps,'overdue_comlurb_cents',NULL);
END $$;
CREATE OR REPLACE FUNCTION public.receivables_import_capabilities() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT cf_private.has_permission('contas_receber','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('schema_version','024_receivable_received_import','open_sync',true,'received_import',true);
END $$;

REVOKE ALL ON FUNCTION cf_private.audit_receivable_received_import(),cf_private.require_receivable_received_import(),
 cf_private.normalize_receivable_received_rows(text,jsonb),cf_private.preview_receivable_received_rows(text,jsonb,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.preview_receivables_received_import(text,jsonb,jsonb),
 public.commit_receivables_received_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean),
 public.receivables_management_summary(date),public.receivable_commission_base(date,date,uuid,integer,integer)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_receivables_received_import(text,jsonb,jsonb),public.receivables_management_summary(date),
 public.receivable_commission_base(date,date,uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_receivables_received_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean) TO service_role;
COMMENT ON FUNCTION public.receivable_commission_base(date,date,uuid,integer,integer) IS
 'Base efetivamente recebida, sem taxa ou valor de comissão presumido. Dívida atribuída e recebida em atraso oferece base; recebimentos em dia e sem responsável ficam identificados.';
INSERT INTO public.central_schema_migrations(version) VALUES('024_receivable_received_import');
-- END SOURCE BODY: 024_receivable_received_import.sql
$cf_cr_source_024_bbb69bd619d336f6_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='024_receivable_received_import') THEN
      RAISE EXCEPTION 'A atualização 024_receivable_received_import não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_cr_apply_024_a0ca990efcd8ab0d_0$;

-- SOURCE: 025_collections_management.sql
DO $cf_cr_apply_025_91345f02eb1568e2_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='025_collections_management') THEN
    RAISE NOTICE 'Atualização 025_collections_management já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_cr_source_025_91060249a2e42050_0$
-- SOURCE BODY: 025_collections_management.sql
-- Visão gerencial da cobrança vencida. Somente leitura; preserva títulos e históricos.
-- Aplicar uma única vez após 022; não depende das importações 023/024.

DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='022_collections_overdue_only') THEN
  RAISE EXCEPTION 'Ative a atualização 022 de Cobrança antes deste resumo.' USING ERRCODE='22023';
 END IF;
END $$;

CREATE FUNCTION public.collections_overdue_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_full_wallet boolean;v_totals jsonb;v_bands jsonb;v_statuses jsonb;v_actions jsonb;v_owners jsonb;
BEGIN
 IF NOT cf_private.has_permission('cobranca','read') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 v_full_wallet:=cf_private.has_permission('contas_receber','read');
 -- A view e as tabelas continuam com a RLS do chamador: cobradora vê apenas
 -- sua carteira vinculada. Nenhum total nasce da página limitada do navegador.
 WITH active AS MATERIALIZED(
  SELECT t.*,(v_today-t.due_date)::integer AS delay_days
  FROM public.collection_overdue_titles t
  WHERE t.scope='grupo-consolidado' AND t.status<>'VALIDATED'
 ),bands(key,label,min_days,max_days,sort_order) AS(VALUES
  ('1_30','1–30 dias',1,30,1),('31_60','31–60 dias',31,60,2),
  ('61_90','61–90 dias',61,90,3),('91_180','91–180 dias',91,180,4),
  ('181_365','181–365 dias',181,365,5),('ACIMA_365','Acima de 365 dias',366,NULL,6)
 ),statuses(status,sort_order) AS(VALUES('NEW',1),('OPEN',2),('PENDING_VALIDATION',3),('NOT_LOCATED',4)),
 actions(action,sort_order) AS(VALUES('NONE',1),('CONTACT',2),('NO_RESPONSE',3),('PROMISE',4),('RETRY',5),('OTHER',6))
 SELECT jsonb_build_object(
  'overdue_cents',coalesce(sum(amount_cents),0),'overdue_count',count(*),
  'client_count',count(DISTINCT customer_key),
  'average_delay_days',coalesce(round(avg(delay_days),1),0),
  'worked_count',count(*) FILTER(WHERE last_action IS NOT NULL),
  'no_action_count',count(*) FILTER(WHERE last_action IS NULL),
  'pending_validation_count',count(*) FILTER(WHERE status='PENDING_VALIDATION'),
  'pending_validation_cents',coalesce(sum(amount_cents) FILTER(WHERE status='PENDING_VALIDATION'),0),
  'over_180_count',count(*) FILTER(WHERE delay_days>180),
  'returns_today_count',count(*) FILTER(WHERE next_action IS NOT NULL AND next_action_date=v_today),
  'returns_overdue_count',count(*) FILTER(WHERE next_action IS NOT NULL AND next_action_date<v_today),
  'unassigned_count',CASE WHEN v_full_wallet THEN count(*) FILTER(WHERE collector_id IS NULL) END,
  'unassigned_cents',CASE WHEN v_full_wallet THEN coalesce(sum(amount_cents) FILTER(WHERE collector_id IS NULL),0) END),
  (SELECT jsonb_agg(jsonb_build_object('key',b.key,'label',b.label,'min_days',b.min_days,'max_days',b.max_days,
    'title_count',(SELECT count(*) FROM active t WHERE t.delay_days>=b.min_days AND (b.max_days IS NULL OR t.delay_days<=b.max_days)),
    'amount_cents',(SELECT coalesce(sum(t.amount_cents),0) FROM active t WHERE t.delay_days>=b.min_days AND (b.max_days IS NULL OR t.delay_days<=b.max_days))) ORDER BY b.sort_order) FROM bands b),
  (SELECT jsonb_agg(jsonb_build_object('status',s.status,
    'title_count',(SELECT count(*) FROM active t WHERE t.status=s.status),
    'amount_cents',(SELECT coalesce(sum(t.amount_cents),0) FROM active t WHERE t.status=s.status)) ORDER BY s.sort_order) FROM statuses s),
  (SELECT jsonb_agg(jsonb_build_object('action',a.action,
    'title_count',(SELECT count(*) FROM active t WHERE coalesce(t.next_action,'NONE')=a.action),
    'amount_cents',(SELECT coalesce(sum(t.amount_cents),0) FROM active t WHERE coalesce(t.next_action,'NONE')=a.action)) ORDER BY a.sort_order) FROM actions a),
  (SELECT coalesce(jsonb_agg(jsonb_build_object('collector_id',o.collector_id,'display_name',o.display_name,
    'title_count',o.title_count,'amount_cents',o.amount_cents) ORDER BY o.collector_id NULLS LAST),'[]'::jsonb)
   FROM(SELECT t.collector_id,
    CASE WHEN t.collector_id IS NULL THEN 'Sem cobradora definida' ELSE coalesce(max(a.display_name),'Cobradora atribuída') END AS display_name,
    count(*) AS title_count,sum(t.amount_cents) AS amount_cents
    FROM active t LEFT JOIN public.collection_agents a ON a.id=t.collector_id GROUP BY t.collector_id)o)
 INTO v_totals,v_bands,v_statuses,v_actions,v_owners FROM active;

 -- Recusar perda de precisão em centavos e contagens; jamais arredondar dinheiro.
 IF EXISTS(SELECT 1 FROM jsonb_each(v_totals) e
    WHERE e.value<>'null'::jsonb AND abs((e.value#>>'{}')::numeric)>9007199254740991)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_bands||v_statuses||v_actions||v_owners) a
   CROSS JOIN LATERAL jsonb_each(a) e WHERE e.key IN('amount_cents','title_count')
    AND abs((e.value#>>'{}')::numeric)>9007199254740991) THEN
  RAISE EXCEPTION 'O resumo excede o limite de precisão. Solicite a conferência da base.' USING ERRCODE='22003';
 END IF;
 RETURN jsonb_build_object('as_of_date',v_today,'by_delay_bands',v_bands,'by_status',v_statuses,
  'by_next_action',v_actions,'by_collector',v_owners)||v_totals;
END $$;
REVOKE ALL ON FUNCTION public.collections_overdue_summary() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.collections_overdue_summary() TO authenticated;
COMMENT ON FUNCTION public.collections_overdue_summary() IS
 'Somente leitura. Carteira ativa vencida pela data oficial de São Paulo, íntegra e sujeita à RLS do chamador. Pendentes permanecem até validação; validados não compõem totais. Faixas são de atraso atual, sem regras ou percentuais de comissão. Sem títulos visíveis retorna contagens e valores zero; não representa saldo bancário ou recebimento.';
INSERT INTO public.central_schema_migrations(version) VALUES('025_collections_management');
-- END SOURCE BODY: 025_collections_management.sql
$cf_cr_source_025_91060249a2e42050_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='025_collections_management') THEN
      RAISE EXCEPTION 'A atualização 025_collections_management não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_cr_apply_025_91345f02eb1568e2_0$;

-- SOURCE: 026_collection_workbench.sql
DO $cf_cr_apply_026_487624d16feb7286_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='026_collection_workbench') THEN
    RAISE NOTICE 'Atualização 026_collection_workbench já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_cr_source_026_1713f3bb5ebc4830_0$
-- SOURCE BODY: 026_collection_workbench.sql
-- Central de Cobrança: acompanhamento operacional e tempo persistente.
-- Não altera regras de quitação, recebimentos, comissões ou responsáveis.

DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='022_collections_overdue_only') THEN
  RAISE EXCEPTION 'Ative a atualização 022 antes da Central de Cobrança operacional.' USING ERRCODE='22023';END IF;
END $$;

CREATE TABLE public.collection_cases(
 title_id uuid PRIMARY KEY REFERENCES public.receivable_titles(id) ON DELETE RESTRICT,
 status text NOT NULL CHECK(status IN ('NOVO TÍTULO - COBRAR','SEM SUCESSO','AGUARDANDO RETORNO','COBRANCA VIA EMAIL',
  'COBRANCA POR WHATSAPP','AGUARDANDO LIQUIDACAO','SEM PRAZO','SEM PREVISAO DE PG','PAGAMENTO PROGRAMADO','TÍTULO PAGO')),
 observation text CHECK(length(observation)<=5000),next_action text CHECK(length(next_action)<=1000),next_date date,
 payment_date date,revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 finalized_at timestamptz,updated_by uuid NOT NULL REFERENCES public.profiles(id),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.collection_case_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title_id uuid NOT NULL REFERENCES public.receivable_titles(id),
 case_revision bigint NOT NULL,status text NOT NULL,observation text,next_action text,next_date date,payment_date date,
 finalized boolean NOT NULL,created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX collection_case_events_title ON public.collection_case_events(title_id,created_at DESC,id DESC);
CREATE TABLE public.collection_work_sessions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title_id uuid NOT NULL REFERENCES public.receivable_titles(id),
 actor_id uuid NOT NULL REFERENCES public.profiles(id),collector_id uuid NOT NULL REFERENCES public.collection_agents(id),
 document_snapshot text NOT NULL,client_name_snapshot text NOT NULL,branch_snapshot text NOT NULL,collector_name_snapshot text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),ended_at timestamptz,
 end_reason text CHECK(end_reason IN ('PAUSE','FINISH','TITLE_SETTLED')),
 CHECK((ended_at IS NULL)=(end_reason IS NULL)),CHECK(ended_at IS NULL OR ended_at>=started_at)
);
CREATE UNIQUE INDEX collection_one_running_per_actor ON public.collection_work_sessions(actor_id) WHERE ended_at IS NULL;
CREATE INDEX collection_work_title ON public.collection_work_sessions(title_id,started_at DESC,id DESC);
CREATE INDEX collection_work_period ON public.collection_work_sessions(started_at,collector_id);
CREATE TABLE public.collection_work_requests(
 actor_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL,
 title_id uuid NOT NULL REFERENCES public.receivable_titles(id),payload jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE cf_private.collection_workbench_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 0);
INSERT INTO cf_private.collection_workbench_state(singleton) VALUES(true);
ALTER TABLE cf_private.collection_workbench_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.collection_workbench_state FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['collection_cases','collection_case_events','collection_work_sessions','collection_work_requests'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
  IF v_table<>'collection_work_requests' THEN
   EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated',v_table);
   IF v_table='collection_work_sessions' THEN
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING(cf_private.has_permission(''cobranca'',''read'') AND ((cf_private.has_permission(''contas_receber'',''read'') AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.role_key IN (''gerente_geral'',''diretor'',''contas_receber''))) OR (actor_id=auth.uid() AND collector_id=cf_private.current_collector_id())))',v_table||'_read',v_table);
   ELSE
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING(cf_private.has_permission(''cobranca'',''read'') AND EXISTS(SELECT 1 FROM public.collection_overdue_titles t WHERE t.id=title_id AND ((cf_private.has_permission(''contas_receber'',''read'') AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.role_key IN (''gerente_geral'',''diretor'',''contas_receber''))) OR t.collector_id=cf_private.current_collector_id())))',v_table||'_read',v_table);
   END IF;
  END IF;
 END LOOP;
END $$;
CREATE TRIGGER collection_case_events_immutable BEFORE UPDATE OR DELETE ON public.collection_case_events
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER collection_work_requests_immutable BEFORE UPDATE OR DELETE ON public.collection_work_requests
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER collection_cases_no_delete BEFORE DELETE ON public.collection_cases
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();

CREATE FUNCTION cf_private.collection_workbench_bump() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 UPDATE cf_private.collection_workbench_state SET revision=revision+1 WHERE singleton;RETURN NULL;
END $$;
CREATE TRIGGER collection_title_workbench_revision AFTER INSERT OR UPDATE OR DELETE ON public.receivable_titles
 FOR EACH STATEMENT EXECUTE FUNCTION cf_private.collection_workbench_bump();
CREATE TRIGGER collection_case_workbench_revision AFTER INSERT OR UPDATE ON public.collection_cases
 FOR EACH STATEMENT EXECUTE FUNCTION cf_private.collection_workbench_bump();
CREATE TRIGGER collection_session_workbench_revision AFTER INSERT OR UPDATE ON public.collection_work_sessions
 FOR EACH STATEMENT EXECUTE FUNCTION cf_private.collection_workbench_bump();
CREATE FUNCTION cf_private.audit_collection_workbench() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_actor public.profiles%ROWTYPE;BEGIN
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'cobranca',TG_TABLE_NAME,
  coalesce(to_jsonb(NEW)->>'id',to_jsonb(NEW)->>'title_id'),CASE WHEN TG_OP='INSERT' THEN 'CREATE' ELSE 'UPDATE' END,
  CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) END,to_jsonb(NEW));RETURN NEW;
END $$;
CREATE TRIGGER collection_cases_audit AFTER INSERT OR UPDATE ON public.collection_cases
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_collection_workbench();
CREATE TRIGGER collection_case_events_audit AFTER INSERT ON public.collection_case_events
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_collection_workbench();
CREATE TRIGGER collection_work_sessions_audit AFTER INSERT OR UPDATE ON public.collection_work_sessions
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_collection_workbench();
CREATE FUNCTION cf_private.guard_collection_work_session() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
  OR ROW(NEW.id,NEW.title_id,NEW.actor_id,NEW.collector_id,NEW.started_at,NEW.document_snapshot,NEW.client_name_snapshot,NEW.branch_snapshot,NEW.collector_name_snapshot)
   IS DISTINCT FROM ROW(OLD.id,OLD.title_id,OLD.actor_id,OLD.collector_id,OLD.started_at,OLD.document_snapshot,OLD.client_name_snapshot,OLD.branch_snapshot,OLD.collector_name_snapshot) THEN
  RAISE EXCEPTION 'O histórico de tempo é imutável; somente um intervalo em andamento pode ser encerrado.' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER collection_work_sessions_immutable BEFORE UPDATE OR DELETE ON public.collection_work_sessions
 FOR EACH ROW EXECUTE FUNCTION cf_private.guard_collection_work_session();
CREATE FUNCTION cf_private.close_settled_collection_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NEW.status='VALIDATED' AND OLD.status<>'VALIDATED' THEN
  UPDATE public.collection_work_sessions SET ended_at=greatest(started_at,clock_timestamp()),end_reason='TITLE_SETTLED'
   WHERE title_id=NEW.id AND ended_at IS NULL;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER collection_close_settled_work AFTER UPDATE ON public.receivable_titles
 FOR EACH ROW EXECUTE FUNCTION cf_private.close_settled_collection_work();

CREATE FUNCTION cf_private.require_collection_workbench_read() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('cobranca','read') OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid()
  AND enabled AND role_key IN ('gerente_geral','diretor','contas_receber','cobradora_1','cobradora_2')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION cf_private.collection_workbench_visible(p_title public.receivable_titles) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT cf_private.has_permission('cobranca','read') AND p_title.due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
  AND ((cf_private.has_permission('contas_receber','read') AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid()
   AND role_key IN ('gerente_geral','diretor','contas_receber'))) OR p_title.collector_id=cf_private.current_collector_id());
$$;
CREATE FUNCTION cf_private.collection_workbench_title(p_title_id uuid) RETURNS public.receivable_titles
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_title public.receivable_titles%ROWTYPE;BEGIN
 PERFORM cf_private.require_collection_workbench_read();SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id;
 IF NOT FOUND OR NOT coalesce(cf_private.collection_workbench_visible(v_title),false) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;RETURN v_title;
END $$;
CREATE FUNCTION cf_private.collection_workbench_timer(p_title_id uuid,p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total bigint;v_actor bigint;v_running public.collection_work_sessions%ROWTYPE;v_visible boolean;BEGIN
 SELECT cf_private.collection_workbench_visible(t) INTO v_visible FROM public.receivable_titles t WHERE id=p_title_id;
 SELECT coalesce(sum(greatest(0,floor(extract(epoch FROM (coalesce(ended_at,p_now)-started_at))))),0),
  coalesce(sum(greatest(0,floor(extract(epoch FROM (coalesce(ended_at,p_now)-started_at))))) FILTER(WHERE actor_id=auth.uid()),0)
 INTO v_total,v_actor FROM public.collection_work_sessions WHERE title_id=p_title_id AND
  ((v_visible AND cf_private.has_permission('contas_receber','read') AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid()
    AND role_key IN ('gerente_geral','diretor','contas_receber'))) OR actor_id=auth.uid());
 SELECT * INTO v_running FROM public.collection_work_sessions WHERE title_id=p_title_id AND actor_id=auth.uid() AND ended_at IS NULL;
 RETURN jsonb_build_object('title_id',p_title_id,'running',v_running.id IS NOT NULL,'session_id',v_running.id,
  'started_at',v_running.started_at,'elapsed_seconds',CASE WHEN v_running.id IS NULL THEN 0 ELSE greatest(0,floor(extract(epoch FROM(p_now-v_running.started_at)))) END,
  'total_seconds',v_total,'actor_total_seconds',v_actor,'server_now',p_now);
END $$;
CREATE FUNCTION cf_private.collection_workbench_legacy_status(p_action text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT CASE p_action WHEN 'PAID' THEN 'TÍTULO PAGO' WHEN 'NO_RESPONSE' THEN 'SEM SUCESSO'
 WHEN 'PROMISE' THEN 'PAGAMENTO PROGRAMADO' ELSE 'NOVO TÍTULO - COBRAR' END;$$;
CREATE FUNCTION cf_private.collection_workbench_row(p_title public.receivable_titles,p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_case public.collection_cases%ROWTYPE;v_timer jsonb;v_name text;v_old_observation text;BEGIN
 SELECT * INTO v_case FROM public.collection_cases WHERE title_id=p_title.id;
 SELECT display_name INTO v_name FROM public.collection_agents WHERE id=p_title.collector_id;
 v_timer:=cf_private.collection_workbench_timer(p_title.id,p_now);
 SELECT observation INTO v_old_observation FROM public.receivable_collection_events WHERE title_id=p_title.id AND observation IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN to_jsonb(p_title)||jsonb_build_object('operational_status',coalesce(v_case.status,cf_private.collection_workbench_legacy_status(p_title.last_action)),
  'operational_label',CASE WHEN v_case.title_id IS NULL AND p_title.last_action IS NOT NULL AND p_title.last_action NOT IN ('PAID','NO_RESPONSE','PROMISE') THEN 'Sem status operacional' ELSE coalesce(v_case.status,cf_private.collection_workbench_legacy_status(p_title.last_action)) END,
  'legacy_worked',v_case.title_id IS NULL AND p_title.last_action IS NOT NULL,'case_revision',coalesce(v_case.revision,0),
  'observation',CASE WHEN v_case.title_id IS NULL THEN v_old_observation ELSE v_case.observation END,'next_action_text',v_case.next_action,
  'next_date',CASE WHEN v_case.title_id IS NULL THEN p_title.next_action_date ELSE v_case.next_date END,'delay_days',(p_now AT TIME ZONE 'America/Sao_Paulo')::date-p_title.due_date,
  'collector_name',v_name,'total_work_seconds',v_timer->'total_seconds','current_timer',v_timer);
END $$;

CREATE FUNCTION public.collection_workbench(p_search text DEFAULT '',p_collector_id uuid DEFAULT NULL,p_unassigned boolean DEFAULT false,
 p_band text DEFAULT NULL,p_sort text DEFAULT 'delay_desc',p_status text DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,
 p_queue text DEFAULT 'active',p_due_start date DEFAULT NULL,p_due_end date DEFAULT NULL,p_next_action text DEFAULT NULL,p_financial_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;v_now timestamptz:=statement_timestamp();
 v_count bigint;v_total numeric;v_rows jsonb;v_revision text;v_active_id uuid;v_active_timer jsonb;BEGIN
 PERFORM cf_private.require_collection_workbench_read();
 IF p_search IS NULL OR length(p_search)>1500 OR p_unassigned IS NULL OR p_sort IS NULL
  OR p_sort NOT IN ('delay_desc','delay_asc','due_asc','due_desc','amount_desc','amount_asc','client_asc','next_date_asc')
  OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
  OR p_queue IS NULL OR p_queue NOT IN ('active','history','all')
  OR (p_band IS NOT NULL AND p_band NOT IN ('1_30','31_60','61_90','91_180','181_365','ACIMA_365'))
  OR (p_status IS NOT NULL AND p_status NOT IN ('NOVO TÍTULO - COBRAR','SEM SUCESSO','AGUARDANDO RETORNO','COBRANCA VIA EMAIL','COBRANCA POR WHATSAPP',
   'AGUARDANDO LIQUIDACAO','SEM PRAZO','SEM PREVISAO DE PG','PAGAMENTO PROGRAMADO','TÍTULO PAGO'))
  OR (p_financial_status IS NOT NULL AND p_financial_status NOT IN ('ACTIVE','NEW','OPEN','PENDING_VALIDATION','NOT_LOCATED','VALIDATED'))
  OR (p_next_action IS NOT NULL AND p_next_action NOT IN ('NONE','CONTACT','NO_RESPONSE','PROMISE','RETRY','OTHER'))
  OR (p_due_start IS NOT NULL AND p_due_end IS NOT NULL AND p_due_start>p_due_end) OR (p_unassigned AND p_collector_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Filtros de cobrança inválidos.' USING ERRCODE='22023';END IF;
 WITH filtered AS MATERIALIZED(
  SELECT t.*,coalesce(c.status,cf_private.collection_workbench_legacy_status(t.last_action)) AS case_status,coalesce(c.next_date,t.next_action_date) AS case_next_date
  FROM public.receivable_titles t LEFT JOIN public.collection_cases c ON c.title_id=t.id
  WHERE cf_private.collection_workbench_visible(t) AND t.scope='grupo-consolidado'
   AND (p_queue='all' OR (p_queue='active' AND t.status<>'VALIDATED') OR (p_queue='history' AND t.status='VALIDATED'))
   AND (p_collector_id IS NULL OR t.collector_id=p_collector_id) AND (NOT p_unassigned OR t.collector_id IS NULL)
   AND (p_due_start IS NULL OR t.due_date>=p_due_start) AND (p_due_end IS NULL OR t.due_date<=p_due_end)
   AND (p_status IS NULL OR coalesce(c.status,cf_private.collection_workbench_legacy_status(t.last_action))=p_status)
   AND (p_financial_status IS NULL OR t.status=p_financial_status OR (p_financial_status='ACTIVE' AND t.status<>'VALIDATED'))
   AND (p_next_action IS NULL OR coalesce(t.next_action,'NONE')=p_next_action)
   AND (p_search='' OR position(lower(btrim(p_search)) IN lower(t.document||' '||t.client_name||' '||coalesce(t.client_document,'')||' '||t.branch||' '||
    coalesce(c.status,cf_private.collection_workbench_legacy_status(t.last_action))||' '||coalesce(c.observation,'')))>0
    OR (c.title_id IS NULL AND EXISTS(SELECT 1 FROM public.receivable_collection_events e WHERE e.title_id=t.id
     AND position(lower(btrim(p_search)) IN lower(coalesce(e.observation,'')))>0)))
   AND (p_band IS NULL OR CASE p_band WHEN '1_30' THEN v_today-t.due_date BETWEEN 1 AND 30 WHEN '31_60' THEN v_today-t.due_date BETWEEN 31 AND 60
    WHEN '61_90' THEN v_today-t.due_date BETWEEN 61 AND 90 WHEN '91_180' THEN v_today-t.due_date BETWEEN 91 AND 180
    WHEN '181_365' THEN v_today-t.due_date BETWEEN 181 AND 365 ELSE v_today-t.due_date>365 END)
 ),page AS(
  SELECT f.id FROM filtered f ORDER BY
   CASE WHEN p_sort IN ('delay_desc','due_asc') THEN f.due_date END ASC,
   CASE WHEN p_sort IN ('delay_asc','due_desc') THEN f.due_date END DESC,
   CASE WHEN p_sort='amount_desc' THEN f.amount_cents END DESC,CASE WHEN p_sort='amount_asc' THEN f.amount_cents END ASC,
   CASE WHEN p_sort='client_asc' THEN lower(f.client_name) END ASC,
   CASE WHEN p_sort='next_date_asc' THEN f.case_next_date END ASC NULLS LAST,f.id ASC OFFSET p_offset LIMIT p_limit
 ) SELECT (SELECT count(*) FROM filtered),(SELECT coalesce(sum(amount_cents),0) FROM filtered),
  coalesce((SELECT jsonb_agg(cf_private.collection_workbench_row(t,v_now) ORDER BY ord) FROM
   (SELECT p.id,row_number() OVER() AS ord FROM page p)x JOIN public.receivable_titles t ON t.id=x.id),'[]'::jsonb)
 INTO v_count,v_total,v_rows;
 IF v_total>9007199254740991 OR v_count>9007199254740991 THEN RAISE EXCEPTION 'O total excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT revision::text INTO v_revision FROM cf_private.collection_workbench_state WHERE singleton;
 -- Recuperação após recarregar: o intervalo pertence ao ator, mesmo quando o
 -- título saiu do filtro, foi reagendado ou deixou sua carteira. Somente IDs e
 -- tempo do próprio ator são retornados; não expõe fatos do título oculto.
 SELECT title_id INTO v_active_id FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL;
 IF v_active_id IS NOT NULL THEN
  v_active_timer:=cf_private.collection_workbench_timer(v_active_id,v_now);
  v_active_timer:=v_active_timer||jsonb_build_object('total_seconds',v_active_timer->'actor_total_seconds');
 END IF;
 RETURN jsonb_build_object('as_of_date',v_today,'server_now',v_now,'snapshot_revision',v_revision,'count',v_count,'total_cents',v_total,'rows',v_rows,'active_timer',v_active_timer);
END $$;
CREATE FUNCTION public.collection_case_detail(p_title_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE;v_case jsonb;v_history jsonb;v_sessions jsonb;v_events jsonb;v_old_observation text;v_now timestamptz:=statement_timestamp();BEGIN
 v_title:=cf_private.collection_workbench_title(p_title_id);
 SELECT to_jsonb(c)-'title_id' INTO v_case FROM public.collection_cases c WHERE title_id=p_title_id;
 IF v_case IS NULL THEN
  SELECT observation INTO v_old_observation FROM public.receivable_collection_events WHERE title_id=p_title_id AND observation IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1;
  v_case:=jsonb_build_object('status',cf_private.collection_workbench_legacy_status(v_title.last_action),
  'observation',v_old_observation,'next_action',CASE v_title.next_action WHEN 'CONTACT' THEN 'Contato' WHEN 'NO_RESPONSE' THEN 'Sem resposta'
   WHEN 'PROMISE' THEN 'Acompanhar promessa' WHEN 'RETRY' THEN 'Nova tentativa' END,
  'next_date',v_title.next_action_date,'payment_date',v_title.payment_reported_date,'revision',0,'finalized_at',NULL,'updated_at',NULL,'updated_by',NULL);END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO v_history
  FROM(SELECT * FROM public.receivable_collection_events WHERE title_id=p_title_id ORDER BY created_at DESC,id DESC LIMIT 100)e;
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO v_events
  FROM(SELECT * FROM public.collection_case_events WHERE title_id=p_title_id ORDER BY created_at DESC,id DESC LIMIT 100)e;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY started_at DESC,id DESC),'[]'::jsonb) INTO v_sessions
  FROM(SELECT * FROM public.collection_work_sessions WHERE title_id=p_title_id AND
   ((cf_private.has_permission('contas_receber','read') AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role_key IN ('gerente_geral','diretor','contas_receber')))
    OR (actor_id=auth.uid() AND collector_id=cf_private.current_collector_id())) ORDER BY started_at DESC,id DESC LIMIT 50)s;
 RETURN jsonb_build_object('title',cf_private.collection_workbench_row(v_title,v_now),'case',v_case,'timer',cf_private.collection_workbench_timer(p_title_id,v_now),
  'history',v_history,'case_history',v_events,'work_sessions',v_sessions);
END $$;

CREATE FUNCTION cf_private.collection_work_request_replay(p_request_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_record public.collection_work_requests%ROWTYPE;BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Informe o identificador da operação para confirmar com segurança.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_record FROM public.collection_work_requests WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN IF v_record.payload IS DISTINCT FROM p_payload THEN
  RAISE EXCEPTION 'Este identificador já foi usado para outra operação.' USING ERRCODE='22023';END IF;RETURN v_record.result;END IF;RETURN NULL;
END $$;
CREATE FUNCTION public.collection_work_action(p_title_id uuid,p_action text,p_expected_revision bigint,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE;v_running public.collection_work_sessions%ROWTYPE;v_payload jsonb;v_result jsonb;BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);PERFORM cf_private.require_collection_workbench_read();
 IF NOT cf_private.has_permission('cobranca','write') OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid()
  AND role_key IN ('gerente_geral','contas_receber','cobradora_1','cobradora_2')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_action IS NULL OR p_action NOT IN ('START','PAUSE','FINISH') OR p_title_id IS NULL THEN RAISE EXCEPTION 'Ação de tempo inválida.' USING ERRCODE='22023';END IF;
 v_payload:=jsonb_build_object('kind','work','title_id',p_title_id,'action',p_action,'expected_revision',p_expected_revision);
 v_result:=cf_private.collection_work_request_replay(p_request_id,v_payload);IF v_result IS NOT NULL THEN RETURN v_result;END IF;
 IF p_action='START' THEN
  v_title:=cf_private.collection_workbench_title(p_title_id);PERFORM cf_private.require_collection_title(v_title);
  IF v_title.status='VALIDATED' OR v_title.collector_id IS NULL THEN RAISE EXCEPTION 'Selecione um título ativo com cobradora definida.' USING ERRCODE='23514';END IF;
  SELECT * INTO v_running FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL FOR UPDATE;
  IF v_running.id IS NOT NULL AND v_running.title_id<>p_title_id THEN RAISE EXCEPTION 'Pause o atendimento atual antes de iniciar outro título.' USING ERRCODE='23514';END IF;
  IF v_running.id IS NULL THEN
   IF p_expected_revision IS NULL OR p_expected_revision<>v_title.revision THEN RAISE EXCEPTION 'O título mudou. Atualize a tela.' USING ERRCODE='40001';END IF;
   INSERT INTO public.collection_work_sessions(title_id,actor_id,collector_id,document_snapshot,client_name_snapshot,branch_snapshot,collector_name_snapshot)
    SELECT p_title_id,auth.uid(),v_title.collector_id,v_title.document,v_title.client_name,v_title.branch,display_name FROM public.collection_agents WHERE id=v_title.collector_id;
  END IF;
 ELSE
  -- Encerrar o próprio intervalo é permitido mesmo após quitação/revínculo;
  -- isso não dá acesso ao título nem permite alterar a validação financeira.
  SELECT * INTO v_running FROM public.collection_work_sessions WHERE title_id=p_title_id AND actor_id=auth.uid() AND ended_at IS NULL FOR UPDATE;
  IF v_running.id IS NOT NULL THEN
   UPDATE public.collection_work_sessions SET ended_at=greatest(started_at,clock_timestamp()),end_reason=p_action WHERE id=v_running.id;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE title_id=p_title_id AND actor_id=auth.uid()) THEN
    PERFORM cf_private.collection_workbench_title(p_title_id);END IF;
  END IF;
 END IF;
 v_result:=cf_private.collection_workbench_timer(p_title_id,clock_timestamp());
 INSERT INTO public.collection_work_requests(actor_id,request_id,title_id,payload,result) VALUES(auth.uid(),p_request_id,p_title_id,v_payload,v_result);RETURN v_result;
END $$;

CREATE FUNCTION public.save_collection_case(p_title_id uuid,p_status text,p_observation text,p_next_action text,p_next_date date,
 p_expected_revision bigint,p_expected_case_revision bigint,p_payment_date date DEFAULT NULL,p_finish boolean DEFAULT false,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE;v_case public.collection_cases%ROWTYPE;v_payload jsonb;v_result jsonb;
 v_event uuid;v_action text;v_legacy_next text;v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;v_now timestamptz;BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);PERFORM cf_private.require_collection_workbench_read();
 IF NOT cf_private.has_permission('cobranca','write') OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid()
  AND role_key IN ('gerente_geral','contas_receber','cobradora_1','cobradora_2')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 v_payload:=jsonb_build_object('kind','case','title_id',p_title_id,'status',p_status,'observation',p_observation,'next_action',p_next_action,
  'next_date',p_next_date,'expected_revision',p_expected_revision,'expected_case_revision',p_expected_case_revision,'payment_date',p_payment_date,'finish',p_finish);
 v_result:=cf_private.collection_work_request_replay(p_request_id,v_payload);IF v_result IS NOT NULL THEN RETURN v_result;END IF;
 v_title:=cf_private.collection_workbench_title(p_title_id);PERFORM cf_private.require_collection_title(v_title);
 SELECT * INTO v_case FROM public.collection_cases WHERE title_id=p_title_id FOR UPDATE;
 IF p_expected_revision IS NULL OR v_title.revision<>p_expected_revision OR p_expected_case_revision IS NULL
  OR coalesce(v_case.revision,0)<>p_expected_case_revision THEN RAISE EXCEPTION 'O título ou o acompanhamento mudou. Atualize a tela.' USING ERRCODE='40001';END IF;
 IF v_title.status='VALIDATED' THEN RAISE EXCEPTION 'O título já foi validado; somente o histórico e o encerramento do tempo estão disponíveis.' USING ERRCODE='23514';END IF;
 IF p_finish IS NULL OR p_status IS NULL OR p_status NOT IN ('NOVO TÍTULO - COBRAR','SEM SUCESSO','AGUARDANDO RETORNO','COBRANCA VIA EMAIL','COBRANCA POR WHATSAPP',
  'AGUARDANDO LIQUIDACAO','SEM PRAZO','SEM PREVISAO DE PG','PAGAMENTO PROGRAMADO','TÍTULO PAGO')
  OR length(coalesce(p_observation,''))>5000 OR length(coalesce(p_next_action,''))>1000
  OR (p_next_date IS NOT NULL AND (p_next_date<DATE '1900-01-01' OR p_next_date>DATE '2199-12-31'))
  OR (p_status='TÍTULO PAGO' AND (p_payment_date IS NULL OR p_payment_date<DATE '1900-01-01' OR p_payment_date>v_today))
  OR (p_status<>'TÍTULO PAGO' AND p_payment_date IS NOT NULL)
  OR (p_finish AND (v_title.collector_id IS NULL OR nullif(cf_private.normalize_receivable_text(p_observation),'') IS NULL
   OR (p_status<>'TÍTULO PAGO' AND (nullif(cf_private.normalize_receivable_text(p_next_action),'') IS NULL OR p_next_date IS NULL)))) THEN
  RAISE EXCEPTION 'Para finalizar, informe cobradora, observação e próxima ação/data; título pago exige a data real do pagamento.' USING ERRCODE='23514';END IF;
 v_now:=clock_timestamp();
 IF p_finish THEN
  -- Finalizar pagamento encerra a agenda de cobrança e encaminha somente
  -- para conferência financeira. A agenda anterior permanece no histórico.
  IF p_status='TÍTULO PAGO' THEN p_next_action:='VALIDAÇÃO FINANCEIRA';p_next_date:=NULL;END IF;
  v_action:=CASE p_status WHEN 'TÍTULO PAGO' THEN 'PAID' WHEN 'SEM SUCESSO' THEN 'NO_RESPONSE' WHEN 'PAGAMENTO PROGRAMADO' THEN 'PROMISE'
   WHEN 'COBRANCA VIA EMAIL' THEN 'CONTACT' WHEN 'COBRANCA POR WHATSAPP' THEN 'CONTACT' ELSE 'OTHER' END;
  IF v_action='PAID' AND (v_title.status='PENDING_VALIDATION' OR v_title.validation_status='PENDING') THEN
   IF v_title.payment_source IS DISTINCT FROM 'COBRANCA' OR v_title.payment_reported_date IS DISTINCT FROM p_payment_date THEN
    RAISE EXCEPTION 'Este pagamento já aguarda conferência com outra origem ou data. Confirme a pendência com o financeiro.' USING ERRCODE='23514';END IF;
   v_action:='OTHER';
  END IF;
  v_legacy_next:=CASE WHEN p_status<>'TÍTULO PAGO' AND nullif(btrim(p_next_action),'') IS NOT NULL THEN 'OTHER' END;
  v_event:=public.record_collection_action(p_title_id,v_action,v_today,v_legacy_next,p_next_date,p_observation,
   'Status operacional: '||p_status||coalesce('; próxima ação: '||nullif(btrim(p_next_action),''),''),
   CASE WHEN v_action='PAID' THEN p_payment_date END,v_title.revision);
 END IF;
 INSERT INTO public.collection_cases(title_id,status,observation,next_action,next_date,payment_date,revision,finalized_at,updated_by,updated_at)
 VALUES(p_title_id,p_status,nullif(btrim(p_observation),''),nullif(btrim(p_next_action),''),p_next_date,p_payment_date,1,
  CASE WHEN p_finish THEN v_now END,auth.uid(),v_now)
 ON CONFLICT(title_id) DO UPDATE SET status=EXCLUDED.status,observation=EXCLUDED.observation,next_action=EXCLUDED.next_action,
  next_date=EXCLUDED.next_date,payment_date=EXCLUDED.payment_date,revision=collection_cases.revision+1,
  finalized_at=EXCLUDED.finalized_at,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at RETURNING * INTO v_case;
 INSERT INTO public.collection_case_events(title_id,case_revision,status,observation,next_action,next_date,payment_date,finalized,created_by)
 VALUES(p_title_id,v_case.revision,p_status,v_case.observation,v_case.next_action,p_next_date,p_payment_date,p_finish,auth.uid());
 IF p_finish THEN UPDATE public.collection_work_sessions SET ended_at=greatest(started_at,v_now),end_reason='FINISH'
  WHERE title_id=p_title_id AND actor_id=auth.uid() AND ended_at IS NULL;END IF;
 SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id;
 v_result:=jsonb_build_object('title_id',p_title_id,'revision',v_title.revision,'case_revision',v_case.revision,'event_id',v_event,
  'finished',p_finish,'timer',cf_private.collection_workbench_timer(p_title_id,clock_timestamp()));
 INSERT INTO public.collection_work_requests(actor_id,request_id,title_id,payload,result) VALUES(auth.uid(),p_request_id,p_title_id,v_payload,v_result);RETURN v_result;
END $$;

CREATE FUNCTION public.collection_work_summary(p_start date,p_end date,p_collector_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;v_now timestamptz:=statement_timestamp();v_start timestamptz;v_end timestamptz;
 v_total bigint;v_count bigint;v_running bigint;v_titles bigint;v_owners jsonb;v_days jsonb;v_rows jsonb;v_finance boolean;BEGIN
 PERFORM cf_private.require_collection_workbench_read();
 IF p_start IS NULL AND p_end IS NULL THEN p_start:=date_trunc('month',v_today)::date;p_end:=(p_start+interval '1 month - 1 day')::date;END IF;
 IF p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end>DATE '2199-12-31' OR p_end<p_start OR p_end-p_start>365 THEN
  RAISE EXCEPTION 'Informe um período de até 366 dias.' USING ERRCODE='22023';END IF;
 v_start:=p_start::timestamp AT TIME ZONE 'America/Sao_Paulo';v_end:=(p_end+1)::timestamp AT TIME ZONE 'America/Sao_Paulo';
 v_finance:=cf_private.has_permission('contas_receber','read') AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role_key IN ('gerente_geral','diretor','contas_receber'));
 WITH intervals AS MATERIALIZED(
  SELECT s.*,s.document_snapshot AS document,s.client_name_snapshot AS client_name,s.branch_snapshot AS branch,s.collector_name_snapshot AS collector_name,p.display_name AS actor_name,
   greatest(s.started_at,v_start) AS clipped_start,least(coalesce(s.ended_at,v_now),v_end,v_now) AS clipped_end,
   greatest(0,floor(extract(epoch FROM(least(coalesce(s.ended_at,v_now),v_end,v_now)-greatest(s.started_at,v_start)))))::bigint AS seconds
  FROM public.collection_work_sessions s JOIN public.profiles p ON p.id=s.actor_id
  WHERE (v_finance OR (s.actor_id=auth.uid() AND s.collector_id=cf_private.current_collector_id())) AND (p_collector_id IS NULL OR s.collector_id=p_collector_id)
   AND s.started_at<least(v_end,v_now) AND coalesce(s.ended_at,v_now)>v_start
 ),daily AS(
  SELECT d.day::date AS day,i.title_id,i.id,
   -- Arredondamento cumulativo: transporta a fração na meia-noite sem criar
   -- segundos; a soma dos dias permanece igual ao intervalo inteiro arredondado.
   greatest(0,floor(extract(epoch FROM(least(i.clipped_end,(d.day+interval '1 day') AT TIME ZONE 'America/Sao_Paulo')-i.clipped_start)))-
    floor(extract(epoch FROM(greatest(i.clipped_start,d.day AT TIME ZONE 'America/Sao_Paulo')-i.clipped_start)))) AS seconds
  FROM intervals i CROSS JOIN LATERAL generate_series((i.clipped_start AT TIME ZONE 'America/Sao_Paulo')::date::timestamp,
   (i.clipped_end AT TIME ZONE 'America/Sao_Paulo')::date::timestamp,interval '1 day') d(day)
 ) SELECT coalesce(sum(i.seconds),0),count(*),count(*) FILTER(WHERE i.ended_at IS NULL),count(DISTINCT i.title_id),
  (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY collector_id),'[]'::jsonb) FROM(
   SELECT collector_id,max(collector_name) AS display_name,sum(seconds) AS total_seconds,count(*) AS session_count,
    count(*) FILTER(WHERE ended_at IS NULL) AS running_count,count(DISTINCT title_id) AS title_count FROM intervals GROUP BY collector_id)o),
  (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY date),'[]'::jsonb) FROM(
   SELECT day AS date,floor(sum(seconds))::bigint AS total_seconds,count(DISTINCT id) AS session_count,count(DISTINCT title_id) AS title_count
    FROM daily WHERE seconds>0 GROUP BY day)d),
  (SELECT coalesce(jsonb_agg(jsonb_build_object('session_id',r.id,'title_id',r.title_id,'document',r.document,'client_name',r.client_name,'branch',r.branch,
   'collector_id',r.collector_id,'collector_name',r.collector_name,'actor_id',r.actor_id,'actor_name',r.actor_name,'started_at',r.started_at,
   'ended_at',r.ended_at,'end_reason',r.end_reason,'seconds',r.seconds,'running',r.ended_at IS NULL) ORDER BY r.started_at DESC,r.id DESC),'[]'::jsonb)
   FROM(SELECT * FROM intervals ORDER BY started_at DESC,id DESC LIMIT 1000)r)
 INTO v_total,v_count,v_running,v_titles,v_owners,v_days,v_rows FROM intervals i;
 IF v_total>9007199254740991 OR v_count>9007199254740991 THEN RAISE EXCEPTION 'O total de tempo excede o limite de precisão.' USING ERRCODE='22003';END IF;
 RETURN jsonb_build_object('start',p_start,'end',p_end,'as_of_date',v_today,'server_now',v_now,'total_seconds',v_total,'session_count',v_count,
  'running_count',v_running,'title_count',v_titles,'by_collector',v_owners,'by_day',v_days,'rows',v_rows,'truncated',v_count>1000);
END $$;

REVOKE ALL ON FUNCTION cf_private.collection_workbench_bump(),cf_private.audit_collection_workbench(),cf_private.guard_collection_work_session(),
 cf_private.close_settled_collection_work(),cf_private.require_collection_workbench_read(),cf_private.collection_workbench_visible(public.receivable_titles),
 cf_private.collection_workbench_title(uuid),cf_private.collection_workbench_timer(uuid,timestamptz),cf_private.collection_workbench_row(public.receivable_titles,timestamptz),cf_private.collection_workbench_legacy_status(text),
 cf_private.collection_work_request_replay(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.collection_workbench(text,uuid,boolean,text,text,text,integer,integer,text,date,date,text,text),
 public.collection_case_detail(uuid),public.collection_work_action(uuid,text,bigint,uuid),
 public.save_collection_case(uuid,text,text,text,date,bigint,bigint,date,boolean,uuid),public.collection_work_summary(date,date,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.collection_workbench(text,uuid,boolean,text,text,text,integer,integer,text,date,date,text,text),
 public.collection_case_detail(uuid),public.collection_work_action(uuid,text,bigint,uuid),
 public.save_collection_case(uuid,text,text,text,date,bigint,bigint,date,boolean,uuid),public.collection_work_summary(date,date,uuid) TO authenticated;
COMMENT ON TABLE public.collection_work_sessions IS 'Intervalos de servidor, um em andamento por usuário. Pausar/finalizar não confirma quitação; validação financeira encerra o intervalo sem alterar o tempo anterior.';
INSERT INTO public.central_schema_migrations(version) VALUES('026_collection_workbench');
-- END SOURCE BODY: 026_collection_workbench.sql
$cf_cr_source_026_1713f3bb5ebc4830_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='026_collection_workbench') THEN
      RAISE EXCEPTION 'A atualização 026_collection_workbench não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_cr_apply_026_487624d16feb7286_0$;

COMMIT;
