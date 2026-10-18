-- CENTRAL FINANCEIRA — ativação incremental de Contas a Pagar (012 a 018).
-- Copie o arquivo inteiro no SQL Editor. Uma transação: falha desfaz toda a ativação.
-- Pode ser executado novamente: pula versões já registradas, sem refazer seeds.
-- Preserva usuários, saldos, títulos, pagamentos, arquivos e históricos existentes.
-- Exige a base online anterior (001/003/004 e 005 a 011). Não executa deploy de funções.
BEGIN;

DO $cf_payables_activation_base$
DECLARE v_version text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('central-financeira:payables-activation',0));
  IF pg_catalog.to_regclass('public.central_schema_migrations') IS NULL
    OR pg_catalog.to_regclass('public.profiles') IS NULL
    OR pg_catalog.to_regclass('public.audit_events') IS NULL
    OR pg_catalog.to_regclass('cf_private.approved_sessions') IS NULL
    OR pg_catalog.to_regclass('public.payable_titles') IS NULL
    OR pg_catalog.to_regclass('public.bank_accounts') IS NULL
    OR pg_catalog.to_regclass('public.director_positions') IS NULL
    OR pg_catalog.to_regclass('public.receivable_titles') IS NULL
    OR pg_catalog.to_regprocedure('cf_private.has_permission(text,text)') IS NULL
    OR pg_catalog.to_regprocedure('public.commit_payables_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,boolean,uuid)') IS NULL THEN
    RAISE EXCEPTION 'A base online anterior está incompleta. Ative as atualizações 001/003/004 e 005 a 011 antes de Contas a Pagar; nenhum dado foi alterado.' USING ERRCODE='22023';
  END IF;
  FOREACH v_version IN ARRAY ARRAY['005_payables','006_treasury','007_director_positions',
    '008_receivables','009_collections','010_bank_import','011_receivables_positions'] LOOP
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version=v_version) THEN
      RAISE EXCEPTION 'A atualização anterior % não está registrada. Confira a base antes de ativar Contas a Pagar; nenhum dado foi alterado.',v_version USING ERRCODE='22023';
    END IF;
  END LOOP;
END;
$cf_payables_activation_base$;

-- SOURCE: 012_treasury_accounts.sql
DO $cf_apply_012_2bd151de882658e6_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='012_treasury_accounts') THEN
    RAISE NOTICE 'Atualização 012_treasury_accounts já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_source_012_899df96cb16364a0_0$
-- SOURCE BODY: 012_treasury_accounts.sql
-- Central Financeira: cadastro oficial ampliado para 12 contas bancárias e 5 caixas.
-- Aplicar uma única vez após 011. Preserva os IDs das contas, saldos e históricos.
-- As seis novas contas começam SEM saldo; zero somente após informação explícita.


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
-- END SOURCE BODY: 012_treasury_accounts.sql
$cf_source_012_899df96cb16364a0_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='012_treasury_accounts') THEN
      RAISE EXCEPTION 'A atualização 012_treasury_accounts não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_apply_012_2bd151de882658e6_0$;

-- SOURCE: 013_director_report.sql
DO $cf_apply_013_f334193a27ecb0a7_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='013_director_report') THEN
    RAISE NOTICE 'Atualização 013_director_report já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_source_013_6e9ab44a4fdb438f_0$
-- SOURCE BODY: 013_director_report.sql
-- Resumo da Diretoria: complementos oficiais diários e fórmula sem M49.
-- Aplicar uma única vez após 012. Não altera posições financeiras ou históricos.


-- A versão anterior incluiu os cinco caixas e a décima segunda conta bancária.
-- Não permitir um relatório aparentemente completo ainda limitado às onze contas.
DO $$
BEGIN
  IF to_regclass('public.central_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Aplique a atualização 012 das contas e caixas antes do Resumo da Diretoria.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='012_treasury_accounts') THEN
    RAISE EXCEPTION 'Aplique a atualização 012 das contas e caixas antes do Resumo da Diretoria.' USING ERRCODE='22023';
  END IF;
END;
$$;

CREATE FUNCTION cf_private.normalize_director_inputs(p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_key text; v_value numeric; v_result jsonb := '{}'::jsonb; v_count integer := 0;
  v_keys text[] := ARRAY['turnover_month_cents','turnover_comlurb_cents','orders_cents',
    'blocked_orders_cents','pending_orders_cents','overdue_comlurb_cents',
    'installments_cents','previous_month_taxes_cents'];
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' OR octet_length(p_values::text)>4096 THEN
    RAISE EXCEPTION 'Informe os indicadores oficiais em centavos.' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_values) k WHERE NOT(k=ANY(v_keys))) THEN
    RAISE EXCEPTION 'Existe um indicador não autorizado.' USING ERRCODE='22023';
  END IF;
  FOREACH v_key IN ARRAY v_keys LOOP
    IF p_values->v_key IS NULL OR jsonb_typeof(p_values->v_key)='null' THEN
      v_result := v_result || jsonb_build_object(v_key,NULL);
    ELSE
      IF jsonb_typeof(p_values->v_key)<>'number' THEN
        RAISE EXCEPTION 'Indicador %: informe um inteiro não negativo em centavos.',v_key USING ERRCODE='22023';
      END IF;
      v_value := (p_values->>v_key)::numeric;
      IF v_value<>trunc(v_value) OR v_value NOT BETWEEN 0 AND 9007199254740991 THEN
        RAISE EXCEPTION 'Indicador %: valor fora do limite de precisão.',v_key USING ERRCODE='22023';
      END IF;
      v_result := v_result || jsonb_build_object(v_key,v_value::bigint);
      v_count := v_count+1;
    END IF;
  END LOOP;
  IF v_count=0 THEN
    RAISE EXCEPTION 'Informe ao menos um indicador; campo vazio permanece desconhecido.' USING ERRCODE='22023';
  END IF;
  IF (v_result->>'turnover_month_cents')::numeric+(v_result->>'turnover_comlurb_cents')::numeric>9007199254740991 THEN
    RAISE EXCEPTION 'O faturamento geral excede o limite de precisão.' USING ERRCODE='22003';
  END IF;
  RETURN v_result;
END;
$$;

CREATE TABLE public.director_report_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_date date NOT NULL CHECK (reference_date>=DATE '1900-01-01'),
  values jsonb NOT NULL CHECK (values=cf_private.normalize_director_inputs(values)),
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT
);
CREATE INDEX director_report_inputs_latest
  ON public.director_report_inputs(reference_date DESC,created_at DESC,id DESC);
ALTER TABLE public.director_report_inputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.director_report_inputs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.director_report_inputs TO authenticated;
CREATE POLICY director_report_inputs_read ON public.director_report_inputs FOR SELECT TO authenticated
  USING(cf_private.has_permission('resumo_diretoria','read'));

CREATE FUNCTION cf_private.block_director_history_changes() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'O histórico da Diretoria é imutável. Registre uma nova posição.' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER director_report_inputs_append_only BEFORE UPDATE OR DELETE ON public.director_report_inputs
  FOR EACH ROW EXECUTE FUNCTION cf_private.block_director_history_changes();
CREATE TRIGGER director_positions_append_only BEFORE UPDATE OR DELETE ON public.director_positions
  FOR EACH ROW EXECUTE FUNCTION cf_private.block_director_history_changes();

