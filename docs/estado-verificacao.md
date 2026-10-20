# Evidências de verificação

18/10/2026. Estado de desenvolvimento e homologação; módulos financeiros ainda pendentes.

As seções iniciais preservam o histórico das versões anteriores. O estado mais recente está na seção de atualização 0.12.2 ao final; pendências antigas não substituem os relatos posteriores do usuário.

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

## Atualização 0.6.0 — relatório da Diretoria e fórmula sem M49

O usuário forneceu as descrições completas do relatório e retirou expressamente a célula M49 do cálculo. M4 é Faturamento Geral; M12 Caixa; M13 o mesmo recebível total de M8; M14 Estoque; M15 Mercadoria; M16 Parcelamentos; M17 Impostos do mês passado. O mapeamento anterior pendente foi substituído pela regra confirmada em `relatorio-diretoria-mapeamento.md`. Não foram carregados números das imagens como valores atuais.

Implementados: complementos diários oficiais em Importar Bases → Resumo da Diretoria, com oito campos opcionais, observação, revisão por data, confirmação, controle de concorrência, autoria oficial e auditoria. Caixa, CR, estoque e mercadoria usam suas bases centrais; os complementos não sobrescrevem essas fontes. Faturamento geral soma mês sem COMLURB e COMLURB quando ambos estiverem informados. O complemento de atraso COMLURB é limitado ao atraso central conhecido. A entrada manual de faturamento/pedidos não equivale à importação ou à implantação completa desses módulos.

O cálculo é server-side em numeric exato, sem arredondar os 14% intermediários, com resultado decimal em milhões transmitido como texto e somente formatado na interface. Cada fonte ausente permanece null; zero explícito e resultado negativo são válidos. Caixa e recebíveis não são duplicados. O relatório novo usa uma leitura consistente no banco, complementos apenas da data atual em São Paulo e mês anterior identificado para impostos. O período selecionado continua controlando o fluxo financeiro, separado da data da posição atual.

Novos snapshots preservam componentes, as 17 contas, complementos e versão da fórmula; a auditoria guarda o mesmo JSON. Os históricos anteriores permanecem inalterados. Histórico permite abrir indicadores salvos sem recalcular. Excel preserva os tipos nativos, adiciona a posição diária na sequência da imagem e memória do cálculo, com controle explícito do limite de precisão do Excel.

Verificações locais concluídas:

- Build TypeScript/Vite de produção aprovado, inclusive com versão 0.6.0.
- **21 grupos SQL novos passaram** em PostgreSQL local PGlite: preservação incremental, origem dos valores, RBAC, requisições diretas, sessão aprovada/bloqueada/expirada/revogada, concorrência, auditoria, rollback, histórico imutável, precisão exata, zero, negativo e componentes ausentes.
- A 013 exige a 012 antes de qualquer nova DDL; teste reproduz ausência da 012 e confirma rollback sem tabela/função/marcador novo nem alteração dos onze cadastros anteriores. Depois, 012+013 aplicam corretamente.
- **4 testes Node novos passaram**: decimal exato de PostgreSQL, zero e resultado mínimo, recusa de perda de precisão Excel, centavos seguros e ordem das contas sem excluir futuras inclusões.
- **67 testes de navegador passaram** na execução integrada de bancos, estoque, Painel e complementos: 16 do formulário novo, oito novos do relatório, 43 cenários existentes. Cobrem dados ausentes, datas, permissões, confirmação, falha incerta, revisões, XSS como texto, histórico, exportação de arquivo XLSX real sintético, tipos numéricos e as 17 contas.
- Revisão independente de regras, SQL e interface concluída. Corrigido antes da entrega um caso em que zeros decimais adicionais do PostgreSQL fariam resultado legítimo parecer indisponível; o valor é normalizado sem arredondamento. Screenshot local conferido visualmente com dados sintéticos.
- Migrations anteriores e arquivos combinados de ativação preservados. Lockfile mudou apenas a versão, sem alteração de dependências. Nenhum serviço pago, chave privada, dado legado ou senha foi adicionado.

A aplicação remota da 013, o término do deploy Cloudflare e a conferência com os valores operacionais reais não foram executados pelo agente. O usuário ainda deve confirmar a 012 e aplicar somente a 013 conforme `ativacao-resumo-diretoria.md`. O frontend mantém as consultas financeiras anteriores enquanto o relatório novo aguarda ativação. Não é necessário criar ou republicar Edge Functions nesta entrega. Permanecem os módulos completos e demais critérios de produção já listados; esta atualização não declara toda a Central concluída.


## Atualização 0.7.0 — operação, conferência e fechamento mensal de Contas a Pagar

O usuário confirmou que o relatório diário contém somente títulos em aberto e cheques, pediu atualização do mesmo título quando mudar valor, vencimento ou banco, pagamentos com valor/data/conta efetivos, consulta mensal por macro e conferência individual antes de fechar o mês. Confirmou que **CONCILIADO exige pagamento integral**. A orientação final substituiu expressamente a autorização anterior para pagamento parcial: **a operação atual aceita somente quitação integral**. Não são carregados valores das imagens, planilhas legadas ou números demonstrativos no banco operacional.

Implementados na versão: consulta **Mês dos títulos + Centro de Custo Macro → Exibir títulos**, paginação, filtros financeiros e de revisão; ações de pagamentos e conferência nas primeiras colunas; ledger auditado de valores realizados pela data efetiva, banco oficial e macro; estorno com motivo e histórico imutável; correções otimistas por título; revisão explícita A CONCILIAR/CONCILIADO e fechamento mensal com versões, reabertura e Excel histórico. O valor do pagamento é preenchido com o total pendente, sem edição para reduzir parcialmente. A migration018 impede pagamento parcial também na API/banco; preserva registros históricos anteriores e aceita apenas a quitação exata de seu eventual saldo. Diferenças exigem corrigir o título antes de confirmar.

A identificação por filial+número mantém o UUID, pagamentos e primeira importação quando a fonte atualiza valor, vencimento, descrição ou banco. Filial+número repetidos sem parcela identificável, versões antigas sem correspondência inequívoca e pagamentos ativos ligados a outra versão bloqueiam a operação. Revisão independente encontrou e corrigiu antes de publicar um caso em que a versão ativa seria escolhida mesmo havendo pagamentos noutra versão histórica. Nenhum pagamento é transferido nem versão financeira mesclada por inferência.

Baixa por importação continua separada de pagamento comprovado. Título só pode ser conferido depois de quitado exatamente, com sessão e permissão oficiais. Alterações comerciais ou financeiras invalidam a conferência e reabrem os meses de vencimento antigo/novo e de pagamentos afetados, com auditoria. A revisão não volta a valer se o usuário desfizer uma correção para o valor anterior. Importação idêntica, novo lote ou mudança técnica NEW→OPEN preservam a conferência. Versões antigas comprovadamente substituídas, baixadas e sem pagamentos ativos permanecem no histórico e no snapshot, sem exigir pagamento duplicado. Sem versão canônica comprovada, o sistema não faz exclusão automática.

Correções individuais de macro preservam o macro original dos pagamentos, acrescentam alocação efetiva auditada e exigem confirmação. O macro específico permanece nas importações do mesmo plano; mudança do plano encerra esse vínculo, sem ressuscitá-lo se o plano anterior retornar. Dados de valor, data e banco da fonte continuam sujeitos à atualização oficial. O fechamento guarda títulos pelo vencimento e realizados pela data real, incluindo títulos de outros meses; relatórios salvos não usam valores vivos para recalcular o passado. Nenhuma gravação de pagamento debita automaticamente o saldo manual de Caixa/Bancos.

A previsão mostra oito semanas sábado–sexta, cheques sem dupla soma, provisões dos dias 5/20 recuperadas do legado e regras com vigência, grupos vinculados explicitamente e conclusão mensal auditada. Ausência de base ou vínculo não definido fica pendente. O saldo real usa os pagamentos; abatimento de provisões considera títulos nominais conhecidos. Excel operacional contém detalhe, macros, comparação equivalente e realizados por pagamento; filtros são respeitados, arquivo de mês completo identifica sua abrangência e valores/datas mantêm tipos nativos. Exportações conferem revisões de importação e de alterações financeiras, recusando arquivos misturados ou perda de centavos no limite do Excel.

Ativação: `supabase/dashboard/ativar-contas-pagar.sql`, aplicando somente versões faltantes de 012 a 018 numa transação; atualizar a função existente `payables-import` para a mensagem segura P0016; publicar o frontend 0.7.0 no endereço atual. O arquivo pode ser repetido sem reaplicar migrations registradas. As migrations 001..013 permanecem inalteradas. A ativação não importa dados antigos, redefine usuários/senhas ou preenche saldos. Procedimento: [ativacao-contas-pagar.md](ativacao-contas-pagar.md).

A inspeção visual no Chromium confirmou os quadros de fechamento, histórico, consulta mensal e tabela paginada. A captura usa somente dados sintéticos; o aviso014 aparece porque o fixture dessa tela simula previsão ainda não instalada. As ações por título foram posicionadas antes das colunas extensas para acesso sem rolar a tabela horizontalmente.

Verificações locais da entrega:

- **98 testes Node aprovados**, incluindo configuração pública, parsing, gateways, recuperação e Excel. Os 18 cenários do helper Excel foram repetidos após o ajuste final dos textos de quitação integral.
- **138 cenários/grupos SQL aprovados** em PostgreSQL local PGlite:16 CP original,22 previsão,27 ledger incremental,22 identificação,29 conferência/fechamento,15 quitação integral e7 ativação combinada. As suites antigas preservam evidências do schema incremental; a 018 é a regra atual e impede novos pagamentos parciais.
- **72 cenários distintos de navegador verificados** com serviços sintéticos:39 de acesso/CP/previsão/Excel,16 de pagamentos na regra integral atual e17 de conferência/fechamento. A rodada final dos 33 cenários de pagamentos+fechamento passou; o caso de revisão do valor integral após atualização concorrente foi repetido e também passou, preservando data e observação.
- Build TypeScript/Vite 0.7.0 aprovado. Dependências não mudaram; lockfile alterou somente a versão. O aviso de chunks grandes do Excel permanece e as planilhas são carregadas separadamente. Tabelas e históricos têm paginação.
- O combinado real 012..018 foi testado na instalação faltante, com 012/013 já instaladas e em repetição. Falha no fim 018 reverte toda a ativação; registros antigos, auditoria, configurações e pagamentos permanecem inalterados. SHA256 do combinado congelado: `94388c4b270a099ca5ce07d7b4672c1ceba839ea3047903305032946a2278e79`.
- Uma consulta HTTP pública ao endereço do site voltou a receber `CONNECT tunnel failed, response 403` do proxy deste ambiente. Git continua sendo o meio de entrega autorizado; esse resultado não diagnostica a disponibilidade do site no navegador do usuário.

A execução remota do SQL, a atualização da função, os totais operacionais reais e o término do deploy da Cloudflare ainda precisam ser confirmados no provedor. O Git publica código, não executa SQL ou funções. A integração Deno hospedada não foi homologada neste ambiente. Nenhum serviço pago ou credencial privada foi solicitado. Faturamento, Margens, Comissões, RH/DP completos, administração Auth completa, backups/restauração e migração conferida do estado operacional antigo permanecem pendentes; esta entrega não declara toda a Central pronta para produção.


