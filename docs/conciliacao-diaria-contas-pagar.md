# Contas a Pagar: relatório diário e status automático — 0.18.18

Em **Importar Bases → Contas a Pagar**, selecione o relatório completo dos títulos ainda em aberto e clique em **Importar relatório**. A Central inclui os novos lançamentos, atualiza valor e vencimento do mesmo título e marca como **Pago** os títulos que desapareceram da posição anterior. As atualizações de valor e vencimento são aplicadas sem uma etapa de aprovação manual.

A identificação permanece **Filial + Lançamento**. O arquivo deve reunir todas as filiais e todos os títulos em aberto, incluindo os cheques. A primeira carga cria a referência quando ainda não existe uma posição anterior.

## Ativar a atualização

1. Copie todo o [SQL 061 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-status-relatorio-contas-pagar.sql) em **Supabase → SQL Editor → New query → Run**.
2. Em **Supabase → Edge Functions → payables-import → Code → index.ts**, substitua todo o conteúdo pela [função completa atualizada](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/payables-import.ts) e clique em **Deploy updates**.
3. Atualize a Central com **Ctrl + F5** e confira a versão **0.18.18**.
4. Importe a planilha original da origem. A leitura e as verificações técnicas são feitas dentro da rotina de importação.

Essa atualização preserva a base e os históricos existentes. Não executa outro reinício de Contas a Pagar.

## Rotina diária

1. Exporte a relação completa dos títulos que continuam em aberto, incluindo os novos títulos e cheques.
2. Selecione o arquivo na Central.
3. Confirme individualmente os marcadores de R$ 0,01, quando existirem.
4. Clique em **Importar relatório**. O resumo aparece após a conclusão, com inclusões, alterações, títulos marcados como Pago e ajustes de centavos.

O vencimento e o valor mais recentes do relatório substituem os dados anteriores do mesmo lançamento. Um título marcado como Pago pelo relatório volta a aberto quando reaparece na relação, preservando os eventos anteriores no histórico.

Planos já classificados mantêm seu Centro de Custo Macro. Um novo plano sem vínculo entra como **NÃO CLASSIFICADO**, com o nome original preservado para classificação posterior. A importação não presume uma categoria contábil pelo nome.

O banco previsto do Plano cc fica preservado. Os cheques mantêm seu número e sua regra de banco BRADESCO F2G para um eventual pagamento financeiro registrado separadamente.

## Significado de Pago pelo relatório

O desaparecimento encerra o título na carteira e na previsão com o status **Pago**, mantendo a referência nominal e o histórico da importação. Essa alteração de status não cria uma saída bancária, um banco efetivo ou uma data real de pagamento.

Os pagamentos financeiros já registrados continuam com seus valores, bancos, datas e históricos. Os indicadores de realizado usam esses pagamentos efetivos. O status operacional pelo relatório e o histórico financeiro permanecem identificados separadamente.

## Centavos e modelo de 30/10/2026

Valores provisionados com mais de duas casas são arredondados automaticamente por título para centavos, com o critério **HALF_UP**. Exemplo: R$ 3.122,935 passa para R$ 3.122,94. O arquivo original é preservado e os ajustes ficam disponíveis no resultado da importação.

A planilha enviada como modelo tem **1.155 títulos, 386 cheques e 16 ajustes de centavos**. A soma dos títulos arredondados é **R$ 3.697.121,79**. Excluindo os quatro marcadores de R$ 0,01, o valor é **R$ 3.697.121,75**.

A soma dos valores originais antes do arredondamento individual é R$ 3.697.121,82. A diferença acumulada de R$ 0,03 decorre do arredondamento de cada título. A Central conserva essa distinção para conferir os totais do relatório.

Os marcadores de **R$ 0,01** seguem com confirmação individual de baixa sem pagamento, fora dos valores financeiros. Um saldo residual de um centavo de um título originalmente maior não é tratado como marcador administrativo.

## Arquivo sem títulos e confirmação pendente

Quando não restar nenhum título em aberto, exporte os cabeçalhos sem lançamentos e marque a declaração de relatório completo vazio. A importação então encerra os últimos títulos da posição anterior. Cabeçalhos ausentes, linhas incompletas, duplicidades e fórmulas continuam sendo recusados pelas verificações técnicas.

Se houver falha de conexão durante a gravação, utilize o reenvio da mesma solicitação. O arquivo, os centavos normalizados e o protocolo permanecem preservados para evitar duplicação. Uma mudança na base exige nova leitura interna; uma confirmação incerta mantém a mesma identificação até esclarecer o resultado.
