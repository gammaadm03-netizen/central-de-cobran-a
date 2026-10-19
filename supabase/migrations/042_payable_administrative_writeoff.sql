-- Baixa administrativa explícita, sem pagamento ou movimentação bancária.
-- Repetível; preserva valores nominais, pagamentos e snapshots históricos.
BEGIN;
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
COMMIT;
