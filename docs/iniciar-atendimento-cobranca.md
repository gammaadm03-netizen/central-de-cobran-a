# Iniciar outros títulos da carteira — 0.18.20

Os retornos com data até hoje continuam destacados na **Agenda de retornos** e na fila de atendimento. Eles passam a indicar prioridade sem impedir o início de outros títulos autorizados da carteira.

## Ativar a atualização

1. Em **Supabase → SQL Editor → New query**, cole todo o [SQL063 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-inicio-atendimento-cobranca.sql) e execute **Run**.
2. Na Central, finalize ou pause um atendimento que esteja em andamento antes de atualizar a página.
3. Atualize com **Ctrl + F5** e confira a versão **0.18.20**. Não é necessário atualizar uma Edge Function para essa correção.

## Rotina da cobradora

Abra **Cobrança → Títulos → Abrir**, selecione um título da sua carteira e clique em **Iniciar**. É possível escolher o segundo, o terceiro ou outro título disponível, mesmo quando há retornos pendentes na agenda.

Para trocar de título enquanto o cronômetro está ativo, use **Pausar** ou conclua o atendimento atual. A Central mantém um intervalo ativo por pessoa.

**Finalizar atendimento** exige que aquele título tenha sido iniciado, além da observação e dos campos de próxima ação e data. Um título informado como pago segue para validação financeira; a cobradora não confirma a entrada bancária.

Títulos de outra carteira, quitados, retirados do relatório, sem responsável ou aguardando validação financeira permanecem sujeitos às permissões e restrições do sistema. A atualização mantém os históricos e a agenda já registrados.
