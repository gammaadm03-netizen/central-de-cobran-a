-- CENTRAL FINANCEIRA — baixas sem pagamento e conciliação na importação (042/043).
-- Cole o SQL completo no SQL Editor. Uma falha desfaz toda a ativação.
-- Repetível e independente de recebíveis/e-mail 040/041. Requer CP até 021.
-- Não importa arquivos, não presume pagamentos e não altera títulos existentes.
-- Depois publique a função payables-import e confira a versão correspondente do site.
BEGIN;

-- SOURCE: 042_payable_administrative_writeoff.sql
-- Baixa administrativa explícita, sem pagamento ou movimentação bancária.
-- Repetível; preserva valores nominais, pagamentos e snapshots históricos.
DO $cf_apply_042$
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative primeiro Contas a Pagar até a atualização 021.' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='021_payable_paid_import')
  OR to_regprocedure('cf_private.session_allowed()') IS NULL THEN
  RAISE EXCEPTION 'Ative primeiro Contas a Pagar até a atualização 021.' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='042_payable_administrative_writeoff') THEN
  RAISE NOTICE 'Baixas administrativas 042 já instaladas; histórico preservado.';
  RETURN;
 END IF;
 EXECUTE $cf_source_042$

CREATE TABLE public.payable_administrative_writeoffs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 title_id uuid NOT NULL REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
 event_type text NOT NULL CHECK(event_type IN ('WRITE_OFF','REVERSE')),
 writeoff_id uuid UNIQUE REFERENCES public.payable_administrative_writeoffs(id) ON DELETE RESTRICT,
 source_import_id uuid REFERENCES public.payable_imports(id) ON DELETE RESTRICT,
 title_amount_cents bigint NOT NULL CHECK(title_amount_cents BETWEEN 0 AND 9007199254740991),
 title_snapshot jsonb NOT NULL CHECK(jsonb_typeof(title_snapshot)='object'),
 expected_revision uuid,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000 AND reason=btrim(reason)),
 created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((event_type='WRITE_OFF' AND writeoff_id IS NULL) OR (event_type='REVERSE' AND writeoff_id IS NOT NULL))
);
CREATE INDEX payable_administrative_writeoffs_title ON public.payable_administrative_writeoffs(title_id,created_at DESC,id DESC);
ALTER TABLE public.payable_administrative_writeoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payable_administrative_writeoffs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_administrative_writeoffs TO authenticated;
CREATE POLICY payable_administrative_writeoffs_read ON public.payable_administrative_writeoffs FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_pagar','read') OR cf_private.has_permission('contas_pagar','import'));

CREATE VIEW cf_private.active_payable_administrative_writeoffs AS
 SELECT w.* FROM public.payable_administrative_writeoffs w WHERE w.event_type='WRITE_OFF'
  AND NOT EXISTS(SELECT 1 FROM public.payable_administrative_writeoffs r WHERE r.writeoff_id=w.id AND r.event_type='REVERSE');
REVOKE ALL ON TABLE cf_private.active_payable_administrative_writeoffs FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION cf_private.require_payable_administrative_write_access() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.session_allowed() OR NOT cf_private.has_permission('contas_pagar','read')
  OR NOT cf_private.has_permission('contas_pagar','write') OR NOT cf_private.has_permission('contas_pagar','import') THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION cf_private.guard_payable_administrative_writeoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.payable_titles%ROWTYPE;v_parent public.payable_administrative_writeoffs%ROWTYPE;v_revision uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 PERFORM cf_private.require_payable_administrative_write_access();
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 PERFORM pg_advisory_xact_lock(2045812309);
 SELECT * INTO v_title FROM public.payable_titles WHERE id=NEW.title_id AND scope='grupo-consolidado' FOR UPDATE;
 IF v_title.id IS NULL OR NEW.created_by IS DISTINCT FROM auth.uid() OR NEW.title_amount_cents IS DISTINCT FROM v_title.amount_cents THEN
  RAISE EXCEPTION 'Confira o título e a autoria da baixa administrativa.' USING ERRCODE='22023';
 END IF;
 NEW.title_snapshot:=to_jsonb(v_title);
 IF NEW.source_import_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payable_imports i
  WHERE i.id=NEW.source_import_id AND i.scope=v_title.scope) THEN
  RAISE EXCEPTION 'A referência da importação não pertence a esta operação.' USING ERRCODE='22023';
 END IF;
 SELECT payment_revision INTO v_revision FROM public.payable_financial_titles WHERE id=NEW.title_id;
 IF NEW.expected_revision IS NOT NULL AND NEW.expected_revision IS DISTINCT FROM v_revision THEN
  RAISE EXCEPTION 'O título foi alterado. Confira novamente antes de confirmar a baixa ou reabertura.' USING ERRCODE='40001';
 END IF;
 IF NEW.event_type='WRITE_OFF' THEN
  IF EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=NEW.title_id) THEN
   RAISE EXCEPTION 'Este título já possui baixa administrativa ativa.' USING ERRCODE='22023';
  END IF;
  IF cf_private.payable_closing_exclusion(NEW.title_id) IS NOT NULL THEN
   RAISE EXCEPTION 'Esta versão é somente histórica. Confira o título canônico.' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=NEW.title_id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) THEN
   RAISE EXCEPTION 'Há pagamento ativo neste título. Confira e estorne o pagamento antes de uma baixa administrativa.' USING ERRCODE='P0042';
  END IF;
 ELSE
  SELECT * INTO v_parent FROM cf_private.active_payable_administrative_writeoffs WHERE id=NEW.writeoff_id AND title_id=NEW.title_id;
  IF v_parent.id IS NULL THEN
   RAISE EXCEPTION 'A baixa administrativa já foi reaberta ou não pertence a este título.' USING ERRCODE='40001';
  END IF;
  NEW.created_at:=greatest(NEW.created_at,v_parent.created_at+interval '1 microsecond');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payable_administrative_writeoff_guard BEFORE INSERT ON public.payable_administrative_writeoffs
 FOR EACH ROW EXECUTE FUNCTION cf_private.guard_payable_administrative_writeoff();
CREATE TRIGGER payable_administrative_writeoff_immutable BEFORE UPDATE OR DELETE ON public.payable_administrative_writeoffs
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_closing_history();

CREATE FUNCTION cf_private.audit_payable_administrative_writeoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_actor public.profiles%ROWTYPE;BEGIN
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
  VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar','payable_administrative_writeoffs',NEW.id::text,
   CASE WHEN NEW.event_type='REVERSE' THEN 'REOPEN' ELSE 'UPDATE' END,to_jsonb(NEW));
 PERFORM cf_private.invalidate_payable_review(NEW.title_id,
  CASE WHEN NEW.event_type='REVERSE' THEN 'Baixa administrativa reaberta explicitamente.' ELSE 'Baixa administrativa confirmada sem pagamento.' END);
 RETURN NEW;
END $$;
CREATE TRIGGER payable_administrative_writeoff_audit AFTER INSERT ON public.payable_administrative_writeoffs
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_administrative_writeoff();

CREATE FUNCTION cf_private.record_payable_administrative_writeoff(p_title_id uuid,p_source_import_id uuid,p_reason text,p_expected_revision uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_id uuid;v_amount bigint;BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 PERFORM cf_private.require_payable_administrative_write_access();
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 PERFORM pg_advisory_xact_lock(2045812309);
 IF p_title_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Confirme individualmente o título e informe o motivo da baixa sem pagamento.' USING ERRCODE='22023';
 END IF;
 SELECT amount_cents INTO v_amount FROM public.payable_titles WHERE id=p_title_id AND scope='grupo-consolidado' FOR UPDATE;
 IF v_amount IS NULL THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='22023';END IF;
 INSERT INTO public.payable_administrative_writeoffs(title_id,event_type,source_import_id,title_amount_cents,expected_revision,reason,created_by)
  VALUES(p_title_id,'WRITE_OFF',p_source_import_id,v_amount,p_expected_revision,btrim(p_reason),auth.uid()) RETURNING id INTO v_id;
 RETURN jsonb_build_object('event_id',v_id,'title_id',p_title_id,'action','WRITE_OFF','writeoff_id',v_id,'source_import_id',p_source_import_id,'reason',btrim(p_reason));
END $$;

CREATE FUNCTION cf_private.reverse_payable_administrative_writeoff(p_title_id uuid,p_reason text,p_expected_revision uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;v_writeoff public.payable_administrative_writeoffs%ROWTYPE;v_amount bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 PERFORM cf_private.require_payable_administrative_write_access();
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 PERFORM pg_advisory_xact_lock(2045812309);
 IF p_title_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Informe o título e o motivo da reabertura.' USING ERRCODE='22023';END IF;
 SELECT amount_cents INTO v_amount FROM public.payable_titles WHERE id=p_title_id AND scope='grupo-consolidado' FOR UPDATE;
 SELECT * INTO v_writeoff FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=p_title_id;
 IF v_writeoff.id IS NULL THEN RAISE EXCEPTION 'Este título não possui baixa administrativa ativa.' USING ERRCODE='22023';END IF;
 INSERT INTO public.payable_administrative_writeoffs(title_id,event_type,writeoff_id,source_import_id,title_amount_cents,expected_revision,reason,created_by)
  VALUES(p_title_id,'REVERSE',v_writeoff.id,v_writeoff.source_import_id,v_amount,p_expected_revision,btrim(p_reason),auth.uid()) RETURNING id INTO v_id;
 RETURN jsonb_build_object('event_id',v_id,'title_id',p_title_id,'action','REVERSE','writeoff_id',v_writeoff.id,'source_import_id',v_writeoff.source_import_id,'reason',btrim(p_reason));
END $$;

-- Nenhum escritor antigo pode converter o sentinela em pagamento financeiro ou
-- transformar uma baixa em dívida nova sem uma reabertura expressa e auditada.
CREATE FUNCTION cf_private.guard_payable_administrative_title() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=OLD.id)
  AND ROW(NEW.id,NEW.scope,NEW.branch,NEW.entry_number,NEW.amount_cents) IS DISTINCT FROM ROW(OLD.id,OLD.scope,OLD.branch,OLD.entry_number,OLD.amount_cents) THEN
  RAISE EXCEPTION 'Título baixado administrativamente. Reabra a baixa com motivo antes de alterar valor ou identidade.' USING ERRCODE='P0042';
 END IF;
 IF NEW.amount_cents=1 AND OLD.amount_cents IS DISTINCT FROM NEW.amount_cents
  AND EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=OLD.id
  AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) THEN
  RAISE EXCEPTION 'O valor de R$ 0,01 indica baixa sem pagamento. Confira os pagamentos ativos antes de alterar este título.' USING ERRCODE='P0042';
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER payable_administrative_title_guard BEFORE UPDATE ON public.payable_titles
 FOR EACH ROW EXECUTE FUNCTION cf_private.guard_payable_administrative_title();
