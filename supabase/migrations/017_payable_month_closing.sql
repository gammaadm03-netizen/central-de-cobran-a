-- Revisão explícita, correções auditáveis e fechamento mensal de Contas a Pagar.
-- Aplicar uma única vez após 016. Não migra, exclui ou reclassifica dados antigos.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative as atualizações anteriores de Contas a Pagar.' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='016_payable_identity_updates') THEN
  RAISE EXCEPTION 'Ative a atualização 016 antes do fechamento mensal.' USING ERRCODE='22023'; END IF;
END $$;

CREATE TABLE cf_private.payable_control_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 0);
INSERT INTO cf_private.payable_control_state(singleton) VALUES(true);
REVOKE ALL ON TABLE cf_private.payable_control_state FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.payable_title_control_revisions(
 title_id uuid PRIMARY KEY REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
 revision bigint NOT NULL CHECK(revision>0),payment_token uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE TABLE public.payable_title_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title_id uuid NOT NULL REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),reviewed boolean NOT NULL,
 observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_title_reviews_latest ON public.payable_title_reviews(title_id,created_at DESC,id DESC);
CREATE TABLE public.payable_title_corrections(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title_id uuid NOT NULL REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
 before_value jsonb NOT NULL,after_value jsonb NOT NULL,
 observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_title_corrections_latest ON public.payable_title_corrections(title_id,created_at DESC,id DESC);
CREATE TABLE public.payable_title_macro_overrides(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title_id uuid NOT NULL REFERENCES public.payable_titles(id),
 plan text NOT NULL,macro text REFERENCES public.payable_macros(name),active boolean NOT NULL,
 correction_id uuid REFERENCES public.payable_title_corrections(id),
 observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((active AND macro IS NOT NULL) OR (NOT active AND macro IS NULL))
);
CREATE INDEX payable_title_macro_overrides_latest ON public.payable_title_macro_overrides(title_id,created_at DESC,id DESC);
CREATE TABLE public.payable_payment_reclassifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payment_id uuid NOT NULL REFERENCES public.payable_payments(id) ON DELETE RESTRICT,
 correction_id uuid NOT NULL REFERENCES public.payable_title_corrections(id) ON DELETE RESTRICT,
 macro text NOT NULL REFERENCES public.payable_macros(name),previous_macro text NOT NULL REFERENCES public.payable_macros(name),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(payment_id,correction_id)
);
CREATE INDEX payable_payment_reclass_latest ON public.payable_payment_reclassifications(payment_id,created_at DESC,id DESC);
CREATE TABLE public.payable_month_closures(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),month date NOT NULL CHECK(month=date_trunc('month',month)::date),
 version integer NOT NULL CHECK(version>0),snapshot jsonb NOT NULL,source_revision jsonb NOT NULL,
 total_titles integer NOT NULL CHECK(total_titles>0),total_nominal_cents bigint NOT NULL,total_paid_cents bigint NOT NULL,
 observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(month,version)
);
CREATE INDEX payable_month_closures_latest ON public.payable_month_closures(month,version DESC);
CREATE TABLE public.payable_month_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),month date NOT NULL CHECK(month=date_trunc('month',month)::date),
 closure_id uuid NOT NULL REFERENCES public.payable_month_closures(id),action text NOT NULL CHECK(action IN ('CLOSE','REOPEN')),
 automatic boolean NOT NULL DEFAULT false,observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_month_events_latest ON public.payable_month_events(month,created_at DESC,id DESC);
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['payable_title_control_revisions','payable_title_reviews','payable_title_corrections',
  'payable_payment_reclassifications','payable_month_closures','payable_month_events','payable_title_macro_overrides'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated',v_table);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING(cf_private.has_permission(''contas_pagar'',''read''))',v_table||'_read',v_table);
 END LOOP;
END $$;
CREATE FUNCTION cf_private.block_payable_closing_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 RAISE EXCEPTION 'O histórico de conciliação e fechamento é imutável. Registre uma nova revisão.' USING ERRCODE='42501';END $$;
CREATE FUNCTION cf_private.audit_payable_closing_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;v_action text;
BEGIN
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 v_action:=CASE WHEN TG_TABLE_NAME='payable_title_reviews' THEN CASE WHEN (to_jsonb(NEW)->>'reviewed')::boolean THEN 'VALIDATE' ELSE 'REOPEN' END
  WHEN TG_TABLE_NAME='payable_month_events' THEN CASE WHEN to_jsonb(NEW)->>'action'='CLOSE' THEN 'VALIDATE' ELSE 'REOPEN' END
  WHEN TG_TABLE_NAME IN ('payable_title_corrections','payable_payment_reclassifications') THEN 'UPDATE' ELSE 'CREATE' END;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
  VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar',TG_TABLE_NAME,NEW.id::text,v_action,
   CASE WHEN TG_TABLE_NAME='payable_title_corrections' THEN to_jsonb(NEW)->'before_value' ELSE NULL END,to_jsonb(NEW));
 RETURN NEW;
