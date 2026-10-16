# Evidências de verificação

16/10/2026. Estado de desenvolvimento e homologação; módulos financeiros ainda pendentes.

As seções iniciais preservam o histórico das versões anteriores. O estado mais recente está na seção de atualização 0.5.0 ao final; pendências antigas não substituem os relatos posteriores do usuário.

## Concluído nesta máquina

- Frontend React/TypeScript, gateway de login/logout, recuperação de senha e SQL incremental de proteção de sessões.
- Instalação com lockfile/cache gravável, geração do gateway para o editor do Supabase e build de produção concluídos.
- 20 testes SQL de identidade/RBAC e 12 testes SQL de gateway/sessões passaram em PostgreSQL local PGlite na entrega anterior.
- 27 testes Node passaram nesta atualização: 4 de configuração pública, 14 do gateway original, 8 do gateway de recuperação e 1 cenário composto de SQL que aplica 001/003/004. Este verifica permissões, limites, auditoria, revogação, login concorrente, falha incerta e recuperação posterior de tentativa abandonada.
- 15 cenários de navegador passaram em Chromium usando respostas sintéticas, incluindo 6 de recuperação: pedido por usuário, remoção do token da URL, isolamento do painel, confirmação da nova senha, link inválido/incompleto e resultado incerto. Nenhuma credencial real foi usada.
- Auditoria npm das dependências runtime retornou zero vulnerabilidades conhecidas na consulta da entrega anterior. Isso não prova ausência de falhas da aplicação.
- Originais do ZIP V75 comparados por hash de cada entrada e preservados sem alterações.
- `.env.local`, node_modules, dist, logs e resultados estão ignorados pelo Git. O arquivo de configuração versionado contém somente URL e chave pública. Nenhuma senha do usuário foi recebida.

## Evidências informadas pelo usuário

O usuário mostrou execução sem erro das migrations 001/003 e perfil administrativo habilitado. Publicou o site na Cloudflare Pages e informou que abriu em `https://central-de-cobran-a.pages.dev`. Publicou a função `auth-gateway`, desativou a verificação JWT legada e criou `ALLOWED_ORIGINS`.

Depois da correção da configuração pública do build 0.1.2, o login passou a retornar erro genérico de credenciais/acesso. A consulta diagnóstica mostrada pelo usuário confirmou perfil ativo, conta Auth existente, senha definida, email confirmado, ausência de bloqueio e nenhum login anterior. Isso não determina sozinho a causa do erro nem comprova que a senha digitada estava correta.

Essas evidências vieram de capturas e relatos; não equivalem a inspeção remota executada pelo agente. As tentativas de conexão ao Supabase nesta máquina receberam bloqueio de proxy 403. A comunicação Git com o repositório selecionado foi verificada e funciona.

## Ainda pendente no provedor

- Aplicar somente a migration 004 e atualizar a função `auth-gateway` com o arquivo único 0.2.0. Publicar o frontend via Git não atualiza automaticamente a função nem o banco.
- Configurar Site URL e Redirect URLs no Supabase Auth e solicitar recuperação pela Central. Nenhum email foi enviado pelo agente. SQL, build e testes não enviam email.
- Demonstrar recebimento real do link, troca de senha, login e logout na conta autorizada sem compartilhar credenciais.
- Homologar permissões com contas reais, bloqueio, expiração, revogação e persistência dos dados após novo deploy.
- Verificar planos gratuitos, cotas, pausas, retenção e entrega de email no provedor. Nenhum recurso pago foi habilitado.

## Escopo ainda não entregue

Cadastro completo Auth, redefinição por administrador, troca obrigatória, módulos financeiros, importações, cálculos, backups/restauração e migração da posição atual V75. Testes locais com Auth/HTTP simulados não comprovam integração remota ou segurança de toda a operação futura. Não declarar a Central completa ou pronta para uso financeiro em produção.

## Entrega pelo GitHub