CREATE FUNCTION public.read_director_inputs(p_reference_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.director_report_inputs%ROWTYPE;
BEGIN
  IF NOT cf_private.has_permission('resumo_diretoria','read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01'
    OR p_reference_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'Informe uma data até hoje em São Paulo.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_row FROM public.director_report_inputs WHERE reference_date=p_reference_date
    ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_row.id IS NULL THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE FUNCTION public.save_director_inputs(
  p_reference_date date,p_values jsonb,p_observation text,p_expected_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.director_report_inputs%ROWTYPE;v_new public.director_report_inputs%ROWTYPE;
  v_values jsonb;v_actor public.profiles%ROWTYPE;
BEGIN
  -- Ordem igual à administração de perfis e à gravação das posições oficiais.
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('resumo_diretoria','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_reference_date IS NULL OR p_reference_date<DATE '1900-01-01'
    OR p_reference_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe uma data até hoje e uma observação de até 1.000 caracteres.' USING ERRCODE='22023';
  END IF;
  v_values := cf_private.normalize_director_inputs(p_values);
  PERFORM pg_advisory_xact_lock(2045812307);
  SELECT * INTO v_previous FROM public.director_report_inputs WHERE reference_date=p_reference_date
    ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous.id IS DISTINCT FROM p_expected_id THEN
    RAISE EXCEPTION 'Os indicadores foram atualizados. Recarregue antes de salvar.' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.director_report_inputs(reference_date,values,observation,created_by,created_at)
    VALUES(p_reference_date,v_values,btrim(p_observation),auth.uid(),
      greatest(clock_timestamp(),v_previous.created_at+interval '1 microsecond')) RETURNING * INTO v_new;
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'resumo_diretoria','director_report_inputs',v_new.id::text,
      CASE WHEN v_previous.id IS NULL THEN 'CREATE' ELSE 'UPDATE' END,
      CASE WHEN v_previous.id IS NULL THEN NULL ELSE to_jsonb(v_previous) END,to_jsonb(v_new));
  RETURN v_new.id;
END;
$$;

CREATE FUNCTION public.director_report(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_date date := (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_inputs jsonb;v_values jsonb;v_cash jsonb;v_stock jsonb;v_cp jsonb;v_cr jsonb;v_data jsonb;
  v_turnover numeric;v_merchandise numeric;v_projected numeric;v_assets numeric;v_comlurb numeric;
  v_missing jsonb := '[]'::jsonb;v_field text;v_label text;
BEGIN
  IF NOT cf_private.has_permission('resumo_diretoria','read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end<p_start OR p_end-p_start>366 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  -- A posição gerencial é a de hoje, mesmo quando o fluxo selecionado é histórico.
  -- Complementos de uma data anterior NÃO são promovidos silenciosamente para hoje.
  v_inputs := public.read_director_inputs(v_date);
  v_values := v_inputs->'values';
  v_cash := public.cash_position(v_date);
  v_stock := public.current_stock();
  v_cp := public.payables_summary(p_start,p_end);
  v_cr := public.receivables_summary(p_start,p_end);
  v_turnover := (v_values->>'turnover_month_cents')::numeric+(v_values->>'turnover_comlurb_cents')::numeric;
  IF v_cp->>'latest_import_at' IS NOT NULL THEN
    SELECT coalesce(sum(amount_cents),0) INTO v_merchandise FROM public.payable_titles
      WHERE scope='grupo-consolidado' AND status IN ('NEW','OPEN') AND macro='COMPRA DE MERCADORIA';
    IF v_merchandise>9007199254740991 THEN
      RAISE EXCEPTION 'O pagamento de mercadoria excede o limite de precisão.' USING ERRCODE='22003';
    END IF;
  END IF;
  IF v_cash->>'total_cents' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Caixa: informe todas as contas.'); END IF;
  IF v_stock->>'value_cents' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Estoque aguardando atualização.'); END IF;
  IF v_cp->>'latest_import_at' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Contas a Pagar: importe o relatório completo.'); END IF;
  IF v_cr->>'latest_import_at' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Contas a Receber: importe o relatório completo.'); END IF;
  FOR v_field,v_label IN SELECT * FROM (VALUES
    ('turnover_month_cents','Faturamento mês'),('turnover_comlurb_cents','Faturamento COMLURB'),
    ('orders_cents','Valor de pedido em sistema'),('blocked_orders_cents','Valor de pedidos bloqueados'),
    ('pending_orders_cents','Valor total pendência'),('overdue_comlurb_cents','Atrasado COMLURB'),
    ('installments_cents','Parcelamentos'),('previous_month_taxes_cents','Impostos do mês passado')
  ) AS fields(field,label) LOOP
    IF v_values->>v_field IS NULL THEN
      v_missing:=v_missing||jsonb_build_array(v_label||': informe a posição de hoje.');
    END IF;
  END LOOP;
  v_comlurb := (v_values->>'overdue_comlurb_cents')::numeric;
  IF v_comlurb IS NOT NULL AND v_cr->>'latest_import_at' IS NOT NULL AND v_comlurb>(v_cr->>'overdue_cents')::numeric THEN
    v_comlurb := NULL;
    v_missing:=v_missing||jsonb_build_array('Atrasado COMLURB excede o total atrasado; revise o complemento.');
  ELSIF v_cr->>'latest_import_at' IS NULL THEN
    v_comlurb := NULL;
  END IF;
  IF v_cash->>'total_cents' IS NOT NULL AND v_cp->>'latest_import_at' IS NOT NULL
    AND v_cr->>'latest_import_at' IS NOT NULL THEN
    v_projected:=(v_cash->>'total_cents')::numeric+(v_cr->>'period_cents')::numeric-(v_cp->>'period_cents')::numeric;
    IF abs(v_projected)>9007199254740991 THEN
      RAISE EXCEPTION 'A projeção excede o limite de precisão.' USING ERRCODE='22003';
    END IF;
  END IF;
  -- Centavos / 100.000.000 = milhões de reais. O fator 14/100 é numeric
  -- exato e pode produzir fração de centavo; não arredondar etapas da fórmula.
  IF v_cr->>'latest_import_at' IS NOT NULL THEN
    v_assets := ((v_cash->>'total_cents')::numeric+(v_cr->>'open_cents')::numeric+(v_stock->>'value_cents')::numeric
      -(v_values->>'previous_month_taxes_cents')::numeric-v_turnover*14/100
      -v_merchandise-(v_values->>'installments_cents')::numeric)/100000000;
  END IF;
  v_data:=jsonb_build_object(
    'turnover_month_cents',v_values->'turnover_month_cents','turnover_comlurb_cents',v_values->'turnover_comlurb_cents',
    'turnover_cents',v_turnover,'orders_cents',v_values->'orders_cents',
    'blocked_orders_cents',v_values->'blocked_orders_cents','pending_orders_cents',v_values->'pending_orders_cents',
    'cash_cents',v_cash->'total_cents','cash_reported_accounts',v_cash->'reported_accounts',
    'cash_expected_accounts',v_cash->'expected_accounts','cash_as_of_date',v_date,
    'payable_open_cents',CASE WHEN v_cp->>'latest_import_at' IS NULL THEN NULL ELSE v_cp->'open_cents' END,
    'payable_period_cents',CASE WHEN v_cp->>'latest_import_at' IS NULL THEN NULL ELSE v_cp->'period_cents' END,
    'payable_overdue_cents',CASE WHEN v_cp->>'latest_import_at' IS NULL THEN NULL ELSE v_cp->'overdue_cents' END,
    'payable_import_at',v_cp->'latest_import_at',
    'stock_cents',v_stock->'value_cents','stock_reference_date',v_stock->'reference_date','stock_source',v_stock->'source',
    'receivable_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'open_cents' END,
    'receivable_period_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'period_cents' END,
    'receivable_overdue_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'overdue_cents' END,
    'receivable_overdue_bps',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'overdue_bps' END,
    'receivable_overdue_comlurb_cents',v_comlurb,
    'receivable_received_period_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'received_period_cents' END,
    'receivable_import_at',v_cr->'latest_import_at',
    'merchandise_cents',v_merchandise,'installments_cents',v_values->'installments_cents',
    'previous_month_taxes_cents',v_values->'previous_month_taxes_cents',
    'projected_cash_cents',v_projected,'current_assets_millions',trim_scale(v_assets)::text,
    'formula_version','2026-10-sem-m49','complete',jsonb_array_length(v_missing)=0,'missing_sources',v_missing,
    'report_input_id',v_inputs->'id','report_input_reference_date',v_inputs->'reference_date',
    'previous_taxes_month',to_char(v_date-interval '1 month','YYYY-MM'));
  RETURN jsonb_build_object('as_of_date',v_date,'inputs',v_inputs,'indicators',v_data,
    'cash',v_cash,'stock',v_stock,'missing_sources',v_missing,'complete',jsonb_array_length(v_missing)=0,
    'formula_version','2026-10-sem-m49');
END;
$$;

ALTER TABLE public.director_positions ALTER COLUMN schema_version SET DEFAULT '0.6.0';
CREATE OR REPLACE FUNCTION public.save_director_position(p_start date,p_end date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_report jsonb;v_data jsonb;v_id uuid;v_actor public.profiles%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('resumo_diretoria','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(2045812307);
  v_report := public.director_report(p_start,p_end);
  v_data := (v_report->'indicators')||jsonb_build_object(
    'cash_accounts',v_report->'cash'->'accounts','report_inputs',v_report->'inputs');
  INSERT INTO public.director_positions(created_by,period_start,period_end,indicators,schema_version)
    VALUES(auth.uid(),p_start,p_end,v_data,'0.6.0') RETURNING id INTO v_id;
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'resumo_diretoria','director_positions',v_id::text,'CREATE',
      jsonb_build_object('period_start',p_start,'period_end',p_end,'indicators',v_data,'schema_version','0.6.0'));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION cf_private.normalize_director_inputs(jsonb),cf_private.block_director_history_changes()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.read_director_inputs(date),public.save_director_inputs(date,jsonb,text,uuid),
  public.director_report(date,date),public.save_director_position(date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_director_inputs(date),public.save_director_inputs(date,jsonb,text,uuid),
  public.director_report(date,date),public.save_director_position(date,date) TO authenticated;
COMMENT ON TABLE public.director_report_inputs IS 'Complementos oficiais manuais da Diretoria por data; revisões imutáveis e auditadas, sem carregar valores antigos para hoje.';
COMMENT ON FUNCTION public.director_report(date,date) IS 'Fórmula oficial sem M49: (caixa + CR + estoque - impostos do mês passado - faturamento geral * 0,14 - mercadoria - parcelamentos) / 1.000.000. Valores ausentes permanecem null.';
INSERT INTO public.central_schema_migrations(version) VALUES('013_director_report');
-- END SOURCE BODY: 013_director_report.sql
$cf_source_013_6e9ab44a4fdb438f_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='013_director_report') THEN
      RAISE EXCEPTION 'A atualização 013_director_report não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_apply_013_f334193a27ecb0a7_0$;

-- SOURCE: 014_payables_forecast.sql
DO $cf_apply_014_722dba4c433173a4_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='014_payables_forecast') THEN
    RAISE NOTICE 'Atualização 014_payables_forecast já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_source_014_de7cc203e82e26a4_0$
-- SOURCE BODY: 014_payables_forecast.sql
-- Contas a Pagar: oito semanas sábado/sexta e previsões fixas sem duplicidade.
-- Incremental: requer 005 e o registro de versões instalado em 007; não requer 013.
-- Não cria lançamentos, não modifica importações e não recalcula posições salvas.

DO $$ BEGIN
  IF to_regclass('public.central_schema_migrations') IS NULL OR to_regclass('public.payable_titles') IS NULL THEN
    RAISE EXCEPTION 'Ative Contas a Pagar (005 a 007) antes desta atualização.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='005_payables') THEN
    RAISE EXCEPTION 'Ative Contas a Pagar (005 a 007) antes desta atualização.' USING ERRCODE='22023';
  END IF;
END $$;

CREATE TABLE public.payable_forecast_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL CHECK(rule_key IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS')),
  label text NOT NULL,
  macro text NOT NULL REFERENCES public.payable_macros(name),
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 0 AND 9007199254740991),
  day_of_month integer NOT NULL CHECK(day_of_month BETWEEN 1 AND 28),
  effective_from date NOT NULL CHECK(effective_from>=DATE '1900-01-01'),
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  CHECK(macro=CASE WHEN rule_key IN ('SALARIOS','SALARIOS_SOCIOS') THEN 'SALÁRIOS' ELSE 'ADIANTAMENTO' END)
);
CREATE INDEX payable_forecast_rules_latest ON public.payable_forecast_rules(rule_key,effective_from DESC,created_at DESC,id DESC);
-- Valores e dias recuperados da versão anterior. Vigência inicia hoje, sem histórico inventado.
INSERT INTO public.payable_forecast_rules(rule_key,label,macro,amount_cents,day_of_month,effective_from,observation) VALUES
 ('SALARIOS','Salários','SALÁRIOS',4600000,5,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'Configuração inicial preservada da Central V75.'),
 ('SALARIOS_SOCIOS','Salários Sócios','SALÁRIOS',3300000,5,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'Configuração inicial preservada da Central V75.'),
 ('ADIANTAMENTO','Adiantamento','ADIANTAMENTO',2300000,20,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'Configuração inicial preservada da Central V75.'),
 ('ADIANTAMENTO_SOCIOS','Adiantamento Sócios','ADIANTAMENTO',3300000,20,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'Configuração inicial preservada da Central V75.');

CREATE TABLE public.payable_forecast_plan_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan text NOT NULL REFERENCES public.payable_plan_mappings(plan) ON DELETE RESTRICT,
  rule_key text CHECK(rule_key IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS')),
  effective_from date NOT NULL CHECK(effective_from>=DATE '1900-01-01'),
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT
);
CREATE INDEX payable_forecast_bindings_latest ON public.payable_forecast_plan_bindings(plan,effective_from DESC,created_at DESC,id DESC);
CREATE TABLE public.payable_forecast_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL CHECK(rule_key IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS')),
  month date NOT NULL CHECK(month=date_trunc('month',month)::date),
  done boolean NOT NULL,
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT
);
CREATE INDEX payable_forecast_completions_latest ON public.payable_forecast_completions(rule_key,month,created_at DESC,id DESC);

CREATE FUNCTION cf_private.block_payable_forecast_history() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
  RAISE EXCEPTION 'O histórico das previsões é imutável. Registre uma nova revisão.' USING ERRCODE='42501';
END $$;
CREATE FUNCTION cf_private.audit_payable_forecast_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;v_before jsonb;v_action text;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  IF TG_TABLE_NAME='payable_forecast_rules' THEN
    SELECT to_jsonb(r) INTO v_before FROM public.payable_forecast_rules r WHERE r.rule_key=NEW.rule_key AND r.id<>NEW.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
  ELSIF TG_TABLE_NAME='payable_forecast_plan_bindings' THEN
    SELECT to_jsonb(r) INTO v_before FROM public.payable_forecast_plan_bindings r WHERE r.plan=NEW.plan AND r.id<>NEW.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
  ELSE
    SELECT to_jsonb(r) INTO v_before FROM public.payable_forecast_completions r WHERE r.rule_key=NEW.rule_key AND r.month=NEW.month AND r.id<>NEW.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
  END IF;
  IF TG_TABLE_NAME='payable_forecast_completions' THEN v_action:=CASE WHEN NEW.done THEN 'VALIDATE' ELSE 'REOPEN' END;
  ELSE v_action:=CASE WHEN v_before IS NULL THEN 'CREATE' ELSE 'UPDATE' END; END IF;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar',TG_TABLE_NAME,NEW.id::text,v_action,v_before,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER payable_forecast_rule_immutable BEFORE UPDATE OR DELETE ON public.payable_forecast_rules
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_forecast_history();
CREATE TRIGGER payable_forecast_binding_immutable BEFORE UPDATE OR DELETE ON public.payable_forecast_plan_bindings
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_forecast_history();
CREATE TRIGGER payable_forecast_completion_immutable BEFORE UPDATE OR DELETE ON public.payable_forecast_completions
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_forecast_history();
CREATE TRIGGER payable_forecast_rule_audit AFTER INSERT ON public.payable_forecast_rules
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_forecast_revision();
CREATE TRIGGER payable_forecast_binding_audit AFTER INSERT ON public.payable_forecast_plan_bindings
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_forecast_revision();
CREATE TRIGGER payable_forecast_completion_audit AFTER INSERT ON public.payable_forecast_completions
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_forecast_revision();
ALTER TABLE public.payable_forecast_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_forecast_plan_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_forecast_completions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payable_forecast_rules,public.payable_forecast_plan_bindings,public.payable_forecast_completions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_forecast_rules,public.payable_forecast_plan_bindings,public.payable_forecast_completions TO authenticated;
CREATE POLICY payable_forecast_rules_read ON public.payable_forecast_rules FOR SELECT TO authenticated USING(cf_private.has_permission('contas_pagar','read'));
CREATE POLICY payable_forecast_bindings_read ON public.payable_forecast_plan_bindings FOR SELECT TO authenticated USING(cf_private.has_permission('contas_pagar','read'));
CREATE POLICY payable_forecast_completions_read ON public.payable_forecast_completions FOR SELECT TO authenticated USING(cf_private.has_permission('contas_pagar','read'));

CREATE FUNCTION public.save_payable_forecast_rule(p_rule_key text,p_amount_cents bigint,p_day_of_month integer,
 p_effective_from date,p_observation text,p_expected_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.payable_forecast_rules%ROWTYPE;v_cycle public.payable_forecast_rules%ROWTYPE;v_id uuid;v_month date;
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.is_manager() OR NOT cf_private.has_permission('contas_pagar','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_rule_key IS NULL OR p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 0 AND 9007199254740991
    OR p_day_of_month IS NULL OR p_day_of_month NOT BETWEEN 1 AND 28 OR p_effective_from IS NULL
    OR p_effective_from<v_today OR p_effective_from>v_today+366 OR p_observation IS NULL
    OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe valor em centavos, dia de 1 a 28, vigência a partir de hoje e observação.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812308);
  SELECT * INTO v_previous FROM public.payable_forecast_rules WHERE rule_key=p_rule_key ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous.id IS NULL THEN RAISE EXCEPTION 'Previsão inexistente.' USING ERRCODE='22023'; END IF;
  IF v_previous.id IS DISTINCT FROM p_expected_id THEN RAISE EXCEPTION 'A regra mudou. Atualize antes de salvar.' USING ERRCODE='40001'; END IF;
  IF p_effective_from<v_previous.effective_from THEN
    RAISE EXCEPTION 'A vigência não pode anteceder a última revisão. Corrija a partir dessa data ou de um mês posterior.' USING ERRCODE='22023'; END IF;
  v_month:=date_trunc('month',p_effective_from)::date;
  SELECT * INTO v_cycle FROM public.payable_forecast_rules r WHERE r.rule_key=p_rule_key
    AND r.effective_from<=v_month+(r.day_of_month-1) ORDER BY r.effective_from DESC,r.created_at DESC,r.id DESC LIMIT 1;
  -- Mesmo na ativação inicial, o dia histórico do ciclo não pode reaparecer
  -- mais tarde no mesmo mês por alteração de regra. Escolha o próximo mês.
  IF v_cycle.id IS NULL THEN v_cycle:=v_previous; END IF;
  IF p_effective_from>v_month+(v_cycle.day_of_month-1) THEN
    RAISE EXCEPTION 'O dia previsto desse ciclo já passou na data de vigência. Escolha o primeiro dia do mês seguinte para preservar o ciclo.' USING ERRCODE='22023'; END IF;
  INSERT INTO public.payable_forecast_rules(rule_key,label,macro,amount_cents,day_of_month,effective_from,observation,created_by,created_at)
    VALUES(p_rule_key,v_previous.label,v_previous.macro,p_amount_cents,p_day_of_month,p_effective_from,btrim(p_observation),auth.uid(),
      greatest(clock_timestamp(),v_previous.created_at+interval '1 microsecond')) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.map_payable_forecast_plan(p_plan text,p_rule_key text,p_effective_from date,
 p_observation text,p_expected_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_plan text;v_macro text;v_previous public.payable_forecast_plan_bindings%ROWTYPE;v_id uuid;
 v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.has_permission('contas_pagar','write') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  v_plan:=cf_private.normalize_payable_plan(p_plan);
  SELECT macro INTO v_macro FROM public.payable_plan_mappings WHERE plan=v_plan;
  IF v_macro IS NULL OR (p_rule_key IS NOT NULL AND (p_rule_key NOT IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS')
    OR v_macro IS DISTINCT FROM CASE WHEN p_rule_key IN ('SALARIOS','SALARIOS_SOCIOS') THEN 'SALÁRIOS' ELSE 'ADIANTAMENTO' END))
    OR p_effective_from IS NULL OR p_effective_from<v_today OR p_effective_from>v_today+366
    OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Escolha um plano conhecido, uma previsão do mesmo macro (ou nenhuma), vigência e observação.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812308);
  SELECT * INTO v_previous FROM public.payable_forecast_plan_bindings WHERE plan=v_plan ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous.id IS DISTINCT FROM p_expected_id THEN RAISE EXCEPTION 'O vínculo mudou. Atualize antes de salvar.' USING ERRCODE='40001'; END IF;
  INSERT INTO public.payable_forecast_plan_bindings(plan,rule_key,effective_from,observation,created_by,created_at)
    VALUES(v_plan,p_rule_key,p_effective_from,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),v_previous.created_at+interval '1 microsecond'))
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.set_payable_forecast_completion(p_rule_key text,p_month date,p_done boolean,
 p_observation text,p_expected_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.payable_forecast_completions%ROWTYPE;v_id uuid;
 v_month date:=date_trunc('month',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date)::date;
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.has_permission('contas_pagar','write') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_rule_key IS NULL OR p_rule_key NOT IN ('SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS') OR p_month IS NULL
    OR p_month<>date_trunc('month',p_month)::date OR p_month<v_month OR p_month>(v_month+interval '1 year')::date
    OR p_done IS NULL OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe a previsão, um mês atual ou futuro e o motivo da conclusão/reabertura.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812308);
  SELECT * INTO v_previous FROM public.payable_forecast_completions WHERE rule_key=p_rule_key AND month=p_month ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_previous.id IS DISTINCT FROM p_expected_id THEN RAISE EXCEPTION 'A conclusão mudou. Atualize antes de salvar.' USING ERRCODE='40001'; END IF;
  INSERT INTO public.payable_forecast_completions(rule_key,month,done,observation,created_by,created_at)
    VALUES(p_rule_key,p_month,p_done,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),v_previous.created_at+interval '1 microsecond'))
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Cálculo interno: não é uma rota de leitura alternativa às permissões do RPC.
CREATE FUNCTION cf_private.payable_forecast_provision(p_rule_key text,p_month date,p_imported boolean) RETURNS jsonb
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
  IF EXISTS(SELECT 1 FROM public.payable_titles t LEFT JOIN LATERAL(
      SELECT b.id FROM public.payable_forecast_plan_bindings b WHERE b.plan=t.plan AND b.effective_from<=v_due
        ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON true
    WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.macro=v_rule.macro AND b.id IS NULL) THEN
    v_issues:=v_issues||jsonb_build_array('Vincule os planos deste macro à previsão correta ou a nenhuma previsão.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.payable_titles t JOIN LATERAL(
      SELECT b.rule_key FROM public.payable_forecast_plan_bindings b WHERE b.plan=t.plan AND b.effective_from<=v_due
        ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON b.rule_key=p_rule_key
    WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.macro<>v_rule.macro) THEN
    v_issues:=v_issues||jsonb_build_array('O macro do título mudou; revise o vínculo da previsão.');
  END IF;
  -- Inclui quitados para não ressuscitar a previsão depois da baixa por importação.
  SELECT coalesce(sum(t.amount_cents),0) INTO v_actual FROM public.payable_titles t JOIN LATERAL(
    SELECT b.rule_key FROM public.payable_forecast_plan_bindings b WHERE b.plan=t.plan AND b.effective_from<=v_due
      ORDER BY b.effective_from DESC,b.created_at DESC,b.id DESC LIMIT 1) b ON b.rule_key=p_rule_key
    WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.macro=v_rule.macro;
  IF v_actual>9007199254740991 THEN RAISE EXCEPTION 'O realizado mensal excede o limite de precisão.' USING ERRCODE='22003'; END IF;
  IF EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date
      AND EXISTS(SELECT 1 FROM public.payable_titles selected JOIN LATERAL(
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

CREATE FUNCTION public.payables_forecast(p_start date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_current date;v_start date;v_week date;v_end date;v_month date;v_key text;v_provision jsonb;
 v_latest public.payable_imports%ROWTYPE;v_rules jsonb;v_plans jsonb;v_weeks jsonb:='[]'::jsonb;v_provisions jsonb;v_macros jsonb;
 v_real numeric;v_estimate numeric;v_known numeric;v_total numeric;v_cheques numeric;v_count integer;v_cheque_count integer;
 v_missing jsonb:='[]'::jsonb;v_window numeric:=0;v_i integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  v_current:=v_today-((extract(dow FROM v_today)::integer+1)%7);v_start:=coalesce(p_start,v_current);
  IF v_start<v_current OR v_start>v_current+366 OR extract(dow FROM v_start)<>6 THEN
    RAISE EXCEPTION 'Escolha um sábado da semana atual até um ano à frente.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_latest FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_latest.id IS NULL THEN v_missing:=jsonb_build_array('Importe o relatório completo de Contas a Pagar.'); END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.day_of_month,r.rule_key),'[]'::jsonb) INTO v_rules
    FROM(SELECT DISTINCT ON(rule_key) * FROM public.payable_forecast_rules ORDER BY rule_key,created_at DESC,id DESC) r;
  SELECT coalesce(jsonb_agg(jsonb_build_object('plan',m.plan,'macro',m.macro,'rule_key',b.rule_key,
    'mapping_id',b.id,'configured',b.id IS NOT NULL,'effective_from',b.effective_from) ORDER BY m.plan),'[]'::jsonb) INTO v_plans
    FROM public.payable_plan_mappings m LEFT JOIN LATERAL(
      SELECT * FROM public.payable_forecast_plan_bindings b WHERE b.plan=m.plan ORDER BY created_at DESC,id DESC LIMIT 1) b ON true
    WHERE m.macro IN ('SALÁRIOS','ADIANTAMENTO') OR b.id IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.plan=m.plan AND t.macro IN ('SALÁRIOS','ADIANTAMENTO')
        AND t.due_date>=date_trunc('month',v_start)::date
        AND t.due_date<(date_trunc('month',v_start+55)+interval '1 month')::date);
  FOR v_i IN 0..7 LOOP
    v_week:=v_start+v_i*7;v_end:=v_week+6;v_provisions:='[]'::jsonb;
    FOR v_month IN SELECT d::date FROM generate_series(date_trunc('month',v_week),date_trunc('month',v_end),interval '1 month') d LOOP
      FOREACH v_key IN ARRAY ARRAY['SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS'] LOOP
        v_provision:=cf_private.payable_forecast_provision(v_key,v_month,v_latest.id IS NOT NULL);
        IF v_provision IS NOT NULL AND (v_provision->>'due_date')::date BETWEEN v_week AND v_end THEN
          v_provisions:=v_provisions||jsonb_build_array(v_provision);
          IF v_provision->>'remaining_cents' IS NULL THEN v_missing:=v_missing||(v_provision->'issues'); END IF;
        END IF;
      END LOOP;
    END LOOP;
    SELECT coalesce(sum(amount_cents),0),count(*)::integer,coalesce(sum(amount_cents) FILTER(WHERE upper(btrim(source_status))='CHEQUE'),0),
      (count(*) FILTER(WHERE upper(btrim(source_status))='CHEQUE'))::integer INTO v_real,v_count,v_cheques,v_cheque_count
      FROM public.payable_titles WHERE scope='grupo-consolidado' AND status IN ('NEW','OPEN') AND due_date BETWEEN v_week AND v_end;
    SELECT coalesce(sum((p->>'remaining_cents')::numeric),0),
      CASE WHEN count(*) FILTER(WHERE p->>'remaining_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((p->>'remaining_cents')::numeric),0) END
      INTO v_known,v_estimate FROM jsonb_array_elements(v_provisions) p;
    IF v_latest.id IS NULL THEN v_real:=NULL;v_estimate:=NULL;v_cheques:=NULL; END IF;
    v_total:=v_real+v_estimate;v_window:=v_window+coalesce(v_real,0)+v_known;
    IF greatest(coalesce(v_real,0),v_known,coalesce(v_total,0),coalesce(v_cheques,0),v_window)>9007199254740991 THEN
      RAISE EXCEPTION 'A previsão excede o limite de precisão.' USING ERRCODE='22003'; END IF;
    SELECT jsonb_agg(jsonb_build_object('macro',m.name,'real_cents',CASE WHEN v_latest.id IS NOT NULL THEN coalesce(t.real_cents,0) ELSE NULL END,
      'estimated_cents',CASE WHEN v_latest.id IS NULL OR coalesce(p.pending,false) THEN NULL ELSE coalesce(p.estimated_cents,0) END,
      'total_cents',CASE WHEN v_latest.id IS NULL OR coalesce(p.pending,false) THEN NULL ELSE coalesce(t.real_cents,0)+coalesce(p.estimated_cents,0) END) ORDER BY m.name)
      INTO v_macros FROM public.payable_macros m
      LEFT JOIN(SELECT macro,sum(amount_cents) real_cents FROM public.payable_titles WHERE scope='grupo-consolidado' AND status IN ('NEW','OPEN')
        AND due_date BETWEEN v_week AND v_end GROUP BY macro) t ON t.macro=m.name
      LEFT JOIN(SELECT p->>'macro' macro,sum((p->>'remaining_cents')::numeric) estimated_cents,bool_or(p->>'remaining_cents' IS NULL) pending
        FROM jsonb_array_elements(v_provisions) p GROUP BY p->>'macro') p ON p.macro=m.name;
    v_weeks:=v_weeks||jsonb_build_array(jsonb_build_object('start',v_week,'end',v_end,'real_cents',v_real,'estimated_cents',v_estimate,
      'known_estimated_cents',v_known,'total_cents',v_total,'cheques_cents',v_cheques,'cheque_count',v_cheque_count,'title_count',v_count,
      'macros',v_macros,'provisions',v_provisions));
  END LOOP;
  SELECT coalesce(jsonb_agg(issue ORDER BY issue),'[]'::jsonb) INTO v_missing FROM(SELECT DISTINCT value issue FROM jsonb_array_elements(v_missing)) x;
  RETURN jsonb_build_object('as_of_date',v_today,'start_date',v_start,'end_date',v_start+55,
    'latest_import_id',v_latest.id,'latest_import_at',v_latest.created_at,'weeks',v_weeks,'rules',v_rules,'plans',v_plans,'missing_sources',v_missing);
END $$;

REVOKE ALL ON FUNCTION cf_private.block_payable_forecast_history(),cf_private.audit_payable_forecast_revision(),
 cf_private.payable_forecast_provision(text,date,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.save_payable_forecast_rule(text,bigint,integer,date,text,uuid),
 public.map_payable_forecast_plan(text,text,date,text,uuid),public.set_payable_forecast_completion(text,date,boolean,text,uuid),
 public.payables_forecast(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_payable_forecast_rule(text,bigint,integer,date,text,uuid),
 public.map_payable_forecast_plan(text,text,date,text,uuid),public.set_payable_forecast_completion(text,date,boolean,text,uuid),
 public.payables_forecast(date) TO authenticated;
COMMENT ON FUNCTION public.payables_forecast(date) IS 'Oito semanas sábado/sexta. Previsões reduzem pelo realizado mensal vinculado, inclusive quitados; planos sem vínculo e chaves ambíguas exigem conferência. Cheques integram os reais, sem soma em duplicidade.';
COMMENT ON COLUMN public.payable_forecast_plan_bindings.rule_key IS 'NULL com revisão existente significa decisão explícita: este plano não reduz nenhuma previsão. Ausência de vínculo não significa NULL configurado.';
INSERT INTO public.central_schema_migrations(version) VALUES('014_payables_forecast');
-- END SOURCE BODY: 014_payables_forecast.sql
$cf_source_014_de7cc203e82e26a4_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='014_payables_forecast') THEN
      RAISE EXCEPTION 'A atualização 014_payables_forecast não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_apply_014_722dba4c433173a4_0$;

-- SOURCE: 015_payable_payments.sql
DO $cf_apply_015_dc64e65bff817126_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='015_payable_payments') THEN
    RAISE NOTICE 'Atualização 015_payable_payments já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_source_015_74ecbc6222d33785_0$
-- SOURCE BODY: 015_payable_payments.sql
-- Contas a Pagar: pagamentos financeiros com data, valor efetivo e conta oficial.
-- Incremental após 013 e 014. Preserva títulos, importações e posições bancárias.
-- A ausência em um relatório completo continua distinta de pagamento confirmado.

DO $$ BEGIN
  IF to_regclass('public.central_schema_migrations') IS NULL OR to_regclass('public.bank_accounts') IS NULL THEN
    RAISE EXCEPTION 'Ative Caixa/Bancos e Contas a Pagar antes desta atualização.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='013_director_report')
    OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='014_payables_forecast') THEN
    RAISE EXCEPTION 'Ative as atualizações 013 e 014 antes dos pagamentos de Contas a Pagar.' USING ERRCODE='22023';
  END IF;
END $$;

CREATE TABLE cf_private.payable_payment_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO cf_private.payable_payment_state(singleton) VALUES(true);
REVOKE ALL ON TABLE cf_private.payable_payment_state FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.payable_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id uuid NOT NULL REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL UNIQUE,
  event_revision bigint NOT NULL UNIQUE CHECK(event_revision>0),
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  paid_on date NOT NULL CHECK(paid_on>=DATE '1900-01-01'),
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  bank_label text NOT NULL,
  bank_company text NOT NULL,
  bank_name text NOT NULL,
  account_type text NOT NULL CHECK(account_type IN ('BANK','CASH')),
  macro_snapshot text NOT NULL REFERENCES public.payable_macros(name) ON DELETE RESTRICT,
  entry_number text NOT NULL,
  description text NOT NULL,
  branch text NOT NULL,
  plan_snapshot text NOT NULL,
  due_date date NOT NULL,
  title_amount_cents bigint NOT NULL CHECK(title_amount_cents BETWEEN 0 AND 9007199254740991),
  expected_revision uuid,
  expected_import_id uuid NOT NULL,
  observation text NOT NULL CHECK(length(btrim(observation))<=1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_payments_title ON public.payable_payments(title_id,event_revision DESC);
CREATE INDEX payable_payments_date_macro ON public.payable_payments(paid_on,macro_snapshot,id);
CREATE INDEX payable_payments_bank_date ON public.payable_payments(bank_account_id,paid_on,id);
CREATE TABLE public.payable_payment_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES public.payable_payments(id) ON DELETE RESTRICT,
  event_revision bigint NOT NULL UNIQUE CHECK(event_revision>0),
  observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.payable_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_payment_reversals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payable_payments,public.payable_payment_reversals FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_payments,public.payable_payment_reversals TO authenticated;
CREATE POLICY payable_payments_read ON public.payable_payments FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_pagar','read'));
CREATE POLICY payable_payment_reversals_read ON public.payable_payment_reversals FOR SELECT TO authenticated
 USING(cf_private.has_permission('contas_pagar','read'));

CREATE FUNCTION cf_private.block_payable_payment_history() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
  RAISE EXCEPTION 'O histórico dos pagamentos é imutável. Registre um estorno com motivo.' USING ERRCODE='42501';
END $$;
CREATE FUNCTION cf_private.audit_payable_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;v_before jsonb;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  IF TG_TABLE_NAME='payable_payment_reversals' THEN
    SELECT to_jsonb(p) INTO v_before FROM public.payable_payments p WHERE p.id=NEW.payment_id;
  END IF;
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar',TG_TABLE_NAME,NEW.id::text,
      CASE WHEN TG_TABLE_NAME='payable_payments' THEN 'VALIDATE' ELSE 'REOPEN' END,v_before,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER payable_payment_immutable BEFORE UPDATE OR DELETE ON public.payable_payments
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_payment_history();
CREATE TRIGGER payable_payment_reversal_immutable BEFORE UPDATE OR DELETE ON public.payable_payment_reversals
 FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_payment_history();
CREATE TRIGGER payable_payment_audit AFTER INSERT ON public.payable_payments
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_payment();
CREATE TRIGGER payable_payment_reversal_audit AFTER INSERT ON public.payable_payment_reversals
 FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_payment();

-- security_invoker mantém as políticas de cada tabela e a sessão aprovada.
CREATE VIEW public.payable_financial_titles WITH(security_invoker=true) AS
 SELECT t.*,
   coalesce(p.paid_cents,0)::bigint AS paid_cents,
   (CASE WHEN t.status IN ('NEW','OPEN') OR coalesce(p.paid_cents,0)>0
     THEN greatest(t.amount_cents-coalesce(p.paid_cents,0),0) ELSE 0 END)::bigint AS outstanding_cents,
   greatest(coalesce(p.paid_cents,0)-t.amount_cents,0)::bigint AS overpaid_cents,
   greatest(t.amount_cents-coalesce(p.paid_cents,0),0)::bigint AS payment_remaining_cents,
   CASE WHEN coalesce(p.paid_cents,0)>t.amount_cents THEN 'OVERPAID'
     WHEN coalesce(p.paid_cents,0)=t.amount_cents AND coalesce(p.paid_cents,0)>0 THEN 'PAID'
     WHEN coalesce(p.paid_cents,0)>0 THEN 'PARTIAL'
     WHEN t.status='SETTLED_IMPORT' THEN 'PENDING_RECONCILIATION' ELSE 'OPEN' END AS financial_status,
   p.last_payment_date,last_bank.bank_label AS last_payment_bank,revision.id AS payment_revision
 FROM public.payable_titles t
 LEFT JOIN LATERAL(SELECT sum(p.amount_cents) paid_cents,max(p.paid_on) last_payment_date
   FROM public.payable_payments p WHERE p.title_id=t.id
     AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) p ON true
 LEFT JOIN LATERAL(SELECT p.bank_label FROM public.payable_payments p WHERE p.title_id=t.id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)
   ORDER BY p.paid_on DESC,p.event_revision DESC LIMIT 1) last_bank ON true
 LEFT JOIN LATERAL(SELECT e.id FROM (
   SELECT p.id,p.event_revision FROM public.payable_payments p WHERE p.title_id=t.id
   UNION ALL SELECT r.id,r.event_revision FROM public.payable_payment_reversals r
     JOIN public.payable_payments p ON p.id=r.payment_id WHERE p.title_id=t.id
 ) e ORDER BY e.event_revision DESC LIMIT 1) revision ON true;
REVOKE ALL ON TABLE public.payable_financial_titles FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_financial_titles TO authenticated;

CREATE FUNCTION public.get_payables_revision() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_import uuid;v_revision bigint;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  SELECT id INTO v_import FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
  SELECT revision INTO v_revision FROM cf_private.payable_payment_state WHERE singleton;
  RETURN jsonb_build_object('import_id',v_import,'financial_revision',v_revision::text);
END $$;
CREATE FUNCTION public.get_payable_payment_accounts() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  RETURN(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'company',a.company,'bank',a.bank,
    'account_label',a.account_label,'account_type',a.account_type,'display_name',a.display_name) ORDER BY a.display_name,a.id),'[]'::jsonb)
    FROM public.bank_accounts a WHERE a.enabled);
END $$;

CREATE FUNCTION public.register_payable_payment(p_title_id uuid,p_amount_cents bigint,p_paid_on date,
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
  IF p_amount_cents::numeric>v_title.amount_cents::numeric-v_paid THEN
    RAISE EXCEPTION 'O valor pago excede o saldo do título. Confira pagamentos anteriores e diferenças antes de continuar.' USING ERRCODE='22023'; END IF;
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

CREATE FUNCTION public.cancel_payable_payment(p_payment_id uuid,p_observation text,p_expected_revision uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payment public.payable_payments%ROWTYPE;v_revision uuid;v_existing public.payable_payment_reversals%ROWTYPE;
 v_counter bigint;v_id uuid;v_observation text:=btrim(coalesce(p_observation,''));
BEGIN
  PERFORM pg_advisory_xact_lock(2045812301);
  IF NOT cf_private.has_permission('contas_pagar','read') OR NOT cf_private.has_permission('contas_pagar','write') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_payment_id IS NULL OR length(v_observation) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Informe o pagamento e o motivo do estorno.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
  PERFORM pg_advisory_xact_lock(2045812309);
  SELECT * INTO v_payment FROM public.payable_payments WHERE id=p_payment_id;
  IF v_payment.id IS NULL THEN RAISE EXCEPTION 'Pagamento não encontrado.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_existing FROM public.payable_payment_reversals WHERE payment_id=p_payment_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.created_by=auth.uid() AND v_existing.observation=v_observation THEN RETURN v_existing.id; END IF;
    RAISE EXCEPTION 'Este pagamento já foi estornado.' USING ERRCODE='22023'; END IF;
  SELECT payment_revision INTO v_revision FROM public.payable_financial_titles WHERE id=v_payment.title_id;
  IF v_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'O título recebeu outra conciliação. Atualize antes de estornar.' USING ERRCODE='40001'; END IF;
  UPDATE cf_private.payable_payment_state SET revision=revision+1 WHERE singleton RETURNING revision INTO v_counter;
  INSERT INTO public.payable_payment_reversals(payment_id,event_revision,observation,created_by)
    VALUES(p_payment_id,v_counter,v_observation,auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.payable_payment_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total numeric;v_count integer;v_macros jsonb;v_pending integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end<p_start OR p_end-p_start>3660 THEN
    RAISE EXCEPTION 'Informe o período real de pagamento.' USING ERRCODE='22023'; END IF;
  SELECT coalesce(sum(p.amount_cents),0),count(*)::integer INTO v_total,v_count FROM public.payable_payments p
    WHERE p.paid_on BETWEEN p_start AND p_end AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id);
  IF v_total>9007199254740991 THEN RAISE EXCEPTION 'O realizado excede o limite de precisão.' USING ERRCODE='22003'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('macro',m.name,'amount_cents',coalesce(p.amount_cents,0),'count',coalesce(p.n,0)) ORDER BY m.name),'[]'::jsonb)
    INTO v_macros FROM public.payable_macros m LEFT JOIN(SELECT p.macro_snapshot,sum(p.amount_cents) amount_cents,count(*) n
      FROM public.payable_payments p WHERE p.paid_on BETWEEN p_start AND p_end
      AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id) GROUP BY p.macro_snapshot) p ON p.macro_snapshot=m.name;
  SELECT count(*)::integer INTO v_pending FROM public.payable_financial_titles WHERE financial_status='PENDING_RECONCILIATION';
  RETURN jsonb_build_object('start_date',p_start,'end_date',p_end,'total_paid_cents',v_total,'payment_count',v_count,
    'by_macro',v_macros,'pending_reconciliation_count',v_pending,'revision',public.get_payables_revision());
END $$;

CREATE FUNCTION public.list_payable_payments(p_start date,p_end date,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,
 p_title_id uuid DEFAULT NULL,p_macro text DEFAULT NULL,p_bank_account_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_count integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF (p_title_id IS NULL AND (p_start IS NULL OR p_end IS NULL))
    OR (p_start IS NOT NULL AND p_start<DATE '1900-01-01')
    OR (p_start IS NOT NULL AND p_end IS NOT NULL AND (p_end<p_start OR (p_title_id IS NULL AND p_end-p_start>3660)))
    OR p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Informe um período e paginação válidos.' USING ERRCODE='22023'; END IF;
  SELECT count(*)::integer INTO v_count FROM public.payable_payments p
    LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id
    WHERE (p_start IS NULL OR p.paid_on>=p_start) AND (p_end IS NULL OR p.paid_on<=p_end) AND (p_title_id IS NULL OR p.title_id=p_title_id)
      AND (p_title_id IS NOT NULL OR r.id IS NULL) AND (p_macro IS NULL OR p.macro_snapshot=p_macro)
      AND (p_bank_account_id IS NULL OR p.bank_account_id=p_bank_account_id);
  SELECT coalesce(jsonb_agg(x.row ORDER BY x.paid_on DESC,x.event_revision DESC),'[]'::jsonb) INTO v_rows FROM(
    SELECT p.paid_on,p.event_revision,to_jsonb(p)||jsonb_build_object('cancelled_at',r.created_at,'cancelled_by',r.created_by,
      'cancellation_id',r.id,'cancellation_observation',r.observation,'status',CASE WHEN r.id IS NULL THEN 'ACTIVE' ELSE 'CANCELLED' END,
      'created_by_name',creator.display_name,'created_by_username',creator.username,'cancelled_by_name',canceller.display_name,
      'title_status',financial.status,'financial_status',financial.financial_status) row
    FROM public.payable_payments p LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id
      LEFT JOIN public.profiles creator ON creator.id=p.created_by LEFT JOIN public.profiles canceller ON canceller.id=r.created_by
      JOIN public.payable_financial_titles financial ON financial.id=p.title_id
    WHERE (p_start IS NULL OR p.paid_on>=p_start) AND (p_end IS NULL OR p.paid_on<=p_end) AND (p_title_id IS NULL OR p.title_id=p_title_id)
      AND (p_title_id IS NOT NULL OR r.id IS NULL) AND (p_macro IS NULL OR p.macro_snapshot=p_macro)
      AND (p_bank_account_id IS NULL OR p.bank_account_id=p_bank_account_id)
    ORDER BY p.paid_on DESC,p.event_revision DESC OFFSET p_offset LIMIT p_limit) x;
  RETURN jsonb_build_object('rows',v_rows,'count',v_count,'revision',public.get_payables_revision());
END $$;

-- Agregados usam o saldo financeiro; a fonte importada permanece intacta.
CREATE OR REPLACE FUNCTION public.payables_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_open numeric;v_overdue numeric;v_period numeric;v_count bigint;v_latest timestamptz;
BEGIN
  IF NOT(cf_private.has_permission('contas_pagar','read') OR cf_private.has_permission('painel','read')) THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end<p_start OR p_end-p_start>3660 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023'; END IF;
  SELECT coalesce(sum(outstanding_cents),0),
    coalesce(sum(outstanding_cents) FILTER(WHERE due_date<(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date),0),
    coalesce(sum(outstanding_cents) FILTER(WHERE due_date BETWEEN p_start AND p_end),0),count(*)
    INTO v_open,v_overdue,v_period,v_count FROM public.payable_financial_titles WHERE outstanding_cents>0;
  IF greatest(v_open,v_overdue,v_period,v_count)>9007199254740991 THEN
    RAISE EXCEPTION 'O consolidado excede o limite de precisão. Revise os valores importados.' USING ERRCODE='22003'; END IF;
  SELECT max(created_at) INTO v_latest FROM public.payable_imports;
  RETURN jsonb_build_object('open_cents',v_open,'overdue_cents',v_overdue,'period_cents',v_period,
    'active_count',v_count,'latest_import_at',v_latest);
END $$;

-- Previsões reduzem apenas as obrigações reais pelo saldo financeiro.
-- O abatimento mensal das estimativas continua nominal, inclusive os quitados.
CREATE OR REPLACE FUNCTION public.payables_forecast(p_start date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_today date:=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 v_current date;v_start date;v_week date;v_end date;v_month date;v_key text;v_provision jsonb;
 v_latest public.payable_imports%ROWTYPE;v_rules jsonb;v_plans jsonb;v_weeks jsonb:='[]'::jsonb;v_provisions jsonb;v_macros jsonb;
 v_real numeric;v_estimate numeric;v_known numeric;v_total numeric;v_cheques numeric;v_count integer;v_cheque_count integer;
 v_missing jsonb:='[]'::jsonb;v_window numeric:=0;v_i integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  v_current:=v_today-((extract(dow FROM v_today)::integer+1)%7);v_start:=coalesce(p_start,v_current);
  IF v_start<v_current OR v_start>v_current+366 OR extract(dow FROM v_start)<>6 THEN
    RAISE EXCEPTION 'Escolha um sábado da semana atual até um ano à frente.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_latest FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_latest.id IS NULL THEN v_missing:=jsonb_build_array('Importe o relatório completo de Contas a Pagar.'); END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.day_of_month,r.rule_key),'[]'::jsonb) INTO v_rules
    FROM(SELECT DISTINCT ON(rule_key) * FROM public.payable_forecast_rules ORDER BY rule_key,created_at DESC,id DESC) r;
  SELECT coalesce(jsonb_agg(jsonb_build_object('plan',m.plan,'macro',m.macro,'rule_key',b.rule_key,
    'mapping_id',b.id,'configured',b.id IS NOT NULL,'effective_from',b.effective_from) ORDER BY m.plan),'[]'::jsonb) INTO v_plans
    FROM public.payable_plan_mappings m LEFT JOIN LATERAL(
      SELECT * FROM public.payable_forecast_plan_bindings b WHERE b.plan=m.plan ORDER BY created_at DESC,id DESC LIMIT 1) b ON true
    WHERE m.macro IN ('SALÁRIOS','ADIANTAMENTO') OR b.id IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.plan=m.plan AND t.macro IN ('SALÁRIOS','ADIANTAMENTO')
        AND t.due_date>=date_trunc('month',v_start)::date
        AND t.due_date<(date_trunc('month',v_start+55)+interval '1 month')::date);
  FOR v_i IN 0..7 LOOP
    v_week:=v_start+v_i*7;v_end:=v_week+6;v_provisions:='[]'::jsonb;
    FOR v_month IN SELECT d::date FROM generate_series(date_trunc('month',v_week),date_trunc('month',v_end),interval '1 month') d LOOP
      FOREACH v_key IN ARRAY ARRAY['SALARIOS','SALARIOS_SOCIOS','ADIANTAMENTO','ADIANTAMENTO_SOCIOS'] LOOP
        v_provision:=cf_private.payable_forecast_provision(v_key,v_month,v_latest.id IS NOT NULL);
        IF v_provision IS NOT NULL AND (v_provision->>'due_date')::date BETWEEN v_week AND v_end THEN
          v_provisions:=v_provisions||jsonb_build_array(v_provision);
          IF v_provision->>'remaining_cents' IS NULL THEN v_missing:=v_missing||(v_provision->'issues'); END IF;
        END IF;
      END LOOP;
    END LOOP;
    SELECT coalesce(sum(outstanding_cents),0),count(*)::integer,coalesce(sum(outstanding_cents) FILTER(WHERE upper(btrim(source_status))='CHEQUE'),0),
      (count(*) FILTER(WHERE upper(btrim(source_status))='CHEQUE'))::integer INTO v_real,v_count,v_cheques,v_cheque_count
      FROM public.payable_financial_titles WHERE scope='grupo-consolidado' AND outstanding_cents>0 AND due_date BETWEEN v_week AND v_end;
    SELECT coalesce(sum((p->>'remaining_cents')::numeric),0),
      CASE WHEN count(*) FILTER(WHERE p->>'remaining_cents' IS NULL)>0 THEN NULL ELSE coalesce(sum((p->>'remaining_cents')::numeric),0) END
      INTO v_known,v_estimate FROM jsonb_array_elements(v_provisions) p;
    IF v_latest.id IS NULL THEN v_real:=NULL;v_estimate:=NULL;v_cheques:=NULL; END IF;
    v_total:=v_real+v_estimate;v_window:=v_window+coalesce(v_real,0)+v_known;
    IF greatest(coalesce(v_real,0),v_known,coalesce(v_total,0),coalesce(v_cheques,0),v_window)>9007199254740991 THEN
      RAISE EXCEPTION 'A previsão excede o limite de precisão.' USING ERRCODE='22003'; END IF;
    SELECT jsonb_agg(jsonb_build_object('macro',m.name,'real_cents',CASE WHEN v_latest.id IS NOT NULL THEN coalesce(t.real_cents,0) ELSE NULL END,
      'estimated_cents',CASE WHEN v_latest.id IS NULL OR coalesce(p.pending,false) THEN NULL ELSE coalesce(p.estimated_cents,0) END,
      'total_cents',CASE WHEN v_latest.id IS NULL OR coalesce(p.pending,false) THEN NULL ELSE coalesce(t.real_cents,0)+coalesce(p.estimated_cents,0) END) ORDER BY m.name)
      INTO v_macros FROM public.payable_macros m
      LEFT JOIN(SELECT macro,sum(outstanding_cents) real_cents FROM public.payable_financial_titles WHERE scope='grupo-consolidado' AND outstanding_cents>0
        AND due_date BETWEEN v_week AND v_end GROUP BY macro) t ON t.macro=m.name
      LEFT JOIN(SELECT p->>'macro' macro,sum((p->>'remaining_cents')::numeric) estimated_cents,bool_or(p->>'remaining_cents' IS NULL) pending
        FROM jsonb_array_elements(v_provisions) p GROUP BY p->>'macro') p ON p.macro=m.name;
    v_weeks:=v_weeks||jsonb_build_array(jsonb_build_object('start',v_week,'end',v_end,'real_cents',v_real,'estimated_cents',v_estimate,
      'known_estimated_cents',v_known,'total_cents',v_total,'cheques_cents',v_cheques,'cheque_count',v_cheque_count,'title_count',v_count,
      'macros',v_macros,'provisions',v_provisions));
  END LOOP;
  SELECT coalesce(jsonb_agg(issue ORDER BY issue),'[]'::jsonb) INTO v_missing FROM(SELECT DISTINCT value issue FROM jsonb_array_elements(v_missing)) x;
  RETURN jsonb_build_object('as_of_date',v_today,'start_date',v_start,'end_date',v_start+55,
    'latest_import_id',v_latest.id,'latest_import_at',v_latest.created_at,'weeks',v_weeks,'rules',v_rules,'plans',v_plans,'missing_sources',v_missing);
END $$;


-- A posição atual de mercadoria usa o mesmo saldo restante dos demais módulos.
CREATE OR REPLACE FUNCTION public.director_report(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_date date := (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_inputs jsonb;v_values jsonb;v_cash jsonb;v_stock jsonb;v_cp jsonb;v_cr jsonb;v_data jsonb;
  v_turnover numeric;v_merchandise numeric;v_projected numeric;v_assets numeric;v_comlurb numeric;
  v_missing jsonb := '[]'::jsonb;v_field text;v_label text;
BEGIN
  IF NOT cf_private.has_permission('resumo_diretoria','read') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end<p_start OR p_end-p_start>366 THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE='22023';
  END IF;
  -- A posição gerencial é a de hoje, mesmo quando o fluxo selecionado é histórico.
  -- Complementos de uma data anterior NÃO são promovidos silenciosamente para hoje.
  v_inputs := public.read_director_inputs(v_date);
  v_values := v_inputs->'values';
  v_cash := public.cash_position(v_date);
  v_stock := public.current_stock();
  v_cp := public.payables_summary(p_start,p_end);
  v_cr := public.receivables_summary(p_start,p_end);
  v_turnover := (v_values->>'turnover_month_cents')::numeric+(v_values->>'turnover_comlurb_cents')::numeric;
  IF v_cp->>'latest_import_at' IS NOT NULL THEN
    SELECT coalesce(sum(outstanding_cents),0) INTO v_merchandise FROM public.payable_financial_titles
      WHERE scope='grupo-consolidado' AND outstanding_cents>0 AND macro='COMPRA DE MERCADORIA';
    IF v_merchandise>9007199254740991 THEN
      RAISE EXCEPTION 'O pagamento de mercadoria excede o limite de precisão.' USING ERRCODE='22003';
    END IF;
  END IF;
  IF v_cash->>'total_cents' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Caixa: informe todas as contas.'); END IF;
  IF v_stock->>'value_cents' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Estoque aguardando atualização.'); END IF;
  IF v_cp->>'latest_import_at' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Contas a Pagar: importe o relatório completo.'); END IF;
  IF v_cr->>'latest_import_at' IS NULL THEN v_missing:=v_missing||jsonb_build_array('Contas a Receber: importe o relatório completo.'); END IF;
  FOR v_field,v_label IN SELECT * FROM (VALUES
    ('turnover_month_cents','Faturamento mês'),('turnover_comlurb_cents','Faturamento COMLURB'),
    ('orders_cents','Valor de pedido em sistema'),('blocked_orders_cents','Valor de pedidos bloqueados'),
    ('pending_orders_cents','Valor total pendência'),('overdue_comlurb_cents','Atrasado COMLURB'),
    ('installments_cents','Parcelamentos'),('previous_month_taxes_cents','Impostos do mês passado')
  ) AS fields(field,label) LOOP
    IF v_values->>v_field IS NULL THEN
      v_missing:=v_missing||jsonb_build_array(v_label||': informe a posição de hoje.');
    END IF;
  END LOOP;
  v_comlurb := (v_values->>'overdue_comlurb_cents')::numeric;
  IF v_comlurb IS NOT NULL AND v_cr->>'latest_import_at' IS NOT NULL AND v_comlurb>(v_cr->>'overdue_cents')::numeric THEN
    v_comlurb := NULL;
    v_missing:=v_missing||jsonb_build_array('Atrasado COMLURB excede o total atrasado; revise o complemento.');
  ELSIF v_cr->>'latest_import_at' IS NULL THEN
    v_comlurb := NULL;
  END IF;
  IF v_cash->>'total_cents' IS NOT NULL AND v_cp->>'latest_import_at' IS NOT NULL
    AND v_cr->>'latest_import_at' IS NOT NULL THEN
    v_projected:=(v_cash->>'total_cents')::numeric+(v_cr->>'period_cents')::numeric-(v_cp->>'period_cents')::numeric;
    IF abs(v_projected)>9007199254740991 THEN
      RAISE EXCEPTION 'A projeção excede o limite de precisão.' USING ERRCODE='22003';
    END IF;
  END IF;
  -- Centavos / 100.000.000 = milhões de reais. O fator 14/100 é numeric
  -- exato e pode produzir fração de centavo; não arredondar etapas da fórmula.
  IF v_cr->>'latest_import_at' IS NOT NULL THEN
    v_assets := ((v_cash->>'total_cents')::numeric+(v_cr->>'open_cents')::numeric+(v_stock->>'value_cents')::numeric
      -(v_values->>'previous_month_taxes_cents')::numeric-v_turnover*14/100
      -v_merchandise-(v_values->>'installments_cents')::numeric)/100000000;
  END IF;
  v_data:=jsonb_build_object(
    'turnover_month_cents',v_values->'turnover_month_cents','turnover_comlurb_cents',v_values->'turnover_comlurb_cents',
    'turnover_cents',v_turnover,'orders_cents',v_values->'orders_cents',
    'blocked_orders_cents',v_values->'blocked_orders_cents','pending_orders_cents',v_values->'pending_orders_cents',
    'cash_cents',v_cash->'total_cents','cash_reported_accounts',v_cash->'reported_accounts',
    'cash_expected_accounts',v_cash->'expected_accounts','cash_as_of_date',v_date,
    'payable_open_cents',CASE WHEN v_cp->>'latest_import_at' IS NULL THEN NULL ELSE v_cp->'open_cents' END,
    'payable_period_cents',CASE WHEN v_cp->>'latest_import_at' IS NULL THEN NULL ELSE v_cp->'period_cents' END,
    'payable_overdue_cents',CASE WHEN v_cp->>'latest_import_at' IS NULL THEN NULL ELSE v_cp->'overdue_cents' END,
    'payable_import_at',v_cp->'latest_import_at',
    'stock_cents',v_stock->'value_cents','stock_reference_date',v_stock->'reference_date','stock_source',v_stock->'source',
    'receivable_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'open_cents' END,
    'receivable_period_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'period_cents' END,
    'receivable_overdue_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'overdue_cents' END,
    'receivable_overdue_bps',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'overdue_bps' END,
    'receivable_overdue_comlurb_cents',v_comlurb,
    'receivable_received_period_cents',CASE WHEN v_cr->>'latest_import_at' IS NULL THEN NULL ELSE v_cr->'received_period_cents' END,
    'receivable_import_at',v_cr->'latest_import_at',
    'merchandise_cents',v_merchandise,'installments_cents',v_values->'installments_cents',
    'previous_month_taxes_cents',v_values->'previous_month_taxes_cents',
    'projected_cash_cents',v_projected,'current_assets_millions',trim_scale(v_assets)::text,
    'formula_version','2026-10-sem-m49','complete',jsonb_array_length(v_missing)=0,'missing_sources',v_missing,
    'report_input_id',v_inputs->'id','report_input_reference_date',v_inputs->'reference_date',
    'previous_taxes_month',to_char(v_date-interval '1 month','YYYY-MM'));
  RETURN jsonb_build_object('as_of_date',v_date,'inputs',v_inputs,'indicators',v_data,
    'cash',v_cash,'stock',v_stock,'missing_sources',v_missing,'complete',jsonb_array_length(v_missing)=0,
    'formula_version','2026-10-sem-m49');
END;
$$;

REVOKE ALL ON FUNCTION cf_private.block_payable_payment_history(),cf_private.audit_payable_payment()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_payables_revision(),public.get_payable_payment_accounts(),
 public.register_payable_payment(uuid,bigint,date,uuid,text,uuid,uuid,uuid),
 public.cancel_payable_payment(uuid,text,uuid),public.payable_payment_summary(date,date),
 public.list_payable_payments(date,date,integer,integer,uuid,text,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_payables_revision(),public.get_payable_payment_accounts(),
 public.register_payable_payment(uuid,bigint,date,uuid,text,uuid,uuid,uuid),
 public.cancel_payable_payment(uuid,text,uuid),public.payable_payment_summary(date,date),
 public.list_payable_payments(date,date,integer,integer,uuid,text,uuid) TO authenticated;
COMMENT ON TABLE public.payable_payments IS 'Pagamentos financeiros efetivos; data real e centavos informados. Macro, título e banco são preservados como eram no registro. Não altera saldos bancários.';
COMMENT ON TABLE public.payable_payment_reversals IS 'Estorno imutável do pagamento com motivo, autor e horário. Preserva o pagamento original e retira seu efeito dos realizados.';
COMMENT ON VIEW public.payable_financial_titles IS 'Fonte importada preservada. Pagamento parcial mantém saldo restante; ausência sem pagamento fica pendente de conciliação e não produz realizado. Valor reimportado menor que pagamentos gera OVERPAID.';
INSERT INTO public.central_schema_migrations(version) VALUES('015_payable_payments');
-- END SOURCE BODY: 015_payable_payments.sql
$cf_source_015_74ecbc6222d33785_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='015_payable_payments') THEN
      RAISE EXCEPTION 'A atualização 015_payable_payments não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_apply_015_dc64e65bff817126_0$;

-- SOURCE: 016_payable_identity_updates.sql
DO $cf_apply_016_a793f31bf0b7cd76_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='016_payable_identity_updates') THEN
    RAISE NOTICE 'Atualização 016_payable_identity_updates já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_source_016_cccd29090995c214_0$
-- SOURCE BODY: 016_payable_identity_updates.sql
-- Contas a Pagar: identidade estável nas atualizações diárias de valor, data e banco.
-- Incremental após 015. A ativação não modifica títulos, saldos, pagamentos,
-- arquivos, históricos ou classificações existentes. Nenhuma versão é mesclada.

DO $$ BEGIN
  IF to_regclass('public.central_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Ative as atualizações anteriores de Contas a Pagar.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='015_payable_payments') THEN
    RAISE EXCEPTION 'Ative a atualização 015 antes da identidade estável de Contas a Pagar.' USING ERRCODE='22023';
  END IF;
END $$;

-- Não remove pontuação nem zeros do número de lançamento: não presume parcelas.
CREATE FUNCTION cf_private.payable_business_key(p_branch text,p_entry_number text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
  SELECT jsonb_build_array(upper(btrim(regexp_replace(p_branch,'[[:space:]]+',' ','g'))),
    upper(btrim(regexp_replace(p_entry_number,'[[:space:]]+',' ','g'))))::text;
$$;
CREATE INDEX payable_titles_business_identity ON public.payable_titles(scope,
  cf_private.payable_business_key(branch,entry_number));

-- Registro canônico privado: preenchido somente pela importação aprovada.
-- Os registros antigos não escolhidos permanecem intactos e consultáveis.
CREATE TABLE cf_private.payable_identity_registry (
  scope text NOT NULL CHECK(scope='grupo-consolidado'),
  business_key text NOT NULL,
  title_id uuid NOT NULL UNIQUE REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  PRIMARY KEY(scope,business_key)
);
ALTER TABLE cf_private.payable_identity_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cf_private.payable_identity_registry FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION cf_private.guard_payable_identity_registry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'A identidade canônica possui histórico imutável.' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.id=NEW.title_id AND t.scope=NEW.scope
    AND cf_private.payable_business_key(t.branch,t.entry_number)=NEW.business_key) THEN
    RAISE EXCEPTION 'A identidade não corresponde ao título.' USING ERRCODE='23514'; END IF;
  SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
    VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar','payable_identity_registry',NEW.title_id::text,
      'ASSIGNMENT',NULL,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER payable_identity_registry_guard BEFORE INSERT OR UPDATE OR DELETE ON cf_private.payable_identity_registry
 FOR EACH ROW EXECUTE FUNCTION cf_private.guard_payable_identity_registry();

-- Reutiliza todas as validações originais (nove campos, tipos, datas e limites).
-- Valor, vencimento e banco pertencem à versão; filial+número identificam o título.
CREATE FUNCTION cf_private.validate_payable_identity_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_rows jsonb;v_result jsonb;
BEGIN
  BEGIN
    v_rows:=cf_private.validate_payable_rows(p_scope,p_rows);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Há linhas repetidas para a mesma filial e número de lançamento. Confira parcelas e a identificação do relatório; nenhum dado foi alterado.' USING ERRCODE='P0016';
  END;
  SELECT jsonb_agg(r||jsonb_build_object('legacy_source_key',r->>'source_key',
    'source_key',cf_private.payable_business_key(r->>'branch',r->>'entry_number')) ORDER BY n)
    INTO v_result FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(r,n);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_result) r GROUP BY r->>'source_key' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Há mais de uma linha para a mesma filial e número de lançamento. Confira parcelas e a identificação do relatório; nenhum dado foi alterado.' USING ERRCODE='P0016';
  END IF;
  RETURN v_result;
END $$;

-- Resolver sem escrita: a prévia nunca elege nem grava uma identidade.
-- Mais de um título ativo ou histórico indistinguível exige conferência.
CREATE FUNCTION cf_private.resolve_payable_identity_rows(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_row jsonb;v_item public.payable_titles%ROWTYPE;v_id uuid;v_registered uuid;
 v_count integer;v_active integer;v_total integer;v_changed boolean;v_items jsonb[]:=ARRAY[]::jsonb[];
BEGIN
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_id:=NULL;v_registered:=NULL;
    SELECT i.title_id INTO v_registered FROM cf_private.payable_identity_registry i
      WHERE i.scope=p_scope AND i.business_key=v_row->>'source_key';
    SELECT count(*)::integer,count(*) FILTER(WHERE t.status<>'SETTLED_IMPORT')::integer
      INTO v_total,v_active FROM public.payable_titles t WHERE t.scope=p_scope
      AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key';
    IF v_active>1 THEN
      RAISE EXCEPTION 'Há mais de um título ativo para a mesma filial e número de lançamento. Confira as versões no histórico; nenhum dado foi alterado.' USING ERRCODE='P0016'; END IF;
    IF v_registered IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.id=v_registered AND t.scope=p_scope
        AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key')
        OR EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
          AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key' AND t.id<>v_registered) THEN
        RAISE EXCEPTION 'A identidade registrada diverge dos títulos existentes. Confira o histórico; nenhum dado foi alterado.' USING ERRCODE='P0016'; END IF;
      v_id:=v_registered;
    ELSIF v_active=1 THEN
      SELECT t.id INTO v_id FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
        AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key';
    ELSIF v_total=1 THEN
      SELECT t.id INTO v_id FROM public.payable_titles t WHERE t.scope=p_scope
        AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key';
    ELSIF v_total>1 THEN
      SELECT count(*)::integer INTO v_count FROM public.payable_titles t WHERE t.scope=p_scope
        AND cf_private.payable_business_key(t.branch,t.entry_number)=v_row->>'source_key'
        AND t.source_key=v_row->>'legacy_source_key';
      IF v_count<>1 THEN
        RAISE EXCEPTION 'Há várias versões históricas e a identidade não pode ser determinada com segurança. Confira parcelas e o histórico; nenhum dado foi alterado.' USING ERRCODE='P0016'; END IF;
      SELECT t.id INTO v_id FROM public.payable_titles t WHERE t.scope=p_scope AND t.source_key=v_row->>'legacy_source_key';
    END IF;
    -- Uma versão histórica com pagamento efetivo pode representar o mesmo título
    -- da versão escolhida. Não canoniza outra versão nem transfere o ledger por
    -- inferência; a origem precisa ser conferida antes de atualizar essa identidade.
    IF EXISTS(SELECT 1 FROM public.payable_titles historical
      JOIN public.payable_payments payment ON payment.title_id=historical.id
      WHERE historical.scope=p_scope AND historical.id IS DISTINCT FROM v_id
        AND cf_private.payable_business_key(historical.branch,historical.entry_number)=v_row->>'source_key'
        AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals reversal WHERE reversal.payment_id=payment.id)) THEN
      RAISE EXCEPTION 'Outra versão desta filial e número possui pagamentos financeiros ativos. Confira o histórico antes de escolher a identidade; nenhum pagamento será transferido nem duplicado.' USING ERRCODE='P0016';
    END IF;
    v_changed:=false;
    IF v_id IS NOT NULL THEN
      SELECT * INTO v_item FROM public.payable_titles WHERE id=v_id;
      v_changed:=ROW(v_item.entry_number,v_item.description,v_item.due_date,v_item.amount_cents,
        v_item.source_status,v_item.plan,v_item.bank_account,v_item.branch,v_item.issued_on)
        IS DISTINCT FROM ROW(v_row->>'entry_number',v_row->>'description',(v_row->>'due_date')::date,
          (v_row->>'amount_cents')::bigint,v_row->>'source_status',v_row->>'plan',v_row->>'bank_account',
          v_row->>'branch',(v_row->>'issued_on')::date);
    END IF;
    v_items:=array_append(v_items,v_row||jsonb_build_object('title_id',v_id,'changed',v_changed));
  END LOOP;
  RETURN to_jsonb(v_items);
END $$;

CREATE OR REPLACE FUNCTION public.preview_payables_import(p_scope text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_previous uuid;v_new integer;v_open integer;v_settled integer;v_changed integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  -- Capture o token antes da análise: uma importação concorrente exige nova prévia.
  SELECT id INTO v_previous FROM public.payable_imports WHERE scope=p_scope ORDER BY created_at DESC,id DESC LIMIT 1;
  v_rows:=cf_private.resolve_payable_identity_rows(p_scope,cf_private.validate_payable_identity_rows(p_scope,p_rows));
  SELECT count(*) FILTER(WHERE r->>'title_id' IS NULL),count(*) FILTER(WHERE r->>'title_id' IS NOT NULL),
    count(*) FILTER(WHERE coalesce((r->>'changed')::boolean,false)) INTO v_new,v_open,v_changed FROM jsonb_array_elements(v_rows) r;
  SELECT count(*) INTO v_settled FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'title_id')::uuid=t.id);
  RETURN jsonb_build_object('previous_import_id',v_previous,'new_count',v_new,'open_count',v_open,
    'settled_count',v_settled,'changed_count',v_changed,'row_count',jsonb_array_length(v_rows));
END $$;

CREATE OR REPLACE FUNCTION public.commit_payables_import(
 p_scope text,p_file_name text,p_file_sha256 text,p_file_base64 text,p_rows jsonb,p_mappings jsonb,
 p_complete boolean,p_previous_import_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rows jsonb; v_previous uuid; v_id uuid:=gen_random_uuid(); v_new integer; v_open integer; v_settled integer;
  v_changed integer; v_file bytea; v_mappings jsonb:='{}'::jsonb; v_mapping record; v_plan text;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','import') THEN
    RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
  END IF;
  IF p_complete IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Confirme que o arquivo contém o relatório completo.' USING ERRCODE='22023';
  END IF;
  v_rows:=cf_private.validate_payable_identity_rows(p_scope,p_rows);
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
  IF EXISTS(SELECT 1 FROM public.payable_imports WHERE scope=p_scope AND file_sha256=p_file_sha256) THEN
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
  SELECT count(*) INTO v_settled FROM public.payable_titles t WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'title_id')::uuid=t.id);
  INSERT INTO public.payable_imports(id,scope,file_name,file_sha256,created_by,row_count,new_count,open_count,settled_count)
    VALUES(v_id,p_scope,btrim(p_file_name),p_file_sha256,auth.uid(),jsonb_array_length(v_rows),v_new,v_open,v_settled);
  INSERT INTO cf_private.payable_import_files(import_id,file_bytes) VALUES(v_id,v_file);
  INSERT INTO public.payable_plan_mappings(plan,macro)
    SELECT key,value#>>'{}' FROM jsonb_each(v_mappings)
    ON CONFLICT(plan) DO UPDATE SET macro=EXCLUDED.macro,updated_at=clock_timestamp()
      WHERE payable_plan_mappings.macro IS DISTINCT FROM EXCLUDED.macro;
  UPDATE public.payable_titles t SET status='SETTLED_IMPORT',settled_at=clock_timestamp(),last_import_id=v_id
    WHERE t.scope=p_scope AND t.status<>'SETTLED_IMPORT'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'title_id')::uuid=t.id);
  -- Atualiza a identidade existente, inclusive vencimento/valor/conta de origem.
  -- first_import_id e UUID não mudam; o trigger anterior guarda antes/depois.
  UPDATE public.payable_titles t SET
      source_key=r.source_key,entry_number=r.entry_number,description=r.description,due_date=r.due_date,
      amount_cents=r.amount_cents,source_status=r.source_status,plan=r.plan,
      bank_account=r.bank_account,branch=r.branch,issued_on=r.issued_on,macro=m.macro,
      status='OPEN',last_import_id=v_id,settled_at=NULL
    FROM jsonb_to_recordset(v_rows) AS r(title_id uuid,source_key text,entry_number text,description text,due_date date,
      amount_cents bigint,source_status text,plan text,bank_account text,branch text,issued_on date)
    JOIN public.payable_plan_mappings m ON m.plan=r.plan WHERE t.id=r.title_id AND t.scope=p_scope;
  INSERT INTO public.payable_titles(scope,source_key,entry_number,description,due_date,amount_cents,source_status,
    plan,bank_account,branch,issued_on,macro,status,first_import_id,last_import_id,settled_at)
    SELECT p_scope,r.source_key,r.entry_number,r.description,r.due_date,r.amount_cents,r.source_status,
      r.plan,r.bank_account,r.branch,r.issued_on,m.macro,'NEW',v_id,v_id,NULL
    FROM jsonb_to_recordset(v_rows) AS r(title_id uuid,source_key text,entry_number text,description text,due_date date,
      amount_cents bigint,source_status text,plan text,bank_account text,branch text,issued_on date)
    JOIN public.payable_plan_mappings m ON m.plan=r.plan WHERE r.title_id IS NULL;
  INSERT INTO cf_private.payable_identity_registry(scope,business_key,title_id,created_by)
    SELECT p_scope,r->>'source_key',t.id,auth.uid() FROM jsonb_array_elements(v_rows) r
    JOIN public.payable_titles t ON t.scope=p_scope AND t.source_key=r->>'source_key'
    WHERE NOT EXISTS(SELECT 1 FROM cf_private.payable_identity_registry i
      WHERE i.scope=p_scope AND i.business_key=r->>'source_key');
  RETURN jsonb_build_object('import_id',v_id,'new_count',v_new,'open_count',v_open,
    'settled_count',v_settled,'changed_count',v_changed,'row_count',jsonb_array_length(v_rows));