END $$;

CREATE FUNCTION public.payables_month_status(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total integer;v_reviewed integer;v_eligible integer;v_nominal numeric;v_paid numeric;v_outstanding numeric;
 v_event public.payable_month_events%ROWTYPE;v_closure public.payable_month_closures%ROWTYPE;v_import uuid;v_issues jsonb:='[]'::jsonb;
 v_status text:='OPEN';v_excluded integer;
BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_month IS NULL OR p_month<DATE '1900-01-01' OR p_month<>date_trunc('month',p_month)::date THEN
  RAISE EXCEPTION 'Informe o primeiro dia do mês de vencimento.' USING ERRCODE='22023';END IF;
 SELECT count(*)::integer,count(*) FILTER(WHERE review_status='CONCILIADO')::integer,
  count(*) FILTER(WHERE financial_status='PAID' AND amount_cents>0 AND review_status='A_CONCILIAR')::integer,
  coalesce(sum(amount_cents),0),coalesce(sum(paid_cents),0),coalesce(sum(payment_remaining_cents),0)
  INTO v_total,v_reviewed,v_eligible,v_nominal,v_paid,v_outstanding FROM public.payable_review_titles
  WHERE due_date>=p_month AND due_date<(p_month+interval '1 month')::date AND closing_eligible;
 SELECT count(*)::integer INTO v_excluded FROM public.payable_review_titles WHERE due_date>=p_month AND due_date<(p_month+interval '1 month')::date AND NOT closing_eligible;
 IF greatest(v_nominal,v_paid,v_outstanding)>9007199254740991 THEN RAISE EXCEPTION 'O mês excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT id INTO v_import FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_import IS NULL THEN v_issues:=v_issues||jsonb_build_array('Importe o relatório completo de Contas a Pagar.');END IF;
 IF v_total=0 THEN v_issues:=v_issues||jsonb_build_array('Não há títulos com vencimento neste mês.');END IF;
 IF v_reviewed<v_total THEN v_issues:=v_issues||jsonb_build_array('Todos os títulos devem estar totalmente pagos e marcados como CONCILIADO.');END IF;
 SELECT * INTO v_event FROM public.payable_month_events WHERE month=p_month ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT * INTO v_closure FROM public.payable_month_closures WHERE month=p_month ORDER BY version DESC LIMIT 1;
 IF v_event.action='CLOSE' AND v_reviewed=v_total AND v_total>0 THEN v_status:='CLOSED';END IF;
 RETURN jsonb_build_object('month',p_month,'status',v_status,'total_titles',v_total,'reconciled_count',v_reviewed,
  'excluded_historical_count',v_excluded,'excluded_legacy_count',v_excluded,'pending_count',v_total-v_reviewed,'eligible_count',v_eligible,'total_nominal_cents',v_nominal,'total_paid_cents',v_paid,
  'outstanding_cents',v_outstanding,'can_close',v_status='OPEN' AND jsonb_array_length(v_issues)=0,
  'revision',public.get_payables_revision(),'latest_closure',CASE WHEN v_closure.id IS NULL THEN NULL ELSE
   jsonb_build_object('id',v_closure.id,'version',v_closure.version,'created_at',v_closure.created_at,'created_by',v_closure.created_by,'observation',v_closure.observation) END,
  'last_event',CASE WHEN v_event.id IS NULL THEN NULL ELSE to_jsonb(v_event) END,'issues',v_issues);
END $$;

CREATE FUNCTION public.close_payables_month(p_month date,p_observation text,p_expected_revision jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_status jsonb;v_titles jsonb;v_historical jsonb;v_payments jsonb;v_realized jsonb;v_real_rows jsonb;v_id uuid;v_version integer;v_previous timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 IF p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Informe a observação do fechamento.' USING ERRCODE='22023';END IF;
 v_status:=public.payables_month_status(p_month);
 IF v_status->'revision' IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'A base mudou. Atualize o mês antes de fechar.' USING ERRCODE='40001';END IF;
 IF NOT coalesce((v_status->>'can_close')::boolean,false) THEN RAISE EXCEPTION 'Fechamento bloqueado: confira os títulos a conciliar e a base completa.' USING ERRCODE='22023';END IF;
 IF (v_status->>'total_titles')::integer+(v_status->>'excluded_historical_count')::integer>20000 THEN RAISE EXCEPTION 'O fechamento excede 20.000 títulos. Solicite um processamento administrativo; nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
 SELECT jsonb_agg(to_jsonb(t) ORDER BY t.macro,t.due_date,t.id) INTO v_titles FROM public.payable_review_titles t
  WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.closing_eligible;
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.due_date,t.id),'[]'::jsonb) INTO v_historical FROM public.payable_review_titles t
  WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND NOT t.closing_eligible;
 IF (SELECT count(*) FROM public.payable_payments p JOIN public.payable_titles t ON t.id=p.title_id
   WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date)>50000 THEN
  RAISE EXCEPTION 'O fechamento excede 50.000 pagamentos. Solicite um processamento administrativo; nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('cancelled_at',r.created_at,'cancellation_id',r.id,
   'cancellation_observation',r.observation,'created_by_name',a.display_name) ORDER BY p.paid_on,p.id),'[]'::jsonb) INTO v_payments
  FROM public.payable_effective_payments p JOIN public.payable_titles t ON t.id=p.title_id
  LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id LEFT JOIN public.profiles a ON a.id=p.created_by
  WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date;
 v_realized:=public.payable_payment_summary(p_month,(p_month+interval '1 month - 1 day')::date);
 IF jsonb_array_length(v_payments)>50000 OR (v_realized->>'payment_count')::integer>50000 THEN
  RAISE EXCEPTION 'O fechamento excede 50.000 pagamentos. Solicite um processamento administrativo; nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('created_by_name',a.display_name) ORDER BY p.paid_on,p.id),'[]'::jsonb) INTO v_real_rows
  FROM public.payable_effective_payments p LEFT JOIN public.profiles a ON a.id=p.created_by
  WHERE p.paid_on>=p_month AND p.paid_on<(p_month+interval '1 month')::date
   AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id);
 SELECT coalesce(max(version),0)+1,max(created_at) INTO v_version,v_previous FROM public.payable_month_closures WHERE month=p_month;
 INSERT INTO public.payable_month_closures(month,version,snapshot,source_revision,total_titles,total_nominal_cents,total_paid_cents,observation,created_by,created_at)
  VALUES(p_month,v_version,jsonb_build_object('month',p_month,'schema_version','1','titles',v_titles,'historical_titles',v_historical,'payments',v_payments,
   'realized',v_realized||jsonb_build_object('rows',v_real_rows)),v_status->'revision',(v_status->>'total_titles')::integer,
   (v_status->>'total_nominal_cents')::bigint,(v_status->>'total_paid_cents')::bigint,btrim(p_observation),auth.uid(),
   greatest(clock_timestamp(),coalesce(v_previous,'1900-01-01'::timestamptz)+interval '1 microsecond')) RETURNING id INTO v_id;
 SELECT max(created_at) INTO v_previous FROM public.payable_month_events WHERE month=p_month;
 INSERT INTO public.payable_month_events(month,closure_id,action,automatic,observation,created_by,created_at)
  VALUES(p_month,v_id,'CLOSE',false,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),coalesce(v_previous,'1900-01-01'::timestamptz)+interval '1 microsecond'));
 PERFORM cf_private.next_payable_control_revision();RETURN v_id;
