-- CENTRAL FINANCEIRA — ativação da operação de Contas a Receber e Cobrança (022 a 030).
-- Copie o arquivo inteiro no SQL Editor. Uma transação: falha desfaz toda a ativação.
-- Pode ser executado novamente: pula versões já registradas, sem refazer dados.
-- Preserva usuários, títulos, responsáveis, recebimentos, saldos, arquivos e históricos.
-- Exige a base de Contas a Receber e Cobrança até 009; não depende de CP 010 a 021.
-- Não executa importação de planilhas nem deploy de funções.
-- 027/028 acrescentam contatos e descrições somente no atendimento da Cobrança.
-- 029 acrescenta o ciclo de atendimento, a agenda e o encaminhamento para conferência financeira.
-- 030 exige a escolha oficial de responsável na importação de clientes sem carteira.
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

-- SOURCE: 027_collection_customer_context.sql
DO $cf_cr_apply_027_32bda7350ba3f07d_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='027_collection_customer_context') THEN
    RAISE NOTICE 'Atualização 027_collection_customer_context já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_cr_source_027_df7cdb5a826dab29_0$
-- SOURCE BODY: 027_collection_customer_context.sql
-- Contatos revisáveis e referências por cliente/documento, somente na Cobrança.
-- Não altera títulos, quitações, responsáveis ou regras de comissão.

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
-- END SOURCE BODY: 027_collection_customer_context.sql
$cf_cr_source_027_df7cdb5a826dab29_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='027_collection_customer_context') THEN
      RAISE EXCEPTION 'A atualização 027_collection_customer_context não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_cr_apply_027_32bda7350ba3f07d_0$;

-- SOURCE: 028_collection_reference_imports.sql
DO $cf_cr_apply_028_fb8f880b4a6702bd_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='028_collection_reference_imports') THEN
    RAISE NOTICE 'Atualização 028_collection_reference_imports já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_cr_source_028_822e636301cc0518_0$
-- SOURCE BODY: 028_collection_reference_imports.sql
-- Fontes privadas e preparação limitada; publicação oficial única e transacional.
-- CSV efetivo é artefato derivado, distinto do arquivo original preservado.

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='027_collection_customer_context') OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='023_receivable_sync') THEN
  RAISE EXCEPTION 'Ative as atualizações 023 e 027 antes das referências de Cobrança.' USING ERRCODE='22023';END IF;
 IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
  RAISE EXCEPTION 'O armazenamento privado do Supabase precisa estar disponível.' USING ERRCODE='22023';END IF;
END $$;

CREATE TABLE cf_private.collection_reference_jobs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 mode text NOT NULL CHECK(mode IN ('CONTACTS','DESCRIPTIONS')),source_name text NOT NULL,source_size bigint NOT NULL CHECK(source_size BETWEEN 1 AND 16777216),
 source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),storage_path text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'UPLOADING' CHECK(status IN ('UPLOADING','VERIFIED','STAGING','PREPARED','PUBLISHING','PUBLISHED')),
 original_verified boolean NOT NULL DEFAULT false,verified_at timestamptz,manifest_sha256 text,
 staged_rows integer NOT NULL DEFAULT 0,staged_chunks integer NOT NULL DEFAULT 0,staged_input_rows integer NOT NULL DEFAULT 0,staged_bytes bigint NOT NULL DEFAULT 0,
 analysis_financial_revision text,analysis_at timestamptz,last_result jsonb,published_at timestamptz,
 UNIQUE(created_by,mode,source_sha256)
);
CREATE TABLE cf_private.collection_reference_chunks(
 job_id uuid NOT NULL REFERENCES cf_private.collection_reference_jobs(id),chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 1023),
 sha256 text NOT NULL,rows_sha256 text NOT NULL,artifact bytea NOT NULL CHECK(octet_length(artifact) BETWEEN 1 AND 262144),row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 500),
 problems jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(job_id,chunk_index)
);
CREATE TABLE cf_private.collection_reference_rows(
 job_id uuid NOT NULL REFERENCES cf_private.collection_reference_jobs(id),row_hash text NOT NULL,source_line integer NOT NULL,
 canonical jsonb NOT NULL,problems jsonb NOT NULL,customer_key text,context_key text,invalid boolean NOT NULL,
 outcome text NOT NULL DEFAULT 'UNMATCHED',analysis_problem text,matched_title_count integer NOT NULL DEFAULT 0,applied boolean NOT NULL DEFAULT false,
 PRIMARY KEY(job_id,row_hash)
);
CREATE INDEX collection_reference_row_customer ON cf_private.collection_reference_rows(job_id,customer_key);
CREATE INDEX collection_reference_row_context ON cf_private.collection_reference_rows(job_id,context_key);
CREATE TABLE cf_private.collection_reference_publish_requests(
 actor_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES cf_private.collection_reference_jobs(id),
 payload jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id)
);
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['collection_reference_jobs','collection_reference_chunks','collection_reference_rows','collection_reference_publish_requests'] LOOP
  EXECUTE format('ALTER TABLE cf_private.%I ENABLE ROW LEVEL SECURITY',v_table);
  EXECUTE format('REVOKE ALL ON TABLE cf_private.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
 END LOOP;
END $$;
ALTER TABLE public.collection_customer_contacts ADD CONSTRAINT collection_contact_source_job FOREIGN KEY(source_job_id) REFERENCES cf_private.collection_reference_jobs(id);
ALTER TABLE public.collection_description_references ADD CONSTRAINT collection_description_source_job FOREIGN KEY(source_job_id) REFERENCES cf_private.collection_reference_jobs(id);
CREATE TRIGGER collection_reference_chunk_immutable BEFORE UPDATE OR DELETE ON cf_private.collection_reference_chunks FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE TRIGGER collection_reference_publish_immutable BEFORE UPDATE OR DELETE ON cf_private.collection_reference_publish_requests FOR EACH ROW EXECUTE FUNCTION cf_private.block_audit_changes();
CREATE FUNCTION cf_private.collection_reference_job_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.created_by,NEW.created_at,NEW.mode,NEW.source_name,NEW.source_size,NEW.source_sha256,NEW.storage_path)
  IS DISTINCT FROM ROW(OLD.id,OLD.created_by,OLD.created_at,OLD.mode,OLD.source_name,OLD.source_size,OLD.source_sha256,OLD.storage_path)
  OR OLD.original_verified AND NOT NEW.original_verified OR OLD.manifest_sha256 IS NOT NULL AND NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256 THEN
  RAISE EXCEPTION 'A fonte e o manifesto preparados são imutáveis.' USING ERRCODE='42501';END IF;RETURN NEW;
END $$;
CREATE TRIGGER collection_reference_job_immutable BEFORE UPDATE OR DELETE ON cf_private.collection_reference_jobs FOR EACH ROW EXECUTE FUNCTION cf_private.collection_reference_job_guard();
CREATE FUNCTION cf_private.collection_reference_row_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.row_hash,NEW.source_line,NEW.canonical,NEW.problems,NEW.customer_key,NEW.context_key,NEW.invalid)
  IS DISTINCT FROM ROW(OLD.job_id,OLD.row_hash,OLD.source_line,OLD.canonical,OLD.problems,OLD.customer_key,OLD.context_key,OLD.invalid)
  OR OLD.applied AND NOT NEW.applied THEN RAISE EXCEPTION 'O artefato preparado é imutável.' USING ERRCODE='42501';END IF;RETURN NEW;
END $$;
CREATE TRIGGER collection_reference_rows_immutable BEFORE UPDATE OR DELETE ON cf_private.collection_reference_rows FOR EACH ROW EXECUTE FUNCTION cf_private.collection_reference_row_guard();

CREATE FUNCTION cf_private.require_collection_reference_import() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM cf_private.require_receivable_finance('read');PERFORM cf_private.require_receivable_finance('write');PERFORM cf_private.require_receivable_finance('import');
 IF NOT cf_private.has_permission('importar_bases','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION cf_private.collection_reference_actor(p_user_id uuid,p_session_id text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM cf_private.set_receivable_sync_actor(p_user_id,p_session_id);PERFORM cf_private.require_collection_reference_import();
END $$;
CREATE FUNCTION cf_private.collection_reference_owned_job(p_job_id uuid) RETURNS cf_private.collection_reference_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;BEGIN
 PERFORM cf_private.require_collection_reference_import();SELECT * INTO v_job FROM cf_private.collection_reference_jobs WHERE id=p_job_id AND created_by=auth.uid();
 IF NOT FOUND THEN RAISE EXCEPTION 'Importação indisponível.' USING ERRCODE='42501';END IF;RETURN v_job;
END $$;
CREATE FUNCTION cf_private.collection_reference_job_json(p_job cf_private.collection_reference_jobs) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('job_id',p_job.id,'mode',p_job.mode,'status',p_job.status,'bucket','collection-reference-files','storage_path',p_job.storage_path,
  'source_name',p_job.source_name,'source_size',p_job.source_size,'source_sha256',p_job.source_sha256,'original_verified',p_job.original_verified,
  'manifest_sha256',p_job.manifest_sha256,'staged_rows',p_job.staged_rows,'staged_chunks',p_job.staged_chunks,'created_at',p_job.created_at,'published_at',p_job.published_at);
$$;
CREATE FUNCTION cf_private.collection_reference_storage_allowed(p_name text,p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT current_setting('role',true)<>'anon' AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.enabled AND p.role_key IN ('gerente_geral','contas_receber'))
  AND cf_private.has_permission('contas_receber','read') AND cf_private.has_permission('contas_receber','write') AND cf_private.has_permission('contas_receber','import')
  AND cf_private.has_permission('importar_bases','read') AND EXISTS(SELECT 1 FROM cf_private.collection_reference_jobs j WHERE j.created_by=auth.uid()
   AND j.storage_path=p_name AND (NOT p_write OR j.status='UPLOADING' AND NOT j.original_verified));
$$;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('collection-reference-files','collection-reference-files',false,16777216,NULL)
 ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=16777216;
CREATE POLICY collection_reference_upload ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='collection-reference-files' AND cf_private.collection_reference_storage_allowed(name,true));
CREATE POLICY collection_reference_download ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='collection-reference-files' AND cf_private.collection_reference_storage_allowed(name,false));
CREATE POLICY collection_reference_insert_guard ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated
 WITH CHECK(bucket_id<>'collection-reference-files' OR cf_private.collection_reference_storage_allowed(name,true));
