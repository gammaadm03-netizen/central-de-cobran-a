# Validação financeira de Contas a Receber — 0.18.10

Em **Contas a Receber → Validação financeira**, o financeiro informa a data real e o valor efetivamente recebido. O relato original da cobradora permanece disponível e não é convertido automaticamente em valores financeiros.

## Conferir um recebimento

1. Abra a fila e clique em **Conferir** no título desejado.
2. Confira o relato, o comprovante e a entrada bancária. Informe **Data real do recebimento** e **Valor efetivamente recebido (R$)**.
3. Se o recebido for menor que o nominal, a tela mostra a diferença em **Desconto ou retenção**. Informe a justificativa e confirme que essa diferença é desconto/retenção e que o título está integralmente quitado. Um saldo que ainda será recebido não deve ser tratado como desconto.
4. Confira o resumo e clique em **Confirmar recebimento financeiro**. A confirmação registra o recebido líquido, o nominal original, o desconto/retenção, sua justificativa e a data real, preservando o histórico e a responsável.

O valor recebido deve ter até duas casas decimais e ser positivo, até o valor original. Não há arredondamento de valores com casas extras. O caso legado de nominal zero aceita recebido zero. A data é conferida pelo banco de dados no horário de São Paulo; uma data futura é recusada.

O recebido e a base de comissões consideram somente o valor efetivamente recebido, conforme as regras de elegibilidade existentes. O desconto/retenção fica separado. O vencimento original não muda. O registro do pagamento continua usando a data real, mesmo que a validação ocorra em outro mês.

Para devolver um pagamento não localizado, escolha **Não localizado — cobrar novamente**, informe a justificativa e confirme. A mesma responsável permanece vinculada e não é criado recebimento. Quando não houver responsável, faça a atribuição antes de devolver.

## Títulos retirados e alterações concorrentes

A fila exclui os títulos retirados pelo relatório completo. Esses títulos devem ser confirmados em **Importar Bases → Contas a Receber → Títulos quitados**, conforme a regra já existente; a ausência no relatório de abertos não comprova pagamento.

A conferência consulta a situação atual e os recebimentos antes de gravar. Se o título for retirado, validado ou alterado depois de abrir a tela, a operação é interrompida com uma orientação específica. Os registros e o relato anterior são preservados.

Os detalhes do título direcionam para essa mesma fila, sem manter um segundo formulário de confirmação nominal.

## Resposta interrompida

Quando aparecer **A confirmação está pendente**, mantenha a conferência aberta e use **Conferir confirmação pendente**. O mesmo valor, data, justificativa e protocolo serão reenviados. O banco devolve o resultado original se já tiver concluído, sem lançar outro recebimento.

Durante essa pendência, a conferência e a navegação ficam bloqueadas para preservar o envio. Recarregar ou fechar a aba aciona um aviso do navegador. Se a aba for encerrada mesmo assim, confira o histórico e a situação do título antes de iniciar outra conferência.

## Ativação

1. Copie todo o [SQL 053 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-validacao-financeira-recebiveis.sql) e execute em **Supabase → SQL Editor → New query → Run**. Requer a atualização 047 existente. O SQL pode ser reaplicado e não confirma recebimentos automaticamente.
2. Atualize a Central até a versão **0.18.10** e abra a Validação financeira.

Esta atualização usa uma nova consulta autenticada diretamente no banco. Não há alteração de Edge Function nesta entrega. A RPC anterior continua disponível para compatibilidade; a tela atual exige a nova versão e não substitui um valor líquido por uma confirmação nominal antiga.

## Manutenção e testes

`npm run test:receivable-financial-validation-sql` verifica a validação em PostgreSQL descartável, incluindo valor líquido, nominal, datas, auditoria, permissões, repetições e rollback. O protocolo privado de confirmação integra o escopo operacional da limpeza/restauração administrativa, preservando usuários, configurações e auditoria.