## Atualização 0.7.1 — modelo do relatório de Contas a Pagar

O usuário apresentou a imagem do relatório e confirmou o nome completo da coluna E como `Emissão: valor do lançamento`, além da presença de `Filial` e `Situação`. O parser CP passou a reconhecer os cabeçalhos ERP exatos de plano CP, conta CC, valor, emissão e vencimento; formatos anteriores continuam aceitos. O horário é validado somente nas colunas ERP de data e convertido para o mesmo dia civil informado, sem deslocamento de fuso. O parser compartilhado usado por CR permanece estrito para data sem horário.

O formulário descreve a correspondência das colunas e mostra uma prévia de até dez títulos derivados pelo servidor antes da conclusão. Essa prévia limita apenas a renderização, não a importação. O banco/conta da fonte fica separado do banco efetivo de pagamento; filial continua explícita, sem inferência. Classificação por Macro, relatório completo, arquivo original privado e confirmação permanecem obrigatórios. Nenhuma regra de pagamento, fechamento, conta ou autorização foi alterada.

Build de produção, **106 testes Node** e **7 testes Chromium de CP** passaram. Foram acrescentados seis cenários de parser e dois de gateway, com CSV/XLSX reais sintéticos, nomes confirmados, centavos, horários, conta/plano separados, coluna obrigatória ausente, duplicidade e recusa integral. A suíte de CR passou sem mudança no parser compartilhado. O gateway também prova leitura de linha oculta do Excel e preservação dos bytes/hash originais. O cenário novo de navegador percorre seleção de XLSX, worker, análise do servidor e prévia; a conclusão fica bloqueada até classificar o plano.

Não há migration nem dados reais novos. O gateway único foi regenerado para publicação na função existente `payables-import`; é necessário atualizar esse código além do frontend 0.7.1. Não é necessário republicar `auth-gateway` ou a função de CR. O arquivo operacional real e seus totais ainda não foram homologados; a função Supabase e o término do deploy não foram verificados remotamente. Guia: [modelo-importacao-contas-pagar.md](modelo-importacao-contas-pagar.md).


## Atualização 0.8.0 — resumo gerencial e pagamentos pelo relatório do ERP

A regra mais recente substitui a operação manual anterior: a equipe continua registrando no sistema de origem e importa o relatório na Central. Primeira base/novos títulos e revisões da previsão são incrementais; pagamentos são confirmados por arquivo explícito de títulos integralmente pagos. A rotina informada é segunda-feira para previsões, terça a sexta para pagos, permitindo reprocessar em outro dia. Ausências não baixam títulos. Após a 021, as APIs legadas também adotam essa regra.

O usuário confirmou que no relatório de pagos **Vencimento: data é a data real de pagamento**, **Emissão: valor do lançamento é o valor integral pago**, e a conta efetiva vem do relatório. A importação preserva o vencimento previsto, atualiza o nominal pelo integral informado, mantém a identidade filial+número e audita o valor anterior. Histórico/plano informados atualizam; ausentes ou vazios preservam. Emissão ausente preserva e coluna vazia limpa. O número de cheque vem somente de **Cheque: número**, como texto com zeros à esquerda; coluna ausente preserva, vazia limpa.

O Contas a Pagar abre no resumo: previsto/realizado por 14 Macros na semana sábado–sexta, total mensal independente da semana, saldo semanal, todo o saldo futuro sem limite de oito semanas, vencidos e cheques sem soma duplicada. A consulta por período e Macro usa a data efetiva dos pagamentos e permite abrir cada título. O previsto representa o valor atual dos títulos por vencimento, não uma previsão histórica congelada. Falta de fonte permanece desconhecida, separada de zero.

Pagamentos válidos importados ficam CONCILIADOS automaticamente, com revisão auditada. Bancos e planos desconhecidos exigem vínculo oficial uma vez. Nova importação com dados já registrados reutiliza o pagamento; mesmo arquivo pago retorna idempotente, sem novas gravações. O hash é único por escopo e modo: bytes idênticos podem primeiro representar previsão e depois pagamento explicitamente declarado, sem duplicar o realizado. Correção de pagamento importado exige uma confirmação do arquivo, estorna o registro anterior e cria outro integral. Mudanças explícitas de cheque também participam dessa comparação. Conflitos com pagamentos manuais, identidade ambígua e títulos desconhecidos bloqueiam a operação inteira.

A revisão financeira oficial é obrigatória para novo arquivo pago e detecta edição concorrente; após validar identidade/sessão/permissão, replay de hash já registrado retorna sem alterar dados. O gateway relê o arquivo e só aceita dados financeiros derivados no servidor. Capacidades 019/021 ausentes bloqueiam a operação correspondente sem recorrer ao modo antigo. Helpers privados e commits exclusivos do serviço continuam protegidos, com RLS e leitura da Diretoria sem escrita. Os saldos bancários manuais não são debitados automaticamente.

Verificação local desta entrega:

- **131 testes Node aprovados**, com parser CP/CR, gateways, configuração pública e Excel. Cobrem XLSX/CSV sintéticos do ERP, datas reais, zeros do cheque, dados opcionais, permissões, payloads adulterados, capacidades e revisão financeira obrigatória.
- **107 casos distintos de navegador aprovados**, em Chromium: 12 do resumo, 12 da importação paga, 20 de pagamentos, 21 de fechamento e 42 regressões de CP, previsão, exportação e acesso. Algumas expectativas antigas de texto foram ajustadas e repetidas; não permaneceram falhas. Incluem filtro por Macro com total específico, mês independente, abertura individual, requisição de pagamento preservada ao alterar período, erros e resultado incerto.
- **16 cenários SQL 019**, **19 cenários SQL 020**, **32 cenários SQL 021** e **15 regressões SQL 018** aprovados. Testam preservação de registros, centavos, datas reais, modos, reimportação, correções nominais 100→120→130 com quitação integral, bancos/planos, cheque, revisão, idempotência, concorrência, rollback, permissões e revogação.
- **11 cenários do combinado SQL 012..021 aprovados**: aplicação parcial, repetição segura, preservação, rollback integral, previsão incremental, pagamento automático, hash idempotente e correção auditada. Artefato final SHA256 `8dac80b82be96a6fff7c04ba2a9cb1469f191b0b0f24fe1119022e34202313b1`.
- Build TypeScript/Vite **0.8.0** aprovado. Captura sintética do resumo inspecionada: seletores, cinco cards, consulta por período/Macro e tabela dos 14 Macros sem sobreposição.
- Migrations **001..018 inalteradas**; novas 019..021 incrementais. Lockfile mudou somente a versão. Nenhuma base real, senha, chave privada, dependência nova ou serviço pago foi adicionado.

Ativação remota pendente: executar `supabase/dashboard/ativar-contas-pagar.sql` no SQL Editor; atualizar **Code** da função existente `payables-import` com o arquivo `.ts` gerado; aguardar o frontend 0.8.0 na Cloudflare. O endereço e os dados são preservados. SQL e TypeScript têm destinos diferentes; não colar a função no SQL Editor. Não é necessário criar outra função ou repetir a instalação inicial. O envio do código não comprova execução do SQL, publicação da função, término do deploy ou conferência com relatórios operacionais reais. Os demais módulos e critérios de produção pendentes permanecem no escopo documentado.

## Atualização 0.9.0 — recebíveis do ERP, cobrança e base de comissões

O usuário forneceu dois relatórios reais separados: abertos/vencidos e quitados. Confirmou que somente vencidos alimentam Cobrança, que quitados saem da carteira ativa e que a base da comissão é **Quitação: valor recebido**. Não existe código único de título/parcela exportável. Solicitou também atraso, total a receber e recebido diário no Painel da Diretoria, além da recuperação das funções de Cobrança da V75.

Implementados: dois modos explícitos de importação com análise dos bytes originais no servidor, atualização incremental, identidade filial/cliente/documento/vencimento, valor atualizável e vínculo explícito para parcelas ambíguas. Ausência no relatório não baixa nem marca como pago. Quitados registram nominal e recebido separadamente, data real, antecipações e diferenças; validam o título e removem-no da cobrança ativa. Repetição não duplica recebimentos. Correções de importação exigem confirmação e acrescentam versões imutáveis, mantendo a origem e o histórico. Conflitos com recebimentos manuais impedem alteração automática. Revisão financeira oficial obrigatória evita confirmar uma prévia desatualizada.

Cobrança recupera totais, carteira por responsável, faixas de atraso, próximos contatos/retornos, filtros e acesso individual com histórico e ações existentes. A carteira ativa contém somente vencidos anteriores à data oficial de São Paulo; o banco também aplica esse limite às ações. Responsáveis conhecidos são preservados/herdados quando inequívocos; não há atribuição fictícia a quem importa. O Painel mostra os três indicadores pedidos, com recebido diário independente do período selecionado e do relógio do computador. Comissões consulta o valor efetivamente recebido por período e responsável, incluindo pendências de atribuição; **percentuais, vigências, cálculo e pagamento de comissão ainda não foram definidos ou implementados**.

Verificação local desta entrega:

- **151 testes Node aprovados**, sem falhas ou casos ignorados: parsers de CP/CR, gateways, permissões, capacidades, bytes originais, datas, centavos e configuração pública.
- **86 cenários/grupos SQL aprovados** em PostgreSQL local PGlite: 16 de cobrança somente vencida, 22 de sincronização dos abertos, 24 de recebimentos/correções, 14 do resumo de cobrança e 10 da ativação combinada. Incluem identidade, concorrência, idempotência, RLS, leitura da Diretoria, sessões, rollback e preservação dos dados existentes.
- **114 cenários distintos de navegador aprovados** com respostas sintéticas: 15 do Painel de recebíveis, 29 regressões de tesouraria, seis da base de comissões, 11 de importação dos abertos, 11 de quitados, 22 da operação CR/Cobrança, 11 do novo resumo de cobrança e nove de acesso. Após os ajustes finais, repetiram-se os 15 cenários do Painel e três casos focados de importação. O relógio incorreto do computador não altera a referência diária oficial; a data inválida do servidor é recusada.
- Build TypeScript/Vite final **0.9.0 aprovado**. Os avisos conhecidos de tamanho dos chunks do leitor Excel permanecem. Nenhuma dependência foi acrescentada; lockfile mudou somente a versão.
- Os arquivos fornecidos foram analisados sem renomear colunas: **962 linhas abertas/vencidas e 178 quitadas**, sem erros de parsing. Um ensaio financeiro em banco local isolado conferiu os totais com as fontes, a validação dos quitados, a base pelo valor recebido, a preservação de responsáveis desconhecidos e a repetição sem duplicação. Nesse ensaio técnico, 27 parcelas históricas ambíguas foram explicitamente tratadas como novas; isso **não homologa o vínculo operacional dessas parcelas**. Nenhuma linha financeira desses arquivos foi incorporada ao Git ou enviada ao banco de produção.
- As migrations **001..021 permanecem inalteradas**. O novo combinado 022..025 exige CR/Cobrança 009, sem depender de CP 021, e aplica somente versões faltantes numa transação. Foram verificados instalação parcial, repetição e rollback integral após falha final, preservando usuários, permissões, saldos, CP/CR, arquivos e auditoria. SHA256 do combinado: `eed23f84458d139e8c7a7a7e775ee203eee32306d16297b7b5ad8b4f3e4cb7b1`.

