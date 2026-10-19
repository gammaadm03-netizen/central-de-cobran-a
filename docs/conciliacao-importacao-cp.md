# Conciliar na importação de Contas a Pagar — 0.16.0

A importação passa a distinguir um relatório completo de uma atualização com somente alguns títulos. Quando o arquivo é completo, a Central apresenta os títulos que deixaram de aparecer para que a responsável informe **Pago** ou **Somente baixado**. Os títulos identificados por **R$ 0,01** exigem confirmação individual de baixa sem pagamento. As escolhas são verificadas antes de concluir e aplicadas junto com o arquivo, em uma única confirmação final.

Uma ausência no relatório não comprova pagamento. Para registrar valor realizado, continuam obrigatórios a data, o valor e a conta efetivamente usados. A informação verbal de que um título foi pago, sem esses dados, não cria um pagamento na Central.

## Ativar no projeto existente

1. Abra o [SQL completo de conciliação de CP](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-conciliacao-importacao-contas-pagar.sql), copie todo o arquivo e execute em **Supabase → SQL Editor → New query → Run**. O combinado instala **042 e 043** sobre a base de Contas a Pagar até **021**, preservando as versões já instaladas. A atualização não importa arquivos nem baixa títulos por conta própria.
2. Abra **Supabase → Edge Functions → payables-import → Code → index.ts**. Use a função **payables-import já existente**.
3. Abra o [código completo atualizado de payables-import](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/payables-import.ts), copie o arquivo inteiro, substitua todo o conteúdo de `index.ts` e clique em **Deploy updates**. Esse arquivo TypeScript pertence ao editor da Edge Function; é separado do SQL executado no primeiro passo.
4. Aguarde o deploy do site e confira **Versão 0.16.0** no rodapé. Atualize a página se ainda estiver na versão anterior, antes de iniciar a importação.

Não há nova Edge Function. As atualizações de e-mail da Cobrança **040** e de desempenho de Contas a Receber **041** são independentes; não substituem 042/043 e não são requisitos desta entrega. Publicar código no Git não executa o SQL, não atualiza a função no Supabase e não comprova que o deploy remoto terminou.

## Escolher o tipo correto de relatório

Em **Importar Bases → Contas a Pagar → Previsões / novos títulos**, selecione uma das opções antes de analisar:

- **Relatório completo de títulos em aberto:** o arquivo contém todos os títulos em aberto da mesma origem. A Central também apresenta os títulos existentes que estão ausentes dessa relação e exige uma escolha para cada caso.
- **Somente novos títulos e atualizações:** o arquivo inclui apenas inclusões ou alterações. Atualiza os lançamentos presentes e preserva os ausentes, sem presumir pagamento ou baixa.

A escolha depende do conteúdo exportado, não do dia da semana. Um arquivo filtrado por período, fornecedor ou parte das empresas não representa automaticamente o relatório completo do grupo. Use a opção de inclusões e atualizações quando a exportação não cobrir toda a origem.

Filial e número do lançamento identificam o título. Alterações de valor, vencimento ou banco atualizam o mesmo lançamento quando sua identidade está resolvida. O número do cheque continua separado e mantém os zeros iniciais.

## Conferir e concluir a importação

1. Selecione o tipo de relatório, o arquivo e a confirmação de conferência exigida pela tela. Clique em **Analisar arquivo**.
2. Confira os lançamentos e a classificação dos planos por Centro de Custo Macro. Na seção **Conciliação antes de importar**, resolva os casos indicados.
3. Para cada título ausente do relatório completo, escolha **Pago — informar pagamento efetivo** ou **Somente baixado — sem pagamento**, conforme a situação real e as opções permitidas para aquele título.
4. Para cada título de **R$ 0,01**, marque sua confirmação individual de baixa sem pagamento. Não existe uma confirmação geral para todos os títulos de um centavo.
5. Após preencher ou alterar qualquer escolha, clique em **Validar escolhas da importação**. A conferência anterior fica identificada como anterior até a nova análise terminar. Corrija os impedimentos apresentados antes de continuar.
6. Clique em **Importar e conciliar títulos**, revise o resumo da confirmação e conclua. O arquivo, os pagamentos informados, as baixas administrativas, as reaberturas e os respectivos registros de histórico são aplicados na mesma transação.

Para **Pago**, informe **Data efetiva**, **Valor efetivamente pago** e a **Conta que realizou o pagamento**, entre as contas oficiais apresentadas. A data não é preenchida a partir do vencimento e o banco previsto não substitui a conta efetiva. O valor precisa quitar integralmente a pendência permitida pelo título. O pagamento confirmado entra no realizado por sua data e Macro e registra a conciliação do título na mesma operação.

