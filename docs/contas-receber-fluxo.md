# Contas a Receber, Cobrança e base de comissões — 0.9.0

A apuração de Comissões foi recuperada na **0.13.0**: [ativação das quatro abas](ativacao-demais-abas.md). As referências abaixo à ausência de taxas descrevem a entrega 0.9.0; os recebimentos e sua base efetiva permanecem preservados.

A **0.18.0** atualiza a regra dos ausentes: relatório completo retira da carteira ativa e encaminha trabalhados à fila pendente de Comissões. A **0.18.12 / SQL 055** permite confirmar esses recebimentos pela Validação financeira ou por Quitados; a confirmação resolve a pendência e alimenta a base de comissão conforme a data real e as regras vigentes. Arquivo parcial conserva ausentes. Estas regras substituem as referências históricas abaixo à preservação na carteira ativa. [Guia e ativação](recebiveis-relatorio-completo.md).

As regras de importação e recebimento desta página permanecem vigentes. A atualização **0.12.0** permite escolher responsáveis na importação dos abertos, acrescenta retornos prioritários e encaminha pagamentos informados à validação fora da fila ativa. Consultar o [guia atual de atendimento e retornos](cobranca-atendimento-retornos.md). As referências à interface anterior abaixo são históricas.

A operação utiliza os dois modelos Excel enviados pelo usuário, sem renomear colunas. A equipe registra no sistema de origem e importa na Central; o arquivo de quitados confirma os recebimentos, sem exigir que a cobradora informe manualmente o mesmo pagamento.

| Relatório | Finalidade |
| --- | --- |
| Abertos e vencidos | Atualizar Contas a Receber; disponibilizar na cobrança ativa somente os vencidos ainda não quitados |
| Títulos quitados | Confirmar o recebimento, retirar o título da cobrança ativa e disponibilizar o valor recebido na base de comissões |

## Colunas dos modelos

| Cabeçalho | Uso |
| --- | --- |
| Entidade 1 - Entidade: nome | Cliente / órgão |
| Documento: número | Número da nota / documento, como identificador textual |
| Emissão: valor do lançamento | Valor nominal original do título |
| Emissão: data | Data civil de emissão |
| Vencimento: data | Vencimento original da parcela |
| Filial | Filial explícita da origem |
| Quitação: data do recebimento | Data efetiva do recebimento; obrigatória no relatório de quitados |
| Quitação: valor recebido | Valor efetivamente recebido; obrigatória no relatório de quitados e base de comissão confirmada pelo usuário |

O modelo de abertos tem seis colunas e o de quitados oito. CNPJ continua opcional nos formatos anteriores; não é deduzido ou completado automaticamente. Datas nativas Excel e horários ERP válidos conservam o dia civil. Valores nominal e recebido são independentes: descontos, retenções ou acréscimos não são inferidos. O relatório declarado como quitado encerra a dívida e registra o valor efetivo, inclusive quando recebido antes do vencimento ou com diferença em relação ao nominal.

## Identificação de parcelas e reimportação

O usuário confirmou que não consegue exportar código único de lançamento/parcela. A identificação passa a usar **filial + cliente + documento + vencimento**, sem o valor. Assim, alterar o valor atualiza o mesmo UUID e preserva carteira, contatos e histórico. Parcelas da mesma NF com vencimentos diferentes permanecem distintas.

Uma mudança de vencimento pode ser confundida com uma nova parcela. Nesses casos a prévia exige vínculo explícito: selecionar o título existente ou **Nova parcela**. É possível declarar em conjunto novas parcelas históricas após conferir a lista. A Central não escolhe a parcela por semelhança nem transfere recebimentos entre UUIDs. Vínculos registrados são preservados para as importações seguintes; ambiguidades na base antiga exigem conferência.

As duas modalidades fazem prévia no servidor e exigem confirmação por arquivo. As escolhas, o hash, a sessão e a revisão financeira são novamente validados na conclusão. Arquivo já registrado retorna sem duplicar títulos, recebimentos ou a base de comissões. Ausência em um arquivo de abertos não confirma recebimento nem cria baixa. Um título validado não é reaberto por reaparecer na origem.

Quitados históricos que ainda não estejam na base podem ser cadastrados a partir das informações originais do próprio relatório. Herdam a única responsável conhecida da dívida ativa do cliente, quando existente; sem vínculo comprovado ficam **Responsável pendente**. Não existe atribuição por nome de login ou escolha presumida de cobradora.

Correções de recebimentos criados pela importação exigem confirmação do arquivo e acrescentam uma revisão imutável. O primeiro recebimento, o arquivo original e as versões anteriores são preservados. Relatórios consultam o recebimento efetivo. Divergência com recebimento manual bloqueia o arquivo para conferência, sem substituí-lo silenciosamente. Nenhum recebimento altera automaticamente os saldos bancários informados manualmente.

## Cobrança conforme os fluxos anteriores

Vencido significa **vencimento anterior ao dia atual de São Paulo**. Um título que vence hoje ainda não entra na cobrança; se continuar em aberto, passa a ser elegível no dia seguinte ao atualizar a consulta. A regra vale para a consulta, exportação, RLS da carteira individual e ações do servidor.

A visão gerencial recupera carteira por responsável, títulos/clientes, valor vencido, atraso médio, títulos com/sem ação, pendências de validação, retornos de hoje/atrasados e as seis faixas de atraso. Os atalhos abrem os títulos correspondentes sem perder a restrição de vencidos. Contato, retorno do cliente, promessa, próxima ação, atribuição e histórico continuam nos formulários existentes. A Diretoria consulta; a cobradora trabalha somente na própria carteira.

Pagamento apenas informado continua pendente até a confirmação financeira ou o relatório de quitados. Na 0.12.0, fica na validação financeira, fora da fila ativa de atendimentos. Se não localizado, volta à mesma cobradora com retorno para hoje. Recebimentos validados saem da cobrança e alimentam a base de comissões. Histórico permanece consultável, sem gerar nova cobrança ou redistribuição de responsáveis.

## Diretoria e comissões

O Painel apresenta **Contas a receber em atraso**, **Total a receber** e **Recebido no dia**. O último usa a data oficial de São Paulo e o valor efetivo dos recebimentos validados, inclusive validações anteriores da cobrança; selecionar outra semana/mês do fluxo não transforma um total semanal em diário. O consolidado legado por origem continua preservado no relatório anterior. Sem fonte conhecida, o indicador fica pendente; uma base conhecida sem recebimentos no dia retorna zero.

A aba **Comissões** permite consultar recebimentos por período efetivo e responsável, com nominal, recebido, vencimento, data real, atraso e detalhes individuais. A base é **Quitação: valor recebido**, conforme orientação do usuário. Valores atribuídos e recebidos em atraso ficam disponíveis para apuração; antecipados/em dia e sem responsável são identificados separadamente. Não é exigida marcação manual de pagamento pela cobradora para considerar o relatório.

**Não foram cadastrados percentuais, vigências ou pagamentos de comissão.** A tela fornece a base confirmada; a tabela de taxas precisa ser definida antes de calcular/aprovar comissões. As referências históricas da V75 não foram transformadas em taxas novas por suposição.

Ativação: [ativacao-operacao-recebiveis.md](ativacao-operacao-recebiveis.md). Não publicar os arquivos Excel operacionais nem incorporar seus registros como dados de demonstração.