CREATE POLICY collection_reference_read_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO anon,authenticated
 USING(bucket_id<>'collection-reference-files' OR cf_private.collection_reference_storage_allowed(name,false));
CREATE POLICY collection_reference_no_overwrite ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated
 USING(bucket_id<>'collection-reference-files') WITH CHECK(bucket_id<>'collection-reference-files');
CREATE POLICY collection_reference_no_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated USING(bucket_id<>'collection-reference-files');

CREATE FUNCTION public.begin_collection_reference_import_from_gateway(p_user_id uuid,p_session_id text,p_mode text,p_file_name text,p_file_size bigint,p_file_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_id uuid:=gen_random_uuid();BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);
 IF p_mode IS NULL OR p_mode NOT IN ('CONTACTS','DESCRIPTIONS') OR p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 250
  OR p_file_name~'[/\\[:cntrl:]]' OR p_file_size IS NULL OR p_file_size NOT BETWEEN 1 AND 16777216 OR p_file_sha256 IS NULL OR p_file_sha256!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Confira modo, nome, tamanho e integridade da fonte.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_job FROM cf_private.collection_reference_jobs WHERE created_by=auth.uid() AND mode=p_mode AND source_sha256=p_file_sha256;
 IF FOUND THEN IF v_job.source_size<>p_file_size THEN RAISE EXCEPTION 'A fonte não corresponde à importação já criada.' USING ERRCODE='22023';END IF;
  RETURN cf_private.collection_reference_job_json(v_job)||jsonb_build_object('reused',true);END IF;
 INSERT INTO cf_private.collection_reference_jobs(id,created_by,mode,source_name,source_size,source_sha256,storage_path)
 VALUES(v_id,auth.uid(),p_mode,btrim(p_file_name),p_file_size,p_file_sha256,auth.uid()::text||'/'||v_id::text||'/original') RETURNING * INTO v_job;
 RETURN cf_private.collection_reference_job_json(v_job)||jsonb_build_object('reused',false);
END $$;
CREATE FUNCTION public.get_collection_reference_job_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);
 RETURN cf_private.collection_reference_job_json(cf_private.collection_reference_owned_job(p_job_id));END $$;
CREATE FUNCTION public.list_collection_reference_imports_from_gateway(p_user_id uuid,p_session_id text,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_rows jsonb;v_count bigint;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);
 IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Paginação inválida.' USING ERRCODE='22023';END IF;
 SELECT count(*) INTO v_count FROM cf_private.collection_reference_jobs WHERE created_by=auth.uid();
 SELECT coalesce(jsonb_agg(cf_private.collection_reference_job_json(j) ORDER BY j.created_at DESC,j.id DESC),'[]'::jsonb) INTO v_rows
  FROM(SELECT * FROM cf_private.collection_reference_jobs WHERE created_by=auth.uid() ORDER BY created_at DESC,id DESC OFFSET p_offset LIMIT p_limit)j;
 RETURN jsonb_build_object('count',v_count,'rows',v_rows);
END $$;
CREATE FUNCTION public.verify_collection_reference_original_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_verified_sha256 text,p_verified_size bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF p_verified_sha256 IS DISTINCT FROM v_job.source_sha256 OR p_verified_size IS DISTINCT FROM v_job.source_size OR NOT EXISTS(
  SELECT 1 FROM storage.objects WHERE bucket_id='collection-reference-files' AND name=v_job.storage_path) THEN
  RAISE EXCEPTION 'O original privado não teve sua integridade confirmada.' USING ERRCODE='22023';END IF;
 IF NOT v_job.original_verified THEN UPDATE cf_private.collection_reference_jobs SET original_verified=true,verified_at=clock_timestamp(),status='VERIFIED'
  WHERE id=p_job_id RETURNING * INTO v_job;END IF;RETURN cf_private.collection_reference_job_json(v_job);
END $$;

CREATE FUNCTION public.stage_collection_reference_chunk_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_chunk_index integer,p_chunk_sha256 text,
 p_chunk_base64 text,p_rows jsonb,p_problems jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_chunk cf_private.collection_reference_chunks%ROWTYPE;v_bytes bytea;v_row jsonb;v_canonical jsonb;
 v_problem jsonb;v_customer text;v_context text;v_invalid boolean;v_hash text;v_inserted integer:=0;v_count integer;v_field text;v_value jsonb;v_dummy jsonb;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF NOT v_job.original_verified OR p_chunk_index IS NULL OR p_chunk_index NOT BETWEEN 0 AND 1023 OR p_chunk_sha256 IS NULL OR p_chunk_sha256!~'^[a-f0-9]{64}$'
  OR p_chunk_base64 IS NULL OR length(p_chunk_base64) NOT BETWEEN 1 AND 349528 OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500
  OR p_problems IS NULL OR jsonb_typeof(p_problems)<>'array' OR jsonb_array_length(p_problems)>10000 OR octet_length(p_problems::text)>1048576 THEN
  RAISE EXCEPTION 'Lote inválido ou original ainda não verificado.' USING ERRCODE='22023';END IF;
 BEGIN v_bytes:=decode(p_chunk_base64,'base64');EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN RAISE EXCEPTION 'CSV derivado inválido.' USING ERRCODE='22023';END;
 IF octet_length(v_bytes) NOT BETWEEN 1 AND 262144 OR encode(sha256(v_bytes),'hex')<>p_chunk_sha256 THEN RAISE EXCEPTION 'A integridade do CSV derivado não foi confirmada.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_chunk FROM cf_private.collection_reference_chunks WHERE job_id=p_job_id AND chunk_index=p_chunk_index;
 IF FOUND THEN IF v_chunk.sha256<>p_chunk_sha256 OR v_chunk.rows_sha256<>encode(sha256(convert_to(p_rows::text,'UTF8')),'hex') OR v_chunk.row_count<>jsonb_array_length(p_rows) OR v_chunk.problems<>p_problems THEN
  RAISE EXCEPTION 'O lote já existe com outro conteúdo.' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('job_id',p_job_id,'chunk_index',p_chunk_index,'row_count',v_chunk.row_count,'duplicate',true,'staged_rows',v_job.staged_rows,'staged_chunks',v_job.staged_chunks);END IF;
 IF v_job.status NOT IN ('VERIFIED','STAGING') OR v_job.staged_input_rows+jsonb_array_length(p_rows)>300000 OR v_job.staged_bytes+octet_length(v_bytes)>134217728 THEN
  RAISE EXCEPTION 'A preparação está encerrada ou excedeu o limite permitido.' USING ERRCODE='22023';END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(v_row)<>'object' OR jsonb_typeof(v_row->'source_line')<>'number' OR (v_row->>'source_line')::numeric<>trunc((v_row->>'source_line')::numeric)
   OR (v_row->>'source_line')::numeric NOT BETWEEN 1 AND 1000000 OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN
    ('source_line','client_name','client_document','emails','phones','notes','document','branch','description','contract')) THEN RAISE EXCEPTION 'Estrutura de linha inválida.' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(v_row->'client_name') IS DISTINCT FROM 'string' OR length(v_row->>'client_name')>1500
   OR (v_row->'client_document' IS NOT NULL AND jsonb_typeof(v_row->'client_document') NOT IN ('string','null')) THEN RAISE EXCEPTION 'Identificação do cliente inválida.' USING ERRCODE='22023';END IF;
  v_canonical:=v_row-'source_line';v_canonical:=v_canonical||jsonb_build_object('client_name',cf_private.normalize_receivable_text(v_row->>'client_name'),'client_document',nullif(v_row->>'client_document',''));
  v_invalid:=length(v_canonical->>'client_name')=0 OR (v_canonical->>'client_document' IS NOT NULL AND v_canonical->>'client_document'!~'^[0-9]{14}$');
  SELECT coalesce(jsonb_agg(p),'[]'::jsonb) INTO v_problem FROM jsonb_array_elements(p_problems)p WHERE p->>'source_line'=v_row->>'source_line';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_problem)p WHERE coalesce(p->>'code','') NOT LIKE 'WARN\_%' ESCAPE '\') THEN v_invalid:=true;END IF;
  IF v_job.mode='CONTACTS' THEN
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_canonical) k WHERE k NOT IN ('client_name','client_document','emails','phones','notes')) OR
    jsonb_typeof(v_canonical->'emails') IS DISTINCT FROM 'array' OR jsonb_typeof(v_canonical->'phones') IS DISTINCT FROM 'array' OR
    jsonb_array_length(v_canonical->'emails')>50 OR jsonb_array_length(v_canonical->'phones')>50 OR length(coalesce(v_canonical->>'notes',''))>5000 THEN
    RAISE EXCEPTION 'Canais de contato inválidos.' USING ERRCODE='22023';END IF;
   BEGIN
    v_dummy:=cf_private.normalize_collection_contact_methods(v_canonical->'emails','emails');v_canonical:=v_canonical||jsonb_build_object('emails',v_dummy);
    v_dummy:=cf_private.normalize_collection_contact_methods(v_canonical->'phones','phones');v_canonical:=v_canonical||jsonb_build_object('phones',v_dummy);
   EXCEPTION WHEN invalid_parameter_value THEN v_invalid:=true;END;
   IF jsonb_array_length(v_canonical->'emails')=0 AND jsonb_array_length(v_canonical->'phones')=0 THEN v_invalid:=true;END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_canonical) k WHERE k NOT IN ('client_name','client_document','document','branch','description','contract')) THEN RAISE EXCEPTION 'Referência de documento inválida.' USING ERRCODE='22023';END IF;
   FOREACH v_field IN ARRAY ARRAY['document','branch','description'] LOOP
    IF jsonb_typeof(v_canonical->v_field) IS DISTINCT FROM 'string' OR length(v_canonical->>v_field)>(CASE WHEN v_field='description' THEN 12000 ELSE 150 END) THEN
     RAISE EXCEPTION 'Campo de descrição inválido ou muito longo.' USING ERRCODE='22023';END IF;
    IF length(cf_private.normalize_receivable_text(v_canonical->>v_field))=0 THEN v_invalid:=true;END IF;
   END LOOP;
   IF v_canonical->'contract' IS NOT NULL AND jsonb_typeof(v_canonical->'contract') NOT IN ('string','null') OR length(coalesce(v_canonical->>'contract',''))>300 THEN
    RAISE EXCEPTION 'Contrato inválido.' USING ERRCODE='22023';END IF;
   v_canonical:=v_canonical||jsonb_build_object('document',cf_private.normalize_receivable_text(v_canonical->>'document'),
    'branch',cf_private.normalize_receivable_text(v_canonical->>'branch'),'description',btrim(v_canonical->>'description'),'contract',nullif(btrim(v_canonical->>'contract'),''));
  END IF;
  v_customer:=CASE WHEN length(v_canonical->>'client_name')>0 THEN cf_private.receivable_customer_key(v_canonical->>'client_name',v_canonical->>'client_document') END;
  v_context:=CASE WHEN v_job.mode='DESCRIPTIONS' AND v_customer IS NOT NULL THEN cf_private.collection_reference_key(v_canonical->>'branch',v_canonical->>'document',v_customer) END;
  v_hash:=encode(sha256(convert_to(v_canonical::text,'UTF8')),'hex');
  INSERT INTO cf_private.collection_reference_rows(job_id,row_hash,source_line,canonical,problems,customer_key,context_key,invalid,outcome)
   VALUES(p_job_id,v_hash,(v_row->>'source_line')::integer,v_canonical,v_problem,v_customer,v_context,v_invalid,CASE WHEN v_invalid THEN 'INVALID' ELSE 'UNMATCHED' END) ON CONFLICT(job_id,row_hash) DO NOTHING;
  GET DIAGNOSTICS v_count=ROW_COUNT;v_inserted:=v_inserted+v_count;
 END LOOP;
 INSERT INTO cf_private.collection_reference_chunks(job_id,chunk_index,sha256,rows_sha256,artifact,row_count,problems)
  VALUES(p_job_id,p_chunk_index,p_chunk_sha256,encode(sha256(convert_to(p_rows::text,'UTF8')),'hex'),v_bytes,jsonb_array_length(p_rows),p_problems);
 UPDATE cf_private.collection_reference_jobs SET status='STAGING',staged_rows=staged_rows+v_inserted,staged_chunks=staged_chunks+1,
  staged_input_rows=staged_input_rows+jsonb_array_length(p_rows),staged_bytes=staged_bytes+octet_length(v_bytes) WHERE id=p_job_id RETURNING * INTO v_job;
 RETURN jsonb_build_object('job_id',p_job_id,'chunk_index',p_chunk_index,'row_count',jsonb_array_length(p_rows),'duplicate',false,'staged_rows',v_job.staged_rows,'staged_chunks',v_job.staged_chunks);