O código é enviado ao repositório `gammaadm03-netizen/central-de-cobran-a`, branch `main`, como alternativa ao download de ZIP indisponível no chat. A Cloudflare está vinculada a essa branch com saída `dist`. Nenhuma senha, UUID administrativo real ou base V75 foi versionada. Scripts de publicação não recriam o banco.

## Atualização 0.2.1 — diagnóstico do link recebido

O usuário informou execução sem erro da migration 004, atualização da Edge Function e recebimento do email. Ao abrir o email mais recente imediatamente após recebê-lo, a tela mostrou link inválido/expirado. A causa remota ainda não foi identificada.

Reprodução local confirmou um defeito na mensagem: HTTP 503 e falha de rede durante a verificação também eram tratados como expiração. O frontend agora distingue callback incompleto, expiração explícita, sessão rejeitada e indisponibilidade, com referências fixas e sem expor erros ou credenciais. Build e 11 testes de navegador de recuperação passaram, incluindo falhas de rede, HTTP 403/503, erros de callback e remoção de parâmetros da URL. Os nove cenários de navegação da entrega anterior não foram repetidos nesta correção restrita à recuperação. A alteração não precisa de nova migration nem de atualização da função.

Durante a verificação local, antes do envio da correção 0.2.1, o usuário informou “funcionou”. Esse relato encerra o bloqueio reportado, mas não permite atribuir sua resolução à correção nem identificar a causa inicial. Não foi solicitada repetição de procedimentos no Supabase. A confirmação de login e as demais homologações de permissões continuam separadas desse relato.

## Atualização 0.3.0 — Painel, Caixa e primeira operação CP

O usuário confirmou que a Central abriu, identificou abas sem as funções anteriores e forneceu uma imagem do Painel V75. A análise confirmou que os módulos financeiros eram placeholders. A marca oficial foi extraída isoladamente do ZIP preservado; nenhum registro financeiro foi incluído nos assets públicos.

Implementados: Painel executivo com períodos e fontes centrais; contas bancárias oficiais, posição manual auditada, subtotal/consolidado sem pressupor saldo zero; estoque manual com origem/data; snapshots parciais imutáveis calculados no servidor; importação CP com parsing de CSV/XLSX/XLSM no servidor, macro obrigatória, cópia original privada, comparação completa, preservação de baixas, filtros, paginação e CSV. O mapeamento do legado está em `docs/v75-mapeamento.md`; o procedimento incremental está em `docs/ativacao-financeira.md`.

Durante a revisão foram corrigidos dois riscos antes da publicação: dados derivados pelo navegador não podiam comprovar correspondência com o arquivo original; a gravação passou a aceitar somente resultados derivados pelo gateway no servidor, com wrapper SQL exclusivo do serviço e revalidação da identidade/sessão. Escopos arbitrários permitiriam duplicar o consolidado; a origem agora é fixa e validada no servidor. O preflight ZIP também verifica os bytes realmente descompactados, recusando tamanhos declarados falsos antes de carregar ExcelJS. Esses defeitos foram reproduzidos localmente e não foram publicados como uma versão operacional.

Verificações desta atualização:

- 50 testes Node passaram: configuração pública, gateway de acesso/recuperação, parsing de arquivos e novo gateway de importação. Incluem CSV/XLSX reais sintéticos, datas, centavos, fórmulas, ZIP adulterado, autenticação anterior ao parsing, corpo real limitado e proteção contra dados/identidade fornecidos pelo navegador.
- 16 cenários SQL CP, 15 de tesouraria e 8 de snapshots passaram no PostgreSQL local PGlite. O teste de snapshots aplica o arquivo combinado real 005/006/007. Cobrem matriz de perfis, sessão revogada, original privado, rollback, concorrência, baixa/reabertura, ausência versus zero e precisão.
- Os 20 testes SQL originais de RBAC e os 12 testes de sessões também foram repetidos e passaram após a integração.
- Os 39 cenários da suíte integrada de navegador passaram em 59,8 segundos, cobrindo acesso, recuperação, CP, Painel e Caixa com respostas sintéticas.
- Build TypeScript/Vite e geração dos arquivos de ativação concluídos. O build informa chunks grandes do leitor Excel; a biblioteca é carregada separadamente para planilhas/exportação. As tabelas possuem paginação.
- `npm audit --omit=dev` retornou zero vulnerabilidades reportadas após override compatível de `uuid` no lockfile. Isso não constitui prova de ausência de falhas nem auditoria do runtime Deno remoto.

