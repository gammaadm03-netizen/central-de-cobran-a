# Mapeamento do relatório da Diretoria — pendente de identificação das linhas

O usuário solicitou que o Painel Gerencial apresente todas as informações do Excel diário enviado à Diretoria. A captura recebida mostra datas e valores, mas não a coluna com os nomes dos indicadores. Nenhum valor da captura deve ser incorporado como dado inicial.

A fórmula visível mais recente é:

```text
=((M12+M13+M14+M49)-(M17+(M4*0,14)+M15+M16))/1000000
```

É necessário identificar os indicadores correspondentes a **M4, M12, M13, M14, M15, M16, M17 e M49** e as demais descrições das linhas para montar o relatório completo. Foi solicitada essa identificação ao usuário. O Excel original com as descrições é a fonte mais direta para concluir o mapeamento.

O código legado V75 não contém essa fórmula ou um exportador com coluna M. Seu resumo usa três parcelas positivas — Caixa, Recebíveis e Estoque — enquanto a fórmula da imagem tem quatro referências positivas. Não se pode presumir que M49 represente caixas adicionais, outro ativo ou um subtotal já incluído no caixa. Uma interpretação indevida poderia contar o mesmo valor duas vezes.

A regra financeira anterior expressamente informada pelo usuário era:

```text
(Caixa total + A Receber total + Estoque total
 − Imposto fixo − Faturamento geral × 0,14
 − Pagamento de mercadoria − Parcelamentos) ÷ 1.000.000
```

A orientação mais recente prevalece quando suas referências forem identificadas. Até lá, nenhum cálculo novo foi ativado nem rótulo/indicador inventado. O Ativo Circulante permanece pendente no Painel quando faltam suas fontes ou parâmetros. O estoque manual acrescentado nesta versão alimenta a base central e o indicador de estoque existente, sem modificar as demais regras financeiras.

Para concluir após receber o arquivo/descrições: mapear cada linha para sua fonte oficial, confirmar o tratamento das 17 posições de bancos/caixas, preservar o alerta de estoque ausente e a origem/data de cada indicador, implementar o cálculo exato sem arredondamento intermediário e validar totais com o relatório original. Alterações devem gerar novos snapshots, sem recalcular posições históricas.