END $$;
CREATE FUNCTION public.finish_collection_reference_prepare_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_expected_chunks integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_manifest text;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF NOT v_job.original_verified OR p_expected_chunks IS NULL OR p_expected_chunks NOT BETWEEN 1 AND 1024 OR v_job.staged_chunks<>p_expected_chunks OR EXISTS(
  SELECT 1 FROM generate_series(0,p_expected_chunks-1)i WHERE NOT EXISTS(SELECT 1 FROM cf_private.collection_reference_chunks WHERE job_id=p_job_id AND chunk_index=i)) THEN
  RAISE EXCEPTION 'A preparação ainda não contém todos os lotes do arquivo.' USING ERRCODE='22023';END IF;
 SELECT encode(sha256(convert_to(string_agg(chunk_index::text||':'||sha256||':'||row_count::text,E'\n' ORDER BY chunk_index),'UTF8')),'hex') INTO v_manifest
  FROM cf_private.collection_reference_chunks WHERE job_id=p_job_id;
 IF v_job.manifest_sha256 IS NULL THEN UPDATE cf_private.collection_reference_jobs SET manifest_sha256=v_manifest,status='PREPARED' WHERE id=p_job_id RETURNING * INTO v_job;
 ELSIF v_job.manifest_sha256<>v_manifest THEN RAISE EXCEPTION 'O manifesto da preparação mudou.' USING ERRCODE='22023';END IF;
 RETURN cf_private.collection_reference_job_json(v_job);
END $$;

-- Materializar as chaves dos títulos uma única vez evita varrer a carteira
-- para cada uma das dezenas de milhares de referências privadas.
CREATE FUNCTION cf_private.analyze_collection_reference_job(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;BEGIN
 SELECT * INTO v_job FROM cf_private.collection_reference_jobs WHERE id=p_job_id;
 WITH titles AS MATERIALIZED(
  SELECT t.customer_key,t.status,cf_private.collection_reference_key(t.branch,t.document,t.customer_key) AS context_key,
   cf_private.receivable_customer_key(t.client_name,NULL) AS name_key,t.client_document,
   cf_private.collection_reference_key(t.branch,t.document,cf_private.receivable_customer_key(t.client_name,NULL)) AS name_context
  FROM public.receivable_titles t WHERE t.scope='grupo-consolidado'
 ),customers AS MATERIALIZED(
  SELECT customer_key,count(*) FILTER(WHERE status<>'VALIDATED')::integer AS active_count,count(*) FILTER(WHERE status='VALIDATED') AS paid_count FROM titles GROUP BY customer_key
 ),contexts AS MATERIALIZED(
  SELECT context_key,count(*) FILTER(WHERE status<>'VALIDATED')::integer AS active_count,count(*) FILTER(WHERE status='VALIDATED') AS paid_count FROM titles GROUP BY context_key
 ),names AS MATERIALIZED(SELECT name_key,count(*) AS count FROM titles WHERE client_document IS NOT NULL GROUP BY name_key),
 name_contexts AS MATERIALIZED(SELECT name_context,count(*) AS count FROM titles WHERE client_document IS NOT NULL GROUP BY name_context),
 classified AS MATERIALIZED(
  SELECT r.row_hash,r.customer_key,CASE WHEN r.invalid THEN 'INVALID'
   WHEN v_job.mode='CONTACTS' THEN CASE
    WHEN r.canonical->>'client_document' IS NULL AND coalesce(n.count,0)>0 THEN 'AMBIGUOUS'
    WHEN coalesce(c.active_count,0)+coalesce(c.paid_count,0)>0 THEN CASE WHEN card.manually_edited THEN 'MANUAL_PRESERVED' ELSE 'MATCHED' END
    WHEN r.customer_key LIKE 'name:%' THEN CASE WHEN card.manually_edited THEN 'MANUAL_PRESERVED' ELSE 'MATCHED' END
    ELSE 'UNMATCHED' END
   WHEN coalesce(k.active_count,0)>0 THEN 'MATCHED'
   WHEN coalesce(k.paid_count,0)>0 THEN 'PAID_ONLY'
   WHEN r.canonical->>'client_document' IS NULL AND coalesce(nk.count,0)>0 THEN 'AMBIGUOUS'
   ELSE 'UNMATCHED' END AS outcome,
   CASE WHEN v_job.mode='CONTACTS' THEN coalesce(c.active_count,0) ELSE coalesce(k.active_count,0) END AS title_count
  FROM cf_private.collection_reference_rows r LEFT JOIN customers c USING(customer_key) LEFT JOIN contexts k USING(context_key)
   LEFT JOIN public.collection_customer_contacts card USING(customer_key)
   LEFT JOIN names n ON n.name_key=cf_private.receivable_customer_key(r.canonical->>'client_name',NULL)
   LEFT JOIN name_contexts nk ON nk.name_context=cf_private.collection_reference_key(r.canonical->>'branch',r.canonical->>'document',cf_private.receivable_customer_key(r.canonical->>'client_name',NULL))
  WHERE r.job_id=p_job_id
 ),clients AS MATERIALIZED(SELECT DISTINCT customer_key FROM classified WHERE v_job.mode='CONTACTS' AND outcome='MATCHED'),
 methods AS(
  SELECT r.customer_key,'email' AS kind,e#>>'{}' AS value FROM cf_private.collection_reference_rows r JOIN clients c USING(customer_key)
   JOIN classified s ON s.row_hash=r.row_hash AND s.outcome='MATCHED'
   CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'emails')e WHERE r.job_id=p_job_id
  UNION SELECT r.customer_key,'phone',p#>>'{}' FROM cf_private.collection_reference_rows r JOIN clients c USING(customer_key)
   JOIN classified s ON s.row_hash=r.row_hash AND s.outcome='MATCHED'
   CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'phones')p WHERE r.job_id=p_job_id
  UNION SELECT c.customer_key,'email',e#>>'{}' FROM public.collection_customer_contacts c JOIN clients s USING(customer_key) CROSS JOIN LATERAL jsonb_array_elements(c.emails)e
  UNION SELECT c.customer_key,'phone',p#>>'{}' FROM public.collection_customer_contacts c JOIN clients s USING(customer_key) CROSS JOIN LATERAL jsonb_array_elements(c.phones)p
 ),overflow AS MATERIALIZED(SELECT DISTINCT customer_key FROM methods GROUP BY customer_key,kind HAVING count(DISTINCT value)>50),
 resolved AS(
  SELECT c.row_hash,c.title_count,CASE WHEN o.customer_key IS NOT NULL THEN 'INVALID' ELSE c.outcome END AS outcome,
   CASE WHEN o.customer_key IS NOT NULL THEN 'LIMIT_METHODS: o cliente excederia 50 e-mails ou telefones; nenhum canal foi truncado.' END AS problem
  FROM classified c LEFT JOIN overflow o USING(customer_key)
 ) UPDATE cf_private.collection_reference_rows r SET outcome=c.outcome,analysis_problem=c.problem,matched_title_count=c.title_count
  FROM resolved c WHERE r.job_id=p_job_id AND r.row_hash=c.row_hash
   AND ROW(r.outcome,r.matched_title_count,r.analysis_problem) IS DISTINCT FROM ROW(c.outcome,c.title_count,c.problem);
 UPDATE cf_private.collection_reference_jobs SET analysis_financial_revision=cf_private.receivables_sync_revision_value(),analysis_at=clock_timestamp() WHERE id=p_job_id;
