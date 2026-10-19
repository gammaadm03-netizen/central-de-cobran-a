# Acesso da Diretoria somente para consulta — 0.12.2

O perfil **Diretor** consulta todas as abas, incluindo usuários, cobradoras e auditoria da Administração. **Importar Bases** fica indisponível. A Diretoria pode filtrar, consultar e exportar relatórios; não pode cadastrar, editar, excluir, importar, validar pagamentos, conciliar, iniciar atendimentos ou enviar/alterar mensagens.

## 1. Ativar as permissões no banco existente

No Supabase, abrir **SQL Editor → New query** e executar o conteúdo completo de [ativar-acesso-diretoria.sql](../supabase/dashboard/ativar-acesso-diretoria.sql).

O ativador atual preserva os limites individuais caso a atualização 039 já esteja instalada; nesse caso não reaplica a definição anterior de permissões.

Essa atualização é separada da ativação de recebíveis. Aplica somente a **031**, preservando as migrations e os dados anteriores. Ajusta as permissões do perfil Diretor, inclusive a antiga autorização para mensagens e a visualização de Importar Bases. Acrescenta consulta administrativa sem conceder funções de administração. O bloqueio de escrita é aplicado no banco e também no site.

**“Success. No rows returned”** confirma a execução do SQL. O SQL não cria uma conta de autenticação, não define senha e não envia email. Não repetir a instalação inicial, nem apagar usuários ou tabelas. As funções Edge existentes continuam sendo utilizadas.

## 2. Criar a conta de autenticação

Como a conta ainda não existe, abrir **Authentication → Users → Add user → Create user** no projeto Supabase.

1. Informar um email válido, disponível para a Diretoria e diferente do utilizado pela conta da Gerência. Esse email vincula a autenticação, mesmo que o login da Central utilize um nome de usuário.
2. Digitar a senha escolhida diretamente nesse painel. Não colocar a senha em SQL, arquivos do projeto, comentários ou commits.
3. Usar a confirmação automática do email, quando essa opção estiver disponível, para criar o acesso sem depender de convite. Se o provedor recusar a senha ou o email, conferir a mensagem no próprio painel antes de tentar entrar.
4. Criar a conta e copiar seu **User UID** completo. O identificador não é uma senha ou chave administrativa.

Se a conta já tiver sido criada, utilizar a existente. Não criar uma segunda conta nem redefinir a senha de outro usuário para contornar uma duplicidade de email.

## 3. Vincular o login na Central

Após o deploy, conferir **Versão 0.12.2** no rodapé da Central, atualizar com **Ctrl + Shift + R** se necessário e entrar como Gerência Geral.

Abrir **Administração → Usuários → Vincular conta existente** e preencher:

| Campo | Informação |
| --- | --- |
| User UID da conta existente | Identificador copiado em Authentication |
| Usuário | Login escolhido para o acesso da Diretoria |
| Nome | Diretoria |
| Perfil | Diretor |
| Status | Ativo |

Clicar em **Revisar e salvar**, conferir e confirmar o cadastro. A senha não é informada nessa tela: ela foi definida no Authentication.

## 4. Conferir o acesso

Sair da conta da Gerência e entrar com o login da Diretoria e a senha cadastrada. Conferir as abas financeiras, Cobrança, Comissões, Faturamento, Margens, RH/DP e a Administração em consulta. Os módulos ainda em preparação continuam mostrando essa condição; a permissão de consulta não implementa funcionalidades pendentes.

Importar Bases não aparece. Mensagens existentes podem ser lidas, mas os controles para enviar, concluir ou reabrir mensagens ficam indisponíveis. Na Administração, usuários, cobradoras e auditoria podem ser consultados, sem formulários de alteração ou vínculo. As permissões de Gerência continuam separadas.

Se a conta Auth existe, mas ainda não recebeu perfil ativo na Central, o login continuará indisponível. Publicar o código ou executar a 031 não cria esse vínculo automaticamente. A criação remota só deve ser considerada concluída após criar a conta, salvar o perfil e conferir o acesso real.