Ativação remota ainda necessária: executar **ativar-recebiveis-operacao.sql** no SQL Editor; atualizar **receivables-import → Code → index.ts** com o arquivo único TypeScript; aguardar o site 0.9.0 na Cloudflare. Guia: [ativacao-operacao-recebiveis.md](ativacao-operacao-recebiveis.md). Publicar Git não aplica essas alterações do Supabase. O agente não executou SQL/importações em produção nem verificou o runtime Deno hospedado ou o término desse deploy. A conferência operacional, as atribuições desconhecidas e as regras de comissão continuam pendentes. Faturamento, Margens, RH/DP e os demais requisitos de produção ainda não entregues permanecem no escopo documentado.

## Atualização 0.10.0 — Central de Cobrança operacional da V75

O usuário esclareceu que a aba é uma central de atendimento e forneceu a imagem do programa original: quatro abas, lista e atendimento lado a lado, responsável/status, observação, próxima ação/data e cronômetro. A inspeção identificou o patch final da V75 (2190–2298), que substitui as funções anteriores. Recuperaram-se os dez status operacionais e as exigências de finalização; não foram copiados clientes, valores, usuários ou tempos embutidos no HTML antigo.

Implementados: **Visão geral**, **Títulos**, **Validação financeira** e **Tempo de trabalho**. A lista possui busca por cliente/documento/status/observação, responsável, faixas e ordenação, com total calculado sobre todos os resultados filtrados. O atendimento lateral oferece rascunho central, status operacional separado do financeiro, contato/agenda, histórico, início/pausa e finalização atômica com o encerramento do próprio intervalo. Marcar como pago solicita os dados; somente finalizar informa o pagamento, que continua pendente até confirmação financeira ou importação dos quitados. A Diretoria permanece em leitura. Atribuições usam o caminho oficial existente, sem redistribuição silenciosa.

O cronômetro usa horários e intervalos do servidor, com um atendimento ativo por pessoa. Seu protocolo pode ser repetido sem duplicar; envios incertos conservam o mesmo UUID. Após recarregar, o intervalo próprio continua recuperável fora dos filtros, inclusive quando o ERP reagenda o vencimento para o futuro. Isso permite pausar sem ler o título inelegível. O relatório usa o ator e a responsável histórica, exclui pausas, reparte intervalos nos dias de São Paulo e preserva o tempo histórico após mudança de vencimento/carteira. A importação de quitados encerra o intervalo no momento da validação, sem modificar recibos ou saldos.

A revisão reproduziu e corrigiu antes da publicação dois riscos: preservação de rascunho com revisão nova poderia sobrescrever andamento concorrente sem conferência; agora a escrita fica bloqueada até escolha explícita entre dados do banco e rascunho. Um título reagendado para o futuro poderia desaparecer da lista e deixar um timer impossível de pausar após recarregar; a consulta retorna separadamente somente a referência e o tempo do próprio ator. Outra revisão independente não identificou bloqueador de segurança nas novas operações.

Verificações locais desta entrega:

- **151 testes Node aprovados**, sem falhas ou casos ignorados, preservando parsers, gateways, configuração pública e exportação financeira existente.
- **27 cenários SQL da 026 aprovados** em PostgreSQL local PGlite: preservação, carteiras, datas, rascunho versus contato/pagamento, revisão otimista, comandos idempotentes, finalização/rollback, sessões aprovadas/revogadas, leitura da Diretoria, tabelas protegidas, tempo próprio por ator, snapshots históricos, busca e legado, fracionamento da meia-noite, recuperação de intervalo fora da lista e integração com recebimentos. Finalizar título pago remove a agenda anterior e encaminha para validação, preservando as versões; não cria recibo.
- **13 cenários do combinado 022..026 aprovados** após a última alteração da 026: preservam os dez cenários anteriores e acrescentam atualização de 0.9 com recebimento corrigido, falha final com rollback de DDL/funções/policies e operação real de timer/atendimento. Instalação parcial e repetição preservam dados e timestamps anteriores. SHA256 final: `feee429c02d4f9e7b769e17f4462a6707f68573a1a5989435389eec72d59a8fa`.
- Build TypeScript/Vite final **0.10.0 aprovado**. **19 casos distintos de navegador do atendimento passaram** com respostas sintéticas, incluindo busca/paginação, timer persistente, rascunho, pagamento pendente, permissões, recuperação do envio incerto com o mesmo UUID, revisão concorrente e timer fora da lista após recarregar. Após os ajustes de apresentação, repetiram-se dois casos focados de layout/histórico na build final. Ambos passaram; horários das duas fontes de histórico foram conferidos em São Paulo, inclusive mudança de dia em relação ao UTC.
- **15 casos distintos de navegador de validação/tempo aprovados** na build final: 11 passaram na primeira rodada; quatro foram repetidos e passaram após correções somente de seletores/expectativas dos testes. Cobrem confirmação/data real, não localizado com a mesma responsável, pagamento já validado, permissões, falhas, período oficial do servidor, filtros, paginação e privacidade. Relógio incorreto do computador não impede data civil aceita pelo servidor; o backend recusa recebimento futuro. Nenhuma regra financeira ou fonte de produto foi alterada durante essa verificação.
- **42 regressões de navegador aprovadas** na build final, sem falhas: 11 da gestão de cobrança, 22 de operações de recebíveis e nove de acesso. As verificações de CR foram preservadas; os cenários de Cobrança passaram a usar as quatro abas e os contratos novos, mantendo carteira própria, Diretoria em leitura, pagamento pendente, datas de São Paulo, respostas inválidas, exportação com duas conferências de versão e ausência de localStorage. A entrega soma **76 casos distintos de navegador aprovados**, além das repetições focadas descritas acima.
- Capturas sintéticas desktop/mobile foram inspecionadas: editor compacto com campos em duas colunas no computador, tabela com Cliente/Abrir acessíveis durante a rolagem, abas em duas linhas no celular e editor em coluna única. As capturas e os registros de teste ficam fora do Git; não contêm dados operacionais.
- As migrations **001..025 permanecem inalteradas**. A 026 acrescenta somente operação/tempo; não muda regras financeiras, taxas de comissão, senhas, saldos ou recibos. Nenhuma dependência nova; lockfile altera somente a versão.

Ativação remota ainda necessária: executar o combinado atualizado **ativar-recebiveis-operacao.sql** e aguardar o frontend **0.10.0**. Quem já instalou 0.9 recebe somente a nova 026; a função `receivables-import` permanece a mesma. Guia: [central-cobranca-operacao.md](central-cobranca-operacao.md). Não foi executado SQL no provedor nem verificado o término do deploy por este agente. Não há novos dados operacionais de demonstração ou tempos históricos presumidos. Permanecem as homologações remotas e os demais módulos/requisitos de produção ainda pendentes.

## Atualização 0.11.0 — contatos e descrições exclusivos da Cobrança

A orientação final do usuário restringe as descrições ao atendimento da Cobrança. A base de apoio pode conter abertos vencidos e a vencer, mas contexto e RLS só permitem consultar referências de títulos ativos estritamente vencidos na carteira autorizada, inclusive para a Diretoria. Contas a Receber e Comissões não receberam esses campos. Notas/filiais iguais com clientes diferentes não são unidas.

Implementados: contatos compartilhados por órgão, múltiplos canais, ausências explícitas, revisão manual, auditoria e diretório com exportação completa dos filtros. A identidade vem do título autorizado; alterações humanas, inclusive campos apagados, são preservadas nas importações seguintes. A lista inicial também cadastra contatos válidos sem dívida atual para uso por títulos futuros, mantendo-os invisíveis enquanto não houver cobrança autorizada. Nomes que possam corresponder a identidades com CNPJ ficam pendentes.

Importar Bases recebe uma área autorizada para os dois arquivos de apoio. O original de até 16 MiB vai diretamente ao Storage privado; worker independente lê XLSX em streaming e prepara CSVs de até 500 linhas/256 KiB. O gateway valida a sessão antes do conteúdo, confere bytes/hash do original, interpreta os CSVs no servidor e preserva os artefatos privados. Essa evidência não equivale a reinterpretar o Excel original inteiro no Edge. A confirmação publica tudo em uma transação; repetições preservam o mesmo protocolo. Nenhuma importação de apoio cria ou altera dívidas, valores, recebimentos, responsáveis ou tempos.

Verificação local desta entrega:

- **196 testes Node aprovados**, incluindo 19 do parser e 26 do gateway dedicado, além das verificações anteriores.
- **33 cenários SQL novos aprovados** nas migrations 027/028, com RLS, sessão, propriedade dos arquivos, original obrigatório, lotes e linhas canônicas idempotentes, revisões, rollback, variantes, limite agregado de canais, proteção humana e herança dos contatos por títulos posteriores.
- **17 cenários do ativador combinado** verificam instalação incremental, preservação de dados/casos/cronômetros, falha 028 com rollback das políticas/bucket e repetição sem refazer cadastros ou proveniência.
- **327 cenários distintos de navegador aprovados.** A execução integrada aprovou 325; dois testes antigos interromperam por falta de resposta simulada para a nova consulta opcional. Após acrescentar a resposta de banco anterior, os 22 cenários de recebíveis foram repetidos e aprovados. As 32 verificações novas cobrem atendimento, permissões, rascunhos, revisão concorrente, CSV, arquivo superior a 2 MiB/5 mil linhas, retomada e confirmação incerta.
- TypeScript e build de produção aprovados. O worker de apoio possui 16,68 kB; não carrega ExcelJS. Asset principal: `index-CMjI3Xbz.js`.
- Os dois anexos reais foram processados somente nesta máquina, com original e dados fora do Git. Também foi usado PostgreSQL local descartável para medir o caminho completo sobre a base grande, sem chamadas aos provedores nem persistência de dados reais no repositório. Resultados finais de capacidade e hashes constam abaixo.

O combinado condicional agora inclui 022..028; versões existentes permanecem intactas. Em uma base 0.10.0, instala somente 027/028. A função nova é **collection-reference-import**. O [guia de ativação](cobranca-contatos-descricoes.md) separa SQL Editor, Edge Functions e importação no sistema.

A verificação usa Auth/Storage simulados e PostgreSQL PGlite local. Não comprova desempenho do plano hospedado nem ativação remota. Publicação no Git não aplica SQL ou publica funções no Supabase. Os arquivos reais ainda precisam de importação confirmada na Central após a ativação; nenhum dado do chat foi carregado em produção pelo agente.

Capacidade medida com os dois anexos, em PGlite descartável e sem tráfego remoto:

