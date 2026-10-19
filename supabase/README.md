# Banco e autenticação da Central Financeira

Os arquivos neste diretório são código e schema, sem usuários reais, senhas, UUIDs administrativos ou bases financeiras.

## Modelo real de RH / DP — 0.13.1

O combinado **dashboard/ativar-demais-abas.sql** agora inclui **035_hr_report_model**, preservando 031..034 já registradas. Acrescenta ajuda de custo e somas separadas de salário da folha, mantendo as posições anteriores imutáveis. A mesma origem pode ser reprocessada pela nova versão de leitura sem duplicar a posição atual. RPCs novos: `preview_hr_report_import` e `commit_hr_report_import_from_gateway`; as permissões e o gateway com original canônico permanecem obrigatórios.

Atualizar a função existente **business-import** com o arquivo único atual. Benefícios vazios em colunas presentes são zero, conforme confirmação do usuário; ausências históricas permanecem desconhecidas. Nenhum dado pessoal foi embutido na atualização. [Guia do modelo e ativação](../docs/corrigir-importacao-rh.md).

## Comissões, Faturamento, Margens e RH/DP — 0.13.0

Aplicar **dashboard/ativar-demais-abas.sql**, combinado transacional repetível de **031..034**. A 032 mantém fechamentos mensais versionados, itens e originais privados; a 033 mantém posições privadas de RH e a política da V75; a 034 mantém regras de comissão por vigência e apurações imutáveis sobre fontes efetivas. Nenhuma base histórica ou pessoa real é inserida pela ativação. Usuários, saldos e títulos existentes são preservados.

Publicar a nova **business-import** com **dashboard/business-import.ts**, verificação JWT legada desligada e `ALLOWED_ORIGINS` existente. A função valida sessão/permissões e relê o original em cada análise e confirmação; os commits são exclusivos do gateway e revalidam as permissões. A Diretoria continua somente em consulta. [Guia de ativação e uso](../docs/ativacao-demais-abas.md).

## Diretoria somente para consulta — 0.12.2

Aplicar **dashboard/ativar-acesso-diretoria.sql**, correspondente à nova migration **031_director_readonly**. A atualização preserva as versões 001..030 e remove do perfil Diretor as antigas permissões de importação e escrita de mensagens. O bloqueio de mutações também é aplicado em `has_permission` e `current_access`, com consulta administrativa somente por SELECT, sessão aprovada e perfil ativo. Os RPCs administrativos continuam exclusivos da Gerência.

A conta de autenticação precisa ser criada em **Authentication → Users** e vinculada em **Administração → Usuários**. A senha é definida somente no Authentication; não há criação de conta ou senha no SQL. Não exige nova Edge Function. [Guia de ativação e cadastro](../docs/acesso-diretoria.md).

## Atendimento e responsáveis na importação — 0.12.0

O combinado atual `dashboard/ativar-recebiveis-operacao.sql` inclui **022..030**, pulando versões registradas. A 029 acrescenta ciclo de atendimento, pausa, rascunho, finalização e prioridade de retornos oficiais por carteira; integra pendência financeira e devolução à mesma responsável. A 030 permite atribuição explícita de clientes sem carteira durante a importação de abertos e a complementação idempotente de um arquivo já importado. Preserva carteiras existentes, recebimentos e logs anteriores.

Atualizar também a função existente **receivables-import** com `dashboard/receivables-import.ts` e o site **0.12.0**. Não criar outro nome de função nem repetir a instalação inicial. [Guia de ativação e uso](../docs/cobranca-atendimento-retornos.md).

## Contatos e descrições de Cobrança — 0.11.0

O combinado atual `dashboard/ativar-recebiveis-operacao.sql` inclui **022..028**, pulando versões registradas. A 027 acrescenta contatos compartilhados, alterações auditadas, relatórios e contexto autorizado exclusivamente para títulos vencidos ativos da Cobrança. A 028 acrescenta importações de apoio com original no bucket privado `collection-reference-files`, CSVs privados validados no servidor, prévia e publicação transacional. Não altera identidades financeiras, valores ou recebimentos; contatos mantidos manualmente são preservados em novas importações.

Publicar também a nova função **collection-reference-import** a partir de `dashboard/collection-reference-import.ts`, com verificação JWT legada desligada e autorização própria no código, e o frontend 0.11.0. Manter as funções anteriores. Descrições não aparecem em Contas a Receber, Comissões ou quitados. [Guia atual](../docs/cobranca-contatos-descricoes.md).

