# Folha, pró-labores e Total da planilha — 0.13.4

A base enviada tem onze colunas: FILIAL, ADMISSAO, ANIVERSARIO, Salário Folha, VT TOTAL, Salário recebido, Adiantamento, Ajuda de Custo, Total, SETOR e Funcionário. Ao final há uma linha com os totais das colunas financeiras, sem nome de pessoa. Essa linha é um rodapé e não entra no quadro de colaboradores ou sócios.

O usuário confirmou três indicadores separados para a remuneração sem descontos:

| Indicador | Origem no relatório mostrado |
| --- | --- |
| Folha total do relatório | Total da coluna Salário Folha, mostrado em D30; inclui colaboradores e sócios |
| Salários dos colaboradores | Coluna Salário Folha das pessoas que não são do setor SÓCIO; equivale a D30 menos os pró-labores |
| Pró-labore sem descontos | Coluna Salário Folha dos registros do setor SÓCIO, mostrados em D27:D29 |
| Salário recebido — colaboradores | Coluna Salário recebido, apenas colaboradores |
| Pró-labore recebido | Coluna Salário recebido, apenas sócios |
| Total de remunerações e benefícios | Coluna Total, conferida com o rodapé mostrado em I30 |

A origem do **Total** passa a ser o valor informado no relatório. Isso substitui a fórmula anterior que somava salário sem descontos ao valor recebido. A posição e as letras das colunas podem mudar: a importação usa os cabeçalhos, a linha final de totais e o setor da pessoa, sem fixar as linhas 27–30.

## Atualizar e reimportar

1. No Supabase, abra **SQL Editor → New query**. Copie o [SQL completo de atualização](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-demais-abas.sql), cole e clique em **Run**. O arquivo termina em `COMMIT;`, aplica somente versões ausentes de **031 a 038** e recarrega o cache da API. `Success. No rows returned` é normal.
2. Abra **Edge Functions → business-import → Code → index.ts**. Substitua o conteúdo inteiro pelo [código atualizado da função](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/business-import.ts) e clique em **Deploy**. O código termina em `}));`. Use a função existente e mantenha **Verify JWT with legacy secret** desligado.
3. Quando a Central mostrar **0.13.4**, abra **Importar Bases → RH / DP**, selecione essa planilha e mantenha a data da posição original. Confira os indicadores e o rodapé na prévia e confirme.

Reimportar é necessário para recuperar os valores que não foram guardados pela leitura anterior. A revisão 4 permite registrar o mesmo original corrigido, preservando o arquivo e as posições anteriores. A consulta utiliza uma posição atual e repetir a revisão corrigida não duplica pessoas ou totais. A publicação pelo Git não executa SQL ou atualiza a função no Supabase.

## Fórmulas e conferência

As colunas financeiras podem conter valores ou fórmulas com **resultado numérico salvo pelo Excel**. A Central usa o resultado salvo, sem executar a fórmula ou macros. Se faltar esse resultado, recalcule e salve a planilha no Excel antes de importar. Fórmulas em campos de texto, datas ou cabeçalhos continuam recusadas.

O rodapé pode ficar sem identificação ou usar TOTAL/TOTAIS/TOTAL GERAL na identificação. Deve ser a última linha preenchida e conter apenas totais financeiros. Cada total informado precisa ser igual à soma das pessoas na coluna correspondente, em centavos. Um total de coluna deixado em branco permanece ausente no rodapé, sem assumir zero. Diferenças bloqueiam a importação e indicam a coluna a conferir.

VT TOTAL, Adiantamento e Ajuda de Custo vazios nas linhas das pessoas valem zero quando as colunas existem, conforme confirmado pela operação. Colunas ausentes, remunerações ou datas vazias permanecem não informadas. O Total de cada pessoa vem da coluna Total; se ela faltar, o total correspondente permanece desconhecido. O salário sem descontos não é somado novamente ao Total informado.

A prévia, os cards e o Excel mantêm folha, salários e pró-labores separados. O Excel identifica Salário ou Pró-labore e os subtotais consideram somente as pessoas filtradas. Os arquivos originais, rodapés, posições e auditorias permanecem preservados. A Diretoria continua somente em consulta.

## Compatibilidade

Salário Folha, Salário da Folha e Salário Base são aceitos como remuneração sem descontos. Salário recebido e Salário Líquido são aceitos como remuneração recebida. O modelo anterior Salário Base + Salário e o formato com dois SALÁRIO continuam aceitos. Nomes explícitos têm prioridade; duas colunas explícitas para o mesmo campo são recusadas como ambíguas.
