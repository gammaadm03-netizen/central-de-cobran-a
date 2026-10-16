-- Central Financeira: cadastro oficial ampliado para 12 contas bancárias e 5 caixas.
-- Aplicar uma única vez após 011. Preserva os IDs das contas, saldos e históricos.
-- As seis novas contas começam SEM saldo; zero somente após informação explícita.
BEGIN;

-- Compartilha o bloqueio das rotinas de saldo e importação da posição completa.
SELECT pg_advisory_xact_lock(2045812301);

ALTER TABLE public.bank_accounts
  ADD COLUMN account_type text NOT NULL DEFAULT 'BANK'
    CHECK (account_type IN ('BANK', 'CASH')),
  ADD COLUMN display_name text;

-- Mantém nomes canônicos de empresa, banco e conta que já identificam os saldos.
-- O nome de apresentação reproduz a relação oficial enviada pela administração.
UPDATE public.bank_accounts SET display_name = upper(bank || ' ' || company);
UPDATE public.bank_accounts a SET display_name = official.display_name
FROM (VALUES
  ('ECOPLAST', 'Bradesco', 'Bradesco', 'BRADESCO ECOPLAST'),
  ('LIMPE FÁCIL', 'Bradesco', 'Bradesco', 'BRADESCO LIMPE FACIL'),
  ('GAMMA', 'Bradesco', 'Bradesco', 'BRADESCO GAMMA IND'),
  ('F2G', 'Bradesco', 'Bradesco', 'BRADESCO F2G'),
  ('FAST CLEAN', 'Bradesco', 'Bradesco', 'BRADESCO FAST CLEAN'),
  ('EASY CLEAN', 'Bradesco', 'Bradesco', 'BRADESCO EASY CLEAN'),
  ('FAST CLEAN', 'Banco do Brasil', 'Banco do Brasil', 'BANCO DO BRASIL FAST CLEAN'),
  ('EASY CLEAN', 'Banco do Brasil', 'Banco do Brasil', 'BANCO DO BRASIL EASY CLEAN'),
  ('ECOPLAST', 'Banco do Brasil', 'Banco do Brasil', 'BANCO DO BRASIL ECOPLAST'),
  ('LIMPE FÁCIL', 'Cora', 'Cora', 'BANCO CORA LIMPE FACIL'),
  ('MY CLEAN', 'Cora', 'Cora', 'BANCO CORA MY CLEAN')
) AS official(company, bank, account_label, display_name)
WHERE a.company = official.company AND a.bank = official.bank
  AND a.account_label = official.account_label;

ALTER TABLE public.bank_accounts ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE public.bank_accounts ADD CONSTRAINT bank_accounts_display_name_valid
  CHECK (length(btrim(display_name)) BETWEEN 1 AND 200);

-- Somente cadastro: nenhuma linha é inserida ou atualizada na tabela de saldos.
INSERT INTO public.bank_accounts(company, bank, account_label, account_type, display_name) VALUES
  ('ECOPLAST', 'Cora', 'Cora', 'BANK', 'BANCO CORA ECO PLAST'),
  ('ECOPLAST', 'Caixa', 'Caixa da empresa', 'CASH', 'CAIXA ECOPLAST'),
  ('LIMPE FÁCIL', 'Caixa', 'Caixa da empresa', 'CASH', 'CAIXA LIMPE FACIL'),
  ('GAMMA', 'Caixa', 'Caixa da empresa', 'CASH', 'CAIXA GAMMA'),
  ('FAST CLEAN', 'Caixa', 'Caixa da empresa', 'CASH', 'CAIXA FAST CLEAN'),
  ('EASY CLEAN', 'Caixa', 'Caixa da empresa', 'CASH', 'CAIXA EASY CLEAN')
ON CONFLICT (company, bank, account_label) DO UPDATE
  SET account_type = EXCLUDED.account_type, display_name = EXCLUDED.display_name;

