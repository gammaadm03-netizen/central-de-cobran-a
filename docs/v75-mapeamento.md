# Mapeamento da Central V75

Este documento registra a análise da última versão recebida, preservada em
`/workspace/legacy-v75/Central_Gestao_Semanal_V75.html`. Os números de linha
abaixo se referem a esse arquivo original. Não contém lançamentos, clientes,
valores de bases, senhas, hashes de autenticação ou credenciais.

## Situação da aplicação online

A estrutura online foi construída com React, TypeScript, Vite, Supabase Auth e
PostgreSQL com RLS. Login, perfis, administração, auditoria de acesso e mensagens
foram implantados antes da operação financeira. Na revisão que originou este
inventário, as abas financeiras ainda exibiam `PendingModule` em `src/App.tsx`.

As abas vazias não indicavam que as bases antigas haviam sido apagadas nem que
existia uma opção do Supabase capaz de recuperá-las. Os fluxos financeiros da V75
precisam ser portados para a arquitetura central, com migração e validação dos
dados. Consultar o código atual para o andamento posterior deste trabalho.

## Identidade visual preservada

A imagem oficial do símbolo Ecoplast foi localizada no elemento
`img.brand-logo` da linha 389 do HTML original. Exclusivamente os bytes PNG
desse elemento foram extraídos para `public/ecoplast-logo.png`.

A imagem foi inspecionada visualmente: contém somente o símbolo verde da marca,
com transparência, em 194 × 193 pixels. O PNG não contém blocos de metadados de
texto ou EXIF. Nenhum HTML, script ou registro financeiro foi incluído no asset.
O arquivo original permanece intacto.

## Módulos e pontos de reaproveitamento

| Módulo | Início da seção | Funções e referências |
| --- | ---: | --- |
| Painel Gerencial | 423 | `renderDashboardWeek` 1330; `renderMain` 1377 |
| Resumo da Diretoria | Dentro do painel | `renderDirectorSummary` 1608; `snapData` 2471; exportações 2551 e 2576 |
| Caixa / Bancos | 488 | Contas oficiais 1157; `cashCompanyTotals` 1571; `renderCashBankModule` 1579 |
| Contas a Pagar | 507 | `apImportDiff` 1529; classificação 1551; previsão 2004; Excel 2009 e 2020 |
| Contas a Receber | 684 | Normalização 1711; comparação 1713; confirmação 1773 |
| Cobrança | 709 | Herança de carteira 1702; ações 1844; validação 1851 e 1852 |
| Comissões | 760 | Cobradoras 1855–1862; vendedores 1869–1883 |
| Faturamento | 846 | `normalizeFatImportRows` 1566; `renderSales` 1484 |
| Margens | 861 | `renderMargins` 1494 |
| RH / DP | 878 | Cesta 3094–3096; datas 3097–3111; normalização 3199 |
| Importar Bases | 996 | Leitura genérica 1547; normalizadores 1548, 1566, 1711 e 3199 |

São reaproveitáveis a identidade, as colunas das tabelas, os filtros conhecidos,
as descrições dos fluxos e as regras que coincidam com a especificação vigente.
O acesso ao DOM e a persistência do monólito precisam ser substituídos por
componentes React e operações protegidas no banco.

## Estruturas de dados de origem

A linha 1143 declara `D`, que contém bases operacionais e agregados para a tela.
As bases embutidas representam uma posição histórica. Elas não comprovam a
posição atual da operação.

| Origem | Formato |
| --- | --- |
| `D.aprows` | `[lancamento, historico, vencimento, valor, status, plano, banco, filial, emissao, macro?]` |
| `D.arrows` | `[documento, cliente, vencimento, valor, filial]` |
| `D.salesrows` | Objetos de venda descritos abaixo |
| `COB_SEED`, linha 1144 | Objetos de cobrança descritos abaixo |
| `D.m` | Indicadores derivados e metadados da posição |
| `D.apdaily`, `D.ardaily`, `D.apcats`, `D.salesfil` | Agregados destinados a gráficos e resumos |
| `D.acts` | Atividades para apresentação no painel |

Venda:

```text
cod, produto, qtd, venda, frete, emissao, cliente, func, nf, centro,
filial, imposto, cmv, comissao_pct, comissao, margem, margem_pct
```

Título de CR após normalização:

```text
doc, client, value, issue, due, filial
```

Cobrança de origem:

