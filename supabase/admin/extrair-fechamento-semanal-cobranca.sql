-- FECHAMENTO SEMANAL DE COBRANÇA POR COBRADORA — somente leitura.
-- Supabase > SQL Editor > New query > Run; exporte o resultado como CSV/JSON.
-- Não instala funções, altera dados, confirma recebimentos ou calcula comissões.
-- Período financeiro: sábado 24/10/2026 a sexta-feira 30/10/2026.
-- Para outra semana, altere apenas as duas datas em parametros.
-- Carteira = posição ATUAL da consulta; não representa um saldo histórico de abertura.
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
), faixas AS (
 SELECT * FROM(VALUES(1,'1–30 dias',1,30),(2,'31–60 dias',31,60),(3,'61–90 dias',61,90),
  (4,'91–180 dias',91,180),(5,'181–365 dias',181,365),(6,'Mais de 365 dias',366,2147483647))f(ordem,faixa,minimo,maximo)
), importacoes AS MATERIALIZED (
 SELECT i.id,i.import_mode tipo,i.file_name arquivo,i.created_at importado_em,i.row_count titulos,
  s.result->>'reference_date' posicao_informada_no_relatorio,
  s.result->'full_report' relatorio_completo
 FROM public.receivable_imports i LEFT JOIN public.receivable_sync_imports s ON s.import_id=i.id
 WHERE i.scope='grupo-consolidado'
), dias AS (
 SELECT d::date dia FROM periodo p CROSS JOIN LATERAL generate_series(p.inicio::timestamp,
  least(p.fim,p.data_carteira)::timestamp,interval '1 day') d
)
SELECT jsonb_build_object(
 'versao_extracao','fechamento-cobranca-v2-por-cobradora',
 'periodo',(SELECT jsonb_build_object('inicio',inicio,'fim',fim,'consultado_em',consultado_em,
  'fuso','America/Sao_Paulo','corte_atividades',corte_instante,'data_carteira_atual',data_carteira,
  'semana_encerrada_no_calendario',consultado_em>=(fim+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') FROM periodo),
 'criterios',jsonb_build_array(
  'Recebimentos: somente recebimentos financeiros vigentes confirmados na Central, pela data real do pagamento.',
  'Com cobrança: evidência de trabalho anterior à validação. Não significa comissão devida nem prova causal de recuperação.',
  'Atendimentos: finalizações e eventos não finalizados separados. Não finalizados também incluem atualizações operacionais do financeiro. Agrupamento por operador registrado no evento.',
  'Por cobradora: finalizações usam a responsável histórica do evento ligado ao protocolo. Sem prova inequívoca, ficam em Sem cobradora identificada; a carteira atual não reatribui o histórico.',
  'Títulos trabalhados por cobradora: união sem duplicação entre títulos com sessão de trabalho e títulos com finalização no período.',
  'Recebimentos usam a cobradora registrada no recebimento; carteira e pendências usam a responsável atual. As origens são distintas e não comprovam causalidade de recuperação.',
  'Tempo: sessões pelo snapshot de cobradora, recortadas ao período e ao instante da consulta; pausas ficam fora da soma.',
  'Carteira e pendências: posição atual da consulta, sem reconstituir o saldo de abertura da semana.',
  'Ausência de título no relatório não é recebimento; valores não confirmados ficam fora dos recebidos.',
  'Zeros indicam ausência de registros na Central; não comprovam ausência de movimento na origem. Confira se todos os relatórios de quitados do período foram importados.'),
 'fechamento_por_cobradora',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.cobradora,c.collector_id),'[]') FROM fechamento_por_cobradora c),
 'finalizacoes_sem_cobradora_identificada',(SELECT jsonb_build_object('quantidade',count(*),'titulos',count(DISTINCT title_id)) FROM finalizacoes WHERE collector_id IS NULL),
 'recebimentos_resumo',(SELECT jsonb_build_object('quantidade',count(*),'titulos_distintos',count(DISTINCT title_id),
  'recebido_centavos',coalesce(sum(amount_cents),0),'nominal_referencia_centavos',coalesce(sum(nominal_amount_cents),0),
  'com_cobranca_quantidade',count(*) FILTER(WHERE teve_cobranca),'com_cobranca_centavos',coalesce(sum(amount_cents) FILTER(WHERE teve_cobranca),0),
  'sem_cobranca_centavos',coalesce(sum(amount_cents) FILTER(WHERE NOT teve_cobranca),0)) FROM recebimentos),
 'recebimentos_por_cobradora',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.cobradora,q.collector_id),'[]') FROM(
  SELECT collector_id,cobradora,count(*) quantidade,sum(amount_cents) recebido_centavos,
   count(*) FILTER(WHERE teve_cobranca) com_cobranca_quantidade,coalesce(sum(amount_cents) FILTER(WHERE teve_cobranca),0) com_cobranca_centavos
  FROM recebimentos GROUP BY collector_id,cobradora)q),
 'recebimentos_por_dia',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.dia),'[]') FROM(
  SELECT d.dia,count(r.id) quantidade,coalesce(sum(r.amount_cents),0) recebido_centavos,
   coalesce(sum(r.amount_cents) FILTER(WHERE r.teve_cobranca),0) com_cobranca_centavos
  FROM dias d LEFT JOIN recebimentos r ON r.payment_date=d.dia GROUP BY d.dia)q),
 'recebimentos_detalhados',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY payment_date,cobradora,document,id),'[]') FROM recebimentos r),
 'atividade_resumo',(SELECT jsonb_build_object('eventos',count(*),'finalizacoes',count(*) FILTER(WHERE finalized),
  'eventos_nao_finalizados',count(*) FILTER(WHERE NOT finalized),'titulos_com_evento',count(DISTINCT title_id),
  'titulos_com_finalizacao',count(DISTINCT title_id) FILTER(WHERE finalized)) FROM atendimentos),
 'atividade_por_operador',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.operador,q.created_by),'[]') FROM(
  SELECT created_by,operador,count(*) eventos,count(*) FILTER(WHERE finalized) finalizacoes,
   count(DISTINCT title_id) FILTER(WHERE finalized) titulos_com_finalizacao FROM atendimentos GROUP BY created_by,operador)q),
 'atividade_por_dia',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.dia),'[]') FROM(
  SELECT d.dia,count(a.id) eventos,count(a.id) FILTER(WHERE a.finalized) finalizacoes,
   count(DISTINCT a.title_id) FILTER(WHERE a.finalized) titulos_com_finalizacao
  FROM dias d LEFT JOIN atendimentos a ON (a.created_at AT TIME ZONE 'America/Sao_Paulo')::date=d.dia GROUP BY d.dia)q),
 'finalizacoes_por_status',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.status),'[]') FROM(
  SELECT status,count(*) quantidade FROM atendimentos WHERE finalized GROUP BY status)q),
 'tempo_resumo',(SELECT jsonb_build_object('segundos',coalesce(sum(segundos),0),'sessoes',count(*),
  'titulos_trabalhados',count(DISTINCT title_id),'sessoes_em_andamento',count(*) FILTER(WHERE em_andamento)) FROM intervalos),
 'tempo_por_cobradora',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.cobradora,q.collector_id),'[]') FROM(
  SELECT collector_id,max(cobradora) cobradora,sum(segundos) segundos,count(*) sessoes,
   count(DISTINCT title_id) titulos_trabalhados,count(*) FILTER(WHERE em_andamento) sessoes_em_andamento
  FROM intervalos GROUP BY collector_id)q),
 'carteira_atual',(SELECT jsonb_build_object('titulos',count(*),'clientes',count(DISTINCT customer_key),
  'total_centavos',coalesce(sum(amount_cents),0),'vencidos_quantidade',count(*) FILTER(WHERE dias_atraso>0),
  'vencidos_centavos',coalesce(sum(amount_cents) FILTER(WHERE dias_atraso>0),0),
  'a_vencer_centavos',coalesce(sum(amount_cents) FILTER(WHERE dias_atraso<=0),0),
  'validacao_pendente_quantidade',count(*) FILTER(WHERE status='PENDING_VALIDATION'),
  'validacao_pendente_nominal_centavos',coalesce(sum(amount_cents) FILTER(WHERE status='PENDING_VALIDATION'),0),
  'retornos_vencidos_quantidade',count(*) FILTER(WHERE next_action_date<(SELECT data_carteira FROM periodo)),
  'retornos_hoje_quantidade',count(*) FILTER(WHERE next_action_date=(SELECT data_carteira FROM periodo))) FROM carteira),
 'carteira_por_cobradora',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.cobradora,q.collector_id),'[]') FROM(
  SELECT collector_id,cobradora,count(*) titulos,count(DISTINCT customer_key) clientes,sum(amount_cents) total_centavos,
   count(*) FILTER(WHERE dias_atraso>0) vencidos_quantidade,coalesce(sum(amount_cents) FILTER(WHERE dias_atraso>0),0) vencidos_centavos
  FROM carteira GROUP BY collector_id,cobradora)q),
 'faixas_atraso_atuais',(SELECT jsonb_agg(to_jsonb(q) ORDER BY q.ordem) FROM(
  SELECT f.ordem,f.faixa,count(c.id) titulos,coalesce(sum(c.amount_cents),0) valor_centavos
  FROM faixas f LEFT JOIN carteira c ON c.dias_atraso BETWEEN f.minimo AND f.maximo GROUP BY f.ordem,f.faixa)q),
 'retirados_trabalhados_aguardando_recebimento',(SELECT jsonb_build_object('quantidade',count(*),'nominal_referencia_centavos',coalesce(sum(amount_cents),0)) FROM retirados_pendentes),
 'ultimas_importacoes',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.tipo),'[]') FROM(
  SELECT DISTINCT ON(tipo) * FROM importacoes ORDER BY tipo,importado_em DESC,id DESC)q),
 'importacoes_no_periodo',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY importado_em,id),'[]') FROM importacoes i CROSS JOIN periodo p
  WHERE importado_em>=p.inicio_instante AND importado_em<p.corte_instante),
 'primeiro_registro_disponivel',(SELECT jsonb_build_object('primeira_importacao',(SELECT min(created_at) FROM public.receivable_imports WHERE scope='grupo-consolidado'),
  'primeiro_atendimento',(SELECT min(created_at) FROM public.collection_case_events),
  'primeira_sessao',(SELECT min(started_at) FROM public.collection_work_sessions))),
 'saldo_abertura_semana_centavos',NULL,'variacao_inadimplencia_semana_centavos',NULL
) AS fechamento_semanal_cobranca;
