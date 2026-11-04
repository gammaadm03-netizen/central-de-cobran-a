# Contas a Pagar: abertos e baixados — 0.18.22

Em **Importar Bases → Contas a Pagar**, escolha o conteúdo do relatório antes de selecionar o arquivo. A relação completa de abertos e o relatório de baixados produzem efeitos diferentes.

## Ativar a atualização

1. Execute todo o [SQL065/066 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-tipos-relatorios-contas-pagar.sql) em **Supabase → SQL Editor → New query → Run**.
2. Em **Supabase → Edge Functions → payables-import → Code → index.ts**, substitua todo o conteúdo pela [função completa atualizada](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/payables-import.ts) e clique em **Deploy updates**.
3. Resolva qualquer envio pendente antes de atualizar a página. Depois, use **Ctrl + F5** e confira a versão **0.18.22**.

A instalação preserva a base, os pagamentos e os históricos. A conciliação dos títulos é aplicada pela importação do relatório escolhido.

## Relação completa de títulos em aberto

Escolha a opção de **abertos completos** para um arquivo com todos os títulos que continuam em aberto, de todas as filiais, incluindo os cheques, os novos lançamentos e as alterações.

A identidade é **Filial + Lançamento**. A Central inclui os novos títulos e atualiza automaticamente valor, vencimento e demais campos da origem do mesmo título. Os títulos que desapareceram da relação completa seguinte recebem o status **Pago**, com o histórico preservado.

A retirada de uma parte expressiva dos títulos da posição anterior exige confirmar que o arquivo é realmente completo, mesmo quando também há novos lançamentos. Confira as quantidades apresentadas antes de autorizar as baixas. Valores e vencimentos continuam sendo atualizados pela rotina, sem aprovação individual dessas alterações.

Na primeira carga completa, a Central estabelece a posição de referência. Arquivos com apenas novos títulos, baixados ou uma seleção de fornecedores não representam uma relação completa de abertos.

## Relatório somente de títulos baixados

Escolha a opção de **títulos baixados** para um arquivo que lista os títulos já encerrados na origem. A Central identifica cada um por Filial + Lançamento e altera somente o status dos títulos listados. Os títulos ausentes desse arquivo continuam como estavam.

Essa rotina exige uma posição completa de referência. Títulos sem vínculo conhecido ou com divergências que impeçam uma baixa segura ficam indicados para conferência. O arquivo de baixados não cria novos títulos em aberto e não substitui os valores e vencimentos da previsão.

O resultado informa a quantidade de registros do arquivo e a quantidade de títulos na posição operacional após a atualização. Um arquivo de baixados com poucos registros não significa que essa é toda a carteira em aberto.

## Corrigir um relatório de baixados enviado como abertos

Exporte na origem uma **nova relação completa e atual de todos os títulos em aberto**, de todas as filiais, incluindo os cheques. Importe esse arquivo pela opção de **abertos completos**.

A posição atual da origem orienta a correção: títulos que continuam em aberto reaparecem na previsão; os que foram baixados e não constam dessa relação permanecem ou passam a Pago. Confirme a abrangência do relatório quando a tela solicitar essa conferência. As importações e os eventos anteriores continuam no histórico.

Use o relatório completo atual para preservar as baixas legítimas ocorridas desde a base anterior. Um arquivo antigo não representa necessariamente a carteira de hoje. Arquivos de uma posição anterior continuam protegidos contra reprocessamento que substitua uma posição mais recente.

## Valor de mercadoria no Resumo da Diretoria

O indicador considera o **saldo em aberto dos títulos cujo Plano cp - Conta: nome seja COMPRA DE MERCADORIA**, de todos os vencimentos e filiais, incluindo cheques. A classificação Macro continua disponível para os demais relatórios e não substitui esse critério do plano de origem.

Pagamentos efetivamente registrados continuam abatendo o saldo financeiro. Títulos com status Pago pelo relatório e baixas administrativas ficam fora do saldo em aberto. Posições históricas já salvas mantêm os valores registrados na época.

## Pagamentos, centavos e arquivo original

A alteração de status pelos relatórios não cria pagamento financeiro, data real ou banco efetivo. Pagamentos já registrados permanecem com os valores, bancos, datas e históricos originais.

Cada marcador de **R$ 0,01** continua exigindo confirmação individual de baixa sem pagamento, fora das somas financeiras. Baixas administrativas já confirmadas não são duplicadas. Um saldo residual de um centavo de um título originalmente maior não é automaticamente tratado como marcador administrativo.

Valores provisionados com mais de duas casas são arredondados por título para centavos, com o critério **HALF_UP**. O arquivo original é preservado e os ajustes ficam disponíveis no resultado. A soma dos títulos arredondados pode diferir em centavos da soma dos valores antes do arredondamento.

Planos já classificados mantêm seu Centro de Custo Macro. Um plano novo sem vínculo entra como **NÃO CLASSIFICADO**, com o nome da origem preservado para classificação posterior. O banco previsto e o número do cheque também são preservados; cheques mantêm a regra BRADESCO F2G para um eventual pagamento financeiro registrado separadamente.

## Arquivo completo vazio e confirmação pendente

Quando não restar nenhum título aberto, exporte os cabeçalhos sem lançamentos e marque a declaração de relatório completo vazio. A confirmação dessa posição encerra os últimos títulos previstos, respeitando as conferências aplicáveis.

Se houver falha de conexão durante a gravação, use a conferência do mesmo envio. O arquivo, o conteúdo escolhido e o protocolo permanecem preservados para evitar duplicação. Aguarde a confirmação antes de trocar de relatório ou atualizar a página.
