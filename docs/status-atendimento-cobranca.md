# Status do atendimento de cobrança — 0.18.11

## Ativação

1. Abra o [SQL 054 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-status-atendimento-cobranca.sql).
2. Copie todo o conteúdo para **Supabase → SQL Editor → New query** e clique em **Run**.
3. Atualize a Central até a versão **0.18.11**.

O SQL requer a atualização 047 e pode ser executado novamente. Preserva os dados existentes. Nenhuma Edge Function precisa ser alterada. A publicação do site pelo Git não executa o SQL no Supabase.

## Como utilizar

Abra **Cobrança → Títulos → selecione o título → Atendimento → Status do atendimento**.

| Status | Uso |
|---|---|
| MERCADORIA A RECOLHER | Acompanhar o recolhimento da mercadoria. |
| NOTA A CANCELAR | Acompanhar a solicitação de cancelamento da nota. |
| AGUARDANDO NOTA ASSINADA | Acompanhar a obtenção da nota assinada. |
| NOTA COM PENDÊNCIA | Registrar a pendência e sua resolução. |
| PAUSAR COBRANÇA | Registrar o motivo da suspensão e quando revisar o caso. |

Preencha **Observações** com o motivo e o encaminhamento. Use **Salvar andamento** para guardar o rascunho. Para concluir, inicie o atendimento, informe **Próxima ação** e **Data da próxima ação** de hoje em diante e clique em **Finalizar atendimento**. O status fica registrado no histórico.

Para localizar esses casos, escolha o status no filtro **Cobrança → Títulos → Status da cobrança**. Ele também aparece na exportação da seleção.

Esses status classificam o atendimento. O título conserva seu valor, vencimento, responsável e situação financeira. O cancelamento efetivo de uma nota, o recebimento financeiro e a baixa de um título continuam dependendo dos procedimentos correspondentes.

**Pausar cobrança** registra a suspensão operacional e sua próxima revisão. O título permanece na carteira e o retorno agendado continua sendo acompanhado. O botão **Pausar** controla o cronômetro do atendimento; **Finalizar atendimento** encerra o intervalo e registra a agenda.

## Verificação local

`npm run test:collection-operational-statuses-sql` verifica a ativação repetida, gravação, histórico, filtros, revisões, confirmação repetida e limites de acesso, além das regras financeiras existentes. Os testes de navegador da central operacional verificam os novos status no fluxo de atendimento.

Nesta entrega passaram 15 verificações SQL, 73 cenários de navegador, 396 testes Node e a compilação TypeScript/Vite. As verificações utilizam dados fictícios e não executam operações no Supabase de produção.