END $$;
CREATE FUNCTION public.preview_collection_reference_import_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_result jsonb;v_variants integer:=0;v_warnings integer;v_examples jsonb;v_context_revision text;v_matched_titles bigint;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF NOT v_job.original_verified OR v_job.manifest_sha256 IS NULL OR v_job.status NOT IN ('PREPARED','PUBLISHING','PUBLISHED') THEN
  RAISE EXCEPTION 'Conclua a preparação verificada antes da análise.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.analyze_collection_reference_job(p_job_id);
 SELECT jsonb_build_object('row_count',count(*),'deduplicated_count',v_job.staged_input_rows-count(*),
  'eligible_count',count(*) FILTER(WHERE outcome='MATCHED' AND NOT applied),'matched_title_count',coalesce(sum(matched_title_count),0),
  'unmatched_count',count(*) FILTER(WHERE outcome='UNMATCHED'),'paid_only_count',count(*) FILTER(WHERE outcome='PAID_ONLY'),
  'ambiguous_count',count(*) FILTER(WHERE outcome='AMBIGUOUS'),'invalid_count',count(*) FILTER(WHERE outcome='INVALID'),
  'manual_preserved_count',count(*) FILTER(WHERE outcome='MANUAL_PRESERVED'),
  'quarantine_count',count(*) FILTER(WHERE outcome IN ('UNMATCHED','PAID_ONLY','AMBIGUOUS','INVALID')),
  'processed_rows',count(*) FILTER(WHERE applied),'published_rows',count(*) FILTER(WHERE applied),'remaining_rows',count(*) FILTER(WHERE outcome='MATCHED' AND NOT applied)) INTO v_result
 FROM cf_private.collection_reference_rows WHERE job_id=p_job_id;
 WITH active_titles AS MATERIALIZED(SELECT id,customer_key,cf_private.collection_reference_key(branch,document,customer_key) AS context_key
  FROM public.receivable_titles WHERE scope='grupo-consolidado' AND status<>'VALIDATED'),
 matched_keys AS MATERIALIZED(SELECT DISTINCT CASE WHEN v_job.mode='CONTACTS' THEN customer_key ELSE context_key END AS key
  FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome IN ('MATCHED','MANUAL_PRESERVED'))
 SELECT count(DISTINCT t.id) INTO v_matched_titles FROM active_titles t JOIN matched_keys r
  ON r.key=CASE WHEN v_job.mode='CONTACTS' THEN t.customer_key ELSE t.context_key END;
 v_result:=v_result||jsonb_build_object('matched_title_count',v_matched_titles);
 IF v_job.mode='DESCRIPTIONS' THEN
  WITH incoming AS MATERIALIZED(SELECT DISTINCT context_key,encode(sha256(convert_to(jsonb_build_array(canonical->>'description',canonical->>'contract')::text,'UTF8')),'hex') AS hash
   FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome='MATCHED'),
  variants AS(SELECT context_key,hash FROM incoming UNION SELECT r.context_key,r.content_sha256 FROM public.collection_description_references r
   WHERE EXISTS(SELECT 1 FROM incoming i WHERE i.context_key=r.context_key))
  SELECT count(*) INTO v_variants FROM(SELECT context_key FROM variants GROUP BY context_key HAVING count(*)>1)x;
 END IF;
 SELECT count(*) INTO v_warnings FROM cf_private.collection_reference_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.problems)p
  WHERE c.job_id=p_job_id AND coalesce(p->>'code','') LIKE 'WARN\_%' ESCAPE '\';
 SELECT coalesce(jsonb_agg(jsonb_build_object('source_line',r.source_line,'outcome',r.outcome,'client_name',r.canonical->>'client_name',
  'document',r.canonical->>'document','branch',r.canonical->>'branch','problem',coalesce(r.analysis_problem,CASE r.outcome WHEN 'UNMATCHED' THEN 'Sem título ativo correspondente.'
   WHEN 'PAID_ONLY' THEN 'Somente títulos validados: referência mantida fora da exibição.' WHEN 'AMBIGUOUS' THEN 'Nome sem CNPJ não confirma o vínculo com este cadastro.'
   WHEN 'INVALID' THEN 'Linha com informação inválida ou incompleta; consulte a fonte privada.' WHEN 'MANUAL_PRESERVED' THEN 'Ficha já editada manualmente; preservada integralmente.' END))
  ORDER BY r.source_line,r.row_hash),'[]'::jsonb) INTO v_examples FROM(
   SELECT * FROM cf_private.collection_reference_rows WHERE job_id=p_job_id ORDER BY CASE WHEN outcome<>'MATCHED' THEN 0 ELSE 1 END,source_line,row_hash LIMIT 100)r;
 SELECT revision::text INTO v_context_revision FROM cf_private.collection_context_state WHERE singleton;
 RETURN v_result||jsonb_build_object('job_id',p_job_id,'mode',v_job.mode,'status',v_job.status,'financial_revision',cf_private.receivables_sync_revision_value(),
  'context_revision',v_context_revision,'manifest_sha256',v_job.manifest_sha256,'source',jsonb_build_object('name',v_job.source_name,'size',v_job.source_size,'sha256',v_job.source_sha256,'verified',true),
  'warning_count',v_warnings,'variant_count',v_variants,'can_publish',true,'requires_quarantine_confirmation',(v_result->>'quarantine_count')::integer>0,'examples',v_examples);
END $$;
CREATE FUNCTION public.publish_collection_reference_import_from_gateway(p_user_id uuid,p_session_id text,p_job_id uuid,p_previous_financial_revision text,
 p_confirm_quarantine boolean DEFAULT false,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job cf_private.collection_reference_jobs%ROWTYPE;v_request cf_private.collection_reference_publish_requests%ROWTYPE;v_payload jsonb;v_preview jsonb;v_result jsonb;
 v_quarantine integer;v_applied integer;v_manual integer;v_actor public.profiles%ROWTYPE;BEGIN
 PERFORM cf_private.collection_reference_actor(p_user_id,p_session_id);PERFORM pg_advisory_xact_lock(2045812308);v_job:=cf_private.collection_reference_owned_job(p_job_id);
 IF p_request_id IS NULL OR p_confirm_quarantine IS NULL THEN RAISE EXCEPTION 'Confirme a operação e seu identificador seguro.' USING ERRCODE='22023';END IF;
 v_payload:=jsonb_build_object('job_id',p_job_id,'previous_financial_revision',p_previous_financial_revision,'confirm_quarantine',p_confirm_quarantine);
 SELECT * INTO v_request FROM cf_private.collection_reference_publish_requests WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN IF v_request.job_id<>p_job_id OR v_request.payload<>v_payload THEN RAISE EXCEPTION 'Identificador usado para outra publicação.' USING ERRCODE='22023';END IF;RETURN v_request.result;END IF;
 IF NOT v_job.original_verified OR v_job.manifest_sha256 IS NULL OR v_job.status NOT IN ('PREPARED','PUBLISHING','PUBLISHED') OR p_previous_financial_revision IS NULL
  OR p_previous_financial_revision IS DISTINCT FROM v_job.analysis_financial_revision OR p_previous_financial_revision IS DISTINCT FROM cf_private.receivables_sync_revision_value() THEN
  RAISE EXCEPTION 'A carteira mudou ou a análise não está atual. Analise novamente antes de publicar.' USING ERRCODE='40001';END IF;
 v_preview:=public.preview_collection_reference_import_from_gateway(p_user_id,p_session_id,p_job_id);
 v_quarantine:=(v_preview->>'quarantine_count')::integer;v_manual:=(v_preview->>'manual_preserved_count')::integer;
 IF v_quarantine>0 AND NOT p_confirm_quarantine THEN RAISE EXCEPTION 'Confirme as referências sem vínculo, inválidas ou já quitadas; elas ficarão privadas fora da exibição.' USING ERRCODE='P0028';END IF;
 IF v_job.mode='CONTACTS' THEN
  WITH customers AS MATERIALIZED(
   SELECT customer_key,min(canonical->>'client_name') AS client_name,min(canonical->>'client_document') AS client_document,
    min(nullif(canonical->>'notes','')) AS notes FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome='MATCHED' AND NOT applied GROUP BY customer_key
  ),incoming AS(
   SELECT c.*,(SELECT coalesce(jsonb_agg(DISTINCT e ORDER BY e),'[]'::jsonb) FROM cf_private.collection_reference_rows r
    CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'emails')e WHERE r.job_id=p_job_id AND r.customer_key=c.customer_key AND r.outcome='MATCHED') AS emails,
   (SELECT coalesce(jsonb_agg(DISTINCT p ORDER BY p),'[]'::jsonb) FROM cf_private.collection_reference_rows r
    CROSS JOIN LATERAL jsonb_array_elements(r.canonical->'phones')p WHERE r.job_id=p_job_id AND r.customer_key=c.customer_key AND r.outcome='MATCHED') AS phones FROM customers c
  ) INSERT INTO public.collection_customer_contacts(customer_key,client_name,client_document,emails,phones,notes,updated_by,source_job_id)
   SELECT customer_key,client_name,client_document,emails,phones,notes,auth.uid(),p_job_id FROM incoming
  ON CONFLICT(customer_key) DO UPDATE SET
   emails=(SELECT coalesce(jsonb_agg(DISTINCT x ORDER BY x),'[]'::jsonb) FROM jsonb_array_elements(collection_customer_contacts.emails||EXCLUDED.emails)x),
   phones=(SELECT coalesce(jsonb_agg(DISTINCT x ORDER BY x),'[]'::jsonb) FROM jsonb_array_elements(collection_customer_contacts.phones||EXCLUDED.phones)x),
   notes=coalesce(collection_customer_contacts.notes,EXCLUDED.notes),revision=collection_customer_contacts.revision+1,updated_at=clock_timestamp(),updated_by=EXCLUDED.updated_by,source_job_id=p_job_id
  WHERE NOT collection_customer_contacts.manually_edited AND (NOT collection_customer_contacts.emails @> EXCLUDED.emails OR NOT collection_customer_contacts.phones @> EXCLUDED.phones
   OR collection_customer_contacts.notes IS NULL AND EXCLUDED.notes IS NOT NULL);
 ELSE
  INSERT INTO public.collection_description_references(context_key,customer_key,branch,document,description,contract,content_sha256,source_job_id)
  SELECT context_key,customer_key,canonical->>'branch',canonical->>'document',canonical->>'description',canonical->>'contract',
   encode(sha256(convert_to(jsonb_build_array(canonical->>'description',canonical->>'contract')::text,'UTF8')),'hex'),p_job_id
  FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND outcome='MATCHED' AND NOT applied ON CONFLICT(context_key,content_sha256) DO NOTHING;
 END IF;
 UPDATE cf_private.collection_reference_rows SET applied=true WHERE job_id=p_job_id AND outcome='MATCHED' AND NOT applied;
 SELECT count(*) INTO v_applied FROM cf_private.collection_reference_rows WHERE job_id=p_job_id AND applied;
 v_result:=jsonb_build_object('job_id',p_job_id,'status','PUBLISHED','done',true,'processed_rows',v_job.staged_rows,'published_rows',v_applied,
  'skipped_manual_rows',v_manual,'quarantined_rows',v_quarantine,'remaining_rows',0,'manifest_sha256',v_job.manifest_sha256,'source_sha256',v_job.source_sha256);
 UPDATE cf_private.collection_reference_jobs SET status='PUBLISHED',last_result=v_result,published_at=clock_timestamp() WHERE id=p_job_id;
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
 VALUES(v_actor.id,v_actor.username,v_actor.role_key,'cobranca','collection_reference_publication',p_job_id::text,'IMPORT',v_job.last_result,v_result);
 INSERT INTO cf_private.collection_reference_publish_requests(actor_id,request_id,job_id,payload,result) VALUES(auth.uid(),p_request_id,p_job_id,v_payload,v_result);RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION cf_private.collection_reference_job_guard(),cf_private.collection_reference_row_guard(),cf_private.require_collection_reference_import(),
 cf_private.collection_reference_actor(uuid,text),cf_private.collection_reference_owned_job(uuid),cf_private.collection_reference_job_json(cf_private.collection_reference_jobs),
 cf_private.collection_reference_storage_allowed(text,boolean),cf_private.analyze_collection_reference_job(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cf_private.collection_reference_storage_allowed(text,boolean) TO anon,authenticated;
REVOKE ALL ON FUNCTION public.begin_collection_reference_import_from_gateway(uuid,text,text,text,bigint,text),public.get_collection_reference_job_from_gateway(uuid,text,uuid),
 public.list_collection_reference_imports_from_gateway(uuid,text,integer,integer),public.verify_collection_reference_original_from_gateway(uuid,text,uuid,text,bigint),
 public.stage_collection_reference_chunk_from_gateway(uuid,text,uuid,integer,text,text,jsonb,jsonb),public.finish_collection_reference_prepare_from_gateway(uuid,text,uuid,integer),
 public.preview_collection_reference_import_from_gateway(uuid,text,uuid),public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_collection_reference_import_from_gateway(uuid,text,text,text,bigint,text),public.get_collection_reference_job_from_gateway(uuid,text,uuid),
 public.list_collection_reference_imports_from_gateway(uuid,text,integer,integer),public.verify_collection_reference_original_from_gateway(uuid,text,uuid,text,bigint),
 public.stage_collection_reference_chunk_from_gateway(uuid,text,uuid,integer,text,text,jsonb,jsonb),public.finish_collection_reference_prepare_from_gateway(uuid,text,uuid,integer),
 public.preview_collection_reference_import_from_gateway(uuid,text,uuid),public.publish_collection_reference_import_from_gateway(uuid,text,uuid,text,boolean,uuid) TO service_role;
COMMENT ON TABLE cf_private.collection_reference_chunks IS 'CSV derivado efetivo, bytes e SHA privados; não é prova de que a transformação do navegador reconstitui semanticamente o arquivo original.';
COMMENT ON TABLE public.collection_description_references IS 'Variantes imutáveis por NF, filial e cliente. Sem data da fonte não existe escolha automática da última; RLS somente Cobrança ativa estritamente vencida.';
INSERT INTO public.central_schema_migrations(version) VALUES('028_collection_reference_imports');
-- END SOURCE BODY: 028_collection_reference_imports.sql
$cf_cr_source_028_822e636301cc0518_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='028_collection_reference_imports') THEN
      RAISE EXCEPTION 'A atualização 028_collection_reference_imports não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_cr_apply_028_fb8f880b4a6702bd_0$;