END;
$$;

REVOKE ALL ON FUNCTION cf_private.payable_business_key(text,text),cf_private.guard_payable_identity_registry(),
 cf_private.validate_payable_identity_rows(text,jsonb),cf_private.resolve_payable_identity_rows(text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
-- Substituições mantêm a API e o envelope originais; escrita continua exclusiva do gateway.
REVOKE ALL ON FUNCTION public.preview_payables_import(text,jsonb),
 public.commit_payables_import(text,text,text,text,jsonb,jsonb,boolean,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_payables_import(text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_payables_import(text,text,text,text,jsonb,jsonb,boolean,uuid) TO service_role;
COMMENT ON FUNCTION public.preview_payables_import(text,jsonb) IS 'Prévia sem escrita: filial+número normalizados identificam o título; changed_count integra open_count e não aumenta a quantidade de títulos.';
COMMENT ON FUNCTION public.commit_payables_import(text,text,text,text,jsonb,jsonb,boolean,uuid) IS 'Somente gateway: atualiza o mesmo UUID quando valor/vencimento/banco mudam. Preserva pagamentos, primeira importação e histórico; rejeita identidades ambíguas.';
INSERT INTO public.central_schema_migrations(version) VALUES('016_payable_identity_updates');
-- END SOURCE BODY: 016_payable_identity_updates.sql
$cf_source_016_cccd29090995c214_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='016_payable_identity_updates') THEN
      RAISE EXCEPTION 'A atualização 016_payable_identity_updates não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_apply_016_a793f31bf0b7cd76_0$;

-- SOURCE: 017_payable_month_closing.sql
DO $cf_apply_017_07659146c8bddccb_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='017_payable_month_closing') THEN
    RAISE NOTICE 'Atualização 017_payable_month_closing já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_source_017_86d3a2064bdbfc14_0$
-- SOURCE BODY: 017_payable_month_closing.sql
-- Revisão explícita, correções auditáveis e fechamento mensal de Contas a Pagar.
-- Aplicar uma única vez após 016. Não migra, exclui ou reclassifica dados antigos.

DO $$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative as atualizações anteriores de Contas a Pagar.' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='016_payable_identity_updates') THEN
  RAISE EXCEPTION 'Ative a atualização 016 antes do fechamento mensal.' USING ERRCODE='22023'; END IF;
END $$;

CREATE TABLE cf_private.payable_control_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 0);
INSERT INTO cf_private.payable_control_state(singleton) VALUES(true);
REVOKE ALL ON TABLE cf_private.payable_control_state FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.payable_title_control_revisions(
 title_id uuid PRIMARY KEY REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
 revision bigint NOT NULL CHECK(revision>0),payment_token uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE TABLE public.payable_title_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title_id uuid NOT NULL REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),reviewed boolean NOT NULL,
 observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_title_reviews_latest ON public.payable_title_reviews(title_id,created_at DESC,id DESC);
