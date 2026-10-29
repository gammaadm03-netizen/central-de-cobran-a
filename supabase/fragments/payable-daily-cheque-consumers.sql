-- A classificação de cheque é a mesma da importação diária: situação CHEQUE
-- ou número explícito informado. O subtotal continua incluído na obrigação;
-- não altera vencimento, nominal, pagamentos, estimativas ou posições salvas.
DO $cf_daily_cheque_consumers_058$
DECLARE
 v_signature text;
 v_definition text;
 v_old text := $predicate$upper(btrim(source_status))='CHEQUE'$predicate$;
 v_new text := $predicate$cf_private.payable_daily_is_cheque(source_status,cheque_number) /* payable_daily_058_cheque */$predicate$;
 v_old_projection text := 'SELECT id,macro,due_date,amount_cents,payment_remaining_cents,source_status,status,paid_cents';
 v_new_projection text := 'SELECT id,macro,due_date,amount_cents,payment_remaining_cents,source_status,status,paid_cents,cheque_number';
BEGIN
 IF to_regprocedure('cf_private.payable_daily_is_cheque(text,text)') IS NULL THEN
  RAISE EXCEPTION 'Ative a classificação de cheques da atualização 058 antes dos seus resumos.' USING ERRCODE='22023';
 END IF;
 FOREACH v_signature IN ARRAY ARRAY['public.payables_management_summary(date,date)','public.payables_forecast(date)'] LOOP
  IF to_regprocedure(v_signature) IS NULL THEN
   RAISE EXCEPTION 'O resumo % não corresponde ao contrato de cheques esperado da atualização 058.',v_signature USING ERRCODE='22023';
  END IF;
  v_definition := pg_get_functiondef(v_signature::regprocedure);
  IF position('payable_daily_058_cheque' IN v_definition)>0 THEN
   IF (length(v_definition)-length(replace(v_definition,v_new,'')))/length(v_new)<>2
    OR (length(v_definition)-length(replace(v_definition,'payable_daily_058_cheque','')))/length('payable_daily_058_cheque')<>2
    OR position(v_old IN v_definition)>0
    OR (v_signature='public.payables_management_summary(date,date)' AND position(v_new_projection IN v_definition)=0) THEN
    RAISE EXCEPTION 'A classificação de cheques do resumo % foi alterada. Confira a atualização 058.',v_signature USING ERRCODE='22023';
   END IF;
   CONTINUE;
  END IF;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>2 THEN
   RAISE EXCEPTION 'O subtotal de cheques do resumo % não corresponde ao contrato esperado.',v_signature USING ERRCODE='22023';
  END IF;
  IF v_signature='public.payables_management_summary(date,date)' THEN
   IF (length(v_definition)-length(replace(v_definition,v_old_projection,'')))/length(v_old_projection)<>1
    OR position(v_new_projection IN v_definition)>0 THEN
    RAISE EXCEPTION 'A origem dos campos do resumo gerencial foi alterada. Confira a atualização 058.' USING ERRCODE='22023';
   END IF;
   v_definition := replace(v_definition,v_old_projection,v_new_projection);
  END IF;
  EXECUTE replace(v_definition,v_old,v_new);
 END LOOP;
END $cf_daily_cheque_consumers_058$;
