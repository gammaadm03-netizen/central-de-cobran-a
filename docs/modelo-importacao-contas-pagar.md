# Modelo de importação de Contas a Pagar — 0.8.0

> O [fluxo diário de títulos e cheques — 0.18.14](conciliacao-diaria-contas-pagar.md) utiliza as colunas de previsões abaixo e acrescenta a comparação entre relatórios completos. As regras deste documento para previsões incrementais e quitações continuam disponíveis nos modos anteriores.

Os nomes abaixo foram confirmados pelo usuário. As colunas podem aparecer em outra ordem. A mesma estrutura é utilizada em dois contextos, escolhidos explicitamente em Importar Bases.

| Coluna do relatório | Previsões / novos títulos | Pagamentos realizados |
| --- | --- | --- |
| Lançamento | Número do título | Mesmo número, sem criar outra dívida |
| Filial | Identificação explícita | Mesma filial para localizar o título |
| Histórico | Histórico / favorecido | Atualiza quando preenchido; ausente ou vazio preserva |
| Plano cp - Conta: nome | Plano vinculado a Macro oficial | Atualiza quando preenchido; ausente ou vazio preserva |
| Plano cc - Conta: nome | Conta prevista da origem | Conta efetivamente usada, vinculada a uma conta oficial |
| Emissão: valor do lançamento | Valor integral previsto | Valor integral efetivamente pago, atualizando o valor atual do título |
| Emissão: data | Data civil da emissão | Se preenchida atualiza; coluna vazia limpa; coluna ausente preserva |
| Vencimento: data | Vencimento previsto | **Data real do pagamento**, conforme confirmação do usuário; preserva o vencimento previsto existente |
| Situação | Situação da origem e identificação de cheque | Compatível com pagamento; a seleção explícita declara que todas as linhas foram pagas |
| Cheque: número | Número próprio do cheque como texto | Atualiza se a coluna existir; ausente preserva, vazia limpa |

O número do título junto com a filial identifica a dívida; valor, data ou banco não criam uma nova identidade. Zeros à esquerda no cheque são preservados quando o Excel contém texto ou formato numérico composto somente de zeros, como `000000`. Números com formato incompatível devem ser convertidos para Texto na origem; a Central não inventa dígitos que não existem no arquivo.

A primeira base e as atualizações de previsão podem conter obrigações em aberto e cheques. Na rotina informada, segunda-feira inclui novos títulos e terça a sexta atualiza os pagos. A seleção não depende do dia do calendário, para permitir reprocessamento. Nenhum dos dois modos baixa títulos apenas por ausência no arquivo.

No modo de pagamentos, são obrigatórios número, filial, valor integral positivo, banco efetivo e data real até hoje. A declaração de pagos aceita situação vazia ou textos compatíveis com pagamento, incluindo CHEQUE, PAGO, QUITADO, LIQUIDADO e COMPENSADO. ABERTO, PENDENTE, CANCELADO, ESTORNADO ou situação desconhecida bloqueiam a análise. Um texto CHEQUE sozinho não comprova quitação fora do modo explícito de pagamentos. Histórico, plano, emissão e número de cheque são informações complementares nesse modo; o original completo é preservado.

Datas ERP de emissão e vencimento aceitam `dd/mm/aaaa`, horário válido `hh:mm` ou `hh:mm:ss`, datas nativas e números seriais Excel válidos. O dia civil não é deslocado por fuso. Data inexistente ou horário inválido bloqueia o arquivo. Valor monetário é convertido em centavos exatos.

Planos não são classificados por suposição. Banco também não é deduzido por trecho do nome: conta com nome oficial inequívoco pode ser reconhecida; demais nomes exigem vínculo explícito por filial + banco informado, reutilizado nas próximas importações. A filial não é extraída do nome do banco.

Arquivos: `.xlsx`, `.xlsm` e `.csv` UTF-8, até 2 MiB, 5.000 títulos e uma aba com dados. `.xls` antigo deve ser salvo como `.xlsx`. Fórmulas, identificação repetida/ambígua e linha inválida bloqueiam a operação inteira; macros não são executadas. Linhas ocultas também são lidas. A análise do navegador não autoriza a gravação: o servidor relê o arquivo original, verifica sessão/permissões e grava atomicamente a cópia privada, o hash, os dados e a auditoria.

A prévia de pagamentos apresenta novos registros, pagamentos já existentes, correções de importações anteriores e divergências. Uma confirmação aplica o arquivo válido e concilia seus títulos integralmente pagos. Repetições não duplicam o realizado. Alterações de pagamentos importados preservam o registro anterior e criam estorno e nova versão. Conflito com pagamento manual ou título desconhecido exige conferência e impede gravação parcial.

Para ativar **0.8.0**, aplicar o SQL combinado e atualizar a função existente **payables-import**, conforme [ativacao-contas-pagar.md](ativacao-contas-pagar.md). O arquivo `.ts` da função não é SQL. Site, função e banco são atualizados separadamente, mantendo o endereço e os dados.