```text
id, client, doc, value, issue, due, filial, company, days, band, owner,
status, validation, lastAction, nextAction, nextDate, observation, source,
elapsedMs, activeSince, lastFinishedAt
```

As alterações em `cobMem` acrescentam campos como data informada do pagamento,
origem do pagamento, data efetiva, dias em atraso no recebimento e faixa de
atraso. A migração deve unir o registro original com suas alterações antes de
comparar o resultado.

Funcionário normalizado:

```text
filial, contagem, admissao, aniversario, salarioBase, setor, funcionario,
vt, salarioFolha, adiantamento, total
```

Snapshot da diretoria: identificação, horário UTC e texto visual, período,
posição comercial, recebíveis, caixa, estoque, obrigações e ativo circulante.
O cálculo fica em `snapData`, linha 2471.

## Chaves persistidas na V75

Todas as chaves abaixo são nomes de estruturas. Seus conteúdos não fazem parte
deste documento nem devem ser incluídos em assets públicos.

| Finalidade | Chaves completas |
| --- | --- |
| CP — base atual | `central_gestao_v14_ap_current` |
| CP — fechamento de semanas | `central_gestao_v45_ap_weeks_sat_fri`; anterior: `central_gestao_v8_ap_weeks` |
| CP — baixas e última importação | `central_gestao_v45_ap_paid_history`; `central_gestao_v45_ap_last_daily_import` |
| CP — previsões e classificações | `central_gestao_v44_ap_manual_forecast`; `central_gestao_v44_ap_provision_done`; `central_gestao_v44_ap_macro_overrides` |
| CR — base e importações | `central_gestao_v11_ar_current`; `central_gestao_v11_ar_history` |
| Atribuições de carteira | `central_gestao_v23_ar_owner_map` |
| Cobrança — registros adicionais | `central_gestao_v11_cob_extra` |
| Cobrança — alterações e atividades | `central_gestao_v7_cobranca`; `central_gestao_v7_log` |
| Fechamento / Faturamento | `central_gestao_v14_fat_current` |
| Caixa — consolidado anterior | `central_gestao_v14_cash` |
| Caixa — contas e data da posição | `central_gestao_v36_cash_accounts`; `central_gestao_v36_cash_position_date` |
| Diretoria — complementos | `central_gestao_v49_director_complements` |
| Diretoria — posições históricas | `central_gestao_director_snapshots` |
| Mensagens | `central_gestao_ap_management_messages` |
| Histórico geral de importações | `central_gestao_v14_import_log` |
| Estoque e compras do portal interno | `central_gestao_v54_external_portal` |
| RH — base e metadados | `central_gestao_v63_rh_base`; `central_gestao_v63_rh_meta` |
| Preferência do período | `central_gestao_v9_dashboard_week` |
| Preferência de preenchimento das mensagens | `central_ui_ap_message_identity` |

O servidor antigo serializa essas informações em `central_state.json`:

```text
{
  storage: { nomeDaChave: stringJSON },
  updatedAt: dataHora
}
```

O `central_state.json` operacional não foi encontrado entre os arquivos
originais recebidos. O conteúdo atualizado pode estar na pasta de dados do
servidor antigo ou no armazenamento dos navegadores usados na operação. As
credenciais do sistema antigo não são uma fonte de dados financeiros e não
devem ser publicadas ou migradas como senhas em texto.

## Regras aproveitáveis com validação

- `saturdayOf`, linha 1199, e `weekKeyFromBR`, linha 1200, definem a semana de
  sábado a sexta. Manter datas de negócio no fuso oficial e testar os limites.
- `apImportDiff`, linha 1529, separa títulos novos, mantidos e desaparecidos.
  Essa comparação deve acontecer dentro do escopo completo da base autorizada.
- `apRecurringForWeek`, linha 2002, reduz a previsão pelo valor já conhecido,
  evitando somar previsão integral e realizado integral.
- `activeOwnerInfo`, linha 1702, identifica responsável de dívida ativa e
  sinaliza conflito em vez de escolher entre duas cobradoras.
- `confirmCobReceipt`, linha 1851, exige data efetiva e calcula a faixa pelo
  atraso na data do recebimento.
- `directorCurrentAssetStats`, linha 1606, distingue ausência de estoque de
  estoque informado. O painel deve manter o cálculo pendente quando necessário.
