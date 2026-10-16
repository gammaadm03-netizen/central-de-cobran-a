# Relatório da Diretoria — fórmula confirmada, sem M49

O usuário forneceu a coluna das descrições e retirou explicitamente M49 da fórmula. Esta orientação também substitui “imposto fixo” por “impostos do mês passado”. Nenhum número das capturas foi incorporado ao código ou ao banco.

A fórmula visível mais recente é:

```text
=((M12+M13+M14)-(M17+(M4*0,14)+M15+M16))/1000000
```

| Linha original | Indicador | Fonte nesta versão |
| --- | --- | --- |
| M2 | Faturamento mês, exceto COMLURB | Complemento diário da Gerência |
| M3 | Faturamento COMLURB | Complemento diário da Gerência |
| M4 | Faturamento geral | M2 + M3; exige os dois valores |
| M5 | Valor de pedido em sistema | Complemento diário da Gerência |
| M6 | Valor de pedidos bloqueados | Complemento diário da Gerência |
| M7 | Valor total pendência | Complemento diário da Gerência |
| M8 | Contas a receber total | Carteira ativa de CR |
| M9 | Contas a receber atrasado | Carteira ativa vencida |
| M10 | Atrasado COMLURB | Complemento conferido; limitado ao atraso central de CR |
| M11 | Percentual em atraso | Atrasado ÷ carteira; sem denominador, fica pendente |
| M12 | Valor total caixa | Soma das 17 contas e caixas; ausência mantém total pendente |
| M13 | Total contas a receber | Mesmo total de M8; repetido somente na apresentação |
| M14 | Valor total estoque | Posição manual vigente, com data e origem |
| M15 | Total pagamento mercadoria | CP: todos os títulos NEW/OPEN da macro COMPRA DE MERCADORIA |
| M16 | Parcelamentos | Complemento diário da Gerência |
| M17 | Impostos do mês passado | Complemento do mês anterior à referência |
| M18 | Ativo circulante | Fórmula acima, resultado em milhões |
| M20–M36 | Contas e caixas | As 17 posições na ordem da imagem |
| M37 | Total caixa / bancos | Mesmo consolidado de M12; sem duplicação no cálculo |

Os complementos manuais são entradas oficiais auditadas enquanto as importações de Fechamento/Faturamento e Pedidos não estiverem implantadas. Não representam uma integração automática desses módulos. Não classificam clientes por nome nem presumem que um órgão seja COMLURB. Mercadoria depende da macro aprovada na importação completa de CP; títulos quitados não entram.

O cálculo ocorre no PostgreSQL com `numeric`: centavos, dedução de `14/100` sem arredondar frações de centavo e divisão por `100.000.000` para obter milhões de reais. O resultado trafega como string decimal exata. Cada um dos sete componentes é obrigatório; ausência não significa zero. O ativo pode estar calculado e o relatório continuar parcial se faltar outro indicador, como pedidos.

O Resumo é uma posição de hoje em America/Sao_Paulo, com faturamento do mês atual. Hoje/Semana/Mês selecionam o fluxo por vencimento; não apresentam o caixa atual como histórico. Complementos são lidos na data exata, sem carregar ontem silenciosamente. Estoque e saldos conservam suas datas visíveis.

Snapshots novos preservam valores, contas, complementos e versão da fórmula; antigos não são recalculados. O Excel mantém a aba detalhada existente e acrescenta Posição diária, na sequência da imagem, e Memória do cálculo. Datas, moedas e percentuais são tipos nativos; valores que excedem os 15 algarismos de precisão do Excel interrompem a exportação com explicação.

Ativação: [ativacao-resumo-diretoria.md](ativacao-resumo-diretoria.md).