-- O contrato antigo permanece disponível. Os campos novos distinguem caixa
-- físico de banco e apresentam os nomes oficiais em todas as telas.
CREATE OR REPLACE FUNCTION public.cash_position(p_as_of date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_details boolean; v_accounts jsonb; v_total numeric; v_reported integer; v_expected integer; v_latest date;
  v_negative_count integer; v_coverage numeric;
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
      'account_label', a.account_label, 'account_type', a.account_type, 'display_name', a.display_name,
      'balance_date', p.balance_date, 'amount_cents', p.amount_cents, 'updated_at', p.updated_at)
      ORDER BY a.company, a.bank, a.account_label, a.id), '[]'::jsonb),
    sum(p.amount_cents), count(p.id)::integer, count(a.id)::integer, max(p.balance_date),
    (count(p.id) FILTER (WHERE p.amount_cents < 0))::integer,
    coalesce(sum(-p.amount_cents) FILTER (WHERE p.amount_cents < 0), 0)
  INTO v_accounts, v_total, v_reported, v_expected, v_latest, v_negative_count, v_coverage
  FROM public.bank_accounts a
  LEFT JOIN LATERAL (
    SELECT b.id, b.balance_date, b.amount_cents, b.updated_at FROM public.bank_balance_positions b
    WHERE b.account_id = a.id AND b.balance_date <= p_as_of
    ORDER BY b.balance_date DESC LIMIT 1
  ) p ON true
  WHERE a.enabled;
  -- Cobertura é a soma absoluta dos saldos negativos conhecidos. Saldo positivo
  -- em outra conta não cobre automaticamente um limite utilizado nesta conta.
  -- A necessidade permanece visível mesmo quando faltam outras posições.
  IF v_coverage > 9007199254740991 THEN
    RAISE EXCEPTION 'A cobertura dos saldos negativos excede o limite seguro de representação.' USING ERRCODE = '22003';
  END IF;
  -- Uma soma de bancos pode cancelar outra soma no consolidado. Cada subtotal
  -- deve ser seguro independentemente, inclusive os caixas da mesma empresa.
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
    'latest_position_date', v_latest, 'negative_accounts_count', v_negative_count,
    'coverage_required_cents', v_coverage);
END;
$$;

