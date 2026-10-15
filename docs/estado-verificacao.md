# Evidências de verificação

15/10/2026. Estado de desenvolvimento e homologação; módulos financeiros ainda pendentes.

As seções iniciais preservam o histórico das versões 0.2.0/0.2.1. O estado mais recente está na seção de atualização 0.3.0 ao final.

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
