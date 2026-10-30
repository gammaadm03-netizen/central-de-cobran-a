-- FECHAMENTO SEMANAL DE COBRANÇA POR COBRADORA — somente leitura.
-- Supabase > SQL Editor > New query > Run. O resultado tem uma linha por cobradora;
-- use Export > CSV para salvar a tabela. Valores monetários já estão em reais.
-- Semana financeira: 24/10/2026 a 30/10/2026. Altere apenas as datas em parametros.
-- Recebimentos usam a responsável histórica da confirmação; finalizações usam
-- o evento histórico ligado ao protocolo. Carteira e pendências são atuais.
-- Sem prova da responsável, o movimento permanece em Sem cobradora identificada.
-- Títulos trabalhados: união de sessões e finalizações, sem duplicação por cobradora.
-- Com cobrança: evidência anterior à validação; não comprova causalidade ou comissão.
-- Zeros significam ausência de registro na Central; confira a cobertura das importações.
-- Não altera dados, instala funções, confirma recebimentos ou calcula comissões.
WITH parametros AS MATERIALIZED (
 SELECT DATE '2026-10-24' inicio,DATE '2026-10-30' fim,statement_timestamp() consultado_em
), periodo AS MATERIALIZED (
 SELECT *,inicio::timestamp AT TIME ZONE 'America/Sao_Paulo' inicio_instante,
  least((fim+1)::timestamp AT TIME ZONE 'America/Sao_Paulo',consultado_em) corte_instante,
  (consultado_em AT TIME ZONE 'America/Sao_Paulo')::date data_carteira
 FROM parametros WHERE inicio<=fim AND fim-inicio<=365
), carteira AS MATERIALIZED (
 SELECT t.id,t.document,t.client_name,t.customer_key,t.branch,t.collector_id,t.due_date,t.amount_cents,
  t.status,t.validation_status,t.next_action,t.next_action_date,
  coalesce(a.display_name,'Sem cobradora definida') cobradora,p.data_carteira-t.due_date dias_atraso
 FROM public.receivable_titles t CROSS JOIN periodo p LEFT JOIN public.collection_agents a ON a.id=t.collector_id
 WHERE t.scope='grupo-consolidado' AND t.status<>'VALIDATED'
  AND NOT coalesce((to_jsonb(t)->>'retired_from_report')::boolean,false)
), recebimentos AS MATERIALIZED (
 SELECT r.id,r.title_id,r.payment_date,r.amount_cents,r.nominal_amount_cents,r.collector_id,r.source_kind,
  r.validated_at,t.document,t.client_name,t.branch,coalesce(a.display_name,'Sem cobradora definida') cobradora,
  r.reported_in_collection OR EXISTS(SELECT 1 FROM public.collection_work_sessions s WHERE s.title_id=t.id AND s.started_at<=r.validated_at)
   OR EXISTS(SELECT 1 FROM public.receivable_collection_events e WHERE e.title_id=t.id AND e.created_at<=r.validated_at
    AND e.action IN('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','OTHER','NOT_LOCATED_CONTACT')) teve_cobranca
 FROM public.effective_receivable_receipts r JOIN public.receivable_titles t ON t.id=r.title_id
 CROSS JOIN periodo p LEFT JOIN public.collection_agents a ON a.id=r.collector_id
 WHERE t.scope='grupo-consolidado' AND t.status='VALIDATED' AND r.validation='VALIDADO'
  AND r.payment_date BETWEEN p.inicio AND least(p.fim,p.data_carteira) AND r.validated_at<=p.consultado_em
), atendimentos AS MATERIALIZED (
 SELECT e.id,e.title_id,e.case_revision,e.status,e.finalized,e.created_at,e.next_date,e.created_by,
  pr.display_name operador,t.document,t.client_name,t.branch
 FROM public.collection_case_events e JOIN public.receivable_titles t ON t.id=e.title_id
 JOIN public.profiles pr ON pr.id=e.created_by CROSS JOIN periodo p
 WHERE t.scope='grupo-consolidado' AND e.created_at>=p.inicio_instante AND e.created_at<p.corte_instante
), intervalos AS MATERIALIZED (
 SELECT s.id,s.title_id,s.collector_id,s.collector_name_snapshot cobradora,s.actor_id,
  greatest(s.started_at,p.inicio_instante) inicio,
  least(coalesce(s.ended_at,p.consultado_em),p.corte_instante) fim,s.ended_at IS NULL em_andamento,
  greatest(0,floor(extract(epoch FROM(least(coalesce(s.ended_at,p.consultado_em),p.corte_instante)
   -greatest(s.started_at,p.inicio_instante)))))::bigint segundos
 FROM public.collection_work_sessions s JOIN public.receivable_titles t ON t.id=s.title_id CROSS JOIN periodo p
 WHERE t.scope='grupo-consolidado' AND s.started_at<p.corte_instante AND coalesce(s.ended_at,p.consultado_em)>p.inicio_instante
), finalizacoes AS MATERIALIZED (
 -- A atribuição vem do evento imutável ligado ao protocolo daquela finalização.
 -- O login e a carteira atuais não reatribuem um atendimento histórico.
 SELECT a.*,prova.collector_id
 FROM atendimentos a LEFT JOIN LATERAL(
  SELECT CASE WHEN count(DISTINCT e.collector_id)=1 AND bool_and(e.collector_id IS NOT NULL)
   THEN min(e.collector_id::text)::uuid END collector_id
  FROM public.collection_work_requests w JOIN public.receivable_collection_events e
   ON e.id::text=w.result->>'event_id' AND e.title_id=a.title_id AND e.created_by=a.created_by
   AND e.action IN('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','OTHER','NOT_LOCATED_CONTACT')
  WHERE w.title_id=a.title_id AND w.actor_id=a.created_by AND w.payload->>'kind'='case'
   AND w.payload->'finish'='true'::jsonb AND w.result->'finished'='true'::jsonb
   AND w.result->>'case_revision'=a.case_revision::text
 ) prova ON true WHERE a.finalized
), retirados_pendentes AS MATERIALIZED (
 SELECT t.id,t.collector_id,t.amount_cents
 FROM public.receivable_titles t CROSS JOIN periodo p WHERE t.scope='grupo-consolidado' AND t.status<>'VALIDATED'
  AND coalesce((to_jsonb(t)->>'retired_from_report')::boolean,false)
  AND (t.reported_in_collection OR EXISTS(SELECT 1 FROM public.collection_work_sessions s WHERE s.title_id=t.id AND s.started_at<=p.consultado_em)
   OR EXISTS(SELECT 1 FROM public.receivable_collection_events e WHERE e.title_id=t.id AND e.created_at<=p.consultado_em
    AND e.action IN('CONTACT','NO_RESPONSE','PROMISE','RETRY','PAID','OTHER','NOT_LOCATED_CONTACT')))
), trabalhados_por_cobradora AS (
 SELECT collector_id,title_id FROM intervalos UNION SELECT collector_id,title_id FROM finalizacoes
), cobradoras AS (
 SELECT id collector_id FROM public.collection_agents WHERE enabled
 UNION SELECT collector_id FROM carteira UNION SELECT collector_id FROM recebimentos
 UNION SELECT collector_id FROM intervalos UNION SELECT collector_id FROM finalizacoes
 UNION SELECT collector_id FROM retirados_pendentes
), carteira_agrupada AS (
 SELECT collector_id,count(*) carteira_titulos,count(DISTINCT customer_key) carteira_clientes,sum(amount_cents) carteira_total_centavos,
  count(*) FILTER(WHERE dias_atraso>0) vencidos_quantidade,coalesce(sum(amount_cents) FILTER(WHERE dias_atraso>0),0) vencidos_centavos,
  coalesce(sum(amount_cents) FILTER(WHERE dias_atraso<=0),0) a_vencer_centavos,
  count(*) FILTER(WHERE status='PENDING_VALIDATION') validacao_pendente_quantidade,
  coalesce(sum(amount_cents) FILTER(WHERE status='PENDING_VALIDATION'),0) validacao_pendente_nominal_centavos,
  count(*) FILTER(WHERE next_action_date<(SELECT data_carteira FROM periodo)) retornos_vencidos_quantidade,
  count(*) FILTER(WHERE next_action_date=(SELECT data_carteira FROM periodo)) retornos_hoje_quantidade
 FROM carteira GROUP BY collector_id
), recebimentos_agrupados AS (
 SELECT collector_id,count(*) recebimentos_quantidade,sum(amount_cents) recebido_centavos,
  count(*) FILTER(WHERE teve_cobranca) com_cobranca_quantidade,
  coalesce(sum(amount_cents) FILTER(WHERE teve_cobranca),0) com_cobranca_centavos,
  coalesce(sum(amount_cents) FILTER(WHERE NOT teve_cobranca),0) sem_cobranca_centavos
 FROM recebimentos GROUP BY collector_id
), tempo_agrupado AS (
 SELECT collector_id,sum(segundos) tempo_segundos,count(*) sessoes,
  count(*) FILTER(WHERE em_andamento) sessoes_em_andamento FROM intervalos GROUP BY collector_id
), finalizacoes_agrupadas AS (
 SELECT collector_id,count(*) atendimentos_finalizados,count(DISTINCT title_id) titulos_com_finalizacao
 FROM finalizacoes GROUP BY collector_id
), trabalho_agrupado AS (
 SELECT collector_id,count(*) titulos_trabalhados FROM trabalhados_por_cobradora GROUP BY collector_id
), retirados_agrupados AS (
 SELECT collector_id,count(*) retirados_aguardando_quantidade,sum(amount_cents) retirados_aguardando_nominal_centavos
 FROM retirados_pendentes GROUP BY collector_id
), fechamento_por_cobradora AS (
 SELECT c.collector_id,coalesce(a.display_name,'Sem cobradora identificada') cobradora,
  coalesce(w.titulos_trabalhados,0) titulos_trabalhados,coalesce(f.atendimentos_finalizados,0) atendimentos_finalizados,
  coalesce(f.titulos_com_finalizacao,0) titulos_com_finalizacao,
  coalesce(t.tempo_segundos,0) tempo_segundos,coalesce(t.sessoes,0) sessoes,coalesce(t.sessoes_em_andamento,0) sessoes_em_andamento,
  coalesce(r.recebimentos_quantidade,0) recebimentos_quantidade,coalesce(r.recebido_centavos,0) recebido_centavos,
  coalesce(r.com_cobranca_quantidade,0) com_cobranca_quantidade,coalesce(r.com_cobranca_centavos,0) com_cobranca_centavos,
  coalesce(r.sem_cobranca_centavos,0) sem_cobranca_centavos,
  coalesce(k.carteira_titulos,0) carteira_titulos,coalesce(k.carteira_clientes,0) carteira_clientes,
  coalesce(k.carteira_total_centavos,0) carteira_total_centavos,
  coalesce(k.vencidos_quantidade,0) vencidos_quantidade,coalesce(k.vencidos_centavos,0) vencidos_centavos,
  coalesce(k.a_vencer_centavos,0) a_vencer_centavos,
  coalesce(k.validacao_pendente_quantidade,0) validacao_pendente_quantidade,
  coalesce(k.validacao_pendente_nominal_centavos,0) validacao_pendente_nominal_centavos,
  coalesce(k.retornos_vencidos_quantidade,0) retornos_vencidos_quantidade,coalesce(k.retornos_hoje_quantidade,0) retornos_hoje_quantidade,
  coalesce(p.retirados_aguardando_quantidade,0) retirados_aguardando_quantidade,
  coalesce(p.retirados_aguardando_nominal_centavos,0) retirados_aguardando_nominal_centavos
 FROM cobradoras c LEFT JOIN public.collection_agents a ON a.id=c.collector_id
 LEFT JOIN carteira_agrupada k ON k.collector_id IS NOT DISTINCT FROM c.collector_id
 LEFT JOIN recebimentos_agrupados r ON r.collector_id IS NOT DISTINCT FROM c.collector_id
 LEFT JOIN tempo_agrupado t ON t.collector_id IS NOT DISTINCT FROM c.collector_id
 LEFT JOIN finalizacoes_agrupadas f ON f.collector_id IS NOT DISTINCT FROM c.collector_id
 LEFT JOIN trabalho_agrupado w ON w.collector_id IS NOT DISTINCT FROM c.collector_id
 LEFT JOIN retirados_agrupados p ON p.collector_id IS NOT DISTINCT FROM c.collector_id
)
SELECT p.inicio AS "Início da semana",p.fim AS "Fim da semana",
 p.consultado_em AT TIME ZONE 'America/Sao_Paulo' AS "Consulta (São Paulo)",
 p.data_carteira AS "Data da carteira atual",c.cobradora AS "Cobradora",
 c.titulos_trabalhados AS "Títulos trabalhados",c.atendimentos_finalizados AS "Atendimentos finalizados",
 c.titulos_com_finalizacao AS "Títulos com finalização",
 floor(c.tempo_segundos/3600)::text||':'||lpad(floor((c.tempo_segundos%3600)/60)::text,2,'0')||':'||lpad((c.tempo_segundos%60)::text,2,'0') AS "Tempo registrado (h:mm:ss)",
 c.sessoes_em_andamento AS "Sessões em andamento",c.recebimentos_quantidade AS "Recebimentos confirmados",
 (c.recebido_centavos/100.0)::numeric(20,2) AS "Recebido confirmado (R$)",
 (c.com_cobranca_centavos/100.0)::numeric(20,2) AS "Recebido com evidência de cobrança (R$)",
 c.carteira_titulos AS "Títulos na carteira atual",c.carteira_clientes AS "Clientes na carteira atual",
 (c.carteira_total_centavos/100.0)::numeric(20,2) AS "Carteira atual total (R$)",
 c.vencidos_quantidade AS "Títulos vencidos atuais",(c.vencidos_centavos/100.0)::numeric(20,2) AS "Carteira vencida atual (R$)",
 (c.a_vencer_centavos/100.0)::numeric(20,2) AS "A vencer atual (R$)",
 c.validacao_pendente_quantidade AS "Títulos aguardando validação",
 (c.validacao_pendente_nominal_centavos/100.0)::numeric(20,2) AS "Aguardando validação - nominal (R$)",
 c.retornos_vencidos_quantidade AS "Retornos com prazo passado",c.retornos_hoje_quantidade AS "Retornos para hoje",
 c.retirados_aguardando_quantidade AS "Retirados aguardando recebimento",
 (c.retirados_aguardando_nominal_centavos/100.0)::numeric(20,2) AS "Retirados aguardando - nominal (R$)"
FROM fechamento_por_cobradora c CROSS JOIN periodo p
ORDER BY (c.collector_id IS NULL),c.cobradora,c.collector_id;