Ainda não executados pelo agente: aplicação remota de 005/006/007, publicação remota da função `payables-import`, teste do runtime Deno hospedado, importação da base real e homologação de totais. O acesso HTTP desta máquina aos provedores continua bloqueado por proxy 403; a entrega de código usa o Git autorizado.

CR, Cobrança/validação, Faturamento, Margens, Comissões e RH continuam sem migração funcional. Previsões CP, relatórios Excel detalhados CP, backups/restauração e migração da posição operacional também permanecem pendentes. Não afirmar restauração integral da V75 ou prontidão para produção financeira.

## Atualização 0.4.0 — bancos em Importar Bases, CR e Cobrança

O usuário informou que a Central e o Painel funcionaram, que já cadastrou os onze saldos e importou um relatório completo de CP. Pediu a entrada bancária dentro de Importar Bases e forneceu a tela antiga com data, onze contas e extrato de apoio. Esses relatos confirmam o uso operacional da versão anterior, sem constituir inspeção remota pelo agente.

Implementados: posição bancária com onze campos na área central de importações, total exato, confirmação e gravação conjunta; concorrência e auditoria por conta e por lote; arquivo de apoio privado preservado com hash e download autorizado, sem atualizar saldos. CR possui análise do arquivo original no servidor, importação completa atômica, títulos persistentes, herança de carteira e ausências que apenas aguardam validação. Cobrança possui carteira individual, contatos e pagamentos informados; o financeiro exige data real para confirmar ou devolve à mesma cobradora quando não localizado. Recebimentos validados e seus dados de atraso/origem são imutáveis. O Painel e novas posições da Diretoria passam a incluir recebíveis, recebimentos diários validados e projeção quando as fontes estiverem disponíveis.

A revisão reproduziu e corrigiu uma duplicação potencial: acrescentar ou retirar CNPJ opcional do mesmo título poderia gerar nova dívida e manter a antiga pendente. Prévia e confirmação agora bloqueiam identificação ambígua para correção administrativa, sem unir clientes automaticamente. Dívidas ativas ausentes no relatório intermediário também são protegidas. Um defeito de debounce que fechava detalhes recém-abertos foi corrigido nos componentes operacionais.

Verificações locais da entrega:

- **76 testes Node passaram**, incluindo parsing CR, CSV/XLSX reais sintéticos, gateway autenticado antes do processamento, limites, atomicidade de acesso e mensagens de erro sem dados internos.
- **126 cenários/grupos SQL passaram** em PostgreSQL local PGlite: 20 RBAC, 12 sessões, 16 CP, 15 tesouraria, 8 snapshots anteriores, 18 importação CR, 22 cobrança/validação, 10 posição/arquivo bancário e 5 atualização integrada.
- O teste de atualização aplica o arquivo combinado novo real sobre o schema anterior com usuário, onze saldos, CP e snapshot sintéticos existentes. Confirma preservação exata desses registros, ausência de recebimento antes da validação, projeção com fontes oficiais e bloqueio de posição concorrente sem alteração parcial.
- **65 cenários distintos de navegador passaram** com HTTP sintético: 59 na execução integrada e os 6 de CP após atualizar a simulação para responder ao novo resumo de CR. A falha inicial desses seis foi a rota ausente no fixture; nenhuma asserção foi removida. Todos os cenários executados terminaram aprovados na verificação final correspondente.
- Build TypeScript/Vite e geração dos dois arquivos novos para o painel do Supabase concluídos. Avisos de chunks grandes do leitor Excel permanecem; as planilhas são analisadas em worker separado. Tabelas operacionais e histórico possuem paginação.
- Os sete arquivos originais foram novamente comparados com o ZIP e permanecem idênticos. Nenhum dado financeiro real, senha, hash de senha ou UUID administrativo foi adicionado às alterações.

