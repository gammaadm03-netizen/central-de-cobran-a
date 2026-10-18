-- CENTRAL FINANCEIRA — ativação da operação de Contas a Receber e Cobrança (022 a 025).
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

COMMIT;