END $$;

CREATE FUNCTION public.reopen_payables_month(p_month date,p_observation text,p_expected_closure_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_event public.payable_month_events%ROWTYPE;v_id uuid;BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 IF p_month IS NULL OR p_month<>date_trunc('month',p_month)::date OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Informe o mês e o motivo da reabertura.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_event FROM public.payable_month_events WHERE month=p_month ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_event.action IS DISTINCT FROM 'CLOSE' OR v_event.closure_id IS DISTINCT FROM p_expected_closure_id THEN
  RAISE EXCEPTION 'O fechamento mudou ou o mês já está aberto. Atualize antes de continuar.' USING ERRCODE='40001';END IF;
 INSERT INTO public.payable_month_events(month,closure_id,action,automatic,observation,created_by,created_at)
  VALUES(p_month,v_event.closure_id,'REOPEN',false,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),v_event.created_at+interval '1 microsecond')) RETURNING id INTO v_id;
 PERFORM cf_private.next_payable_control_revision();RETURN v_id;
END $$;

CREATE FUNCTION public.list_payable_month_closures(p_month date,p_offset integer DEFAULT 0,p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_rows jsonb;v_count integer;BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_month IS NULL OR p_month<>date_trunc('month',p_month)::date OR p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'Informe o mês e paginação válidos.' USING ERRCODE='22023';END IF;
 SELECT count(*)::integer INTO v_count FROM public.payable_month_closures WHERE month=p_month;
 SELECT coalesce(jsonb_agg(x.row ORDER BY x.version DESC),'[]'::jsonb) INTO v_rows FROM(
  SELECT c.version,(to_jsonb(c)-'snapshot')||jsonb_build_object('created_by_name',a.display_name) row FROM public.payable_month_closures c
   LEFT JOIN public.profiles a ON a.id=c.created_by WHERE c.month=p_month ORDER BY c.version DESC OFFSET p_offset LIMIT p_limit) x;
 RETURN jsonb_build_object('rows',v_rows,'count',v_count);
END $$;
CREATE FUNCTION public.read_payable_month_closure(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_row jsonb;BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT to_jsonb(c)||jsonb_build_object('created_by_name',a.display_name) INTO v_row FROM public.payable_month_closures c LEFT JOIN public.profiles a ON a.id=c.created_by WHERE c.id=p_id;
 IF v_row IS NULL THEN RAISE EXCEPTION 'Fechamento não encontrado.' USING ERRCODE='22023';END IF;RETURN v_row;
END $$;
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['payable_title_reviews','payable_title_corrections','payable_payment_reclassifications','payable_month_closures','payable_month_events','payable_title_macro_overrides'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_closing_history()',v_table||'_immutable',v_table);
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_closing_history()',v_table||'_audit',v_table);
 END LOOP;
END $$;

CREATE OR REPLACE VIEW public.payable_financial_titles WITH(security_invoker=true) AS
 SELECT t.*,
   coalesce(p.paid_cents,0)::bigint AS paid_cents,
   (CASE WHEN t.status IN ('NEW','OPEN') OR coalesce(p.paid_cents,0)>0
     THEN greatest(t.amount_cents-coalesce(p.paid_cents,0),0) ELSE 0 END)::bigint AS outstanding_cents,
   greatest(coalesce(p.paid_cents,0)-t.amount_cents,0)::bigint AS overpaid_cents,
   greatest(t.amount_cents-coalesce(p.paid_cents,0),0)::bigint AS payment_remaining_cents,
   CASE WHEN coalesce(p.paid_cents,0)>t.amount_cents THEN 'OVERPAID'
     WHEN coalesce(p.paid_cents,0)=t.amount_cents AND coalesce(p.paid_cents,0)>0 THEN 'PAID'
     WHEN coalesce(p.paid_cents,0)>0 THEN 'PARTIAL'
     WHEN t.status='SETTLED_IMPORT' THEN 'PENDING_RECONCILIATION' ELSE 'OPEN' END AS financial_status,
   p.last_payment_date,last_bank.bank_label AS last_payment_bank,coalesce(control.payment_token,revision.id) AS payment_revision
 FROM public.payable_titles t
 LEFT JOIN public.payable_title_control_revisions control ON control.title_id=t.id
 LEFT JOIN LATERAL(SELECT sum(p.amount_cents) paid_cents,max(p.paid_on) last_payment_date
   FROM public.payable_payments p WHERE p.title_id=t.id
     AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) p ON true
 LEFT JOIN LATERAL(SELECT p.bank_label FROM public.payable_payments p WHERE p.title_id=t.id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)
   ORDER BY p.paid_on DESC,p.event_revision DESC LIMIT 1) last_bank ON true
 LEFT JOIN LATERAL(SELECT e.id FROM (
   SELECT p.id,p.event_revision FROM public.payable_payments p WHERE p.title_id=t.id
   UNION ALL SELECT r.id,r.event_revision FROM public.payable_payment_reversals r
     JOIN public.payable_payments p ON p.id=r.payment_id WHERE p.title_id=t.id
 ) e ORDER BY e.event_revision DESC LIMIT 1) revision ON true;

CREATE FUNCTION cf_private.preserve_payable_macro_override() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_override public.payable_title_macro_overrides%ROWTYPE;BEGIN
 SELECT * INTO v_override FROM public.payable_title_macro_overrides WHERE title_id=OLD.id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF OLD.plan IS DISTINCT FROM NEW.plan AND v_override.active THEN
  INSERT INTO public.payable_title_macro_overrides(title_id,plan,macro,active,observation,created_by,created_at)
   VALUES(OLD.id,NEW.plan,NULL,false,'O plano da importação mudou; a classificação específica anterior deixou de valer.',auth.uid(),greatest(clock_timestamp(),v_override.created_at+interval '1 microsecond'));
 ELSIF NEW.last_import_id IS DISTINCT FROM OLD.last_import_id AND OLD.plan=NEW.plan AND v_override.active AND v_override.plan=NEW.plan THEN
  NEW.macro:=v_override.macro;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER payable_macro_override_preserve BEFORE UPDATE ON public.payable_titles FOR EACH ROW EXECUTE FUNCTION cf_private.preserve_payable_macro_override();

CREATE FUNCTION cf_private.payable_closing_exclusion(p_title_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.payable_titles t JOIN cf_private.payable_identity_registry i
  ON i.scope=t.scope AND i.business_key=cf_private.payable_business_key(t.branch,t.entry_number)
  WHERE t.id=p_title_id AND t.status='SETTLED_IMPORT' AND i.title_id<>t.id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=t.id
    AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id))) THEN
  RETURN 'Versão anterior preservada no histórico; a identidade canônica está vinculada a outro título.';
 END IF;RETURN NULL;
