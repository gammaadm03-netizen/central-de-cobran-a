# Retornos devidos antes de novos atendimentos — 0.18.21

A cobradora deve atender os títulos da sua carteira que tenham retorno agendado com data até hoje antes de iniciar os demais atendimentos. Os retornos com data futura não bloqueiam o trabalho nos outros títulos.

## Ativar a atualização

1. Em **Supabase → SQL Editor → New query**, cole todo o [SQL064 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-retornos-prioritarios-cobranca.sql) e execute **Run**. A atualização pode ser aplicada mesmo quando o SQL063 já foi executado.
2. Pause ou finalize um atendimento que esteja em andamento antes de atualizar a página.
3. Atualize com **Ctrl + F5** e confira a versão **0.18.21**. A ativação exige apenas o SQL.

## Rotina da cobradora

Abra **Cobrança → Títulos → Abrir retornos devidos** ou use **Agenda de retornos → Atender retornos**. Abra um retorno, clique em **Iniciar** e registre o atendimento. Ao finalizar, informe observação, próxima ação e a data do próximo retorno.

Quando todos os retornos devidos da carteira estiverem atendidos e a agenda atualizada, os demais títulos ficam disponíveis para **Iniciar**. Se a próxima data continuar sendo hoje, o título continua na agenda de retornos devidos. Para um próximo contato em outro dia, informe essa data futura.

Para trocar de título enquanto o cronômetro estiver ativo, use **Pausar** ou conclua o atendimento atual. A Central mantém um intervalo ativo por pessoa.

**Finalizar atendimento** exige que aquele título tenha sido iniciado. Um título informado como pago segue para validação financeira; a cobradora não confirma a entrada bancária.

Títulos de outra carteira, quitados, retirados do relatório, sem responsável ou aguardando validação financeira permanecem sujeitos às permissões e restrições do sistema. A atualização preserva os históricos e agendamentos já registrados.
