-- CENTRAL FINANCEIRA — rascunho de e-mail de Cobrança (040).
-- Copie o arquivo inteiro no SQL Editor do projeto existente.
-- Requer a base de Cobrança com 024, contatos 027 e atendimento 029.
-- Não depende dos limites individuais 039; não modifica contas nem permissões de perfis.
-- Repetível; não altera títulos, recebimentos, contatos, atendimentos ou tempos registrados.
-- Não envia e-mails, não marca mensagens como enviadas e não publica Edge Functions.
-- SOURCE: 040_collection_email_draft.sql
-- Rascunho de e-mail após finalização própria comprovada. Somente leitura:
-- não envia mensagens, não marca envio e não altera cobrança ou dados financeiros.
-- Repetível; independente dos limites individuais 039.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL
  OR to_regclass('public.collection_work_requests') IS NULL
  OR to_regclass('public.collection_customer_contacts') IS NULL
  OR to_regclass('public.receivable_receipts') IS NULL
  OR to_regclass('cf_private.approved_sessions') IS NULL
  OR to_regprocedure('cf_private.session_allowed()') IS NULL
  OR to_regprocedure('cf_private.collection_workflow_write_allowed()') IS NULL
  OR to_regprocedure('cf_private.normalize_collection_contact_methods(jsonb,text)') IS NULL THEN
  RAISE EXCEPTION 'Ative a base de Cobrança, contatos 027 e fluxo de atendimento 029 antes dos rascunhos de e-mail.' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='024_receivable_received_import')
  OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='027_collection_customer_context')
  OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='029_collection_workflow') THEN
  RAISE EXCEPTION 'Ative as atualizações 024, 027 e 029 antes dos rascunhos de e-mail.' USING ERRCODE='22023';
 END IF;
END $$;
SELECT pg_advisory_xact_lock(2045812308);