## Central de Cobrança operacional — 0.10.0

O combinado `dashboard/ativar-recebiveis-operacao.sql` foi ampliado para **022..026**, aplicando somente versões faltantes. A nova **026** mantém estado operacional separado do financeiro, intervalos de trabalho com horários do servidor, comandos auditados e consultas autorizadas para as quatro abas da central. Não reescreve as migrations 001..025, recibos ou bases existentes. Não exige outra Edge Function; `receivables-import` continua sendo a versão da 0.9.0. [Guia atual](../docs/central-cobranca-operacao.md).

## Contas a Receber e Cobrança — 0.9.0

Na entrega 0.9.0, o combinado incluía 022..025; o arquivo atual aplica somente versões faltantes **022..026**, numa transação, com pré-requisito009 e sem dependência de CP021. A022 restringe carteira/ações aos vencidos;023 resolve parcelas e sincroniza abertos incrementalmente;024 confirma recebimentos reais e mantém versões imutáveis, resumo diário e base de comissões;025 agrega gestão da cobrança sob RLS;026 recupera atendimento e tempo. Quem ainda não atualizou a função de importação deve publicar `receivables-import` com o arquivo único gerado.

Valores nominal e recebido permanecem separados. Revisão financeira obrigatória evita concluir uma análise desatualizada; repetição de arquivo retorna sem duplicidade. Vencimento ambíguo exige vínculo explícito. Dados e atribuições existentes são preservados. Comissões usa o efetivamente recebido e ainda não calcula taxa/pagamento. Não alterar gateways Auth/CP para esta entrega. [Guia](../docs/ativacao-operacao-recebiveis.md); [modelos/regras](../docs/contas-receber-fluxo.md).

## Contas a Pagar — 0.8.0

No projeto existente, executar `dashboard/ativar-contas-pagar.sql`: aplica somente migrations faltantes **012..021** numa transação. A 019 acrescenta número de cheque sem reescrever snapshots antigos; a 020 agrega previsto/realizado semanal por Macro e total mensal pela data real; a 021 oferece previsões incrementais e importação explícita de pagamentos integrais com revisão automática, idempotência e correções auditadas.

Atualizar também a função existente **payables-import** com `dashboard/payables-import.ts`, mantendo nome, origens e verificação própria de sessão/permissões. Os modos novos exigem a capacidade correspondente do banco; a ausência da migration bloqueia a gravação com mensagem de atualização. O modo antigo sem contexto permanece para compatibilidade, mas a interface atual usa explicitamente `forecast` ou `payments`. Não alterar `auth-gateway` ou o serviço CR.

As cópias originais permanecem privadas. Escrita nas novas tabelas é restrita às funções autorizadas; Diretoria consulta sem escrita, inclusive pela API. Não expor chaves administrativas no navegador ou desativar RLS. Guia: [ativação CP](../docs/ativacao-contas-pagar.md); [modelo confirmado](../docs/modelo-importacao-contas-pagar.md).

## Resumo da Diretoria — 0.6.0

Após confirmar a 012, executar somente `migrations/013_director_report.sql`. Adiciona complementos diários auditados, fórmula oficial sem M49 com impostos do mês passado, leitura consistente e novas posições com os componentes preservados. Exige permissão oficial e sessão aprovada; Diretor consulta e Gerência escreve. Não altera dados anteriores ou exige nova Edge Function. Guia: [ativação do resumo](../docs/ativacao-resumo-diretoria.md).

## Estoque manual — 0.5.0

A orientação mais recente do usuário é cadastrar estoque manualmente em **Importar Bases → Estoque**. Esse card utiliza `save_manual_stock`, `current_stock` e `stock_positions` da migration006 já instalada. Não há nova migration ou Edge Function nesta versão, nem integração automática com o portal privado. A autorização de escrita continua validada no banco e o histórico/auditoria existentes são preservados. Procedimento: [../docs/estoque-manual.md](../docs/estoque-manual.md).

## Projeto existente — atualização 0.4.1

