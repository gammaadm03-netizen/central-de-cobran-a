# Comissões, Faturamento, Margens e RH / DP — 0.13.0

**Atualização 0.13.4:** o combinado atual inclui **031..038**. A importação reconhece a folha e o rodapé de totais, e o Total geral vem da coluna Total do relatório. Atualize também business-import e reimporte a planilha para recuperar os campos anteriores ausentes. [Guia de RH](corrigir-importacao-rh.md).

As quatro abas foram recuperadas do código original V75 e adaptadas à base central. O HTML antigo e seus registros embutidos permanecem privados. Esta atualização não substitui usuários, saldos, títulos, recebimentos ou atendimentos já cadastrados.

## Ativar no projeto existente

1. No Supabase, abra **SQL Editor → New query**. Cole todo o conteúdo de [ativar-demais-abas.sql](../supabase/dashboard/ativar-demais-abas.sql) e clique em **Run**. Este arquivo é SQL e instala somente versões ainda não registradas, de 031 a 038, em uma transação. `Success. No rows returned` é o resultado normal. Não repetir a instalação inicial.
2. Abra **Edge Functions → Deploy a new function → Via Editor**. Substitua todo o conteúdo de **index.ts** pelo arquivo [business-import.ts](../supabase/dashboard/business-import.ts). Em **Function name**, no rodapé ao lado de **Deploy function**, escreva exatamente **business-import** e publique. Se esse nome já existir, atualize **Code → index.ts** na função existente.
3. Em **business-import → Settings**, desligue **Verify JWT with legacy secret** e salve. A função verifica o token pelo Supabase Auth, a sessão aprovada e as permissões antes de processar o arquivo. O secret existente **ALLOWED_ORIGINS** deve conter `https://central-de-cobran-a.pages.dev`, sem barra final. As outras funções permanecem em uso.
4. Na Cloudflare, confira o deploy da branch **main**. Na Central, atualize a página e confira **Versão 0.13.4** no rodapé. Entre novamente para carregar suas permissões.

O arquivo TypeScript do passo 2 pertence ao editor de Edge Functions; não deve ser colado no SQL Editor. A publicação pelo Git atualiza o site, mas não executa SQL nem publica a função do Supabase.

## Faturamento e Margens

Em **Importar Bases → Fechamento / Faturamento**, selecione o mês e o relatório completo desse mês. Analise a prévia, confira quantidade e totais e confirme. A mesma importação alimenta **Faturamento**, **Margens** e a base das comissões de vendedores.

Cada nova versão substitui a consulta daquele mês, preservando os arquivos e versões anteriores. Envie o fechamento mensal completo, inclusive numa correção; um arquivo contendo apenas itens novos não representa o fechamento integral. Repetir um original já registrado não duplica valores.

Os cabeçalhos reconhecidos incluem Código, Produto, Venda total, Emissão, Cliente, Filial, Funcionário comissionado, Nota fiscal e Centro de custo. Para Margens, use CMV total, Imposto total, Frete total, Comissão total e Margem líquida final R$. Cabeçalhos equivalentes da V75 também são aceitos. A tela apresenta os campos obrigatórios e as linhas que precisam de correção.

A margem final informada no arquivo é preservada, inclusive zero. Quando ela está ausente, o cálculo só é feito se venda e todos os componentes necessários estiverem preenchidos. Campo ausente não vira custo zero. O percentual consolidado é margem total dividida pela venda total, sem média dos percentuais dos itens.

As duas abas têm seleção de mês, filtros, paginação e abertura de cada item. Faturamento filtra filial, centro de custo e funcionário; Margens também filtra faixa de margem. O Excel inclui todos os itens do filtro autorizado, e não somente a página visível.

## Comissões

**Cobradoras:** a origem é o valor efetivamente recebido e validado, vinculado a título trabalhado na Cobrança. A faixa considera o atraso na data real do recebimento. Pagamento apenas informado ou ainda pendente de validação não gera comissão.

