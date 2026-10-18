-- Quitações do ERP: nominal e efetivamente recebido são valores independentes.
-- A declaração de quitação encerra o título, inclusive antecipações e diferenças.
-- Preserva recebimentos originais; correções de importação acrescentam versões.
BEGIN;
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
COMMIT;
