# Custos por item e recálculo do fechamento — 0.17.0

Em **Importar Bases → Custos**, importe o catálogo de produtos e aplique a versão escolhida a um mês de fechamento já disponível. O custo identifica o produto pelo **código exato**, inclusive zeros iniciais. Nome e peso são informações do cadastro; o nome não é usado para adivinhar códigos e o peso não substitui a quantidade vendida.

## Ativação no Supabase existente

1. Copie e execute o [SQL completo de Custos e fechamento](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-custos-fechamento.sql) em **Supabase → SQL Editor → New query → Run**. O arquivo instala as atualizações **044/045** sobre a base comercial **032**, com as permissões existentes. Essa ativação não importa uma planilha nem recalcula um mês.
2. Abra **Edge Functions → business-import → Code → index.ts**. Substitua todo o conteúdo pelo [código completo atualizado](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/business-import.ts) e clique em **Deploy updates**. Use a função `business-import` já existente; este TypeScript pertence ao editor da função, separado do SQL do primeiro passo.
3. Confira **Versão 0.17.0** no rodapé da Central e atualize a página antes de importar. Publicar código no Git não executa o SQL nem atualiza automaticamente a função no Supabase.

As atualizações de Contas a Pagar e Contas a Receber são independentes. Não é necessário criar outra Edge Function, configurar novas chaves ou alterar as permissões dos usuários de CP, CR e RH.

## Importar o catálogo

1. Abra **Importar Bases → Custos** e informe a **Data de referência dos custos**.
2. Selecione a planilha em **Planilha de custos por item** e clique em **Analisar custos**.
3. Confira produtos distintos, linhas repetidas, custos zerados, valores não informados e a amostra. Os cabeçalhos aceitos incluem **Produto: código**, **Produto: nome**, **peso** e **custo atual**.
4. Quando o mesmo código trouxer custos diferentes, escolha a linha correta em **Custo para o código…** e clique em **Validar escolhas dos custos**. Cada escolha é vinculada à linha original. Um valor divergente não é escolhido pela ordem do arquivo.
5. Marque **Conferi os custos, os valores zerados e as escolhas dos códigos repetidos** e clique em **Confirmar importação dos custos**.

São aceitos `.xlsx`, `.xlsm` e `.csv` UTF-8, com uma aba preenchida, até 2 MiB e 5.000 linhas. Fórmulas são recusadas; macros não são executadas. As linhas originais e a planilha são preservadas com hash, autor e data. Repetições idênticas são consolidadas no catálogo e mantidas na fonte histórica.

O custo unitário conserva até **seis casas decimais**. Não se arredonda o preço unitário para centavos antes de multiplicá-lo pela quantidade. Célula de custo vazia permanece **Não informado**, e zero explícito permanece zero no cadastro. A soma de preços unitários de produtos diferentes não representa o custo do fechamento e não é apresentada como total financeiro.

Em **Custos cadastrados e histórico**, escolha a versão e pesquise pelo código ou produto. A posição mais recente considera a data de referência; importar uma posição antiga não a transforma silenciosamente na posição atual. O seletor mostra as versões recentes e permite consultar uma importação preservada.

## Substituir o CMV e recalcular as margens

Depois de importar ou selecionar o catálogo:

1. Em **Aplicar custos ao fechamento**, escolha o **Mês do fechamento para aplicar custos**. Esse mês precisa ter sido importado em **Fechamento / Faturamento**.
2. Clique em **Analisar impacto dos custos**. Confira o CMV atual e o novo CMV, a margem atual e a margem recalculada, além das linhas do fechamento.
3. Resolva os impedimentos apresentados. Código ausente ou sem correspondência, quantidade ausente ou inválida, custo ausente ou zerado e componentes da margem não informados bloqueiam a aplicação. Não se presume quantidade igual a um, custo zero conhecido ou produto equivalente pelo nome.
4. Marque a confirmação do impacto e clique em **Aplicar custos e recalcular margens**.

O cálculo é:

```text
Novo CMV da linha = custo unitário escolhido × quantidade da linha
Nova margem da linha = venda − novo CMV − frete − imposto − comissão do fechamento
```

O produto é calculado com decimais exatos. Só o **CMV total de cada linha** é arredondado para centavos, com meio centavo afastado de zero. Os totais somam os resultados das linhas. Quantidades negativas de devoluções mantêm o sinal; peso não participa desse cálculo. A aplicação mantém venda, quantidade, frete, imposto e comissão informados no fechamento. Ela não altera as regras de comissão.

A confirmação cria uma **nova versão mensal** com os novos valores, disponível em Faturamento e Margens. O fechamento anterior, seus itens, a planilha original e a base de custos permanecem preservados. O novo arquivo de origem é um manifesto JSON identificado como recálculo, que registra as fontes e a política usada; ele não é apresentado como outra planilha exportada do ERP.

As consultas atuais de comissão sobre vendas passam a ler a nova versão comercial pelo fluxo já existente. Apurações de comissão já salvas permanecem imutáveis. Para publicar uma apuração diferente, use a conferência e o fluxo próprios de Comissões.

## Confirmação pendente ou base alterada

Se uma confirmação não retornar, mantenha a tela aberta e use **Repetir confirmação pendente dos custos** ou **Repetir aplicação pendente**. O envio conserva os mesmos dados, escolhas e, na aplicação, o mesmo protocolo. Não altere o mês ou a base para tentar contornar uma confirmação incerta.

O servidor reconhece uma tentativa concluída sem duplicar o resultado. A aplicação exige a versão do fechamento conferida na prévia; uma alteração concorrente pede nova análise. O arquivo e o protocolo pendentes ficam na memória da tela: sair ou recarregar pode perder o rascunho, mas as operações já confirmadas permanecem no banco. Se perder a tela pendente, confira o histórico antes de iniciar outra operação.

O acesso de importação continua condicionado às permissões de Custos, Margens e Importar Bases; aplicar ao mês também exige as permissões de fechamento. Diretoria permanece em consulta, e os limites individuais de acesso continuam sendo aplicados no servidor.