CREATE TABLE public.payable_title_corrections(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title_id uuid NOT NULL REFERENCES public.payable_titles(id) ON DELETE RESTRICT,
 before_value jsonb NOT NULL,after_value jsonb NOT NULL,
 observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_title_corrections_latest ON public.payable_title_corrections(title_id,created_at DESC,id DESC);
CREATE TABLE public.payable_title_macro_overrides(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title_id uuid NOT NULL REFERENCES public.payable_titles(id),
 plan text NOT NULL,macro text REFERENCES public.payable_macros(name),active boolean NOT NULL,
 correction_id uuid REFERENCES public.payable_title_corrections(id),
 observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((active AND macro IS NOT NULL) OR (NOT active AND macro IS NULL))
);
CREATE INDEX payable_title_macro_overrides_latest ON public.payable_title_macro_overrides(title_id,created_at DESC,id DESC);
CREATE TABLE public.payable_payment_reclassifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payment_id uuid NOT NULL REFERENCES public.payable_payments(id) ON DELETE RESTRICT,
 correction_id uuid NOT NULL REFERENCES public.payable_title_corrections(id) ON DELETE RESTRICT,
 macro text NOT NULL REFERENCES public.payable_macros(name),previous_macro text NOT NULL REFERENCES public.payable_macros(name),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(payment_id,correction_id)
);
CREATE INDEX payable_payment_reclass_latest ON public.payable_payment_reclassifications(payment_id,created_at DESC,id DESC);
CREATE TABLE public.payable_month_closures(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),month date NOT NULL CHECK(month=date_trunc('month',month)::date),
 version integer NOT NULL CHECK(version>0),snapshot jsonb NOT NULL,source_revision jsonb NOT NULL,
 total_titles integer NOT NULL CHECK(total_titles>0),total_nominal_cents bigint NOT NULL,total_paid_cents bigint NOT NULL,
 observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(month,version)
);
CREATE INDEX payable_month_closures_latest ON public.payable_month_closures(month,version DESC);
CREATE TABLE public.payable_month_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),month date NOT NULL CHECK(month=date_trunc('month',month)::date),
 closure_id uuid NOT NULL REFERENCES public.payable_month_closures(id),action text NOT NULL CHECK(action IN ('CLOSE','REOPEN')),
 automatic boolean NOT NULL DEFAULT false,observation text NOT NULL CHECK(length(btrim(observation)) BETWEEN 1 AND 1000),
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payable_month_events_latest ON public.payable_month_events(month,created_at DESC,id DESC);
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['payable_title_control_revisions','payable_title_reviews','payable_title_corrections',
  'payable_payment_reclassifications','payable_month_closures','payable_month_events','payable_title_macro_overrides'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated',v_table);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING(cf_private.has_permission(''contas_pagar'',''read''))',v_table||'_read',v_table);
 END LOOP;
