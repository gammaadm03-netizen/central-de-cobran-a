# Salários e pró-labores de RH / DP — 0.13.3

Os registros com setor **SÓCIO** são identificados como **Pró-labore**, com seus valores apresentados separadamente dos salários dos colaboradores. A classificação considera o setor informado na planilha, sem depender do nome da pessoa.

| Indicador | Coluna de origem | Pessoas incluídas |
| --- | --- | --- |
| Salário Folha — colaboradores | Salário Folha ou Salário Base, sem descontos | Colaboradores, sem sócios |
| Salário recebido — colaboradores | Salário recebido, com descontos | Colaboradores, sem sócios |
| Pró-labore sem descontos | Salário Folha ou Salário Base, sem descontos | Sócios |
| Pró-labore recebido | Salário recebido, com descontos | Sócios |

O **Total geral** mantém a soma definida pela operação: **remuneração sem descontos + VT total + remuneração recebida + Adiantamento + Ajuda de Custo**. Há subtotais separados para colaboradores e sócios. Para os colaboradores, remuneração significa salário; para os sócios, pró-labore. Os valores originais e o histórico permanecem preservados.

## Ativar a separação dos sócios

1. No Supabase, abra **SQL Editor → New query**. Abra o [SQL completo de atualização](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-demais-abas.sql), copie tudo, cole e clique em **Run**. O arquivo termina em `COMMIT;`. Instala somente versões ausentes de **031 a 037** e solicita atualização do cache da API. `Success. No rows returned` é normal.
2. Confira o deploy do site **0.13.3** na Cloudflare. Atualize a Central, abra **RH / DP** e clique em **Atualizar RH / DP**.

Se a versão **0.13.2 já foi ativada**, esses dois passos bastam. A classificação usa os registros já importados; não é necessário reimportar o arquivo ou republicar a função para separar pró-labores. A publicação pelo Git não executa o SQL no Supabase.

## Se ainda não concluiu a correção das colunas da 0.13.2

Depois de executar o SQL acima, abra **Edge Functions → business-import → Code → index.ts**. Abra o [código completo da função](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/business-import.ts), copie tudo e substitua o conteúdo inteiro. Confira que termina em `}));` e publique a função existente. Mantenha **Verify JWT with legacy secret** desligado em Settings.

Na Central atualizada, abra **Importar Bases → RH / DP**. Selecione a mesma planilha com a data da posição original, confira os salários e pró-labores na prévia e confirme. Essa reimportação recupera vínculos de colunas antes interpretados incorretamente; não é necessária apenas para a classificação de sócios.

## Cabeçalhos aceitos

| Coluna do relatório | Informação utilizada |
| --- | --- |
| FILIAL | Filial / empresa da pessoa |
| ADMISSAO | Data de admissão; pode ficar vazia |
| ANIVERSARIO | Data de nascimento / aniversário |
| Salário Folha, Salário da Folha ou Salário Base | Remuneração sem descontos: salário ou pró-labore conforme o setor |
| VT TOTAL | Vale-transporte recebido |
| Salário recebido ou Salário Líquido | Remuneração recebida com descontos: salário ou pró-labore conforme o setor |
| Adiantamento | Adiantamento informado |
| Ajuda de Custo | Ajuda de custo |
| SETOR | SÓCIO identifica a pessoa na soma de pró-labores |
| Funcionário | Nome da pessoa |
| TOTAL (opcional) | Valor original preservado para conferência, separado do Total calculado |

O modelo anterior com **Salário Base + Salário** continua aceito: Salário preenche o valor recebido. No formato com dois cabeçalhos SALÁRIO, o primeiro é sem descontos e o segundo é recebido. Nomes explícitos têm prioridade, independentemente da ordem das colunas. Duas colunas explícitas para o mesmo campo exigem correção do arquivo para evitar escolha ambígua.

Conforme confirmado pelo usuário, **célula vazia em VT TOTAL, Adiantamento ou Ajuda de Custo significa zero**, quando a coluna existe. O traço contábil, como `R$ -`, também representa zero. Coluna ausente, salários, pró-labores e datas vazios permanecem não informados.

## Conferência e histórico

O banco calcula os totais em centavos; RH/DP, prévia e Excel mantêm os salários e pró-labores separados. A coluna TOTAL original permanece apenas para conferência. Se faltar um dos cinco componentes, o Total correspondente fica **Não informado**; uma informação ausente no grupo de sócios não torna desconhecido o subtotal dos colaboradores e vice-versa. A cesta básica continua separada desse cálculo.

As posições antigas, arquivos originais e auditorias não são reescritos. A consulta usa uma posição atual; repetir o mesmo arquivo pela revisão atual não duplica pessoas ou totais. A revisão 3 e a proteção contra importadores antigos continuam em uso. O Excel identifica cada pessoa como Salário ou Pró-labore e mantém as informações de origem.