A Gerência configura as responsáveis participantes e a data de início da regra em **Comissões**. A seleção usa as responsáveis cadastradas na Central; não cria pessoas nem redistribui carteiras. As faixas proporcionais recuperadas são:

| Atraso | Base de referência | Comissão de referência |
| --- | ---: | ---: |
| 1–30 dias | — | R$ 0,00 |
| 31–60 dias | R$ 200.000,00 | R$ 100,00 |
| 61–90 dias | R$ 100.000,00 | R$ 300,00 |
| 91–180 dias | R$ 100.000,00 | R$ 600,00 |
| 181–365 dias | R$ 80.000,00 | R$ 1.000,00 |
| Mais de 365 dias | R$ 35.000,00 | R$ 1.500,00 |

**Vendedores:** a Gerência vincula cada funcionário real do fechamento à política correspondente, com vigência e justificativa. As políticas Comercial, Grandes Contas, Francisco, Mateus e Kevyn foram recuperadas. O usuário confirmou para **Mateus e Kevyn** a margem mínima de **10% em setembro de 2026** e de **14% a partir de 01/10/2026**; as duas vigências são preservadas. Uma regra desconhecida aparece como pendência, sem comissão presumida. A margem usada na regra de vendedores considera a própria comissão, conforme o original; é apresentada separadamente da margem final importada.

Após importar o fechamento, abra **Comissões → Comissões — Vendedores → Configurar comissões**. Selecione o funcionário exatamente como aparece na base, escolha a política, informe uma justificativa e clique em **Recuperar regras confirmadas**. Para Mateus e Kevyn, esse botão cadastra as duas vigências numa única operação. Configurações já existentes são preservadas; uma correção posterior deve ser registrada em **Salvar regra com vigência**.

Os relatórios permitem filtrar período, responsável e faixa, consultar detalhes e preservar uma apuração com a versão da regra e os valores usados. Alterações posteriores não reescrevem apurações salvas. A comissão apurada não representa pagamento de comissão.

## RH / DP

Em **Importar Bases → RH / DP**, informe a data da posição e selecione a folha/base completa. Confira a prévia antes de confirmar. Os campos reconhecidos são Filial, Contagem, Admissão, Aniversário, Funcionário, Setor, Salário, VT TOTAL, segundo Salário, Adiantamento e Total. O primeiro **SALÁRIO** corresponde ao salário base; o segundo, ao salário da folha. Não renomeie os dois para um único campo.

A aba recupera colaboradores e sócios separados, admissões e aniversários do mês, salário base, vale-transporte, adiantamentos, total informado, quadro por filial/setor e calendário de aniversário e tempo de empresa. Busca, filtros e Excel permitem conferir os registros individuais. A consulta usa a posição de referência mais recente; importar uma data mais antiga não a promove sobre a posição atual. A troca do mês no calendário não transforma a base de RH em uma folha histórica daquele mês; a data da posição consultada permanece visível.

A política de cesta do original usa **R$ 112,80 por beneficiário**, com projeção anual de doze meses. As duas exclusões são os nomes completos da política V75: Gabriel Pedrosa Marques Ferreira e Gustavo Marques Ferreira. Sócios são separados do quadro e do salário base dos colaboradores; os agrupamentos preservam todas as pessoas, como no original. Valores faltantes ficam identificados para conferência.

## Acessos e conferência

A Diretoria consulta as quatro abas e exporta relatórios conforme suas permissões, sem modificar regras ou importar arquivos. A Gerência configura comissões e atualiza as bases autorizadas. RH/DP mantém seu acesso à folha e ao fechamento previsto na matriz existente; não recebe acesso a custos/margens por causa da importação.

Depois da ativação, confira um mês e alguns itens contra o relatório de origem, incluindo margem zero, custo ausente e comissão por faixa. Confira também o total e os dois campos de salário na base de RH. Não há registros de demonstração no banco operacional. O estado atualizado do servidor antigo não foi fornecido: importar as bases reais é necessário para preencher as abas.