END $$;
CREATE FUNCTION cf_private.block_payable_closing_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 RAISE EXCEPTION 'O histórico de conciliação e fechamento é imutável. Registre uma nova revisão.' USING ERRCODE='42501';END $$;
CREATE FUNCTION cf_private.audit_payable_closing_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;v_action text;
BEGIN
 SELECT * INTO v_actor FROM public.profiles WHERE id=auth.uid();
 v_action:=CASE WHEN TG_TABLE_NAME='payable_title_reviews' THEN CASE WHEN (to_jsonb(NEW)->>'reviewed')::boolean THEN 'VALIDATE' ELSE 'REOPEN' END
  WHEN TG_TABLE_NAME='payable_month_events' THEN CASE WHEN to_jsonb(NEW)->>'action'='CLOSE' THEN 'VALIDATE' ELSE 'REOPEN' END
  WHEN TG_TABLE_NAME IN ('payable_title_corrections','payable_payment_reclassifications') THEN 'UPDATE' ELSE 'CREATE' END;
 INSERT INTO public.audit_events(user_id,username,role_key,module,entity,record_id,action,before_value,after_value)
  VALUES(v_actor.id,v_actor.username,v_actor.role_key,'contas_pagar',TG_TABLE_NAME,NEW.id::text,v_action,
   CASE WHEN TG_TABLE_NAME='payable_title_corrections' THEN to_jsonb(NEW)->'before_value' ELSE NULL END,to_jsonb(NEW));
 RETURN NEW;