CREATE FUNCTION cf_private.guard_payable_administrative_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_amount bigint;BEGIN
 SELECT amount_cents INTO v_amount FROM public.payable_titles WHERE id=NEW.title_id FOR UPDATE;
 IF v_amount=1 OR EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=NEW.title_id) THEN
  RAISE EXCEPTION 'Este título exige baixa administrativa confirmada, sem registrar pagamento. Reabra uma baixa existente antes de registrar valor real.' USING ERRCODE='P0042';
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER payable_administrative_payment_guard BEFORE INSERT ON public.payable_payments
 FOR EACH ROW EXECUTE FUNCTION cf_private.guard_payable_administrative_payment();

-- Recria as views com suas definições congeladas: mesmos nomes, tipos e ordem
-- das colunas existentes. Dados administrativos novos são acrescentados ao fim.
DO $cf_writeoff_views$ DECLARE v_sql text;v_fields text;BEGIN
 v_sql:=regexp_replace(pg_get_viewdef('public.payable_financial_titles'::regclass,true),';[[:space:]]*$','');
 SELECT string_agg(CASE WHEN attname IN ('outstanding_cents','payment_remaining_cents')
    THEN 'CASE WHEN w.id IS NOT NULL THEN 0::bigint ELSE original.'||quote_ident(attname)||' END AS '||quote_ident(attname)
   WHEN attname='financial_status' THEN 'CASE WHEN w.id IS NOT NULL THEN ''ADMIN_WRITEOFF''::text ELSE original.financial_status END AS financial_status'
   ELSE 'original.'||quote_ident(attname) END,',' ORDER BY attnum) INTO v_fields FROM pg_attribute
  WHERE attrelid='public.payable_financial_titles'::regclass AND attnum>0 AND NOT attisdropped;
 EXECUTE 'CREATE OR REPLACE VIEW public.payable_financial_titles WITH(security_invoker=true) AS SELECT '||v_fields||',w.id AS administrative_writeoff_id,w.created_at AS administrative_writeoff_at,w.created_by AS administrative_writeoff_by,w.reason AS administrative_writeoff_reason,w.source_import_id AS administrative_writeoff_import_id FROM ('||v_sql||') original LEFT JOIN LATERAL(SELECT w.* FROM public.payable_administrative_writeoffs w WHERE w.title_id=original.id AND w.event_type=''WRITE_OFF'' AND NOT EXISTS(SELECT 1 FROM public.payable_administrative_writeoffs r WHERE r.writeoff_id=w.id AND r.event_type=''REVERSE'')) w ON true';
 v_sql:=regexp_replace(pg_get_viewdef('public.payable_review_titles'::regclass,true),';[[:space:]]*$','');
 -- Metadados anexados não alteram a impressão de um título comum: remover as
 -- cinco chaves novas preserva exatamente o JSON pré-042, inclusive os NULL.
 -- Uma baixa/reabertura real já altera o control_revision e o saldo/status.
 IF position('to_jsonb(f.*)' IN v_sql)=0 THEN
  RAISE EXCEPTION 'A visão de conferência possui estrutura diferente da versão019. Nenhum dado foi alterado.' USING ERRCODE='22023';
 END IF;
 v_sql:=replace(v_sql,'to_jsonb(f.*)',
  '(to_jsonb(f.*)-ARRAY[''administrative_writeoff_id'',''administrative_writeoff_at'',''administrative_writeoff_by'',''administrative_writeoff_reason'',''administrative_writeoff_import_id'']::text[])');
 SELECT string_agg(CASE WHEN attname='review_status' THEN 'CASE WHEN w.id IS NOT NULL THEN ''BAIXADO_ADMINISTRATIVAMENTE''::text ELSE original.review_status END AS review_status'
   WHEN attname='closing_eligible' THEN '(w.id IS NULL AND original.closing_eligible) AS closing_eligible'
   WHEN attname='closing_exclusion_reason' THEN 'CASE WHEN w.id IS NOT NULL THEN ''ADMIN_WRITEOFF''::text ELSE original.closing_exclusion_reason END AS closing_exclusion_reason'
   ELSE 'original.'||quote_ident(attname) END,',' ORDER BY attnum) INTO v_fields FROM pg_attribute
  WHERE attrelid='public.payable_review_titles'::regclass AND attnum>0 AND NOT attisdropped;
 EXECUTE 'CREATE OR REPLACE VIEW public.payable_review_titles WITH(security_invoker=true) AS SELECT '||v_fields||',w.id AS administrative_writeoff_id,w.created_at AS administrative_writeoff_at,w.created_by AS administrative_writeoff_by,w.reason AS administrative_writeoff_reason,w.source_import_id AS administrative_writeoff_import_id FROM ('||v_sql||') original LEFT JOIN LATERAL(SELECT w.* FROM public.payable_administrative_writeoffs w WHERE w.title_id=original.id AND w.event_type=''WRITE_OFF'' AND NOT EXISTS(SELECT 1 FROM public.payable_administrative_writeoffs r WHERE r.writeoff_id=w.id AND r.event_type=''REVERSE'')) w ON true';
END $cf_writeoff_views$;

CREATE OR REPLACE FUNCTION cf_private.payable_closing_exclusion(p_title_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=p_title_id) THEN RETURN 'ADMIN_WRITEOFF';END IF;
 IF EXISTS(SELECT 1 FROM public.payable_titles t JOIN cf_private.payable_identity_registry i
  ON i.scope=t.scope AND i.business_key=cf_private.payable_business_key(t.branch,t.entry_number)
  WHERE t.id=p_title_id AND t.status='SETTLED_IMPORT' AND i.title_id<>t.id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=t.id
    AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id))) THEN
  RETURN 'Versão anterior preservada no histórico; a identidade canônica está vinculada a outro título.';
 END IF;RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION cf_private.payable_forecast_provision(p_rule_key text,p_month date,p_imported boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_rule public.payable_forecast_rules%ROWTYPE;v_done public.payable_forecast_completions%ROWTYPE;
 v_due date;v_actual numeric:=0;v_remaining numeric;v_issues jsonb:='[]'::jsonb;
BEGIN
  SELECT * INTO v_rule FROM public.payable_forecast_rules r WHERE r.rule_key=p_rule_key
    AND r.effective_from<=p_month+(r.day_of_month-1)
    ORDER BY r.effective_from DESC,r.created_at DESC,r.id DESC LIMIT 1;
  IF v_rule.id IS NULL THEN RETURN NULL; END IF;
  v_due:=p_month+(v_rule.day_of_month-1);
  SELECT * INTO v_done FROM public.payable_forecast_completions WHERE rule_key=p_rule_key AND month=p_month ORDER BY created_at DESC,id DESC LIMIT 1;
  IF NOT p_imported THEN v_issues:=v_issues||jsonb_build_array('Importe o relatório completo de Contas a Pagar.'); END IF;
  -- Um plano de salários/adiantamento não vinculado deixa as duas previsões desse
  -- macro pendentes; não adivinhamos quais títulos pertencem aos sócios.
  IF EXISTS(SELECT 1 FROM (SELECT raw.* FROM public.payable_titles raw WHERE NOT EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs w WHERE w.title_id=raw.id)) t LEFT JOIN LATERAL(
      SELECT b.id FROM public.payable_forecast_plan_bindings b WHERE b.plan=t.plan AND b.effective_from<=v_due
        ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON true
    WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.macro=v_rule.macro AND b.id IS NULL) THEN
    v_issues:=v_issues||jsonb_build_array('Vincule os planos deste macro à previsão correta ou a nenhuma previsão.');
  END IF;
  IF EXISTS(SELECT 1 FROM (SELECT raw.* FROM public.payable_titles raw WHERE NOT EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs w WHERE w.title_id=raw.id)) t JOIN LATERAL(
      SELECT b.rule_key FROM public.payable_forecast_plan_bindings b WHERE b.plan=t.plan AND b.effective_from<=v_due
        ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON b.rule_key=p_rule_key
    WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.macro<>v_rule.macro) THEN
    v_issues:=v_issues||jsonb_build_array('O macro do título mudou; revise o vínculo da previsão.');
  END IF;
  -- Inclui pagamentos reais e quitações históricas; baixas administrativas não compõem realizado, estimativa, pendências de vínculo ou ambiguidades.
  SELECT coalesce(sum(t.amount_cents),0) INTO v_actual FROM (SELECT raw.* FROM public.payable_titles raw WHERE NOT EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs w WHERE w.title_id=raw.id)) t JOIN LATERAL(
    SELECT b.rule_key FROM public.payable_forecast_plan_bindings b WHERE b.plan=t.plan AND b.effective_from<=v_due
      ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON b.rule_key=p_rule_key
    WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.macro=v_rule.macro;
  IF v_actual>9007199254740991 THEN RAISE EXCEPTION 'O realizado mensal excede o limite de precisão.' USING ERRCODE='22003'; END IF;
  IF EXISTS(SELECT 1 FROM (SELECT raw.* FROM public.payable_titles raw WHERE NOT EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs w WHERE w.title_id=raw.id)) t WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date
      AND EXISTS(SELECT 1 FROM (SELECT raw.* FROM public.payable_titles raw WHERE NOT EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs w WHERE w.title_id=raw.id)) selected JOIN LATERAL(
        SELECT b.rule_key FROM public.payable_forecast_plan_bindings b WHERE b.plan=selected.plan AND b.effective_from<=v_due
          ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON b.rule_key=p_rule_key
        WHERE selected.branch=t.branch AND selected.entry_number=t.entry_number
          AND selected.due_date>=p_month AND selected.due_date<(p_month+interval '1 month')::date)
      GROUP BY t.branch,t.entry_number HAVING count(DISTINCT t.source_key)>1) THEN
    v_issues:=v_issues||jsonb_build_array('Há versões ou parcelas do mesmo lançamento no mês. Confira e conclua o ciclo quando não houver previsão restante.');
  END IF;
  IF p_imported THEN
    IF coalesce(v_done.done,false) THEN v_remaining:=0;
    ELSIF jsonb_array_length(v_issues)=0 THEN v_remaining:=greatest(v_rule.amount_cents::numeric-v_actual,0); END IF;
  END IF;
  RETURN jsonb_build_object('rule_key',p_rule_key,'rule_id',v_rule.id,'label',v_rule.label,'macro',v_rule.macro,
    'month',p_month,'due_date',v_due,'expected_cents',v_rule.amount_cents,'actual_cents',CASE WHEN p_imported AND jsonb_array_length(v_issues)=0 THEN v_actual ELSE NULL END,
    'remaining_cents',v_remaining,'completion_id',v_done.id,'done',coalesce(v_done.done,false),'issues',v_issues);
