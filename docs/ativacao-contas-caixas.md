# Contas bancárias e caixas das empresas — 0.4.1

A lista mais recente fornecida pelo usuário contém **17 posições: 12 contas bancárias e 5 caixas das empresas**. Esta lista substitui a quantidade de onze bancos da configuração inicial. As seis posições que faltavam são Cora Ecoplast e os caixas de Ecoplast, Limpe Fácil, Gamma, Fast Clean e Easy Clean.

## Atualizar o projeto já configurado

O usuário confirmou `Success. No rows returned` ao executar a atualização 008/009/010/011. Para acrescentar as contas, **não executar novamente esse arquivo nem as migrations anteriores**.

1. Abra o [script das contas e caixas](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/migrations/012_treasury_accounts.sql) e copie todo o conteúdo.
2. Abra o [SQL Editor do projeto atual](https://supabase.com/dashboard/project/sjimddcqgrsauzvffcol/sql/new), crie uma nova consulta, cole o código e clique em **Run** uma vez.
3. Aguarde o resultado `Success. No rows returned`. Se houver erro, preserve a mensagem para análise; não apague tabelas nem repita a instalação inicial.
4. Aguarde o deploy da Cloudflare terminar. Abra a Central no mesmo endereço, pressione **Ctrl + Shift + R**, entre e confira **Versão 0.4.1** no rodapé.
5. Abra **Importar Bases → Caixa / Bancos**. Confira as dezessete posições, informe a data e os saldos reais das novas contas/caixas, confira o total e salve a posição.

O script preserva IDs, saldos e históricos das onze contas anteriores, usuários, CP, CR, arquivos e posições já salvas da Diretoria. Acrescenta somente o cadastro das seis novas posições, sem preencher saldos automaticamente. Não redefine senhas e não exige uma nova Edge Function, Storage ou serviço pago.

Campos já salvos para a mesma data aparecem preenchidos. Os seis novos campos aguardam informação, inclusive quando o saldo real for zero: nesse caso, informe `0,00` expressamente. Posições de dias anteriores aparecem como referência e não são copiadas para o dia atual. O consolidado ficará pendente enquanto faltar saldo de qualquer conta/caixa ativo.

## Cadastro oficial informado

| Tipo | Posição |
| --- | --- |
| Banco | BRADESCO ECOPLAST |
| Banco | BRADESCO LIMPE FACIL |
| Banco | BRADESCO GAMMA IND |
| Banco | BRADESCO F2G |
| Banco | BRADESCO FAST CLEAN |
| Banco | BRADESCO EASY CLEAN |
| Banco | BANCO DO BRASIL FAST CLEAN |
| Banco | BANCO DO BRASIL EASY CLEAN |
| Banco | BANCO DO BRASIL ECOPLAST |
| Banco | BANCO CORA LIMPE FACIL |
| Banco | BANCO CORA MY CLEAN |
| Banco | BANCO CORA ECO PLAST |
| Caixa | CAIXA ECOPLAST |
| Caixa | CAIXA LIMPE FACIL |
| Caixa | CAIXA GAMMA |
| Caixa | CAIXA FAST CLEAN |
| Caixa | CAIXA EASY CLEAN |

As grafias de exibição seguem a lista. `ECO PLAST` continua ligado à empresa ECOPLAST e `GAMMA IND` à GAMMA, preservando a consolidação e os vínculos anteriores.

## Reflexo na operação

O preenchimento continua centralizado em **Importar Bases → Caixa / Bancos**. O mesmo cadastro e os mesmos saldos são consultados em **Caixa / Bancos** e no **Painel Gerencial**. Os subtotais de empresa e o Caixa Total incluem contas bancárias e caixas das empresas. Não há outra base paralela ou duplicação desses valores.

Contas/caixas com saldo negativo recebem alerta de cobertura no mesmo dia. O Painel mostra a quantidade e o valor necessário para cobrir os negativos; Caixa/Bancos permite identificar cada conta. O valor a cobrir soma os saldos negativos em módulo, sem compensá-los com contas positivas. Um total consolidado positivo não elimina a necessidade de cobertura de uma conta negativa. Quando a posição negativa vem de data anterior, a tela pede conferência/atualização hoje; uma consulta histórica identifica a data consultada. A ausência de saldo em outra conta não esconde os negativos já conhecidos. Não são feitas transferências automáticas.

Os quadros de contas recebem uma elevação discreta ao passar o cursor, com sombra e respeito à preferência de reduzir movimento.

A posição inteira é gravada em uma transação, com observação, confirmação e auditoria. Um envio contendo somente as onze contas antigas é recusado após a atualização para dezessete; nenhuma parte é salva. O Diretor continua em consulta e os demais perfis mantêm as permissões existentes. Extratos continuam sendo arquivos de apoio, sem alterar saldos automaticamente.

Executar localmente `npm run test:treasury-accounts-sql`, `npm run build` e os cenários de navegador de bancos/Painel. Os testes usam valores sintéticos e PostgreSQL local; não comprovam execução do script no Supabase ou conferência dos saldos reais.
