# Publicação e ativação — 0.5.0

Para o estoque manual em **Importar Bases → Estoque**, basta o deploy da versão 0.5.0 do site; seguir [estoque-manual.md](estoque-manual.md). O banco atual já possui as tabelas e RPCs necessárias. Não criar integração automática, conector, chave ou nova Edge Function para essa entrega. Os passos anteriores de 012/CR continuam independentes e não precisam ser repetidos para o card de estoque.

Para o projeto atual, o usuário já confirmou a execução de 008/009/010/011. A atualização **0.4.1** usa somente `supabase/migrations/012_treasury_accounts.sql`, seguindo [ativacao-contas-caixas.md](ativacao-contas-caixas.md). Ela acrescenta Cora Ecoplast e cinco caixas das empresas: o total passa a 17 posições, sem alterar saldos anteriores. Não exige outra Edge Function. Não repetir o SQL combinado da versão anterior para acrescentar contas.

Os procedimentos abaixo registram a ativação 0.4.0 e a publicação de CR, quando ainda necessária. O deploy atual deve exibir a versão 0.4.1 no rodapé.

A Central já possui endereço na Cloudflare Pages: https://central-de-cobran-a.pages.dev. O usuário informou que login, Painel, saldos e CP funcionam. A versão 0.4.0 acrescenta a entrada bancária em Importar Bases, CR e Cobrança. Os passos abaixo atualizam esse projeto, preservando seus dados. Testes locais não comprovam que o deploy ou a ativação remota já terminaram.

## 1. Atualizar somente o banco necessário

Seguir [ativacao-recebiveis.md](ativacao-recebiveis.md): no SQL Editor do projeto existente, executar **uma única vez** `supabase/dashboard/ativar-recebiveis.sql`. Ele reúne as migrations **008/009/010/011** numa transação.

Não repetir 001/003/004, 005/006/007 ou `ativar-financeiro.sql`, já usados neste projeto. Não executar o arquivo combinado e depois as quatro migrations individuais. Se alguma nova migration já foi aplicada, conferir o histórico e aplicar apenas o que falta. Não usar `db reset`, remover tabelas ou restaurar estado vazio para contornar erro. Nenhuma publicação deve refazer usuários, saldos, CP, mensagens ou auditoria.

Para um projeto completamente novo, a ordem inicial está em [../supabase/README.md](../supabase/README.md). Essa instalação não é necessária para atualizar o projeto atual.

## 2. Publicar a nova função de recebíveis

Em **Edge Functions → Deploy a new function → Via Editor**, copiar o conteúdo completo de `supabase/dashboard/receivables-import.ts` para **index.ts**. No campo **Function name**, na parte inferior direita ao lado de **Deploy function**, colocar **receivables-import** e publicar.

Em **Settings**, desativar **Verify JWT with legacy secret** e salvar. O próprio código confirma o token no Supabase Auth e a sessão/permissão no banco antes de analisar arquivos. RLS permanece ativa.

Manter as funções **auth-gateway** e **payables-import** já em funcionamento. O secret existente `ALLOWED_ORIGINS` continua sendo `https://central-de-cobran-a.pages.dev`, sem barra final. As chaves privadas do runtime não pertencem ao site, ao Git ou ao chat. Bancos usam RPCs e não exigem outra Edge Function.

Uma função com nome automático, como `quick-worker`, não substitui `receivables-import`. Antes de remover um serviço antigo, conferir que ele não está em uso. Não alterar o nome de `auth-gateway`.

## 3. Atualizar o site no mesmo endereço

O projeto Pages já está ligado à branch `main` do repositório. Conferir no painel da Cloudflare se o build/deploy da atualização terminou com sucesso. Configuração esperada: Node 24, instalação `npm ci`, comando de build `npm run build`, pasta de saída **dist**, raiz do projeto sem subpasta. Não publicar o código-fonte inteiro como se fosse a pasta de saída.

