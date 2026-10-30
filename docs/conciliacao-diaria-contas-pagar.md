# Contas a Pagar: um relatório por dia — 0.18.17

Em **Importar Bases → Contas a Pagar**, envie um único relatório completo dos títulos que continuam em aberto, incluindo os novos lançamentos, os vencidos, os valores a vencer e os cheques de todas as filiais. O primeiro arquivo cria a base inicial. Nos arquivos seguintes, a Central atualiza os títulos presentes, inclui os novos e considera pagos os títulos da posição anterior que desapareceram.

## Reiniciar somente Contas a Pagar

O reinício foi solicitado em 30/10/2026 para começar uma nova base oficial. Ele remove os dados operacionais de Contas a Pagar, inclusive importações, arquivos originais, títulos, pagamentos, conciliações e fechamentos antigos, após conferir uma cópia privada recuperável. Contas a Receber, Cobrança, Comissões, Caixa/Bancos, estoque, demais bases e configurações permanecem preservados.

1. Copie todo o [SQL de ativação e reinício somente de Contas a Pagar](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/reiniciar-contas-pagar-relatorio-unico.sql) para **Supabase → SQL Editor → New query → Run**. Ele instala a rotina 060 e executa a limpeza de CP na mesma transação.
2. Em **Supabase → Edge Functions → payables-import → Code → index.ts**, substitua todo o conteúdo pela [função completa atualizada](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/payables-import.ts) e clique em **Deploy updates**. O código TypeScript pertence à função, separado do SQL do primeiro passo.
3. Atualize a Central com **Ctrl + F5** e confira a versão **0.18.17**.
4. Importe o novo relatório completo para estabelecer a base inicial.

O reinício é uma operação única: repetir o mesmo SQL não apaga arquivos ou títulos oficiais importados depois da primeira limpeza. Uma falha na instalação, na cópia ou na conferência desfaz a operação inteira. A publicação do site não executa esse SQL e não limpa o banco remoto.

Para instalar a rotina sem limpar dados, utilize o [SQL 060 de ativação](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-relatorio-unico-contas-pagar.sql). A recuperação da cópia tem um [SQL separado](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/admin/restaurar-somente-contas-pagar-2026-10-30.sql), que recusa sobrepor novas operações oficiais.

## Rotina diária

1. Exporte do sistema de origem a relação **completa dos títulos em aberto**, de todas as filiais, incluindo os cheques e os novos títulos.
2. Entre em **Importar Bases → Contas a Pagar** e selecione o arquivo. A conferência começa automaticamente.
3. Confira o resumo de inclusões, atualizações e baixas. Resolva somente as exceções indicadas, como plano novo, conta sem vínculo ou marcador de R$ 0,01.
4. Clique em **Importar e conciliar relatório diário** e confirme o resumo.

O primeiro relatório cria a referência e não baixa títulos antigos por ausência. Cada novo relatório completo passa a ser a referência do dia seguinte. Um arquivo filtrado, de uma única filial ou apenas com os novos lançamentos não deve ser utilizado nesta rotina.

Se a relação atual não tiver mudado e o arquivo for idêntico ao da posição mais recente, a Central registra a nova conferência sem duplicar títulos ou pagamentos. Um arquivo antigo que já foi substituído por outra posição continua bloqueado.

Títulos comuns ausentes entram em **Pago/Realizado na data de vencimento registrada**. Cheques ausentes entram em **Pago/Realizado na data oficial da importação, em São Paulo**. Ambos são processados pelo mesmo arquivo. O pagamento considera o saldo integral a pagar e fica conciliado, com seu histórico.

Uma data de vencimento futura exige conferir a data efetiva do pagamento antes de concluir; a Central não registra um pagamento futuro por suposição. As contas já vinculadas são reutilizadas. Uma conta sem correspondência segura exige escolha explícita, que pode ser reutilizada nas próximas importações. Para títulos comuns, o banco efetivo pode ser ajustado individualmente antes da confirmação.

## Como as colunas são utilizadas

| Coluna do relatório | Informação na Central |
| --- | --- |
| Lançamento + Filial | Identidade do título nas próximas importações. |
| Histórico | Descrição da conta e da parcela. |
| Plano cp - Conta: nome | Plano vinculado ao Centro de Custo Macro; classificações existentes são reutilizadas. |
| Plano cc - Conta: nome | Banco previsto na origem, preservado separadamente do banco efetivo do pagamento. |
| Emissão: valor do lançamento | Valor provisionado atualizado pelo novo relatório. |
| Emissão: data | Data de emissão do título. |
| Vencimento: data | Vencimento atualizado do mesmo lançamento. |
| Cheque: número | Número textual do cheque, incluindo zeros iniciais. Quando preenchido, o banco do pagamento é BRADESCO F2G. |

Alterar valor ou vencimento não cria outra dívida para a mesma filial e lançamento. Pagamentos já registrados não são apagados por uma atualização da previsão. Um título pago que reaparece exige conferir o histórico antes de retornar à base.

## R$ 0,01 e relatório sem títulos

Os marcadores de **R$ 0,01** exigem confirmação individual de baixa sem pagamento. Permanecem no histórico, fora dos valores financeiros e do realizado. Um saldo residual de um centavo em um título originalmente maior não é tratado como marcador administrativo.

Quando todos os títulos tiverem sido liquidados, exporte um arquivo com os cabeçalhos e sem lançamentos. Marque **Confirmo que o relatório completo não contém títulos em aberto** e confira o resumo das últimas baixas. A declaração só vale para uma posição completa vazia; linhas incompletas, fórmulas ou cabeçalhos ausentes continuam bloqueados.

Se a confirmação ficar pendente por falha de conexão, mantenha a tela aberta e use o reenvio da mesma confirmação. O arquivo, as escolhas e o protocolo ficam preservados para impedir duplicação de pagamentos.