A aplicação remota de 008/009/010/011 e a publicação de `receivables-import` ainda dependem do painel autorizado do usuário. O deploy do site por Git não executa essas etapas. O acesso HTTP aos provedores nesta máquina continua sem evidência de disponibilidade após o bloqueio de proxy registrado; nenhum teste usou senha real nem alterou o banco remoto. Instruções incrementais: `docs/ativacao-recebiveis.md`. Não repetir 005/006/007 nem refazer os onze saldos/CP para instalar esta versão.

Comissões ainda não são apuradas: os recebimentos apenas preservam os dados necessários à implementação futura. Faturamento, Margens, RH/DP, previsões e Excel detalhado de CP, conciliação bancária, backups/restauração, administração completa Auth e migração conferida do estado operacional antigo permanecem pendentes. Não declarar o sistema completo ou homologado para produção financeira.

## Atualização 0.4.1 — dezessete posições, alertas de cobertura e efeito nos quadros

O usuário confirmou `Success. No rows returned` após executar a atualização anterior e enviou uma lista ampliada: doze contas bancárias e cinco caixas das empresas. Essa lista mais recente substitui a configuração inicial de onze bancos. Depois solicitou alerta de cobertura de contas negativas no mesmo dia e elevação dos quadros ao passar o cursor.

A migration incremental 012 acrescenta Cora Ecoplast e os caixas de Ecoplast, Limpe Fácil, Gamma, Fast Clean e Easy Clean, sem criar saldos. Mantém os onze IDs anteriores, os nomes canônicos das empresas e os históricos. Tipo banco/caixa e nomes de apresentação seguem a lista; ECO PLAST e ECOPLAST não viram empresas diferentes, assim como GAMMA IND e GAMMA. O mesmo cadastro é usado no formulário central de importações, na consulta de Caixa/Bancos, no Painel e no detalhamento Excel.

Os alertas mostram os negativos conhecidos mesmo quando faltam outras posições ou o consolidado está positivo. O valor a cobrir é a soma absoluta somente dos saldos negativos. Posições antigas pedem atualização hoje; consultas históricas identificam o período consultado. Um perfil futuro com apenas Painel recebe agregados, sem nomes de contas nem afirmação indevida sobre a data de cada saldo. Não há transferência ou cobertura automática. Os quadros recebem elevação discreta em dispositivos com cursor, respeitando redução de movimento.

**14 grupos SQL passaram** em PostgreSQL local PGlite, aplicando o SQL 012 sobre os arquivos de ativação anteriores reais. Cobrem preservação dos saldos, CP/CR, arquivos, auditoria e snapshots sintéticos; 17 nomes/tipos corretos; seis novas posições ausentes versus zero explícito; rejeição integral do lote antigo de onze contas; total com bancos e caixas; conflito de versão com rollback de saldos/auditoria; cobertura negativa independente de saldos positivos e da data; limite de precisão da cobertura na leitura e antes da gravação; RBAC e privacidade dos agregados.

Build TypeScript/Vite e **30 cenários de navegador de bancos/Painel passaram**, incluindo as dezessete posições, preenchimento das seis novas contas, envio único, saldo negativo, saldo antigo, consulta histórica, posição incompleta, Diretor em leitura, privacidade de perfil somente com agregados e exportação com caixas. A conferência visual manual no Chromium verificou os alertas, a elevação de três pixels com sombra ao passar o cursor e a ausência de transformação/transição com redução de movimento. O caso funcional de posição incompleta foi repetido após retirar as verificações de estilo da suíte financeira e também passou. Não foram repetidos testes de importação CP/CR ou autenticação nesta mudança restrita a bancos/Painel; seus resultados anteriores permanecem registrados acima.