Para **Somente baixado**, não são criados pagamento, data de quitação, banco utilizado ou valor realizado. A escolha registra uma baixa administrativa com responsável e motivo. Se houver pagamento ativo ou outra condição que impeça a baixa, a análise mantém o bloqueio e explica o caso; confira o histórico antes de alterar qualquer registro financeiro.

## O que acontece com os títulos de R$ 0,01

Cada ocorrência indicada no arquivo precisa ser confirmada separadamente. A confirmação retira o título dos valores financeiros e preserva seu valor original e histórico; não registra um pagamento de um centavo. Se a baixa já estiver registrada, a tela informa essa situação e preserva o vínculo existente.

O mesmo cuidado vale em **Pagamentos realizados**: os casos de um centavo passam pela conferência individual, em vez de serem convertidos automaticamente em pagamento. Analise por **Analisar pagamentos** e confira cada escolha. Depois de alterar as escolhas, use **Reanalisar mesmo arquivo** antes de concluir por **Concluir importação dos pagamentos**.

Se um título de R$ 0,01 do arquivo de pagamentos ainda não tiver previsão na Central, importe primeiro a previsão para conservar seu valor e vencimento originais. A análise mantém esse caso bloqueado até existir a previsão.

Não há uma exclusão global de todo valor de um centavo. Um pagamento real já registrado permanece no histórico e no realizado até eventual estorno explícito e justificado. A confirmação de uma nova baixa administrativa não apaga ou estorna esse pagamento.

## Consultar os valores e o histórico depois

O título baixado administrativamente aparece como **BAIXADO SEM PAGAMENTO**, com data, motivo e responsável da baixa. Seu valor original continua disponível para auditoria, mas ele não participa do previsto, saldo em aberto, resumo por Macro, indicadores da Diretoria ou totais do Excel. Ele não recebe o status de pago ou conciliado por essa baixa.

O detalhamento e o Excel preservam o registro original e identificam a exclusão. A coluna **Valor considerado nos totais** mostra zero para a baixa administrativa. Use essa coluna para somar os valores elegíveis do detalhamento; a coluna do valor original permanece como informação histórica. Consultar o título e o histórico continua permitido; registrar pagamento, corrigir ou conciliar diretamente um título com baixa administrativa ativa fica bloqueado.

Se o título reaparecer depois com valor real, a nova análise exige a escolha explícita **Reabrir previsão**, quando permitida. A reabertura preserva o evento de baixa e registra sua reversão; o título volta à previsão e à conferência normal. Ele não é reaberto silenciosamente por uma alteração do arquivo.

A reabertura é feita em **Previsões / novos títulos**. Um pagamento com valor real para um título ainda baixado administrativamente permanece bloqueado em **Pagamentos realizados** até essa reabertura explícita.

O previsto nominal inclui os títulos pagos elegíveis como parte do planejamento original. Registrar um pagamento reduz o saldo em aberto e aumenta o realizado; não retira automaticamente o título do previsto nominal. A baixa administrativa tem outro efeito: exclui o título dos valores financeiros sem gerar realizado.

## Se a resposta da confirmação não chegar

O aviso **A confirmação está pendente** mantém congelados o mesmo arquivo, o tipo de relatório, as escolhas e o protocolo daquela tentativa. Mantenha essa tela aberta e use **Repetir confirmação pendente** para conferir o mesmo envio. Não crie uma nova importação ou altere o arquivo para tentar contornar a incerteza.

O servidor reconhece a repetição do mesmo protocolo e devolve o resultado já registrado sem duplicar pagamentos ou baixas. Se alguma validação impedir a operação, a transação não aplica parcialmente o arquivo ou suas escolhas. Uma resposta interrompida, porém, não comprova falha da transação: confira o histórico e o resultado da confirmação antes de iniciar outra operação.

Arquivo, escolhas e confirmação pendente ficam na memória da tela; recarregar, sair ou fechar a página perde esse rascunho local. Os títulos, pagamentos, baixas e importações já confirmados permanecem no banco. Depois de perder uma tela pendente, confira o histórico antes de importar novamente.

## Conferência da ativação

A publicação do código disponibiliza o fluxo, mas não concilia automaticamente arquivos antigos ou os títulos já existentes. A responsável precisa analisar a base real, escolher as situações corretas e confirmar a importação. Os testes locais usam dados sintéticos e não comprovam aplicação do SQL, publicação da função ou conclusão de uma importação de produção.
