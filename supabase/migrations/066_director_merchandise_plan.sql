-- Diretoria: mercadoria a pagar pelo Plano cp original, considerando o saldo aberto.
-- Preserva pagamentos reais, baixas por relatório, classificações e posições salvas.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $apply066$
DECLARE
 v_definition text;
 v_old text:=$old$WHERE scope='grupo-consolidado' AND outstanding_cents>0 AND macro='COMPRA DE MERCADORIA';$old$;
 v_new text:=$new$WHERE scope='grupo-consolidado' AND outstanding_cents>0 AND cf_private.normalize_payable_plan(plan)='COMPRA DE MERCADORIA';$new$;
BEGIN
 PERFORM pg_advisory_xact_lock(2045812301);
 IF to_regclass('public.central_schema_migrations') IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='015_payable_payments')
  OR to_regprocedure('public.director_report(date,date)') IS NULL
  OR to_regprocedure('cf_private.normalize_payable_plan(text)') IS NULL THEN
  RAISE EXCEPTION 'Ative as bases de Contas a Pagar e o saldo financeiro015 antes do indicador por plano.' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='066_director_merchandise_plan') THEN RETURN;END IF;

 -- Keep the installed definition, including receipt/reversal consumers and its
 -- permissions. Change only which original plan belongs to this obligation.
 v_definition:=pg_get_functiondef('public.director_report(date,date)'::regprocedure);
 IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 THEN
  RAISE EXCEPTION 'O contrato do indicador de mercadoria divergiu. A atualização foi interrompida sem alterar dados ou fórmulas.' USING ERRCODE='22023';END IF;
 EXECUTE replace(v_definition,v_old,v_new);
 INSERT INTO public.central_schema_migrations(version) VALUES('066_director_merchandise_plan');
 NOTIFY pgrst,'reload schema';
END $apply066$;
COMMIT;
