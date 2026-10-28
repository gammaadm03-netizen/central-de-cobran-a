# Variação diária da inadimplência

No **Painel Gerencial → Resumo da Diretoria**, o quadro substitui o detalhamento de caixa por empresa e conta. Esse detalhamento continua em **Caixa / Bancos**.

O quadro começa comparando ontem e hoje. Para escolher outro período, informe **Data anterior** e **Data atual** e clique em **Comparar datas**. As datas são independentes do filtro de fluxo financeiro do painel. Há seis faixas de atraso: 1–30, 31–60, 61–90, 91–180, 181–365 e acima de 365 dias, além do total vencido.

## Origem dos valores

A consulta usa os títulos da base atual e a auditoria imutável já existente. Para um dia passado, considera a última revisão registrada antes da meia-noite seguinte, no horário de São Paulo. Hoje usa o estado atual da carteira e aparece como parcial. Títulos que vencem na própria data ainda não estão atrasados. Títulos validados ou retirados do relatório ficam fora da posição em que essa alteração foi registrada.

O histórico representa o que estava registrado na Central naquela data. Uma confirmação lançada hoje com data real de recebimento anterior não reescreve a posição histórica. As faixas também mudam pelo decurso dos dias; redução de uma faixa não prova recebimento ou migração por si só.

Dias anteriores à primeira importação, ou sem auditoria suficiente, aparecem como **Sem histórico**. Uma carteira importada sem títulos vencidos é uma posição válida de zero. Auditorias preservadas de títulos removidos em uma limpeza de testes não entram na base atual.

## Cálculo e leitura

- Variação em reais: saldo atual menos saldo anterior.
- Variação percentual: diferença dividida pelo saldo anterior, com duas casas decimais.
- Saldo anterior zero e saldo atual positivo: **Sem base anterior**, sem percentual inventado.
- Redução de pelo menos 30%: **Excelente**; de pelo menos 10%: **Muito positivo**; acima de 1%: **Positivo**.
- Entre −1% e +1%: **Estável**. Valores iguais: **Sem variação**.
- Aumento acima de 1%: **Atenção**. Novo saldo a partir de zero: **Novo saldo vencido**.

Os centavos e os percentuais usam aritmética inteira. A cor acompanha a leitura, que também é escrita por extenso.

## Ativação

1. No Supabase, abra **SQL Editor → New query**.
2. Copie o conteúdo completo de [ativar-variacao-diaria-inadimplencia.sql](../supabase/dashboard/ativar-variacao-diaria-inadimplencia.sql) e execute **Run**. Requer a atualização 047 já instalada. A execução repetida é segura.
3. Atualize a Central e abra o Painel Gerencial.

Não há atualização de Edge Function nesta mudança. O SQL cria a consulta e um índice de auditoria; não altera títulos, saldos, recebimentos ou permissões de perfil. A consulta exige acesso de leitura ao painel ou a Contas a Receber e devolve apenas totais por faixa.

## Validação local

`node scripts/test-receivables-delinquency-sql.mjs` executa o instalador duas vezes em PostgreSQL descartável e verifica datas, faixas, auditoria, precisão, isolamento da base atual e permissões. Os testes de navegador ficam em `tests/treasury-dashboard.spec.ts`; a matemática é verificada em `src/lib/delinquency-comparison.test.mjs`.
