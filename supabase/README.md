# Banco e autenticação da Central Financeira

Os arquivos neste diretório são código e schema, sem usuários reais, senhas, UUIDs administrativos ou bases financeiras.

## Estado e ordem de aplicação

1. `migrations/001_identidade_rbac.sql`: schema original de perfis, RBAC, vínculos, mensagens e auditoria. **Se já foi executado neste projeto, não executar novamente.** A migration não é um reset e não contém comandos para remover tabelas.
2. Provisionar o administrador no Supabase Authentication e vincular seu UUID a `public.profiles` pelo procedimento inicial já revisado. Nunca salvar senhas em SQL ou Git. Esse bootstrap não é repetido em deploys.
3. Revisar e executar `migrations/003_auth_gateway.sql` uma vez pelo SQL Editor, em uma nova consulta. Ela é incremental, preserva os registros existentes e não cria contas Auth. Após aplicá-la, sessões precisam ter `session_id` no JWT emitido pelo Supabase Auth e aprovação pelo gateway. Uma sessão criada diretamente no Auth não dá acesso aos dados da aplicação.
4. Revisar e executar `migrations/004_password_recovery.sql` uma vez, após 001 e 003. Ela acrescenta conclusão auditada de pedidos de recuperação e troca de senha com limitação e revogação das sessões. Não altera `auth.users`, senhas, dados financeiros nem os perfis existentes. Depois atualizar a função com o código completo de `dashboard/auth-gateway.ts` gerado nesta versão.

Em projetos já configurados manualmente, registrar as migrations aplicadas antes de usar `supabase db push`. Não rodar o histórico inteiro contra um banco existente sem conferir o histórico. Não executar `db reset` em um projeto com dados.

## Publicar o gateway

O frontend sozinho não faz login por usuário. É necessário publicar a Edge Function `auth-gateway` deste diretório. Nenhum deploy remoto é feito pelos testes locais.

Pelo painel do Supabase:

1. Abra **Edge Functions** e crie `auth-gateway`. Para o editor do painel, copie o conteúdo completo de `dashboard/auth-gateway.ts` para o arquivo `index.ts` da função. Esse arquivo único é gerado por `npm run bundle:gateway`, não contém credenciais e dispensa adicionar arquivos auxiliares. Como alternativa, adicione `index.ts` e `handler.mjs` do diretório `functions/auth-gateway`, preservando nomes e importação relativa.
2. Desative **Verify JWT / Enforce JWT verification** para esta função de login. A configuração equivalente está em `config.toml`. O login ainda não tem JWT; o logout valida o Bearer token diretamente no Supabase Auth.
3. Em **Edge Functions → Secrets**, configure `ALLOWED_ORIGINS` com as origens HTTPS exatas do site, separadas por vírgula e sem barra final. Exemplo ilustrativo: `https://central-financeira.pages.dev`. Substitua pelo endereço realmente publicado. Domínios de preview não são aceitos automaticamente.
4. Publique a função. O nome deve permanecer `auth-gateway`.

Alternativamente, usando o CLI oficial autenticado localmente:

```sh
supabase functions deploy auth-gateway --project-ref SEU_PROJECT_REF --no-verify-jwt
```

O runtime Supabase fornece automaticamente `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY`. A chave de serviço nunca vai para o frontend, repositório ou conversa. Se alguma dessas variáveis não estiver disponível, a função responde 503 e exige correção da configuração no painel. Nenhuma credencial deve ser colada em chat ou na linha de comando.

Para desenvolvimento local, origens permitidas podem incluir `http://127.0.0.1:5173,http://localhost:5173`. Remova-as da configuração de produção quando desnecessárias. Sem `ALLOWED_ORIGINS`, a função falha de forma fechada. Não use `*`.

## Contrato HTTP

`POST https://SEU_PROJECT_REF.supabase.co/functions/v1/auth-gateway`

Cabeçalhos de entrada: `Origin` autorizado e `Content-Type: application/json`. O SDK também pode enviar a chave pública em `apikey`.

Login:

```json
{"action":"sign_in","username":"usuario","password":"senha digitada pelo próprio usuário"}
```