END $$;


REVOKE ALL ON FUNCTION cf_private.require_payable_administrative_write_access(),
 cf_private.guard_payable_administrative_writeoff(),cf_private.audit_payable_administrative_writeoff(),
 cf_private.record_payable_administrative_writeoff(uuid,uuid,text,uuid),
 cf_private.reverse_payable_administrative_writeoff(uuid,text,uuid),
 cf_private.guard_payable_administrative_title(),cf_private.guard_payable_administrative_payment()
 FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.payable_administrative_writeoffs IS 'Histórico imutável de baixas administrativas e reaberturas. Não constitui pagamento, não movimenta caixa, não muda o valor nominal original.';
INSERT INTO public.central_schema_migrations(version) VALUES('042_payable_administrative_writeoff');
NOTIFY pgrst,'reload schema';

 $cf_source_042$;
END $cf_apply_042$;

-- SOURCE: 043_payable_import_reconciliation.sql
-- Conciliação explícita dentro da confirmação da importação de CP.
-- Ausência em relatório completo exige decisão; centavos nunca viram pagamentos.
DO $cf_apply_043$
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL OR to_regclass('cf_private.active_payable_administrative_writeoffs') IS NULL THEN
  RAISE EXCEPTION 'Ative a atualização 042 antes da conciliação na importação.' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='043_payable_import_reconciliation') THEN
  RAISE NOTICE 'Conciliação na importação 043 já instalada; histórico preservado.';
  RETURN;
 END IF;
 EXECUTE $cf_source_043$
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL
  OR to_regclass('cf_private.active_payable_administrative_writeoffs') IS NULL THEN
  RAISE EXCEPTION 'Ative a atualização 042 antes da conciliação na importação.' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='042_payable_administrative_writeoff') THEN
  RAISE EXCEPTION 'Ative a atualização 042 antes da conciliação na importação.' USING ERRCODE='22023';END IF;
END $$;
SELECT pg_advisory_xact_lock(2045812301);
SELECT pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
SELECT pg_advisory_xact_lock(2045812309);