CREATE OR REPLACE FUNCTION public.prepare_collection_customer_email(p_finish_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_request public.collection_work_requests%ROWTYPE;
 v_anchor public.receivable_titles%ROWTYPE;
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_emails jsonb:='[]'::jsonb;v_rows jsonb;v_email text;
 v_count bigint;v_overdue_count bigint;v_upcoming_count bigint;
 v_total numeric;v_overdue numeric;v_upcoming numeric;v_absolute numeric;v_result jsonb;
BEGIN
 PERFORM cf_private.require_collection_workbench_read();
 IF NOT cf_private.collection_workflow_write_allowed() THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 -- UUIDs de finalização são referências, nunca credenciais. O ator, os dados e
 -- ambos os resultados devem corresponder ao registro imutável do servidor.
 SELECT * INTO v_request FROM public.collection_work_requests
  WHERE actor_id=auth.uid() AND request_id=p_finish_request_id;
 IF NOT FOUND OR v_request.payload->>'kind' IS DISTINCT FROM 'case'
  OR v_request.payload->'finish' IS DISTINCT FROM 'true'::jsonb
  OR v_request.result->'finished' IS DISTINCT FROM 'true'::jsonb
  OR v_request.payload->>'title_id' IS DISTINCT FROM v_request.title_id::text
  OR v_request.result->>'title_id' IS DISTINCT FROM v_request.title_id::text THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
 -- A âncora pode ter ido para validação ou sido quitada após o atendimento.
 -- Isso não reabre a dívida. Somente os demais títulos realmente pendentes
 -- serão relacionados. A visibilidade e a carteira são reavaliadas agora.
 v_anchor:=cf_private.collection_workbench_title(v_request.title_id);
 PERFORM cf_private.require_collection_title(v_anchor);
 IF v_anchor.collector_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.collection_agents WHERE id=v_anchor.collector_id AND enabled) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;

 SELECT cf_private.normalize_collection_contact_methods(c.emails,'emails') INTO v_emails
  FROM public.collection_customer_contacts c WHERE c.customer_key=v_anchor.customer_key;
 v_emails:=coalesce(v_emails,'[]'::jsonb);
 -- Não aceitar listas de destinatários ou metadados de cabeçalho disfarçados
 -- de endereço único em registros legados. O frontend ainda codifica cada URI.
 FOR v_email IN SELECT value FROM jsonb_array_elements_text(v_emails) LOOP
  IF length(v_email)>254 OR length(split_part(v_email,'@',1))>64
   OR v_email ~ '[,;<>:"\\]' OR v_email ~ '[[:cntrl:]]'
   OR split_part(v_email,'@',1) ~ '^\.|\.$|\.\.'
   OR split_part(v_email,'@',2) !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' THEN
   RAISE EXCEPTION 'Revise os e-mails cadastrados para este cliente antes de preparar o rascunho.' USING ERRCODE='22023';
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO v_emails FROM jsonb_array_elements(v_emails);

 -- O recorte adicional para títulos futuros pertence exclusivamente a esta
 -- leitura autorizada. Não amplia workbench, RLS ou carteira de outra pessoa.
 -- O limite 5001 serve apenas para detectar excesso; nunca retorna truncado.
 WITH eligible AS MATERIALIZED(
  SELECT t.id,t.document,t.branch,t.due_date,t.amount_cents
  FROM public.receivable_titles t
  WHERE t.scope=v_anchor.scope AND t.customer_key=v_anchor.customer_key
   AND t.collector_id=v_anchor.collector_id
   AND t.status IN ('NEW','OPEN','NOT_LOCATED') AND t.validation_status='NONE'
   AND NOT EXISTS(SELECT 1 FROM public.receivable_receipts r WHERE r.title_id=t.id)
  ORDER BY t.due_date,t.document,t.branch,t.id LIMIT 5001
 ) SELECT count(*),count(*) FILTER(WHERE due_date<v_today),count(*) FILTER(WHERE due_date>=v_today),
  coalesce(sum(amount_cents),0),coalesce(sum(amount_cents) FILTER(WHERE due_date<v_today),0),
  coalesce(sum(amount_cents) FILTER(WHERE due_date>=v_today),0),coalesce(sum(abs(amount_cents::numeric)),0),
  coalesce(jsonb_agg(jsonb_build_object('title_id',id,'document',document,'branch',branch,
   'due_date',due_date,'amount_cents',amount_cents,'category',CASE WHEN due_date<v_today THEN 'OVERDUE' ELSE 'UPCOMING' END)
   ORDER BY due_date,document,branch,id),'[]'::jsonb)
 INTO v_count,v_overdue_count,v_upcoming_count,v_total,v_overdue,v_upcoming,v_absolute,v_rows FROM eligible;
 IF v_count>5000 THEN
  RAISE EXCEPTION 'Este cliente possui mais de 5.000 títulos pendentes nesta carteira. O rascunho não foi preparado; nenhum título foi omitido silenciosamente.' USING ERRCODE='54000';
 END IF;
 IF greatest(abs(v_total),abs(v_overdue),abs(v_upcoming),v_absolute)>9007199254740991 THEN
  RAISE EXCEPTION 'O total dos títulos excede o limite seguro de precisão. O rascunho não foi preparado.' USING ERRCODE='22003';
 END IF;
 v_result:=jsonb_build_object('request_id',v_request.request_id,'title_id',v_anchor.id,
  'customer_key',v_anchor.customer_key,'client_name',v_anchor.client_name,'as_of_date',v_today,
  'emails',v_emails,'rows',v_rows,'overdue_count',v_overdue_count,'upcoming_count',v_upcoming_count,
  'total_count',v_count,'overdue_cents',v_overdue,'upcoming_cents',v_upcoming,'total_cents',v_total);
 RETURN v_result||jsonb_build_object('revision',encode(sha256(convert_to(v_result::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION public.prepare_collection_customer_email(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.prepare_collection_customer_email(uuid) TO authenticated;
COMMENT ON FUNCTION public.prepare_collection_customer_email(uuid) IS 'Somente leitura após finalização própria comprovada, com permissões e carteira revalidadas. Todos os títulos pendentes do mesmo cliente/escopo/cobradora, vencidos e a vencer separados. Não envia nem registra mensagem enviada.';
INSERT INTO public.central_schema_migrations(version) VALUES('040_collection_email_draft') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