END $$;

CREATE VIEW public.payable_effective_payments WITH(security_invoker=true) AS
 SELECT p.*,coalesce(r.macro,p.macro_snapshot) AS effective_macro,r.id AS reclassification_id
 FROM public.payable_payments p LEFT JOIN LATERAL(SELECT r.id,r.macro FROM public.payable_payment_reclassifications r
  WHERE r.payment_id=p.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true;
CREATE VIEW public.payable_review_titles WITH(security_invoker=true) AS
 SELECT f.*,CASE WHEN r.reviewed AND r.fingerprint=h.fingerprint AND f.financial_status='PAID' AND f.amount_cents>0
   THEN 'CONCILIADO' ELSE 'A_CONCILIAR' END AS review_status,
  r.id AS review_id,r.created_at AS reviewed_at,r.created_by AS reviewed_by,h.fingerprint AS review_fingerprint,
  exclusion.reason IS NULL AS closing_eligible,exclusion.reason AS closing_exclusion_reason
 FROM public.payable_financial_titles f LEFT JOIN public.payable_title_control_revisions c ON c.title_id=f.id
 CROSS JOIN LATERAL(SELECT encode(sha256(convert_to(jsonb_build_object(
  'title',to_jsonb(f)-ARRAY['last_import_id','first_import_id','source_key','settled_at','status'],
  'source_active',f.status<>'SETTLED_IMPORT','control_revision',coalesce(c.revision,0))::text,'UTF8')),'hex') AS fingerprint) h
 CROSS JOIN LATERAL(SELECT cf_private.payable_closing_exclusion(f.id) AS reason) exclusion
 LEFT JOIN LATERAL(SELECT r.* FROM public.payable_title_reviews r WHERE r.title_id=f.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true;
REVOKE ALL ON TABLE public.payable_effective_payments,public.payable_review_titles FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_effective_payments,public.payable_review_titles TO authenticated;

CREATE FUNCTION cf_private.next_payable_control_revision() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_revision bigint;BEGIN
 UPDATE cf_private.payable_control_state SET revision=revision+1 WHERE singleton RETURNING revision INTO v_revision;RETURN v_revision;
END $$;
CREATE FUNCTION cf_private.reopen_changed_payable_month(p_month date,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_last public.payable_month_events%ROWTYPE;BEGIN
 IF p_month IS NULL THEN RETURN;END IF;
 SELECT * INTO v_last FROM public.payable_month_events WHERE month=date_trunc('month',p_month)::date ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_last.action='CLOSE' THEN
  INSERT INTO public.payable_month_events(month,closure_id,action,automatic,observation,created_by,created_at)
   VALUES(v_last.month,v_last.closure_id,'REOPEN',true,left(p_reason,1000),auth.uid(),greatest(clock_timestamp(),v_last.created_at+interval '1 microsecond'));
 END IF;
END $$;
CREATE FUNCTION cf_private.invalidate_payable_review(p_title_id uuid,p_reason text,p_old_due date DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_revision bigint;v_month date;BEGIN
 v_revision:=cf_private.next_payable_control_revision();
 INSERT INTO public.payable_title_control_revisions(title_id,revision) VALUES(p_title_id,v_revision)
  ON CONFLICT(title_id) DO UPDATE SET revision=EXCLUDED.revision,payment_token=gen_random_uuid();
 FOR v_month IN SELECT DISTINCT date_trunc('month',d)::date FROM(
  SELECT due_date d FROM public.payable_titles WHERE id=p_title_id
  UNION ALL SELECT p_old_due UNION ALL SELECT paid_on FROM public.payable_payments WHERE title_id=p_title_id) dates WHERE d IS NOT NULL LOOP
  PERFORM cf_private.reopen_changed_payable_month(v_month,p_reason);
 END LOOP;
END $$;
CREATE FUNCTION cf_private.payable_title_review_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM cf_private.invalidate_payable_review(NEW.id,'Novo título na base após o fechamento.');
 ELSIF ROW(OLD.entry_number,OLD.description,OLD.due_date,OLD.amount_cents,OLD.source_status,OLD.plan,OLD.bank_account,OLD.branch,OLD.issued_on,OLD.macro,OLD.status='SETTLED_IMPORT')
  IS DISTINCT FROM ROW(NEW.entry_number,NEW.description,NEW.due_date,NEW.amount_cents,NEW.source_status,NEW.plan,NEW.bank_account,NEW.branch,NEW.issued_on,NEW.macro,NEW.status='SETTLED_IMPORT') THEN
  PERFORM cf_private.invalidate_payable_review(NEW.id,'Dados do título alterados; confira e concilie novamente.',OLD.due_date);
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION cf_private.payable_payment_review_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_title uuid;BEGIN
 IF TG_TABLE_NAME='payable_payments' THEN v_title:=NEW.title_id;
 ELSE SELECT title_id INTO v_title FROM public.payable_payments WHERE id=NEW.payment_id;END IF;
 PERFORM cf_private.invalidate_payable_review(v_title,'Pagamento, estorno ou classificação financeira alterados; confira o fechamento.');RETURN NEW;
END $$;
CREATE TRIGGER payable_title_review_change AFTER INSERT OR UPDATE ON public.payable_titles FOR EACH ROW EXECUTE FUNCTION cf_private.payable_title_review_change();
CREATE TRIGGER payable_payment_review_change AFTER INSERT ON public.payable_payments FOR EACH ROW EXECUTE FUNCTION cf_private.payable_payment_review_change();
CREATE TRIGGER payable_reversal_review_change AFTER INSERT ON public.payable_payment_reversals FOR EACH ROW EXECUTE FUNCTION cf_private.payable_payment_review_change();
CREATE TRIGGER payable_reclassification_review_change AFTER INSERT ON public.payable_payment_reclassifications FOR EACH ROW EXECUTE FUNCTION cf_private.payable_payment_review_change();

CREATE OR REPLACE FUNCTION public.get_payables_revision() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_import uuid;v_revision text;BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT id INTO v_import FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT p.revision::text||':'||c.revision::text INTO v_revision FROM cf_private.payable_payment_state p CROSS JOIN cf_private.payable_control_state c WHERE p.singleton AND c.singleton;
 RETURN jsonb_build_object('import_id',v_import,'financial_revision',v_revision);
END $$;

CREATE FUNCTION public.review_payable_title(p_title_id uuid,p_observation text,p_expected_fingerprint text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_title public.payable_review_titles%ROWTYPE;v_id uuid;BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 IF p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Informe a observação da conciliação.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_title FROM public.payable_review_titles WHERE id=p_title_id;
 IF v_title.id IS NULL THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='22023';END IF;
 IF v_title.review_fingerprint IS DISTINCT FROM p_expected_fingerprint THEN RAISE EXCEPTION 'O título mudou. Confira os dados atualizados.' USING ERRCODE='40001';END IF;
 IF NOT v_title.closing_eligible THEN RAISE EXCEPTION 'Esta versão anterior é somente histórica e não integra o fechamento.' USING ERRCODE='22023';END IF;
 IF v_title.financial_status<>'PAID' OR v_title.amount_cents<=0 OR v_title.paid_cents<>v_title.amount_cents THEN
  RAISE EXCEPTION 'Somente um título totalmente pago, sem diferença, pode ser conciliado.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.id<>v_title.id AND t.scope=v_title.scope
  AND cf_private.payable_business_key(t.branch,t.entry_number)=cf_private.payable_business_key(v_title.branch,v_title.entry_number)
  AND (t.status<>'SETTLED_IMPORT' OR EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=t.id AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)))) THEN RAISE EXCEPTION 'A identidade do título possui versões ativas ambíguas.' USING ERRCODE='P0016';END IF;
 IF v_title.review_status='CONCILIADO' THEN RETURN v_title.review_id;END IF;
 INSERT INTO public.payable_title_reviews(title_id,fingerprint,reviewed,observation,created_by)
  VALUES(p_title_id,v_title.review_fingerprint,true,btrim(p_observation),auth.uid()) RETURNING id INTO v_id;
 PERFORM cf_private.next_payable_control_revision();RETURN v_id;
END $$;

CREATE FUNCTION public.correct_payable_title(p_title_id uuid,p_due_date date,p_amount_cents bigint,p_bank_account text,
 p_description text,p_issued_on date,p_macro text,p_observation text,p_expected_fingerprint text,p_reclassify_payments boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.payable_review_titles%ROWTYPE;v_before jsonb;v_after jsonb;v_id uuid;v_has_payments boolean;v_do_reclass boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 IF p_due_date IS NULL OR p_due_date<DATE '1900-01-01' OR p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 1 AND 9007199254740991
  OR p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 1500 OR length(coalesce(p_bank_account,''))>300
  OR (p_issued_on IS NOT NULL AND p_issued_on<DATE '1900-01-01') OR NOT EXISTS(SELECT 1 FROM public.payable_macros WHERE name=p_macro)
  OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Confira valor positivo em centavos, datas, favorecido, banco, macro e motivo da correção.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_title FROM public.payable_review_titles WHERE id=p_title_id;
 IF v_title.id IS NULL THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='22023';END IF;
 IF v_title.review_fingerprint IS DISTINCT FROM p_expected_fingerprint THEN RAISE EXCEPTION 'O título mudou. Confira os dados antes de corrigir.' USING ERRCODE='40001';END IF;
 IF NOT v_title.closing_eligible THEN RAISE EXCEPTION 'Esta versão anterior é somente histórica. Corrija o título canônico.' USING ERRCODE='22023';END IF;
 SELECT p_reclassify_payments IS TRUE AND EXISTS(SELECT 1 FROM public.payable_effective_payments p WHERE p.title_id=p_title_id
  AND p.effective_macro<>p_macro AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) INTO v_do_reclass;
 IF ROW(v_title.due_date,v_title.amount_cents,v_title.bank_account,v_title.description,v_title.issued_on,v_title.macro)
  IS NOT DISTINCT FROM ROW(p_due_date,p_amount_cents,nullif(btrim(p_bank_account),''),btrim(p_description),p_issued_on,p_macro) AND NOT v_do_reclass THEN
  RAISE EXCEPTION 'Nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
 SELECT EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=p_title_id AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) INTO v_has_payments;
 IF p_macro<>v_title.macro AND v_has_payments AND p_reclassify_payments IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Confirme expressamente a reclassificação dos pagamentos deste título para o novo macro.' USING ERRCODE='22023';END IF;
 SELECT to_jsonb(t) INTO v_before FROM public.payable_titles t WHERE id=p_title_id;
 v_after:=v_before||jsonb_build_object('due_date',p_due_date,'amount_cents',p_amount_cents,'bank_account',nullif(btrim(p_bank_account),''),
  'description',btrim(p_description),'issued_on',p_issued_on,'macro',p_macro);
 INSERT INTO public.payable_title_corrections(title_id,before_value,after_value,observation,created_by)
  VALUES(p_title_id,v_before,v_after,btrim(p_observation),auth.uid()) RETURNING id INTO v_id;
 IF p_macro<>v_title.macro OR v_do_reclass THEN
  INSERT INTO public.payable_title_macro_overrides(title_id,plan,macro,active,correction_id,observation,created_by,created_at)
   SELECT p_title_id,v_title.plan,p_macro,true,v_id,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),coalesce(max(created_at),'1900-01-01'::timestamptz)+interval '1 microsecond')
   FROM public.payable_title_macro_overrides WHERE title_id=p_title_id;
 END IF;
 UPDATE public.payable_titles SET due_date=p_due_date,amount_cents=p_amount_cents,bank_account=nullif(btrim(p_bank_account),''),
  description=btrim(p_description),issued_on=p_issued_on,macro=p_macro WHERE id=p_title_id;
 IF v_do_reclass THEN
  INSERT INTO public.payable_payment_reclassifications(payment_id,correction_id,macro,previous_macro,created_by,created_at)
   SELECT p.id,v_id,p_macro,p.effective_macro,auth.uid(),greatest(clock_timestamp(),coalesce(old.created_at,'1900-01-01'::timestamptz)+interval '1 microsecond')
   FROM public.payable_effective_payments p LEFT JOIN LATERAL(SELECT r.created_at FROM public.payable_payment_reclassifications r WHERE r.payment_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1) old ON true
   WHERE p.title_id=p_title_id AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id) AND p.effective_macro<>p_macro;
 END IF;RETURN v_id;
