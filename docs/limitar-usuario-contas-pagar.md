# Somente Painel, Contas a Pagar e Importar Bases

O perfil padrão Contas a Pagar também permite consultar Caixa/Bancos. A atualização 039 acrescenta um limite individual para retirar os recursos extras de uma pessoa sem modificar a matriz compartilhada de permissões dos demais usuários.

O limite padronizado mantém somente as abas **Painel Gerencial**, **Contas a Pagar** e **Importar Bases**. Dentro da importação aparece somente **Contas a Pagar**. A pessoa continua podendo consultar, alterar, importar e exportar CP. Não recebe funções administrativas nem acesso às outras bases. O Painel conserva os números consolidados permitidos, sem disponibilizar o detalhamento de Caixa/Bancos. O cadastro de contas necessário para registrar pagamentos em CP permanece disponível, sem liberar saldos bancários.

## Vincular a conta já criada

Na Central, entre como Gerência Geral e abra **Administração → Usuários → Vincular conta existente**. Informe o User UID da conta criada no Supabase, o login e o nome escolhidos. Selecione **Perfil: Contas a Pagar** e salve. Se o perfil já estiver vinculado, use **Editar** para conferir a função.

Para uma conta nova, é possível deixá-la **Bloqueada** até concluir o limite, ativando-a depois. O comando de restrição não habilita, cria ou modifica a conta de autenticação e não altera sua senha.

## Ativar os limites no projeto existente

1. Abra o [SQL completo de ativação](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/ativar-limites-usuarios.sql), clique em **Raw** e copie todo o arquivo.
2. No Supabase, abra **SQL Editor → New query**, cole o conteúdo e execute **Run**.
3. A ativação exige identidade com sessões aprovadas, base financeira e Diretoria 031 já instaladas. Se a mensagem indicar falta da 031, execute primeiro o [ativador da Diretoria](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/ativar-acesso-diretoria.sql) e repita a ativação 039. Esse ativador já preserva limites instalados.

Executar a ativação instala a estrutura; ainda não restringe nenhuma pessoa. Nenhuma migration publicada anterior foi alterada. Não há nova Edge Function ou atualização de função existente para esta configuração. A interface atual já usa as permissões efetivas devolvidas pelo banco; não precisa de uma versão nova do site.

## Restringir uma pessoa

No mesmo **SQL Editor**, execute o comando abaixo trocando o marcador pelo User UID completo:

```sql
SELECT cf_private.restrict_payables_user(
  'COLE_AQUI_O_USER_UID'::uuid
);
```

O resultado informa `user_id` e `allowed_resources`. Entre os recursos aparece `mensagens_cp`, que pertence ao quadro de mensagens dentro de Contas a Pagar e não cria outra aba. O comando exige perfil CP previamente vinculado, preserva seu status ativo/bloqueado e não muda a matriz global. Pode ser repetido sem duplicar configuração ou auditoria quando o limite já for o mesmo.

Se a conta estava bloqueada para configuração, ative-a agora em **Administração → Usuários**. Depois peça à pessoa que saia e entre novamente. O banco já bloqueia os recursos retirados nas consultas, mas uma sessão aberta pode manter o menu antigo até atualizar seu acesso. Confira três botões no menu e somente CP dentro de Importar Bases.

## Conferir ou retirar o limite

Somente o operador do SQL Editor pode configurar esses limites nesta primeira versão. Para consultar:

```sql
SELECT p.id, p.username, p.role_key, p.enabled,
       l.allowed_resources, l.reason
FROM public.profiles p
JOIN cf_private.user_access_limits l ON l.user_id = p.id
WHERE p.id = 'COLE_AQUI_O_USER_UID'::uuid;
```

Para voltar às permissões padrão do perfil CP, remova somente a linha dessa pessoa na tabela privada. Isso restaura também Caixa/Bancos, previsto no perfil padrão. Uma troca de perfil é bloqueada enquanto houver limite; o operador deve retirar explicitamente o limite antes de mudar a função. Não é necessário apagar o usuário, histórico ou dados financeiros.

A primeira versão dos limites foi validada para **Contas a Pagar**. Ela não oferece um configurador geral de funções e permissões na interface. Alterações são auditadas e não podem ser feitas pelo próprio usuário por chamadas à API.

O envio de código ao Git não executa o SQL no Supabase. O acesso só deve ser considerado configurado depois da execução do comando para a pessoa e da conferência do login real.
