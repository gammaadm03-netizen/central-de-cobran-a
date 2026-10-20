# Publicação e ativação — 0.17.0

A atualização **0.17.0** implementa **Importar Bases → Custos** e a aplicação dos custos ao CMV e às margens de um mês escolhido. Instale [ativar-custos-fechamento.sql](../supabase/dashboard/ativar-custos-fechamento.sql), com **044/045** sobre a base comercial **032**; atualize a função **business-import existente → Code → index.ts** com o [TypeScript completo](../supabase/dashboard/business-import.ts) e clique em **Deploy updates**; confira o site **0.17.0**. O [guia de Custos e fechamento](custos-fechamento.md) explica a escolha dos custos divergentes, precisão, histórico, impacto e aplicação em nova versão. Publicar pelo Git não executa a atualização no Supabase nem recalcula um fechamento real.

A atualização **0.16.0** acrescenta a conciliação durante a importação de **Contas a Pagar**: tipo de relatório explícito, escolha para cada título ausente do completo e confirmação individual de cada ocorrência de R$ 0,01. Pagamento exige dados efetivos; baixa administrativa preserva o original e a auditoria, exclui o título dos valores financeiros e não gera realizado. Aplicar [ativar-conciliacao-importacao-contas-pagar.sql](../supabase/dashboard/ativar-conciliacao-importacao-contas-pagar.sql), com **042/043** sobre CP até **021**; atualizar a função **payables-import existente → Code → index.ts** com o TypeScript completo e clicar em **Deploy updates**; conferir o site **0.16.0**. O [guia de conciliação na importação](conciliacao-importacao-cp.md) explica a confirmação atômica, as respostas pendentes, a reabertura explícita e a diferença entre previsto, saldo e realizado. Não há nova Edge Function e 040/041 são independentes. Publicar pelo Git não aplica o SQL nem comprova a ativação remota.

A correção da análise de **Contas a Receber na 0.15.0** otimiza as consultas de parcelas por meio do índice existente, mantendo a identificação exata, amplia os limites da função/site para 50/60 segundos e apresenta uma referência segura em caso de falha. Executar [ativar-otimizacao-importacao-recebiveis.sql](../supabase/dashboard/ativar-otimizacao-importacao-recebiveis.sql), que instala **041** sobre 023/024, atualizar **receivables-import → Code → index.ts** com o arquivo TypeScript completo e clicar em **Deploy updates**, depois conferir o site **0.15.0**. O [guia de revalidação](revalidar-parcelas-recebiveis.md) separa esses passos, preserva as escolhas corretas e orienta a conferência do histórico quando a confirmação é interrompida. Essa correção é independente da 040 de e-mail; os tempos locais não comprovam desempenho ou execução remotos.

A atualização **0.15.0** oferece a preparação de e-mail depois de finalizar um atendimento na Cobrança. A mensagem relaciona os títulos pendentes do mesmo cliente e carteira, com vencidos e a vencer separados, e usa os destinatários selecionados dos contatos salvos. Aplicar somente [ativar-rascunho-email-cobranca.sql](../supabase/dashboard/ativar-rascunho-email-cobranca.sql), que instala **040** sobre a base de Cobrança com 024/027/029, e conferir o site **0.15.0**. A configuração 039 é independente. Não há criação ou atualização de Edge Function, SMTP ou envio automático. O envio é confirmado no Gmail, Outlook ou aplicativo de e-mail; a Central não registra entrega. A fila de opções de rascunho fica em memória apenas dentro do módulo Cobrança. [Guia de uso, ativação e arquivos completos](cobranca-email-rascunho.md). Publicar o código não executa o SQL nem comprova o deploy remoto.

A atualização opcional **039_user_access_limits** permite limitar individualmente um perfil CP a Painel, Contas a Pagar e Importar Bases. Requer SQL e configuração por UID no projeto; não exige novo site ou Edge Function. Seguir o [guia específico](limitar-usuario-contas-pagar.md). O ativador da Diretoria foi protegido para não substituir os limites ao ser repetido depois da 039.

A atualização **0.14.3** acrescenta elevação, sombra e destaque de borda aos cards de indicadores ao passar o mouse. Respeita movimento reduzido, toque e impressão. Basta atualizar o site; não há alteração de banco ou funções.

A atualização **0.14.2** acrescenta **Validar escolhas de parcelas** junto às escolhas e distingue o resultado anterior da análise atual. Também bloqueia explicitamente uma resposta que continue ambígua para um vínculo já enviado. Esta melhoria depende somente do site. Caso a função remota não aplique as escolhas, o [guia específico](revalidar-parcelas-recebiveis.md) orienta atualizar a função existente `receivables-import` com o código completo já disponível; não há nova migration ou função adicional.