| Operação | Descrições (~64 mil registros únicos, 128 lotes) | Contatos (9 lotes) |
| --- | ---: | ---: |
| Leitura e preparação dos lotes | 29,22 s | — |
| Análise oficial | 3,55 s | 0,31 s |
| Publicação transacional | 3,24 s | 0,63 s |
| Nova análise | 3,13 s | 0,27 s |

O tempo de preparação dos contatos não foi incluído nesta comparação final. A otimização recalcula o vínculo atual e grava somente classificações alteradas; não usa um resultado antigo para dispensar a conferência financeira ou a proteção manual. A análise anterior regravava todos os registros e levava cerca de 9–10 s. O experimento local demonstra capacidade da implementação, sem garantir os mesmos tempos no plano Supabase. Nenhuma dívida/revisão financeira foi alterada pela importação de apoio.

Hashes SHA256 dos artefatos finais:

- Migration 027: `9f8492031c86d95c439deb986499cd0595e1c1903a3975cc50c29b6df410a709`.
- Migration 028: `76b86bd4c2a086fc56a7c3a4405f214dd0d862e9ca9c6d72526e4ca384b098d0`.
- Combinado 022..028: `4279adc5a03be12d24a9848f7e76df1ba2a3b13678637e2657c285b3be2c82cf`.
- Gateway único: `827d45692ac9f455382ee339dd2e37b509200b735f898843e8c6cf15e0e4ac97`.

## Atualização 0.12.0 — atendimento, retornos e responsáveis na importação

O usuário relatou que Iniciar, Pausar e Salvar andamento estavam desabilitados, sem mensagem, e informou que a responsável deve ser definida na importação. A implementação acrescenta escolha explícita por cliente no relatório de abertos e mantém as carteiras existentes nas atualizações diárias. Não foi presumido vínculo entre quem importa e uma cobradora. Sem acesso administrativo remoto, a causa exata no banco de produção não foi confirmada; o estado sem responsável observado pelo usuário é tratado pelo novo fluxo.

A 029 mantém pausa e rascunhos, exige um ciclo iniciado ainda não finalizado para encerrar atendimento e separa a agenda oficial de rascunhos. Retornos de hoje ou atrasados, pela data de São Paulo, têm prioridade na carteira da responsável do título; filtros locais e carteiras de outras pessoas não alteram esse bloqueio. A abertura do portal apresenta o total e os primeiros cinco retornos, além do intervalo próprio recuperado. Os controles explicam ausência de responsável, pendência financeira, leitura, ausência de alterações, atualização necessária e confirmação em andamento.

Pagamento informado exige observação e data real até hoje; a data é acrescentada pelo servidor. Finalizar ou marcar como pago encerra o intervalo e encaminha à validação de Contas a Receber, fora da fila ativa. Salvar rascunho pago não confirma recebimento nem encaminha ao financeiro. A conferência mostra o relato original separado da justificativa financeira. Não localizado mantém a responsável e o relato anterior, devolve o título com próxima ação para hoje e não cria recebimento. A confirmação continua usando as regras financeiras existentes; não há percentuais ou pagamento de comissão presumidos.

A 030 acrescenta prévia e conclusão autorizadas para responsáveis na importação de abertos. Somente clientes ativos sem vínculo recebem escolha; responsáveis existentes, vínculos bloqueados, títulos quitados e recebimentos são preservados. O arquivo original é reinterpretado no gateway. Um arquivo já importado pode completar vínculos ausentes sem criar outro lote financeiro. Atribuições são transacionais, auditadas e exigem uma análise vigente; repetições preservam o resultado. O frontend exige nova análise após alterar escolhas e preserva arquivo/modo/parcelas em resposta incerta. Se quitação ou mudança oficial tornar uma escolha obsoleta, uma nova consulta somente de leitura permite revisar os vínculos ainda necessários, sem liberar outro arquivo ou alterar recebimentos.

Validações locais desta entrega:

- **206 testes Node aprovados**, incluindo dez novos testes do gateway de recebíveis; preservados os limites financeiros, autorização, interpretação do original e os modos antigos/quitados.
- **24 cenários SQL da 029**, **18 da 030** e **23 do combinado** aprovados em PostgreSQL local descartável, com dados sintéticos. Incluem sessão/perfil/carteira, prioridade, pausa, rascunho, fechamento, pagamento, recusa, importação e correções existentes, atribuição idempotente, rollback integral e preservação de arquivos privados/contatos/tempos.
- **376 cenários distintos de navegador aprovados no conjunto das execuções locais**, com respostas sintéticas. A passagem geral executou 374: 356 passaram e 18 identificaram fixtures/seletores desatualizados ou leituras assíncronas ainda em andamento. Foram corrigidos sem retirar as verificações de valores, carteiras, permissões e repetição segura. Na build final passaram **70 casos** de atendimento, retornos, validação e importações, incluindo dois novos de recuperação; depois passaram **11 regressões focadas**, cobrindo os casos restantes da passagem geral. Nenhuma falha ficou pendente. A passagem geral inteira não foi repetida após os ajustes específicos.
- Build de produção e TypeScript aprovados. As migrations **001..028 permanecem inalteradas**.

Hashes SHA256:

- 029: `0471c84f89a89a0810d78896e392b0599158af5a750071e6ef8142d27c1ca0b3`.
- 030: `6b2093f97ac98ee2a2992eca0bbbf7ab1e1dffe79e65158e3883f5fd112d6ed3`.
- Combinado 022..030: `2071e417b7193d31531cfd98569aefbbbf6492ededb3b7952034ca9cc3b34660`.

Ativação remota necessária: executar **ativar-recebiveis-operacao.sql**, atualizar a função existente **receivables-import** e conferir o site **0.12.0**. Depois, reimportar o relatório de abertos e escolher as responsáveis ausentes. [Guia de ativação e uso](cobranca-atendimento-retornos.md). Não foi executado SQL, importado arquivo real ou publicado gateway no Supabase pelo agente. Não há novas credenciais, nomes presumidos ou alterações financeiras de demonstração em produção. Os demais módulos e critérios de homologação pendentes continuam registrados nas seções anteriores.


## Atualização 0.12.1 — ações visíveis e responsável somente para consulta

O usuário relatou que Finalizar atendimento e Marcar como título pago haviam desaparecido. A condição de renderização dependia de o título estar editável; por isso os controles sumiam quando faltava a ativação 029, não havia responsável ou o título estava em leitura financeira. As ações agora permanecem visíveis para operadores autorizados ao abrir o título, desabilitadas com explicação enquanto houver bloqueio. O motivo também está associado aos botões para leitores de tela. Os acessos de consulta continuam sem comandos de escrita e as guardas existentes continuam exigindo o ciclo iniciado e os demais requisitos.

A pedido do usuário, Gerenciar responsável foi retirado de dentro do atendimento, junto com seu formulário, estado e chamada de atribuição. A responsável oficial permanece visível em campo somente de leitura, conforme o vínculo definido na importação. A orientação de título sem responsável passa a indicar somente Importar Bases. A operação de importação e os cadastros fora desse atendimento permanecem com os contratos existentes.

Build de produção/TypeScript e **46 cenários de navegador** aprovados na fonte final. As regressões conferem controles visíveis e desabilitados nos casos sem atualização, sem responsável ou em validação, conclusão após início/pausa, pagamento, acesso de Diretoria, carteira oficial somente para consulta e ausência de formulário/chamada de atribuição dentro do atendimento. Os dados e serviços são sintéticos locais.

É uma correção do site que utiliza as mesmas migrations 029/030 e o mesmo gateway da 0.12.0. Não foi criado novo SQL ou alterado dado financeiro em produção. A publicação Git aciona o deploy da Cloudflare; o agente não aplicou atualizações no Supabase nem confirmou o término do deploy público.


## Atualização 0.12.2 — Diretoria somente para consulta

O usuário solicitou novo acesso da Diretoria, com todas as abas exceto Importar Bases e nenhuma alteração de informações. Confirmou que a conta ainda não foi criada em Authentication. O cadastro remoto não foi executado pelo agente: não há conector nem credencial administrativa disponível neste ambiente. A senha solicitada não foi incluída em arquivos, SQL, testes ou commits. O guia orienta criar a conta pelo Supabase Auth e vincular o User UID em Administração, com perfil Diretor ativo; o login depende dessas etapas.

A 031 remove a antiga exceção de escrita em mensagens e o acesso a Importar Bases, preserva consultas/exportações financeiras e permite leitura de usuários, cobradoras e auditoria. O bloqueio de ações além de read/export e de qualquer acesso à importação também é aplicado em has_permission e current_access, mesmo diante de concessões antigas reinseridas. Novas políticas administrativas concedem somente SELECT ao perfil oficial ativo, com sessão aprovada. RPCs de administração continuam exclusivos da Gerência.

O frontend usa a mesma barreira no helper de permissões. A Diretoria pode navegar e consultar todas as abas, incluindo a Administração, sem formulários ou comandos de alteração. A Gerência mantém cadastro, vínculos e envio de mensagens. Filtros, consultas e exportações continuam disponíveis. O novo acesso não torna funcionais os módulos que permanecem em preparação.

Validação: build de produção/TypeScript, 206 testes Node e 14 cenários SQL da 031 aprovados. A suíte SQL aplica 001..030 antes da 031 em PostgreSQL local descartável, comprova preservação dos dados/auth/perfis e dos demais acessos, bloqueia mutações e concessões antigas, verifica sessões ausentes, expiradas, revogadas e perfis desabilitados e confirma repetição sem alterações extras. Revisão independente não encontrou bloqueadores de autorização ou recursão de RLS.

No navegador, foram verificados os dez casos de acesso e seis novos de Diretoria. A primeira execução teve 15 aprovados e um seletor que apontava para o cronômetro oculto de outra aba; foi corrigido e o caso passou. A bateria de 50 cenários relacionados à Diretoria teve 47 aprovados e três helpers antigos que ainda tentavam navegar para Importar Bases, agora corretamente indisponível. Os helpers foram atualizados sem remover as verificações de ausência de gravações/importações. A execução final focada de **13 casos passou**, incluindo esses três casos, as outras funções nos mesmos fluxos e uma importação autorizada de CP. Os seis novos casos confirmam as nove abas e a Administração em leitura, bloqueios mesmo com concessões antigas, mensagens, pagamentos, validação, contatos e tempo de trabalho. Nenhuma falha permanece pendente; a suíte inteira não foi repetida após esses ajustes de testes.

A migration e o ativador avulso têm o mesmo SHA256: 8688fe40812728185c54848b879463cadce87800bd709b8edf44846d30cf4d32. As migrations 001..030 e o combinado anterior permanecem intactos. Ativação separada por dashboard/ativar-acesso-diretoria.sql; não exige nova Edge Function. [Guia de ativação e cadastro](acesso-diretoria.md). Publicação Git, aplicação SQL, criação Auth, vínculo do perfil e conferência do login são etapas distintas; o agente não confirmou execução remota delas.


## Recuperação das quatro abas restantes da V75 — 0.13.0

Solicitação: recuperar Comissões (cobradoras e vendedores), Faturamento, Margens e RH/DP do arquivo original, preservando a base central existente. O usuário confirmou margem mínima de Mateus e Kevyn de 10% em setembro/2026 e 14% a partir de 01/10/2026.