-- Mantém a validação dinâmica e a transação da posição completa. Acrescenta
-- somente a proteção da soma de cobertura antes de gravar qualquer saldo.
CREATE OR REPLACE FUNCTION public.save_bank_position(
  p_balance_date date, p_positions jsonb, p_observation text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row jsonb; v_account_id uuid; v_amount bigint; v_expected timestamptz;
  v_count integer; v_total numeric; v_actor public.profiles%ROWTYPE;
BEGIN
  -- Mesmo bloqueio de set_bank_balance e da administração de perfis.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('caixa','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_balance_date IS NULL OR p_balance_date < DATE '1900-01-01'
    OR p_balance_date > (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000
    OR p_positions IS NULL OR jsonb_typeof(p_positions) <> 'array' THEN
    RAISE EXCEPTION 'Informe data válida, todas as contas e uma observação de até 1.000 caracteres.' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM public.bank_accounts WHERE enabled ORDER BY id FOR UPDATE;
  SELECT count(*)::integer INTO v_count FROM public.bank_accounts WHERE enabled;
  IF v_count=0 OR jsonb_array_length(p_positions)<>v_count THEN
    RAISE EXCEPTION 'Informe um saldo explícito para cada conta ativa, sem repetir contas.' USING ERRCODE='23514';
  END IF;
  -- Valida o lote inteiro antes de chamar a rotina existente, inclusive precisão.
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_positions) LOOP
    IF jsonb_typeof(v_row)<>'object' THEN
      RAISE EXCEPTION 'Cada conta deve ser um registro com identificador, valor e versão anterior.' USING ERRCODE='23514';
    END IF;
    IF NOT (v_row ?& ARRAY['account_id','amount_cents','expected_updated_at'])
      OR (SELECT count(*) FROM jsonb_object_keys(v_row))<>3
      OR jsonb_typeof(v_row->'account_id')<>'string'
      OR jsonb_typeof(v_row->'amount_cents')<>'number'
      OR (v_row->>'amount_cents') !~ '^-?[0-9]+$'
      OR jsonb_typeof(v_row->'expected_updated_at') NOT IN ('null','string') THEN
      RAISE EXCEPTION 'Cada conta deve informar somente identificador, centavos inteiros e versão anterior.' USING ERRCODE='23514';
    END IF;
    IF (v_row->>'amount_cents')::numeric NOT BETWEEN -9007199254740991 AND 9007199254740991 THEN
      RAISE EXCEPTION 'O saldo de uma conta excede o limite seguro de representação.' USING ERRCODE='22003';
    END IF;
    BEGIN
      v_account_id := (v_row->>'account_id')::uuid;
      IF jsonb_typeof(v_row->'expected_updated_at')='string' THEN
        IF (v_row->>'expected_updated_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
          RAISE invalid_datetime_format;
        END IF;
        v_expected := (v_row->>'expected_updated_at')::timestamptz;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Identificador ou versão da conta inválidos. Atualize a tela.' USING ERRCODE='23514';
    END;
    IF NOT EXISTS(SELECT 1 FROM public.bank_accounts WHERE id=v_account_id AND enabled) THEN
      RAISE EXCEPTION 'Uma das contas está indisponível. Atualize a tela.' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (value->>'account_id')::uuid) FROM jsonb_array_elements(p_positions))<>v_count THEN
    RAISE EXCEPTION 'Há contas repetidas ou ausentes na posição.' USING ERRCODE='23514';
  END IF;
  SELECT sum((value->>'amount_cents')::numeric) INTO v_total FROM jsonb_array_elements(p_positions);
  IF (SELECT coalesce(sum(-(value->>'amount_cents')::numeric) FILTER (
    WHERE (value->>'amount_cents')::numeric < 0),0) FROM jsonb_array_elements(p_positions)) > 9007199254740991 THEN
    RAISE EXCEPTION 'A cobertura dos saldos negativos excede o limite seguro de representação.' USING ERRCODE='22003';
  END IF;
  IF abs(v_total)>9007199254740991 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_positions) r
    JOIN public.bank_accounts a ON a.id=(r.value->>'account_id')::uuid
    GROUP BY a.company HAVING abs(sum((r.value->>'amount_cents')::numeric))>9007199254740991
  ) THEN
    RAISE EXCEPTION 'O total ou subtotal de uma empresa excede o limite seguro de representação.' USING ERRCODE='22003';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_positions) LOOP
    v_expected := CASE WHEN jsonb_typeof(v_row->'expected_updated_at')='null' THEN NULL
      ELSE (v_row->>'expected_updated_at')::timestamptz END;
    PERFORM public.set_bank_balance((v_row->>'account_id')::uuid,p_balance_date,
      (v_row->>'amount_cents')::bigint,btrim(p_observation),v_expected);
  END LOOP;
  -- Uma divergência de versão em qualquer conta reverte todo o lote e a auditoria.
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'caixa','bank_position',p_balance_date::text,'IMPORT',
      jsonb_build_object('position_date',p_balance_date,'total_cents',v_total,'account_count',v_count,
        'observation',btrim(p_observation),'source','MANUAL'));
  RETURN jsonb_build_object('position_date',p_balance_date,'total_cents',v_total,'account_count',v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.cash_position(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_position(date) TO authenticated;
COMMENT ON TABLE public.bank_accounts IS 'Cadastro oficial de contas bancárias e caixas físicos por empresa. Novas contas não recebem saldo automático.';
COMMENT ON COLUMN public.bank_accounts.account_type IS 'BANK = conta bancária; CASH = caixa físico da empresa. Ambos integram a posição de caixa consolidada.';
COMMENT ON COLUMN public.bank_accounts.display_name IS 'Nome oficial de apresentação; não altera empresa, banco, ID ou histórico da conta.';
COMMENT ON FUNCTION public.cash_position(date) IS 'Consolida bancos e caixas ativos, somente com todos os saldos conhecidos. Soma cobertura dos negativos conhecidos sem compensar positivos, inclusive posição incompleta. Detalhes exigem caixa.read.';
INSERT INTO public.central_schema_migrations(version) VALUES ('012_treasury_accounts');
COMMIT;