END $$;

CREATE FUNCTION public.payables_month_status(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total integer;v_reviewed integer;v_eligible integer;v_nominal numeric;v_paid numeric;v_outstanding numeric;
 v_event public.payable_month_events%ROWTYPE;v_closure public.payable_month_closures%ROWTYPE;v_import uuid;v_issues jsonb:='[]'::jsonb;
 v_status text:='OPEN';v_excluded integer;
BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_month IS NULL OR p_month<DATE '1900-01-01' OR p_month<>date_trunc('month',p_month)::date THEN
  RAISE EXCEPTION 'Informe o primeiro dia do mês de vencimento.' USING ERRCODE='22023';END IF;
 SELECT count(*)::integer,count(*) FILTER(WHERE review_status='CONCILIADO')::integer,
  count(*) FILTER(WHERE financial_status='PAID' AND amount_cents>0 AND review_status='A_CONCILIAR')::integer,
  coalesce(sum(amount_cents),0),coalesce(sum(paid_cents),0),coalesce(sum(payment_remaining_cents),0)
  INTO v_total,v_reviewed,v_eligible,v_nominal,v_paid,v_outstanding FROM public.payable_review_titles
  WHERE due_date>=p_month AND due_date<(p_month+interval '1 month')::date AND closing_eligible;
 SELECT count(*)::integer INTO v_excluded FROM public.payable_review_titles WHERE due_date>=p_month AND due_date<(p_month+interval '1 month')::date AND NOT closing_eligible;
 IF greatest(v_nominal,v_paid,v_outstanding)>9007199254740991 THEN RAISE EXCEPTION 'O mês excede o limite de precisão.' USING ERRCODE='22003';END IF;
 SELECT id INTO v_import FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_import IS NULL THEN v_issues:=v_issues||jsonb_build_array('Importe o relatório completo de Contas a Pagar.');END IF;
 IF v_total=0 THEN v_issues:=v_issues||jsonb_build_array('Não há títulos com vencimento neste mês.');END IF;
 IF v_reviewed<v_total THEN v_issues:=v_issues||jsonb_build_array('Todos os títulos devem estar totalmente pagos e marcados como CONCILIADO.');END IF;
 SELECT * INTO v_event FROM public.payable_month_events WHERE month=p_month ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT * INTO v_closure FROM public.payable_month_closures WHERE month=p_month ORDER BY version DESC LIMIT 1;
 IF v_event.action='CLOSE' AND v_reviewed=v_total AND v_total>0 THEN v_status:='CLOSED';END IF;
 RETURN jsonb_build_object('month',p_month,'status',v_status,'total_titles',v_total,'reconciled_count',v_reviewed,
  'excluded_historical_count',v_excluded,'excluded_legacy_count',v_excluded,'pending_count',v_total-v_reviewed,'eligible_count',v_eligible,'total_nominal_cents',v_nominal,'total_paid_cents',v_paid,
  'outstanding_cents',v_outstanding,'can_close',v_status='OPEN' AND jsonb_array_length(v_issues)=0,
  'revision',public.get_payables_revision(),'latest_closure',CASE WHEN v_closure.id IS NULL THEN NULL ELSE
   jsonb_build_object('id',v_closure.id,'version',v_closure.version,'created_at',v_closure.created_at,'created_by',v_closure.created_by,'observation',v_closure.observation) END,
  'last_event',CASE WHEN v_event.id IS NULL THEN NULL ELSE to_jsonb(v_event) END,'issues',v_issues);
END $$;

CREATE FUNCTION public.close_payables_month(p_month date,p_observation text,p_expected_revision jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_status jsonb;v_titles jsonb;v_historical jsonb;v_payments jsonb;v_realized jsonb;v_real_rows jsonb;v_id uuid;v_version integer;v_previous timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 IF p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Informe a observação do fechamento.' USING ERRCODE='22023';END IF;
 v_status:=public.payables_month_status(p_month);
 IF v_status->'revision' IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'A base mudou. Atualize o mês antes de fechar.' USING ERRCODE='40001';END IF;
 IF NOT coalesce((v_status->>'can_close')::boolean,false) THEN RAISE EXCEPTION 'Fechamento bloqueado: confira os títulos a conciliar e a base completa.' USING ERRCODE='22023';END IF;
 IF (v_status->>'total_titles')::integer+(v_status->>'excluded_historical_count')::integer>20000 THEN RAISE EXCEPTION 'O fechamento excede 20.000 títulos. Solicite um processamento administrativo; nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
 SELECT jsonb_agg(to_jsonb(t) ORDER BY t.macro,t.due_date,t.id) INTO v_titles FROM public.payable_review_titles t
  WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND t.closing_eligible;
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.due_date,t.id),'[]'::jsonb) INTO v_historical FROM public.payable_review_titles t
  WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date AND NOT t.closing_eligible;
 IF (SELECT count(*) FROM public.payable_payments p JOIN public.payable_titles t ON t.id=p.title_id
   WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date)>50000 THEN
  RAISE EXCEPTION 'O fechamento excede 50.000 pagamentos. Solicite um processamento administrativo; nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('cancelled_at',r.created_at,'cancellation_id',r.id,
   'cancellation_observation',r.observation,'created_by_name',a.display_name) ORDER BY p.paid_on,p.id),'[]'::jsonb) INTO v_payments
  FROM public.payable_effective_payments p JOIN public.payable_titles t ON t.id=p.title_id
  LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id LEFT JOIN public.profiles a ON a.id=p.created_by
  WHERE t.due_date>=p_month AND t.due_date<(p_month+interval '1 month')::date;
 v_realized:=public.payable_payment_summary(p_month,(p_month+interval '1 month - 1 day')::date);
 IF jsonb_array_length(v_payments)>50000 OR (v_realized->>'payment_count')::integer>50000 THEN
  RAISE EXCEPTION 'O fechamento excede 50.000 pagamentos. Solicite um processamento administrativo; nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('created_by_name',a.display_name) ORDER BY p.paid_on,p.id),'[]'::jsonb) INTO v_real_rows
  FROM public.payable_effective_payments p LEFT JOIN public.profiles a ON a.id=p.created_by
  WHERE p.paid_on>=p_month AND p.paid_on<(p_month+interval '1 month')::date
   AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id);
 SELECT coalesce(max(version),0)+1,max(created_at) INTO v_version,v_previous FROM public.payable_month_closures WHERE month=p_month;
 INSERT INTO public.payable_month_closures(month,version,snapshot,source_revision,total_titles,total_nominal_cents,total_paid_cents,observation,created_by,created_at)
  VALUES(p_month,v_version,jsonb_build_object('month',p_month,'schema_version','1','titles',v_titles,'historical_titles',v_historical,'payments',v_payments,
   'realized',v_realized||jsonb_build_object('rows',v_real_rows)),v_status->'revision',(v_status->>'total_titles')::integer,
   (v_status->>'total_nominal_cents')::bigint,(v_status->>'total_paid_cents')::bigint,btrim(p_observation),auth.uid(),
   greatest(clock_timestamp(),coalesce(v_previous,'1900-01-01'::timestamptz)+interval '1 microsecond')) RETURNING id INTO v_id;
 SELECT max(created_at) INTO v_previous FROM public.payable_month_events WHERE month=p_month;
 INSERT INTO public.payable_month_events(month,closure_id,action,automatic,observation,created_by,created_at)
  VALUES(p_month,v_id,'CLOSE',false,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),coalesce(v_previous,'1900-01-01'::timestamptz)+interval '1 microsecond'));
 PERFORM cf_private.next_payable_control_revision();RETURN v_id;