Implementação: fechamentos mensais completos versionados, consultas com filtros e detalhes, Excel integral do filtro; posições privadas de RH, salários base/folha separados, política da cesta e calendário; regras de comissão com vigência, vínculo explícito de pessoas reais, faixas originais, recebimentos efetivos validados de títulos trabalhados e apurações imutáveis. As regras confirmadas dos vendedores são recuperadas atomicamente em duas vigências. Fonte/custos desconhecidos ou limites sem taxa consistente ficam pendentes; nenhuma comissão é paga automaticamente.

A nova função business-import autentica o usuário e a sessão aprovada antes de analisar o arquivo, relê os bytes originais na prévia e confirmação, mantém o original privado e revalida permissões no commit. Repetição não duplica; correções preservam versões; prévia concorrente é recusada. A posição oficial de RH usa a maior data de referência, sem promover uma importação histórica. Faturamento permanece acessível ao RH sem disponibilizar custos ou margens. A Diretoria continua somente em consulta. Migrations 001..031 permanecem inalteradas.

Verificação local de 19/10/2026:

- Build TypeScript/Vite aprovado, sem dependências novas. Permanece o aviso de tamanho dos chunks; não impede a geração.
- **231 testes Node aprovados**, incluindo normalização, centavos exatos, salários repetidos, limites, sessão/origem e análise canônica do novo gateway.
- **40 testes SQL aprovados**: dez comerciais, dez RH, dezesseis comissões e quatro do combinado. Banco PostgreSQL descartável com a base existente, preservação de registros, RLS/permissões, original privado, vigência setembro/outubro, correções, apuração histórica e repetição da ativação sem mutações.
- **42 cenários distintos de navegador aprovados**: nove comerciais, seis RH, onze comissões, dez de acesso e seis da Diretoria. Incluem filtros/paginação, detalhes, exportação completa, original/confirmacão, configuração, regras confirmadas, campos financeiros ausentes e ausência de controles de alteração para a Diretoria. A primeira execução encontrou JWT sintético inválido e seletores de teste inadequados para selects; os fixtures foram corrigidos e os cenários afetados repetidos com sucesso. O acesso comercial de RH com campos confidenciais omitidos também foi corrigido e validado. Telas sintéticas de RH e Faturamento foram inspecionadas; viewport de 390px não causa transbordamento horizontal da página.
- Artefatos gerados e conferidos: dashboard/ativar-demais-abas.sql (**2a47e40c199468fa28dc9a9aaae023a47742376f27bd6ff5f7889df8fd033b1b**) e dashboard/business-import.ts (**97610cea661e5a46764647ec3a4ef31eb9c25cb965a8fb4509214360f30baaed**).

Limites: o agente não executou SQL nem publicou Edge Functions no projeto remoto, não importou bases reais e não comprovou o término do deploy Cloudflare. Os bytes e registros históricos embutidos no HTML privado não foram publicados ou usados como posição atual. O Resumo da Diretoria e a fórmula sem M49 mantêm suas fontes atuais; a aba de Margens consulta o fechamento importado. Pagamento de comissões, migração conferida do estado operacional anterior e backups continuam fora desta entrega. Ativação e uso: [ativacao-demais-abas.md](ativacao-demais-abas.md).


## Correção do modelo real de RH / DP — 0.13.1

O usuário mostrou os cabeçalhos FILIAL, ADMISSAO, ANIVERSARIO, Salário Base, VT TOTAL, Salário, Adiantamento, Ajuda de Custo, SETOR e Funcionário. Confirmou que células vazias em VT, adiantamento e ajuda significam zero. O parser anterior confundia Salário Base com o primeiro Salário genérico e não tinha campo de ajuda de custo; o modelo misto era recusado como ambíguo.

A correção dá prioridade aos nomes de salário e completa os campos genéricos restantes na ordem base/folha; conserva o modelo legado de dois SALÁRIO. Inclui ajuda de custo nos registros, totais, prévia, tela e Excel. Benefícios vazios em colunas presentes e traços contábeis são zero; coluna ausente, salário e data vazios permanecem desconhecidos. TOTAL não é derivado de salário e adiantamento. Os testes usam exclusivamente pessoas/valores sintéticos; o arquivo real não foi fornecido nesta etapa, apenas sua imagem.

A migration 035 preserva as posições e originais da 033, acrescenta a revisão de formato e permite reimportar o mesmo original para recuperar campos antes ignorados. A nova posição substitui a consulta, sem somar duas versões. Repetir a versão corrigida é idempotente. Um importador antigo não pode criar posição incompleta depois da primeira revisão nova. RPCs preview_hr_report_import e commit_hr_report_import_from_gateway mantêm autorização, original canônico e revisão concorrente. Nenhuma migration publicada 001..034 foi alterada.

Validação local em 19/10/2026: build TypeScript/Vite aprovado; **235 testes Node**, incluindo um arquivo XLSX sintético real com os dez cabeçalhos, datas e formatação contábil; **13 testes SQL da evolução de RH + quatro do combinado repetível**; **24 testes de navegador**, sendo nove RH, nove comerciais e seis da Diretoria. Campos individuais, valores zero/ausentes, prévia, Excel, leitura legada e permissões foram conferidos. Nenhum teste ficou pendente ou falhando. O aviso de tamanho do bundle permanece sem impedir o build.

Artefatos atuais: ativar-demais-abas.sql, combinado 031..035 com recarga de schema, SHA-256 f6a873814cead9bdf199e40d25813fe1e0aad091b97b6418c76c202b4c955994; business-import.ts SHA-256 7e25e88120e165250550485ac7e2628ee1f57d9a59b150d6b53a3cd8b9b553f6. O agente não executou SQL, republicou funções ou importou RH no projeto remoto. A ativação requer o combinado atual, atualização da função existente e site 0.13.1; depois reimportar a mesma planilha. Guia: [corrigir-importacao-rh.md](corrigir-importacao-rh.md).

## Salário Folha, Salário recebido e Total — 0.13.2

A operação definiu os dois salários e solicitou explicitamente o Total como a soma dos cinco campos: Salário Base + VT total + Salário recebido + Adiantamento + Ajuda de Custo. Depois esclareceu os dois cards: Salário Folha — colaboradores deve usar Salário Folha sem descontos, excluindo sócios; o antigo Salário da Folha deve usar Salário recebido com descontos, incluindo sócios. Os aliases Salário Folha / Salário da Folha passam ao campo bruto; Salário recebido / Salário Líquido ao recebido. Salário Base + Salário e o legado de dois SALÁRIO continuam aceitos. Colunas explícitas conflitantes são recusadas.

A migration 036 calcula o Total de cada pessoa e da base em centavos exatos, com limites por linha e agregado absoluto. Os cinco componentes entram uma vez, incluindo os dois salários e os sócios. TOTAL da origem é preservado separadamente; não supre componente desconhecido nem integra novamente o cálculo. Prévia, tela e Excel usam a mesma projeção do banco. A qualidade missing_total passa a indicar Total calculado indisponível. Posições antigas sem ajuda de custo continuam desconhecidas; benefícios vazios em colunas presentes valem zero conforme confirmação anterior.

A revisão 3 permite reimportar o mesmo original com os vínculos corrigidos, preservando os registros, bytes e auditorias antigos. A consulta usa uma posição, sem agregar revisões. Repetições exatas são idempotentes. Novas gravações por revisões anteriores são bloqueadas após a primeira revisão 3; replays idempotentes anteriores continuam possíveis. O site identifica o importador antigo antes de apresentar confirmação. O gateway continua analisando bytes originais no servidor e gravando as 13 propriedades canônicas, sem gravar a projeção derivada. Migrations publicadas 001..035 permanecem inalteradas.

Validação local em 19/10/2026:

- Build TypeScript/Vite aprovado; sem dependências novas. O aviso de tamanho dos chunks permanece sem impedir a geração.
- **235 testes Node aprovados**, incluindo aliases bruto/recebido em ordens diferentes, compatibilidade dos salários genéricos e arquivo XLSX com prévia derivada e commit canônico.
- **17 testes SQL aprovados**: 13 da 036 e quatro do combinado repetível. Cobrem preservação, mesma origem reimportada, versão 3, totais com sócios, dados desconhecidos, original TOTAL separado, precisão, concorrência, sessões e permissões.
- **27 testes de navegador aprovados**: 12 de RH, nove comerciais e seis da Diretoria. Conferidos os dois cards, a soma dos cinco campos, detalhes, prévia, Excel, leitura legada, original TOTAL separado e bloqueio do importador antigo. Nenhum cenário falhou ou foi ignorado.
- Artefato SQL 031..036 com recarga do schema: SHA-256 `e8879ff8bce392708176f60073facfa5bd1923881ab9737e635df1e4950165af`.
- Função business-import de arquivo único: SHA-256 `fb15fa35be80b51e0f1133fdc3f63fde69e376ce8839303c7ac87f8e937edbac`.

O agente não executou SQL, atualizou funções ou importou RH no projeto remoto; não comprovou o término do deploy Cloudflare. Ativação: combinado 031..036, função existente business-import e site 0.13.2; depois reimportar a mesma planilha com a data original. Guia: [corrigir-importacao-rh.md](corrigir-importacao-rh.md).

## Sócios apresentados como pró-labores — 0.13.3

O usuário determinou que os sócios apareçam em soma separada e sejam classificados como pró-labores. A nova migration 037 deriva a classificação do setor SÓCIO, preservando os 13 campos importados, arquivos originais, posições e auditorias. Não altera o formato 3, a função business-import ou o valor numérico do Total de cinco componentes.

Os indicadores Salário Folha e Salário recebido agora abrangem somente colaboradores. Há indicadores separados de Pró-labore sem descontos e Pró-labore recebido, além dos subtotais de colaboradores e sócios no Total geral. A projeção identifica o tipo de remuneração em cada pessoa e nos calendários. Quadros por filial e setor separam salários de pró-labores. Campos de API existentes com valores globais são preservados para compatibilidade, mas não são usados como salários na interface atualizada.

Prévia e Excel seguem a classificação. O Excel utiliza cabeçalhos neutros de remuneração e identifica cada registro como Salário ou Pró-labore; seus subtotais são calculados somente sobre as pessoas filtradas. Na consulta anterior à 037, a interface separa os grupos a partir das linhas existentes, usando centavos exatos e preservando dados desconhecidos. A ausência de informação num grupo não invalida o subtotal conhecido do outro. A Diretoria permanece somente em consulta.

Validação local em 19/10/2026:

- Build TypeScript/Vite aprovado, sem dependências novas. O aviso de tamanho dos chunks permanece sem impedir a geração.
- **19 testes Node de RH e business-import aprovados**, verificando os modelos de origem, valores canônicos e fluxo do gateway existente.
- **14 testes SQL aprovados**: dez da classificação 037 e quatro do combinado repetível. Cobrem gross/net separados, Total inalterado, grupos/calendários, valores desconhecidos e grupos vazios, precisão, original privado, histórico/auditoria preservados, repetição e permissões.
- **19 cenários de navegador aprovados**: 13 de RH e seis da Diretoria. Conferidos cards, prévia, classificação do sócio no Excel, subtotais do filtro, leitura antiga, dados ausentes, importação canônica e controles somente para consulta. Nenhum teste falhou ou foi ignorado.
- Combinado 031..037 com recarga do schema: SHA-256 `754e9290fe71dbcfd8d9537ff14a9aaca37634dd4e0d7b1c562d2cfc6f1e1c7a`.
- business-import.ts permanece inalterado: SHA-256 `fb15fa35be80b51e0f1133fdc3f63fde69e376ce8839303c7ac87f8e937edbac`. Migrations publicadas 001..036 também permanecem inalteradas.

