# Contas a Pagar: data efetiva de quitação — 0.18.6

Em **Importar Bases → Contas a Pagar → Pagamentos realizados**, a coluna **Quitação: data do pagamento** informa a data efetiva. Ela tem prioridade sobre **Vencimento: data**. O vencimento original da previsão permanece preservado no histórico e não é substituído pela data de pagamento.

Nos relatórios antigos que não contêm uma coluna explícita de pagamento, o sistema mantém a leitura de Vencimento como data efetiva, conforme o modelo de relatório já confirmado. Quando a coluna Quitação existe mas está vazia ou inválida, a importação aponta essa linha para correção; não utiliza o vencimento para preencher a lacuna.

## Conferir e importar

1. Acesse **Importar Bases → Contas a Pagar → Pagamentos realizados**.
2. Selecione o relatório e confirme que ele contém os pagamentos efetivos do período.
3. Clique em **Analisar pagamentos** ou **Reanalisar mesmo arquivo**. Quando houver problema, confira a linha física e a coluna na tabela **Problemas dos pagamentos**.
4. Confira os bancos, a correspondência dos títulos e a classificação dos planos. Os marcadores de **R$ 0,01** continuam exigindo confirmação individual de baixa sem pagamento.
5. Reanalise após alterar escolhas e conclua quando todas as pendências estiverem resolvidas.

A validação de data considera o dia de **America/Sao_Paulo**, no servidor. Uma data de pagamento posterior ao dia atual permanece no arquivo, mas bloqueia a importação desse relatório de pagamentos realizados. A análise não altera datas, não troca a data por hoje e não importa apenas parte das linhas automaticamente. A identificação da linha permite conferir a origem ou preparar separadamente os registros que já podem ser importados.

O arquivo integral e seu hash são preservados. O servidor refaz a leitura dos mesmos bytes, sem aceitar datas ou valores substitutos enviados pelo navegador. Uma recusa por dados inválidos informa as linhas e não é tratada como confirmação pendente de uma gravação. Pagamentos, previsões, baixas e comissões existentes permanecem protegidos pelas regras atuais.

A regra de leitura acompanha cada novo envio, preservando a interpretação de confirmações antigas que ainda estejam pendentes durante a atualização. Se um arquivo já tiver sido importado com outra leitura de datas, a repetição do mesmo hash não é apresentada como uma correção concluída: a tela solicita conferir o histórico, sem duplicar os pagamentos. A correção de um registro anterior deve seguir o fluxo auditado de revisão; reenviar o arquivo original não altera automaticamente uma importação já registrada.

## Ativação

Esta correção não exige SQL novo. Reutiliza a conciliação 042/043 já instalada.

1. Abra o [código completo de payables-import](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/payables-import.ts) e copie tudo com **Ctrl+A → Ctrl+C**.
2. Em **Supabase → Edge Functions → payables-import → Code**, substitua todo o conteúdo de **index.ts** e clique em **Deploy updates**. Atualize a função existente com esse nome; o arquivo é TypeScript.
3. Recarregue a Central até a versão **0.18.6** e analise o relatório novamente.

Publicar o código do site não atualiza a função no Supabase nem importa as bases reais. As cópias e conferências de arquivos reais não fazem parte do repositório público.