END $$;

CREATE FUNCTION public.reopen_payables_month(p_month date,p_observation text,p_expected_closure_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_event public.payable_month_events%ROWTYPE;v_id uuid;BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 IF p_month IS NULL OR p_month<>date_trunc('month',p_month)::date OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Informe o mês e o motivo da reabertura.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_event FROM public.payable_month_events WHERE month=p_month ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_event.action IS DISTINCT FROM 'CLOSE' OR v_event.closure_id IS DISTINCT FROM p_expected_closure_id THEN
  RAISE EXCEPTION 'O fechamento mudou ou o mês já está aberto. Atualize antes de continuar.' USING ERRCODE='40001';END IF;
 INSERT INTO public.payable_month_events(month,closure_id,action,automatic,observation,created_by,created_at)
  VALUES(p_month,v_event.closure_id,'REOPEN',false,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),v_event.created_at+interval '1 microsecond')) RETURNING id INTO v_id;
 PERFORM cf_private.next_payable_control_revision();RETURN v_id;
END $$;

CREATE FUNCTION public.list_payable_month_closures(p_month date,p_offset integer DEFAULT 0,p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_rows jsonb;v_count integer;BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF p_month IS NULL OR p_month<>date_trunc('month',p_month)::date OR p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'Informe o mês e paginação válidos.' USING ERRCODE='22023';END IF;
 SELECT count(*)::integer INTO v_count FROM public.payable_month_closures WHERE month=p_month;
 SELECT coalesce(jsonb_agg(x.row ORDER BY x.version DESC),'[]'::jsonb) INTO v_rows FROM(
  SELECT c.version,(to_jsonb(c)-'snapshot')||jsonb_build_object('created_by_name',a.display_name) row FROM public.payable_month_closures c
   LEFT JOIN public.profiles a ON a.id=c.created_by WHERE c.month=p_month ORDER BY c.version DESC OFFSET p_offset LIMIT p_limit) x;
 RETURN jsonb_build_object('rows',v_rows,'count',v_count);
END $$;
CREATE FUNCTION public.read_payable_month_closure(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_row jsonb;BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT to_jsonb(c)||jsonb_build_object('created_by_name',a.display_name) INTO v_row FROM public.payable_month_closures c LEFT JOIN public.profiles a ON a.id=c.created_by WHERE c.id=p_id;
 IF v_row IS NULL THEN RAISE EXCEPTION 'Fechamento não encontrado.' USING ERRCODE='22023';END IF;RETURN v_row;
END $$;
DO $$ DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['payable_title_reviews','payable_title_corrections','payable_payment_reclassifications','payable_month_closures','payable_month_events','payable_title_macro_overrides'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION cf_private.block_payable_closing_history()',v_table||'_immutable',v_table);
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION cf_private.audit_payable_closing_history()',v_table||'_audit',v_table);
 END LOOP;
END $$;

CREATE OR REPLACE VIEW public.payable_financial_titles WITH(security_invoker=true) AS
 SELECT t.*,
   coalesce(p.paid_cents,0)::bigint AS paid_cents,
   (CASE WHEN t.status IN ('NEW','OPEN') OR coalesce(p.paid_cents,0)>0
     THEN greatest(t.amount_cents-coalesce(p.paid_cents,0),0) ELSE 0 END)::bigint AS outstanding_cents,
   greatest(coalesce(p.paid_cents,0)-t.amount_cents,0)::bigint AS overpaid_cents,
   greatest(t.amount_cents-coalesce(p.paid_cents,0),0)::bigint AS payment_remaining_cents,
   CASE WHEN coalesce(p.paid_cents,0)>t.amount_cents THEN 'OVERPAID'
     WHEN coalesce(p.paid_cents,0)=t.amount_cents AND coalesce(p.paid_cents,0)>0 THEN 'PAID'
     WHEN coalesce(p.paid_cents,0)>0 THEN 'PARTIAL'
     WHEN t.status='SETTLED_IMPORT' THEN 'PENDING_RECONCILIATION' ELSE 'OPEN' END AS financial_status,
   p.last_payment_date,last_bank.bank_label AS last_payment_bank,coalesce(control.payment_token,revision.id) AS payment_revision
 FROM public.payable_titles t
 LEFT JOIN public.payable_title_control_revisions control ON control.title_id=t.id
 LEFT JOIN LATERAL(SELECT sum(p.amount_cents) paid_cents,max(p.paid_on) last_payment_date
   FROM public.payable_payments p WHERE p.title_id=t.id
     AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) p ON true
 LEFT JOIN LATERAL(SELECT p.bank_label FROM public.payable_payments p WHERE p.title_id=t.id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)
   ORDER BY p.paid_on DESC,p.event_revision DESC LIMIT 1) last_bank ON true
 LEFT JOIN LATERAL(SELECT e.id FROM (
   SELECT p.id,p.event_revision FROM public.payable_payments p WHERE p.title_id=t.id
   UNION ALL SELECT r.id,r.event_revision FROM public.payable_payment_reversals r
     JOIN public.payable_payments p ON p.id=r.payment_id WHERE p.title_id=t.id
 ) e ORDER BY e.event_revision DESC LIMIT 1) revision ON true;

CREATE FUNCTION cf_private.preserve_payable_macro_override() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_override public.payable_title_macro_overrides%ROWTYPE;BEGIN
 SELECT * INTO v_override FROM public.payable_title_macro_overrides WHERE title_id=OLD.id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF OLD.plan IS DISTINCT FROM NEW.plan AND v_override.active THEN
  INSERT INTO public.payable_title_macro_overrides(title_id,plan,macro,active,observation,created_by,created_at)
   VALUES(OLD.id,NEW.plan,NULL,false,'O plano da importação mudou; a classificação específica anterior deixou de valer.',auth.uid(),greatest(clock_timestamp(),v_override.created_at+interval '1 microsecond'));
 ELSIF NEW.last_import_id IS DISTINCT FROM OLD.last_import_id AND OLD.plan=NEW.plan AND v_override.active AND v_override.plan=NEW.plan THEN
  NEW.macro:=v_override.macro;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER payable_macro_override_preserve BEFORE UPDATE ON public.payable_titles FOR EACH ROW EXECUTE FUNCTION cf_private.preserve_payable_macro_override();

CREATE FUNCTION cf_private.payable_closing_exclusion(p_title_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.payable_titles t JOIN cf_private.payable_identity_registry i
  ON i.scope=t.scope AND i.business_key=cf_private.payable_business_key(t.branch,t.entry_number)
  WHERE t.id=p_title_id AND t.status='SETTLED_IMPORT' AND i.title_id<>t.id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=t.id
    AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id))) THEN
  RETURN 'Versão anterior preservada no histórico; a identidade canônica está vinculada a outro título.';
 END IF;RETURN NULL;
END $$;