-- SOURCE: 029_collection_workflow.sql
DO $cf_cr_apply_029_06d295e4251fc3ab_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='029_collection_workflow') THEN
    RAISE NOTICE 'Atualização 029_collection_workflow já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_cr_source_029_5fb14d40a37de659_0$
-- SOURCE BODY: 029_collection_workflow.sql
-- Cobrança: retornos prioritários, atendimento iniciado e validação financeira.
-- Incremental: preserva recebimentos, comissões, responsáveis e históricos.

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='028_collection_reference_imports') THEN
  RAISE EXCEPTION 'Ative a atualização 028 antes do fluxo de atendimento.' USING ERRCODE='22023';END IF;
END $$;

CREATE FUNCTION cf_private.collection_workflow_write_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT cf_private.has_permission('cobranca','write') AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid()
  AND enabled AND role_key IN ('gerente_geral','contas_receber','cobradora_1','cobradora_2'));
$$;
CREATE FUNCTION cf_private.collection_workflow_collectible(p_title public.receivable_titles) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT p_title.status IN ('NEW','OPEN','NOT_LOCATED') AND p_title.due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
  AND EXISTS(SELECT 1 FROM public.collection_agents WHERE id=p_title.collector_id AND enabled)
  AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=p_title.id);
$$;
CREATE FUNCTION cf_private.collection_workflow_started(p_title_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT s.end_reason IS NULL OR s.end_reason='PAUSE'
  FROM public.collection_work_sessions s WHERE s.title_id=p_title_id AND s.actor_id=auth.uid()
   AND s.started_at>coalesce((SELECT max(e.created_at) FROM public.collection_case_events e WHERE e.title_id=p_title_id AND e.finalized),'-infinity'::timestamptz)
  ORDER BY s.started_at DESC,s.id DESC LIMIT 1),false);
$$;
CREATE FUNCTION cf_private.collection_workflow_priority(p_collector_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_collector uuid:=p_collector_id;v_count bigint;v_total numeric;v_next uuid;v_date date;BEGIN
 IF EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role_key IN ('cobradora_1','cobradora_2')) THEN v_collector:=cf_private.current_collector_id();END IF;
 WITH due AS MATERIALIZED(SELECT t.id,t.next_action_date,t.due_date,t.amount_cents FROM public.receivable_titles t
  WHERE t.scope='grupo-consolidado' AND cf_private.collection_workbench_visible(t) AND cf_private.collection_workflow_collectible(t)
   AND (v_collector IS NULL OR t.collector_id=v_collector)
   AND t.next_action_date<=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date)
 SELECT count(*),coalesce(sum(amount_cents),0),(SELECT id FROM due ORDER BY next_action_date,due_date,id LIMIT 1),
  (SELECT next_action_date FROM due ORDER BY next_action_date,due_date,id LIMIT 1) INTO v_count,v_total,v_next,v_date FROM due;
 IF greatest(v_count,v_total)>9007199254740991 THEN RAISE EXCEPTION 'O total excede o limite de precisão.' USING ERRCODE='22003';END IF;
 RETURN jsonb_build_object('collector_id',v_collector,'due_count',v_count,'total_cents',v_total,'next_title_id',v_next,'next_due_date',v_date);
END $$;
CREATE FUNCTION cf_private.collection_workflow_metadata(p_title_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_title public.receivable_titles%ROWTYPE;v_started boolean:=false;v_recovery boolean:=false;v_finish boolean:=false;BEGIN
 IF p_title_id IS NOT NULL THEN
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id;
  v_started:=cf_private.collection_workflow_started(p_title_id);
  v_finish:=v_started AND cf_private.collection_workflow_write_allowed() AND cf_private.collection_workbench_visible(v_title) AND cf_private.collection_workflow_collectible(v_title);
  v_recovery:=cf_private.collection_workflow_write_allowed() AND EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE title_id=p_title_id AND actor_id=auth.uid() AND ended_at IS NULL)
   AND NOT coalesce(cf_private.collection_workbench_visible(v_title) AND cf_private.collection_workflow_collectible(v_title),false);
 END IF;
 RETURN jsonb_build_object('version','029','normal_pause',true,'finish_requires_started',true,'pending_read_only',true,'returns_priority',true)
  ||CASE WHEN p_title_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('started',v_started,'can_finish',v_finish,'recovery_allowed',v_recovery) END;
END $$;

CREATE OR REPLACE FUNCTION cf_private.collection_workbench_timer(p_title_id uuid,p_now timestamptz) RETURNS jsonb
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
  'total_seconds',v_total,'actor_total_seconds',v_actor,'server_now',p_now,
  'recovery_allowed',cf_private.collection_workflow_metadata(p_title_id)->'recovery_allowed');