**Cadastro atual de bancos/caixas (0.4.1):** após a confirmação de execução de 008/009/010/011, executar somente `migrations/012_treasury_accounts.sql`. Acrescenta Cora Ecoplast e cinco caixas das empresas, totalizando 17 posições, preserva os onze IDs e saldos anteriores e mantém ausências sem saldo. As contas recebem tipo banco/caixa e nome de exibição, sem dividir ECOPLAST/ECO PLAST ou GAMMA/GAMMA IND em empresas diferentes. Guia: [../docs/ativacao-contas-caixas.md](../docs/ativacao-contas-caixas.md). Não repetir a instalação abaixo nem o arquivo combinado já aplicado.

O usuário informou que já configurou 001/003/004, `auth-gateway`, 005/006/007 e `payables-import`, e que cadastrou os onze saldos e importou CP. Também confirmou a execução de 008/009/010/011. Esses dados não devem ser refeitos ou substituídos por uma instalação inicial.

O arquivo **`dashboard/ativar-recebiveis.sql` foi a atualização anterior (0.4.0)** e reúne 008/009/010/011; não deve ser reaplicado neste projeto. Para usar a importação de CR, quem ainda não publicou a função deve criar **`receivables-import`** a partir de `dashboard/receivables-import.ts`. Ela usa `ALLOWED_ORIGINS` já existente; manter a origem `https://central-de-cobran-a.pages.dev`, sem barra final. Caixa/Bancos usa RPCs e não precisa de outro serviço de importação.

Procedimento atual dos bancos/caixas: [../docs/ativacao-contas-caixas.md](../docs/ativacao-contas-caixas.md). Referência da importação/validação CR: [../docs/ativacao-recebiveis.md](../docs/ativacao-recebiveis.md). Executar SQL e publicar o site são passos separados; os testes locais não confirmam a ativação remota. Se uma migration nova já tiver sido aplicada separadamente, conferir o histórico antes de executar qualquer combinado. Nunca resolver conflitos apagando tabelas.

## Ordem de instalação em projeto novo

Os passos abaixo são referência da instalação inicial. **Não repeti-los no projeto existente já configurado.**

1. `migrations/001_identidade_rbac.sql`: schema original de perfis, RBAC, vínculos, mensagens e auditoria. **Se já foi executado neste projeto, não executar novamente.** A migration não é um reset e não contém comandos para remover tabelas.
2. Provisionar o administrador no Supabase Authentication e vincular seu UUID a `public.profiles` pelo procedimento inicial já revisado. Nunca salvar senhas em SQL ou Git. Esse bootstrap não é repetido em deploys.
3. Revisar e executar `migrations/003_auth_gateway.sql` uma vez pelo SQL Editor, em uma nova consulta. Ela é incremental, preserva os registros existentes e não cria contas Auth. Após aplicá-la, sessões precisam ter `session_id` no JWT emitido pelo Supabase Auth e aprovação pelo gateway. Uma sessão criada diretamente no Auth não dá acesso aos dados da aplicação.
4. Revisar e executar `migrations/004_password_recovery.sql` uma vez, após 001 e 003. Ela acrescenta conclusão auditada de pedidos de recuperação e troca de senha com limitação e revogação das sessões. Não altera `auth.users`, senhas, dados financeiros nem os perfis existentes. Depois atualizar a função com o código completo de `dashboard/auth-gateway.ts` gerado nesta versão.
5. Para a operação inicial de Painel/Caixa/CP, executar somente `dashboard/ativar-financeiro.sql`, que reúne 005/006/007 em uma transação. Publicar separadamente a nova função `payables-import` usando `dashboard/payables-import.ts`. Não repetir os arquivos individuais depois do combinado. Procedimento e limites em [../docs/ativacao-financeira.md](../docs/ativacao-financeira.md).

6. Após 005/006/007, executar `dashboard/ativar-recebiveis.sql`, que reúne 008/009/010/011, e publicar `receivables-import`. Não executar também as quatro migrations individuais. O script acrescenta CR, Cobrança, validações, posições bancárias completas e indicadores. Não importa dados antigos nem cria valores de exemplo.
7. Após 008/009/010/011, executar `migrations/012_treasury_accounts.sql` uma vez, acrescentando as seis posições da lista atual. As contas novas aguardam saldo explícito; nenhuma posição financeira é inventada.

8. Após 012, executar `migrations/013_director_report.sql` uma vez. Não repetir a instalação inicial em projetos já existentes.
9. Após 013, aplicar 014 a 021 em ordem, ou usar o combinado condicional `dashboard/ativar-contas-pagar.sql`, que ignora versões já registradas. Publicar `payables-import` atualizado.
10. Aplicar022..026 ou o combinado `dashboard/ativar-recebiveis-operacao.sql`, que ignora versões registradas. Publicar `receivables-import` atualizado.

