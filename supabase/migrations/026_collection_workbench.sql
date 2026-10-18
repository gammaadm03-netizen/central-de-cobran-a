-- Central de Cobrança: acompanhamento operacional e tempo persistente.
-- Não altera regras de quitação, recebimentos, comissões ou responsáveis.
BEGIN;
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
COMMIT;
