# Importação do modelo atual de RH / DP — 0.13.1

O modelo enviado possui **Salário Base** e **Salário** como colunas distintas, além de **Ajuda de Custo**. O leitor anterior confundia a coluna Salário com outro salário base e não guardava a ajuda de custo. A correção reconhece o modelo completo e mantém o formato antigo com dois cabeçalhos SALÁRIO.

## Atualizar o projeto existente

1. No Supabase, abra **SQL Editor → New query**. Abra o [SQL completo de atualização](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-demais-abas.sql), copie tudo, cole e clique em **Run**. O arquivo termina em `COMMIT;`. Ele instala somente versões ausentes de 031 a 035, preserva as bases e solicita atualização do cache da API. `Success. No rows returned` é normal.
2. Abra **Edge Functions → business-import → Code → index.ts**. Abra o [código completo atualizado](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/business-import.ts), copie tudo e substitua o conteúdo inteiro do editor. Confira que termina em `}));` e publique a atualização da função existente. Mantenha **Verify JWT with legacy secret** desligado em Settings.
3. Confira o deploy do site **0.13.1** na Cloudflare. Atualize a Central, entre novamente e abra **Importar Bases → RH / DP**. Selecione a mesma planilha, confira todos os campos na prévia e confirme.

O arquivo SQL pertence ao SQL Editor; o TypeScript pertence ao editor da função. A publicação pelo Git não executa esses passos no Supabase. As demais funções continuam em uso.

## Cabeçalhos aceitos

| Coluna do relatório | Informação preservada |
| --- | --- |
| FILIAL | Filial / empresa da pessoa |
| ADMISSAO | Data de admissão; pode ficar vazia |
| ANIVERSARIO | Data de nascimento / aniversário |
| Salário Base | Salário base, separado da folha |
| VT TOTAL | Vale-transporte |
| Salário | Salário da folha |
| Adiantamento | Adiantamento informado |
| Ajuda de Custo | Ajuda de custo, separada do salário e do adiantamento |
| SETOR | Setor; sócios permanecem identificados separadamente |
| Funcionário | Nome da pessoa |

Conforme confirmado pelo usuário, **célula vazia em VT TOTAL, Adiantamento ou Ajuda de Custo significa zero**, quando a coluna existe. O traço contábil, como `R$ -`, também representa zero. Se uma dessas colunas não existir no arquivo, o valor permanece desconhecido. Salários e datas vazios permanecem não informados.

O modelo enviado não contém TOTAL. A Central não calcula um total somando salário e adiantamento, pois isso poderia contar pagamentos duas vezes. O campo Total informado continua disponível para arquivos que tragam explicitamente a coluna TOTAL.

## Conferência e histórico

A prévia mostra todos os campos do modelo. A aba RH/DP acrescenta os totais separados de salário da folha e ajuda de custo, e o Excel mantém as colunas individuais. O salário base dos colaboradores continua excluindo sócios; os totais da folha e da ajuda de custo abrangem as pessoas informadas, incluindo sócios.

As posições antigas e os arquivos originais não são reescritos. Reimportar um arquivo já registrado pelo modelo antigo cria uma posição corrigida com os novos campos, mantendo o histórico. A repetição do mesmo arquivo pela versão corrigida não duplica registros nem totais. Colunas ausentes em posições antigas permanecem desconhecidas até a reimportação; não são transformadas retroativamente em zero.

Depois da primeira importação corrigida, a função antiga não pode gravar uma posição incompleta por cima dela. Por isso, conclua o passo de atualizar **business-import** antes de iniciar novas importações de RH.
