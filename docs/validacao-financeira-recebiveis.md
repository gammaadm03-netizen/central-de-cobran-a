# Validação financeira de Contas a Receber — 0.18.12

Em **Contas a Receber → Validação financeira**, o financeiro informa a data real e o valor efetivamente recebido. O relato original da cobradora permanece disponível e não é convertido automaticamente em valores financeiros.

Desde **0.18.13 / SQL 057**, uma quitação incorreta que reaparece no relatório de abertos pode ser corrigida pela [aprovação individual de retorno na importação](conciliacao-retornos-recebiveis.md). O estorno preserva o recebimento anterior e seu histórico; a decisão da Gerência só altera a situação financeira ao confirmar a importação.

## Conferir um recebimento

1. Abra a fila e clique em **Conferir** no título desejado.
2. Confira o relato, o comprovante e a entrada bancária. Informe **Data real do recebimento** e **Valor efetivamente recebido (R$)**.
3. Se o recebido for menor que o nominal, a tela mostra a diferença em **Desconto ou retenção**. Informe a justificativa e confirme que essa diferença é desconto/retenção e que o título está integralmente quitado. Um saldo que ainda será recebido não deve ser tratado como desconto.
4. Confira o resumo e clique em **Confirmar recebimento financeiro**. A confirmação registra o recebido líquido, o nominal original, o desconto/retenção, sua justificativa e a data real, preservando o histórico e a responsável.

O valor recebido deve ter até duas casas decimais e ser positivo, até o valor original. Não há arredondamento de valores com casas extras. O caso legado de nominal zero aceita recebido zero. A data é conferida pelo banco de dados no horário de São Paulo; uma data futura é recusada.

O recebido e a base de comissões consideram somente o valor efetivamente recebido, conforme as regras de elegibilidade existentes. O desconto/retenção fica separado. O vencimento original não muda. O registro do pagamento continua usando a data real, mesmo que a validação ocorra em outro mês.

Ao confirmar, a mesma transação registra o recebimento, muda o título para quitado validado, limpa a agenda e encerra eventuais intervalos de atendimento. O título deixa a carteira ativa e a fila de pendências de Comissões. Havendo movimento anterior de cobrança, o recebido entra na base de apuração, sem exigir nova importação de Quitados ou outro lançamento manual de comissão.

A apuração usa o **mês da data real do recebimento**. Por exemplo, um recebimento confirmado hoje com data de agosto deve ser consultado em agosto. A inclusão na base não assegura comissão positiva: continuam valendo a responsável habilitada, a vigência da regra e a faixa de atraso. A regra existente de até 30 dias mantém comissão zero. Uma apuração já salva conserva sua posição histórica; consulte a base atual para incluir recebimentos confirmados depois.

Para devolver um pagamento não localizado, escolha **Não localizado — cobrar novamente**, informe a justificativa e confirme. A mesma responsável permanece vinculada e não é criado recebimento. Quando não houver responsável, faça a atribuição antes de devolver.

## Títulos retirados pelo relatório completo

A atualização 055 substitui a restrição anterior de confirmação exclusivamente por Quitados. A Validação financeira apresenta uma fila própria dos títulos retirados que tiveram movimento de cobrança e ainda não possuem recebimento validado. Essa fila pode ser consultada pelo financeiro e pela Diretoria, respeitando as permissões. Somente os perfis autorizados a validar podem confirmar.

Localize o título, confira a entrada bancária e informe a data, o valor recebido e eventual desconto/retenção como na conferência normal. O registro da retirada e o histórico de cobrança permanecem preservados após a confirmação. A ausência no relatório de abertos, por si só, continua sem comprovar pagamento.

Também é possível confirmar por **Importar Bases → Contas a Receber → Títulos quitados**. Um recebimento já registrado é reconhecido na conciliação; não é necessário repetir essa importação para fazer a confirmação manual alimentar Comissões.

Um título retirado sem recebimento localizado permanece pendente. Essa conferência não reabre a carteira automaticamente. A devolução **Não localizado — cobrar novamente** continua disponível para títulos da fila normal; reaparecimentos no relatório de abertos seguem o processo existente.

## Alterações concorrentes

A conferência consulta a situação atual e os recebimentos antes de gravar. Se o título for validado ou alterado depois de abrir a tela, a operação é interrompida com uma orientação específica. Os registros e o relato anterior são preservados. Uma retirada entre a fila normal e a confirmação exige atualizar a consulta e abrir o título pela fila dos retirados.

Os detalhes do título direcionam para essa mesma fila, sem manter um segundo formulário de confirmação nominal.

## Resposta interrompida

Quando aparecer **A confirmação está pendente**, mantenha a conferência aberta e use **Conferir confirmação pendente**. O mesmo valor, data, justificativa e protocolo serão reenviados. O banco devolve o resultado original se já tiver concluído, sem lançar outro recebimento.

Durante essa pendência, a conferência e a navegação ficam bloqueadas para preservar o envio. Recarregar ou fechar a aba aciona um aviso do navegador. Se a aba for encerrada mesmo assim, confira o histórico e a situação do título antes de iniciar outra conferência.

## Ativação

1. Copie todo o [SQL 055 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-validacao-comissoes-recebiveis.sql) e execute em **Supabase → SQL Editor → New query → Run**. O arquivo inclui a atualização 053 quando ainda não instalada e requer a atualização 047 existente. Pode ser reaplicado e não confirma recebimentos automaticamente.
2. Atualize a Central até a versão **0.18.12** e abra a Validação financeira.

Esta atualização usa uma nova consulta autenticada diretamente no banco. Não há alteração de Edge Function nesta entrega. A RPC anterior continua disponível para compatibilidade; a tela atual exige a nova versão e não substitui um valor líquido por uma confirmação nominal antiga.

## Manutenção e testes

`npm run test:receivable-financial-validation-sql` verifica as regras originais da atualização 053. `npm run test:receivable-validation-commissions-sql` verifica a atualização 055, a fila de retirados e a passagem da confirmação financeira à base de comissão. Ambos usam PostgreSQL descartável, com dados fictícios. O protocolo privado de confirmação integra o escopo operacional da limpeza/restauração administrativa, preservando usuários, configurações e auditoria.

Na entrega 0.18.12 passaram 20 verificações SQL, 160 cenários de navegador, 396 testes Node e a compilação TypeScript/Vite. A verificação inclui confirmação líquida, comissão no mês real, comissão zero até 30 dias e Quitados posterior sem duplicação. Nenhum recebimento de produção foi confirmado por esses testes.