END $$;

-- A correção expressa usa alocações novas e conserva o macro original do pagamento.
CREATE OR REPLACE FUNCTION public.payable_payment_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total numeric;v_count integer;v_macros jsonb;v_pending integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end<p_start OR p_end-p_start>3660 THEN
    RAISE EXCEPTION 'Informe o período real de pagamento.' USING ERRCODE='22023'; END IF;
  SELECT coalesce(sum(p.amount_cents),0),count(*)::integer INTO v_total,v_count FROM public.payable_effective_payments p
    WHERE p.paid_on BETWEEN p_start AND p_end AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id);
  IF v_total>9007199254740991 THEN RAISE EXCEPTION 'O realizado excede o limite de precisão.' USING ERRCODE='22003'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('macro',m.name,'amount_cents',coalesce(p.amount_cents,0),'count',coalesce(p.n,0)) ORDER BY m.name),'[]'::jsonb)
    INTO v_macros FROM public.payable_macros m LEFT JOIN(SELECT p.effective_macro,sum(p.amount_cents) amount_cents,count(*) n
      FROM public.payable_effective_payments p WHERE p.paid_on BETWEEN p_start AND p_end
      AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id) GROUP BY p.effective_macro) p ON p.effective_macro=m.name;
  SELECT count(*)::integer INTO v_pending FROM public.payable_financial_titles WHERE financial_status='PENDING_RECONCILIATION';
  RETURN jsonb_build_object('start_date',p_start,'end_date',p_end,'total_paid_cents',v_total,'payment_count',v_count,
    'by_macro',v_macros,'pending_reconciliation_count',v_pending,'revision',public.get_payables_revision());