CREATE TABLE cf_private.payable_import_resolution_requests(
 actor_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL,
 scope text NOT NULL CHECK(scope='grupo-consolidado'),mode text NOT NULL CHECK(mode IN ('forecast','payments')),
 file_sha256 text NOT NULL CHECK(file_sha256~'^[a-f0-9]{64}$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id)
);
ALTER TABLE cf_private.payable_import_resolution_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.payable_import_resolution_requests FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER payable_import_resolutions_immutable BEFORE UPDATE OR DELETE ON cf_private.payable_import_resolution_requests
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_closing_history();
CREATE FUNCTION cf_private.audit_payable_import_resolution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
 SELECT id,username,role_key,'contas_pagar','payable_import_resolution',NEW.request_id::text,'IMPORT',
  jsonb_build_object('scope',NEW.scope,'mode',NEW.mode,'file_sha256',NEW.file_sha256,'request_id',NEW.request_id,
   'payload_sha256',encode(sha256(convert_to(NEW.payload::text,'UTF8')),'hex'),'result',NEW.result)
 FROM public.profiles WHERE id=auth.uid();RETURN NEW;
END $$;
CREATE TRIGGER payable_import_resolution_audit AFTER INSERT ON cf_private.payable_import_resolution_requests
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_import_resolution();

CREATE FUNCTION cf_private.require_payable_import_reconciliation_actor(p_user_id uuid,p_session_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_session_id!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'session_id',p_session_id,'role','authenticated')::text,true);
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')
  AND cf_private.has_permission('contas_pagar','import') AND cf_private.has_permission('importar_bases','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 PERFORM pg_advisory_xact_lock(2045812309);
END $$;
CREATE FUNCTION cf_private.validate_payable_reconciliation_file(p_file_name text,p_file_sha256 text,p_file_base64 text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$ DECLARE v_file bytea;BEGIN
 IF p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 250 OR p_file_name~'[/\\[:cntrl:]]'
  OR p_file_sha256 IS NULL OR p_file_sha256!~'^[a-f0-9]{64}$' OR p_file_base64 IS NULL OR length(p_file_base64) NOT BETWEEN 1 AND 2796204 THEN
  RAISE EXCEPTION 'Metadados do arquivo inválidos.' USING ERRCODE='22023';END IF;
 BEGIN v_file:=decode(p_file_base64,'base64');EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
  RAISE EXCEPTION 'Arquivo original inválido.' USING ERRCODE='22023';END;
 IF octet_length(v_file) NOT BETWEEN 1 AND 2097152 OR encode(sha256(v_file),'hex')<>p_file_sha256 THEN
  RAISE EXCEPTION 'A integridade do arquivo original não foi confirmada.' USING ERRCODE='22023';END IF;RETURN v_file;
END $$;
CREATE FUNCTION cf_private.validate_payable_import_resolution_choices(p_choices jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_key text;v_choice jsonb;v_action text;v_date date;BEGIN
 IF p_choices IS NULL OR jsonb_typeof(p_choices)<>'object' OR octet_length(p_choices::text)>6000000
  OR (SELECT count(*) FROM jsonb_object_keys(p_choices))>10000 THEN
  RAISE EXCEPTION 'Informe as decisões individuais desta importação.' USING ERRCODE='22023';END IF;
 FOR v_key,v_choice IN SELECT key,value FROM jsonb_each(p_choices) LOOP
  IF v_key!~'^(row:[1-9][0-9]{0,3}|title:[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$'
   OR (v_key LIKE 'row:%' AND substring(v_key FROM 5)::integer>5000) OR jsonb_typeof(v_choice)<>'object' THEN
   RAISE EXCEPTION 'Identificação de decisão inválida.' USING ERRCODE='22023';END IF;
  v_action:=v_choice->>'action';
  IF v_action IS NULL OR v_action NOT IN ('PAID','WRITE_OFF','REOPEN') OR jsonb_typeof(v_choice->'reason') IS DISTINCT FROM 'string'
   OR length(btrim(v_choice->>'reason')) NOT BETWEEN 1 AND 1000 OR v_choice->>'reason'~'[[:cntrl:]]'
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_choice) k WHERE k NOT IN ('action','reason','paid_on','amount_paid_cents','bank_account_id'))
   OR (v_action<>'PAID' AND (v_choice ? 'paid_on' OR v_choice ? 'amount_paid_cents' OR v_choice ? 'bank_account_id')) THEN
   RAISE EXCEPTION 'Confirme a ação e o motivo individual; pagamento exige dados reais.' USING ERRCODE='22023';END IF;
  IF v_action='PAID' THEN
   IF jsonb_typeof(v_choice->'paid_on') IS DISTINCT FROM 'string' OR v_choice->>'paid_on'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR jsonb_typeof(v_choice->'amount_paid_cents') IS DISTINCT FROM 'number'
    OR (v_choice->>'amount_paid_cents')::numeric<>trunc((v_choice->>'amount_paid_cents')::numeric)
    OR (v_choice->>'amount_paid_cents')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR coalesce(v_choice->>'bank_account_id','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN
    RAISE EXCEPTION 'Informe valor integral, data e banco efetivos; um centavo exige baixa sem pagamento.' USING ERRCODE='22023';END IF;
   BEGIN v_date:=(v_choice->>'paid_on')::date;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Data efetiva de pagamento inválida.' USING ERRCODE='22023';END;
   IF v_date<DATE '1900-01-01' OR v_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR NOT EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=(v_choice->>'bank_account_id')::uuid AND enabled) THEN
    RAISE EXCEPTION 'Informe data real até hoje e conta oficial ativa.' USING ERRCODE='22023';END IF;
  END IF;
 END LOOP;RETURN p_choices;
END $$;
CREATE FUNCTION cf_private.payable_import_resolution_bank_options() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'display_name',display_name,'company',company,'bank',bank,'account_type',account_type) ORDER BY display_name,id),'[]') FROM public.bank_accounts WHERE enabled;
$$;
CREATE FUNCTION cf_private.payable_import_resolution_replay(p_request_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_record cf_private.payable_import_resolution_requests%ROWTYPE;BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Informe o protocolo da confirmação.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_record FROM cf_private.payable_import_resolution_requests WHERE actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN
  IF v_record.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'Protocolo já usado com outros dados.' USING ERRCODE='22023';END IF;
  RETURN v_record.result||jsonb_build_object('idempotent',true);
 END IF;RETURN NULL;
END $$;
CREATE FUNCTION cf_private.record_payable_import_resolution(p_request_id uuid,p_payload jsonb,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 INSERT INTO cf_private.payable_import_resolution_requests(actor_id,request_id,scope,mode,file_sha256,payload,result)
 VALUES(auth.uid(),p_request_id,p_payload->>'scope',p_payload->>'mode',p_payload->>'file_sha256',p_payload,p_result);RETURN p_result;
END $$;

CREATE FUNCTION cf_private.review_payable_import_resolution_items(p_items jsonb,p_choices jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$ DECLARE v_item jsonb;v_choice jsonb;v_problem text;v_action text;v_items jsonb:='[]';v_errors jsonb:='[]';v_key text;BEGIN
 PERFORM cf_private.validate_payable_import_resolution_choices(p_choices);
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  v_problem:=NULL;v_choice:=p_choices->(v_item->>'key');v_action:=v_choice->>'action';
  IF coalesce((v_item->>'requires_resolution')::boolean,false) THEN
   IF v_choice IS NULL THEN v_problem:='Confirme individualmente a conciliação deste título.';
   ELSIF NOT (v_item->'allowed_actions') ? v_action THEN v_problem:='A ação escolhida não é permitida para este título.';
   ELSIF v_action='PAID' AND (v_choice->>'amount_paid_cents')::numeric<>(v_item->>'payment_remaining_cents')::numeric THEN
    v_problem:='O valor pago deve quitar exatamente o saldo atual; corrija a origem se houver divergência.';
   END IF;
  ELSIF v_choice IS NOT NULL AND NOT(coalesce((v_item->>'already_written_off')::boolean,false) AND v_action='WRITE_OFF') THEN
   v_problem:='Este título não exige essa decisão nesta análise.';
  END IF;
  IF v_item->>'problem' IS NOT NULL THEN v_problem:=v_item->>'problem';END IF;
  v_items:=v_items||jsonb_build_array(v_item||jsonb_build_object('selected_action',CASE WHEN v_choice IS NOT NULL THEN v_action END,'problem',v_problem));
  IF v_problem IS NOT NULL THEN v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',coalesce((v_item->>'line')::integer,0),'column','Conciliação da importação','problem',v_problem,'correction','Confira os dados e as escolhas individuais e analise novamente.'));END IF;
 END LOOP;
 FOR v_key IN SELECT jsonb_object_keys(p_choices) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) r WHERE r->>'key'=v_key) THEN
   v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',0,'column','Conciliação da importação','problem','Uma escolha não pertence aos títulos desta análise.','correction','Atualize a análise e refaça somente as escolhas apresentadas.'));
  END IF;
 END LOOP;
 RETURN jsonb_build_object('reconciliation_items',v_items,'resolution_errors',v_errors,'can_commit',jsonb_array_length(v_errors)=0);
END $$;

-- O núcleo anterior permanece privado. As rotas antigas não podem contornar
-- a confirmação de centavos nem declarar relatório completo sem suas decisões.
ALTER FUNCTION cf_private.commit_payables_forecast_import(text,text,text,text,jsonb,jsonb,uuid) RENAME TO commit_payables_forecast_import_v1_core;
CREATE OR REPLACE FUNCTION cf_private.commit_payables_forecast_import_v1_core(
 p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_mappings jsonb,
 p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rows jsonb; v_previous uuid; v_id uuid:=gen_random_uuid(); v_new integer; v_open integer; v_settled integer;
  v_changed integer; v_file bytea; v_mappings jsonb:='{}'::jsonb; v_mapping record; v_plan text;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  v_rows:=cf_private.validate_payable_identity_rows(p_scope,p_rows);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE upper(btrim(coalesce(r->>'source_status',''))) IN ('PAGO','PAGA','PAGOS','QUITADO','QUITADA','CANCELADO','CANCELADA','ESTORNADO','ESTORNADA')) THEN RAISE EXCEPTION 'Use o modo de pagamentos para títulos pagos; previsão aceita somente obrigações em aberto e cheques.' USING ERRCODE='22023';END IF;
  IF p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 250
     OR p_file_name ~ '[/\\[:cntrl:]]' OR p_file_sha256 IS NULL OR p_file_sha256 !~ '^[a-f0-9]{64}$'
     OR p_file_base64 IS NULL OR length(p_file_base64) NOT BETWEEN 1 AND 2796204 THEN
    RAISE EXCEPTION 'Metadados do arquivo inválidos.' USING ERRCODE='22023';
  END IF;
  BEGIN
    v_file:=decode(p_file_base64,'base64');
  EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'O arquivo original está inválido.' USING ERRCODE='22023';
  END;
  IF octet_length(v_file) NOT BETWEEN 1 AND 2097152 OR encode(sha256(v_file),'hex')<>p_file_sha256 THEN
    RAISE EXCEPTION 'A integridade do arquivo original não foi confirmada.' USING ERRCODE='22023';
  END IF;
  IF p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'object' OR octet_length(p_mappings::text)>2000000 THEN
    RAISE EXCEPTION 'Informe as classificações dos planos.' USING ERRCODE='22023';
  END IF;
  FOR v_mapping IN SELECT key,value FROM jsonb_each(p_mappings) LOOP
    v_plan:=cf_private.normalize_payable_plan(v_mapping.key);
    IF length(v_plan) NOT BETWEEN 1 AND 300 OR length(v_mapping.key)>300
       OR jsonb_typeof(v_mapping.value)<>'string' OR NOT EXISTS(
         SELECT 1 FROM public.payable_macros WHERE name=v_mapping.value#>>'{}') THEN
      RAISE EXCEPTION 'Classificação de plano inválida.' USING ERRCODE='22023';
    END IF;
    IF v_mappings ? v_plan THEN
      RAISE EXCEPTION 'O mesmo plano possui classificações duplicadas.' USING ERRCODE='22023';
    END IF;
    v_mappings:=v_mappings||jsonb_build_object(v_plan,v_mapping.value#>>'{}');
  END LOOP;
  -- Um lock serializa cada relatório integral. O token de prévia impede baixa
  -- sobre uma posição diferente da que o operador revisou.
  PERFORM pg_advisory_xact_lock(2045812305,hashtext(p_scope));
  SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous IS DISTINCT FROM p_previous_import_id THEN
    RAISE EXCEPTION 'A base foi atualizada por outra importação. Gere uma nova prévia.' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM public.payable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256 AND import_mode='FORECAST') THEN
    RAISE EXCEPTION 'Este arquivo já foi importado neste escopo.' USING ERRCODE='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r
    LEFT JOIN public.payable_plan_mappings m ON m.plan=r->>'plan'
    WHERE NOT (v_mappings ? (r->>'plan')) AND m.plan IS NULL) THEN
    RAISE EXCEPTION 'Existem planos NÃO CLASSIFICADOS. Classifique todos antes de concluir.' USING ERRCODE='23514';
  END IF;
  -- Não permite usar uma importação para alterar silenciosamente planos ausentes.
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_mappings) k
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'plan'=k)) THEN
    RAISE EXCEPTION 'A classificação deve pertencer a um plano deste relatório.' USING ERRCODE='22023';
  END IF;
  -- O mesmo lock usado pelos pagamentos serializa a importação e a conciliação.
  -- As linhas financeiras permanecem vinculadas ao UUID; a fonte não as reescreve.
  PERFORM 1 FROM public.payable_titles t WHERE t.scope=p_scope AND
    (t.status<>'SETTLED_IMPORT' OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r
      WHERE r->>'source_key'=cf_private.payable_business_key(t.branch,t.entry_number)))
    ORDER BY t.id FOR UPDATE;
  v_rows:=cf_private.resolve_payable_identity_rows(p_scope,v_rows);
  SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL),count(*) FILTER(WHERE r->>'title_id' IS NOT NULL),
    count(*) FILTER(WHERE coalesce((r->>'changed')::boolean,false)) INTO v_new,v_open,v_changed
    FROM jsonb_array_elements(v_rows) r;
  v_settled:=0;
  INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode)
    VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),v_new,v_open,v_settled,'FORECAST');
  INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
  INSERT INTO public.payable_plan_mappings(plan,macro)
    SELECT key,value#>>'{}' FROM jsonb_each(v_mappings)
    ON CONFLICT(plan) DO UPDATE SET macro=EXCLUDED.macro,updated_at=clock_timestamp()
      WHERE payable_plan_mappings.macro IS DISTINCT FROM EXCLUDED.macro;
  -- Atualiza a identidade existente, inclusive vencimento/valor/conta de origem.
  -- first_import_id e UUID não mudam; o trigger anterior guarda antes/depois.
  -- Um centavo confirma uma baixa: preserva o valor nominal já cadastrado.
  UPDATE public.payable_titles t SET
      source_key=r.source_key,entry_number=r.entry_number,description=r.description,due_date=r.due_date,
      amount_cents=r.amount_cents,source_status=r.source_status,plan=r.plan,
      bank_account=r.bank_account,branch=r.branch,issued_on=r.issued_on,macro=m.macro,
      status='OPEN',last_import_id=v_id,settled_at=NULL,cheque_number=CASE WHEN r.cheque_present THEN r.cheque_number ELSE t.cheque_number END
    FROM jsonb_to_recordset((SELECT jsonb_agg(item||jsonb_build_object('cheque_present',item ? 'cheque_number')) FROM jsonb_array_elements(v_rows) item)) AS r(title_id uuid,source_key text,entry_number text,description text,due_date date,
      amount_cents bigint,source_status text,plan text,bank_account text,branch text,issued_on date,cheque_number text,cheque_present boolean)
    JOIN public.payable_plan_mappings m ON m.plan=r.plan WHERE t.id=r.title_id AND t.scope=p_scope AND r.amount_cents<>1 AND NOT EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs w WHERE w.title_id=t.id);
  INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,source_status,
    plan,bank_account,branch,issued_on,macro,status,first_import_id,last_import_id,settled_at,cheque_number)
    SELECT p_scope,r.source_key,r.entry_number,r.description,r.due_date,r.amount_cents,r.source_status,
      r.plan,r.bank_account,r.branch,r.issued_on,m.macro,'NEW',v_id,v_id,NULL,r.cheque_number
    FROM jsonb_to_recordset(v_rows) AS r(title_id uuid,source_key text,entry_number text,description text,due_date date,
      amount_cents bigint,source_status text,plan text,bank_account text,branch text,issued_on date,cheque_number text)
    JOIN public.payable_plan_mappings m ON m.plan=r.plan WHERE r.title_id IS NULL;
  INSERT INTO cf_private.payable_identity_registry(scope,business_key,title_id,created_by)
    SELECT p_scope,r->>'source_key',t.id,auth.uid() FROM jsonb_array_elements(v_rows) r
    JOIN public.payable_titles t ON t.scope=p_scope AND t.source_key=r->>'source_key'
    WHERE NOT EXISTS(SELECT 1 FROM cf_private.payable_identity_registry i
      WHERE i.scope=p_scope AND i.business_key=r->>'source_key');
  RETURN jsonb_build_object('mode','forecast','import_id',v_id,'new_count',v_new,'open_count',v_open,
    'settled_count',v_settled,'changed_count',v_changed,'row_count',jsonb_array_length(v_rows));