O agente não aplicou SQL no Supabase remoto nem comprovou o término do deploy Cloudflare. Para quem já ativou 0.13.2, basta executar o combinado atual e atualizar a consulta no site 0.13.3. Essa classificação não exige reimportação ou nova publicação da função. O guia mantém os passos anteriores para quem ainda não concluiu o reconhecimento das colunas: [corrigir-importacao-rh.md](corrigir-importacao-rh.md).

## Coluna Salário Folha e rodapé do relatório — 0.13.4

O usuário mostrou o modelo completo de onze colunas com Salário Folha, Salário recebido, Total e rodapé final. Confirmou Folha total do relatório (incluindo sócios), Salários dos colaboradores e Pró-labore sem descontos como três indicadores separados. Determinou que o Total de remunerações e benefícios use o próprio Total do relatório. Essa definição substitui a fórmula anterior de cinco parcelas.

O parser já reconhecia Salário Folha, mas recusava fórmulas mesmo com resultado salvo e a linha final sem Funcionário. A revisão permite somente resultados numéricos salvos de fórmulas nas colunas financeiras, sem avaliar fórmulas ou executar macros. Preserva centavos exatos e trata apenas ruído binário insignificante do resultado salvo. Um único rodapé final, com campos financeiros e identificação vazia ou rótulo de total, fica separado das pessoas. Totais informados são conferidos com a soma dos registros; diferenças ou valores não verificáveis bloqueiam a importação. Benefícios em branco nas linhas das pessoas continuam zero quando presentes; campo vazio no rodapé continua desconhecido. Datas numéricas do Excel já eram aceitas e permanecem civis.

A migration 038 guarda report_totals na revisão 4 e usa a coluna Total original em linhas, grupos, calendários, prévia, consulta e Excel. Não soma a remuneração sem descontos ao Total informado. Os indicadores separam folha inteira, salários de colaboradores e pró-labores; recebido continua dividido entre colaboradores e sócios. Posições antigas não ganham valores ausentes por inferência. A consulta anterior à atualização também evita apresentar a antiga soma de cinco campos como Total original. Reimportar o mesmo arquivo pela revisão 4 recupera os valores com histórico preservado; replay exato é idempotente e importadores antigos ficam impedidos de criar novas posições após a revisão 4.

O gateway business-import lê novamente os bytes originais na prévia e na confirmação, extrai o rodapé no servidor e não aceita rodapé, linhas ou autor fornecidos como campos adicionais pelo cliente. A ampliação limitada do CSV permite 5.000 pessoas com preâmbulo e rodapé; o limite padrão das demais importações não mudou. XLSX mantém os limites de bytes, expansão, colunas e pessoas. Originais privados, sessões aprovadas, permissões e Diretoria somente para consulta continuam em vigor. Migrations publicadas 001..037 permanecem inalteradas.

Validação local em 19/10/2026:

- Build TypeScript/Vite aprovado, sem dependências novas; aviso de tamanho dos chunks permanece sem impedir a geração.
- **242 testes Node aprovados**. Incluem onze cabeçalhos, salários sem descontos e recebidos, fórmulas financeiras com resultado salvo, rodapé reconciliado, erros de fórmula/rodapé, troca da ordem das colunas, XLSX original reanalisado, prevenção de metadados forjados e CSV com 5.000 pessoas, preâmbulo e rodapé.
- **18 testes SQL aprovados**: 14 da 038 e quatro do combinado. Fonte Total distinta da soma anterior, conferência do rodapé, mesma origem reimportada em revisão 4, replay, cercas de versões antigas, concorrência, centavos, dados desconhecidos e preservação de originais, histórico, auditoria e RBAC.
- **29 cenários de navegador aprovados**: 14 RH, nove comerciais e seis da Diretoria. Conferidos três indicadores de folha, pró-labores, Total original, rodapé na prévia, Excel filtrado, leitura antiga segura, valores ausentes e bloqueio do importador anterior. Nenhum teste falhou ou foi ignorado.
- Combinado 031..038: SHA-256 `d11c16ff09e3e95ac03f63ab9acb1b6c704040d302b78a3621bc2ae13305fb08`.
- business-import.ts atualizado: SHA-256 `b082daa83678372e15d7df8941d32eceba2b20b7aa9c96a29b63924fd647d063`.

O agente trabalhou com uma imagem do relatório real e arquivos sintéticos nos testes, sem promover nomes ou valores reais a fixtures ou dados iniciais públicos. Não aplicou SQL, publicou funções ou importou a folha no Supabase remoto; não comprovou o término do deploy Cloudflare. Para ativar: SQL combinado atual, código completo da função existente business-import e site 0.13.4; depois reimportar essa planilha com a data original, conferindo a prévia. Guia: [corrigir-importacao-rh.md](corrigir-importacao-rh.md).

## Ativo Circulante com duas casas na apresentação — 0.13.5

O usuário pediu duas casas após a vírgula. O formatador compartilhado agora arredonda somente a exibição em milhões, com centésimos calculados sobre a string decimal, sem conversão do cálculo para ponto flutuante. Painel, histórico e texto dos indicadores usam o mesmo formato. O Excel apresenta duas casas com numFmt, preservando o valor numérico exportado. Fórmula, valores oficiais, histórico persistido, precisão e limites de exportação permanecem preservados.

Verificação local em 19/10/2026: quatro testes existentes de director-report aprovados, com expectativas de apresentação atualizadas; build TypeScript/Vite aprovado; 29 cenários existentes de treasury-dashboard aprovados, incluindo card, histórico, memória e valor original numérico no Excel. Nenhum teste falhou ou foi ignorado. O aviso de tamanho dos chunks permanece sem impedir o build.

Esta alteração depende somente do site 0.13.5. Não exige SQL, atualização de Edge Function ou reimportação. O agente não confirmou o término do deploy Cloudflare.

## Tela inicial e campanhas mensais — 0.14.0

O usuário pediu uma apresentação mais bonita por mês, ampliando logo e nome da Central, mantendo o slogan, retirando a descrição e incluindo o crédito abaixo da versão. Confirmou campanhas do calendário brasileiro e pediu explicitamente o símbolo de Outubro Rosa na entrada e uma mensagem pequena dentro de cada aba.

A tela inicial mantém a identidade verde da Ecoplast, com marca ampliada, título mais destacado, elementos decorativos próprios de cada mês e o crédito solicitado. Outubro usa laço rosa em SVG local. Doze campanhas definem nomes, cores, símbolos e mensagens, pelo calendário oficial de São Paulo; a página verifica a mudança periodicamente e ao voltar à visibilidade. O mesmo card compacto aparece no contêiner compartilhado de todos os módulos autorizados e da Administração, incluindo as abas internas. Não acrescenta consultas ou ações ao card e não altera permissões.

O formulário e a recuperação de senha conservam seus fluxos, nomes dos campos e controles. O CSS novo fica isolado para a apresentação de entrada e o card mensal; a marca do menu protegido mantém seu tamanho. No celular o slogan, o símbolo, a versão e o crédito permanecem visíveis, com quebra de linhas e sem transbordamento horizontal. Não há dependências ou imagens remotas novas, nem mudanças no banco, gateways ou dados financeiros.

Verificação local em 19/10/2026:

- Build TypeScript/Vite aprovado. O aviso existente de tamanho dos chunks permanece sem impedir a geração.
- Dois testes do calendário mensal aprovados, cobrindo os doze meses e as viradas de novembro/janeiro pelo horário de São Paulo.
- 25 cenários de navegador aprovados: quatro da identidade mensal, dez de acesso e onze de recuperação. O card foi conferido nos dez módulos e Administração. Login, permissões, logout, recuperação e bloqueios existentes foram preservados.
- O cenário de celular foi repetido após acrescentar a largura de 320 px, além de 390 px, e passou. Telas de entrada desktop/celular e card no painel com dados sintéticos foram inspecionados visualmente. Não foram observadas sobreposições ou rolagem horizontal.

A atualização depende somente do site 0.14.0; não exige SQL, funções ou reimportação. O agente não confirmou o término do deploy Cloudflare.


## Diagnóstico visível de Contas a Receber — 0.14.1

O usuário informou bloqueio nos modos abertos e quitados. A imagem mostra somente o aviso geral e um nome de arquivo diferente dos anexos disponíveis. Os dois modelos anteriormente enviados foram lidos localmente pelos mesmos adaptadores Excel e parser usados no worker e no gateway: 962 títulos abertos e 178 quitados, sem erros de leitura. Isso não comprova a importação no banco nem identifica o motivo do novo bloqueio. Nenhum dado pessoal ou financeiro dos anexos foi adicionado ao repositório ou aos testes.

A tela conserva os erros do parser, do HTTP 422 e da prévia SQL. O problema de apresentação confirmado era que o aviso genérico aparecia antes da tabela detalhada, fora do trecho visível da imagem. Agora o aviso inclui o primeiro erro com linha física, coluna e orientação; a tabela completa fica imediatamente após o formulário, antes das escolhas de carteira e parcela. Ao concluir uma análise com problemas, a página leva foco e rolagem ao diagnóstico. Editar uma escolha existente não desloca novamente o foco. Arquivo, declaração e vínculos permanecem disponíveis para nova análise.

Validação local em 19/10/2026:

- Build TypeScript/Vite da versão 0.14.1 aprovado; o aviso existente de tamanho dos chunks não impede a geração.
- 22 cenários existentes de importação de quitados e cobradoras aprovados.
- Seis cenários novos de navegador aprovados: erros locais e HTTP 422 nos dois modos, erro de arquivo sem linha e vínculo obrigatório de parcela. Conferidos aviso visível, foco, linhas físicas, tabela, preservação do arquivo, ausência de gravações e bloqueio da confirmação. Na primeira execução, as seis falhas eram de seleção/foco e tolerância de viewport no próprio teste; essas verificações foram corrigidas e os seis cenários repetidos passaram.
- Nenhuma regra de valor, data, identidade, parcela, responsável, recebimento ou comissão foi alterada. Parser, gateway e migrations permanecem inalterados. Esta versão depende somente do site.

A causa do arquivo atual continua pendente do erro específico ou dos relatórios atuais. Não há evidência para afrouxar validações financeiras nem para afirmar que a importação foi corrigida. O agente não executou importações no Supabase remoto nem confirmou o término do deploy Cloudflare.


## Revalidação junto às escolhas de parcelas — 0.14.2

