# Acesso individual às nove bases de importação — 0.17.1

Esta configuração libera todas as áreas de **Importar Bases** para uma conta específica do perfil **Contas a Receber**: Contas a Pagar, Contas a Receber, Contatos e descrições, Caixa / Bancos, Estoque, Resumo da Diretoria, Fechamento / Faturamento, RH / DP e Custos.

O perfil permanece Contas a Receber. A concessão não promove a pessoa a Gerência Geral, não altera outros usuários e não concede administração, configurações, backups ou regras de comissão. As permissões operacionais de leitura, escrita e importação exigidas pelas bases são liberadas para essa conta; os módulos correspondentes podem aparecer na navegação pelas mesmas permissões. A concessão inclui consulta dos dados financeiros e de RH necessários à conferência.

## Instalar e configurar

1. Execute o [SQL de acesso individual às importações](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-acesso-importacoes-usuario.sql) em **Supabase → SQL Editor → New query → Run**. O arquivo instala a atualização 046 e preserva os limites individuais da 039. Nenhuma conta é habilitada por padrão.
2. Ainda no **SQL Editor**, execute a chamada com o nome de login da conta desejada:

```sql
SELECT cf_private.set_user_import_access(
  'LOGIN_DA_CONTA', true,
  'Acesso autorizado a todas as bases de importação'
);
```

3. Confira o login, identificador, perfil `contas_receber` e `enabled: true` na resposta.
4. A pessoa deve sair da Central e entrar novamente. Confira o site **0.17.1** e as nove opções em **Importar Bases**.

Esse arquivo é SQL e deve ser executado no SQL Editor. Não há atualização de Edge Function nesta entrega. As tabelas e funções próprias de cada módulo precisam estar previamente ativadas; conceder acesso não instala Custos 044/045 ou RH/DP.

O nome é resolvido no projeto atual sem diferenciar maiúsculas e minúsculas. Login ausente, ambíguo, desativado ou de outro perfil é recusado. A configuração não cria usuário Auth nem altera senha. A conta precisa continuar ativa e ter sessão aprovada em cada operação.

## Revogar

O proprietário SQL pode remover a concessão sem excluir a conta ou modificar suas permissões normais de Contas a Receber:

```sql
SELECT cf_private.set_user_import_access(
  'LOGIN_DA_CONTA', false,
  'Revogação do acesso individual às demais bases de importação'
);
```

As configurações ficam em tabela privada e auditada. O configurador é exclusivo do proprietário SQL. A atualização mantém a Diretoria em consulta e os limites de Contas a Pagar. O banco verifica a concessão atual a cada operação; uma interface antiga não concede acesso após a revogação.

## Conferência

Confira as nove áreas e os formulários de Estoque e Resumo da Diretoria. Administração de Usuários e Configurações permanecem indisponíveis. Outra conta comum de Contas a Receber mantém suas áreas originais, e o usuário limitado de CP continua com sua única importação autorizada.

Publicar o código não executa SQL ou ativa uma concessão no Supabase remoto. A instalação e a chamada para a conta real são etapas do proprietário do projeto.