CREATE VIEW public.payable_effective_payments WITH(security_invoker=true) AS
 SELECT p.*,coalesce(r.macro,p.macro_snapshot) AS effective_macro,r.id AS reclassification_id
 FROM public.payable_payments p LEFT JOIN LATERAL(SELECT r.id,r.macro FROM public.payable_payment_reclassifications r
  WHERE r.payment_id=p.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true;
CREATE VIEW public.payable_review_titles WITH(security_invoker=true) AS
 SELECT f.*,CASE WHEN r.reviewed AND r.fingerprint=h.fingerprint AND f.financial_status='PAID' AND f.amount_cents>0
   THEN 'CONCILIADO' ELSE 'A_CONCILIAR' END AS review_status,
  r.id AS review_id,r.created_at AS reviewed_at,r.created_by AS reviewed_by,h.fingerprint AS review_fingerprint,
  exclusion.reason IS NULL AS closing_eligible,exclusion.reason AS closing_exclusion_reason
 FROM public.payable_financial_titles f LEFT JOIN public.payable_title_control_revisions c ON c.title_id=f.id
 CROSS JOIN LATERAL(SELECT encode(sha256(convert_to(jsonb_build_object(
  'title',to_jsonb(f)-ARRAY['last_import_id','first_import_id','source_key','settled_at','status'],
  'source_active',f.status<>'SETTLED_IMPORT','control_revision',coalesce(c.revision,0))::text,'UTF8')),'hex') AS fingerprint) h
 CROSS JOIN LATERAL(SELECT cf_private.payable_closing_exclusion(f.id) AS reason) exclusion
 LEFT JOIN LATERAL(SELECT r.* FROM public.payable_title_reviews r WHERE r.title_id=f.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true;
REVOKE ALL ON TABLE public.payable_effective_payments,public.payable_review_titles FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.payable_effective_payments,public.payable_review_titles TO authenticated;

CREATE FUNCTION cf_private.next_payable_control_revision() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_revision bigint;BEGIN
 UPDATE cf_private.payable_control_state SET revision=revision+1 WHERE singleton RETURNING revision INTO v_revision;RETURN v_revision;
END $$;
CREATE FUNCTION cf_private.reopen_changed_payable_month(p_month date,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_last public.payable_month_events%ROWTYPE;BEGIN
 IF p_month IS NULL THEN RETURN;END IF;
 SELECT * INTO v_last FROM public.payable_month_events WHERE month=date_trunc('month',p_month)::date ORDER BY created_at DESC,id DESC LIMIT 1;
 IF v_last.action='CLOSE' THEN
  INSERT INTO public.payable_month_events(month,closure_id,action,automatic,observation,created_by,created_at)
   VALUES(v_last.month,v_last.closure_id,'REOPEN',true,left(p_reason,1000),auth.uid(),greatest(clock_timestamp(),v_last.created_at+interval '1 microsecond'));
 END IF;
END $$;
CREATE FUNCTION cf_private.invalidate_payable_review(p_title_id uuid,p_reason text,p_old_due date DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_revision bigint;v_month date;BEGIN
 v_revision:=cf_private.next_payable_control_revision();
 INSERT INTO public.payable_title_control_revisions(title_id,revision) VALUES(p_title_id,v_revision)
  ON CONFLICT(title_id) DO UPDATE SET revision=EXCLUDED.revision,payment_token=gen_random_uuid();
 FOR v_month IN SELECT DISTINCT date_trunc('month',d)::date FROM(
  SELECT due_date d FROM public.payable_titles WHERE id=p_title_id
  UNION ALL SELECT p_old_due UNION ALL SELECT paid_on FROM public.payable_payments WHERE title_id=p_title_id) dates WHERE d IS NOT NULL LOOP
  PERFORM cf_private.reopen_changed_payable_month(v_month,p_reason);
 END LOOP;
END $$;
CREATE FUNCTION cf_private.payable_title_review_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM cf_private.invalidate_payable_review(NEW.id,'Novo título na base após o fechamento.');
 ELSIF ROW(OLD.entry_number,OLD.description,OLD.due_date,OLD.amount_cents,OLD.source_status,OLD.plan,OLD.bank_account,OLD.branch,OLD.issued_on,OLD.macro,OLD.status='SETTLED_IMPORT')
  IS DISTINCT FROM ROW(NEW.entry_number,NEW.description,NEW.due_date,NEW.amount_cents,NEW.source_status,NEW.plan,NEW.bank_account,NEW.branch,NEW.issued_on,NEW.macro,NEW.status='SETTLED_IMPORT') THEN
  PERFORM cf_private.invalidate_payable_review(NEW.id,'Dados do título alterados; confira e concilie novamente.',OLD.due_date);
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION cf_private.payable_payment_review_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_title uuid;BEGIN
 IF TG_TABLE_NAME='payable_payments' THEN v_title:=NEW.title_id;
 ELSE SELECT title_id INTO v_title FROM public.payable_payments WHERE id=NEW.payment_id;END IF;
 PERFORM cf_private.invalidate_payable_review(v_title,'Pagamento, estorno ou classificação financeira alterados; confira o fechamento.');RETURN NEW;
END $$;
CREATE TRIGGER payable_title_review_change AFTER INSERT OR UPDATE ON public.payable_titles FOR EACH ROW EXECUTE FUNCTION cf_private.payable_title_review_change();
CREATE TRIGGER payable_payment_review_change AFTER INSERT ON public.payable_payments FOR EACH ROW EXECUTE FUNCTION cf_private.payable_payment_review_change();
CREATE TRIGGER payable_reversal_review_change AFTER INSERT ON public.payable_payment_reversals FOR EACH ROW EXECUTE FUNCTION cf_private.payable_payment_review_change();
CREATE TRIGGER payable_reclassification_review_change AFTER INSERT ON public.payable_payment_reclassifications FOR EACH ROW EXECUTE FUNCTION cf_private.payable_payment_review_change();

CREATE OR REPLACE FUNCTION public.get_payables_revision() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE v_import uuid;v_revision text;BEGIN
 IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 SELECT id INTO v_import FROM public.payable_imports WHERE scope='grupo-consolidado' ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT p.revision::text||':'||c.revision::text INTO v_revision FROM cf_private.payable_payment_state p CROSS JOIN cf_private.payable_control_state c WHERE p.singleton AND c.singleton;
 RETURN jsonb_build_object('import_id',v_import,'financial_revision',v_revision);
END $$;

CREATE FUNCTION public.review_payable_title(p_title_id uuid,p_observation text,p_expected_fingerprint text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_title public.payable_review_titles%ROWTYPE;v_id uuid;BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 IF p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Informe a observação da conciliação.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_title FROM public.payable_review_titles WHERE id=p_title_id;
 IF v_title.id IS NULL THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='22023';END IF;
 IF v_title.review_fingerprint IS DISTINCT FROM p_expected_fingerprint THEN RAISE EXCEPTION 'O título mudou. Confira os dados atualizados.' USING ERRCODE='40001';END IF;
 IF NOT v_title.closing_eligible THEN RAISE EXCEPTION 'Esta versão anterior é somente histórica e não integra o fechamento.' USING ERRCODE='22023';END IF;
 IF v_title.financial_status<>'PAID' OR v_title.amount_cents<=0 OR v_title.paid_cents<>v_title.amount_cents THEN
  RAISE EXCEPTION 'Somente um título totalmente pago, sem diferença, pode ser conciliado.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.payable_titles t WHERE t.id<>v_title.id AND t.scope=v_title.scope
  AND cf_private.payable_business_key(t.branch,t.entry_number)=cf_private.payable_business_key(v_title.branch,v_title.entry_number)
  AND (t.status<>'SETTLED_IMPORT' OR EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=t.id AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)))) THEN RAISE EXCEPTION 'A identidade do título possui versões ativas ambíguas.' USING ERRCODE='P0016';END IF;
 IF v_title.review_status='CONCILIADO' THEN RETURN v_title.review_id;END IF;
 INSERT INTO public.payable_title_reviews(title_id,fingerprint,reviewed,observation,created_by)
  VALUES(p_title_id,v_title.review_fingerprint,true,btrim(p_observation),auth.uid()) RETURNING id INTO v_id;
 PERFORM cf_private.next_payable_control_revision();RETURN v_id;
END $$;

CREATE FUNCTION public.correct_payable_title(p_title_id uuid,p_due_date date,p_amount_cents bigint,p_bank_account text,
 p_description text,p_issued_on date,p_macro text,p_observation text,p_expected_fingerprint text,p_reclassify_payments boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_title public.payable_review_titles%ROWTYPE;v_before jsonb;v_after jsonb;v_id uuid;v_has_payments boolean;v_do_reclass boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF NOT(cf_private.has_permission('contas_pagar','read') AND cf_private.has_permission('contas_pagar','write')) THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(2045812305,hashtext('grupo-consolidado'));
 IF p_due_date IS NULL OR p_due_date<DATE '1900-01-01' OR p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 1 AND 9007199254740991
  OR p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 1500 OR length(coalesce(p_bank_account,''))>300
  OR (p_issued_on IS NOT NULL AND p_issued_on<DATE '1900-01-01') OR NOT EXISTS(SELECT 1 FROM public.payable_macros WHERE name=p_macro)
  OR p_observation IS NULL OR length(btrim(p_observation)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Confira valor positivo em centavos, datas, favorecido, banco, macro e motivo da correção.' USING ERRCODE='22023';END IF;
 SELECT * INTO v_title FROM public.payable_review_titles WHERE id=p_title_id;
 IF v_title.id IS NULL THEN RAISE EXCEPTION 'Título não encontrado.' USING ERRCODE='22023';END IF;
 IF v_title.review_fingerprint IS DISTINCT FROM p_expected_fingerprint THEN RAISE EXCEPTION 'O título mudou. Confira os dados antes de corrigir.' USING ERRCODE='40001';END IF;
 IF NOT v_title.closing_eligible THEN RAISE EXCEPTION 'Esta versão anterior é somente histórica. Corrija o título canônico.' USING ERRCODE='22023';END IF;
 SELECT p_reclassify_payments IS TRUE AND EXISTS(SELECT 1 FROM public.payable_effective_payments p WHERE p.title_id=p_title_id
  AND p.effective_macro<>p_macro AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) INTO v_do_reclass;
 IF ROW(v_title.due_date,v_title.amount_cents,v_title.bank_account,v_title.description,v_title.issued_on,v_title.macro)
  IS NOT DISTINCT FROM ROW(p_due_date,p_amount_cents,nullif(btrim(p_bank_account),''),btrim(p_description),p_issued_on,p_macro) AND NOT v_do_reclass THEN
  RAISE EXCEPTION 'Nenhum dado foi alterado.' USING ERRCODE='22023';END IF;
 SELECT EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=p_title_id AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)) INTO v_has_payments;
 IF p_macro<>v_title.macro AND v_has_payments AND p_reclassify_payments IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Confirme expressamente a reclassificação dos pagamentos deste título para o novo macro.' USING ERRCODE='22023';END IF;
 SELECT to_jsonb(t) INTO v_before FROM public.payable_titles t WHERE id=p_title_id;
 v_after:=v_before||jsonb_build_object('due_date',p_due_date,'amount_cents',p_amount_cents,'bank_account',nullif(btrim(p_bank_account),''),
  'description',btrim(p_description),'issued_on',p_issued_on,'macro',p_macro);
 INSERT INTO public.payable_title_corrections(title_id,before_value,after_value,observation,created_by)
  VALUES(p_title_id,v_before,v_after,btrim(p_observation),auth.uid()) RETURNING id INTO v_id;
 IF p_macro<>v_title.macro OR v_do_reclass THEN
  INSERT INTO public.payable_title_macro_overrides(title_id,plan,macro,active,correction_id,observation,created_by,created_at)
   SELECT p_title_id,v_title.plan,p_macro,true,v_id,btrim(p_observation),auth.uid(),greatest(clock_timestamp(),coalesce(max(created_at),'1900-01-01'::timestamptz)+interval '1 microsecond')
   FROM public.payable_title_macro_overrides WHERE title_id=p_title_id;
 END IF;
 UPDATE public.payable_titles SET due_date=p_due_date,amount_cents=p_amount_cents,bank_account=nullif(btrim(p_bank_account),''),
  description=btrim(p_description),issued_on=p_issued_on,macro=p_macro WHERE id=p_title_id;
 IF v_do_reclass THEN
  INSERT INTO public.payable_payment_reclassifications(payment_id,correction_id,macro,previous_macro,created_by,created_at)
   SELECT p.id,v_id,p_macro,p.effective_macro,auth.uid(),greatest(clock_timestamp(),coalesce(old.created_at,'1900-01-01'::timestamptz)+interval '1 microsecond')
   FROM public.payable_effective_payments p LEFT JOIN LATERAL(SELECT r.created_at FROM public.payable_payment_reclassifications r WHERE r.payment_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1) old ON true
   WHERE p.title_id=p_title_id AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id) AND p.effective_macro<>p_macro;
 END IF;RETURN v_id;
END $$;

-- A correção expressa usa alocações novas e conserva o macro original do pagamento.
CREATE OR REPLACE FUNCTION public.payable_payment_summary(p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total numeric;v_count integer;v_macros jsonb;v_pending integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start<DATE '1900-01-01' OR p_end<p_start OR p_end-p_start>3660 THEN
    RAISE EXCEPTION 'Informe o período real de pagamento.' USING ERRCODE='22023'; END IF;
  SELECT coalesce(sum(p.amount_cents),0),count(*)::integer INTO v_total,v_count FROM public.payable_effective_payments p
    WHERE p.paid_on BETWEEN p_start AND p_end AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id);
  IF v_total>9007199254740991 THEN RAISE EXCEPTION 'O realizado excede o limite de precisão.' USING ERRCODE='22003'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('macro',m.name,'amount_cents',coalesce(p.amount_cents,0),'count',coalesce(p.n,0)) ORDER BY m.name),'[]'::jsonb)
    INTO v_macros FROM public.payable_macros m LEFT JOIN(SELECT p.effective_macro,sum(p.amount_cents) amount_cents,count(*) n
      FROM public.payable_effective_payments p WHERE p.paid_on BETWEEN p_start AND p_end
      AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id) GROUP BY p.effective_macro) p ON p.effective_macro=m.name;
  SELECT count(*)::integer INTO v_pending FROM public.payable_financial_titles WHERE financial_status='PENDING_RECONCILIATION';
  RETURN jsonb_build_object('start_date',p_start,'end_date',p_end,'total_paid_cents',v_total,'payment_count',v_count,
    'by_macro',v_macros,'pending_reconciliation_count',v_pending,'revision',public.get_payables_revision());
END $$;

CREATE OR REPLACE FUNCTION public.list_payable_payments(p_start date,p_end date,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,
 p_title_id uuid DEFAULT NULL,p_macro text DEFAULT NULL,p_bank_account_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb;v_count integer;
BEGIN
  IF NOT cf_private.has_permission('contas_pagar','read') THEN RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501'; END IF;
  IF (p_title_id IS NULL AND (p_start IS NULL OR p_end IS NULL))
    OR (p_start IS NOT NULL AND p_start<DATE '1900-01-01')
    OR (p_start IS NOT NULL AND p_end IS NOT NULL AND (p_end<p_start OR (p_title_id IS NULL AND p_end-p_start>3660)))
    OR p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Informe um período e paginação válidos.' USING ERRCODE='22023'; END IF;
  SELECT count(*)::integer INTO v_count FROM public.payable_effective_payments p
    LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id
    WHERE (p_start IS NULL OR p.paid_on>=p_start) AND (p_end IS NULL OR p.paid_on<=p_end) AND (p_title_id IS NULL OR p.title_id=p_title_id)
      AND (p_title_id IS NOT NULL OR r.id IS NULL) AND (p_macro IS NULL OR p.effective_macro=p_macro)
      AND (p_bank_account_id IS NULL OR p.bank_account_id=p_bank_account_id);
  SELECT coalesce(jsonb_agg(x.row ORDER BY x.paid_on DESC,x.event_revision DESC),'[]'::jsonb) INTO v_rows FROM(
    SELECT p.paid_on,p.event_revision,to_jsonb(p)||jsonb_build_object('cancelled_at',r.created_at,'cancelled_by',r.created_by,
      'cancellation_id',r.id,'cancellation_observation',r.observation,'status',CASE WHEN r.id IS NULL THEN 'ACTIVE' ELSE 'CANCELLED' END,
      'created_by_name',creator.display_name,'created_by_username',creator.username,'cancelled_by_name',canceller.display_name,
      'title_status',financial.status,'financial_status',financial.financial_status,'review_status',financial.review_status) row
    FROM public.payable_effective_payments p LEFT JOIN public.payable_payment_reversals r ON r.payment_id=p.id
      LEFT JOIN public.profiles creator ON creator.id=p.created_by LEFT JOIN public.profiles canceller ON canceller.id=r.created_by
      JOIN public.payable_review_titles financial ON financial.id=p.title_id
    WHERE (p_start IS NULL OR p.paid_on>=p_start) AND (p_end IS NULL OR p.paid_on<=p_end) AND (p_title_id IS NULL OR p.title_id=p_title_id)
      AND (p_title_id IS NOT NULL OR r.id IS NULL) AND (p_macro IS NULL OR p.effective_macro=p_macro)
      AND (p_bank_account_id IS NULL OR p.bank_account_id=p_bank_account_id)
    ORDER BY p.paid_on DESC,p.event_revision DESC OFFSET p_offset LIMIT p_limit) x;
  RETURN jsonb_build_object('rows',v_rows,'count',v_count,'revision',public.get_payables_revision());
END $$;

CREATE FUNCTION cf_private.guard_payable_payment_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE v_title public.payable_titles%ROWTYPE;BEGIN
 IF cf_private.payable_closing_exclusion(NEW.title_id) IS NOT NULL THEN
  RAISE EXCEPTION 'Versão anterior somente histórica. Registre o pagamento no título canônico.' USING ERRCODE='P0016';END IF;
 SELECT * INTO v_title FROM public.payable_titles WHERE id=NEW.title_id;
 IF EXISTS(SELECT 1 FROM public.payable_titles other WHERE other.id<>NEW.title_id AND other.scope=v_title.scope
  AND cf_private.payable_business_key(other.branch,other.entry_number)=cf_private.payable_business_key(v_title.branch,v_title.entry_number)
  AND (other.status<>'SETTLED_IMPORT' OR EXISTS(SELECT 1 FROM public.payable_payments p WHERE p.title_id=other.id
   AND NOT EXISTS(SELECT 1 FROM public.payable_payment_reversals r WHERE r.payment_id=p.id)))) THEN
  RAISE EXCEPTION 'Há versões ativas ou pagamentos em outra versão da mesma identidade. Confira o histórico antes de continuar.' USING ERRCODE='P0016';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payable_payment_identity_guard BEFORE INSERT ON public.payable_payments FOR EACH ROW EXECUTE FUNCTION cf_private.guard_payable_payment_identity();

REVOKE ALL ON FUNCTION cf_private.payable_closing_exclusion(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cf_private.payable_closing_exclusion(uuid) TO authenticated;
REVOKE ALL ON FUNCTION cf_private.guard_payable_payment_identity() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION cf_private.block_payable_closing_history(),cf_private.audit_payable_closing_history(),
 cf_private.next_payable_control_revision(),cf_private.reopen_changed_payable_month(date,text),
 cf_private.invalidate_payable_review(uuid,text,date),cf_private.payable_title_review_change(),
 cf_private.payable_payment_review_change(),cf_private.preserve_payable_macro_override() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.review_payable_title(uuid,text,text),
 public.correct_payable_title(uuid,date,bigint,text,text,date,text,text,text,boolean),public.payables_month_status(date),
 public.close_payables_month(date,text,jsonb),public.reopen_payables_month(date,text,uuid),
 public.list_payable_month_closures(date,integer,integer),public.read_payable_month_closure(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.review_payable_title(uuid,text,text),
 public.correct_payable_title(uuid,date,bigint,text,text,date,text,text,text,boolean),public.payables_month_status(date),
 public.close_payables_month(date,text,jsonb),public.reopen_payables_month(date,text,uuid),
 public.list_payable_month_closures(date,integer,integer),public.read_payable_month_closure(uuid) TO authenticated;
COMMENT ON VIEW public.payable_review_titles IS 'Revisão explícita válida apenas com pagamento integral exato e a mesma versão comercial/financeira. Importação idêntica, last_import_id e NEW para OPEN não invalidam a revisão.';
COMMENT ON TABLE public.payable_month_closures IS 'Posições imutáveis por versão do fechamento. Títulos selecionados pelo vencimento; realizados pela data efetiva do pagamento, inclusive títulos de outros meses.';
COMMENT ON TABLE public.payable_title_macro_overrides IS 'Correção específica do título, preservada em importações do mesmo plano. Uma mudança de plano cancela a substituição anterior com histórico.';
INSERT INTO public.central_schema_migrations(version) VALUES('017_payable_month_closing');
-- END SOURCE BODY: 017_payable_month_closing.sql
$cf_source_017_86d3a2064bdbfc14_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='017_payable_month_closing') THEN
      RAISE EXCEPTION 'A atualização 017_payable_month_closing não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_apply_017_07659146c8bddccb_0$;

-- SOURCE: 018_payable_full_payment.sql
DO $cf_apply_018_295a03c7567fa546_0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='018_payable_full_payment') THEN
    RAISE NOTICE 'Atualização 018_payable_full_payment já instalada; dados e configurações preservados.';
  ELSE
    EXECUTE $cf_source_018_c27cafe2974fe25e_0$
-- SOURCE BODY: 018_payable_full_payment.sql
-- Regra atual: Contas a Pagar possui somente quitação integral.
-- Incremental após 017. Não altera nem exclui pagamentos históricos parciais.
-- Um saldo parcial antigo pode receber apenas o complemento integral exato.

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
-- END SOURCE BODY: 018_payable_full_payment.sql
$cf_source_018_c27cafe2974fe25e_0$;
    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='018_payable_full_payment') THEN
      RAISE EXCEPTION 'A atualização 018_payable_full_payment não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$cf_apply_018_295a03c7567fa546_0$;

COMMIT;