END;
$$;

CREATE FUNCTION cf_private.commit_payables_forecast_import(p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_mappings jsonb,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 RAISE EXCEPTION 'Atualize a função de importação para confirmar a conciliação na versão 043.' USING ERRCODE='P0043';
END $$;

CREATE FUNCTION public.preview_payables_forecast_import_v2(p_scope text,p_rows jsonb,p_full_report boolean,p_resolution_choices jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_row jsonb;v_title public.payable_review_titles%ROWTYPE;v_items jsonb:='[]';v_item jsonb;v_review jsonb;v_previous uuid;
 v_line integer;v_count integer;v_new integer;v_changed integer;v_written boolean;v_keys jsonb;v_allowed jsonb;BEGIN
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write') AND cf_private.has_permission('contas_pagar','import') AND cf_private.has_permission('importar_bases','read')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_full_report IS NULL THEN RAISE EXCEPTION 'Declare relatório completo ou novos títulos.' USING ERRCODE='22023';END IF;
 PERFORM cf_private.validate_payable_import_resolution_choices(p_resolution_choices);
 v_rows:=cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,p_rows));
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE upper(btrim(coalesce(r->>'source_status',''))) IN ('PAGO','PAGA','PAGOS','QUITADO','QUITADA','CANCELADO','CANCELADA','ESTORNADO','ESTORNADA')) THEN
  RAISE EXCEPTION 'Use o relatório de pagamentos para títulos quitados.' USING ERRCODE='22023';END IF;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL),count(*) FILTER(WHERE coalesce((r->>'changed')::boolean,false) AND NOT ((r->>'amount_cents')::bigint=1 AND EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs w WHERE w.title_id=(r->>'title_id')::uuid))) INTO v_new,v_changed FROM jsonb_array_elements(v_rows) r;
 FOR v_row,v_line IN SELECT value,ordinality::integer FROM jsonb_array_elements(v_rows) WITH ORDINALITY LOOP
  v_title:=NULL;v_written:=false;
  IF v_row->>'title_id' IS NOT NULL THEN
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_row->>'title_id')::uuid;
   v_written:=EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=v_title.id);
  END IF;
  IF (v_row->>'amount_cents')::bigint=1 THEN
   v_item:=jsonb_build_object('key','row:'||v_line,'kind','CENT','line',v_line,'title_id',v_title.id,'branch',v_row->>'branch','entry_number',v_row->>'entry_number',
    'description',v_row->>'description','due_date',v_row->>'due_date','amount_cents',coalesce(v_title.amount_cents,1),'source_amount_cents',1,'payment_remaining_cents',CASE WHEN v_written THEN 0 ELSE 1 END,'allowed_actions','["WRITE_OFF"]'::jsonb,
    'requires_resolution',true,'already_written_off',v_written,'problem',CASE WHEN coalesce(v_title.paid_cents,0)>0 THEN 'Há pagamento ativo para este título. Confira e estorne somente mediante comprovante antes da baixa sem pagamento.' END);
   v_items:=v_items||jsonb_build_array(v_item);
  ELSIF v_written THEN
   v_items:=v_items||jsonb_build_array(jsonb_build_object('key','title:'||v_title.id,'kind','REAPPEARED','line',v_line,'title_id',v_title.id,'branch',v_row->>'branch','entry_number',v_row->>'entry_number',
    'description',v_row->>'description','due_date',v_row->>'due_date','amount_cents',(v_row->>'amount_cents')::bigint,'payment_remaining_cents',(v_row->>'amount_cents')::bigint,
    'allowed_actions','["REOPEN"]'::jsonb,'requires_resolution',true,'problem',NULL));
  END IF;
 END LOOP;
 IF p_full_report THEN
  SELECT count(*) INTO v_count FROM public.payable_review_titles t WHERE t.scope=p_scope AND t.closing_eligible AND t.payment_remaining_cents>0
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'source_key'=cf_private.payable_business_key(t.branch,t.entry_number));
  IF v_count>5000 THEN RAISE EXCEPTION 'Mais de 5.000 títulos ausentes exigem conferência; nenhum título foi omitido. Confira o relatório completo da origem.' USING ERRCODE='22023';END IF;
  FOR v_title IN SELECT t.* FROM public.payable_review_titles t WHERE t.scope=p_scope AND t.closing_eligible AND t.payment_remaining_cents>0
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'source_key'=cf_private.payable_business_key(t.branch,t.entry_number)) ORDER BY t.branch,t.entry_number,t.id LOOP
   v_allowed:=CASE WHEN v_title.amount_cents=1 THEN '["WRITE_OFF"]'::jsonb WHEN v_title.paid_cents>0 THEN '["PAID"]'::jsonb ELSE '["PAID","WRITE_OFF"]'::jsonb END;
   v_items:=v_items||jsonb_build_array(jsonb_build_object('key','title:'||v_title.id,'kind','MISSING','line',NULL,'title_id',v_title.id,'branch',v_title.branch,'entry_number',v_title.entry_number,
    'description',v_title.description,'due_date',v_title.due_date,'amount_cents',v_title.amount_cents,'payment_remaining_cents',v_title.payment_remaining_cents,'allowed_actions',v_allowed,'requires_resolution',true,'problem',NULL));
  END LOOP;
 END IF;
 v_review:=cf_private.review_payable_import_resolution_items(v_items,p_resolution_choices);
 RETURN jsonb_build_object('mode','forecast','previous_import_id',v_previous,'row_count',jsonb_array_length(v_rows),'new_count',v_new,'open_count',jsonb_array_length(v_rows)-v_new,
  'changed_count',v_changed,'settled_count',0,'reconciliation_version','043','financial_revision',public.get_payables_revision()->>'financial_revision','full_report',p_full_report,
  'bank_accounts',cf_private.payable_import_resolution_bank_options(),'bank_options',cf_private.payable_import_resolution_bank_options())||v_review;
END $$;

CREATE FUNCTION public.commit_payables_forecast_import_v2_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,
 p_file_base64 text,p_rows jsonb,p_mappings jsonb,p_previous_import_id uuid,p_full_report boolean,p_resolution_choices jsonb,p_previous_financial_revision text,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payload jsonb;v_result jsonb;v_replay jsonb;v_preview jsonb;v_item jsonb;v_choice jsonb;v_title public.payable_review_titles%ROWTYPE;
 v_import uuid;v_existing public.payable_imports%ROWTYPE;v_previous uuid;v_row jsonb;v_rows jsonb;v_writeoffs integer:=0;v_payments integer:=0;v_reopened integer:=0;v_payment uuid;v_review uuid;v_mapping record;v_plan text;v_seen jsonb:='{}';BEGIN
 PERFORM cf_private.require_payable_import_reconciliation_actor(p_user_id,p_session_id);
 PERFORM cf_private.validate_payable_reconciliation_file(p_file_name,p_file_sha256,p_file_base64);
 v_payload:=jsonb_build_object('scope',p_scope,'mode','forecast','file_name',p_file_name,'file_sha256',p_file_sha256,'rows',p_rows,'mappings',p_mappings,
  'previous_import_id',p_previous_import_id,'full_report',p_full_report,'resolution_choices',p_resolution_choices,'previous_financial_revision',p_previous_financial_revision);
 v_replay:=cf_private.payable_import_resolution_replay(p_request_id,v_payload);IF v_replay IS NOT NULL THEN RETURN v_replay;END IF;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_previous IS DISTINCT FROM p_previous_import_id OR p_previous_financial_revision IS NULL OR p_previous_financial_revision IS DISTINCT FROM public.get_payables_revision()->>'financial_revision' THEN
  RAISE EXCEPTION 'A base mudou. Analise novamente antes de confirmar a conciliação.' USING ERRCODE='40001';END IF;
 v_preview:=public.preview_payables_forecast_import_v2(p_scope,p_rows,p_full_report,p_resolution_choices);
 IF NOT coalesce((v_preview->>'can_commit')::boolean,false) THEN RAISE EXCEPTION 'Confirme todas as decisões individuais da importação antes de concluir.' USING ERRCODE='P0043';END IF;
 SELECT * INTO v_existing FROM public.payable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256 AND import_mode='FORECAST';
 IF v_existing.id IS NOT NULL THEN
  IF v_existing.row_count<>jsonb_array_length(p_rows) OR NOT EXISTS(SELECT 1 FROM cf_private.payable_import_files f WHERE f.import_id=v_existing.id AND f.file_bytes=decode(p_file_base64,'base64')) THEN
   RAISE EXCEPTION 'A origem já registrada não corresponde integralmente a este envio.' USING ERRCODE='22023';END IF;
  IF p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'object' OR octet_length(p_mappings::text)>2000000 THEN
   RAISE EXCEPTION 'Informe as classificações dos planos.' USING ERRCODE='22023';END IF;
  FOR v_mapping IN SELECT key,value FROM jsonb_each(p_mappings) LOOP
   v_plan:=cf_private.normalize_payable_plan(v_mapping.key);
   IF jsonb_typeof(v_mapping.value)<>'string' OR v_seen ? v_plan OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE cf_private.normalize_payable_plan(r->>'plan')=v_plan) THEN
    RAISE EXCEPTION 'Classificação de plano inválida para este arquivo.' USING ERRCODE='22023';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.payable_plan_mappings m WHERE m.plan=v_plan AND m.macro=v_mapping.value#>>'{}') THEN
    RAISE EXCEPTION 'A classificação escolhida difere da base atual. Exporte uma nova cópia antes de alterar planos; nenhuma escolha foi ignorada.' USING ERRCODE='P0043';END IF;
   v_seen:=v_seen||jsonb_build_object(v_plan,true);
  END LOOP;
 END IF;
 IF v_existing.id IS NOT NULL AND (v_preview->>'changed_count')::integer>0 THEN
  RAISE EXCEPTION 'Este arquivo já foi importado, mas os dados atuais dos títulos mudaram. Exporte uma nova cópia da origem e confira as diferenças; nenhuma versão foi ocultada.' USING ERRCODE='P0043';END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_preview->'reconciliation_items') WHERE value->>'kind'='REAPPEARED' LOOP
  v_choice:=p_resolution_choices->(v_item->>'key');PERFORM cf_private.reverse_payable_administrative_writeoff((v_item->>'title_id')::uuid,v_choice->>'reason',NULL);v_reopened:=v_reopened+1;
 END LOOP;
 IF v_existing.id IS NULL THEN
  v_result:=cf_private.commit_payables_forecast_import_v1_core(p_scope,p_file_name,p_file_sha256,p_file_base64,p_rows,p_mappings,p_previous_import_id);
  v_import:=(v_result->>'import_id')::uuid;
  INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES(v_import,'FORECAST',v_result,auth.uid());
 ELSE v_import:=v_existing.id;v_result:=jsonb_build_object('mode','forecast','import_id',v_import,'row_count',jsonb_array_length(p_rows),'new_count',0,'open_count',jsonb_array_length(p_rows),'changed_count',0,'settled_count',0,'source_already_imported',true);END IF;
 v_rows:=cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,p_rows));
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_preview->'reconciliation_items') LOOP
  v_choice:=p_resolution_choices->(v_item->>'key');
  IF NOT coalesce((v_item->>'requires_resolution')::boolean,false) OR v_item->>'kind'='REAPPEARED' THEN CONTINUE;END IF;
  IF v_item->>'kind'='CENT' THEN
   v_row:=v_rows->((v_item->>'line')::integer-1);SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_row->>'title_id')::uuid;
  ELSE SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_item->>'title_id')::uuid;END IF;
  IF v_title.id IS NULL THEN RAISE EXCEPTION 'O título da conciliação não está disponível.' USING ERRCODE='40001';END IF;
  IF v_choice->>'action'='WRITE_OFF' THEN
   IF NOT EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=v_title.id) THEN
    PERFORM cf_private.record_payable_administrative_writeoff(v_title.id,v_import,v_choice->>'reason',v_title.payment_revision);
   END IF;v_writeoffs:=v_writeoffs+1;
  ELSIF v_choice->>'action'='PAID' THEN
   v_payment:=public.register_payable_payment(v_title.id,(v_choice->>'amount_paid_cents')::bigint,(v_choice->>'paid_on')::date,(v_choice->>'bank_account_id')::uuid,
    v_choice->>'reason',v_title.payment_revision,gen_random_uuid(),v_title.last_import_id);
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
   v_review:=public.review_payable_title(v_title.id,v_choice->>'reason',v_title.review_fingerprint);v_payments:=v_payments+1;
  END IF;
 END LOOP;
 v_result:=v_result||jsonb_build_object('reconciliation_version','043','request_id',p_request_id,'full_report',p_full_report,'writeoff_count',v_writeoffs,
  'reconciled_payment_count',v_payments,'paid_count',v_payments,'written_off_count',v_writeoffs,'reopened_count',v_reopened,'reconciled_at',clock_timestamp(),'idempotent',false);
 RETURN cf_private.record_payable_import_resolution(p_request_id,v_payload,v_result);
