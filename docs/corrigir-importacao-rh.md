# Salários e Total de RH / DP — 0.13.2

Os dois indicadores usam colunas diferentes, conforme a definição da operação:

- **Salário Folha — colaboradores**: coluna **Salário Folha** (ou **Salário Base**), sem descontos e excluindo o setor SÓCIO.
- **Salário recebido**: coluna **Salário recebido**, com descontos e incluindo sócios.
- **Total de salários e benefícios**: **Salário Base + VT total + Salário recebido + Adiantamento + Ajuda de Custo**, incluindo ambos os salários e os sócios. Essa soma foi solicitada explicitamente pelo usuário.

## Atualizar o projeto existente

1. No Supabase, abra **SQL Editor → New query**. Abra o [SQL completo de atualização](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-demais-abas.sql), copie tudo, cole e clique em **Run**. O arquivo termina em `COMMIT;`. Ele instala somente versões ausentes de **031 a 036**, preserva as bases e solicita atualização do cache da API. `Success. No rows returned` é normal.
2. Abra **Edge Functions → business-import → Code → index.ts**. Abra o [código completo atualizado](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/business-import.ts), copie tudo e substitua o conteúdo inteiro do editor. Confira que termina em `}));` e publique a atualização da função existente. Mantenha **Verify JWT with legacy secret** desligado em Settings.
3. Confira o deploy do site **0.13.2** na Cloudflare. Atualize a Central, entre novamente e abra **Importar Bases → RH / DP**. Selecione a mesma planilha e mantenha a data da posição original. Confira os dois salários e o Total na prévia e confirme.

O arquivo SQL pertence ao SQL Editor; o TypeScript pertence ao editor da função. A publicação pelo Git não executa esses passos no Supabase. Use a função **business-import** existente.

## Cabeçalhos aceitos

| Coluna do relatório | Informação utilizada |
| --- | --- |
| FILIAL | Filial / empresa da pessoa |
| ADMISSAO | Data de admissão; pode ficar vazia |
| ANIVERSARIO | Data de nascimento / aniversário |
| Salário Folha, Salário da Folha ou Salário Base | Salário sem descontos |
| VT TOTAL | Vale-transporte recebido |
| Salário recebido ou Salário Líquido | Salário recebido com descontos |
| Adiantamento | Adiantamento informado |
| Ajuda de Custo | Ajuda de custo |
| SETOR | Setor; sócios permanecem identificados separadamente |
| Funcionário | Nome da pessoa |
| TOTAL (opcional) | Valor original preservado para conferência, separado do Total calculado |

O modelo anterior com **Salário Base + Salário** continua aceito: Salário preenche o valor recebido. No formato com dois cabeçalhos SALÁRIO, o primeiro é sem descontos e o segundo é recebido. Nomes explícitos têm prioridade, independentemente da ordem das colunas. Duas colunas explícitas para o mesmo campo exigem correção do arquivo para evitar escolha ambígua.

Conforme confirmado pelo usuário, **célula vazia em VT TOTAL, Adiantamento ou Ajuda de Custo significa zero**, quando a coluna existe. O traço contábil, como `R$ -`, também representa zero. Se uma dessas colunas não existir no arquivo, o valor permanece desconhecido. Salários e datas vazios permanecem não informados.

## Conferência e histórico

O banco calcula o Total em centavos para cada pessoa e para a base inteira; a prévia, RH/DP e o Excel usam esse mesmo cálculo. A coluna TOTAL original é opcional e permanece separada. Se algum dos cinco componentes não estiver informado, o Total fica **Não informado**, sem completar dados ausentes com zero. A cesta básica continua sendo um indicador separado.

As posições antigas e os arquivos originais não são reescritos. Reimportar um arquivo já registrado permite corrigir o vínculo dos salários numa nova revisão do mesmo original, mantendo o histórico. A consulta usa uma única posição atual. Repetir o arquivo pela revisão atual não duplica pessoas ou totais. Colunas ausentes em posições antigas permanecem desconhecidas até a reimportação.

A revisão 3 bloqueia novas gravações pelos importadores antigos após a primeira importação corrigida. O site atualizado também identifica uma função antiga antes de permitir confirmação. Conclua a atualização de **business-import** antes de importar RH.
