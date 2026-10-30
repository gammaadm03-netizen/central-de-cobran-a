# Conciliação diária de títulos e cheques — 0.18.16

Em **Importar Bases → Contas a Pagar**, o relatório completo da manhã atualiza os títulos e calcula os pagamentos dos lançamentos que deixaram de aparecer. Selecionar o arquivo inicia a conferência; uma confirmação final grava a importação e a conciliação na mesma transação.

## Ativar

1. Abra o [SQL 059 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-colunas-contas-pagar.sql). Copie todo o conteúdo e execute em **Supabase → SQL Editor → New query → Run**. O arquivo inclui as atualizações anteriores da rotina diária.
2. Abra **Supabase → Edge Functions → payables-import → Code → index.ts**. Substitua todo o conteúdo pelo [código completo atualizado](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/payables-import.ts) e clique em **Deploy updates**. Use a função existente. Esse arquivo TypeScript pertence à Edge Function, separado do SQL do primeiro passo.
3. Atualize a Central e confira a versão **0.18.16**.

A instalação mantém os dados e as correspondências bancárias existentes. Ela não importa relatórios nem baixa títulos. A publicação do site não executa o SQL ou atualiza a função no Supabase.

## Como as colunas são utilizadas

| Coluna do relatório | Informação na Central |
| --- | --- |
| Lançamento | Número do título. A combinação **Filial + Lançamento** identifica o mesmo título nas próximas importações. |
| Histórico | Descrição da conta e da parcela, preservando o texto informado. |
| Plano cp - Conta: nome | Plano vinculado ao **Centro de Custo Macro**. Planos novos exigem a classificação na conferência; os vínculos existentes são reutilizados. |
| Plano cc - Conta: nome | Banco previsto na origem. O relatório de pagamentos e o registro da baixa mantêm o banco efetivo separadamente. |
| Emissão: valor do lançamento | Valor provisionado. Uma nova importação atualiza o valor do título em aberto. |
| Emissão: data | Data de emissão do título. |
| Vencimento: data | Vencimento atualizado. Se a origem alterar o vencimento, a próxima importação atualiza o mesmo título. |
| Cheque: número | Número textual do cheque, incluindo zeros iniciais. Quando preenchido, o banco do pagamento é **BRADESCO F2G**. |

Alterar valor ou vencimento não cria outra dívida para o mesmo lançamento e filial. As versões importadas e os pagamentos anteriores permanecem no histórico. Títulos com pagamentos já registrados e alterações que exigem revisão continuam sujeitos à conferência financeira.

Para títulos comuns, o banco efetivamente utilizado pode ser diferente do previsto e pode ser informado na baixa. Para títulos com número de cheque, a Central utiliza a conta oficial ativa **BRADESCO F2G**. Se essa conta não estiver disponível de forma inequívoca, a baixa fica bloqueada até a conferência do cadastro; a Central não cria outra conta nem escolhe um banco parecido.

## Relatório diário de títulos

1. Entre em **Importar Bases → Contas a Pagar → Relatório diário de títulos**.
2. Selecione o relatório **completo de títulos em aberto**, incluindo vencidos e a vencer, de todas as filiais da origem. A conferência começa automaticamente.
3. Confira novos títulos, atualizações e a lista das baixas calculadas. No primeiro uso, a tela informa a adoção da base atual como referência anterior.
4. Resolva somente as exceções indicadas, como plano novo sem classificação, conta bancária sem vínculo ou data de pagamento que precisa de correção.
5. Conclua por **Importar e conciliar relatório diário** e confirme o resumo apresentado.

Os títulos comuns ausentes recebem pagamento pelo saldo integral, usando a data de vencimento registrada e a conta oficial vinculada. Eles entram em **Pago/Realizado**, com conciliação e histórico. Cheques presentes no arquivo global também são incluídos ou atualizados na previsão, com seus valores, vencimentos e números. A ausência de um cheque no arquivo global não gera baixa: a comparação e a data de pagamento dos cheques pertencem ao relatório diário de cheques.