END $$;

CREATE OR REPLACE FUNCTION public.list_payable_payments(p_start date,p_end date,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,
 p_title_id uuid DEFAULT NULL,p_macro text DEFAULT NULL,p_bank_account_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_count integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF (p_title_id IS NULL AND (p_start IS NULL OR p_end IS NULL))
    OR (p_start IS NOT NULL AND p_start<DATE '1900-01-01')
    OR (p_start IS NOT NULL AND p_end IS NOT NULL AND (p_end<p_start OR (p_title_id IS NULL AND p_end-p_start>3660)))
    OR p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Informe um período e paginação válidos.' USING ERRCODE='22023'; END IF;
  SELECT count(*)::integer INTO v_count FROM public.payable_effective_payments p
    LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id
    WHERE (p_start IS NULL OR p.paid_on>=p_start) AND (p_end IS NULL OR p.paid_on<=p_end) AND (p_title_id IS NULL OR p.title_id=p_title_id)
      AND (p_title_id IS NOT NULL OR r.id IS NULL) AND (p_macro IS NULL OR p.effective_macro=p_macro)
      AND (p_bank_account_id IS NULL OR p.bank_account_id=p_bank_account_id);
  SELECT coalesce(jsonb_agg(x.row ORDER BY x.paid_on DESC,x.event_revision DESC),'[]'::jsonb) INTO v_rows FROM(
    SELECT p.paid_on,p.event_revision,to_jsonb(p)||jsonb_build_object('cancelled_at',r.created_at,'cancelled_by',r.created_by,
      'cancellation_id',r.id,'cancellation_observation',r.observation,'status',CASE WHEN r.id IS NULL THEN 'ACTIVE' ELSE 'CANCELLED' END,
      'created_by_name',creator.display_name,'created_by_username',creator.username,'cancelled_by_name',canceller.display_name,
      'title_status',financial.status,'financial_status',financial.financial_status,'review_status',financial.review_status) row
    FROM public.payable_effective_payments p LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id
      LEFT JOIN public.profiles creator ON creator.id=p.created_by LEFT JOIN public.profiles canceller ON canceller.id=r.created_by
      JOIN public.payable_review_titles financial ON financial.id=p.title_id
    WHERE (p_start IS NULL OR p.paid_on>=p_start) AND (p_end IS NULL OR p.paid_on<=p_end) AND (p_title_id IS NULL OR p.title_id=p_title_id)
      AND (p_title_id IS NOT NULL OR r.id IS NULL) AND (p_macro IS NULL OR p.effective_macro=p_macro)
      AND (p_bank_account_id IS NULL OR p.bank_account_id=p_bank_account_id)
    ORDER BY p.paid_on DESC,p.event_revision DESC OFFSET p_offset LIMIT p_limit) x;
  RETURN jsonb_build_object('rows',v_rows,'count',v_count,'revision',public.get_payables_revision());
END $$;

CREATE FUNCTION cf_private.guard_payable_payment_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_title public.payable_titles%ROWTYPE;BEGIN
 IF cf_private.payable_closing_exclusion(NEW.title_id) IS NOT NULL THEN
  RAISE EXCEPTION 'Versão anterior somente histórica. Registre o pagamento no título canônico.' USING ERRCODE='P0016';END IF;
 SELECT * INTO v_title FROM public.payable_titles WHERE id=NEW.title_id;
 IF EXISTS(SELECT 1 FROM public.payable_titles other WHERE other.id<>NEW.title_id AND other.scope=v_title.scope
  AND cf_private.payable_business_key(other.branch,other.entry_number)=cf_private.payable_business_key(v_title.branch,v_title.entry_number)
  AND (other.status<>'SETTLED_IMPORT' OR EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=other.id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)))) THEN
  RAISE EXCEPTION 'Há versões ativas ou pagamentos em outra versão da mesma identidade. Confira o histórico antes de continuar.' USING ERRCODE='P0016';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payable_payment_identity_guard BEFORE INSERT ON public.payable_payments FOR EACH ROW EXECUTE FUNCTION cf_private.guard_payable_payment_identity();