Em projetos já configurados manualmente, registrar as migrations aplicadas antes de usar `supabase db push`. Não rodar o histórico inteiro contra um banco existente sem conferir o histórico. Não executar `db reset` em um projeto com dados.

## Importações e posições bancárias — 0.4.0

Para publicar `receivables-import` pelo painel, criar uma função nova **Via Editor**, substituir todo o `index.ts` por `dashboard/receivables-import.ts` e preencher o nome **receivables-import** no campo inferior direito, ao lado de **Deploy function**. Em Settings, desativar **Verify JWT with legacy secret** e salvar. Preservar `auth-gateway` e `payables-import` existentes.

O serviço confirma o Bearer token no Auth e consulta a sessão aprovada e a permissão oficial de importação antes de processar o arquivo. Recebe apenas ação, nome e conteúdo do arquivo, mais confirmação de relatório completo e identificador da análise anterior na conclusão. Não recebe role do cliente nem aceita linhas financeiras derivadas pelo navegador. A leitura inicial em worker melhora a interface; a análise que autoriza a gravação é feita novamente no servidor. Não desativar RLS ou expor `service_role` para contornar falha.

CR aceita `.xlsx`, `.xlsm` e `.csv` UTF-8, até 2 MiB, 5.000 títulos, 100 colunas e uma única aba com dados. `.xls` antigo exige cópia `.xlsx`. Fórmulas, base vazia, linhas inválidas, arquivo repetido e comparação desatualizada impedem a conclusão. As cópias originais e seus hashes ficam privados no banco. Cabeçalhos obrigatórios: documento/NF, cliente/órgão, filial, vencimento e valor; emissão e CNPJ são opcionais. CNPJ informado exige 14 dígitos, sem completar zeros. Alteração da identificação nome/CNPJ exige revisão administrativa para evitar duplicar dívida; não há união automática.

Contagens da análise são disjuntas: `row_count = new_count + open_count + validated_in_source_count`. `pending_count` indica somente novas ausências, não toda a fila acumulada. Títulos ausentes aguardam validação; títulos já validados que reaparecem continuam validados. Um retorno como pagamento não localizado mantém a mesma cobradora e não é reenfileirado como nova ausência em toda importação. Atribuição inicial é administrativa; título novo herda cobradora de dívida ativa do cliente quando existe um vínculo oficial.

As funções operacionais de Cobrança exigem sessão aprovada, permissão e carteira autorizada, com controle de versão. Cobradora informa pagamento e data; somente CR/Gerência validam financeiramente. Não localizado retorna à mesma cobradora, exigindo atribuição antes da devolução quando o título não possui responsável. Os recebimentos validados preservam valor, data, atraso, origem e cobradora em registros imutáveis. O cálculo de comissões continua pendente. O total recebido na semana usa somente validações de origem `IMPORTACAO_DIARIA` e a data real no período sábado–sexta.

`save_bank_position` permite à Gerência salvar todas as contas ativas com uma data e observação, validando versões e centavos exatos numa única transação. Valores vazios não viram zero, e datas anteriores não são copiadas para novos dias. A consulta de caixa do Painel utiliza a data atual de São Paulo mesmo quando os títulos seguem outro período. `register_bank_support` e `download_bank_support` armazenam e recuperam cópias privadas de até 2 MiB, com hash e auditoria. Extratos de apoio não são interpretados e nunca atualizam saldos, validam recebimentos ou conciliam títulos automaticamente. Não é necessário Storage ou uma Edge Function bancária adicional.

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

Desde a versão 0.2.1, erros de recuperação possuem referências fixas: `REC-01` retorno sem credenciais completas; `REC-02` callback com `otp_expired` informado pelo Auth; `REC-03` outro erro de callback; `REC-04` sessão/token rejeitado durante verificação; `REC-05` falha de rede, serviço ou configuração durante a verificação. Falha de conexão não comprova expiração do link. O conteúdo bruto do erro não é exibido e os parâmetros sensíveis são removidos da URL. Para suporte, solicitar somente a referência ou captura da mensagem, nunca o link do email, tokens ou a nova senha. Esta correção é apenas de frontend e não exige reaplicar SQL ou atualizar a Edge Function.

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
