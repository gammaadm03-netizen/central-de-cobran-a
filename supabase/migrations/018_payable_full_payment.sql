-- Regra atual: Contas a Pagar possui somente quitação integral.
-- Incremental após 017. Não altera nem exclui pagamentos históricos parciais.
-- Um saldo parcial antigo pode receber apenas o complemento integral exato.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative as atualizações anteriores de Contas a Pagar.' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='017_payable_month_closing') THEN
  RAISE EXCEPTION 'Ative a atualização 017 antes da quitação integral.' USING ERRCODE='22023';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.register_payable_payment(p_title_id uuid,p_amount_cents bigint,p_paid_on date,
 p_bank_account_id uuid,p_observation text,p_expected_revision uuid,p_request_id uuid,p_expected_import_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.payable_titles%ROWTYPE;v_bank public.bank_accounts%ROWTYPE;v_existing public.payable_payments%ROWTYPE;
 v_paid numeric;v_revision uuid;v_counter bigint;v_id uuid;v_observation text:=btrim(coalesce(p_observation,''));
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.has_permission('contas_pagar','read') OR NOT cf_private.has_permission('contas_pagar','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_title_id IS NULL OR p_request_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 1 AND 9007199254740991
    OR p_paid_on IS NULL OR p_paid_on<DATE '1900-01-01'
    OR p_paid_on>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_bank_account_id IS NULL OR length(v_observation) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe título, valor positivo em centavos, data real até hoje e banco/caixa oficial.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
  PERFORM pg_advisory_xact_lock(2045812309);
  SELECT * INTO v_existing FROM public.payable_payments WHERE request_id=p_request_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.created_by=auth.uid() AND v_existing.title_id=p_title_id AND v_existing.amount_cents=p_amount_cents
      AND v_existing.paid_on=p_paid_on AND v_existing.bank_account_id=p_bank_account_id
      AND v_existing.observation=v_observation AND v_existing.expected_revision IS NOT DISTINCT FROM p_expected_revision
      AND v_existing.expected_import_id IS NOT DISTINCT FROM p_expected_import_id THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'A identificação desta solicitação já foi usada com outros dados.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_title FROM public.payable_titles WHERE id=p_title_id AND scope='grupo-consolidado' FOR UPDATE;
  IF v_title.id IS NULL THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='22023'; END IF;
  IF v_title.last_import_id IS DISTINCT FROM p_expected_import_id THEN
    RAISE EXCEPTION 'O título foi atualizado por importação. Confira o valor e vencimento antes de registrar.' USING ERRCODE='40001'; END IF;
  SELECT payment_revision,paid_cents INTO v_revision,v_paid FROM public.payable_financial_titles WHERE id=p_title_id;
  IF v_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'O título recebeu outra conciliação. Atualize antes de registrar.' USING ERRCODE='40001'; END IF;
  IF p_amount_cents::numeric IS DISTINCT FROM v_title.amount_cents::numeric-v_paid THEN
    RAISE EXCEPTION 'Pagamento parcial não permitido. O valor deve quitar integralmente o saldo atual do título. Corrija os dados do título antes de registrar qualquer diferença.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_bank FROM public.bank_accounts WHERE id=p_bank_account_id AND enabled FOR SHARE;
  IF v_bank.id IS NULL THEN RAISE EXCEPTION 'Selecione uma conta oficial ativa.' USING ERRCODE='22023'; END IF;
  IF (SELECT coalesce(sum(p.amount_cents),0) FROM public.payable_payments p
      WHERE NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id))+p_amount_cents::numeric>9007199254740991 THEN
    RAISE EXCEPTION 'O realizado excede o limite de precisão.' USING ERRCODE='22003'; END IF;
  UPDATE cf_private.payable_payment_state SET revision=revision+1 WHERE singleton RETURNING revision INTO v_counter;
  INSERT INTO public.payable_payments(title_id,request_id,event_revision,amount_cents,paid_on,bank_account_id,
    bank_label,bank_company,bank_name,account_type,macro_snapshot,entry_number,description,branch,plan_snapshot,due_date,
    title_amount_cents,expected_revision,expected_import_id,observation,created_by)
    VALUES(v_title.id,p_request_id,v_counter,p_amount_cents,p_paid_on,v_bank.id,v_bank.display_name,v_bank.company,v_bank.bank,
      v_bank.account_type,v_title.macro,v_title.entry_number,v_title.description,v_title.branch,v_title.plan,v_title.due_date,
      v_title.amount_cents,p_expected_revision,p_expected_import_id,v_observation,auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.register_payable_payment(uuid,bigint,date,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.register_payable_payment(uuid,bigint,date,uuid,text,uuid,uuid,uuid) TO authenticated;
COMMENT ON FUNCTION public.register_payable_payment(uuid,bigint,date,uuid,text,uuid,uuid,uuid) IS 'Somente quitação integral pelo valor exato do saldo atual. Preserva pagamentos parciais antigos e permite apenas completar seu saldo integralmente. Solicitações idempotentes previamente concluídas retornam o registro original sem criar outro.';
INSERT INTO public.central_schema_migrations(version) VALUES('018_payable_full_payment');
COMMIT;
