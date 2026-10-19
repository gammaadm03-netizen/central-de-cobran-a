-- CENTRAL FINANCEIRA — otimização da importação de Contas a Receber.
-- Cole este SQL completo no SQL Editor; não é código de Edge Function.
-- Executar após as atualizações 023 e 024. Não exige a atualização de e-mail 040.
-- Repetível: não importa planilhas, não altera dados nem refaz vínculos.
-- Mantém a comparação exata de identidade e utiliza o índice existente da 023.
-- O deploy do site e da função receivables-import é uma etapa separada.

-- Importação de recebíveis: usa o índice existente para localizar parcelas.
-- Acrescenta somente pré-filtros indexáveis; a identidade JSON exata é mantida.
-- Não altera dados, vínculos, valores, permissões, limites ou regras de quitação.
-- Independente de contatos/e-mail e das atualizações 025 a 040.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL
  OR to_regclass('public.receivable_sync_identity_lookup') IS NULL
  OR to_regprocedure('cf_private.resolve_receivable_sync_rows(text,jsonb,jsonb,text)') IS NULL THEN
  RAISE EXCEPTION 'Ative as atualizações 023 e 024 de recebíveis e confira o índice de identificação antes da otimização.' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='023_receivable_sync')
  OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='024_receivable_received_import') THEN
  RAISE EXCEPTION 'Ative as atualizações 023 e 024 de recebíveis antes da otimização.' USING ERRCODE='22023';
 END IF;
END $$;
SELECT pg_advisory_xact_lock(2045812301);
SELECT pg_advisory_xact_lock(2045812308);

CREATE OR REPLACE FUNCTION cf_private.resolve_receivable_sync_rows(p_scope text,p_rows jsonb,
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
   AND upper(cf_private.normalize_receivable_text(t.branch))=upper(v_row->>'branch')
   AND upper(cf_private.normalize_receivable_text(t.document))=upper(v_row->>'document')
   AND t.customer_key=v_row->>'customer_key'
   AND cf_private.receivable_sync_group_key(t.branch,t.document,t.customer_key)=v_row->>'group_key';
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'due_date',t.due_date,'amount_cents',t.amount_cents,
   'status',t.status,'collector_id',t.collector_id) ORDER BY t.due_date,t.id),'[]'::jsonb) INTO v_candidates
  FROM (SELECT t.* FROM public.receivable_titles t WHERE t.scope=p_scope
   AND upper(cf_private.normalize_receivable_text(t.branch))=upper(v_row->>'branch')
   AND upper(cf_private.normalize_receivable_text(t.document))=upper(v_row->>'document')
   AND t.customer_key=v_row->>'customer_key'
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
    AND upper(cf_private.normalize_receivable_text(t.branch))=upper(v_row->>'branch')
   AND upper(cf_private.normalize_receivable_text(t.document))=upper(v_row->>'document')
   AND t.customer_key=v_row->>'customer_key'
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

INSERT INTO public.central_schema_migrations(version) VALUES('041_receivable_import_performance') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
