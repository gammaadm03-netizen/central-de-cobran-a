-- CENTRAL FINANCEIRA — novos status do atendimento de Cobrança (054).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 047. Pode ser executado novamente com segurança.
-- Preserva os dados, a carteira, o histórico e as regras de recebimento.
-- Não há atualização de Edge Function nesta mudança.

-- Novos status operacionais do atendimento; sem alterações financeiras.
-- Mantém o fluxo 029 e a visibilidade/conciliação do relatório completo 047.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $cf054$ BEGIN
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='054_collection_operational_statuses') THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN
  RAISE EXCEPTION 'Ative o SQL 047 de Contas a Receber antes dos novos status de atendimento.' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(2045812308);
 EXECUTE $cf054ddl$
-- Expansão do conjunto permitido, preservando todos os status e dados anteriores.
ALTER TABLE public.collection_cases DROP CONSTRAINT collection_cases_status_check;
ALTER TABLE public.collection_cases ADD CONSTRAINT collection_cases_status_check CHECK(status IN(
 'NOVO TÍTULO - COBRAR','SEM SUCESSO','AGUARDANDO RETORNO','COBRANCA VIA EMAIL','COBRANCA POR WHATSAPP',
 'AGUARDANDO LIQUIDACAO','SEM PRAZO','SEM PREVISAO DE PG','PAGAMENTO PROGRAMADO','TÍTULO PAGO',
 'MERCADORIA A RECOLHER','NOTA A CANCELAR','AGUARDANDO NOTA ASSINADA','NOTA COM PENDÊNCIA','PAUSAR COBRANÇA'));

-- A nova seleção usa o mesmo controle de carteira, revisão, protocolo e tempo.
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
  'AGUARDANDO LIQUIDACAO','SEM PRAZO','SEM PREVISAO DE PG','PAGAMENTO PROGRAMADO','TÍTULO PAGO','MERCADORIA A RECOLHER','NOTA A CANCELAR','AGUARDANDO NOTA ASSINADA','NOTA COM PENDÊNCIA','PAUSAR COBRANÇA')
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
   'AGUARDANDO LIQUIDACAO','SEM PRAZO','SEM PREVISAO DE PG','PAGAMENTO PROGRAMADO','TÍTULO PAGO','MERCADORIA A RECOLHER','NOTA A CANCELAR','AGUARDANDO NOTA ASSINADA','NOTA COM PENDÊNCIA','PAUSAR COBRANÇA'))
  OR (p_financial_status IS NOT NULL AND p_financial_status NOT IN ('ACTIVE','NEW','OPEN','PENDING_VALIDATION','NOT_LOCATED','VALIDATED','RETIRED_FROM_REPORT'))
  OR (p_next_action IS NOT NULL AND p_next_action NOT IN ('NONE','CONTACT','NO_RESPONSE','PROMISE','RETRY','OTHER'))
  OR (p_due_start IS NOT NULL AND p_due_end IS NOT NULL AND p_due_start>p_due_end) OR (p_unassigned AND p_collector_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Filtros de cobrança inválidos.' USING ERRCODE='22023';END IF;
 WITH filtered AS MATERIALIZED(
  SELECT t.*,coalesce(c.status,cf_private.collection_workbench_legacy_status(t.last_action)) AS case_status,coalesce(c.next_date,t.next_action_date) AS case_next_date
  FROM public.receivable_titles t LEFT JOIN public.collection_cases c ON c.title_id=t.id
  WHERE cf_private.collection_workbench_visible(t) AND t.scope='grupo-consolidado'
   AND (p_queue='all' OR (p_queue='active' AND NOT t.retired_from_report AND t.status IN ('NEW','OPEN','NOT_LOCATED') AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.title_id=t.id))
    OR (p_queue='returns' AND cf_private.collection_workflow_collectible(t) AND t.next_action_date<=v_today) OR (p_queue='history' AND (t.status='VALIDATED' OR t.retired_from_report)))
   AND (p_collector_id IS NULL OR t.collector_id=p_collector_id) AND (NOT p_unassigned OR t.collector_id IS NULL)
   AND (p_due_start IS NULL OR t.due_date>=p_due_start) AND (p_due_end IS NULL OR t.due_date<=p_due_end)
   AND (p_status IS NULL OR coalesce(c.status,cf_private.collection_workbench_legacy_status(t.last_action))=p_status)
   AND (p_financial_status IS NULL OR t.status=p_financial_status OR (p_financial_status='ACTIVE' AND t.status<>'VALIDATED' AND NOT t.retired_from_report)
    OR (p_financial_status='RETIRED_FROM_REPORT' AND t.retired_from_report))
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

COMMENT ON FUNCTION public.save_collection_case(uuid,text,text,text,date,bigint,bigint,date,boolean,uuid) IS 'Status operacionais 054. Rascunho não muda agenda oficial; finalização exige atendimento iniciado, observação e próxima ação/data. Status de pausa ou cancelamento não confirma recebimento nem retira o título.';
INSERT INTO public.central_schema_migrations(version) VALUES('054_collection_operational_statuses');
NOTIFY pgrst,'reload schema';
$cf054ddl$;
END $cf054$;
COMMIT;
