-- Central Financeira: posições bancárias e estoque manual de contingência.
-- Aplicar uma única vez após 001, 003 e 004. Não altera saldos ou dados existentes.
-- Cadastra somente as onze contas oficiais; ausência de posição nunca significa zero.
BEGIN;

CREATE TABLE public.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (length(btrim(company)) BETWEEN 1 AND 100),
  bank text NOT NULL CHECK (length(btrim(bank)) BETWEEN 1 AND 100),
  account_label text NOT NULL CHECK (length(btrim(account_label)) BETWEEN 1 AND 150),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company, bank, account_label)
);
INSERT INTO public.bank_accounts(company, bank, account_label) VALUES
  ('F2G', 'Bradesco', 'Bradesco'),
  ('EASY CLEAN', 'Bradesco', 'Bradesco'),
  ('EASY CLEAN', 'Banco do Brasil', 'Banco do Brasil'),
  ('FAST CLEAN', 'Bradesco', 'Bradesco'),
  ('FAST CLEAN', 'Banco do Brasil', 'Banco do Brasil'),
  ('ECOPLAST', 'Bradesco', 'Bradesco'),
  ('ECOPLAST', 'Banco do Brasil', 'Banco do Brasil'),
  ('GAMMA', 'Bradesco', 'Bradesco'),
  ('LIMPE FÁCIL', 'Bradesco', 'Bradesco'),
  ('LIMPE FÁCIL', 'Cora', 'Cora'),
  ('MY CLEAN', 'Cora', 'Cora');

CREATE TABLE public.bank_balance_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  balance_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN -9007199254740991 AND 9007199254740991),
  observation text NOT NULL CHECK (length(btrim(observation)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, balance_date)
);
CREATE INDEX bank_positions_lookup ON public.bank_balance_positions(account_id, balance_date DESC);