END $$;
CREATE OR REPLACE FUNCTION cf_private.collection_workbench_row(p_title public.receivable_titles,p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_case public.collection_cases%ROWTYPE;v_timer jsonb;v_name text;v_old_observation text;v_return boolean;v_reason text;BEGIN
 SELECT * INTO v_case FROM public.collection_cases WHERE title_id=p_title.id;
 SELECT display_name INTO v_name FROM public.collection_agents WHERE id=p_title.collector_id;
 v_timer:=cf_private.collection_workbench_timer(p_title.id,p_now);
 v_return:=coalesce(cf_private.collection_workflow_collectible(p_title) AND p_title.next_action_date<=(p_now AT TIME ZONE 'America/Sao_Paulo')::date,false);
 v_reason:=CASE WHEN NOT cf_private.collection_workflow_write_allowed() THEN 'READ_ONLY'
  WHEN p_title.status='PENDING_VALIDATION' THEN 'PENDING_VALIDATION'
  WHEN p_title.status='VALIDATED' OR EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=p_title.id) THEN 'SETTLED'
  WHEN p_title.collector_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=p_title.collector_id AND enabled) THEN 'UNASSIGNED'
  WHEN EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL AND title_id<>p_title.id) THEN 'ALREADY_RUNNING'
  WHEN NOT v_return AND NOT EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL AND title_id=p_title.id)
   AND (cf_private.collection_workflow_priority(p_title.collector_id)->>'due_count')::bigint>0 THEN 'RETURN_PRIORITY'
  ELSE NULL END;
 SELECT observation INTO v_old_observation FROM public.receivable_collection_events WHERE title_id=p_title.id AND observation IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN to_jsonb(p_title)||jsonb_build_object('operational_status',coalesce(v_case.status,cf_private.collection_workbench_legacy_status(p_title.last_action)),
  'operational_label',CASE WHEN v_case.title_id IS NULL AND p_title.last_action IS NOT NULL AND p_title.last_action NOT IN ('PAID','NO_RESPONSE','PROMISE') THEN 'Sem status operacional' ELSE coalesce(v_case.status,cf_private.collection_workbench_legacy_status(p_title.last_action)) END,
  'legacy_worked',v_case.title_id IS NULL AND p_title.last_action IS NOT NULL,'case_revision',coalesce(v_case.revision,0),
  'observation',CASE WHEN v_case.title_id IS NULL THEN v_old_observation ELSE v_case.observation END,'next_action_text',v_case.next_action,
  'next_date',CASE WHEN v_case.title_id IS NULL THEN p_title.next_action_date ELSE v_case.next_date END,'delay_days',(p_now AT TIME ZONE 'America/Sao_Paulo')::date-p_title.due_date,
  'collector_name',v_name,'total_work_seconds',v_timer->'total_seconds','current_timer',v_timer,
  'return_due',v_return,'return_due_date',CASE WHEN v_return THEN p_title.next_action_date END,'can_start',v_reason IS NULL,'start_block_reason',v_reason);
END $$;
CREATE OR REPLACE FUNCTION public.collection_workbench(p_search text DEFAULT '',p_collector_id uuid DEFAULT NULL,p_unassigned boolean DEFAULT false,
 p_band text DEFAULT NULL,p_sort text DEFAULT 'delay_desc',p_status text DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,
 p_queue text DEFAULT 'active',p_due_start date DEFAULT NULL,p_due_end date DEFAULT NULL,p_next_action text DEFAULT NULL,p_financial_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;v_now timestamptz:=statement_timestamp();
 v_count bigint;v_total numeric;v_rows jsonb;v_revision text;v_active_id uuid;v_active_timer jsonb;BEGIN
 PERFORM cf_private.require_collection_workbench_read();
 IF p_search IS NULL OR length(p_search)>1500 OR p_unassigned IS NULL OR p_sort IS NULL
  OR p_sort NOT IN ('delay_desc','delay_asc','due_asc','due_desc','amount_desc','amount_asc','client_asc','next_date_asc')
  OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
  OR p_queue IS NULL OR p_queue NOT IN ('active','history','all','returns')
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
   AND (p_queue='all' OR (p_queue='active' AND t.status IN ('NEW','OPEN','NOT_LOCATED') AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.title_id=t.id))
    OR (p_queue='returns' AND cf_private.collection_workflow_collectible(t) AND t.next_action_date<=v_today) OR (p_queue='history' AND t.status='VALIDATED'))
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
  SELECT f.id,row_number() OVER(ORDER BY
   CASE WHEN p_queue='returns' THEN f.next_action_date END ASC,CASE WHEN p_queue='returns' THEN f.due_date END ASC,CASE WHEN p_queue='returns' THEN f.id END ASC,
   CASE WHEN p_sort IN ('delay_desc','due_asc') THEN f.due_date END ASC,
   CASE WHEN p_sort IN ('delay_asc','due_desc') THEN f.due_date END DESC,
   CASE WHEN p_sort='amount_desc' THEN f.amount_cents END DESC,CASE WHEN p_sort='amount_asc' THEN f.amount_cents END ASC,
   CASE WHEN p_sort='client_asc' THEN lower(f.client_name) END ASC,
   CASE WHEN p_sort='next_date_asc' THEN f.case_next_date END ASC NULLS LAST,f.id ASC) AS ord FROM filtered f ORDER BY ord OFFSET p_offset LIMIT p_limit
 ) SELECT (SELECT count(*) FROM filtered),(SELECT coalesce(sum(amount_cents),0) FROM filtered),
  coalesce((SELECT jsonb_agg(cf_private.collection_workbench_row(t,v_now) ORDER BY ord) FROM
   (SELECT p.id,p.ord FROM page p)x JOIN public.receivable_titles t ON t.id=x.id),'[]'::jsonb)
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
 RETURN jsonb_build_object('as_of_date',v_today,'server_now',v_now,'snapshot_revision',v_revision,'count',v_count,'total_cents',v_total,'rows',v_rows,'active_timer',v_active_timer,
  'workflow',cf_private.collection_workflow_metadata(),'priority',cf_private.collection_workflow_priority(p_collector_id));
END $$;
CREATE OR REPLACE FUNCTION public.collection_case_detail(p_title_id uuid) RETURNS jsonb
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
  'history',v_history,'case_history',v_events,'work_sessions',v_sessions,
  'workflow',cf_private.collection_workflow_metadata(p_title_id),'priority',cf_private.collection_workflow_priority(v_title.collector_id));
END $$;

CREATE OR REPLACE FUNCTION public.collection_work_action(p_title_id uuid,p_action text,p_expected_revision bigint,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE;v_running public.collection_work_sessions%ROWTYPE;v_payload jsonb;v_result jsonb;BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);PERFORM cf_private.require_collection_workbench_read();
 IF NOT cf_private.collection_workflow_write_allowed() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_action IS NULL OR p_action NOT IN ('START','PAUSE','FINISH') OR p_title_id IS NULL THEN RAISE EXCEPTION 'Ação de tempo inválida.' USING ERRCODE='22023';END IF;
 v_payload:=jsonb_build_object('kind','work','title_id',p_title_id,'action',p_action,'expected_revision',p_expected_revision);
 -- Reenvio confirmado retorna antes dos estados que a própria operação alterou.
 v_result:=cf_private.collection_work_request_replay(p_request_id,v_payload);IF v_result IS NOT NULL THEN RETURN v_result;END IF;
 IF p_action='START' THEN
  v_title:=cf_private.collection_workbench_title(p_title_id);PERFORM cf_private.require_collection_title(v_title);
  IF NOT cf_private.collection_workflow_collectible(v_title) THEN
   RAISE EXCEPTION 'Inicie somente um título ativo, vencido e com cobradora definida; pendências aguardam Contas a Receber.' USING ERRCODE='23514';END IF;
  SELECT * INTO v_running FROM public.collection_work_sessions WHERE actor_id=auth.uid() AND ended_at IS NULL FOR UPDATE;
  IF v_running.id IS NOT NULL AND v_running.title_id<>p_title_id THEN RAISE EXCEPTION 'Pause o atendimento atual antes de iniciar outro título.' USING ERRCODE='23514';END IF;
  IF v_running.id IS NULL THEN
   IF p_expected_revision IS NULL OR p_expected_revision<>v_title.revision THEN RAISE EXCEPTION 'O título mudou. Atualize a tela.' USING ERRCODE='40001';END IF;
   IF NOT coalesce(v_title.next_action_date<=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,false)
    AND (cf_private.collection_workflow_priority(v_title.collector_id)->>'due_count')::bigint>0 THEN
    RAISE EXCEPTION 'Atenda primeiro os retornos devidos desta carteira.' USING ERRCODE='P0029';END IF;
   INSERT INTO public.collection_work_sessions(title_id,actor_id,collector_id,document_snapshot,client_name_snapshot,branch_snapshot,collector_name_snapshot)
    SELECT p_title_id,auth.uid(),v_title.collector_id,v_title.document,v_title.client_name,v_title.branch,display_name FROM public.collection_agents WHERE id=v_title.collector_id AND enabled;
  END IF;
 ELSE
  SELECT * INTO v_title FROM public.receivable_titles WHERE id=p_title_id;
  SELECT * INTO v_running FROM public.collection_work_sessions WHERE title_id=p_title_id AND actor_id=auth.uid() AND ended_at IS NULL FOR UPDATE;
  IF v_running.id IS NULL AND NOT EXISTS(SELECT 1 FROM public.collection_work_sessions WHERE title_id=p_title_id AND actor_id=auth.uid()) THEN
   RAISE EXCEPTION 'Não há atendimento próprio iniciado para este título.' USING ERRCODE='42501';END IF;
  IF p_action='FINISH' AND coalesce(cf_private.collection_workbench_visible(v_title) AND cf_private.collection_workflow_collectible(v_title),false) THEN
   RAISE EXCEPTION 'Finalize pelo atendimento, com observação e próxima ação/data.' USING ERRCODE='23514';END IF;
  -- Pausar é permitido. Encerrar sem agenda serve exclusivamente à recuperação
  -- de intervalo próprio cujo título saiu da cobrança; não altera título/case.
  IF v_running.id IS NOT NULL THEN
   UPDATE public.collection_work_sessions SET ended_at=greatest(started_at,clock_timestamp()),end_reason=p_action WHERE id=v_running.id;
  END IF;
 END IF;
 v_result:=cf_private.collection_workbench_timer(p_title_id,clock_timestamp());
 INSERT INTO public.collection_work_requests(actor_id,request_id,title_id,payload,result) VALUES(auth.uid(),p_request_id,p_title_id,v_payload,v_result);RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.save_collection_case(p_title_id uuid,p_status text,p_observation text,p_next_action text,p_next_date date,
 p_expected_revision bigint,p_expected_case_revision bigint,p_payment_date date DEFAULT NULL,p_finish boolean DEFAULT false,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE;v_case public.collection_cases%ROWTYPE;v_payload jsonb;v_result jsonb;
 v_event uuid;v_action text;v_legacy_next text;v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;v_now timestamptz;v_paid_note text;BEGIN
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
 IF v_title.status NOT IN ('NEW','OPEN','NOT_LOCATED') OR EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=p_title_id) THEN
  RAISE EXCEPTION 'O título está fora da cobrança ativa; consulte o histórico ou Contas a Receber.' USING ERRCODE='23514';END IF;
 IF p_finish AND NOT cf_private.collection_workflow_started(p_title_id) THEN RAISE EXCEPTION 'Inicie o atendimento antes de finalizar; um atendimento já finalizado não pode ser reutilizado.' USING ERRCODE='55000';END IF;
 IF p_finish IS NULL OR p_status IS NULL OR p_status NOT IN ('NOVO TÍTULO - COBRAR','SEM SUCESSO','AGUARDANDO RETORNO','COBRANCA VIA EMAIL','COBRANCA POR WHATSAPP',
  'AGUARDANDO LIQUIDACAO','SEM PRAZO','SEM PREVISAO DE PG','PAGAMENTO PROGRAMADO','TÍTULO PAGO')
  OR length(coalesce(p_observation,''))>5000 OR length(coalesce(p_next_action,''))>1000
  OR (p_next_date IS NOT NULL AND (p_next_date<DATE '1900-01-01' OR p_next_date>DATE '2199-12-31'))
  OR (p_status='TÍTULO PAGO' AND (p_payment_date IS NULL OR p_payment_date<DATE '1900-01-01' OR p_payment_date>v_today))
  OR (p_status<>'TÍTULO PAGO' AND p_payment_date IS NOT NULL)
  OR (p_finish AND (v_title.collector_id IS NULL OR nullif(cf_private.normalize_receivable_text(p_observation),'') IS NULL
   OR (p_status<>'TÍTULO PAGO' AND (nullif(cf_private.normalize_receivable_text(p_next_action),'') IS NULL OR p_next_date IS NULL OR p_next_date<v_today)))) THEN
  RAISE EXCEPTION 'Para finalizar, informe cobradora, observação e próxima ação/data; título pago exige a data real do pagamento.' USING ERRCODE='23514';END IF;
 v_now:=clock_timestamp();
 IF p_finish THEN
  -- Finalizar pagamento encerra a agenda de cobrança e encaminha somente
  -- para conferência financeira. A agenda anterior permanece no histórico.
  IF p_status='TÍTULO PAGO' THEN
   p_next_action:='Aguardar validação de Contas a Receber';p_next_date:=NULL;
   v_paid_note:='Pagamento informado em '||to_char(p_payment_date,'DD/MM/YYYY')||'.';
   IF position(v_paid_note IN coalesce(p_observation,''))=0 THEN p_observation:=btrim(p_observation)||E'\n'||v_paid_note;END IF;
   IF length(p_observation)>5000 THEN RAISE EXCEPTION 'Reduza a observação para incluir a data informada do pagamento.' USING ERRCODE='23514';END IF;
  END IF;
  v_action:=CASE p_status WHEN 'TÍTULO PAGO' THEN 'PAID' WHEN 'SEM SUCESSO' THEN 'NO_RESPONSE' WHEN 'PAGAMENTO PROGRAMADO' THEN 'PROMISE'
   WHEN 'COBRANCA VIA EMAIL' THEN 'CONTACT' WHEN 'COBRANCA POR WHATSAPP' THEN 'CONTACT' ELSE 'OTHER' END;
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