END $$;


-- PAYMENTS v2: conciliação financeira normal e baixas explícitas de sentinelas de R$ 0,01.
CREATE FUNCTION cf_private.preview_payable_paid_rows_v2(p_scope text,p_rows jsonb,p_bank_mappings jsonb,p_mappings jsonb,p_resolution_choices jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_rows jsonb;v_banks jsonb;v_plans jsonb;v_choices jsonb;v_base jsonb;v_row jsonb;v_choice jsonb;v_title public.payable_review_titles%ROWTYPE;
 v_out_rows jsonb:='[]';v_errors jsonb:='[]';v_resolution_errors jsonb:='[]';v_items jsonb:='[]';v_item jsonb;v_problem text;v_key text;v_outcome text;v_active_writeoff uuid;
 v_new integer:=0;v_matched integer:=0;v_correct integer:=0;v_writeoff integer:=0;v_new_writeoff integer:=0;v_matched_writeoff integer:=0;v_mapping record;v_unmapped jsonb;v_unclassified jsonb;v_previous uuid;
BEGIN
 v_rows:=cf_private.normalize_payable_paid_rows(p_scope,p_rows);
 v_banks:=cf_private.normalize_payable_paid_mappings(v_rows,p_bank_mappings);
 v_plans:=cf_private.normalize_payable_paid_plans(v_rows,p_mappings);
 v_choices:=cf_private.validate_payable_import_resolution_choices(p_resolution_choices);
 v_base:=cf_private.preview_payable_paid_rows(v_rows,v_banks,v_plans);
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_base->'rows') LOOP
  v_problem:='';v_key:='row:'||(v_row->>'line');v_choice:=v_choices->v_key;v_active_writeoff:=NULL;
  IF (v_row->>'amount_paid_cents')::bigint=1 AND v_row->>'title_id' IS NOT NULL THEN
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_row->>'title_id')::uuid;
   SELECT id INTO v_active_writeoff FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=v_title.id;
   -- A sentinela não autoriza mesclar versões da identidade nem apagar pagamentos.
   IF EXISTS(SELECT 1 FROM public.payable_titles other WHERE other.id<>v_title.id AND other.scope=p_scope
      AND cf_private.payable_business_key(other.branch,other.entry_number)=v_row->>'business_key'
      AND(other.status<>'SETTLED_IMPORT' OR EXISTS(SELECT 1 FROM public.payable_payments pay WHERE pay.title_id=other.id
       AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals rev WHERE rev.payment_id=pay.id)))) THEN
    v_problem:='Há versões ativas da mesma filial e lançamento. Confira a identidade antes da baixa sem pagamento.';
   ELSIF EXISTS(SELECT 1 FROM public.payable_payments pay WHERE pay.title_id=v_title.id AND NOT EXISTS(
       SELECT 1 FROM public.payable_payment_reversals rev WHERE rev.payment_id=pay.id)) THEN
    v_problem:='Este título já possui pagamento efetivo. Confira e corrija o histórico antes de confirmar uma baixa sem pagamento.';
   ELSIF NOT v_title.closing_eligible AND v_active_writeoff IS NULL THEN
    v_problem:='Esta versão é somente histórica. Confira o título canônico antes da baixa sem pagamento.';
   ELSIF v_choice IS NULL THEN
    v_problem:='Confirme individualmente a baixa sem pagamento deste título de R$ 0,01.';
   ELSIF v_choice->>'action'<>'WRITE_OFF' THEN
    v_problem:='Um valor de R$ 0,01 deve ser baixado sem pagamento, com confirmação individual.';
   END IF;
   v_outcome:=CASE WHEN v_problem='' THEN 'WRITE_OFF' ELSE 'WRITE_OFF_PENDING' END;
   v_item:=jsonb_build_object('key',v_key,'kind','CENT','line',(v_row->>'line')::integer,'title_id',v_title.id,
    'branch',v_title.branch,'entry_number',v_title.entry_number,'description',v_title.description,'due_date',v_title.due_date,
    'amount_cents',v_title.amount_cents,'source_amount_cents',1,'payment_revision',v_title.payment_revision,
    'already_written_off',v_active_writeoff IS NOT NULL,'allowed_actions',jsonb_build_array('WRITE_OFF'),
    'selected_action',v_choice->>'action','requires_resolution',true,'problem',nullif(v_problem,''));
   v_items:=v_items||jsonb_build_array(v_item);
   v_row:=v_row||jsonb_build_object('outcome',v_outcome,'problem',v_problem,'bank_account_id',NULL,'payment_ids','[]'::jsonb,
    'amount_changed',false,'updated_amount_cents',v_title.amount_cents,'resolution_key',v_key,'administrative_writeoff_id',v_active_writeoff);
   v_writeoff:=v_writeoff+1;IF v_active_writeoff IS NULL THEN v_new_writeoff:=v_new_writeoff+1;ELSE v_matched_writeoff:=v_matched_writeoff+1;END IF;
   IF v_problem<>'' THEN v_resolution_errors:=v_resolution_errors||jsonb_build_array(jsonb_build_object('line',(v_row->>'line')::integer,'column','Baixa sem pagamento',
    'problem',v_problem,'correction','Confira este título e confirme expressamente a baixa sem pagamento, informando o motivo.'));
   END IF;
  ELSE
   IF (v_row->>'amount_paid_cents')::bigint=1 AND v_row->>'title_id' IS NULL THEN
    v_items:=v_items||jsonb_build_array(jsonb_build_object('key',v_key,'kind','CENT','line',(v_row->>'line')::integer,
     'title_id',NULL,'branch',v_row->>'branch','entry_number',v_row->>'entry_number','description',coalesce(v_row->>'description',''),
     'due_date',NULL,'amount_cents',NULL,'source_amount_cents',1,'allowed_actions','[]'::jsonb,'selected_action',NULL,
     'requires_resolution',false,'problem','Título de R$ 0,01 não encontrado. Importe primeiro a previsão para preservar o vencimento e o valor original.'));
   END IF;
   -- Uma baixa anterior nunca é reaberta por um relatório de pagamentos.
   IF v_row->>'title_id' IS NOT NULL AND EXISTS(SELECT 1 FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=(v_row->>'title_id')::uuid) THEN
    v_row:=v_row||jsonb_build_object('outcome','CONFLICT','problem','Este título foi baixado sem pagamento. Reabra-o expressamente na importação de previsões antes de registrar um pagamento.');
    v_errors:=v_errors||jsonb_build_array(jsonb_build_object('line',(v_row->>'line')::integer,'column','Baixa sem pagamento',
     'problem',v_row->>'problem','correction','Importe o título na previsão e confirme a reabertura antes de importar este pagamento.'));
   ELSE
    v_errors:=v_errors||coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(v_base->'errors') e WHERE e->>'line'=v_row->>'line'),'[]'::jsonb);
   END IF;
   CASE v_row->>'outcome' WHEN 'NEW_PAYMENT' THEN v_new:=v_new+1;WHEN 'MATCHED' THEN v_matched:=v_matched+1;WHEN 'CORRECTION' THEN v_correct:=v_correct+1;ELSE NULL;END CASE;
  END IF;
  v_out_rows:=v_out_rows||jsonb_build_array(v_row);
 END LOOP;
 FOR v_mapping IN SELECT key,value FROM jsonb_each(v_choices) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_items) i WHERE i->>'key'=v_mapping.key AND i->>'title_id' IS NOT NULL) THEN
   RAISE EXCEPTION 'A escolha de baixa deve corresponder a uma linha de R$ 0,01 conhecida deste relatório.' USING ERRCODE='22023';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'branch',branch,'paid_bank',paid_bank,'count',n) ORDER BY key),'[]'::jsonb) INTO v_unmapped FROM(
  SELECT r->>'bank_mapping_key' key,min(r->>'branch') branch,min(r->>'paid_bank') paid_bank,count(*) n FROM jsonb_array_elements(v_out_rows) r
   WHERE (r->>'amount_paid_cents')::bigint<>1 AND r->>'bank_account_id' IS NULL GROUP BY r->>'bank_mapping_key') x;
 SELECT coalesce(jsonb_agg(jsonb_build_object('plan',plan,'count',n,'total_cents',total_cents) ORDER BY plan),'[]'::jsonb) INTO v_unclassified FROM(
  SELECT r->>'plan' plan,count(*) n,sum((r->>'amount_paid_cents')::numeric) total_cents FROM jsonb_array_elements(v_out_rows) r
   WHERE r->>'outcome'='UNCLASSIFIED_PLAN' GROUP BY r->>'plan') x;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN v_base||jsonb_build_object('rows',v_out_rows,'new_payment_count',v_new,'matched_payment_count',v_matched,'correction_count',v_correct,
  'writeoff_count',v_writeoff,'new_writeoff_count',v_new_writeoff,'matched_writeoff_count',v_matched_writeoff,'conflict_count',jsonb_array_length(v_errors)+jsonb_array_length(v_resolution_errors),'errors',v_errors||v_resolution_errors,
  'unmapped_banks',v_unmapped,'unclassified_plans',v_unclassified,'can_commit',jsonb_array_length(v_errors)=0 AND jsonb_array_length(v_resolution_errors)=0,
  'reconciliation_version','043','full_report',false,'reconciliation_items',v_items,'resolution_errors',v_resolution_errors,
  'previous_import_id',v_previous,'financial_revision',public.get_payables_revision()->>'financial_revision',
  'bank_accounts',cf_private.payable_import_resolution_bank_options(),'bank_options',cf_private.payable_import_resolution_bank_options());