CREATE TABLE public.stock_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  value_cents bigint NOT NULL CHECK (value_cents BETWEEN 0 AND 9007199254740991),
  reference_date date NOT NULL,
  observation text NOT NULL CHECK (length(btrim(observation)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX stock_positions_latest ON public.stock_positions(reference_date DESC, created_at DESC, id DESC);

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_balance_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_accounts_read ON public.bank_accounts FOR SELECT TO authenticated
  USING (cf_private.has_permission('caixa', 'read'));
CREATE POLICY bank_positions_read ON public.bank_balance_positions FOR SELECT TO authenticated
  USING (cf_private.has_permission('caixa', 'read'));
CREATE POLICY stock_positions_read ON public.stock_positions FOR SELECT TO authenticated
  USING (cf_private.has_permission('painel', 'read') OR cf_private.has_permission('resumo_diretoria', 'read'));

CREATE FUNCTION cf_private.audit_treasury() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor public.profiles%ROWTYPE; v_before jsonb; v_after jsonb;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = auth.uid();
  IF TG_OP <> 'INSERT' THEN v_before := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_after := to_jsonb(NEW); END IF;
  INSERT INTO public.audit_events(user_id, username, role_key, module, entity, record_id, action, before_value, after_value)
  VALUES (v_actor.id, v_actor.username, v_actor.role_key,
    CASE WHEN TG_TABLE_NAME = 'stock_positions' THEN 'estoque' ELSE 'caixa' END,
    TG_TABLE_NAME, coalesce(v_after->>'id', v_before->>'id'),
    CASE TG_OP WHEN 'INSERT' THEN 'CREATE' WHEN 'UPDATE' THEN 'UPDATE' ELSE 'DELETE' END,
    v_before, v_after);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_position_audit AFTER INSERT OR UPDATE OR DELETE ON public.bank_balance_positions
  FOR EACH ROW EXECUTE FUNCTION cf_private.audit_treasury();
CREATE TRIGGER stock_position_audit AFTER INSERT OR UPDATE OR DELETE ON public.stock_positions
  FOR EACH ROW EXECUTE FUNCTION cf_private.audit_treasury();

CREATE FUNCTION public.set_bank_balance(
  p_account_id uuid,
  p_balance_date date,
  p_amount_cents bigint,
  p_observation text,
  p_expected_updated_at timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_previous public.bank_balance_positions%ROWTYPE; v_id uuid;
BEGIN
  -- Compartilha o bloqueio da administração de perfis antes de verificar o perfil oficial.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('caixa', 'write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NULL OR p_balance_date IS NULL OR p_amount_cents IS NULL
    OR p_amount_cents NOT BETWEEN -9007199254740991 AND 9007199254740991
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe conta, data, valor em centavos e uma observação de até 1.000 caracteres.' USING ERRCODE = '23514';
  END IF;
  IF p_balance_date < DATE '1900-01-01' OR p_balance_date > (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'A data do saldo deve ser uma data passada ou a data de hoje em São Paulo.' USING ERRCODE = '23514';
  END IF;
  -- A conta serializa inclusive a primeira posição de uma data, evitando sobrescrita concorrente.
  PERFORM 1 FROM public.bank_accounts WHERE id = p_account_id AND enabled FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conta bancária indisponível.' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_previous FROM public.bank_balance_positions
    WHERE account_id = p_account_id AND balance_date = p_balance_date FOR UPDATE;
  IF FOUND THEN
    IF p_expected_updated_at IS NULL OR p_expected_updated_at IS DISTINCT FROM v_previous.updated_at THEN
      RAISE EXCEPTION 'O saldo foi alterado. Atualize a tela antes de salvar novamente.' USING ERRCODE = '40001';
    END IF;
    UPDATE public.bank_balance_positions
      SET amount_cents = p_amount_cents, observation = btrim(p_observation),
          updated_at = greatest(clock_timestamp(), v_previous.updated_at + interval '1 microsecond')
      WHERE id = v_previous.id RETURNING id INTO v_id;
  ELSE
    IF p_expected_updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'A posição informada não está mais disponível. Atualize a tela.' USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.bank_balance_positions(account_id, balance_date, amount_cents, observation, created_by)
      VALUES (p_account_id, p_balance_date, p_amount_cents, btrim(p_observation), auth.uid())
      RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.cash_position(p_as_of date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_details boolean; v_accounts jsonb; v_total numeric; v_reported integer; v_expected integer; v_latest date;
BEGIN
  v_details := cf_private.has_permission('caixa', 'read');
  IF NOT v_details AND NOT cf_private.has_permission('painel', 'read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
  END IF;
  IF p_as_of IS NULL OR p_as_of < DATE '1900-01-01' THEN
    RAISE EXCEPTION 'Informe uma data de referência válida.' USING ERRCODE = '23514';
  END IF;
  SELECT
    coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'company', a.company, 'bank', a.bank,
      'account_label', a.account_label, 'balance_date', p.balance_date,
      'amount_cents', p.amount_cents, 'updated_at', p.updated_at)
      ORDER BY a.company, a.bank, a.account_label, a.id), '[]'::jsonb),
    sum(p.amount_cents), count(p.id)::integer, count(a.id)::integer, max(p.balance_date)
  INTO v_accounts, v_total, v_reported, v_expected, v_latest
  FROM public.bank_accounts a
  LEFT JOIN LATERAL (
    SELECT b.id, b.balance_date, b.amount_cents, b.updated_at FROM public.bank_balance_positions b
    WHERE b.account_id = a.id AND b.balance_date <= p_as_of
    ORDER BY b.balance_date DESC LIMIT 1
  ) p ON true
  WHERE a.enabled;
  -- Um total seguro pode ocultar subtotais de empresas que se cancelam entre si.
  IF EXISTS (
    SELECT 1 FROM public.bank_accounts a
    JOIN LATERAL (
      SELECT b.amount_cents FROM public.bank_balance_positions b
      WHERE b.account_id = a.id AND b.balance_date <= p_as_of
      ORDER BY b.balance_date DESC LIMIT 1
    ) p ON true
    WHERE a.enabled GROUP BY a.company
    HAVING abs(sum(p.amount_cents)) > 9007199254740991
  ) THEN
    RAISE EXCEPTION 'O subtotal de uma empresa excede o limite seguro de representação.' USING ERRCODE = '22003';
  END IF;
  IF v_reported <> v_expected OR v_expected = 0 THEN v_total := NULL; END IF;
  IF v_total IS NOT NULL AND abs(v_total) > 9007199254740991 THEN
    RAISE EXCEPTION 'O saldo consolidado excede o limite seguro de representação.' USING ERRCODE = '22003';
  END IF;
  RETURN jsonb_build_object('accounts', CASE WHEN v_details THEN v_accounts ELSE '[]'::jsonb END,
    'total_cents', v_total, 'reported_accounts', v_reported, 'expected_accounts', v_expected,
    'latest_position_date', v_latest);
END;
$$;

CREATE FUNCTION public.save_manual_stock(p_value_cents bigint, p_reference_date date, p_observation text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501'; END IF;
  IF p_value_cents IS NULL OR p_value_cents NOT BETWEEN 0 AND 9007199254740991
    OR p_reference_date IS NULL OR p_reference_date < DATE '1900-01-01'
    OR p_reference_date > (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe valor não negativo em centavos, data de referência e uma observação de até 1.000 caracteres.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.stock_positions(value_cents, reference_date, observation, created_by)
    VALUES (p_value_cents, p_reference_date, btrim(p_observation), auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.current_stock() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_position public.stock_positions%ROWTYPE;
BEGIN
  IF NOT cf_private.has_permission('painel', 'read') AND NOT cf_private.has_permission('resumo_diretoria', 'read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_position FROM public.stock_positions
    WHERE reference_date <= (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    ORDER BY reference_date DESC, created_at DESC, id DESC LIMIT 1;
  RETURN jsonb_build_object('value_cents', v_position.value_cents,
    'reference_date', v_position.reference_date, 'source', CASE WHEN v_position.id IS NOT NULL THEN 'MANUAL' ELSE NULL END);
END;
$$;

REVOKE ALL ON TABLE public.bank_accounts, public.bank_balance_positions, public.stock_positions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.bank_accounts, public.bank_balance_positions, public.stock_positions TO authenticated;
REVOKE ALL ON FUNCTION cf_private.audit_treasury() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_bank_balance(uuid,date,bigint,text,timestamptz), public.cash_position(date),
  public.save_manual_stock(bigint,date,text), public.current_stock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_bank_balance(uuid,date,bigint,text,timestamptz), public.cash_position(date),
  public.save_manual_stock(bigint,date,text), public.current_stock() TO authenticated;

COMMENT ON TABLE public.bank_accounts IS 'Somente cadastro das contas oficiais. Saldo ausente deve permanecer desconhecido.';
COMMENT ON TABLE public.bank_balance_positions IS 'Posição manual por conta e data, em centavos inteiros. Alterações preservadas na auditoria imutável.';
COMMENT ON TABLE public.stock_positions IS 'Histórico manual de contingência; não existe integração automática ativa nesta versão.';
COMMENT ON FUNCTION public.cash_position(date) IS 'Consolidado somente com todas as contas ativas informadas. Detalhes exigem caixa.read; painel.read permite apenas o agregado.';
COMMIT;