O usuário informou que Nova parcela não eliminava o aviso de ambiguidade. A captura indicou seis posições: 11, 12, 16, 17, 18 e 33. A mensagem genérica copiada depois corresponde ao texto substituído na versão 0.14.1; a versão efetivamente carregada e a função publicada não puderam ser verificadas remotamente. A resposta do usuário não confirmou se os seletores permanecem preenchidos após nova análise.

O resolvedor SQL023 e a prévia SQL024 foram ensaiados em PGlite com 35 títulos sintéticos e as mesmas seis posições. Sem escolhas, há seis ambiguidades. Com NEW nas chaves ordinais correspondentes, há zero erros, resultado HISTORICAL e can_commit=true. O gateway atual encaminha os vínculos e conserva as linhas oficiais. Não foi reproduzido erro de ordinal ou escolha ignorada no código atual; os ensaios não comprovam qual resposta ocorreu no ambiente do usuário.

Foi corrigida uma dificuldade concreta de apresentação: após editar uma escolha, o diagnóstico anterior continuava parecendo um resultado atualizado e a reanálise ficava no alto da página. Agora a seção de parcelas oferece **Validar escolhas de parcelas**, usando a mesma prévia, sem confirmar o arquivo. Enquanto houver edições, o aviso fica neutro e a tabela é identificada como Análise anterior. Arquivo, bytes originais e escolhas continuam preservados; a confirmação exige uma nova prévia aprovada.

Cada análise guarda o mapa de parcelas efetivamente enviado. Se a mesma linha retornar AMBIGUOUS apesar de ter recebido escolha explícita naquela análise, o sistema informa que a função não aplicou os vínculos. Há bloqueio próprio tanto no botão quanto no handler de confirmação, inclusive se uma resposta incoerente trouxer errors vazio e can_commit=true. CONFLICT conserva sua explicação financeira e não é tratado como escolha ignorada. Não há inferência de nova parcela, mudança de recebimento, alteração de carteira ou liberação automática.

Verificação local em 19/10/2026:

- Build TypeScript/Vite aprovado na versão 0.14.2; permanece somente o aviso existente de tamanho dos chunks.
- **37 testes Node do gateway de recebíveis aprovados**, conferindo contratos, encaminhamento dos vínculos, originais, autorização e bloqueios.
- **47 cenários de navegador aprovados**, incluindo oito novos de revalidação. Cobrem as seis posições nos dois modos, mesmos bytes e mapas na prévia/commit, confirmação separada, edição parcial, resposta que ignora escolhas, resposta incoerente sem erros, conflito financeiro legítimo e troca de arquivo. Nenhuma falha ou cenário ignorado.
- Fixture de navegador ampliada para posições não iniciais, respostas que ignoram vínculos e conflitos; inclui preview.rows e contagem de conflitos coerentes com as linhas. Dados exclusivamente sintéticos.
- Revisão independente conferiu snapshot, geração, cancelamento, bloqueios, preservação das escolhas e tratamento de conflitos. git diff --check aprovado.

A melhoria depende somente do site. Não foram alterados gateway, migrations ou dados persistidos. O [guia de revalidação](revalidar-parcelas-recebiveis.md) inclui a atualização da função existente com o código completo já publicado caso o serviço remoto esteja divergente. O agente não publicou funções, executou SQL ou importou arquivos no Supabase remoto e não comprovou o término do deploy Cloudflare. A causa remota exata continua pendente; a versão não deve ser descrita como confirmação de importação de produção corrigida.


## Cards de indicadores com resposta ao cursor — 0.14.3

O usuário pediu que os boxes, exemplificados pelos quatro indicadores principais do Painel, respondam à passagem do mouse. Um CSS compartilhado aplica elevação de 4 px, sombra e borda verde suave aos indicadores financeiros e cards de resumo equivalentes de Contas a Pagar, Cobrança, RH/DP, Comercial, Comissões e tempo de atendimento. O efeito também acompanha o foco de um controle já existente dentro do card. Não transforma artigos em botões, não acrescenta paradas de tabulação e conserva as cores dos valores e os comportamentos existentes.

O efeito se restringe a telas com ponteiro preciso e suporte real a hover. A preferência por movimento reduzido conserva somente o destaque, sem transformação ou transição. As regras não se aplicam à impressão. Painéis inteiros de formulários e tabelas ficam fora do escopo. O comportamento já existente dos agrupamentos bancários não foi alterado.

Verificação local em 19/10/2026: build TypeScript/Vite da 0.14.3 aprovado, com o aviso existente de tamanho dos chunks. Conferência direta no Chromium com CSS compilado e marcação sintética verificou os quatro cards financeiros e as seis outras famílias: elevação e retorno, altura e posição dos vizinhos estáveis, cores dos valores preservadas, foco de botão interno, ausência de deslocamento/transição sob movimento reduzido, impressão sem movimento/sombra e toque em 390 px sem hover persistente ou transbordamento horizontal. A imagem local dos quatro cards foi inspecionada. git diff --check aprovado. Não foram criados testes permanentes para esta alteração visual reversível.

A atualização depende somente do site e não altera dados, cálculos, banco ou funções. O agente não confirmou o término do deploy Cloudflare. A investigação da importação de recebíveis permanece com os limites descritos na 0.14.2; este ajuste visual não a substitui nem comprova a importação remota.


## Limite individual de Contas a Pagar — SQL 039

O usuário pediu que uma conta já criada veja somente Painel Gerencial, Contas a Pagar e Importar Bases. Confirmou consulta, alterações e importação de CP, reforçando que as demais abas não podem aparecer. O perfil padrão CP também permite Caixa/Bancos; alterar sua matriz compartilhada afetaria outros usuários.

A migration aditiva 039 cria um teto privado por pessoa, aplicado como interseção da matriz RBAC em has_permission e filtrado por current_access. A configuração padronizada permite painel, contas_pagar, importar_bases e o recurso interno mensagens_cp; este último é um quadro dentro de CP. A navegação e o hub existentes já usam essas permissões, sem exigir novo site ou função Edge. Importar Bases mostra apenas CP. O Painel continua usando agregados autorizados; as contas e os saldos detalhados de Caixa ficam bloqueados, mantendo somente o diretório de contas necessário ao pagamento de CP.

O teto só é aceito para perfis CP nesta primeira versão. Uma troca de perfil com teto ativo exige removê-lo explicitamente. A tabela tem RLS e não concede leitura ou escrita a anon, authenticated ou service_role. O atalho privado restrict_payables_user(uuid) é SECURITY INVOKER, exclusivo do operador SQL proprietário; exige perfil CP vinculado e preserva seu status, a conta Auth e a matriz global. A aplicação é idempotente, auditada e não habilita uma conta bloqueada. Nenhum UID, login ou senha real foi salvo no código.

A 039 exige a identidade com sessões aprovadas, base financeira e o registro 031. Migrations publicadas 001..038 permanecem inalteradas. O ativador isolado da Diretoria foi transformado em artefato gerado: quando identifica 039 instalada, preserva a autorização mais recente em vez de substituí-la pela definição 031. O ativador combinado das demais abas já ignora a 031 registrada. Isso conserva os limites ao repetir os ativadores oficiais.

Verificação local em 19/10/2026:

- **16 grupos SQL da 039 aprovados** em PostgreSQL descartável com identidade Supabase emulada. Cobrem exatamente três módulos efetivos, importação e pagamento de CP, agregados do Painel sem detalhamento de Caixa, outro CP preservado, ausência de concessões novas, tabelas e APIs bloqueadas, sessões, conta desabilitada, metadata forjada, auditoria, idempotência, listas, perfil e repetição do ativador da Diretoria depois da 039.
- **14 grupos SQL da Diretoria aprovados**, incluindo execução do novo ativador guardado na primeira instalação, geração determinística do artefato, permissões e bloqueios existentes preservados.
- **11 cenários de navegador aprovados**: dez de acesso existentes e um novo confirmando somente três botões no menu, Administração e Abrir Caixa ausentes, somente CP no hub e navegação até CP. A primeira execução do cenário novo falhou pela inclusão dos ícones decorativos na comparação de texto do teste; a verificação foi ajustada para conservar a ordem e os nomes, e o cenário repetido passou. Nenhuma regra da aplicação foi alterada para atender ao teste.
- O artefato ativar-limites-usuarios.sql é idêntico à migration 039. git diff --check aprovado. Não foi repetido o build: não há alteração de frontend, dependências ou runtime; o navegador usou o build 0.14.3 já validado.

A documentação traz ativação, vínculo do perfil, comando privado e conferência por login real. O agente não executou SQL nem restringiu o UID no Supabase remoto. A configuração dessa pessoa ainda depende da execução pelo operador e de sair/entrar para atualizar o menu da sessão existente. A investigação de recebíveis permanece pendente de confirmação real e não é substituída por esta configuração.

## Rascunho de cobrança após atendimento — 0.15.0

O usuário escolheu abrir rascunhos no Outlook/Gmail, com vencidos e a vencer separados. Uma finalização comprovada oferece a preparação por clique; a consulta 040 usa a autoria do protocolo, carteira e permissões atuais para retornar os contatos oficiais e todos os títulos elegíveis do mesmo cliente. Quitações e pagamentos aguardando validação ficam fora da mensagem. O limite de 5.000 títulos é explícito: não há corte silencioso. A consulta não escreve dados nem registra envio.

O texto contém títulos, datas, valores nominais e subtotais, sem observações internas ou descrições dos contratos. Destinatários podem ser selecionados entre os contatos salvos. Gmail e aplicativo padrão recebem texto simples; Outlook web recebe somente texto escapado com quebras de linha próprias. Links longos ficam desabilitados, conservando a mensagem completa em cópia, texto ou `.eml`. Contatos ausentes e ausência de pendências têm tratamentos próprios. A fila de finalizações é temporária dentro do módulo Cobrança. Alterações locais conhecidas de contatos ou situação financeira invalidam a prévia; mudanças externas exigem nova consulta.

Verificação local em 19/10/2026: **13 grupos SQL**, **15 testes Node** dos contratos/mensagem e **25 cenários de navegador** aprovados. Incluem autorização, cliente e carteira, autoria, limite e somas exatas, conteúdo completo, escape HTML, destinatários, finalização incerta com repetição do mesmo protocolo, pagamento informado, fila entre clientes, invalidação da prévia e falhas sem escrita financeira. A primeira execução do navegador teve duas falhas de montagem dos novos testes (campo de pagamento ainda oculto e expectativa de botão inicial após uma prévia já aberta); corrigidos os testes, a suíte completa passou sem alterar a aplicação para contorná-los. Build TypeScript/Vite aprovado, com o aviso existente de tamanho dos chunks.

O arquivo de ativação é gerado da migration 040 com uma transação e recarregamento de esquema. Migrations publicadas 001..039 permanecem inalteradas. O agente não executou SQL remoto, não enviou e-mail e não confirmou entrega. A ativação e a conferência do deploy remoto permanecem passos externos conforme o [guia de uso](cobranca-email-rascunho.md).

## Desempenho e diagnóstico da importação de recebíveis — 0.15.0 / SQL 041

