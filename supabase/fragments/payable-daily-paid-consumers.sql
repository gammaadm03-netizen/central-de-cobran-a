-- A fonte explícita de pagamentos pode corrigir somente pagamentos que já
-- pertencem a importações: ERP anterior ou baixa inferida pelo relatório 058.
-- Pagamentos manuais continuam sujeitos à conferência e ao estorno explícitos.
DO $cf_daily_paid_consumers_058$
DECLARE
 v_signature text := 'cf_private.preview_payable_paid_rows(jsonb,jsonb,jsonb)';
 v_definition text;
 v_original text := $owned$coalesce(bool_and(EXISTS(SELECT 1 FROM public.payable_paid_import_rows own WHERE own.outcome IN ('CREATED','CORRECTED') AND p.id=ANY(own.payment_ids))),false)$owned$;
 v_replacement text := $owned$coalesce(bool_and((EXISTS(SELECT 1 FROM public.payable_paid_import_rows own WHERE own.outcome IN ('CREATED','CORRECTED') AND p.id=ANY(own.payment_ids)) OR EXISTS(SELECT 1 FROM cf_private.payable_daily_actions daily_058 WHERE daily_058.payment_id=p.id AND daily_058.title_id=p.title_id))),false) /* payable_daily_058_owned */$owned$;
BEGIN
 IF to_regprocedure(v_signature) IS NULL
  OR to_regclass('cf_private.payable_daily_actions') IS NULL THEN
  RAISE EXCEPTION 'Ative as regras de pagamentos 050 e o histórico dos relatórios diários 058 antes da compatibilidade.' USING ERRCODE='22023';
 END IF;
 v_definition := pg_get_functiondef(v_signature::regprocedure);
 IF position('payable_daily_058_owned' IN v_definition)>0 THEN
  IF (length(v_definition)-length(replace(v_definition,'payable_daily_058_owned','')))/length('payable_daily_058_owned')<>1
   OR (length(v_definition)-length(replace(v_definition,v_replacement,'')))/length(v_replacement)<>1 THEN
   RAISE EXCEPTION 'O contrato de propriedade dos pagamentos diários foi alterado. Confira a atualização 058.' USING ERRCODE='22023';
  END IF;
  RETURN;
 END IF;
 IF (length(v_definition)-length(replace(v_definition,v_original,'')))/length(v_original)<>1 THEN
  RAISE EXCEPTION 'O contrato de pagamentos 050 não corresponde à compatibilidade esperada da atualização 058.' USING ERRCODE='22023';
 END IF;
 -- CREATE OR REPLACE preserva OID, proprietário, privilégios e configurações.
 -- Nenhuma linha, pagamento, revisão ou confirmação é alterada na instalação.
 EXECUTE replace(v_definition,v_original,v_replacement);
END $cf_daily_paid_consumers_058$;