A conexão pública vem de `config/supabase.public.json`, contendo somente URL e chave publishable. Não é necessário adicionar chaves privadas à Cloudflare. Para outro projeto, usar apenas as duas configurações públicas previstas em `.env.example`.

O build inclui `_headers` com CSP e política de cache. A navegação atual usa a mesma página e não precisa de regra global de redirecionamento. Não publicar o HTML legado V75, `usuarios.json`, hashes ou bases financeiras como arquivos estáticos.

Após a publicação atual, abrir a Central, atualizar com **Ctrl + Shift + R** se necessário, entrar e conferir **Versão 0.5.0** no rodapé. Esse deploy não executa o SQL nem publica funções do Supabase. O endereço existente deve permanecer o mesmo; não criar outro site para cada atualização.

## 4. Conferir os dados e os acessos

- Confirmar que os onze saldos e os títulos de CP já lançados continuam disponíveis.
- Abrir **Importar Bases → Caixa / Bancos** como Gerência e conferir data, onze campos de saldo, total e observação. Uma posição é salva inteira, com confirmação e auditoria; vazio não significa zero. Saldos de dias anteriores precisam ser conferidos para a nova data.
- Registrar extrato somente como apoio, se necessário. O arquivo privado de até 2 MiB não preenche saldos nem baixa títulos.
- Importar um relatório completo e real de CR; conferir quantidade e valor antes de concluir. Um título desaparecido aguarda validação financeira e não conta como recebido.
- Vincular cada login de cobrança à pessoa responsável na Administração, sem presumir nomes. Conferir atribuição e herança por cliente com dívida ativa.
- Conferir o fluxo de data real, confirmação financeira e não localizado, com retorno à mesma cobradora. Um título sem responsável precisa de atribuição antes da devolução.
- Verificar carteiras separadas, Diretor em leitura, CP sem importação de CR e CR sem alteração de CP. Conferir auditoria como Gerência.
- Atualizar o Painel e comparar com as fontes. Títulos e recebimentos seguem o período; o caixa permanece a posição atual na data oficial de São Paulo. A semana financeira é sábado–sexta.
- Conferir login, logout e acesso externo. Atualizar página ou publicar outra versão não pode apagar dados.

Não usar dados inventados no banco operacional para demonstrar módulos. Os testes automatizados utilizam dados sintéticos em ambiente local; sua evidência está em [estado-verificacao.md](estado-verificacao.md). A homologação remota deve respeitar os dados e os acessos reais, sem registrar credenciais em comandos ou logs.

## Login e recuperação já configurados

Esta atualização não exige reaplicar 004 nem republicar `auth-gateway`. A configuração existente de **Authentication → URL Configuration** deve manter:

- **Site URL:** `https://central-de-cobran-a.pages.dev`
- **Redirect URLs:** `https://central-de-cobran-a.pages.dev/?password-reset=1`

Somente uma solicitação em **Esqueci minha senha** pede o email ao Supabase. Deploy e SQL não enviam links. A resposta genérica não comprova entrega; conferir caixa de entrada, spam e limites do provedor. Senha ou link de recuperação não devem ser enviados no chat.

## Limites e recuperação de falhas

Faturamento, Margens, Comissões, RH/DP, previsões completas e Excel detalhado de CP, conciliação bancária, backups operacionais e migração conferida do estado atual da Central antiga permanecem pendentes. Não considerar concluída a primeira versão de produção enquanto esses itens e os critérios de aceite não forem homologados. Fontes ausentes continuam pendentes, sem números fictícios.

Preservar banco, ZIP original e estado operacional anterior. Publicar código não substitui backup. Se houver falha, preservar a mensagem administrativa e investigar; não apagar dados, desativar permissões ou liberar acesso para contornar um erro. A restauração de produção ainda precisa ser implantada e testada. Não ativar billing para resolver cotas ou configuração sem autorização.