A execução remota de 012 e a conferência dos saldos reais ainda dependem do painel do usuário. O envio por Git não aplica SQL. Para esta atualização, executar somente `supabase/migrations/012_treasury_accounts.sql`, sem repetir o combinado 008/009/010/011 já confirmado. Não é necessária outra Edge Function. Procedimento: `docs/ativacao-contas-caixas.md`. Nenhuma integração paga foi ativada e os módulos pendentes da versão anterior permanecem pendentes.

## Atualização 0.5.0 — estoque manual centralizado

Após indicar o portal privado de estoque, o usuário orientou que a atualização fosse manual em Importar Bases. O rascunho automático, ainda não publicado, foi retirado desta entrega. Nenhuma função de sincronização, migration, chave de máquina ou programa local é publicado. O valor da captura não foi carregado como posição atual nem incorporado a código, assets ou fixtures.

Implementados: **Importar Bases → Estoque**, exclusivo da Gerência com permissão de escrita; data de referência, valor exato não negativo, observação, confirmação, estados de operação e histórico paginado com responsável. O card usa as tabelas/RPCs existentes e o mesmo dado consultado no Painel/Resumo da Diretoria e Caixa/Bancos. A posição vigente segue a data de referência mais recente; uma data antiga não substitui outra atual. Zero explícito é válido, ausência continua pendente e falha de gravação orienta conferir o histórico antes de repetir. O acesso existente em Caixa/Bancos foi preservado e recebeu um caminho para a entrada centralizada.

Verificações da entrega:

- Build TypeScript/Vite concluído.
- **13 testes novos de navegador passaram**, cobrindo cadastro/consulta entre os módulos, confirmação, centavos/limites, zero explícito, datas, histórico/autoria, permissões, XSS como texto, paginação e falhas sem falso sucesso ou perda do preenchimento.
- **30 testes existentes de bancos/Painel passaram** após a integração, preservando as dezessete posições, cobertura de negativos, leitura do Diretor, dados ausentes e relatórios já implementados.
- **15 grupos SQL de tesouraria passaram**, incluindo a RPC manual existente, autoria/auditoria, histórico, zero versus ausência, restrições de perfil e sessão revogada. Nenhum schema foi alterado nesta entrega.
- A revisão corrigiu um estado de paginação que poderia exibir linhas da página anterior sob a página nova após falha de leitura. O cenário de página 2/HTTP 503 agora é testado e aprovado.

A inspeção HTTP do portal privado não forneceu acesso à origem. Isso não bloqueia o cadastro manual escolhido pelo usuário. Não houve acesso ao banco remoto ou uso de senha real nos testes. A publicação do código não comprova que o deploy remoto terminou ou que os valores reais foram conferidos pelo usuário.

O usuário também solicitou todas as informações do relatório diário da Diretoria e forneceu uma fórmula com referências M4/M12/M13/M14/M15/M16/M17/M49. A imagem está cortada na coluna das descrições. A fórmula exata e seu mapeamento não existem no exportador V75; foi solicitada a identificação das células. O novo cálculo não foi ativado, nenhum campo financeiro foi presumido e as regras existentes permanecem preservadas. Essa parte depende do Excel original ou das descrições completas: `docs/relatorio-diretoria-mapeamento.md`.

O retorno vazio de `pg_advisory_xact_lock` mostrado pelo usuário após a migration 012 é normal, mas não comprova isoladamente que todo o arquivo foi executado. Foi indicada consulta de leitura à quantidade de contas ativas, esperando 17. O resultado dessa consulta ainda não foi informado. O card manual usa a migration 006 e não exige repetir a migration 012 ou outro script.