CREATE OR REPLACE FUNCTION public.validate_receivable_payment(
 p_title_id uuid,p_decision text,p_payment_date date,p_observation text,p_expected_revision bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.receivable_titles%ROWTYPE; v_id uuid; v_delay integer; v_band text;
 v_case public.collection_cases%ROWTYPE;v_today date:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
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
      last_action='PAYMENT_NOT_LOCATED',next_action='RETRY',next_action_date=v_today WHERE id=p_title_id;
    -- A recusa financeira reabre o mesmo atendimento/carteira e mantém toda
    -- observação anterior nos eventos imutáveis. Não existe recebimento aqui.
    INSERT INTO public.collection_cases(title_id,status,observation,next_action,next_date,payment_date,revision,finalized_at,updated_by)
    VALUES(p_title_id,'NOVO TÍTULO - COBRAR',btrim(p_observation),'Retomar cobrança',v_today,NULL,1,NULL,auth.uid())
    ON CONFLICT(title_id) DO UPDATE SET status=EXCLUDED.status,observation=EXCLUDED.observation,next_action=EXCLUDED.next_action,
      next_date=EXCLUDED.next_date,payment_date=NULL,revision=collection_cases.revision+1,finalized_at=NULL,updated_by=auth.uid(),updated_at=clock_timestamp()
    RETURNING * INTO v_case;
    INSERT INTO public.collection_case_events(title_id,case_revision,status,observation,next_action,next_date,payment_date,finalized,created_by)
    VALUES(p_title_id,v_case.revision,v_case.status,v_case.observation,v_case.next_action,v_today,NULL,false,auth.uid());
  END IF;
  INSERT INTO public.receivable_collection_events(title_id,collector_id,action,next_action,next_date,observation,payment_date,created_by)
    VALUES(p_title_id,v_title.collector_id,CASE WHEN p_decision='CONFIRM' THEN 'VALIDATE' ELSE 'PAYMENT_NOT_LOCATED' END,
      CASE WHEN p_decision='NOT_LOCATED' THEN 'RETRY' ELSE NULL END,CASE WHEN p_decision='NOT_LOCATED' THEN v_today END,nullif(btrim(p_observation),''),p_payment_date,auth.uid());
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    SELECT id,username,role_key,'contas_receber','receivable_validation',p_title_id::text,'VALIDATE',to_jsonb(v_title),
      jsonb_build_object('decision',p_decision,'receipt_id',v_id,'payment_date',p_payment_date,'observation',nullif(btrim(p_observation),''))
    FROM public.profiles WHERE id=auth.uid();
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION cf_private.close_settled_collection_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NEW.status='VALIDATED' OR EXISTS(SELECT 1 FROM public.receivable_receipts WHERE title_id=NEW.id) THEN
  UPDATE public.collection_work_sessions SET ended_at=greatest(started_at,clock_timestamp()),end_reason='TITLE_SETTLED'
   WHERE title_id=NEW.id AND ended_at IS NULL;
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION cf_private.collection_workflow_receipt_settled() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(2045812308);
 UPDATE public.collection_work_sessions SET ended_at=greatest(started_at,clock_timestamp()),end_reason='TITLE_SETTLED'
  WHERE title_id=NEW.title_id AND ended_at IS NULL;RETURN NEW;
END $$;
CREATE TRIGGER collection_receipt_closes_work AFTER INSERT ON public.receivable_receipts
 FOR EACH ROW EXECUTE FUNCTION cf_private.collection_workflow_receipt_settled();
-- Só intervalos ainda abertos de títulos comprovadamente quitados. Horário do
-- servidor na atualização, nunca data retroativa do pagamento; histórico intacto.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.collection_work_sessions s JOIN public.receivable_titles t ON t.id=s.title_id
  WHERE s.ended_at IS NULL AND (t.status='VALIDATED' OR EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.title_id=t.id))) THEN
  UPDATE public.collection_work_sessions s SET ended_at=greatest(s.started_at,clock_timestamp()),end_reason='TITLE_SETTLED'
 WHERE s.ended_at IS NULL AND EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.id=s.title_id
  AND (t.status='VALIDATED' OR EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.title_id=t.id)));
 END IF;
END $$;

-- O endpoint legado não pode contornar o atendimento, a agenda nem o timer.
-- save_collection_case é SECURITY DEFINER e conserva a chamada ao core009.
REVOKE EXECUTE ON FUNCTION public.record_collection_action(uuid,text,date,text,date,text,text,date,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION cf_private.collection_workflow_write_allowed(),cf_private.collection_workflow_collectible(public.receivable_titles),
 cf_private.collection_workflow_started(uuid),cf_private.collection_workflow_priority(uuid),cf_private.collection_workflow_metadata(uuid),
 cf_private.collection_workflow_receipt_settled() FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.collection_work_action(uuid,text,bigint,uuid) IS 'START e PAUSE persistentes; FINISH direto somente recupera intervalo próprio fora da cobrança. Finalização normal usa save_collection_case.';
COMMENT ON FUNCTION public.save_collection_case(uuid,text,text,text,date,bigint,bigint,date,boolean,uuid) IS 'Rascunho não muda agenda oficial. Finalizar exige atendimento próprio iniciado, observação e próxima ação/data; pagamento informado somente encaminha à validação financeira.';
INSERT INTO public.central_schema_migrations(version) VALUES('029_collection_workflow');
-- END SOURCE BODY: 029_collection_workflow.sql
$cf_cr_source_029_5fb14d40a37de659_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='029_collection_workflow') THEN
      RAISE EXCEPTION 'A atualização 029_collection_workflow não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_cr_apply_029_06d295e4251fc3ab_0$;

-- SOURCE: 030_receivable_import_collectors.sql
DO $cf_cr_apply_030_2ff4991cea67afcd_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='030_receivable_import_collectors') THEN
    RAISE NOTICE 'Atualização 030_receivable_import_collectors já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_cr_source_030_f06204bbe61ffaf8_0$
-- SOURCE BODY: 030_receivable_import_collectors.sql
-- Responsável oficial na importação de abertos; nenhuma redistribuição implícita.
-- O arquivo financeiro continua sob as regras e a identidade da atualização 023.

DO $$ BEGIN
 IF to_regclass('public.collection_agents') IS NULL OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='023_receivable_sync') THEN
  RAISE EXCEPTION 'Ative Contas a Receber e a sincronização 023 antes das responsáveis na importação.' USING ERRCODE='22023';END IF;
END $$;