A atualização **0.14.1** apresenta o primeiro erro detalhado da importação de Contas a Receber perto do botão de análise, com foco automático e tabela completa preservada. Depende somente do site, sem mudança de banco ou função. A causa do novo arquivo informado pelo usuário depende de receber o erro específico ou as planilhas atuais.

A atualização **0.14.0** renova a apresentação da tela inicial, amplia logo e nome da Central e mostra o crédito solicitado abaixo da versão. Usa campanhas mensais do calendário brasileiro, incluindo o laço de Outubro Rosa e uma mensagem compacta em todas as abas autorizadas. Basta o deploy do site e atualizar a página. Não há alterações de banco, funções ou importações.

A atualização **0.13.5** exibe o Ativo Circulante com duas casas decimais no painel, histórico e Excel, mantendo o cálculo exato. Basta o deploy do site e atualizar a página; não exige mudança de banco, função ou importação.

A atualização **0.13.4** reconhece a coluna Salário Folha e o rodapé final do modelo de RH, aceita resultados numéricos salvos de fórmulas financeiras e usa a coluna Total como fonte do Total geral. Folha total, salários de colaboradores e pró-labores têm indicadores separados. Aplicar **031..038**, atualizar a função existente **business-import**, conferir o site **0.13.4** e reimportar a planilha com a data original. A revisão 4 preserva os originais e as posições anteriores, sem duplicar totais. [Guia de ativação](corrigir-importacao-rh.md).

A atualização **0.13.3** separa a remuneração dos registros com setor SÓCIO como **Pró-labore**, retirando-os dos indicadores de salários dos colaboradores. A prévia, o Excel, os quadros por filial/setor e os subtotais seguem a mesma classificação. Aplicar o combinado atual **031..037**, conferir o site **0.13.3** e atualizar a consulta de RH. Quem já ativou a 0.13.2 não precisa reimportar a planilha nem republicar business-import para essa separação. As bases e os valores originais permanecem preservados. [Guia](corrigir-importacao-rh.md).

A atualização **0.13.2** separa **Salário Folha** (sem descontos, colaboradores sem sócios) de **Salário recebido** (com descontos, incluindo sócios) e calcula o Total dos cinco campos definidos pela operação. Seguir [corrigir-importacao-rh.md](corrigir-importacao-rh.md): executar o combinado atual **031..036**, atualizar a função existente **business-import** e conferir o site **0.13.2**. Reimportar a mesma planilha com a data original corrige os vínculos e preserva o histórico, sem duplicar pessoas ou totais. A publicação pelo Git não executa o SQL nem publica a função no Supabase.

A atualização **0.13.0** recupera Comissões, Faturamento, Margens e RH/DP. Seguir [ativacao-demais-abas.md](ativacao-demais-abas.md): executar **ativar-demais-abas.sql** (031..034, versões já aplicadas são preservadas), publicar a nova função **business-import** e conferir o site 0.13.0. As funções anteriores permanecem. A Gerência importa as bases reais e vincula as pessoas às políticas de comissões com vigência; o código antigo não é publicado como HTML ou base atual.

A atualização **0.12.2** deixa o perfil Diretor somente em consulta, com todas as abas exceto Importar Bases e Administração também em leitura. Seguir [acesso-diretoria.md](acesso-diretoria.md): aplicar o arquivo separado **ativar-acesso-diretoria.sql**, conferir o site 0.12.2 e criar/vincular a conta Auth se ainda não existir. O SQL não contém senha ou criação de usuário; nenhuma Edge Function precisa ser republicada.

A correção **0.12.1** mantém as ações do atendimento visíveis para os operadores autorizados, desabilitadas com explicação quando necessário. É uma atualização do site e usa a mesma ativação Supabase da 0.12.0. Conferir **Versão 0.12.1** no rodapé após o deploy.

A atualização base **0.12.0** corrige o atendimento, a prioridade dos retornos e a validação financeira e acrescenta a escolha da cobradora na importação dos abertos. Seguir [cobranca-atendimento-retornos.md](cobranca-atendimento-retornos.md): executar o combinado **022..030**, atualizar a função existente **receivables-import** e conferir o site **0.12.0**. Numa base 0.11.0 completa, somente 029/030 são instaladas. Depois, reimportar o relatório de abertos para completar responsáveis ausentes sem duplicar os títulos. Não repetir a instalação inicial.