Uma data de vencimento futura não é convertida em pagamento futuro. Nessa exceção, informe a data efetiva até o dia da importação e a conta usada. A Central não troca silenciosamente a data por hoje.

## Relatório diário de cheques

1. Entre em **Importar Bases → Contas a Pagar → Relatório diário de cheques**.
2. Selecione o relatório completo dos cheques pendentes, com as colunas usuais de Contas a Pagar. A identificação de cheque vem da situação **CHEQUE** ou da coluna explícita **Cheque: número**.
3. No primeiro relatório, confira e confirme a posição inicial. A primeira carga não baixa cheques antigos apenas por ausência.
4. No dia seguinte, importe a nova relação completa. Os cheques presentes na posição anterior que deixaram de aparecer recebem pagamento na **data oficial dessa importação, em São Paulo**.
5. Confira o resumo e conclua a importação.

Quando não restar nenhum cheque pendente, exporte o relatório com os cabeçalhos e sem lançamentos. Na mesma tela, marque **Confirmo que o relatório completo não contém cheques pendentes** e confira o arquivo. Essa declaração permite conciliar os últimos cheques da posição anterior na data da importação. Um arquivo sem cabeçalhos, com linhas incompletas ou sem essa declaração continua bloqueado. Na primeira carga, uma posição zerada estabelece somente a referência inicial.

Títulos comuns e cheques têm referências independentes. A identidade continua sendo **Filial + Número do lançamento**; o número do cheque não identifica sozinho a dívida e mantém os zeros iniciais. Um mesmo cheque pode estar vinculado a mais de um lançamento.

## Títulos de R$ 0,01

Os marcadores de **R$ 0,01** exigem confirmação individual de baixa sem pagamento. O valor original e o histórico são preservados; não há acréscimo em Pago/Realizado. Um saldo residual de um centavo de um título de valor maior não é tratado como marcador administrativo.

## Contas e exceções

As correspondências bancárias cadastradas são reutilizadas. Uma descrição que coincide de forma inequívoca com uma conta oficial ativa também pode ser reconhecida. Quando não houver uma correspondência segura, selecione a conta efetivamente usada; nomes parecidos não autorizam escolher um banco por suposição. Para a mesma descrição e filial, o campo de vínculo resolve vários títulos e registra expressamente a conta para as próximas importações. Uma conta informada somente na exceção de um pagamento vale para aquele caso e não altera o vínculo permanente.

A regra **Cheque: número → BRADESCO F2G** vale para aquele título e não altera o vínculo bancário dos títulos comuns que tenham a mesma descrição na origem. O banco previsto continua visível mesmo quando o pagamento usa outra conta.

Um título já pago que reaparece não recebe uma nova dívida ou estorno automático. A conferência apresenta o impedimento para corrigir o histórico antes de importar. Reaberturas de baixas administrativas continuam explícitas e justificadas.

Se posteriormente for importado um relatório de **Pagamentos realizados**, os dados efetivos desse relatório podem corrigir os pagamentos originados na conciliação diária, mediante a confirmação de correções já exigida nessa tela. O pagamento anterior permanece no histórico com seu estorno. Pagamentos manuais não são substituídos por essa regra.

## Arquivos parciais e repetição

Use os fluxos diários somente para relatórios completos da mesma origem e de todas as filiais. Para arquivos filtrados ou apenas novos lançamentos, use **Previsões / novos títulos → Somente novos títulos e atualizações**, que preserva os ausentes. **Pagamentos realizados** continua disponível para o relatório de quitações efetivas.

Arquivos vazios não baixam toda a carteira. A posição sem cheques exige os cabeçalhos válidos e a declaração específica descrita acima. O original permanece preservado, e reenviar o mesmo protocolo não duplica pagamentos. Se a confirmação ficar pendente, mantenha a tela aberta e use a opção de conferir a mesma confirmação, sem trocar o arquivo ou criar outra importação. A navegação permanece bloqueada até esclarecer esse envio.

Os testes utilizam dados sintéticos e não confirmam implantação ou importação de dados de produção.