Resposta 200:

```json
{
  "session": {
    "access_token": "JWT",
    "refresh_token": "token de renovação",
    "expires_in": 3600,
    "expires_at": 1800000000,
    "token_type": "bearer"
  },
  "access": {
    "profile": {"id":"UUID","username":"usuario","role_key":"perfil oficial","enabled":true},
    "permissions": [{"resource":"recurso","action":"read"}],
    "collector_id": null
  }
}
```

O perfil retornado vem do banco oficial. O cliente não fornece perfil, email ou UUID para realizar login. Em `profile`, os campos completos do schema001 também são retornados. O valor de `collector_id` depende do vínculo administrativo, sem associação presumida entre login e pessoa.

Logout: mesmo endpoint com `Authorization: Bearer JWT` e `{"action":"sign_out"}`. A função valida o token no Auth, revoga o `session_id` nas regras da aplicação, grava `LOGOUT` e encerra a sessão no Auth. O frontend deve descartar seus tokens e dados em memória mesmo quando a rede falha e deve informar quando a revogação remota não puder ser confirmada.

Erros: `400` entrada inválida; `401` credencial/sessão inválida; `403` origem inválida; `405` método inválido; `429` limite de tentativas com `Retry-After`; `503` configuração ou serviço indisponível. Nenhuma resposta contém detalhes SQL ou erros internos do Auth. Não há redirecionamento nem cookies da aplicação.

## Recuperar senha

Antes de testar, em **Authentication → URL Configuration** defina **Site URL** como a origem de produção e adicione o endereço exato `https://SEU_SITE/?password-reset=1` a **Redirect URLs**. Para a publicação atual, use `https://central-de-cobran-a.pages.dev` e `https://central-de-cobran-a.pages.dev/?password-reset=1`, respectivamente. Não autorize curingas ou domínios de preview desnecessários. O mesmo domínio precisa estar em `ALLOWED_ORIGINS` da função. A lista de redirecionamento do Auth e a lista CORS da função são configurações diferentes.

O formulário **Esqueci minha senha** envia `{"action":"request_password_reset","username":"usuario"}`. O gateway resolve o email somente no servidor e solicita o envio ao Supabase Auth. A resposta `202` é sempre genérica para usuários ausentes/inativos e falhas do provedor de email: não comprova que uma mensagem foi enviada ou entregue. O pedido usa os mesmos limites atômicos de login (6 por usuário/30 por rede em 15 minutos), sem zerar os contadores. A auditoria recebe `PASSWORD_CHANGE` com estágio `recovery_requested`, sem email, senha ou token. Limites/indisponibilidade do banco retornam 429/503. Falhas de envio geram apenas um identificador técnico fixo no log.

Depois do clique no link do email, a Central consome os tokens do fragmento, remove-os da URL e mantém o token de recuperação somente em memória, sem transformá-lo em sessão aprovada da aplicação. O formulário envia `{"action":"change_password","password":"nova senha digitada"}` com o token em `Authorization: Bearer JWT`. A função confirma o token com `/auth/v1/user`, valida o perfil ativo oficial e admite no máximo 3 alterações em 15 minutos. A senha precisa ter 12 a 1.024 caracteres; a política do Supabase pode exigir outras condições.

A troca exige auditoria e revogação prévias das sessões de aplicação, depois utiliza exclusivamente a API autenticada do Supabase Auth. Uma segunda transação registra `changed`/`failed`/`uncertain`, revoga aprovações concorrentes e encerra tentativas de login anteriores; a função encerra a sessão Auth utilizada. Resposta 200: `{"password_changed":true,"signed_out":true}`. O usuário deve entrar novamente com usuário e nova senha. Uma resposta perdida da API Auth é registrada como incerta; nunca se presume que a senha permaneceu igual. Se a auditoria final ou o encerramento não puder ser confirmado, a função responde503, sem apresentar sucesso falso. Não trocar senhas por SQL, não inserir senhas em variáveis persistidas ou em arquivos, e não solicitar credenciais pelo chat.