REVOKE ALL ON FUNCTION cf_private.payable_closing_exclusion(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cf_private.payable_closing_exclusion(uuid) TO authenticated;
REVOKE ALL ON FUNCTION cf_private.guard_payable_payment_identity() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION cf_private.block_payable_closing_history(),cf_private.audit_payable_closing_history(),
 cf_private.next_payable_control_revision(),cf_private.reopen_changed_payable_month(date,text),
 cf_private.invalidate_payable_review(uuid,text,date),cf_private.payable_title_review_change(),
 cf_private.payable_payment_review_change(),cf_private.preserve_payable_macro_override() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.review_payable_title(uuid,text,text),
 public.correct_payable_title(uuid,date,bigint,text,text,date,text,text,text,boolean),public.payables_month_status(date),
 public.close_payables_month(date,text,jsonb),public.reopen_payables_month(date,text,uuid),
 public.list_payable_month_closures(date,integer,integer),public.read_payable_month_closure(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.review_payable_title(uuid,text,text),
 public.correct_payable_title(uuid,date,bigint,text,text,date,text,text,text,boolean),public.payables_month_status(date),
 public.close_payables_month(date,text,jsonb),public.reopen_payables_month(date,text,uuid),
 public.list_payable_month_closures(date,integer,integer),public.read_payable_month_closure(uuid) TO authenticated;
COMMENT ON VIEW public.payable_review_titles IS 'Revisão explícita válida apenas com pagamento integral exato e a mesma versão comercial/financeira. Importação idêntica, last_import_id e NEW para OPEN não invalidam a revisão.';
COMMENT ON TABLE public.payable_month_closures IS 'Posições imutáveis por versão do fechamento. Títulos selecionados pelo vencimento; realizados pela data efetiva do pagamento, inclusive títulos de outros meses.';
COMMENT ON TABLE public.payable_title_macro_overrides IS 'Correção específica do título, preservada em importações do mesmo plano. Uma mudança de plano cancela a substituição anterior com histórico.';
INSERT INTO public.central_schema_migrations(version) VALUES('017_payable_month_closing');
COMMIT;