O novo relatório de quitados foi lido em ambiente privado: a estrutura foi aceita pelo parser atual, sem erros de célula ou cabeçalho. A mesma resposta SQL passou pela validação do gateway atual. A captura posterior confirmou HTTP503 após 10.574ms, com `request_unavailable` aproximadamente dez segundos depois da inicialização, compatível com o limite compartilhado anterior de dez segundos. Isso não identifica a causa de todas as falhas do serviço remoto.

Foi encontrado e reproduzido um gargalo no resolvedor privado: três consultas por linha comparavam apenas uma identidade JSON, sem os pré-filtros correspondentes ao índice existente. A migration 041 acrescenta esses pré-filtros e conserva o predicado JSON original. A prévia integral do arquivo real, em PostgreSQL local descartável, permaneceu idêntica; naquele ensaio a duração passou de 4.088 ms para 66 ms. Não é uma estimativa garantida de produção. Nenhuma linha do arquivo real foi incorporada a testes, artefatos públicos ou documentação. A atualização é independente da 040 e exige somente a base 023/024 e seu índice já existente.

O gateway tem agora um limite total de 50 segundos, e o navegador espera 60 segundos. Esses limites não alteram configurações de execução ou bloqueio do PostgreSQL. Falhas retornam códigos permitidos, etapa fixa, versão de diagnóstico e identificador gerado. Logs não recebem SQL bruto, token, arquivo ou dados financeiros. A tela distingue rede, demora, resposta incompatível e interrupção no banco. Uma reanálise malsucedida conserva as escolhas e a prévia anterior com confirmação bloqueada. Uma confirmação interrompida continua incerta e exige conferir o mesmo envio; não promete que nenhuma alteração ocorreu.

Verificação local em 19/10/2026:

- **24 grupos SQL da 041 aprovados**, com 18 cenários de paridade integral antes/depois, erros e vínculos explícitos, nomes normalizados, clientes/filiais e identificadores distintos, recebimentos existentes, correções, conflitos manuais, autorização dos sete perfis, ACL/owner/search_path/STABLE/SECURITY preservados, nenhum dado financeiro modificado pela ativação, UUID preservado na quitação e repetição idempotente.
- **41 testes do gateway**, **seis testes do diagnóstico do navegador** e **50 cenários de navegador da importação aprovados**. Três cenários novos reproduzem 503 durante revalidação, resposta sem JSON e 503 na confirmação, conferindo escolhas preservadas, referência segura, proibição de confirmar prévia antiga e manutenção de resultado incerto. A mensagem antiga de bloqueio no teste foi atualizada para restringir a afirmação à análise, sem prometer o estado de um envio anterior.
- Build TypeScript/Vite 0.15.0 aprovado, com o aviso de tamanho de chunks já existente. Bundle completo da função e SQL da 041 gerados e conferidos. Revisão independente conferiu os filtros, a identidade exata, as permissões e a ausência de dependência da 040. git diff --check aprovado.

O agente não atualizou a Edge Function, não executou SQL nem importou o arquivo no Supabase remoto. O [guia de ativação](revalidar-parcelas-recebiveis.md) entrega o SQL041, o código completo para atualizar a função existente e a sequência de revalidação. A conclusão da importação real e seus indicadores ainda precisam ser conferidos após essa ativação. A tentativa de consultar o site remoto por este ambiente foi bloqueada pelo proxy; não foi possível comprovar o término do deploy Cloudflare.

## Conciliação na importação de Contas a Pagar — 0.16.0 / SQL 042–043

O usuário confirmou que usa tanto relatórios completos quanto arquivos incrementais, quer confirmar individualmente as baixas indicadas por R$ 0,01 e deseja concluir a conciliação na própria importação. A tela exige a seleção do tipo de arquivo, sem opção inicial presumida. Somente o relatório completo apresenta títulos ausentes para decidir entre pagamento efetivo e baixa sem pagamento. Pagamento exige data, valor integral e conta oficiais informados; o arquivo de pagamentos continua conciliando automaticamente os pagamentos efetivos conferidos.

As escolhas, o arquivo original, os lançamentos, os pagamentos, as baixas e suas auditorias são aplicados em uma transação. Uma pendência bloqueia o conjunto. O ledger administrativo é imutável, preserva o valor original e não gera caixa, realizado ou status CONCILIADO. Os totais de CP, Painel, compras de mercadoria, projeções, Ativo e relatórios excluem a baixa ativa. O detalhamento e as exportações preservam o original, a auditoria e uma coluna explícita com o valor considerado nos totais. Pagamentos reais de um centavo já existentes são preservados; não foi criado um filtro global para escondê-los.

Reaparecimento de valor real exige reabertura explícita na importação de previsões. Um centavo no relatório de pagamentos sem título anterior fica bloqueado, sem inventar valor ou vencimento originais. Escritores antigos não podem contornar a confirmação. Permissões atuais, sessão aprovada e integridade do arquivo são verificadas no servidor. A repetição de um protocolo concluído devolve o resultado imutável, mesmo após alterações no cadastro de bancos; uma solicitação nova continua sujeita às validações atuais. Durante uma confirmação incerta, a tela congela o mesmo arquivo, tipo, escolhas e protocolo.

Verificação local em 19/10/2026:

- **21 grupos SQL da 042**, **18 da previsão 043** e **18 de pagamentos 043 aprovados**, com Auth simulado em PostgreSQL/PGlite. Incluem baixas de qualquer valor sem dinheiro ativo, confirmações individuais, ausência somente no completo, pagamento integral e conciliação, preservação do nominal ao receber marcador de um centavo, reabertura, idempotência, arquivo já importado por outro operador, alterações proibidas na repetição, permissões, fechamento, rollback após falha tardia e ativação combinada repetível.
- A revisão independente reproduziu uma regressão de ativação: acrescentar campos nulos à view financeira mudava o hash de conferência de títulos anteriores. A 042 exclui somente os cinco metadados novos do JSON usado nesse hash. O teste criado falhou antes da correção e passou depois: fingerprint, revisão, estado CLOSED e snapshot anteriores permanecem iguais. Baixa e reabertura reais continuam invalidando o título alterado.
- **284 testes Node aprovados**, incluindo gateway, validação do protocolo e exportação Excel. **114 cenários de navegador aprovados** nas sete suítes de CP: 112 na execução conjunta, com os dois restantes aprovados após corrigir uma expectativa de texto antigo e um seletor de status ambíguo. A aplicação não foi alterada para contornar essas duas falhas de teste. Os cenários verificam conferência atômica, cada centavo separado, tipo explícito, repetição congelada, protocolo antigo bloqueado, leitura da Diretoria, fechamento, filtros, exportações, precisão, cheque e visualização em celular.
- Build TypeScript/Vite 0.16.0 aprovado, com o aviso existente de tamanho dos chunks. Código completo da função e SQL combinado gerados; o teste confere igualdade do combinado com suas fontes e reaplicação sem alterações financeiras. Migrations publicadas 001..041 permanecem inalteradas. Nenhum registro dos relatórios reais foi incorporado aos testes ou artefatos públicos.

O agente não executou o SQL, não atualizou a função nem conciliou os títulos no Supabase remoto. A ativação requer o [SQL combinado 042/043 e a atualização da função payables-import existente](conciliacao-importacao-cp.md), além do site 0.16.0. Publicar pelo Git não aplica essas etapas nem comprova o término do deploy Cloudflare. A conferência dos totais globais da base real continua dependendo de uma exportação completa da Central; os arquivos recebidos permitem comparar o recorte semanal, sem presumir o restante da base.

## Custos por item e recálculo do fechamento — 0.17.0 / SQL 044–045

O usuário enviou uma planilha de custos atualizados e escolheu explicitamente substituir o CMV e recalcular as margens. Importar Bases → Custos agora recebe o catálogo por código, com data de referência, conferência, escolha de linha para custos divergentes e consulta das versões. A aplicação ao mês possui uma prévia separada do impacto e cria uma nova versão comercial. Venda, quantidade, frete, imposto e comissão da fonte são mantidos. Os originais, o fechamento anterior e apurações de comissão já salvas são preservados; as consultas atuais usam a nova versão comercial pelo fluxo existente.

O CMV usa custo unitário × quantidade vendida, com decimais exatos e arredondamento por linha para centavos, meio centavo afastado de zero. O preço unitário conserva até seis casas decimais. Peso não é quantidade e não recebe uma unidade presumida. Código ausente ou sem correspondência, quantidade ausente ou zero, custo ausente ou zero e componentes incompletos bloqueiam a aplicação. Custos desconhecidos não herdam valores anteriores silenciosamente. O catálogo conserva zeros explícitos, que são apontados na conferência.

Verificação local em 20/10/2026:

- A planilha real foi lida apenas em ambiente privado: uma aba, 2.727 linhas de dados, 2.107 códigos e nenhum erro do parser. A prévia SQL reconheceu a divergência de custo sem escolher uma ocorrência. O contrato do gateway aceitou a prévia bloqueada e as alternativas explicitamente selecionadas; não houve gravação de registros reais. A prévia local levou aproximadamente 319 ms, sem garantia de desempenho remoto. Não foram incorporados registros reais aos testes ou artefatos públicos.
- **17 testes SQL da 044 e 14 da 045 aprovados**, incluindo consolidação, origem por linha, escolhas, seis casas decimais, NULL e zero, referências históricas, versões e arquivos imutáveis, permissões/caps039/sessões, fonte de comissão já salva, CMV pela quantidade, componentes preservados, arredondamento positivo e negativo, overflow, revisão concorrente, replay, retorno de base já aplicada, rollback após falha tardia e ativação repetível. Dois problemas de compilação da 044 foram identificados na revisão e corrigidos antes da execução final das suítes.
- **305 testes Node aprovados**. O parser recusa casas decimais genuínas excedentes; a limpeza de caudas binárias do Excel só ocorre com tolerância de até dois ULPs e limite absoluto de 1e-9. Há regressão para números grandes com sete casas genuínas, além de paridade entre respostas reais do SQL e o contrato do gateway.
- **48 cenários distintos de navegador aprovados** nas suítes de Custos, comercial, RH e acesso. A primeira execução conjunta passou nos 46 casos existentes naquela etapa; os dois estados adicionais de base já aplicada e mês sem fechamento foram incluídos e os 14 testes de Custos passaram na execução final. Cobrem original, códigos com zeros, seis casas, escolha e revalidação, permissões, revisão concorrente, importação e aplicação incertas, protocolo preservado e bloqueios sem zeros fabricados.
- Build TypeScript/Vite 0.17.0 aprovado, com o aviso existente de tamanho dos chunks. Bundle completo business-import e SQL combinado gerados; os testes comparam o combinado com as fontes e repetem a ativação sem alterações financeiras. Migrations publicadas 001..043 permanecem inalteradas. Nenhuma dependência ou configuração de ambiente foi acrescentada.

O agente não executou SQL, publicou a função ou importou a planilha no Supabase remoto. A ativação requer o [SQL combinado 044/045, a atualização da função business-import existente e o site 0.17.0](custos-fechamento.md). O código publicado no Git não comprova o término do deploy Cloudflare nem a conclusão dessas operações remotas. A responsável ainda precisa escolher o custo divergente, confirmar a base e conferir o impacto do mês antes de aplicar o recálculo.