A atualização anterior **0.11.0** acrescenta contatos e descrições exclusivamente ao atendimento de **Cobrança**, com importação dos arquivos de apoio e relatórios de contatos. Seguir [cobranca-contatos-descricoes.md](cobranca-contatos-descricoes.md): executar o combinado condicional **022..028**, publicar a nova função **collection-reference-import** e conferir o site 0.11.0 no mesmo endereço. Em uma base 0.10.0 completa, só 027/028 são instaladas. Não repetir a instalação inicial, nem substituir as funções anteriores. A importação dos arquivos reais é um passo posterior no sistema.

A atualização anterior **0.10.0** recupera a Central de Cobrança operacional com quatro abas, atendimento ao lado da lista, status/agenda, validação e controle de tempo no banco. Seguir [central-cobranca-operacao.md](central-cobranca-operacao.md): executar o combinado condicional **022..026** e aguardar o site no mesmo endereço. Quem já ativou a 0.9.0 recebe somente a nova 026; a função de importação permanece a mesma. Nenhuma instalação inicial deve ser repetida.

A atualização anterior **0.9.0** utiliza os dois relatórios reais de CR, confirma quitações por importação, atualiza Cobrança, apresenta recebido diário à Diretoria e disponibiliza a base efetiva de comissões. Seguir [ativacao-operacao-recebiveis.md](ativacao-operacao-recebiveis.md) para a função **receivables-import**, caso ainda não atualizada. O combinado atual **022..026** já inclui as atualizações de banco dessa entrega. Taxas de comissão não foram presumidas. Não repetir a instalação inicial.

Para a versão anterior **0.8.0**, seguir [ativacao-contas-pagar.md](ativacao-contas-pagar.md): executar o SQL combinado condicional **012..021**, atualizar o código da função existente **payables-import** e aguardar o frontend no mesmo endereço. Inclui resumo semanal por Macro, total pago mensal, consulta por período, importação incremental de previsões e conciliação automática pelo relatório dos pagos. Nenhum serviço pago é habilitado. Não repetir a instalação inicial.

Os procedimentos abaixo preservam o histórico das versões anteriores.

Para a atualização anterior 0.6.0, seguir [ativacao-resumo-diretoria.md](ativacao-resumo-diretoria.md): confirmar 012 e executar somente a nova migration 013. Ela acrescenta os complementos oficiais e o cálculo sem M49, preservando o banco. Nenhuma Edge Function precisa ser criada ou republicada para o Resumo da Diretoria. O site deve exibir **Versão 0.6.0**.

Os passos abaixo preservam o histórico de publicação das versões anteriores.

Para o estoque manual em **Importar Bases → Estoque**, basta o deploy da versão 0.5.0 do site; seguir [estoque-manual.md](estoque-manual.md). O banco atual já possui as tabelas e RPCs necessárias. Não criar integração automática, conector, chave ou nova Edge Function para essa entrega. Os passos anteriores de 012/CR continuam independentes e não precisam ser repetidos para o card de estoque.

Para o projeto atual, o usuário já confirmou a execução de 008/009/010/011. A atualização **0.4.1** usa somente `supabase/migrations/012_treasury_accounts.sql`, seguindo [ativacao-contas-caixas.md](ativacao-contas-caixas.md). Ela acrescenta Cora Ecoplast e cinco caixas das empresas: o total passa a 17 posições, sem alterar saldos anteriores. Não exige outra Edge Function. Não repetir o SQL combinado da versão anterior para acrescentar contas.

Os procedimentos abaixo registram a ativação histórica 0.4.0 e a publicação inicial de CR. Na entrega histórica seguinte, o rodapé passou a mostrar 0.4.1. Para a atualização atual 0.11.0, seguir o guia no início desta página.

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

Na publicação histórica do estoque, o rodapé passou a mostrar 0.5.0. Após a atualização atual, abrir a Central, atualizar com **Ctrl + Shift + R** se necessário, entrar e conferir **Versão 0.11.0**. Esse deploy não executa o SQL nem publica funções do Supabase. O endereço existente deve permanecer o mesmo; não criar outro site para cada atualização.

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

As quatro abas recuperadas dependem da ativação 0.13.0 e da conferência das bases reais. Pagamento de comissões, conciliação automática de extratos bancários, backups operacionais e migração conferida do estado atual da Central antiga permanecem pendentes. Não considerar concluída a primeira versão de produção enquanto esses itens e os critérios de aceite não forem homologados. Fontes ausentes continuam pendentes, sem números fictícios.

Preservar banco, ZIP original e estado operacional anterior. Publicar código não substitui backup. Se houver falha, preservar a mensagem administrativa e investigar; não apagar dados, desativar permissões ou liberar acesso para contornar um erro. A restauração de produção ainda precisa ser implantada e testada. Não ativar billing para resolver cotas ou configuração sem autorização.