CREATE FUNCTION cf_private.receivable_import_collector_plan(p_preview jsonb,p_collector_mappings jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_group record;v_owner uuid;v_selected uuid;v_resolved uuid;v_name text;v_owners integer;v_locked boolean;v_locked_null boolean;
 v_requires boolean;v_assignments jsonb:='[]';v_missing integer:=0;v_needed boolean:=false;v_mapping jsonb;
BEGIN
 IF p_collector_mappings IS NULL OR jsonb_typeof(p_collector_mappings)<>'object' OR octet_length(p_collector_mappings::text)>1048576
  OR (SELECT count(*) FROM jsonb_object_keys(p_collector_mappings))>5000 THEN
  RAISE EXCEPTION 'Informe as responsáveis usando as chaves oficiais dos clientes.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_collector_mappings)m WHERE length(m.key)>1505 OR m.key~'[[:cntrl:]]'
  OR NOT(m.key LIKE 'name:%' OR m.key~'^cnpj:[0-9]{14}$') OR jsonb_typeof(m.value)<>'string'
  OR m.value#>>'{}' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_preview->'rows')r WHERE r->>'customer_key'=m.key)) THEN
  RAISE EXCEPTION 'A seleção contém cliente desconhecido ou responsável inválida. Gere nova análise.' USING ERRCODE='22023';END IF;
 FOR v_group IN
  SELECT r->>'customer_key' AS customer_key,min(r->>'client_name') AS client_name,min(r->>'client_document') AS client_document,
   count(*)::integer AS row_count,bool_or(t.id IS NULL OR (t.status<>'VALIDATED' AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id))) AS eligible,
   bool_or(t.id IS NULL AND r->>'outcome'='NEW') AS new_rows
  FROM jsonb_array_elements(p_preview->'rows')r LEFT JOIN public.receivable_titles t ON t.id=(r->>'title_id')::uuid
  GROUP BY r->>'customer_key' ORDER BY r->>'customer_key'
 LOOP
  v_owner:=NULL;v_selected:=NULL;v_resolved:=NULL;v_name:=NULL;v_locked:=false;v_locked_null:=false;
  SELECT count(DISTINCT t.collector_id)::integer,min(t.collector_id::text)::uuid,
   coalesce(bool_or(t.collector_locked),false),coalesce(bool_or(t.collector_id IS NULL AND t.collector_locked),false)
  INTO v_owners,v_owner,v_locked,v_locked_null FROM public.receivable_titles t
  WHERE t.scope='grupo-consolidado' AND t.customer_key=v_group.customer_key AND t.status<>'VALIDATED'
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id);
  v_mapping:=p_collector_mappings->v_group.customer_key;
  IF v_mapping IS NOT NULL THEN
   v_selected:=(v_mapping#>>'{}')::uuid;
   IF NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=v_selected AND enabled) THEN
    RAISE EXCEPTION 'Selecione uma responsável ativa. Nenhuma carteira foi alterada.' USING ERRCODE='23514';END IF;
  END IF;
  IF v_group.eligible AND (v_owners>1 OR v_locked_null) THEN
   RAISE EXCEPTION 'Cliente com carteira conflitante ou vínculo bloqueado sem responsável. Confira a carteira antes de importar.' USING ERRCODE='23514';END IF;
  IF v_group.eligible AND v_owner IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=v_owner AND enabled) THEN
   RAISE EXCEPTION 'A responsável existente está inativa. A carteira foi preservada; confira o cadastro antes de importar.' USING ERRCODE='23514';END IF;
  IF v_selected IS NOT NULL AND (NOT v_group.eligible OR v_owner IS NOT NULL AND v_selected<>v_owner) THEN
   RAISE EXCEPTION 'A importação não redistribui carteiras nem altera responsáveis de títulos quitados.' USING ERRCODE='23514';END IF;
  v_requires:=v_group.eligible AND v_owner IS NULL;v_resolved:=CASE WHEN v_group.eligible THEN coalesce(v_owner,v_selected) END;
  IF v_requires AND v_resolved IS NULL THEN v_missing:=v_missing+1;END IF;
  SELECT display_name INTO v_name FROM public.collection_agents WHERE id=v_resolved;
  IF v_group.eligible AND (v_group.new_rows OR EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope='grupo-consolidado'
    AND t.customer_key=v_group.customer_key AND t.status<>'VALIDATED' AND t.collector_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id))) THEN v_needed:=true;END IF;
  v_assignments:=v_assignments||jsonb_build_array(jsonb_build_object('customer_key',v_group.customer_key,'client_name',v_group.client_name,
   'client_document',v_group.client_document,'collector_id',v_resolved,'collector_name',v_name,'row_count',v_group.row_count,
   'requires_selection',v_requires,'locked',v_locked,'eligible',v_group.eligible));
 END LOOP;
 RETURN jsonb_build_object('assignments',v_assignments,'missing_count',v_missing,'assignment_needed',v_needed);
END $$;

CREATE FUNCTION public.preview_receivables_open_import_with_collectors(p_scope text,p_rows jsonb,
 p_title_mappings jsonb DEFAULT '{}'::jsonb,p_collector_mappings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_preview jsonb;v_plan jsonb;v_assignments jsonb;BEGIN
 v_preview:=public.preview_receivables_open_import(p_scope,p_rows,p_title_mappings);
 v_plan:=cf_private.receivable_import_collector_plan(v_preview,p_collector_mappings);
 SELECT coalesce(jsonb_agg(a-'eligible' ORDER BY a->>'customer_key'),'[]'::jsonb) INTO v_assignments FROM jsonb_array_elements(v_plan->'assignments')a;
 RETURN v_preview||jsonb_build_object('collector_assignment_version','030','customer_collector_assignments',v_assignments,
  'missing_collector_count',(v_plan->>'missing_count')::integer,'can_commit',(v_preview->>'can_commit')::boolean AND (v_plan->>'missing_count')::integer=0);
END $$;

CREATE FUNCTION public.commit_receivables_open_import_with_collectors_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,
 p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_title_mappings jsonb DEFAULT '{}'::jsonb,
 p_previous_import_id uuid DEFAULT NULL,p_previous_financial_revision text DEFAULT NULL,p_collector_mappings jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_preview jsonb;v_plan jsonb;v_result jsonb;v_customer jsonb;v_collector uuid;v_count integer;v_total integer:=0;v_clients integer:=0;v_existing uuid;
BEGIN
 PERFORM cf_private.set_receivable_sync_actor(p_user_id,p_session_id);
 PERFORM cf_private.validate_receivable_sync_file(p_file_name,p_file_sha256,p_file_base64);
 PERFORM pg_advisory_xact_lock(2045812308);
 v_preview:=public.preview_receivables_open_import(p_scope,p_rows,p_title_mappings);
 v_plan:=cf_private.receivable_import_collector_plan(v_preview,p_collector_mappings);
 IF NOT (v_preview->>'can_commit')::boolean OR (v_plan->>'missing_count')::integer>0 THEN
  RAISE EXCEPTION 'Confirme as parcelas e informe a responsável de cada cliente sem carteira antes de importar.' USING ERRCODE='P0030';END IF;
 SELECT id INTO v_existing FROM public.receivable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256 AND import_mode='OPEN';
 -- O replay financeiro não autoriza uma nova atribuição com análise obsoleta.
 IF v_existing IS NOT NULL AND (v_plan->>'assignment_needed')::boolean AND (p_previous_import_id IS DISTINCT FROM (v_preview->>'previous_import_id')::uuid
  OR p_previous_financial_revision IS NULL OR p_previous_financial_revision IS DISTINCT FROM v_preview->>'financial_revision') THEN
  RAISE EXCEPTION 'A carteira mudou. Gere nova análise antes de preencher as responsáveis.' USING ERRCODE='40001';END IF;
 v_result:=public.commit_receivables_open_import_from_gateway(p_user_id,p_session_id,p_scope,p_file_name,p_file_sha256,p_file_base64,p_rows,p_title_mappings,
  p_previous_import_id,p_previous_financial_revision);
 FOR v_customer IN SELECT value FROM jsonb_array_elements(v_plan->'assignments') WHERE (value->>'eligible')::boolean LOOP
  v_collector:=(v_customer->>'collector_id')::uuid;
  IF v_collector IS NULL OR NOT EXISTS(SELECT 1 FROM public.collection_agents WHERE id=v_collector AND enabled) THEN
   RAISE EXCEPTION 'A responsável não está disponível. Nenhuma alteração será mantida.' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key' AND t.status<>'VALIDATED'
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)
   AND ((t.collector_id IS NOT NULL AND t.collector_id<>v_collector) OR (t.collector_id IS NULL AND t.collector_locked))) THEN
   RAISE EXCEPTION 'A carteira mudou ou possui vínculo bloqueado. A responsável existente foi preservada.' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.receivable_titles t WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key'
   AND t.status<>'VALIDATED' AND t.collector_id IS NULL AND NOT t.collector_locked
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id)) THEN CONTINUE;END IF;
  UPDATE public.receivable_titles t SET collector_id=v_collector WHERE t.scope=p_scope AND t.customer_key=v_customer->>'customer_key'
   AND t.status<>'VALIDATED' AND t.collector_id IS NULL AND NOT t.collector_locked
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts q WHERE q.title_id=t.id);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN
   v_total:=v_total+v_count;v_clients:=v_clients+1;
   INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    SELECT id,username,role_key,'contas_receber','customer_assignment',v_customer->>'customer_key','ASSIGNMENT',
     jsonb_build_object('collector_id',v_collector,'assigned_count',v_count,'import_id',v_result->>'import_id','origin','OPEN_IMPORT_030')
    FROM public.profiles WHERE id=auth.uid();
  END IF;
 END LOOP;
 RETURN v_result||jsonb_build_object('collector_assignment_version','030','assigned_title_count',v_total,'assigned_customer_count',v_clients);
END $$;

REVOKE ALL ON FUNCTION cf_private.receivable_import_collector_plan(jsonb,jsonb),
 public.preview_receivables_open_import_with_collectors(text,jsonb,jsonb,jsonb),
 public.commit_receivables_open_import_with_collectors_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_receivables_open_import_with_collectors(text,jsonb,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_receivables_open_import_with_collectors_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb) TO service_role;
INSERT INTO public.central_schema_migrations(version) VALUES('030_receivable_import_collectors');
-- END SOURCE BODY: 030_receivable_import_collectors.sql
$cf_cr_source_030_f06204bbe61ffaf8_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='030_receivable_import_collectors') THEN
      RAISE EXCEPTION 'A atualização 030_receivable_import_collectors não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_cr_apply_030_2ff4991cea67afcd_0$;

COMMIT;