END $$;

CREATE FUNCTION public.preview_payables_paid_import_v2(p_scope text,p_rows jsonb,p_bank_mappings jsonb DEFAULT '{}'::jsonb,p_mappings jsonb DEFAULT '{}'::jsonb,p_resolution_choices jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write') AND cf_private.has_permission('contas_pagar','import') AND cf_private.has_permission('importar_bases','read')) THEN
  RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 RETURN cf_private.preview_payable_paid_rows_v2(p_scope,p_rows,p_bank_mappings,p_mappings,p_resolution_choices);
END $$;

CREATE FUNCTION public.commit_payables_paid_import_v2_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,
 p_file_base64 text,p_rows jsonb,p_bank_mappings jsonb,p_previous_import_id uuid DEFAULT NULL,p_confirm_corrections boolean DEFAULT false,
 p_mappings jsonb DEFAULT '{}'::jsonb,p_previous_financial_revision text DEFAULT NULL,p_resolution_choices jsonb DEFAULT '{}'::jsonb,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_banks jsonb;v_plans jsonb;v_choices jsonb;v_preview jsonb;v_row jsonb;v_file bytea;v_previous uuid;v_id uuid:=gen_random_uuid();v_existing uuid;v_existing_mode text;
 v_payload jsonb;v_replay jsonb;v_result jsonb;v_title public.payable_review_titles%ROWTYPE;v_payment uuid;v_payments uuid[];v_review uuid;v_mapping record;v_current_mapping uuid;
 v_new integer:=0;v_matched integer:=0;v_correct integer:=0;v_writeoff integer:=0;v_new_writeoff integer:=0;v_matched_writeoff integer:=0;
 v_observation text;v_source jsonb;v_outcome text;v_choice jsonb;v_writeoff_id uuid;v_writeoff_rows jsonb:='[]';
BEGIN
 PERFORM cf_private.require_payable_import_reconciliation_actor(p_user_id,p_session_id);
 IF p_confirm_corrections IS NULL OR p_request_id IS NULL THEN RAISE EXCEPTION 'Confirme os dados e identifique esta solicitação de importação.' USING ERRCODE='22023';END IF;
 v_file:=cf_private.validate_payable_reconciliation_file(p_file_name,p_file_sha256,p_file_base64);
 v_payload:=jsonb_build_object('scope',p_scope,'mode','payments','file_name',p_file_name,'file_sha256',p_file_sha256,'rows',p_rows,'bank_mappings',p_bank_mappings,
  'mappings',p_mappings,'previous_import_id',p_previous_import_id,'confirm_corrections',p_confirm_corrections,
  'previous_financial_revision',p_previous_financial_revision,'resolution_choices',p_resolution_choices,'reconciliation_version','043');
 v_replay:=cf_private.payable_import_resolution_replay(p_request_id,v_payload);IF v_replay IS NOT NULL THEN RETURN v_replay;END IF;
 -- O reconhecimento durável do mesmo protocolo não depende de um banco ainda ativo hoje.
 v_rows:=cf_private.normalize_payable_paid_rows(p_scope,p_rows);
 v_banks:=cf_private.normalize_payable_paid_mappings(v_rows,p_bank_mappings);v_plans:=cf_private.normalize_payable_paid_plans(v_rows,p_mappings);
 v_choices:=cf_private.validate_payable_import_resolution_choices(p_resolution_choices);
 SELECT i.id,m.mode,m.result INTO v_existing,v_existing_mode,v_result FROM public.payable_imports i LEFT JOIN public.payable_import_modes m ON m.import_id=i.id
  WHERE i.scope=p_scope AND i.file_sha256=p_file_sha256 AND i.import_mode='PAYMENTS';
 IF v_existing IS NOT NULL THEN
  IF v_existing_mode='PAYMENTS' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'amount_paid_cents')::bigint=1)
      AND coalesce(v_result->>'reconciliation_version','')<>'043' THEN
    RAISE EXCEPTION 'Este relatório já foi registrado pela versão anterior com valores de R$ 0,01. Confira os pagamentos históricos antes de corrigir as baixas; nenhum pagamento será apagado automaticamente.' USING ERRCODE='P0042';
   END IF;
   -- Uma retransmissão do mesmo protocolo já retornou acima. Um protocolo novo
   -- ainda exige a confirmação individual, mesmo quando o arquivo não gera novos eventos.
   FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) WHERE (value->>'amount_paid_cents')::bigint=1 LOOP
    IF coalesce(v_choices->('row:'||(v_row->>'line'))->>'action','')<>'WRITE_OFF' THEN
     RAISE EXCEPTION 'Confirme individualmente cada baixa de R$ 0,01 antes de repetir esta importação.' USING ERRCODE='P0042';END IF;
   END LOOP;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_choices) k WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE 'row:'||(r->>'line')=k AND (r->>'amount_paid_cents')::bigint=1)) THEN
    RAISE EXCEPTION 'A escolha deve corresponder a uma linha de R$ 0,01 deste relatório.' USING ERRCODE='22023';END IF;
   FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) WHERE (value->>'amount_paid_cents')::bigint<>1 LOOP
    SELECT source_row INTO v_source FROM public.payable_paid_import_rows WHERE import_id=v_existing
      AND source_row->>'business_key'=v_row->>'business_key';
    IF v_source IS NULL THEN
     RAISE EXCEPTION 'Confira o histórico deste arquivo antes de repetir a importação.' USING ERRCODE='P0042';END IF;
    IF (v_banks ? (v_row->>'bank_mapping_key') AND v_banks->>(v_row->>'bank_mapping_key') IS DISTINCT FROM v_source->>'bank_account_id')
      OR (v_row ? 'plan' AND v_plans ? (v_row->>'plan') AND v_plans->>(v_row->>'plan') IS DISTINCT FROM v_source->>'target_macro') THEN
     RAISE EXCEPTION 'Este arquivo já foi conciliado com outro banco ou classificação. Confira o histórico e corrija expressamente; a repetição do arquivo não altera decisões já registradas.' USING ERRCODE='P0042';END IF;
   END LOOP;
   RETURN cf_private.record_payable_import_resolution(p_request_id,v_payload,v_result||jsonb_build_object('idempotent',true,'request_id',p_request_id,'reconciliation_version','043',
    'reconciled_at',coalesce(v_result->>'reconciled_at',clock_timestamp()::text),
    'writeoff_count',coalesce((v_result->>'writeoff_count')::integer,0),
    'new_writeoff_count',coalesce((v_result->>'new_writeoff_count')::integer,0),
    'matched_writeoff_count',coalesce((v_result->>'matched_writeoff_count')::integer,0)));
  END IF;
  RAISE EXCEPTION 'Este arquivo já foi registrado em outro modo de importação.' USING ERRCODE='23505';END IF;
 SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_previous IS DISTINCT FROM p_previous_import_id THEN RAISE EXCEPTION 'A base mudou. Gere nova análise antes de confirmar os pagamentos.' USING ERRCODE='40001';END IF;
 IF p_previous_financial_revision IS NULL OR p_previous_financial_revision IS DISTINCT FROM public.get_payables_revision()->>'financial_revision' THEN
  RAISE EXCEPTION 'Os dados financeiros mudaram. Gere nova análise antes de confirmar os pagamentos.' USING ERRCODE='40001';END IF;
 -- O mesmo lock do lançamento de pagamentos e das baixas protege toda a análise e aplicação.
 PERFORM 1 FROM public.payable_titles t WHERE t.scope=p_scope AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r
  WHERE r->>'business_key'=cf_private.payable_business_key(t.branch,t.entry_number)) ORDER BY t.id FOR UPDATE;
 v_preview:=cf_private.preview_payable_paid_rows_v2(p_scope,p_rows,p_bank_mappings,p_mappings,p_resolution_choices);
 IF NOT coalesce((v_preview->>'can_commit')::boolean,false) THEN
  RAISE EXCEPTION 'A importação possui pendências. Confirme cada baixa sem pagamento e confira os pagamentos; nenhum dado foi alterado.' USING ERRCODE='P0042',DETAIL=(v_preview->'errors')::text;END IF;
 IF (v_preview->>'correction_count')::integer>0 AND NOT p_confirm_corrections THEN
  RAISE EXCEPTION 'Confirme expressamente os estornos e a substituição dos pagamentos originados em importações anteriores.' USING ERRCODE='P0042';END IF;
 INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count,import_mode)
  VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),0,jsonb_array_length(v_rows),0,'PAYMENTS');
 INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
 -- Classificações financeiras só são aplicadas quando utilizadas por linhas com pagamento real.
 INSERT INTO public.payable_plan_mappings(plan,macro) SELECT key,value#>>'{}' FROM jsonb_each(v_plans) mapping
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview->'rows') r WHERE r->>'outcome'<>'WRITE_OFF' AND r->>'plan'=mapping.key)
  ON CONFLICT(plan) DO UPDATE SET macro=EXCLUDED.macro,updated_at=clock_timestamp() WHERE payable_plan_mappings.macro IS DISTINCT FROM EXCLUDED.macro;
 FOR v_mapping IN SELECT key,value FROM jsonb_each(v_banks) LOOP
  SELECT r INTO v_source FROM jsonb_array_elements(v_preview->'rows') r WHERE r->>'outcome'<>'WRITE_OFF' AND r->>'bank_mapping_key'=v_mapping.key LIMIT 1;
  IF NOT FOUND THEN CONTINUE;END IF;
  SELECT bank_account_id INTO v_current_mapping FROM public.payable_paid_bank_mappings WHERE mapping_key=v_mapping.key ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_current_mapping IS DISTINCT FROM (v_mapping.value#>>'{}')::uuid THEN
   INSERT INTO public.payable_paid_bank_mappings(mapping_key,branch,paid_bank,bank_account_id,created_by,created_at)
    SELECT v_mapping.key,v_source->>'branch',v_source->>'paid_bank',(v_mapping.value#>>'{}')::uuid,auth.uid(),
     greatest(clock_timestamp(),coalesce(max(created_at),'1900-01-01'::timestamptz)+interval '1 microsecond') FROM public.payable_paid_bank_mappings WHERE mapping_key=v_mapping.key;
  END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_preview->'rows') LOOP
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=(v_row->>'title_id')::uuid;
  v_outcome:=v_row->>'outcome';v_payments:=ARRAY[]::uuid[];
  IF v_outcome='WRITE_OFF' THEN
   v_choice:=v_choices->('row:'||(v_row->>'line'));
   SELECT id INTO v_writeoff_id FROM cf_private.active_payable_administrative_writeoffs WHERE title_id=v_title.id;
   IF v_writeoff_id IS NULL THEN
    v_source:=cf_private.record_payable_administrative_writeoff(v_title.id,v_id,v_choice->>'reason',v_title.payment_revision);
    v_writeoff_id:=(v_source->>'writeoff_id')::uuid;v_new_writeoff:=v_new_writeoff+1;
   ELSE v_matched_writeoff:=v_matched_writeoff+1;END IF;
   v_writeoff:=v_writeoff+1;
   v_writeoff_rows:=v_writeoff_rows||jsonb_build_array(jsonb_build_object('line',(v_row->>'line')::integer,'title_id',v_title.id,'writeoff_id',v_writeoff_id,'amount_cents',v_title.amount_cents));
   CONTINUE;
  END IF;
  UPDATE public.payable_titles SET amount_cents=(v_row->>'amount_paid_cents')::bigint,description=CASE WHEN v_row ? 'description' THEN v_row->>'description' ELSE description END,
   plan=CASE WHEN v_row ? 'plan' THEN v_row->>'plan' ELSE plan END,macro=v_row->>'target_macro',
   issued_on=CASE WHEN v_row ? 'issued_on' THEN (v_row->>'issued_on')::date ELSE issued_on END,bank_account=v_row->>'paid_bank',
   cheque_number=CASE WHEN v_row ? 'cheque_number' THEN v_row->>'cheque_number' ELSE cheque_number END,last_import_id=v_id WHERE id=v_title.id;
  IF v_outcome='CORRECTION' THEN
   FOR v_payment IN SELECT value::uuid FROM jsonb_array_elements_text(v_row->'payment_ids') LOOP
    SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
    PERFORM public.cancel_payable_payment(v_payment,'Correção expressamente confirmada por relatório de pagamentos. Importação '||v_id::text,v_title.payment_revision);
   END LOOP;
  END IF;
  IF v_outcome IN('NEW_PAYMENT','CORRECTION') THEN
   SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
   v_observation:='Pagamento integral informado em relatório de títulos pagos. Importação '||v_id::text;
   v_payment:=public.register_payable_payment(v_title.id,(v_row->>'amount_paid_cents')::bigint,(v_row->>'paid_on')::date,
    (v_row->>'bank_account_id')::uuid,v_observation,v_title.payment_revision,gen_random_uuid(),v_title.last_import_id);
   v_payments:=ARRAY[v_payment];IF v_outcome='CORRECTION' THEN v_correct:=v_correct+1;ELSE v_new:=v_new+1;END IF;
  ELSE SELECT coalesce(array_agg(value::uuid),'{}'::uuid[]) INTO v_payments FROM jsonb_array_elements_text(v_row->'payment_ids');v_matched:=v_matched+1;END IF;
  SELECT * INTO v_title FROM public.payable_review_titles WHERE id=v_title.id;
  v_review:=public.review_payable_title(v_title.id,'Conciliação automática por relatório explícito de títulos pagos. Importação '||v_id::text,v_title.review_fingerprint);
  INSERT INTO public.payable_paid_import_rows(import_id,title_id,outcome,payment_ids,review_id,source_row)
   VALUES(v_id,v_title.id,CASE WHEN v_outcome='NEW_PAYMENT' THEN 'CREATED' WHEN v_outcome='CORRECTION' THEN 'CORRECTED' ELSE 'MATCHED' END,v_payments,v_review,v_row);
 END LOOP;
 v_result:=jsonb_build_object('mode','payments','import_id',v_id,'row_count',jsonb_array_length(v_rows),'new_payment_count',v_new,'matched_payment_count',v_matched,
  'correction_count',v_correct,'reviewed_count',v_new+v_matched+v_correct,'settled_count',0,'writeoff_count',v_writeoff,
  'new_writeoff_count',v_new_writeoff,'matched_writeoff_count',v_matched_writeoff,'writeoff_rows',v_writeoff_rows,'reconciliation_version','043','request_id',p_request_id,'reconciled_at',clock_timestamp(),'idempotent',false);
 INSERT INTO public.payable_import_modes(import_id,mode,result,created_by) VALUES(v_id,'PAYMENTS',v_result,auth.uid());
 RETURN cf_private.record_payable_import_resolution(p_request_id,v_payload,v_result);
END $$;
-- As rotas anteriores não recebem protocolo nem escolhas individuais.
-- Nenhuma nova aplicação financeira pode contornar o contrato 043.
CREATE OR REPLACE FUNCTION public.commit_payables_paid_import_from_gateway(p_user_id uuid,p_session_id text,p_scope text,p_file_name text,p_file_sha256 text,
 p_file_base64 text,p_rows jsonb,p_bank_mappings jsonb,p_previous_import_id uuid DEFAULT NULL,p_confirm_corrections boolean DEFAULT false,
 p_mappings jsonb DEFAULT '{}'::jsonb,p_previous_financial_revision text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM cf_private.require_payable_import_reconciliation_actor(p_user_id,p_session_id);
 RAISE EXCEPTION 'Atualize a função payables-import para a conciliação 043 antes de confirmar este relatório.' USING ERRCODE='P0043';
END $$;
REVOKE ALL ON FUNCTION public.commit_payables_paid_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION cf_private.preview_payable_paid_rows_v2(text,jsonb,jsonb,jsonb,jsonb),
 public.preview_payables_paid_import_v2(text,jsonb,jsonb,jsonb,jsonb),
 public.commit_payables_paid_import_v2_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_payables_paid_import_v2(text,jsonb,jsonb,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_payables_paid_import_v2_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text,jsonb,uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.payables_import_capabilities() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('contas_pagar','import') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('schema_version','043_payable_import_reconciliation','cheque_number',true,'forecast_incremental',true,'paid_import',true,
  'import_reconciliation',true,'reconciliation_version','043');
END $$;
REVOKE ALL ON FUNCTION cf_private.audit_payable_import_resolution(),cf_private.require_payable_import_reconciliation_actor(uuid,text),
 cf_private.validate_payable_reconciliation_file(text,text,text),cf_private.validate_payable_import_resolution_choices(jsonb),
 cf_private.payable_import_resolution_bank_options(),cf_private.payable_import_resolution_replay(uuid,jsonb),cf_private.record_payable_import_resolution(uuid,jsonb,jsonb),
 cf_private.review_payable_import_resolution_items(jsonb,jsonb),cf_private.commit_payables_forecast_import_v1_core(text,text,text,text,jsonb,jsonb,uuid),
 cf_private.commit_payables_forecast_import(text,text,text,text,jsonb,jsonb,uuid),
 public.preview_payables_forecast_import_v2(text,jsonb,boolean,jsonb),
 public.commit_payables_forecast_import_v2_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_payables_forecast_import_v2(text,jsonb,boolean,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_payables_forecast_import_v2_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,boolean,jsonb,text,uuid) TO service_role;
INSERT INTO public.central_schema_migrations(version) VALUES('043_payable_import_reconciliation');
NOTIFY pgrst,'reload schema';
 $cf_source_043$;
END $cf_apply_043$;

COMMIT;