Enquanto existir tentativa de alteração sem conclusão, `finish_login` nega novas aprovações de sessão para esse usuário, inclusive depois da expiração da reserva de30 segundos. Outra recuperação concluída resolve tentativas antigas como incertas e permite novos logins. Isso evita aprovar um login concorrente com a senha antiga quando o resultado da alteração ficou desconhecido. Não apagar os registros para desbloquear o acesso; concluir uma nova recuperação e conferir a auditoria.

O Supabase aplica limites próprios de email e pode restringir os destinatários atendidos pelo provedor padrão. Verifique o recebimento no email administrativo e as configurações oficiais de envio; se o provedor recusar a entrega, configurar um SMTP autorizado pode ser necessário. Não habilitar cobrança ou prometer entrega ilimitada no plano gratuito. A falha de entrega não deve ser contornada expondo o email do usuário, removendo controles ou editando `auth.users` diretamente.

## Garantias e limites

- O endereço associado ao login é resolvido por uma RPC exclusiva de `service_role`. Não existe consulta pública de username → email.
- SQL serializa a admissão de tentativas, permite uma única verificação em andamento por usuário e aplica limites de 6 admissões por usuário e 30 por origem de rede em 15 minutos. A conta continua protegida se o cabeçalho de rede for alterado. Esse cabeçalho é apenas um sinal auxiliar e não é tratado como identidade IP comprovada.
- Senhas são enviadas somente por HTTPS ao gateway/Auth e nunca persistidas nos logs ou tabelas de aplicação. `LOGIN` negado não armazena o texto do usuário informado; login bem-sucedido e logout registram a identidade oficial.
- Indisponibilidade dos limites, perfil ou auditoria impede emissão de sessão pelo gateway. Não há modo permissivo para contornar erro.
- Sessões precisam de aprovação server-side vinculada ao usuário oficial e ao `session_id`, com duração máxima de 12 horas. Renovações do JWT não estendem esse prazo; é necessário realizar novo login. Login direto por email no Auth pode emitir um JWT válido, mas esse JWT não tem aprovação nem acesso à aplicação. A conclusão do gateway aprova a sessão e grava a auditoria na mesma transação.
- Sessões revogadas são negadas imediatamente por todos os helpers/RPCs de acesso existentes. **Futuros módulos, policies e RPCs também devem usar `cf_private.is_active`, `cf_private.has_permission` ou `cf_private.session_allowed`.** Um JWT revogado continua criptograficamente válido até expirar, mas não recebe acesso à aplicação.
- O Auth público do Supabase também aceita autenticação por email e tem proteção própria. Revisar seus limites e a proteção contra abuso antes de produção; eventual CAPTCHA exige integração no gateway, não deve ser desativado para contornar falhas. O gateway não habilita serviços pagos.
- O broker oferece login, logout, pedido de recuperação por usuário e troca de senha autenticada. Troca obrigatória e gestão administrativa completa de senha ainda exigem implementação e homologação. Recuperação depende da configuração e entrega do email do Supabase Auth; nenhum teste simulado comprova entrega real.
- Tokens no frontend devem permanecer em memória (`persistSession: false`), sem `localStorage` como banco ou repositório de sessão. A autorização real sempre fica nas RPCs/RLS. Logout sem conexão limpa o navegador, mas sua revogação remota exige resposta de sucesso do servidor.

## Verificação local

```sh
node --test supabase/functions/auth-gateway/*.test.mjs
```

Os testes exercitam o handler real com serviços HTTP simulados: login, perfil bloqueado, credencial inválida, limites, indisponibilidade de auditoria, CORS, validação de entrada, logout, recuperação, troca de senha e revogação. O teste SQL de recuperação aplica 001/003/004 em PostgreSQL local e verifica permissões, limites, auditoria, preservação dos dados e revogação inclusive de login concorrente. Eles não comprovam publicação, recebimento de email, integração com o Supabase remoto ou ativação de contas reais.

Após publicar, testar manualmente com uma conta de homologação: login válido/inválido, bloqueio de perfil, `current_access`, logout e tentativa de reutilizar o JWT antigo nas RPCs. Não usar nem registrar senhas reais em comandos de teste.
