-- Cobrança: retornos prioritários, atendimento iniciado e validação financeira.
-- Incremental: preserva recebimentos, comissões, responsáveis e históricos.
BEGIN;
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
COMMIT;