- `hasBasket`, linha 3095, aplica as exclusões nominais definidas pela operação.

## Divergências a resolver pela especificação mais recente

1. As regras de comissão de Mateus e Kevyn no código antigo usam uma margem
   mínima inferior à instrução atual. Usar a regra vigente, com tabela de
   configuração e vigência; preservar os períodos históricos.
2. A recusa de pagamento em `renderValidation`, linha 1852, define uma próxima
   ação diferente de `COBRAR NOVAMENTE`. O fluxo atual exige devolução à mesma
   cobradora, sem comissão e sem redistribuição.
3. A heurística `apMacroFor`, linha 1976, agrupa categorias que a especificação
   atual separa. Planos desconhecidos devem aguardar classificação oficial.
4. `AP_HISTORY_2026`, linha 1958, contém resumos históricos fixos.
   `apMonthData`, linha 2152, prioriza esses resumos sobre dados calculados para
   os períodos correspondentes. Migrar como agregados de origem identificada;
   não fabricar lançamentos para explicar o resumo.
5. As faixas e configurações de comissão estão no código antigo. A versão
   central precisa registrar vigência e a regra usada em cada apuração.

## Bloqueios técnicos e de integridade

- A sincronização do HTML só é ativada na porta `8788` (linha 9). Publicar o
  arquivo em HTTPS comum mantém a operação no armazenamento local, sem a base
  compartilhada exigida.
- O servidor antigo entrega todo o estado a qualquer usuário autenticado em
  `/__state` (`servidor_central_v75.py`, linha 263). O novo modelo precisa de
  autorização por módulo e por carteira diretamente nas consultas e alterações.
- O HTML contém bases financeiras embutidas. Ele deve permanecer privado; não
  pode ser colocado integralmente em `public/` ou incorporado em um iframe.
- `apImportRowKey`, linha 1528, pode usar somente o número do lançamento;
  `arTitleKey`, linha 1694, omite valor; `importedCobId`, linha 1699, usa um hash
  curto. Avaliar colisões, repetições entre filiais e alterações antes de
  definir chaves estáveis no destino.
- O normalizador CP descarta algumas linhas com data inválida sem relatório.
  Outros normalizadores podem converter entrada inválida em zero. O destino
  deve rejeitar a importação com indicação da linha e da correção necessária.
- O leitor CSV de CR, linha 1712, usa divisão por delimitador sem tratar
  adequadamente campos entre aspas. Substituir por leitor apropriado.
- As importações antigas escrevem várias chaves sequencialmente, sem
  transação. O novo fluxo deve garantir confirmação atômica ou rollback.
- O leitor Excel é carregado de CDN (linha 1141). A aplicação nova deve usar
  dependência revisada e definir limites de tamanho, linhas e formatos.
- Custos/fatores de produtos, mapeamento prefeitura/região e conciliação de
  cheques não foram localizados como módulos implementados na V75. Não
  apresentá-los como funcionalidades já portadas.
- As colunas de venda disponíveis não atendem a todos os filtros de estado,
  tipo fiscal e operações com/sem nota. Dados ausentes devem ser sinalizados,
  sem inferência automática.

## Plano de migração sem perda de dados

1. Preservar o ZIP original, o HTML e as cópias existentes de estado.
2. Obter uma exportação atual do estado operacional, sem publicar credenciais.
3. Registrar origem, data e hash dos arquivos recebidos.
4. Ler as bases embutidas e o estado em staging privado. Aplicar as alterações
   persistidas sobre os registros de origem, mantendo rastreabilidade.
5. Normalizar datas e valores; separar dados ausentes, inválidos e duplicados.
   Não transformar ausência em zero nem escolher classificação ou cobradora
   em caso de conflito.
6. Produzir relatório por entidade: quantidade na origem, quantidade no
   destino, totais antes/depois, diferenças, erros e não migrados.
7. Conferir a posição com a Gerência Geral e registrar a validação.
8. Migrar em transação, com identificador de lote, backup e auditoria. Executar
   novamente o lote não pode duplicar os registros.
9. Habilitar cada módulo somente depois de testar suas regras e permissões,
   incluindo acesso direto à API e isolamento das carteiras.
10. Manter o endereço público e atualizar apenas código e migrations aditivas.
    Publicações futuras não devem recriar ou zerar o banco.

Este mapeamento documenta a origem. Ele não representa uma migração executada
nem a homologação dos módulos financeiros.
